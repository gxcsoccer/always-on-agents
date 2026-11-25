import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Standing } from "../src/connectors";
import type { Principal } from "../src/events";
import { Revisions } from "../src/brain/revisions";
import { BrainStore, type RunRow } from "../src/brain/store";
import { Tasks, type TasksHost } from "../src/brain/tasks";
import { sandboxWorker } from "../src/workers/sandbox/worker";

/**
 * Tasks handed to workers, and the approval questions they raise, by themselves on a real Brain's
 * storage. The worker, the registry, the channel a question is shown in and the rest of the Brain
 * are stand-ins. No model, no connector, no run, no alarm.
 */
const SESSION_KEY = "chat";
const TARGET = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_1" } });
const RUN = { id: "run_1" } as RunRow;
const ZERO = "0".repeat(40);
const BRANCH = [{ ref: "refs/heads/main", old: "a".repeat(40), new: "b".repeat(40) }];

let scopes = 0;
function within<T>(use: (bench: ReturnType<typeof bench>) => T | Promise<T>, scope = "chat:oc_tasks"): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(`acme:${scope}-${++scopes}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));
}

afterEach(() => vi.restoreAllMocks());

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  const settings = {
    deciders: [{ kind: "human", id: "alice", explicit: true }] as Principal[],
    revisable: new Set<string>(),
    /** What a source says one of its messages is now, by subject. */
    now: {} as Record<string, Standing>,
    /** The workers this deployment lists, by name. */
    workers: ["sandbox"],
  };
  /** The worker of every task: what it was told, and what it says back. */
  const worker = {
    started: [] as unknown[],
    cancelled: [] as string[],
    /** Set to have the sandbox give no answer to being stopped. */
    cancelFails: false,
    /** Something that happens while the sandbox is being asked to stop. */
    /** What the sandbox says when asked whether it has a task: its state, that it has none, or no answer at all. */
    has: "none" as "there" | "none" | Error,
    asked: [] as string[],
    answered: [] as unknown[][],
    start: (async () => ({ phase: "running" })) as (input: unknown) => Promise<{ phase: string; error?: string }>,
    answer: (async (decision: "allow" | "deny") => ({ ok: true, decision })) as (...args: any[]) => Promise<any>,
    fate: {} as Record<string, unknown>,
  };
  const slots = { acquired: [] as string[], released: [] as string[], usage: [] as [string, number][], acquire: (async () => true) as () => Promise<boolean> };
  const amended: unknown[][] = [];
  const background: Promise<unknown>[] = [];
  const woken: number[] = [];
  const spent: number[] = [];
  const mayRevisit = (source: string) => settings.revisable.has(source);
  const standingOf = async (_source: string, subject: string) => settings.now[subject];
  const isDecider = (principal: Principal) => principal.kind === "human" && principal.explicit;
  /** The sandbox of one task, as the Brain and the sandbox worker both reach it. */
  const sandboxOf = (taskId: string) =>
    ({
      start: async (input: unknown) => (worker.started.push(input), worker.start(input)),
      cancel: async () => {
        if (worker.cancelFails) throw new Error("connection reset");
        return (worker.cancelled.push(taskId), { ok: true });
      },
      claimed: async () => {
        worker.asked.push(taskId);
        if (worker.has instanceof Error) throw worker.has;
        return worker.has;
      },
      answer: async (...args: unknown[]) => (worker.answered.push(args), worker.answer(...args)),
      decisionOn: async (questionId: string) => {
        const fate = worker.fate[questionId];
        if (fate instanceof Error) throw fate;
        return fate ?? { state: "unknown" };
      },
    }) as never;
  const host: TasksHost & { amend: TasksHost["amend"] } = {
    env: { TASKS: { getByName: sandboxOf } } as never,
    // The deployment's workers, by name: the real sandbox worker, unless a test takes it out.
    workerNamed: (name) => (settings.workers.includes(name) && name === sandboxWorker.name ? sandboxWorker : undefined),
    workerOf: () => sandboxWorker,
    worker: sandboxOf,
    registry: () =>
      ({
        acquireTaskSlot: async (tenant: string, taskId: string) => (slots.acquired.push(`${tenant}:${taskId}`), slots.acquire()),
        releaseTaskSlot: async (taskId: string) => void slots.released.push(taskId),
        recordUsage: async (tenant: string, tokens: number) => (slots.usage.push([tenant, tokens]), { allowed: true, used: 0, budget: 0, day: "" }),
      }) as never,
    deciders: () => settings.deciders,
    isDecider,
    canRevisit: mayRevisit,
    standingOf,
    // As the outbox's own does, as far as the row goes.
    enqueue: (idem, sessionId, runId, text, ask) => {
      const target = store.rows<{ target: string | null }>("SELECT target FROM sessions WHERE id = ?", sessionId)[0]?.target;
      if (!target) throw new Error("there is nowhere to send a message in this conversation");
      store.sql.exec("INSERT OR IGNORE INTO outbox (idem, run_id, target, text, next_at, created_at, ask) VALUES (?, ?, ?, ?, 0, 0, ?)", idem, runId, target, text, ask ? JSON.stringify(ask) : null);
      return { ok: true };
    },
    amend: async (...args) => void amended.push(args),
    waitUntil: (promise) => void background.push(promise),
    wakeBy: async (at) => void woken.push(at),
    spend: (tokens) => void spent.push(tokens),
  };
  const revisions = new Revisions(store, { isDecider, canRevisit: mayRevisit, standingOf });
  const tasks = new Tasks(store, revisions, host);
  store.sql.exec("INSERT INTO sessions (id, session_key, target, created_at, updated_at) VALUES ('s1', ?, ?, 1, 1)", SESSION_KEY, TARGET);

  /** A task as it is kept: running, asked for by alice, unless said otherwise. */
  const task = (id: string, over: { status?: string; session_key?: string; requested_by?: string | null; pending?: unknown; answering?: unknown } = {}) => {
    store.sql.exec(
      "INSERT INTO tasks (id, op_id, worker, title, brief, session_key, requested_by, status, pending, answering, created_at, updated_at) VALUES (?, ?, 'sandbox', ?, 'brief', ?, ?, ?, ?, ?, 1000, 1000)",
      id,
      `op_${id}`,
      `Title of ${id}`,
      over.session_key ?? SESSION_KEY,
      over.requested_by === undefined ? "alice" : over.requested_by,
      over.status ?? "running",
      over.pending ? JSON.stringify(over.pending) : null,
      over.answering ? JSON.stringify(over.answering) : null,
    );
    store.sql.exec("INSERT INTO timers (id, due_at, session_key, note, created_at) VALUES (?, 9e15, ?, 'watch', 0)", `watch_${id}`, SESSION_KEY);
  };
  const kept = (id: string) => store.rows<Record<string, any>>("SELECT * FROM tasks WHERE id = ?", id)[0];
  const pendingOf = (id: string) => JSON.parse(kept(id).pending) as Record<string, any>;
  const question = (idem: string) => store.rows<Record<string, any>>("SELECT * FROM outbox WHERE idem = ?", idem)[0];
  const closed = (idem: string) => (question(idem)?.closed ? JSON.parse(question(idem).closed) : null);
  /** The question a worker's report raised reaches the people here. */
  const shown = (idem: string, over: { receipt?: unknown; sent_at?: number } = {}) =>
    void store.sql.exec("UPDATE outbox SET status = 'sent', sent_at = ?, receipt = ? WHERE idem = ?", over.sent_at ?? 5_000, over.receipt ? JSON.stringify(over.receipt) : null, idem);
  /** The worker asks; the question is shown. What is kept of it. */
  const asks = async (id: string, seq: number, body: Record<string, unknown> = { id: `q${seq}`, command: "rm -rf build" }, receipt?: unknown) => {
    await tasks.event(id, seq, "needs_input", body);
    const pending = pendingOf(id);
    if (pending.ask) shown(pending.ask, { receipt });
    return pending as { id: string; code: string; ask: string };
  };
  let said = 0;
  /** A message in the task's conversation, already handled by a run unless said otherwise. */
  const reply = (text: string, over: { person?: string; explicit?: boolean; status?: string; question?: string; session?: string; received_at?: number; subject?: string; revision?: number; routed_from?: string } = {}): number =>
    store.rows<{ id: number }>(
      "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, status, received_at) VALUES ('feishu', ?, 'message', ?, ?, ?, ?, ?, ?) RETURNING id",
      `om_${++said}`,
      over.session ?? SESSION_KEY,
      JSON.stringify({ kind: "human", id: over.person ?? "alice", explicit: over.explicit ?? true }),
      text,
      JSON.stringify({ ...(over.question ? { question: over.question } : {}), ...(over.subject ? { subject: over.subject, revision: over.revision ?? 1, holder: "h1" } : {}), ...(over.routed_from ? { routed_from: over.routed_from } : {}) }),
      over.status ?? "done",
      over.received_at ?? 10_000 + said,
    )[0].id;
  const audited = (action: string) => store.rows<{ actor: string; detail: string }>("SELECT actor, detail FROM audit WHERE action = ? ORDER BY id", action).map((each) => ({ actor: each.actor, ...(JSON.parse(each.detail) as Record<string, any>) }));
  const events = () => store.rows<Record<string, any>>("SELECT source, source_id, kind, session_key, principal, text, data FROM inbox WHERE source = 'worker' ORDER BY id");
  const timer = (id: string) => store.rows<Record<string, any>>("SELECT * FROM timers WHERE id = ?", `watch_${id}`)[0];
  const answer = (taskId: string, decision: "allow" | "deny", callId = "call_1", sessionKey = SESSION_KEY) => tasks.answer(RUN, sessionKey, callId, taskId, decision, "because");
  return { store, tasks, revisions, host, settings, worker, slots, amended, background, woken, spent, task, kept, pendingOf, question, closed, shown, asks, reply, audited, events, timer, answer };
}

describe("tasks, by themselves", () => {
  describe("handing work to a worker", () => {
    it("writes the task and its watchdog first, takes a sandbox slot, starts the worker, and says it is running", async () => {
      await within(async ({ tasks, store, kept, worker, slots, audited }) => {
        const before = Date.now();
        const result = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "Fix the build", "do it", "https://github.com/acme/app")) as { task_id: string; status: string };
        expect(result.status).toBe("running");
        expect(kept(result.task_id)).toMatchObject({ op_id: "call_1", worker: "sandbox", title: "Fix the build", brief: "do it", session_key: SESSION_KEY, requested_by: "alice", status: "running" });
        const [watch] = store.rows<Record<string, any>>("SELECT * FROM timers WHERE id = ?", `watch_${result.task_id}`);
        expect(watch).toMatchObject({ session_key: SESSION_KEY, status: "active" });
        expect(JSON.parse(watch.data)).toEqual({ task_id: result.task_id });
        expect(watch.due_at).toBeGreaterThanOrEqual(before + (2 * 60 * 60 + 10 * 60) * 1_000);
        expect(slots.acquired).toEqual([`acme:${result.task_id}`]);
        expect(worker.started).toEqual([{ id: result.task_id, prompt: "do it", repository: "https://github.com/acme/app", brain: store.scopeName(), accept_by: expect.any(Number) }]);
        expect(audited("task.dispatched")).toEqual([{ actor: "alice", task_id: result.task_id, title: "Fix the build", repository: "https://github.com/acme/app" }]);
      });
    });

    it("credits a task to the one person who asked, and to nobody when several did or none", async () => {
      await within(async ({ tasks, kept, settings, audited }) => {
        settings.deciders = [
          { kind: "human", id: "alice", explicit: true },
          { kind: "human", id: "alice", explicit: true },
        ];
        const one = (await tasks.dispatch(RUN, SESSION_KEY, "c1", "t", "b", null)) as { task_id: string };
        settings.deciders = [
          { kind: "human", id: "alice", explicit: true },
          { kind: "human", id: "bob", explicit: true },
        ];
        const two = (await tasks.dispatch(RUN, SESSION_KEY, "c2", "t", "b", null)) as { task_id: string };
        settings.deciders = [];
        const none = (await tasks.dispatch(RUN, SESSION_KEY, "c3", "t", "b", null)) as { task_id: string };
        expect([kept(one.task_id).requested_by, kept(two.task_id).requested_by, kept(none.task_id).requested_by]).toEqual(["alice", null, null]);
        expect(audited("task.dispatched").map((each) => each.actor)).toEqual(["alice", "(automation)", "(automation)"]);
      });
    });

    it("accepts only a GitHub https URL, and in a repository's own scope only that repository", async () => {
      await within(async ({ tasks }) => {
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c1", "t", "b", "git@github.com:acme/app.git")).rejects.toThrow("repository must be an https://github.com/owner/name URL");
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c2", "t", "b", "https://github.com/acme/app.git")).resolves.toMatchObject({ status: "running" });
      });
      await within(async ({ tasks, store }) => {
        const own = store.scope().id;
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c1", "t", "b", "https://github.com/other/repo")).rejects.toThrow(`in this repository's conversation a task can only work on ${own}`);
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c2", "t", "b", `https://github.com/${own.toUpperCase()}.git`)).resolves.toMatchObject({ status: "running" });
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c3", "t", "b", null)).resolves.toMatchObject({ status: "running" });
      }, "repo:acme/app");
    });

    it("never starts a second task for the same call, and does not start an already started one again", async () => {
      await within(async ({ tasks, store, worker }) => {
        const first = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        const again = await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null);
        expect(again).toEqual({ task_id: first.task_id, status: "running" });
        expect(store.rows("SELECT 1 FROM tasks")).toHaveLength(1);
        expect(worker.started).toHaveLength(1);
      });
    });

    it("continues a task that was written but never started, under the same id", async () => {
      await within(async ({ tasks, task, kept, worker }) => {
        task("t1", { status: "dispatching" });
        expect(await tasks.dispatch(RUN, SESSION_KEY, "op_t1", "t", "b", null)).toEqual({ task_id: "t1", status: "running" });
        expect(worker.started).toHaveLength(1);
        expect(kept("t1").status).toBe("running");
      });
    });

    it("runs at most three tasks at a time in a scope", async () => {
      await within(async ({ tasks, task, store }) => {
        task("t1", { status: "dispatching" });
        task("t2", { status: "running" });
        task("t3", { status: "needs_input" });
        task("t4", { status: "succeeded" });
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)).rejects.toThrow("there are already 3 tasks running here; wait for one to finish or cancel one");
        expect(store.rows("SELECT 1 FROM tasks")).toHaveLength(4);
      });
    });

    it("fails the task, and gives the slot back, when the registry cannot be reached", async () => {
      await within(async ({ tasks, store, kept, slots, worker, timer }) => {
        slots.acquire = async () => {
          throw new Error("registry down");
        };
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)).rejects.toThrow("the sandbox could not be started; try again");
        const id = store.rows<{ id: string }>("SELECT id FROM tasks")[0].id;
        expect(kept(id).status).toBe("failed");
        expect(JSON.parse(kept(id).result).error).toMatch(/^the registry could not be reached: Error: registry down/);
        expect(slots.released).toEqual([id]);
        expect(worker.started).toEqual([]);
        // Nothing is left to watch.
        expect(timer(id).status).toBe("done");
      });
    });

    it("fails the task when the tenant has no sandbox left", async () => {
      await within(async ({ tasks, store, kept, slots, worker }) => {
        slots.acquire = async () => false;
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)).rejects.toThrow("too many sandboxes are running for this tenant right now; try again later");
        const id = store.rows<{ id: string }>("SELECT id FROM tasks")[0].id;
        expect(JSON.parse(kept(id).result)).toEqual({ error: "the tenant's sandbox limit is reached" });
        expect(worker.started).toEqual([]);
      });
    });

    /** Lets the time for asking about tasks whose start was not answered come, and asks. */
    const later = async (store: BrainStore, tasks: Tasks) => {
      store.sql.exec("UPDATE unconfirmed SET next_at = 0");
      await tasks.settle();
    };
    const lost = async () => {
      throw new Error("connection reset");
    };

    it("finds the same start again when only its answer was lost, and starts nothing twice", async () => {
      await within(async ({ tasks, store, kept, slots, worker }) => {
        let calls = 0;
        worker.start = async () => {
          if (++calls === 1) throw new Error("connection reset");
          return { phase: "running" };
        };
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)).toMatchObject({ status: "running" });
        const id = store.rows<{ id: string }>("SELECT id FROM tasks")[0].id;
        expect(worker.started.map((each: any) => each.id)).toEqual([id, id]);
        expect(kept(id).status).toBe("running");
        expect(worker.cancelled).toEqual([]);
        expect(slots.released).toEqual([]);
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
      });
    });

    it("keeps a task whose start was not answered as not confirmed, with its place, and says the same to the call made again", async () => {
      await within(async ({ tasks, store, kept, slots, worker, woken }) => {
        worker.start = lost;
        const said = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string; status: string; note: string };
        expect(said).toMatchObject({ status: "unconfirmed", note: expect.stringContaining("Do not hand the same work over again") });
        const id = said.task_id;
        // Nothing is stopped or given back on a guess, and nobody is told to try again.
        expect(kept(id).status).toBe("unconfirmed");
        expect(worker.cancelled).toEqual([]);
        expect(slots.released).toEqual([]);
        expect(woken.length).toBeGreaterThan(0);
        expect(tasks.nextWakeAt(0)).not.toBeNull();
        // The same call again (a replay), and a look at how it stands: the same, with the same word.
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)).toEqual(said);
        expect(await tasks.status(id)).toMatchObject({ status: "unconfirmed", note: said.note });
        expect(worker.started).toHaveLength(2);
        // It holds one of the conversation's places while it is not known.
        expect(store.rows<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'unconfirmed'")[0].n).toBe(1);
      });
    });

    it("goes by what the worker reported while the start was being asked for, whatever became of the call's answer", async () => {
      await within(async ({ tasks, store, kept, slots, worker }) => {
        // It began, finished and reported; neither start was answered.
        worker.start = async () => {
          const id = store.rows<{ id: string }>("SELECT id FROM tasks")[0].id;
          if (kept(id).status === "dispatching") await tasks.event(id, 1, "result", { status: "succeeded", summary: "done" });
          throw new Error("connection reset");
        };
        const said = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string; status: string };
        expect(said.status).toBe("succeeded");
        expect(JSON.parse(kept(said.task_id).result)).toMatchObject({ summary: "done" });
        // Heard from: it is not asked to start a second time.
        expect(worker.started).toHaveLength(1);
        expect(worker.cancelled).toEqual([]);
        expect(slots.released).toEqual([said.task_id]);
      });
      await within(async ({ tasks, store, kept, worker }) => {
        // It began and has said so (progress), no more: it is running, not unconfirmed.
        worker.start = async () => {
          const id = store.rows<{ id: string }>("SELECT id FROM tasks")[0].id;
          await tasks.event(id, 1, "progress", { message: "cloning" });
          throw new Error("connection reset");
        };
        const said = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string; status: string };
        expect(said.status).toBe("running");
        expect(kept(said.task_id).status).toBe("running");
      });
    });

    it("finds out from the worker whether a task whose start was not answered began: it has it, it never heard of it, or it reported", async () => {
      // The worker has it: it began.
      await within(async ({ tasks, store, kept, slots, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        worker.has = "there";
        await later(store, tasks);
        expect(kept(id).status).toBe("running");
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
        expect(slots.released).toEqual([]);
        expect(tasks.nextWakeAt(0)).toBeNull();
      });
      // The worker never took it, and has closed it against a start still on its way: it never began. Failed, said in its conversation, its place given back.
      await within(async ({ tasks, store, kept, slots, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        // Not to be asked at first; then asked, and it says none.
        worker.has = new Error("connection reset");
        await later(store, tasks);
        expect(kept(id).status).toBe("unconfirmed");
        worker.has = "none";
        await later(store, tasks);
        expect(kept(id).status).toBe("failed");
        expect(JSON.parse(kept(id).result).error).toContain("never started");
        expect(slots.released).toEqual([id]);
        expect(store.rows<{ kind: string }>("SELECT kind FROM inbox WHERE source = 'worker'")).toEqual([{ kind: "worker.failed" }]);
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
        expect(store.rows<{ state: string }>("SELECT state FROM work WHERE id = ?", id)).toEqual([{ state: "failed" }]);
      });
      // It reports before it is asked about: what it reported stands, and nothing more is asked.
      await within(async ({ tasks, store, kept, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        await tasks.event(id, 1, "progress", { message: "cloning" });
        await later(store, tasks);
        expect(kept(id).status).toBe("running");
        expect(worker.asked).toEqual([]);
      });
    });

    it("gives up a task whose worker cannot be asked after a bounded number of tries: lost, said as not known, its place kept until it is certain that nothing runs", async () => {
      await within(async ({ tasks, store, kept, slots, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        worker.has = new Error("connection reset");
        for (let n = 0; n < 5; n++) {
          await later(store, tasks);
          expect(kept(id).status).toBe("unconfirmed");
          // Asked again later each time, further apart.
          expect(store.rows<{ attempts: number }>("SELECT attempts FROM unconfirmed")[0].attempts).toBe(n + 1);
        }
        await later(store, tasks);
        expect(kept(id).status).toBe("lost");
        expect(JSON.parse(kept(id).result).error).toContain("it is not known whether it began");
        // Nothing more is asked of a worker that does not answer, and its place is not given back on a guess.
        expect(worker.asked).toHaveLength(6);
        expect(worker.cancelled).toEqual([]);
        expect(slots.released).toEqual([]);
        expect(tasks.nextWakeAt(0)).toBeNull();
        // What is said in its conversation is that, not that a sandbox stopped.
        const said = store.rows<{ kind: string; text: string }>("SELECT kind, text FROM inbox WHERE source = 'worker'");
        expect(said.map((each) => each.kind)).toEqual(["worker.lost"]);
        expect(said[0].text).toContain("it is not known whether it began");
        expect(said[0].text).not.toContain("its sandbox stopped");
        // It no longer counts against the conversation's own places.
        expect(store.rows<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('dispatching', 'unconfirmed', 'running', 'needs_input')")[0].n).toBe(0);
        // Word of progress that comes after all, also repeated, does not bring it back and gives no place back: it has not been said to have ended.
        await tasks.event(id, 1, "progress", { message: "cloning" });
        await tasks.event(id, 1, "progress", { message: "cloning" });
        expect(kept(id).status).toBe("lost");
        expect(slots.released).toEqual([]);
        // Its ending, when the worker reports that, shows that nothing runs any more: the place is given back then, also on a repeat.
        await tasks.event(id, 2, "result", { status: "succeeded", summary: "late" });
        expect(kept(id).status).toBe("lost");
        expect(slots.released).toEqual([id]);
        await tasks.event(id, 2, "result", { status: "succeeded", summary: "late" });
        expect(slots.released).toEqual([id, id]);
      });
    });

    it("does not wait for ever for a start that neither answers nor fails: past its time the task is kept as not confirmed, and a late answer changes nothing", async () => {
      await within(async ({ tasks, store, kept, slots, worker }) => {
        vi.useFakeTimers();
        try {
          let answer: (value: { phase: string }) => void = () => undefined;
          worker.start = () => new Promise((resolve) => (answer = resolve));
          const asked = tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null) as Promise<{ task_id: string; status: string }>;
          await vi.advanceTimersByTimeAsync(7 * 60_000);
          const said = await asked;
          expect(said.status).toBe("unconfirmed");
          expect(kept(said.task_id).status).toBe("unconfirmed");
          // Asked once: there was no time left for a second try.
          expect(worker.started).toHaveLength(1);
          expect(slots.released).toEqual([]);
          // The answer comes after all: it is not used; the task is found out about as any unconfirmed one.
          answer({ phase: "running" });
          await vi.advanceTimersByTimeAsync(1);
          expect(kept(said.task_id).status).toBe("unconfirmed");
          expect(store.rows("SELECT task_id FROM unconfirmed")).toEqual([{ task_id: said.task_id }]);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("tells the worker until when it may first take the work: fixed when the task was first written, the same for every repeat", async () => {
      await within(async ({ tasks, store, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        const created = store.rows<{ created_at: number }>("SELECT created_at FROM tasks WHERE id = ?", id)[0].created_at;
        expect(worker.started.map((each: any) => each.accept_by)).toEqual([created + 15 * 60_000, created + 15 * 60_000]);
      });
    });

    it("counts, once, what a task ended here as lost turns out to have spent", async () => {
      await within(async ({ tasks, store, kept, slots, worker, spent }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        worker.has = new Error("connection reset");
        for (let n = 0; n < 6; n++) await later(store, tasks);
        expect(kept(id).status).toBe("lost");
        await tasks.event(id, 1, "result", { status: "succeeded", summary: "late", usage: { total_tokens: 1234 } });
        await tasks.event(id, 1, "result", { status: "succeeded", summary: "late", usage: { total_tokens: 1234 } });
        expect(kept(id).status).toBe("lost");
        expect(spent).toEqual([1234]);
        expect(slots.usage).toEqual([["acme", 1234]]);
      });
    });

    it("takes any word from the worker as showing that it began: not confirmed no longer, at once", async () => {
      await within(async ({ tasks, store, kept, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        expect(kept(id).status).toBe("unconfirmed");
        await tasks.event(id, 1, "progress", { message: "cloning" });
        expect(kept(id)).toMatchObject({ status: "running", last_progress: "cloning" });
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
        expect((await tasks.status(id)) as Record<string, unknown>).not.toHaveProperty("note");
      });
    });

    it("finds out, rather than guesses, when the same call is made again and the place cannot be asked for", async () => {
      await within(async ({ tasks, store, kept, slots, worker, task }) => {
        // As after an interruption: the task was written, and its worker may have been started, by an earlier attempt at this call.
        task("t_again", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_again' WHERE id = 't_again'");
        slots.acquire = async () => {
          throw new Error("registry down");
        };
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_again", "t", "b", null)).toMatchObject({ task_id: "t_again", status: "unconfirmed" });
        expect(kept("t_again").status).toBe("unconfirmed");
        expect(worker.started).toEqual([]);
        expect(store.rows("SELECT task_id FROM unconfirmed")).toEqual([{ task_id: "t_again" }]);
      });
      // No place to be had, on the same call made again: not failed either, for the same reason.
      await within(async ({ tasks, store, kept, slots, task }) => {
        task("t_again", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_again' WHERE id = 't_again'");
        slots.acquire = async () => false;
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_again", "t", "b", null)).toMatchObject({ status: "unconfirmed" });
        expect(kept("t_again").status).toBe("unconfirmed");
      });
      // It has reported meanwhile: it began, whatever the registry says. And one that ended meanwhile is told as it ended.
      await within(async ({ tasks, store, kept, slots, task }) => {
        task("t_again", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_again' WHERE id = 't_again'");
        slots.acquire = async () => {
          await tasks.event("t_again", 1, "progress", { message: "cloning" });
          return false;
        };
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_again", "t", "b", null)).toMatchObject({ status: "running" });
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
        task("t_done", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_done' WHERE id = 't_done'");
        slots.acquire = async () => {
          await tasks.event("t_done", 1, "result", { status: "succeeded", summary: "done" });
          throw new Error("registry down");
        };
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_done", "t", "b", null)).toMatchObject({ status: "succeeded" });
        expect(kept("t_done").status).toBe("succeeded");
      });
      // The same where the place is had: one that has ended meanwhile is told as it ended, nothing more is asked of its worker, and the place just taken is given back.
      await within(async ({ tasks, store, kept, slots, worker, task }) => {
        task("t_had", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_had' WHERE id = 't_had'");
        slots.acquire = async () => {
          await tasks.event("t_had", 1, "result", { status: "succeeded", summary: "done" });
          slots.released.length = 0;
          return true;
        };
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_had", "t", "b", null)).toMatchObject({ status: "succeeded" });
        expect(worker.started).toEqual([]);
        expect(slots.released).toEqual(["t_had"]);
        expect(kept("t_had").status).toBe("succeeded");
      });
    });

    it("lets a task that is not confirmed be called off like any other", async () => {
      await within(async ({ tasks, store, kept, slots, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        await tasks.cancel(SESSION_KEY, id);
        expect(kept(id).status).toBe("cancelled");
        expect(worker.cancelled).toEqual([id]);
        expect(slots.released).toEqual([id]);
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
      });
    });

    it("keeps one row for each task in the index of work, opened as it is written and ended once", async () => {
      await within(async ({ tasks, store, task }) => {
        const work = () => store.rows<Record<string, unknown>>("SELECT id, worker, session_key, person, state FROM work ORDER BY created_at, id");
        const one = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        // The same call again is the same task, and the same row.
        await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null);
        expect(work()).toEqual([{ id: one.task_id, worker: "sandbox", session_key: SESSION_KEY, person: "alice", state: "open" }]);
        await tasks.event(one.task_id, 1, "result", { status: "succeeded", summary: "done" });
        expect(work()).toMatchObject([{ id: one.task_id, state: "done" }]);
        // A late word on it changes nothing.
        await tasks.cancel(SESSION_KEY, one.task_id);
        expect(work()).toMatchObject([{ state: "done" }]);
        const two = (await tasks.dispatch(RUN, SESSION_KEY, "call_2", "t", "b", null)) as { task_id: string };
        await tasks.cancel(SESSION_KEY, two.task_id);
        expect(work().map((each) => each.state).sort()).toEqual(["cancelled", "done"]);
        // A task taken before there was an index has no row; it gets one when it ends.
        task("t_old", { status: "running" });
        await tasks.cancel(SESSION_KEY, "t_old");
        expect(store.rows("SELECT worker, session_key, state FROM work WHERE id = 't_old'")).toEqual([{ worker: "sandbox", session_key: SESSION_KEY, state: "cancelled" }]);
      });
    });

    it("takes nothing new where the deployment lists no such worker, writes nothing for it, and still stops a task taken before", async () => {
      await within(async ({ tasks, store, kept, settings, worker, slots }) => {
        // Started while the worker was listed.
        const before = (await tasks.dispatch(RUN, SESSION_KEY, "call_0", "t", "b", null)) as { task_id: string };
        settings.workers = [];
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)).rejects.toThrow("this deployment has no worker to hand this to");
        expect(store.rows("SELECT 1 FROM tasks")).toHaveLength(1);
        expect(worker.started).toHaveLength(1);
        expect(slots.acquired).toHaveLength(1);
        // The earlier one is stopped as it was started.
        await tasks.cancel(SESSION_KEY, before.task_id);
        expect(worker.cancelled).toEqual([before.task_id]);
        expect(kept(before.task_id)).toMatchObject({ status: "cancelled" });
      });
    });

    it("carries a task through that was written before its worker was taken out of the deployment: one task, started once more under the same id", async () => {
      await within(async ({ tasks, task, kept, settings, worker }) => {
        // Written, slot perhaps taken, the worker perhaps already at it: only the Brain's "running" is missing.
        task("t_before", { status: "dispatching" });
        settings.workers = [];
        const result = (await tasks.dispatch(RUN, SESSION_KEY, "op_t_before", "t", "b", null)) as { task_id: string; status: string };
        expect(result).toEqual({ task_id: "t_before", status: "running" });
        expect(worker.started).toMatchObject([{ id: "t_before" }]);
        expect(kept("t_before")).toMatchObject({ status: "running" });
      });
    });

    it("fails the task with the worker's own reason when the sandbox did not start", async () => {
      for (const phase of ["failed", "lost"]) {
        await within(async ({ tasks, store, kept, slots, worker }) => {
          worker.start = async () => ({ phase, error: "image missing" });
          await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)).rejects.toThrow("the sandbox did not start: image missing");
          const id = store.rows<{ id: string }>("SELECT id FROM tasks")[0].id;
          expect(JSON.parse(kept(id).result)).toEqual({ error: "image missing" });
          expect(slots.released).toEqual([id]);
        });
      }
    });

    it("does not move a task back to running when the worker reported while it was starting", async () => {
      await within(async ({ tasks, store, kept, worker }) => {
        worker.start = async (input) => {
          store.sql.exec("UPDATE tasks SET status = 'succeeded' WHERE id = ?", (input as { id: string }).id);
          return { phase: "running" };
        };
        const result = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "t", "b", null)) as { task_id: string };
        expect(kept(result.task_id).status).toBe("succeeded");
      });
    });
  });

  describe("saying how a task stands", () => {
    it("gives what is kept of it, with its question and result as data and its times as dates", async () => {
      await within(async ({ tasks, task, store }) => {
        task("t1", { status: "needs_input", pending: { id: "q1", code: "ABCD" } });
        store.sql.exec("UPDATE tasks SET result = ?, last_progress = 'half way' WHERE id = 't1'", JSON.stringify({ text: "done" }));
        expect(await tasks.status("t1")).toEqual({ id: "t1", title: "Title of t1", status: "needs_input", pending: { id: "q1", code: "ABCD" }, last_progress: "half way", result: { text: "done" }, created_at: "1970-01-01T00:00:01.000Z", updated_at: "1970-01-01T00:00:01.000Z" });
        task("t2");
        expect(await tasks.status("t2")).toMatchObject({ pending: null, result: null });
        await expect(tasks.status("nope")).rejects.toThrow("no task nope in this conversation's scope");
      });
    });
  });

  describe("cancelling", () => {
    it("stops the worker, ends the task and its watchdog, and frees the slot", async () => {
      await within(async ({ tasks, task, kept, worker, slots, timer, audited }) => {
        task("t1");
        expect(await tasks.cancel(SESSION_KEY, "t1")).toEqual({ ok: true, task_id: "t1", status: "cancelled" });
        expect(kept("t1").status).toBe("cancelled");
        expect(worker.cancelled).toEqual(["t1"]);
        expect(slots.released).toEqual(["t1"]);
        expect(timer("t1").status).toBe("done");
        expect(audited("task.cancelled")).toEqual([{ actor: "(agent)", task_id: "t1" }]);
      });
    });

    it("is refused from another conversation, and does nothing to a task that has already ended", async () => {
      await within(async ({ tasks, task, kept, worker }) => {
        task("t1");
        task("t2", { status: "succeeded" });
        await expect(tasks.cancel("elsewhere", "t1")).rejects.toThrow("that task belongs to a different conversation and has to be cancelled there");
        await expect(tasks.cancel(SESSION_KEY, "nope")).rejects.toThrow("no task nope in this conversation's scope");
        expect(await tasks.cancel(SESSION_KEY, "t2")).toEqual({ ok: true, task_id: "t2", status: "succeeded" });
        expect(worker.cancelled).toEqual([]);
        expect(kept("t1").status).toBe("running");
      });
    });

    it("closes a question nobody answered as withdrawn, and asks the worker about one whose answer was sent", async () => {
      await within(async ({ tasks, task, asks, closed, store }) => {
        task("t1");
        const open = await asks("t1", 1);
        await tasks.cancel(SESSION_KEY, "t1");
        expect(closed(open.ask)).toEqual({ state: "withdrawn" });
        expect(store.rows("SELECT 1 FROM unsettled")).toEqual([]);
      });
      await within(async ({ tasks, task, asks, closed, store }) => {
        task("t1");
        const open = await asks("t1", 1);
        store.sql.exec("UPDATE tasks SET answering = ? WHERE id = 't1'", JSON.stringify({ pending_id: open.id }));
        const before = Date.now();
        await tasks.cancel(SESSION_KEY, "t1");
        expect(closed(open.ask)).toBeNull();
        const [left] = store.rows<Record<string, any>>("SELECT * FROM unsettled");
        expect(left).toMatchObject({ ask: open.ask, task_id: "t1", question_id: open.id, attempts: 0 });
        expect(left.next_at).toBeGreaterThanOrEqual(before);
      });
    });
  });

  describe("a worker's reports", () => {
    it("are not taken for a task nobody knows", async () => {
      await within(async ({ tasks, woken }) => {
        expect(await tasks.event("nope", 1, "result", {})).toEqual({ ok: false });
        expect(woken).toEqual([]);
      });
    });

    it("of progress only update the record: no event, no wake-up", async () => {
      await within(async ({ tasks, task, kept, events, woken }) => {
        task("t1");
        task("t2", { status: "succeeded" });
        expect(await tasks.event("t1", 1, "progress", { message: "x".repeat(600) })).toEqual({ ok: true });
        expect(kept("t1").last_progress).toBe("x".repeat(500));
        await tasks.event("t1", 2, "progress", { text: "by text" });
        expect(kept("t1").last_progress).toBe("by text");
        await tasks.event("t2", 1, "progress", { message: "late" });
        expect(kept("t2").last_progress).toBeNull();
        await tasks.event("t1", 3, "recovered", {});
        await tasks.event("t1", 4, "something-new" as never, {});
        expect(events()).toEqual([]);
        expect(woken).toEqual([]);
        expect(kept("t1").status).toBe("running");
      });
    });

    it("that it finished end the task, become one event in its conversation, wake the Brain and free the slot", async () => {
      await within(async ({ tasks, task, kept, events, woken, slots, timer, spent }) => {
        task("t1");
        const before = Date.now();
        expect(await tasks.event("t1", 7, "result", { text: "all green", usage: { total_tokens: 1234 } })).toEqual({ ok: true });
        expect(kept("t1").status).toBe("succeeded");
        expect(JSON.parse(kept("t1").result)).toEqual({ text: "all green", usage: { total_tokens: 1234 } });
        expect(timer("t1").status).toBe("done");
        const [event] = events();
        expect(event).toMatchObject({ source: "worker", source_id: "t1:7", kind: "worker.result", session_key: SESSION_KEY, text: 'Task t1 "Title of t1" finished. The worker\'s own summary (unverified): all green' });
        expect(JSON.parse(event.principal)).toEqual({ kind: "worker", id: "t1", explicit: false });
        expect(JSON.parse(event.data)).toMatchObject({ task_id: "t1", text: "all green" });
        expect(woken).toHaveLength(1);
        expect(woken[0]).toBeGreaterThanOrEqual(before + 300);
        expect(slots.released).toEqual(["t1"]);
        // What the worker spent counts here and against the tenant.
        expect(spent).toEqual([1234]);
        expect(slots.usage).toEqual([["acme", 1234]]);
      });
    });

    it("count what a worker says it spent at most up to a bound, and nothing when it says nothing sensible", async () => {
      await within(async ({ tasks, task, spent, slots }) => {
        task("t1");
        task("t2");
        task("t3");
        await tasks.event("t1", 1, "result", { usage: { total_tokens: 9e9 } });
        await tasks.event("t2", 1, "result", { usage: { total_tokens: "many" } });
        await tasks.event("t3", 1, "result", { usage: { total_tokens: -5 } });
        expect(spent).toEqual([50_000_000]);
        // The registry bounds what it is told by itself; nothing is sent for nothing spent.
        expect(slots.usage).toEqual([["acme", 9e9]]);
      });
    });

    it("that it failed or was lost end the task as that, and are logged", async () => {
      await within(async ({ tasks, task, kept, events }) => {
        const lines: string[] = [];
        vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
        task("t1");
        task("t2");
        await tasks.event("t1", 1, "failed", { error: "tests failed" });
        await tasks.event("t2", 1, "lost", {});
        expect([kept("t1").status, kept("t2").status]).toEqual(["failed", "lost"]);
        expect(events().map((each) => each.text)).toEqual(['Task t1 "Title of t1" failed: tests failed', 'Task t2 "Title of t2" was lost: its sandbox stopped and could not be restored.']);
        expect(lines.map((line) => JSON.parse(line).event)).toEqual(["task_failed", "task_lost"]);
      });
    });

    it("are taken once: a repeat changes nothing, but does again what may not have happened after the first", async () => {
      await within(async ({ tasks, task, store, events, woken, slots }) => {
        task("t1");
        await tasks.event("t1", 1, "result", { text: "done" });
        expect(await tasks.event("t1", 1, "result", { text: "done differently" })).toEqual({ ok: true });
        expect(store.rows("SELECT 1 FROM task_events")).toHaveLength(1);
        expect(events()).toHaveLength(1);
        expect(woken).toHaveLength(2);
        expect(slots.released).toEqual(["t1", "t1"]);
      });
    });

    it("cannot bring back a task that has ended", async () => {
      await within(async ({ tasks, task, kept, events, woken, slots }) => {
        task("t1", { status: "cancelled" });
        await tasks.event("t1", 1, "result", { text: "done after all" });
        await tasks.event("t1", 2, "failed", { error: "x" });
        expect(kept("t1")).toMatchObject({ status: "cancelled", result: null });
        expect(events()).toEqual([]);
        expect(woken).toEqual([]);
        expect(slots.released).toEqual([]);
      });
    });

    it("that it needs approval put the question to the people here in the system's own words, under a code of its own", async () => {
      await within(async ({ tasks, task, kept, pendingOf, question, events, woken, slots, store }) => {
        task("t1");
        const before = Date.now();
        expect(await tasks.event("t1", 3, "needs_input", { id: "q1", command: "rm -rf build" })).toEqual({ ok: true });
        const pending = pendingOf("t1");
        expect(kept("t1").status).toBe("needs_input");
        expect(pending).toMatchObject({ id: "q1", command: "rm -rf build", ask: "ask:t1:3", delivered: true, what: "run this command:\nrm -rf build" });
        expect(pending.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
        expect(pending.asked_at).toBeGreaterThanOrEqual(before);
        expect(store.rows<{ code: string }>("SELECT code FROM used_codes").map((each) => each.code)).toEqual([pending.code]);
        const asked = question("ask:t1:3");
        expect(asked).toMatchObject({ run_id: null, target: TARGET, status: "pending" });
        expect(asked.text).toBe(`Task "Title of t1" is paused and needs approval to run this command:\nrm -rf build\n\nTo approve, reply: approve ${pending.code}\nTo refuse, reply: deny ${pending.code}`);
        expect(JSON.parse(asked.ask)).toEqual({ id: "ask:t1:3", code: pending.code, title: "Title of t1", kind: "command", detail: "rm -rf build", can_approve: true });
        const [event] = events();
        expect(event).toMatchObject({ kind: "worker.needs_input", source_id: "t1:3" });
        expect(event.text).toBe(`Task t1 "Title of t1" is paused and needs approval to run this command:\nrm -rf build The people here have already been asked by the system, with the code ${pending.code}. Do not ask again. When one of them replies, pass their decision on with answer_task.`);
        expect(woken).toHaveLength(1);
        // The task goes on: its slot is kept.
        expect(slots.released).toEqual([]);
      });
    });

    it("describe a push by what it does to which branches, and offer approval for the rest of the task only for branch updates", async () => {
      await within(async ({ tasks, task, question }) => {
        task("t1");
        await tasks.event("t1", 1, "needs_input", { id: "q1", source: "proxy", summary: "push to acme/app: move branch main", resource: "acme/app", action: "push", refs: BRANCH });
        expect(JSON.parse(question("ask:t1:1").ask)).toMatchObject({ kind: "push", detail: "push to acme/app: move branch main", resource: "acme/app", refs: BRANCH, standing_offered: true, can_approve: true });
        expect(question("ask:t1:1").text).toContain("needs approval to push to acme/app: move branch main.\n\n");
        await tasks.event("t1", 2, "needs_input", { id: "q2", source: "proxy", action: "push", resource: "acme/app", refs: [{ ref: "refs/heads/old", old: "a".repeat(40), new: ZERO }] });
        expect(JSON.parse(question("ask:t1:2").ask)).toMatchObject({ detail: "push on acme/app", standing_offered: false });
      });
    });

    it("show a question too long to show in full as one that can only be refused", async () => {
      await within(async ({ tasks, task, question, pendingOf }) => {
        task("t1");
        await tasks.event("t1", 1, "needs_input", { id: "q1", command: "long…", truncated: true });
        const code = pendingOf("t1").code;
        expect(JSON.parse(question("ask:t1:1").ask)).toMatchObject({ can_approve: false });
        expect(question("ask:t1:1").text).toContain(`This is too long to show in full, so it cannot be approved.\nTo refuse, reply: deny ${code}`);
        expect(question("ask:t1:1").text).not.toContain("To approve");
      });
    });

    it("say so when the question could reach nobody", async () => {
      await within(async ({ tasks, task, pendingOf, events, store }) => {
        task("t1", { session_key: "ci" });
        await tasks.event("t1", 1, "needs_input", { id: "q1", command: "x" });
        expect(pendingOf("t1")).toMatchObject({ delivered: false });
        expect(pendingOf("t1").ask).toBeUndefined();
        expect(events()[0].text).toContain("The question could not be delivered to anyone here.");
        expect(store.rows("SELECT 1 FROM outbox")).toEqual([]);
      });
    });

    it("ask nothing for a task that has already ended: no code is drawn and no question queued", async () => {
      await within(async ({ tasks, task, store, events, woken }) => {
        task("t1", { status: "failed" });
        expect(await tasks.event("t1", 1, "needs_input", { id: "q1", command: "x" })).toEqual({ ok: true });
        expect(store.rows("SELECT 1 FROM used_codes")).toEqual([]);
        expect(store.rows("SELECT 1 FROM outbox")).toEqual([]);
        expect(store.rows("SELECT 1 FROM task_events")).toHaveLength(1);
        expect(events()).toEqual([]);
        expect(woken).toEqual([]);
      });
    });

    it("never give a code twice in a scope", async () => {
      await within(async ({ tasks, task, pendingOf, store }) => {
        // Every code but one has been used.
        const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        vi.spyOn(crypto, "getRandomValues").mockImplementationOnce(((bytes: Uint8Array) => bytes.fill(0)) as never);
        store.sql.exec("INSERT INTO used_codes (code, used_at) VALUES ('AAAA', 0)");
        task("t1");
        await tasks.event("t1", 1, "needs_input", { id: "q1", command: "x" });
        expect(pendingOf("t1").code).not.toBe("AAAA");
        expect(pendingOf("t1").code).toHaveLength(4);
        void alphabet;
      });
    });

    it("replace an earlier question by a newer one, closing the earlier as withdrawn", async () => {
      await within(async ({ tasks, task, asks, closed, pendingOf }) => {
        task("t1");
        const first = await asks("t1", 1);
        await tasks.event("t1", 2, "needs_input", { id: "q2", command: "y" });
        expect(closed(first.ask)).toEqual({ state: "withdrawn" });
        expect(pendingOf("t1")).toMatchObject({ id: "q2", ask: "ask:t1:2" });
        expect(closed("ask:t1:2")).toBeNull();
      });
    });

    it("that a held request gave up put the task back to running and close its question, and no other", async () => {
      await within(async ({ tasks, task, asks, closed, kept, events }) => {
        task("t1");
        const open = await asks("t1", 1);
        await tasks.event("t1", 2, "withdrawn", { id: "another" });
        expect(kept("t1").status).toBe("needs_input");
        expect(closed(open.ask)).toBeNull();
        await tasks.event("t1", 3, "withdrawn", { id: open.id });
        expect(kept("t1")).toMatchObject({ status: "running", pending: null });
        expect(closed(open.ask)).toEqual({ state: "withdrawn" });
        expect(events()).toHaveLength(1);
      });
    });

    it("that the task ended close a question still open, so nobody answers into nothing", async () => {
      await within(async ({ tasks, task, asks, closed }) => {
        task("t1");
        const open = await asks("t1", 1);
        await tasks.event("t1", 2, "result", { text: "done" });
        expect(closed(open.ask)).toEqual({ state: "withdrawn" });
      });
    });
  });

  describe("a question's ending", () => {
    it("is recorded once and shown where the question was put, if it was delivered with a receipt", async () => {
      await within(async ({ tasks, task, asks, closed, amended, background, question }) => {
        task("t1");
        const receipt = { subject: "feishu:message:om_q", holder: "bot" };
        const open = await asks("t1", 1, undefined, receipt);
        await tasks.event("t1", 2, "withdrawn", { id: open.id });
        await Promise.all(background);
        expect(amended).toEqual([[JSON.parse(TARGET), receipt, JSON.parse(question(open.ask).ask), { state: "withdrawn" }]]);
        // Shown again on request (a delivery that landed after it closed): the same ending.
        tasks.showClosed(open.ask);
        await Promise.all(background);
        expect(amended).toHaveLength(2);
        expect(closed(open.ask)).toEqual({ state: "withdrawn" });
      });
    });

    it("is not shown for a question that never reached anyone, or one still open", async () => {
      await within(async ({ tasks, task, asks, amended }) => {
        task("t1");
        const open = await asks("t1", 1, undefined, { subject: "s", holder: "h" });
        tasks.showClosed(open.ask);
        tasks.showClosed("ask:unknown");
        expect(amended).toEqual([]);
        task("t2");
        const unsent = await asks("t2", 1);
        await tasks.event("t2", 2, "withdrawn", { id: unsent.id });
        expect(amended).toEqual([]);
      });
    });

    it("stays recorded when showing it fails: that is logged and holds nothing up", async () => {
      await within(async ({ tasks, task, asks, closed, host, background }) => {
        const lines: string[] = [];
        vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
        host.amend = async () => {
          throw new Error("card gone");
        };
        task("t1");
        const open = await asks("t1", 1, undefined, { subject: "s", holder: "h" });
        await tasks.event("t1", 2, "withdrawn", { id: open.id });
        await Promise.all(background);
        expect(closed(open.ask)).toEqual({ state: "withdrawn" });
        expect(lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: "question_not_closed", ask: open.ask, error: "Error: card gone" }));
      });
    });
  });

  describe("finding out how a set-aside question ended", () => {
    /** A question whose answer was sent, on a task then cancelled: its ending is the worker's to say. */
    const setAside = async ({ tasks, task, asks, store }: ReturnType<typeof bench>, id = "t1") => {
      task(id);
      const open = await asks(id, 1);
      store.sql.exec("UPDATE tasks SET answering = ? WHERE id = ?", JSON.stringify({ pending_id: open.id }), id);
      await tasks.cancel(SESSION_KEY, id);
      return open;
    };

    it("closes it as what the worker holds: approved, with its reach, or refused", async () => {
      await within(async (b) => {
        const open = await setAside(b);
        b.worker.fate[open.id] = { state: "decided", decision: "allow", standing: true };
        await b.tasks.settle();
        expect(b.closed(open.ask)).toEqual({ state: "approved", standing: true });
        expect(b.store.rows("SELECT 1 FROM unsettled")).toEqual([]);
      });
      await within(async (b) => {
        const open = await setAside(b);
        b.worker.fate[open.id] = { state: "decided", decision: "allow" };
        await b.tasks.settle();
        expect(b.closed(open.ask)).toEqual({ state: "approved" });
      });
      await within(async (b) => {
        const open = await setAside(b);
        b.worker.fate[open.id] = { state: "decided", decision: "deny", standing: true };
        await b.tasks.settle();
        expect(b.closed(open.ask)).toEqual({ state: "refused", standing: false });
      });
    });

    it("closes it as withdrawn when the worker's records are whole and hold no answer", async () => {
      await within(async (b) => {
        const open = await setAside(b);
        b.worker.fate[open.id] = { state: "undecided" };
        await b.tasks.settle();
        expect(b.closed(open.ask)).toEqual({ state: "withdrawn" });
      });
    });

    it("closes it as unknown, on the record, when the worker cannot say any more", async () => {
      await within(async (b) => {
        const open = await setAside(b);
        b.worker.fate[open.id] = { state: "unknown" };
        await b.tasks.settle();
        expect(b.closed(open.ask)).toEqual({ state: "unknown" });
        expect(b.audited("task.answer_unverified")).toEqual([{ actor: "(system)", task_id: "t1", question: open.id, why: "unknown" }]);
      });
    });

    it("asks again later, each time after a longer wait, while the worker still has it open or cannot be reached", async () => {
      await within(async (b) => {
        const open = await setAside(b);
        b.worker.fate[open.id] = { state: "pending" };
        const before = Date.now();
        await b.tasks.settle();
        const left = () => b.store.rows<Record<string, any>>("SELECT * FROM unsettled")[0];
        expect(left()).toMatchObject({ attempts: 1 });
        expect(left().next_at).toBeGreaterThanOrEqual(before + 30_000);
        expect(left().next_at).toBeLessThan(before + 60_000);
        // Not due yet: not asked.
        b.worker.fate[open.id] = { state: "undecided" };
        await b.tasks.settle();
        expect(b.closed(open.ask)).toBeNull();
        b.worker.fate[open.id] = new Error("sandbox asleep");
        b.store.sql.exec("UPDATE unsettled SET next_at = 0");
        await b.tasks.settle();
        expect(left().attempts).toBe(2);
        expect(left().next_at).toBeGreaterThanOrEqual(before + 60_000);
        // The wait stops growing at an hour.
        b.store.sql.exec("UPDATE unsettled SET next_at = 0, attempts = 10");
        await b.tasks.settle();
        expect(left().next_at).toBeLessThanOrEqual(Date.now() + 3_600_000);
        expect(left().next_at).toBeGreaterThanOrEqual(before + 3_600_000);
      });
    });

    it("gives up after twelve tries and closes it as unknown, never as a guess", async () => {
      await within(async (b) => {
        const open = await setAside(b);
        b.worker.fate[open.id] = new Error("sandbox gone");
        b.store.sql.exec("UPDATE unsettled SET attempts = 10");
        await b.tasks.settle();
        expect(b.closed(open.ask)).toBeNull();
        b.store.sql.exec("UPDATE unsettled SET next_at = 0");
        await b.tasks.settle();
        expect(b.closed(open.ask)).toEqual({ state: "unknown" });
        expect(b.audited("task.answer_unverified")).toMatchObject([{ why: "unreachable" }]);
      });
    });

    it("says when it next has something to do: when the earliest of them is to be asked about again", async () => {
      await within((b) => {
        expect(b.tasks.nextWakeAt(0)).toBeNull();
        b.store.sql.exec("INSERT INTO unsettled (ask, task_id, question_id, next_at) VALUES ('a', 't', 'q', 9000), ('b', 't', 'q', 4000)");
        expect(b.tasks.nextWakeAt(0)).toBe(4_000);
      });
    });
  });

  it("knows whether a text quotes the code of a question open in a conversation", async () => {
    await within(async ({ tasks, task }) => {
      task("t1", { status: "needs_input", pending: { id: "q1", code: "ABCD" } });
      task("t2", { status: "running", pending: { id: "q2", code: "WXYZ" } });
      task("t3", { status: "needs_input", pending: { id: "q3", code: "QRST" }, session_key: "elsewhere" });
      expect(await tasks.quotesOpenQuestion("please approve abcd, thanks", SESSION_KEY)).toBe(true);
      expect(await tasks.quotesOpenQuestion("xABCDx", SESSION_KEY)).toBe(false);
      expect(await tasks.quotesOpenQuestion("approve WXYZ", SESSION_KEY)).toBe(false);
      expect(await tasks.quotesOpenQuestion("approve QRST", SESSION_KEY)).toBe(false);
      expect(await tasks.quotesOpenQuestion("approve QRST", "elsewhere")).toBe(true);
    });
  });

  describe("passing a person's decision on", () => {
    it("approves when the one who asked for the task says so by the code, after the question reached them", async () => {
      await within(async ({ task, asks, reply, answer, worker, kept, closed, audited }) => {
        task("t1");
        const open = await asks("t1", 1);
        const said = reply(`approve ${open.code}`);
        expect(await answer("t1", "allow")).toEqual({ ok: true, task_id: "t1", decision: "allow", decided_by: "alice" });
        expect(worker.answered).toEqual([["allow", "because", open.id, false]]);
        expect(kept("t1")).toMatchObject({ status: "running", pending: null });
        expect(JSON.parse(kept("t1").answering)).toEqual({ call_id: "call_1", pending_id: open.id, decision: "allow", reason: "because", decided_by: "alice", deciding_event: said, ask: open.ask });
        expect(closed(open.ask)).toEqual({ state: "approved" });
        expect(audited("task.approved")).toMatchObject([{ actor: "alice", task_id: "t1", reason: "because", deciding_event: said, question: { id: open.id, code: open.code } }]);
      });
    });

    it("is refused for a task nobody knows, one of another conversation, or one not waiting", async () => {
      await within(async ({ task, answer, worker }) => {
        task("t1");
        task("t2", { session_key: "elsewhere" });
        await expect(answer("nope", "allow")).rejects.toThrow("no task nope in this conversation's scope");
        await expect(answer("t2", "allow")).rejects.toThrow("that task belongs to a different conversation and has to be answered there");
        await expect(answer("t1", "deny")).rejects.toThrow("task t1 is running; it is not waiting for an answer");
        expect(worker.answered).toEqual([]);
      });
    });

    it("waits for the question to have gone out, and for somebody to have answered after it did", async () => {
      await within(async ({ tasks, task, shown, reply, answer, pendingOf }) => {
        task("t1");
        await tasks.event("t1", 1, "needs_input", { id: "q1", command: "x" });
        const open = pendingOf("t1");
        reply(`approve ${open.code}`, { received_at: 4_000 });
        await expect(answer("t1", "allow")).rejects.toThrow("the question has not been delivered to anyone in this conversation yet, so it cannot be answered");
        shown(open.ask, { sent_at: 5_000 });
        // What was said before the question went out does not answer it.
        await expect(answer("t1", "allow")).rejects.toThrow("nobody here has answered the question yet; wait for a reply");
        // Nor does someone who was not addressing the agent.
        reply(`approve ${open.code}`, { explicit: false });
        await expect(answer("t1", "allow")).rejects.toThrow("nobody here has answered the question yet; wait for a reply");
      });
      await within(async ({ task, reply, answer }) => {
        task("t1", { status: "needs_input", pending: { id: "q1", code: "ABCD" } });
        reply("approve ABCD");
        await expect(answer("t1", "allow")).rejects.toThrow("the question has not been delivered to anyone in this conversation yet");
      });
    });

    it("takes as an approval only a message that says just that, by the code, or a plain yes tied to the question itself", async () => {
      await within(async ({ task, asks, reply, answer, worker }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply("looks fine to me");
        reply(`approve ${open.code} if the tests pass`);
        await expect(answer("t1", "allow")).rejects.toThrow(`no reply so far is an approval. An approval is a message whose only words are "approve ${open.code}"`);
        // About another question: not about this one, whatever it says.
        reply("可以", { question: "ask:other:1" });
        await expect(answer("t1", "allow")).rejects.toThrow("no reply so far is an approval");
        reply("可以", { question: open.ask });
        await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow", decided_by: "alice" });
        expect(worker.answered).toHaveLength(1);
      });
    });

    it("passes on a refusal from any member, which has to be said too", async () => {
      await within(async ({ task, asks, reply, answer, worker, closed, audited, kept }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply("hmm", { person: "bob" });
        await expect(answer("t1", "deny")).rejects.toThrow(`no reply so far refuses this. A refusal is a message that says "deny ${open.code}"`);
        const said = reply(`deny ${open.code}`, { person: "bob" });
        expect(await answer("t1", "deny")).toEqual({ ok: true, task_id: "t1", decision: "deny", decided_by: "bob" });
        expect(worker.answered).toEqual([["deny", "because", open.id, false]]);
        expect(closed(open.ask)).toEqual({ state: "refused", standing: false });
        expect(audited("task.denied")).toMatchObject([{ actor: "bob", deciding_event: said }]);
        expect(kept("t1").status).toBe("running");
      });
    });

    it("lets a refusal from any member win over an approval, whichever came first and whether or not a run has seen it", async () => {
      await within(async ({ task, asks, reply, answer }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`deny ${open.code}`, { person: "bob" });
        reply(`approve ${open.code}`);
        await expect(answer("t1", "allow")).rejects.toThrow("a reply refuses this; pass on a denial, not an approval");
      });
      await within(async ({ task, asks, reply, answer }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        reply(`wait, not ${open.code} yet`, { person: "bob", status: "pending" });
        await expect(answer("t1", "allow")).rejects.toThrow("a reply refuses this; pass on a denial, not an approval");
      });
    });

    it("outside a private conversation lets only the person who asked for the task approve, and nobody when no person did", async () => {
      await within(async ({ task, asks, reply, answer }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`, { person: "bob" });
        await expect(answer("t1", "allow")).rejects.toThrow("only alice, who requested this task, can approve it");
      });
      await within(async ({ task, asks, reply, answer }) => {
        task("t1", { requested_by: null });
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        await expect(answer("t1", "allow")).rejects.toThrow("this task was not started by a person, so nobody can approve this; it can only be refused");
        reply(`deny ${open.code}`);
        await expect(answer("t1", "deny")).resolves.toMatchObject({ decision: "deny" });
      });
      // In a person's own conversation their word is enough, whoever the task is credited to.
      await within(async ({ task, asks, reply, answer }) => {
        task("t1", { requested_by: null });
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow", decided_by: "alice" });
      }, "user:ou_tasks");
    });

    it("needs the approval to be that person's last word, seen by a run or not", async () => {
      await within(async ({ task, asks, reply, answer }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        reply("actually let me check something");
        await expect(answer("t1", "allow")).rejects.toThrow(`alice said something after approving; ask them to confirm by sending just "approve ${open.code}" again`);
        reply(`approve ${open.code}`);
        await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow" });
      });
      await within(async ({ task, asks, reply, answer }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        reply("one more thing", { status: "pending" });
        await expect(answer("t1", "allow")).rejects.toThrow("alice said something after approving");
      });
    });

    it("lets one message approve one question", async () => {
      await within(async ({ task, asks, reply, answer }) => {
        task("t1");
        const open = await asks("t1", 1);
        const said = reply(`approve ${open.code}`);
        task("t2", { answering: { deciding_event: said } });
        await expect(answer("t1", "allow")).rejects.toThrow("that reply was already used to approve another question");
      });
    });

    it("cannot approve what was too long to show in full, only refuse it", async () => {
      await within(async ({ task, asks, reply, answer }) => {
        task("t1");
        const open = await asks("t1", 1, { id: "q1", command: "long…", truncated: true });
        reply(`approve ${open.code}`);
        await expect(answer("t1", "allow")).rejects.toThrow("the action is too long to be shown in full, so it cannot be approved; it can only be refused");
        reply(`deny ${open.code}`);
        await expect(answer("t1", "deny")).resolves.toMatchObject({ decision: "deny" });
      });
    });

    it("does not approve on a reply that was edited while its new text has not arrived", async () => {
      await within(async ({ task, asks, reply, answer, settings }) => {
        settings.revisable.add("feishu");
        task("t1");
        const open = await asks("t1", 1, undefined, { subject: "q:posted", holder: "as written" });
        settings.now["q:posted"] = { revision: 1, holder: "as written", deleted: false, edited: false };
        reply(`approve ${open.code}`, { subject: "c1", revision: 20_000 });
        reply("an earlier remark", { person: "bob", subject: "c2", revision: 19_000 });
        settings.now.c1 = { revision: 20_000, holder: "h1", deleted: false, edited: false };
        settings.now.c2 = { revision: 21_000, holder: "h2", deleted: false, edited: true };
        await expect(answer("t1", "allow")).rejects.toThrow("a reply here was edited and its new text has not arrived yet; call this tool again when it has");
      });
    });

    describe("where the question itself could have been changed", () => {
      const RECEIPT = { subject: "q:posted", holder: "as written" };

      it("approves once the question is confirmed to say what the agent wrote", async () => {
        await within(async ({ task, asks, reply, answer, settings }) => {
          settings.revisable.add("feishu");
          settings.now[RECEIPT.subject] = { revision: 1, holder: "as written", deleted: false, edited: false };
          task("t1");
          const open = await asks("t1", 1, undefined, RECEIPT);
          reply(`approve ${open.code}`);
          await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow" });
        });
      });

      it("refuses to approve when it was edited, deleted, reworded, or ever touched", async () => {
        const changes: Standing[] = [
          { revision: 2, holder: "as written", deleted: false, edited: true },
          { revision: 1, holder: "as written", deleted: true, edited: false },
          { revision: 1, holder: "something else", deleted: false, edited: false },
        ];
        for (const now of changes) {
          await within(async ({ task, asks, reply, answer, settings, worker }) => {
            settings.revisable.add("feishu");
            settings.now[RECEIPT.subject] = now;
            task("t1");
            const open = await asks("t1", 1, undefined, RECEIPT);
            reply(`approve ${open.code}`);
            await expect(answer("t1", "allow")).rejects.toThrow("the question as it was posted has since been changed or removed, so nobody can be taken to have approved this action; it can only be refused");
            expect(worker.answered).toEqual([]);
            // It can still be refused.
            reply(`deny ${open.code}`);
            await expect(answer("t1", "deny")).resolves.toMatchObject({ decision: "deny" });
          });
        }
        await within(async ({ task, asks, reply, answer, settings, revisions }) => {
          settings.revisable.add("feishu");
          settings.now[RECEIPT.subject] = { revision: 1, holder: "as written", deleted: false, edited: false };
          task("t1");
          const open = await asks("t1", 1, undefined, RECEIPT);
          // Edited once and put back: someone may have read the other wording.
          revisions.revise(RECEIPT.subject, 1, false, "as written");
          reply(`approve ${open.code}`);
          await expect(answer("t1", "allow")).rejects.toThrow("the question as it was posted has since been changed or removed");
        });
      });

      it("refuses to approve when the question cannot be found, or cannot be identified, where it was shown", async () => {
        await within(async ({ task, asks, reply, answer, settings }) => {
          settings.revisable.add("feishu");
          task("t1");
          const open = await asks("t1", 1, undefined, RECEIPT);
          reply(`approve ${open.code}`);
          await expect(answer("t1", "allow")).rejects.toThrow("the question as it was posted cannot be found where it was shown, so nobody can be taken to have approved this action; it can only be refused");
        });
        await within(async ({ task, asks, reply, answer, settings }) => {
          settings.revisable.add("feishu");
          task("t1");
          const open = await asks("t1", 1);
          reply(`approve ${open.code}`);
          await expect(answer("t1", "allow")).rejects.toThrow("the question was posted where it can be changed and cannot be identified there, so nobody can be taken to have approved this action; it can only be refused");
        });
      });

      it("has nothing to check where nobody else can change the agent's messages", async () => {
        await within(async ({ task, asks, reply, answer }) => {
          task("t1");
          const open = await asks("t1", 1, undefined, RECEIPT);
          reply(`approve ${open.code}`);
          await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow" });
        });
      });
    });

    it("carries 'for the rest of this task' only when the approver said so, for a push that only updates branches", async () => {
      const push = { id: "q1", source: "proxy", summary: "push", resource: "acme/app", action: "push", refs: BRANCH };
      await within(async ({ task, asks, reply, answer, worker, kept, closed, audited }) => {
        worker.answer = async (decision, _reason, _id, standing) => ({ ok: true, decision, standing });
        task("t1");
        const open = await asks("t1", 1, push);
        reply(`approve all ${open.code}`);
        expect(await answer("t1", "allow")).toEqual({ ok: true, task_id: "t1", decision: "allow", decided_by: "alice", standing: "later pushes of the same branches in this task will not ask again" });
        expect(worker.answered[0][3]).toBe(true);
        expect(JSON.parse(kept("t1").answering).standing).toBe(true);
        expect(closed(open.ask)).toEqual({ state: "approved", standing: true });
        expect(audited("task.approved")[0].standing).toBe(true);
      });
      // Not said: not carried.
      await within(async ({ task, asks, reply, answer, worker }) => {
        task("t1");
        const open = await asks("t1", 1, push);
        reply(`approve ${open.code}`);
        await answer("t1", "allow");
        expect(worker.answered[0][3]).toBe(false);
      });
      // Said, but of a command, or of a push that deletes: not carried.
      for (const body of [{ id: "q1", command: "x" }, { ...push, refs: [{ ref: "refs/heads/old", old: "a".repeat(40), new: ZERO }] }]) {
        await within(async ({ task, asks, reply, answer, worker }) => {
          task("t1");
          const open = await asks("t1", 1, body);
          reply(`approve all ${open.code}`);
          await answer("t1", "allow");
          expect(worker.answered[0][3]).toBe(false);
        });
      }
    });

    describe("when the answer's delivery to the worker was not confirmed", () => {
      it("fails the call with the worker's reason, and a replay delivers that same decision again without judging afresh", async () => {
        await within(async ({ task, asks, reply, answer, worker, kept, audited }) => {
          task("t1");
          const open = await asks("t1", 1);
          reply(`approve ${open.code}`);
          worker.answer = async () => ({ ok: false, error: "the worker is restarting" });
          await expect(answer("t1", "allow")).rejects.toThrow("the worker is restarting");
          expect(kept("t1").status).toBe("needs_input");
          expect(JSON.parse(kept("t1").answering)).toMatchObject({ call_id: "call_1", pending_id: open.id, decision: "allow" });
          worker.answer = async (decision) => ({ ok: true, decision });
          await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow", decided_by: "alice" });
          expect(worker.answered).toEqual([
            ["allow", "because", open.id, false],
            ["allow", "because", open.id, false],
          ]);
          expect(audited("task.approved")).toHaveLength(1);
        });
      });

      it("sends an approval on record again from another call too, as long as nothing since speaks against it", async () => {
        await within(async ({ task, asks, reply, answer, worker, audited }) => {
          task("t1");
          const open = await asks("t1", 1);
          reply(`approve ${open.code}`);
          worker.answer = async () => ({ ok: false, error: "busy" });
          await expect(answer("t1", "allow", "call_1")).rejects.toThrow("busy");
          worker.answer = async (decision) => ({ ok: true, decision });
          reply("unrelated chatter", { person: "bob" });
          await expect(answer("t1", "allow", "call_2")).resolves.toMatchObject({ decision: "allow", decided_by: "alice" });
          expect(audited("task.approved")).toHaveLength(1);
        });
      });

      it("judges afresh once the approver has said anything more, or anyone has spoken against it", async () => {
        await within(async ({ task, asks, reply, answer, worker }) => {
          task("t1");
          const open = await asks("t1", 1);
          reply(`approve ${open.code}`);
          worker.answer = async () => ({ ok: false, error: "busy" });
          await expect(answer("t1", "allow", "call_1")).rejects.toThrow("busy");
          reply("hold on");
          // The approval on record is dropped. Judged afresh, the same message cannot approve again,
          // and the refusal says why: not that it approved something else, but that it was set aside.
          await expect(answer("t1", "allow", "call_2")).rejects.toThrow(`alice's earlier approval of this was set aside because of what was said since; ask them to confirm by sending just "approve ${open.code}" again`);
          expect(worker.answered).toHaveLength(1);
        });
        await within(async ({ task, asks, reply, answer, worker }) => {
          task("t1");
          const open = await asks("t1", 1);
          reply(`approve ${open.code}`);
          worker.answer = async () => ({ ok: false, error: "busy" });
          await expect(answer("t1", "allow", "call_1")).rejects.toThrow("busy");
          reply(`deny ${open.code}`, { person: "bob", status: "pending" });
          await expect(answer("t1", "allow", "call_2")).rejects.toThrow("a reply refuses this; pass on a denial, not an approval");
        });
      });

      it("lets a refusal replace an approval on record, and says so when the worker had already acted on the approval", async () => {
        await within(async ({ task, asks, reply, answer, worker, kept, closed, audited }) => {
          task("t1");
          const open = await asks("t1", 1);
          reply(`approve ${open.code}`);
          worker.answer = async () => ({ ok: false, error: "busy" });
          await expect(answer("t1", "allow", "call_1")).rejects.toThrow("busy");
          reply(`deny ${open.code}`, { person: "bob" });
          // The worker did hear the approval, and holds it.
          worker.answer = async () => ({ ok: true, decision: "allow" });
          expect(await answer("t1", "deny", "call_2")).toEqual({ ok: true, task_id: "t1", decision: "allow", decided_by: "alice", note: `the worker had already been told to allow; bob's "deny" came too late to change that` });
          expect(JSON.parse(kept("t1").answering)).toMatchObject({ call_id: "call_2", decision: "deny", decided_by: "bob", before: { decision: "allow", decided_by: "alice" } });
          expect(closed(open.ask)).toEqual({ state: "approved" });
          expect(audited("task.answer_too_late")).toEqual([{ actor: "bob", task_id: "t1", question: open.id, wanted: "deny", in_force: "allow", in_force_by: "alice" }]);
        });
      });
    });

    it("does not deliver a decision on record for an earlier question to the one open now", async () => {
      await within(async ({ task, asks, reply, answer, worker }) => {
        task("t1", { answering: { call_id: "call_0", pending_id: "q0", decision: "deny", reason: "old", decided_by: "bob", deciding_event: 0 } });
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        await expect(answer("t1", "allow", "call_1")).resolves.toMatchObject({ decision: "allow", decided_by: "alice" });
        expect(worker.answered).toEqual([["allow", "because", open.id, false]]);
      });
    });

    it("does not send an approval on record again when a refusal is proposed: that is judged afresh, and needs a refusal to have been said", async () => {
      await within(async ({ task, asks, reply, answer, worker }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        worker.answer = async () => ({ ok: false, error: "busy" });
        await expect(answer("t1", "allow", "call_1")).rejects.toThrow("busy");
        worker.answer = async (decision) => ({ ok: true, decision });
        await expect(answer("t1", "deny", "call_2")).rejects.toThrow("no reply so far refuses this");
        expect(worker.answered).toHaveLength(1);
      });
    });

    it("records how a question ended once: a replay that finds the worker holding something else does not rewrite it", async () => {
      await within(async ({ task, asks, reply, answer, worker, closed }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        await answer("t1", "allow", "call_1");
        expect(closed(open.ask)).toEqual({ state: "approved" });
        worker.answer = async () => ({ ok: true, decision: "deny" });
        await answer("t1", "allow", "call_1");
        expect(closed(open.ask)).toEqual({ state: "approved" });
      });
    });

    it("does not send an approval on record again once its author has said more where they typed it, when it was moved here", async () => {
      await within(async ({ task, asks, reply, answer, worker }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`, { routed_from: "thread:1" });
        worker.answer = async () => ({ ok: false, error: "busy" });
        await expect(answer("t1", "allow", "call_1")).rejects.toThrow("busy");
        worker.answer = async (decision) => ({ ok: true, decision });
        // Said only in the conversation the approval was typed in.
        reply("wait", { session: "thread:1" });
        await expect(answer("t1", "allow", "call_2")).rejects.toThrow();
        expect(worker.answered).toHaveLength(1);
      });
    });

    it("takes the approval said last, by the source's time, however the two arrived", async () => {
      await within(async ({ task, asks, reply, answer, kept, settings }) => {
        settings.revisable.add("feishu");
        settings.now["q:posted"] = { revision: 1, holder: "as written", deleted: false, edited: false };
        settings.now.c1 = { revision: 30_000, holder: "h1", deleted: false, edited: false };
        settings.now.c2 = { revision: 20_000, holder: "h1", deleted: false, edited: false };
        task("t1");
        const open = await asks("t1", 1, undefined, { subject: "q:posted", holder: "as written" });
        // The newer one arrives first.
        const newer = reply(`approve ${open.code}`, { subject: "c1", revision: 30_000 });
        reply(`approve ${open.code}`, { subject: "c2", revision: 20_000 });
        await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow" });
        expect(JSON.parse(kept("t1").answering).deciding_event).toBe(newer);
      });
    });

    it("orders two approvals that arrived at the same moment, with no time from their source, as they were stored", async () => {
      await within(async ({ task, asks, reply, answer, kept }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`, { received_at: 12_000 });
        const second = reply(`approve ${open.code}`, { received_at: 12_000 });
        await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow" });
        expect(JSON.parse(kept("t1").answering).deciding_event).toBe(second);
      });
    });

    it("names nobody for a decision in force that is neither the one passed on nor one on record before it", async () => {
      await within(async ({ task, asks, reply, answer, worker, audited }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`deny ${open.code}`, { person: "bob" });
        worker.answer = async () => ({ ok: true, decision: "allow" });
        const result = (await answer("t1", "deny")) as Record<string, unknown>;
        expect(result).toMatchObject({ ok: true, task_id: "t1", decision: "allow" });
        expect(result).not.toHaveProperty("decided_by");
        expect(audited("task.answer_too_late")).toEqual([{ actor: "bob", task_id: "t1", question: open.id, wanted: "deny", in_force: "allow", in_force_by: null }]);
      });
    });

    it("does not name the author of an earlier approval as the author of a refusal the worker holds", async () => {
      await within(async ({ task, asks, reply, answer, worker, kept, audited }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        worker.answer = async () => ({ ok: false, error: "busy" });
        await expect(answer("t1", "allow", "call_1")).rejects.toThrow("busy");
        // A fresh approval for the same question; the worker turns out to hold a refusal.
        reply(`approve ${open.code}`);
        worker.answer = async () => ({ ok: true, decision: "deny" });
        const result = (await answer("t1", "allow", "call_2")) as Record<string, unknown>;
        expect(JSON.parse(kept("t1").answering).before).toEqual({ decision: "allow", decided_by: "alice" });
        expect(result).toMatchObject({ ok: true, decision: "deny" });
        expect(result).not.toHaveProperty("decided_by");
        expect(audited("task.answer_too_late")).toMatchObject([{ in_force: "deny", in_force_by: null }]);
      });
    });

    it("clears only the question it answered: a newer one that arrived meanwhile stays open", async () => {
      await within(async ({ tasks, task, asks, reply, answer, worker, kept, pendingOf, closed }) => {
        task("t1");
        const open = await asks("t1", 1);
        reply(`approve ${open.code}`);
        worker.answer = async (decision) => {
          await tasks.event("t1", 2, "needs_input", { id: "q2", command: "y" });
          return { ok: true, decision };
        };
        await expect(answer("t1", "allow")).resolves.toMatchObject({ decision: "allow" });
        expect(kept("t1").status).toBe("needs_input");
        expect(pendingOf("t1").id).toBe("q2");
        // The one answered is closed as answered; the new one is open.
        expect(closed(open.ask)).not.toBeNull();
        expect(closed("ask:t1:2")).toBeNull();
      });
    });
  });
});
