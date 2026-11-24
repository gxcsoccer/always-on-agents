/**
 * The run loop: claim a batch of events, call the model, carry out its tool calls, repeat until it
 * stops. After every step the transcript is on disk, so a run interrupted by a deploy or a crash
 * continues from where it was instead of starting over. Only the Brain's alarm calls `next` and
 * `execute`, and alarms never overlap, so there is at most one run at a time; every write after an
 * await re-checks that the run is still the active one.
 *
 * Built on the Brain's database. What only the Brain holds (the set of calls that read outside
 * text, the connectors, the registry, the model) and the other parts are handed in (RunnerHost).
 */
import type { ConnectorTool, Quoted } from "../connectors";
import type { Env } from "../env";
import { type Principal, privateSessionKey } from "../events";
import { type Item, ModelError, type ModelRequest, type ModelResponse, type ToolDefinition } from "../model/openai";
import type { registry } from "../registry";
import type { Outbox } from "./outbox";
import { buildInstructions } from "./prompt";
import { HANDLING_LIMIT_MS, type Requests } from "./requests";
import { READ_OUTSIDE, type RunTools, eligibleSource, toolsIn } from "./run-tools";
import type { BrainStore, InboxRow, Row, RunRow } from "./store";
import { TOOLS, type ToolCall, describeTool, executeTool } from "./tools";

const MAX_STEPS_PER_RUN = 16;
/** How often a run may be (re)entered before it is abandoned: crashes, deploys, model failures. */
const MAX_RUN_ENTRIES = 5;
const RUN_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000];
/** The model sees at most this many transcript items; older ones are dropped from the front. */
const MAX_TRANSCRIPT_ITEMS = 80;
/** One run takes at most this much of a conversation's backlog; the rest waits for the next run. */
const MAX_EVENTS_PER_RUN = 40;
/** How long a connector is given to fetch what a message was written in reply to. */
export const QUOTED_WAIT_MS = 3_000;
const MAX_EVENT_BYTES_PER_RUN = 120_000;
const DAILY_TOKEN_BUDGET = 2_000_000;
/** Tokens set aside against the tenant's budget before a model call, corrected to the real figure after. */
const MODEL_CALL_RESERVE = 20_000;
/** The note left in place of a turn that read outside text. Fixed words, but for what the tool itself said it read. */
function outsideRemoved(read: string[]): string {
  return `[In this turn you used a tool that read text from outside. What it returned, and what you made of it, are not kept here.${read.length > 0 ? ` Read in this turn: ${read.join(", ")}.` : ""} What you said to the person in this turn, as it reached them, follows this note: answer a follow-up from that, and read the source again (one the person pointed to) only if you need more than you said.]`;
}
const ERROR_WITHHELD = "failed after reading outside text; the details are not kept";
const REPLACES = { type: ["string", "null"], description: "If the person wants this instead of a request of theirs that is still waiting (they changed their mind about what they want), that request's id; otherwise null." };
export type Said = { text: string; data: Record<string, unknown> };
/** How far back a person's earlier messages still count as part of what they are asking now. */
/** How far back a person's own earlier messages count as part of what they ask now: a day, and at most fifty. */
const RECENT_REQUEST_MS = 24 * 3_600_000;
const MAX_RECENT_REQUESTS = 50;

/** What the run loop needs from the Brain it is part of. */
export interface RunnerHost {
  readonly env: Env;
  /** Calls in this invocation whose result came from a connector's tool, until they are recorded. */
  readonly outside: Set<string>;
  /** Whether this person's word counts here. */
  isDecider(principal: Principal, source: string): boolean;
  /** A connector's tools. */
  toolsOf(connector: string): ConnectorTool[];
  /** Where the tenant's usage is kept. */
  registry(): Pick<ReturnType<typeof registry>, "recordUsage" | "adjustUsage">;
  /** One call to the model. */
  respond(request: ModelRequest): Promise<ModelResponse>;
  /** The message one was written in reply to, asked of the connector it came through. Never throws. */
  quoted(connector: string, event: { principal: Principal; data?: Record<string, unknown>; signal?: AbortSignal }): Promise<Quoted | undefined>;
  readonly requests: Pick<Requests, "continuationOf" | "draft" | "mayNotDisclose" | "endRequest" | "guards" | "over" | "basis" | "resumed" | "cancellable" | "askedFor" | "resume" | "readsOf">;
  readonly outbox: Pick<Outbox, "notify" | "notice" | "scrub">;
  readonly tools: Pick<RunTools, "for">;
}

export class Runner {
  readonly #s: BrainStore;
  readonly #b: RunnerHost;

  constructor(store: BrainStore, host: RunnerHost) {
    this.#s = store;
    this.#b = host;
  }

  activeRun(): RunRow | undefined {
    const id = this.#s.meta("active_run");
    return id ? this.#s.rows<RunRow>("SELECT * FROM runs WHERE id = ?", id)[0] : undefined;
  }

  /**
   * Returns the run to work on: the active one if there is one (resuming it), otherwise a new run
   * over the oldest pending conversation. Claiming is one synchronous transaction, so two
   * invocations can never both claim the same events.
   */
  /**
   * The messages the next run would take up: those pending in the conversation of the oldest,
   * in order. Bounded, so a burst in one conversation becomes several runs instead of one
   * oversized one.
   */
  #batch(first: InboxRow): InboxRow[] {
    const events: InboxRow[] = [];
    let bytes = 0;
    for (const event of this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' AND session_key = ? AND kind != 'request.ready' ORDER BY id LIMIT ?", first.session_key, MAX_EVENTS_PER_RUN)) {
      bytes += sizeOf(event);
      if (events.length > 0 && bytes > MAX_EVENT_BYTES_PER_RUN) break;
      // A message that replies to something other than what the ones before it reply to is about
      // something else: it starts a run of its own, in order, so each is read under its own binding.
      if (events.length > 0 && repliesTo(event) !== repliesTo(events.at(-1)!)) break;
      // Where a connector's tools would act for a person, a run is one person's ordinary
      // messages and nothing else with them; anything else is a run of its own (see #askerOf).
      if (events.length > 0 && this.#askerOf(event) !== this.#askerOf(events.at(-1)!)) break;
      events.push(event);
    }
    return events;
  }

  /**
   * Whose ordinary request a message is, for telling one person's from the next: their id. Null
   * where the connector has no tools that act for a person, so the question does not arise.
   * Anything else that came through such a connector is its own: a button pressed, an answer to
   * a question, words naming an open question, words not addressed to the agent, an event no
   * person wrote. Each of those is taken up alone.
   */
  #askerOf(event: InboxRow): string | null {
    if (this.#b.toolsOf(event.source).length === 0) return null;
    const principal = JSON.parse(event.principal) as Principal;
    const data = event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {};
    const ordinary = event.kind === "message" && this.#b.isDecider(principal, event.source) && plain(data);
    // Told apart by kind and by connector, so that no id can read as another's or as an event's.
    return ordinary ? `person:${event.source}:${principal.id}` : `event:${event.id}`;
  }

  /** Starts a run over exactly these messages, those of them still pending. Anything that arrived since waits for the next. */
  #claim(ids: number[]): string | undefined {
    return this.#s.transaction(() => {
      const active = this.activeRun();
      if (active) return active.retry_at && active.retry_at > Date.now() ? undefined : active.id;

      // Measured again as they now are: what was fetched for them counts too. Those that no
      // longer fit stay pending, with what was fetched kept, for the next run.
      const events: InboxRow[] = [];
      let bytes = 0;
      for (const event of ids.length === 0 ? [] : this.#s.rows<InboxRow>(`SELECT * FROM inbox WHERE status = 'pending' AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids)) {
        bytes += sizeOf(event);
        if (events.length > 0 && bytes > MAX_EVENT_BYTES_PER_RUN) break;
        events.push(event);
      }
      const first = events[0];
      if (!first) return undefined;
      const now = Date.now();
      const runId = crypto.randomUUID();

      let session = this.#s.rows<Row>("SELECT * FROM sessions WHERE session_key = ?", first.session_key)[0];
      if (!session) {
        session = { id: crypto.randomUUID() };
        this.#s.sql.exec("INSERT INTO sessions (id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)", session.id, first.session_key, now, now);
      }
      for (const event of events) this.#s.sql.exec("UPDATE inbox SET status = 'claimed', run_id = ? WHERE id = ?", runId, event.id);

      // Replies go where the most recent addressed event came from.
      const target = [...events].reverse().find((e) => e.reply_to)?.reply_to;
      if (target) this.#s.sql.exec("UPDATE sessions SET target = ? WHERE id = ?", target, session.id);

      this.#s.sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES (?, ?, 'running', ?)", runId, session.id, now);
      // A reply to one of the agent's own delivered messages points at those words (see #transcript); it does not hold them.
      const replied: number[] = [];
      const content = events.map((each) => renderEvent(each) + this.#repliedTo(each, session.id, replied)).join("\n");
      this.append(session.id, runId, { role: "user", content, ...(replied.length > 0 ? { _replied: replied } : {}) } as Item);
      this.#s.setMeta("active_run", runId);
      return runId;
    });
  }

  /**
   * What a message was written in reply to, for the model: the text alone does not say. A
   * message of the same person's in this conversation is quoted (their own words, as stored);
   * one of the agent's is only named by when it was sent, since what it said may not be kept.
   */
  /** The stored message another was written in reply to: the very one, earlier, in the same conversation and through the same connector. */
  #parentOf(event: InboxRow, subject: string): InboxRow | undefined {
    const prefix = `${event.source}:message:`;
    if (!subject.startsWith(prefix)) return undefined;
    return this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE source = ? AND source_id = ? AND kind = 'message' AND session_key = ? AND id < ?", event.source, subject.slice(prefix.length), event.session_key, event.id)[0];
  }

  #repliedTo(event: InboxRow, sessionId: string, replied: number[]): string {
    const subject = event.kind === "message" && event.data ? (JSON.parse(event.data) as { replies_to?: unknown }).replies_to : undefined;
    if (typeof subject !== "string") return "";
    const parent = this.#parentOf(event, subject);
    const who = (row: InboxRow) => JSON.parse(row.principal) as Principal;
    if (parent && parent.text !== null && who(parent).kind === "human" && who(event).kind === "human" && who(parent).id === who(event).id) return `\n  (written as a reply to their own earlier message: ${JSON.stringify(parent.text.slice(0, 500))})`;
    // Words of the agent's that reached the person in this very conversation: pointed at, and
    // shown to the model as the agent's own when the transcript is put together, while they are kept.
    const words = this.#s.rows<{ outbox_id: number; sent_at: number }>("SELECT outbox_id, sent_at FROM said WHERE receipt_subject = ? AND session_id = ? ORDER BY outbox_id DESC LIMIT 1", subject, sessionId)[0];
    if (words) {
      replied.push(words.outbox_id);
      return `\n  (written as a reply to the message you sent at ${new Date(words.sent_at).toISOString()})`;
    }
    // One of the agent's own, sent in this conversation, whose words are not kept.
    const yours = this.#s.rows<{ sent_at: number | null }>(
      "SELECT o.sent_at FROM outbox o WHERE json_extract(o.receipt, '$.subject') = ? AND (o.run_id IN (SELECT r.id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.session_key = ?) OR o.continuation IN (SELECT c.id FROM continuations c JOIN sessions s ON s.id = c.session_id WHERE s.session_key = ?)) LIMIT 1",
      subject,
      event.session_key,
      event.session_key,
    )[0];
    if (yours?.sent_at) return `\n  (written as a reply to the message you sent at ${new Date(yours.sent_at).toISOString()})`;
    // A message the agent was never sent, which the connector was asked for before this run
    // (see #quote): the person's own words, or only that there was one.
    const quoted = (JSON.parse(event.data ?? "{}") as { quoted?: { text?: unknown } }).quoted;
    if (!quoted) return "";
    return typeof quoted.text === "string" ? `\n  (written as a reply to their own earlier message: ${JSON.stringify(quoted.text)})` : "\n  (written as a reply to a message here that is not shown to you: someone else's, or one that could not be read)";
  }

  /**
   * Before a run takes these messages up: for each that was written in reply to something the
   * Brain has no record of, the connector is asked for it, once, and what it says is kept with
   * the message. The messages were stored and acknowledged long before; this only adds to what
   * the model is shown. All of them are asked about at once, within one limit for the lot; what
   * has not answered by then is told to stop, and the run starts whatever came of it.
   */
  async #quote(events: InboxRow[]): Promise<void> {
    const sessionId = events[0] ? (this.#s.rows<{ id: string }>("SELECT id FROM sessions WHERE session_key = ?", events[0].session_key)[0]?.id ?? "") : "";
    // Asked about once for each person and message replied to, however many messages say so.
    const unknown = new Map<string, { asking: { principal: Principal; data: Record<string, unknown> }; source: string; ids: number[] }>();
    for (const event of events) {
      const data = event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {};
      const principal = JSON.parse(event.principal) as Principal;
      const subject = data.replies_to;
      // Only a person's ordinary message, about a message there is no record of at all: not one
      // that reached the agent (whoever wrote it, and whether or not its words are still kept),
      // not one the agent or the system sent, and not an answer to a question.
      if (event.kind !== "message" || principal.kind !== "human" || typeof subject !== "string" || data.quoted !== undefined || data.question !== undefined) continue;
      // On record anywhere in this place, by its identity alone: also where its words are gone, or it was filed under another conversation.
      const prefix = `${event.source}:message:`;
      if (subject.startsWith(prefix) && this.#s.rows("SELECT 1 FROM inbox WHERE source = ? AND source_id = ? LIMIT 1", event.source, subject.slice(prefix.length)).length > 0) continue;
      if (this.#s.rows("SELECT 1 FROM outbox WHERE json_extract(receipt, '$.subject') = ? LIMIT 1", subject).length > 0 || this.#repliedTo(event, sessionId, []) !== "") continue;
      const key = JSON.stringify([event.source, principal.id, subject, data.origin ?? null]);
      const same = unknown.get(key);
      if (same) same.ids.push(event.id);
      else unknown.set(key, { asking: { principal, data }, source: event.source, ids: [event.id] });
    }
    if (unknown.size === 0) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Quoted>((resolve) => (timer = setTimeout(() => resolve({}), QUOTED_WAIT_MS)));
    await Promise.all(
      [...unknown.values()].map(async ({ asking, source, ids }) => {
        const found = await Promise.race([this.#b.quoted(source, { ...asking, signal: stop.signal }), late]).catch((): Quoted => ({}));
        if (found) for (const id of ids) this.#s.sql.exec("UPDATE inbox SET data = json_set(data, '$.quoted', json(?)) WHERE id = ? AND status = 'pending'", JSON.stringify(typeof found.text === "string" ? { text: found.text, ...(Array.isArray(found.documents) && found.documents.length > 0 ? { documents: found.documents } : {}) } : {}), id);
      }),
    );
    clearTimeout(timer);
    stop.abort();
  }

  async execute(runId: string): Promise<void> {
    const entered = this.#s.rows<RunRow>("UPDATE runs SET entries = entries + 1, retry_at = NULL WHERE id = ? RETURNING *", runId)[0];
    if (!entered) return;
    // A tool ended the matter itself: that is how the run ends, however often it was entered.
    if (entered.closed === "settled") {
      const run = this.#stillActive(runId);
      if (!run) return;
      this.#s.transaction(() => {
        for (const call of danglingCalls(this.#transcript(run.session_id, runId))) this.append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "not carried out" }) });
      });
      return this.#finish(runId, "done");
    }
    if (entered.entries > MAX_RUN_ENTRIES) return this.#abandon(runId, "the run kept failing and was abandoned");
    // A run an earlier version left part way after reopening an answer kept for follow-ups, which
    // are retired: nothing more of it is done, not even a call it left behind.
    if (this.#b.requests.guards(runId).some((each) => each.retired)) return this.#retire(runId);

    for (;;) {
      const run = this.#stillActive(runId);
      if (!run) return;
      const items = this.#transcript(run.session_id, runId);

      // Tool calls without a recorded output: either the model just asked for them, or an earlier
      // attempt died mid-call. Either way, execute and record. Tools are idempotent per call id.
      const open = danglingCalls(items);
      // A tool ended the matter itself: nothing more is done in this run, also when it is entered
      // again after an interruption. Calls left open are closed unrun and the model is not asked.
      if (run.closed === "settled") {
        this.#s.transaction(() => {
          for (const call of open) this.append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "not carried out" }) });
        });
        break;
      }
      // Calls that act for the person go first, whatever order the model gave them in: what they
      // lead to (the run has read, has to wait, is settled) then decides about the others.
      const acting = open.length > 1 ? this.actingFor(runId) : undefined;
      const personal = new Set(acting ? toolsIn(acting, this.#b.toolsOf).map((each) => each.name) : []);
      const dangling = [...open.filter((each) => personal.has(each.name)), ...open.filter((each) => !personal.has(each.name))];
      // A request being carried on makes its one call only while what it waited for still holds,
      // asked now: also when the run was interrupted after the request was claimed, however
      // long ago. No longer so, and nothing is read; not to be asked just now, and it is put off.
      const making = dangling.length > 0 ? this.#b.requests.continuationOf(runId) : undefined;
      if (making?.status === "resuming") {
        let why: string | undefined;
        try {
          why = await this.#b.requests.mayNotDisclose(making);
        } catch (err) {
          return this.#retryLater(runId, err);
        }
        if (!this.#stillActive(runId)) return;
        if (why) {
          this.#s.transaction(() => {
            for (const call of dangling) this.append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "not carried out" }) });
            this.#b.requests.endRequest(making.id, "void", why);
          });
          this.#b.outbox.notify(`withheld:${runId}`, run.session_id, null, this.#b.outbox.notice("withheld", run.session_id));
          break;
        }
      }
      if (dangling.length > 0) {
        for (const call of dangling) {
          if (this.#stillActive(runId)?.closed === "settled") {
            this.append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "not carried out" }) });
            continue;
          }
          // Decided at the moment of use, a repeat after an interruption included.
          const output = this.mayUse(runId, call.name) ? await executeTool(this.#b.tools.for(run), call) : JSON.stringify({ error: READ_OUTSIDE });
          const outside = this.#b.outside.delete(call.call_id);
          if (!this.#stillActive(runId)) return;
          this.append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output }, outside);
        }
        continue;
      }

      const last = items.at(-1);
      const awaitingModel = last && (last.role === "user" || last.type === "function_call_output");
      if (!awaitingModel || run.steps >= MAX_STEPS_PER_RUN) break;

      // Two limits: this scope's own, and the tenant's across all of its scopes and sandboxes.
      // The tenant's share is reserved before the call and trued up after it, so several scopes
      // admitted at the same moment cannot all slip under the limit together.
      const tenant = await this.#b.registry().recordUsage(this.#s.scope().tenant, MODEL_CALL_RESERVE);
      // The day the registry charged, which is not necessarily today as seen from here.
      const reservedOn = tenant.day;
      /** Gives the reservation back: the call it was made for is not going to happen. */
      const release = () => this.#b.registry().adjustUsage(this.#s.scope().tenant, -MODEL_CALL_RESERVE, reservedOn).catch(() => undefined);
      // From here, a run that stops being this object's while waiting gives the reservation back.
      if (!this.#stillActive(runId)) return void (await release());
      if (!tenant.allowed || this.tokensToday() >= DAILY_TOKEN_BUDGET) {
        await release();
        if (!this.#stillActive(runId)) return;
        // A request that was being carried on cannot wait until tomorrow: its time would be up.
        // It ends here, and the person is told, in place of its answer.
        const carrying = this.#b.requests.continuationOf(runId);
        if (carrying) {
          if (carrying.status === "resuming") this.#b.requests.draft(carrying, run, this.#b.outbox.notice("limit", run.session_id));
          this.#s.log("budget_exhausted", { run: runId, tokens_today: this.tokensToday() });
          break;
        }
        // The run stays claimed and resumes after midnight UTC; nothing is dropped. This pause is
        // not a failure, so it does not count towards the run's entry limit.
        this.#b.outbox.notify(`budget:${runId}:${today()}`, run.session_id, runId, this.#b.outbox.notice("tomorrow", run.session_id));
        this.#s.log("budget_exhausted", { run: runId, tokens_today: this.tokensToday() });
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 30, 0);
        this.#s.sql.exec("UPDATE runs SET retry_at = ?, entries = entries - 1 WHERE id = ?", midnight.getTime(), runId);
        return;
      }

      // A request being carried on has read what it waited for. Each time that text is about to
      // be put before the model (also after an interruption, or a pause of any length) the
      // condition's owner is asked whether it still holds, and nothing else is waited for between
      // that answer and the call. If it does not hold, the model is not given the text.
      const carried = this.#b.requests.continuationOf(runId);
      if (carried && this.sawOutside(runId)) {
        let why: string | undefined;
        try {
          why = carried.status === "resuming" ? await this.#b.requests.mayNotDisclose(carried) : "the request has ended";
        } catch (err) {
          await release();
          return this.#retryLater(runId, err);
        }
        if (!this.#stillActive(runId)) return void (await release());
        if (why || !this.actingFor(runId)) {
          await release();
          if (!this.#stillActive(runId)) return;
          this.#b.requests.endRequest(carried.id, "void", why ?? "it is no longer the person's to ask here");
          // They were waiting for this: told, in fixed words, that it stopped.
          this.#b.outbox.notify(`withheld:${runId}`, run.session_id, null, this.#b.outbox.notice("withheld", run.session_id));
          break;
        }
      }

      // The same for any run that has read something under a condition (an authorisation, the
      // time a kept answer lasts): what it read is not put before the model once that is over.
      const guards = this.#b.requests.guards(runId);
      if (guards.length > 0 && this.sawOutside(runId) && this.#stillActive(runId)?.status === "running" && (!carried || this.#b.requests.continuationOf(runId)?.status === "resuming")) {
        let over: string | undefined;
        try {
          over = await this.#b.requests.over(guards);
        } catch (err) {
          await release();
          return this.#retryLater(runId, err);
        }
        if (!this.#stillActive(runId)) return void (await release());
        if (over) {
          await release();
          if (!this.#stillActive(runId)) return;
          // Nothing more of it goes out; the person is told, in fixed words, that it stopped.
          this.#s.sql.exec("UPDATE outbox SET status = 'void', text = '', review = NULL WHERE run_id = ? AND status = 'pending' AND started = 0", runId);
          if (carried) this.#b.requests.endRequest(carried.id, "void", over);
          this.#b.outbox.notify(`withheld:${runId}`, run.session_id, null, this.#b.outbox.notice("withheld", run.session_id));
          break;
        }
      }

      // Last, with nothing waited for after it: a request being carried on is still that, and
      // still in its time. The checks above each waited for an owner's answer.
      if (carried) {
        const still = this.#b.requests.continuationOf(runId);
        if (!still || still.status !== "resuming" || Date.now() - (still.claimed_at ?? 0) > HANDLING_LIMIT_MS) {
          await release();
          if (!this.#stillActive(runId)) return;
          if (still?.status === "resuming") {
            this.#b.requests.endRequest(still.id, "void", "it was not finished in time");
            this.#b.outbox.notify(`withheld:${runId}`, run.session_id, null, this.#b.outbox.notice("notSent", run.session_id));
          }
          break;
        }
      }

      let response;
      try {
        response = await this.#b.respond({
          baseUrl: this.#b.env.OPENAI_BASE_URL,
          apiKey: this.#b.env.OPENAI_API_KEY,
          model: this.#b.env.BRAIN_MODEL,
          instructions: this.#instructions(runId),
          input: items,
          tools: this.#toolsFor(runId),
        });
      } catch (err) {
        await release();
        return this.#retryLater(runId, err);
      }
      // The call was made: what it spent is counted, here and for the tenant, even if the run is no longer this object's.
      const trueUp = () => this.#b.registry().adjustUsage(this.#s.scope().tenant, response.usage.total_tokens - MODEL_CALL_RESERVE, reservedOn).catch(() => undefined);
      if (!this.#stillActive(runId)) {
        this.spend(response.usage.total_tokens);
        return void (await trueUp());
      }
      this.#s.transaction(() => {
        for (const item of response.output) this.append(run.session_id, runId, item);
        this.#s.sql.exec(
          "UPDATE runs SET steps = steps + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?",
          response.usage.input_tokens,
          response.usage.output_tokens,
          runId,
        );
        this.#s.setMeta(`tokens:${today()}`, String(this.tokensToday() + response.usage.total_tokens));
      });
      // After the commit: if this is lost the tenant is under-counted by one call, never blocked.
      await trueUp();
    }
    this.#finish(runId, "done");
  }

  /** The run, if it is still the one this object is working on. Checked after every await. */
  #stillActive(runId: string): RunRow | undefined {
    const run = this.activeRun();
    return run && run.id === runId && run.status === "running" ? run : undefined;
  }

  /** Ends a run that rests on something retired: its open calls are closed unrun, nothing it wrote is sent, and the person is told. */
  #retire(runId: string): void {
    const run = this.#stillActive(runId);
    if (!run) return;
    this.#s.transaction(() => {
      for (const call of danglingCalls(this.#transcript(run.session_id, runId))) this.append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "not carried out" }) });
      this.#s.sql.exec("UPDATE outbox SET status = 'void', text = '', review = NULL WHERE run_id = ? AND status IN ('pending', 'draft') AND started = 0", runId);
      this.#b.outbox.notify(`withheld:${runId}`, run.session_id, null, this.#b.outbox.notice("retired", run.session_id));
    });
    this.#finish(runId, "done");
  }

  #retryLater(runId: string, err: unknown): void {
    const run = this.#stillActive(runId);
    if (!run) return;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ModelError && !err.retryable && err.status !== 0) return this.#abandon(runId, message);
    const delay = RUN_RETRY_DELAYS_MS[Math.min(run.entries - 1, RUN_RETRY_DELAYS_MS.length - 1)];
    this.#s.sql.exec("UPDATE runs SET retry_at = ?, error = ? WHERE id = ?", Date.now() + delay, this.sawOutside(runId) ? ERROR_WITHHELD : message.slice(0, 1_000), runId);
  }

  #abandon(runId: string, reason: string): void {
    const run = this.#s.rows<RunRow>("SELECT * FROM runs WHERE id = ?", runId)[0];
    if (!run) return;
    // Looked at before the run's record is cleared.
    const outside = this.sawOutside(runId);
    this.#s.transaction(() => {
      // Close any open tool call so the transcript stays well-formed for the next run.
      for (const call of danglingCalls(this.#transcript(run.session_id, runId))) {
        this.append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "the run was abandoned before this finished" }) });
      }
      // A task that never got past "dispatching" in this run will not be picked up by anything else.
      this.#s.sql.exec("UPDATE tasks SET status = 'failed', updated_at = ? WHERE status = 'dispatching' AND session_key = (SELECT session_key FROM sessions WHERE id = ?)", Date.now(), run.session_id);
      // For a request that was being carried on, this takes the place of its answer: one or the other.
      const carried = this.#b.requests.continuationOf(runId);
      if (carried?.status === "resuming") this.#b.requests.draft(carried, run, this.#b.outbox.notice("failed", run.session_id));
      // One that went back to waiting, or ended, has nothing to say here: its answer, if it gets
      // one, is the request's.
      else if (!carried) this.#b.outbox.notify(`abandoned:${runId}`, run.session_id, runId, this.#b.outbox.notice("failed", run.session_id));
      this.#finish(runId, "failed", reason);
    });
    this.#s.log("run_abandoned", { run: runId, reason: outside ? ERROR_WITHHELD : reason.slice(0, 300) });
  }

  #finish(runId: string, status: "done" | "failed", error?: string): void {
    this.#s.transaction(() => {
      const run = this.#s.rows<RunRow>("SELECT * FROM runs WHERE id = ?", runId)[0];
      if (!run || run.status !== "running") return;
      const now = Date.now();
      this.#s.sql.exec("UPDATE inbox SET status = ? WHERE run_id = ? AND status = 'claimed'", status === "done" ? "done" : "dead", runId);
      // An error can quote what the model was sent. From a run that read outside text, only the fact is kept.
      const said = error === undefined ? null : this.sawOutside(runId) ? ERROR_WITHHELD : error.slice(0, 1_000);
      this.#s.sql.exec("UPDATE runs SET status = ?, ended_at = ?, retry_at = NULL, error = ? WHERE id = ?", status, now, said, runId);
      this.#s.sql.exec("UPDATE sessions SET updated_at = ? WHERE id = ?", now, run.session_id);
      // The run that carried a request on ends together with the request's fate, in this one
      // step: its one answer becomes a message to deliver, and the request one that is being
      // answered. Until here the answer was a draft that nothing would send. A request that is
      // no longer being carried on (told to wait again, ended) leaves no answer behind.
      // What the run read under is on every message it wrote by now (outbox.guard); the run's own note of it goes.
      // What the run read, by the tool's own canonical call (never anything the model wrote, nor what came back): kept on the note below.
      const read = this.#b.requests.readsOf(runId);
      this.#s.sql.exec("DELETE FROM meta WHERE key = ?", `sources:${runId}`);
      // And its notes of calls answered with a request another call had made: no call of it is made again now.
      this.#s.sql.exec("DELETE FROM meta WHERE key LIKE 'waited:%' AND json_valid(value) AND json_extract(value, '$.run') = ?", runId);
      const carried = this.#b.requests.continuationOf(runId);
      if (carried?.status === "resuming") {
        // A run that stopped without answering has not answered: the person is told so.
        if (this.#s.rows("SELECT 1 FROM outbox WHERE idem = ? AND status = 'draft'", `answer:${carried.id}`).length === 0) this.#b.requests.draft(carried, run, this.#b.outbox.notice("notAnswered", run.session_id));
        this.#s.sql.exec("UPDATE outbox SET status = 'pending', next_at = ? WHERE idem = ? AND status = 'draft'", now, `answer:${carried.id}`);
        this.#s.sql.exec("UPDATE continuations SET status = 'answering' WHERE id = ?", carried.id);
      } else if (carried) this.#s.sql.exec("DELETE FROM outbox WHERE idem = ? AND status = 'draft'", `answer:${carried.id}`);
      this.#forgetOutside(run, read);
      if (this.#s.meta("active_run") === runId) this.#s.sql.exec("DELETE FROM meta WHERE key = 'active_run'");
    });
  }

  append(sessionId: string, runId: string, item: Item, outside = false): void {
    this.#s.sql.exec(
      "INSERT INTO items (session_id, seq, run_id, is_user, item, outside) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE session_id = ?), ?, ?, ?, ?)",
      sessionId,
      sessionId,
      runId,
      item.role === "user" ? 1 : 0,
      JSON.stringify(item),
      outside ? 1 : 0,
    );
  }

  /**
   * Whose authority a connector's tools would carry in this run, if anyone's. There is such a
   * person only when it is beyond doubt. This is that person's own scope and their private
   * conversation through one connector. Everything that started the run is an ordinary message
   * they wrote to the agent there: not a button press, not a reply to a question, not something
   * routed from elsewhere, not a timer or a worker's report. Every one came through that
   * connector, which the deployment trusts, with one and the same verified origin, none of it
   * empty. Anything else and there is no such person. Worked out from the stored events each
   * time it is needed, never remembered.
   */
  actingFor(runId: string): { connector: string; person: string; origin: Record<string, string>; shared?: true; said: Said[]; recent: Said[]; recentIds: number[] } | undefined {
    return this.actingOn(this.#b.requests.basis(runId), this.#b.requests.resumed(runId) ? (JSON.parse(this.#b.requests.resumed(runId)!.events) as { recent: number[] }).recent : undefined);
  }

  /**
   * The same judgement over given messages: `events` as what was asked, and, if `kept` is given,
   * exactly those earlier messages as what came shortly before (instead of looking for them).
   */
  actingOn(events: InboxRow[], kept?: number[]): { connector: string; person: string; origin: Record<string, string>; shared?: true; said: Said[]; recent: Said[]; recentIds: number[] } | undefined {
    const scope = this.#s.scope();
    if (events.length === 0) return undefined;
    const source = events[0].source;
    const origin = originOf(events[0]);
    // A person's own scope, and their private conversation there. Or a place several people
    // share, where the person is whoever wrote the first of these messages, the conversation is
    // the one it came in, and only tools that say they may be used there count.
    const shared = scope.kind === "chat";
    if (scope.kind !== "user" && !shared) return undefined;
    if (!origin || toolsIn({ connector: source, ...(shared ? { shared: true as const } : {}) }, this.#b.toolsOf).length === 0) return undefined;
    const person = shared ? (JSON.parse(events[0].principal) as Principal).id : scope.id;
    const conversation = shared ? events[0].session_key : privateSessionKey(source, origin);
    // A request, in the person's own words, made here: through that connector, in that private
    // conversation, by the person whose scope this is, with that same verified origin.
    const own = (event: InboxRow): boolean => {
      const principal = JSON.parse(event.principal) as Principal;
      if (event.kind !== "message" || event.source !== source || event.session_key !== conversation) return false;
      if (!this.#b.isDecider(principal, event.source) || principal.id !== person) return false;
      const data = event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {};
      // What the connector itself says of the message, as it verified it: written to the agent
      // alone, or written where its tools may be used for the writer in front of the others.
      if ((shared ? data.shared : data.direct) !== true || !plain(data)) return false;
      const same = originOf(event);
      return same !== undefined && JSON.stringify(same) === JSON.stringify(origin);
    };
    if (!events.every(own)) return undefined;
    const said = (event: InboxRow): Said => ({ text: event.text ?? "", data: event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {} });
    // What the same person wrote here shortly before, by the same test. People say what they
    // mean over two messages: a link, then what to do with it. These are their own words as
    // they arrived, never anything a run wrote or read.
    const first = events[0];
    let recent: InboxRow[];
    if (kept) {
      // Not looked for again: the very messages that were found when the request was made, all
      // still there and still passing the same test.
      const ids = kept;
      recent = ids.length === 0 ? [] : this.#s.rows<InboxRow>(`SELECT * FROM inbox WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids);
      if (recent.length !== ids.length || !recent.every((each) => each.text !== null && own(each))) return undefined;
    } else {
      recent = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND source = ? AND json_extract(principal, '$.id') = ? AND id < ? AND received_at >= ? ORDER BY id DESC LIMIT ?", conversation, source, person, first.id, first.received_at - RECENT_REQUEST_MS, MAX_RECENT_REQUESTS * 4)
        .filter(own)
        .slice(0, MAX_RECENT_REQUESTS)
        .reverse();
      // A message the person replied to is part of what they are saying now, however long ago
      // they wrote it: their own, by the same test, in this conversation.
      const pointed = events.map((each) => (JSON.parse(each.data ?? "{}") as { replies_to?: unknown }).replies_to).filter((each): each is string => typeof each === "string");
      if (pointed.length > 0) {
        const older = [...new Set(pointed)].flatMap((subject) => this.#parentOf(first, subject) ?? []).filter((each, index, all) => own(each) && each.text !== null && all.findIndex((other) => other.id === each.id) === index && !recent.some((seen) => seen.id === each.id));
        recent = [...older, ...recent].sort((a, b) => a.id - b.id);
      }
    }
    return { connector: source, person, origin, ...(shared ? { shared: true as const } : {}), said: events.map(said), recent: recent.map(said), recentIds: recent.map((each) => each.id) };
  }

  /**
   * Ends what a run that read outside text leaves behind. Text a connector's tool brought in was
   * for that run, and so is everything the run went on to say or do with it: the model's own
   * words about a document carry the document. So the run's whole record, apart from what the
   * person wrote, is replaced by one fixed note. A later run sees that something was read; it is
   * not handed the content, in the original or retold, nor anything else the model wrote.
   * Messages the run wrote are emptied once they have been delivered or given up.
   */
  #forgetOutside(run: RunRow, read: { args: string }[] = []): void {
    if (this.#s.rows("SELECT 1 FROM items WHERE run_id = ? AND outside = 1 LIMIT 1", run.id).length === 0) return;
    this.#s.sql.exec("DELETE FROM items WHERE run_id = ? AND is_user = 0", run.id);
    // Fixed words, and what the tool said it read. Nothing the model wrote is carried over, not even what it asked a tool for.
    const links = linksOf(read);
    // Also as a record (never shown to the model as such): what this turn read, whether or not anything it said reached the person.
    this.append(run.session_id, run.id, { role: "assistant", content: outsideRemoved(links), ...(read.length > 0 ? { _reads: read } : {}) } as Item);
    this.#s.sql.exec("UPDATE items SET outside = 2 WHERE run_id = ? AND is_user = 0", run.id);
    this.#s.sql.exec("UPDATE outbox SET private = 1 WHERE run_id = ?", run.id);
    this.#b.outbox.scrub("run_id = ?", run.id);
  }

  /** Whether this run has been given text from outside by a connector's tool. */
  sawOutside(runId: string): boolean {
    return this.#b.outside.size > 0 || this.#s.rows("SELECT 1 FROM items WHERE run_id = ? AND outside = 1 LIMIT 1", runId).length > 0;
  }

  /**
   * The items the model sees, at most the last MAX_TRANSCRIPT_ITEMS of them as they stand (places
   * left by scrubbed items do not count). The window always starts at a user turn: starting
   * anywhere else would hand the model a tool output without its call, or a reasoning item without
   * its message. If the most recent turns alone exceed the window, the window grows to hold the
   * whole latest turn.
   *
   * Two things are put in from where they are kept rather than stored with the transcript:
   * - After a turn that read outside text (scrubbed down to its fixed note), what that turn said
   *   to the person, as it was delivered (`said`), in order.
   * - Before a person's turn that replied to one of those messages, the words replied to, as the
   *   agent's own.
   */
  #transcript(sessionId: string, runId?: string): Item[] {
    const lastUser = this.#s.rows<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM items WHERE session_id = ? AND is_user = 1", sessionId)[0]?.seq;
    const floor = this.#s.rows<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM (SELECT seq FROM items WHERE session_id = ? ORDER BY seq DESC LIMIT ?)", sessionId, MAX_TRANSCRIPT_ITEMS * 4)[0]?.seq;
    if (floor == null) return [];
    const from = lastUser != null ? Math.min(lastUser, floor) : floor;
    const rows = this.#s.rows<{ run_id: string | null; is_user: number; item: string; outside: number }>("SELECT run_id, is_user, item, outside FROM items WHERE session_id = ? AND seq >= ? ORDER BY seq", sessionId, from);
    // Each scrubbed turn's delivered words go after the last of its kept items. One query for all of them.
    const wordsOf = new Map<string, Item[]>();
    // Where several people talk, those words are shown only to a run that itself acts for one of
    // them there: they were written from what one person could read.
    const mayShow = this.#s.scope().kind !== "chat" || (runId !== undefined && this.actingFor(runId) !== undefined);
    for (const each of mayShow === false ? [] : this.#s.rows<{ run_id: string; text: string }>(
      "SELECT run_id, text FROM said WHERE session_id = ? AND run_id IN (SELECT DISTINCT run_id FROM items WHERE session_id = ? AND seq >= ? AND is_user = 0 AND outside = 2) ORDER BY outbox_id",
      sessionId,
      sessionId,
      from,
    )) {
      wordsOf.set(each.run_id, [...(wordsOf.get(each.run_id) ?? []), { role: "assistant", content: each.text }]);
    }
    // The words people replied to, for every reply in the window, in one query.
    const pointed = rows.flatMap((row) => (row.is_user === 1 ? ((JSON.parse(row.item) as { _replied?: unknown })._replied as number[] | undefined) ?? [] : []));
    const quotedOf = new Map(
      pointed.length === 0 || !mayShow ? [] : this.#s.rows<{ outbox_id: number; text: string; sent_at: number; reads: string }>("SELECT outbox_id, text, sent_at, reads FROM said WHERE session_id = ? AND outbox_id IN (SELECT value FROM json_each(?))", sessionId, JSON.stringify(pointed)).map((each) => [each.outbox_id, each] as const),
    );
    const lastOf = new Map<string, number>();
    rows.forEach((each, index) => each.run_id && lastOf.set(each.run_id, index));
    // What is kept beside an item for the system's own use (names starting with "_") is never shown.
    const shown = (item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith("_"))) as Item;
    const entries: { item: Item; starts: boolean }[] = [];
    // Who the run acts for, worked out once and only if some answer is quoted: what they can still
    // point at decides what an answer is shown as written from.
    const acting = quotedOf.size > 0 && runId ? this.actingFor(runId) : undefined;
    rows.forEach((row, index) => {
      const item = JSON.parse(row.item) as Record<string, unknown> & { _replied?: number[] };
      if (row.is_user === 1) {
        const quoted = (item._replied ?? []).flatMap((id) => quotedOf.get(id) ?? []);
        quoted.forEach((each, at) => {
          // What it was written from, by the tool's canonical call, where that is the one thing the
          // person can still point at: what they are asking about, even once that turn is out of sight.
          const source = eligibleSource(JSON.parse(each.reads) as { connector: string; tool: string; args: string; identity: string }[], acting, this.#b.toolsOf);
          const from = source ? linksOf([{ args: JSON.stringify(source.request) }]) : [];
          entries.push({ item: { role: "assistant", content: `[The message of yours they are replying to, sent at ${new Date(each.sent_at).toISOString()}${from.length > 0 ? `, written from ${from.join(", ")}` : ""}:]\n${each.text}` }, starts: at === 0 });
        });
        entries.push({ item: shown(item), starts: quoted.length === 0 });
      } else entries.push({ item: shown(item), starts: false });
      if (row.run_id && lastOf.get(row.run_id) === index) for (const words of wordsOf.get(row.run_id) ?? []) entries.push({ item: words, starts: false });
    });
    let start = Math.max(0, entries.length - MAX_TRANSCRIPT_ITEMS);
    while (start < entries.length && !entries[start].starts) start++;
    if (start >= entries.length) {
      const last = entries.map((each) => each.starts).lastIndexOf(true);
      start = last >= 0 ? last : Math.max(0, entries.length - MAX_TRANSCRIPT_ITEMS);
    }
    return entries.slice(start).map((each) => each.item);
  }

  #toolsFor(runId: string): ToolDefinition[] {
    // A run that carries a request on answers it, and does nothing else.
    if (this.#b.requests.continuationOf(runId)) return TOOLS.filter((each) => each.name === "send_message");
    const acting = this.actingFor(runId);
    const own = TOOLS;
    const all = acting ? [...own, ...toolsIn(acting, this.#b.toolsOf).map((each) => describeTool(each.name, each.description, { ...each.parameters, replaces: REPLACES }))] : own;
    return all.filter((each) => this.mayUse(runId, each.name));
  }

  /**
   * Whether a tool may be used in this run now. Before the run has read outside text: any tool it
   * has. After: the reply to the person, and a connector's tools that only read. That is a list of
   * what is allowed, not of what is forbidden, so a tool added later is refused until it is put on
   * it.
   */
  mayUse(runId: string, name: string): boolean {
    const carried = this.#b.requests.continuationOf(runId);
    // The one call made for it (checked again, by its id, where it is carried out) and its answer.
    const closed = this.#s.rows<{ closed: string | null }>("SELECT closed FROM runs WHERE id = ?", runId)[0]?.closed;
    if (closed === "settled") return false;
    if (carried) return name === "send_message" || (carried.status === "resuming" && name === carried.tool);
    // A run with a call that has to wait is held to the same as one that has read.
    if (!this.sawOutside(runId) && closed !== "waited") return true;
    if (name === "send_message") return true;
    const acting = this.actingFor(runId);
    return acting !== undefined && toolsIn(acting, this.#b.toolsOf).some((each) => each.name === name && each.effect === "read");
  }

  #instructions(runId: string): string {
    // A person who deliberately wrote to the agent is waiting for it; anything else merely happened.
    const waiting = this.#s.rows<{ principal: string }>("SELECT principal FROM inbox WHERE run_id = ? AND kind = 'message'", runId).some((event) => {
      const principal = JSON.parse(event.principal) as Principal;
      return principal.kind === "human" && principal.explicit === true;
    });
    const asker = this.actingFor(runId)?.person;
    return buildInstructions({
      scope: this.#s.scope(),
      situation: waiting ? "conversation" : "background",
      now: Date.now(),
      instructions: this.#s.rows<Row>("SELECT content FROM memory WHERE path = 'instructions.md'")[0]?.content,
      index: this.#s.rows<Row>("SELECT content FROM memory WHERE path = 'index.md'")[0]?.content,
      tasks: this.#s.rows<Row>("SELECT id, title, status FROM tasks WHERE status IN ('dispatching', 'running', 'needs_input') ORDER BY created_at") as any,
      // The requests of the person this run stands for, which only they can call off; none where it stands for nobody.
      requests: (asker ? this.#b.requests.cancellable(this.#s.rows<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", runId)[0]?.session_id ?? "", asker) : []).map((each) => ({ id: each.id, asked: this.#b.requests.askedFor(each) })),
    });
  }

  /** Counts tokens against this scope's daily budget, at once: the count the run loop checks. */
  spend(tokens: number): void {
    this.#s.setMeta(`tokens:${today()}`, String(this.tokensToday() + tokens));
  }

  tokensToday(): number {
    return Number(this.#s.meta(`tokens:${today()}`) ?? 0);
  }

  /** The run to work on next: the active one, a request to carry on, or a new run over pending events. */
  async next(): Promise<string | undefined> {
    for (;;) {
      const active = this.activeRun();
      if (active) return active.retry_at && active.retry_at > Date.now() ? undefined : active.id;
      const first = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0];
      if (!first) return undefined;
      if (first.kind !== "request.ready") {
        // The very messages looked at are the ones taken up: what arrives meanwhile waits its turn.
        const batch = this.#batch(first);
        await this.#quote(batch);
        const runId = this.#claim(batch.map((each) => each.id));
        if (runId || this.activeRun()) return runId;
        continue;
      }
      const runId = await this.#b.requests.resume(first);
      if (runId) return runId;
    }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** How much of a run's room a message takes. */
function sizeOf(event: InboxRow): number {
  return (event.text?.length ?? 0) + (event.data?.length ?? 0) + 300;
}

/**
 * Whether a message is a person's ordinary words: not a button pressed, an answer to a question,
 * words that name an open question, a reply taken only as such, or something routed from
 * elsewhere. One test for taking messages up together and for whose authority a run carries.
 */
function plain(data: Record<string, unknown>): boolean {
  return ["card", "question", "reply_only", "routed_from", "about_question"].every((each) => data[each] === undefined);
}

/** What a message replies to, if anything. */
function repliesTo(event: InboxRow): string | null {
  const to = event.data ? (JSON.parse(event.data) as { replies_to?: unknown }).replies_to : undefined;
  return typeof to === "string" ? to : null;
}

/** The strings in what some reads were made with (their canonical calls): what a person or a model can recognise them by. */
function linksOf(read: { args: string }[]): string[] {
  return [
    ...new Set(
      read.flatMap((each) => {
        try {
          return Object.values(JSON.parse(each.args) as Record<string, unknown>).filter((value): value is string => typeof value === "string");
        } catch {
          return [];
        }
      }),
    ),
  ];
}

/** Function calls in the transcript that have no output yet. */
/**
 * What a connector verified about where an event came from, with its keys in order. Undefined
 * unless it is a set of named, non-empty strings: an origin with a gap in it identifies nothing.
 */
function originOf(event: InboxRow): Record<string, string> | undefined {
  const origin = event.data ? (JSON.parse(event.data) as { origin?: unknown }).origin : undefined;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return undefined;
  const entries = Object.entries(origin as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0 || entries.some(([key, value]) => key === "" || typeof value !== "string" || value === "" || value === "undefined")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function danglingCalls(items: Item[]): ToolCall[] {
  const answered = new Set(items.filter((i) => i.type === "function_call_output").map((i) => i.call_id));
  return items.filter((i) => i.type === "function_call" && !answered.has(i.call_id)).map((i) => ({ call_id: i.call_id, name: i.name, arguments: i.arguments ?? "{}" }));
}

/** One line per event, saying when it happened and who caused it, so the model can tell people from machines. */
function renderEvent(event: InboxRow): string {
  const principal = JSON.parse(event.principal) as Principal;
  const who =
    principal.kind === "human"
      ? `${principal.display ?? principal.id} (person, id ${principal.id}${principal.explicit ? ", addressing you" : ", not addressing you"})`
      : principal.kind === "worker"
        ? `worker for task ${principal.id}`
        : principal.kind === "timer"
          ? "a timer you set"
          : `${principal.display ?? principal.id} (automated)`;
  // Where it happened, as the connector established it: the text alone often does not say.
  const where = event.data ? (JSON.parse(event.data) as { where?: unknown }).where : undefined;
  const place = typeof where === "string" && where ? `, in ${where.replace(/\s+/g, " ").slice(0, 200)}` : "";
  return `[${new Date(event.received_at).toISOString()}] ${event.kind} from ${who}${place}: ${event.text ?? ""}`.trim();
}
