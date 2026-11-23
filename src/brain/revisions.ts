/**
 * Messages that can change after they were said: an edited or deleted comment.
 *
 * A connector whose messages can change gives each a subject, a revision and a holder (which
 * identifies the text of that revision). This part keeps what is known of each subject and says
 * whether a message read earlier still says what it said, so that nothing is approved on words
 * that are no longer there. The Brain builds it on its own database.
 */
import type { Standing } from "../connectors";
import { NOT_FOR_THE_AGENT, type Principal } from "../events";
import type { BrainStore, InboxRow } from "./store";

/** What this part needs from the Brain it is part of. */
export interface RevisionsHost {
  /** Whether this person's word counts here. */
  isDecider(principal: Principal, source: string): boolean;
  /** Whether this source can say what one of its messages says now. */
  canRevisit(source: string): boolean;
  /** What a revisable message says at its source now. Throws if the source cannot be asked. */
  standingOf(source: string, subject: string): Promise<Standing | undefined>;
}

/** When a message was said, according to its source if it tells us, else when it arrived. */
export function saidAt(event: InboxRow): number {
  const revision = event.data ? (JSON.parse(event.data) as { subject?: string; revision?: number }) : {};
  return revision.subject && typeof revision.revision === "number" ? revision.revision : event.received_at;
}

export class Revisions {
  readonly #s: BrainStore;
  readonly #b: RevisionsHost;

  constructor(store: BrainStore, host: RevisionsHost) {
    this.#s = store;
    this.#b = host;
  }

  /**
   * Records that a subject now stands at this revision, or is gone. Revisions only move forward,
   * so news heard out of order ends in the same state; two different texts claiming the same
   * revision leave nobody holding it.
   */
  revise(subject: string, revision: number, deleted: boolean, holder: string): void {
    const current = this.#s.rows<{ revision: number; deleted: number; holder: string }>("SELECT revision, deleted, holder FROM revisions WHERE subject = ?", subject)[0];
    if (!current) {
      this.#s.sql.exec("INSERT INTO revisions (subject, revision, deleted, holder) VALUES (?, ?, ?, ?)", subject, revision, deleted ? 1 : 0, holder);
      return;
    }
    if (deleted) this.#s.sql.exec("UPDATE revisions SET deleted = 1 WHERE subject = ?", subject);
    else if (revision > current.revision) this.#s.sql.exec("UPDATE revisions SET revision = ?, holder = ? WHERE subject = ?", revision, holder, subject);
    // Told twice about one revision with different texts: nobody holds it. Except that a revision
    // known not to be for the agent stays so, whatever its text is.
    // known not to be for the agent is so whatever its text, whichever of the two was heard first.
    else if (revision === current.revision && holder === NOT_FOR_THE_AGENT) this.#s.sql.exec("UPDATE revisions SET holder = ? WHERE subject = ?", NOT_FOR_THE_AGENT, subject);
    else if (revision === current.revision && holder !== current.holder && current.holder !== NOT_FOR_THE_AGENT) this.#s.sql.exec("UPDATE revisions SET holder = '' WHERE subject = ?", subject);
  }

  /** False if the thing this event was read from has since been edited or deleted. */
  stillStands(event: InboxRow): boolean {
    return this.standing(event) === "stands";
  }

  /** Whether what this event was read from still says the same, says something else now, or is gone. */
  standing(event: InboxRow): "stands" | "changed" | "deleted" | "withdrawn" {
    const data = event.data ? (JSON.parse(event.data) as { subject?: string; revision?: number; holder?: string }) : {};
    if (!data.subject) return "stands";
    const current = this.#s.rows<{ revision: number; deleted: number; holder: string }>("SELECT revision, deleted, holder FROM revisions WHERE subject = ?", data.subject)[0];
    if (current?.deleted) return "deleted";
    if (current && current.holder === NOT_FOR_THE_AGENT && current.revision > (data.revision ?? 0)) return "withdrawn";
    return current && current.revision === data.revision && current.holder !== "" && current.holder === data.holder ? "stands" : "changed";
  }

  /**
   * Whether the author of a reply that was moved to its question's conversation has said anything
   * since in the conversation where they typed it.
   */
  saidSinceWhereTyped(reply: InboxRow, since: number): boolean {
    const origin = (JSON.parse(reply.data ?? "{}") as { routed_from?: string }).routed_from;
    if (!origin) return false;
    const author = (JSON.parse(reply.principal) as Principal).id;
    const later = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE session_key = ? AND received_at > ? AND id != ?", origin, since, reply.id).filter(
      (event) => (JSON.parse(event.principal) as Principal).id === author && (saidAt(event) > saidAt(reply) || (saidAt(event) === saidAt(reply) && event.id > reply.id)),
    );
    return this.reconcile(later).events.length > 0;
  }

  /**
   * Brings a set of messages up to date with what their sources say now. A message whose comment
   * was edited is dropped when the edit has arrived as a message of its own; if the edit is known
   * of but has not arrived, the set is unresolved and nothing should be approved on it.
   */
  reconcile(events: InboxRow[]): { events: InboxRow[]; unresolved: boolean } {
    let unresolved = false;
    const current = events.filter((event) => {
      const standing = this.standing(event);
      // A deleted comment says nothing any more, for or against. Nor does one edited into
      // something that is not for the agent: no new message will come to replace it.
      if (standing === "deleted" || standing === "withdrawn") return false;
      if (standing !== "changed") return true;
      const subject = (JSON.parse(event.data ?? "{}") as { subject?: string }).subject;
      // Whichever of them arrived first: the message that carries the subject's current text.
      const replaced = this.#s.rows<InboxRow>("SELECT * FROM inbox WHERE id != ? AND json_extract(data, '$.subject') = ?", event.id, subject ?? "").some((other) => this.standing(other) === "stands");
      if (!replaced) unresolved = true;
      return !replaced;
    });
    return { events: current, unresolved };
  }

  /**
   * Looks again at the source of every revisable message that could decide this question. The news
   * that a comment was edited or deleted can still be on its way when the approval is acted on.
   */
  async refreshStanding(events: InboxRow[]): Promise<void> {
    const subjects = new Map<string, string>();
    const deciding = new Set<string>();
    for (const event of events) {
      const subject = event.data ? (JSON.parse(event.data) as { subject?: string }).subject : undefined;
      if (!subject) continue;
      subjects.set(subject, event.source);
      if (this.#b.isDecider(JSON.parse(event.principal) as Principal, event.source)) deciding.add(subject);
    }
    for (const [subject, source] of subjects) {
      // A message that can change, from a connector that cannot say what it says now, cannot be
      // relied on for an approval.
      // Only where it could decide something: a notification nobody's approval rests on is left alone.
      if (!this.#b.canRevisit(source)) {
        if (!deciding.has(subject)) continue;
        throw new Error(`a reply here came through "${source}", which cannot confirm what the reply says now, so nothing can be approved on it`);
      }
      const standing = await this.#b.standingOf(source, subject);
      // Its own connector does not know the message. What it says now is then not known either.
      if (!standing && deciding.has(subject)) throw new Error(`"${source}" does not recognise a reply here as one of its messages, so what the reply says now cannot be confirmed and nothing can be approved on it`);
      if (standing) this.revise(subject, standing.revision, standing.deleted, standing.holder);
    }
  }
}
