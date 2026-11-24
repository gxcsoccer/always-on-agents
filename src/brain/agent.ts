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

import { amend, aside, closeInvitation, holds, canRevisit, deliver, direct, offeredFor, quoted, under, received, standingOf, toolsOf, trusts, unreceived } from "../connectors";
import type { Env } from "../env";
import { type InboundEvent, type Principal, isPrivateSession, type Target, type WorkerEventKind } from "../events";
import { messageText, respond } from "../model/openai";
import { registry } from "../registry";
import { workerNamed, workers } from "../workers";
import { sandboxWorker } from "../workers/sandbox/worker";
import { migrate } from "./schema";
import { BrainStore, type Row, type Wakes } from "./store";
import { Outbox } from "./outbox";
import { Revisions } from "./revisions";
import { quotes } from "./approval";
import { Tasks } from "./tasks";
import { Marks } from "./marks";
import { Timers } from "./timers";
import { type Continuation, Requests } from "./requests";
import { RunTools } from "./run-tools";
import { Runner } from "./runner";

/** Events arriving within this window are answered in one run. */
const BATCH_WINDOW_MS = 2_000;
/** How long finished records are kept before housekeeping removes them. */
const RETAIN_RECORDS_MS = 30 * 86_400_000;
const RETAIN_AUDIT_MS = 365 * 86_400_000;
/** A conversation keeps at least this many recent transcript items, however old. */
const RETAIN_ITEMS_PER_SESSION = 200;




export class BrainAgent extends DurableObject<Env> {
  /** The database, shared with every part of this Brain. */
  readonly #store: BrainStore;
  /** Calls in this invocation whose result came from a connector's tool, until they are recorded. */
  readonly #outside = new Set<string>();
  /** Requests that wait, and guards: the same database and transactions, in a file of their own. */
  readonly #requests: Requests;
  readonly #timers: Timers;
  readonly #marks: Marks;
  /** Messages to deliver. */
  readonly #outbox: Outbox;
  /** What is known of messages that can change after they were said. */
  readonly #revisions: Revisions;
  /** Work handed to workers, and the approval questions they raise. */
  readonly #tasks: Tasks;
  /** What a run's tools do. */
  readonly #tools: RunTools;
  /** The run loop. */
  readonly #runner: Runner;
  /** The parts that can ask to be woken. */
  readonly #parts: Wakes[];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new BrainStore(ctx);
    this.#timers = new Timers(this.#store);
    this.#marks = new Marks(this.#store, { unmark: (source, event, mark) => unreceived(this.env, source, this.#store.scope(), event, mark) });
    const brain = this;
    this.#revisions = new Revisions(this.#store, {
      isDecider: (principal, source) => this.#isDecider(principal, source),
      canRevisit,
      standingOf: (source, subject) => standingOf(this.env, source, this.#store.scope(), subject),
    });
    this.#tasks = new Tasks(this.#store, this.#revisions, {
      // Read each time, as everywhere else in this class: not the value at construction.
      get env() {
        return brain.env;
      },
      workerNamed,
      workerOf: (name) => {
        const worker = workerNamed(name) ?? (name === sandboxWorker.name ? sandboxWorker : undefined);
        if (!worker) throw new Error(`no worker named "${name}" is known here`);
        return worker;
      },
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
      spend: (tokens) => this.#runner.spend(tokens),
    });
    this.#runner = new Runner(this.#store, {
      // Read each time: not the value at construction.
      get env() {
        return brain.env;
      },
      outside: this.#outside,
      isDecider: (principal, source) => this.#isDecider(principal, source),
      toolsOf,
      workers,
      workStands: (work) => this.#workStands(work),
      registry: () => registry(this.env),
      respond,
      quoted: (connector, event) => quoted(this.env, connector, this.#store.scope(), event),
      under,
      // Built after this part: read when they are used.
      get requests() {
        return brain.#requests;
      },
      get outbox() {
        return brain.#outbox;
      },
      get tools() {
        return brain.#tools;
      },
    });
    this.#tools = new RunTools(this.#store, {
      // Read each time: not the value at construction.
      get env() {
        return brain.env;
      },
      outside: this.#outside,
      actingFor: (runId) => this.#runner.actingFor(runId),
      mayUse: (runId, name) => this.#runner.mayUse(runId, name),
      instructionEditors: (runId) => this.#instructionEditors(runId),
      toolsOf,
      workers,
      workStands: (work) => this.#workStands(work),
      // Built after this part: read when they are used.
      get requests() {
        return brain.#requests;
      },
      get outbox() {
        return brain.#outbox;
      },
      get tasks() {
        return brain.#tasks;
      },
    });
    this.#outbox = new Outbox(this.#store, {
      deliver: (target, message) => deliver(this.env, this.#store.scope(), target, message),
      sawOutside: (runId) => this.#runner.sawOutside(runId),
      actedFor: (runId) => this.#runner.actingFor(runId)?.person,
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
      append: (sessionId, runId, item, outside) => this.#runner.append(sessionId, runId, item, outside),
      actingFor: (runId) => this.#runner.actingFor(runId),
      actingOn: (events, kept) => this.#runner.actingOn(events, kept),
      enqueueMessage: (...args) => this.#outbox.enqueue(...args),
      notice: (which, sessionId) => this.#outbox.notice(which, sessionId),
      direct,
      aside,
      handsTo: (connector, tool) => toolsOf(connector).find((each) => each.name === tool)?.hands_to,
      closeInvitation: (target, receipt, interaction, how) => closeInvitation(this.env, target, receipt, interaction, how),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    this.#parts = [this.#timers, this.#requests, this.#outbox, this.#tasks, this.#marks];
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
    // Which optional tools of plugged-in connectors are for whoever caused this: said by those
    // connectors now, and by nobody else. Whatever the event's own connector wrote there is dropped.
    if (event.data && "offered" in event.data) event = { ...event, data: Object.fromEntries(Object.entries(event.data).filter(([key]) => key !== "offered")) };
    const offered = event.kind === "message" ? await offeredFor(this.env, event) : [];
    if (offered.length > 0) event = { ...event, data: { ...event.data, offered } };
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
      // Typed words that name an open question are marked as such, so that they are taken up
      // apart from the person's ordinary requests. Only that: they are not thereby an answer to
      // the question, which is still judged from what they say.
      if (!pressed && sessions.size > 0) event = { ...event, data: { ...event.data, about_question: true } };
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
      this.ctx.waitUntil(
        received(this.env, event.source, this.#store.scope(), { source_id: event.source_id, data: event.data, reply_to: event.reply_to, wanted }).then(async (mark) => {
          if (!mark) return;
          this.#store.log("received_shown", { ms: Date.now() - at });
          // Kept with the message, to take off once it has been dealt with: at once if it already has.
          if (this.#marks.keep(event.source, event.source_id, mark)) await this.#wakeBy(Date.now());
        }),
      );
    }
    // Someone who writes while a request of theirs waits may be saying that the wait is over
    // ("done"). That is not taken from their words: the condition's owner is asked again.
    if (inserted && event.kind === "message") {
      // Their own requests, that is: what someone else says in a shared conversation is no reason to ask about them.
      // One kept before its person was recorded counts as theirs only in a private conversation.
      for (const waiting of this.#store.rows<Continuation>("SELECT c.* FROM continuations c JOIN sessions s ON s.id = c.session_id WHERE c.status = 'waiting' AND s.session_key = ? AND (c.person = ? OR (? = 1 AND c.person IS NULL))", event.session_key, event.principal.id, isPrivateSession(event.session_key) ? 1 : 0)) this.#requests.hint(waiting, `said:${event.source}:${event.source_id}`);
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
      this.#housekeeping(Date.now());
      await this.#outbox.flush();
      await this.#tasks.settle();
      // A few runs per wake-up at most, so one busy scope cannot hold an invocation forever.
      for (let i = 0; i < 3; i++) {
        const runId = await this.#runner.next();
        if (!runId) break;
        await this.#runner.execute(runId);
        await this.#outbox.flush();
        // Messages this run dealt with no longer show that they are being handled: at once, not after the runs that follow.
        await this.#marks.clear(Date.now());
        if (this.#store.meta("active_run")) break;
      }
      // And any whose removal is due again, also when no run was made.
      await this.#marks.clear(Date.now());
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
    const active = this.#runner.activeRun();
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

  /**
   * Whether a piece of work done in a person's name that has ended still stands under what it
   * was done under: whoever keeps the authorisation is asked, with the condition and generation
   * the work was kept with. Gone (taken away, or the set-up changed), or not to be told: it does
   * not. One still under way is its request's to settle, and one kept with no condition has
   * nothing to ask about.
   */
  async #workStands(work: { id: string; state: string; condition: string | null; generation: number | null }): Promise<boolean> {
    const connector = this.#requests.record(work.id)?.connector;
    if (work.state === "open" || work.condition === null || work.generation === null || !connector) return true;
    try {
      return (await holds(this.env, connector, this.#store.scope(), work.condition, work.generation)).state !== "gone";
    } catch {
      return false;
    }
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
      // Before what the index of work points at is cleared: a row still open for something that has
      // ended (ended while a version without the index ran, say) is given its end, with the time
      // it ended. A task's is its own last status. For a request, only an end that is about the work
      // itself (called off, out of time, no longer standing): that its answer was sent, or could
      // not be, does not say what the worker made of it, so that is not known.
      // One whose task or request is gone altogether is not known either.
      this.#store.sql.exec(
        `UPDATE work SET state = CASE t.status WHEN 'succeeded' THEN 'done' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE 'unknown' END, updated_at = t.updated_at
         FROM tasks t WHERE t.id = work.id AND work.state = 'open' AND t.status IN ('succeeded', 'failed', 'lost', 'cancelled')`,
      );
      this.#store.sql.exec(
        `UPDATE work SET state = CASE WHEN c.status IN ('cancelled', 'expired', 'void') THEN c.status ELSE 'unknown' END, updated_at = c.ended_at
         FROM continuations c WHERE c.id = work.id AND work.state = 'open' AND c.ended_at IS NOT NULL`,
      );
      this.#store.sql.exec("UPDATE work SET state = 'unknown' WHERE state = 'open' AND id NOT IN (SELECT id FROM tasks) AND id NOT IN (SELECT id FROM continuations) AND updated_at < ?", old);
      this.#store.sql.exec("DELETE FROM continuations WHERE ended_at IS NOT NULL AND ended_at < ?", old);
      this.#store.sql.exec("DELETE FROM runs WHERE status != 'running' AND ended_at < ?", old);
      this.#store.sql.exec("DELETE FROM timers WHERE status != 'active' AND created_at < ?", old);
      this.#store.sql.exec("DELETE FROM task_events WHERE at < ?", old);
      this.#store.sql.exec("DELETE FROM tasks WHERE status IN ('succeeded', 'failed', 'lost', 'cancelled') AND updated_at < ?", old);
      // The index of work is kept as long as what it points at: work that has ended, for the same time.
      this.#store.sql.exec("DELETE FROM work WHERE state != 'open' AND updated_at < ?", old);
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
        // What the person was told in turns no longer kept goes with them (and not with the outbox rows, which age out on their own).
        this.#store.sql.exec("DELETE FROM said WHERE session_id = ? AND (run_id IS NULL OR run_id NOT IN (SELECT DISTINCT run_id FROM items WHERE session_id = ? AND run_id IS NOT NULL))", session.id, session.id);
      }
    });
  }


  // ------------------------------------------------------------------ runs

  // ------------------------------------------------------------------ requests that wait
  //
  // Kept in ./requests. What is here is only what the wake cycle and the connectors call.

  /** Called by a connector when something changed for one of its subjects: see Requests.conditionReported. */
  async conditionReported(connector: string, subject: string, event: string): Promise<{ ok: true }> {
    return this.#requests.conditionReported(connector, subject, event);
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
      active_run: this.#runner.activeRun() ?? null,
      inbox: { pending: count("inbox", "status = 'pending'"), claimed: count("inbox", "status = 'claimed'"), done: count("inbox", "status = 'done'"), dead: count("inbox", "status = 'dead'") },
      recent_events: this.#store.rows("SELECT id, source, kind, session_key, status, substr(text, 1, 160) AS text FROM inbox ORDER BY id DESC LIMIT 15"),
      runs: this.#store.rows("SELECT id, status, entries, steps, input_tokens, output_tokens, started_at, ended_at, error FROM runs ORDER BY started_at DESC LIMIT 10"),
      sessions: this.#store.rows("SELECT session_key, (SELECT COUNT(*) FROM items WHERE session_id = sessions.id) AS items FROM sessions"),
      memory: this.#store.rows("SELECT path, LENGTH(content) AS size FROM memory ORDER BY path"),
      timers: this.#store.rows("SELECT id, due_at, every_s, status, substr(note, 1, 120) AS note FROM timers ORDER BY due_at DESC LIMIT 10"),
      tasks: this.#store.rows("SELECT id, title, status, requested_by, last_progress, substr(result, 1, 300) AS result FROM tasks ORDER BY created_at DESC LIMIT 10"),
      // What was written after reading outside text is not shown here either, sent or not.
      outbox: this.#store.rows("SELECT id, status, attempts, CASE WHEN private = 1 OR continuation IS NOT NULL THEN '' ELSE substr(text, 1, 200) END AS text, error FROM outbox ORDER BY id DESC LIMIT 10"),
      tokens_today: this.#runner.tokensToday(),
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


export { messageText };
export { readDecision, readTiedDecision, wantsStanding } from "./approval";
