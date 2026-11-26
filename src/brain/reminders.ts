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
/** How many of those who have written here are looked at. */
const MAX_SPOKEN = 200;

export interface RemindersHost {
  /** The messages a run rests on: its own, or the ones the request it carries on was made in. */
  basis(runId: string): InboxRow[];
}

/** A person named with the platform's own mention in one message, as the connector noted it: the name as it stands in the text, and who it is. */
type Named = { name: string; id: string };

const namedIn = (data: string | null): Named[] => {
  const noted = (JSON.parse(data ?? "{}") as { mentioned?: unknown }).mentioned;
  return Array.isArray(noted) ? noted.filter((each): each is Named => typeof each?.name === "string" && typeof each?.id === "string" && each.name !== "" && each.id !== "") : [];
};

export class Reminders {
  readonly #s: BrainStore;
  readonly #b: RemindersHost;

  constructor(store: BrainStore, host: RemindersHost) {
    this.#s = store;
    this.#b = host;
  }

  /**
   * What is noted when a task or a timer is made in a run, to be gone by when it comes back: who
   * asked, and whom they named. From the run's own messages alone, and only where they are one
   * person's own, written to the agent where several people talk.
   */
  asked(runId: string): { by: string; named: Named[] } | undefined {
    const from = this.#from(this.#b.basis(runId));
    return from ? { by: from.by, named: from.named } : undefined;
  }

  /** Whose words these are and whom they name, where they are one person's own messages to the agent in a shared place. */
  #from(events: InboxRow[]): { by: string; named: Named[]; first: number; sessionKey: string } | undefined {
    if (events.length === 0 || !events.every((each) => each.kind === "message" && each.session_key === events[0].session_key)) return undefined;
    const people = new Set(events.map((each) => this.#writer(each)));
    const by = [...people][0];
    if (people.size !== 1 || by === undefined) return undefined;
    return { by, named: events.flatMap((each) => namedIn(each.data)), first: events[0].id, sessionKey: events[0].session_key };
  }

  /** Who wrote a message to the agent themselves, where several people talk: said by the connector of that very message, which is still kept. None for anything else. */
  #writer(event: InboxRow): string | undefined {
    if (event.kind !== "message" || event.text === null || event.data === null) return undefined;
    const principal = JSON.parse(event.principal) as { kind?: unknown; id?: unknown; explicit?: unknown };
    const data = JSON.parse(event.data) as { group?: unknown; card?: unknown };
    return principal.kind === "human" && principal.explicit === true && typeof principal.id === "string" && data.group === true && data.card === undefined ? principal.id : undefined;
  }

  /**
   * For a run: the thing it is about (so that one thing reminds a person once), and everyone it
   * may remind, by the ways the model can name them (an id; a name as the one who asked wrote
   * it). Undefined where nobody may be: not where several people talk, or nothing says whose
   * thing it is, or it came up in another conversation than this message goes out in.
   */
  of(run: RunRow): { event: string; people: Map<string, string>; timer?: string } | undefined {
    if (this.#s.scope().kind !== "chat") return undefined;
    const here = this.#s.rows<{ session_key: string }>("SELECT session_key FROM sessions WHERE id = ?", run.session_id)[0]?.session_key;
    const events = this.#b.basis(run.id);
    if (here === undefined || events.length === 0) return undefined;
    let about: { event: string; by: string; named: Named[]; sessionKey: string; timer?: string } | undefined;
    const said = this.#from(events);
    if (said) about = { event: `message:${said.first}`, by: said.by, named: said.named, sessionKey: said.sessionKey };
    else if (events.length === 1 && events[0].source === "worker" && events[0].kind === "worker.result") {
      // (Whose task: as the Brain wrote it on the event; who asked for it and whom they named: as kept with the task.)
      const id = String((JSON.parse(events[0].principal) as { id?: unknown }).id ?? "");
      const task = this.#s.rows<{ requested_by: string | null; named: string | null; session_key: string }>("SELECT t.requested_by, n.named, t.session_key FROM tasks t LEFT JOIN task_named n ON n.task_id = t.id WHERE t.id = ?", id)[0];
      if (task?.requested_by) about = { event: `task:${id}`, by: task.requested_by, named: namedIn(JSON.stringify({ mentioned: JSON.parse(task.named ?? "[]") })), sessionKey: task.session_key };
    } else if (events.length === 1 && events[0].source === "timer" && events[0].kind === "timer") {
      const id = String((JSON.parse(events[0].principal) as { id?: unknown }).id ?? "");
      const timer = this.#s.rows<{ data: string | null; session_key: string }>("SELECT data, session_key FROM timers WHERE id = ?", id)[0];
      const kept = JSON.parse(timer?.data ?? "{}") as { by?: unknown; named?: unknown; stop_after_reminding?: unknown };
      // Each time it fires is a thing of its own.
      if (timer && typeof kept.by === "string") about = { event: `timer:${id}:${events[0].id}`, by: kept.by, named: namedIn(JSON.stringify({ mentioned: kept.named })), sessionKey: timer.session_key, ...(kept.stop_after_reminding === true ? { timer: id } : {}) };
    }
    // Where it came up and where this goes out are one conversation: the same group, and the same topic of it.
    if (!about || about.sessionKey !== here) return undefined;
    const people = new Map<string, string>([[about.by.toLowerCase(), about.by]]);
    // A name that would mean two people means neither; one person named twice is one.
    const byName = new Map<string, Set<string>>();
    for (const each of about.named) byName.set(each.name.toLowerCase(), new Set([...(byName.get(each.name.toLowerCase()) ?? []), each.id]));
    for (const [name, ids] of byName) {
      if (ids.size !== 1) continue;
      const [id] = [...ids];
      people.set(name, id);
      people.set(id.toLowerCase(), id);
    }
    // Those who have written to the agent here themselves, by what is still kept of their messages.
    for (const each of this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND kind = 'message' AND text IS NOT NULL AND data IS NOT NULL ORDER BY id DESC LIMIT ?", here, MAX_SPOKEN)) {
      const writer = this.#writer(each);
      if (writer) people.set(writer.toLowerCase(), writer);
    }
    return { event: about.event, people, ...(about.timer ? { timer: about.timer } : {}) };
  }

  /**
   * Who a message of this run reminds, of those the model asked for: in the order asked, each
   * once, none who was already reminded of this thing, and no more than a few. Taken for this
   * thing in the same step, so it has to be called in one transaction with keeping the message.
   * A timer set to stop once it has reminded stops here.
   */
  claim(run: RunRow, asked: string[]): string[] {
    const may = asked.length > 0 ? this.of(run) : undefined;
    if (!may) return [];
    const reminded: string[] = [];
    for (const each of asked) {
      const id = may.people.get(each.trim().toLowerCase());
      if (id === undefined || reminded.includes(id) || this.#s.rows("SELECT 1 FROM reminded WHERE event = ? AND person = ?", may.event, id).length > 0) continue;
      reminded.push(id);
      if (reminded.length === MAX_REMINDED) break;
    }
    for (const id of reminded) this.#s.sql.exec("INSERT INTO reminded (event, person, at) VALUES (?, ?, ?)", may.event, id, Date.now());
    if (reminded.length > 0 && may.timer) this.#s.sql.exec("UPDATE timers SET status = 'done' WHERE id = ? AND status = 'active'", may.timer);
    return reminded;
  }
}
