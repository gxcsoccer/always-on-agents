/**
 * Reading further back in a conversation than the model is shown.
 *
 * The model sees the latest turns of a conversation. What stands before them is still kept for a
 * while, and a question can need it ("what did we settle last week?"). This part reads it: what
 * people wrote to the agent in this conversation and what the agent's own messages said as they
 * reached it. Nothing else: not what a tool returned, not what the model wrote on the way, not a
 * message that has been edited or taken back since, not anything of another conversation.
 *
 * It reads the Brain's own record and asks nobody outside, so it is not a read of outside text.
 */
import type { Principal } from "../events";
import type { BrainStore, InboxRow, RunRow } from "./store";

/** How far back is read, whatever is still kept: said in the query itself, since what is kept is not cut by age alone. */
export const HISTORY_KEPT_MS = 30 * 86_400_000;
/** The most messages given at once. */
export const MAX_HISTORY = 30;
/** How much of one message is given. */
export const MAX_HISTORY_TEXT = 2_000;
/** How many rows are looked through for one answer: what is left out by then is said to be further back. */
const MAX_LOOKED_AT = 600;

export interface HistoryHost {
  /** Whether a message still says what it said when it came. */
  stillStands(event: InboxRow): boolean;
}

export interface HistoryMessage {
  at: string;
  /** "you" for the agent's own; a person as the model sees them elsewhere. */
  by: string;
  text: string;
  cut?: true;
}

type Found = { kind: "m" | "s"; id: number; at: number; text: string; principal: string | null; data: string | null };

export class History {
  readonly #s: BrainStore;
  readonly #b: HistoryHost;

  constructor(store: BrainStore, host: HistoryHost) {
    this.#s = store;
    this.#b = host;
  }

  /**
   * The latest messages of this run's conversation that fit what is asked, oldest first, and where
   * to go on from for those before them (null when there are none).
   */
  read(run: RunRow, ask: { query?: string; from?: string; before?: string; limit?: number }, now = Date.now()): { messages: HistoryMessage[]; earlier: string | null } {
    const limit = Math.max(1, Math.min(MAX_HISTORY, ask.limit ?? MAX_HISTORY));
    let at = cursorOf(ask.before);
    const found: Found[] = [];
    let more = false;
    for (let looked = 0; found.length <= limit; ) {
      const page = this.#page(run.session_id, now - HISTORY_KEPT_MS, at, ask.query ?? "", 100);
      for (const each of page) {
        if (found.length > limit) break;
        at = each;
        if (this.#fits(each, ask.from)) found.push(each);
      }
      looked += page.length;
      if (page.length < 100) break;
      // Not looked through to the end: there may be more, and it is said so.
      if (looked >= MAX_LOOKED_AT) {
        more = true;
        break;
      }
    }
    if (found.length > limit) {
      more = true;
      found.length = limit;
      at = found[limit - 1];
    }
    return {
      messages: found.reverse().map((each) => ({ at: new Date(each.at).toISOString(), by: writer(each), text: each.text.slice(0, MAX_HISTORY_TEXT), ...(each.text.length > MAX_HISTORY_TEXT ? { cut: true as const } : {}) })),
      earlier: more && at ? `${at.at}.${at.kind}${at.id}` : null,
    };
  }

  /** Whether a row is something to give: a person's own ordinary words written here that still stand, or the agent's; and by whoever was asked for. */
  #fits(each: Found, from?: string): boolean {
    if (each.kind === "s") return from === undefined || from === "you";
    const by = JSON.parse(each.principal ?? "{}") as Principal;
    const data = JSON.parse(each.data ?? "{}") as Record<string, unknown>;
    if (by.kind !== "human" || !["card", "question", "reply_only", "routed_from", "about_question"].every((name) => data[name] === undefined)) return false;
    if (from !== undefined && from !== by.id) return false;
    return this.#b.stillStands({ id: each.id, data: each.data } as InboxRow);
  }

  /** Rows of the conversation before a point, latest first: people's messages that are done with, and the agent's words as they arrived. */
  #page(sessionId: string, since: number, before: { at: number; kind: string; id: number } | undefined, query: string, limit: number): Found[] {
    return this.#s.rows<Found>(
      `SELECT * FROM (
         SELECT 'm' AS kind, id, received_at AS at, text, principal, data FROM inbox
           WHERE kind = 'message' AND status = 'done' AND text IS NOT NULL AND text != '' AND session_key = (SELECT session_key FROM sessions WHERE id = ?1)
         UNION ALL
         SELECT 's', outbox_id, sent_at, text, NULL, NULL FROM said WHERE session_id = ?1 AND text != ''
       )
       WHERE at >= ?2 AND (?3 IS NULL OR at < ?3 OR (at = ?3 AND (kind < ?4 OR (kind = ?4 AND id < ?5)))) AND (?6 = '' OR instr(lower(text), lower(?6)) > 0)
       ORDER BY at DESC, kind DESC, id DESC LIMIT ?7`,
      sessionId,
      since,
      before?.at ?? null,
      before?.kind ?? "",
      before?.id ?? 0,
      query,
      limit,
    );
  }
}

/** Where to read back from: a time, or the place an earlier answer ended at (a time and the row it stood at, so that rows of one instant are each read once). */
function cursorOf(before: string | undefined): { at: number; kind: string; id: number } | undefined {
  if (before === undefined) return undefined;
  const place = /^(\d+)\.([ms])(\d+)$/.exec(before);
  if (place) return { at: Number(place[1]), kind: place[2], id: Number(place[3]) };
  const time = Date.parse(before);
  if (Number.isNaN(time)) throw new Error("before is a time (2026-11-27T12:00:00Z) or what an earlier call gave as `earlier`");
  // Before every row of that instant.
  return { at: time, kind: "", id: 0 };
}

function writer(each: Found): string {
  if (each.kind === "s") return "you";
  const by = JSON.parse(each.principal ?? "{}") as Principal;
  return by.display ? `${by.display} (${by.id})` : by.id;
}
