/**
 * The index of work handed to workers: one row for each piece of work, whichever worker it went
 * to, under the id it has where it is carried out. Written here and read by nothing yet (step 2
 * of docs/design/workers.zh-CN.md): carrying work out and delivering its result stay where they are.
 *
 * A row is opened once and ends once. Opening it again (the same request waiting on something
 * else, a call made again after an interruption) changes only what it waits under.
 */
import type { BrainStore } from "./store";

export type WorkEnd = "done" | "failed" | "cancelled" | "expired" | "void" | "unknown";

/** A piece of work has been handed over, or is on its way to be: kept under its id, once. */
export function workOpened(store: BrainStore, work: { id: string; worker: string; sessionKey: string; person: string | null; under?: { condition: string; generation: number } }): void {
  const now = Date.now();
  store.sql.exec(
    `INSERT INTO work (id, worker, session_key, person, state, condition, generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET condition = excluded.condition, generation = excluded.generation, updated_at = excluded.updated_at WHERE work.state = 'open'`,
    work.id,
    work.worker,
    work.sessionKey,
    work.person,
    work.under?.condition ?? null,
    work.under?.generation ?? null,
    now,
    now,
  );
}

/** A piece of work has ended, once: a later word on it changes nothing. Nothing happens for an id that is not work. */
export function workEnded(store: BrainStore, id: string, as: WorkEnd): void {
  store.sql.exec("UPDATE work SET state = ?, updated_at = ? WHERE id = ? AND state = 'open'", as, Date.now(), id);
}
