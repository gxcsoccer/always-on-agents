/**
 * An operator lets go of what waits in a scope and will never be worth doing: events of
 * conversations named, and timers named. Nothing of what they say is read.
 */
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { brain, call, installFakeModel, message, model, modelCalls, say, wake } from "./helpers";

beforeEach(() => installFakeModel());

const admin = (method: string, path: string, body?: unknown) => (exports as any).default.fetch(new Request(`https://agent.test/v1/admin/${path}`, { method, headers: { authorization: "Bearer test-admin", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })) as Promise<Response>;
const rowsOf = (stub: any, query: string): Promise<any[]> => runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec(query).toArray());

describe("letting go of what waits in a scope", () => {
  it("drops the waiting events of the conversations named and cancels the timers named, and nothing else; says how many, and keeps a record", async () => {
    const { name, stub } = brain("repo");
    // A timer, set by a run that has ended.
    model.replies([call("set_timer", { delay_seconds: 600, note: "try again", repeat_every_seconds: 600, stop_after_reminding: null })], [say("")]);
    await stub.ingest(message("first", { session_key: "pr:1" }));
    await wake(stub);
    const [timer] = await rowsOf(stub, "SELECT id FROM timers WHERE status = 'active' AND id LIKE 'tmr_%'");
    // Events waiting, in three conversations.
    for (const key of ["pr:1", "pr:1", "pr:2", "pr:3"]) await stub.ingest(message("a push", { session_key: key }));
    modelCalls.length = 0;

    const dropped = await admin("POST", `scopes/${encodeURIComponent(name)}/drop`, { sessions: ["pr:1", "pr:2", "pr:404"], timers: [timer.id, "tmr_unknown"] });
    expect(dropped.status).toBe(200);
    expect(await dropped.json()).toEqual({ events: 3, timers: 1 });

    expect(await rowsOf(stub, "SELECT session_key, status FROM inbox WHERE status IN ('pending', 'dropped') ORDER BY id")).toEqual([
      { session_key: "pr:1", status: "dropped" },
      { session_key: "pr:1", status: "dropped" },
      { session_key: "pr:2", status: "dropped" },
      { session_key: "pr:3", status: "pending" },
    ]);
    expect(await rowsOf(stub, "SELECT status FROM timers WHERE id LIKE 'tmr_%'")).toEqual([{ status: "cancelled" }]);
    const state = await stub.inspect();
    expect(state.inbox).toMatchObject({ pending: 1, dropped: 3, dead: 0 });
    // By whom and how much, not what any of it said.
    expect(JSON.parse(state.audit.find((each: any) => each.action === "admin.dropped").detail)).toEqual({ sessions: ["pr:1", "pr:2", "pr:404"], timers: [timer.id, "tmr_unknown"], events: 3, cancelled: 1 });

    // What is left is taken up as ever; what was dropped is not.
    model.replies([say("")]);
    await wake(stub);
    expect(modelCalls).toHaveLength(1);
    expect(JSON.stringify(modelCalls[0].input)).toContain("a push");
    expect((await stub.inspect()).inbox).toMatchObject({ pending: 0, dropped: 3 });
  });

  it("leaves alone what a run has already taken up, a task's own watch, and anything asked for wrongly", async () => {
    const { name, stub } = brain("repo");
    await stub.ingest(message("taken up", { session_key: "pr:1" }));
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE inbox SET status = 'claimed'");
      state.storage.sql.exec("INSERT INTO timers (id, due_at, note, session_key, status, data, created_at) VALUES ('watch_t1', ?, 'watch', 'pr:1', 'active', '{\"task_id\":\"t1\"}', 1)", Date.now() + 3_600_000);
    });
    expect(await (await admin("POST", `scopes/${encodeURIComponent(name)}/drop`, { sessions: ["pr:1"], timers: ["watch_t1"] })).json()).toEqual({ events: 0, timers: 0 });
    expect(await rowsOf(stub, "SELECT status FROM timers WHERE id = 'watch_t1'")).toEqual([{ status: "active" }]);
    for (const bad of [{}, { sessions: "pr:1" }, { sessions: [1] }, { timers: [null] }, { sessions: [], timers: [] }]) expect((await admin("POST", `scopes/${encodeURIComponent(name)}/drop`, bad)).status).toBe(400);
  });
});
