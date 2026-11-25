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
import type { Picture, PictureRef } from "../connectors/types";
import type { Env } from "../env";
import type { Worker } from "../workers";
import { type ChainLevel, type Principal, type Target, chainLevels, privateSessionKey } from "../events";
import { type Item, ModelError, type ModelRequest, type ModelResponse, type ToolDefinition } from "../model/openai";
import type { registry } from "../registry";
import type { Outbox } from "./outbox";
import { buildInstructions } from "./prompt";
import { HANDLING_LIMIT_MS, type Requests } from "./requests";
import { READ_OUTSIDE, type RunTools, eligibleSource, standingOf, toolsIn, workersIn } from "./run-tools";
import type { BrainStore, InboxRow, Row, RunRow } from "./store";
import { workIs } from "./work";
import { TOOLS, type ToolCall, describeTool, executeTool, workTools } from "./tools";

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
/** How far up the chain of replies a message stands in is followed. */
export const MAX_CHAIN = 5;
const MAX_EVENT_BYTES_PER_RUN = 120_000;
/** How many pictures a run is shown at most: the latest. */
const MAX_PICTURES_SHOWN = 4;
/** How long before a message the same person's pictures here still count as going with it. */
const PICTURES_RECENT_MS = 10 * 60_000;
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
  /** Every worker this deployment lists. */
  workers(): Worker[];
  /** The deployment's guidance on which worker a piece of work goes to. */
  guidance(): string;
  /** Whether a piece of work done in a person's name still stands under what it was done under: see BrainAgent. */
  workStands(work: { id: string; state: string; condition: string | null; generation: number | null }): Promise<boolean>;
  /** Where the tenant's usage is kept. */
  registry(): Pick<ReturnType<typeof registry>, "recordUsage" | "adjustUsage">;
  /** One call to the model. */
  respond(request: ModelRequest): Promise<ModelResponse>;
  /** The message one was written in reply to, asked of the connector it came through. Never throws. */
  quoted(connector: string, event: { principal: Principal; data?: Record<string, unknown>; signal?: AbortSignal }): Promise<Quoted | undefined>;
  /** Pictures people sent, fetched through the connector they came by: null for each that cannot be had. Never throws. */
  pictures(connector: string, event: { data?: Record<string, unknown> }, refs: PictureRef[]): Promise<(Picture | null)[]>;
  /** The message something sent to this address is written under, where the connector says. */
  under(target: Target): string | undefined;
  readonly requests: Pick<Requests, "continuationOf" | "draft" | "mayNotDisclose" | "endRequest" | "guards" | "over" | "basis" | "resumed" | "cancellable" | "askedFor" | "resume" | "readsOf" | "record" | "indexed" | "promised" | "told">;
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
      // What is shown with a message because of what it leads back to (an answer of the agent's,
      // an earlier message of the person's) counts too: each such thing once for the run.
      const counted = new Set<string>();
      for (const event of ids.length === 0 ? [] : this.#s.rows<InboxRow>(`SELECT * FROM inbox WHERE status = 'pending' AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids)) {
        const shown = this.#shownWith(event).filter((each) => !counted.has(each.key));
        bytes += sizeOf(event) + shown.reduce((sum, each) => sum + each.size, 0);
        if (events.length > 0 && bytes > MAX_EVENT_BYTES_PER_RUN) break;
        for (const each of shown) counted.add(each.key);
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
      // Likewise an earlier message of the person's own that one of these leads back to: named, not copied.
      const replied: number[] = [];
      // And what stands further up the chain of replies: named, never copied, and shown from
      // where it is kept each time the transcript is put together (oldest first, each thing once).
      const chain: Link[] = [];
      const content = events.map((each) => renderEvent(each) + this.#repliedTo(each, session.id, replied, chain)).join("\n");
      this.append(session.id, runId, { role: "user", content, ...(replied.length > 0 ? { _replied: replied } : {}), ...(chain.length > 0 ? { _chain: chain } : {}) } as Item);
      this.#s.setMeta("active_run", runId);
      return runId;
    });
  }

  /**
   * What a message was written in reply to, for the model: the text alone does not say. A
   * message of the same person's in this conversation is quoted (their own words, as stored);
   * one of the agent's is only named by when it was sent, since what it said may not be kept.
   */
  /**
   * The one person who wrote every message this run was started by, where it acts for nobody:
   * all of them ordinary messages, through one connector the deployment trusts, with one and the
   * same verified origin, by one human. Told apart by all of that, not by an id alone.
   */
  #writerOf(runId: string): { person: string; connector: string; origin: Record<string, string> } | undefined {
    const events = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE run_id = ?", runId);
    const first = events[0];
    const origin = first ? originOf(first) : undefined;
    if (!first || !origin) return undefined;
    const who = JSON.parse(first.principal) as Principal;
    const same = (event: InboxRow) => {
      const principal = JSON.parse(event.principal) as Principal;
      return event.kind === "message" && event.source === first.source && this.#b.isDecider(principal, event.source) && principal.id === who.id && plain(event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {}) && JSON.stringify(originOf(event)) === JSON.stringify(origin);
    };
    return events.every(same) ? { person: who.id, connector: first.source, origin } : undefined;
  }

  /** What would be shown with this message because of what it leads back to, and how much each is: for measuring a run before it starts. */
  #shownWith(event: InboxRow): { key: string; size: number }[] {
    const sessionId = this.#s.rows<{ id: string }>("SELECT id FROM sessions WHERE session_key = ?", event.session_key)[0]?.id ?? "";
    const replied: number[] = [];
    const chain: Link[] = [];
    const note = this.#repliedTo(event, sessionId, replied, chain);
    // In the units the messages themselves are measured in (sizeOf), with room for what is written around each when it is shown.
    const words = (id: number) => (this.#s.rows<{ text: string }>("SELECT text FROM said WHERE outbox_id = ?", id)[0]?.text.length ?? 0) + SHOWN_AROUND;
    return [
      // What is written into the turn itself about what the message replies to.
      { key: `note:${event.id}`, size: note.length },
      ...replied.map((id) => ({ key: `said:${id}`, size: words(id) })),
      ...chain.map((each) => {
        if (each.kind === "said") return { key: `said:${each.id}`, size: words(each.id) };
        if (each.kind === "inbox") return { key: `inbox:${each.id}`, size: MAX_POINTED_TEXT + MAX_LINKS_TEXT + SHOWN_AROUND };
        // Kept with the message itself, so already measured with it (sizeOf counts its data): only what is written around it.
        return { key: each.kind === "fetched" ? `fetched:${each.event}:${each.level}` : `${each.kind}:${event.id}`, size: 200 };
      }),
    ];
  }

  /** The stored message another was written in reply to: the very one, earlier, in the same conversation and through the same connector. */
  #parentOf(event: InboxRow, subject: string): InboxRow | undefined {
    const prefix = `${event.source}:message:`;
    if (!subject.startsWith(prefix)) return undefined;
    return this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE source = ? AND source_id = ? AND kind = 'message' AND session_key = ? AND id < ?", event.source, subject.slice(prefix.length), event.session_key, event.id)[0];
  }

  #repliedTo(event: InboxRow, sessionId: string, replied: number[], chain: Link[] = []): string {
    const subject = event.kind === "message" && event.data ? (JSON.parse(event.data) as { replies_to?: unknown }).replies_to : undefined;
    if (typeof subject !== "string") return "";
    return this.#repliedDirectly(event, sessionId, subject, replied, chain) + this.#repliedFurther(event, sessionId, chain);
  }

  /** What the message it replies to itself is, for the model. */
  #repliedDirectly(event: InboxRow, sessionId: string, subject: string, replied: number[], chain: Link[]): string {
    const parent = this.#parentOf(event, subject);
    const who = (row: InboxRow) => JSON.parse(row.principal) as Principal;
    // (Where its words are cut short, the links beyond the cut are named too: any of them may be what is meant.)
    if (parent && parent.text !== null && who(parent).kind === "human" && who(event).kind === "human" && who(parent).id === who(event).id) return `\n  (written as a reply to their own earlier message: ${JSON.stringify(parent.text.slice(0, 500))}${parent.text.length > 500 ? linked(addressesIn(parent.text.slice(200))).replace("\n", " ") : ""})`;
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
    if (typeof quoted.text !== "string") return "\n  (written as a reply to a message here that is not shown to you: someone else's, or one that could not be read)";
    // Their own words, kept with this message and shown from there: not copied into the turn,
    // which everyone who talks here is later shown.
    push(chain, { kind: "fetched", event: event.id, level: 1, by: (JSON.parse(event.principal) as Principal).id });
    return "\n  (written as a reply to an earlier message of their own that you were not sent, shown just before this)";
  }

  /**
   * What stands further up the chain of replies, beyond the message replied to: each named for
   * showing before the turn, oldest first. An answer of the agent's delivered here; a message of
   * the same person's on record here; their own words the connector fetched; or only that
   * something stood there (someone else's, or nothing that can be shown).
   */
  #repliedFurther(event: InboxRow, sessionId: string, chain: Link[]): string {
    const levels = chainLevels(JSON.parse(event.data ?? "{}") as Record<string, unknown>);
    if (levels.length === 0) return "";
    const by = (JSON.parse(event.principal) as Principal).id;
    const found: Link[] = [];
    levels.forEach((level, index) => {
      if (level.cut || typeof level.subject !== "string") return void (level.cut && found.push({ kind: "cut" }));
      const words = this.#s.rows<{ outbox_id: number }>("SELECT outbox_id FROM said WHERE receipt_subject = ? AND session_id = ? ORDER BY outbox_id DESC LIMIT 1", level.subject, sessionId)[0];
      if (words) return void found.push({ kind: "said", id: words.outbox_id });
      const parent = this.#parentOf(event, level.subject);
      const who = parent ? (JSON.parse(parent.principal) as Principal) : undefined;
      if (parent && parent.text !== null && who?.kind === "human" && who.id === by) return void found.push({ kind: "inbox", id: parent.id, by });
      if (typeof level.text === "string") return void found.push({ kind: "fetched", event: event.id, level: index + 2, by });
      found.push({ kind: "hidden" });
    });
    // Oldest first; and before the message replied to itself, where that is shown this way too.
    const direct = chain.findIndex((each) => each.kind === "fetched" && each.event === event.id && each.level === 1);
    let at = direct >= 0 ? direct : chain.length;
    for (const each of found.reverse()) if (push(chain, each, at)) at++;
    return "\n  (that stands in a chain of replies: what it leads back to is shown just before this, oldest first)";
  }

  /**
   * Before a run takes these messages up: for each that was written in reply to something the
   * Brain has no record of, the connector is asked for it, once, and what it says is kept with
   * the message. The messages were stored and acknowledged long before; this only adds to what
   * the model is shown. All of them are asked about at once, within one limit for the lot; what
   * has not answered by then is told to stop, and the run starts whatever came of it.
   */
  async #quote(events: InboxRow[]): Promise<void> {
    // Followed once for each person and message replied to, however many messages say so.
    const asked = new Map<string, { event: InboxRow; ids: number[] }>();
    for (const event of events) {
      const data = event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {};
      const principal = JSON.parse(event.principal) as Principal;
      // Only a person's ordinary message written as a reply, and only once: not an answer to a question.
      if (event.kind !== "message" || principal.kind !== "human" || typeof data.replies_to !== "string" || data.quoted !== undefined || data.chain !== undefined || data.question !== undefined) continue;
      const key = JSON.stringify([event.source, principal.id, data.replies_to, data.origin ?? null]);
      const same = asked.get(key);
      if (same) same.ids.push(event.id);
      else asked.set(key, { event, ids: [event.id] });
    }
    if (asked.size === 0) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One limit for all of it. What has not come back by then is left out, and said to be.
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), QUOTED_WAIT_MS)));
    await Promise.all(
      [...asked.values()].map(async ({ event, ids }) => {
        const found = await this.#walk(event, stop.signal, late).catch(() => undefined);
        if (!found) return;
        for (const id of ids) {
          if (found.quoted) this.#s.sql.exec("UPDATE inbox SET data = json_set(data, '$.quoted', json(?)) WHERE id = ? AND status = 'pending'", JSON.stringify(found.quoted), id);
          // Always written once the chain was followed, also when there is nothing above: so that it is not followed, or read the older way, again.
          this.#s.sql.exec("UPDATE inbox SET data = json_set(data, '$.chain', json(?)) WHERE id = ? AND status = 'pending'", JSON.stringify([...found.chain, ...(found.partial ? [{ cut: true }] : [])]), id);
        }
      }),
    );
    clearTimeout(timer);
    stop.abort();
  }

  /**
   * The chain of replies a message stands in, from the message it replies to upwards: at most
   * MAX_CHAIN messages. Each is looked for in the Brain's own records first (a message that
   * reached it here, an answer of its own as it was delivered here); only one there is no record
   * of is asked of the connector, which gives the person's own words or, for anyone else's,
   * nothing but where it points. What is on record is kept as a name only; what was fetched is
   * kept with the message that led to it. Ends where a message replies to nothing, where the
   * same message comes round again, or where time runs out (`partial`).
   */
  async #walk(event: InboxRow, signal: AbortSignal, late: Promise<"late">): Promise<{ quoted?: Record<string, unknown>; chain: Level[]; partial: boolean }> {
    const data = event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {};
    const principal = JSON.parse(event.principal) as Principal;
    const chain: Level[] = [];
    let quoted: Record<string, unknown> | undefined;
    const seen = new Set<string>();
    let subject: string | undefined = data.replies_to as string;
    let partial = false;
    for (let level = 1; subject !== undefined; level++) {
      // Round in a circle, or not the name of a message that came through this connector: it ends here.
      if (seen.has(subject) || !subject.startsWith(`${event.source}:message:`)) break;
      if (level > MAX_CHAIN) {
        partial = true;
        break;
      }
      seen.add(subject);
      const here = this.#onRecord(event, subject);
      let next: string | undefined;
      if (here) {
        next = here.next;
        if (level > 1) chain.push({ subject });
      } else {
        const found: Quoted | "late" | undefined = await Promise.race([this.#b.quoted(event.source, { principal, data: { ...data, replies_to: subject }, signal }), late]).catch((): Quoted => ({}));
        if (found === "late") {
          // Not back in time: for the message replied to itself, as one that could not be read.
          if (level === 1) quoted = {};
          else partial = true;
          break;
        }
        // Where the connector has no such thing at all, nothing is kept, as before.
        if (found === undefined) break;
        const own = typeof found.text === "string";
        const kept = own ? { text: found.text, ...(Array.isArray(found.documents) && found.documents.length > 0 ? { documents: found.documents } : {}), ...(Array.isArray(found.pictures) && found.pictures.length > 0 ? { pictures: found.pictures } : {}), ...(typeof found.at === "number" ? { at: found.at } : {}) } : {};
        next = typeof found.replies_to === "string" ? found.replies_to : undefined;
        if (level === 1) quoted = { ...kept, ...(own && next ? { replies_to: next } : {}) };
        else chain.push({ subject, ...(own ? kept : { hidden: true }) });
      }
      subject = next;
    }
    return { ...(quoted ? { quoted } : {}), chain, partial };
  }

  /**
   * A message on the Brain's own record in this conversation, by its name, and what it was
   * itself written in reply to: one that reached the agent here (whoever wrote it), or one the
   * agent sent here. Undefined where there is no record of it.
   */
  #onRecord(event: InboxRow, subject: string): { next?: string } | undefined {
    const prefix = `${event.source}:message:`;
    const arrived = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE source = ? AND source_id = ? LIMIT 1", event.source, subject.slice(prefix.length))[0];
    if (arrived) {
      // Followed further only within this conversation: a message filed under another is where this ends.
      const above = arrived.session_key === event.session_key ? (JSON.parse(arrived.data ?? "{}") as { replies_to?: unknown }).replies_to : undefined;
      return { ...(typeof above === "string" ? { next: above } : {}) };
    }
    // The agent's own answer, delivered in this conversation: known by what it said, whatever
    // has become of the row it was sent by. What it was sent under comes from the address it was
    // really sent to, if that row is still there; if not, the chain ends at the answer.
    const answer = this.#s.rows<{ outbox_id: number }>("SELECT w.outbox_id FROM said w JOIN sessions s ON s.id = w.session_id WHERE w.receipt_subject = ? AND s.session_key = ? ORDER BY w.outbox_id DESC LIMIT 1", subject, event.session_key)[0];
    if (answer) {
      const target = this.#s.rows<{ target: string }>("SELECT target FROM outbox WHERE id = ?", answer.outbox_id)[0]?.target;
      let above: string | undefined;
      try {
        above = target ? this.#b.under(JSON.parse(target) as Target) : undefined;
      } catch {
        above = undefined;
      }
      return { ...(above ? { next: above } : {}) };
    }
    // Anything else it sent here (a notice, a card): the chain ends there.
    return this.#s.rows("SELECT 1 FROM outbox WHERE json_extract(receipt, '$.subject') = ? LIMIT 1", subject).length > 0 ? {} : undefined;
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
      // The pictures this run is shown, fetched once for the run and held only while it lasts.
      const pictures = await this.#picturesShown(runId);
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
      /** Closes the calls left open, unrun. */
      const leave = () =>
        this.#s.transaction(() => {
          for (const call of dangling) this.append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "not carried out" }) });
        });
      // One that is no longer being carried on (called off, told to wait again, ended): nothing
      // of it is done, nobody is asked anything, and nothing more is said.
      if (making && making.status !== "resuming") {
        leave();
        break;
      }
      if (making?.status === "resuming") {
        let why: string | undefined;
        try {
          why = await this.#b.requests.mayNotDisclose(making);
        } catch (err) {
          return this.#retryLater(runId, err);
        }
        if (!this.#stillActive(runId)) return;
        // It may have been called off while the owner was asked: then that is how it ended, and it is not told otherwise.
        const still = this.#b.requests.continuationOf(runId)?.status === "resuming";
        if (why || !still) {
          leave();
          if (still) {
            this.#b.requests.endRequest(making.id, "void", why!);
            this.#b.outbox.notify(`withheld:${runId}`, run.session_id, null, this.#b.outbox.notice("withheld", run.session_id));
          }
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

      // What the model is told besides the transcript is put together first: it asks others things
      // (whether work done in the person's name still stands), and nothing may be waited for
      // between the checks below and the call.
      let instructions: string;
      try {
        instructions = await this.#instructions(runId);
      } catch (err) {
        await release();
        return this.#retryLater(runId, err);
      }
      if (!this.#stillActive(runId)) return void (await release());

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

      const offered = this.#toolsFor(runId);
      // What the model is asked with: the same for the note of its shape and for the call.
      const input = this.#withPictures(runId, items, pictures);
      this.#noteShape(runId, input, offered);
      let response;
      try {
        response = await this.#b.respond({
          baseUrl: this.#b.env.OPENAI_BASE_URL,
          apiKey: this.#b.env.OPENAI_API_KEY,
          model: this.#b.env.BRAIN_MODEL,
          instructions,
          input,
          tools: offered,
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
      const never = this.#s.rows<{ id: string; worker: string; session_key: string; requested_by: string | null }>("UPDATE tasks SET status = 'failed', updated_at = ? WHERE status = 'dispatching' AND session_key = (SELECT session_key FROM sessions WHERE id = ?) RETURNING id, worker, session_key, requested_by", Date.now(), run.session_id);
      for (const each of never) workIs(this.#s, { id: each.id, worker: each.worker, sessionKey: each.session_key, person: each.requested_by }, "failed");
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
      this.#forgetPersonal(run);
      this.#forgetOutside(run, read);
      if (this.#s.meta("active_run") === runId) this.#s.sql.exec("DELETE FROM meta WHERE key = 'active_run'");
      // The pictures it was shown are let go with it.
      if (this.#shown?.run === runId) this.#shown = undefined;
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
    // (Whether the connector has any tool for such a place at all: which of them this run has is worked out from its messages, below and in toolsIn.)
    if (!origin || !this.#b.toolsOf(source).some((each) => !shared || each.shared === true)) return undefined;
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
      // (There: by the connector's own word for all its tools, or by a tool being offered for this very message.)
      const there = data.shared === true || (data.group === true && Array.isArray(data.offered) && data.offered.length > 0);
      if (!(shared ? there : data.direct === true) || !plain(data)) return false;
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
      // And every message further up the chain of replies (the same chain the model is shown).
      const pointed = events.flatMap((each) => {
        const data = JSON.parse(each.data ?? "{}") as Record<string, unknown>;
        return [data.replies_to, ...chainLevels(data).map((level) => level.subject)].filter((subject): subject is string => typeof subject === "string");
      });
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
  /**
   * Where several people talk, the conversation's record is read by whoever asks next. A run in
   * which something was done in one person's name (work handed to a worker that acts as them,
   * asked about, stopped) leaves nothing of itself there: not its calls and their answers, not
   * what the model wrote on the way, not a draft that was never sent, not the system's word to a
   * run that carried a request on. Only what actually reached the conversation is put back, from
   * the record of what was sent (see #window). That is what clearing a run that read outside text
   * already does, so such a run is cleared the same way when it ends. Who may see a thing is kept
   * apart from whether it came from outside: nothing is limited while the run lasts.
   */
  #forgetPersonal(run: RunRow): void {
    if (this.#s.scope().kind !== "chat") return;
    const rows = this.#s.rows<{ seq: number; is_user: number; item: string }>("SELECT seq, is_user, item FROM items WHERE run_id = ?", run.id).map((each) => ({ seq: each.seq, user: each.is_user === 1, item: JSON.parse(each.item) as Item }));
    // The tools that carry a worker, by what the connectors say of their own tools: not only those of workers listed now.
    // (For a run that carries a request on, the connector the request was made through.)
    const carried = this.#b.requests.continuationOf(run.id)?.connector;
    const sources = [...this.#s.rows<{ source: string }>("SELECT DISTINCT source FROM inbox WHERE run_id = ?", run.id).map((each) => each.source), ...(carried ? [carried] : [])];
    const carrying = new Map(sources.flatMap((source) => this.#b.toolsOf(source).flatMap((tool) => (tool.hands_to ? [[tool.name, tool.hands_to] as const] : []))));
    const acting = new Set([...carrying.values(), ...this.#b.workers().flatMap((each) => (each.tool ? [each.name] : []))]);
    const args = (item: Item): Record<string, unknown> => {
      try {
        return JSON.parse(String(item.arguments ?? "{}")) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const task = (id: unknown) => this.#s.rows("SELECT 1 FROM tasks WHERE id = ?", String(id ?? "")).length > 0;
    const theirs = (item: Item): boolean => {
      if (item.type !== "function_call") return false;
      if (carrying.has(String(item.name))) return true;
      if (item.name === "hand_over") return acting.has(String(args(item).worker));
      // By its id: theirs unless it is a task, which is the conversation's.
      if (item.name === "work_status" || item.name === "cancel_work") return !task(args(item).work_id);
      if (item.name === "cancel_request") return carrying.has(String(this.#b.requests.record(String(args(item).request_id ?? ""))?.tool));
      return false;
    };
    const calls = new Set(rows.filter((each) => !each.user && theirs(each.item)).map((each) => String(each.item.call_id)));
    // Or it was given such work to read (its id, what was asked, how it stands), whatever it then did with that.
    const given = this.#s.meta(`personal:${run.id}`) !== undefined;
    this.#s.sql.exec("DELETE FROM meta WHERE key = ?", `personal:${run.id}`);
    if (calls.size === 0 && !given) return;
    for (const each of rows) if (each.user && (each.item as { _carried?: boolean })._carried === true) this.#s.sql.exec("DELETE FROM items WHERE run_id = ? AND seq = ?", run.id, each.seq);
    // Cleared as a run that read outside text is: marked, and left to that.
    this.#s.sql.exec("UPDATE items SET outside = 1 WHERE run_id = ? AND is_user = 0 AND outside = 0", run.id);
  }

  #forgetOutside(run: RunRow, read: { args: string }[] = []): void {
    if (this.#s.rows("SELECT 1 FROM items WHERE run_id = ? AND outside = 1 LIMIT 1", run.id).length === 0) return;
    this.#s.sql.exec("DELETE FROM items WHERE run_id = ? AND is_user = 0", run.id);
    // Fixed words, and what the tool said it read. Nothing the model wrote is carried over, not even what it asked a tool for.
    // What a worker's tool was called with names a piece of work, not something the person pointed to: it is not named in the note.
    const links = linksOf((read as { args: string; connector?: string; tool?: string }[]).filter((each) => !this.#b.toolsOf(String(each.connector ?? "")).some((tool) => tool.name === each.tool && tool.hands_to)));
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
    // What a cleared turn said in this conversation, as it reached it, is the conversation's: everyone
    // there saw it, so any later run here is given it, whoever it acts for or nobody (a timer, a
    // worker's report). It is what was sent to this very conversation and arrived: nothing sent to
    // one person alone, nothing unsent, nothing from another conversation or topic.
    // (What an answer was written from, and for whom, stays with runs that act for someone there: below.)
    const mayShow = this.#s.scope().kind !== "chat" || (runId !== undefined && this.actingFor(runId) !== undefined);
    for (const each of this.#s.rows<{ run_id: string; text: string }>(
      "SELECT run_id, text FROM said WHERE session_id = ? AND run_id IN (SELECT DISTINCT run_id FROM items WHERE session_id = ? AND seq >= ? AND is_user = 0 AND outside = 2) ORDER BY outbox_id",
      sessionId,
      sessionId,
      from,
    )) {
      wordsOf.set(each.run_id, [...(wordsOf.get(each.run_id) ?? []), { role: "assistant", content: each.text }]);
    }
    // The words people replied to, for every reply in the window, in one query.
    const pointed = rows.flatMap((row) => {
      if (row.is_user !== 1) return [];
      const item = JSON.parse(row.item) as { _replied?: number[]; _chain?: Link[] };
      return [...(item._replied ?? []), ...(item._chain ?? []).flatMap((each) => (each.kind === "said" ? [each.id] : []))];
    });
    const quotedOf = new Map(
      pointed.length === 0 || !mayShow ? [] : this.#s.rows<{ outbox_id: number; text: string; sent_at: number; reads: string; person: string | null }>("SELECT outbox_id, text, sent_at, reads, person FROM said WHERE session_id = ? AND outbox_id IN (SELECT value FROM json_each(?))", sessionId, JSON.stringify(pointed)).map((each) => [each.outbox_id, each] as const),
    );
    const lastOf = new Map<string, number>();
    rows.forEach((each, index) => each.run_id && lastOf.set(each.run_id, index));
    // What is kept beside an item for the system's own use (names starting with "_") is never shown.
    const shown = (item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith("_"))) as Item;
    const entries: { item: Item; starts: boolean }[] = [];
    // Who the run acts for, worked out once and only if some answer is quoted: what they can still
    // point at decides what an answer is shown as written from.
    const leads = rows.some((row) => row.is_user === 1 && (row.item.includes('"_pointed"') || row.item.includes('"_chain"')));
    const acting = (quotedOf.size > 0 || leads) && runId ? this.actingFor(runId) : undefined;
    // Whose earlier words may be led back to in this run: the person it acts for, where several
    // people talk; in a person's own scope, theirs.
    // (Where the run acts for nobody there, the one person who wrote everything it was started
    // by: their own words, fetched for their own message, are theirs to be shown with it.)
    // (A request being carried on is read by the messages kept for it, as they were taken when it was made.)
    const carrying = runId !== undefined && this.#b.requests.resumed(runId) !== undefined;
    const scope = this.#s.scope();
    const writer = scope.kind === "chat" && !acting && leads && runId ? this.#writerOf(runId) : undefined;
    const through = acting ? { connector: acting.connector, origin: acting.origin } : writer;
    const me = scope.kind === "chat" ? (acting?.person ?? writer?.person) : scope.kind === "user" ? scope.id : undefined;
    rows.forEach((row, index) => {
      const item = JSON.parse(row.item) as Record<string, unknown> & { _replied?: number[]; _pointed?: Pointed[]; _chain?: Link[] };
      if (row.is_user === 1) {
        // An earlier message of the person's own that this turn leads back to: its words as they
        // are kept now, in this conversation, by the same person; or only that there was one.
        // (A turn begins at the first thing shown for it, so the window is never cut between them.)
        const before = entries.length;
        // A message kept here, if it is this conversation's and this run is for the one who wrote it,
        // through the same connector and origin where that is known: theirs then, and theirs now.
        const theirs = (id: number, by: string): InboxRow | undefined => {
          const kept = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE id = ? AND kind = 'message' AND session_key = (SELECT session_key FROM sessions WHERE id = ?)", id, sessionId)[0];
          const same = kept !== undefined && (!through || (kept.source === through.connector && JSON.stringify(originOf(kept)) === JSON.stringify(through.origin)));
          return kept && same && by === me && (JSON.parse(kept.principal) as Principal).id === by ? kept : undefined;
        };
        const lead = (content: string, role: "user" | "assistant" = "user") => entries.push({ item: { role, content }, starts: entries.length === before });
        const GONE = "[An earlier message of theirs that this leads back to is no longer kept.]";
        // (An item written before the whole chain was followed names one such message this way.)
        const links: Link[] = [...(item._pointed ?? []).map((each): Link => ({ kind: "inbox", ...each })), ...(item._chain ?? [])];
        for (const each of links) {
          if (each.kind === "inbox") {
            const kept = theirs(each.id, each.by);
            lead(kept && kept.text !== null ? `[An earlier message of theirs that this leads back to, written at ${new Date(kept.received_at).toISOString()}:]\n${kept.text.slice(0, MAX_POINTED_TEXT)}${linked(kept.text.length > MAX_POINTED_TEXT ? addressesIn(kept.text.slice(MAX_POINTED_TEXT - 300)) : [])}` : GONE);
          } else if (each.kind === "fetched") {
            // Their own words that had to be fetched, kept with the message that led to them.
            const kept = theirs(each.event, each.by);
            const data = kept ? (JSON.parse(kept.data ?? "{}") as Record<string, unknown>) : {};
            const level = (each.level === 1 ? data.quoted : chainLevels(data)[each.level - 2]) as { text?: unknown; documents?: unknown } | undefined;
            const text = typeof level?.text === "string" ? level.text : undefined;
            // What it links, as the connector verified it: also where that lies beyond the words shown.
            const links = Array.isArray(level?.documents) ? (level.documents as { link?: unknown }[]).flatMap((doc) => (typeof doc?.link === "string" ? [doc.link] : [])) : [];
            lead(text !== undefined ? `[An earlier message of theirs that this leads back to, which you were not sent:]\n${text.slice(0, MAX_FETCHED_TEXT)}${linked(links.filter((link) => !text.slice(0, MAX_FETCHED_TEXT).includes(link)))}` : GONE);
          } else if (each.kind === "said") {
            const words = quotedOf.get(each.id);
            if (!words) continue;
            const source = eligibleSource(JSON.parse(words.reads) as { connector: string; tool: string; args: string; identity: string }[], acting, this.#b.toolsOf, words.person, carrying);
            const from = source ? linksOf([{ args: JSON.stringify(source.request) }]) : [];
            lead(`[A message of yours further up the chain of replies, sent at ${new Date(words.sent_at).toISOString()}${from.length > 0 ? `, written from ${from.join(", ")}` : ""}:]\n${words.text}`, "assistant");
          } else lead(each.kind === "cut" ? "[The chain of replies goes further back than was followed.]" : "[A message here that this leads back to is not shown to you: someone else's, or one that could not be read.]");
        }
        const led = entries.length > before;
        // (One already shown as part of the chain is not shown a second time.)
        const chained = new Set((item._chain ?? []).flatMap((each) => (each.kind === "said" ? [each.id] : [])));
        const quoted = [...new Set(item._replied ?? [])].filter((id) => !chained.has(id)).flatMap((id) => quotedOf.get(id) ?? []);
        quoted.forEach((each, at) => {
          // What it was written from, by the tool's canonical call, where that is the one thing the
          // person can still point at: what they are asking about, even once that turn is out of sight.
          const source = eligibleSource(JSON.parse(each.reads) as { connector: string; tool: string; args: string; identity: string }[], acting, this.#b.toolsOf, each.person, carrying);
          const from = source ? linksOf([{ args: JSON.stringify(source.request) }]) : [];
          entries.push({ item: { role: "assistant", content: `[The message of yours they are replying to, sent at ${new Date(each.sent_at).toISOString()}${from.length > 0 ? `, written from ${from.join(", ")}` : ""}:]\n${each.text}` }, starts: at === 0 && !led });
        });
        entries.push({ item: shown(item), starts: quoted.length === 0 && !led });
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

  /**
   * Which pictures a run is shown, by name: those in the messages it was started by; those in
   * the message one of them was written in reply to (the person's own); and, where there is
   * room left, those the same person wrote in this conversation in the minutes before, since a
   * picture and the question about it often come as two messages. The first two come first:
   * what the person sent now, or pointed at, is never pushed out by what they sent earlier.
   * Only people's own messages, written in this very conversation through one connector and
   * origin: a message brought here from another conversation carries no picture with it.
   */
  #picturesFor(runId: string): { connector: string; data: Record<string, unknown>; refs: (PictureRef & { from: "now" | "replied" | "earlier" })[]; left: number } | undefined {
    if (this.#b.requests.continuationOf(runId)) return undefined;
    const dataOf = (row: InboxRow) => JSON.parse(row.data ?? "{}") as Record<string, unknown>;
    const who = (row: InboxRow) => JSON.parse(row.principal) as Principal;
    // Written here, by a person: not something routed here from where it was written.
    const here = (row: InboxRow) => who(row).kind === "human" && dataOf(row).routed_from === undefined;
    const events = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE run_id = ? AND kind = 'message' ORDER BY id", runId).filter(here);
    const last = events.at(-1);
    // Started by more than one person's messages: nobody's pictures are shown, since each is its sender's alone.
    if (!last || events.some((each) => who(each).id !== who(last).id)) return undefined;
    const origin = JSON.stringify(originOf(last));
    const same = (row: InboxRow) => row.source === last.source && JSON.stringify(originOf(row)) === origin;
    const named = (value: unknown): PictureRef[] => (Array.isArray(value) ? value.filter((each): each is PictureRef => typeof each?.message === "string" && typeof each?.key === "string").map((each) => ({ message: each.message, key: each.key })) : []);
    const now: PictureRef[] = [];
    const replied: PictureRef[] = [];
    for (const event of events.filter(same)) {
      const data = dataOf(event);
      now.push(...named(data.pictures));
      // The message it was written in reply to: fetched for it, or on record here as the same person's.
      replied.push(...named((data.quoted as { pictures?: unknown } | undefined)?.pictures));
      const parent = typeof data.replies_to === "string" && data.replies_to.startsWith(`${event.source}:message:`) ? data.replies_to.slice(`${event.source}:message:`.length) : undefined;
      const kept = parent ? this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE kind = 'message' AND source = ? AND source_id = ? AND session_key = ?", event.source, parent, event.session_key)[0] : undefined;
      if (kept && here(kept) && same(kept) && who(kept).id === who(event).id) replied.push(...named(dataOf(kept).pictures));
    }
    // Earlier messages of the same person here, shortly before: the latest of them, for the room that is left.
    const first = events[0];
    const earlier = this.#s
      .rows<InboxRow>("SELECT * FROM inbox WHERE kind = 'message' AND source = ? AND session_key = ? AND received_at >= ? AND id < ? AND data LIKE '%\"pictures\"%' ORDER BY id", last.source, last.session_key, first.received_at - PICTURES_RECENT_MS, first.id)
      .filter((row) => here(row) && same(row) && who(row).id === who(last).id)
      .flatMap((row) => named(dataOf(row).pictures));
    // Every one that could go with it, once, in the order they were written; where one is named twice, its nearest standing counts.
    const all = [...earlier.map((each) => ({ ...each, from: "earlier" as const })), ...replied.map((each) => ({ ...each, from: "replied" as const })), ...now.map((each) => ({ ...each, from: "now" as const }))];
    const rank = { now: 0, replied: 1, earlier: 2 };
    const once = all.filter((ref, at) => !all.some((other, there) => other.message === ref.message && other.key === ref.key && (rank[other.from] < rank[ref.from] || (rank[other.from] === rank[ref.from] && there < at))));
    // Chosen by standing, and within one standing the latest first; shown in the order they were written.
    const chosen = new Set([...once].reverse().sort((a, b) => rank[a.from] - rank[b.from]).slice(0, MAX_PICTURES_SHOWN));
    const refs = once.filter((each) => chosen.has(each));
    return refs.length > 0 ? { connector: last.source, data: dataOf(last), refs, left: once.length - refs.length } : undefined;
  }

  /** The pictures of the one run under way, as they are being fetched: held in memory and nowhere else. */
  #shown?: { run: string; parts: Promise<Item[]> };

  /** What is put after the words of a run's own turn: each picture under a line saying where it is from, and a line in its place for one that could not be had. */
  #picturesShown(runId: string): Promise<Item[]> {
    if (this.#shown?.run === runId) return this.#shown.parts;
    const wanted = this.#picturesFor(runId);
    const FROM = { now: "of what is above", replied: "of the message this was written in reply to", earlier: "of an earlier message of theirs here" };
    const parts = !wanted
      ? Promise.resolve([])
      : this.#b.pictures(wanted.connector, { data: wanted.data }, wanted.refs.map((each) => ({ message: each.message, key: each.key }))).then((got) => [
          { type: "input_text", text: "[The pictures that go with this follow, each under a line saying where it is from; those of one message in the order they stand in it. You see them in this turn only.]" + (wanted.left > 0 ? ` [${wanted.left} more that would go with this ${wanted.left === 1 ? "is" : "are"} not shown: only the latest ${wanted.refs.length} are, and earlier ones were left out. Do not take the last one shown for the last one sent without saying so.]` : "") },
          ...wanted.refs.flatMap((ref, at): Item[] => {
            const picture = got[at];
            return picture ? [{ type: "input_text", text: `[A picture ${FROM[ref.from]}:]` }, { type: "input_image", image_url: `data:${picture.mime};base64,${picture.data}` }] : [{ type: "input_text", text: `[A picture ${FROM[ref.from]} could not be shown to you.]` }];
          }),
        ]);
    this.#shown = { run: runId, parts };
    return parts;
  }

  /** The transcript with a run's pictures put after the words of its own turn. Nothing of them is stored. */
  #withPictures(runId: string, items: Item[], pictures: Item[]): Item[] {
    if (pictures.length === 0) return items;
    const own = this.#s.rows<{ item: string }>("SELECT item FROM items WHERE run_id = ? AND is_user = 1 ORDER BY seq LIMIT 1", runId)[0];
    const content = own ? (JSON.parse(own.item) as { content?: unknown }).content : undefined;
    const at = typeof content === "string" ? items.map((each) => each.role === "user" && each.content === content).lastIndexOf(true) : -1;
    return at < 0 ? items : items.map((each, index) => (index === at ? { ...each, content: [{ type: "input_text", text: content }, ...pictures] } : each));
  }

  /**
   * For the operator: the shape of what the model was shown the last time it was asked in a
   * run, noted at that moment (see #noteShape). Undefined where nothing was noted: a run from
   * before this was kept, one that never reached the model, or one no longer among the latest.
   */
  shapeOf(runId: string): Shape | undefined {
    const noted = this.#s.meta(`shape:${runId}`);
    return noted ? (JSON.parse(noted) as Shape) : undefined;
  }

  /**
   * Notes, as the model is about to be asked, the shape of what it is shown: for each of the
   * last entries, whose it is, how long, and which of the system's own kinds of entry it is,
   * by name from a fixed list; for a person's turn, how many of each of the system's own notes
   * about replies stand under it. Never a word of what anyone or anything said. With it: the
   * tools offered, whether someone counts as waiting, and whether the run acts for a person.
   * Kept for the latest few runs.
   */
  #noteShape(runId: string, items: Item[], tools: ToolDefinition[]): void {
    const shown = items.slice(-14).map((item) => {
      const body = item as Record<string, unknown>;
      const content = typeof body.content === "string" ? body.content : Array.isArray(body.content) ? (body.content as { text?: unknown }[]).map((each) => String(each?.text ?? "")).join("") : String(body.output ?? body.arguments ?? "");
      const kind = SHAPE_KINDS.find(([, starts]) => starts.test(content))?.[0];
      const notes = body.role === "user" ? Object.fromEntries(SHAPE_NOTES.map(([name, line]) => [name, content.split("\n").filter((each) => line.test(each)).length] as const).filter(([, count]) => count > 0)) : {};
      const images = Array.isArray(body.content) ? (body.content as { type?: unknown }[]).filter((each) => each?.type === "input_image").length : 0;
      return { role: String(body.role ?? body.type ?? "?"), chars: content.length, ...(images > 0 ? { pictures: images } : {}), ...(kind ? { kind } : {}), ...(Object.keys(notes).length > 0 ? { notes } : {}) };
    });
    const waiting = this.#s.rows<{ principal: string }>("SELECT principal FROM inbox WHERE run_id = ? AND kind = 'message'", runId).some((event) => {
      const principal = JSON.parse(event.principal) as Principal;
      return principal.kind === "human" && principal.explicit === true;
    });
    const step = this.#s.rows<{ steps: number }>("SELECT steps FROM runs WHERE id = ?", runId)[0]?.steps ?? 0;
    this.#s.setMeta(`shape:${runId}`, JSON.stringify({ step, at: Date.now(), tools: tools.map((each) => each.name), waiting, acting: this.actingFor(runId) !== undefined, entries: items.length, shown } satisfies Shape));
    this.#s.sql.exec("DELETE FROM meta WHERE key LIKE 'shape:%' AND key NOT IN (SELECT 'shape:' || id FROM runs ORDER BY started_at DESC LIMIT 5)");
  }

  #toolsFor(runId: string): ToolDefinition[] {
    // A run that carries a request on answers it, and does nothing else.
    if (this.#b.requests.continuationOf(runId)) return TOOLS.filter((each) => each.name === "send_message");
    const acting = this.actingFor(runId);
    // Work is handed over through one set of tools, whichever worker it goes to. A connector's
    // tool that carries a worker is not offered under its own name: it is that worker's way in.
    const workers = workersIn(acting, this.#b.toolsOf, this.#b.workers());
    const carrying = new Set(workers.flatMap((each) => (each.tool ? [each.tool] : [])));
    // (Nor where its worker is not among them: such a tool is a worker's way in and nothing else.)
    const handing = workTools(workers.map((each) => ({ name: each.name, description: each.description, acts_as: each.acts_as, options: each.options, continues: each.tool !== undefined })), carrying.size > 0 ? REPLACES : undefined);
    const own = [...TOOLS, ...handing];
    const all = acting ? [...own, ...toolsIn(acting, this.#b.toolsOf).filter((each) => each.hands_to === undefined).map((each) => describeTool(each.name, each.description, { ...each.parameters, replaces: REPLACES }))] : own;
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

  async #instructions(runId: string): Promise<string> {
    // A person who deliberately wrote to the agent is waiting for it; anything else merely happened.
    const waiting = this.#s.rows<{ principal: string }>("SELECT principal FROM inbox WHERE run_id = ? AND kind = 'message'", runId).some((event) => {
      const principal = JSON.parse(event.principal) as Principal;
      return principal.kind === "human" && principal.explicit === true;
    });
    const asker = this.actingFor(runId)?.person;
    const session = this.#s.rows<{ id: string; session_key: string }>("SELECT s.id, s.session_key FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?", runId)[0];
    // A request kept for a tool that hands work to a worker is a piece of work, listed as that and nowhere else.
    const handsTo = (each: { connector: string; tool: string }) => this.#b.toolsOf(each.connector).find((tool) => tool.name === each.tool)?.hands_to;
    const requests = asker && session ? this.#b.requests.cancellable(session.id, asker) : [];
    // Work done in the person's name: theirs alone, in this conversation; what is under way, and what ended in the last day (it can be gone on with).
    // (A request kept before there was an index is given its row first. What is under way comes before what has ended.)
    for (const each of requests) if (handsTo(each)) this.#b.requests.indexed(each.id);
    // Of what has ended, only what can be gone on with (done) or what the person may need to hear of (not known whether it was taken).
    // Where several people talk, only what the conversation was in fact told of: the word that the person was sent a way in, that it is under way, or its answer, reached it.
    const chat = this.#s.scope().kind === "chat";
    const candidates = asker && session ? this.#s.rows<{ id: string; worker: string; state: string; condition: string | null; generation: number | null; handed: number }>(`SELECT id, worker, state, condition, generation, handed FROM work WHERE session_key = ? AND person = ? AND (state = 'open' OR (state IN ('done', 'unknown') AND updated_at > ?)) AND id NOT IN (SELECT id FROM tasks) ORDER BY state = 'open' DESC, created_at DESC, id`, session.session_key, asker, Date.now() - 24 * 60 * 60_000) : [];
    // (All of them are candidates, however many: what is under way, and what ended in the last day, for one person in one conversation.)
    // Eight of them, in that order, each of which the conversation was told of and which still
    // stands under the authorisation it was done under (whoever keeps that is asked, each time the
    // model is about to be asked, so that its being taken away is seen within a run too). One
    // that does not count takes no place from one that does.
    const theirs: typeof candidates = [];
    for (const each of candidates) {
      if (theirs.length >= 8) break;
      if ((!chat || this.#b.requests.told(each.id)) && (await this.#b.workStands(each))) theirs.push(each);
    }
    // Where several people talk, a run that was given any of this is cleared when it ends as one that did something in the person's name is: kept to be found then.
    if (chat && theirs.length > 0) this.#s.setMeta(`personal:${runId}`, "1");
    return buildInstructions({
      scope: this.#s.scope(),
      situation: waiting ? "conversation" : "background",
      now: Date.now(),
      instructions: this.#s.rows<Row>("SELECT content FROM memory WHERE path = 'instructions.md'")[0]?.content,
      index: this.#s.rows<Row>("SELECT content FROM memory WHERE path = 'index.md'")[0]?.content,
      // Only where this very call to the model is given the tool to hand work over with: by the same word that decides its tools.
      guidance: this.#toolsFor(runId).some((each) => each.name === "hand_over") ? this.#b.guidance() : undefined,
      work: [
        ...this.#s.rows<{ id: string; worker: string; title: string; status: string }>("SELECT id, worker, title, status FROM tasks WHERE status IN ('dispatching', 'running', 'needs_input') ORDER BY created_at").map((each) => ({ id: each.id, worker: each.worker, title: each.title, state: each.status })),
        ...theirs.map((each) => {
          const record = this.#b.requests.record(each.id);
          const waits = each.state === "open" && record?.status === "waiting" ? (record.interaction !== "" ? ("authorisation" as const) : ("result" as const)) : undefined;
          const handed = waits === "authorisation" && (each.handed === 1 || this.#b.requests.promised(each.id));
          // One that never had to wait is kept only as that it was handed over: not what was asked.
          return { id: each.id, worker: each.worker, title: record ? this.#b.requests.askedFor(record) : "(what was asked is not kept)", state: standingOf(each.state, waits, handed) };
        }),
      ],
      // The requests of the person this run stands for, which only they can call off; none where it stands for nobody.
      requests: requests.filter((each) => !handsTo(each)).map((each) => ({ id: each.id, asked: this.#b.requests.askedFor(each) })),
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
/** Adds something to show before a turn, unless it is there already: each thing once. Says whether it was added. */
function push(chain: Link[], link: Link, at = chain.length): boolean {
  const key = (each: Link) => (each.kind === "said" || each.kind === "inbox" ? `${each.kind}:${each.id}` : each.kind === "fetched" ? `fetched:${each.event}:${each.level}` : undefined);
  if (key(link) !== undefined && chain.some((each) => key(each) === key(link))) return false;
  chain.splice(at, 0, link);
  return true;
}

/** One message further up the chain of replies, as kept with the message that led to it: its name, and, where it had to be fetched, the person's own words and links, or that it is not theirs. A last entry `cut` says the chain goes on but was not followed. */
type Level = ChainLevel;
/**
 * One thing a turn leads back to, to be shown before it: an answer of the agent's by its outbox
 * row; a message of the person's own on record by its row; one that was fetched, by the message
 * it is kept with and how far up it stood; or one that is not shown.
 */
type Link = { kind: "said"; id: number } | { kind: "inbox"; id: number; by: string } | { kind: "fetched"; event: number; level: number; by: string } | { kind: "hidden" } | { kind: "cut" };
/** An earlier message of the person's own that a turn leads back to: its row, and whose it was when that was established. */
type Pointed = { id: number; by: string };
/** How much of such a message is shown. */
const MAX_POINTED_TEXT = 500;
/** Addresses written in a piece of text: for naming the links of a message whose words are cut short. */
function addressesIn(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s<>"'）】]+/g) ?? [])].slice(0, MAX_LINKS_SHOWN).map((each) => each.slice(0, 300));
}

/** The line that names links beyond the words shown, or nothing. */
function linked(links: string[]): string {
  const some = [...new Set(links)].slice(0, MAX_LINKS_SHOWN);
  let line = "";
  for (const each of some) if (line.length + each.length + 1 <= MAX_LINKS_TEXT) line += ` ${each}`;
  return line ? `\n(links in it:${line})` : "";
}

/** How many links of one message are named beside its words. */
const MAX_LINKS_SHOWN = 10;
/** How much of a fetched message is shown (the connector already keeps it short). */
const MAX_FETCHED_TEXT = 1_000;
/** Room for what is written around something shown with a turn: its label, and where it was written from. */
const SHOWN_AROUND = 600;
/** How much the line naming a message's links may take. */
const MAX_LINKS_TEXT = 1_000;

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
/** The shape of what the model was shown at one step of a run: see Runner.shapeOf. */
export interface Shape {
  step: number;
  at: number;
  tools: string[];
  waiting: boolean;
  acting: boolean;
  /** How many entries it was shown in all; `shown` is the last of them. */
  entries: number;
  shown: { role: string; chars: number; pictures?: number; kind?: string; notes?: Record<string, number> }[];
}

/** The system's own kinds of entry, by how they begin. */
const SHAPE_KINDS: [string, RegExp][] = [
  ["turn", /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] /],
  ["earlier_own_kept", /^\[An earlier message of theirs that this leads back to, written at /],
  ["earlier_own_fetched", /^\[An earlier message of theirs that this leads back to, which you were not sent:\]/],
  ["earlier_own_gone", /^\[An earlier message of theirs that this leads back to is no longer kept\.\]/],
  ["yours_up_the_chain", /^\[A message of yours further up the chain of replies/],
  ["yours_replied_to", /^\[The message of yours they are replying to/],
  ["chain_cut", /^\[The chain of replies goes further back than was followed\.\]/],
  ["not_shown", /^\[A message here that this leads back to is not shown to you/],
  ["cleared_turn", /^\[In this turn you used a tool that read text from outside\./],
];

/** The system's own notes under a person's turn about what it was written in reply to, by how they begin. */
const SHAPE_NOTES: [string, RegExp][] = [
  ["reply_to_own_quoted", /^  \(written as a reply to their own earlier message: /],
  ["reply_to_yours", /^  \(written as a reply to the message you sent at /],
  ["reply_to_not_shown", /^  \(written as a reply to a message here that is not shown to you/],
  ["reply_to_own_fetched", /^  \(written as a reply to an earlier message of their own that you were not sent/],
  ["in_a_chain", /^  \(that stands in a chain of replies/],
];

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
