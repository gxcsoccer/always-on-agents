/**
 * Timers: a due timer becomes an event in the inbox; it never runs the agent directly. One part
 * of the Brain, on the shared store.
 */
import { type BrainStore, type Row, TERMINAL_TASK, type Wakes } from "./store";

/** How many times a repeating timer comes round before it ends by itself. */
export const REPEATS = 50;

export class Timers implements Wakes {
  readonly #s: BrainStore;

  constructor(store: BrainStore) {
    this.#s = store;
  }

  /**
   * Turns every timer due by `now` into an event, and moves it on or ends it, in one step.
   *
   * A repeating timer has one event waiting at a time: while the last one has not been dealt
   * with, a new firing adds nothing, so a scope that cannot run for a while (its day's usage
   * spent, say) is not met by hundreds of the same reminder when it can again. And it does not
   * repeat for ever: after so many times it could have fired it ends by itself, and its last
   * event says so, so that one nobody cancelled stops costing a run every time it fires. That
   * is hours for one that fires every few minutes and about a year for a weekly one. Set
   * again, it runs as long again.
   */
  fire(now: number): void {
    this.#s.transaction(() => {
      // Firings of one timer that piled up before only one was kept waiting: the latest stands for them all.
      this.#s.sql.exec(
        "UPDATE inbox SET status = 'done' WHERE source = 'timer' AND kind = 'timer' AND status = 'pending' AND id NOT IN (SELECT MAX(id) FROM inbox WHERE source = 'timer' AND kind = 'timer' AND status = 'pending' GROUP BY json_extract(principal, '$.id'))",
      );
      for (const timer of this.#s.rows<Row>("SELECT * FROM timers WHERE status = 'active' AND due_at <= ?", now)) {
        const data = timer.data ? JSON.parse(timer.data) : {};
        // A watchdog for a task that already ended has nothing to say.
        const stale = data.task_id && TERMINAL_TASK.has(this.#s.rows<Row>("SELECT status FROM tasks WHERE id = ?", data.task_id)[0]?.status);
        const last = Boolean(timer.every_s) && now - timer.created_at >= REPEATS * timer.every_s * 1_000;
        const waiting = Boolean(timer.every_s) && this.#s.rows("SELECT 1 FROM inbox WHERE source = 'timer' AND status = 'pending' AND json_extract(principal, '$.id') = ? LIMIT 1", timer.id).length > 0;
        // The last one says that it ended, and stands in place of one still waiting: one reminder, not two.
        if (last && waiting) this.#s.sql.exec("UPDATE inbox SET status = 'done' WHERE source = 'timer' AND status = 'pending' AND json_extract(principal, '$.id') = ?", timer.id);
        if (!stale && (!waiting || last)) {
          this.#s.insertEvent({
            source: "timer",
            source_id: `${timer.id}:${timer.due_at}`,
            kind: data.task_id ? "task.overdue" : "timer",
            session_key: timer.session_key,
            principal: { kind: "timer", id: timer.id, explicit: false },
            text: timer.every_s ? `${timer.note}\n  (${last ? `this repeating timer has come round ${REPEATS} times and has now ended: set it again only if it is still needed` : `a repeating timer, id ${timer.id}: cancel it once what it is for is done or no longer wanted`})` : timer.note,
            data,
          });
        }
        if (timer.every_s && !stale && !last) {
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
