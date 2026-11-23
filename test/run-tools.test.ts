import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorTool, ToolContext } from "../src/connectors";
import type { Env } from "../src/env";
import type { Acting, Continuation } from "../src/brain/requests";
import { READ_OUTSIDE, RunTools, type RunToolsHost } from "../src/brain/run-tools";
import { BrainStore, type RunRow } from "../src/brain/store";
import { Timers } from "../src/brain/timers";
import type { ToolHost } from "../src/brain/tools";

/**
 * What a run's tools do, by themselves on a real Brain's storage: the Brain's own tools (memory,
 * timers, messages) and the way into a connector's tools. The connector's tool, the requests part,
 * the outbox and the tasks part are stand-ins that record what they were asked. No model, no run
 * loop, no alarm.
 */
const SESSION = "s1";
const SESSION_KEY = "dm";
const PERSON: Acting = { connector: "feishu", person: "ou_1", origin: { app_id: "cli_1" }, said: [{ text: "read this", data: {} }], recent: [{ text: "earlier", data: {} }], recentIds: [41, 42] };

let scopes = 0;
function within<T>(use: (bench: ReturnType<typeof bench>) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(`acme:user:tools-${++scopes}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));
}

afterEach(() => vi.restoreAllMocks());

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  const calls: [string, ...unknown[]][] = [];
  const note = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
  const settings = {
    acting: PERSON as Acting | undefined,
    carried: undefined as Partial<Continuation> | undefined,
    mayUse: true,
    editors: ["ou_1"] as string[] | Error,
    basis: [7, 8],
  };
  /** The connector's one tool: what it was given, and what it says back. */
  const tool = {
    given: [] as { context: ToolContext; args: Record<string, unknown> }[],
    answer: (async () => ({ text: "the document" })) as (context: ToolContext, args: Record<string, unknown>) => Promise<unknown>,
  };
  const read: ConnectorTool = { name: "feishu_read_document", description: "", parameters: {}, run: async (context, args) => (tool.given.push({ context, args }), tool.answer(context, args)) } as unknown as ConnectorTool;
  const outside = new Set<string>();
  const host: RunToolsHost = {
    get env() {
      return { marker: "env" } as unknown as Env;
    },
    outside,
    actingFor: () => settings.acting,
    mayUse: () => settings.mayUse,
    instructionEditors: () => {
      if (settings.editors instanceof Error) throw settings.editors;
      return settings.editors;
    },
    toolsOf: (connector) => (connector === "feishu" ? [read] : []),
    requests: {
      continuationOf: () => settings.carried as Continuation | undefined,
      mayCancel: (_run, requestId, by, ask) => (calls.push(["mayCancel", requestId, by, ask]), { record: { id: requestId } as Continuation, choosing: 3 }),
      cancel: note("cancel"),
      basis: () => settings.basis.map((id) => ({ id })) as never,
      endRequest: note("endRequest"),
      noteSource: note("noteSource"),
      wait: (...args: unknown[]) => (calls.push(["wait", ...args]), { waiting: "kept" }),
      draft: (...args: unknown[]) => (calls.push(["draft", ...args]), { ok: true as const }),
    } as RunToolsHost["requests"],
    outbox: { enqueue: (...args: unknown[]) => (calls.push(["enqueue", ...args]), { ok: true as const }) } as RunToolsHost["outbox"],
    tasks: {
      dispatch: async (...args: unknown[]) => (calls.push(["dispatch", ...args]), { task_id: "t1" }),
      status: async (...args: unknown[]) => (calls.push(["status", ...args]), { status: "running" }),
      answer: async (...args: unknown[]) => (calls.push(["answer", ...args]), { ok: true }),
      cancel: async (...args: unknown[]) => (calls.push(["cancelTask", ...args]), { ok: true }),
    } as RunToolsHost["tasks"],
  };
  store.sql.exec("INSERT INTO sessions (id, session_key, target, created_at, updated_at) VALUES (?, ?, '{}', 1, 1)", SESSION, SESSION_KEY);
  store.sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES ('r1', ?, 'running', 1)", SESSION);
  const run = store.rows<RunRow>("SELECT * FROM runs WHERE id = 'r1'")[0];
  const tools = (): ToolHost => new RunTools(store, host).for(run);
  const of = (name: string) => calls.filter(([each]) => each === name).map(([, ...args]) => args);
  return { store, host, settings, tool, outside, calls, of, run, tools };
}

describe("a run's tools", () => {
  describe("memory", () => {
    it("writes, lists, reads and deletes files", async () => {
      await within(({ tools }) => {
        const t = tools();
        expect(t.memoryWrite("notes/a.md", "hello")).toEqual({ ok: true, path: "notes/a.md" });
        t.memoryWrite("notes/a.md", "hello again");
        expect(t.memoryRead("notes/a.md")).toEqual({ path: "notes/a.md", content: "hello again" });
        expect((t.memoryList() as { files: { path: string; size: number }[] }).files).toMatchObject([{ path: "notes/a.md", size: 11 }]);
        expect(t.memoryDelete("notes/a.md")).toEqual({ ok: true, deleted: true });
        expect(t.memoryDelete("notes/a.md")).toEqual({ ok: true, deleted: false });
        expect(() => t.memoryRead("notes/a.md")).toThrow("no memory file at notes/a.md");
      });
    });

    it("takes only paths like notes/topic.md", async () => {
      await within(({ tools }) => {
        const t = tools();
        for (const path of ["Notes/a.md", "a.txt", "../a.md", "notes/../a.md", "/a.md", `${"a".repeat(152)}.md`]) {
          expect(() => t.memoryWrite(path, "x")).toThrow("path must look like notes/topic.md: lowercase letters, digits, - _ /");
        }
        expect(t.memoryWrite(`${"a".repeat(151)}.md`, "x")).toMatchObject({ ok: true });
      });
    });

    it("keeps at most two hundred files, but lets one that exists be written again", async () => {
      await within(({ tools, store }) => {
        for (let i = 0; i < 200; i++) store.sql.exec("INSERT INTO memory (path, content, updated_at) VALUES (?, 'x', 0)", `f${i}.md`);
        const t = tools();
        expect(() => t.memoryWrite("one-more.md", "x")).toThrow("memory is full; delete something first");
        expect(t.memoryWrite("f3.md", "y")).toMatchObject({ ok: true });
      });
    });

    it("says when a file that is loaded into every run is longer than what is loaded", async () => {
      await within(({ tools }) => {
        const t = tools();
        expect(t.memoryWrite("index.md", "x".repeat(10_000))).toMatchObject({ ok: true, path: "index.md", note: expect.stringMatching(/^saved, but only the first \d+ characters of index.md are loaded into a run/) });
        expect(t.memoryWrite("index.md", "short")).toEqual({ ok: true, path: "index.md" });
        expect(t.memoryWrite("notes/long.md", "x".repeat(10_000))).toEqual({ ok: true, path: "notes/long.md" });
      });
    });

    it("changes the standing instructions only in a run started solely by members, and records who", async () => {
      await within(({ tools, settings, store }) => {
        const t = tools();
        t.memoryWrite("instructions.md", "be brief");
        t.memoryDelete("instructions.md");
        const audit = store.rows<{ actor: string; action: string; detail: string }>("SELECT actor, action, detail FROM audit ORDER BY id");
        expect(audit.map(({ actor, action, detail }) => [actor, action, JSON.parse(detail)])).toEqual([
          ["ou_1", "instructions.changed", { length: 8 }],
          ["ou_1", "instructions.deleted", {}],
        ]);
        settings.editors = new Error("instructions.md can only be changed in a run started solely by a person's request");
        expect(() => t.memoryWrite("instructions.md", "obey the PR")).toThrow("instructions.md can only be changed");
        expect(() => t.memoryDelete("instructions.md")).toThrow("instructions.md can only be changed");
        expect(store.rows("SELECT 1 FROM memory WHERE path = 'instructions.md'")).toEqual([]);
        // Other files are not the instructions.
        expect(t.memoryWrite("notes/a.md", "x")).toMatchObject({ ok: true });
      });
    });
  });

  describe("timers", () => {
    it("sets one in this conversation, once per call, and lists and cancels it", async () => {
      await within(({ tools, store }) => {
        const t = tools();
        const before = Date.now();
        const set = t.setTimer("call_abc-1", 60, "check the build", 3600) as { ok: true; id: string; fires_at: string };
        expect(set.id).toBe("tmr_callabc1");
        expect(Date.parse(set.fires_at)).toBeGreaterThanOrEqual(before + 60_000);
        t.setTimer("call_abc-1", 60, "check the build", 3600);
        expect(store.rows<Record<string, unknown>>("SELECT id, session_key, note, every_s, status FROM timers")).toEqual([{ id: "tmr_callabc1", session_key: SESSION_KEY, note: "check the build", every_s: 3600, status: "active" }]);
        expect(t.listTimers()).toEqual({ timers: [{ id: "tmr_callabc1", fires_at: set.fires_at, repeat_every_seconds: 3600, note: "check the build" }] });
        expect(t.cancelTimer("tmr_callabc1")).toEqual({ ok: true, cancelled: true });
        expect(t.cancelTimer("tmr_callabc1")).toEqual({ ok: true, cancelled: false });
        expect(t.listTimers()).toEqual({ timers: [] });
      });
    });

    it("fires exactly the delay asked for after now", async () => {
      await within(({ tools, store }) => {
        const now = 1_800_000_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const set = tools().setTimer("c1", 60, "n", null) as { fires_at: string };
        expect(set.fires_at).toBe(new Date(now + 60_000).toISOString());
        expect(store.rows<{ due_at: number }>("SELECT due_at FROM timers")[0].due_at).toBe(now + 60_000);
      });
    });

    it("tells a replayed call when the timer it set fires, not a time counted from the replay", async () => {
      await within(({ tools, store }) => {
        const now = 1_800_000_000_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        const first = tools().setTimer("c1", 60, "n", null) as { id: string; fires_at: string };
        // The run is picked up again after a crash, 40 seconds later, and the same call made again.
        clock.mockReturnValue(now + 40_000);
        const again = tools().setTimer("c1", 60, "n", null) as { id: string; fires_at: string };
        expect(again).toEqual({ ok: true, id: first.id, fires_at: new Date(now + 60_000).toISOString() });
        expect(store.rows<{ due_at: number }>("SELECT due_at FROM timers")).toEqual([{ due_at: now + 60_000 }]);
      });
    });

    it("tells a replayed call of a repeating timer that has fired since when it fires next", async () => {
      await within(({ tools, store }) => {
        const now = 1_800_000_000_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        tools().setTimer("c1", 60, "n", 3600);
        clock.mockReturnValue(now + 61_000);
        new Timers(store).fire(now + 61_000);
        expect(tools().setTimer("c1", 60, "n", 3600)).toEqual({ ok: true, id: "tmr_c1", fires_at: new Date(now + 61_000 + 3_600_000).toISOString() });
      });
    });

    it("tells a replayed call of a timer that has fired or been cancelled since that it will not fire, and sets none", async () => {
      await within(({ tools, store }) => {
        const now = 1_800_000_000_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        tools().setTimer("c1", 60, "n", null);
        tools().setTimer("c2", 120, "n", null);
        // The alarm fires due timers before it picks the interrupted run up again.
        clock.mockReturnValue(now + 61_000);
        new Timers(store).fire(now + 61_000);
        expect(tools().cancelTimer("tmr_c2")).toEqual({ ok: true, cancelled: true });
        expect(tools().setTimer("c1", 60, "n", null)).toEqual({ ok: true, id: "tmr_c1", status: "done" });
        expect(tools().setTimer("c2", 120, "n", null)).toEqual({ ok: true, id: "tmr_c2", status: "cancelled" });
        expect(store.rows<{ id: string; status: string }>("SELECT id, status FROM timers ORDER BY id")).toEqual([
          { id: "tmr_c1", status: "done" },
          { id: "tmr_c2", status: "cancelled" },
        ]);
      });
    });

    it("refuses delays and repeats out of bounds", async () => {
      await within(({ tools }) => {
        const t = tools();
        expect(() => t.setTimer("c1", 4, "n", null)).toThrow("delay_seconds must be between 5 and one year");
        expect(() => t.setTimer("c2", 366 * 86_400 + 1, "n", null)).toThrow("delay_seconds must be between 5 and one year");
        expect(() => t.setTimer("c3", 60, "n", 59)).toThrow("repeat_every_seconds must be at least 60");
        expect(t.setTimer("c4", 5, "n", 60)).toMatchObject({ ok: true });
        expect(t.setTimer("c5", 366 * 86_400, "n", null)).toMatchObject({ ok: true });
      });
    });

    it("keeps at most fifty active, and does not show or cancel a task's watchdog", async () => {
      await within(({ tools, store }) => {
        for (let i = 0; i < 50; i++) store.sql.exec("INSERT INTO timers (id, due_at, session_key, note, created_at) VALUES (?, 9e15, 'dm', 'n', 0)", `x${i}`);
        const t = tools();
        expect(() => t.setTimer("c1", 60, "n", null)).toThrow("too many active timers; cancel one first");
        store.sql.exec("DELETE FROM timers");
        store.sql.exec("INSERT INTO timers (id, due_at, session_key, note, data, created_at) VALUES ('watch_t1', 9e15, 'dm', 'n', '{\"task_id\":\"t1\"}', 0)");
        expect(t.listTimers()).toEqual({ timers: [] });
        expect(t.cancelTimer("watch_t1")).toEqual({ ok: true, cancelled: false });
        expect(store.rows<{ status: string }>("SELECT status FROM timers")[0].status).toBe("active");
      });
    });
  });

  describe("messages", () => {
    it("are kept to be sent", async () => {
      await within(({ tools, calls }) => {
        expect(tools().sendMessage("c1", "hello")).toEqual({ ok: true });
        // Written by the model: the agent's own words.
        expect(calls).toEqual([["enqueue", "msg:c1", SESSION, "r1", "hello", undefined, undefined, { authored: true }]]);
      });
    });

    it("in a run that carries a request on, are that request's answer, kept as a draft, or nothing once it waits again", async () => {
      await within(({ tools, settings, of }) => {
        settings.carried = { id: "req_1", status: "resuming" };
        expect(tools().sendMessage("c1", "the answer")).toEqual({ ok: true });
        expect(of("draft")).toMatchObject([[{ id: "req_1" }, { id: "r1" }, "the answer", true]]);
        settings.carried = { id: "req_1", status: "waiting" };
        expect(tools().sendMessage("c2", "more")).toEqual({ ok: true, note: "nothing was sent: the request is not being answered now" });
        expect(of("enqueue")).toEqual([]);
      });
    });

    it("send a review with its words for where comments cannot be attached, within the longest message", async () => {
      await within(({ tools, of }) => {
        const t = tools();
        t.sendReview("c1", "fine", "abc", [{ path: "a.ts", line: 3, body: "typo" }]);
        t.sendReview("c2", "fine", null, []);
        expect(of("enqueue")).toEqual([
          ["msg:c1", SESSION, "r1", "fine\n\na.ts:3\ntypo", undefined, { summary: "fine", commit: "abc", comments: [{ path: "a.ts", line: 3, body: "typo" }] }, { authored: true }],
          ["msg:c2", SESSION, "r1", "fine", undefined, { summary: "fine", comments: [] }, { authored: true }],
        ]);
        expect(() => t.sendReview("c3", "x".repeat(8_001), null, [])).toThrow("the review is too long: summary and comments together must stay within 8000 characters");
      });
    });
  });

  it("calls a request off only through the requests part's own checks, and says what to tell the person", async () => {
    await within(({ tools, calls }) => {
      expect(tools().cancelRequest("c1", "req_1", "the report")).toEqual({ ok: true, cancelled: "req_1", note: "It will not be carried on and nothing of it will be sent. Tell the person it has been cancelled." });
      expect(calls).toEqual([
        ["mayCancel", "req_1", "c1", "the report"],
        ["cancel", { id: "req_1" }, "c1", 3],
      ]);
    });
  });

  it("hands tasks to their part, in this conversation", async () => {
    await within(async ({ tools, of, run }) => {
      const t = tools();
      await t.dispatchTask("c2", "title", "brief", null);
      await t.taskStatus("t1");
      await t.answerTask("c3", "t1", "allow", "ok");
      await t.cancelTask("t1");
      expect(of("dispatch")).toEqual([[run, SESSION_KEY, "c2", "title", "brief", null]]);
      expect(of("status")).toEqual([["t1"]]);
      expect(of("answer")).toEqual([[run, SESSION_KEY, "c3", "t1", "allow", "ok"]]);
      expect(of("cancelTask")).toEqual([[SESSION_KEY, "t1"]]);
    });
  });

  describe("a connector's tool", () => {
    it("is there only for the person this run acts for, through their connector", async () => {
      await within(async ({ tools, settings, tool }) => {
        await expect(tools().connectorTool("c1", "github_read", {})).rejects.toThrow('there is no tool "github_read" in this run');
        settings.acting = undefined;
        await expect(tools().connectorTool("c1", "feishu_read_document", {})).rejects.toThrow('there is no tool "feishu_read_document" in this run');
        expect(tool.given).toEqual([]);
      });
    });

    it("is called as the person, with what they said, and what comes back is outside text", async () => {
      await within(async ({ tools, tool, outside, store }) => {
        const result = await tools().connectorTool("c1", "feishu_read_document", { url: "u" });
        expect(result).toEqual({ text: "the document" });
        const [{ context, args }] = tool.given;
        expect(args).toEqual({ url: "u" });
        expect(context).toMatchObject({ env: { marker: "env" }, scope: store.scope(), person: "ou_1", origin: { app_id: "cli_1" }, said: PERSON.said, recent: PERSON.recent, callId: "c1" });
        expect(context.resuming).toBeUndefined();
        expect(outside.has("c1")).toBe(true);
        // Which tool and for whom: not what it was asked.
        const [audit] = store.rows<{ actor: string; action: string; detail: string }>("SELECT actor, action, detail FROM audit");
        expect([audit.actor, audit.action, JSON.parse(audit.detail)]).toEqual(["ou_1", "tool.used", { tool: "feishu_read_document", call: "c1" }]);
      });
    });

    it("marks everything the run writes to send as private once it has read outside text, also when the tool fails", async () => {
      await within(async ({ tools, tool, store }) => {
        store.sql.exec("INSERT INTO outbox (idem, run_id, target, text, next_at, created_at) VALUES ('m1', 'r1', '{}', 't', 0, 0), ('m2', 'other', '{}', 't', 0, 0)");
        tool.answer = async () => {
          throw new Error("Feishu said no: the document's title");
        };
        await expect(tools().connectorTool("c1", "feishu_read_document", {})).rejects.toThrow("Feishu said no");
        expect(store.rows<{ idem: string; private: number }>("SELECT idem, private FROM outbox ORDER BY id")).toEqual([
          { idem: "m1", private: 1 },
          { idem: "m2", private: 0 },
        ]);
      });
    });

    it("notes what was read only when the tool identified it and it is not an error", async () => {
      await within(async ({ tools, tool, of }) => {
        tool.answer = async (context) => {
          context.relied("said", 1);
          context.relied("recent", 0);
          context.relied("recent", 5);
          context.identified({ doc: "d1" }, "doc:d1", { condition: "grant", generation: 4 });
          return { text: "the document" };
        };
        await tools().connectorTool("c1", "feishu_read_document", { url: "u" });
        const [[runId, source]] = of("noteSource");
        expect(runId).toBe("r1");
        expect(source).toEqual({ connector: "feishu", tool: "feishu_read_document", args: '{"doc":"d1"}', identity: "doc:d1", condition: "grant", generation: 4 });
      });
      for (const answer of [async () => ({ error: "not found" }), async () => "plain text"]) {
        await within(async ({ tools, tool, of }) => {
          tool.answer = async (context) => (context.identified({ doc: "d1" }, "doc:d1", { condition: "g", generation: 1 }), answer());
          await tools().connectorTool("c1", "feishu_read_document", {});
          expect(of("noteSource")).toEqual([]);
        });
      }
      await within(async ({ tools, of }) => {
        await tools().connectorTool("c1", "feishu_read_document", {});
        expect(of("noteSource")).toEqual([]);
      });
    });

    it("keeps a request that has to wait: nothing was read, and the answer is the requests part's", async () => {
      await within(async ({ tools, tool, outside, of, store }) => {
        store.sql.exec("INSERT INTO outbox (idem, run_id, target, text, next_at, created_at) VALUES ('m1', 'r1', '{}', 't', 0, 0)");
        const waiting = { on: "feishu", subject: "grant", condition: "c", generation: 1, until: Date.now() + 60_000, interaction: "int:1", request: { doc: "d1" } };
        tool.answer = async (context) => (context.relied("recent", 1), { waiting });
        expect(await tools().connectorTool("c1", "feishu_read_document", { url: "u" })).toEqual({ waiting: "kept" });
        expect(outside.has("c1")).toBe(false);
        expect(of("wait")).toEqual([[expect.objectContaining({ id: "r1" }), { connector: "feishu", events: { said: [7, 8], recent: [42], bound: [42] } }, "c1", "feishu_read_document", waiting, undefined]]);
        expect(store.rows<{ private: number }>("SELECT private FROM outbox")[0].private).toBe(0);
      });
    });

    it("answers a call that was told to wait, when it is replayed, without asking the connector again", async () => {
      await within(async ({ tools, tool, store }) => {
        store.sql.exec("INSERT INTO continuations (id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, created_at) VALUES ('c1', ?, '{}', 'feishu', 'feishu_read_document', '{}', '{}', 'g', 'c', 1, 'i', 0, 'waiting', 0)", SESSION);
        expect(await tools().connectorTool("c1", "feishu_read_document", {})).toMatchObject({ waiting: true, request: "c1" });
        expect(tool.given).toEqual([]);
      });
    });

    describe("in place of a request that still waits", () => {
      it("calls that one off once this one is done", async () => {
        await within(async ({ tools, calls }) => {
          await tools().connectorTool("c1", "feishu_read_document", { url: "u", replaces: "req_0" });
          expect(calls.filter(([name]) => name === "mayCancel" || name === "cancel")).toEqual([
            ["mayCancel", "req_0", "c1", undefined],
            ["cancel", { id: "req_0" }, "c1", 3],
          ]);
        });
      });

      it("hands the one it replaces to the request that is kept, when this one has to wait too", async () => {
        await within(async ({ tools, tool, of }) => {
          tool.answer = async () => ({ waiting: { on: "feishu", subject: "g", condition: "c", generation: 1, until: Date.now() + 60_000, interaction: "i", request: {} } });
          await tools().connectorTool("c1", "feishu_read_document", { url: "u", replaces: "req_0" });
          expect(of("cancel")).toEqual([]);
          expect(of("wait")[0][5]).toEqual({ record: { id: "req_0" }, choosing: 3, by: "c1" });
        });
      });

      it("does not pass the request it replaces on to the tool", async () => {
        await within(async ({ tools, tool }) => {
          await tools().connectorTool("c1", "feishu_read_document", { url: "u", replaces: "req_0" });
          expect(tool.given[0].args).toEqual({ url: "u" });
        });
      });

      it("is refused, before anything is read, in a run that may no longer call things off", async () => {
        await within(async ({ tools, tool, settings, of }) => {
          settings.mayUse = false;
          await expect(tools().connectorTool("c1", "feishu_read_document", { url: "u", replaces: "req_0" })).rejects.toThrow(READ_OUTSIDE);
          expect(tool.given).toEqual([]);
          expect(of("mayCancel")).toEqual([]);
          // An empty one replaces nothing.
          await tools().connectorTool("c2", "feishu_read_document", { url: "u", replaces: "" });
          expect(tool.given).toHaveLength(1);
        });
      });
    });

    describe("in a run that carries a request on", () => {
      const carried = (over: Partial<Continuation> = {}): Partial<Continuation> => ({ id: "req_1", status: "resuming", call_id: "c1", tool: "feishu_read_document", args: '{"doc":"d1"}', generation: 4, claimed_at: Date.now(), ...over });

      it("makes only the call made for it, with what the request was made with", async () => {
        await within(async ({ tools, tool, settings, store }) => {
          settings.carried = carried();
          await tools().connectorTool("c1", "feishu_read_document", { doc: "something else" });
          const [{ context, args }] = tool.given;
          expect(args).toEqual({ doc: "d1" });
          expect(context.callId).toBe("req_1");
          expect(context.resuming?.generation).toBe(4);
          expect(context.resuming?.notAfter).toBe((settings.carried.claimed_at as number) + 60 * 60_000);
          const [audit] = store.rows<{ detail: string }>("SELECT detail FROM audit");
          expect(JSON.parse(audit.detail)).toEqual({ tool: "feishu_read_document", call: "req_1" });
        });
      });

      it("refuses any other call", async () => {
        for (const over of [{ status: "waiting" }, { call_id: "other" }, { tool: "another_tool" }] as Partial<Continuation>[]) {
          await within(async ({ tools, tool, settings }) => {
            settings.carried = carried(over);
            await expect(tools().connectorTool("c1", "feishu_read_document", {})).rejects.toThrow("this run can only answer the request it carries on");
            expect(tool.given).toEqual([]);
          });
        }
      });

      it("ends the request, reading nothing, once the time to handle it is over", async () => {
        await within(async ({ tools, tool, settings, of }) => {
          settings.carried = carried({ claimed_at: Date.now() - 60 * 60_000 - 1_000 });
          await expect(tools().connectorTool("c1", "feishu_read_document", {})).rejects.toThrow("this request was not finished in time; nothing was read. The person can ask again");
          expect(of("endRequest")).toEqual([["req_1", "void", "it was not finished in time"]]);
          expect(tool.given).toEqual([]);
        });
      });

      it("cannot replace another request", async () => {
        await within(async ({ tools, settings, of }) => {
          settings.carried = carried();
          await tools().connectorTool("c1", "feishu_read_document", { replaces: "req_0" });
          expect(of("mayCancel")).toEqual([]);
        });
      });
    });
  });
});
