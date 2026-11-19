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

import { deliver } from "../connectors";
import type { Env } from "../env";
import { type InboundEvent, type Principal, type Scope, type Target, type WorkerEventKind, parseScope } from "../events";
import { type Item, ModelError, messageText, respond } from "../model/openai";
import { registry } from "../registry";
import { buildInstructions } from "./prompt";
import { migrate } from "./schema";
import { TOOLS, type ToolCall, type ToolHost, executeTool } from "./tools";

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
const TASK_WATCHDOG_S = 2 * 60 * 60 + 10 * 60;
/** How long finished records are kept before housekeeping removes them. */
const RETAIN_RECORDS_MS = 30 * 86_400_000;
const RETAIN_AUDIT_MS = 365 * 86_400_000;
/** A conversation keeps at least this many recent transcript items, however old. */
const RETAIN_ITEMS_PER_SESSION = 200;
const MEMORY_PATH = /^[a-z0-9][a-z0-9_\-/]{0,150}\.md$/;
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
    if ((event.text?.length ?? 0) > 50_000) throw new Error("event text is too long");
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
      this.#sql.exec("DELETE FROM outbox WHERE status IN ('sent', 'dead') AND created_at < ?", old);
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

  #enqueueMessage(idem: string, sessionId: string, runId: string | null, text: string): { ok: true } {
    const target = this.#rows<Row>("SELECT target FROM sessions WHERE id = ?", sessionId)[0]?.target ?? this.#meta("default_target");
    if (!target) throw new Error("there is nowhere to send a message in this conversation");
    const now = Date.now();
    this.#sql.exec("INSERT OR IGNORE INTO outbox (idem, run_id, target, text, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", idem, runId, target, text, now, now);
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
    for (;;) {
      const row = this.#rows<Row>("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0];
      if (!row || row.next_at > Date.now()) return;
      try {
        await deliver(this.env, this.#scope(), JSON.parse(row.target) as Target, { id: row.id, idem: row.idem, text: row.text });
        this.#sql.exec("UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL WHERE id = ? AND status = 'pending'", Date.now(), row.id);
      } catch (err) {
        const attempts = row.attempts + 1;
        const dead = attempts > OUTBOX_RETRY_DELAYS_MS.length;
        this.#sql.exec(
          "UPDATE outbox SET status = ?, attempts = ?, next_at = ?, error = ? WHERE id = ?",
          dead ? "dead" : "pending",
          attempts,
          Date.now() + (OUTBOX_RETRY_DELAYS_MS[attempts - 1] ?? 0),
          String(err).slice(0, 500),
          row.id,
        );
        if (dead) this.#log("message_undeliverable", { outbox_id: row.id, error: String(err).slice(0, 300) });
        return;
      }
    }
  }

  // ------------------------------------------------------------------ tools

  #toolHost(run: RunRow): ToolHost {
    const session = this.#rows<Row>("SELECT * FROM sessions WHERE id = ?", run.session_id)[0];
    const sql = this.#sql;
    return {
      sendMessage: (callId, text) => this.#enqueueMessage(`msg:${callId}`, run.session_id, run.id, text),

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
    const task = this.#rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
    if (!task) throw new Error(`no task ${taskId} in this conversation's scope`);
    if (task.session_key !== sessionKey) throw new Error("that task belongs to a different conversation and has to be answered there");

    let intent = task.answering ? (JSON.parse(task.answering) as { call_id: string; pending_id: string; decision: "allow" | "deny"; reason: string; decided_by: string; deciding_event: number }) : undefined;
    // A question gets one decision. If one is already on record for the question still shown as
    // pending (its delivery to the worker was not confirmed), this call delivers that same decision
    // again; it does not get to make a new one.
    const open = task.status === "needs_input" && task.pending ? (JSON.parse(task.pending) as { id: string }).id : undefined;
    if (intent && intent.pending_id !== open && intent.call_id !== callId) intent = undefined;
    if (!intent) {
      if (task.status !== "needs_input" || !task.pending) throw new Error(`task ${taskId} is ${task.status}; it is not waiting for an answer`);
      const pending = JSON.parse(task.pending) as { id: string; code: string; asked_at: number; ask?: string; truncated?: boolean };
      // "Asked" means the message actually went out, not merely that it was queued.
      const asked = pending.ask ? this.#rows<Row>("SELECT status, sent_at FROM outbox WHERE idem = ?", pending.ask)[0] : undefined;
      if (asked?.status !== "sent") throw new Error("the question has not been delivered to anyone in this conversation yet, so it cannot be answered");

      // Messages from members, sent after the question was put to them.
      const replies = this.#rows<InboxRow>("SELECT * FROM inbox WHERE run_id = ? AND received_at > ? ORDER BY id", run.id, asked.sent_at)
        .map((event) => ({ event, principal: JSON.parse(event.principal) as Principal }))
        .filter(({ principal }) => this.#isDecider(principal));
      if (replies.length === 0) throw new Error("nobody here has answered the question yet; wait for a reply");

      // What each reply says about this question, read from its own words. The model proposes a
      // decision; it only goes through if a person's message actually says it.
      const read = replies.map((reply) => ({ ...reply, says: readDecision(reply.event.text ?? "", pending.code) }));
      const shared = this.#scope().kind !== "user";
      let deciding: (typeof read)[number];
      if (decision === "deny") {
        // A refusal has to be said too: "deny <code>". An unrelated message is not one.
        const refusals = read.filter(({ says }) => says === "deny");
        if (refusals.length === 0) throw new Error(`no reply so far refuses this. A refusal is a message that says "deny ${pending.code}". Call this tool again whenever a new reply arrives`);
        deciding = refusals.at(-1)!;
      } else {
        if (pending.truncated) throw new Error("the action is too long to be shown in full, so it cannot be approved; it can only be refused");
        // A refusal from any member wins over an approval in the same batch, whichever came first.
        if (read.some(({ says }) => says === "deny")) throw new Error("a reply refuses this; pass on a denial, not an approval");
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
        deciding = approvals.at(-1)!;
        // The approval has to be that person's last word. If they said anything after it, they may
        // have been taking it back, and there is no reading that safely.
        const lastWord = read.filter(({ principal }) => principal.id === deciding.principal.id).at(-1)!;
        if (lastWord.event.id !== deciding.event.id) throw new Error(`${deciding.principal.id} said something after approving; ask them to confirm by sending just "approve ${pending.code}" again`);
      }
      intent = { call_id: callId, pending_id: pending.id, decision, reason, decided_by: deciding.principal.id, deciding_event: deciding.event.id };
      this.#sql.exec("UPDATE tasks SET answering = ? WHERE id = ?", JSON.stringify(intent), taskId);
      // Recorded with the question as it was put and the message that answered it.
      this.#audit(intent.decided_by, `task.${decision === "allow" ? "approved" : "denied"}`, { task_id: taskId, question: pending, reason, deciding_event: deciding.event.id });
    }

    const answered = await this.env.TASKS.getByName(taskId).answer(intent.decision, intent.reason, intent.pending_id);
    if (!answered.ok) throw new Error(answered.error);
    // Only clear the question that was answered; a newer one may have arrived meanwhile.
    this.#sql.exec(
      "UPDATE tasks SET status = 'running', pending = NULL, updated_at = ? WHERE id = ? AND status = 'needs_input' AND json_extract(pending, '$.id') = ?",
      Date.now(),
      taskId,
      intent.pending_id,
    );
    return { ok: true, task_id: taskId, decision: intent.decision, decided_by: intent.decided_by };
  }

  async #cancelTask(sessionKey: string, taskId: string): Promise<unknown> {
    const task = this.#rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
    if (!task) throw new Error(`no task ${taskId} in this conversation's scope`);
    if (task.session_key !== sessionKey) throw new Error("that task belongs to a different conversation and has to be cancelled there");
    if (TERMINAL_TASK.has(task.status)) return { ok: true, task_id: taskId, status: task.status };
    await this.env.TASKS.getByName(taskId).cancel();
    this.#setTask(taskId, "cancelled", {});
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
        }
        return { known: true, wake: false, terminal: false };
      }
      if (kind === "needs_input") {
        // The question is put to people by this code, not by the model: what they are shown is
        // exactly what the worker is held on, and the code ties their reply to this one question.
        // No two open questions in this scope share a code, so one reply cannot answer two of them.
        const open = new Set(this.#rows<{ code: string | null }>("SELECT json_extract(pending, '$.code') AS code FROM tasks WHERE pending IS NOT NULL").map((r) => r.code));
        let code = questionCode();
        while (open.has(code)) code = questionCode();
        const what = describeRequest(body);
        const session = this.#rows<Row>("SELECT id FROM sessions WHERE session_key = ?", task.session_key)[0];
        const truncated = body.truncated === true;
        let ask: string | undefined = `ask:${taskId}:${seq}`;
        try {
          if (!session) throw new Error("no conversation");
          const how = truncated ? `This is too long to show in full, so it cannot be approved.\nTo refuse, reply: deny ${code}` : `To approve, reply: approve ${code}\nTo refuse, reply: deny ${code}`;
          this.#enqueueMessage(ask, session.id, null, `Task "${task.title}" is paused and needs approval to ${what}\n\n${how}`);
        } catch {
          // No reply address: the question reaches nobody, so it cannot be approved.
          ask = undefined;
        }
        body = { ...body, code, asked_at: Date.now(), ask, delivered: ask !== undefined, what };
        applied = this.#setTask(taskId, "needs_input", { pending: JSON.stringify(body) });
      }
      else if (kind === "result") applied = this.#setTask(taskId, "succeeded", { result: JSON.stringify(body) });
      else if (kind === "failed" || kind === "lost") applied = this.#setTask(taskId, kind, { result: JSON.stringify(body) });
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
    return this.#runPrincipals(runId).filter((p) => this.#isDecider(p));
  }

  /**
   * Who may be changing the standing instructions in this run, or an error. The run must have been
   * started by members only: if a worker report, a CI event or any other untrusted text is in the
   * same batch, the model may be acting on that text rather than on the member's words.
   */
  #instructionEditors(runId: string): string[] {
    const principals = this.#runPrincipals(runId);
    if (principals.length === 0 || !principals.every((p) => this.#isDecider(p))) {
      throw new Error("instructions.md can only be changed in a run started solely by a person's request");
    }
    return [...new Set(principals.map((p) => p.id))];
  }

  #isDecider(principal: Principal): boolean {
    return principal.kind === "human" && principal.explicit && !(this.#scope().kind === "repo" && principal.id.startsWith("github:"));
  }

  #runPrincipals(runId: string): Principal[] {
    return this.#rows<{ principal: string }>("SELECT principal FROM inbox WHERE run_id = ? ORDER BY id", runId).map((r) => JSON.parse(r.principal) as Principal);
  }

  // ------------------------------------------------------------------ reads for connectors and admins

  /** Records where this scope's messages go when an event does not say. Set by the first connector to reach it. */
  async setDefaultTarget(target: Target): Promise<void> {
    if (!this.#meta("default_target")) this.#setMeta("default_target", JSON.stringify(target));
  }

  /** Messages written since `afterId`, for connectors whose clients pull instead of being pushed to. */
  async outboxSince(afterId: number, limit = 50): Promise<{ id: number; text: string; status: string; created_at: number }[]> {
    return this.#rows("SELECT id, text, status, created_at FROM outbox WHERE id > ? ORDER BY id LIMIT ?", afterId, Math.min(limit, 200));
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
  return `[${new Date(event.received_at).toISOString()}] ${event.kind} from ${who}: ${event.text ?? ""}`.trim();
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
  // An approval is the whole message and nothing else: optional plain @handles in front, then
  // "approve CODE". Anything longer could be a condition or a different statement.
  const bare = text.replace(/^(\s*@[A-Za-z0-9_-]+(?=\s))+/, " ").replace(/[\s:：,，.。!！]+/g, " ").trim();
  if (new RegExp(`^(?:approve|同意|批准) ?${code}$`, "i").test(bare)) return "allow";
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
  if (kind === "result") return `${head} finished. The worker's own summary (unverified): ${String(body.text ?? "").slice(0, 3_000)}`;
  if (kind === "failed") return `${head} failed: ${String(body.error ?? "").slice(0, 1_000)}`;
  return `${head} was lost: its sandbox stopped and could not be restored.`;
}

export { messageText };
