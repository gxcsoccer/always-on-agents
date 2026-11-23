/**
 * Timers: a due timer becomes an event in the inbox; it never runs the agent directly. One part
 * of the Brain, on the shared store.
 */
import { type BrainStore, type Row, TERMINAL_TASK, type Wakes } from "./store";

export class Timers implements Wakes {
  readonly #s: BrainStore;

  constructor(store: BrainStore) {
    this.#s = store;
  }

  /** Turns every timer due by `now` into an event, and moves it on or ends it, in one step. */
  fire(now: number): void {
    this.#s.transaction(() => {
      for (const timer of this.#s.rows<Row>("SELECT * FROM timers WHERE status = 'active' AND due_at <= ?", now)) {
        const data = timer.data ? JSON.parse(timer.data) : {};
        // A watchdog for a task that already ended has nothing to say.
        const stale = data.task_id && TERMINAL_TASK.has(this.#s.rows<Row>("SELECT status FROM tasks WHERE id = ?", data.task_id)[0]?.status);
        if (!stale) {
          this.#s.insertEvent({
            source: "timer",
            source_id: `${timer.id}:${timer.due_at}`,
            kind: data.task_id ? "task.overdue" : "timer",
            session_key: timer.session_key,
            principal: { kind: "timer", id: timer.id, explicit: false },
            text: timer.note,
            data,
          });
        }
        if (timer.every_s && !stale) {
          // Skip occurrences that were missed while asleep rather than firing them all at once.
          const next = Math.max(timer.due_at + timer.every_s * 1_000, now + timer.every_s * 1_000);
          this.#s.sql.exec("UPDATE timers SET due_at = ? WHERE id = ?", next, timer.id);
        } else {
          this.#s.sql.exec("UPDATE timers SET status = 'done' WHERE id = ?", timer.id);
        }
      }
    });
  }

  nextWakeAt(_now: number): number | null {
    return this.#s.rows<{ due_at: number | null }>("SELECT MIN(due_at) AS due_at FROM timers WHERE status = 'active'")[0]?.due_at ?? null;
  }
}
