/**
 * Requests that wait and are carried on, what a run read under (guards), and answers that can be
 * followed up. One part of the Brain, in a file of its own: it works on the same database, in the
 * same transactions, through the shared store and what else the Brain hands it (RequestsHost). Nothing here is reachable
 * from outside the Brain.
 */
import { type ApprovalQuestion, type CodeReview, type Holds, type Outcome, type Receipt, type Waiting, holds, isWaiting, toolsOf } from "../connectors";
import type { Env } from "../env";
import type { Item } from "../model/openai";
import type { NoticeKey, Said } from "./agent";
import { type Passage, followUpDecision, locate, passageNow } from "./follow-up";
import type { BrainStore, InboxRow, Row, RunRow } from "./store";

/**
 * How long a request that was carried on has, from the moment it was taken up, to read and to
 * hand its answer to the channel. Past it nothing more is read and an unsent answer is not sent.
 */
export const HANDLING_LIMIT_MS = 60 * 60_000;

export const WAITING_NOTE =
  "This cannot be done until the person does something that only they can do (authorise it, say). The system itself is showing them how, in this conversation; do not repeat or paraphrase that, and do not ask them to send their request again. The request is kept under the id given here and is carried on by itself once they have done it: its answer is sent to them then. There is nothing more for you to do about it in this run, and nothing to say about it.";

/** A request that waits, or is being carried on: see the `continuations` table. */
export interface Continuation {
  id: string;
  session_id: string;
  events: string;
  connector: string;
  tool: string;
  args: string;
  target: string;
  subject: string;
  condition: string;
  generation: number;
  interaction: string;
  until: number;
  status: string;
  run_id: string | null;
  call_id: string | null;
  claimed_at: number | null;
  why?: string | null;
}

/** Why a request the person called off ended, naming the call that did it so that a replay of that call is recognised. */
export const calledOff = (by: string) => `the person called it off (${by})`;

/** One thing a run read for the person: which tool, with what, on which of their messages, and what it said (as a fingerprint). */
/** Whether a kept answer's record is one that can be used: exactly one source, with what it was read for and what it was. */
export function wholeAnswer(answer: { sources: string }): boolean {
  try {
    const sources = JSON.parse(answer.sources) as Partial<Source>[];
    return Array.isArray(sources) && sources.length === 1 && sources.every((source) => source !== null && typeof source === "object" && Array.isArray(source.events?.said) && Array.isArray(source.events?.recent) && typeof source.identity === "string" && typeof source.args === "string" && typeof source.tool === "string");
  } catch {
    return false;
  }
}

/** A delivered answer kept for follow-ups: see the `answers` table. */
export interface AnswerRow {
  id: string;
  session_id: string;
  sources: string;
  created_at: number;
  expires_at: number;
  subject: string;
  outbox_id: number;
  target: string;
}

export interface Source {
  connector: string;
  tool: string;
  args: string;
  call: string;
  events: { said: number[]; recent: number[]; bound?: number[] };
  fingerprint: string;
  /** The very thing that was read, as the outside system resolved it. */
  identity: string;
  /** What the read was made under, for asking its owner later whether that still holds. */
  condition?: string;
  generation?: number;
  /** For something read again to reopen a kept answer: until when that answer is kept. */
  until?: number;
}

/** What a message written after reading may go out under. */
export type Guard = { connector: string; condition: string; generation: number; until?: number };

/** Every piece of text in a value, however nested. */
export function textsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textsIn);
  return typeof value === "object" && value !== null ? Object.values(value).flatMap(textsIn) : [];
}

export async function fingerprint(value: unknown): Promise<string> {
  // What a tool says about the thing, as against what it read from it, is left out: whether a
  // look-up of that kind worked this time says nothing about whether the thing has changed.
  const read = typeof value === "object" && value !== null && !Array.isArray(value) && "aside" in value ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "aside")) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(read))));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The names a message goes by when another message is a reply to it. */
export function subjectsOfEvent(event: InboxRow): string[] {
  const data = JSON.parse(event.data ?? "{}") as { subject?: unknown; message_id?: unknown };
  return [...(typeof data.subject === "string" ? [data.subject] : []), ...(typeof data.message_id === "string" ? [`${event.source}:message:${data.message_id}`] : [])];
}
/** Besides the shared store, the few things of the Brain's own that this part calls. */
export interface RequestsHost {
  env: Env;
  /** Calls under way whose result is outside text not yet recorded as such. */
  outside: Set<string>;
  wakeBy(at: number): Promise<void>;
  append(sessionId: string, runId: string, item: Item, outside?: boolean): void;
  actingFor(runId: string): Acting | undefined;
  actingOn(events: InboxRow[], kept?: number[]): Acting | undefined;
  enqueueMessage(idem: string, sessionId: string, runId: string | null, text: string, ask?: ApprovalQuestion, review?: CodeReview, bound?: { continuation?: Continuation; interaction?: string; target?: string }): { ok: true };
  notice(which: NoticeKey, sessionId: string): string;
}

/** The one person a run acts for, and their own messages it rests on. */
export type Acting = { connector: string; person: string; origin: Record<string, string>; said: Said[]; recent: Said[]; recentIds: number[] };

export class Requests {
  readonly #s: BrainStore;
  readonly #b: RequestsHost;

  constructor(store: BrainStore, host: RequestsHost) {
    this.#s = store;
    this.#b = host;
  }

  // ------------------------------------------------------------------ requests that wait
  //
  // A tool can answer "not yet": something has to happen first that is not the agent's to do.
  // The request is then kept, the run that made it ends as usual, and when the condition holds a
  // run of its own carries out that one call again and answers. Who says the condition holds is
  // the connector the tool belongs to, asked afresh each time; a report that it may hold is only
  // ever a reason to ask. See docs/design/agent-core-step0.md.

  /** The request this run carries on, whatever has become of it since. */
  continuationOf(runId: string): Continuation | undefined {
    return this.#s.rows<Continuation>("SELECT * FROM continuations WHERE run_id = ?", runId)[0];
  }

  /** The request this run is carrying on now. */
  resumed(runId: string): Continuation | undefined {
    const found = this.continuationOf(runId);
    return found?.status === "resuming" ? found : undefined;
  }

  /**
   * The events a run rests on: what started it, or, for a run that carries a request on, the
   * person's own messages that made the request, as they were stored. If any of those is gone
   * there is nothing to rest on.
   */
  basis(runId: string): InboxRow[] {
    const resumed = this.resumed(runId);
    if (!resumed) return this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE run_id = ? ORDER BY id", runId);
    const ids = (JSON.parse(resumed.events) as { said: number[] }).said;
    const rows = this.#s.rows<InboxRow>(`SELECT * FROM inbox WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids);
    return rows.length === ids.length && rows.every((each) => each.text !== null) ? rows : [];
  }

  /** The person's own words that made a request, for telling requests apart. */
  askedFor(record: Continuation): string {
    // The messages it is tied to, where the tool named them: two requests made in one batch are
    // then told apart by their own words.
    const on = JSON.parse(record.events) as { said: number[]; bound?: number[] };
    const ids = on.bound?.length ? on.bound : on.said;
    return this.#s.rows<{ text: string | null }>(`SELECT text FROM inbox WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids).map((each) => each.text ?? "").join(" ").slice(0, 200);
  }

  /** The person's words for each request; where two read the same (one message asked for both), also what each asks for. */
  #labels(records: Continuation[]): string[] {
    const words = records.map((each) => this.askedFor(each));
    return words.map((each, index) => (words.filter((other) => other === each).length > 1 ? `${each} → ${textsIn(JSON.parse(records[index].args)).join(" ")}` : each));
  }

  /**
   * Keeps a request a tool could not carry out yet, and puts what the person has to do in front
   * of them. One step: the record, and the message that shows the way in, exist together or not
   * at all, so nothing can be acted on before there is a request to carry on.
   */
  wait(run: RunRow, acting: { connector: string; events: { said: number[]; recent: number[]; bound?: number[] } }, id: string, tool: string, waiting: Waiting["waiting"], replacing?: { record: Continuation; by: string; choosing?: number }): unknown {
    this.#s.transaction(() => {
      const existing = this.#s.rows<Continuation>("SELECT * FROM continuations WHERE id = ?", id)[0];
      if (existing && existing.status !== "resuming") throw new Error("that request has ended");
      if (existing) {
        // Carried on and told to wait once more: the same request, waiting on what it needs now.
        this.#s.sql.exec("UPDATE continuations SET status = 'waiting', subject = ?, condition = ?, generation = ?, interaction = ?, until = ?, claimed_at = NULL, check_at = NULL WHERE id = ?", waiting.subject, waiting.condition, waiting.generation, waiting.interaction, waiting.until, id);
      } else {
        const basis = this.basis(run.id);
        // Its answer goes back where the person's own message came from, as that message said:
        // not to wherever the conversation, or the scope, happens to point later.
        const target = [...basis].reverse().find((each) => each.reply_to)?.reply_to;
        if (!target) throw new Error("there is nowhere to send a message in this conversation");
        this.#s.sql.exec(
          "INSERT INTO continuations (id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)",
          id,
          run.session_id,
          JSON.stringify(acting.events),
          acting.connector,
          tool,
          // What to call again, as the tool itself put it: never what the model wrote.
          JSON.stringify(waiting.request),
          target,
          waiting.subject,
          waiting.condition,
          waiting.generation,
          waiting.interaction,
          waiting.until,
          Date.now(),
        );
        this.#s.audit("(system)", "request.waiting", { request: id, on: waiting.on });
      }
      if (replacing) this.cancel(replacing.record, replacing.by, replacing.choosing);
      const now = this.#s.rows<Continuation>("SELECT * FROM continuations WHERE id = ?", id)[0];
      // One message per way in, whoever is waiting on it: two requests can share an invitation.
      this.#b.enqueueMessage(`invite:${waiting.interaction}`, now.session_id, null, this.#b.notice("invite", now.session_id), undefined, undefined, { interaction: waiting.interaction, target: now.target });
      // The condition may already hold (the person used an earlier invitation a moment ago): ask.
      this.hint(now, `asked:${waiting.interaction}`);
    });
    return { waiting: true, request: id, note: WAITING_NOTE };
  }

  /**
   * The one answer of a request that is being carried on, as a draft: written, and replaced if
   * written again, but not a message anything will send until the run that wrote it ends (see
   * #finish). So a run interrupted after writing it cannot have it sent, or thrown away, early.
   */
  draft(carried: Continuation, run: RunRow, text: string): { ok: true } {
    this.#b.enqueueMessage(`answer:${carried.id}`, run.session_id, run.id, text, undefined, undefined, { continuation: carried });
    this.#s.sql.exec("UPDATE outbox SET status = 'draft', text = ? WHERE idem = ? AND status IN ('pending', 'draft') AND started = 0", text, `answer:${carried.id}`);
    return { ok: true };
  }

  /** A reason to ask a waiting request's condition again. Never more than that. */
  hint(record: Continuation, event: string): void {
    const session = this.#s.rows<{ session_key: string }>("SELECT session_key FROM sessions WHERE id = ?", record.session_id)[0];
    if (!session) return;
    this.#s.insertEvent({ source: "request", source_id: `${record.id}:${event}`, kind: "request.ready", session_key: session.session_key, principal: { kind: "automation", id: "request", explicit: false }, data: { request: record.id } });
  }

  /**
   * Called by a connector when something changed for one of its subjects (a person authorised,
   * say). It carries no authority and names no request: every request of this scope that waits
   * on that subject has its own condition asked again.
   */
  async conditionReported(connector: string, subject: string, event: string): Promise<{ ok: true }> {
    for (const waiting of this.#s.rows<Continuation>("SELECT * FROM continuations WHERE status = 'waiting' AND connector = ? AND subject = ?", connector, subject)) this.hint(waiting, `reported:${event}`);
    await this.#b.wakeBy(Date.now() + 50);
    return { ok: true };
  }

  /** A wait whose time is up is asked about once more, and ends there if the answer is still no. */
  deadlines(now: number): void {
    for (const waiting of this.#s.rows<Continuation>("SELECT * FROM continuations WHERE status = 'waiting' AND (until <= ? OR check_at <= ?)", now, now)) {
      this.#s.sql.exec("UPDATE continuations SET check_at = NULL WHERE id = ?", waiting.id);
      this.hint(waiting, `due:${Math.floor(now / 60_000)}`);
    }
  }

  /**
   * Acts on one reason to look at a waiting request. The condition's owner is asked whether what
   * this request needs holds, and since when. Only a yes that was true before the deadline takes
   * the request up; anything else leaves the request exactly as it is, except that a wait whose
   * time is up, or whose condition can no longer come about, ends.
   *
   * Taking it up is one step: the request must still be the one that was asked about (it may
   * have been carried on and told to wait again meanwhile), and what the person asked must still
   * be on record and still theirs to ask. Then a run starts that makes the one call again.
   */
  async resume(event: InboxRow): Promise<string | undefined> {
    const drop = () => void this.#s.sql.exec("UPDATE inbox SET status = 'done' WHERE id = ? AND status = 'pending'", event.id);
    const id = String((JSON.parse(event.data ?? "{}") as { request?: string }).request ?? "");
    const before = this.#s.rows<Continuation>("SELECT * FROM continuations WHERE id = ?", id)[0];
    if (!before || before.status !== "waiting") return drop();
    let answer: Holds;
    try {
      answer = await holds(this.#b.env, before.connector, this.#s.scope(), before.condition, before.generation);
    } catch {
      // Could not be asked. It is asked again in a minute, and for as long as the wait lasts.
      this.#s.sql.exec("UPDATE continuations SET check_at = ? WHERE id = ? AND status = 'waiting'", Date.now() + 60_000, id);
      return drop();
    }
    return this.#s.transaction(() => {
      const now = this.#s.rows<Continuation>("SELECT * FROM continuations WHERE id = ?", id)[0];
      // The answer was about the request as it stood when asked. If that has changed, it is not used.
      if (!now || now.status !== "waiting" || now.condition !== before.condition || now.generation !== before.generation || now.until !== before.until) return drop();
      if (answer.state === "gone") {
        this.endRequest(id, "void", "what it waited for was taken away");
        return drop();
      }
      if (answer.state !== "holds" || !(answer.since < now.until)) {
        if (Date.now() >= now.until) this.endRequest(id, "expired", "it was not done in time");
        return drop();
      }
      const runId = crypto.randomUUID();
      const callId = `resume_${runId.replace(/-/g, "")}`;
      this.#s.sql.exec("UPDATE continuations SET status = 'resuming', run_id = ?, call_id = ?, claimed_at = ? WHERE id = ?", runId, callId, Date.now(), id);
      // Whose request it is, worked out again from what they wrote, not remembered.
      const basis = this.basis(runId);
      if (basis.length === 0 || !this.#b.actingFor(runId)) {
        this.endRequest(id, "void", "what the person asked is no longer on record, or no longer theirs to ask here");
        return drop();
      }
      this.#s.sql.exec("UPDATE inbox SET status = 'claimed', run_id = ? WHERE id = ?", runId, event.id);
      this.#s.sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES (?, ?, 'running', ?)", runId, now.session_id, Date.now());
      const asked = basis.map((each) => each.text ?? "").join("\n");
      this.#b.append(now.session_id, runId, {
        role: "user",
        content: `[${new Date().toISOString()}] system: A request that was waiting can now be carried on. What the person asked, in their own words:\n${asked}\nThe tool ${now.tool} has been called again for it and its result follows. Answer that request, and only that, in one send_message, as you would have if it had worked the first time. If the result says it has to wait again, send nothing.`,
      });
      this.#b.append(now.session_id, runId, { type: "function_call", call_id: callId, name: now.tool, arguments: now.args } as Item);
      this.#s.setMeta("active_run", runId);
      this.#s.audit("(system)", "request.resumed", { request: id, run: runId });
      return runId;
    });
  }

  /**
   * Why what a carried-on request has read may not go any further, if it may not: to the model,
   * or to the channel. The request has to be the one still under way, within its time, and the
   * condition's owner has to say, now, that it still holds. If the owner cannot be asked, the
   * answer is "not now".
   */
  async mayNotDisclose(record: Continuation): Promise<string | undefined> {
    if (Date.now() - (record.claimed_at ?? 0) > HANDLING_LIMIT_MS) return "it was not finished in time";
    const answer = await holds(this.#b.env, record.connector, this.#s.scope(), record.condition, record.generation);
    if (answer.state !== "holds") return "what it waited for no longer holds";
    // Time went by while the owner was asked.
    return Date.now() - (record.claimed_at ?? 0) > HANDLING_LIMIT_MS ? "it was not finished in time" : undefined;
  }

  /** Ends a request, once. What ended it is kept; nothing ended is ever reopened. */
  endRequest(id: string, status: "done" | "failed" | "cancelled" | "expired" | "void" | "unverified", why: string): void {
    const ended = this.#s.rows("UPDATE continuations SET status = ?, ended_at = ?, why = ? WHERE id = ? AND status IN ('waiting', 'resuming', 'answering') RETURNING id", status, Date.now(), why, id);
    if (ended.length > 0) this.#s.audit("(system)", "request.ended", { request: id, as: status, why });
  }

  /**
   * Whether a message may be handed to its channel now. Asked before every attempt.
   *   - What shows a way in goes out only while some request still waits on it, in time.
   *   - A request's answer goes out only while the request stands (not cancelled, not past its
   *     time, its condition still holding by its owner's word), and never ahead of something the
   *     person has written here that has not been handled yet: they may be calling it off.
   */
  async gate(row: Row): Promise<"send" | "hold" | "wait" | "void" | "unasked"> {
    if (row.interaction) return this.#s.rows("SELECT 1 FROM continuations WHERE interaction = ? AND status = 'waiting' AND until > ? LIMIT 1", row.interaction, Date.now()).length > 0 ? "send" : "void";
    // Written after reading under a condition: not handed over once that is over. Asked last,
    // after everything else that is waited for, so nothing comes between its answer and the send.
    const guarded = async (): Promise<"send" | "void" | "unasked"> => {
      if (!row.guard) return "send";
      try {
        return (await this.over(JSON.parse(row.guard) as Guard[])) ? "void" : "send";
      } catch {
        return "unasked";
      }
    };
    if (!row.continuation) return guarded();
    const record = () => this.#s.rows<Continuation>("SELECT * FROM continuations WHERE id = ?", row.continuation)[0];
    const unheard = (sessionId: string): "pending" | "claimed" | undefined =>
      this.#s.rows<{ status: "pending" | "claimed" }>("SELECT status FROM inbox WHERE status IN ('pending', 'claimed') AND kind = 'message' AND session_key = (SELECT session_key FROM sessions WHERE id = ?) ORDER BY status DESC LIMIT 1", sessionId)[0]?.status;
    // Words still to be handled in this wake-up are waited for briefly; ones a paused run holds, longer.
    const held = (status: "pending" | "claimed") => (status === "pending" ? "hold" : "wait");
    const before = record();
    if (!before || before.status !== "answering") return "void";
    // The time it had comes first: an answer is not kept waiting past it for anything.
    if (Date.now() - (before.claimed_at ?? 0) > HANDLING_LIMIT_MS) return "void";
    const words = unheard(before.session_id);
    if (words) return held(words);
    let why: string | undefined;
    try {
      why = await this.mayNotDisclose(before);
    } catch {
      return "wait";
    }
    if (why) return "void";
    // Something may have arrived, or the request ended, while the owner was being asked.
    const after = record();
    if (!after || after.status !== "answering") return "void";
    const since = unheard(after.session_id);
    if (since) return held(since);
    const last = await guarded();
    if (last !== "send") return last;
    // And once more, without waiting for anything: its time, its request, the person's words.
    const final = record();
    if (!final || final.status !== "answering" || Date.now() - (final.claimed_at ?? 0) > HANDLING_LIMIT_MS) return "void";
    const now = unheard(final.session_id);
    return now ? held(now) : "send";
  }

  /** The requests in a conversation that can still be called off: nothing of theirs has been handed to the channel. */
  cancellable(sessionId: string): Continuation[] {
    return this.#s.rows<Continuation>("SELECT * FROM continuations WHERE session_id = ? AND status IN ('waiting', 'resuming', 'answering') ORDER BY created_at", sessionId).filter(
      (each) => each.status !== "answering" || this.#s.rows("SELECT 1 FROM outbox WHERE idem = ? AND status = 'pending' AND started = 0", `answer:${each.id}`).length > 0,
    );
  }

  /**
   * Whether a request may be called off, or replaced, because the person said so. The model
   * proposes which; this decides whether that can be what they meant, and throws if not.
   *
   * Only in a run that rests on nothing but the person's own messages in their private
   * conversation. If a message of theirs is a reply to something, the request has to be one that
   * thing belongs to: its answer, the invitation it waits on, or the message that asked for it.
   * If more than one request could be meant, none is cancelled and the model asks. The first
   * message the person writes after that question has reached them may pick one of those
   * requests, once: a message that came before the question was delivered is not an answer to
   * it, a reply to something else is judged by what it replies to, and the message that picks
   * one cannot go on to pick another.
   *
   * `by` names the call: a call that already ended the request is let through when replayed.
   */
  mayCancel(run: RunRow, requestId: string, by: string, ask = ""): { record: Continuation; choosing?: number } {
    if (this.continuationOf(run.id) || !this.#b.actingFor(run.id)) throw new Error("a request can only be cancelled when the person themselves asks for that, in their own private conversation");
    const done = this.#s.rows<Continuation>("SELECT * FROM continuations WHERE id = ? AND session_id = ? AND status = 'cancelled' AND why = ?", requestId, run.session_id, calledOff(by))[0];
    if (done) return { record: done };
    const events = this.basis(run.id);
    const repliedTo = events.map((each) => (JSON.parse(each.data ?? "{}") as { replies_to?: unknown }).replies_to).filter((each): each is string => typeof each === "string");
    const open = this.cancellable(run.session_id);
    const which = `asked_which:${run.session_id}`;
    const asked = JSON.parse(this.#s.meta(which) ?? "null") as { ids: string[]; question: string; chose?: number } | null;
    const question = asked ? this.#s.rows<{ status: string; receipt: string | null; sent_at: number | null }>("SELECT status, receipt, sent_at FROM outbox WHERE idem = ?", asked.question)[0] : undefined;
    // A reply to the system's own "which one?" is an answer to it, not a reply to something else.
    const toQuestion = repliedTo.length > 0 && question?.receipt != null && repliedTo.every((subject) => subject === (JSON.parse(question.receipt as string) as Receipt).subject);
    const candidates = repliedTo.length === 0 ? open : toQuestion ? open.filter((each) => asked!.ids.includes(each.id)) : open.filter((each) => repliedTo.every((subject) => this.#belongsTo(each, subject)));
    const describe = (records: Continuation[]) => this.#labels(records).map((label, index) => `${records[index].id}: "${label}"`).join("; ");
    const chosen = candidates.find((each) => each.id === requestId);
    if (!chosen) throw new Error(candidates.length === 0 ? "there is no request that this could be about" : `that is not a request this could be about. It could be about: ${describe(candidates)}`);

    // A message that has already picked one does not get to pick again, by any route.
    if (asked?.chose !== undefined && events.some((each) => each.id === asked.chose)) throw new Error("this message has already been taken as choosing one request; another needs the person to say so again");
    // The answer to "which one?" is the first message here after that very question reached the
    // person, by its own receipt, and it has to stand alone: batched with another message, there
    // is no telling which of them chose.
    const delivered = question?.status === "sent" && question.receipt && question.sent_at != null ? question.sent_at : undefined;
    const first = delivered === undefined ? undefined : this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE kind = 'message' AND received_at >= ? AND session_key = (SELECT session_key FROM sessions WHERE id = ?) ORDER BY id LIMIT 1", delivered, run.session_id)[0];
    if (asked && asked.chose === undefined && (repliedTo.length === 0 || toQuestion) && first !== undefined && events.length === 1 && first.id === events[0].id && asked.ids.includes(requestId)) return { record: chosen, choosing: first.id };
    // A reply to that question which is not its one answer (it has been answered, or this is not
    // the first message since) decides nothing, however few requests are still open.
    if (toQuestion && candidates.length === 1) throw new Error("that question has already been answered, or this is not the first message since it was asked, so it does not say which request is meant. Ask the person to say plainly which one");
    if (candidates.length === 1) return { record: chosen };
    // The question is put by this code, like an approval question: it is then known exactly
    // which message asked, about which requests, and when it reached the person. Its opening
    // words are the model's, so that it is in the person's language; the list is their own words.
    const key = `which:${by}`;
    this.#b.enqueueMessage(key, run.session_id, null, `${ask.trim() || this.#b.notice("which", run.session_id)}\n${this.#labels(candidates).map((label, index) => `${index + 1}. "${label}"`).join("\n")}`);
    this.#s.setMeta(which, JSON.stringify({ ids: candidates.map((each) => each.id), question: key }));
    throw new Error(`more than one request could be meant, so none was cancelled. The person has been asked which one, by the system itself; do not ask again. They could mean: ${describe(candidates)}`);
  }

  /**
   * Ends a request the person called off. An answer written and not yet handed over is not sent,
   * and what it said is removed. If this used up the one choice after a question, that is
   * recorded in the same step, not before: an interruption on the way here leaves the choice open.
   */
  cancel(chosen: Continuation, by: string, choosing?: number): void {
    this.#s.transaction(() => {
      this.endRequest(chosen.id, "cancelled", calledOff(by));
      this.#s.sql.exec("UPDATE outbox SET status = 'void', text = '', review = NULL, error = NULL WHERE idem = ? AND status IN ('pending', 'draft') AND started = 0", `answer:${chosen.id}`);
      if (choosing !== undefined) {
        const which = `asked_which:${chosen.session_id}`;
        const asked = JSON.parse(this.#s.meta(which) ?? "null") as Record<string, unknown> | null;
        if (asked) this.#s.setMeta(which, JSON.stringify({ ...asked, chose: choosing }));
      }
    });
  }

  /** Whether a message someone replied to belongs to this request: its answer, its way in, or what asked for it. */
  #belongsTo(record: Continuation, subject: string): boolean {
    if (this.#s.rows("SELECT 1 FROM outbox WHERE json_extract(receipt, '$.subject') = ? AND (continuation = ? OR interaction = ?) LIMIT 1", subject, record.id, record.interaction).length > 0) return true;
    // Only the messages the request was tied to by the tool that took it. Where none were named,
    // no message is taken to be about it: a reply then says nothing about which request is meant.
    const ids = (JSON.parse(record.events) as { bound?: number[] }).bound ?? [];
    if (ids.length === 0) return false;
    return this.#s.rows<InboxRow>(`SELECT * FROM inbox WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).some((each) => subjectsOfEvent(each).includes(subject));
  }

  // ---- answers that can be followed up
  //
  // What a run read for a person is not kept in the conversation, and neither is what it said
  // about it. An answer that was delivered is kept apart for a day, and comes back only through
  // reopen_answer: for the person it was given to, in the conversation it was given in, when
  // they are asking about that answer, and only after its source has been read again as them.
  // If they can no longer read the source, the old answer does not come back either.

  followUps(): boolean {
    return this.#b.env.FOLLOW_UPS === "on";
  }

  /**
   * Notes something a run has read: for a later follow-up, and, where it was read under a
   * condition, so that what the run goes on to write is tied to that condition from now on.
   * Nothing of what was read is in the note.
   */
  noteSource(runId: string, source: Source): void {
    const noted = JSON.parse(this.#s.meta(`sources:${runId}`) ?? "[]") as Partial<Source>[];
    // Where nothing is kept for follow-ups, only what the later checks need: under what it was
    // read. Not which document, not on whose message, not what it said.
    const kept: Partial<Source> = this.followUps() ? source : { connector: source.connector, condition: source.condition, generation: source.generation };
    this.#s.setMeta(`sources:${runId}`, JSON.stringify([...noted, kept]));
    this.stampGuards(runId);
  }

  /** What this run's reads were made under. */
  guards(runId: string): Guard[] {
    const noted = JSON.parse(this.#s.meta(`sources:${runId}`) ?? "[]") as Source[];
    const guards = noted.flatMap((each) => (each.condition !== undefined && each.generation !== undefined ? [{ connector: each.connector, condition: each.condition, generation: each.generation, ...(each.until === undefined ? {} : { until: each.until }) }] : []));
    return [...new Map(guards.map((each) => [JSON.stringify(each), each])).values()];
  }

  /** Ties every message this run has written and not yet handed over to what the run read under. */
  stampGuards(runId: string): void {
    const guards = this.guards(runId);
    if (guards.length > 0) this.#s.sql.exec("UPDATE outbox SET guard = ? WHERE run_id = ? AND status IN ('pending', 'draft')", JSON.stringify(guards), runId);
  }

  /** Why what was read under these may go no further, if so: asked of each condition's owner, now. Throws if one cannot be asked. */
  async over(guards: Guard[]): Promise<string | undefined> {
    for (const each of guards) {
      if ((await holds(this.#b.env, each.connector, this.#s.scope(), each.condition, each.generation)).state !== "holds") return "what it was read under no longer holds";
    }
    // Last, with nothing waited for after it: a reopened answer goes no further once it is no
    // longer kept (to the instant), or follow-ups have been switched off.
    for (const each of guards) if (each.until !== undefined && (Date.now() >= each.until || !this.followUps())) return "the answer it reopened is no longer kept";
    return undefined;
  }

  /**
   * The sentences a message says it rests on, kept only if each stands word for word in what
   * the run read. They are what a later question about one of its points is checked against.
   */
  noteQuotes(runId: string, quotes: { point: string; quote: string }[]): void {
    if (!this.followUps() || quotes.length === 0) return;
    // Against what this run read from the source itself: not against an earlier answer brought
    // back beside it, and not against a tool's own notes.
    const read = this.#s.rows<{ item: string }>("SELECT item FROM items WHERE run_id = ? AND outside = 1", runId).flatMap((row) => {
      try {
        const output = JSON.parse(String((JSON.parse(row.item) as { output?: unknown }).output ?? "null")) as { text?: unknown; sources_now?: { text?: unknown }[] } | null;
        return [output?.text, ...(output?.sources_now ?? []).map((each) => each?.text)].filter((each): each is string => typeof each === "string");
      } catch {
        return [];
      }
    });
    // Each is kept, tied to its one place or marked as not tied to any: a point whose sentence
    // could not be placed is remembered as that, not forgotten.
    const placed = quotes.map((each) => ({ point: each.point.trim(), quote: each.quote.trim() })).filter((each) => each.quote.length >= 1 && each.quote.length <= 600).map((each) => locate(each.point, each.quote, read));
    const noted = JSON.parse(this.#s.meta(`quotes:${runId}`) ?? "[]") as Passage[];
    this.#s.setMeta(`quotes:${runId}`, JSON.stringify([...noted, ...placed].slice(-20)));
  }

  /** What a follow-up that has to wait rests on: the person's message that asked it, bound to it when there is exactly one. */
  #followUpEvidence(runId: string): { said: number[]; recent: number[]; bound: number[] } {
    const said = this.basis(runId).map((each) => each.id);
    return { said, recent: [], bound: said.length === 1 ? said : [] };
  }

  sessionKeyOf(_target: string, runId: string | null): string {
    return this.#s.rows<{ session_key: string }>("SELECT s.session_key FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?", runId ?? "")[0]?.session_key ?? "";
  }

  /**
   * The answer a run could be following up, if there is one: the one the person replied to, or
   * else the one that is the last thing the agent said to them here. At most one is ever offered.
   */
  /**
   * The messages a reply to which is about this answer: the answer's own, and the person's
   * messages its source was read for, where the tool tied the read to particular ones.
   */
  #subjectsOf(answer: { subject: string; sources: string }): string[] {
    // Only the messages the tool tied the read to: the whole batch that started the run says nothing about which of them asked for this.
    let ids: number[] = [];
    try {
      ids = (JSON.parse(answer.sources) as Partial<Source>[]).flatMap((source) => (Array.isArray(source.events?.bound) ? source.events.bound : []));
    } catch {
      // A record that is not whole has no messages tied to it.
    }
    const asked = ids.length === 0 ? [] : this.#s.rows<InboxRow>(`SELECT * FROM inbox WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    return [answer.subject, ...asked.flatMap((each) => subjectsOfEvent(each))];
  }

  /**
   * Which kept answers of a conversation a run could mean, worked out in one place for both
   * what is offered and what is then allowed. Records that are not whole are left out one by
   * one. `fits`: those the messages replied to belong to. `named`: the one a reply names (the
   * answer's own message names it exactly; a message of the person's that exactly one answer was
   * read for names that one; two, neither). `last`: the one that is the last thing said here.
   */
  #eligible(sessionId: string, repliedTo: string[]): { kept: AnswerRow[]; fits: AnswerRow[]; named?: AnswerRow; last?: AnswerRow } {
    const kept = this.#s.rows<AnswerRow>("SELECT * FROM answers WHERE session_id = ? AND expires_at > ? ORDER BY created_at DESC", sessionId, Date.now()).filter(wholeAnswer);
    const fits = repliedTo.length > 0 ? kept.filter((each) => repliedTo.every((subject) => this.#subjectsOf(each).includes(subject))) : [];
    const named = fits.find((each) => repliedTo.every((subject) => subject === each.subject)) ?? (fits.length === 1 ? fits[0] : undefined);
    const last = kept.find((each) => this.#s.rows<{ id: number }>("SELECT id FROM outbox WHERE status = 'sent' AND target = ? ORDER BY sent_at DESC, id DESC LIMIT 1", each.target)[0]?.id === each.outbox_id);
    return { kept, fits, named, last };
  }

  reopenable(runId: string): { id: string; asked: string; at: number }[] {
    if (!this.followUps() || this.continuationOf(runId) || !this.#b.actingFor(runId)) return [];
    const sessionId = this.#s.rows<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", runId)[0]?.session_id ?? "";
    const repliedTo = this.basis(runId).map((each) => (JSON.parse(each.data ?? "{}") as { replies_to?: unknown }).replies_to).filter((each): each is string => typeof each === "string");
    const { named, last } = this.#eligible(sessionId, repliedTo);
    const candidate = repliedTo.length > 0 ? named : last;
    if (!candidate) return [];
    // What the person asked when it was first read: the request behind its first source.
    const ids = (JSON.parse(candidate.sources) as Source[])[0].events.said;
    const asked = this.#s.rows<{ text: string | null }>(`SELECT text FROM inbox WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids).map((row) => row.text ?? "").join(" ").slice(0, 200);
    return [{ id: candidate.id, asked, at: candidate.created_at }];
  }

  /**
   * Brings an earlier answer back for a follow-up, with what its source says now.
   *
   * Which answer is the model's to propose and this code's to bound: if the person replied to a
   * message, it must be that answer's message; otherwise it must be the last thing the agent
   * said to them in this conversation. Whether their words are about it at all is left to the
   * model (a decision the user made: see docs/design/agent-core-step0.md, 5.3). The source is
   * then read again as the person, on the strength of the request they made when it was first
   * read; only if that succeeds is the old answer handed over, with the source as it is now and
   * whether it has changed. If the read has to wait (their authorisation has ended), the
   * follow-up waits like any request and is carried on when they have authorised again.
   */
  async reopenAnswer(run: RunRow, callId: string, answerId: string): Promise<unknown> {
    const carried = this.continuationOf(run.id);
    if (carried && (carried.status !== "resuming" || carried.call_id !== callId || carried.tool !== "reopen_answer")) throw new Error("this run can only answer the request it carries on");
    const acting = this.#b.actingFor(run.id);
    // Told to wait before: the same answer on a replay, as for any call that waits.
    if (!carried && acting && this.followUps() && this.#s.rows("SELECT 1 FROM continuations WHERE id = ?", callId).length > 0) return { waiting: true, request: callId, note: WAITING_NOTE };
    const id = carried ? String((JSON.parse(carried.args) as { answer_id?: unknown }).answer_id ?? "") : answerId;
    const row = () => this.#s.rows<Row>("SELECT * FROM answers WHERE id = ?", id)[0];
    const kept = () => {
      const found = row();
      return found && found.session_id === run.session_id && found.expires_at > Date.now() ? found : undefined;
    };
    const repliedTo = this.basis(run.id).map((each) => (JSON.parse(each.data ?? "{}") as { replies_to?: unknown }).replies_to).filter((each): each is string => typeof each === "string");
    const eligible = this.#eligible(run.session_id, repliedTo);
    // The record acted on is the one that was checked: among those this conversation can use
    // now, or, for a follow-up that waited, the answer it was made about, if still whole.
    const pinned = carried ? row() : undefined;
    const proposed: Row | undefined = carried ? (pinned && wholeAnswer(pinned as AnswerRow) ? pinned : undefined) : (eligible.kept.find((each) => each.id === id) as Row | undefined);
    // Everything about this that is not a matter of judgement is decided by one plain function
    // (see ./follow-up), from what is on record.
    const verdict = followUpDecision({
      enabled: this.followUps(),
      actingForPerson: acting !== undefined,
      session: run.session_id,
      repliedTo,
      now: Date.now(),
      carriedOn: carried !== undefined,
      ...(proposed ? { answer: { session: proposed.session_id, expiresAt: proposed.expires_at, subjects: this.#subjectsOf(proposed as AnswerRow), shared: eligible.fits.some((each) => each.id === proposed.id) && eligible.named?.id !== proposed.id, isLastThingSaid: eligible.last?.id === proposed.id } } : {}),
    });
    if (!verdict.allow) {
      throw new Error(
        {
          off: "there is no such tool in this run",
          not_the_person: "an answer can only be reopened when the person themselves asks, in their own private conversation",
          no_such_answer: "there is no such answer here, or it is no longer kept. If the person wants it again, they can ask for it anew",
          another_conversation: "there is no such answer here, or it is no longer kept. If the person wants it again, they can ask for it anew",
          expired: "there is no such answer here, or it is no longer kept. If the person wants it again, they can ask for it anew",
          replied_to_something_else: "the message the person replied to is not that answer",
          reply_fits_several: "more than one of your answers was read for the message the person replied to, so it is not clear which they mean. Ask them, or they can reply to the answer itself",
          not_the_last_thing_said: "that answer is not the last thing you said to them, so it is not clear they mean it. Ask them, or they can reply to the answer they mean",
        }[verdict.reason],
      );
    }
    const answer = proposed!;
    if (!acting) throw new Error("an answer can only be reopened when the person themselves asks, in their own private conversation");
    const sources = JSON.parse(answer.sources) as Source[];
    const quotes = JSON.parse(answer.quotes) as Passage[];
    // Each thing it was read from is read again on the strength of the request that first had
    // it read: that request must still be on record, and still this person's to make.
    const prepared = sources.map((source) => {
      const rows = this.#s.rows<InboxRow>(`SELECT * FROM inbox WHERE id IN (${source.events.said.map(() => "?").join(",")}) ORDER BY id`, ...source.events.said);
      const original = rows.length === source.events.said.length && rows.every((each) => each.text !== null) ? this.#b.actingOn(rows, source.events.recent) : undefined;
      const found = toolsOf(source.connector).find((each) => each.name === source.tool);
      return found && original && original.person === acting.person && original.connector === acting.connector ? { source, found, original } : undefined;
    });
    if (prepared.some((each) => each === undefined)) throw new Error("what the person asked for at the time is no longer on record, so this cannot be reopened. They can ask for it anew");
    const notAfter = (carried?.claimed_at ?? 0) + HANDLING_LIMIT_MS;
    if (carried && Date.now() > notAfter) {
      this.endRequest(carried.id, "void", "it was not finished in time");
      throw new Error("this request was not finished in time; nothing was read. The person can ask again");
    }
    this.#b.outside.add(callId);
    let waits = false;
    try {
      const now: { source: Source; result: unknown; print: string; under?: { condition: string; generation: number } }[] = [];
      for (const each of prepared) {
        const { source, found, original } = each!;
        this.#s.audit(acting.person, "tool.used", { tool: source.tool, call: source.call, reopening: id });
        let identity: string | undefined;
        let under: { condition: string; generation: number } | undefined;
        const result = await found.run(
          { env: this.#b.env, scope: this.#s.scope(), person: acting.person, origin: acting.origin, said: original.said, recent: original.recent, callId: source.call, identified: (_request, name, read) => void ((identity = name), (under = read)), ...(carried ? { resuming: { generation: carried.generation, notAfter } } : {}) },
          JSON.parse(source.args) as Record<string, unknown>,
        );
        // One of them has to wait: the follow-up waits as a whole, and nothing is handed over yet.
        if (isWaiting(result)) {
          waits = true;
          this.#b.outside.delete(callId);
          return this.wait(run, { connector: answer.connector, events: this.#followUpEvidence(run.id) }, carried ? carried.id : callId, "reopen_answer", { ...result.waiting, request: { answer_id: id } });
        }
        // One of them cannot be read now: nothing of the old answer is handed over.
        if (typeof result !== "object" || result === null || "error" in result) return result;
        // The same link, now resolving to something else: being able to read that says nothing
        // about the thing the old answer was read from, so the old answer stays where it is.
        if (identity !== source.identity) return { error: "what that answer was read from cannot be found as it was (the link now leads elsewhere), so the earlier answer cannot be reopened. The person can ask about the document anew" };
        now.push({ source, result, print: await fingerprint(result), under });
      }
      const still = kept();
      if (!still) throw new Error("that answer is no longer kept");
      // From here on this run, and whatever it writes, stands under what these reads were made
      // under and under the time the answer is kept for.
      for (const each of now) this.noteSource(run.id, { ...each.source, fingerprint: each.print, ...(each.under ?? {}), until: still.expires_at });
      // What the source itself says now, and whether all of it was read this time.
      const texts = now.map((each) => (each.result as { text?: unknown }).text).filter((each): each is string => typeof each === "string");
      const partial = now.some((each) => (each.result as { truncated?: unknown }).truncated === true);
      // Each point of the answer that named a sentence it rests on: unchanged, changed, or not
      // something that can be verified.
      const passages = quotes.map((each) => ({ point: each.point, quote: each.quote, ...passageNow(each, texts, partial) }));
      const changed = now.some((each) => each.print !== each.source.fingerprint);
      const besides = now.some((each) => typeof each.result === "object" && each.result !== null && "aside" in each.result);
      return {
        sources_now: now.map((each) => each.result),
        your_answer_then: still.text,
        source_changed: changed,
        // Only what was read as text is compared. What a source holds besides text was not
        // recorded with the answer, so nothing is claimed about it either way.
        compared: "the source's text only",
        ...(besides ? { besides_text: "What the source holds besides its text is given under sources_now as it is now (aside). It was not recorded when you answered and is not compared: if your earlier answer said anything about such content (that there is a whiteboard, a sheet, an image), check that against what is there now, and do not present it as unchanged." } : {}),
        passages: passages.length > 0 ? passages : "no passages were recorded with that answer, so which of its points still hold cannot be checked one by one",
        note: !changed
          ? "The source's text reads as it did when you answered."
          : passages.length > 0
            ? "The source has changed since you answered. A passage reported as unchanged means its sentence still stands where it stood, not that your point still follows: read the point again against the text around it as it is now. For one that is changed, say that the source has changed there and answer from what it says now. For one that cannot be verified, and for any point of the old answer with no passage, say that you cannot tell whether it still holds and answer from what the source says now."
            : "The source has changed since you answered, and which parts cannot be told. Say so, and answer from what it says now; do not present the old answer's points as what it says now.",
      };
    } finally {
      if (!waits) this.#s.sql.exec("UPDATE outbox SET private = 1 WHERE run_id = ?", run.id);
    }
  }

  /**
   * Everything this scope is waiting on, in one shape, whatever keeps it: requests that wait for
   * a condition, and questions put to people for approval. Read only: approvals are kept where
   * they always were, and this looks at them.
   */
  waits(): { kind: "request" | "approval"; id: string; state: string; shown: boolean; since: number }[] {
    const shown = (idem: string) => this.#s.rows("SELECT 1 FROM outbox WHERE idem = ? AND status = 'sent'", idem).length > 0;
    const requests = this.#s.rows<Continuation & { created_at: number }>("SELECT * FROM continuations ORDER BY created_at DESC LIMIT 20").map((each) => ({
      kind: "request" as const,
      id: each.id,
      state: ({ resuming: "continuing", answering: "answer to be sent", done: "done", failed: "failed", cancelled: "withdrawn", expired: "withdrawn", void: "withdrawn", unverified: "cannot be verified" } as Record<string, string>)[each.status] ?? "waiting",
      shown: shown(`invite:${each.interaction}`),
      since: each.created_at,
    }));
    const approvals = this.#s.rows<{ idem: string; closed: string | null; created_at: number; status: string }>("SELECT idem, closed, created_at, status FROM outbox WHERE ask IS NOT NULL ORDER BY id DESC LIMIT 20").map((each) => {
      const settling = this.#s.rows("SELECT 1 FROM unsettled WHERE ask = ?", each.idem).length > 0;
      const ended = each.closed ? ({ approved: "done", refused: "refused", withdrawn: "withdrawn", unknown: "cannot be verified" } as Record<string, string>)[(JSON.parse(each.closed) as Outcome).state] : undefined;
      return { kind: "approval" as const, id: each.idem, state: ended ?? (settling ? "reconciling" : "waiting"), shown: each.status === "sent", since: each.created_at };
    });
    return [...requests, ...approvals];
  }
}
