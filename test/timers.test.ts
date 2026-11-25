import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { BrainStore } from "../src/brain/store";
import { Timers } from "../src/brain/timers";

/**
 * Timers by themselves, on a real Brain's storage: a due timer becomes an event in the inbox and
 * nothing else. No model, no run, no alarm.
 */
let scopes = 0;
function within<T>(use: (timers: Timers, store: BrainStore) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(`acme:user:timers-${++scopes}`), (_instance: unknown, state: DurableObjectState) => {
    const store = new BrainStore(state);
    return use(new Timers(store), store);
  });
}

const NOW = 1_800_000_000_000;
function timer(store: BrainStore, id: string, due: number, more: { every_s?: number; data?: Record<string, unknown>; status?: string; note?: string; created?: number } = {}) {
  store.sql.exec(
    "INSERT INTO timers (id, due_at, every_s, session_key, note, data, status, created_at) VALUES (?, ?, ?, 'dm', ?, ?, ?, ?)",
    id,
    due,
    more.every_s ?? null,
    more.note ?? `note of ${id}`,
    more.data ? JSON.stringify(more.data) : null,
    more.status ?? "active",
    more.created ?? NOW - 60_000,
  );
}
const events = (store: BrainStore) => store.rows<Record<string, any>>("SELECT source, source_id, kind, session_key, principal, text, data, status FROM inbox ORDER BY id");
const timers = (store: BrainStore) => Object.fromEntries(store.rows<{ id: string; status: string; due_at: number }>("SELECT id, status, due_at FROM timers").map((each) => [each.id, { status: each.status, due_at: each.due_at }]));

describe("timers", () => {
  it("turns a due timer into one event in its conversation, and is then done", async () => {
    await within((part, store) => {
      timer(store, "t1", NOW - 1, { note: "check the build" });
      part.fire(NOW);
      const [event] = events(store);
      expect(event).toMatchObject({ source: "timer", source_id: `t1:${NOW - 1}`, kind: "timer", session_key: "dm", text: "check the build", status: "pending" });
      expect(JSON.parse(event.principal)).toEqual({ kind: "timer", id: "t1", explicit: false });
      expect(timers(store)).toEqual({ t1: { status: "done", due_at: NOW - 1 } });
      // Firing again finds nothing due.
      part.fire(NOW + 1);
      expect(events(store)).toHaveLength(1);
    });
  });

  it("leaves a timer that is not due yet, and ones that are cancelled or done", async () => {
    await within((part, store) => {
      timer(store, "later", NOW + 1);
      timer(store, "cancelled", NOW - 1, { status: "cancelled" });
      timer(store, "done", NOW - 1, { status: "done" });
      part.fire(NOW);
      expect(events(store)).toEqual([]);
      expect(timers(store)).toMatchObject({ later: { status: "active" }, cancelled: { status: "cancelled" }, done: { status: "done" } });
    });
  });

  it("fires a timer that is due exactly now", async () => {
    await within((part, store) => {
      timer(store, "t1", NOW);
      part.fire(NOW);
      expect(events(store)).toHaveLength(1);
    });
  });

  it("moves a repeating timer on by its interval and keeps it active", async () => {
    await within((part, store) => {
      timer(store, "hourly", NOW - 1_000, { every_s: 3_600 });
      part.fire(NOW);
      expect(events(store)).toHaveLength(1);
      // The later of "one interval after it was due" and "one interval from now".
      expect(timers(store)).toEqual({ hourly: { status: "active", due_at: NOW + 3_600_000 } });
    });
  });

  it("fires a repeating timer once for the occurrences missed while asleep, not once for each", async () => {
    await within((part, store) => {
      timer(store, "minutely", NOW - 10 * 60_000, { every_s: 60 });
      part.fire(NOW);
      expect(events(store)).toHaveLength(1);
      expect(timers(store).minutely).toEqual({ status: "active", due_at: NOW + 60_000 });
    });
  });

  it("keeps one event of a repeating timer waiting at a time, and says with each how to end it", async () => {
    await within((part, store) => {
      timer(store, "every5", NOW - 1, { every_s: 300, note: "look again" });
      part.fire(NOW);
      expect(events(store).map((each) => each.text)).toEqual(["look again\n  (a repeating timer, id every5: cancel it once what it is for is done or no longer wanted)"]);
      // Not dealt with yet (the scope cannot run just now): it fires and moves on, and adds nothing.
      for (let n = 1; n <= 5; n++) part.fire(NOW + n * 300_000);
      expect(events(store)).toHaveLength(1);
      expect(timers(store).every5).toEqual({ status: "active", due_at: NOW + 6 * 300_000 });
      // Dealt with: the next firing is an event again.
      store.sql.exec("UPDATE inbox SET status = 'done'");
      part.fire(NOW + 6 * 300_000);
      expect(events(store).filter((each) => each.status === "pending")).toHaveLength(1);
      // A one-off timer is not held back by anything.
      timer(store, "once", NOW + 7 * 300_000 - 1);
      part.fire(NOW + 7 * 300_000);
      expect(events(store).filter((each) => each.status === "pending").map((each) => JSON.parse(each.principal).id)).toEqual(["every5", "once"]);
    });
  });

  it("ends a repeating timer after it has come round fifty times, and its last event says so in place of one still waiting", async () => {
    await within((part, store) => {
      // Every five minutes: fifty times is a little over four hours.
      timer(store, "forgotten", NOW - 1, { every_s: 300, note: "start the review when there is room", created: NOW - 49 * 300_000 });
      part.fire(NOW);
      expect(timers(store).forgotten.status).toBe("active");
      part.fire(NOW + 300_000);
      expect(timers(store).forgotten.status).toBe("done");
      const waiting = events(store).filter((each) => each.status === "pending");
      expect(waiting.map((each) => each.text)).toEqual(["start the review when there is room\n  (this repeating timer has come round 50 times and has now ended: set it again only if it is still needed)"]);
      part.fire(NOW + 2 * 300_000);
      expect(events(store)).toHaveLength(2);
    });
  });

  it("lets a daily or a weekly timer go on: set to fire first in a week and weekly after, it does not end at its first firing", async () => {
    await within((part, store) => {
      const WEEK = 7 * 24 * 3_600;
      timer(store, "weekly", NOW, { every_s: WEEK, created: NOW - WEEK * 1_000 });
      timer(store, "daily", NOW, { every_s: 24 * 3_600, created: NOW - 30 * 24 * 3_600_000 });
      part.fire(NOW);
      expect(timers(store)).toMatchObject({ weekly: { status: "active" }, daily: { status: "active" } });
      expect(events(store)).toHaveLength(2);
    });
  });

  it("lets the latest stand for firings of one timer that piled up before, and leaves other timers' events alone", async () => {
    await within((part, store) => {
      const piled = (id: string, at: number) => store.insertEvent({ source: "timer", source_id: `${id}:${at}`, kind: "timer", session_key: "dm", principal: { kind: "timer", id, explicit: false }, text: "again", data: {} });
      for (let n = 0; n < 40; n++) piled("tmr_a", NOW - n * 300_000);
      piled("tmr_b", NOW - 1);
      store.insertEvent({ source: "github", source_id: "pr-1", kind: "github.pull_request", session_key: "pr:1", principal: { kind: "service", id: "github", explicit: false }, text: "opened", data: {} });
      part.fire(NOW);
      const left = events(store).filter((each) => each.status === "pending");
      expect(left.map((each) => (each.source === "timer" ? JSON.parse(each.principal).id : each.source)).sort()).toEqual(["github", "tmr_a", "tmr_b"]);
      expect(events(store).filter((each) => each.status === "done")).toHaveLength(39);
    });
  });

  it("reports a task that is overdue as such, with the task it is about", async () => {
    await within((part, store) => {
      store.sql.exec("INSERT INTO tasks (id, op_id, worker, title, brief, session_key, status, created_at, updated_at) VALUES ('task1', 'op1', 'w', 't', 'b', 'dm', 'running', ?, ?)", NOW, NOW);
      timer(store, "watch_task1", NOW - 1, { data: { task_id: "task1" } });
      part.fire(NOW);
      const [event] = events(store);
      expect(event).toMatchObject({ kind: "task.overdue", source_id: `watch_task1:${NOW - 1}` });
      expect(JSON.parse(event.data)).toEqual({ task_id: "task1" });
      expect(timers(store).watch_task1.status).toBe("done");
    });
  });

  it("says nothing for the watchdog of a task that has already ended, repeating or not", async () => {
    await within((part, store) => {
      for (const [index, status] of ["succeeded", "failed", "lost", "cancelled"].entries()) {
        store.sql.exec("INSERT INTO tasks (id, op_id, worker, title, brief, session_key, status, created_at, updated_at) VALUES (?, ?, 'w', 't', 'b', 'dm', ?, ?, ?)", `task${index}`, `op${index}`, status, NOW, NOW);
        timer(store, `watch_task${index}`, NOW - 1, { data: { task_id: `task${index}` }, ...(index === 0 ? { every_s: 60 } : {}) });
      }
      part.fire(NOW);
      expect(events(store)).toEqual([]);
      expect(Object.values(timers(store)).map((each) => each.status)).toEqual(["done", "done", "done", "done"]);
    });
  });

  it("does not store the same occurrence twice if it is fired again before being marked", async () => {
    await within((part, store) => {
      timer(store, "t1", NOW - 1);
      part.fire(NOW);
      // As after an interruption that lost the mark but kept the event.
      store.sql.exec("UPDATE timers SET status = 'active' WHERE id = 't1'");
      part.fire(NOW);
      expect(events(store)).toHaveLength(1);
    });
  });

  it("asks to be woken for the earliest active timer, and for nothing when there is none", async () => {
    await within((part, store) => {
      expect(part.nextWakeAt(NOW)).toBeNull();
      timer(store, "b", NOW + 5_000);
      timer(store, "a", NOW + 1_000);
      timer(store, "gone", NOW - 9_000, { status: "cancelled" });
      expect(part.nextWakeAt(NOW)).toBe(NOW + 1_000);
      // One already due is still the earliest: the wake cycle decides how soon that can be.
      timer(store, "overdue", NOW - 1);
      expect(part.nextWakeAt(NOW)).toBe(NOW - 1);
    });
  });
});
