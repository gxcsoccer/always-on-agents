/**
 * Requests that wait and are carried on, and what a run read under (guards). One part of the Brain, in a file of its own: it works on the same database, in the
 * same transactions, through the shared store and what else the Brain hands it (RequestsHost). Nothing here is reachable
 * from outside the Brain.
 */
import { type ApprovalQuestion, type CodeReview, type Holds, type Outcome, type Receipt, type Waiting, holds } from "../connectors";
import type { Env } from "../env";
import type { Item } from "../model/openai";
import type { Said } from "./runner";
import type { NoticeKey } from "./outbox";
import type { BrainStore, InboxRow, Row, RunRow, Wakes } from "./store";

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
  /** Whose request it is. Null only for one kept before this was recorded. */
  person?: string | null;
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

/** One thing a run read for the person: which tool, with what, and what it was read under. */
export interface Source {
  connector: string;
  tool: string;
  args: string;
  /** The very thing that was read, as the outside system resolved it. */
  identity: string;
  /** What the read was made under, for asking its owner later whether that still holds. */
  condition?: string;
  generation?: number;
}

/** What a message written after reading may go out under. */
export type Guard = { connector: string; condition: string; generation: number; retired?: true };

/** Every piece of text in a value, however nested. */
export function textsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textsIn);
  return typeof value === "object" && value !== null ? Object.values(value).flatMap(textsIn) : [];
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
  enqueueMessage(idem: string, sessionId: string, runId: string | null, text: string, ask?: ApprovalQuestion, review?: CodeReview, bound?: { continuation?: Continuation; interaction?: string; target?: string; authored?: boolean }): { ok: true };
  notice(which: NoticeKey, sessionId: string): string;
}

/** The one person a run acts for, and their own messages it rests on. */
export type Acting = { connector: string; person: string; origin: Record<string, string>; said: Said[]; recent: Said[]; recentIds: number[] };

export class Requests implements Wakes {
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

  /** The earliest of the waits' deadlines and next checks. */
  nextWakeAt(now: number): number | null {
    const candidates: number[] = [];
    // Each wait by itself, without holding back the others: at its deadline and at its scheduled
    // re-ask, whichever comes first. One with a look whose time has passed is looked at again in a
    // minute (until its owner has been asked), but not after a look still to come.
    for (const wait of this.#s.rows<{ until: number; check_at: number | null }>("SELECT until, check_at FROM continuations WHERE status = 'waiting'")) {
      const looks = [wait.until, wait.check_at].filter((at): at is number => at != null);
      const ahead = looks.filter((at) => at > now);
      candidates.push(ahead.length === looks.length ? Math.min(...ahead) : Math.min(now + 60_000, ...ahead));
    }
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

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
  wait(run: RunRow, acting: { connector: string; person: string; events: { said: number[]; recent: number[]; bound?: number[] } }, id: string, tool: string, waiting: Waiting["waiting"], replacing?: { record: Continuation; by: string; choosing?: number }): unknown {
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
          "INSERT INTO continuations (person, id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)",
          acting.person,
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
  /** `authored`: written by the model, as against the system's fixed words in place of an answer. */
  draft(carried: Continuation, run: RunRow, text: string, authored = false): { ok: true } {
    this.#b.enqueueMessage(`answer:${carried.id}`, run.session_id, run.id, text, undefined, undefined, { continuation: carried, authored });
    this.#s.sql.exec("UPDATE outbox SET status = 'draft', text = ?, reads = ?, authored = ? WHERE idem = ? AND status IN ('pending', 'draft') AND started = 0", text, JSON.stringify(this.readsOf(run.id)), authored ? 1 : 0, `answer:${carried.id}`);
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

  /**
   * A wait whose time is up is asked about once more, and ends there if the answer is still no.
   * One whose owner could not be asked is asked again when its re-ask is due. Each look is its own
   * reason, named by its time: the same look given again is kept once, and a re-ask and the
   * deadline never stand in for each other, whichever comes first.
   */
  deadlines(now: number): void {
    for (const waiting of this.#s.rows<Continuation & { check_at: number | null }>("SELECT * FROM continuations WHERE status = 'waiting' AND (until <= ? OR check_at <= ?)", now, now)) {
      if (waiting.check_at != null && waiting.check_at <= now) {
        this.#s.sql.exec("UPDATE continuations SET check_at = NULL WHERE id = ?", waiting.id);
        this.hint(waiting, `check:${waiting.check_at}`);
      }
      // The deadline of the request as it now stands: one waiting again on something else has its own.
      if (waiting.until <= now) this.hint(waiting, `deadline:${waiting.until}:${waiting.condition}:${waiting.generation}`);
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
    // The person's own words, that is: where others share the conversation, theirs say nothing about this request.
    const unheard = (of: Continuation): "pending" | "claimed" | undefined =>
      this.#s.rows<{ status: "pending" | "claimed" }>(
        "SELECT status FROM inbox WHERE status IN ('pending', 'claimed') AND kind = 'message' AND session_key = (SELECT session_key FROM sessions WHERE id = ?) AND (? IS NULL OR json_extract(principal, '$.id') = ?) ORDER BY status DESC LIMIT 1",
        of.session_id,
        of.person ?? null,
        of.person ?? null,
      )[0]?.status;
    // Words still to be handled in this wake-up are waited for briefly; ones a paused run holds, longer.
    const held = (status: "pending" | "claimed") => (status === "pending" ? "hold" : "wait");
    const before = record();
    if (!before || before.status !== "answering") return "void";
    // The time it had comes first: an answer is not kept waiting past it for anything.
    if (Date.now() - (before.claimed_at ?? 0) > HANDLING_LIMIT_MS) return "void";
    const words = unheard(before);
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
    const since = unheard(after);
    if (since) return held(since);
    const last = await guarded();
    if (last !== "send") return last;
    // And once more, without waiting for anything: its time, its request, the person's words.
    const final = record();
    if (!final || final.status !== "answering" || Date.now() - (final.claimed_at ?? 0) > HANDLING_LIMIT_MS) return "void";
    const now = unheard(final);
    return now ? held(now) : "send";
  }

  /**
   * The requests in a conversation that can still be called off: nothing of theirs has been
   * handed to the channel. With a person named, that person's only (and any kept before it was
   * recorded whose they are): where several people share a conversation, nobody is shown, or
   * can call off, another's.
   */
  cancellable(sessionId: string, person?: string): Continuation[] {
    return this.#s.rows<Continuation>("SELECT * FROM continuations WHERE session_id = ? AND status IN ('waiting', 'resuming', 'answering') AND (? IS NULL OR person IS NULL OR person = ?) ORDER BY created_at", sessionId, person ?? null, person ?? null).filter(
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
    const acting = this.continuationOf(run.id) ? undefined : this.#b.actingFor(run.id);
    if (!acting) throw new Error("a request can only be cancelled when the person themselves asks for that, in their own private conversation");
    const done = this.#s.rows<Continuation>("SELECT * FROM continuations WHERE id = ? AND session_id = ? AND status = 'cancelled' AND why = ?", requestId, run.session_id, calledOff(by))[0];
    if (done) return { record: done };
    const events = this.basis(run.id);
    const repliedTo = events.map((each) => (JSON.parse(each.data ?? "{}") as { replies_to?: unknown }).replies_to).filter((each): each is string => typeof each === "string");
    const open = this.cancellable(run.session_id, acting.person);
    const which = askedWhich(run.session_id, acting.person);
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
    const first = delivered === undefined ? undefined : this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE kind = 'message' AND received_at >= ? AND session_key = (SELECT session_key FROM sessions WHERE id = ?) AND json_extract(principal, '$.id') = ? ORDER BY id LIMIT 1", delivered, run.session_id, acting.person)[0];
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
        const which = askedWhich(chosen.session_id, chosen.person);
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

  // ---- what a run read under

  /**
   * Notes something a run has read: which thing, and, where it was read under a condition, that
   * condition, so that what the run goes on to write is tied to it from now on. Nothing of what
   * was read is in the note.
   */
  noteSource(runId: string, source: Source): void {
    const noted = JSON.parse(this.#s.meta(`sources:${runId}`) ?? "[]") as Source[];
    this.#s.setMeta(`sources:${runId}`, JSON.stringify([...noted, source]));
    this.stampGuards(runId);
  }

  /** The conversation a run belongs to, by its key. */
  sessionKeyOf(_target: string, runId: string | null): string {
    return this.#s.rows<{ session_key: string }>("SELECT s.session_key FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?", runId ?? "")[0]?.session_key ?? "";
  }

  /** What this run has read so far, each thing once: its connector, tool, canonical call and identity. */
  readsOf(runId: string): { connector: string; tool: string; args: string; identity: string }[] {
    const noted = JSON.parse(this.#s.meta(`sources:${runId}`) ?? "[]") as Partial<Source>[];
    const whole = noted.filter((each): each is Source => typeof each.tool === "string" && typeof each.args === "string" && typeof each.identity === "string");
    return [...new Map(whole.map((each) => [each.identity, { connector: each.connector, tool: each.tool, args: each.args, identity: each.identity }])).values()];
  }

  /** What this run's reads were made under. */
  guards(runId: string): Guard[] {
    const noted = JSON.parse(this.#s.meta(`sources:${runId}`) ?? "[]") as (Source & { until?: unknown })[];
    // A read noted by an earlier version, to reopen an answer kept for follow-ups (it carried
    // until when that answer was kept), rests on something that is retired: what it read goes no further.
    const guards: Guard[] = noted.flatMap((each) => (each.condition !== undefined && each.generation !== undefined ? [{ connector: each.connector, condition: each.condition, generation: each.generation, ...(each.until !== undefined ? { retired: true as const } : {}) }] : []));
    return [...new Map(guards.map((each) => [JSON.stringify(each), each])).values()];
  }

  /** Ties every message this run has written and not yet handed over to what the run read under. */
  stampGuards(runId: string): void {
    const guards = this.guards(runId);
    if (guards.length > 0) this.#s.sql.exec("UPDATE outbox SET guard = ? WHERE run_id = ? AND status IN ('pending', 'draft')", JSON.stringify(guards), runId);
  }

  /** Why what was read under these may go no further, if so: asked of each condition's owner, now. Throws if one cannot be asked. */
  async over(guards: Guard[]): Promise<string | undefined> {
    if (guards.some((each) => each.retired)) return "it rested on an answer kept for follow-ups, which are retired";
    for (const each of guards) {
      if ((await holds(this.#b.env, each.connector, this.#s.scope(), each.condition, each.generation)).state !== "holds") return "what it was read under no longer holds";
    }
    return undefined;
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

/** Where it is kept that a person was asked which of their requests they mean: one question per person and conversation. */
function askedWhich(sessionId: string, person: string | null | undefined): string {
  return `asked_which:${sessionId}:${person ?? ""}`;
}
