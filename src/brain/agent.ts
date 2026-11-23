/**
 * The Brain: one Durable Object per scope (a user, a group chat, a repository).
 *
 * It owns the five primitives of an always-on agent for that scope:
 *   inbox   - every trigger is written here first, deduplicated, and only then acted on
 *   timers  - a due timer becomes an inbox event; it never runs the agent directly
 *   memory  - files that survive between runs
 *   tasks   - work handed to worker agents, whose reports come back as inbox events
 *   outbox  - messages to deliver, retried independently of the run that wrote them
 *
 * A run is a short loop: claim a batch of events, call the model, execute its tool calls, repeat
 * until it stops. The loop runs inside this object, and after every step the transcript is on disk,
 * so a run interrupted by a deploy or a crash continues from where it was instead of starting over.
 *
 * Only alarm() executes runs, and alarms never overlap, so there is at most one run at a time.
 * Every write after an await re-checks that the run is still the active one.
 */
import { DurableObject } from "cloudflare:workers";

import { amend, canRevisit, deliver, received, isWaiting, standingOf, toolsOf, trusts } from "../connectors";
import type { Env } from "../env";
import { type InboundEvent, type Principal, isPrivateSession, privateSessionKey, type Target, type WorkerEventKind } from "../events";
import { type Item, ModelError, type ToolDefinition, messageText, respond } from "../model/openai";
import { registry } from "../registry";
import { MAX_LOADED_INDEX, MAX_LOADED_INSTRUCTIONS, buildInstructions } from "./prompt";
import { migrate } from "./schema";
import { BrainStore, type InboxRow, type Row, type RunRow, type Wakes } from "./store";
import { Outbox } from "./outbox";
import { Revisions } from "./revisions";
import { Tasks, quotes } from "./tasks";
import { Timers } from "./timers";
import type { Passage } from "./follow-up";
import { type Continuation, HANDLING_LIMIT_MS, Requests, type Source, WAITING_NOTE, fingerprint } from "./requests";
import { MAX_MESSAGE_TEXT, TOOLS, type ToolCall, type ToolHost, describeTool, executeTool, withoutQuotes } from "./tools";

/** Events arriving within this window are answered in one run. */
const BATCH_WINDOW_MS = 2_000;
const MAX_STEPS_PER_RUN = 16;
/** How often a run may be (re)entered before it is abandoned: crashes, deploys, model failures. */
const MAX_RUN_ENTRIES = 5;
const RUN_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000];
/** The model sees at most this many transcript items; older ones are dropped from the front. */
const MAX_TRANSCRIPT_ITEMS = 80;
/** One run takes at most this much of a conversation's backlog; the rest waits for the next run. */
const MAX_EVENTS_PER_RUN = 40;
const MAX_EVENT_BYTES_PER_RUN = 120_000;
const MAX_ACTIVE_TIMERS = 50;
const MAX_MEMORY_FILES = 200;
const DAILY_TOKEN_BUDGET = 2_000_000;
/** Tokens set aside against the tenant's budget before a model call, corrected to the real figure after. */
const MODEL_CALL_RESERVE = 20_000;
/** How long finished records are kept before housekeeping removes them. */
const RETAIN_RECORDS_MS = 30 * 86_400_000;
const RETAIN_AUDIT_MS = 365 * 86_400_000;
/** A conversation keeps at least this many recent transcript items, however old. */
const RETAIN_ITEMS_PER_SESSION = 200;
const MEMORY_PATH = /^[a-z0-9][a-z0-9_\-/]{0,150}\.md$/;
const READ_OUTSIDE = "this run has read text from outside through a tool. From then on it can only reply to the person with send_message and read again; no other tool can be used in it. If the person wants something else done, they can ask for it in a new message";
const OUTSIDE_REMOVED = "[In this turn you answered using a tool that read text from outside. What it returned, and what you said and did with it, are not kept here. If the content is needed again, read it again from what the person themselves pointed to.]";
const ERROR_WITHHELD = "failed after reading outside text; the details are not kept";
const REPLACES = { type: ["string", "null"], description: "If the person wants this instead of a request of theirs that is still waiting (they changed their mind about what they want), that request's id; otherwise null." };


export type Said = { text: string; data: Record<string, unknown> };

/** How far back a person's earlier messages still count as part of what they are asking now. */
const RECENT_REQUEST_MS = 10 * 60_000;
const MAX_RECENT_REQUESTS = 5;

export class BrainAgent extends DurableObject<Env> {
  /** The database, shared with every part of this Brain. */
  readonly #store: BrainStore;
  /** Calls in this invocation whose result came from a connector's tool, until they are recorded. */
  readonly #outside = new Set<string>();
  /** Requests that wait, guards and follow-ups: the same database and transactions, in a file of their own. */
  readonly #requests: Requests;
  readonly #timers: Timers;
  /** Messages to deliver. */
  readonly #outbox: Outbox;
  /** What is known of messages that can change after they were said. */
  readonly #revisions: Revisions;
  /** Work handed to workers, and the approval questions they raise. */
  readonly #tasks: Tasks;
  /** The parts that can ask to be woken. */
  readonly #parts: Wakes[];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new BrainStore(ctx);
    this.#timers = new Timers(this.#store);
    const brain = this;
    this.#revisions = new Revisions(this.#store, {
      isDecider: (principal, source) => this.#isDecider(principal, source),
      canRevisit,
      standingOf: (source, subject) => standingOf(this.env, source, this.#store.scope(), subject),
    });
    this.#tasks = new Tasks(this.#store, this.#revisions, {
      worker: (taskId) => this.env.TASKS.getByName(taskId),
      registry: () => registry(this.env),
      deciders: (runId) => this.#deciders(runId),
      isDecider: (principal, source) => this.#isDecider(principal, source),
      canRevisit,
      standingOf: (source, subject) => standingOf(this.env, source, this.#store.scope(), subject),
      enqueue: (...args) => this.#outbox.enqueue(...args),
      amend: (target, receipt, ask, outcome) => amend(this.env, target, receipt, ask, outcome),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      wakeBy: (at) => this.#wakeBy(at),
      // The same count the run loop adds its own calls to, written at once.
      spend: (tokens) => this.#store.setMeta(`tokens:${today()}`, String(this.#tokensToday() + tokens)),
    });
    this.#outbox = new Outbox(this.#store, {
      deliver: (target, message) => deliver(this.env, this.#store.scope(), target, message),
      sawOutside: (runId) => this.#sawOutside(runId),
      showClosed: (ask) => this.#tasks.showClosed(ask),
      // Built after this part: read when it is used.
      get requests() {
        return brain.#requests;
      },
    });
    this.#requests = new Requests(this.#store, {
      // Read each time, as everywhere else in this class: not the value at construction.
      get env() {
        return brain.env;
      },
      outside: this.#outside,
      wakeBy: (at) => this.#wakeBy(at),
      append: (sessionId, runId, item, outside) => this.#append(sessionId, runId, item, outside),
      actingFor: (runId) => this.#actingFor(runId),
      actingOn: (events, kept) => this.#actingOn(events, kept),
      enqueueMessage: (...args) => this.#outbox.enqueue(...args),
      notice: (which, sessionId) => this.#outbox.notice(which, sessionId),
    });
    this.#parts = [this.#timers, this.#requests, this.#outbox, this.#tasks];
    migrate(ctx.storage);
    // If an invocation died between committing work and scheduling the wake-up for it, nothing else
    // would ever schedule it. Any activation of this object repairs that.
    void ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await this.#rearm();
    });
  }

  // ------------------------------------------------------------------ inbox

  /**
   * Accepts an event. The insert is the acknowledgement: once this returns, the event will be
   * handled even if everything else fails. A repeat of the same (source, source_id) is ignored.
   */
  async ingest(event: InboundEvent): Promise<{ accepted: true; duplicate: boolean }> {
    if (!event.source || !event.source_id || !event.kind || !event.session_key) throw new Error("event is missing a required field");
    // Larger than the longest comment any connector passes on, so a reply is stored whole: what it
    // says about an open question is read from the stored text, and a cut-off refusal would be lost.
    if ((event.text?.length ?? 0) > 300_000) throw new Error("event text is too long");
    // In a chat with threads, a reply that names an open question's code belongs with that
    // question, wherever in the chat it was typed. The connector says when this applies.
    // A message written in reply to one of the agent's questions answers that question.
    if (event.kind === "message" && typeof event.data?.replies_to === "string" && event.data.question === undefined) {
      const asked = this.#store.rows<{ idem: string }>("SELECT idem FROM outbox WHERE ask IS NOT NULL AND json_extract(receipt, '$.subject') = ?", event.data.replies_to)[0];
      if (asked) event = { ...event, data: { ...event.data, question: asked.idem } };
    }
    if (event.kind === "message" && event.data?.route_by_code === true && event.text) {
      const pressed = typeof event.data.question === "string" ? event.data.question : undefined;
      const sessions = new Set(
        this.#store.rows<{ session_key: string; code: string | null; ask: string | null }>(
          "SELECT session_key, json_extract(pending, '$.code') AS code, json_extract(pending, '$.ask') AS ask FROM tasks WHERE status = 'needs_input' AND pending IS NOT NULL",
        )
          // A button names its question exactly; typed words name it by its code.
          .filter(({ code, ask }) => (pressed ? ask === pressed : code && quotes(event.text ?? "", code)))
          .map(({ session_key }) => session_key),
      );
      // Its answer goes where the question was asked, not to wherever the reply came from. Where it
      // did come from is kept: what the same person says there next still bears on it.
      // Not into or out of someone's private conversation: what is said there stays there, and what
      // is said elsewhere is not written into it.
      const crosses = isPrivateSession(event.session_key) || [...sessions].some(isPrivateSession);
      if (sessions.size === 1 && !sessions.has(event.session_key) && !crosses) {
        event = { ...event, session_key: [...sessions][0], reply_to: undefined, data: { ...event.data, routed_from: event.session_key } };
      }
    }
    const subject = event.data?.subject;
    if (typeof subject === "string") this.#revisions.revise(subject, Number(event.data?.revision ?? 0), false, String(event.data?.holder ?? ""));
    const inserted = this.#store.insertEvent(event);
    // A person who addressed the agent is shown at once, on their own message, that it arrived.
    // Only that: nothing waits for it, nothing depends on it, and it is not a message.
    const principal = event.principal;
    if (inserted && event.kind === "message" && principal.kind === "human" && principal.explicit) {
      const at = Date.now();
      // Wanted only while it still says something: soon, and before the message has been dealt with.
      const wanted = () => Date.now() - at < 15_000 && this.#store.rows("SELECT 1 FROM inbox WHERE source = ? AND source_id = ? AND status IN ('pending', 'claimed')", event.source, event.source_id).length > 0;
      this.ctx.waitUntil(received(this.env, event.source, this.#store.scope(), { source_id: event.source_id, data: event.data, reply_to: event.reply_to, wanted }).then((shown) => void (shown && this.#store.log("received_shown", { ms: Date.now() - at }))));
    }
    // Someone who writes while a request of theirs waits may be saying that the wait is over
    // ("done"). That is not taken from their words: the condition's owner is asked again.
    if (inserted && event.kind === "message") {
      for (const waiting of this.#store.rows<Continuation>("SELECT c.* FROM continuations c JOIN sessions s ON s.id = c.session_id WHERE c.status = 'waiting' AND s.session_key = ?", event.session_key)) this.#requests.hint(waiting, `said:${event.source}:${event.source_id}`);
    }
    // Also on a duplicate: the first delivery may have been stored without its wake-up being scheduled.
    await this.#wakeBy(Date.now() + BATCH_WINDOW_MS);
    return { accepted: true, duplicate: !inserted };
  }


  // ------------------------------------------------------------------ the wake cycle

  async alarm(): Promise<void> {
    try {
      this.#timers.fire(Date.now());
      this.#requests.deadlines(Date.now());
      this.#store.sql.exec("DELETE FROM answers WHERE expires_at <= ?", Date.now());
      this.#housekeeping(Date.now());
      await this.#outbox.flush();
      await this.#tasks.settle();
      // A few runs per wake-up at most, so one busy scope cannot hold an invocation forever.
      for (let i = 0; i < 3; i++) {
        const runId = await this.#next();
        if (!runId) break;
        await this.#execute(runId);
        await this.#outbox.flush();
        if (this.#store.meta("active_run")) break;
      }
    } finally {
      await this.#rearm();
    }
  }

  /** Sets the alarm to `at` unless an earlier one is already set. */
  async #wakeBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  /** One alarm serves everything: pick the earliest thing this object is waiting for. */
  async #rearm(): Promise<void> {
    const now = Date.now();
    const candidates: number[] = [];
    const active = this.#activeRun();
    if (active) candidates.push(active.retry_at ?? now + 1_000);
    else if (this.#store.rows("SELECT 1 FROM inbox WHERE status = 'pending' LIMIT 1").length > 0) candidates.push(now + 200);
    // Each part says for itself when it next has something to do.
    for (const part of this.#parts) {
      const at = part.nextWakeAt(now);
      if (at != null) candidates.push(at);
    }
    // Housekeeping is work too: a scope that has gone quiet still has old records to remove.
    const housekeeping = Number(this.#store.meta("housekeeping_at") ?? 0);
    if (housekeeping > 0 && this.#store.rows("SELECT 1 FROM inbox LIMIT 1").length > 0) candidates.push(housekeeping);
    if (candidates.length === 0) return;
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 50));
  }

  // ------------------------------------------------------------------ records



  /** Once a day, removes what is finished and old. Nothing pending, running or recent is touched. */
  #housekeeping(now: number): void {
    if (Number(this.#store.meta("housekeeping_at") ?? 0) > now) return;
    this.#store.setMeta("housekeeping_at", String(now + 86_400_000));
    const old = now - RETAIN_RECORDS_MS;
    this.#store.transaction(() => {
      // Old events lose their content but keep their identity for a year: the (source, source_id)
      // pair is what makes a replayed webhook a duplicate, and a signed webhook never expires.
      this.#store.sql.exec("UPDATE inbox SET text = NULL, data = NULL, reply_to = NULL WHERE status IN ('done', 'dead') AND received_at < ? AND text IS NOT NULL", old);
      this.#store.sql.exec("DELETE FROM inbox WHERE status IN ('done', 'dead') AND received_at < ?", now - RETAIN_AUDIT_MS);
      this.#store.sql.exec("DELETE FROM outbox WHERE status IN ('sent', 'dead', 'withdrawn', 'reconciling', 'void', 'unverified') AND created_at < ?", old);
      this.#store.sql.exec("DELETE FROM continuations WHERE ended_at IS NOT NULL AND ended_at < ?", old);
      this.#store.sql.exec("DELETE FROM runs WHERE status != 'running' AND ended_at < ?", old);
      this.#store.sql.exec("DELETE FROM timers WHERE status != 'active' AND created_at < ?", old);
      this.#store.sql.exec("DELETE FROM task_events WHERE at < ?", old);
      this.#store.sql.exec("DELETE FROM tasks WHERE status IN ('succeeded', 'failed', 'lost', 'cancelled') AND updated_at < ?", old);
      this.#store.sql.exec("DELETE FROM audit WHERE at < ?", now - RETAIN_AUDIT_MS);
      this.#store.sql.exec("DELETE FROM meta WHERE key LIKE 'tokens:%' AND key < ?", `tokens:${new Date(old).toISOString().slice(0, 10)}`);
      // Old transcript, beyond what any future run would be shown. The cut lands on a user turn, as
      // the window does, so a kept transcript never opens mid-exchange.
      for (const session of this.#store.rows<{ id: string }>("SELECT id FROM sessions WHERE updated_at < ?", old)) {
        const keepFrom = this.#store.rows<{ seq: number }>(
          "SELECT MIN(seq) AS seq FROM items WHERE session_id = ? AND is_user = 1 AND seq > (SELECT COALESCE(MAX(seq), 0) FROM items WHERE session_id = ?) - ?",
          session.id,
          session.id,
          RETAIN_ITEMS_PER_SESSION,
        )[0]?.seq;
        if (keepFrom != null) this.#store.sql.exec("DELETE FROM items WHERE session_id = ? AND seq < ?", session.id, keepFrom);
      }
    });
  }


  // ------------------------------------------------------------------ runs

  #activeRun(): RunRow | undefined {
    const id = this.#store.meta("active_run");
    return id ? this.#store.rows<RunRow>("SELECT * FROM runs WHERE id = ?", id)[0] : undefined;
  }

  /**
   * Returns the run to work on: the active one if there is one (resuming it), otherwise a new run
   * over the oldest pending conversation. Claiming is one synchronous transaction, so two
   * invocations can never both claim the same events.
   */
  #claim(): string | undefined {
    return this.#store.transaction(() => {
      const active = this.#activeRun();
      if (active) return active.retry_at && active.retry_at > Date.now() ? undefined : active.id;

      const first = this.#store.rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0];
      if (!first) return undefined;
      const now = Date.now();
      const runId = crypto.randomUUID();

      let session = this.#store.rows<Row>("SELECT * FROM sessions WHERE session_key = ?", first.session_key)[0];
      if (!session) {
        session = { id: crypto.randomUUID() };
        this.#store.sql.exec("INSERT INTO sessions (id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)", session.id, first.session_key, now, now);
      }
      // Bounded, so a burst in one conversation becomes several runs instead of one oversized one.
      const events: InboxRow[] = [];
      let bytes = 0;
      for (const event of this.#store.rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' AND session_key = ? AND kind != 'request.ready' ORDER BY id LIMIT ?", first.session_key, MAX_EVENTS_PER_RUN)) {
        bytes += (event.text?.length ?? 0) + (event.data?.length ?? 0) + 300;
        if (events.length > 0 && bytes > MAX_EVENT_BYTES_PER_RUN) break;
        events.push(event);
        this.#store.sql.exec("UPDATE inbox SET status = 'claimed', run_id = ? WHERE id = ?", runId, event.id);
      }

      // Replies go where the most recent addressed event came from.
      const target = [...events].reverse().find((e) => e.reply_to)?.reply_to;
      if (target) this.#store.sql.exec("UPDATE sessions SET target = ? WHERE id = ?", target, session.id);

      this.#store.sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES (?, ?, 'running', ?)", runId, session.id, now);
      this.#append(session.id, runId, { role: "user", content: events.map((each) => renderEvent(each) + this.#repliedTo(each)).join("\n") });
      this.#store.setMeta("active_run", runId);
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
    return this.#store.rows<InboxRow>("SELECT * FROM inbox WHERE source = ? AND source_id = ? AND kind = 'message' AND session_key = ? AND id < ?", event.source, subject.slice(prefix.length), event.session_key, event.id)[0];
  }

  #repliedTo(event: InboxRow): string {
    const subject = event.kind === "message" && event.data ? (JSON.parse(event.data) as { replies_to?: unknown }).replies_to : undefined;
    if (typeof subject !== "string") return "";
    const parent = this.#parentOf(event, subject);
    const who = (row: InboxRow) => JSON.parse(row.principal) as Principal;
    if (parent && parent.text !== null && who(parent).kind === "human" && who(event).kind === "human" && who(parent).id === who(event).id) return `\n  (written as a reply to their own earlier message: ${JSON.stringify(parent.text.slice(0, 500))})`;
    // One of the agent's own, sent in this conversation.
    const yours = this.#store.rows<{ sent_at: number | null }>(
      "SELECT o.sent_at FROM outbox o WHERE json_extract(o.receipt, '$.subject') = ? AND (o.run_id IN (SELECT r.id FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.session_key = ?) OR o.continuation IN (SELECT c.id FROM continuations c JOIN sessions s ON s.id = c.session_id WHERE s.session_key = ?)) LIMIT 1",
      subject,
      event.session_key,
      event.session_key,
    )[0];
    return yours?.sent_at ? `\n  (written as a reply to the message you sent at ${new Date(yours.sent_at).toISOString()})` : "";
  }

  async #execute(runId: string): Promise<void> {
    const entered = this.#store.rows<RunRow>("UPDATE runs SET entries = entries + 1, retry_at = NULL WHERE id = ? RETURNING *", runId)[0];
    if (!entered) return;
    if (entered.entries > MAX_RUN_ENTRIES) return this.#abandon(runId, "the run kept failing and was abandoned");

    for (;;) {
      const run = this.#stillActive(runId);
      if (!run) return;
      const items = this.#transcript(run.session_id);

      // Tool calls without a recorded output: either the model just asked for them, or an earlier
      // attempt died mid-call. Either way, execute and record. Tools are idempotent per call id.
      const dangling = danglingCalls(items);
      if (dangling.length > 0) {
        for (const call of dangling) {
          // Decided at the moment of use, a repeat after an interruption included.
          const output = this.#mayUse(runId, call.name) ? await executeTool(this.#toolHost(run), call) : JSON.stringify({ error: READ_OUTSIDE });
          const outside = this.#outside.delete(call.call_id);
          if (!this.#stillActive(runId)) return;
          this.#append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output }, outside);
        }
        continue;
      }

      const last = items.at(-1);
      const awaitingModel = last && (last.role === "user" || last.type === "function_call_output");
      if (!awaitingModel || run.steps >= MAX_STEPS_PER_RUN) break;

      // Two limits: this scope's own, and the tenant's across all of its scopes and sandboxes.
      // The tenant's share is reserved before the call and trued up after it, so several scopes
      // admitted at the same moment cannot all slip under the limit together.
      const tenant = await registry(this.env).recordUsage(this.#store.scope().tenant, MODEL_CALL_RESERVE);
      // The day the registry charged, which is not necessarily today as seen from here.
      const reservedOn = tenant.day;
      /** Gives the reservation back: the call it was made for is not going to happen. */
      const release = () => registry(this.env).adjustUsage(this.#store.scope().tenant, -MODEL_CALL_RESERVE, reservedOn).catch(() => undefined);
      if (!this.#stillActive(runId)) return;
      if (!tenant.allowed || this.#tokensToday() >= DAILY_TOKEN_BUDGET) {
        await release();
        if (!this.#stillActive(runId)) return;
        // A request that was being carried on cannot wait until tomorrow: its time would be up.
        // It ends here, and the person is told, in place of its answer.
        const carrying = this.#requests.continuationOf(runId);
        if (carrying) {
          if (carrying.status === "resuming") this.#requests.draft(carrying, run, this.#outbox.notice("limit", run.session_id));
          this.#store.log("budget_exhausted", { run: runId, tokens_today: this.#tokensToday() });
          break;
        }
        // The run stays claimed and resumes after midnight UTC; nothing is dropped. This pause is
        // not a failure, so it does not count towards the run's entry limit.
        this.#outbox.notify(`budget:${runId}:${today()}`, run.session_id, runId, this.#outbox.notice("tomorrow", run.session_id));
        this.#store.log("budget_exhausted", { run: runId, tokens_today: this.#tokensToday() });
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 30, 0);
        this.#store.sql.exec("UPDATE runs SET retry_at = ?, entries = entries - 1 WHERE id = ?", midnight.getTime(), runId);
        return;
      }

      // A request being carried on has read what it waited for. Each time that text is about to
      // be put before the model (also after an interruption, or a pause of any length) the
      // condition's owner is asked whether it still holds, and nothing else is waited for between
      // that answer and the call. If it does not hold, the model is not given the text.
      const carried = this.#requests.continuationOf(runId);
      if (carried && this.#sawOutside(runId)) {
        let why: string | undefined;
        try {
          why = carried.status === "resuming" ? await this.#requests.mayNotDisclose(carried) : "the request has ended";
        } catch (err) {
          await release();
          return this.#retryLater(runId, err);
        }
        if (!this.#stillActive(runId)) return;
        if (why || !this.#actingFor(runId)) {
          await release();
          if (!this.#stillActive(runId)) return;
          this.#requests.endRequest(carried.id, "void", why ?? "it is no longer the person's to ask here");
          // They were waiting for this: told, in fixed words, that it stopped.
          this.#outbox.notify(`withheld:${runId}`, run.session_id, null, this.#outbox.notice("withheld", run.session_id));
          break;
        }
      }

      // The same for any run that has read something under a condition (an authorisation, the
      // time a kept answer lasts): what it read is not put before the model once that is over.
      const guards = this.#requests.guards(runId);
      if (guards.length > 0 && this.#sawOutside(runId) && this.#stillActive(runId)?.status === "running" && (!carried || this.#requests.continuationOf(runId)?.status === "resuming")) {
        let over: string | undefined;
        try {
          over = await this.#requests.over(guards);
        } catch (err) {
          await release();
          return this.#retryLater(runId, err);
        }
        if (!this.#stillActive(runId)) return;
        if (over) {
          await release();
          if (!this.#stillActive(runId)) return;
          // Nothing more of it goes out; the person is told, in fixed words, that it stopped.
          this.#store.sql.exec("UPDATE outbox SET status = 'void', text = '', review = NULL WHERE run_id = ? AND status = 'pending' AND started = 0", runId);
          if (carried) this.#requests.endRequest(carried.id, "void", over);
          this.#outbox.notify(`withheld:${runId}`, run.session_id, null, this.#outbox.notice("withheld", run.session_id));
          break;
        }
      }

      // Last, with nothing waited for after it: a request being carried on is still that, and
      // still in its time. The checks above each waited for an owner's answer.
      if (carried) {
        const still = this.#requests.continuationOf(runId);
        if (!still || still.status !== "resuming" || Date.now() - (still.claimed_at ?? 0) > HANDLING_LIMIT_MS) {
          await release();
          if (!this.#stillActive(runId)) return;
          if (still?.status === "resuming") {
            this.#requests.endRequest(still.id, "void", "it was not finished in time");
            this.#outbox.notify(`withheld:${runId}`, run.session_id, null, this.#outbox.notice("notSent", run.session_id));
          }
          break;
        }
      }

      let response;
      try {
        response = await respond({
          baseUrl: this.env.OPENAI_BASE_URL,
          apiKey: this.env.OPENAI_API_KEY,
          model: this.env.BRAIN_MODEL,
          instructions: this.#instructions(runId),
          input: items,
          tools: this.#toolsFor(runId),
        });
      } catch (err) {
        await release();
        return this.#retryLater(runId, err);
      }
      if (!this.#stillActive(runId)) return;
      this.#store.transaction(() => {
        for (const item of response.output) this.#append(run.session_id, runId, item);
        this.#store.sql.exec(
          "UPDATE runs SET steps = steps + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?",
          response.usage.input_tokens,
          response.usage.output_tokens,
          runId,
        );
        this.#store.setMeta(`tokens:${today()}`, String(this.#tokensToday() + response.usage.total_tokens));
      });
      // After the commit: if this is lost the tenant is under-counted by one call, never blocked.
      await registry(this.env).adjustUsage(this.#store.scope().tenant, response.usage.total_tokens - MODEL_CALL_RESERVE, reservedOn).catch(() => undefined);
    }
    this.#finish(runId, "done");
  }

  /** The run, if it is still the one this object is working on. Checked after every await. */
  #stillActive(runId: string): RunRow | undefined {
    const run = this.#activeRun();
    return run && run.id === runId && run.status === "running" ? run : undefined;
  }

  #retryLater(runId: string, err: unknown): void {
    const run = this.#stillActive(runId);
    if (!run) return;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ModelError && !err.retryable && err.status !== 0) return this.#abandon(runId, message);
    const delay = RUN_RETRY_DELAYS_MS[Math.min(run.entries - 1, RUN_RETRY_DELAYS_MS.length - 1)];
    this.#store.sql.exec("UPDATE runs SET retry_at = ?, error = ? WHERE id = ?", Date.now() + delay, this.#sawOutside(runId) ? ERROR_WITHHELD : message.slice(0, 1_000), runId);
  }

  #abandon(runId: string, reason: string): void {
    const run = this.#store.rows<RunRow>("SELECT * FROM runs WHERE id = ?", runId)[0];
    if (!run) return;
    // Looked at before the run's record is cleared.
    const outside = this.#sawOutside(runId);
    this.#store.transaction(() => {
      // Close any open tool call so the transcript stays well-formed for the next run.
      for (const call of danglingCalls(this.#transcript(run.session_id))) {
        this.#append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "the run was abandoned before this finished" }) });
      }
      // A task that never got past "dispatching" in this run will not be picked up by anything else.
      this.#store.sql.exec("UPDATE tasks SET status = 'failed', updated_at = ? WHERE status = 'dispatching' AND session_key = (SELECT session_key FROM sessions WHERE id = ?)", Date.now(), run.session_id);
      // For a request that was being carried on, this takes the place of its answer: one or the other.
      const carried = this.#requests.continuationOf(runId);
      if (carried?.status === "resuming") this.#requests.draft(carried, run, this.#outbox.notice("failed", run.session_id));
      // One that went back to waiting, or ended, has nothing to say here: its answer, if it gets
      // one, is the request's.
      else if (!carried) this.#outbox.notify(`abandoned:${runId}`, run.session_id, runId, this.#outbox.notice("failed", run.session_id));
      this.#finish(runId, "failed", reason);
    });
    this.#store.log("run_abandoned", { run: runId, reason: outside ? ERROR_WITHHELD : reason.slice(0, 300) });
  }

  #finish(runId: string, status: "done" | "failed", error?: string): void {
    this.#store.transaction(() => {
      const run = this.#store.rows<RunRow>("SELECT * FROM runs WHERE id = ?", runId)[0];
      if (!run || run.status !== "running") return;
      const now = Date.now();
      this.#store.sql.exec("UPDATE inbox SET status = ? WHERE run_id = ? AND status = 'claimed'", status === "done" ? "done" : "dead", runId);
      // An error can quote what the model was sent. From a run that read outside text, only the fact is kept.
      const said = error === undefined ? null : this.#sawOutside(runId) ? ERROR_WITHHELD : error.slice(0, 1_000);
      this.#store.sql.exec("UPDATE runs SET status = ?, ended_at = ?, retry_at = NULL, error = ? WHERE id = ?", status, now, said, runId);
      this.#store.sql.exec("UPDATE sessions SET updated_at = ? WHERE id = ?", now, run.session_id);
      // The run that carried a request on ends together with the request's fate, in this one
      // step: its one answer becomes a message to deliver, and the request one that is being
      // answered. Until here the answer was a draft that nothing would send. A request that is
      // no longer being carried on (told to wait again, ended) leaves no answer behind.
      // A run that read exactly one thing for the person: its messages carry where they came
      // from, so that one delivered can be reopened for a follow-up. One that drew on several
      // things carries nothing: reading one of them again would not vouch for the rest.
      const sources = JSON.parse(this.#store.meta(`sources:${runId}`) ?? "[]") as Source[];
      const quotes = JSON.parse(this.#store.meta(`quotes:${runId}`) ?? "[]") as Passage[];
      this.#store.sql.exec("DELETE FROM meta WHERE key IN (?, ?)", `sources:${runId}`, `quotes:${runId}`);
      // And only when the run said one thing: with several messages there is no telling which is the answer.
      const written = this.#store.rows<{ id: number; status: string }>("SELECT id, status FROM outbox WHERE run_id = ?", runId);
      // (With follow-ups off these notes hold only what the run read under, and nothing is kept.)
      // Each thing once, as it was last read in this run. An answer that drew on several things
      // is not kept (the contract, 5.2): only one source, read again, vouches for the whole of it.
      const each = [...new Map(sources.map((source) => [source.identity, source])).values()];
      // Every read must have been noted in full: one made while follow-ups were off (the switch
      // was turned on during a pause) left only what it was read under, and keeps nothing.
      const whole = sources.every((source) => typeof source.identity === "string" && typeof source.args === "string" && Array.isArray(source.events?.said));
      // "One thing" counts everything the run said, also what has already gone out.
      if (this.#requests.followUps() && status === "done" && whole && written.length === 1 && ["pending", "draft"].includes(written[0].status) && each.length === 1) {
        this.#store.sql.exec("UPDATE outbox SET source = ? WHERE id = ?", JSON.stringify({ sources: each, quotes }), written[0].id);
      }
      const carried = this.#requests.continuationOf(runId);
      if (carried?.status === "resuming") {
        // A run that stopped without answering has not answered: the person is told so.
        if (this.#store.rows("SELECT 1 FROM outbox WHERE idem = ? AND status = 'draft'", `answer:${carried.id}`).length === 0) this.#requests.draft(carried, run, this.#outbox.notice("notAnswered", run.session_id));
        this.#store.sql.exec("UPDATE outbox SET status = 'pending', next_at = ? WHERE idem = ? AND status = 'draft'", now, `answer:${carried.id}`);
        this.#store.sql.exec("UPDATE continuations SET status = 'answering' WHERE id = ?", carried.id);
      } else if (carried) this.#store.sql.exec("DELETE FROM outbox WHERE idem = ? AND status = 'draft'", `answer:${carried.id}`);
      this.#forgetOutside(run);
      if (this.#store.meta("active_run") === runId) this.#store.sql.exec("DELETE FROM meta WHERE key = 'active_run'");
    });
  }

  #append(sessionId: string, runId: string, item: Item, outside = false): void {
    this.#store.sql.exec(
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
  #actingFor(runId: string): { connector: string; person: string; origin: Record<string, string>; said: Said[]; recent: Said[]; recentIds: number[] } | undefined {
    return this.#actingOn(this.#requests.basis(runId), this.#requests.resumed(runId) ? (JSON.parse(this.#requests.resumed(runId)!.events) as { recent: number[] }).recent : undefined);
  }

  /**
   * The same judgement over given messages: `events` as what was asked, and, if `kept` is given,
   * exactly those earlier messages as what came shortly before (instead of looking for them).
   */
  #actingOn(events: InboxRow[], kept?: number[]): { connector: string; person: string; origin: Record<string, string>; said: Said[]; recent: Said[]; recentIds: number[] } | undefined {
    const scope = this.#store.scope();
    if (scope.kind !== "user") return undefined;
    if (events.length === 0) return undefined;
    const source = events[0].source;
    const origin = originOf(events[0]);
    if (!origin || toolsOf(source).length === 0) return undefined;
    const conversation = privateSessionKey(source, origin);
    // A request, in the person's own words, made here: through that connector, in that private
    // conversation, by the person whose scope this is, with that same verified origin.
    const own = (event: InboxRow): boolean => {
      const principal = JSON.parse(event.principal) as Principal;
      if (event.kind !== "message" || event.source !== source || event.session_key !== conversation) return false;
      if (!this.#isDecider(principal, event.source) || principal.id !== scope.id) return false;
      const data = event.data ? (JSON.parse(event.data) as Record<string, unknown>) : {};
      if (data.direct !== true || data.card !== undefined || data.question !== undefined || data.reply_only !== undefined || data.routed_from !== undefined) return false;
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
      recent = ids.length === 0 ? [] : this.#store.rows<InboxRow>(`SELECT * FROM inbox WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids);
      if (recent.length !== ids.length || !recent.every((each) => each.text !== null && own(each))) return undefined;
    } else {
      recent = this.#store.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND source = ? AND id < ? AND received_at >= ? ORDER BY id DESC LIMIT ?", conversation, source, first.id, first.received_at - RECENT_REQUEST_MS, MAX_RECENT_REQUESTS * 4)
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
    return { connector: source, person: scope.id, origin, said: events.map(said), recent: recent.map(said), recentIds: recent.map((each) => each.id) };
  }

  /**
   * Ends what a run that read outside text leaves behind. Text a connector's tool brought in was
   * for that run, and so is everything the run went on to say or do with it: the model's own
   * words about a document carry the document. So the run's whole record, apart from what the
   * person wrote, is replaced by one fixed note. A later run sees that something was read; it is
   * not handed the content, in the original or retold, nor anything else the model wrote.
   * Messages the run wrote are emptied once they have been delivered or given up.
   */
  #forgetOutside(run: RunRow): void {
    if (this.#store.rows("SELECT 1 FROM items WHERE run_id = ? AND outside = 1 LIMIT 1", run.id).length === 0) return;
    this.#store.sql.exec("DELETE FROM items WHERE run_id = ? AND is_user = 0", run.id);
    // Fixed words only. Nothing the model wrote is carried over, not even what it asked a tool for.
    this.#append(run.session_id, run.id, { role: "assistant", content: OUTSIDE_REMOVED });
    this.#store.sql.exec("UPDATE items SET outside = 2 WHERE run_id = ? AND is_user = 0", run.id);
    this.#store.sql.exec("UPDATE outbox SET private = 1 WHERE run_id = ?", run.id);
    this.#outbox.scrub("run_id = ?", run.id);
  }

  /** Whether this run has been given text from outside by a connector's tool. */
  #sawOutside(runId: string): boolean {
    return this.#outside.size > 0 || this.#store.rows("SELECT 1 FROM items WHERE run_id = ? AND outside = 1 LIMIT 1", runId).length > 0;
  }

  /**
   * The items the model sees. The window always starts at a user turn: starting anywhere else would
   * hand the model a tool output without its call, or a reasoning item without its message. If the
   * most recent turns alone exceed the window, the window grows to hold the whole latest turn.
   */
  #transcript(sessionId: string): Item[] {
    const last = this.#store.rows<{ seq: number }>("SELECT MAX(seq) AS seq FROM items WHERE session_id = ?", sessionId)[0]?.seq;
    if (last == null) return [];
    const floor = Math.max(1, last - MAX_TRANSCRIPT_ITEMS + 1);
    const start =
      this.#store.rows<{ seq: number }>("SELECT MIN(seq) AS seq FROM items WHERE session_id = ? AND seq >= ? AND is_user = 1", sessionId, floor)[0]?.seq ??
      this.#store.rows<{ seq: number }>("SELECT MAX(seq) AS seq FROM items WHERE session_id = ? AND is_user = 1", sessionId)[0]?.seq ??
      floor;
    return this.#store.rows<{ item: string }>("SELECT item FROM items WHERE session_id = ? AND seq >= ? ORDER BY seq", sessionId, start).map((r) => JSON.parse(r.item) as Item);
  }

  /**
   * The Brain's own tools, and a connector's where this run acts for one person through it. Once
   * the run has read outside text, only what it may still use (see #mayUse).
   */
  #toolsFor(runId: string): ToolDefinition[] {
    // A run that carries a request on answers it, and does nothing else.
    if (this.#requests.continuationOf(runId)) return TOOLS.filter((each) => each.name === "send_message").map((each) => (this.#requests.followUps() ? each : withoutQuotes(each)));
    const acting = this.#actingFor(runId);
    const keeps = acting !== undefined && this.#requests.followUps();
    const own = TOOLS.filter((each) => each.name !== "reopen_answer" || keeps).map((each) => (each.name === "send_message" && !keeps ? withoutQuotes(each) : each));
    const all = acting ? [...own, ...toolsOf(acting.connector).map((each) => describeTool(each.name, each.description, { ...each.parameters, replaces: REPLACES }))] : own;
    return all.filter((each) => this.#mayUse(runId, each.name));
  }

  /**
   * Whether a tool may be used in this run now. Before the run has read outside text: any tool it
   * has. After: the reply to the person, and a connector's tools that only read. That is a list of
   * what is allowed, not of what is forbidden, so a tool added later is refused until it is put on
   * it.
   */
  #mayUse(runId: string, name: string): boolean {
    const carried = this.#requests.continuationOf(runId);
    // The one call made for it (checked again, by its id, where it is carried out) and its answer.
    if (carried) return name === "send_message" || (carried.status === "resuming" && name === carried.tool);
    if (!this.#sawOutside(runId)) return true;
    if (name === "send_message") return true;
    const acting = this.#actingFor(runId);
    return acting !== undefined && toolsOf(acting.connector).some((each) => each.name === name && each.effect === "read");
  }

  #instructions(runId: string): string {
    // A person who deliberately wrote to the agent is waiting for it; anything else merely happened.
    const waiting = this.#store.rows<{ principal: string }>("SELECT principal FROM inbox WHERE run_id = ? AND kind = 'message'", runId).some((event) => {
      const principal = JSON.parse(event.principal) as Principal;
      return principal.kind === "human" && principal.explicit === true;
    });
    return buildInstructions({
      scope: this.#store.scope(),
      situation: waiting ? "conversation" : "background",
      now: Date.now(),
      instructions: this.#store.rows<Row>("SELECT content FROM memory WHERE path = 'instructions.md'")[0]?.content,
      index: this.#store.rows<Row>("SELECT content FROM memory WHERE path = 'index.md'")[0]?.content,
      tasks: this.#store.rows<Row>("SELECT id, title, status FROM tasks WHERE status IN ('dispatching', 'running', 'needs_input') ORDER BY created_at") as any,
      answers: this.#requests.reopenable(runId),
      requests: this.#requests.cancellable(this.#store.rows<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", runId)[0]?.session_id ?? "").map((each) => ({ id: each.id, asked: this.#requests.askedFor(each) })),
    });
  }

  #tokensToday(): number {
    return Number(this.#store.meta(`tokens:${today()}`) ?? 0);
  }

  // ------------------------------------------------------------------ tools

  #toolHost(run: RunRow): ToolHost {
    const session = this.#store.rows<Row>("SELECT * FROM sessions WHERE id = ?", run.session_id)[0];
    const sql = this.#store.sql;
    return {
      connectorTool: async (callId, name, args) => {
        // Decided afresh at the moment of use, from what is stored: also after an interruption.
        const acting = this.#actingFor(run.id);
        const found = acting && toolsOf(acting.connector).find((each) => each.name === name);
        if (!acting || !found) throw new Error(`there is no tool "${name}" in this run`);
        const carried = this.#requests.continuationOf(run.id);
        // A run that carries a request on makes one call: the one made for it, with what the
        // request was made with. Nothing the model asks for in such a run is carried out.
        if (carried && (carried.status !== "resuming" || carried.call_id !== callId || carried.tool !== name)) throw new Error("this run can only answer the request it carries on");
        // A call that was told to wait has that for its answer, also when the run is replayed
        // after an interruption: the connector is not asked a second time, whatever has happened
        // since. Carrying the request on is another run's to do.
        if (!carried && this.#store.rows("SELECT 1 FROM continuations WHERE id = ?", callId).length > 0) return { waiting: true, request: callId, note: WAITING_NOTE };
        const key = carried ? carried.id : callId;
        const { replaces, ...asked } = args;
        const given = carried ? (JSON.parse(carried.args) as Record<string, unknown>) : asked;
        // In place of a request that still waits: that one ends in the same step this one is kept
        // or done. Ending a request changes something, so it needs what calling one off needs,
        // decided here and before anything is read: a run that has read outside text may not.
        const replacing = !carried && typeof replaces === "string" && replaces !== "";
        if (replacing && !this.#mayUse(run.id, "cancel_request")) throw new Error(READ_OUTSIDE);
        const replaced = replacing ? this.#requests.mayCancel(run, replaces as string, callId) : undefined;
        // Which earlier messages of the person the tool acted on, as it says itself.
        const relied = new Set<number>();
        const named = new Set<number>();
        let identified: { request: Record<string, unknown>; identity: string; under: { condition: string; generation: number } } | undefined;
        const evidence = () => {
          const said = this.#requests.basis(run.id).map((each) => each.id);
          const recent = [...relied].map((index) => acting.recentIds[index]).filter((each) => each !== undefined);
          // `bound`: the messages the tool said its action rests on. A reply to one of these is about this request.
          return { said, recent, bound: [...[...named].map((index) => said[index]).filter((each) => each !== undefined), ...recent] };
        };
        const notAfter = (carried?.claimed_at ?? 0) + HANDLING_LIMIT_MS;
        if (carried && Date.now() > notAfter) {
          this.#requests.endRequest(carried.id, "void", "it was not finished in time");
          throw new Error("this request was not finished in time; nothing was read. The person can ask again");
        }
        // Whatever comes back is from outside, including an error that quotes something.
        this.#outside.add(callId);
        // Which tool and for whom. Not its arguments: they can name what the person is reading.
        this.#store.audit(acting.person, "tool.used", { tool: name, call: key });
        let waits = false;
        try {
          const result = await found.run({ env: this.env, scope: this.#store.scope(), person: acting.person, origin: acting.origin, said: acting.said, recent: acting.recent, callId: key, relied: (from, index) => void (from === "said" ? named : relied).add(index), identified: (request, identity, under) => void (identified = { request, identity, under }), ...(carried ? { resuming: { generation: carried.generation, notAfter } } : {}) }, given);
          if (!isWaiting(result)) {
            if (replaced) this.#requests.cancel(replaced.record, callId, replaced.choosing);
            // What was read, for a later follow-up; a refusal or an error is not something read.
            // Only what the tool itself identified: its canonical call and the thing as resolved.
            const read = identified as { request: Record<string, unknown>; identity: string; under: { condition: string; generation: number } } | undefined;
            if (read && typeof result === "object" && result !== null && !("error" in result)) {
              this.#requests.noteSource(run.id, { connector: acting.connector, tool: name, args: JSON.stringify(read.request), call: key, events: evidence(), fingerprint: await fingerprint(result), identity: read.identity, ...read.under });
            }
            return result;
          }
          // Nothing was read. The answer the model gets is written here, not by the tool.
          waits = true;
          this.#outside.delete(callId);
          return this.#requests.wait(run, { connector: acting.connector, events: evidence() }, key, name, result.waiting, replaced ? { ...replaced, by: callId } : undefined);
        } finally {
          // What this run has already written to send, and whatever it writes from here on.
          if (!waits) this.#store.sql.exec("UPDATE outbox SET private = 1 WHERE run_id = ?", run.id);
        }
      },
      sendMessage: (callId, text, quotes) => {
        this.#requests.noteQuotes(run.id, quotes);
        const carried = this.#requests.continuationOf(run.id);
        if (!carried) {
          return this.#outbox.enqueue(`msg:${callId}`, run.session_id, run.id, text);
        }
        // Everything such a run says belongs to the request it carries on. That request has one
        // answer, kept as a draft until the run ends; one that is waiting again has none.
        if (carried.status !== "resuming") return { ok: true, note: "nothing was sent: the request is not being answered now" };
        return this.#requests.draft(carried, run, text);
      },
      reopenAnswer: (callId, answerId) => this.#requests.reopenAnswer(run, callId, answerId),
      cancelRequest: (callId, requestId, ask) => {
        const chosen = this.#requests.mayCancel(run, requestId, callId, ask);
        this.#requests.cancel(chosen.record, callId, chosen.choosing);
        return { ok: true, cancelled: chosen.record.id, note: "It will not be carried on and nothing of it will be sent. Tell the person it has been cancelled." };
      },
      sendReview: (callId, summary, commit, comments) => {
        // The same review in words, for wherever comments cannot be attached to lines.
        const said = [summary, ...comments.map((c) => `${c.path}:${c.line}\n${c.body}`)].join("\n\n");
        if (said.length > MAX_MESSAGE_TEXT) throw new Error(`the review is too long: summary and comments together must stay within ${MAX_MESSAGE_TEXT} characters`);
        return this.#outbox.enqueue(`msg:${callId}`, run.session_id, run.id, said, undefined, { summary, ...(commit ? { commit } : {}), comments });
      },

      memoryList: () => ({ files: this.#store.rows("SELECT path, LENGTH(content) AS size, updated_at FROM memory ORDER BY path") }),
      memoryRead: (path) => {
        const row = this.#store.rows<Row>("SELECT content FROM memory WHERE path = ?", path)[0];
        if (!row) throw new Error(`no memory file at ${path}`);
        return { path, content: row.content };
      },
      memoryWrite: (path, content) => {
        if (!MEMORY_PATH.test(path) || path.includes("..")) throw new Error("path must look like notes/topic.md: lowercase letters, digits, - _ /");
        // instructions.md is read as instructions in every later run, so only a person who is a
        // member here may cause it to change. Text from a PR, a CI log or a worker cannot.
        if (path === "instructions.md") this.#store.audit(this.#instructionEditors(run.id).join(","), "instructions.changed", { length: content.length });
        const exists = this.#store.rows("SELECT 1 FROM memory WHERE path = ?", path).length > 0;
        if (!exists && this.#store.rows<{ n: number }>("SELECT COUNT(*) AS n FROM memory")[0].n >= MAX_MEMORY_FILES) throw new Error("memory is full; delete something first");
        sql.exec("INSERT INTO memory (path, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at", path, content, Date.now());
        // Said at the moment it happens, so the file is shortened by the run that made it long.
        const limit = path === "index.md" ? MAX_LOADED_INDEX : path === "instructions.md" ? MAX_LOADED_INSTRUCTIONS : undefined;
        if (limit !== undefined && content.trim().length > limit) return { ok: true, path, note: `saved, but only the first ${limit} characters of ${path} are loaded into a run; shorten it, and move detail into other files` };
        return { ok: true, path };
      },
      memoryDelete: (path) => {
        if (path === "instructions.md") this.#store.audit(this.#instructionEditors(run.id).join(","), "instructions.deleted", {});
        const existed = this.#store.rows("SELECT 1 FROM memory WHERE path = ?", path).length > 0;
        sql.exec("DELETE FROM memory WHERE path = ?", path);
        return { ok: true, deleted: existed };
      },

      setTimer: (callId, delaySeconds, note, repeat) => {
        if (delaySeconds < 5 || delaySeconds > 366 * 86_400) throw new Error("delay_seconds must be between 5 and one year");
        if (repeat !== null && repeat < 60) throw new Error("repeat_every_seconds must be at least 60");
        const id = `tmr_${callId.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`;
        if (this.#store.rows("SELECT 1 FROM timers WHERE id = ?", id).length === 0 && this.#store.rows<{ n: number }>("SELECT COUNT(*) AS n FROM timers WHERE status = 'active'")[0].n >= MAX_ACTIVE_TIMERS) {
          throw new Error("too many active timers; cancel one first");
        }
        const due = Date.now() + delaySeconds * 1_000;
        sql.exec("INSERT OR IGNORE INTO timers (id, due_at, every_s, session_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, due, repeat, session.session_key, note, Date.now());
        return { ok: true, id, fires_at: new Date(due).toISOString() };
      },
      listTimers: () => ({
        timers: this.#store.rows<Row>("SELECT id, due_at, every_s, note FROM timers WHERE status = 'active' AND data IS NULL ORDER BY due_at").map((t) => ({
          id: t.id,
          fires_at: new Date(t.due_at).toISOString(),
          repeat_every_seconds: t.every_s,
          note: t.note,
        })),
      }),
      cancelTimer: (id) => {
        const active = this.#store.rows("SELECT 1 FROM timers WHERE id = ? AND status = 'active' AND data IS NULL", id).length > 0;
        if (active) sql.exec("UPDATE timers SET status = 'cancelled' WHERE id = ?", id);
        return { ok: true, cancelled: active };
      },

      dispatchTask: async (callId, title, brief, repository) => {
        return this.#tasks.dispatch(run, session.session_key, callId, title, brief, repository);
      },
      taskStatus: (taskId) => this.#tasks.status(taskId),
      answerTask: (callId, taskId, decision, reason) => this.#tasks.answer(run, session.session_key, callId, taskId, decision, reason),
      cancelTask: (taskId) => this.#tasks.cancel(session.session_key, taskId),
    };
  }

  // ------------------------------------------------------------------ requests that wait, and answers that can be followed up
  //
  // Kept in ./requests. What is here is only what the wake cycle and the connectors call.

  /** Called by a connector when something changed for one of its subjects: see Requests.conditionReported. */
  async conditionReported(connector: string, subject: string, event: string): Promise<{ ok: true }> {
    return this.#requests.conditionReported(connector, subject, event);
  }

  /** The run to work on next: the active one, a request to carry on, or a new run over pending events. */
  async #next(): Promise<string | undefined> {
    for (;;) {
      const active = this.#activeRun();
      if (active) return active.retry_at && active.retry_at > Date.now() ? undefined : active.id;
      const first = this.#store.rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0];
      if (!first) return undefined;
      if (first.kind !== "request.ready") return this.#claim();
      const runId = await this.#requests.resume(first);
      if (runId) return runId;
    }
  }

  // ------------------------------------------------------------------ tasks
  //
  // Kept in ./tasks. What is here is only what workers and connectors call.

  /** Called by a worker to report: see Tasks.event. */
  async taskEvent(taskId: string, seq: number, kind: WorkerEventKind, report: Record<string, unknown>): Promise<{ ok: boolean }> {
    return this.#tasks.event(taskId, seq, kind, report);
  }

  /** Whether this text quotes the code of an approval question that is open in this conversation: see Tasks.quotesOpenQuestion. */
  async quotesOpenQuestion(text: string, sessionKey: string): Promise<boolean> {
    return this.#tasks.quotesOpenQuestion(text, sessionKey);
  }

  /**
   * The people whose word counts in this run: humans who deliberately addressed the agent and who
   * belong here. In a repository, an account that is not linked to a tenant user is an outsider.
   */
  #deciders(runId: string): Principal[] {
    return this.#runSpeakers(runId)
      .filter(({ principal, source }) => this.#isDecider(principal, source))
      .map(({ principal }) => principal);
  }

  /**
   * Who may be changing the standing instructions in this run, or an error. The run must have been
   * started by members only: if a worker report, a CI event or any other untrusted text is in the
   * same batch, the model may be acting on that text rather than on the member's words.
   */
  #instructionEditors(runId: string): string[] {
    const speakers = this.#runSpeakers(runId);
    const principals = speakers.map(({ principal }) => principal);
    // A comment that was only let in as a reply to an approval question is not a request either.
    const replyOnly = this.#store.rows<{ data: string | null }>("SELECT data FROM inbox WHERE run_id = ?", runId).some((row) => row.data && JSON.parse(row.data).reply_only === true);
    if (principals.length === 0 || replyOnly || !speakers.every(({ principal, source }) => this.#isDecider(principal, source))) {
      throw new Error("instructions.md can only be changed in a run started solely by a person's request");
    }
    return [...new Set(principals.map((p) => p.id))];
  }

  /**
   * Whether this person's word counts here: a person who deliberately addressed the agent, who is
   * a user of the tenant, and whose identity was established by a connector the deployment trusts
   * to establish it. What a connector outside that list says about who spoke is not relied on.
   */
  #isDecider(principal: Principal, source: string): boolean {
    return principal.kind === "human" && principal.explicit && principal.unlinked !== true && trusts(source);
  }

  #runSpeakers(runId: string): { principal: Principal; source: string }[] {
    return this.#store.rows<{ principal: string; source: string }>("SELECT principal, source FROM inbox WHERE run_id = ? ORDER BY id", runId).map((r) => ({ principal: JSON.parse(r.principal) as Principal, source: r.source }));
  }

  // ------------------------------------------------------------------ reads for connectors and admins

  /**
   * Records that something a person wrote (a comment, say) now stands at this revision, or is gone.
   * A message read from any other revision can no longer decide anything. `holder` identifies the
   * text of the revision. Revisions only move forward, so events delivered out of order end in the
   * same state; two different texts claiming the same revision leave nobody holding it.
   */
  async revise(subject: string, revision: number, deleted: boolean, holder = ""): Promise<void> {
    this.#revisions.revise(subject, revision, deleted, holder);
  }

  /** Records where this scope's messages go when an event does not say. Set by the first connector to reach it. */
  async setDefaultTarget(target: Target): Promise<void> {
    if (!this.#store.meta("default_target")) this.#store.setMeta("default_target", JSON.stringify(target));
  }

  /**
   * Messages written since `afterId` and addressed to the named connector, for one whose clients
   * pull instead of being pushed to. A message addressed anywhere else is not theirs to read: what
   * the agent says to someone in another system stays in that system.
   */
  async outboxSince(connector: string, afterId: number, limit = 50): Promise<{ id: number; text: string; status: string; created_at: number }[]> {
    // A question withdrawn before it went out was never said to anyone, on any channel.
    return this.#store.rows(
      "SELECT id, text, status, created_at FROM outbox WHERE id > ? AND json_extract(target, '$.connector') = ? AND status NOT IN ('withdrawn', 'reconciling', 'void', 'draft') AND NOT (status = 'pending' AND ask IS NOT NULL AND closed IS NOT NULL) ORDER BY id LIMIT ?",
      afterId,
      connector,
      Math.min(limit, 200),
    );
  }

  async inspect(): Promise<Record<string, unknown>> {
    const count = (table: string, where = "1") => this.#store.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;
    return {
      scope: this.#store.meta("scope"),
      alarm_at: await this.ctx.storage.getAlarm(),
      active_run: this.#activeRun() ?? null,
      inbox: { pending: count("inbox", "status = 'pending'"), claimed: count("inbox", "status = 'claimed'"), done: count("inbox", "status = 'done'"), dead: count("inbox", "status = 'dead'") },
      recent_events: this.#store.rows("SELECT id, source, kind, session_key, status, substr(text, 1, 160) AS text FROM inbox ORDER BY id DESC LIMIT 15"),
      runs: this.#store.rows("SELECT id, status, entries, steps, input_tokens, output_tokens, started_at, ended_at, error FROM runs ORDER BY started_at DESC LIMIT 10"),
      sessions: this.#store.rows("SELECT session_key, (SELECT COUNT(*) FROM items WHERE session_id = sessions.id) AS items FROM sessions"),
      memory: this.#store.rows("SELECT path, LENGTH(content) AS size FROM memory ORDER BY path"),
      timers: this.#store.rows("SELECT id, due_at, every_s, status, substr(note, 1, 120) AS note FROM timers ORDER BY due_at DESC LIMIT 10"),
      tasks: this.#store.rows("SELECT id, title, status, requested_by, last_progress, substr(result, 1, 300) AS result FROM tasks ORDER BY created_at DESC LIMIT 10"),
      // What was written after reading outside text is not shown here either, sent or not.
      outbox: this.#store.rows("SELECT id, status, attempts, CASE WHEN private = 1 OR continuation IS NOT NULL THEN '' ELSE substr(text, 1, 200) END AS text, error FROM outbox ORDER BY id DESC LIMIT 10"),
      tokens_today: this.#tokensToday(),
      health: {
        oldest_pending_age_ms: (() => {
          const oldest = this.#store.rows<{ at: number }>("SELECT MIN(received_at) AS at FROM inbox WHERE status IN ('pending', 'claimed')")[0]?.at;
          return oldest == null ? 0 : Date.now() - oldest;
        })(),
        dead_events: count("inbox", "status = 'dead'"),
        undeliverable_messages: count("outbox", "status = 'dead'"),
        unverified_messages: count("outbox", "status = 'unverified'"),
        lost_tasks: count("tasks", "status = 'lost'"),
        abandoned_runs: count("runs", "status = 'failed'"),
      },
      audit: this.#store.rows("SELECT at, actor, action, detail FROM audit ORDER BY id DESC LIMIT 20"),
      waits: this.#requests.waits(),
    };
  }

  async readMemory(path: string): Promise<string | null> {
    return this.#store.rows<Row>("SELECT content FROM memory WHERE path = ?", path)[0]?.content ?? null;
  }

  // ------------------------------------------------------------------ helpers





}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

export { messageText };
export { readDecision, readTiedDecision, wantsStanding } from "./tasks";
