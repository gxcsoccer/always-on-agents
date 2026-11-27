/**
 * Marks: what a channel showed on a person's message to say it arrived (a reaction, say), kept
 * with that message, and taken off once the message has been dealt with (its inbox row is done
 * or dead). Nothing waits for this and nothing depends on it; it is only kept until its removal
 * is known, so that a restart or a busy channel does not leave a mark behind. One part of the
 * Brain, on the shared store.
 */
import type { Target } from "../events";
import type { BrainStore, Wakes } from "./store";

/** How long to wait before asking the channel again, by how many times it was asked. */
const RETRY_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
/** At most this many marks are taken off in one go. */
const BATCH = 20;

export interface MarksHost {
  /** Asks the channel to take a mark off. Never throws. */
  unmark(source: string, event: { data?: Record<string, unknown>; reply_to?: Target }, mark: string): Promise<"removed" | "retry" | "permanent">;
}

export class Marks implements Wakes {
  readonly #s: BrainStore;
  readonly #b: MarksHost;

  constructor(store: BrainStore, host: MarksHost) {
    this.#s = store;
    this.#b = host;
  }

  /**
   * Keeps the mark a channel put on a message, on that very message. True when it is due to come
   * off at once: the message was dealt with before the channel confirmed the mark.
   */
  keep(source: string, sourceId: string, mark: string): boolean {
    const row = this.#s.rows<{ status: string }>("UPDATE inbox SET mark = ?, mark_attempts = 0, mark_next_at = NULL WHERE source = ? AND source_id = ? RETURNING status", mark, source, sourceId)[0];
    return row !== undefined && (row.status === "done" || row.status === "dead" || row.status === "dropped");
  }

  /** When a mark is next due to come off: now for one whose message was dealt with, or its next try. */
  nextWakeAt(now: number): number | null {
    return this.#s.rows<{ at: number | null }>("SELECT MIN(COALESCE(mark_next_at, ?)) AS at FROM inbox WHERE mark IS NOT NULL AND status IN ('done', 'dead', 'dropped')", now)[0]?.at ?? null;
  }

  /** Takes off the marks of messages that have been dealt with and are due, asking the channel for each. */
  async clear(now: number): Promise<void> {
    const due = this.#s.rows<{ id: number; source: string; data: string | null; reply_to: string | null; mark: string; mark_attempts: number }>(
      "SELECT id, source, data, reply_to, mark, mark_attempts FROM inbox WHERE mark IS NOT NULL AND status IN ('done', 'dead', 'dropped') AND COALESCE(mark_next_at, 0) <= ? ORDER BY id LIMIT ?",
      now,
      BATCH,
    );
    for (const row of due) {
      const event = { ...(row.data ? { data: JSON.parse(row.data) as Record<string, unknown> } : {}), ...(row.reply_to ? { reply_to: JSON.parse(row.reply_to) as Target } : {}) };
      const outcome = await this.#b.unmark(row.source, event, row.mark);
      const tries = row.mark_attempts + 1;
      if (outcome === "retry" && tries <= RETRY_MS.length) {
        this.#s.sql.exec("UPDATE inbox SET mark_attempts = ?, mark_next_at = ? WHERE id = ? AND mark = ?", tries, now + RETRY_MS[tries - 1], row.id, row.mark);
        continue;
      }
      // Off, already gone, refused, or tried as often as it will be: nothing more to do. Said once.
      if (outcome !== "removed") this.#s.log("mark_not_removed", { inbox_id: row.id, outcome, tries });
      this.#s.sql.exec("UPDATE inbox SET mark = NULL, mark_next_at = NULL WHERE id = ? AND mark = ?", row.id, row.mark);
    }
  }
}
