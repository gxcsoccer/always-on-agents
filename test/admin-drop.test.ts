/**
 * An operator lets go of what waits in a scope and will never be worth doing: notifications of
 * one kind in conversations named, as they stood when stock was taken, and timers named.
 * Nothing of what they say is read.
 */
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { brain, call, installFakeModel, message, model, modelCalls, say, wake } from "./helpers";

beforeEach(() => installFakeModel());

const admin = (method: string, path: string, body?: unknown) => (exports as any).default.fetch(new Request(`https://agent.test/v1/admin/${path}`, { method, headers: { authorization: "Bearer test-admin", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })) as Promise<Response>;
const rowsOf = (stub: any, query: string): Promise<any[]> => runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec(query).toArray());
/** A notification of a push, as a connector for code would bring it: nobody's words. */
const pushed = (key: string) => message("a push", { source: "git", kind: "git.pull_request", session_key: key, principal: { kind: "human", id: "dev", explicit: false, unlinked: true } });

describe("letting go of what waits in a scope", () => {
  it("drops the waiting notifications of one kind in the conversations named, up to where stock was taken, and nothing else; says how many, and keeps a record", async () => {
    const { name, stub } = brain("repo");
    const drop = async (body: unknown) => (await admin("POST", `scopes/${encodeURIComponent(name)}/drop`, body)).json();
    for (const key of ["pr:1", "pr:1", "pr:2", "pr:3"]) await stub.ingest(pushed(key));
    // One of that very kind that a person addressed to the agent stays, whatever it is called.
    await stub.ingest(message("look at this one", { source: "git", kind: "git.pull_request", session_key: "pr:1" }));
    // In the same conversation: a person's word, and what a request and a task wait to be told. None of them is such a notification.
    await stub.ingest(message("hold on a moment", { session_key: "pr:1" }));
    await stub.ingest(message("", { source: "request", kind: "request.ready", session_key: "pr:1", principal: { kind: "automation", id: "request" } }));
    await stub.ingest(message("done", { source: "worker", kind: "worker.result", session_key: "pr:1", principal: { kind: "worker", id: "t1" } as any }));

    // Stock is taken from what the scope says of itself: how much waits where, of what kind, and up to which event. No words.
    const waiting = (await stub.inspect()).waiting;
    expect(waiting).toContainEqual({ session_key: "pr:1", source: "git", kind: "git.pull_request", events: 3, up_to: expect.any(Number) });
    const upTo = Math.max(...waiting.map((each: any) => each.up_to));
    // Another push arrives after stock was taken: the pull request was opened again.
    await stub.ingest(pushed("pr:2"));

    const asked = { sessions: ["pr:1", "pr:2", "pr:404"], source: "git", kind: "git.pull_request", up_to: upTo };
    expect(await drop(asked)).toEqual({ events: 3, timers: 0, timer_events: 0 });
    // Asked again, it drops nothing more: what came since stays.
    expect(await drop(asked)).toEqual({ events: 0, timers: 0, timer_events: 0 });

    expect(await rowsOf(stub, "SELECT session_key, kind, status FROM inbox ORDER BY id")).toEqual([
      { session_key: "pr:1", kind: "git.pull_request", status: "dropped" },
      { session_key: "pr:1", kind: "git.pull_request", status: "dropped" },
      { session_key: "pr:2", kind: "git.pull_request", status: "dropped" },
      { session_key: "pr:3", kind: "git.pull_request", status: "pending" },
      { session_key: "pr:1", kind: "git.pull_request", status: "pending" },
      { session_key: "pr:1", kind: "message", status: "pending" },
      { session_key: "pr:1", kind: "request.ready", status: "pending" },
      { session_key: "pr:1", kind: "worker.result", status: "pending" },
      { session_key: "pr:2", kind: "git.pull_request", status: "pending" },
    ]);
    const state = await stub.inspect();
    expect(state.inbox).toMatchObject({ pending: 6, dropped: 3, dead: 0 });
    // By whom and how much, not what any of it said.
    expect(JSON.parse(state.audit.find((each: any) => each.action === "admin.dropped" && JSON.parse(each.detail).events === 3).detail)).toEqual({ ...asked, timers: [], events: 3, cancelled: 0, timer_events: 0 });
  });

  it("cancels the timers named together with what they have already put in line, so that none of them starts a run", async () => {
    const { name, stub } = brain("repo");
    model.replies([call("set_timer", { delay_seconds: 60, note: "try again", repeat_every_seconds: 600, stop_after_reminding: null })], [say("")]);
    await stub.ingest(message("first", { session_key: "pr:1" }));
    await wake(stub);
    const [timer] = await rowsOf(stub, "SELECT id FROM timers WHERE status = 'active' AND id LIKE 'tmr_%'");
    // It has fired, and its event waits; so does a task's own watch, and that task's word that it is overdue.
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO inbox (source, source_id, kind, session_key, principal, text, status, received_at) VALUES ('timer', ?, 'timer', 'pr:1', ?, 'try again', 'pending', 1)", `${timer.id}:1`, JSON.stringify({ kind: "timer", id: timer.id, explicit: false }));
      state.storage.sql.exec("INSERT INTO inbox (source, source_id, kind, session_key, principal, text, status, received_at) VALUES ('timer', 'watch_t1:1', 'task.overdue', 'pr:1', ?, 'late', 'pending', 1)", JSON.stringify({ kind: "timer", id: "watch_t1", explicit: false }));
      state.storage.sql.exec("INSERT INTO timers (id, due_at, note, session_key, status, data, created_at) VALUES ('watch_t1', ?, 'watch', 'pr:1', 'active', '{\"task_id\":\"t1\"}', 1)", Date.now() + 3_600_000);
    });
    expect(await (await admin("POST", `scopes/${encodeURIComponent(name)}/drop`, { timers: [timer.id, "tmr_unknown", "watch_t1"] })).json()).toEqual({ events: 0, timers: 1, timer_events: 1 });
    expect(await rowsOf(stub, "SELECT id, status FROM timers ORDER BY id")).toEqual([
      { id: timer.id, status: "cancelled" },
      { id: "watch_t1", status: "active" },
    ]);
    expect(await rowsOf(stub, "SELECT kind, status FROM inbox WHERE source = 'timer' ORDER BY id")).toEqual([
      { kind: "timer", status: "dropped" },
      { kind: "task.overdue", status: "pending" },
    ]);
  });

  it("leaves alone what a run has already taken up, and refuses what is asked for wrongly: people's words are never dropped this way", async () => {
    const { name, stub } = brain("repo");
    const drop = (body: unknown) => admin("POST", `scopes/${encodeURIComponent(name)}/drop`, body);
    await stub.ingest(pushed("pr:1"));
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => void state.storage.sql.exec("UPDATE inbox SET status = 'claimed'"));
    expect(await (await drop({ sessions: ["pr:1"], source: "git", kind: "git.pull_request", up_to: 1_000 })).json()).toEqual({ events: 0, timers: 0, timer_events: 0 });
    for (const bad of [
      {},
      { sessions: "pr:1", source: "git", kind: "git.pull_request", up_to: 5 },
      { sessions: ["pr:1"] },
      { sessions: ["pr:1"], source: "git", kind: "git.pull_request" },
      { sessions: ["pr:1"], source: "console", kind: "message", up_to: 5 },
      { sessions: ["pr:1"], source: "request", kind: "request.ready", up_to: 5 },
      { sessions: ["pr:1"], source: "timer", kind: "timer", up_to: 5 },
      { timers: [null] },
      { sessions: [], timers: [] },
    ]) {
      expect((await drop(bad)).status).toBe(400);
    }
    expect(modelCalls).toHaveLength(0);
  });
});
