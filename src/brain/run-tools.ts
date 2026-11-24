/**
 * What a run's tools do: the Brain's own (memory, timers, messages, reviews) and the way into a
 * connector's tools, for one run. Built on the Brain's database; the requests part, the outbox and
 * the tasks part are handed in, and so is what only the run loop knows (whom the run acts for,
 * whether it may still use a tool, what it has read from outside). See tools.ts for how the model
 * is told about them and how a call is dispatched.
 */
import { type ConnectorTool, isSettled, isWaiting } from "../connectors";
import type { Env } from "../env";
import type { Outbox } from "./outbox";
import { MAX_LOADED_INDEX, MAX_LOADED_INSTRUCTIONS } from "./prompt";
import { type Acting, HANDLING_LIMIT_MS, type Requests, WAITING_NOTE } from "./requests";
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
  readonly requests: Pick<Requests, "continuationOf" | "mayCancel" | "cancel" | "basis" | "endRequest" | "noteSource" | "wait" | "draft">;
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
  #answering(run: RunRow, acting: Acting): { answering?: { source?: Record<string, unknown>; nothing?: true } } {
    const subjects = this.#b.requests.basis(run.id).map((each) => (JSON.parse(each.data ?? "{}") as { replies_to?: unknown }).replies_to).filter((each): each is string => typeof each === "string");
    if (subjects.length === 0) return {};
    const answers = this.#s.rows<{ reads: string }>("SELECT reads FROM said WHERE session_id = ? AND receipt_subject IN (SELECT value FROM json_each(?))", run.session_id, JSON.stringify(subjects));
    if (answers.length === 0) return {};
    // Written from nothing read, every one of them: they point at nothing.
    // (And every message replied to has to be such an answer: a reply to anything else as well
    // keeps what that one points at.)
    if (answers.length === new Set(subjects).size && answers.every((each) => (JSON.parse(each.reads) as Read[]).length === 0)) return { answering: { nothing: true } };
    const sources = answers.map((each) => eligibleSource(JSON.parse(each.reads) as Read[], acting, this.#b.toolsOf));
    const one = sources.every((each) => each !== undefined && each.identity === sources[0]!.identity) ? sources[0] : undefined;
    return { answering: one ? { source: one.request } : {} };
  }

  for(run: RunRow): ToolHost {
    const session = this.#s.rows<Row>("SELECT * FROM sessions WHERE id = ?", run.session_id)[0];
    const sql = this.#s.sql;
    return {
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
          return { waiting: true, request: folded ?? callId, note: WAITING_NOTE };
        }
        const key = carried ? carried.id : callId;
        const { replaces, ...asked } = args;
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
          const result = await found.run({ env: this.#b.env, scope: this.#s.scope(), person: acting.person, origin: acting.origin, said: acting.said, recent: acting.recent, ...this.#answering(run, acting), callId: key, relied: (from, index) => void (from === "said" ? named : relied).add(index), identified: (request, identity, under) => void (identified = { request, identity, under }), ...(carried ? { resuming: { generation: carried.generation, notAfter } } : {}) }, given);
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
      cancelRequest: (callId, requestId, ask) => {
        const chosen = this.#b.requests.mayCancel(run, requestId, callId, ask);
        this.#b.requests.cancel(chosen.record, callId, chosen.choosing);
        return { ok: true, cancelled: chosen.record.id, note: "It will not be carried on and nothing of it will be sent. Tell the person it has been cancelled." };
      },
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

      dispatchTask: async (callId, title, brief, repository) => {
        return this.#b.tasks.dispatch(run, session.session_key, callId, title, brief, repository);
      },
      taskStatus: (taskId) => this.#b.tasks.status(taskId),
      answerTask: (callId, taskId, decision, reason) => this.#b.tasks.answer(run, session.session_key, callId, taskId, decision, reason),
      cancelTask: (taskId) => this.#b.tasks.cancel(session.session_key, taskId),
    };
  }
}

type Read = { connector: string; tool: string; args: string; identity: string };

/** The connector's tools that may be used for this person where they are: all of them in private, and where several people talk only those that say so. */
export function toolsIn(acting: Pick<Acting, "connector" | "shared">, toolsOf: (connector: string) => ConnectorTool[]): ConnectorTool[] {
  return toolsOf(acting.connector).filter((each) => !acting.shared || each.shared === true);
}

/**
 * The one thing an answer was written from, if it was written from exactly one, and the person
 * can still point at it: linked by them in the messages the run acts on or in their own earlier
 * messages here (as the tool that read it judges). None for an answer written from nothing read,
 * from several (even if only one of them is still in reach), or from one they linked too long ago.
 */
export function eligibleSource(reads: Read[], acting: Acting | undefined, toolsOf: (connector: string) => ConnectorTool[]): { tool: string; request: Record<string, unknown>; identity: string } | undefined {
  if (!acting) return undefined;
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
    return tool?.links && own.some((message) => tool.links!(message, request)) ? [{ tool: each.tool, request, identity: each.identity }] : [];
  });
  return eligible.length === 1 ? eligible[0] : undefined;
}
