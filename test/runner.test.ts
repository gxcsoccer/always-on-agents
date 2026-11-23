import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorTool } from "../src/connectors";
import type { Env } from "../src/env";
import { type Item, ModelError, type ModelResponse } from "../src/model/openai";
import type { Continuation } from "../src/brain/requests";
import { Runner, type RunnerHost } from "../src/brain/runner";
import { BrainStore, type InboxRow, type RunRow } from "../src/brain/store";
import type { ToolHost } from "../src/brain/tools";

/**
 * The run loop by itself, on a real Brain's storage: claiming events, calling the model, carrying
 * out its tool calls, and ending, retrying or abandoning a run. The model, the registry, the tools
 * and the other parts are stand-ins that record what they were asked. No alarm, no connector.
 */
const PERSON = "ou_1";
const ORIGIN = { app_id: "cli_1", tenant_key: "t1" };
const PRIVATE = `private:feishu:${JSON.stringify([["app_id", "cli_1"], ["tenant_key", "t1"]])}`;
const TARGET = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_1" } });

let scopes = 0;
function within<T>(use: (bench: ReturnType<typeof bench>) => T | Promise<T>, scope = `user:${PERSON}`): Promise<T> {
  // A tenant of its own for each test, so the person's own scope can be fresh every time.
  return runInDurableObject(env.BRAIN.getByName(`runner${++scopes}:${scope}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));
}

afterEach(() => vi.restoreAllMocks());

/** A model answer: these items, at this cost. */
const answer = (output: Item[], total = 100): ModelResponse => ({ output, usage: { input_tokens: total - 10, output_tokens: 10, cached_tokens: 0, total_tokens: total } });
const says = (text: string): Item => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const calls = (name: string, id = "call_1", args: Record<string, unknown> = {}): Item => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  const log: [string, ...unknown[]][] = [];
  const settings = {
    followUps: true,
    carried: undefined as Partial<Continuation> | undefined,
    allowed: true,
    mayNotDisclose: undefined as string | undefined | Error,
    guards: [] as unknown[],
    over: undefined as string | undefined | Error,
    connectorTools: [] as ConnectorTool[],
  };
  /** What the model says, in order; an Error is thrown instead. */
  const model: (ModelResponse | Error)[] = [];
  const asked: { instructions: string; input: Item[]; tools: { name: string }[] }[] = [];
  /** What each tool call returns, by tool name. */
  const results: Record<string, unknown> = {};
  const outside = new Set<string>();
  const toolHost = new Proxy({} as ToolHost, {
    get: (_target, name: string) => (...args: unknown[]) => {
      log.push(["tool", name, ...args]);
      const result = results[name] ?? { ok: true };
      if (result instanceof Error) throw result;
      // A function stands for a tool that does more than answer (a connector's, say, that read from outside).
      return typeof result === "function" ? (result as (...args: unknown[]) => unknown)(...args) : result;
    },
  });
  const host: RunnerHost = {
    get env() {
      return { OPENAI_BASE_URL: "https://model", OPENAI_API_KEY: "k", BRAIN_MODEL: "m" } as unknown as Env;
    },
    outside,
    isDecider: (principal) => principal.kind === "human" && principal.explicit && principal.unlinked !== true,
    toolsOf: (connector) => (connector === "feishu" ? settings.connectorTools : []),
    registry: () =>
      ({
        recordUsage: async (tenant: string, tokens: number) => (log.push(["recordUsage", tenant, tokens]), { allowed: settings.allowed, used: 0, budget: 0, day: "2026-11-23" }),
        adjustUsage: async (tenant: string, delta: number, day: string) => void log.push(["adjustUsage", tenant, delta, day]),
      }) as never,
    respond: async (request) => {
      asked.push({ instructions: request.instructions, input: structuredClone(request.input), tools: request.tools.map((each) => ({ name: each.name })) });
      const next = model.shift() ?? answer([says("done")]);
      if (next instanceof Error) throw next;
      return next;
    },
    requests: {
      continuationOf: () => settings.carried as Continuation | undefined,
      draft: (carried: Continuation, run: RunRow, text: string) => (log.push(["draft", carried.id, run.id, text]), { ok: true as const }),
      mayNotDisclose: async () => {
        if (settings.mayNotDisclose instanceof Error) throw settings.mayNotDisclose;
        return settings.mayNotDisclose;
      },
      endRequest: (id: string, status: string, why: string) => void log.push(["endRequest", id, status, why]),
      guards: () => settings.guards,
      over: async () => {
        if (settings.over instanceof Error) throw settings.over;
        return settings.over;
      },
      followUps: () => settings.followUps,
      basis: (runId: string) => store.rows<InboxRow>("SELECT * FROM inbox WHERE run_id = ? AND kind = 'message' ORDER BY id", runId),
      resumed: () => undefined,
      reopenable: () => [],
      cancellable: () => [],
      askedFor: () => "",
      resume: async (event: InboxRow) => (log.push(["resume", event.source_id]), undefined),
    } as unknown as RunnerHost["requests"],
    outbox: {
      notify: (idem: string, sessionId: string, runId: string | null, text: string) => void log.push(["notify", idem, sessionId, runId, text]),
      notice: (which: string) => `notice:${which}`,
      scrub: (which: string, value: unknown) => void log.push(["scrub", which, value]),
    } as unknown as RunnerHost["outbox"],
    tools: { for: (run: RunRow) => (log.push(["toolsFor", run.id]), toolHost) },
  };
  const runner = new Runner(store, host);
  let made = 0;
  /** An event in the inbox: by default the person's own message in their private conversation. */
  const event = (text: string, over: Partial<{ source: string; kind: string; session_key: string; principal: Record<string, unknown>; data: Record<string, unknown>; reply_to: string | null; received_at: number; status: string; source_id: string }> = {}): number =>
    store.rows<{ id: number }>(
      "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, reply_to, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      over.source ?? "feishu",
      over.source_id ?? `om_${++made}`,
      over.kind ?? "message",
      over.session_key ?? PRIVATE,
      JSON.stringify(over.principal ?? { kind: "human", id: PERSON, explicit: true }),
      text,
      JSON.stringify(over.data ?? { direct: true, origin: ORIGIN }),
      over.reply_to === undefined ? TARGET : over.reply_to,
      over.status ?? "pending",
      over.received_at ?? Date.now(),
    )[0].id;
  const run = (id: string) => store.rows<RunRow & Record<string, any>>("SELECT * FROM runs WHERE id = ?", id)[0];
  const items = (runId?: string) => store.rows<{ item: string; outside: number; is_user: number }>(`SELECT item, outside, is_user FROM items ${runId ? "WHERE run_id = ?" : ""} ORDER BY seq`, ...(runId ? [runId] : [])).map((each) => ({ ...(JSON.parse(each.item) as Item), _outside: each.outside }));
  const inbox = () => store.rows<{ id: number; status: string; run_id: string | null }>("SELECT id, status, run_id FROM inbox ORDER BY id");
  const of = (name: string) => log.filter(([each]) => each === name).map(([, ...args]) => args);
  /** Claims what is pending and runs it to its end, as the wake cycle does once. */
  const go = async () => {
    const id = await runner.next();
    if (id) await runner.execute(id);
    return id;
  };
  const tenant = store.scope().tenant;
  return { store, tenant, runner, host, settings, model, asked, results, outside, log, event, run, items, inbox, of, go };
}

describe("the run loop, by itself", () => {
  describe("claiming", () => {
    it("takes the oldest conversation's pending events as one run, with a user turn that says who said what", async () => {
      await within(async ({ runner, store, event, inbox, items, run }) => {
        const first = event("hello");
        const second = event("are you there?");
        const elsewhere = event("other", { session_key: "chat:oc_9" });
        const id = (await runner.next())!;
        expect(store.meta("active_run")).toBe(id);
        expect(run(id)).toMatchObject({ status: "running", entries: 0, steps: 0 });
        expect(inbox()).toEqual([
          { id: first, status: "claimed", run_id: id },
          { id: second, status: "claimed", run_id: id },
          { id: elsewhere, status: "pending", run_id: null },
        ]);
        const [turn] = items(id);
        expect(turn.role).toBe("user");
        expect(turn.content).toMatch(/^\[[^\]]+\] message from ou_1 \(person, id ou_1, addressing you\): hello\n\[[^\]]+\] message from ou_1 \(person, id ou_1, addressing you\): are you there\?$/);
        // The conversation answers where its latest addressed event came from.
        expect(store.rows<{ session_key: string; target: string }>("SELECT session_key, target FROM sessions")).toEqual([{ session_key: PRIVATE, target: TARGET }]);
      });
    });

    it("takes a burst as several runs, by count and by size", async () => {
      await within(async ({ runner, store, event, inbox }) => {
        for (let i = 0; i < 45; i++) event(`m${i}`);
        const id = (await runner.next())!;
        expect(inbox().filter((each) => each.run_id === id)).toHaveLength(40);
        expect(inbox().filter((each) => each.status === "pending")).toHaveLength(5);
        void store;
      });
      await within(async ({ runner, event, inbox }) => {
        event("x".repeat(70_000));
        event("y".repeat(70_000));
        const id = (await runner.next())!;
        expect(inbox().filter((each) => each.run_id === id)).toHaveLength(1);
      });
      await within(async ({ runner, event, inbox }) => {
        // One that is too large alone is still taken.
        event("z".repeat(200_000));
        const id = (await runner.next())!;
        expect(inbox().filter((each) => each.run_id === id)).toHaveLength(1);
      });
    });

    it("leaves a ready request out of the batch, and answers where the latest addressed event came from", async () => {
      await within(async ({ runner, store, event, inbox }) => {
        const first = event("hello", { reply_to: JSON.stringify({ connector: "feishu", address: { chat_id: "oc_old" } }) });
        const ready = event("", { kind: "request.ready", source: "request", source_id: "req_1:said" });
        const second = event("again");
        event("not addressed", { reply_to: null });
        const id = (await runner.next())!;
        expect(inbox().filter((each) => each.run_id === id).map((each) => each.id)).toEqual([first, second, first + 3]);
        expect(inbox().find((each) => each.id === ready)).toMatchObject({ status: "pending", run_id: null });
        expect(store.rows<{ target: string }>("SELECT target FROM sessions")[0].target).toBe(TARGET);
      });
    });

    it("keeps the active run, and waits while it is to be retried later", async () => {
      await within(async ({ runner, store, event }) => {
        event("hello");
        const id = (await runner.next())!;
        event("more");
        expect(await runner.next()).toBe(id);
        store.sql.exec("UPDATE runs SET retry_at = ? WHERE id = ?", Date.now() + 60_000, id);
        expect(await runner.next()).toBeUndefined();
        store.sql.exec("UPDATE runs SET retry_at = ? WHERE id = ?", Date.now() - 1, id);
        expect(await runner.next()).toBe(id);
        expect(runner.activeRun()?.id).toBe(id);
      });
    });

    it("asks the requests part to carry on a ready request when it is the oldest pending event", async () => {
      await within(async ({ runner, host, event, store, of }) => {
        const ready = event("", { kind: "request.ready", source: "request", source_id: "req_1:said" });
        event("hello");
        host.requests.resume = (async (row: InboxRow) => {
          store.sql.exec("UPDATE inbox SET status = 'done' WHERE id = ?", row.id);
          return undefined;
        }) as never;
        const id = (await runner.next())!;
        expect(id).toBeDefined();
        expect(of("resume")).toEqual([]);
        expect(store.rows<{ status: string }>("SELECT status FROM inbox WHERE id = ?", ready)[0].status).toBe("done");
        // A run it starts is the one to work on.
        store.sql.exec("DELETE FROM meta WHERE key = 'active_run'");
        event("", { kind: "request.ready", source: "request", source_id: "req_2:said" });
        host.requests.resume = (async () => "run_carried") as never;
        expect(await runner.next()).toBe("run_carried");
      });
    });

    it("says what a message was written in reply to: the person's own earlier words, or when the agent's message was sent", async () => {
      await within(async ({ runner, store, event, items }) => {
        event("the link https://x", { source_id: "om_parent", status: "done" });
        event("summarise it", { data: { direct: true, origin: ORIGIN, replies_to: "feishu:message:om_parent" } });
        const id = (await runner.next())!;
        expect(items(id)[0].content).toContain('\n  (written as a reply to their own earlier message: "the link https://x")');
        store.sql.exec("DELETE FROM meta WHERE key = 'active_run'");
        store.sql.exec("INSERT INTO outbox (idem, run_id, target, text, status, next_at, created_at, sent_at, receipt) VALUES ('m1', ?, ?, 't', 'sent', 0, 0, ?, ?)", id, TARGET, Date.UTC(2026, 10, 23, 8), JSON.stringify({ subject: "feishu:message:om_bot", holder: "b" }));
        event("why?", { data: { direct: true, origin: ORIGIN, replies_to: "feishu:message:om_bot" } });
        const next = (await runner.next())!;
        expect(items(next)[0].content).toContain("\n  (written as a reply to the message you sent at 2026-11-23T08:00:00.000Z)");
      });
    });

    it("does not quote what someone else wrote, nor anything from another conversation", async () => {
      await within(async ({ runner, event, items }) => {
        event("secret", { source_id: "om_other", status: "done", principal: { kind: "human", id: "ou_2", explicit: true } });
        event("elsewhere", { source_id: "om_far", status: "done", session_key: "chat:oc_2" });
        event("what?", { data: { direct: true, origin: ORIGIN, replies_to: "feishu:message:om_other" } });
        event("and?", { data: { direct: true, origin: ORIGIN, replies_to: "feishu:message:om_far" } });
        const id = (await runner.next())!;
        expect(items(id)[0].content).not.toContain("written as a reply");
      });
    });
  });

  describe("running", () => {
    it("calls the model with the instructions, the transcript and the tools, and ends when it stops", async () => {
      await within(async ({ go, event, model, asked, run, store, inbox, log, tenant }) => {
        event("hello");
        model.push(answer([says("hi")], 250));
        const id = (await go())!;
        expect(asked).toHaveLength(1);
        expect(asked[0].input).toHaveLength(1);
        expect(asked[0].instructions.length).toBeGreaterThan(0);
        expect(asked[0].tools.map((each) => each.name)).toContain("send_message");
        expect(run(id)).toMatchObject({ status: "done", steps: 1, input_tokens: 240, output_tokens: 10 });
        expect(inbox()[0].status).toBe("done");
        expect(store.meta("active_run")).toBeUndefined();
        // The tenant's share is reserved before the call and trued up after it.
        expect(log.filter(([name]) => name === "recordUsage" || name === "adjustUsage")).toEqual([
          ["recordUsage", tenant, 20_000],
          ["adjustUsage", tenant, 250 - 20_000, "2026-11-23"],
        ]);
      });
    });

    it("gives the reservation back when the run stops being this object's while the reservation is made", async () => {
      await within(async ({ go, event, host, store, asked, log, tenant }) => {
        event("hello");
        const registry = host.registry;
        host.registry = () => ({
          ...registry(),
          recordUsage: async (name: string, tokens: number) => {
            const made = await registry().recordUsage(name, tokens);
            store.sql.exec("DELETE FROM meta WHERE key = 'active_run'");
            return made;
          },
        });
        await go();
        expect(asked).toHaveLength(0);
        expect(log.filter(([name]) => name === "recordUsage" || name === "adjustUsage")).toEqual([
          ["recordUsage", tenant, 20_000],
          ["adjustUsage", tenant, -20_000, "2026-11-23"],
        ]);
      });
    });

    it("counts what a model call spent when the run stops being this object's while the call is made", async () => {
      await within(async ({ go, event, host, store, model, log, tenant, runner }) => {
        event("hello");
        model.push(answer([says("hi")], 250));
        const respond = host.respond;
        host.respond = async (request) => {
          const response = await respond(request);
          store.sql.exec("DELETE FROM meta WHERE key = 'active_run'");
          return response;
        };
        await go();
        expect(log.filter(([name]) => name === "recordUsage" || name === "adjustUsage")).toEqual([
          ["recordUsage", tenant, 20_000],
          ["adjustUsage", tenant, 250 - 20_000, "2026-11-23"],
        ]);
        // And in this scope's own count: the tokens were spent.
        expect(runner.tokensToday()).toBe(250);
      });
    });

    it("carries out the tool calls the model asked for, records their outputs, and asks again", async () => {
      await within(async ({ go, event, model, asked, results, items, of }) => {
        event("hello");
        results.memoryList = { files: [] };
        model.push(answer([calls("memory_list", "call_1")]), answer([says("nothing there")]));
        const id = (await go())!;
        expect(of("tool").map(([name]) => name)).toEqual(["memoryList"]);
        expect(asked).toHaveLength(2);
        expect(items(id).map((each) => each.type ?? each.role)).toEqual(["user", "function_call", "function_call_output", "message"]);
        expect(JSON.parse(items(id)[2].output)).toEqual({ files: [] });
      });
    });

    it("marks the output of a call that read from outside, and the run counts as having read outside text while it runs", async () => {
      await within(async ({ go, event, model, results, outside, runner, store, items, of }) => {
        event("hello");
        let during: boolean | undefined;
        let id = "";
        results.memoryList = () => {
          outside.add("call_1");
          during = runner.sawOutside(id);
          return { text: "from outside" };
        };
        model.push(answer([calls("memory_list", "call_1")]), answer([says("it says…")]));
        id = (await runner.next())!;
        await runner.execute(id);
        expect(during).toBe(true);
        // Recorded as outside, and the call is no longer in this invocation's set.
        expect(outside.size).toBe(0);
        // Then forgotten with everything the run did after reading.
        expect(items(id).map((each) => each.role ?? each.type)).toEqual(["user", "assistant"]);
        expect(of("scrub")).toEqual([["run_id = ?", id]]);
        void go;
        void store;
      });
    });

    it("stops after sixteen model calls", async () => {
      await within(async ({ go, event, model, run }) => {
        event("hello");
        for (let i = 0; i < 20; i++) model.push(answer([calls("memory_list", `call_${i}`)]));
        const id = (await go())!;
        expect(run(id)).toMatchObject({ status: "done", steps: 16 });
      });
    });

    it("tries a failed model call again later, waiting longer each time, and gives up after five entries", async () => {
      await within(async ({ runner, event, model, run, store, of, tenant }) => {
        event("hello");
        const id = (await runner.next())!;
        const delays: number[] = [];
        for (let entry = 1; entry <= 5; entry++) {
          model.push(new ModelError("busy", 503, true));
          const before = Date.now();
          await runner.execute(id);
          expect(run(id)).toMatchObject({ status: "running", entries: entry, error: "busy" });
          delays.push(run(id).retry_at - before);
          // The reservation for the call that failed is given back.
          expect(of("adjustUsage").at(-1)).toEqual([tenant, -20_000, "2026-11-23"]);
          store.sql.exec("UPDATE runs SET retry_at = NULL WHERE id = ?", id);
        }
        expect(delays.map((each) => Math.round(each / 1_000))).toEqual([5, 30, 120, 300, 300]);
        await runner.execute(id);
        expect(run(id)).toMatchObject({ status: "failed", error: "the run kept failing and was abandoned" });
        expect(of("notify")).toEqual([[`abandoned:${id}`, run(id).session_id, id, "notice:failed"]]);
        expect(store.meta("active_run")).toBeUndefined();
      });
    });

    it("abandons at once a run the model refuses for good, and closes the calls left open", async () => {
      await within(async ({ runner, model, run, items, event, store, of }) => {
        event("hello");
        const id = (await runner.next())!;
        model.push(new ModelError("bad request", 400, false));
        await runner.execute(id);
        expect(run(id)).toMatchObject({ status: "failed", error: "bad request" });
        expect(store.meta("active_run")).toBeUndefined();
        expect(of("notify")).toEqual([[`abandoned:${id}`, run(id).session_id, id, "notice:failed"]]);
        // What started it is dead, not done.
        expect(store.rows<{ status: string }>("SELECT status FROM inbox")).toEqual([{ status: "dead" }]);
        void items;
      });
      await within(async ({ runner, model, run, items, event }) => {
        event("hello");
        const id = (await runner.next())!;
        // A call left open by an earlier attempt that died, then the run is abandoned.
        runner.append(run(id).session_id, id, calls("memory_list", "call_9"));
        model.push(new ModelError("bad request", 400, false));
        // Its output is recorded before the model is asked: the stand-in tool answers it.
        await runner.execute(id);
        const outputs = items(id).filter((each) => each.type === "function_call_output");
        expect(outputs.map((each) => each.call_id)).toEqual(["call_9"]);
        expect(run(id).status).toBe("failed");
      });
      await within(async ({ runner, run, items, event, store }) => {
        event("hello");
        const id = (await runner.next())!;
        runner.append(run(id).session_id, id, calls("memory_list", "call_9"));
        // Entered too often: abandoned before anything runs, and the open call is closed.
        store.sql.exec("UPDATE runs SET entries = 5 WHERE id = ?", id);
        await runner.execute(id);
        const output = items(id).find((each) => each.type === "function_call_output");
        expect(output).toMatchObject({ call_id: "call_9" });
        expect(JSON.parse(output!.output)).toEqual({ error: "the run was abandoned before this finished" });
      });
      await within(async ({ runner, model, run, event }) => {
        event("hello");
        const id = (await runner.next())!;
        // A failure that could not even reach the model is retried, whatever it says.
        model.push(new ModelError("network", 0, false));
        await runner.execute(id);
        expect(run(id).status).toBe("running");
      });
    });

    it("pauses until tomorrow when the day's budget is spent, without counting that as a failure", async () => {
      await within(async ({ runner, event, store, model, asked, run, of, tenant }) => {
        store.setMeta(`tokens:${new Date().toISOString().slice(0, 10)}`, "2000000");
        event("hello");
        const id = (await runner.next())!;
        await runner.execute(id);
        expect(asked).toEqual([]);
        expect(run(id)).toMatchObject({ status: "running", entries: 0 });
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 30, 0);
        expect(run(id).retry_at).toBe(midnight.getTime());
        expect(of("notify")).toEqual([[`budget:${id}:${new Date().toISOString().slice(0, 10)}`, run(id).session_id, id, "notice:tomorrow"]]);
        expect(of("adjustUsage")).toEqual([[tenant, -20_000, "2026-11-23"]]);
        void model;
      });
      await within(async ({ runner, event, settings, asked, run }) => {
        settings.allowed = false;
        event("hello");
        const id = (await runner.next())!;
        await runner.execute(id);
        expect(asked).toEqual([]);
        expect(run(id).status).toBe("running");
      });
    });

    it("counts what the model spent against the day", async () => {
      await within(async ({ go, event, model, runner }) => {
        event("hello");
        model.push(answer([calls("memory_list", "call_1")], 300), answer([says("ok")], 200));
        await go();
        expect(runner.tokensToday()).toBe(500);
        runner.spend(50);
        expect(runner.tokensToday()).toBe(550);
      });
    });

    it("refuses a tool the run may no longer use once it has read outside text, without calling it", async () => {
      await within(async ({ runner, event, store, model, items, of, asked }) => {
        event("hello");
        const id = (await runner.next())!;
        const session = store.rows<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", id)[0].session_id;
        runner.append(session, id, { type: "function_call", call_id: "c0", name: "feishu_read_document", arguments: "{}" });
        runner.append(session, id, { type: "function_call_output", call_id: "c0", output: "{}" }, true);
        model.push(answer([calls("memory_write", "call_1", { path: "a.md", content: "x" })]), answer([says("ok")]));
        await runner.execute(id);
        expect(of("tool")).toEqual([]);
        // What the model was shown next: the refusal in place of the tool's output. (The run's own
        // record of it is then forgotten with everything else it did after reading.)
        const output = asked[1].input.find((each) => each.call_id === "call_1" && each.type === "function_call_output");
        expect(JSON.parse(output!.output).error).toMatch(/^this run has read text from outside/);
        void items;
      });
    });
  });

  describe("a run that stopped being the active one while it waited", () => {
    it("does not record what the model said once another run is active", async () => {
      await within(async ({ runner, event, host, store, items, run }) => {
        event("hello");
        const id = (await runner.next())!;
        host.respond = async () => {
          store.setMeta("active_run", "another");
          return answer([says("too late")], 500);
        };
        await runner.execute(id);
        expect(items(id).map((each) => each.role ?? each.type)).toEqual(["user"]);
        expect(run(id)).toMatchObject({ steps: 0, input_tokens: 0, output_tokens: 0 });
        // What it said is not this run's to record; what it spent was spent all the same.
        expect(runner.tokensToday()).toBe(500);
      });
    });
  });

  describe("ending a run in one step", () => {
    it("leaves the run as it was when ending it fails part way, and ends it once when tried again", async () => {
      await within(async ({ runner, event, host, store, run, inbox }) => {
        event("hello");
        const id = (await runner.next())!;
        runner.append(run(id).session_id, id, says("done"));
        const followUps = host.requests.followUps;
        let failed = false;
        host.requests.followUps = () => {
          if (failed) return followUps();
          failed = true;
          throw new Error("storage hiccup");
        };
        await expect(runner.execute(id)).rejects.toThrow("storage hiccup");
        expect(run(id).status).toBe("running");
        expect(inbox()[0].status).toBe("claimed");
        expect(store.meta("active_run")).toBe(id);
        await runner.execute(id);
        expect(run(id).status).toBe("done");
        expect(inbox()[0].status).toBe("done");
        expect(store.meta("active_run")).toBeUndefined();
      });
    });

    it("leaves the run as it was when abandoning it fails part way, and closes an open call once when tried again", async () => {
      await within(async ({ runner, event, host, store, run, items }) => {
        event("hello");
        const id = (await runner.next())!;
        runner.append(run(id).session_id, id, calls("memory_list", "call_9"));
        store.sql.exec("UPDATE runs SET entries = 5 WHERE id = ?", id);
        const notify = host.outbox.notify;
        let failed = false;
        host.outbox.notify = ((...args: Parameters<typeof notify>) => {
          if (failed) return notify(...args);
          failed = true;
          throw new Error("storage hiccup");
        }) as typeof notify;
        await expect(runner.execute(id)).rejects.toThrow("storage hiccup");
        expect(items(id).filter((each) => each.type === "function_call_output")).toEqual([]);
        expect(run(id).status).toBe("running");
        await runner.execute(id);
        expect(items(id).filter((each) => each.type === "function_call_output").map((each) => each.call_id)).toEqual(["call_9"]);
        expect(run(id).status).toBe("failed");
      });
    });
  });

  describe("ending a run", () => {
    it("replaces everything a run that read outside text said or did by one fixed note, and empties its messages", async () => {
      await within(async ({ runner, event, store, items, of }) => {
        event("read this");
        const id = (await runner.next())!;
        const session = store.rows<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", id)[0].session_id;
        runner.append(session, id, { type: "function_call", call_id: "c0", name: "feishu_read_document", arguments: "{}" });
        runner.append(session, id, { type: "function_call_output", call_id: "c0", output: "the secret" }, true);
        runner.append(session, id, says("it says the secret"));
        store.sql.exec("INSERT INTO outbox (idem, run_id, target, text, next_at, created_at) VALUES ('m1', ?, ?, 't', 0, 0)", id, TARGET);
        await runner.execute(id);
        const kept = items(id);
        expect(kept.map((each) => each.role ?? each.type)).toEqual(["user", "assistant"]);
        expect(kept[1].content).toMatch(/^\[In this turn you answered using a tool that read text from outside/);
        expect(store.rows<{ private: number }>("SELECT private FROM outbox")[0].private).toBe(1);
        expect(of("scrub")).toEqual([["run_id = ?", id]]);
      });
    });

    it("keeps where a lone message came from, for a follow-up, only when the run read one thing and said one thing", async () => {
      const source = { connector: "feishu", tool: "feishu_read_document", identity: "doc:1", args: "{}", events: { said: [1], recent: [] }, call: "c0", fingerprint: "f", condition: "g", generation: 1 };
      const finish = async (b: ReturnType<typeof bench>, over: { sources?: unknown[]; messages?: number; followUps?: boolean } = {}) => {
        b.settings.followUps = over.followUps ?? true;
        b.event("read this");
        const id = (await b.runner.next())!;
        b.store.setMeta(`sources:${id}`, JSON.stringify(over.sources ?? [source]));
        b.store.setMeta(`quotes:${id}`, JSON.stringify([{ point: "p", quote: "q" }]));
        for (let i = 0; i < (over.messages ?? 1); i++) b.store.sql.exec("INSERT INTO outbox (idem, run_id, target, text, next_at, created_at) VALUES (?, ?, ?, 't', 0, 0)", `m${i}`, id, TARGET);
        await b.runner.execute(id);
        const kept = b.store.rows<{ source: string | null }>("SELECT source FROM outbox ORDER BY id").map((each) => each.source && JSON.parse(each.source));
        expect(b.store.meta(`sources:${id}`)).toBeUndefined();
        expect(b.store.meta(`quotes:${id}`)).toBeUndefined();
        return kept;
      };
      await within(async (b) => expect(await finish(b)).toEqual([{ sources: [source], quotes: [{ point: "p", quote: "q" }] }]));
      // The same thing read twice is one thing.
      await within(async (b) => expect(await finish(b, { sources: [{ ...source, fingerprint: "old" }, source] })).toEqual([{ sources: [source], quotes: [{ point: "p", quote: "q" }] }]));
      await within(async (b) => expect(await finish(b, { sources: [source, { ...source, identity: "doc:2" }] })).toEqual([null]));
      await within(async (b) => expect(await finish(b, { messages: 2 })).toEqual([null, null]));
      await within(async (b) => expect(await finish(b, { followUps: false })).toEqual([null]));
      // A read noted while follow-ups were off keeps nothing.
      await within(async (b) => expect(await finish(b, { sources: [{ connector: "feishu", condition: "g", generation: 1 }] })).toEqual([null]));
    });

    it("turns the answer of a request it carried on into a message to deliver, or says it was not answered", async () => {
      await within(async ({ runner, event, store, settings, of }) => {
        event("hello");
        const id = (await runner.next())!;
        settings.carried = { id: "req_1", status: "resuming" };
        store.sql.exec("INSERT INTO continuations (id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, created_at) VALUES ('req_1', 's', '{}', 'feishu', 't', '{}', '{}', 'g', 'c', 1, 'i', 0, 'resuming', 0)");
        store.sql.exec("INSERT INTO outbox (idem, target, text, status, next_at, created_at) VALUES ('answer:req_1', ?, 'the answer', 'draft', 0, 0)", TARGET);
        await runner.execute(id);
        expect(store.rows<{ status: string }>("SELECT status FROM outbox WHERE idem = 'answer:req_1'")[0].status).toBe("pending");
        expect(store.rows<{ status: string }>("SELECT status FROM continuations WHERE id = 'req_1'")[0].status).toBe("answering");
        expect(of("draft")).toEqual([]);
      });
      await within(async ({ runner, event, settings, of }) => {
        event("hello");
        const id = (await runner.next())!;
        settings.carried = { id: "req_1", status: "resuming" };
        await runner.execute(id);
        expect(of("draft")).toEqual([["req_1", id, "notice:notAnswered"]]);
      });
      await within(async ({ runner, event, store, settings }) => {
        event("hello");
        const id = (await runner.next())!;
        settings.carried = { id: "req_1", status: "waiting" };
        store.sql.exec("INSERT INTO outbox (idem, target, text, status, next_at, created_at) VALUES ('answer:req_1', ?, 'stale', 'draft', 0, 0)", TARGET);
        await runner.execute(id);
        expect(store.rows("SELECT 1 FROM outbox WHERE idem = 'answer:req_1'")).toEqual([]);
      });
    });
  });

  describe("a request being carried on", () => {
    const carrying = async (b: ReturnType<typeof bench>) => {
      // The person the request is carried on for can still be acted for.
      b.settings.connectorTools = [{ name: "feishu_read_document", effect: "read" } as ConnectorTool];
      b.event("hello");
      const id = (await b.runner.next())!;
      const session = b.store.rows<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", id)[0].session_id;
      b.settings.carried = { id: "req_1", status: "resuming", claimed_at: Date.now() };
      b.runner.append(session, id, { type: "function_call", call_id: "c0", name: "feishu_read_document", arguments: "{}" });
      b.runner.append(session, id, { type: "function_call_output", call_id: "c0", output: "the text" }, true);
      return id;
    };

    it("is not put before the model once its condition no longer holds; the person is told", async () => {
      await within(async (b) => {
        const id = await carrying(b);
        b.settings.mayNotDisclose = "the authorisation was withdrawn";
        await b.runner.execute(id);
        expect(b.asked).toEqual([]);
        expect(b.of("endRequest")).toEqual([["req_1", "void", "the authorisation was withdrawn"]]);
        expect(b.of("notify")).toEqual([[`withheld:${id}`, b.run(id).session_id, null, "notice:withheld"]]);
        expect(b.run(id).status).toBe("done");
      });
    });

    it("is not put before the model once it is no longer the person's to ask here", async () => {
      await within(async (b) => {
        const id = await carrying(b);
        b.settings.connectorTools = [];
        await b.runner.execute(id);
        expect(b.asked).toEqual([]);
        expect(b.of("endRequest")).toEqual([["req_1", "void", "it is no longer the person's to ask here"]]);
      });
    });

    it("is tried again later when the condition's owner cannot be asked", async () => {
      await within(async (b) => {
        const id = await carrying(b);
        b.settings.mayNotDisclose = new Error("Feishu is down");
        await b.runner.execute(id);
        expect(b.asked).toEqual([]);
        expect(b.run(id)).toMatchObject({ status: "running", error: "failed after reading outside text; the details are not kept" });
      });
    });

    it("gives the reservation back when the run stops being this object's while a condition's owner is asked", async () => {
      for (const asking of ["mayNotDisclose", "over"] as const) {
        await within(async (b) => {
          const id = await carrying(b);
          b.settings.guards = [{ condition: "c" }];
          const lose = async () => void b.store.sql.exec("DELETE FROM meta WHERE key = 'active_run'");
          (b.host.requests as unknown as Record<string, unknown>)[asking] = lose;
          await b.runner.execute(id);
          expect(b.asked).toEqual([]);
          expect(b.of("adjustUsage")).toEqual([[b.tenant, -20_000, "2026-11-23"]]);
        });
      }
    });

    it("ends once its time is up, before the model is called", async () => {
      await within(async (b) => {
        const id = await carrying(b);
        b.settings.carried = { id: "req_1", status: "resuming", claimed_at: Date.now() - 61 * 60_000 };
        await b.runner.execute(id);
        expect(b.asked).toEqual([]);
        expect(b.of("endRequest")).toEqual([["req_1", "void", "it was not finished in time"]]);
        expect(b.of("notify")).toEqual([[`withheld:${id}`, b.run(id).session_id, null, "notice:notSent"]]);
      });
    });

    it("on a spent budget, gets the system's notice for its answer instead of waiting for tomorrow", async () => {
      await within(async (b) => {
        const id = await carrying(b);
        b.settings.allowed = false;
        await b.runner.execute(id);
        expect(b.asked).toEqual([]);
        // In place of its answer; with that draft there, the run's end adds nothing (the stand-in keeps no drafts).
        expect(b.of("draft")[0]).toEqual(["req_1", id, "notice:limit"]);
        expect(b.run(id).retry_at).toBeNull();
        expect(b.run(id).status).toBe("done");
      });
    });

    it("offers only send_message and its own call", async () => {
      await within(async (b) => {
        const id = await carrying(b);
        expect(b.runner.mayUse(id, "send_message")).toBe(true);
        expect(b.runner.mayUse(id, "memory_write")).toBe(false);
        b.settings.carried = { id: "req_1", status: "resuming", tool: "feishu_read_document" };
        expect(b.runner.mayUse(id, "feishu_read_document")).toBe(true);
        b.settings.carried = { id: "req_1", status: "waiting", tool: "feishu_read_document" };
        expect(b.runner.mayUse(id, "feishu_read_document")).toBe(false);
      });
    });
  });

  describe("a run that read something under a condition", () => {
    it("puts nothing more before the model, and sends nothing more, once the condition is over", async () => {
      await within(async (b) => {
        b.event("hello");
        const id = (await b.runner.next())!;
        const session = b.run(id).session_id;
        b.runner.append(session, id, { type: "function_call", call_id: "c0", name: "feishu_read_document", arguments: "{}" });
        b.runner.append(session, id, { type: "function_call_output", call_id: "c0", output: "x" }, true);
        b.store.sql.exec("INSERT INTO outbox (idem, run_id, target, text, next_at, created_at) VALUES ('m1', ?, ?, 'words', 0, 0), ('m2', ?, ?, 'begun', 0, 0)", id, TARGET, id, TARGET);
        b.store.sql.exec("UPDATE outbox SET started = 1 WHERE idem = 'm2'");
        b.settings.guards = [{}];
        b.settings.over = "the authorisation ended";
        await b.runner.execute(id);
        expect(b.asked).toEqual([]);
        expect(b.store.rows<{ idem: string; status: string }>("SELECT idem, status FROM outbox ORDER BY id")).toEqual([
          { idem: "m1", status: "void" },
          { idem: "m2", status: "pending" },
        ]);
        expect(b.of("notify")).toEqual([[`withheld:${id}`, session, null, "notice:withheld"]]);
      });
    });
  });

  describe("whom a run acts for", () => {
    it("is the person whose scope this is, writing to the agent in their private conversation through one connector", async () => {
      await within(async ({ runner, event, settings }) => {
        settings.connectorTools = [{ name: "feishu_read_document", effect: "read" } as ConnectorTool];
        const earlier = event("the link", { status: "done", received_at: Date.now() - 60_000 });
        event("summarise it");
        const id = (await runner.next())!;
        expect(runner.actingFor(id)).toEqual({ connector: "feishu", person: PERSON, origin: ORIGIN, said: [{ text: "summarise it", data: { direct: true, origin: ORIGIN } }], recent: [{ text: "the link", data: { direct: true, origin: ORIGIN } }], recentIds: [earlier] });
      });
    });

    it("is nobody outside a person's own scope, without connector tools, or for anything but their plain messages", async () => {
      const cases: [string, Record<string, unknown>][] = [
        ["a button press", { data: { direct: true, origin: ORIGIN, card: "x" } }],
        ["a reply to a question", { data: { direct: true, origin: ORIGIN, question: "ask:1" } }],
        ["a routed message", { data: { direct: true, origin: ORIGIN, routed_from: "chat:x" } }],
        ["not direct", { data: { origin: ORIGIN } }],
        ["no origin", { data: { direct: true } }],
        ["someone else", { principal: { kind: "human", id: "ou_2", explicit: true } }],
        ["not addressing", { principal: { kind: "human", id: PERSON, explicit: false } }],
        ["a timer", { kind: "timer.fired", principal: { kind: "timer", id: "t", explicit: false } }],
      ];
      for (const [, over] of cases) {
        await within(async ({ runner, event, settings }) => {
          settings.connectorTools = [{ name: "feishu_read_document", effect: "read" } as ConnectorTool];
          event("hello", over as never);
          const id = (await runner.next())!;
          expect(runner.actingFor(id)).toBeUndefined();
        });
      }
      await within(async ({ runner, event }) => {
        event("hello");
        const id = (await runner.next())!;
        expect(runner.actingFor(id)).toBeUndefined();
      });
      await within(async ({ runner, event, settings }) => {
        settings.connectorTools = [{ name: "feishu_read_document", effect: "read" } as ConnectorTool];
        event("hello", { session_key: "chat:oc_1" });
        const id = (await runner.next())!;
        expect(runner.actingFor(id)).toBeUndefined();
      }, "chat:oc_1");
    });

    it("counts as what came shortly before only the person's own messages here, within ten minutes, with the same verified origin", async () => {
      await within(async ({ runner, event, settings }) => {
        settings.connectorTools = [{ name: "feishu_read_document", effect: "read" } as ConnectorTool];
        event("too old", { status: "done", received_at: Date.now() - 11 * 60_000 });
        event("no origin", { status: "done", received_at: Date.now() - 60_000, data: { direct: true } });
        const kept = event("just now", { status: "done", received_at: Date.now() - 30_000 });
        event("summarise it");
        const id = (await runner.next())!;
        expect(runner.actingFor(id)?.recentIds).toEqual([kept]);
      });
    });

    it("is nobody in a scope that is not a person's own, even for their private conversation", async () => {
      await within(async ({ runner, event, settings }) => {
        settings.connectorTools = [{ name: "feishu_read_document", effect: "read" } as ConnectorTool];
        event("hello");
        const id = (await runner.next())!;
        expect(runner.actingFor(id)).toBeUndefined();
      }, `chat:${PERSON}`);
    });

    it("offers the connector's tools only to such a run, and after reading outside text only those that read", async () => {
      await within(async ({ runner, event, settings, store }) => {
        settings.connectorTools = [{ name: "feishu_read_document", effect: "read", description: "", parameters: {} } as unknown as ConnectorTool, { name: "feishu_write", effect: "write", description: "", parameters: {} } as unknown as ConnectorTool];
        event("hello");
        const id = (await runner.next())!;
        expect(runner.mayUse(id, "memory_write")).toBe(true);
        expect(runner.mayUse(id, "feishu_write")).toBe(true);
        const session = store.rows<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", id)[0].session_id;
        runner.append(session, id, { type: "function_call_output", call_id: "c0", output: "x" }, true);
        expect(runner.sawOutside(id)).toBe(true);
        expect(runner.mayUse(id, "send_message")).toBe(true);
        expect(runner.mayUse(id, "feishu_read_document")).toBe(true);
        expect(runner.mayUse(id, "feishu_write")).toBe(false);
        expect(runner.mayUse(id, "memory_write")).toBe(false);
      });
    });
  });
});
