/**
 * The index of work handed to workers: one row for each piece of work, whichever worker it went
 * to, under the id it has where it is carried out. Written here and read by nothing yet (step 2
 * of docs/design/workers.zh-CN.md): carrying work out and delivering its result stay where they are.
 *
 * A row is open until it ends, and ends once: what it ended as is not changed by a later word.
 * How a piece of work ended is its own outcome, as whoever carried it out says, and not whether
 * the person was told. A piece of work that has no row yet (taken before there was an index, or
 * ended at its first word) gets one whenever something is said of it.
 */
import type { BrainStore } from "./store";

export type WorkEnd = "done" | "failed" | "cancelled" | "expired" | "void" | "unknown";

export interface Work {
  id: string;
  worker: string;
  sessionKey: string;
  person: string | null;
  /** What it waits under, for work that waits on a condition of its worker's. */
  under?: { condition: string; generation: number };
}

/** How a piece of work stands now. Open again changes only what it waits under; an end is kept once. */
export function workIs(store: BrainStore, work: Work, as: "open" | WorkEnd): void {
  const now = Date.now();
  store.sql.exec(
    `INSERT INTO work (id, worker, session_key, person, state, condition, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, condition = COALESCE(excluded.condition, work.condition), generation = COALESCE(excluded.generation, work.generation), updated_at = excluded.updated_at
     WHERE work.state = 'open'`,
    work.id,
    work.worker,
    work.sessionKey,
    work.person,
    as,
    work.under?.condition ?? null,
    work.under?.generation ?? null,
    now,
    now,
  );
}
