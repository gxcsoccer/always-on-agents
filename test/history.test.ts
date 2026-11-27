/**
 * Reading further back in a conversation than the model is shown: the part of the Brain that
 * does it, by itself, over a real store.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { HISTORY_KEPT_MS, History, MAX_HISTORY, MAX_HISTORY_TEXT } from "../src/brain/history";
import { BrainStore, type RunRow } from "../src/brain/store";
import { privateSessionKey } from "../src/events";
import { brain, call, installFakeModel, message, model, modelCalls, say, wake } from "./helpers";

let scopes = 0;
const ANN = "ou_ann";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 12);

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  let made = 0;
  const session = (key: string) => {
    store.sql.exec("INSERT OR IGNORE INTO sessions (id, session_key, target, created_at, updated_at) VALUES (?, ?, '{}', 1, 1)", `s:${key}`, key);
    return `s:${key}`;
  };
  /** A person's message, taken up and done with, some time ago. */
  const wrote = (text: string | null, ago: number, over: Partial<{ by: string; key: string; status: string; kind: string; data: Record<string, unknown>; principal: Record<string, unknown> }> = {}): number =>
    store.rows<{ id: number }>(
      "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, status, received_at) VALUES ('feishu', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      `om_${++made}`,
      over.kind ?? "message",
      over.key ?? "private:ann",
      JSON.stringify(over.principal ?? { kind: "human", id: over.by ?? ANN, display: "Ann", explicit: true }),
      text,
      JSON.stringify(over.data ?? {}),
      over.status ?? "done",
      NOW - ago,
    )[0].id;
  /** Words of the agent's own that reached the conversation, some time ago. */
  const answered = (text: string, ago: number, key = "private:ann"): number => {
    const id = ++made + 1_000;
    store.sql.exec("INSERT INTO said (outbox_id, run_id, session_id, text, sent_at, reads) VALUES (?, 'earlier', ?, ?, ?, '[]')", id, session(key), text, NOW - ago);
    return id;
  };
  const run = (key = "private:ann"): RunRow => {
    const id = `r${++made}`;
    store.sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES (?, ?, 'running', 1)", id, session(key));
    return store.rows<RunRow>("SELECT * FROM runs WHERE id = ?", id)[0];
  };
  const gone = new Set<number>();
  const history = new History(store, { stillStands: (event) => !gone.has(event.id) });
  const read = (ask: Parameters<History["read"]>[1] = {}, of = run()) => history.read(of, ask, NOW);
  return { store, wrote, answered, run, read, gone };
}

const within = <T>(use: (all: ReturnType<typeof bench>) => T | Promise<T>): Promise<T> =>
  runInDurableObject(env.BRAIN.getByName(`history${++scopes}:user:ann`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));

describe("reading further back in a conversation", () => {
  it("gives what people wrote and what the agent said there, oldest first, each with when and by whom", async () => {
    await within(({ wrote, answered, read }) => {
      wrote("what is the plan for the launch?", 3 * DAY);
      answered("The launch is on Friday.", 3 * DAY - 1_000);
      wrote("and who signs it off?", 2 * DAY);
      expect(read()).toEqual({
        messages: [
          { at: new Date(NOW - 3 * DAY).toISOString(), by: `Ann (${ANN})`, text: "what is the plan for the launch?" },
          { at: new Date(NOW - 3 * DAY + 1_000).toISOString(), by: "you", text: "The launch is on Friday." },
          { at: new Date(NOW - 2 * DAY).toISOString(), by: `Ann (${ANN})`, text: "and who signs it off?" },
        ],
        earlier: null,
      });
    });
  });

  it("is of this conversation only, and of nothing that was not a person's own words kept as they stand", async () => {
    await within(({ wrote, answered, read, gone }) => {
      wrote("in another conversation", DAY, { key: "private:bob" });
      answered("said in another conversation", DAY, "private:bob");
      wrote(null, DAY);
      wrote("a button pressed", DAY, { data: { card: true } });
      wrote("brought here from elsewhere", DAY, { data: { routed_from: "thread:t5" } });
      wrote("a timer's note", DAY, { principal: { kind: "timer", id: "t1" } });
      wrote("a worker's report", DAY, { kind: "result", principal: { kind: "worker", id: "w1" } });
      wrote("not taken up yet", DAY, { status: "pending" });
      wrote("what this very run was started by", DAY, { status: "claimed" });
      gone.add(wrote("edited or taken back since", DAY));
      wrote("the one thing there is", DAY);
      expect(read().messages.map((each) => each.text)).toEqual(["the one thing there is"]);
    });
  });

  it("goes back a month and no further, whatever is still kept", async () => {
    await within(({ wrote, answered, read }) => {
      wrote("older than is read", HISTORY_KEPT_MS + 1_000);
      answered("older than is read, too", HISTORY_KEPT_MS + 1_000);
      wrote("just within", HISTORY_KEPT_MS - 1_000);
      expect(read().messages.map((each) => each.text)).toEqual(["just within"]);
    });
  });

  it("finds by words (whatever their case, and taking % and _ as themselves), by who wrote, and by time", async () => {
    await within(({ wrote, answered, read }) => {
      wrote("The Budget is 100% spent", 5 * DAY);
      answered("budget_2026 has room left", 4 * DAY);
      wrote("nothing about money", 3 * DAY);
      const texts = (ask: Parameters<typeof read>[0]) => read(ask).messages.map((each) => each.text);
      expect(texts({ query: "budget" })).toEqual(["The Budget is 100% spent", "budget_2026 has room left"]);
      expect(texts({ query: "100%" })).toEqual(["The Budget is 100% spent"]);
      expect(texts({ query: "budget_" })).toEqual(["budget_2026 has room left"]);
      expect(texts({ from: "you" })).toEqual(["budget_2026 has room left"]);
      expect(texts({ from: ANN })).toEqual(["The Budget is 100% spent", "nothing about money"]);
      expect(texts({ before: new Date(NOW - 4 * DAY).toISOString() })).toEqual(["The Budget is 100% spent"]);
      expect(() => read({ before: "last week" })).toThrow("before is a time (2026-11-27T12:00:00Z) or what an earlier call gave as `earlier`");
    });
  });

  it("gives the latest few and says where to go on from, so that everything is read once, also what came in the same instant", async () => {
    await within(({ wrote, answered, read }) => {
      for (let n = 1; n <= 4; n++) wrote(`message ${n}`, DAY);
      for (let n = 1; n <= 3; n++) answered(`answer ${n}`, DAY);
      const seen: string[] = [];
      let before: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const page = read({ limit: 2, ...(before ? { before } : {}) });
        expect(page.messages.length).toBeLessThanOrEqual(2);
        seen.unshift(...page.messages.map((each) => each.text));
        if (page.earlier === null) break;
        before = page.earlier;
      }
      expect([...seen].sort()).toEqual(["answer 1", "answer 2", "answer 3", "message 1", "message 2", "message 3", "message 4"]);
      // Never more than a fixed number at once, whatever is asked for.
      for (let n = 0; n < MAX_HISTORY + 5; n++) wrote(`more ${n}`, 2 * DAY);
      expect(read({ limit: 500 }).messages).toHaveLength(MAX_HISTORY);
      expect(read({ limit: 500 }).earlier).not.toBeNull();
    });
  });

  it("cuts a long message short and says so", async () => {
    await within(({ wrote, read }) => {
      wrote("x".repeat(MAX_HISTORY_TEXT + 50), DAY);
      const [only] = read().messages;
      expect(only.text).toHaveLength(MAX_HISTORY_TEXT);
      expect(only.cut).toBe(true);
    });
  });
});

describe("the tool that reads further back", () => {
  beforeEach(() => installFakeModel());
  const PRIVATE = privateSessionKey("console", { app: "a" });
  const offered = (at: number) => (modelCalls[at].tools as { name: string }[]).map((each) => each.name);

  it("is there in a person's own conversation, and gives what they wrote and what reached them", async () => {
    const { stub } = brain();
    model.replies([call("send_message", { text: "The launch is on Friday." })], [say("")]);
    await stub.ingest(message("when is the launch?", { session_key: PRIVATE }));
    await wake(stub);
    await wake(stub);
    modelCalls.length = 0;
    model.replies([call("read_history", { query: "launch", from: null, before: null, limit: null }, "look")], [say("")]);
    await stub.ingest(message("remind me what we settled", { session_key: PRIVATE }));
    await wake(stub);
    expect(offered(0)).toContain("read_history");
    const given = JSON.parse(modelCalls[1].input.find((each: any) => each.type === "function_call_output" && each.call_id === "look").output);
    expect(given.messages.map((each: any) => [each.by, each.text])).toEqual([
      ["alice", "when is the launch?"],
      ["you", "The launch is on Friday."],
    ]);
    expect(given.earlier).toBeNull();
  });

  it("is not there where several people talk, and a call of it does nothing", async () => {
    const { stub } = brain("chat");
    model.replies([call("read_history", { query: null, from: null, before: null, limit: null }, "look")], [say("")]);
    await stub.ingest(message("what did the others say?", { session_key: "chat" }));
    await wake(stub);
    expect(offered(0)).not.toContain("read_history");
    const given = JSON.parse(modelCalls[1].input.find((each: any) => each.type === "function_call_output" && each.call_id === "look").output);
    expect(given.messages).toBeUndefined();
    expect(given.error).toBeDefined();
  });
});
