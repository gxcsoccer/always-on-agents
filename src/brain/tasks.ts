/**
 * Tasks: work handed to worker agents, and the approval questions they raise.
 *
 * A task is written before its worker is started, reports back by numbered events, and ends once.
 * When a worker asks for approval, the question is put to people by this code, under a code of
 * its own, and a decision is passed on only if a person's message actually says it (see `answer`).
 * The Brain builds this part on its own database; what it needs from the rest of the Brain, and
 * from the systems outside it, it is handed (TasksHost).
 */
import type { ApprovalQuestion, Outcome, Receipt, Standing } from "../connectors";
import type { Env } from "../env";
import type { Principal, Target, WorkerEventKind } from "../events";
import type { registry } from "../registry";
import { type RefUpdate, standingEligible } from "../workers/sandbox/outbound";
import { type QuestionFate, clipResult } from "../workers/sandbox/result";
import type { Started, Worker } from "../workers";
import type { Outbox } from "./outbox";
import { decidingReply, speaksAgainst, wantsStanding } from "./approval";
import type { Revisions } from "./revisions";
import { type BrainStore, type InboxRow, type Row, type RunRow, TERMINAL_TASK, type Wakes } from "./store";

const MAX_ACTIVE_TASKS = 3;
const TASK_WATCHDOG_S = 2 * 60 * 60 + 10 * 60;
/** How many times the worker is asked how a set-aside question ended before giving up on knowing. */
const SETTLE_ATTEMPTS = 12;

/** What tasks need from the Brain they are part of, and from the systems outside it. */
export interface TasksHost {
  readonly env: Env;
  /** The worker listed under a name in this deployment, if it is: only such a one is given something new. */
  workerNamed(name: string): Worker | undefined;
  /** The worker a task was written for, listed or not: what was taken is carried through and can be stopped. */
  workerOf(name: string): Worker;
  /** The sandbox of one task, for what is still its own: the questions it asks. */
  worker(taskId: string): Pick<ReturnType<Env["TASKS"]["getByName"]>, "answer" | "decisionOn">;
  /** Where sandbox slots and the tenant's usage are kept. */
  registry(): Pick<ReturnType<typeof registry>, "acquireTaskSlot" | "releaseTaskSlot" | "recordUsage">;
  /** The people whose word counts in this run. */
  deciders(runId: string): Principal[];
  /** Whether this person's word counts here. */
  isDecider(principal: Principal, source: string): boolean;
  /** Whether this source can say what one of its messages says now. */
  canRevisit(source: string): boolean;
  /** What a revisable message says at its source now. Throws if the source cannot be asked. */
  standingOf(source: string, subject: string): Promise<Standing | undefined>;
  /** Keeps a message to deliver: see Outbox.enqueue. */
  enqueue: Outbox["enqueue"];
  /** Marks a delivered question as closed where it is shown. */
  amend(target: Target, receipt: Receipt, ask: ApprovalQuestion, outcome: Outcome): Promise<void>;
  /** Lets something finish after the current invocation has answered. */
  waitUntil(promise: Promise<unknown>): void;
  wakeBy(at: number): Promise<void>;
  /** Counts tokens against this scope's daily budget, at once: the same count the Brain's own calls go to. */
  spend(tokens: number): void;
}

/** The worker tasks are written for. */
const WORKER = "sandbox";

export class Tasks implements Wakes {
  readonly #s: BrainStore;
  readonly #r: Revisions;
  readonly #b: TasksHost;

  constructor(store: BrainStore, revisions: Revisions, host: TasksHost) {
    this.#s = store;
    this.#r = revisions;
    this.#b = host;
  }

  /** When the earliest set-aside question is to be asked about again. */
  nextWakeAt(_now: number): number | null {
    return this.#s.rows<{ next_at: number | null }>("SELECT MIN(next_at) AS next_at FROM unsettled")[0]?.next_at ?? null;
  }

  async dispatch(run: RunRow, sessionKey: string, callId: string, title: string, brief: string, repository: string | null): Promise<unknown> {
    if (repository !== null && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/.test(repository)) throw new Error("repository must be an https://github.com/owner/name URL");
    const scope = this.#s.scope();
    // Credentials for a repository are lent only inside that repository's own scope, so that is the
    // only repository such a scope may send a worker to.
    if (scope.kind === "repo" && repository !== null && repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").toLowerCase() !== scope.id.toLowerCase()) {
      throw new Error(`in this repository's conversation a task can only work on ${scope.id}`);
    }

    // The row is written before anything is started. A retry of this tool call finds it by op_id
    // and continues with the same task id, so a lost response can never start a second task.
    let task = this.#s.rows<Row>("SELECT * FROM tasks WHERE op_id = ?", callId)[0];
    if (!task) {
      // Something new is taken only by a worker this deployment lists. Nothing is written for one that is not.
      if (!this.#b.workerNamed(WORKER)) throw new Error("this deployment has no worker to hand this to");
      if (this.#s.rows<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('dispatching', 'running', 'needs_input')")[0].n >= MAX_ACTIVE_TASKS) {
        throw new Error(`there are already ${MAX_ACTIVE_TASKS} tasks running here; wait for one to finish or cancel one`);
      }
      const now = Date.now();
      // A task has a requester only when exactly one person asked. With several speakers in the
      // batch there is no telling whose request it was, so nobody is credited (and nobody can approve).
      const askers = [...new Set(this.#b.deciders(run.id).map((p) => p.id))];
      const requestedBy = askers.length === 1 ? askers[0] : null;
      const id = crypto.randomUUID();
      this.#s.sql.exec(
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
      this.#s.sql.exec(
        "INSERT INTO timers (id, due_at, session_key, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        `watch_${id}`,
        now + TASK_WATCHDOG_S * 1_000,
        sessionKey,
        `Task ${id} "${title}" has not reported a result in time.`,
        JSON.stringify({ task_id: id }),
        now,
      );
      this.#s.audit(requestedBy ?? "(automation)", "task.dispatched", { task_id: id, title, repository });
      task = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", id)[0];
    }
    if (task.status !== "dispatching") return { task_id: task.id, status: task.status };
    // One that was written is one that was taken: it is carried through by the worker it was
    // written for, whether or not the deployment still lists that worker for new work.
    const worker = this.#b.workerOf(String(task.worker));

    let slot: boolean;
    try {
      slot = await this.#b.registry().acquireTaskSlot(scope.tenant, task.id);
    } catch (err) {
      // The reservation may have been made even though its reply was lost; give it back.
      await this.#b.registry().releaseTaskSlot(task.id).catch(() => undefined);
      // The task must not be left "dispatching": nothing would ever pick it up again.
      this.#set(task.id, "failed", { result: JSON.stringify({ error: `the registry could not be reached: ${String(err).slice(0, 300)}` }) });
      throw new Error("the sandbox could not be started; try again");
    }
    if (!slot) {
      this.#set(task.id, "failed", { result: JSON.stringify({ error: "the tenant's sandbox limit is reached" }) });
      throw new Error("too many sandboxes are running for this tenant right now; try again later");
    }
    let started: Started;
    try {
      started = await worker.start(this.#b.env, { id: task.id, brief, options: { repository: repository ?? null }, brain: this.#s.scopeName() });
    } catch (err) {
      // Whether the worker heard us is unknown. Stop it if it did, and free the slot either way, so
      // a start that failed in transit does not hold one of this scope's task slots for good.
      await this.#stop(task).catch(() => undefined);
      this.#set(task.id, "failed", { result: JSON.stringify({ error: `the sandbox could not be reached: ${String(err).slice(0, 300)}` }) });
      await this.#b.registry().releaseTaskSlot(task.id).catch(() => undefined);
      throw new Error("the sandbox could not be started; try again");
    }
    if (started.state === "refused") {
      this.#set(task.id, "failed", { result: JSON.stringify({ error: started.error }) });
      await this.#b.registry().releaseTaskSlot(task.id);
      throw new Error(`the sandbox did not start: ${started.error}`);
    }
    // Only move forward: the worker may already have reported while start() was returning.
    this.#s.sql.exec("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'dispatching'", Date.now(), task.id);
    return { task_id: task.id, status: "running" };
  }

  async status(taskId: string): Promise<unknown> {
    const task = this.#s.rows<Row>("SELECT id, title, status, pending, last_progress, result, created_at, updated_at FROM tasks WHERE id = ?", taskId)[0];
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
   * that one question (see `event`). An approval counts only if:
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
  async answer(run: RunRow, sessionKey: string, callId: string, taskId: string, decision: "allow" | "deny", reason: string): Promise<unknown> {
    let task = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
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
      const candidates = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND received_at > ?", sessionKey, task.created_at ?? 0);
      await this.#r.refreshStanding(candidates);
      // The question itself is a comment others may be able to edit. People approve what they
      // read, so it has to still say what the agent wrote.
      const ask = task.pending ? (JSON.parse(task.pending) as { ask?: string }).ask : undefined;
      const shown = ask ? this.#s.rows<{ target: string; receipt: string | null; status: string }>("SELECT target, receipt, status FROM outbox WHERE idem = ?", ask)[0] : undefined;
      const where = shown ? (JSON.parse(shown.target) as Target).connector : "";
      const receipt = shown?.receipt;
      // Posted somewhere others can change it, with nothing to say which posted message it is:
      // there is then no way to know that what people read is what the agent wrote.
      if (shown?.status === "sent" && !receipt && this.#b.canRevisit(where)) {
        throw new Error("the question was posted where it can be changed and cannot be identified there, so nobody can be taken to have approved this action; it can only be refused");
      }
      if (ask && receipt) {
        const posted = JSON.parse(receipt) as { subject: string; holder: string };
        // Asked of the system the question was posted in. One where nobody else can change the
        // agent's messages has nothing to say here.
        const now = await this.#b.standingOf(where, posted.subject);
        // A system where the question can be changed has to recognise the question it was shown in.
        if (!now && this.#b.canRevisit(where)) throw new Error("the question as it was posted cannot be found where it was shown, so nobody can be taken to have approved this action; it can only be refused");
        // Edited at any time, even if put back since: someone may have read and answered the other wording.
        const touched = this.#s.rows("SELECT 1 FROM revisions WHERE subject = ?", posted.subject).length > 0;
        if (touched || (now && (now.deleted || now.edited || now.holder !== posted.holder))) {
          throw new Error("the question as it was posted has since been changed or removed, so nobody can be taken to have approved this action; it can only be refused");
        }
        confirmedAsk = ask;
      }
      // Other events may have arrived while GitHub was being asked; read the task again.
      task = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
      intent = task.answering ? (JSON.parse(task.answering) as Intent) : undefined;
    }
    // An answer already given to this question that may have reached the worker.
    let before: Intent["before"];
    // The message an approval of this question rested on, if that approval has just been set aside.
    let setAside: number | undefined;
    // A question gets one decision. If one is already on record for the question still shown as
    // pending (its delivery to the worker was not confirmed), this call delivers that same decision
    // again; it does not get to make a new one.
    const open = task.status === "needs_input" && task.pending ? (JSON.parse(task.pending) as { id: string }).id : undefined;
    if (intent && intent.pending_id !== open && intent.call_id !== callId) intent = undefined;
    // An approval on record but not yet confirmed by the worker does not outrank a change of mind:
    // a refusal proposed now is judged afresh, and an approval is only re-sent if nothing that has
    // arrived since speaks against it.
    if (intent?.decision === "allow" && intent.pending_id === open) {
      const approver = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE id = ?", intent.deciding_event)[0];
      const onRecord = JSON.parse(task.pending) as { code: string; ask?: string };
      // Everything else members have said in this conversation since the task began, whenever it
      // arrived: a later word from the approver, or anything about this question that is not an approval.
      const later = this.#r.reconcile(
        this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND received_at > ? AND id != ?", sessionKey, task.created_at ?? 0, intent.deciding_event).filter((event) => this.#b.isDecider(JSON.parse(event.principal) as Principal, event.source)),
      );
      const against =
        speaksAgainst(later, onRecord, approver, intent.decided_by) ||
        // And anything the approver has said since in the place the approval was typed, if it was moved here.
        (approver !== undefined && this.#r.saidSinceWhereTyped(approver, task.created_at ?? 0));
      if (decision === "deny" || against || !approver || !this.#r.stillStands(approver)) {
        before = { decision: intent.decision, decided_by: intent.decided_by };
        setAside = intent.deciding_event;
        intent = undefined;
      }
    }
    if (!intent) {
      if (task.status !== "needs_input" || !task.pending) throw new Error(`task ${taskId} is ${task.status}; it is not waiting for an answer`);
      const pending = JSON.parse(task.pending) as { id: string; code: string; asked_at: number; ask?: string; truncated?: boolean };
      // "Asked" means the message actually went out, not merely that it was queued.
      const asked = pending.ask ? this.#s.rows<Row>("SELECT status, sent_at, receipt FROM outbox WHERE idem = ?", pending.ask)[0] : undefined;
      if (asked?.status !== "sent") throw new Error("the question has not been delivered to anyone in this conversation yet, so it cannot be answered");
      // A question posted where it can be edited has to be the one just confirmed unchanged.
      if (decision === "allow" && asked.receipt && pending.ask !== confirmedAsk) throw new Error("the question changed while it was being checked; call this tool again");

      // Messages from members, sent after the question was put to them.
      // A reply whose comment was edited is represented by the edit, which is a message of its own.
      // Not only this run's: a "wait" that was handled in an earlier run still counts against an
      // older approval that arrives after it.
      const received = this.#r.reconcile(this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND status != 'pending' AND received_at > ? ORDER BY id", sessionKey, asked.sent_at));
      const replies = received.events
        .map((event) => ({ event, principal: JSON.parse(event.principal) as Principal }))
        .filter(({ event, principal }) => this.#b.isDecider(principal, event.source));
      const deciding = decidingReply(decision, pending, {
        replies,
        unresolved: received.unresolved,
        // A refusal from any member wins over an approval. That includes one that arrived after
        // this run started and is still waiting in the inbox.
        queued: () =>
          this.#r.reconcile(
            this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' AND session_key = ? AND received_at > ?", sessionKey, asked.sent_at).filter((event) => this.#b.isDecider(JSON.parse(event.principal) as Principal, event.source)),
          ),
        // One message approves one question.
        used: () => new Set(this.#s.rows<{ event: number | null }>("SELECT json_extract(answering, '$.deciding_event') AS event FROM tasks WHERE answering IS NOT NULL").map((r) => r.event)),
        setAside,
        shared: this.#s.scope().kind !== "user",
        requestedBy: task.requested_by,
        // Anything of theirs that arrived after this run started and is still in the inbox. And,
        // for an approval that was typed elsewhere in the chat and brought here, anything they
        // have said since in the place they typed it.
        saidMore: (deciding) =>
          this.#r.saidSinceWhereTyped(deciding.event, asked.sent_at) ||
          this.#r.reconcile(this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE status = 'pending' AND session_key = ? AND id > ?", sessionKey, deciding.event.id)).events.some(
            (event) => (JSON.parse(event.principal) as Principal).id === deciding.principal.id,
          ),
        stillStands: (event) => this.#r.stillStands(event),
      });
      // "For the rest of this task" is the approver's to say, in their own message; it is offered
      // only for pushes.
      // only for pushes that update branches, which is also the only kind it is offered for.
      const asksAbout = pending as { source?: string; refs?: RefUpdate[] };
      const standing = decision === "allow" && asksAbout.source === "proxy" && standingEligible(Array.isArray(asksAbout.refs) ? asksAbout.refs : []) && wantsStanding(deciding.event.text ?? "");
      intent = { call_id: callId, pending_id: pending.id, decision, reason, decided_by: deciding.principal.id, deciding_event: deciding.event.id, ...(pending.ask ? { ask: pending.ask } : {}), ...(standing ? { standing } : {}), ...(before ? { before } : {}) };
      this.#s.sql.exec("UPDATE tasks SET answering = ? WHERE id = ?", JSON.stringify(intent), taskId);
      // Recorded with the question as it was put and the message that answered it.
      this.#s.audit(intent.decided_by, `task.${decision === "allow" ? "approved" : "denied"}`, { task_id: taskId, question: pending, reason, deciding_event: deciding.event.id, ...(standing ? { standing: true } : {}) });
    }

    const answered = await this.#b.worker(taskId).answer(intent.decision, intent.reason, intent.pending_id, intent.standing === true);
    if (!answered.ok) throw new Error(answered.error);
    // The worker may already have acted on an earlier answer to this question; report what it holds.
    const decided = answered.decision ?? intent.decision;
    // Only clear the question that was answered; a newer one may have arrived meanwhile.
    this.#s.sql.exec(
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
    this.#s.audit(intent.decided_by, "task.answer_too_late", { task_id: taskId, question: intent.pending_id, wanted: intent.decision, in_force: decided, in_force_by: earlier ?? null });
    return { ok: true, task_id: taskId, decision: decided, ...(earlier ? { decided_by: earlier } : {}), ...reach, note: `the worker had already been told to ${decided}; ${intent.decided_by}'s "${intent.decision}" came too late to change that` };
  }

  async cancel(sessionKey: string, taskId: string): Promise<unknown> {
    const task = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
    if (!task) throw new Error(`no task ${taskId} in this conversation's scope`);
    if (task.session_key !== sessionKey) throw new Error("that task belongs to a different conversation and has to be cancelled there");
    if (TERMINAL_TASK.has(task.status)) return { ok: true, task_id: taskId, status: task.status };
    await this.#stop(task);
    // A question still open when the task is cancelled has nothing left to answer.
    const open = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
    if (this.#set(taskId, "cancelled", {}) && open) this.#setAside(open);
    this.#s.audit("(agent)", "task.cancelled", { task_id: taskId });
    await this.#b.registry().releaseTaskSlot(taskId);
    return { ok: true, task_id: taskId, status: "cancelled" };
  }

  /** Stops a task through the worker it was written for. */
  async #stop(task: Row): Promise<void> {
    await this.#b.workerOf(String(task.worker)).cancel?.(this.#b.env, String(task.id));
  }

  /** A terminal status is final: a late or repeated report cannot bring a task back. */
  #set(taskId: string, status: string, fields: { pending?: string | null; result?: string; last_progress?: string }): boolean {
    const current = this.#s.rows<Row>("SELECT status FROM tasks WHERE id = ?", taskId)[0];
    if (!current || TERMINAL_TASK.has(current.status)) return false;
    this.#s.sql.exec(
      "UPDATE tasks SET status = ?, pending = ?, result = COALESCE(?, result), last_progress = COALESCE(?, last_progress), updated_at = ? WHERE id = ?",
      status,
      fields.pending ?? null,
      fields.result ?? null,
      fields.last_progress ?? null,
      Date.now(),
      taskId,
    );
    // The watchdog has nothing left to watch.
    if (TERMINAL_TASK.has(status)) this.#s.sql.exec("UPDATE timers SET status = 'done' WHERE id = ? AND status = 'active'", `watch_${taskId}`);
    return true;
  }

  /**
   * Called by a worker to report. Reports are numbered by the worker; a repeat is ignored. Progress
   * only updates the task record. Anything the Brain has to react to also becomes an inbox event.
   */
  async event(taskId: string, seq: number, kind: WorkerEventKind, report: Record<string, unknown>): Promise<{ ok: boolean }> {
    let body = report;
    const outcome: { known: boolean; wake: boolean; terminal: boolean; spent?: number } = this.#s.transaction(() => {
      const task = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", taskId)[0];
      if (!task) return { known: false, wake: false, terminal: false };
      // A repeat means the worker never saw our acknowledgement. The work after the commit (waking
      // up, releasing the slot) may not have happened either, so it is done again; both are idempotent.
      if (this.#s.rows("SELECT 1 FROM task_events WHERE task_id = ? AND seq = ?", taskId, seq).length > 0) return { known: true, wake: true, terminal: TERMINAL_TASK.has(task.status) };
      this.#s.sql.exec("INSERT INTO task_events (task_id, seq, kind, body, at) VALUES (?, ?, ?, ?, ?)", taskId, seq, kind, JSON.stringify(body), Date.now());

      const text = typeof body.message === "string" ? body.message : typeof body.text === "string" ? body.text : "";
      let applied = true;
      if (kind === "progress") {
        if (!TERMINAL_TASK.has(task.status)) this.#s.sql.exec("UPDATE tasks SET last_progress = ?, updated_at = ? WHERE id = ?", text.slice(0, 500), Date.now(), taskId);
        return { known: true, wake: false, terminal: false };
      }
      if (kind === "recovered") return { known: true, wake: false, terminal: false };
      if (kind === "withdrawn") {
        // The held request gave up; its question no longer stands.
        if (task.status === "needs_input" && task.pending && JSON.parse(task.pending).id === body.id) {
          this.#s.sql.exec("UPDATE tasks SET status = 'running', pending = NULL, updated_at = ? WHERE id = ?", Date.now(), taskId);
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
        while (this.#s.rows("SELECT 1 FROM used_codes WHERE code = ?", code).length > 0) code = questionCode();
        this.#s.sql.exec("INSERT INTO used_codes (code, used_at) VALUES (?, ?)", code, Date.now());
        const what = describeRequest(body);
        const session = this.#s.rows<Row>("SELECT id FROM sessions WHERE session_key = ?", task.session_key)[0];
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
          this.#b.enqueue(ask, session.id, null, `Task "${task.title}" is paused and needs approval to ${what}\n\n${how}`, question);
        } catch {
          // No reply address: the question reaches nobody, so it cannot be approved.
          ask = undefined;
        }
        body = { ...body, code, asked_at: Date.now(), ask, delivered: ask !== undefined, what };
        applied = this.#set(taskId, "needs_input", { pending: JSON.stringify(body) });
      }
      else if (kind === "result" || kind === "failed" || kind === "lost") {
        // A task that ends while a question of its is still open leaves nothing to answer: the
        // question is closed where it is shown, so nobody presses a button that does nothing.
        applied = kind === "result" ? this.#set(taskId, "succeeded", { result: JSON.stringify(body) }) : this.#set(taskId, kind, { result: JSON.stringify(body) });
        if (applied) this.#setAside(task);
      }
      else return { known: true, wake: false, terminal: false };
      if (!applied) return { known: true, wake: false, terminal: false };

      // What the worker spent counts against the same daily budget as the Brain's own calls.
      const said = Number((body.usage as { total_tokens?: unknown } | undefined)?.total_tokens ?? 0);
      // Anything that is not a positive number of tokens is nothing spent, here and in the registry.
      const spent = Number.isFinite(said) && said > 0 ? said : 0;
      if (spent > 0) this.#b.spend(Math.min(spent, 50_000_000));
      if (kind === "lost" || kind === "failed") this.#s.log(`task_${kind}`, { task: taskId, error: String(body.error ?? "").slice(0, 300) });

      this.#s.insertEvent({
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
    if (outcome.spent) await this.#b.registry().recordUsage(this.#s.scope().tenant, outcome.spent).catch(() => undefined);
    if (outcome.terminal) await this.#b.registry().releaseTaskSlot(taskId);
    if (outcome.wake) await this.#b.wakeBy(Date.now() + 300);
    return { ok: outcome.known };
  }

  /**
   * Whether this text quotes the code of an approval question that is open in this conversation.
   * The whole text is searched, so a reply cannot be missed for being long.
   */
  async quotesOpenQuestion(text: string, sessionKey: string): Promise<boolean> {
    const codes = this.#s.rows<{ code: string | null }>(
      "SELECT json_extract(pending, '$.code') AS code FROM tasks WHERE status = 'needs_input' AND pending IS NOT NULL AND session_key = ?",
      sessionKey,
    );
    return codes.some(({ code }) => code && new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "i").test(text));
  }

  /**
   * Called when a question stops being the one its task is waiting on without an answer to it
   * having been confirmed: a newer question took its place, or the task ended or was cancelled.
   *
   * If no answer was ever sent for it, nothing was decided and it is closed as withdrawn. If one
   * was sent, the worker may hold a decision the Brain never heard back about; how the question
   * ended is then not guessed but asked of the worker (see `settle`).
   */
  #setAside(task: Row): void {
    if (task.status !== "needs_input" || !task.pending) return;
    const pending = JSON.parse(task.pending) as { id?: string; ask?: string };
    if (!pending.ask) return;
    const sent = task.answering ? (JSON.parse(task.answering) as { pending_id?: string }).pending_id === pending.id : false;
    if (!sent || !pending.id) return this.#closeQuestion(pending.ask, { state: "withdrawn" });
    this.#s.sql.exec("INSERT OR IGNORE INTO unsettled (ask, task_id, question_id, next_at) VALUES (?, ?, ?, ?)", pending.ask, task.id, pending.id, Date.now());
  }

  /**
   * Finds out from the worker how each set-aside question ended, and closes it as that. The
   * worker's record of a decision is the truth: it is what the guest was told. If the worker
   * cannot be reached, or still has the question open, it is asked again later.
   */
  async settle(): Promise<void> {
    for (const row of this.#s.rows<{ ask: string; task_id: string; question_id: string; attempts: number }>("SELECT * FROM unsettled WHERE next_at <= ? ORDER BY next_at LIMIT 20", Date.now())) {
      let fate: QuestionFate | { state: "unreachable"; error: string };
      try {
        fate = await this.#b.worker(row.task_id).decisionOn(row.question_id);
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
        this.#s.log("question_unsettled", { task: row.task_id, question: row.question_id, why: fate.state, ...("error" in fate ? { error: fate.error } : {}) });
        this.#s.audit("(system)", "task.answer_unverified", { task_id: row.task_id, question: row.question_id, why: fate.state });
        this.#closeQuestion(row.ask, { state: "unknown" });
      } else {
        // Still being waited on, or the worker could not be asked: look again later.
        this.#s.sql.exec("UPDATE unsettled SET attempts = attempts + 1, next_at = ? WHERE ask = ?", Date.now() + Math.min(30_000 * 2 ** row.attempts, 3_600_000), row.ask);
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
    this.#s.sql.exec("UPDATE outbox SET closed = ? WHERE idem = ? AND ask IS NOT NULL AND closed IS NULL", JSON.stringify(outcome), ask);
    this.#s.sql.exec("DELETE FROM unsettled WHERE ask = ?", ask);
    this.showClosed(ask);
  }

  /** Replaces a delivered question by its closed form. Never holds anything up. */
  showClosed(ask: string): void {
    const row = this.#s.rows<{ target: string; receipt: string | null; ask: string | null; closed: string | null }>("SELECT target, receipt, ask, closed FROM outbox WHERE idem = ?", ask)[0];
    if (!row?.receipt || !row.ask || !row.closed) return;
    this.#b.waitUntil(
      this.#b.amend(JSON.parse(row.target) as Target, JSON.parse(row.receipt) as Receipt, JSON.parse(row.ask) as ApprovalQuestion, JSON.parse(row.closed) as Outcome).catch((err) =>
        this.#s.log("question_not_closed", { ask, error: String(err).slice(0, 300) }),
      ),
    );
  }
}

/** What a held request would do, in words. Built from the worker's structured report. */
function describeRequest(body: Record<string, unknown>): string {
  return body.source === "proxy" ? `${String(body.summary ?? `${body.action} on ${body.resource}`)}.` : `run this command:\n${String(body.command ?? "")}`;
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
