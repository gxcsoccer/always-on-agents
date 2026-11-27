/**
 * Who a message may remind: the part of the Brain that decides it, by itself, over a real store.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { MAX_REMINDED, Reminders, placeOf } from "../src/brain/reminders";
import { BrainStore, type InboxRow, type RunRow } from "../src/brain/store";

let scopes = 0;
const ANN = "ou_ann";
const BOB = "ou_bob";
const CAROL = "ou_carol";
/** Where a message was written, as the connector addresses it: the chat's main conversation, answering some message; or a topic of it. */
const AT = (over: Record<string, unknown> = {}) => JSON.stringify({ connector: "feishu", address: { app_id: "cli_1", chat_id: "oc_1", message_id: `om_${Math.random()}`, ...over } });
const HERE = AT();
const PLACE = placeOf(HERE)!;

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  let made = 0;
  /** A message in the inbox: by default one person's own, written to the agent in the chat's main conversation. */
  const message = (by: string, text: string, over: Partial<{ session_key: string; run: string; data: Record<string, unknown> | null; explicit: boolean; kind: string; source: string; principal: Record<string, unknown>; text: string | null; from: string | null }> = {}): number =>
    store.rows<{ id: number }>(
      "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, reply_to, status, run_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done', ?, ?) RETURNING id",
      over.source ?? "feishu",
      `om_${++made}`,
      over.kind ?? "message",
      over.session_key ?? "chat",
      JSON.stringify(over.principal ?? { kind: "human", id: by, explicit: over.explicit ?? true }),
      over.text === undefined ? text : over.text,
      over.data === null ? null : JSON.stringify(over.data ?? { group: true }),
      // (Written in the chat's main conversation unless said otherwise; an event nobody wrote comes from nowhere.)
      over.from === undefined ? ((over.kind ?? "message") === "message" ? AT() : null) : over.from,
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
  /** Runs that carry a request on, by the request; and connectors whose word on who wrote something does not count here. */
  const settings = { carrying: {} as Record<string, string>, untrusted: [] as string[] };
  const reminders = new Reminders(store, {
    basis: (runId) => store.rows<InboxRow>("SELECT * FROM inbox WHERE run_id = ? ORDER BY id", runId),
    carrying: (runId) => settings.carrying[runId],
    isDecider: (principal, source) => principal.kind === "human" && principal.unlinked !== true && !settings.untrusted.includes(source),
  });
  return { store, message, run, reminders, settings };
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
      message("ou_hal", "written in another topic, in answer to something asked here", { data: { group: true, routed_from: "thread:t5" } });
      const asked = run("r1");
      const may = reminders.of(asked, HERE)!;
      expect(may.event).toMatch(/^message:\d+$/);
      // In the order asked for, each once, however they are written; the rest are left out.
      expect(reminders.claim(asked, [], HERE)).toEqual([]);
      // The name she wrote for someone, for whoever is reminded by it; none for anyone else.
      // A name without the chat's mark before it is the same name; but never before who someone is.
      expect(reminders.of(asked, HERE)!.who("carol")).toBe(CAROL);
      // With the name she wrote for each, where she wrote one: told as they are taken.
      expect(reminders.claimed(asked, ["@carol", CAROL, "ou_dave", "ou_erin", "ou_frank", "ou_gail", "ou_hal", "all", "ou_nobody", BOB.toUpperCase(), ANN], HERE)).toEqual({ ids: [CAROL, BOB, ANN], names: { [CAROL]: "@Carol" } });
    });
  });

  it("takes a name given without its mark only where it is nobody by who they are, and tells the names of a timer that stops once it has reminded as it is taken", async () => {
    await within(({ message, run, reminders, store }) => {
      // Someone she named bears, for a name, what another person she named is by who they are.
      message(ANN, "tell @ou_bob and @Bob", { run: "r1", data: { group: true, mentioned: [{ name: `@${BOB}`, id: CAROL }, { name: "@Bob", id: BOB }] } });
      const asked = run("r1");
      expect(reminders.of(asked, HERE)!.who(BOB)).toBe(BOB);
      expect(reminders.of(asked, HERE)!.who("bob")).toBe(BOB);
      expect(reminders.of(asked, HERE)!.who(`@${BOB}`)).toBe(CAROL);
      // A timer set to stop once it has reminded: whose it was is told with the taking, not asked for afterwards.
      store.sql.exec("INSERT INTO timers (id, due_at, note, session_key, status, data, created_at) VALUES ('tmr_1', 1, 'n', 'chat', 'active', ?, 1)", JSON.stringify({ by: ANN, named: [{ id: CAROL, name: "@Carol" }], place: PLACE, stop_after_reminding: true }));
      message("", "", { run: "r2", kind: "timer", source: "timer", principal: { kind: "timer", id: "tmr_1", explicit: false }, data: null });
      expect(reminders.claimed(run("r2"), ["@Carol"], HERE)).toEqual({ ids: [CAROL], names: { [CAROL]: "@Carol" } });
    });
  });

  it("takes a name for nobody where someone the message named who cannot be reminded bears it too", async () => {
    await within(({ message, run, reminders }) => {
      // Two named by one name: a bot of the chat, and a person of another organisation, who is kept by the name alone.
      message(ANN, "remind @Helper, not @Helper", { run: "r1", data: { group: true, mentioned: [{ id: "ou_helper_bot", name: "@Helper" }, { id: "", name: "@Helper" }, { id: "", name: "@Guest" }] } });
      const asked = run("r1");
      const may = reminders.of(asked, HERE)!;
      expect(may.who("@Helper")).toBeUndefined();
      expect(may.who("helper")).toBeUndefined();
      expect(may.who("@Guest")).toBeUndefined();
      expect(may.who("guest")).toBeUndefined();
      expect(may.who("")).toBeUndefined();
      // By who it is, it is still the one it is; but the words name it by no name of its own.
      expect(may.who("ou_helper_bot")).toBe("ou_helper_bot");
      expect(reminders.claimed(asked, ["@Helper", "ou_helper_bot", "@Guest"], HERE)).toEqual({ ids: ["ou_helper_bot"], names: {} });
    });
  });

  it("finds someone who wrote here long ago, however much has been written since", async () => {
    await within(({ message, run, reminders }) => {
      message(BOB, "an early question of his");
      for (let n = 0; n < 260; n++) message(CAROL, `chatter ${n}`);
      message(ANN, "tell bob", { run: "r1" });
      expect(reminders.claim(run("r1"), [BOB], HERE)).toEqual([BOB]);
      // Nor however many of his own answers from elsewhere were brought in here since he wrote here himself.
      message("ou_ivy", "a question of hers, written here");
      for (let n = 0; n < 230; n++) message("ou_ivy", `an answer of hers from another topic ${n}`, { data: { group: true, routed_from: "thread:t5" } });
      message(ANN, "tell ivy", { run: "r2" });
      expect(reminders.claim(run("r2"), ["ou_ivy"], HERE)).toEqual(["ou_ivy"]);
      // One who only ever answered from elsewhere has not written here, through however many such.
      for (let n = 0; n < 230; n++) message("ou_jon", `an answer of his from another topic ${n}`, { data: { group: true, routed_from: "thread:t5" } });
      message(ANN, "tell jon", { run: "r3" });
      expect(reminders.claim(run("r3"), ["ou_jon"], HERE)).toEqual([]);
    });
  });

  it("reminds a person of one thing once, however often it is asked, and of another thing again", async () => {
    await within(({ message, run, reminders, store }) => {
      message(ANN, "tell me when it is done", { run: "r1" });
      const first = run("r1");
      expect(reminders.claim(first, [ANN], HERE)).toEqual([ANN]);
      expect(reminders.claim(first, [ANN], HERE)).toEqual([]);
      expect(store.rows("SELECT person FROM reminded")).toEqual([{ person: ANN }]);
      message(ANN, "and this other thing", { run: "r2" });
      expect(reminders.claim(run("r2"), [ANN], HERE)).toEqual([ANN]);
    });
  });

  it("reminds no more than a few people of one thing, by however many messages", async () => {
    await within(({ message, run, reminders }) => {
      const many = Array.from({ length: MAX_REMINDED + 2 }, (_, n) => `ou_p${n}`);
      for (const each of many) message(each, "hello");
      message(ANN, "tell everyone", { run: "r1" });
      const asked = run("r1");
      // Two by one message, then the rest asked for by another: only as many as are left of the few.
      expect(reminders.claim(asked, many.slice(0, 2), HERE)).toEqual(many.slice(0, 2));
      expect(reminders.claim(asked, many, HERE)).toEqual(many.slice(2, MAX_REMINDED));
      // A run made to send message after message reminds nobody more of it.
      expect(reminders.claim(asked, many, HERE)).toEqual([]);
      expect(reminders.claim(asked, [ANN], HERE)).toEqual([]);
      // Of another thing, a few again.
      message(ANN, "and of this", { run: "r2" });
      expect(reminders.claim(run("r2"), many, HERE)).toEqual(many.slice(0, MAX_REMINDED));
    });
  });

  it("takes the answer of a request that had to wait for a thing of its own, and nobody's word through a connector that is not trusted here", async () => {
    await within(({ message, run, reminders, settings }) => {
      message(ANN, "do it, and tell me", { run: "r1" });
      const asked = run("r1");
      // Told when it was asked that it has to wait.
      expect(reminders.claim(asked, [ANN], HERE)).toEqual([ANN]);
      // The run that carries it on rests on the same message of hers: its answer reminds her all the same, once.
      message(ANN, "do it, and tell me", { run: "resumed" });
      settings.carrying.resumed = "call_9";
      const carried = run("resumed");
      expect(reminders.of(carried, HERE)!.event).toBe("request:call_9");
      expect(reminders.claim(carried, [ANN], HERE)).toEqual([ANN]);
      expect(reminders.claim(carried, [ANN], HERE)).toEqual([]);

      // Written through a connector whose word on who wrote it does not count: not hers to ask by, and no sign that she wrote here.
      message("ou_zed", "hello", { source: "elsewhere" });
      message("ou_yan", "tell zed and me", { run: "r3", source: "elsewhere" });
      settings.untrusted.push("elsewhere");
      expect(reminders.of(run("r3"), HERE)).toBeUndefined();
      message(ANN, "tell zed", { run: "r4" });
      expect(reminders.claim(run("r4"), ["ou_zed", "all", "@ou_zed"], HERE)).toEqual([]);
    });
  });

  it("takes a name that would mean two people for neither, and one person named twice for one", async () => {
    await within(({ message, run, reminders }) => {
      // Everyone the message named, each with their name: a name two of them bear means neither.
      message(ANN, "tell @Li and @Li, and @Wu", { run: "r1", data: { group: true, mentioned: [{ name: "@Li", id: "ou_li1" }, { name: "@Li", id: "ou_li2" }, { name: "@Wu", id: "ou_wu" }, { name: "@Wu", id: "ou_wu" }, { name: "@NoId" }, { id: "ou_noname" }] } });
      // The name that means two is no way of saying either; who they are still is.
      expect(reminders.claim(run("r1"), ["@Li", "@Wu", "@NoId", "ou_noname", "ou_li2"], HERE)).toEqual(["ou_wu", "ou_li2"]);
      // Two messages of one request that give one name with different people: that name means neither.
      message(ANN, "tell @Sam", { run: "r2", data: { group: true, mentioned: [{ name: "@Sam", id: "ou_sam1" }] } });
      message(ANN, "and @Sam", { run: "r2", data: { group: true, mentioned: [{ name: "@Sam", id: "ou_sam2" }] } });
      expect(reminders.claim(run("r2"), ["@Sam", "ou_sam1"], HERE)).toEqual(["ou_sam1"]);
      // Two of that name in one message, and one of them again alone in another: still neither by the name.
      message(ANN, "tell @Kim and @Kim", { run: "r3", data: { group: true, mentioned: [{ name: "@Kim", id: "ou_kim1" }, { name: "@Kim", id: "ou_kim2" }] } });
      message(ANN, "I mean @Kim", { run: "r3", data: { group: true, mentioned: [{ name: "@Kim", id: "ou_kim1" }] } });
      expect(reminders.claim(run("r3"), ["@Kim", "ou_kim2"], HERE)).toEqual(["ou_kim2"]);
    });
  });

  it("reminds nobody where there is only one person, where nothing says whose thing it is, or where it came up somewhere else than the message goes", async () => {
    await within(({ message, run, reminders }) => {
      message(ANN, "tell me", { run: "r1", data: { direct: true } });
      expect(reminders.of(run("r1"), HERE)).toBeUndefined();
    }, `user:${ANN}`);
    await within(({ message, run, reminders }) => {
      // Two people's messages in one run; an event nobody wrote; a message not written to the agent.
      message(ANN, "one", { run: "r1" });
      message(BOB, "two", { run: "r1" });
      expect(reminders.of(run("r1"), HERE)).toBeUndefined();
      message("", "tick", { run: "r2", source: "timer", kind: "timer", principal: { kind: "timer", id: "tmr_unknown", explicit: false } });
      expect(reminders.of(run("r2"), HERE)).toBeUndefined();
      message(ANN, "aside", { run: "r3", explicit: false });
      expect(reminders.of(run("r3"), HERE)).toBeUndefined();
      // Asked in one topic of the chat; the message goes out in another, or in the chat's main conversation.
      const topic = AT({ thread: "1" });
      message(ANN, "tell me, here", { run: "r4", session_key: "thread:t1", from: topic });
      expect(reminders.of(run("r4", "thread:t2"), topic)).toBeUndefined();
      message(ANN, "tell me, here", { run: "r5", session_key: "thread:t1", from: topic });
      expect(reminders.of(run("r5", "chat"), HERE)).toBeUndefined();
      message(ANN, "tell me, here", { run: "r6", session_key: "thread:t1", from: topic });
      expect(reminders.claim(run("r6", "thread:t1"), [ANN], topic)).toEqual([ANN]);
      // Those who wrote in another topic have not written here.
      message(BOB, "in the other topic", { session_key: "thread:t2", from: topic });
      message(ANN, "tell bob", { run: "r7", session_key: "thread:t1", from: topic });
      expect(reminders.claim(run("r7", "thread:t1"), [BOB], topic)).toEqual([]);

      // The conversation is the one it came up in, and the message is to go somewhere else all the same:
      // to her alone, to another chat, through another account, or nowhere that can be told. Nobody is reminded, and nothing is taken.
      message(ANN, "tell me", { run: "r8" });
      const asked = run("r8");
      for (const elsewhere of [AT({ visible_to: ANN }), AT({ chat_id: "oc_other" }), AT({ app_id: "cli_2" }), AT({ thread: "1" }), JSON.stringify({ connector: "github", address: { app_id: "cli_1", chat_id: "oc_1" } }), null, "not json"]) expect(reminders.claim(asked, [ANN], elsewhere), String(elsewhere)).toEqual([]);
      // Where it does go out where it came up, answering whichever message: she is reminded.
      expect(reminders.claim(asked, [ANN], AT())).toEqual([ANN]);
      // A message whose record of where it was written is gone says nothing of where: not gone by.
      message(ANN, "tell me", { run: "r9", from: null });
      expect(reminders.of(run("r9"), HERE)).toBeUndefined();
    });
  });

  it("goes by what was kept with a task or a timer when it comes back: who asked, whom they named, and where", async () => {
    await within(({ message, run, reminders, store }) => {
      const ended = (id: string, runId: string, kind = "worker.result") => message("", "ended", { run: runId, source: "worker", kind, principal: { kind: "worker", id, explicit: false } });
      const task = (id: string, key: string, asked?: unknown) => {
        store.sql.exec("INSERT INTO tasks (id, op_id, worker, title, brief, session_key, requested_by, status, created_at, updated_at) VALUES (?, ?, 'sandbox', 't', 'b', ?, ?, 'succeeded', 1, 1)", id, `op_${id}`, key, ANN);
        if (asked) store.sql.exec("INSERT INTO task_asked (task_id, asked) VALUES (?, ?)", id, JSON.stringify(asked));
      };
      task("t1", "chat", { by: ANN, named: [{ name: "@Carol", id: CAROL }], place: PLACE });
      ended("t1", "r1");
      expect(reminders.claim(run("r1"), [ANN, "@Carol", "ou_stranger"], HERE)).toEqual([ANN, CAROL]);
      // The result brought once more is the same thing: nobody is reminded of it again.
      ended("t1", "r1again");
      expect(reminders.claim(run("r1again"), [ANN, "@Carol"], HERE)).toEqual([]);
      // It failed, or was lost: that is its end too, and she asked to be told. Its progress is not an end.
      task("t4", "chat", { by: ANN, named: [], place: PLACE });
      ended("t4", "r4p", "worker.progress");
      expect(reminders.of(run("r4p"), HERE)).toBeUndefined();
      ended("t4", "r4", "worker.failed");
      expect(reminders.claim(run("r4"), [ANN], HERE)).toEqual([ANN]);
      task("t5", "chat", { by: ANN, named: [], place: PLACE });
      ended("t5", "r5", "worker.lost");
      expect(reminders.claim(run("r5"), [ANN], HERE)).toEqual([ANN]);
      // One made before any of this was kept, though it says who asked for it; one of another conversation; one asked somewhere else.
      task("t2", "chat");
      ended("t2", "r2");
      expect(reminders.of(run("r2"), HERE)).toBeUndefined();
      task("t3", "thread:t9", { by: ANN, named: [], place: PLACE });
      ended("t3", "r3");
      expect(reminders.of(run("r3"), HERE)).toBeUndefined();
      task("t6", "chat", { by: ANN, named: [], place: placeOf(AT({ chat_id: "oc_other" })) });
      ended("t6", "r6");
      expect(reminders.of(run("r6"), HERE)).toBeUndefined();

      // A timer: each time it fires is a thing of its own.
      const fires = (id: string, runId: string) => message("", "check", { run: runId, source: "timer", kind: "timer", principal: { kind: "timer", id, explicit: false } });
      store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, data, created_at) VALUES ('tmr_each', 1, 600, 'chat', 'n', ?, 1)", JSON.stringify({ by: ANN, named: [{ name: "@Carol", id: CAROL }], place: PLACE }));
      fires("tmr_each", "f1");
      fires("tmr_each", "f2");
      expect(reminders.claim(run("f1"), [ANN], HERE)).toEqual([ANN]);
      expect(reminders.claim(run("f2"), [ANN, "@Carol"], HERE)).toEqual([ANN, CAROL]);
      expect(store.rows("SELECT status FROM timers WHERE id = 'tmr_each'")).toEqual([{ status: "active" }]);
      // One set to stop once it has reminded: it ends with the first message that reminds someone, and not with one that reminds nobody.
      store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, data, created_at) VALUES ('tmr_once', 1, 600, 'chat', 'n', ?, 1)", JSON.stringify({ by: ANN, named: [], place: PLACE, stop_after_reminding: true }));
      fires("tmr_once", "o1");
      const first = run("o1");
      expect(reminders.claim(first, ["ou_stranger"], HERE)).toEqual([]);
      expect(reminders.claim(first, [ANN], AT({ chat_id: "oc_other" }))).toEqual([]);
      expect(store.rows("SELECT status FROM timers WHERE id = 'tmr_once'")).toEqual([{ status: "active" }]);
      // Two firings were already waiting when the first of them reminded her: the other reminds nobody.
      fires("tmr_once", "o2");
      fires("tmr_once", "o3");
      expect(reminders.claim(run("o2"), [ANN], HERE)).toEqual([ANN]);
      expect(store.rows("SELECT status FROM timers WHERE id = 'tmr_once'")).toEqual([{ status: "done" }]);
      expect(reminders.claim(run("o3"), [ANN], HERE)).toEqual([]);
      expect(store.rows("SELECT person FROM reminded WHERE event LIKE 'timer:tmr_once:%'")).toEqual([{ person: ANN }]);
      // One called off after it fired: the firing that was already waiting reminds nobody.
      store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, data, created_at) VALUES ('tmr_off', 1, 600, 'chat', 'n', ?, 1)", JSON.stringify({ by: ANN, named: [], place: PLACE }));
      fires("tmr_off", "c1");
      store.sql.exec("UPDATE timers SET status = 'cancelled' WHERE id = 'tmr_off'");
      expect(reminders.claim(run("c1"), [ANN], HERE)).toEqual([]);
      // One that has run its rounds and ended by itself still reminds, of its last firing.
      store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, data, status, created_at) VALUES ('tmr_ended', 1, 600, 'chat', 'n', ?, 'done', 1)", JSON.stringify({ by: ANN, named: [], place: PLACE }));
      fires("tmr_ended", "e1");
      expect(reminders.claim(run("e1"), [ANN], HERE)).toEqual([ANN]);
      // One set before any of this was kept reminds nobody.
      store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, created_at) VALUES ('tmr_old', 1, NULL, 'chat', 'n', 1)");
      fires("tmr_old", "old");
      expect(reminders.of(run("old"), HERE)).toBeUndefined();
    });
  });

  it("says, of a run, who asked and whom they named, for a task or a timer made in it", async () => {
    await within(({ message, reminders }) => {
      message(ANN, "check and tell @Carol", { run: "r1", data: { group: true, mentioned: [{ name: "@Carol", id: CAROL }] } });
      expect(reminders.asked("r1")).toEqual({ by: ANN, named: [{ name: "@Carol", id: CAROL }], place: PLACE });
      message(ANN, "one", { run: "r2" });
      message(BOB, "two", { run: "r2" });
      expect(reminders.asked("r2")).toBeUndefined();
      expect(reminders.asked("r_none")).toBeUndefined();
    });
  });

  it("keeps whose thing it is through every step it is done in: a timer set by a timer's firing, a task handed over when a task ends", async () => {
    await within(({ message, run, reminders, store }) => {
      const kept = { by: ANN, named: [{ name: "@Carol", id: CAROL }], place: PLACE };
      const fires = (id: string, runId: string) => message("", "next", { run: runId, source: "timer", kind: "timer", principal: { kind: "timer", id, explicit: false } });
      const timer = (id: string, data: unknown, status = "done") => store.sql.exec("INSERT INTO timers (id, due_at, every_s, session_key, note, data, status, created_at) VALUES (?, 1, NULL, 'chat', 'n', ?, ?, 1)", id, data === undefined ? null : JSON.stringify(data), status);
      // She asked for ten steps, ten seconds apart: each is a timer set in the run the one before it started.
      timer("t1", reminders.asked((message(ANN, "count to ten, then tell me and @Carol", { run: "r0", data: { group: true, mentioned: [{ name: "@Carol", id: CAROL }] } }), "r0")));
      for (let step = 1; step < 10; step++) {
        fires(`t${step}`, `r${step}`);
        expect(reminders.asked(`r${step}`), `step ${step}`).toEqual(kept);
        timer(`t${step + 1}`, reminders.asked(`r${step}`));
      }
      // The last of them tells her, and the one she named.
      fires("t10", "r10");
      expect(reminders.claim(run("r10"), [ANN, "@Carol"], HERE)).toEqual([ANN, CAROL]);
      // So with a task's end, well or not.
      store.sql.exec("INSERT INTO tasks (id, op_id, worker, title, brief, session_key, requested_by, status, created_at, updated_at) VALUES ('k1', 'op_k1', 'sandbox', 't', 'b', 'chat', ?, 'failed', 1, 1)", ANN);
      store.sql.exec("INSERT INTO task_asked (task_id, asked) VALUES ('k1', ?)", JSON.stringify(kept));
      message("", "ended", { run: "rk", source: "worker", kind: "worker.failed", principal: { kind: "worker", id: "k1", explicit: false } });
      expect(reminders.asked("rk")).toEqual(kept);
      // Not from one of which nothing was kept, nor from one called off, nor from its mere progress.
      timer("t_nobodys", undefined);
      fires("t_nobodys", "rn");
      expect(reminders.asked("rn")).toBeUndefined();
      timer("t_off", kept, "cancelled");
      fires("t_off", "ro");
      expect(reminders.asked("ro")).toBeUndefined();
      message("", "going", { run: "rp", source: "worker", kind: "worker.progress", principal: { kind: "worker", id: "k1", explicit: false } });
      expect(reminders.asked("rp")).toBeUndefined();
    });
  });
});
