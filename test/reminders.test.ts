/**
 * Who a message may remind: the part of the Brain that decides it, by itself, over a real store.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { MAX_REMINDED, Reminders } from "../src/brain/reminders";
import { BrainStore, type InboxRow, type RunRow } from "../src/brain/store";

let scopes = 0;
const ANN = "ou_ann";
const BOB = "ou_bob";
const CAROL = "ou_carol";

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  let made = 0;
  /** A message in the inbox: by default one person's own, written to the agent in the chat's main conversation. */
  const message = (by: string, text: string, over: Partial<{ session_key: string; run: string; data: Record<string, unknown> | null; explicit: boolean; kind: string; source: string; principal: Record<string, unknown>; text: string | null }> = {}): number =>
    store.rows<{ id: number }>(
      "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, status, run_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?) RETURNING id",
      over.source ?? "feishu",
      `om_${++made}`,
      over.kind ?? "message",
      over.session_key ?? "chat",
      JSON.stringify(over.principal ?? { kind: "human", id: by, explicit: over.explicit ?? true }),
      over.text === undefined ? text : over.text,
      over.data === null ? null : JSON.stringify(over.data ?? { group: true }),
      over.run ?? null,
      Date.now(),
    )[0].id;
  const session = (key: string) => {
    store.sql.exec("INSERT OR IGNORE INTO sessions (id, session_key, target, created_at, updated_at) VALUES (?, ?, '{}', 1, 1)", `s:${key}`, key);
    return `s:${key}`;
  };
  /** A run in a conversation, over the events given it. */
  const run = (id: string, key = "chat"): RunRow => {
    store.sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES (?, ?, 'running', 1)", id, session(key));
    return store.rows<RunRow>("SELECT * FROM runs WHERE id = ?", id)[0];
  };
  const reminders = new Reminders(store, { basis: (runId) => store.rows<InboxRow>("SELECT * FROM inbox WHERE run_id = ? ORDER BY id", runId) });
  return { store, message, run, reminders };
}

const within = <T>(use: (all: ReturnType<typeof bench>) => T | Promise<T>, scope = "chat:oc_1"): Promise<T> =>
  runInDurableObject(env.BRAIN.getByName(`reminders${++scopes}:${scope}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));

describe("who a message may remind", () => {
  it("is the one who asked, those they named with the chat's own mention, and those who have written to the agent here; nobody else, by any way of naming them", async () => {
    await within(({ message, run, reminders }) => {
      message(BOB, "an earlier question of his");
      message("ou_dave", "said to the others, not to the agent", { explicit: false });
      message("ou_erin", "a button she pressed", { data: { group: true, card: true } });
      message("ou_frank", "kept without what it came with", { data: null });
      message("ou_gail", "its words are gone", { text: null });
      message(ANN, "tell @Carol when it is done", { run: "r1", data: { group: true, mentioned: [{ name: "@Carol", id: CAROL }] } });
      const may = reminders.of(run("r1"))!;
      expect(may.event).toMatch(/^message:\d+$/);
      expect(new Set(may.people.values())).toEqual(new Set([ANN, BOB, CAROL]));
      // In the order asked for, each once, however they are written; the rest are left out.
      expect(reminders.claim(run("r1b"), [])).toEqual([]);
      expect(reminders.claim(may && { ...run("r1c"), id: "r1" }, ["@carol", CAROL, "ou_dave", "ou_erin", "ou_frank", "ou_gail", "all", "ou_nobody", BOB.toUpperCase(), ANN])).toEqual([CAROL, BOB, ANN]);
    });
  });

  it("reminds a person of one thing once, however often it is asked, and of another thing again", async () => {
    await within(({ message, run, reminders, store }) => {
      message(ANN, "tell me when it is done", { run: "r1" });
      const first = run("r1");
      expect(reminders.claim(first, [ANN])).toEqual([ANN]);
      expect(reminders.claim(first, [ANN])).toEqual([]);
      expect(store.rows("SELECT person FROM reminded")).toEqual([{ person: ANN }]);
      message(ANN, "and this other thing", { run: "r2" });
      expect(reminders.claim(run("r2"), [ANN])).toEqual([ANN]);
    });
  });

  it("reminds no more than a few by one message, and the ones left out keep their turn", async () => {
    await within(({ message, run, reminders }) => {
      const many = Array.from({ length: MAX_REMINDED + 2 }, (_, n) => `ou_p${n}`);
      for (const each of many) message(each, "hello");
      message(ANN, "tell everyone", { run: "r1" });
      const asked = run("r1");
      expect(reminders.claim(asked, many)).toEqual(many.slice(0, MAX_REMINDED));
      // In another message of the same thing: those not yet reminded, and none of those who were.
      expect(reminders.claim(asked, many)).toEqual(many.slice(MAX_REMINDED));
    });
  });

  it("takes a name that would mean two people for neither, and one person named twice for one", async () => {
    await within(({ message, run, reminders }) => {
      message(ANN, "tell @Li and @Li, and @Wu and @Wu", { run: "r1", data: { group: true, mentioned: [{ name: "@Li", id: "ou_li1" }, { name: "@Li", id: "ou_li2" }, { name: "@Wu", id: "ou_wu" }, { name: "@Wu", id: "ou_wu" }, { name: "", id: "ou_x" }, { name: "@NoId" }] } });
      expect(reminders.claim(run("r1"), ["@Li", "@Wu", "@NoId", "ou_x"])).toEqual(["ou_wu"]);
    });
  });

  it("reminds nobody where there is only one person, where nothing says whose thing it is, or where it came up in another conversation of the chat", async () => {
    await within(({ message, run, reminders }) => {
      message(ANN, "tell me", { run: "r1", data: { direct: true } });
      expect(reminders.of(run("r1"))).toBeUndefined();
    }, `user:${ANN}`);
    await within(({ message, run, reminders }) => {
      // Two people's messages in one run; an event nobody wrote; a message not written to the agent.
      message(ANN, "one", { run: "r1" });
      message(BOB, "two", { run: "r1" });
      expect(reminders.of(run("r1"))).toBeUndefined();
      message("", "tick", { run: "r2", source: "timer", kind: "timer", principal: { kind: "timer", id: "tmr_unknown", explicit: false } });
      expect(reminders.of(run("r2"))).toBeUndefined();
      message(ANN, "aside", { run: "r3", explicit: false });
      expect(reminders.of(run("r3"))).toBeUndefined();
      // Asked in one topic of the chat; the message goes out in another, or in the chat's main conversation.
      message(ANN, "tell me, here", { run: "r4", session_key: "thread:t1" });
      expect(reminders.of(run("r4", "thread:t2"))).toBeUndefined();
      message(ANN, "tell me, here", { run: "r5", session_key: "thread:t1" });
      expect(reminders.of(run("r5", "chat"))).toBeUndefined();
      message(ANN, "tell me, here", { run: "r6", session_key: "thread:t1" });
      expect(reminders.claim(run("r6", "thread:t1"), [ANN])).toEqual([ANN]);
      // Those who wrote in another topic have not written here.
      message(BOB, "in the other topic", { session_key: "thread:t2" });
      message(ANN, "tell bob", { run: "r7", session_key: "thread:t1" });
      expect(reminders.claim(run("r7", "thread:t1"), [BOB])).toEqual([]);
    });
  });

  it("goes by what was kept with a task or a timer when it comes back: who asked, whom they named, and where", async () => {
    await within(({ message, run, reminders, store }) => {
      const result = (id: string, runId: string) => message("", "finished", { run: runId, source: "worker", kind: "worker.result", principal: { kind: "worker", id, explicit: false } });
      store.sql.exec("INSERT INTO tasks (id, op_id, worker, title, brief, session_key, requested_by, status, created_at, updated_at) VALUES ('t1', 'op1', 'sandbox', 't', 'b', 'chat', ?, 'succeeded', 1, 1)", ANN);
      store.sql.exec("INSERT INTO task_named (task_id, named) VALUES ('t1', ?)", JSON.stringify([{ name: "@Carol", id: CAROL }]));
      result("t1", "r1");
      expect(reminders.claim(run("r1"), [ANN, "@Carol", "ou_stranger"])).toEqual([ANN, CAROL]);
      // The result brought once more is the same thing: nobody is reminded of it again.
      result("t1", "r1again");
      expect(reminders.claim(run("r1again"), [ANN, "@Carol"])).toEqual([]);
      // A task nobody in particular asked for, or one of another conversation.
      store.sql.exec("INSERT INTO tasks (id, op_id, worker, title, brief, session_key, requested_by, status, created_at, updated_at) VALUES ('t2', 'op2', 'sandbox', 't', 'b', 'chat', NULL, 'succeeded', 1, 1)");
      result("t2", "r2");
      expect(reminders.of(run("r2"))).toBeUndefined();
      store.sql.exec("INSERT INTO tasks (id, op_id, worker, title, brief, session_key, requested_by, status, created_at, updated_at) VALUES ('t3', 'op3', 'sandbox', 't', 'b', 'thread:t9', ?, 'succeeded', 1, 1)", ANN);
      result("t3", "r3");
      expect(reminders.of(run("r3"))).toBeUndefined();

      // A timer: each time it fires is a thing of its own.
      const fires = (id: string, runId: string) => message("", "check", { run: runId, source: "timer", kind: "timer", principal: { kind: "timer", id, explicit: false } });
      store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, data, created_at) VALUES ('tmr_each', 1, 600, 'chat', 'n', ?, 1)", JSON.stringify({ by: ANN, named: [{ name: "@Carol", id: CAROL }] }));
      fires("tmr_each", "f1");
      fires("tmr_each", "f2");
      expect(reminders.claim(run("f1"), [ANN])).toEqual([ANN]);
      expect(reminders.claim(run("f2"), [ANN, "@Carol"])).toEqual([ANN, CAROL]);
      expect(store.rows("SELECT status FROM timers WHERE id = 'tmr_each'")).toEqual([{ status: "active" }]);
      // One set to stop once it has reminded: it ends with the first message that reminds someone, and not with one that reminds nobody.
      store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, data, created_at) VALUES ('tmr_once', 1, 600, 'chat', 'n', ?, 1)", JSON.stringify({ by: ANN, stop_after_reminding: true }));
      fires("tmr_once", "o1");
      expect(reminders.claim(run("o1"), ["ou_stranger"])).toEqual([]);
      expect(reminders.claim({ ...run("o1b"), id: "o1" }, [])).toEqual([]);
      expect(store.rows("SELECT status FROM timers WHERE id = 'tmr_once'")).toEqual([{ status: "active" }]);
      fires("tmr_once", "o2");
      expect(reminders.claim(run("o2"), [ANN])).toEqual([ANN]);
      expect(store.rows("SELECT status FROM timers WHERE id = 'tmr_once'")).toEqual([{ status: "done" }]);
      // One set before any of this was kept reminds nobody.
      store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, created_at) VALUES ('tmr_old', 1, NULL, 'chat', 'n', 1)");
      fires("tmr_old", "old");
      expect(reminders.of(run("old"))).toBeUndefined();
    });
  });

  it("says, of a run, who asked and whom they named, for a task or a timer made in it", async () => {
    await within(({ message, reminders }) => {
      message(ANN, "check and tell @Carol", { run: "r1", data: { group: true, mentioned: [{ name: "@Carol", id: CAROL }] } });
      expect(reminders.asked("r1")).toEqual({ by: ANN, named: [{ name: "@Carol", id: CAROL }] });
      message(ANN, "one", { run: "r2" });
      message(BOB, "two", { run: "r2" });
      expect(reminders.asked("r2")).toBeUndefined();
      expect(reminders.asked("r_none")).toBeUndefined();
    });
  });
});
