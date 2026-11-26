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
import type { BrainStore, InboxRow, RunRow } from "./store";

/** No more than this many people by one message. */
export const MAX_REMINDED = 5;

export interface RemindersHost {
  /** The messages a run rests on: its own, or the ones the request it carries on was made in. */
  basis(runId: string): InboxRow[];
}

/** A person named with the platform's own mention in one message, as the connector noted it: the name as it stands in the text, and who it is. */
export type Named = { name: string; id: string };

/** What is kept of where and by whom a thing was asked, with a task or a timer, to go by when it comes back. */
export type Asked = { by: string; named: Named[]; place: string };

const named = (noted: unknown): Named[] => (Array.isArray(noted) ? noted.filter((each): each is Named => typeof each?.name === "string" && typeof each?.id === "string" && each.name !== "" && each.id !== "") : []);

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
   * asked, whom they named, and where. From the run's own messages alone, and only where they
   * are one person's own, written to the agent where several people talk.
   */
  asked(runId: string): Asked | undefined {
    const from = this.#from(this.#b.basis(runId));
    return from ? { by: from.by, named: from.named, place: from.place } : undefined;
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
    const principal = JSON.parse(event.principal) as { kind?: unknown; id?: unknown; explicit?: unknown };
    const data = JSON.parse(event.data) as { group?: unknown; card?: unknown; routed_from?: unknown };
    return principal.kind === "human" && principal.explicit === true && typeof principal.id === "string" && data.group === true && data.card === undefined && data.routed_from === undefined ? principal.id : undefined;
  }

  /**
   * For a run, and the place a message of it is to be sent to: the thing it is about (so that
   * one thing reminds a person once), and a way of telling, of someone the model names (by an
   * id; by a name as the one who asked wrote it), who they are if they may be reminded.
   * Undefined where nobody may be: not where several people talk; nothing says whose thing it
   * is, or where it was asked; it came up in another conversation, or another place, than the
   * one this message goes out in.
   */
  of(run: RunRow, target: string | null | undefined): { event: string; who(asked: string): string | undefined; timer?: string } | undefined {
    if (this.#s.scope().kind !== "chat") return undefined;
    const here = this.#s.rows<{ session_key: string }>("SELECT session_key FROM sessions WHERE id = ?", run.session_id)[0]?.session_key;
    const events = this.#b.basis(run.id);
    if (here === undefined || events.length === 0) return undefined;
    let about: { event: string; by: string; named: Named[]; sessionKey: string; place: string; timer?: string } | undefined;
    const said = this.#from(events);
    const [only] = events;
    if (said) about = { event: `message:${said.first}`, by: said.by, named: said.named, sessionKey: said.sessionKey, place: said.place };
    else if (events.length === 1 && only.source === "worker" && ["worker.result", "worker.failed", "worker.lost"].includes(only.kind)) {
      // A task that has had its end, well or not: one thing, however it ended.
      // (Whose task: as the Brain wrote it on the event; who asked for it, whom they named and where: as kept with the task when it was made.)
      const id = String((JSON.parse(only.principal) as { id?: unknown }).id ?? "");
      const task = this.#s.rows<{ session_key: string; asked: string }>("SELECT t.session_key, a.asked FROM tasks t JOIN task_asked a ON a.task_id = t.id WHERE t.id = ?", id)[0];
      const kept = task ? (JSON.parse(task.asked) as Partial<Asked>) : undefined;
      if (task && typeof kept?.by === "string" && typeof kept.place === "string") about = { event: `task:${id}`, by: kept.by, named: named(kept.named), sessionKey: task.session_key, place: kept.place };
    } else if (events.length === 1 && only.source === "timer" && only.kind === "timer") {
      const id = String((JSON.parse(only.principal) as { id?: unknown }).id ?? "");
      const timer = this.#s.rows<{ data: string | null; session_key: string }>("SELECT data, session_key FROM timers WHERE id = ?", id)[0];
      const kept = JSON.parse(timer?.data ?? "{}") as Partial<Asked> & { stop_after_reminding?: unknown; reminded?: unknown };
      // One set to stop once it has reminded has done so, at an earlier firing: no later one reminds, whenever it is taken up.
      if (kept.stop_after_reminding === true && kept.reminded !== undefined) return undefined;
      // Each time it fires is a thing of its own.
      if (timer && typeof kept.by === "string" && typeof kept.place === "string") about = { event: `timer:${id}:${only.id}`, by: kept.by, named: named(kept.named), sessionKey: timer.session_key, place: kept.place, ...(kept.stop_after_reminding === true ? { timer: id } : {}) };
    }
    // Where it came up and where this goes out are one conversation (the same topic of the same
    // chat) and one place as the connector addresses it (the same account, the same chat, for
    // everyone there to see).
    if (!about || about.sessionKey !== here || about.place !== placeOf(target)) return undefined;
    const { by, sessionKey } = about;
    // Named by them: by who they are, always; by the name only where it means one person.
    const ids = new Set(about.named.map((each) => each.id));
    const names = new Map<string, Set<string>>();
    for (const each of about.named) names.set(each.name.toLowerCase(), new Set([...(names.get(each.name.toLowerCase()) ?? []), each.id]));
    const who = (asked: string): string | undefined => {
      const ref = asked.trim();
      if (ref === "") return undefined;
      if (ref.toLowerCase() === by.toLowerCase()) return by;
      const meant = names.get(ref.toLowerCase());
      if (meant?.size === 1) return [...meant][0];
      const exact = [...ids].find((id) => id.toLowerCase() === ref.toLowerCase());
      if (exact) return exact;
      // Someone who has written to the agent in this conversation themselves: looked for by who they are, however long ago, in what is still kept of it.
      for (const each of this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND kind = 'message' AND text IS NOT NULL AND data IS NOT NULL AND lower(json_extract(principal, '$.id')) = ? ORDER BY id DESC LIMIT 50", sessionKey, ref.toLowerCase())) {
        const writer = this.#writer(each);
        if (writer !== undefined && placeOf(each.reply_to as string | null) === about!.place) return writer;
      }
      return undefined;
    };
    return { event: about.event, who, ...(about.timer ? { timer: about.timer } : {}) };
  }

  /**
   * Who a message of this run, to be sent to `target`, reminds, of those the model asked for: in
   * the order asked, each once, none who was already reminded of this thing, and no more than a
   * few. Taken for this thing in the same step, so it has to be called in one transaction with
   * keeping the message. A timer set to stop once it has reminded stops here, and that it has is
   * written on it, so that a firing of it already waiting reminds nobody.
   */
  claim(run: RunRow, asked: string[], target: string | null | undefined): string[] {
    const may = asked.length > 0 ? this.of(run, target) : undefined;
    if (!may) return [];
    const reminded: string[] = [];
    for (const each of asked) {
      const id = may.who(each);
      if (id === undefined || reminded.includes(id) || this.#s.rows("SELECT 1 FROM reminded WHERE event = ? AND person = ?", may.event, id).length > 0) continue;
      reminded.push(id);
      if (reminded.length === MAX_REMINDED) break;
    }
    for (const id of reminded) this.#s.sql.exec("INSERT INTO reminded (event, person, at) VALUES (?, ?, ?)", may.event, id, Date.now());
    if (reminded.length > 0 && may.timer) {
      const kept = JSON.parse(this.#s.rows<{ data: string | null }>("SELECT data FROM timers WHERE id = ?", may.timer)[0]?.data ?? "{}") as Record<string, unknown>;
      this.#s.sql.exec("UPDATE timers SET status = CASE WHEN status = 'active' THEN 'done' ELSE status END, data = ? WHERE id = ?", JSON.stringify({ ...kept, reminded: may.event }), may.timer);
    }
    return reminded;
  }
}
