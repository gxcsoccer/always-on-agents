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
import { type RefUpdate, standingEligible } from "../workers/questions";
import { type QuestionFate, clipResult } from "../workers/result";
import type { Started, Worker } from "../workers";
import type { Outbox } from "./outbox";
import { type WorkEnd, workIs } from "./work";
import { decidingReply, speaksAgainst, wantsStanding } from "./approval";
import type { Revisions } from "./revisions";
import { DEFAULT_LIMITS, type Limits, limitsFrom } from "../limits";
import { type BrainStore, type InboxRow, type Row, type RunRow, TERMINAL_TASK, type Wakes } from "./store";

// (How many tasks a scope may have under way is the tenant's limit: see ../limits. It is read
// from what the registry last said, kept by the run loop before every call to the model.)
/** How long after a task may have ended at the latest its watchdog says that it has not reported. */
const TASK_WATCHDOG_GRACE_S = 10 * 60;
/** How many times the worker is asked how a set-aside question ended before giving up on knowing. */
const SETTLE_ATTEMPTS = 12;
/** How often a task whose start was not answered is asked about before it is given up as lost: about a quarter of an hour in all. */
const CONFIRM_ATTEMPTS = 6;
/** How long after a start that was not answered the worker is first asked whether it has the task. */
const CONFIRM_FIRST_MS = 15_000;

/** How long one call to a worker is waited for when a start is being found out about. */
const CONFIRM_CALL_MS = 10_000;
/**
 * How long the hand-over waits for the worker to answer a start, both tries together. A start
 * answers once the sandbox is up and the repository cloned, which the sandbox itself gives five
 * minutes; past this the call is not waited for any more and the task is found out about.
 */
export const START_WAIT_MS = 6 * 60_000;
/** How long after a task was first written its worker may still take it for the first time. */
export const ACCEPT_WITHIN_MS = 15 * 60_000;

/** A call that is given up, as unanswered, once it has taken that long. What it answers later is not used. */
function within<T>(call: Promise<T>, ms = CONFIRM_CALL_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([call, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error("not answered in time")), ms)))]).finally(() => clearTimeout(timer));
}

/** Why a task whose worker could never be asked is ended. */
const NOT_KNOWN = "its worker could not be reached after the start was requested: it is not known whether it began, or what became of it";

/** What is said of a task whose start was not answered, wherever its standing is told. */
export const UNCONFIRMED_NOTE = "It is not known yet whether this began: the worker did not answer when it was started. It is being checked, and you will be told how it ends. Do not hand the same work over again; if the person asks, tell them it may or may not have started.";

/** What tasks need from the Brain they are part of, and from the systems outside it. */
export interface TasksHost {
  readonly env: Env;
  /** The worker listed under a name in this deployment, if it is: only such a one is given something new. */
  workerNamed(name: string): Worker | undefined;
  /** The worker a task was written for, listed or not: what was taken is carried through and can be stopped. */
  workerOf(name: string): Worker;
  /** Every worker this deployment offers for new work. */
  workers(): Worker[];
  /** The worker the tool from before there were several was for, if the deployment says which and still offers it. */
  firstWorker(): Worker | undefined;
  /** Where the tenant's places for tasks and its usage are kept. */
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

/** For how long finished work of a worker that can go on from it is listed as such: a little under the day its worker keeps what it left. */
const GOES_ON_FOR_MS = 23 * 60 * 60_000;
/** How many pieces of finished work are listed that way: the latest. */
const MAX_FINISHED_LISTED = 5;

/** What a task's last status is, as a piece of work. */
export const taskEnd = (status: string): WorkEnd => ({ succeeded: "done", failed: "failed", cancelled: "cancelled" } as Record<string, WorkEnd>)[status] ?? "unknown";

export class Tasks implements Wakes {
  readonly #s: BrainStore;
  readonly #r: Revisions;
  readonly #b: TasksHost;

  constructor(store: BrainStore, revisions: Revisions, host: TasksHost) {
    this.#s = store;
    this.#r = revisions;
    this.#b = host;
  }

  /**
   * How far a task may go, as kept with it. One from before that was kept goes by what held for
   * every task then (the defaults): its place with the tenant was taken for that long, whatever
   * the limits have become since.
   */
  #boundsOf(task: Row): { lifetime_ms: number; model_calls: number } {
    let kept: { lifetime_ms?: unknown; model_calls?: unknown } = {};
    try {
      kept = JSON.parse(this.#s.rows<{ bounds: string }>("SELECT bounds FROM task_bounds WHERE task_id = ?", task.id)[0]?.bounds ?? "{}") ?? {};
    } catch {
      kept = {};
    }
    const whole = (figure: unknown, otherwise: number) => (typeof figure === "number" && Number.isInteger(figure) && figure > 0 ? figure : otherwise);
    return { lifetime_ms: whole(kept.lifetime_ms, DEFAULT_LIMITS.task_minutes * 60_000), model_calls: whole(kept.model_calls, DEFAULT_LIMITS.task_model_calls) };
  }

  /** The tenant's limits as the registry last gave them to this scope; the defaults before it ever did. */
  #limits(): Limits {
    try {
      return limitsFrom(JSON.parse(this.#s.meta("limits") ?? "null"));
    } catch {
      return limitsFrom(null);
    }
  }

  /** When the earliest set-aside question, or task whose start was not answered, is to be asked about again. */
  nextWakeAt(_now: number): number | null {
    return this.#s.rows<{ next_at: number | null }>("SELECT MIN(next_at) AS next_at FROM (SELECT next_at FROM unsettled UNION ALL SELECT next_at FROM unconfirmed)")[0]?.next_at ?? null;
  }

  /**
   * Work that ended well in this conversation in the last day, asked for by the one person this
   * run is for, of a worker that can go on from it: the latest few, oldest first. It is theirs
   * alone to go on from, so it is listed for nobody else.
   */
  leftToGoOnFrom(runId: string, sessionKey: string): { id: string; worker: string; title: string }[] {
    const people = [...new Set(this.#b.deciders(runId).map((p) => p.id))];
    if (people.length !== 1) return [];
    return this.#s
      .rows<{ id: string; worker: string; title: string }>("SELECT id, worker, title FROM tasks WHERE status = 'succeeded' AND session_key = ? AND requested_by = ? AND updated_at > ? ORDER BY updated_at DESC LIMIT ?", sessionKey, people[0], Date.now() - GOES_ON_FOR_MS, MAX_FINISHED_LISTED)
      .filter((each) => this.#b.workers().some((worker) => worker.name === each.worker && worker.goes_on === true))
      .reverse();
  }

  /**
   * Hands a piece of work to a worker the Brain starts, and says how it then stands. `name` is
   * the worker it is for; null where the call does not say (a tool call from before there was
   * more than one): then the worker the deployment names for that tool (`firstWorker`), while it is offered. `options`
   * are that worker's own, and it is the worker that says whether they will do.
   */
  async dispatch(run: RunRow, sessionKey: string, callId: string, name: string | null, title: string, brief: string, options: Record<string, unknown>, from: string | null = null): Promise<unknown> {
    const scope = this.#s.scope();

    // The row is written before anything is started. A retry of this tool call finds it by op_id
    // and continues with the same task id, so a lost response can never start a second task.
    let task = this.#s.rows<Row>("SELECT * FROM tasks WHERE op_id = ?", callId)[0];
    // The same call made again: an earlier attempt at it may have got as far as starting the worker.
    const replayed = task !== undefined;
    // One that was written and has got past being started is told as it stands, before anything else is
    // looked at: also where its worker has since been taken out of the deployment altogether.
    if (task && task.status !== "dispatching") return this.#told(task);
    // What is asked of it is the worker's to look at, before anything is written or started. A call
    // that names no worker is the tool from before there were several: it goes to the worker the
    // deployment says that tool was for, if it still offers that one, and to no other.
    const offered = task ? undefined : name !== null ? this.#b.workerNamed(name) : this.#b.firstWorker();
    // Going on from an earlier piece of work: it has to be this conversation's, this worker's, and
    // one that ended well; and the worker has to be one that goes on at all. Whoever asks, and
    // whatever was approved then, are this new piece's own: nothing of the earlier one's is carried.
    if (!task && from !== null) {
      const earlier = this.#s.rows<Row>("SELECT worker, session_key, status, requested_by FROM tasks WHERE id = ?", from)[0];
      // Whose it was: the one person who asked for it, and it is theirs alone to go on from. Being in the same conversation is not enough.
      const people = [...new Set(this.#b.deciders(run.id).map((p) => p.id))];
      const asker = people.length === 1 ? people[0] : null;
      if (!offered?.goes_on) throw new Error(`the worker "${offered?.name ?? name}" cannot go on with an earlier piece of work; hand this over as something new, and say in the brief what it follows`);
      // (Work nobody in particular asked for, or a run that is not one person's, has nobody whose it is: it is not gone on from.)
      if (!earlier || asker === null || earlier.session_key !== sessionKey || earlier.worker !== offered.name || earlier.requested_by !== asker) throw new Error(`there is no piece of work ${JSON.stringify(from)} of this worker's to go on with here; nothing was started`);
      if (earlier.status !== "succeeded") throw new Error(`that piece of work ${TERMINAL_TASK.has(String(earlier.status)) ? "did not end well" : "has not ended yet"}, so there is nothing of it to go on from; ${TERMINAL_TASK.has(String(earlier.status)) ? "hand this over as something new" : "wait for it, or hand this over as something new"}`);
    }
    if (!task) {
      // Something new is taken only by a worker this deployment lists, and one that is started from here. Nothing is written for any other.
      if (!offered?.start) throw new Error("this deployment has no worker to hand this to");
      // (Only for something new: one already written was taken, and is not turned away by a check made again.)
      offered.accepts?.(options, scope);
      const WORKER = offered.name;
      const most = this.#limits().scope_active_tasks;
      if (this.#s.rows<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('dispatching', 'unconfirmed', 'running', 'needs_input')")[0].n >= most) {
        // Said as what it is where no task may be had here at all: there is none to wait for.
        if (most === 0) throw new Error("tasks cannot be handed to a worker here at present: the limit set for this place is none. Tell the person so; waiting or trying again will not change it");
        throw new Error(`there are already ${most} tasks running here; wait for one to finish or cancel one`);
      }
      const now = Date.now();
      // A task has a requester only when exactly one person asked. With several speakers in the
      // batch there is no telling whose request it was, so nobody is credited (and nobody can approve).
      const askers = [...new Set(this.#b.deciders(run.id).map((p) => p.id))];
      const requestedBy = askers.length === 1 ? askers[0] : null;
      const id = crypto.randomUUID();
      // The task and its row in the index of work exist together or not at all.
      this.#s.transaction(() => {
        this.#s.sql.exec(
          "INSERT INTO tasks (id, op_id, worker, title, brief, session_key, requested_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)",
          id,
          callId,
          WORKER,
          title,
          brief,
          sessionKey,
          requestedBy,
          now,
          now,
        );
        // How far it may go, by the tenant's limits as they stand at this moment: fixed here, for good.
        if (from !== null) this.#s.sql.exec("INSERT OR IGNORE INTO task_follows (task_id, from_id) VALUES (?, ?)", id, from);
        this.#s.sql.exec("INSERT OR IGNORE INTO task_bounds (task_id, bounds) VALUES (?, ?)", id, JSON.stringify({ lifetime_ms: this.#limits().task_minutes * 60_000, model_calls: this.#limits().task_model_calls }));
        workIs(this.#s, { id, worker: WORKER, sessionKey, person: requestedBy }, "open");
      });
      this.#s.sql.exec(
        "INSERT INTO timers (id, due_at, session_key, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        `watch_${id}`,
        // After the latest moment it may still be running: taken as late as it may be, and run for as long as it may.
        now + ACCEPT_WITHIN_MS + this.#limits().task_minutes * 60_000 + TASK_WATCHDOG_GRACE_S * 1_000,
        sessionKey,
        `Task ${id} "${title}" has not reported a result in time.`,
        JSON.stringify({ task_id: id }),
        now,
      );
      this.#s.audit(requestedBy ?? "(automation)", "task.dispatched", { ...options, task_id: id, title, ...(from !== null ? { continue_from: from } : {}) });
      task = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", id)[0];
    }
    // One that was written is one that was taken: it is carried through by the worker it was
    // written for, whether or not the deployment still lists that worker for new work.
    let worker: Worker;
    try {
      worker = this.#b.workerOf(String(task.worker));
    } catch {
      // Written for a worker the deployment no longer has at all. Whether an earlier attempt at this
      // call started it is not known and cannot be asked from here: it is kept as exactly that, and
      // given up in its time (see settle), rather than left as it is for ever holding a place here.
      this.#unconfirmed(task.id);
      await this.#b.wakeBy(Date.now() + CONFIRM_FIRST_MS);
      return this.#told(this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", task.id)[0]);
    }
    // How far this task may go, as it was fixed when it was written (one written before that was
    // kept: as every task could then). Its worker, its place and its watchdog go by the same figures.
    const bounds = this.#boundsOf(task);
    // Known here, before anything is asked of anyone: not something to find out about later.
    if (!worker.start) {
      this.#set(task.id, "failed", { result: JSON.stringify({ error: "this worker is not started by the Brain" }) });
      throw new Error("this worker cannot be started from here");
    }

    let slot: boolean | Error;
    try {
      slot = await this.#b.registry().acquireTaskSlot(scope.tenant, task.id, bounds.lifetime_ms);
    } catch (err) {
      slot = err instanceof Error ? err : new Error(String(err));
    }
    // The same call made again, for a task an earlier attempt may already have started. Read again
    // after the wait, whatever the registry said: what the worker reported meanwhile is what
    // happened, and nothing more is asked of it.
    if (replayed) {
      const now = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", task.id)[0];
      if (now.status !== "dispatching") {
        // A place just taken for one that has ended is given straight back: also where the registry
        // did not answer, since it may have taken one all the same.
        if (slot !== false && TERMINAL_TASK.has(String(now.status))) await this.#b.registry().releaseTaskSlot(task.id).catch(() => undefined);
        return this.#told(now);
      }
      if (this.#s.rows("SELECT 1 FROM task_events WHERE task_id = ? LIMIT 1", task.id).length > 0) {
        this.#s.sql.exec("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'dispatching'", Date.now(), task.id);
        return this.#told(this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", task.id)[0]);
      }
      // No place, and no word of it: whether it started is not known, and is found out rather than guessed.
      if (slot !== true) {
        this.#unconfirmed(task.id);
        await this.#b.wakeBy(Date.now() + CONFIRM_FIRST_MS);
        return this.#told(this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", task.id)[0]);
      }
    }
    if (slot !== true) {
      if (slot === false) {
        this.#set(task.id, "failed", { result: JSON.stringify({ error: "the tenant's limit of tasks at once is reached" }) });
        throw new Error("too many tasks are running for this tenant right now; try again later");
      }
      // The reservation may have been made even though its reply was lost; give it back.
      await this.#b.registry().releaseTaskSlot(task.id).catch(() => undefined);
      // The task must not be left "dispatching": nothing would ever pick it up again.
      this.#set(task.id, "failed", { result: JSON.stringify({ error: `the registry could not be reached: ${String(slot).slice(0, 300)}` }) });
      throw new Error("the worker could not be started; try again");
    }
    // The same start, made again, is the same piece of work (it is named by the id written before
    // anything was sent): so a start whose answer was lost is asked for once more, and is found.
    // The waiting has an end of its own, for both tries together: a call that neither answers nor
    // fails would otherwise leave the task as it is for ever. Past it the task is found out about.
    // What it goes on from is what was written with it when that was found to be allowed: a call
    // made again that says otherwise is not this call. (One written before this was kept goes on from nothing.)
    const follows = this.#s.rows<{ from_id: string }>("SELECT from_id FROM task_follows WHERE task_id = ?", task.id)[0]?.from_id ?? null;
    if (replayed && (task.session_key !== sessionKey || (from !== null && follows !== null && from !== follows))) throw new Error("this call was first made for something else; nothing further was started");
    // The worker may first take it only so long after it was first written, however often this is repeated.
    const until = Date.now() + START_WAIT_MS;
    const start = () => within(worker.start!(this.#b.env, { id: task.id, brief, options, brain: this.#s.scopeName(), accept_by: Number(task.created_at) + ACCEPT_WITHIN_MS, bounds, ...(follows !== null ? { continue_from: follows } : {}) }), Math.max(1, until - Date.now())).catch(() => undefined);
    const heard = () => this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", task.id)[0].status !== "dispatching" || this.#s.rows("SELECT 1 FROM task_events WHERE task_id = ? LIMIT 1", task.id).length > 0;
    let started: Started | undefined = await start();
    // Asked once more only if nothing was heard meanwhile, and there is time left to wait.
    if (!started && !heard() && Date.now() < until) started = await start();
    // Read again after the wait: the worker may have reported meanwhile, and what it reported is
    // what happened, whatever became of the answer to the call.
    const now = this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", task.id)[0];
    if (now.status !== "dispatching") return this.#told(now);
    if (started?.state === "refused") {
      this.#set(task.id, "failed", { result: JSON.stringify({ error: started.error }) });
      await this.#b.registry().releaseTaskSlot(task.id);
      throw new Error(`the worker did not start: ${started.error}`);
    }
    // Answered, or heard from in the meantime: it began.
    if (started || this.#s.rows("SELECT 1 FROM task_events WHERE task_id = ? LIMIT 1", task.id).length > 0) {
      this.#s.sql.exec("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'dispatching'", Date.now(), task.id);
      return this.#told(this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", task.id)[0]);
    }
    // Not answered, twice: whether the worker took it is not known. It is kept as exactly that,
    // with its place, and found out by asking the worker (see settle); nothing is stopped or
    // given back on a guess, and the model is not told to try again.
    this.#unconfirmed(task.id);
    await this.#b.wakeBy(Date.now() + CONFIRM_FIRST_MS);
    return this.#told(this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ?", task.id)[0]);
  }

  /** Keeps a task as one whose start was not answered, to be asked about. */
  #unconfirmed(taskId: string): void {
    this.#s.transaction(() => {
      this.#s.sql.exec("UPDATE tasks SET status = 'unconfirmed', updated_at = ? WHERE id = ? AND status = 'dispatching'", Date.now(), taskId);
      if (this.#s.rows("SELECT 1 FROM tasks WHERE id = ? AND status = 'unconfirmed'", taskId).length > 0) this.#s.sql.exec("INSERT OR IGNORE INTO unconfirmed (task_id, attempts, next_at) VALUES (?, 0, ?)", taskId, Date.now() + CONFIRM_FIRST_MS);
    });
  }

  /** How a task stands, as a call that made it (or made it again) is told. */
  #told(task: Row): { task_id: string; status: string; note?: string } {
    return { task_id: String(task.id), status: String(task.status), ...(task.status === "unconfirmed" ? { note: UNCONFIRMED_NOTE } : {}) };
  }

  async status(taskId: string): Promise<unknown> {
    const task = this.#s.rows<Row>("SELECT id, title, status, pending, last_progress, result, created_at, updated_at FROM tasks WHERE id = ?", taskId)[0];
    if (!task) throw new Error(`no task ${taskId} in this conversation's scope`);
    return {
      ...task,
      ...(task.status === "unconfirmed" ? { note: UNCONFIRMED_NOTE } : {}),
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
    // Known before anything is written: an answer nobody can be given is not recorded as given.
    const asking = this.#b.workerOf(String(task.worker));
    if (!asking.answer) throw new Error("the worker of this task takes no answers");
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

    const answered = await asking.answer(this.#b.env, taskId, intent.decision, intent.reason, intent.pending_id, intent.standing === true);
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
    // Only the worker's word that the work itself stopped counts: not that it cannot be stopped, nor that only the waiting ended.
    let worker: Worker;
    try {
      worker = this.#b.workerOf(String(task.worker));
    } catch {
      throw new Error("the worker of this task is no longer part of this deployment, so it cannot be asked to stop; whether it is still running is not known");
    }
    const how = await worker.cancel?.(this.#b.env, String(task.id));
    if (how !== "stopped") throw new Error("the worker did not say that this stopped");
  }

  /** A terminal status is final: a late or repeated report cannot bring a task back. */
  #set(taskId: string, status: string, fields: { pending?: string | null; result?: string; last_progress?: string }): boolean {
    const current = this.#s.rows<Row>("SELECT status, worker, session_key, requested_by FROM tasks WHERE id = ?", taskId)[0];
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
    if (TERMINAL_TASK.has(status)) workIs(this.#s, { id: taskId, worker: String(current.worker), sessionKey: String(current.session_key), person: (current.requested_by as string | null) ?? null }, taskEnd(status));
    // The watchdog has nothing left to watch.
    if (TERMINAL_TASK.has(status)) this.#s.sql.exec("UPDATE timers SET status = 'done' WHERE id = ? AND status = 'active'", `watch_${taskId}`);
    // However it left "not confirmed", there is nothing left to ask about.
    if (status !== "unconfirmed") this.#s.sql.exec("DELETE FROM unconfirmed WHERE task_id = ?", taskId);
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
      // (Whether there is a place to give back goes by what was reported, not by how the task stands here:
      // one ended here as lost, whose worker then repeats a mere progress report, has not been said to have ended.)
      const before = this.#s.rows<{ kind: string }>("SELECT kind FROM task_events WHERE task_id = ? AND seq = ?", taskId, seq)[0];
      if (before) return { known: true, wake: true, terminal: TERMINAL_TASK.has(task.status) && ["result", "failed", "lost"].includes(before.kind) };
      this.#s.sql.exec("INSERT INTO task_events (task_id, seq, kind, body, at) VALUES (?, ?, ?, ?, ?)", taskId, seq, kind, JSON.stringify(body), Date.now());

      const text = typeof body.message === "string" ? body.message : typeof body.text === "string" ? body.text : "";
      // What the worker spent counts against the same daily budget as the Brain's own calls.
      // Anything that is not a positive number of tokens is nothing spent, here and in the registry.
      const spend = () => {
        const said = Number((body.usage as { total_tokens?: unknown } | undefined)?.total_tokens ?? 0);
        const spent = Number.isFinite(said) && said > 0 ? said : 0;
        if (spent > 0) this.#b.spend(Math.min(spent, 50_000_000));
        return spent;
      };
      let applied = true;
      // Any word from the worker shows that it began: one whose start was not answered is running from here on.
      if (task.status === "unconfirmed" && (kind === "progress" || kind === "recovered")) {
        this.#s.sql.exec("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'unconfirmed'", Date.now(), taskId);
        this.#s.sql.exec("DELETE FROM unconfirmed WHERE task_id = ?", taskId);
      }
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
      // Not applied: the task had ended already. Where the worker says it has ended too, nothing
      // runs under it any more: one ended here as lost may still hold its place, and gives it back now.
      if (!applied) {
        // One ended here as lost, whose worker now reports how it really ended: it stays lost in
        // its conversation, but what it spent was spent, and is counted, once (a repeat of this
        // report is caught above).
        const late = task.status === "lost" && kind !== "needs_input";
        return { known: true, wake: false, terminal: late, spent: late ? spend() : 0 };
      }

      const spent = spend();
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
    await this.#confirm();
    for (const row of this.#s.rows<{ ask: string; task_id: string; question_id: string; attempts: number }>("SELECT * FROM unsettled WHERE next_at <= ? ORDER BY next_at LIMIT 20", Date.now())) {
      let fate: QuestionFate | { state: "unreachable"; error: string };
      try {
        const worker = this.#b.workerOf(String(this.#s.rows<Row>("SELECT worker FROM tasks WHERE id = ?", row.task_id)[0]?.worker ?? ""));
        // One that keeps no record of its questions cannot say: not to be found out.
        fate = worker.decisionOn ? await worker.decisionOn(this.#b.env, row.task_id, row.question_id) : { state: "unknown" };
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
   * Finds out whether each task whose start was not answered began, by asking its worker
   * whether it has it; a bounded number of times, whatever the model does or can spend.
   * - The worker has it, or has reported on it: it began, and goes on as any task.
   * - The worker never took it, and by saying so has closed it against a start that is still
   *   on its way: it never began and never will. Failed, its place given back, and said.
   * - The worker cannot be asked, to the last attempt: the waiting ends here. Lost, said as not
   *   known whether it began. Nothing more is asked of a worker that does not answer (a stop
   *   whose answer is lost settles nothing), and its place with the tenant is not given back
   *   on a guess: it lapses by its own time limit, which is longer than a sandbox can live, or
   *   is given back when the worker reports an ending after all.
   * No call to the worker is waited for longer than a fixed time.
   */
  async #confirm(): Promise<void> {
    for (const row of this.#s.rows<{ task_id: string; attempts: number }>("SELECT * FROM unconfirmed WHERE next_at <= ? ORDER BY next_at LIMIT 20", Date.now())) {
      const waiting = () => this.#s.rows<Row>("SELECT * FROM tasks WHERE id = ? AND status = 'unconfirmed'", row.task_id)[0];
      const reported = () => this.#s.rows("SELECT 1 FROM task_events WHERE task_id = ? LIMIT 1", row.task_id).length > 0;
      const began = () => {
        this.#s.sql.exec("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'unconfirmed'", Date.now(), row.task_id);
        this.#s.sql.exec("DELETE FROM unconfirmed WHERE task_id = ?", row.task_id);
      };
      const task = waiting();
      if (!task) {
        this.#s.sql.exec("DELETE FROM unconfirmed WHERE task_id = ?", row.task_id);
        continue;
      }
      if (reported()) {
        began();
        continue;
      }
      let standing: "there" | "none" | "unreachable";
      try {
        // (A worker that is no longer part of the deployment at all cannot be asked: as one that does not answer, not as something that stops everything else.)
        const worker = this.#b.workerOf(String(task.worker));
        standing = worker.standing ? await within(worker.standing(this.#b.env, row.task_id)) : "unreachable";
      } catch {
        standing = "unreachable";
      }
      // Read again after the wait: a report that came meanwhile is what happened.
      if (!waiting()) continue;
      if (standing === "there" || reported()) {
        began();
        continue;
      }
      const last = row.attempts + 1 >= CONFIRM_ATTEMPTS;
      if (standing === "none") {
        await this.#ended(task, "failed", "the worker never took it: it has no record of this task", true);
      } else if (standing === "unreachable" && last) {
        await this.#ended(task, "lost", NOT_KNOWN, false);
      } else {
        this.#s.sql.exec("UPDATE unconfirmed SET attempts = attempts + 1, next_at = ? WHERE task_id = ?", Date.now() + CONFIRM_FIRST_MS * 2 ** (row.attempts + 1), row.task_id);
      }
    }
  }

  /** Ends a task by the Brain's own finding, as a report from its worker would: recorded, said in its conversation, its place given back. */
  async #ended(task: Row, kind: "failed" | "lost", error: string, release: boolean): Promise<void> {
    const applied = this.#s.transaction(() => {
      if (!this.#set(String(task.id), kind, { result: JSON.stringify({ error }) })) return false;
      this.#setAside(task);
      this.#s.log(`task_${kind}`, { task: task.id, error });
      this.#s.insertEvent({
        source: "worker",
        source_id: `${task.id}:start`,
        kind: `worker.${kind}`,
        session_key: String(task.session_key),
        principal: { kind: "worker", id: String(task.id), explicit: false },
        text: renderWorkerEvent(task, kind, { error }),
        data: { task_id: task.id, error },
      });
      return true;
    });
    if (!applied) return;
    // Its place with the tenant is given back only where it is certain that nothing runs under it.
    if (release) await this.#b.registry().releaseTaskSlot(String(task.id)).catch(() => undefined);
    await this.#b.wakeBy(Date.now() + 300);
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
  // The Brain's own finding says why; a worker's report of a lost task means that where it ran stopped under it.
  return typeof body.error === "string" && body.error === NOT_KNOWN ? `${head} was lost: ${NOT_KNOWN}. Tell the person so; do not say that it ran, or that it did not.` : `${head} was lost: it stopped where it was running and could not be restored.`;
}
