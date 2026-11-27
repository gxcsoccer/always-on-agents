/**
 * Who a message may remind, and that nobody is reminded twice of one thing.
 *
 * The model says whom it wants reminded (`notify` of send_message); whether they are is decided
 * here, from what the Brain itself has kept. Only where several people talk. Three kinds of people,
 * all of the conversation the thing came up in: the one who asked for it; those they named there
 * with the platform's own mention (as the connector noted of that very message); and those who
 * have written to the agent there themselves. Anyone else has no way of being reminded.
 *
 * See docs/design/reply-format.zh-CN.md.
 */
import type { Principal } from "../events";
import type { BrainStore, InboxRow, RunRow } from "./store";

/** No more than this many people of one thing, by however many messages. */
export const MAX_REMINDED = 5;

/** Whom a kept message reminds, as it is kept beside it: their ids, and for some the name they were named by. (Kept as the ids alone where there are no names.) */
export function reminded(kept: string | null | undefined): { ids: string[]; names: Record<string, string> } {
  const found = JSON.parse(kept ?? "[]") as string[] | { ids: string[]; names: Record<string, string> };
  return Array.isArray(found) ? { ids: found, names: {} } : found;
}

export interface RemindersHost {
  /** The messages a run rests on: its own, or the ones the request it carries on was made in. */
  basis(runId: string): InboxRow[];
  /** The request a run carries on, if it carries one on. */
  carrying(runId: string): string | undefined;
  /** Whether this person's word counts here, coming through that connector (a connector the deployment trusts, and a person it knows). */
  isDecider(principal: Principal, source: string): boolean;
}

/**
 * A person named with the platform's own mention in one message, as the connector noted it: who
 * it is, and the name that stands in the text for them. The connector gives everyone the message
 * named; whether a name means one person is told here, over all of them.
 */
export type Named = { id: string; name: string };

/** What is kept of where and by whom a thing was asked, with a task or a timer, to go by when it comes back. */
export type Asked = { by: string; named: Named[]; place: string };

const named = (noted: unknown): Named[] => (Array.isArray(noted) ? noted.filter((each): each is Named => typeof each?.id === "string" && each.id !== "" && typeof each?.name === "string") : []);

/**
 * The place a message is written in or sent to, as the connector addresses it, without what is
 * of one message alone (which one it answers): the same account, the same chat, the same kind of
 * place in it, shown to the same people. Two addresses are of one place where this is the same.
 */
export function placeOf(target: string | null | undefined): string | undefined {
  if (!target) return undefined;
  try {
    const { connector, address } = JSON.parse(target) as { connector?: unknown; address?: Record<string, unknown> };
    if (typeof connector !== "string" || !address || typeof address !== "object") return undefined;
    const { message_id: _, ...rest } = address;
    return JSON.stringify([connector, Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))]);
  } catch {
    return undefined;
  }
}

export class Reminders {
  readonly #s: BrainStore;
  readonly #b: RemindersHost;

  constructor(store: BrainStore, host: RemindersHost) {
    this.#s = store;
    this.#b = host;
  }

  /**
   * What is noted when a task or a timer is made in a run, to be gone by when it comes back: who
   * asked, whom they named, and where. From the run's own messages, where they are one person's
   * own, written to the agent where several people talk; or, for a run that a task's end or a
   * timer's firing started, what was kept with that task or timer: what a person asked for is
   * still theirs however many steps it is done in, each set going by the one before.
   */
  asked(runId: string): Asked | undefined {
    const about = this.#about(runId);
    return about ? { by: about.by, named: about.named, place: about.place } : undefined;
  }

  /** The thing a run is about, and whose it is: what its own messages say, or what was kept with the task or the timer that started it. */
  #about(runId: string): { event: string; by: string; named: Named[]; sessionKey: string; place: string; timer?: string } | undefined {
    const events = this.#b.basis(runId);
    if (events.length === 0) return undefined;
    let about: { event: string; by: string; named: Named[]; sessionKey: string; place: string; timer?: string } | undefined;
    const said = this.#from(events);
    const [only] = events;
    // (The answer of a request that had to wait is a thing of its own: what was said when it was asked, with whoever that reminded, was about its being asked.)
    const carried = said ? this.#b.carrying(runId) : undefined;
    if (said) about = { event: carried ? `request:${carried}` : `message:${said.first}`, by: said.by, named: said.named, sessionKey: said.sessionKey, place: said.place };
    else if (events.length === 1 && only.source === "worker" && ["worker.result", "worker.failed", "worker.lost"].includes(only.kind)) {
      // A task that has had its end, well or not: one thing, however it ended.
      // (Whose task: as the Brain wrote it on the event; who asked for it, whom they named and where: as kept with the task when it was made.)
      const id = String((JSON.parse(only.principal) as { id?: unknown }).id ?? "");
      const task = this.#s.rows<{ session_key: string; asked: string }>("SELECT t.session_key, a.asked FROM tasks t JOIN task_asked a ON a.task_id = t.id WHERE t.id = ?", id)[0];
      const kept = task ? (JSON.parse(task.asked) as Partial<Asked>) : undefined;
      if (task && typeof kept?.by === "string" && typeof kept.place === "string") about = { event: `task:${id}`, by: kept.by, named: named(kept.named), sessionKey: task.session_key, place: kept.place };
    } else if (events.length === 1 && only.source === "timer" && only.kind === "timer") {
      const id = String((JSON.parse(only.principal) as { id?: unknown }).id ?? "");
      const timer = this.#s.rows<{ data: string | null; session_key: string; status: string }>("SELECT data, session_key, status FROM timers WHERE id = ?", id)[0];
      // Called off since it fired: a firing of it that was already waiting reminds nobody.
      if (timer?.status === "cancelled") return undefined;
      const kept = JSON.parse(timer?.data ?? "{}") as Partial<Asked> & { stop_after_reminding?: unknown; reminded?: unknown };
      // One set to stop once it has reminded has done so, at an earlier firing: no later one reminds, whenever it is taken up.
      if (kept.stop_after_reminding === true && kept.reminded !== undefined) return undefined;
      // Each time it fires is a thing of its own.
      if (timer && typeof kept.by === "string" && typeof kept.place === "string") about = { event: `timer:${id}:${only.id}`, by: kept.by, named: named(kept.named), sessionKey: timer.session_key, place: kept.place, ...(kept.stop_after_reminding === true ? { timer: id } : {}) };
    }
    return about;
  }

  /** Whose words these are, whom they name and where they were written, where they are one person's own messages to the agent in one shared place. */
  #from(events: InboxRow[]): { by: string; named: Named[]; first: number; sessionKey: string; place: string } | undefined {
    if (events.length === 0 || !events.every((each) => each.session_key === events[0].session_key)) return undefined;
    const people = new Set(events.map((each) => this.#writer(each)));
    const places = new Set(events.map((each) => placeOf(each.reply_to as string | null)));
    const [by] = [...people];
    const [place] = [...places];
    if (people.size !== 1 || by === undefined || places.size !== 1 || place === undefined) return undefined;
    return { by, named: events.flatMap((each) => named((JSON.parse(each.data ?? "{}") as { mentioned?: unknown }).mentioned)), first: events[0].id, sessionKey: events[0].session_key, place };
  }

  /**
   * Who wrote a message to the agent themselves, in the conversation it is kept in, where several
   * people talk: said by the connector of that very message, which is still kept. None for
   * anything else: a button pressed, words not written to the agent, a message whose words or
   * whose record of where it came from is gone, and one written somewhere else and brought into
   * this conversation because it answered a question asked here.
   */
  #writer(event: InboxRow): string | undefined {
    if (event.kind !== "message" || event.text === null || event.data === null || !event.reply_to) return undefined;
    const principal = JSON.parse(event.principal) as Principal;
    const data = JSON.parse(event.data) as { group?: unknown; card?: unknown; routed_from?: unknown };
    // (Through a connector whose word on who wrote it counts here, as for anything else a person's word decides.)
    return this.#b.isDecider(principal, event.source) && principal.explicit === true && typeof principal.id === "string" && data.group === true && data.card === undefined && data.routed_from === undefined ? principal.id : undefined;
  }

  /**
   * For a run, and the place a message of it is to be sent to: the thing it is about (so that
   * one thing reminds a person once), and a way of telling, of someone the model names (by an
   * id; by a name as the one who asked wrote it), who they are if they may be reminded.
   * Undefined where nobody may be: not where several people talk; nothing says whose thing it
   * is, or where it was asked; it came up in another conversation, or another place, than the
   * one this message goes out in.
   */
  of(run: RunRow, target: string | null | undefined): { event: string; who(asked: string): string | undefined; name(id: string): string | undefined; timer?: string } | undefined {
    if (this.#s.scope().kind !== "chat") return undefined;
    const here = this.#s.rows<{ session_key: string }>("SELECT session_key FROM sessions WHERE id = ?", run.session_id)[0]?.session_key;
    const about = here === undefined ? undefined : this.#about(run.id);
    // Where it came up and where this goes out are one conversation (the same topic of the same
    // chat) and one place as the connector addresses it (the same account, the same chat, for
    // everyone there to see).
    if (!about || about.sessionKey !== here || about.place !== placeOf(target)) return undefined;
    const { by, sessionKey } = about;
    // Named by them: by who they are, always; by the name only where it means one person.
    const ids = new Set(about.named.map((each) => each.id));
    const names = new Map<string, Set<string>>();
    // (Over everyone named in all the messages the request was made in: a name two of them bear, in one message or in two, means neither.)
    for (const each of about.named) if (each.name !== "") names.set(each.name.toLowerCase(), new Set([...(names.get(each.name.toLowerCase()) ?? []), each.id]));
    const who = (asked: string): string | undefined => {
      const ref = asked.trim();
      // (Never everyone at once, whatever the place calls that.)
      if (ref === "" || ref.toLowerCase() === "all") return undefined;
      if (ref.toLowerCase() === by.toLowerCase()) return by;
      // (By the name as they wrote it, with the chat's mark before it or without: the same name.)
      const meant = names.get(ref.toLowerCase()) ?? (ref.startsWith("@") ? undefined : names.get(`@${ref.toLowerCase()}`));
      if (meant?.size === 1) return [...meant][0];
      const exact = [...ids].find((id) => id.toLowerCase() === ref.toLowerCase());
      if (exact) return exact;
      // Someone who has written to the agent in this conversation themselves: looked for by who
      // they are, however long ago and whatever else of theirs is kept here since (answers of
      // theirs brought in from elsewhere, say), through all that is still kept of it.
      // (A name is not who someone is: only those the one who asked named are found by a name.)
      if (ref.startsWith("@")) return undefined;
      for (let before = Number.MAX_SAFE_INTEGER; ; ) {
        const page = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND kind = 'message' AND text IS NOT NULL AND data IS NOT NULL AND reply_to IS NOT NULL AND lower(json_extract(principal, '$.id')) = ? AND id < ? ORDER BY id DESC LIMIT 100", sessionKey, ref.toLowerCase(), before);
        for (const each of page) {
          const writer = this.#writer(each);
          if (writer !== undefined && placeOf(each.reply_to as string | null) === about!.place) return writer;
        }
        if (page.length < 100) return undefined;
        before = page.at(-1)!.id;
      }
    };
    // The name the one who asked wrote for a person, where it means that one person: what the words of a message may name them by.
    const name = (id: string): string | undefined => about.named.find((each) => each.id === id && each.name !== "" && names.get(each.name.toLowerCase())?.size === 1)?.name;
    return { event: about.event, who, name, ...(about.timer ? { timer: about.timer } : {}) };
  }

  /** Of people a message of this run reminds, the name the one who asked wrote for each, where they wrote one. */
  named(run: RunRow, ids: string[], target: string | null | undefined): Record<string, string> {
    const may = ids.length > 0 ? this.of(run, target) : undefined;
    return Object.fromEntries(ids.flatMap((id) => (may?.name(id) ? [[id, may.name(id)!]] : [])));
  }

  /**
   * Who a message of this run, to be sent to `target`, reminds, of those the model asked for: in
   * the order asked, each once, none who was already reminded of this thing, and no more than a
   * few of one thing by all its messages together. Taken for this thing in the same step, so it has to be called in one transaction with
   * keeping the message. A timer set to stop once it has reminded stops here, and that it has is
   * written on it, so that a firing of it already waiting reminds nobody.
   */
  claim(run: RunRow, asked: string[], target: string | null | undefined): string[] {
    const may = asked.length > 0 ? this.of(run, target) : undefined;
    if (!may) return [];
    const reminded: string[] = [];
    // (Of one thing, not of one message: a run made to send message after message reminds no more people by it.)
    const left = MAX_REMINDED - this.#s.rows<{ n: number }>("SELECT COUNT(*) AS n FROM reminded WHERE event = ?", may.event)[0].n;
    for (const each of asked) {
      if (reminded.length >= left) break;
      const id = may.who(each);
      if (id === undefined || reminded.includes(id) || this.#s.rows("SELECT 1 FROM reminded WHERE event = ? AND person = ?", may.event, id).length > 0) continue;
      reminded.push(id);
    }
    for (const id of reminded) this.#s.sql.exec("INSERT INTO reminded (event, person, at) VALUES (?, ?, ?)", may.event, id, Date.now());
    if (reminded.length > 0 && may.timer) {
      const kept = JSON.parse(this.#s.rows<{ data: string | null }>("SELECT data FROM timers WHERE id = ?", may.timer)[0]?.data ?? "{}") as Record<string, unknown>;
      this.#s.sql.exec("UPDATE timers SET status = CASE WHEN status = 'active' THEN 'done' ELSE status END, data = ? WHERE id = ?", JSON.stringify({ ...kept, reminded: may.event }), may.timer);
    }
    return reminded;
  }
}
