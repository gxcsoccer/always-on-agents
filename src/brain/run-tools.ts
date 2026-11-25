/**
 * What a run's tools do: the Brain's own (memory, timers, messages, reviews) and the way into a
 * connector's tools, for one run. Built on the Brain's database; the requests part, the outbox and
 * the tasks part are handed in, and so is what only the run loop knows (whom the run acts for,
 * whether it may still use a tool, what it has read from outside). See tools.ts for how the model
 * is told about them and how a call is dispatched.
 */
import { type WorkEnd, workIs } from "./work";
import { type ConnectorTool, isSettled, isWaiting } from "../connectors";
import type { Env } from "../env";
import type { Worker } from "../workers";
import { chainLevels } from "../events";
import type { Outbox } from "./outbox";
import { MAX_LOADED_INDEX, MAX_LOADED_INSTRUCTIONS } from "./prompt";
import { type Acting, HANDLING_LIMIT_MS, type Requests, UNDER_WAY_NOTE, WAITING_NOTE } from "./requests";
import type { BrainStore, Row, RunRow } from "./store";
import type { Tasks } from "./tasks";
import { MAX_MESSAGE_TEXT, type ToolHost } from "./tools";

const MAX_ACTIVE_TIMERS = 50;
const MAX_MEMORY_FILES = 200;
const MEMORY_PATH = /^[a-z0-9][a-z0-9_\-/]{0,150}\.md$/;
export const SETTLED_NOTE = "The system has dealt with this itself and has told the person what they need to know. There is nothing more to do or say in this run.";
const SETTLED_SILENT = "This ends here. Nothing has been said to the person about it, and there is nothing more to do or say in this run.";
const UNUSABLE = { error: "the tool's answer could not be used; nothing was read and nothing waits" };
export const READ_OUTSIDE = "this run has read text from outside through a tool. From then on it can only reply to the person with send_message and read again; no other tool can be used in it. If the person wants something else done, they can ask for it in a new message";

/** What a run's tools need from the Brain they are part of. */
export interface RunToolsHost {
  readonly env: Env;
  /** Calls in this invocation whose result came from a connector's tool, until they are recorded. */
  readonly outside: Set<string>;
  /** The one person this run acts for, decided from what is stored. */
  actingFor(runId: string): Acting | undefined;
  /** Whether this run may still use a tool, given what it has read. */
  mayUse(runId: string, name: string): boolean;
  /** Who may be changing the standing instructions in this run; throws if nobody may. */
  instructionEditors(runId: string): string[];
  /** A connector's tools. */
  toolsOf(connector: string): ConnectorTool[];
  /** Every worker this deployment lists. */
  workers(): Worker[];
  /** Whether a piece of work done in a person's name still stands under what it was done under. */
  workStands(work: { id: string; state: string; condition: string | null; generation: number | null }): Promise<boolean>;
  readonly requests: Pick<Requests, "continuationOf" | "mayCancel" | "cancel" | "basis" | "endRequest" | "noteSource" | "wait" | "draft" | "record" | "indexed" | "promised">;
  readonly outbox: Pick<Outbox, "enqueue" | "notify" | "notice" | "isNotice">;
  readonly tasks: Pick<Tasks, "dispatch" | "status" | "answer" | "cancel">;
}

export class RunTools {
  readonly #s: BrainStore;
  readonly #b: RunToolsHost;

  constructor(store: BrainStore, host: RunToolsHost) {
    this.#s = store;
    this.#b = host;
  }

  /** The tools of this run. */
  /**
   * Whether the person's messages reply to one of the agent's own answers in this conversation,
   * as it reached them, and if so the one thing every such answer was written from that the
   * person can still point at (see eligibleSource); none when there is no such single thing.
   */
  #answering(run: RunRow, acting: Acting, kept = false): { answering?: { source?: Record<string, unknown>; nothing?: true } } {
    // Which answer of the agent's each message points at: the message it replies to, or the
    // nearest one further up the chain of replies it stands in, as long as nothing of the
    // person's own in between names a document itself (what they link comes first).
    const delivered = (subject: unknown): subject is string => typeof subject === "string" && this.#s.rows("SELECT 1 FROM said WHERE session_id = ? AND receipt_subject = ? LIMIT 1", run.session_id, subject).length > 0;
    const naming = (source: string, subject: string, person: unknown): boolean => {
      const prefix = `${source}:message:`;
      // Only in this conversation, as everything else that follows the chain.
      const row = subject.startsWith(prefix) ? this.#s.rows<{ data: string | null; principal: string }>("SELECT i.data, i.principal FROM inbox i WHERE i.source = ? AND i.source_id = ? AND i.session_key = (SELECT session_key FROM sessions WHERE id = ?) LIMIT 1", source, subject.slice(prefix.length), run.session_id)[0] : undefined;
      const documents = row && (JSON.parse(row.principal) as { id?: unknown }).id === person ? (JSON.parse(row.data ?? "{}") as { documents?: unknown }).documents : undefined;
      return Array.isArray(documents) && documents.length > 0;
    };
    const subjects = this.#b.requests
      .basis(run.id)
      .map((each) => {
        const data = JSON.parse(each.data ?? "{}") as { replies_to?: unknown; quoted?: { documents?: unknown } };
        const person = (JSON.parse(each.principal ?? "{}") as { id?: unknown }).id;
        const levels: { subject?: unknown; documents?: unknown }[] = [{ subject: data.replies_to, documents: data.quoted?.documents }, ...chainLevels(data as Record<string, unknown>)];
        for (const level of levels) {
          if (delivered(level.subject)) return level.subject;
          if (typeof level.subject !== "string" || (Array.isArray(level.documents) && level.documents.length > 0) || naming(String(each.source ?? ""), level.subject, person)) break;
        }
        return data.replies_to;
      })
      .filter((each): each is string => typeof each === "string");
    if (subjects.length === 0) return {};
    const answers = this.#s.rows<{ reads: string; person: string | null }>("SELECT reads, person FROM said WHERE session_id = ? AND receipt_subject IN (SELECT value FROM json_each(?))", run.session_id, JSON.stringify(subjects));
    if (answers.length === 0) return {};
    // Written from nothing read, every one of them: they point at nothing.
    // (And every message replied to has to be such an answer: a reply to anything else as well
    // keeps what that one points at.)
    if (answers.length === new Set(subjects).size && answers.every((each) => (JSON.parse(each.reads) as Read[]).length === 0)) return { answering: { nothing: true } };
    const sources = answers.map((each) => eligibleSource(JSON.parse(each.reads) as Read[], acting, this.#b.toolsOf, each.person, kept));
    const one = sources.every((each) => each !== undefined && each.identity === sources[0]!.identity) ? sources[0] : undefined;
    return { answering: one ? { source: one.request } : {} };
  }

  /**
   * A piece of work the run may ask about or stop, by its id: a task, as tasks always were; or
   * work done in a person's name, which is that person's alone and in the conversation it was
   * handed over in. Told from what is kept of it on either side: a request kept before there
   * was an index has its row made now; one that never waited has only its row.
   */
  async #work(run: RunRow, sessionKey: string, id: string): Promise<{ task: true } | { task: false; worker: string; state: string; standing: string; waits?: "authorisation" | "result"; handed: boolean }> {
    if (this.#s.rows("SELECT 1 FROM tasks WHERE id = ?", id).length > 0) return { task: true };
    const record = this.#b.requests.record(id);
    if (record) this.#b.requests.indexed(id);
    const row = this.#s.rows<{ worker: string; state: string; session_key: string; person: string | null; condition: string | null; generation: number | null; handed: number }>("SELECT worker, state, session_key, person, condition, generation, handed FROM work WHERE id = ?", id)[0];
    // Nor one done under an authorisation since taken away: it is as if it were not there.
    if (!row || row.session_key !== sessionKey || row.person === null || row.person !== this.#b.actingFor(run.id)?.person || !(await this.#b.workStands({ id, ...row }))) throw new Error(`there is no piece of work ${id} here`);
    // What it waits for, where it waits: for the person (something was put before them), or for the worker.
    const waits = row.state === "open" && record && record.status === "waiting" ? (record.interaction !== "" ? "authorisation" : "result") : undefined;
    // Whether it was ever handed over, by the record: waiting for the person again does not undo that.
    // (As whoever carries it out said when it was kept; or, for one kept before that was recorded, as the person was told.)
    const handed = row.handed === 1 || waits === "result" || (record !== undefined && this.#b.requests.promised(id));
    return { task: false, worker: row.worker, state: row.state, standing: standingOf(row.state, waits, handed), handed, ...(waits ? { waits } : {}) };
  }

  /**
   * Whether, in a conversation several people share, this run was given work done in one person's
   * own name to read: exactly the runs whose instructions listed such work (the Runner notes it
   * as it puts the list together). A person whose work there is not listed (called off, failed,
   * no longer standing, or not yet said in the conversation) is held to nothing by it.
   */
  #personalHere(run: RunRow): boolean {
    return this.#s.scope().kind === "chat" && this.#s.meta(`personal:${run.id}`) !== undefined;
  }

  for(run: RunRow): ToolHost {
    const session = this.#s.rows<Row>("SELECT * FROM sessions WHERE id = ?", run.session_id)[0];
    const sql = this.#s.sql;
    /** Calls a waiting request of the person's off. */
    const callOff = (callId: string, requestId: string, ask: string) => {
      const chosen = this.#b.requests.mayCancel(run, requestId, callId, ask);
      this.#b.requests.cancel(chosen.record, callId, chosen.choosing);
      return { ok: true, cancelled: chosen.record.id, note: "It will not be carried on and nothing of it will be sent. Tell the person it has been cancelled." };
    };
    const host: ToolHost = {
      connectorTool: async (callId, name, args) => {
        // Decided afresh at the moment of use, from what is stored: also after an interruption.
        const acting = this.#b.actingFor(run.id);
        const found = acting && toolsIn(acting, this.#b.toolsOf).find((each) => each.name === name);
        if (!acting || !found) throw new Error(`there is no tool "${name}" in this run`);
        const carried = this.#b.requests.continuationOf(run.id);
        // A run that carries a request on makes one call: the one made for it, with what the
        // request was made with. Nothing the model asks for in such a run is carried out.
        if (carried && (carried.status !== "resuming" || carried.call_id !== callId || carried.tool !== name)) throw new Error("this run can only answer the request it carries on");
        // A call that was told to wait has that for its answer, also when the run is replayed
        // after an interruption: the connector is not asked a second time, whatever has happened
        // since. Carrying the request on is another run's to do.
        // The same for a call that was answered with a request another call of the run had already made.
        const folded = carried ? undefined : (JSON.parse(this.#s.meta(`waited:${callId}`) ?? "null") as { request: string } | null)?.request;
        if (!carried && (folded !== undefined || this.#s.rows("SELECT 1 FROM continuations WHERE id = ?", callId).length > 0)) {
          this.#s.sql.exec("UPDATE runs SET closed = 'waited' WHERE id = ? AND closed IS NULL", run.id);
          const shown = this.#s.rows<{ interaction: string }>("SELECT interaction FROM continuations WHERE id = ?", folded ?? callId)[0]?.interaction !== "";
          return { waiting: true, request: folded ?? callId, note: shown ? WAITING_NOTE : UNDER_WAY_NOTE };
        }
        // A tool that carries a worker is that worker's way in, under whatever name it is called:
        // something new goes through it only where the run has that worker. (What was already
        // asked for is carried on above and below, whether or not the worker is still listed.)
        if (found.hands_to && !carried && !workersIn(acting, this.#b.toolsOf, this.#b.workers()).some((each) => each.tool === name)) throw new Error(`there is no worker to hand this to here`);
        const key = carried ? carried.id : callId;
        const { replaces, ...asked } = args;
        // (A new call names it in one way only, the one checked here: what a kept request was kept with is not for a new call to give.)
        // (Given in that other way, it is not dropped and the work then handed over as something new: nothing is sent.)
        if (found.hands_to && !carried && asked.from != null) {
          if (asked.continue_from == null) throw new Error("the earlier piece of work to go on with is named in continue_from; nothing was sent");
          delete asked.from;
        }
        // An earlier piece of work named to go on with has to be this person's own, handed to
        // this worker in this conversation, and still standing: checked here, against the Brain's
        // own record, whatever name the tool was called under. Anything else is not gone on with
        // and nothing is sent; it is not turned into something new, nor into another piece.
        // (A request carried on goes to what it was kept with.)
        if (found.hands_to && !carried && asked.continue_from != null) {
          const from = typeof asked.continue_from === "string" ? asked.continue_from : "";
          const row = this.#s.rows<{ worker: string; state: string; session_key: string; person: string | null; condition: string | null; generation: number | null }>("SELECT worker, state, session_key, person, condition, generation FROM work WHERE id = ?", from)[0];
          if (!row || row.worker !== found.hands_to || row.session_key !== String(session.session_key) || row.person !== acting.person || !(await this.#b.workStands({ id: from, ...row }))) {
            throw new Error(`there is no piece of work ${JSON.stringify(from)} of this worker's to go on with here (it is not one of this person's listed here, or it can no longer be gone on with); nothing was sent. If it is the piece they meant, tell them it cannot be gone on with; it is handed over as something new only if they then ask for that`);
          }
        }
        const given = carried ? (JSON.parse(carried.args) as Record<string, unknown>) : asked;
        // In place of a request that still waits: that one ends in the same step this one is kept
        // or done. Ending a request changes something, so it needs what calling one off needs,
        // decided here and before anything is read: a run that has read outside text may not.
        const replacing = !carried && typeof replaces === "string" && replaces !== "";
        if (replacing && !this.#b.mayUse(run.id, "cancel_request")) throw new Error(READ_OUTSIDE);
        const replaced = replacing ? this.#b.requests.mayCancel(run, replaces as string, callId) : undefined;
        // Which earlier messages of the person the tool acted on, as it says itself.
        const relied = new Set<number>();
        const named = new Set<number>();
        let identified: { request: Record<string, unknown>; identity: string; under: { condition: string; generation: number } } | undefined;
        const evidence = () => {
          const said = this.#b.requests.basis(run.id).map((each) => each.id);
          const recent = [...relied].map((index) => acting.recentIds[index]).filter((each) => each !== undefined);
          // `bound`: the messages the tool said its action rests on. A reply to one of these is about this request.
          return { said, recent, bound: [...[...named].map((index) => said[index]).filter((each) => each !== undefined), ...recent] };
        };
        const notAfter = (carried?.claimed_at ?? 0) + HANDLING_LIMIT_MS;
        if (carried && Date.now() > notAfter) {
          this.#b.requests.endRequest(carried.id, "void", "it was not finished in time");
          throw new Error("this request was not finished in time; nothing was read. The person can ask again");
        }
        // Whatever comes back is from outside, including an error that quotes something.
        this.#b.outside.add(callId);
        // Which tool and for whom. Not its arguments: they can name what the person is reading.
        this.#s.audit(acting.person, "tool.used", { tool: name, call: key });
        let waits = false;
        try {
          const handsTo = found.hands_to;
          // How the tool says the piece of work stands: kept once it is known what became of the
          // call. One that waits is recorded with the request it is kept as (or not at all, where
          // it turns out to be a request already kept, or cannot be kept).
          let standing: "open" | WorkEnd | undefined;
          const work = handsTo ? { work: (as: "open" | WorkEnd) => void (standing = as) } : {};
          const result = await found.run({ ...work, env: this.#b.env, scope: this.#s.scope(), person: acting.person, origin: acting.origin, said: acting.said, recent: acting.recent, ...this.#answering(run, acting, carried !== undefined), callId: key, relied: (from, index) => void (from === "said" ? named : relied).add(index), identified: (request, identity, under) => void (identified = { request, identity, under }), ...(carried ? { resuming: { generation: carried.generation, notAfter } } : {}) }, given);
          // A tool that says it waits and does not say it whole has not answered: what it gave is
          // not passed on (it can name the way in), nothing is kept, and nothing else is changed.
          if (typeof result === "object" && result !== null && "waiting" in result && !isWaiting(result)) return UNUSABLE;
          // The same for one that says the matter ends here: said whole, and naming a line the system has, or not at all.
          if (typeof result === "object" && result !== null && "settled" in result) {
            const say = isSettled(result) ? result.settled.say : null;
            if (say === null || (say !== undefined && !this.#b.outbox.isNotice(say))) return UNUSABLE;
            // Nothing was read. The run is closed and the line queued in one step, so a run that
            // is interrupted here is either still open with nothing said, or closed with it said.
            // (Only once that step has been kept is the call no longer counted as one that read.)
            this.#s.transaction(() => {
              this.#s.sql.exec("UPDATE runs SET closed = 'settled' WHERE id = ?", run.id);
              if (carried) this.#b.requests.endRequest(carried.id, "void", "the tool settled it");
              // The system's line, not this run's: it is not held back with what the run wrote.
              // A request being carried on is told where it was asked, not wherever the conversation points by now.
              if (say === undefined || !this.#b.outbox.isNotice(say)) return;
              const text = this.#b.outbox.notice(say, run.session_id);
              try {
                // A failure to keep the line undoes the whole step: the run is not closed with nothing said.
                this.#b.outbox.enqueue(`settled:${run.id}`, run.session_id, null, text, undefined, undefined, carried ? { target: carried.target } : undefined);
              } catch (err) {
                // Only where there is nowhere to say it at all is it left unsaid.
                if (!(err instanceof Error) || !err.message.startsWith("there is nowhere to send")) throw err;
              }
            });
            waits = true;
            this.#b.outside.delete(callId);
            return { settled: true, note: say === undefined ? SETTLED_SILENT : SETTLED_NOTE };
          }
          if (!isWaiting(result)) {
            if (handsTo && standing) workIs(this.#s, { id: key, worker: handsTo, sessionKey: String(session.session_key), person: acting.person }, standing);
            if (replaced) this.#b.requests.cancel(replaced.record, callId, replaced.choosing);
            // What was read, for a later follow-up; a refusal or an error is not something read.
            // Only what the tool itself identified: its canonical call and the thing as resolved.
            const read = identified as { request: Record<string, unknown>; identity: string; under: { condition: string; generation: number } } | undefined;
            if (read && typeof result === "object" && result !== null && !("error" in result)) {
              this.#b.requests.noteSource(run.id, { connector: acting.connector, tool: name, args: JSON.stringify(read.request), identity: read.identity, ...read.under });
            }
            return result;
          }
          // Nothing was read. The answer the model gets is written here, not by the tool.
          const kept = this.#b.requests.wait(run, { connector: acting.connector, person: acting.person, origin: acting.origin, events: evidence() }, key, name, result.waiting, replaced ? { ...replaced, by: callId } : undefined);
          // Only once the request is kept: one that could not be is an ordinary failure of the call.
          waits = true;
          this.#b.outside.delete(callId);
          // From here the run can only reply and read again, as after reading: what it could not
          // read here it must not go and fetch some other way.
          if (!carried) this.#s.sql.exec("UPDATE runs SET closed = 'waited' WHERE id = ? AND closed IS NULL", run.id);
          return kept;
        } finally {
          // What this run has already written to send, and whatever it writes from here on.
          if (!waits) this.#s.sql.exec("UPDATE outbox SET private = 1 WHERE run_id = ?", run.id);
        }
      },
      sendMessage: (callId, text) => {
        const carried = this.#b.requests.continuationOf(run.id);
        if (!carried) {
          return this.#b.outbox.enqueue(`msg:${callId}`, run.session_id, run.id, text, undefined, undefined, { authored: true });
        }
        // Everything such a run says belongs to the request it carries on. That request has one
        // answer, kept as a draft until the run ends; one that is waiting again has none.
        if (carried.status !== "resuming") return { ok: true, note: "nothing was sent: the request is not being answered now" };
        return this.#b.requests.draft(carried, run, text, true);
      },
      // A piece of work handed to a worker is called off as that, whichever of the two tools named it:
      // what is said of it then (stopped, or only no longer waited for) is the same either way.
      cancelRequest: (callId, requestId, ask) => (this.#s.rows("SELECT 1 FROM work WHERE id = ?", requestId).length > 0 ? host.cancelWork(callId, requestId) : callOff(callId, requestId, ask)),
      sendReview: (callId, summary, commit, comments) => {
        // The same review in words, for wherever comments cannot be attached to lines.
        const said = [summary, ...comments.map((c) => `${c.path}:${c.line}\n${c.body}`)].join("\n\n");
        if (said.length > MAX_MESSAGE_TEXT) throw new Error(`the review is too long: summary and comments together must stay within ${MAX_MESSAGE_TEXT} characters`);
        return this.#b.outbox.enqueue(`msg:${callId}`, run.session_id, run.id, said, undefined, { summary, ...(commit ? { commit } : {}), comments }, { authored: true });
      },

      memoryList: () => ({ files: this.#s.rows("SELECT path, LENGTH(content) AS size, updated_at FROM memory ORDER BY path") }),
      memoryRead: (path) => {
        const row = this.#s.rows<Row>("SELECT content FROM memory WHERE path = ?", path)[0];
        if (!row) throw new Error(`no memory file at ${path}`);
        return { path, content: row.content };
      },
      memoryWrite: (path, content) => {
        if (!MEMORY_PATH.test(path) || path.includes("..")) throw new Error("path must look like notes/topic.md: lowercase letters, digits, - _ /");
        // Where several people talk, memory is everyone's. A run that has before it something done
        // in one person's name there (it is listed for them, or was called for) writes none of it down.
        if (this.#personalHere(run)) throw new Error("this run has to do with work done in one person's own name; nothing is written to this conversation's shared memory in it");
        // instructions.md is read as instructions in every later run, so only a person who is a
        // member here may cause it to change. Text from a PR, a CI log or a worker cannot.
        if (path === "instructions.md") this.#s.audit(this.#b.instructionEditors(run.id).join(","), "instructions.changed", { length: content.length });
        const exists = this.#s.rows("SELECT 1 FROM memory WHERE path = ?", path).length > 0;
        if (!exists && this.#s.rows<{ n: number }>("SELECT COUNT(*) AS n FROM memory")[0].n >= MAX_MEMORY_FILES) throw new Error("memory is full; delete something first");
        sql.exec("INSERT INTO memory (path, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at", path, content, Date.now());
        // Said at the moment it happens, so the file is shortened by the run that made it long.
        const limit = path === "index.md" ? MAX_LOADED_INDEX : path === "instructions.md" ? MAX_LOADED_INSTRUCTIONS : undefined;
        if (limit !== undefined && content.trim().length > limit) return { ok: true, path, note: `saved, but only the first ${limit} characters of ${path} are loaded into a run; shorten it, and move detail into other files` };
        return { ok: true, path };
      },
      memoryDelete: (path) => {
        if (path === "instructions.md") this.#s.audit(this.#b.instructionEditors(run.id).join(","), "instructions.deleted", {});
        const existed = this.#s.rows("SELECT 1 FROM memory WHERE path = ?", path).length > 0;
        sql.exec("DELETE FROM memory WHERE path = ?", path);
        return { ok: true, deleted: existed };
      },

      setTimer: (callId, delaySeconds, note, repeat) => {
        if (delaySeconds < 5 || delaySeconds > 366 * 86_400) throw new Error("delay_seconds must be between 5 and one year");
        if (repeat !== null && repeat < 60) throw new Error("repeat_every_seconds must be at least 60");
        const id = `tmr_${callId.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`;
        if (this.#s.rows("SELECT 1 FROM timers WHERE id = ?", id).length === 0 && this.#s.rows<{ n: number }>("SELECT COUNT(*) AS n FROM timers WHERE status = 'active'")[0].n >= MAX_ACTIVE_TIMERS) {
          throw new Error("too many active timers; cancel one first");
        }
        const due = Date.now() + delaySeconds * 1_000;
        sql.exec("INSERT OR IGNORE INTO timers (id, due_at, every_s, session_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, due, repeat, session.session_key, note, Date.now());
        // A replayed call set nothing new: it is told when the timer it set fires next, or, if
        // that timer has fired for the last time or been cancelled since, that it will not.
        const stored = this.#s.rows<{ due_at: number; status: string }>("SELECT due_at, status FROM timers WHERE id = ?", id)[0];
        if (stored.status !== "active") return { ok: true, id, status: stored.status };
        return { ok: true, id, fires_at: new Date(stored.due_at).toISOString() };
      },
      listTimers: () => ({
        timers: this.#s.rows<Row>("SELECT id, due_at, every_s, note FROM timers WHERE status = 'active' AND data IS NULL ORDER BY due_at").map((t) => ({
          id: t.id,
          fires_at: new Date(t.due_at).toISOString(),
          repeat_every_seconds: t.every_s,
          note: t.note,
        })),
      }),
      cancelTimer: (id) => {
        const active = this.#s.rows("SELECT 1 FROM timers WHERE id = ? AND status = 'active' AND data IS NULL", id).length > 0;
        if (active) sql.exec("UPDATE timers SET status = 'cancelled' WHERE id = ?", id);
        return { ok: true, cancelled: active };
      },

      handOver: async (callId, name, title, brief, options, continueFrom, replaces) => {
        // A call made before and made again is the piece of work it was, whatever the deployment lists now.
        if (this.#s.rows("SELECT 1 FROM tasks WHERE op_id = ?", callId).length > 0) {
          const again = (await this.#b.tasks.dispatch(run, session.session_key, callId, title, brief, typeof options.repository === "string" ? options.repository : null)) as { task_id: string; status: string };
          return { work_id: again.task_id, status: again.status };
        }
        const kept = this.#b.requests.record(callId) ?? this.#b.requests.record((JSON.parse(this.#s.meta(`waited:${callId}`) ?? "null") as { request?: string } | null)?.request ?? "");
        if (kept) return host.connectorTool(callId, kept.tool, { brief, continue_from: continueFrom, replaces });
        const worker = workersIn(this.#b.actingFor(run.id), this.#b.toolsOf, this.#b.workers()).find((each) => each.name === name);
        if (!worker) throw new Error(`there is no worker "${name}" to hand this to here`);
        // Each worker has its own options and no other's.
        const foreign = Object.entries(options).filter(([key, value]) => value != null && !(key in (worker.options ?? {})));
        if (foreign.length > 0) throw new Error(`the worker "${name}" has no option ${foreign.map(([key]) => key).join(", ")}; leave it null`);
        // Carried by a connector's tool: that tool is called for it, and what it cannot do yet waits as its request.
        if (worker.tool) return host.connectorTool(callId, worker.tool, { brief, continue_from: continueFrom, replaces });
        // Said before anything is started: a worker the Brain starts does not take a waiting request's place.
        if (replaces !== null) throw new Error(`the worker "${name}" cannot take the place of a request that waits; if the person no longer wants that one, call it off first, then hand this over`);
        if (continueFrom !== null) throw new Error(`the worker "${name}" cannot go on with an earlier piece of work; hand this over as something new, and say in the brief what it follows`);
        const started = (await this.#b.tasks.dispatch(run, session.session_key, callId, title, brief, typeof options.repository === "string" ? options.repository : null)) as { task_id: string; status: string };
        return { work_id: started.task_id, status: started.status };
      },
      workStatus: async (workId) => {
        const work = await this.#work(run, session.session_key, workId);
        // Work done in a person's name: how it stands, and nothing of what it brought back.
        return work.task ? this.#b.tasks.status(workId) : { work_id: workId, worker: work.worker, state: work.standing };
      },
      cancelWork: async (callId, workId) => {
        const work = await this.#work(run, session.session_key, workId);
        if (work.task) return this.#b.tasks.cancel(session.session_key, workId);
        if (work.state !== "open" || !work.waits) return { ok: true, work_id: workId, state: work.standing, note: work.state === "open" ? "It is being finished just now and cannot be stopped at this moment." : work.state === "cancelled" && work.handed ? "It was already called off here: nothing of it will be brought back. It had been handed over, so the worker may still finish it over there: tell the person that, not that it was stopped." : "It had already ended; there was nothing to stop." };
        // The request that carries it is called off, as any request of the person's is.
        const off = callOff(callId, workId, "") as { cancelled?: string };
        if (off.cancelled !== workId) return off;
        // Whether the work itself stopped, or only the waiting for it here.
        return !work.handed
          ? { ok: true, cancelled: workId, how: "stopped", note: "It had not been handed over yet and will not be. Tell the person so." }
          : { ok: true, cancelled: workId, how: "no_longer_waited_for", note: "Nothing of it will be brought back here. The worker may still finish it over there: tell the person that, not that it was stopped." };
      },
      dispatchTask: async (callId, title, brief, repository) => {
        return this.#b.tasks.dispatch(run, session.session_key, callId, title, brief, repository);
      },
      taskStatus: (taskId) => this.#b.tasks.status(taskId),
      answerTask: (callId, taskId, decision, reason) => this.#b.tasks.answer(run, session.session_key, callId, taskId, decision, reason),
      cancelTask: (taskId) => this.#b.tasks.cancel(session.session_key, taskId),
    };
    return host;
  }
}

type Read = { connector: string; tool: string; args: string; identity: string };

/** The connector's tools that may be used for this person where they are: all of them in private, and where several people talk only those that say so. */
/**
 * The workers a run can hand work to: those the Brain starts, and those carried by a connector's
 * tool where the run has that tool (so one done in a person's name is there only for a person it
 * is offered to).
 */
export function workersIn(acting: Parameters<typeof toolsIn>[0] | undefined, toolsOf: (connector: string) => ConnectorTool[], all: Worker[]): Worker[] {
  const tools = acting ? toolsIn(acting, toolsOf).map((each) => each.name) : [];
  return all.filter((each) => (each.tool ? tools.includes(each.tool) : each.start !== undefined));
}

/** How a piece of work done in a person's name stands, in words for the model: what it waits for while it is under way, or how it ended. */
export function standingOf(state: string, waits?: "authorisation" | "result", handed = false): string {
  // Called off here after it was handed over: this side stopped waiting, and what became of it over there is not known.
  if (state === "cancelled" && handed) return "cancelled (no longer waited for here; it had been handed over, and the worker may still have finished it over there)";
  return state !== "open" ? state : waits === "authorisation" ? (handed ? "waiting_for_authorisation (it was handed over already, or may have been; the person has to authorise again before it can go on; they were shown how)" : "waiting_for_authorisation (not handed over yet: the person has to authorise it first; they were shown how)") : waits === "result" ? "waiting_for_result (handed over; the worker is at it)" : "under way";
}

export function toolsIn(acting: Pick<Acting, "connector" | "shared"> & { said?: { data: Record<string, unknown> }[] }, toolsOf: (connector: string) => ConnectorTool[]): ConnectorTool[] {
  // An optional tool: only where every message the run acts on was marked, as it arrived, as one it is offered for.
  const offered = (name: string) => acting.said !== undefined && acting.said.length > 0 && acting.said.every((each) => Array.isArray(each.data.offered) && each.data.offered.includes(name));
  // Where several people talk: a tool that says it may be used there. One that is there for
  // everyone the connector lets it be (not optional) needs the connector's word on each message;
  // an optional one is there by being offered for each message.
  const allowed = acting.said === undefined || acting.said.every((each) => each.data.shared === true);
  return toolsOf(acting.connector).filter((each) => (!acting.shared || (each.shared === true && (each.optional === true || allowed))) && (!each.optional || offered(each.name)));
}

/**
 * The one thing an answer was written from, if it was written from exactly one, and the person
 * can still point at it: linked by them in the messages the run acts on or in their own earlier
 * messages here (as the tool that read it judges). None for an answer written from nothing read,
 * from several (even if only one of them is still in reach), or from one they linked too long ago.
 */
export function eligibleSource(reads: Read[], acting: Acting | undefined, toolsOf: (connector: string) => ConnectorTool[], writtenFor?: string | null, kept = false): { tool: string; request: Record<string, unknown>; identity: string } | undefined {
  if (!acting) return undefined;
  // An answer written for someone else is something that was said here, and no more: what it
  // was read from is not this person's to have read again on its strength. Where several people
  // talk, whom it was written for has to be on record; in a person's own conversation an answer
  // from before that was kept is theirs. (Not given: not asked, as by a caller with no answer in hand.)
  if (writtenFor !== undefined && (acting.shared ? writtenFor !== acting.person : writtenFor !== null && writtenFor !== acting.person)) return undefined;
  const own = [...acting.said, ...acting.recent];
  const tools = toolsIn(acting, toolsOf);
  // An answer written from several things rests on all of them: none of them alone is its source,
  // whichever of them the person can still point at.
  const distinct = [...new Map(reads.map((each) => [`${each.connector}\u0000${each.identity}`, each])).values()];
  if (distinct.length !== 1 || distinct[0].connector !== acting.connector) return undefined;
  const eligible = distinct.flatMap((each) => {
    const tool = tools.find((candidate) => candidate.name === each.tool);
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(each.args) as Record<string, unknown>;
    } catch {
      return [];
    }
    return tool?.links && own.some((message) => tool.links!(message, request, kept)) ? [{ tool: each.tool, request, identity: each.identity }] : [];
  });
  return eligible.length === 1 ? eligible[0] : undefined;
}
