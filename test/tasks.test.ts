import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Standing } from "../src/connectors";
import type { Principal } from "../src/events";
import { Revisions } from "../src/brain/revisions";
import { BrainStore, type RunRow } from "../src/brain/store";
import { Tasks, type TasksHost } from "../src/brain/tasks";
import { sandboxWorker } from "../src/workers/sandbox/worker";
import type { Worker } from "../src/workers/types";

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
    /** Workers of another kind altogether that this deployment has, for showing that nothing here is the sandbox's own. */
    others: [] as Worker[],
    /** Workers taken out of the deployment altogether: neither offered nor retired. */
    gone: [] as string[],
  };
  /** The worker of every task: what it was told, and what it says back. */
  const worker = {
    started: [] as unknown[],
    cancelled: [] as string[],
    /** Set to have the sandbox give no answer to being stopped. */
    cancelFails: false,
    /** Something that happens while the sandbox is being asked to stop. */
    /** What the sandbox says became of a note, when asked without being given anything. */
    fates: [] as string[],
    fateOf: (async () => "none") as (noteId: string) => Promise<"taken" | "closed" | "none">,
    /** What the sandbox was told for a task at work, and what it says to that. */
    told: [] as [string, { id: string; text: string }][],
    tell: (async () => ({ state: "taken" })) as (taskId: string, note: { id: string; text: string }) => Promise<{ state: "taken" } | { state: "closed" } | { state: "refused"; error: string }>,
    /** Tasks the sandbox has already taken, by id, as they stand there. */
    took: {} as Record<string, { phase: string; error?: string }>,
    /** What a task left for a later one to go on from, by task id; nothing for one that left nothing or whose leavings are gone. */
    left: {} as Record<string, { record: unknown; cwd: string; repository?: string; until: number }>,
    /** What the sandbox says when asked whether it has a task: its state, that it has none, or no answer at all. */
    has: "none" as "there" | "none" | Error,
    asked: [] as string[],
    answered: [] as unknown[][],
    start: (async () => ({ phase: "running" })) as (input: unknown) => Promise<{ phase: string; error?: string }>,
    answer: (async (decision: "allow" | "deny") => ({ ok: true, decision })) as (...args: any[]) => Promise<any>,
    fate: {} as Record<string, unknown>,
  };
  const slots = { leases: [] as [string, string, string | undefined][], acquired: [] as string[], lifetimes: [] as (number | undefined)[], released: [] as string[], usage: [] as [string, number][], acquire: (async () => true) as () => Promise<boolean>, release: (async () => undefined) as () => Promise<void> };
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
      snapshot: async () => worker.left[taskId] ?? null,
      tell: async (note: { id: string; text: string }) => (worker.told.push([taskId, note]), worker.tell(taskId, note)),
      told: async (noteId: string) => (worker.fates.push(noteId), worker.fateOf(noteId)),
      status: async () => worker.took[taskId] ?? { error: "no such task" },
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
    workerNamed: (name) => settings.others.find((each) => each.name === name) ?? (settings.workers.includes(name) && name === sandboxWorker.name ? sandboxWorker : undefined),
    workers: () => [...(settings.workers.includes(sandboxWorker.name) ? [sandboxWorker] : []), ...settings.others],
    firstWorker: () => (settings.workers.includes(sandboxWorker.name) ? sandboxWorker : undefined),
    // Offered or retired; one the deployment no longer has at all is not known, as in the Brain itself.
    workerOf: (name) => {
      const known = settings.others.find((each) => each.name === name) ?? (name === sandboxWorker.name && !settings.gone.includes(name) ? sandboxWorker : undefined);
      if (!known) throw new Error(`no worker named "${name}" is known here`);
      return known;
    },
    registry: () =>
      ({
        acquireTaskSlot: async (tenant: string, taskId: string, lifetimeMs?: number, lease?: string) => (slots.acquired.push(`${tenant}:${taskId}`), slots.lifetimes.push(lifetimeMs), slots.leases.push(["take", taskId, lease]), slots.acquire()),
        releaseTaskSlot: async (taskId: string, lease?: string) => (await slots.release(), slots.leases.push(["back", taskId, lease]), void slots.released.push(taskId)),
        recordUsage: async (tenant: string, tokens: number) => (slots.usage.push([tenant, tokens]), { allowed: true, used: 0, budget: 0, day: "" }),
      }) as never,
    deciders: () => settings.deciders,
    askedIn: () => undefined,
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
        const result = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "Fix the build", "do it", { repository: "https://github.com/acme/app" })) as { task_id: string; status: string };
        expect(result.status).toBe("running");
        expect(kept(result.task_id)).toMatchObject({ op_id: "call_1", worker: "sandbox", title: "Fix the build", brief: "do it", session_key: SESSION_KEY, requested_by: "alice", status: "running" });
        const [watch] = store.rows<Record<string, any>>("SELECT * FROM timers WHERE id = ?", `watch_${result.task_id}`);
        expect(watch).toMatchObject({ session_key: SESSION_KEY, status: "active" });
        expect(JSON.parse(watch.data)).toEqual({ task_id: result.task_id });
        expect(watch.due_at).toBeGreaterThanOrEqual(before + (2 * 60 * 60 + 10 * 60) * 1_000);
        expect(slots.acquired).toEqual([`acme:${result.task_id}`]);
        expect(worker.started).toEqual([{ id: result.task_id, prompt: "do it", repository: "https://github.com/acme/app", brain: store.scopeName(), requested_by: "alice", accept_by: expect.any(Number), bounds: { lifetime_ms: 120 * 60_000, model_calls: 400 } }]);
        expect(audited("task.dispatched")).toEqual([{ actor: "alice", task_id: result.task_id, title: "Fix the build", repository: "https://github.com/acme/app" }]);
      });
    });

    it("credits a task to the one person who asked, and to nobody when several did or none", async () => {
      await within(async ({ tasks, kept, settings, audited }) => {
        settings.deciders = [
          { kind: "human", id: "alice", explicit: true },
          { kind: "human", id: "alice", explicit: true },
        ];
        const one = (await tasks.dispatch(RUN, SESSION_KEY, "c1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        settings.deciders = [
          { kind: "human", id: "alice", explicit: true },
          { kind: "human", id: "bob", explicit: true },
        ];
        const two = (await tasks.dispatch(RUN, SESSION_KEY, "c2", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        settings.deciders = [];
        const none = (await tasks.dispatch(RUN, SESSION_KEY, "c3", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        expect([kept(one.task_id).requested_by, kept(two.task_id).requested_by, kept(none.task_id).requested_by]).toEqual(["alice", null, null]);
        expect(audited("task.dispatched").map((each) => each.actor)).toEqual(["alice", "(automation)", "(automation)"]);
      });
    });

    it("accepts only a GitHub https URL, and in a repository's own scope only that repository", async () => {
      await within(async ({ tasks }) => {
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c1", "sandbox", "t", "b", { repository: "git@github.com:acme/app.git" })).rejects.toThrow("repository must be an https://github.com/owner/name URL");
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c2", "sandbox", "t", "b", { repository: "https://github.com/acme/app.git" })).resolves.toMatchObject({ status: "running" });
      });
      await within(async ({ tasks, store }) => {
        const own = store.scope().id;
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c1", "sandbox", "t", "b", { repository: "https://github.com/other/repo" })).rejects.toThrow(`in this repository's conversation a task can only work on ${own}`);
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c2", "sandbox", "t", "b", { repository: `https://github.com/${own.toUpperCase()}.git` })).resolves.toMatchObject({ status: "running" });
        await expect(tasks.dispatch(RUN, SESSION_KEY, "c3", "sandbox", "t", "b", { repository: null })).resolves.toMatchObject({ status: "running" });
      }, "repo:acme/app");
    });

    it("never starts a second task for the same call, and does not start an already started one again", async () => {
      await within(async ({ tasks, store, worker }) => {
        const first = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        const again = await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null });
        expect(again).toEqual({ task_id: first.task_id, status: "running" });
        expect(store.rows("SELECT 1 FROM tasks")).toHaveLength(1);
        expect(worker.started).toHaveLength(1);
      });
    });

    it("continues a task that was written but never started, under the same id", async () => {
      await within(async ({ tasks, task, kept, worker }) => {
        task("t1", { status: "dispatching" });
        expect(await tasks.dispatch(RUN, SESSION_KEY, "op_t1", "sandbox", "t", "b", { repository: null })).toEqual({ task_id: "t1", status: "running" });
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
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })).rejects.toThrow("there are already 3 tasks running here; wait for one to finish or cancel one");
        expect(store.rows("SELECT 1 FROM tasks")).toHaveLength(4);
      });
    });

    it("fails the task, and gives the slot back, when the registry cannot be reached", async () => {
      await within(async ({ tasks, store, kept, slots, worker, timer }) => {
        slots.acquire = async () => {
          throw new Error("registry down");
        };
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })).rejects.toThrow("the worker could not be started; try again");
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
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })).rejects.toThrow("too many tasks are running for this tenant right now; try again later");
        const id = store.rows<{ id: string }>("SELECT id FROM tasks")[0].id;
        expect(JSON.parse(kept(id).result)).toEqual({ error: "the tenant's limit of tasks at once is reached" });
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
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })).toMatchObject({ status: "running" });
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
        const said = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string; status: string; note: string };
        expect(said).toMatchObject({ status: "unconfirmed", note: expect.stringContaining("Do not hand the same work over again") });
        const id = said.task_id;
        // Nothing is stopped or given back on a guess, and nobody is told to try again.
        expect(kept(id).status).toBe("unconfirmed");
        expect(worker.cancelled).toEqual([]);
        expect(slots.released).toEqual([]);
        expect(woken.length).toBeGreaterThan(0);
        expect(tasks.nextWakeAt(0)).not.toBeNull();
        // The same call again (a replay), and a look at how it stands: the same, with the same word.
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })).toEqual(said);
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
        const said = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string; status: string };
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
        const said = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string; status: string };
        expect(said.status).toBe("running");
        expect(kept(said.task_id).status).toBe("running");
      });
    });

    it("finds out from the worker whether a task whose start was not answered began: it has it, it never heard of it, or it reported", async () => {
      // The worker has it: it began.
      await within(async ({ tasks, store, kept, slots, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
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
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        // Not to be asked at first; then asked, and it says none.
        worker.has = new Error("connection reset");
        await later(store, tasks);
        expect(kept(id).status).toBe("unconfirmed");
        worker.has = "none";
        await later(store, tasks);
        expect(kept(id).status).toBe("failed");
        expect(JSON.parse(kept(id).result).error).toContain("never took it");
        expect(slots.released).toEqual([id]);
        expect(store.rows<{ kind: string }>("SELECT kind FROM inbox WHERE source = 'worker'")).toEqual([{ kind: "worker.failed" }]);
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
        expect(store.rows<{ state: string }>("SELECT state FROM work WHERE id = ?", id)).toEqual([{ state: "failed" }]);
      });
      // It reports before it is asked about: what it reported stands, and nothing more is asked.
      await within(async ({ tasks, store, kept, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        await tasks.event(id, 1, "progress", { message: "cloning" });
        await later(store, tasks);
        expect(kept(id).status).toBe("running");
        expect(worker.asked).toEqual([]);
      });
    });

    it("gives up a task whose worker cannot be asked after a bounded number of tries: lost, said as not known, its place kept until it is certain that nothing runs", async () => {
      await within(async ({ tasks, store, kept, slots, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
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
        expect(said[0].text).not.toContain("it stopped where it was running");
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
          const asked = tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null }) as Promise<{ task_id: string; status: string }>;
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
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        const created = store.rows<{ created_at: number }>("SELECT created_at FROM tasks WHERE id = ?", id)[0].created_at;
        expect(worker.started.map((each: any) => each.accept_by)).toEqual([created + 15 * 60_000, created + 15 * 60_000]);
      });
    });

    it("counts, once, what a task ended here as lost turns out to have spent", async () => {
      await within(async ({ tasks, store, kept, slots, worker, spent }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
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

    it("fixes how far a task may go as it is written: its worker, its place and its watchdog go by that, whatever is changed afterwards", async () => {
      await within(async ({ tasks, store, worker, slots, task }) => {
        store.setMeta("limits", JSON.stringify({ task_minutes: 30, task_model_calls: 50 }));
        const before = Date.now();
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        expect((worker.started[0] as any).bounds).toEqual({ lifetime_ms: 30 * 60_000, model_calls: 50 });
        // The place is asked for with the same figure.
        expect(slots.lifetimes).toEqual([30 * 60_000]);
        // The watchdog speaks after the latest it may still be running: taken as late as it may be (a quarter of an hour), run for its half hour, and ten minutes to say how it ended.
        const due = store.rows<{ due_at: number }>("SELECT due_at FROM timers WHERE id = ?", `watch_${id}`)[0].due_at;
        expect(due - before).toBeGreaterThanOrEqual(55 * 60_000);
        expect(due - before).toBeLessThan(56 * 60_000);

        // The limits change while a task that was written has not been started yet: it goes by what was fixed for it.
        store.setMeta("limits", JSON.stringify({ task_minutes: 480, task_model_calls: 5 }));
        store.sql.exec("UPDATE tasks SET status = 'dispatching' WHERE id = ?", id);
        await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null });
        expect((worker.started.at(-1) as any).bounds).toEqual({ lifetime_ms: 30 * 60_000, model_calls: 50 });
        expect(slots.lifetimes.at(-1)).toBe(30 * 60_000);
        // One written before this was kept: by what held for every task then, which is what its place was taken for.
        task("t_old", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_old' WHERE id = 't_old'");
        await tasks.dispatch(RUN, SESSION_KEY, "call_old", "sandbox", "t", "b", { repository: null });
        expect((worker.started.at(-1) as any).bounds).toEqual({ lifetime_ms: 120 * 60_000, model_calls: 400 });
        expect(slots.lifetimes.at(-1)).toBe(120 * 60_000);
      });
    });

    it("takes any word from the worker as showing that it began: not confirmed no longer, at once", async () => {
      await within(async ({ tasks, store, kept, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
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
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_again", "sandbox", "t", "b", { repository: null })).toMatchObject({ task_id: "t_again", status: "unconfirmed" });
        expect(kept("t_again").status).toBe("unconfirmed");
        expect(worker.started).toEqual([]);
        expect(store.rows("SELECT task_id FROM unconfirmed")).toEqual([{ task_id: "t_again" }]);
      });
      // No place to be had, on the same call made again: not failed either, for the same reason.
      await within(async ({ tasks, store, kept, slots, task }) => {
        task("t_again", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_again' WHERE id = 't_again'");
        slots.acquire = async () => false;
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_again", "sandbox", "t", "b", { repository: null })).toMatchObject({ status: "unconfirmed" });
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
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_again", "sandbox", "t", "b", { repository: null })).toMatchObject({ status: "running" });
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
        task("t_done", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_done' WHERE id = 't_done'");
        slots.acquire = async () => {
          await tasks.event("t_done", 1, "result", { status: "succeeded", summary: "done" });
          throw new Error("registry down");
        };
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_done", "sandbox", "t", "b", { repository: null })).toMatchObject({ status: "succeeded" });
        expect(kept("t_done").status).toBe("succeeded");
        // The registry gave no answer: it may have taken a place all the same, so one is given back.
        expect(slots.released.filter((each) => each === "t_done").length).toBeGreaterThanOrEqual(2);
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
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_had", "sandbox", "t", "b", { repository: null })).toMatchObject({ status: "succeeded" });
        expect(worker.started).toEqual([]);
        expect(slots.released).toEqual(["t_had"]);
        expect(kept("t_had").status).toBe("succeeded");
      });
    });

    it("lets a task that is not confirmed be called off like any other", async () => {
      await within(async ({ tasks, store, kept, slots, worker }) => {
        worker.start = lost;
        const { task_id: id } = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
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
        const one = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        // The same call again is the same task, and the same row.
        await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null });
        expect(work()).toEqual([{ id: one.task_id, worker: "sandbox", session_key: SESSION_KEY, person: "alice", state: "open" }]);
        await tasks.event(one.task_id, 1, "result", { status: "succeeded", summary: "done" });
        expect(work()).toMatchObject([{ id: one.task_id, state: "done" }]);
        // A late word on it changes nothing.
        await tasks.cancel(SESSION_KEY, one.task_id);
        expect(work()).toMatchObject([{ state: "done" }]);
        const two = (await tasks.dispatch(RUN, SESSION_KEY, "call_2", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        await tasks.cancel(SESSION_KEY, two.task_id);
        expect(work().map((each) => each.state).sort()).toEqual(["cancelled", "done"]);
        // A task taken before there was an index has no row; it gets one when it ends.
        task("t_old", { status: "running" });
        await tasks.cancel(SESSION_KEY, "t_old");
        expect(store.rows("SELECT worker, session_key, state FROM work WHERE id = 't_old'")).toEqual([{ worker: "sandbox", session_key: SESSION_KEY, state: "cancelled" }]);
      });
    });

    it("lets a worker look, before anything is written, at what the work will be allowed: turned away, as ever, or bound to something kept with the task", async () => {
      await within(async ({ tasks, store, settings, slots }) => {
        const asked: unknown[] = [];
        const started: unknown[] = [];
        let answer: any = { kind: "ordinary" };
        let gate: Promise<void> | undefined;
        const careful: Worker = {
          name: "careful",
          description: "Does something that may need leave.",
          acts_as: "agent",
          options: { where: { type: ["string", "null"] } },
          prepareStart: async (_env, about) => {
            asked.push(about);
            await gate;
            return answer;
          },
          start: async (_env, work) => (started.push({ id: work.id, lend: work.lend, by: work.by }), { state: "started" }),
          standing: async () => "there",
        };
        settings.workers = [];
        settings.others = [careful];
        const actor = { person: "alice", connector: "chat", origin: { app: "a" }, said: [{ ref: 7, text: "look at acme/app" }], recent: [] };

        // Turned away: said to the model in the worker's words, and nothing is written, taken or started.
        answer = { kind: "refused", reason: "that cannot be reached just now; ask again later", retryable: true };
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_r", "careful", "t", "b", { where: "acme/app" }, null, undefined, actor)).rejects.toThrow("that cannot be reached just now; ask again later");
        expect(store.rows("SELECT 1 FROM tasks")).toEqual([]);
        expect(slots.acquired).toEqual([]);
        expect(started).toEqual([]);
        // What it is asked with: where, who (the one person who asked), what was asked for, and what the host knows of who asked.
        expect(asked).toEqual([{ scope: store.scope(), sessionKey: SESSION_KEY, by: "alice", options: { where: "acme/app" }, continueFrom: null, actor }]);

        // As ever: nothing is kept beside the task, and the work is started with nothing more.
        answer = { kind: "ordinary" };
        const plain = (await tasks.dispatch(RUN, SESSION_KEY, "call_o", "careful", "t", "b", { where: "acme/app" }, null, undefined, actor)) as { task_id: string };
        expect(store.rows("SELECT 1 FROM task_lends")).toEqual([]);
        expect(started.at(-1)).toEqual({ id: plain.task_id, lend: undefined, by: "alice" });

        // Bound: what the worker gave is kept with the task as it is, and handed to it when it is started. Nothing of it is the model's.
        answer = { kind: "bound", record: { v: 1, leave: "to read acme/app" } };
        const bound = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "careful", "t", "b", { where: "acme/app" }, null, undefined, actor)) as { task_id: string };
        expect(store.rows("SELECT task_id, record FROM task_lends")).toEqual([{ task_id: bound.task_id, record: JSON.stringify({ v: 1, leave: "to read acme/app" }) }]);
        expect(started.at(-1)).toEqual({ id: bound.task_id, lend: { v: 1, leave: "to read acme/app" }, by: "alice" });
        // The same call made again is the task it made: the worker is not asked a second time, and nothing it would say now changes what was kept.
        answer = { kind: "bound", record: { v: 1, leave: "something else" } };
        const before = asked.length;
        expect(((await tasks.dispatch(RUN, SESSION_KEY, "call_b", "careful", "t", "b", { where: "acme/app" }, null, undefined, actor)) as { task_id: string }).task_id).toBe(bound.task_id);
        expect(asked).toHaveLength(before);
        expect(store.rows("SELECT record FROM task_lends WHERE task_id = ?", bound.task_id)).toEqual([{ record: JSON.stringify({ v: 1, leave: "to read acme/app" }) }]);

        // The same call made twice at once, both still being looked at: one task, started once, with what the first to be written was given.
        let open!: () => void;
        gate = new Promise((resolve) => (open = resolve));
        answer = { kind: "bound", record: { v: 1, leave: "once" } };
        const count = started.length;
        const both = Promise.all([tasks.dispatch(RUN, SESSION_KEY, "call_2x", "careful", "t", "b", { where: "acme/app" }, null, undefined, actor), tasks.dispatch(RUN, SESSION_KEY, "call_2x", "careful", "t", "b", { where: "acme/app" }, null, undefined, actor)]);
        open();
        const [one, two] = (await both) as { task_id: string }[];
        expect(one.task_id).toBe(two.task_id);
        expect(store.rows("SELECT 1 FROM tasks WHERE op_id = 'call_2x'")).toHaveLength(1);
        expect(started.slice(count).filter((each: any) => each.id === one.task_id).length).toBeGreaterThanOrEqual(1);
        expect(new Set(started.slice(count).map((each: any) => JSON.stringify(each.lend)))).toEqual(new Set([JSON.stringify({ v: 1, leave: "once" })]));
      });
    });

    it("hands work to any worker that is started from here, by the contract alone: its own options, its own say on them, its own name on the record", async () => {
      await within(async ({ tasks, store, kept, settings, slots, worker }) => {
        // A worker that is nothing like the sandbox, and the only one this deployment has.
        const calls: unknown[][] = [];
        const probe: Worker = {
          name: "probe",
          description: "Looks something up, to a depth.",
          acts_as: "agent",
          options: { depth: { type: ["integer", "null"] } },
          accepts(options) {
            if (typeof options.depth === "number" && options.depth > 3) throw new Error("depth is at most 3");
          },
          start: async (_env, work) => (calls.push(["start", work.id, work.options, work.brain, typeof work.accept_by]), { state: "started" }),
          cancel: async (_env, id) => (calls.push(["cancel", id]), "stopped"),
          standing: async () => "there",
        };
        settings.workers = [];
        settings.others = [probe];

        // What it will not take is said by it, before anything is written.
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_0", "probe", "t", "b", { depth: 9 })).rejects.toThrow("depth is at most 3");
        expect(store.rows("SELECT 1 FROM tasks")).toEqual([]);

        const said = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "probe", "Look it up", "find x", { depth: 2 })) as { task_id: string; status: string };
        expect(said.status).toBe("running");
        expect(calls).toEqual([["start", said.task_id, { depth: 2 }, store.scopeName(), "number"]]);
        expect(worker.started).toEqual([]);
        // Recorded under its own name, in the task and in the index of work.
        expect(kept(said.task_id).worker).toBe("probe");
        expect(store.rows<{ worker: string; state: string }>("SELECT worker, state FROM work WHERE id = ?", said.task_id)).toEqual([{ worker: "probe", state: "open" }]);
        // A call that names no worker is the tool from before there were several: it was for the worker the deployment says, and is not
        // given to whichever worker happens to be the only one now.
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_2", null, "t", "b", { depth: 1 })).rejects.toThrow("this deployment has no worker to hand this to");
        const unnamed = (await tasks.dispatch(RUN, SESSION_KEY, "call_2b", "probe", "t", "b", { depth: 1 })) as { task_id: string };

        // It reports as any worker does, and is stopped through its own stopping.
        await tasks.event(said.task_id, 1, "result", { text: "x is 42" });
        expect(kept(said.task_id).status).toBe("succeeded");
        await tasks.cancel(SESSION_KEY, unnamed.task_id);
        expect(calls.at(-1)).toEqual(["cancel", unnamed.task_id]);
        expect(slots.released).toEqual([said.task_id, unnamed.task_id]);

        // Another worker's options, left null by the call, never reach it: not on the first call, and not when the call is made again.
        const before = calls.length;
        store.sql.exec("UPDATE tasks SET status = 'dispatching' WHERE id = ?", unnamed.task_id);
        await tasks.dispatch(RUN, SESSION_KEY, "call_2b", "probe", "t", "b", { depth: 1, repository: null });
        expect(calls.slice(before).filter((each) => each[0] === "start").map((each) => each[2])).toEqual([{ depth: 1 }]);
        // And a call is the call it was only in its own conversation.
        await expect(tasks.dispatch(RUN, "thread:elsewhere", "call_2b", "probe", "t", "b", { depth: 1 })).rejects.toThrow("first made in another conversation");

        // With the worker that tool was for offered again, such a call goes to it, whatever else there is.
        settings.workers = ["sandbox"];
        const old = (await tasks.dispatch(RUN, SESSION_KEY, "call_5", null, "t", "b", { repository: null })) as { task_id: string };
        expect(kept(old.task_id).worker).toBe("sandbox");
      });
    });

    it("goes on from an earlier piece of the same worker's work in the same conversation that ended well, and from no other", async () => {
      await within(async ({ tasks, store, kept, settings, slots, worker, task, audited }) => {
        // A piece of work that ended well, on a repository, and left its workspace behind.
        const first = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "Fix", "fix it", { repository: "https://github.com/acme/app" })) as { task_id: string };
        await tasks.event(first.task_id, 1, "result", { text: "fixed" });
        worker.left[first.task_id] = { record: { id: "kept" }, cwd: "/workspace/job/repo", repository: "https://github.com/acme/app", until: Date.now() + 3_600_000 };

        // The next piece goes on from it: a task of its own, started from what the first left, where the first worked.
        const second = (await tasks.dispatch(RUN, SESSION_KEY, "call_2", "sandbox", "Tests", "add tests", { repository: null }, first.task_id)) as { task_id: string; status: string };
        expect(second.status).toBe("running");
        expect(second.task_id).not.toBe(first.task_id);
        expect(worker.started.at(-1)).toMatchObject({ id: second.task_id, prompt: "add tests", seed: { from: first.task_id, record: { id: "kept" }, cwd: "/workspace/job/repo", repository: "https://github.com/acme/app" } });
        expect((worker.started.at(-1) as any).repository).toBeUndefined();
        // The first is as it ended; the second is credited and counted on its own.
        expect(kept(first.task_id).status).toBe("succeeded");
        expect(audited("task.dispatched").at(-1)).toMatchObject({ task_id: second.task_id, continue_from: first.task_id });
        // The same repository named again is the same; another is other work, which the worker says.
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_3", "sandbox", "t", "b", { repository: "https://github.com/ACME/app.git" }, first.task_id)).toMatchObject({ status: "running" });
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_4", "sandbox", "t", "b", { repository: "https://github.com/acme/other" }, first.task_id)).rejects.toThrow("to go on with it leave repository null");
        // What it left is no longer kept: said by the worker, nothing started in its place, the place given back.
        delete worker.left[first.task_id];
        const before = worker.started.length;
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_5", "sandbox", "t", "b", { repository: null }, first.task_id)).rejects.toThrow("is no longer kept");
        expect(worker.started).toHaveLength(before);
        expect(slots.released.length).toBeGreaterThan(0);

        // Not one that did not end well; not another conversation's; not one there is none of. Nothing is written for any of these.
        // (One that has not ended yet is waited for: see "work put after a piece that has not ended yet".)
        const written = store.rows("SELECT 1 FROM tasks").length;
        task("t_failed", { status: "failed" });
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_7", "sandbox", "t", "b", { repository: null }, "t_failed")).rejects.toThrow("did not end well");
        task("t_elsewhere", { status: "succeeded", session_key: "thread:other" });
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_8", "sandbox", "t", "b", { repository: null }, "t_elsewhere")).rejects.toThrow("there is no piece of work");
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_9", "sandbox", "t", "b", { repository: null }, "no-such")).rejects.toThrow("there is no piece of work");
        expect(store.rows("SELECT 1 FROM tasks").length).toBe(written + 2);

        // Not another person's, in the same conversation: it is theirs alone to go on from.
        worker.left[first.task_id] = { record: { id: "kept" }, cwd: "/workspace/job/repo", until: Date.now() + 3_600_000 };
        store.sql.exec("UPDATE tasks SET requested_by = 'ou_someone_else' WHERE id = ?", first.task_id);
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_other_person", "sandbox", "t", "b", { repository: null }, first.task_id)).rejects.toThrow("there is no piece of work");

        // A start that was taken while the word of it was lost, made again after what the earlier task left is gone:
        // the new task answers for itself. It is running, and is not said to have failed.
        store.sql.exec("UPDATE tasks SET requested_by = (SELECT requested_by FROM tasks WHERE id = ?) WHERE id = ?", second.task_id, first.task_id);
        worker.left[first.task_id] = { record: { id: "kept" }, cwd: "/workspace/job/repo", until: Date.now() + 3_600_000 };
        worker.start = async () => {
          throw new Error("connection reset");
        };
        const unanswered = (await tasks.dispatch(RUN, SESSION_KEY, "call_lost_word", "sandbox", "t", "b", { repository: null }, first.task_id)) as { task_id: string; status: string };
        expect(unanswered.status).toBe("unconfirmed");
        store.sql.exec("DELETE FROM unconfirmed WHERE task_id = ?", unanswered.task_id);
        store.sql.exec("UPDATE tasks SET status = 'dispatching' WHERE id = ?", unanswered.task_id);
        delete worker.left[first.task_id];
        worker.took[unanswered.task_id] = { phase: "running" };
        const begun = worker.started.length;
        // (Made again saying it goes on from something else: not this call.)
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_lost_word", "sandbox", "t", "b", { repository: null }, second.task_id)).rejects.toThrow("first made for something else");
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_lost_word", "sandbox", "t", "b", { repository: null }, first.task_id)).toMatchObject({ task_id: unanswered.task_id, status: "running" });
        expect(worker.started).toHaveLength(begun);
        // Made again by a run that is someone else's, or nobody's in particular: not this call, whether or not it has begun.
        const alice = settings.deciders;
        settings.deciders = [{ kind: "human", id: "bob", explicit: true }];
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_lost_word", "sandbox", "t", "b", { repository: null }, first.task_id)).rejects.toThrow("first made for someone else");
        settings.deciders = [];
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_lost_word", "sandbox", "t", "b", { repository: null }, first.task_id)).rejects.toThrow("first made for someone else");
        settings.deciders = alice;
        // What it goes on from is kept with it.
        expect(store.rows("SELECT from_id FROM task_follows WHERE task_id = ?", unanswered.task_id)).toEqual([{ from_id: first.task_id }]);
        store.sql.exec("UPDATE tasks SET requested_by = 'ou_someone_else' WHERE id = ?", first.task_id);

        // Work nobody in particular asked for is nobody's to go on from, also for a run that is nobody's in particular.
        task("t_nobodys", { status: "succeeded" });
        store.sql.exec("UPDATE tasks SET requested_by = NULL WHERE id = 't_nobodys'");
        const one = settings.deciders;
        settings.deciders = [];
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_nobody", "sandbox", "t", "b", { repository: null }, "t_nobodys")).rejects.toThrow("can only be asked for in answer to the one person");
        settings.deciders = one;

        // A worker that does not say it goes on is never asked to.
        const probe: Worker = { name: "probe", description: "", acts_as: "agent", start: async () => ({ state: "started" }) };
        settings.others = [probe];
        task("t_probe", { status: "succeeded" });
        store.sql.exec("UPDATE tasks SET worker = 'probe' WHERE id = 't_probe'");
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_10", "probe", "t", "b", {}, "t_probe")).rejects.toThrow("cannot go on with an earlier piece of work");
        // And one worker's work is not another's to go on from.
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_11", "sandbox", "t", "b", { repository: null }, "t_probe")).rejects.toThrow("there is no piece of work");
      });
    });

    describe("something said to a piece of work that is under way", () => {
      it("is passed to its worker by the id of the call, for its own person in their own step, and said to be passed on, not done", async () => {
        await within(async ({ tasks, worker, audited, settings, task, store }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", { repository: null })) as { task_id: string };
          const said = (await tasks.tell(RUN, SESSION_KEY, "call_t1", a.task_id, "also fix the footer")) as { ok: boolean; state: string; note: string };
          expect(said).toMatchObject({ ok: true, state: "taken", note: expect.stringContaining("not read yet") });
          expect(worker.told).toEqual([[a.task_id, { id: "call_t1", text: "also fix the footer" }]]);
          // Recorded without what was said.
          expect(audited("task.told")).toEqual([{ actor: "alice", task_id: a.task_id, call: "call_t1", length: 19 }]);
          // The same call made again: what became of it is known here; it is not sent again, and is recorded once.
          expect(await tasks.tell(RUN, SESSION_KEY, "call_t1", a.task_id, "also fix the footer")).toMatchObject({ ok: true, state: "taken" });
          expect(worker.told).toHaveLength(1);
          expect(audited("task.told")).toHaveLength(1);
          // And not for another piece of work.
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t1", "t_other", "x")).rejects.toThrow();

          // Not someone else's, not in a step that is nobody's own, not from another conversation, not one there is none of.
          const before = worker.told.length;
          const alice = settings.deciders;
          settings.deciders = [{ kind: "human", id: "bob", explicit: true }];
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t2", a.task_id, "x")).rejects.toThrow("there is no piece of work");
          settings.deciders = [];
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t3", a.task_id, "x")).rejects.toThrow("only in answer to the one person");
          settings.deciders = alice;
          await expect(tasks.tell(RUN, "thread:other", "call_t4", a.task_id, "x")).rejects.toThrow("there is no piece of work");
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t5", "no-such", "x")).rejects.toThrow("there is no piece of work");
          // Not one that has not begun, or is not known to have.
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t6", b.task_id, "x")).rejects.toThrow("has not begun yet");
          task("t_un", { status: "unconfirmed" });
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t7", "t_un", "x")).rejects.toThrow("not known yet that this piece of work has begun");
          expect(worker.told).toHaveLength(before);
          expect(store.rows("SELECT 1 FROM audit WHERE action = 'task.told'")).toHaveLength(1);
        });
      });

      it("says so when the work takes no more, without making it something that comes after by itself; and when the work waits for an approval, that this takes nothing back", async () => {
        await within(async ({ tasks, worker, audited, store }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", { repository: null })) as { task_id: string };
          worker.tell = async () => ({ state: "closed" });
          const written = store.rows("SELECT 1 FROM tasks").length;
          expect(await tasks.tell(RUN, SESSION_KEY, "call_t1", a.task_id, "one more thing")).toMatchObject({ ok: false, state: "closed", note: expect.stringContaining("put it after that piece") });
          expect(store.rows("SELECT 1 FROM tasks")).toHaveLength(written);
          expect(audited("task.told")).toEqual([]);
          // A call that was passed on while the work was at it, made again after the work has ended, is told what it was told then;
          // one never made before is told that nothing more is taken. The worker is asked neither time.
          worker.tell = async () => ({ state: "taken" });
          await tasks.tell(RUN, SESSION_KEY, "call_t0", a.task_id, "said earlier");
          await tasks.event(a.task_id, 1, "result", { text: "done" });
          const asked = worker.told.length;
          expect(await tasks.tell(RUN, SESSION_KEY, "call_t0", a.task_id, "said earlier")).toMatchObject({ ok: true, state: "taken" });
          expect(await tasks.tell(RUN, SESSION_KEY, "call_new", a.task_id, "said after it ended")).toMatchObject({ ok: false, state: "closed" });
          expect(worker.told).toHaveLength(asked);
          expect(audited("task.told")).toHaveLength(1);

          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null })) as { task_id: string };
          store.sql.exec("UPDATE tasks SET status = 'needs_input' WHERE id = ?", b.task_id);
          expect(((await tasks.tell(RUN, SESSION_KEY, "call_t2", b.task_id, "do not push yet")) as { note: string }).note).toContain("does not take back what it is waiting to do");
          // Turned away by the worker for a reason of its own: said as that, and nothing is kept as perhaps taken.
          worker.tell = async () => ({ state: "refused", error: "that is too long to add" });
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t3", b.task_id, "x")).rejects.toThrow("nothing was added: that is too long to add");
          expect(store.rows("SELECT 1 FROM task_notes WHERE call_id = 'call_t3'")).toEqual([]);
        });
      });

      it("does not say that nothing was added when the work took it and only the answer was lost: made again after the work ended, the call is told what became of it, and nothing is sent again", async () => {
        await within(async ({ tasks, worker, audited, store }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", { repository: null })) as { task_id: string };
          // The worker takes it; the answer never gets back.
          worker.tell = async () => {
            throw new Error("connection reset");
          };
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t1", a.task_id, "also the footer")).rejects.toThrow("it may or may not have been taken. Do not send it again as something new");
          expect(store.rows("SELECT state FROM task_notes WHERE call_id = 'call_t1'")).toEqual([{ state: "sent" }]);
          // The work ends. The call is made again: asked what became of it, not sent again.
          await tasks.event(a.task_id, 1, "result", { text: "done" });
          const sent = worker.told.length;
          worker.fateOf = async () => "taken";
          expect(await tasks.tell(RUN, SESSION_KEY, "call_t1", a.task_id, "also the footer")).toMatchObject({ ok: true, state: "taken" });
          expect(worker.told).toHaveLength(sent);
          expect(worker.fates).toEqual(["call_t1"]);
          expect(audited("task.told")).toHaveLength(1);
          // And from then on it is known here: the worker is not asked again.
          await tasks.tell(RUN, SESSION_KEY, "call_t1", a.task_id, "also the footer");
          expect(worker.fates).toHaveLength(1);

          // (Nothing is promised about being told later: a note the work never had cannot be reported by it as unread.)
          await expect(tasks.tell(RUN, SESSION_KEY, "call_tx", (await tasks.dispatch(RUN, SESSION_KEY, "call_x", "sandbox", "X", "x", { repository: null }) as { task_id: string }).task_id, "y")).rejects.toThrow(/could not confirm that it arrived$/);
          // To work that did not end well, nothing is added and nothing is said of going on from it.
          const lost = (await tasks.dispatch(RUN, SESSION_KEY, "call_l", "sandbox", "L", "l", { repository: null })) as { task_id: string };
          await tasks.event(lost.task_id, 1, "failed", { error: "boom" });
          const refused = (await tasks.tell(RUN, SESSION_KEY, "call_tl", lost.task_id, "y")) as { state: string; note: string };
          expect(refused.state).toBe("closed");
          expect(refused.note).toContain("nothing of it to go on from");
          expect(refused.note).not.toContain("hand it over to go on from it");
          // One the worker never had: nothing was added, said as that.
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null })) as { task_id: string };
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t2", b.task_id, "x")).rejects.toThrow("may or may not have been taken");
          await tasks.event(b.task_id, 1, "result", { text: "done" });
          worker.fateOf = async () => "none";
          expect(await tasks.tell(RUN, SESSION_KEY, "call_t2", b.task_id, "x")).toMatchObject({ ok: false, state: "closed" });
          // One whose fate cannot be found out: said to be not known, with no advice to do it over.
          const c = (await tasks.dispatch(RUN, SESSION_KEY, "call_c", "sandbox", "C", "c", { repository: null })) as { task_id: string };
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t3", c.task_id, "x")).rejects.toThrow("may or may not have been taken");
          await tasks.event(c.task_id, 1, "result", { text: "done" });
          worker.fateOf = async () => {
            throw new Error("unreachable");
          };
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t3", c.task_id, "x")).rejects.toThrow("may or may not have been taken into account; do not hand it over again on a guess");
          // While the work is still at it, the same call made again is simply sent again by its id.
          const d = (await tasks.dispatch(RUN, SESSION_KEY, "call_d", "sandbox", "D", "d", { repository: null })) as { task_id: string };
          await expect(tasks.tell(RUN, SESSION_KEY, "call_t4", d.task_id, "x")).rejects.toThrow("may or may not have been taken");
          worker.tell = async () => ({ state: "taken" });
          expect(await tasks.tell(RUN, SESSION_KEY, "call_t4", d.task_id, "x")).toMatchObject({ ok: true, state: "taken" });
        });
      });

      it("keeps and tells only which notes were not read and when, whatever a worker sends with its ending", async () => {
        await within(async ({ tasks, kept, events }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", { repository: null })) as { task_id: string };
          await tasks.event(a.task_id, 1, "result", { text: "ok", notes_not_read: [{ id: "n1", at: 5, text: "something private" }] });
          expect(JSON.stringify(kept(a.task_id))).not.toContain("something private");
          expect(JSON.stringify(await tasks.status(a.task_id))).not.toContain("something private");
          expect(JSON.stringify(events())).not.toContain("something private");
        });
      });

      it("has what did not reach the work told with its ending, in so many words", async () => {
        await within(async ({ tasks, events }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", { repository: null })) as { task_id: string };
          await tasks.event(a.task_id, 1, "result", { text: "Fixed the build.", notes_not_read: [{ id: "call_t1", at: Date.UTC(2026, 10, 26, 4, 5) }] });
          const told = events().at(-1)!.text as string;
          expect(told).toContain("finished. The worker's own summary (unverified): Fixed the build.");
          expect(told).toContain("One thing added to it while it was at work could not be confirmed to have reached it before it ended (added at 04:05 UTC)");
          // How many and when, never what: this is the conversation's record, which everyone there shares.
          expect(told).toContain("Do not repeat here what was added");
          // Of work that did not end well, nothing is said of going on from it (it cannot be gone on from).
          const f = (await tasks.dispatch(RUN, SESSION_KEY, "call_f", "sandbox", "F", "f", { repository: null })) as { task_id: string };
          await tasks.event(f.task_id, 1, "failed", { error: "boom", notes_not_read: [{ id: "x", at: 1 }] });
          expect(events().at(-1)!.text).toContain("could not be confirmed to have reached it");
          expect(events().at(-1)!.text).not.toContain("goes on from this piece");
          // Nothing of the kind where everything was read.
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null })) as { task_id: string };
          await tasks.event(b.task_id, 1, "result", { text: "ok" });
          expect(events().at(-1)!.text).not.toContain("could not be confirmed");
        });
      });
    });

    describe("work put after a piece that has not ended yet", () => {
      const REPO = { repository: "https://github.com/acme/app" };
      const left = (id: string) => ({ record: { id: `kept-${id}` }, cwd: "/workspace/job/repo", repository: REPO.repository, until: Date.now() + 3_600_000 });
      const due = (store: any) => store.sql.exec("UPDATE task_queued SET next_at = 0");

      it("is written as waiting, takes no place and starts nothing; when the one before it ends well it is started from what that left, by the id it was given", async () => {
        await within(async ({ tasks, store, kept, worker, slots, audited, timer, woken }) => {
          const first = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "Fix", "fix it", REPO)) as { task_id: string };
          const places = slots.acquired.length;
          const begun = worker.started.length;
          const second = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "Tests", "add tests", { repository: null }, first.task_id)) as { task_id: string; status: string; note?: string };
          expect(second).toMatchObject({ status: "queued", note: expect.stringContaining("starts by itself") });
          expect(kept(second.task_id)).toMatchObject({ status: "queued", worker: "sandbox", requested_by: "alice" });
          // No place with the tenant, nothing started, no watchdog yet; it is in the index of work, and said in the record.
          expect(slots.acquired).toHaveLength(places);
          expect(worker.started).toHaveLength(begun);
          expect(timer(second.task_id)).toBeUndefined();
          expect(store.rows("SELECT state FROM work WHERE id = ?", second.task_id)).toEqual([{ state: "open" }]);
          expect(audited("task.dispatched").at(-1)).toMatchObject({ task_id: second.task_id, continue_from: first.task_id, queued: true });
          // The same call made again is told how it stands, and starts nothing.
          expect(await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "Tests", "add tests", { repository: null }, first.task_id)).toMatchObject({ task_id: second.task_id, status: "queued" });
          // While the first is at it, settling changes nothing.
          due(store);
          await tasks.settle();
          expect(kept(second.task_id).status).toBe("queued");
          expect(worker.started).toHaveLength(begun);

          // The first ends well: the second is woken for at once, and started from what the first left.
          worker.left[first.task_id] = left(first.task_id);
          const before = woken.length;
          await tasks.event(first.task_id, 1, "result", { text: "fixed" });
          expect(woken.length).toBeGreaterThan(before);
          await tasks.settle();
          expect(kept(second.task_id).status).toBe("running");
          expect(worker.started.at(-1)).toMatchObject({ id: second.task_id, prompt: "add tests", seed: { from: first.task_id, record: { id: `kept-${first.task_id}` } } });
          expect(slots.acquired.at(-1)).toBe(`acme:${second.task_id}`);
          expect(timer(second.task_id)).toMatchObject({ status: "active" });
          expect(store.rows("SELECT 1 FROM task_queued")).toEqual([]);
          // Settling again starts nothing more.
          const once = worker.started.length;
          await tasks.settle();
          expect(worker.started).toHaveLength(once);
        });
      });

      it("is one line: a piece of work has one waiting behind it, and the next goes behind that one", async () => {
        await within(async ({ tasks, kept, store, worker }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          // Another after A is told where the end of the line is, and nothing is written for it.
          await expect(tasks.dispatch(RUN, SESSION_KEY, "call_c", "sandbox", "C", "c", { repository: null }, a.task_id)).rejects.toThrow(`continue_from: "${b.task_id}"`);
          expect(store.rows("SELECT 1 FROM tasks")).toHaveLength(2);
          const c = (await tasks.dispatch(RUN, SESSION_KEY, "call_c2", "sandbox", "C", "c", { repository: null }, b.task_id)) as { task_id: string; status: string };
          expect(c.status).toBe("queued");
          // B is called off before it began: done here at once, nothing asked of the worker, and what waited behind it ends too.
          const stopped = worker.cancelled.length;
          expect(await tasks.cancel(SESSION_KEY, b.task_id)).toMatchObject({ status: "cancelled" });
          expect(worker.cancelled).toHaveLength(stopped);
          await tasks.settle();
          expect(kept(c.task_id).status).toBe("failed");
          expect(JSON.parse(kept(c.task_id).result).error).toContain("was to go on from");
          // And something new can be put after A again.
          expect(await tasks.dispatch(RUN, SESSION_KEY, "call_d", "sandbox", "D", "d", { repository: null }, a.task_id)).toMatchObject({ status: "queued" });
        });
      });

      it("is not started, and its person is told, when the one before it does not end well, however that came about", async () => {
        await within(async ({ tasks, kept, worker, events, slots }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          const begun = worker.started.length;
          const places = slots.acquired.length;
          await tasks.event(a.task_id, 1, "failed", { error: "boom" });
          await tasks.settle();
          expect(kept(b.task_id).status).toBe("failed");
          expect(worker.started).toHaveLength(begun);
          expect(slots.acquired).toHaveLength(places);
          expect(events().at(-1)).toMatchObject({ kind: "worker.failed", data: expect.stringContaining(b.task_id) });
        });
      });

      it("keeps waiting, and is not failed, while the tenant has no place free; and is failed where no task may be had at all", async () => {
        await within(async ({ tasks, kept, store, worker, slots }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          worker.left[a.task_id] = left(a.task_id);
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          slots.acquire = async () => false;
          const begun = worker.started.length;
          await tasks.settle();
          expect(kept(b.task_id).status).toBe("queued");
          expect(worker.started).toHaveLength(begun);
          expect(store.rows<{ next_at: number }>("SELECT next_at FROM task_queued")[0].next_at).toBeGreaterThan(Date.now());
          expect(tasks.nextWakeAt(Date.now())).not.toBeNull();
          // A place comes free: it starts, with the time it may be taken by counted from now, not from when it was written.
          slots.acquire = async () => true;
          due(store);
          store.sql.exec("UPDATE tasks SET created_at = created_at - ? WHERE id = ?", 60 * 60_000, b.task_id);
          await tasks.settle();
          expect(kept(b.task_id).status).toBe("running");
          expect((worker.started.at(-1) as any).accept_by).toBeGreaterThan(Date.now());
        });
      });

      it("does not hold everything up for a start that is not answered, asks again with the same id, and is found out about once it may no longer be taken", async () => {
        await within(async ({ tasks, kept, store, worker }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          worker.left[a.task_id] = left(a.task_id);
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          worker.start = async () => {
            throw new Error("connection reset");
          };
          const begun = worker.started.length;
          await tasks.settle();
          // Not answered: it stays as being started, to be asked again; it is not in any run, and is not left so for ever.
          expect(kept(b.task_id).status).toBe("dispatching");
          expect(worker.started).toHaveLength(begun + 1);
          due(store);
          await tasks.settle();
          expect(worker.started).toHaveLength(begun + 2);
          expect((worker.started.at(-1) as any).id).toBe(b.task_id);
          // The same call made again by the model does not start it either: that is settle's alone.
          expect(await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)).toMatchObject({ status: "dispatching" });
          expect(worker.started).toHaveLength(begun + 2);
          // Past the time by which it may be taken: kept as not confirmed, and found out about the usual way.
          store.sql.exec("UPDATE task_queued SET started_at = started_at - ?, next_at = 0", 16 * 60_000);
          await tasks.settle();
          expect(kept(b.task_id).status).toBe("unconfirmed");
          expect(store.rows("SELECT 1 FROM unconfirmed WHERE task_id = ?", b.task_id)).toHaveLength(1);
          // Answered at last on a later try: it runs.
        });
      });

      it("is ended, with its person told, when the worker turns the start down; and one called off while a place was being asked for is not started", async () => {
        await within(async ({ tasks, kept, store, worker, slots, events }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          // What A left is not kept: the worker says so when B is started.
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          await tasks.settle();
          expect(kept(b.task_id).status).toBe("failed");
          expect(JSON.parse(kept(b.task_id).result).error).toContain("no longer kept");
          expect(slots.released).toContain(b.task_id);
          expect(events().at(-1)).toMatchObject({ kind: "worker.failed" });

          const c = (await tasks.dispatch(RUN, SESSION_KEY, "call_c", "sandbox", "C", "c", REPO)) as { task_id: string };
          const d = (await tasks.dispatch(RUN, SESSION_KEY, "call_d", "sandbox", "D", "d", { repository: null }, c.task_id)) as { task_id: string };
          worker.left[c.task_id] = left(c.task_id);
          await tasks.event(c.task_id, 1, "result", { text: "ok" });
          const begun = worker.started.length;
          slots.acquire = async () => {
            await tasks.cancel(SESSION_KEY, d.task_id).catch(() => undefined);
            return true;
          };
          await tasks.settle();
          expect(kept(d.task_id).status).toBe("cancelled");
          expect(worker.started).toHaveLength(begun);
          expect(slots.released).toContain(d.task_id);
          expect(store.rows("SELECT 1 FROM task_queued")).toEqual([]);
        });
      });

      it("is carried on after the Brain was replaced while a place was being asked for: the place is asked for again by its id, and only then is it started and watched", async () => {
        await within(async ({ tasks, kept, store, worker, slots, timer }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          worker.left[a.task_id] = left(a.task_id);
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          // As it was kept at the moment the place was being asked for: out of waiting, not yet let through.
          const mid = () => {
            store.sql.exec("UPDATE tasks SET status = 'dispatching' WHERE id = ?", b.task_id);
            store.sql.exec("UPDATE task_queued SET started_at = NULL, next_at = 0 WHERE task_id = ?", b.task_id);
          };
          mid();
          // The tenant is full: it is not started on the strength of having been taken out of waiting. It waits again.
          slots.acquire = async () => false;
          const begun = worker.started.length;
          let asked = slots.acquired.length;
          await tasks.settle();
          expect(slots.acquired.length).toBe(asked + 1);
          expect(worker.started).toHaveLength(begun);
          expect(kept(b.task_id).status).toBe("queued");
          expect(timer(b.task_id)).toBeUndefined();
          // Much later, with a place free: asked for, let through from now, watched, started.
          mid();
          store.sql.exec("UPDATE tasks SET updated_at = ? WHERE id = ?", Date.now() - 16 * 60_000, b.task_id);
          slots.acquire = async () => true;
          asked = slots.acquired.length;
          await tasks.settle();
          expect(slots.acquired.length).toBe(asked + 1);
          expect(kept(b.task_id).status).toBe("running");
          expect(worker.started).toHaveLength(begun + 1);
          expect((worker.started.at(-1) as any).accept_by).toBeGreaterThan(Date.now());
          expect(timer(b.task_id)).toMatchObject({ status: "active" });
          // No answer about the place at all: it stays as it is, and is asked for again; nothing is started meanwhile.
          const c = (await tasks.dispatch(RUN, SESSION_KEY, "call_c", "sandbox", "C", "c", { repository: null }, b.task_id)) as { task_id: string };
          worker.left[b.task_id] = left(b.task_id);
          await tasks.event(b.task_id, 1, "result", { text: "ok" });
          slots.acquire = async () => {
            throw new Error("registry unreachable");
          };
          await tasks.settle();
          expect(kept(c.task_id).status).toBe("dispatching");
          expect(worker.started).toHaveLength(begun + 1);
          slots.acquire = async () => true;
          due(store);
          await tasks.settle();
          expect(kept(c.task_id).status).toBe("running");
        });
      });

      it("is not started on an asking for a place that was never answered, once it may no longer be: the limit there has become none, or its hour has run out", async () => {
        for (const how of ["none", "late"] as const) {
          await within(async ({ tasks, kept, store, worker, slots, events }) => {
            const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
            const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
            worker.left[a.task_id] = left(a.task_id);
            await tasks.event(a.task_id, 1, "result", { text: "ok" });
            slots.acquire = async () => {
              throw new Error("registry unreachable");
            };
            await tasks.settle();
            expect(kept(b.task_id).status).toBe("dispatching");
            // Meanwhile what let it be started no longer holds; the registry answers again, and has room.
            if (how === "none") store.setMeta("limits", JSON.stringify({ scope_active_tasks: 0 }));
            else store.sql.exec("UPDATE tasks SET updated_at = ? WHERE id = ?", Date.now() - 61 * 60_000, a.task_id);
            slots.acquire = async () => true;
            const begun = worker.started.length;
            due(store);
            await tasks.settle();
            expect(worker.started).toHaveLength(begun);
            expect(kept(b.task_id).status).toBe("failed");
            expect(JSON.parse(kept(b.task_id).result).error).toContain(how === "none" ? "the limit set for this place is none" : "no place came free for it in an hour");
            // A place the unanswered asking may have taken is given back.
            expect(slots.released).toContain(b.task_id);
            expect(events().at(-1)).toMatchObject({ kind: "worker.failed" });
          });
        }
      });

      it("writes down that a place is owed back before anything else can go wrong, and does not let a piece through on a place that is on its way out", async () => {
        await within(async ({ tasks, kept, store, worker, slots, host }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          // What A left is not kept, so B's start is refused; and the Brain fails right after ending B (the wake-up throws).
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          const wake = host.wakeBy;
          host.wakeBy = async () => {
            throw new Error("the Brain was replaced");
          };
          await tasks.settle().catch(() => undefined);
          host.wakeBy = wake;
          expect(kept(b.task_id).status).toBe("failed");
          // Nothing was given back yet, but it is owed, and is given back on the next pass.
          expect(slots.released).not.toContain(b.task_id);
          expect(store.rows("SELECT task_id FROM task_releases")).toEqual([{ task_id: b.task_id }]);
          store.sql.exec("UPDATE task_releases SET next_at = 0");
          await tasks.settle();
          expect(slots.released).toContain(b.task_id);
          expect(store.rows("SELECT 1 FROM task_releases")).toEqual([]);

          // A place was granted and the answer lost; then there is no room here; then it is called off while it waits: the place is given back.
          const c = (await tasks.dispatch(RUN, SESSION_KEY, "call_c", "sandbox", "C", "c", REPO)) as { task_id: string };
          const d = (await tasks.dispatch(RUN, SESSION_KEY, "call_d", "sandbox", "D", "d", { repository: null }, c.task_id)) as { task_id: string };
          worker.left[c.task_id] = left(c.task_id);
          await tasks.event(c.task_id, 1, "result", { text: "ok" });
          slots.acquire = async () => {
            throw new Error("the answer was lost");
          };
          await tasks.settle();
          expect(kept(d.task_id).status).toBe("dispatching");
          slots.acquire = async () => true;
          const others = ["x1", "x2"].map((id) => `t_${id}`);
          for (const id of others) store.sql.exec("INSERT INTO tasks (id, op_id, worker, title, brief, session_key, status, created_at, updated_at) VALUES (?, ?, 'sandbox', 't', 'b', ?, 'running', 0, 0)", id, id, SESSION_KEY);
          store.setMeta("limits", JSON.stringify({ scope_active_tasks: 2 }));
          due(store);
          await tasks.settle();
          expect(kept(d.task_id).status).toBe("queued");
          expect(slots.released).toContain(d.task_id);
          const begun = worker.started.length;
          // What was given back is the taking that was asked for (the same lease, however often it was asked); the next asking is another.
          const of = slots.leases.filter((each) => each[1] === d.task_id);
          const first = of.find((each) => each[0] === "take")![2];
          expect(first).toMatch(/^[0-9a-f-]{36}$/);
          expect(of.filter((each) => each[0] === "take").every((each) => each[2] === first)).toBe(true);
          expect(of.find((each) => each[0] === "back")![2]).toBe(first);
          store.setMeta("limits", JSON.stringify({ scope_active_tasks: 3 }));
          due(store);
          await tasks.settle();
          expect(kept(d.task_id).status).toBe("running");
          const again = slots.leases.filter((each) => each[1] === d.task_id && each[0] === "take").at(-1)![2];
          expect(again).not.toBe(first);
          await tasks.cancel(SESSION_KEY, d.task_id);
          expect(store.rows("SELECT 1 FROM task_releases")).toEqual([]);
          void begun;
        });
      });

      it("comes back to a place it could not give back at a time set afresh each time, never at once over and over", async () => {
        await within(async ({ tasks, store, slots }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          slots.release = async () => {
            throw new Error("registry unreachable");
          };
          await tasks.settle();
          const next = () => store.rows<{ next_at: number }>("SELECT next_at FROM task_releases WHERE task_id = ?", b.task_id)[0].next_at;
          for (let n = 0; n < 3; n++) {
            store.sql.exec("UPDATE task_releases SET next_at = 0");
            await tasks.settle();
            // Still owed, and due in a while: the Brain is not woken for it at once.
            expect(next()).toBeGreaterThan(Date.now() + 10_000);
            expect(tasks.nextWakeAt(Date.now())).toBeGreaterThan(Date.now() + 10_000);
          }
        });
      });

      it("owes back the taking a waiting piece asked for, by its lease, when it is called off or ends with that asking perhaps still on its way", async () => {
        await within(async ({ tasks, kept, store, worker, slots }) => {
          const leaseOf = (id: string) => slots.leases.filter((each) => each[1] === id && each[0] === "take").at(-1)?.[2];
          const backs = (id: string) => slots.leases.filter((each) => each[1] === id && each[0] === "back").map((each) => each[2]);
          // Called off while it is being started: the asking for a place was never answered (it may yet arrive).
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          worker.left[a.task_id] = left(a.task_id);
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          slots.acquire = async () => {
            throw new Error("the answer was lost");
          };
          await tasks.settle();
          expect(kept(b.task_id).status).toBe("dispatching");
          const asked = leaseOf(b.task_id);
          expect(asked).toMatch(/^[0-9a-f-]{36}$/);
          slots.acquire = async () => true;
          await tasks.cancel(SESSION_KEY, b.task_id);
          expect(kept(b.task_id).status).toBe("cancelled");
          // Owed by that lease at once (written before anything was awaited), and given back by it on the next pass.
          expect(store.rows("SELECT lease FROM task_releases WHERE task_id = ?", b.task_id)).toEqual([{ lease: asked }]);
          store.sql.exec("UPDATE task_releases SET next_at = 0");
          await tasks.settle();
          expect(backs(b.task_id)).toContain(asked);
          expect(store.rows("SELECT 1 FROM task_releases")).toEqual([]);
          expect(store.rows("SELECT 1 FROM task_queued")).toEqual([]);

          // Ended some other way while out of waiting, found so by a later pass (as after the Brain was replaced): owed the same.
          const c = (await tasks.dispatch(RUN, SESSION_KEY, "call_c", "sandbox", "C", "c", REPO)) as { task_id: string };
          const d = (await tasks.dispatch(RUN, SESSION_KEY, "call_d", "sandbox", "D", "d", { repository: null }, c.task_id)) as { task_id: string };
          worker.left[c.task_id] = left(c.task_id);
          await tasks.event(c.task_id, 1, "result", { text: "ok" });
          slots.acquire = async () => {
            throw new Error("the answer was lost");
          };
          await tasks.settle();
          const lease = leaseOf(d.task_id);
          store.sql.exec("UPDATE tasks SET status = 'cancelled' WHERE id = ?", d.task_id);
          store.sql.exec("UPDATE task_queued SET next_at = 0");
          await tasks.settle();
          expect(backs(d.task_id)).toContain(lease);
          expect(store.rows("SELECT 1 FROM task_queued")).toEqual([]);

          // Called off while it waits again after an asking that was never answered.
          slots.acquire = async () => true;
          const e = (await tasks.dispatch(RUN, SESSION_KEY, "call_e", "sandbox", "E", "e", REPO)) as { task_id: string };
          const f = (await tasks.dispatch(RUN, SESSION_KEY, "call_f", "sandbox", "F", "f", { repository: null }, e.task_id)) as { task_id: string };
          await tasks.settle();
          store.sql.exec("UPDATE task_queued SET lease = 'left-over' WHERE task_id = ?", f.task_id);
          await tasks.cancel(SESSION_KEY, f.task_id);
          expect(store.rows("SELECT lease FROM task_releases WHERE task_id = ?", f.task_id)).toEqual([{ lease: "left-over" }]);
          // And asked how it stands, a waiting piece says what it waits for.
          const g = (await tasks.dispatch(RUN, SESSION_KEY, "call_g", "sandbox", "G", "g", { repository: null }, e.task_id)) as { task_id: string };
          expect(await tasks.status(g.task_id)).toMatchObject({ status: "queued", queued_after: e.task_id });
        });
      });

      it("does not wait on a place being given back either: that is written down, tried within the pass's time, and tried again by its id", async () => {
        await within(async ({ tasks, kept, store, worker, slots }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          // What A left is not kept, so B's start is turned down; and the registry is slow to take the place back.
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          vi.useFakeTimers();
          try {
            slots.release = () => new Promise(() => undefined);
            const began = Date.now();
            const pass = tasks.settle();
            await vi.advanceTimersByTimeAsync(9_000);
            await pass;
            expect(Date.now() - began).toBeLessThan(9_500);
            expect(kept(b.task_id).status).toBe("failed");
            expect(store.rows("SELECT task_id FROM task_releases")).toEqual([{ task_id: b.task_id }]);
            expect(tasks.nextWakeAt(Date.now())).not.toBeNull();
            // It answers on a later pass: given back, and no longer owed.
            slots.release = async () => undefined;
            store.sql.exec("UPDATE task_releases SET next_at = 0");
            const again = tasks.settle();
            await vi.advanceTimersByTimeAsync(100);
            await again;
            expect(slots.released).toContain(b.task_id);
            expect(store.rows("SELECT 1 FROM task_releases")).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        });
      });

      it("gives the one behind it an end to its waiting when it is let through, so that a line does not wait on a time set before", async () => {
        await within(async ({ tasks, kept, store, worker }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const b = (await tasks.dispatch(RUN, SESSION_KEY, "call_b", "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
          const c = (await tasks.dispatch(RUN, SESSION_KEY, "call_c", "sandbox", "C", "c", { repository: null }, b.task_id)) as { task_id: string };
          const next = () => store.rows<{ next_at: number }>("SELECT next_at FROM task_queued WHERE task_id = ?", c.task_id)[0].next_at;
          await tasks.settle();
          const while_waiting = next();
          worker.left[a.task_id] = left(a.task_id);
          await tasks.event(a.task_id, 1, "result", { text: "ok" });
          await tasks.settle();
          expect(kept(b.task_id).status).toBe("running");
          await tasks.settle();
          // C now waits until a little past the latest B could still be running, by B's own watchdog.
          const watched = store.rows<{ due_at: number }>("SELECT due_at FROM timers WHERE id = ?", `watch_${b.task_id}`)[0].due_at;
          expect(next()).toBe(watched + 5 * 60_000);
          expect(next()).not.toBe(while_waiting);
          // B never ends: past that moment C gives up.
          store.sql.exec("UPDATE timers SET due_at = ? WHERE id = ?", Date.now() - 6 * 60_000, `watch_${b.task_id}`);
          due(store);
          await tasks.settle();
          expect(kept(c.task_id).status).toBe("failed");
        });
      });

      it("does not keep the Brain from its conversations for workers that do not answer: one pass has a time of its own, and what it did not get to is looked at again soon", async () => {
        await within(async ({ tasks, kept, store, worker, woken }) => {
          const firsts: string[] = [];
          for (const n of [1, 2, 3]) {
            const a = (await tasks.dispatch(RUN, SESSION_KEY, `call_a${n}`, "sandbox", "A", "a", REPO)) as { task_id: string };
            const b = (await tasks.dispatch(RUN, SESSION_KEY, `call_b${n}`, "sandbox", "B", "b", { repository: null }, a.task_id)) as { task_id: string };
            worker.left[a.task_id] = left(a.task_id);
            await tasks.event(a.task_id, 1, "result", { text: "ok" });
            firsts.push(b.task_id);
          }
          vi.useFakeTimers();
          try {
            worker.start = () => new Promise(() => undefined);
            const began = Date.now();
            let over = false;
            const pass = tasks.settle().then(() => (over = true));
            await vi.advanceTimersByTimeAsync(8_500);
            await pass;
            expect(over).toBe(true);
            expect(Date.now() - began).toBeLessThan(9_000);
            // None was answered: all are as they were left, and the pass asked to be woken again soon.
            expect(firsts.map((id) => kept(id).status).every((status) => status === "dispatching" || status === "queued")).toBe(true);
            expect(woken.at(-1)).toBeLessThan(Date.now() + 20_000);
            expect(tasks.nextWakeAt(Date.now())).not.toBeNull();
          } finally {
            vi.useRealTimers();
          }
        });
      });

      it("is for the same person, worker and conversation as going on from finished work; has a bound on how many wait; and gives up waiting in the end", async () => {
        await within(async ({ tasks, kept, store, settings, task }) => {
          const a = (await tasks.dispatch(RUN, SESSION_KEY, "call_a", "sandbox", "A", "a", REPO)) as { task_id: string };
          const alice = settings.deciders;
          settings.deciders = [{ kind: "human", id: "bob", explicit: true }];
          await expect(tasks.dispatch(RUN, SESSION_KEY, "call_x", "sandbox", "t", "b", { repository: null }, a.task_id)).rejects.toThrow("there is no piece of work");
          settings.deciders = alice;
          task("t_elsewhere", { status: "running", session_key: "thread:other" });
          await expect(tasks.dispatch(RUN, SESSION_KEY, "call_y", "sandbox", "t", "b", { repository: null }, "t_elsewhere")).rejects.toThrow("there is no piece of work");
          // Five may wait in a conversation, in a line; a sixth is refused.
          let tail = a.task_id;
          for (let n = 0; n < 5; n++) tail = ((await tasks.dispatch(RUN, SESSION_KEY, `call_q${n}`, "sandbox", "t", "b", { repository: null }, tail)) as { task_id: string }).task_id;
          await expect(tasks.dispatch(RUN, SESSION_KEY, "call_q5", "sandbox", "t", "b", { repository: null }, tail)).rejects.toThrow("already waiting");
          // Those that wait do not count as tasks at it: something new is still taken (the limit of three is of those running).
          expect(await tasks.dispatch(RUN, SESSION_KEY, "call_new", "sandbox", "t", "b", REPO)).toMatchObject({ status: "running" });
          // The one before the first in line never ends: past the longest it could have run, the first gives up, and so the rest.
          const first = store.rows<{ task_id: string }>("SELECT task_id FROM task_follows WHERE from_id = ?", a.task_id)[0].task_id;
          store.sql.exec("UPDATE timers SET due_at = ? WHERE id = ?", Date.now() - 6 * 60_000, `watch_${a.task_id}`);
          due(store);
          await tasks.settle();
          expect(kept(first).status).toBe("failed");
          expect(JSON.parse(kept(first).result).error).toContain("waited");
          expect(kept(tail).status).toBe("failed");
        });
      });
    });

    it("is not stopped by work whose worker has been taken out of the deployment altogether: that work is said to be what it is, and the rest goes on", async () => {
      await within(async ({ tasks, store, kept, settings, worker, slots, task }) => {
        // One that finished, one whose start was never answered, one that is running: all the sandbox's.
        const done = (await tasks.dispatch(RUN, SESSION_KEY, "call_done", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        await tasks.event(done.task_id, 1, "result", { text: "ok" });
        worker.start = async () => {
          throw new Error("connection reset");
        };
        const unanswered = (await tasks.dispatch(RUN, SESSION_KEY, "call_un", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        worker.start = async () => ({ phase: "running" });
        const running = (await tasks.dispatch(RUN, SESSION_KEY, "call_run", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        // The sandbox is removed: neither offered nor retired.
        settings.workers = [];
        settings.gone = ["sandbox"];

        // The call that made the finished one, made again: told as it ended, without its worker being looked for.
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_done", "sandbox", "t", "b", { repository: null })).toMatchObject({ task_id: done.task_id, status: "succeeded" });
        // The one that was not confirmed: its worker cannot be asked, which is taken as no answer, tried again later, and given up after its tries.
        for (let n = 0; n < 5; n++) {
          store.sql.exec("UPDATE unconfirmed SET next_at = 0");
          await tasks.settle();
          expect(store.rows<{ attempts: number }>("SELECT attempts FROM unconfirmed")[0].attempts).toBe(n + 1);
        }
        store.sql.exec("UPDATE unconfirmed SET next_at = 0");
        await tasks.settle();
        expect(kept(unanswered.task_id).status).toBe("lost");
        // The one that is running still takes its report, and gives its place back.
        await tasks.event(running.task_id, 1, "result", { text: "late but fine" });
        expect(kept(running.task_id).status).toBe("succeeded");
        expect(slots.released).toContain(running.task_id);
        // One that was written and never got as far as being started, its call made again now: not left as it is for ever. It is
        // kept as not confirmed, given up in its time, and its place here is free again for other work.
        task("t_mid", { status: "dispatching" });
        store.sql.exec("UPDATE tasks SET op_id = 'call_mid' WHERE id = 't_mid'");
        expect(await tasks.dispatch(RUN, SESSION_KEY, "call_mid", "sandbox", "t", "b", { repository: null })).toMatchObject({ task_id: "t_mid", status: "unconfirmed" });
        for (let n = 0; n < 6; n++) {
          store.sql.exec("UPDATE unconfirmed SET next_at = 0");
          await tasks.settle();
        }
        expect(kept("t_mid").status).toBe("lost");
        expect(store.rows("SELECT 1 FROM unconfirmed")).toEqual([]);
        // And one that is asked to stop cannot be, which is said as that.
        const other = (await (async () => {
          settings.gone = [];
          settings.workers = ["sandbox"];
          const made = (await tasks.dispatch(RUN, SESSION_KEY, "call_other", "sandbox", "t", "b", { repository: null })) as { task_id: string };
          settings.workers = [];
          settings.gone = ["sandbox"];
          return made;
        })()) as { task_id: string };
        await expect(tasks.cancel(SESSION_KEY, other.task_id)).rejects.toThrow("is no longer part of this deployment, so it cannot be asked to stop");
        expect(kept(other.task_id).status).toBe("running");
      });
    });

    it("takes nothing new where the deployment lists no such worker, writes nothing for it, and still stops a task taken before", async () => {
      await within(async ({ tasks, store, kept, settings, worker, slots }) => {
        // Started while the worker was listed.
        const before = (await tasks.dispatch(RUN, SESSION_KEY, "call_0", "sandbox", "t", "b", { repository: null })) as { task_id: string };
        settings.workers = [];
        await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })).rejects.toThrow("this deployment has no worker to hand this to");
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
        const result = (await tasks.dispatch(RUN, SESSION_KEY, "op_t_before", "sandbox", "t", "b", { repository: null })) as { task_id: string; status: string };
        expect(result).toEqual({ task_id: "t_before", status: "running" });
        expect(worker.started).toMatchObject([{ id: "t_before" }]);
        expect(kept("t_before")).toMatchObject({ status: "running" });
      });
    });

    it("fails the task with the worker's own reason when the sandbox did not start", async () => {
      for (const phase of ["failed", "lost"]) {
        await within(async ({ tasks, store, kept, slots, worker }) => {
          worker.start = async () => ({ phase, error: "image missing" });
          await expect(tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })).rejects.toThrow("the worker did not start: image missing");
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
        const result = (await tasks.dispatch(RUN, SESSION_KEY, "call_1", "sandbox", "t", "b", { repository: null })) as { task_id: string };
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
        await expect(tasks.status("nope")).rejects.toThrow("there is no piece of work nope here");
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
        expect(events().map((each) => each.text)).toEqual(['Task t1 "Title of t1" failed: tests failed', 'Task t2 "Title of t2" was lost: it stopped where it was running and could not be restored.']);
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
