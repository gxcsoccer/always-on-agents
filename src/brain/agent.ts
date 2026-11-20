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

import { type ApprovalQuestion, type CodeReview, DeliveryDeferred, type Outcome, type Receipt, amend, canRevisit, deliver, standingOf, trusts } from "../connectors";
import type { Env } from "../env";
import { type InboundEvent, NOT_FOR_THE_AGENT, type Principal, type Scope, type Target, type WorkerEventKind, parseScope } from "../events";
import { type Item, ModelError, messageText, respond } from "../model/openai";
import { registry } from "../registry";
import { type QuestionFate, clipResult } from "../workers/sandbox/result";
import { type RefUpdate, standingEligible } from "../workers/sandbox/outbound";
import { buildInstructions } from "./prompt";
import { migrate } from "./schema";
import { MAX_MESSAGE_TEXT, TOOLS, type ToolCall, type ToolHost, executeTool } from "./tools";

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
const MAX_ACTIVE_TASKS = 3;
const MAX_ACTIVE_TIMERS = 50;
const MAX_MEMORY_FILES = 200;
const DAILY_TOKEN_BUDGET = 2_000_000;
/** Tokens set aside against the tenant's budget before a model call, corrected to the real figure after. */
const MODEL_CALL_RESERVE = 20_000;
const OUTBOX_RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 300_000, 900_000];
/**
 * The longest an outside system's request to wait is waited out. The queue delivers in order, so a
 * message that waits holds back those behind it; one asked to wait longer than this is given up
 * as undeliverable rather than sent early or held indefinitely.
 */
const MAX_DEFERRAL_MS = 24 * 60 * 60_000;
const TASK_WATCHDOG_S = 2 * 60 * 60 + 10 * 60;
/** How long finished records are kept before housekeeping removes them. */
const RETAIN_RECORDS_MS = 30 * 86_400_000;
const RETAIN_AUDIT_MS = 365 * 86_400_000;
/** A conversation keeps at least this many recent transcript items, however old. */
const RETAIN_ITEMS_PER_SESSION = 200;
const MEMORY_PATH = /^[a-z0-9][a-z0-9_\-/]{0,150}\.md$/;
/** How many times the worker is asked how a set-aside question ended before giving up on knowing. */
const SETTLE_ATTEMPTS = 12;
const TERMINAL_TASK = new Set(["succeeded", "failed", "lost", "cancelled"]);

type Row = Record<string, any>;

interface InboxRow {
  id: number;
  source: string;
  source_id: string;
  kind: string;
  session_key: string;
  principal: string;
  text: string | null;
  data: string | null;
  reply_to: string | null;
  received_at: number;
}

interface RunRow {
  id: string;
  session_id: string;
  status: string;
  entries: number;
  steps: number;
  retry_at: number | null;
}

export class BrainAgent extends DurableObject<Env> {
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
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
      const asked = this.#rows<{ idem: string }>("SELECT idem FROM outbox WHERE ask IS NOT NULL AND json_extract(receipt, '$.subject') = ?", event.data.replies_to)[0];
      if (asked) event = { ...event, data: { ...event.data, question: asked.idem } };
    }
    if (event.kind === "message" && event.data?.route_by_code === true && event.text) {
      const pressed = typeof event.data.question === "string" ? event.data.question : undefined;
      const sessions = new Set(
        this.#rows<{ session_key: string; code: string | null; ask: string | null }>(
          "SELECT session_key, json_extract(pending, '$.code') AS code, json_extract(pending, '$.ask') AS ask FROM tasks WHERE status = 'needs_input' AND pending IS NOT NULL",
        )
          // A button names its question exactly; typed words name it by its code.
          .filter(({ code, ask }) => (pressed ? ask === pressed : code && quotes(event.text ?? "", code)))
          .map(({ session_key }) => session_key),
      );
      // Its answer goes where the question was asked, not to wherever the reply came from. Where it
      // did come from is kept: what the same person says there next still bears on it.
      if (sessions.size === 1 && !sessions.has(event.session_key)) {
        event = { ...event, session_key: [...sessions][0], reply_to: undefined, data: { ...event.data, routed_from: event.session_key } };
      }
    }
    const subject = event.data?.subject;
    if (typeof subject === "string") this.#revise(subject, Number(event.data?.revision ?? 0), false, String(event.data?.holder ?? ""));
    const inserted = this.#insertEvent(event);
    // Also on a duplicate: the first delivery may have been stored without its wake-up being scheduled.
    await this.#wakeBy(Date.now() + BATCH_WINDOW_MS);
    return { accepted: true, duplicate: !inserted };
  }

  #insertEvent(event: InboundEvent): boolean {
    // Checked explicitly: rowsWritten also counts index writes, so it cannot tell an insert from an ignore.
    if (this.#rows("SELECT 1 FROM inbox WHERE source = ? AND source_id = ?", event.source, event.source_id).length > 0) return false;
    this.#sql.exec(
        `INSERT OR IGNORE INTO inbox (source, source_id, kind, session_key, principal, text, data, reply_to, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.source,
        event.source_id,
        event.kind,
        event.session_key,
        JSON.stringify(event.principal),
        event.text ?? null,
        event.data ? JSON.stringify(event.data) : null,
      event.reply_to ? JSON.stringify(event.reply_to) : null,
      Date.now(),
    );
    return true;
  }

  // ------------------------------------------------------------------ the wake cycle

  async alarm(): Promise<void> {
    try {
      this.#fireTimers(Date.now());
      this.#housekeeping(Date.now());
      await this.#flushOutbox();
      await this.#settleQuestions();
      // A few runs per wake-up at most, so one busy scope cannot hold an invocation forever.
      for (let i = 0; i < 3; i++) {
        const runId = this.#claim();
        if (!runId) break;
        await this.#execute(runId);
        await this.#flushOutbox();
        if (this.#meta("active_run")) break;
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
    else if (this.#rows("SELECT 1 FROM inbox WHERE status = 'pending' LIMIT 1").length > 0) candidates.push(now + 200);
    const timer = this.#rows<{ due_at: number }>("SELECT MIN(due_at) AS due_at FROM timers WHERE status = 'active'")[0]?.due_at;
    if (timer != null) candidates.push(timer);
    const outbox = this.#rows<{ next_at: number }>("SELECT next_at FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0]?.next_at;
    if (outbox != null) candidates.push(outbox);
    const reconciling = this.#rows<{ next_at: number | null }>("SELECT MIN(next_at) AS next_at FROM outbox WHERE status = 'reconciling'")[0]?.next_at;
    if (reconciling != null) candidates.push(reconciling);
    const unsettled = this.#rows<{ next_at: number | null }>("SELECT MIN(next_at) AS next_at FROM unsettled")[0]?.next_at;
    if (unsettled != null) candidates.push(unsettled);
    // Housekeeping is work too: a scope that has gone quiet still has old records to remove.
    const housekeeping = Number(this.#meta("housekeeping_at") ?? 0);
    if (housekeeping > 0 && this.#rows("SELECT 1 FROM inbox LIMIT 1").length > 0) candidates.push(housekeeping);
    if (candidates.length === 0) return;
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 50));
  }

  // ------------------------------------------------------------------ records

  /** Who decided what. Append-only, kept long after the events themselves are gone. */
  #audit(actor: string, action: string, detail: Record<string, unknown>): void {
    this.#sql.exec("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)", Date.now(), actor, action, JSON.stringify(detail));
  }

  /** One structured line per thing an operator would want to be alerted on. */
  #log(event: string, detail: Record<string, unknown>): void {
    console.log(JSON.stringify({ event, scope: this.ctx.id.name, ...detail }));
  }

  /** Once a day, removes what is finished and old. Nothing pending, running or recent is touched. */
  #housekeeping(now: number): void {
    if (Number(this.#meta("housekeeping_at") ?? 0) > now) return;
    this.#setMeta("housekeeping_at", String(now + 86_400_000));
    const old = now - RETAIN_RECORDS_MS;
    this.ctx.storage.transactionSync(() => {
      // Old events lose their content but keep their identity for a year: the (source, source_id)
      // pair is what makes a replayed webhook a duplicate, and a signed webhook never expires.
      this.#sql.exec("UPDATE inbox SET text = NULL, data = NULL, reply_to = NULL WHERE status IN ('done', 'dead') AND received_at < ? AND text IS NOT NULL", old);
      this.#sql.exec("DELETE FROM inbox WHERE status IN ('done', 'dead') AND received_at < ?", now - RETAIN_AUDIT_MS);
      this.#sql.exec("DELETE FROM outbox WHERE status IN ('sent', 'dead', 'withdrawn', 'reconciling') AND created_at < ?", old);
      this.#sql.exec("DELETE FROM runs WHERE status != 'running' AND ended_at < ?", old);
      this.#sql.exec("DELETE FROM timers WHERE status != 'active' AND created_at < ?", old);
      this.#sql.exec("DELETE FROM task_events WHERE at < ?", old);
      this.#sql.exec("DELETE FROM tasks WHERE status IN ('succeeded', 'failed', 'lost', 'cancelled') AND updated_at < ?", old);
      this.#sql.exec("DELETE FROM audit WHERE at < ?", now - RETAIN_AUDIT_MS);
      this.#sql.exec("DELETE FROM meta WHERE key LIKE 'tokens:%' AND key < ?", `tokens:${new Date(old).toISOString().slice(0, 10)}`);
      // Old transcript, beyond what any future run would be shown. The cut lands on a user turn, as
      // the window does, so a kept transcript never opens mid-exchange.
      for (const session of this.#rows<{ id: string }>("SELECT id FROM sessions WHERE updated_at < ?", old)) {
        const keepFrom = this.#rows<{ seq: number }>(
          "SELECT MIN(seq) AS seq FROM items WHERE session_id = ? AND is_user = 1 AND seq > (SELECT COALESCE(MAX(seq), 0) FROM items WHERE session_id = ?) - ?",
          session.id,
          session.id,
          RETAIN_ITEMS_PER_SESSION,
        )[0]?.seq;
        if (keepFrom != null) this.#sql.exec("DELETE FROM items WHERE session_id = ? AND seq < ?", session.id, keepFrom);
      }
    });
  }

  // ------------------------------------------------------------------ timers

  #fireTimers(now: number): void {
    this.ctx.storage.transactionSync(() => {
      for (const timer of this.#rows<Row>("SELECT * FROM timers WHERE status = 'active' AND due_at <= ?", now)) {
        const data = timer.data ? JSON.parse(timer.data) : {};
        // A watchdog for a task that already ended has nothing to say.
        const stale = data.task_id && TERMINAL_TASK.has(this.#rows<Row>("SELECT status FROM tasks WHERE id = ?", data.task_id)[0]?.status);
        if (!stale) {
          this.#insertEvent({
            source: "timer",
            source_id: `${timer.id}:${timer.due_at}`,
            kind: data.task_id ? "task.overdue" : "timer",
            session_key: timer.session_key,
            principal: { kind: "timer", id: timer.id, explicit: false },
            text: timer.note,
            data,
          });
        }
        if (timer.every_s && !stale) {
          // Skip occurrences that were missed while asleep rather than firing them all at once.
          const next = Math.max(timer.due_at + timer.every_s * 1_000, now + timer.every_s * 1_000);
          this.#sql.exec("UPDATE timers SET due_at = ? WHERE id = ?", next, timer.id);
        } else {
          this.#sql.exec("UPDATE timers SET status = 'done' WHERE id = ?", timer.id);
        }
      }
    });
  }

  // ------------------------------------------------------------------ runs

  #activeRun(): RunRow | undefined {
    const id = this.#meta("active_run");
    return id ? this.#rows<RunRow>("SELECT * FROM runs WHERE id = ?", id)[0] : undefined;
  }

  /**
   * Returns the run to work on: the active one if there is one (resuming it), otherwise a new run
   * over the oldest pending conversation. Claiming is one synchronous transaction, so two
   * invocations can never both claim the same events.
   */
  #claim(): string | undefined {
    return this.ctx.storage.transactionSync(() => {
      const active = this.#activeRun();
      if (active) return active.retry_at && active.retry_at > Date.now() ? undefined : active.id;

      const first = this.#rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0];
      if (!first) return undefined;
      const now = Date.now();
      const runId = crypto.randomUUID();

      let session = this.#rows<Row>("SELECT * FROM sessions WHERE session_key = ?", first.session_key)[0];
      if (!session) {
        session = { id: crypto.randomUUID() };
        this.#sql.exec("INSERT INTO sessions (id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)", session.id, first.session_key, now, now);
      }
      // Bounded, so a burst in one conversation becomes several runs instead of one oversized one.
      const events: InboxRow[] = [];
      let bytes = 0;
      for (const event of this.#rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' AND session_key = ? ORDER BY id LIMIT ?", first.session_key, MAX_EVENTS_PER_RUN)) {
        bytes += (event.text?.length ?? 0) + (event.data?.length ?? 0) + 300;
        if (events.length > 0 && bytes > MAX_EVENT_BYTES_PER_RUN) break;
        events.push(event);
        this.#sql.exec("UPDATE inbox SET status = 'claimed', run_id = ? WHERE id = ?", runId, event.id);
      }

      // Replies go where the most recent addressed event came from.
      const target = [...events].reverse().find((e) => e.reply_to)?.reply_to;
      if (target) this.#sql.exec("UPDATE sessions SET target = ? WHERE id = ?", target, session.id);

      this.#sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES (?, ?, 'running', ?)", runId, session.id, now);
      this.#append(session.id, runId, { role: "user", content: events.map(renderEvent).join("\n") });
      this.#setMeta("active_run", runId);
      return runId;
    });
  }

  async #execute(runId: string): Promise<void> {
    const entered = this.#rows<RunRow>("UPDATE runs SET entries = entries + 1, retry_at = NULL WHERE id = ? RETURNING *", runId)[0];
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
          const output = await executeTool(this.#toolHost(run), call);
          if (!this.#stillActive(runId)) return;
          this.#append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output });
        }
        continue;
      }

      const last = items.at(-1);
      const awaitingModel = last && (last.role === "user" || last.type === "function_call_output");
      if (!awaitingModel || run.steps >= MAX_STEPS_PER_RUN) break;

      // Two limits: this scope's own, and the tenant's across all of its scopes and sandboxes.
      // The tenant's share is reserved before the call and trued up after it, so several scopes
      // admitted at the same moment cannot all slip under the limit together.
      const tenant = await registry(this.env).recordUsage(this.#scope().tenant, MODEL_CALL_RESERVE);
      // The day the registry charged, which is not necessarily today as seen from here.
      const reservedOn = tenant.day;
      if (!this.#stillActive(runId)) return;
      if (!tenant.allowed || this.#tokensToday() >= DAILY_TOKEN_BUDGET) {
        await registry(this.env).adjustUsage(this.#scope().tenant, -MODEL_CALL_RESERVE, reservedOn).catch(() => undefined);
        if (!this.#stillActive(runId)) return;
        // The run stays claimed and resumes after midnight UTC; nothing is dropped. This pause is
        // not a failure, so it does not count towards the run's entry limit.
        this.#notify(`budget:${runId}:${today()}`, run.session_id, runId, "I have reached today's usage limit here and will pick this up tomorrow.");
        this.#log("budget_exhausted", { run: runId, tokens_today: this.#tokensToday() });
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 30, 0);
        this.#sql.exec("UPDATE runs SET retry_at = ?, entries = entries - 1 WHERE id = ?", midnight.getTime(), runId);
        return;
      }

      let response;
      try {
        response = await respond({
          baseUrl: this.env.OPENAI_BASE_URL,
          apiKey: this.env.OPENAI_API_KEY,
          model: this.env.BRAIN_MODEL,
          instructions: this.#instructions(),
          input: items,
          tools: TOOLS,
        });
      } catch (err) {
        await registry(this.env).adjustUsage(this.#scope().tenant, -MODEL_CALL_RESERVE, reservedOn).catch(() => undefined);
        return this.#retryLater(runId, err);
      }
      if (!this.#stillActive(runId)) return;
      this.ctx.storage.transactionSync(() => {
        for (const item of response.output) this.#append(run.session_id, runId, item);
        this.#sql.exec(
          "UPDATE runs SET steps = steps + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?",
          response.usage.input_tokens,
          response.usage.output_tokens,
          runId,
        );
        this.#setMeta(`tokens:${today()}`, String(this.#tokensToday() + response.usage.total_tokens));
      });
      // After the commit: if this is lost the tenant is under-counted by one call, never blocked.
      await registry(this.env).adjustUsage(this.#scope().tenant, response.usage.total_tokens - MODEL_CALL_RESERVE, reservedOn).catch(() => undefined);
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
    this.#sql.exec("UPDATE runs SET retry_at = ?, error = ? WHERE id = ?", Date.now() + delay, message.slice(0, 1_000), runId);
  }

  #abandon(runId: string, reason: string): void {
    const run = this.#rows<RunRow>("SELECT * FROM runs WHERE id = ?", runId)[0];
    if (!run) return;
    this.ctx.storage.transactionSync(() => {
      // Close any open tool call so the transcript stays well-formed for the next run.
      for (const call of danglingCalls(this.#transcript(run.session_id))) {
        this.#append(run.session_id, runId, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "the run was abandoned before this finished" }) });
      }
      // A task that never got past "dispatching" in this run will not be picked up by anything else.
      this.#sql.exec("UPDATE tasks SET status = 'failed', updated_at = ? WHERE status = 'dispatching' AND session_key = (SELECT session_key FROM sessions WHERE id = ?)", Date.now(), run.session_id);
      this.#notify(`abandoned:${runId}`, run.session_id, runId, "Something went wrong on my side and I could not finish handling that. Please try again.");
      this.#finish(runId, "failed", reason);
    });
    this.#log("run_abandoned", { run: runId, reason: reason.slice(0, 300) });
  }

  #finish(runId: string, status: "done" | "failed", error?: string): void {
    this.ctx.storage.transactionSync(() => {
      const run = this.#rows<RunRow>("SELECT * FROM runs WHERE id = ?", runId)[0];
      if (!run || run.status !== "running") return;
      const now = Date.now();
      this.#sql.exec("UPDATE inbox SET status = ? WHERE run_id = ? AND status = 'claimed'", status === "done" ? "done" : "dead", runId);
      this.#sql.exec("UPDATE runs SET status = ?, ended_at = ?, retry_at = NULL, error = ? WHERE id = ?", status, now, error?.slice(0, 1_000) ?? null, runId);
      this.#sql.exec("UPDATE sessions SET updated_at = ? WHERE id = ?", now, run.session_id);
      if (this.#meta("active_run") === runId) this.#sql.exec("DELETE FROM meta WHERE key = 'active_run'");
    });
  }

  #append(sessionId: string, runId: string, item: Item): void {
    this.#sql.exec(
      "INSERT INTO items (session_id, seq, run_id, is_user, item) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE session_id = ?), ?, ?, ?)",
      sessionId,
      sessionId,
      runId,
      item.role === "user" ? 1 : 0,
      JSON.stringify(item),
    );
  }

  /**
   * The items the model sees. The window always starts at a user turn: starting anywhere else would
   * hand the model a tool output without its call, or a reasoning item without its message. If the
   * most recent turns alone exceed the window, the window grows to hold the whole latest turn.
   */
  #transcript(sessionId: string): Item[] {
    const last = this.#rows<{ seq: number }>("SELECT MAX(seq) AS seq FROM items WHERE session_id = ?", sessionId)[0]?.seq;
    if (last == null) return [];
    const floor = Math.max(1, last - MAX_TRANSCRIPT_ITEMS + 1);
    const start =
      this.#rows<{ seq: number }>("SELECT MIN(seq) AS seq FROM items WHERE session_id = ? AND seq >= ? AND is_user = 1", sessionId, floor)[0]?.seq ??
      this.#rows<{ seq: number }>("SELECT MAX(seq) AS seq FROM items WHERE session_id = ? AND is_user = 1", sessionId)[0]?.seq ??
      floor;
    return this.#rows<{ item: string }>("SELECT item FROM items WHERE session_id = ? AND seq >= ? ORDER BY seq", sessionId, start).map((r) => JSON.parse(r.item) as Item);
  }

  #instructions(): string {
    return buildInstructions({
      scope: this.#scope(),
      now: Date.now(),
      instructions: this.#rows<Row>("SELECT content FROM memory WHERE path = 'instructions.md'")[0]?.content,
      index: this.#rows<Row>("SELECT content FROM memory WHERE path = 'index.md'")[0]?.content,
      tasks: this.#rows<Row>("SELECT id, title, status FROM tasks WHERE status IN ('dispatching', 'running', 'needs_input') ORDER BY created_at") as any,
    });
  }

  #tokensToday(): number {
    return Number(this.#meta(`tokens:${today()}`) ?? 0);
  }

  // ------------------------------------------------------------------ outbox

  #enqueueMessage(idem: string, sessionId: string, runId: string | null, text: string, ask?: ApprovalQuestion, review?: CodeReview): { ok: true } {
    const target = this.#rows<Row>("SELECT target FROM sessions WHERE id = ?", sessionId)[0]?.target ?? this.#meta("default_target");
    if (!target) throw new Error("there is nowhere to send a message in this conversation");
    const now = Date.now();
    this.#sql.exec(
      "INSERT OR IGNORE INTO outbox (idem, run_id, target, text, next_at, created_at, ask, review) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      idem,
      runId,
      target,
      text,
      now,
      now,
      ask ? JSON.stringify(ask) : null,
      review ? JSON.stringify(review) : null,
    );
    return { ok: true };
  }

  /** A message from the system rather than the model. Having nowhere to send it must never fail the caller. */
  #notify(idem: string, sessionId: string, runId: string | null, text: string): void {
    try {
      this.#enqueueMessage(idem, sessionId, runId, text);
    } catch {
      // Conversations started by automation (a CI run on a branch, say) can have no reply address.
    }
  }

  /** Delivers strictly in order: the oldest undelivered message goes first, even while it is backing off. */
  async #flushOutbox(): Promise<void> {
    try {
      for (;;) {
        const row = this.#rows<Row>("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0];
        if (!row) return;
        // A closed question leaves the ordered queue at once, whatever back-off it is in, so it
        // never holds up the messages behind it. If no attempt to send it was ever begun, nobody
        // has seen it and it is simply not sent. If one was begun, it may have reached people
        // although we never heard so: it is set aside to be found and shown as closed (below).
        if (row.ask && row.closed) {
          this.#sql.exec("UPDATE outbox SET status = ?, error = NULL WHERE id = ? AND status = 'pending'", row.started ? "reconciling" : "withdrawn", row.id);
          continue;
        }
        if (row.next_at > Date.now()) return;
        if (!(await this.#attempt(row, "pending"))) return;
      }
    } finally {
      await this.#reconcileClosed();
    }
  }

  /**
   * Closed questions whose delivery was begun but never confirmed. Each is sent again under its own
   * id, which the connector does not duplicate, to learn where it is, and is then shown as closed.
   * Outside the ordered queue: these hold nothing up, and one failing does not stop the others.
   */
  async #reconcileClosed(): Promise<void> {
    for (const row of this.#rows<Row>("SELECT * FROM outbox WHERE status = 'reconciling' AND next_at <= ? ORDER BY id LIMIT 20", Date.now())) await this.#attempt(row, "reconciling");
  }

  /** One attempt to deliver a row. Returns whether it was delivered. */
  async #attempt(row: Row, status: "pending" | "reconciling"): Promise<boolean> {
    // Recorded before anything is sent: if this instance dies between the send and the receipt,
    // the row still says that an attempt was begun.
    this.#sql.exec("UPDATE outbox SET started = 1 WHERE id = ?", row.id);
    try {
      // The time it was written goes along, so a retry looks for an earlier attempt in the same place every time.
      const receipt = await deliver(this.env, this.#scope(), JSON.parse(row.target) as Target, { id: row.id, idem: row.idem, text: row.text, created_at: row.created_at, ...(row.ask ? { ask: JSON.parse(row.ask) as ApprovalQuestion } : {}), ...(row.review ? { review: JSON.parse(row.review) as CodeReview } : {}) });
      // If an earlier attempt had in fact been posted, that is when people could first answer it.
      this.#sql.exec("UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL, receipt = ? WHERE id = ? AND status = ?", receipt?.posted_at ?? Date.now(), receipt ? JSON.stringify(receipt) : null, row.id, status);
      // It may have been closed while it was on its way.
      if (row.ask) this.#showClosed(row.idem);
      return true;
    } catch (err) {
      const attempts = row.attempts + 1;
      // The outside system may have said not to try again before a certain time. That time is
      // kept exactly: the message is not sent sooner. One too far off to wait for, in a queue
      // that delivers in order, ends here as undeliverable instead, and is not sent again.
      const notBefore = err instanceof DeliveryDeferred && Number.isFinite(err.notBefore) ? err.notBefore : 0;
      const tooFar = notBefore > Date.now() + MAX_DEFERRAL_MS;
      const dead = tooFar || attempts > OUTBOX_RETRY_DELAYS_MS.length;
      const nextAt = Math.max(Date.now() + (OUTBOX_RETRY_DELAYS_MS[attempts - 1] ?? 0), notBefore);
      const why = `${tooFar ? "asked to wait longer than a message is held for; " : ""}${String(err)}`.slice(0, 500);
      this.#sql.exec("UPDATE outbox SET status = ?, attempts = ?, next_at = ?, error = ? WHERE id = ?", dead ? "dead" : status, attempts, nextAt, why, row.id);
      if (dead) this.#log("message_undeliverable", { outbox_id: row.id, error: String(err).slice(0, 300) });
      return false;
    }
  }

  // ------------------------------------------------------------------ tools

  #toolHost(run: RunRow): ToolHost {
    const session = this.#rows<Row>("SELECT * FROM sessions WHERE id = ?", run.session_id)[0];
    const sql = this.#sql;
    return {
      sendMessage: (callId, text) => this.#enqueueMessage(`msg:${callId}`, run.session_id, run.id, text),
      sendReview: (callId, summary, commit, comments) => {
        // The same review in words, for wherever comments cannot be attached to lines.
        const said = [summary, ...comments.map((c) => `${c.path}:${c.line}\n${c.body}`)].join("\n\n");
        if (said.length > MAX_MESSAGE_TEXT) throw new Error(`the review is too long: summary and comments together must stay within ${MAX_MESSAGE_TEXT} characters`);
        return this.#enqueueMessage(`msg:${callId}`, run.session_id, run.id, said, undefined, { summary, ...(commit ? { commit } : {}), comments });
      },

      memoryList: () => ({ files: this.#rows("SELECT path, LENGTH(content) AS size, updated_at FROM memory ORDER BY path") }),
      memoryRead: (path) => {
        const row = this.#rows<Row>("SELECT content FROM memory WHERE path = ?", path)[0];
        if (!row) throw new Error(`no memory file at ${path}`);
        return { path, content: row.content };
      },
      memoryWrite: (path, content) => {
        if (!MEMORY_PATH.test(path) || path.includes("..")) throw new Error("path must look like notes/topic.md: lowercase letters, digits, - _ /");
        // instructions.md is read as instructions in every later run, so only a person who is a
        // member here may cause it to change. Text from a PR, a CI log or a worker cannot.
        if (path === "instructions.md") this.#audit(this.#instructionEditors(run.id).join(","), "instructions.changed", { length: content.length });
        const exists = this.#rows("SELECT 1 FROM memory WHERE path = ?", path).length > 0;
        if (!exists && this.#rows<{ n: number }>("SELECT COUNT(*) AS n FROM memory")[0].n >= MAX_MEMORY_FILES) throw new Error("memory is full; delete something first");
        sql.exec("INSERT INTO memory (path, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at", path, content, Date.now());
        return { ok: true, path };
      },
      memoryDelete: (path) => {
        if (path === "instructions.md") this.#audit(this.#instructionEditors(run.id).join(","), "instructions.deleted", {});
        const existed = this.#rows("SELECT 1 FROM memory WHERE path = ?", path).length > 0;
        sql.exec("DELETE FROM memory WHERE path = ?", path);
        return { ok: true, deleted: existed };
      },

      setTimer: (callId, delaySeconds, note, repeat) => {
        if (delaySeconds < 5 || delaySeconds > 366 * 86_400) throw new Error("delay_seconds must be between 5 and one year");
        if (repeat !== null && repeat < 60) throw new Error("repeat_every_seconds must be at least 60");
        const id = `tmr_${callId.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`;
        if (this.#rows("SELECT 1 FROM timers WHERE id = ?", id).length === 0 && this.#rows<{ n: number }>("SELECT COUNT(*) AS n FROM timers WHERE status = 'active'")[0].n >= MAX_ACTIVE_TIMERS) {
          throw new Error("too many active timers; cancel one first");
        }
        const due = Date.now() + delaySeconds * 1_000;
        sql.exec("INSERT OR IGNORE INTO timers (id, due_at, every_s, session_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, due, repeat, session.session_key, note, Date.now());
        return { ok: true, id, fires_at: new Date(due).toISOString() };
      },
      listTimers: () => ({
        timers: this.#rows<Row>("SELECT id, due_at, every_s, note FROM timers WHERE status = 'active' AND data IS NULL ORDER BY due_at").map((t) => ({
          id: t.id,
          fires_at: new Date(t.due_at).toISOString(),
          repeat_every_seconds: t.every_s,
          note: t.note,
        })),
      }),
      cancelTimer: (id) => {
        const active = this.#rows("SELECT 1 FROM timers WHERE id = ? AND status = 'active' AND data IS NULL", id).length > 0;
        if (active) sql.exec("UPDATE timers SET status = 'cancelled' WHERE id = ?", id);
        return { ok: true, cancelled: active };
      },

      dispatchTask: (callId, title, brief, repository) => this.#dispatchTask(run, session.session_key, callId, title, brief, repository),
      taskStatus: (taskId) => this.#taskStatus(taskId),
      answerTask: (callId, taskId, decision, reason) => this.#answerTask(run, session.session_key, callId, taskId, decision, reason),
      cancelTask: (taskId) => this.#cancelTask(session.session_key, taskId),
    };
  }

  // ------------------------------------------------------------------ tasks

  async #dispatchTask(run: RunRow, sessionKey: string, callId: string, title: string, brief: string, repository: string | null): Promise<unknown> {
    if (repository !== null && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/.test(repository)) throw new Error("repository must be an https://github.com/owner/name URL");
    const scope = this.#scope();
    // Credentials for a repository are lent only inside that repository's own scope, so that is the
    // only repository such a scope may send a worker to.
    if (scope.kind === "repo" && repository !== null && repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").toLowerCase() !== scope.id.toLowerCase()) {
      throw new Error(`in this repository's conversation a task can only work on ${scope.id}`);
    }

    // The row is written before anything is started. A retry of this tool call finds it by op_id
    // and continues with the same task id, so a lost response can never start a second task.
    let task = this.#rows<Row>("SELECT * FROM tasks WHERE op_id = ?", callId)[0];
    if (!task) {
      if (this.#rows<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('dispatching', 'running', 'needs_input')")[0].n >= MAX_ACTIVE_TASKS) {
        throw new Error(`there are already ${MAX_ACTIVE_TASKS} tasks running here; wait for one to finish or cancel one`);
      }
      const now = Date.now();
      // A task has a requester only when exactly one person asked. With several speakers in the
      // batch there is no telling whose request it was, so nobody is credited (and nobody can approve).
      const askers = [...new Set(this.#deciders(run.id).map((p) => p.id))];
      const requestedBy = askers.length === 1 ? askers[0] : null;
      const id = crypto.randomUUID();
      this.#sql.exec(
        "INSERT INTO tasks (id, op_id, worker, title, brief, session_key, requested_by, status, created_at, updated_at) VALUES (?, ?, 'sandbox', ?, ?, ?, ?, 'dispatching', ?, ?)",
        id,
        callId,
        title,
        brief,
        sessionKey,
        requestedBy,
        now,
        now,
      );
      this.#sql.exec(
        "INSERT INTO timers (id, due_at, session_key, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        `watch_${id}`,
        now + TASK_WATCHDOG_S * 1_000,
        sessionKey,
        `Task ${id} "${title}" has not reported a result in time.`,
        JSON.stringify({ task_id: id }),
        now,
      );
      this.#audit(requestedBy ?? "(automation)", "task.dispatched", { task_id: id, title, repository });
      task = this.#rows<Row>("SELECT * FROM tasks WHERE id = ?", id)[0];
    }
    if (task.status !== "dispatching") return { task_id: task.id, status: task.status };

    let slot: boolean;
    try {
      slot = await registry(this.env).acquireTaskSlot(scope.tenant, task.id);
    } catch (err) {
      // The reservation may have been made even though its reply was lost; give it back.
      await registry(this.env).releaseTaskSlot(task.id).catch(() => undefined);
      // The task must not be left "dispatching": nothing would ever pick it up again.
      this.#setTask(task.id, "failed", { result: JSON.stringify({ error: `the registry could not be reached: ${String(err).slice(0, 300)}` }) });
      throw new Error("the sandbox could not be started; try again");
    }
    if (!slot) {
      this.#setTask(task.id, "failed", { result: JSON.stringify({ error: "the tenant's sandbox limit is reached" }) });
      throw new Error("too many sandboxes are running for this tenant right now; try again later");
    }
    let started: { phase: string; error?: string };
    try {
      started = await this.env.TASKS.getByName(task.id).start({ id: task.id, prompt: brief, repository: repository ?? undefined, brain: this.#scopeName() });
    } catch (err) {
      // Whether the worker heard us is unknown. Stop it if it did, and free the slot either way, so
      // a start that failed in transit does not hold one of this scope's task slots for good.
      await this.env.TASKS.getByName(task.id).cancel().catch(() => undefined);
      this.#setTask(task.id, "failed", { result: JSON.stringify({ error: `the sandbox could not be reached: ${String(err).slice(0, 300)}` }) });
      await registry(this.env).releaseTaskSlot(task.id).catch(() => undefined);
      throw new Error("the sandbox could not be started; try again");
    }
    if (started.phase === "failed" || started.phase === "lost") {
      this.#setTask(task.id, "failed", { result: JSON.stringify({ error: started.error ?? "the sandbox did not start" }) });
      await registry(this.env).releaseTaskSlot(task.id);
      throw new Error(`the sandbox did not start: ${started.error ?? "unknown error"}`);
    }
    // Only move forward: the worker may already have reported while start() was returning.
    this.#sql.exec("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'dispatching'", Date.now(), task.id);
    return { task_id: task.id, status: "running" };
  }

  async #taskStatus(taskId: string): Promise<unknown> {
    const task = this.#rows<Row>("SELECT id, title, status, pending, last_progress, result, created_at, updated_at FROM tasks WHERE id = ?", taskId)[0];
    if (!task) throw new Error(`no task ${taskId} in this conversation's scope`);
    return {
      ...task,
      pending: task.pending ? JSON.parse(task.pending) : null,
      result: task.result ? JSON.parse(task.result) : null,
      created_at: new Date(task.created_at).toISOString(),
      updated_at: new Date(task.updated_at).toISOString(),
    };
  }

  /**
   * Passes a person's decision on to a waiting task.
   *
   * The model proposes; this code decides whether a person actually agreed. When a worker asks for
   * approval, the Brain itself sends the question to the conversation, with a short code made for
   * that one question (see taskEvent). An approval counts only if:
   *   - it is made in the conversation the task belongs to
   *   - the question was delivered there
   *   - a message in this run, sent after the question, contains that question's code
   *   - that message is from a member who explicitly addressed the agent
   *   - outside a private conversation, that member is the one person who requested the task
   * A refusal needs any member's message sent after the question; it does not need the code.
   *
   * The question being answered is recorded before the worker is called. If the call's outcome is
   * lost and this tool call is replayed, it answers that same question again, never a newer one.
   */
  async #answerTask(run: RunRow, sessionKey: string, callId: string, taskId: string, decision: "allow" | "deny", reason: string): Promise<unknown> {
    let task = this.#rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
    if (!task) throw new Error(`no task ${taskId} in this conversation's scope`);
    if (task.session_key !== sessionKey) throw new Error("that task belongs to a different conversation and has to be answered there");

    type Intent = { call_id: string; pending_id: string; decision: "allow" | "deny"; reason: string; decided_by: string; deciding_event: number; ask?: string; standing?: boolean; before?: { decision: "allow" | "deny"; decided_by: string } };
    let intent = task.answering ? (JSON.parse(task.answering) as Intent) : undefined;
    // An approval is about to be acted on: look again at where the replies it could rest on were
    // read from. From here to the worker call nothing else can interleave.
    // The question whose posted text was confirmed unchanged, if it was posted somewhere editable.
    let confirmedAsk: string | undefined;
    if (decision === "allow") {
      // Everything in this conversation that could bear on it, handled or still waiting.
      const candidates = this.#rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND received_at > ?", sessionKey, task.created_at ?? 0);
      await this.#refreshStanding(candidates);
      // The question itself is a comment others may be able to edit. People approve what they
      // read, so it has to still say what the agent wrote.
      const ask = task.pending ? (JSON.parse(task.pending) as { ask?: string }).ask : undefined;
      const shown = ask ? this.#rows<{ target: string; receipt: string | null; status: string }>("SELECT target, receipt, status FROM outbox WHERE idem = ?", ask)[0] : undefined;
      const where = shown ? (JSON.parse(shown.target) as Target).connector : "";
      const receipt = shown?.receipt;
      // Posted somewhere others can change it, with nothing to say which posted message it is:
      // there is then no way to know that what people read is what the agent wrote.
      if (shown?.status === "sent" && !receipt && canRevisit(where)) {
        throw new Error("the question was posted where it can be changed and cannot be identified there, so nobody can be taken to have approved this action; it can only be refused");
      }
      if (ask && receipt) {
        const posted = JSON.parse(receipt) as { subject: string; holder: string };
        // Asked of the system the question was posted in. One where nobody else can change the
        // agent's messages has nothing to say here.
        const now = await standingOf(this.env, where, this.#scope(), posted.subject);
        // A system where the question can be changed has to recognise the question it was shown in.
        if (!now && canRevisit(where)) throw new Error("the question as it was posted cannot be found where it was shown, so nobody can be taken to have approved this action; it can only be refused");
        // Edited at any time, even if put back since: someone may have read and answered the other wording.
        const touched = this.#rows("SELECT 1 FROM revisions WHERE subject = ?", posted.subject).length > 0;
        if (touched || (now && (now.deleted || now.edited || now.holder !== posted.holder))) {
          throw new Error("the question as it was posted has since been changed or removed, so nobody can be taken to have approved this action; it can only be refused");
        }
        confirmedAsk = ask;
      }
      // Other events may have arrived while GitHub was being asked; read the task again.
      task = this.#rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
      intent = task.answering ? (JSON.parse(task.answering) as Intent) : undefined;
    }
    // An answer already given to this question that may have reached the worker.
    let before: Intent["before"];
    // A question gets one decision. If one is already on record for the question still shown as
    // pending (its delivery to the worker was not confirmed), this call delivers that same decision
    // again; it does not get to make a new one.
    const open = task.status === "needs_input" && task.pending ? (JSON.parse(task.pending) as { id: string }).id : undefined;
    if (intent && intent.pending_id !== open && intent.call_id !== callId) intent = undefined;
    // An approval on record but not yet confirmed by the worker does not outrank a change of mind:
    // a refusal proposed now is judged afresh, and an approval is only re-sent if nothing that has
    // arrived since speaks against it.
    if (intent?.decision === "allow" && intent.pending_id === open) {
      const approver = this.#rows<InboxRow>("SELECT * FROM inbox WHERE id = ?", intent.deciding_event)[0];
      const onRecord = JSON.parse(task.pending) as { code: string; ask?: string };
      const code = onRecord.code;
      // Everything else members have said in this conversation since the task began, whenever it
      // arrived: a later word from the approver, or anything about this question that is not an approval.
      const later = this.#reconcile(
        this.#rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND received_at > ? AND id != ?", sessionKey, task.created_at ?? 0, intent.deciding_event).filter((event) => this.#isDecider(JSON.parse(event.principal) as Principal, event.source)),
      );
      const against =
        later.unresolved ||
        later.events.some(
          (event) =>
            // The same test as for a fresh decision: anything about this question, by its code or
            // by being tied to it, that is not an approval.
            (isAbout(event, onRecord.ask) && (isTiedTo(event, onRecord.ask) || quotes(event.text ?? "", code)) && saysAbout(event, onRecord) !== "allow") ||
            ((JSON.parse(event.principal) as Principal).id === intent!.decided_by && approver !== undefined && saidAt(event) >= saidAt(approver)),
        ) ||
        // And anything the approver has said since in the place the approval was typed, if it was moved here.
        (approver !== undefined && this.#saidSinceWhereTyped(approver, task.created_at ?? 0));
      if (decision === "deny" || against || !approver || !this.#stillStands(approver)) {
        before = { decision: intent.decision, decided_by: intent.decided_by };
        intent = undefined;
      }
    }
    if (!intent) {
      if (task.status !== "needs_input" || !task.pending) throw new Error(`task ${taskId} is ${task.status}; it is not waiting for an answer`);
      const pending = JSON.parse(task.pending) as { id: string; code: string; asked_at: number; ask?: string; truncated?: boolean };
      // "Asked" means the message actually went out, not merely that it was queued.
      const asked = pending.ask ? this.#rows<Row>("SELECT status, sent_at, receipt FROM outbox WHERE idem = ?", pending.ask)[0] : undefined;
      if (asked?.status !== "sent") throw new Error("the question has not been delivered to anyone in this conversation yet, so it cannot be answered");
      // A question posted where it can be edited has to be the one just confirmed unchanged.
      if (decision === "allow" && asked.receipt && pending.ask !== confirmedAsk) throw new Error("the question changed while it was being checked; call this tool again");

      // Messages from members, sent after the question was put to them.
      // A reply whose comment was edited is represented by the edit, which is a message of its own.
      // Not only this run's: a "wait" that was handled in an earlier run still counts against an
      // older approval that arrives after it.
      const received = this.#reconcile(this.#rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND status != 'pending' AND received_at > ? ORDER BY id", sessionKey, asked.sent_at));
      const replies = received.events
        .map((event) => ({ event, principal: JSON.parse(event.principal) as Principal }))
        .filter(({ event, principal }) => this.#isDecider(principal, event.source));
      if (replies.length === 0) throw new Error("nobody here has answered the question yet; wait for a reply");

      // What each reply says about this question, read from its own words. The model proposes a
      // decision; it only goes through if a person's message actually says it.
      // A button press is about the question whose card it was on, and about no other.
      const about = (event: InboxRow) => isAbout(event, pending.ask);
      // One that is tied to this very question (a press on its card, a reply to its message) need
      // not repeat the code: "可以" under the question is an answer to it.
      const tied = (event: InboxRow) => isTiedTo(event, pending.ask);
      const says = (event: InboxRow) => saysAbout(event, pending);
      const read = replies.map((reply) => ({ ...reply, says: says(reply.event) }));
      const shared = this.#scope().kind !== "user";
      let deciding: (typeof read)[number];
      if (decision === "deny") {
        // A refusal has to be said too: "deny <code>". An unrelated message is not one.
        const refusals = read.filter(({ says }) => says === "deny");
        if (refusals.length === 0) throw new Error(`no reply so far refuses this. A refusal is a message that says "deny ${pending.code}". Call this tool again whenever a new reply arrives`);
        deciding = refusals.at(-1)!;
      } else {
        if (pending.truncated) throw new Error("the action is too long to be shown in full, so it cannot be approved; it can only be refused");
        // A refusal from any member wins over an approval, whichever came first. That includes one
        // that arrived after this run started and is still waiting in the inbox.
        const queued = this.#reconcile(
          this.#rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' AND session_key = ? AND received_at > ?", sessionKey, asked.sent_at).filter((event) => this.#isDecider(JSON.parse(event.principal) as Principal, event.source)),
        );
        const waiting = queued.events.some((event) => about(event) && (tied(event) || quotes(event.text ?? "", pending.code)) && says(event) !== "allow");
        if (waiting || read.some(({ says }) => says === "deny")) throw new Error("a reply refuses this; pass on a denial, not an approval");
        // The same goes for a waiting reply that has been edited into something not yet seen.
        if (queued.unresolved) throw new Error("a reply here was edited and its new text has not arrived yet; call this tool again when it has");
        // A reply that was edited since, whose new text has not arrived yet, may now be a refusal.
        if (received.unresolved) throw new Error("a reply here was edited and its new text has not arrived yet; call this tool again when it has");
        let approvals = read.filter(({ says }) => says === "allow");
        if (approvals.length === 0) throw new Error(`no reply so far is an approval. An approval is a message whose only words are "approve ${pending.code}" (mentioning you in front of it is fine; anything after it, or any other wording, is not). Tell them that, and call this tool again whenever a new reply arrives`);
        // One message approves one question.
        const used = new Set(this.#rows<{ event: number | null }>("SELECT json_extract(answering, '$.deciding_event') AS event FROM tasks WHERE answering IS NOT NULL").map((r) => r.event));
        approvals = approvals.filter(({ event }) => !used.has(event.id));
        if (approvals.length === 0) throw new Error("that reply was already used to approve another question");
        if (shared) {
          if (!task.requested_by) throw new Error("this task was not started by a person, so nobody can approve this; it can only be refused");
          approvals = approvals.filter(({ principal }) => principal.id === task.requested_by);
          if (approvals.length === 0) throw new Error(`only ${task.requested_by}, who requested this task, can approve it`);
        }
        // "Last" is by when a thing was said, where the source tells us: deliveries can arrive out
        // of order, and a "wait" sent after the approval may get here before it.
        const bySaid = (a: (typeof read)[number], b: (typeof read)[number]) => saidAt(a.event) - saidAt(b.event) || a.event.id - b.event.id;
        deciding = [...approvals].sort(bySaid).at(-1)!;
        // The approval has to be that person's last word. If they said anything after it, they may
        // have been taking it back, and there is no reading that safely.
        const theirs = read.filter(({ principal }) => principal.id === deciding.principal.id).sort(bySaid);
        const lastWord = theirs.at(-1)!;
        // Said in the same instant as far as the source can tell: which came last is anyone's guess.
        // (Only where the time is the source's, which may be coarse. Arrival times order themselves.)
        if (theirs.some(({ event }) => event.id !== deciding.event.id && fromSource(event) && fromSource(deciding.event) && saidAt(event) === saidAt(deciding.event))) {
          throw new Error(`${deciding.principal.id} said something else at the same moment as approving; ask them to confirm by sending just "approve ${pending.code}" again`);
        }
        // Including anything of theirs that arrived after this run started and is still in the inbox.
        // And, for an approval that was typed elsewhere in the chat and brought here, anything
        // they have said since in the place they typed it.
        const saidMore =
          this.#saidSinceWhereTyped(deciding.event, asked.sent_at) ||
          this.#reconcile(this.#rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' AND session_key = ? AND id > ?", sessionKey, deciding.event.id)).events.some(
            (event) => (JSON.parse(event.principal) as Principal).id === deciding.principal.id,
          );
        // And it has to be what they still say: not a comment since edited or deleted.
        if (!this.#stillStands(deciding.event)) throw new Error("that reply has since been edited or deleted; it no longer approves anything");
        if (lastWord.event.id !== deciding.event.id || saidMore) throw new Error(`${deciding.principal.id} said something after approving; ask them to confirm by sending just "approve ${pending.code}" again`);
      }
      // "For the rest of this task" is the approver's to say, in their own message; it is offered
      // only for pushes.
      // only for pushes that update branches, which is also the only kind it is offered for.
      const asksAbout = pending as { source?: string; refs?: RefUpdate[] };
      const standing = decision === "allow" && asksAbout.source === "proxy" && standingEligible(Array.isArray(asksAbout.refs) ? asksAbout.refs : []) && wantsStanding(deciding.event.text ?? "");
      intent = { call_id: callId, pending_id: pending.id, decision, reason, decided_by: deciding.principal.id, deciding_event: deciding.event.id, ...(pending.ask ? { ask: pending.ask } : {}), ...(standing ? { standing } : {}), ...(before ? { before } : {}) };
      this.#sql.exec("UPDATE tasks SET answering = ? WHERE id = ?", JSON.stringify(intent), taskId);
      // Recorded with the question as it was put and the message that answered it.
      this.#audit(intent.decided_by, `task.${decision === "allow" ? "approved" : "denied"}`, { task_id: taskId, question: pending, reason, deciding_event: deciding.event.id, ...(standing ? { standing: true } : {}) });
    }

    const answered = await this.env.TASKS.getByName(taskId).answer(intent.decision, intent.reason, intent.pending_id, intent.standing === true);
    if (!answered.ok) throw new Error(answered.error);
    // The worker may already have acted on an earlier answer to this question; report what it holds.
    const decided = answered.decision ?? intent.decision;
    // Only clear the question that was answered; a newer one may have arrived meanwhile.
    this.#sql.exec(
      "UPDATE tasks SET status = 'running', pending = NULL, updated_at = ? WHERE id = ? AND status = 'needs_input' AND json_extract(pending, '$.id') = ?",
      Date.now(),
      taskId,
      intent.pending_id,
    );
    const askedAs = task.pending ? (JSON.parse(task.pending) as { id?: string; ask?: string }) : {};
    // Whether the approval reaches the rest of the task is what the worker recorded, not what was
    // asked for just now: the decision in force may be an earlier one. A worker record that does
    // not say is not taken to say no.
    const forTheTask = decided === "allow" ? answered.standing : false;
    // The question that was answered, which need not be the one open now: a newer question may
    // have taken its place while the answer was on its way.
    const answeredAsk = intent.ask ?? (askedAs.id === intent.pending_id ? askedAs.ask : undefined);
    this.#closeQuestion(answeredAsk, { state: decided === "allow" ? "approved" : "refused", ...(forTheTask === undefined ? {} : { standing: forTheTask }) });
    // Said whichever answer is in force, so that it can be told to the people here.
    const reach = forTheTask ? { standing: "later pushes of the same branches in this task will not ask again" } : {};
    if (decided === intent.decision) return { ok: true, task_id: taskId, decision: decided, decided_by: intent.decided_by, ...reach };
    // The decision in force is the earlier one, and so is the person it is attributed to.
    const earlier = intent.before?.decision === decided ? intent.before.decided_by : undefined;
    this.#audit(intent.decided_by, "task.answer_too_late", { task_id: taskId, question: intent.pending_id, wanted: intent.decision, in_force: decided, in_force_by: earlier ?? null });
    return { ok: true, task_id: taskId, decision: decided, ...(earlier ? { decided_by: earlier } : {}), ...reach, note: `the worker had already been told to ${decided}; ${intent.decided_by}'s "${intent.decision}" came too late to change that` };
  }

  async #cancelTask(sessionKey: string, taskId: string): Promise<unknown> {
    const task = this.#rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
    if (!task) throw new Error(`no task ${taskId} in this conversation's scope`);
    if (task.session_key !== sessionKey) throw new Error("that task belongs to a different conversation and has to be cancelled there");
    if (TERMINAL_TASK.has(task.status)) return { ok: true, task_id: taskId, status: task.status };
    await this.env.TASKS.getByName(taskId).cancel();
    // A question still open when the task is cancelled has nothing left to answer.
    const open = this.#rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
    if (this.#setTask(taskId, "cancelled", {}) && open) this.#setAside(open);
    this.#audit("(agent)", "task.cancelled", { task_id: taskId });
    await registry(this.env).releaseTaskSlot(taskId);
    return { ok: true, task_id: taskId, status: "cancelled" };
  }

  /** A terminal status is final: a late or repeated report cannot bring a task back. */
  #setTask(taskId: string, status: string, fields: { pending?: string | null; result?: string; last_progress?: string }): boolean {
    const current = this.#rows<Row>("SELECT status FROM tasks WHERE id = ?", taskId)[0];
    if (!current || TERMINAL_TASK.has(current.status)) return false;
    this.#sql.exec(
      "UPDATE tasks SET status = ?, pending = ?, result = COALESCE(?, result), last_progress = COALESCE(?, last_progress), updated_at = ? WHERE id = ?",
      status,
      fields.pending ?? null,
      fields.result ?? null,
      fields.last_progress ?? null,
      Date.now(),
      taskId,
    );
    // The watchdog has nothing left to watch.
    if (TERMINAL_TASK.has(status)) this.#sql.exec("UPDATE timers SET status = 'done' WHERE id = ? AND status = 'active'", `watch_${taskId}`);
    return true;
  }

  /**
   * Called by a worker to report. Reports are numbered by the worker; a repeat is ignored. Progress
   * only updates the task record. Anything the Brain has to react to also becomes an inbox event.
   */
  async taskEvent(taskId: string, seq: number, kind: WorkerEventKind, report: Record<string, unknown>): Promise<{ ok: boolean }> {
    let body = report;
    const outcome: { known: boolean; wake: boolean; terminal: boolean; spent?: number } = this.ctx.storage.transactionSync(() => {
      const task = this.#rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
      if (!task) return { known: false, wake: false, terminal: false };
      // A repeat means the worker never saw our acknowledgement. The work after the commit (waking
      // up, releasing the slot) may not have happened either, so it is done again; both are idempotent.
      if (this.#rows("SELECT 1 FROM task_events WHERE task_id = ? AND seq = ?", taskId, seq).length > 0) return { known: true, wake: true, terminal: TERMINAL_TASK.has(task.status) };
      this.#sql.exec("INSERT INTO task_events (task_id, seq, kind, body, at) VALUES (?, ?, ?, ?, ?)", taskId, seq, kind, JSON.stringify(body), Date.now());

      const text = typeof body.message === "string" ? body.message : typeof body.text === "string" ? body.text : "";
      let applied = true;
      if (kind === "progress") {
        if (!TERMINAL_TASK.has(task.status)) this.#sql.exec("UPDATE tasks SET last_progress = ?, updated_at = ? WHERE id = ?", text.slice(0, 500), Date.now(), taskId);
        return { known: true, wake: false, terminal: false };
      }
      if (kind === "recovered") return { known: true, wake: false, terminal: false };
      if (kind === "withdrawn") {
        // The held request gave up; its question no longer stands.
        if (task.status === "needs_input" && task.pending && JSON.parse(task.pending).id === body.id) {
          this.#sql.exec("UPDATE tasks SET status = 'running', pending = NULL, updated_at = ? WHERE id = ?", Date.now(), taskId);
          this.#closeQuestion((JSON.parse(task.pending) as { ask?: string }).ask, { state: "withdrawn" });
        }
        return { known: true, wake: false, terminal: false };
      }
      if (kind === "needs_input") {
        // A question from a task that has already ended asks nothing: it is recorded above and goes
        // no further. Checked before a code is drawn or anything is queued, so no card is sent that
        // nobody can answer.
        if (TERMINAL_TASK.has(task.status)) return { known: true, wake: false, terminal: false };
        // A new question replaces the one before it, which can no longer be answered.
        this.#setAside(task);
        // The question is put to people by this code, not by the model: what they are shown is
        // exactly what the worker is held on, and the code ties their reply to this one question.
        // No two open questions in this scope share a code, so one reply cannot answer two of them.
        // Nor is a code ever given twice here: an old question's code, still on someone's screen,
        // must not come to mean a new question.
        let code = questionCode();
        while (this.#rows("SELECT 1 FROM used_codes WHERE code = ?", code).length > 0) code = questionCode();
        this.#sql.exec("INSERT INTO used_codes (code, used_at) VALUES (?, ?)", code, Date.now());
        const what = describeRequest(body);
        const session = this.#rows<Row>("SELECT id FROM sessions WHERE session_key = ?", task.session_key)[0];
        const truncated = body.truncated === true;
        let ask: string | undefined = `ask:${taskId}:${seq}`;
        try {
          if (!session) throw new Error("no conversation");
          const how = truncated ? `This is too long to show in full, so it cannot be approved.\nTo refuse, reply: deny ${code}` : `To approve, reply: approve ${code}\nTo refuse, reply: deny ${code}`;
          const question: ApprovalQuestion = {
            id: ask,
            code,
            title: String(task.title),
            kind: body.source === "proxy" ? "push" : "command",
            detail: body.source === "proxy" ? String(body.summary ?? `${body.action} on ${body.resource}`) : String(body.command ?? ""),
            can_approve: !truncated,
            ...(body.source === "proxy"
              ? { resource: String(body.resource ?? ""), refs: Array.isArray(body.refs) ? (body.refs as ApprovalQuestion["refs"]) : [], standing_offered: !truncated && standingEligible(Array.isArray(body.refs) ? (body.refs as RefUpdate[]) : []) }
              : {}),
          };
          this.#enqueueMessage(ask, session.id, null, `Task "${task.title}" is paused and needs approval to ${what}\n\n${how}`, question);
        } catch {
          // No reply address: the question reaches nobody, so it cannot be approved.
          ask = undefined;
        }
        body = { ...body, code, asked_at: Date.now(), ask, delivered: ask !== undefined, what };
        applied = this.#setTask(taskId, "needs_input", { pending: JSON.stringify(body) });
      }
      else if (kind === "result" || kind === "failed" || kind === "lost") {
        // A task that ends while a question of its is still open leaves nothing to answer: the
        // question is closed where it is shown, so nobody presses a button that does nothing.
        applied = kind === "result" ? this.#setTask(taskId, "succeeded", { result: JSON.stringify(body) }) : this.#setTask(taskId, kind, { result: JSON.stringify(body) });
        if (applied) this.#setAside(task);
      }
      else return { known: true, wake: false, terminal: false };
      if (!applied) return { known: true, wake: false, terminal: false };

      // What the worker spent counts against the same daily budget as the Brain's own calls.
      const spent = Number((body.usage as { total_tokens?: unknown } | undefined)?.total_tokens ?? 0);
      if (Number.isFinite(spent) && spent > 0) this.#setMeta(`tokens:${today()}`, String(this.#tokensToday() + Math.min(spent, 50_000_000)));
      if (kind === "lost" || kind === "failed") this.#log(`task_${kind}`, { task: taskId, error: String(body.error ?? "").slice(0, 300) });

      this.#insertEvent({
        source: "worker",
        source_id: `${taskId}:${seq}`,
        kind: `worker.${kind}`,
        session_key: task.session_key,
        principal: { kind: "worker", id: taskId, explicit: false },
        text: renderWorkerEvent(task, kind, body),
        data: { task_id: taskId, ...body },
      });
      return { known: true, wake: true, terminal: kind !== "needs_input", spent };
    });
    if (outcome.spent) await registry(this.env).recordUsage(this.#scope().tenant, outcome.spent).catch(() => undefined);
    if (outcome.terminal) await registry(this.env).releaseTaskSlot(taskId);
    if (outcome.wake) await this.#wakeBy(Date.now() + 300);
    return { ok: outcome.known };
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
    const replyOnly = this.#rows<{ data: string | null }>("SELECT data FROM inbox WHERE run_id = ?", runId).some((row) => row.data && JSON.parse(row.data).reply_only === true);
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
    return this.#rows<{ principal: string; source: string }>("SELECT principal, source FROM inbox WHERE run_id = ? ORDER BY id", runId).map((r) => ({ principal: JSON.parse(r.principal) as Principal, source: r.source }));
  }

  // ------------------------------------------------------------------ reads for connectors and admins

  /**
   * Whether this text quotes the code of an approval question that is open in this conversation.
   * The whole text is searched, so a reply cannot be missed for being long.
   */
  async quotesOpenQuestion(text: string, sessionKey: string): Promise<boolean> {
    const codes = this.#rows<{ code: string | null }>(
      "SELECT json_extract(pending, '$.code') AS code FROM tasks WHERE status = 'needs_input' AND pending IS NOT NULL AND session_key = ?",
      sessionKey,
    );
    return codes.some(({ code }) => code && new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "i").test(text));
  }

  /**
   * Records that something a person wrote (a comment, say) now stands at this revision, or is gone.
   * A message read from any other revision can no longer decide anything. `holder` identifies the
   * text of the revision. Revisions only move forward, so events delivered out of order end in the
   * same state; two different texts claiming the same revision leave nobody holding it.
   */
  async revise(subject: string, revision: number, deleted: boolean, holder = ""): Promise<void> {
    this.#revise(subject, revision, deleted, holder);
  }

  #revise(subject: string, revision: number, deleted: boolean, holder: string): void {
    const current = this.#rows<{ revision: number; deleted: number; holder: string }>("SELECT revision, deleted, holder FROM revisions WHERE subject = ?", subject)[0];
    if (!current) {
      this.#sql.exec("INSERT INTO revisions (subject, revision, deleted, holder) VALUES (?, ?, ?, ?)", subject, revision, deleted ? 1 : 0, holder);
      return;
    }
    if (deleted) this.#sql.exec("UPDATE revisions SET deleted = 1 WHERE subject = ?", subject);
    else if (revision > current.revision) this.#sql.exec("UPDATE revisions SET revision = ?, holder = ? WHERE subject = ?", revision, holder, subject);
    // Told twice about one revision with different texts: nobody holds it. Except that a revision
    // known not to be for the agent stays so, whatever its text is.
    // known not to be for the agent is so whatever its text, whichever of the two was heard first.
    else if (revision === current.revision && holder === NOT_FOR_THE_AGENT) this.#sql.exec("UPDATE revisions SET holder = ? WHERE subject = ?", NOT_FOR_THE_AGENT, subject);
    else if (revision === current.revision && holder !== current.holder && current.holder !== NOT_FOR_THE_AGENT) this.#sql.exec("UPDATE revisions SET holder = '' WHERE subject = ?", subject);
  }

  /** False if the thing this event was read from has since been edited or deleted. */
  #stillStands(event: InboxRow): boolean {
    return this.#standing(event) === "stands";
  }

  /** Whether what this event was read from still says the same, says something else now, or is gone. */
  #standing(event: InboxRow): "stands" | "changed" | "deleted" | "withdrawn" {
    const data = event.data ? (JSON.parse(event.data) as { subject?: string; revision?: number; holder?: string }) : {};
    if (!data.subject) return "stands";
    const current = this.#rows<{ revision: number; deleted: number; holder: string }>("SELECT revision, deleted, holder FROM revisions WHERE subject = ?", data.subject)[0];
    if (current?.deleted) return "deleted";
    if (current && current.holder === NOT_FOR_THE_AGENT && current.revision > (data.revision ?? 0)) return "withdrawn";
    return current && current.revision === data.revision && current.holder !== "" && current.holder === data.holder ? "stands" : "changed";
  }

  /**
   * Whether the author of a reply that was moved to its question's conversation has said anything
   * since in the conversation where they typed it.
   */
  #saidSinceWhereTyped(reply: InboxRow, since: number): boolean {
    const origin = (JSON.parse(reply.data ?? "{}") as { routed_from?: string }).routed_from;
    if (!origin) return false;
    const author = (JSON.parse(reply.principal) as Principal).id;
    const later = this.#rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND received_at > ? AND id != ?", origin, since, reply.id).filter(
      (event) => (JSON.parse(event.principal) as Principal).id === author && (saidAt(event) > saidAt(reply) || (saidAt(event) === saidAt(reply) && event.id > reply.id)),
    );
    return this.#reconcile(later).events.length > 0;
  }

  /**
   * Called when a question stops being the one its task is waiting on without an answer to it
   * having been confirmed: a newer question took its place, or the task ended or was cancelled.
   *
   * If no answer was ever sent for it, nothing was decided and it is closed as withdrawn. If one
   * was sent, the worker may hold a decision the Brain never heard back about; how the question
   * ended is then not guessed but asked of the worker (see #settleQuestions).
   */
  #setAside(task: Row): void {
    if (task.status !== "needs_input" || !task.pending) return;
    const pending = JSON.parse(task.pending) as { id?: string; ask?: string };
    if (!pending.ask) return;
    const sent = task.answering ? (JSON.parse(task.answering) as { pending_id?: string }).pending_id === pending.id : false;
    if (!sent || !pending.id) return this.#closeQuestion(pending.ask, { state: "withdrawn" });
    this.#sql.exec("INSERT OR IGNORE INTO unsettled (ask, task_id, question_id, next_at) VALUES (?, ?, ?, ?)", pending.ask, task.id, pending.id, Date.now());
  }

  /**
   * Finds out from the worker how each set-aside question ended, and closes it as that. The
   * worker's record of a decision is the truth: it is what the guest was told. If the worker
   * cannot be reached, or still has the question open, it is asked again later.
   */
  async #settleQuestions(): Promise<void> {
    for (const row of this.#rows<{ ask: string; task_id: string; question_id: string; attempts: number }>("SELECT * FROM unsettled WHERE next_at <= ? ORDER BY next_at LIMIT 20", Date.now())) {
      let fate: QuestionFate | { state: "unreachable"; error: string };
      try {
        fate = await this.env.TASKS.getByName(row.task_id).decisionOn(row.question_id);
      } catch (err) {
        fate = { state: "unreachable", error: String(err).slice(0, 300) };
      }
      if (fate.state === "decided") {
        const standing = fate.decision === "allow" ? fate.standing : false;
        this.#closeQuestion(row.ask, { state: fate.decision === "allow" ? "approved" : "refused", ...(standing === undefined ? {} : { standing }) });
      } else if (fate.state === "undecided") {
        // The worker's records are whole and hold no answer: the one that was sent never took effect.
        this.#closeQuestion(row.ask, { state: "withdrawn" });
      } else if (fate.state === "unknown" || row.attempts + 1 >= SETTLE_ATTEMPTS) {
        // Not to be found out any more. The question is closed as exactly that, never as a guess.
        this.#log("question_unsettled", { task: row.task_id, question: row.question_id, why: fate.state, ...("error" in fate ? { error: fate.error } : {}) });
        this.#audit("(system)", "task.answer_unverified", { task_id: row.task_id, question: row.question_id, why: fate.state });
        this.#closeQuestion(row.ask, { state: "unknown" });
      } else {
        // Still being waited on, or the worker could not be asked: look again later.
        this.#sql.exec("UPDATE unsettled SET attempts = attempts + 1, next_at = ? WHERE ask = ?", Date.now() + Math.min(30_000 * 2 ** row.attempts, 3_600_000), row.ask);
      }
    }
  }

  /**
   * Records that a question is closed and shows it where the question was put. The outcome is kept
   * with the question, so it also holds if the question has not been delivered yet: an unsent one
   * is then not sent at all, and one whose delivery is under way is closed as soon as it lands.
   */
  #closeQuestion(ask: string | undefined, outcome: Outcome): void {
    if (!ask) return;
    // A question ends once: this record is written once and never replaced. Showing it where the
    // question was put can be repeated or fail, but always shows this one ending.
    this.#sql.exec("UPDATE outbox SET closed = ? WHERE idem = ? AND ask IS NOT NULL AND closed IS NULL", JSON.stringify(outcome), ask);
    this.#sql.exec("DELETE FROM unsettled WHERE ask = ?", ask);
    this.#showClosed(ask);
  }

  /** Replaces a delivered question by its closed form. Never holds anything up. */
  #showClosed(ask: string): void {
    const row = this.#rows<{ target: string; receipt: string | null; ask: string | null; closed: string | null }>("SELECT target, receipt, ask, closed FROM outbox WHERE idem = ?", ask)[0];
    if (!row?.receipt || !row.ask || !row.closed) return;
    this.ctx.waitUntil(
      amend(this.env, JSON.parse(row.target) as Target, JSON.parse(row.receipt) as Receipt, JSON.parse(row.ask) as ApprovalQuestion, JSON.parse(row.closed) as Outcome).catch((err) =>
        this.#log("question_not_closed", { ask, error: String(err).slice(0, 300) }),
      ),
    );
  }

  /**
   * Brings a set of messages up to date with what their sources say now. A message whose comment
   * was edited is dropped when the edit has arrived as a message of its own; if the edit is known
   * of but has not arrived, the set is unresolved and nothing should be approved on it.
   */
  #reconcile(events: InboxRow[]): { events: InboxRow[]; unresolved: boolean } {
    let unresolved = false;
    const current = events.filter((event) => {
      const standing = this.#standing(event);
      // A deleted comment says nothing any more, for or against. Nor does one edited into
      // something that is not for the agent: no new message will come to replace it.
      if (standing === "deleted" || standing === "withdrawn") return false;
      if (standing !== "changed") return true;
      const subject = (JSON.parse(event.data ?? "{}") as { subject?: string }).subject;
      // Whichever of them arrived first: the message that carries the subject's current text.
      const replaced = this.#rows<InboxRow>("SELECT * FROM inbox WHERE id != ? AND json_extract(data, '$.subject') = ?", event.id, subject ?? "").some((other) => this.#standing(other) === "stands");
      if (!replaced) unresolved = true;
      return !replaced;
    });
    return { events: current, unresolved };
  }

  /**
   * Looks again at the source of every revisable message that could decide this question. The news
   * that a comment was edited or deleted can still be on its way when the approval is acted on.
   */
  async #refreshStanding(events: InboxRow[]): Promise<void> {
    const subjects = new Map<string, string>();
    const deciding = new Set<string>();
    for (const event of events) {
      const subject = event.data ? (JSON.parse(event.data) as { subject?: string }).subject : undefined;
      if (!subject) continue;
      subjects.set(subject, event.source);
      if (this.#isDecider(JSON.parse(event.principal) as Principal, event.source)) deciding.add(subject);
    }
    for (const [subject, source] of subjects) {
      // A message that can change, from a connector that cannot say what it says now, cannot be
      // relied on for an approval.
      // Only where it could decide something: a notification nobody's approval rests on is left alone.
      if (!canRevisit(source)) {
        if (!deciding.has(subject)) continue;
        throw new Error(`a reply here came through "${source}", which cannot confirm what the reply says now, so nothing can be approved on it`);
      }
      const standing = await standingOf(this.env, source, this.#scope(), subject);
      // Its own connector does not know the message. What it says now is then not known either.
      if (!standing && deciding.has(subject)) throw new Error(`"${source}" does not recognise a reply here as one of its messages, so what the reply says now cannot be confirmed and nothing can be approved on it`);
      if (standing) this.#revise(subject, standing.revision, standing.deleted, standing.holder);
    }
  }

  /** Records where this scope's messages go when an event does not say. Set by the first connector to reach it. */
  async setDefaultTarget(target: Target): Promise<void> {
    if (!this.#meta("default_target")) this.#setMeta("default_target", JSON.stringify(target));
  }

  /** Messages written since `afterId`, for connectors whose clients pull instead of being pushed to. */
  async outboxSince(afterId: number, limit = 50): Promise<{ id: number; text: string; status: string; created_at: number }[]> {
    // A question withdrawn before it went out was never said to anyone, on any channel.
    return this.#rows("SELECT id, text, status, created_at FROM outbox WHERE id > ? AND status NOT IN ('withdrawn', 'reconciling') AND NOT (status = 'pending' AND ask IS NOT NULL AND closed IS NOT NULL) ORDER BY id LIMIT ?", afterId, Math.min(limit, 200));
  }

  async inspect(): Promise<Record<string, unknown>> {
    const count = (table: string, where = "1") => this.#rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;
    return {
      scope: this.#meta("scope"),
      alarm_at: await this.ctx.storage.getAlarm(),
      active_run: this.#activeRun() ?? null,
      inbox: { pending: count("inbox", "status = 'pending'"), claimed: count("inbox", "status = 'claimed'"), done: count("inbox", "status = 'done'"), dead: count("inbox", "status = 'dead'") },
      recent_events: this.#rows("SELECT id, source, kind, session_key, status, substr(text, 1, 160) AS text FROM inbox ORDER BY id DESC LIMIT 15"),
      runs: this.#rows("SELECT id, status, entries, steps, input_tokens, output_tokens, started_at, ended_at, error FROM runs ORDER BY started_at DESC LIMIT 10"),
      sessions: this.#rows("SELECT session_key, (SELECT COUNT(*) FROM items WHERE session_id = sessions.id) AS items FROM sessions"),
      memory: this.#rows("SELECT path, LENGTH(content) AS size FROM memory ORDER BY path"),
      timers: this.#rows("SELECT id, due_at, every_s, status, substr(note, 1, 120) AS note FROM timers ORDER BY due_at DESC LIMIT 10"),
      tasks: this.#rows("SELECT id, title, status, requested_by, last_progress, substr(result, 1, 300) AS result FROM tasks ORDER BY created_at DESC LIMIT 10"),
      outbox: this.#rows("SELECT id, status, attempts, substr(text, 1, 200) AS text, error FROM outbox ORDER BY id DESC LIMIT 10"),
      tokens_today: this.#tokensToday(),
      health: {
        oldest_pending_age_ms: (() => {
          const oldest = this.#rows<{ at: number }>("SELECT MIN(received_at) AS at FROM inbox WHERE status IN ('pending', 'claimed')")[0]?.at;
          return oldest == null ? 0 : Date.now() - oldest;
        })(),
        dead_events: count("inbox", "status = 'dead'"),
        undeliverable_messages: count("outbox", "status = 'dead'"),
        lost_tasks: count("tasks", "status = 'lost'"),
        abandoned_runs: count("runs", "status = 'failed'"),
      },
      audit: this.#rows("SELECT at, actor, action, detail FROM audit ORDER BY id DESC LIMIT 20"),
    };
  }

  async readMemory(path: string): Promise<string | null> {
    return this.#rows<Row>("SELECT content FROM memory WHERE path = ?", path)[0]?.content ?? null;
  }

  // ------------------------------------------------------------------ helpers

  #scopeName(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("a Brain must be addressed by name");
    return name;
  }

  #scope(): Scope {
    return parseScope(this.#scopeName());
  }

  #meta(key: string): string | undefined {
    return this.#rows<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value;
  }

  #setMeta(key: string, value: string): void {
    this.#sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  #rows<T = Row>(query: string, ...bindings: unknown[]): T[] {
    return this.#sql.exec(query, ...(bindings as SqlStorageValue[])).toArray() as unknown as T[];
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Function calls in the transcript that have no output yet. */
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

/** A button press or a reply to a question's message is about that question and no other. */
function isAbout(event: InboxRow, ask: string | undefined): boolean {
  const question = event.data ? (JSON.parse(event.data) as { question?: string }).question : undefined;
  return question === undefined || question === ask;
}

function isTiedTo(event: InboxRow, ask: string | undefined): boolean {
  return ask !== undefined && (event.data ? (JSON.parse(event.data) as { question?: string }).question : undefined) === ask;
}

/** What a message says about one open question: by its code, or, if it is tied to the question, in plain words. */
function saysAbout(event: InboxRow, pending: { code: string; ask?: string }): "allow" | "deny" | undefined {
  if (!isAbout(event, pending.ask)) return undefined;
  return isTiedTo(event, pending.ask) ? readTiedDecision(event.text ?? "", pending.code) : readDecision(event.text ?? "", pending.code);
}

/**
 * What a reply says when it is tied to one question (a press on its card, a reply to its message).
 * It need not name the code, and a plain yes is an approval; anything refusing is a refusal, and
 * anything else is nothing.
 */
export function readTiedDecision(text: string, code: string): "allow" | "deny" | undefined {
  const named = readDecision(text, code);
  if (named) return named;
  if (/(?<![A-Za-z])(deny|denied|refuse|refused|reject|rejected|don'?t|do not|not|never|no|stop|cancel|wait)(?![A-Za-z])|拒绝|不同意|不批准|否决|不要|不行|不可以|别|取消|等等|等一下|先别/i.test(text)) return "deny";
  const bare = text.replace(/[\s:：,，.。!！~～]+/g, " ").trim().toLowerCase();
  return /^(approve all|全部批准|都批准|approve|approved|yes|ok|okay|同意|批准|可以|好|好的|行|确认|通过)$/.test(bare) ? "allow" : undefined;
}

/** Whether an approval also says "and for the rest of this task". Only ever read from an approval. */
export function wantsStanding(text: string): boolean {
  return /(?<![A-Za-z])approve all(?![A-Za-z])|全部批准|都批准/i.test(text);
}

/** When a message was said, according to its source if it tells us, else when it arrived. */
function saidAt(event: InboxRow): number {
  const revision = event.data ? (JSON.parse(event.data) as { subject?: string; revision?: number }) : {};
  return revision.subject && typeof revision.revision === "number" ? revision.revision : event.received_at;
}

/** Whether the time a message was said comes from its source rather than from its arrival. */
function fromSource(event: InboxRow): boolean {
  const data = event.data ? (JSON.parse(event.data) as { subject?: string; revision?: number }) : {};
  return Boolean(data.subject) && typeof data.revision === "number";
}

/** Whether a message mentions this question's code at all. */
function quotes(text: string, code: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "i").test(text);
}

/** What a held request would do, in words. Built from the worker's structured report. */
function describeRequest(body: Record<string, unknown>): string {
  return body.source === "proxy" ? `${String(body.summary ?? `${body.action} on ${body.resource}`)}.` : `run this command:\n${String(body.command ?? "")}`;
}

/**
 * What a person's reply says about the question with this code: an approval, a refusal, or nothing.
 * A refusal is checked first because "不同意 X" contains "同意 X".
 */
export function readDecision(text: string, code: string): "allow" | "deny" | undefined {
  if (!new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "i").test(text)) return undefined;
  // Refusal first, on the message exactly as written: any refusing or negating word next to the
  // code makes it a refusal, wherever it sits and whatever it is attached to. English words are
  // matched whole, so "notebook" or "another" is not one.
  if (/(?<![A-Za-z])(deny|denied|refuse|refused|reject|rejected|don'?t|do not|not|never|no|stop|cancel)(?![A-Za-z])|拒绝|不同意|不批准|否决|不要|不行|别|取消/i.test(text)) return "deny";
  // An approval is the whole message and nothing else: "approve CODE". Anything longer could be a
  // condition or a different statement. Mentions are not stripped here: each connector removes the
  // agent's own, where it knows which that is, and a message addressed to anyone else is not for us.
  const bare = text.replace(/[\s:：,，.。!！]+/g, " ").trim();
  if (new RegExp(`^(?:approve all|approve|全部批准|都批准|同意|批准) ?${code}$`, "i").test(bare)) return "allow";
  return undefined;
}

/** Four characters a person can read back without ambiguity (no 0/O, 1/I/L). */
function questionCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return [...crypto.getRandomValues(new Uint8Array(4))].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function renderWorkerEvent(task: Row, kind: WorkerEventKind, body: Record<string, unknown>): string {
  const head = `Task ${task.id} "${task.title}"`;
  if (kind === "needs_input") {
    const what = String(body.what ?? describeRequest(body));
    const told = body.delivered ? `The people here have already been asked by the system, with the code ${body.code}. Do not ask again. When one of them replies, pass their decision on with answer_task.` : "The question could not be delivered to anyone here.";
    return `${head} is paused and needs approval to ${what} ${told}`;
  }
  if (kind === "result") return `${head} finished. The worker's own summary (unverified): ${clipResult(String(body.text ?? ""))}`;
  if (kind === "failed") return `${head} failed: ${String(body.error ?? "").slice(0, 1_000)}`;
  return `${head} was lost: its sandbox stopped and could not be restored.`;
}

export { messageText };
