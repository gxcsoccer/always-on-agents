import { expect, it, describe, vi } from "vitest";

import { TaskSandbox } from "../src/workers/sandbox/task";

/**
 * The sandbox task's own part in starting and stopping, on the real class with stand-ins for
 * what it runs on: its storage, its container, and the Brain it reports to. No container runs.
 */
vi.mock("cloudflare:workers", async (original) => ({
  ...(await original<typeof import("cloudflare:workers")>()),
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock("@cloudflare/sandbox", () => ({
  Files: class {
    async mkdir() {}
    async remove() {}
  },
  DirectoryBackup: class {
    constructor(
      _container: unknown,
      _gateway: unknown,
      private where: { prefix: string },
    ) {}
    async intercept() {}
    async restore(record: { id: string }, into: { dir: string }) {
      backups.restored.push({ prefix: this.where.prefix, id: record.id, dir: into.dir });
      await restoring.now?.();
    }
    async backup() {
      await backups.whileTaking?.();
      backups.taken += 1;
      return { id: `taken-${backups.taken}` };
    }
    async delete(record: { id: string }) {
      if (backups.deleteFails) throw new Error("storage unavailable");
      backups.deleted.push(record.id);
    }
  },
  DirectoryBackupGateway: class {},
}));

/** What was asked of the store of checkpoints: copies taken, restored (from whose, which, to where) and removed. */
const backups = { taken: 0, restored: [] as { prefix: string; id: string; dir: string }[], deleted: [] as string[], whileTaking: undefined as (() => Promise<void>) | undefined, deleteFails: false };
/** Something that happens while a checkpoint is being restored, for the fixture that is restoring. */
const restoring: { now?: () => Promise<void> } = {};

function fixture() {
  const records = new Map<string, any>();
  const kv = { get: (key: string) => structuredClone(records.get(key)), put: (key: string, value: unknown) => void records.set(key, structuredClone(value)) };
  /** What the task reported to its Brain, by kind. */
  const reported: string[] = [];
  const background: Promise<unknown>[] = [];
  const ok = async () => {};
  const process = { output: async () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }) };
  const container = {
    running: false,
    images: { sandbox: "image" },
    start() {
      this.running = true;
    },
    async destroy() {
      this.running = false;
    },
    interceptOutboundHttp: ok,
    interceptAllOutboundHttp: ok,
    interceptOutboundHttps: ok,
    setInactivityTimeout: ok,
    exec: async (_argv: string[]) => process,
  };
  const ctx = { storage: { kv, setAlarm: ok }, container, waitUntil: (work: Promise<unknown>) => void background.push(work), id: { name: "fixture" }, exports: { Outbound: () => ({}), DirectoryBackupGateway: {} } };
  const env = { BRAIN: { getByName: () => ({ taskEvent: async (_id: string, _seq: number, kind: string) => void reported.push(kind) }) } };
  restoring.now = undefined;
  Object.assign(backups, { taken: 0, restored: [], deleted: [], whileTaking: undefined, deleteFails: false });
  return {
    task: new TaskSandbox(ctx as never, env as never),
    container,
    reported,
    background,
    records,
    process,
    set restoring(what: () => Promise<void>) {
      restoring.now = what;
    },
  };
}

/** A container whose agent has ended as told: what the task reads of its files, and every command it was given. */
function ended(container: { exec: (argv: string[]) => Promise<unknown> }, how: { code: string; events: object[] }) {
  const commands: string[][] = [];
  const out = (text: string | undefined) => ({ output: async () => ({ exitCode: text === undefined ? 1 : 0, stdout: new TextEncoder().encode(text ?? ""), stderr: new Uint8Array() }) });
  container.exec = async (argv) => {
    commands.push(argv);
    if (argv[0] !== "tail") return out("");
    const path = argv.at(-1)!;
    return out(path.endsWith("/exit-code") ? how.code : path.endsWith("/events.jsonl") ? how.events.map((each) => JSON.stringify(each)).join("\n") : undefined);
  };
  return commands;
}
const DONE = [{ type: "session", id: "s1" }, { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }, { type: "agent_settled" }];

describe("a sandbox task that a later one goes on from", () => {
  it("keeps its workspace as it was when it ended well, and hands that out; one that did not end well keeps nothing to go on from", async () => {
    const good = fixture();
    await good.task.start({ id: "fixture", prompt: "hello", brain: "brain", repository: "https://github.com/acme/app" });
    expect(await good.task.snapshot()).toBeNull();
    ended(good.container, { code: "0", events: DONE });
    await good.task.alarm();
    expect(await good.task.status()).toMatchObject({ phase: "succeeded", checkpoint: { record: { id: "taken-1" }, final: true } });
    expect(await good.task.snapshot()).toMatchObject({ record: { id: "taken-1" }, cwd: "/workspace/job/repo", repository: "https://github.com/acme/app" });
    // Not handed out in its last minutes before it is removed.
    const state = good.records.get("state");
    state.finished_at = Date.now() - (24 * 60 * 60_000 - 60_000);
    good.records.set("state", state);
    expect(await good.task.snapshot()).toBeNull();

    // The agent exited cleanly but its last word was an error: the copy taken is put with those to be removed, and nothing is handed out.
    const bad = fixture();
    await bad.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    ended(bad.container, { code: "0", events: [{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "model failed", content: [] } }, { type: "agent_settled" }] });
    await bad.task.alarm();
    expect(await bad.task.status()).toMatchObject({ phase: "failed", stale_checkpoints: [{ id: "taken-1" }] });
    expect((await bad.task.status() as any).checkpoint).toBeUndefined();
    expect(await bad.task.snapshot()).toBeNull();

    // One that exited with an error has no copy taken at all.
    const failed = fixture();
    await failed.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    ended(failed.container, { code: "1", events: [] });
    await failed.task.alarm();
    expect(await failed.task.status()).toMatchObject({ phase: "failed" });
    expect(backups.taken).toBe(0);
  });

  it("starts from what an earlier task left: its workspace brought into this task's own container, nothing fetched, the agent's session carried on with what is asked now", async () => {
    const { task, container } = fixture();
    const commands = ended(container, { code: "0", events: DONE });
    const started = await task.start({ id: "fixture", prompt: "add tests", brain: "brain", seed: { from: "earlier", record: { id: "kept", dir: "/workspace/job" } as never, cwd: "/workspace/job/repo", repository: "https://github.com/acme/app" } });
    expect(started.phase).toBe("running");
    expect(await task.status()).toMatchObject({ phase: "running", follows: "earlier", cwd: "/workspace/job/repo", repository: "https://github.com/acme/app", runs: [{ kind: "follow_up" }] });
    // Read from the earlier task's own place, into this one's workspace.
    expect(backups.restored).toEqual([{ prefix: "tasks/earlier/", id: "kept", dir: "/workspace/job" }]);
    // Nothing is cloned; the agent is started on its earlier session, told that it goes on, with what is asked now.
    const flat = commands.map((each) => each.join(" "));
    expect(flat.some((each) => each.includes("git clone") || each.includes("git fetch"))).toBe(false);
    const launch = flat.find((each) => each.includes("--continue"));
    expect(launch).toBeDefined();
    expect(launch).toContain("add tests");
    expect(launch).toContain("Nothing that was approved then is approved now");
    // Bringing the earlier workspace in used up this task's life: the agent is not started, and the task ends for that.
    const slow = fixture();
    const given = ended(slow.container, { code: "0", events: DONE });
    slow.restoring = async () => {
      const state = slow.records.get("state");
      state.created_at -= 301_000;
      slow.records.set("state", state);
    };
    expect(await slow.task.start({ id: "fixture", prompt: "x", brain: "brain", bounds: { lifetime_ms: 300_000 }, seed: { from: "earlier", record: { id: "kept" } as never, cwd: "/workspace/job/scratch" } })).toMatchObject({ phase: "failed", error: expect.stringContaining("exceeded the maximum lifetime") });
    expect(given.some((each) => each.join(" ").includes("--continue"))).toBe(false);
    Object.assign(backups, { taken: 0, restored: [], deleted: [] });

    // And what it leaves in its turn is its own.
    await task.alarm();
    expect(await task.snapshot()).toMatchObject({ record: { id: "taken-1" }, cwd: "/workspace/job/repo" });
  });
});

describe("a sandbox task stopped while its last copy was being taken", () => {
  it("writes the copy down as one to remove, and keeps it written down when removing it fails", async () => {
    const { task, container, records } = fixture();
    await task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    ended(container, { code: "0", events: DONE });
    backups.whileTaking = async () => void (await task.cancel());
    backups.deleteFails = true;
    await task.alarm();
    expect(records.get("state")).toMatchObject({ phase: "cancelled", stale_checkpoints: [{ id: "taken-1" }] });
    expect(backups.deleted).toEqual([]);
  });
});

describe("a sandbox task whose agent ended just inside its life", () => {
  it("is not ended for its life while what it left is being copied, and the copy is taken once", async () => {
    const { task, container, records } = fixture();
    await task.start({ id: "fixture", prompt: "hello", brain: "brain", bounds: { lifetime_ms: 300_000 } });
    ended(container, { code: "0", events: DONE });
    backups.whileTaking = async () => {
      backups.whileTaking = undefined;
      // Its life runs out during the copying, and the watchdog comes round.
      const state = records.get("state");
      state.created_at = Date.now() - 301_000;
      records.set("state", state);
      await task.alarm();
      expect(records.get("state").phase).toBe("running");
    };
    await task.alarm();
    expect(records.get("state")).toMatchObject({ phase: "succeeded", checkpoint: { final: true } });
    expect(backups.taken).toBe(1);
  });
});

describe("a sandbox task, started and stopped", () => {
  it("turns away a start that arrives after it was stopped, or asked about and found absent", async () => {
    const stopped = fixture();
    expect(await stopped.task.cancel()).toEqual({ ok: true });
    expect(await stopped.task.start({ id: "fixture", prompt: "hello" })).toMatchObject({ phase: "failed", error: expect.stringContaining("closed before it started") });
    expect(stopped.container.running).toBe(false);

    const asked = fixture();
    expect(await asked.task.claimed()).toBe("none");
    expect((await asked.task.start({ id: "fixture", prompt: "hello" })).phase).toBe("failed");
    expect(asked.container.running).toBe(false);
    // And it stays so, however often it is asked or started.
    expect(await asked.task.claimed()).toBe("none");
    expect((await asked.task.start({ id: "fixture", prompt: "hello" })).phase).toBe("failed");
  });

  it("says that it has a task once it took it, whatever has become of it, also one that failed with an error", async () => {
    const { task, container } = fixture();
    container.exec = async () => {
      throw new Error("set-up failed");
    };
    expect((await task.start({ id: "fixture", prompt: "hello", brain: "brain" })).phase).toBe("failed");
    expect(await task.status()).toMatchObject({ phase: "failed", error: expect.stringContaining("set-up failed") });
    expect(await task.claimed()).toBe("there");
    // The same start asked for again is the same one: it says how it stands and starts nothing.
    expect((await task.start({ id: "fixture", prompt: "hello", brain: "brain" })).phase).toBe("failed");
  });

  it("does not take, for the first time, a start that arrives after the time it was given; one already taken is answered as it stands", async () => {
    const late = fixture();
    expect(await late.task.start({ id: "fixture", prompt: "hello", accept_by: Date.now() - 1 })).toMatchObject({ phase: "failed", error: expect.stringContaining("too late") });
    expect(late.container.running).toBe(false);
    // Closed by that: a start with more time, arriving after, is turned away too.
    expect((await late.task.start({ id: "fixture", prompt: "hello", accept_by: Date.now() + 60_000 })).phase).toBe("failed");

    const taken = fixture();
    expect((await taken.task.start({ id: "fixture", prompt: "hello", accept_by: Date.now() + 60_000 })).phase).toBe("running");
    // The repeat of a start that was taken in time, arriving after that time: the same task, as it stands.
    expect((await taken.task.start({ id: "fixture", prompt: "hello", accept_by: Date.now() - 1 })).phase).toBe("running");
  });

  it("reports a start that fails, as well as answering it", async () => {
    const { task, container, reported, background } = fixture();
    container.exec = async () => {
      throw new Error("set-up failed");
    };
    expect((await task.start({ id: "fixture", prompt: "hello", brain: "brain" })).phase).toBe("failed");
    await Promise.all(background);
    expect(reported).toEqual(["failed"]);
  });

  it("leaves a task as its watchdog ended it, when the launch it was waiting for comes back afterwards", async () => {
    const { task, container, reported, records, process } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    container.exec = async (argv) => {
      if (argv[0] === "/bin/sh") {
        entered.resolve();
        await release.promise;
      }
      return process;
    };
    const pending = task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    await entered.promise;
    // It has been starting for longer than it may: the watchdog ends it and reports that.
    const state = records.get("state");
    state.starting_since = Date.now() - 6 * 60_000;
    records.set("state", state);
    await task.alarm();
    expect(reported).toContain("failed");
    expect(((await task.status()) as { phase: string }).phase).toBe("failed");
    // The launch comes back: it does not make the task run after all.
    release.resolve();
    expect((await pending).phase).toBe("failed");
    expect(((await task.status()) as { phase: string }).phase).toBe("failed");
    expect(reported.filter((each) => each === "failed")).toHaveLength(1);
  });

  it("goes by the bounds it was given when it started, and by its own where it was given none", async () => {
    // How often it may ask the model. (Started with no Brain to report to, so nothing else is asked.)
    const bounded = fixture();
    expect((await bounded.task.start({ id: "fixture", prompt: "hello", bounds: { model_calls: 2 } })).phase).toBe("running");
    expect([await bounded.task.countModelCall(), await bounded.task.countModelCall(), await bounded.task.countModelCall()]).toEqual([true, true, false]);
    // The same start asked for again with other bounds: the same task, by the bounds it has.
    await bounded.task.start({ id: "fixture", prompt: "hello", bounds: { model_calls: 99 } });
    expect(await bounded.task.countModelCall()).toBe(false);
    expect(((await bounded.task.status()) as { bounds?: unknown }).bounds).toEqual({ model_calls: 2 });

    // How long it may live: past the time it was given it is ended, though well within the fixed two hours.
    const brief = fixture();
    await brief.task.start({ id: "fixture", prompt: "hello", brain: "brain", bounds: { lifetime_ms: 10 * 60_000 } });
    const state = brief.records.get("state");
    state.created_at = Date.now() - 11 * 60_000;
    brief.records.set("state", state);
    await brief.task.alarm();
    expect(await brief.task.status()).toMatchObject({ phase: "failed", error: "exceeded the maximum lifetime" });

    // Starting again after its container was lost, with its whole life already over: ended for that, however fresh this start is.
    const again = fixture();
    await again.task.start({ id: "fixture", prompt: "hello", brain: "brain", bounds: { lifetime_ms: 5 * 60_000 } });
    const starting = again.records.get("state");
    starting.phase = "starting";
    starting.created_at = Date.now() - 6 * 60_000;
    starting.starting_since = Date.now() - 2 * 60_000;
    again.records.set("state", starting);
    await again.task.alarm();
    expect(await again.task.status()).toMatchObject({ phase: "failed", error: "exceeded the maximum lifetime" });
    expect(await again.task.countModelCall()).toBe(false);

    // Brought back from a checkpoint with a moment of its life left, and the bringing back takes longer than that:
    // it is not started again, no recovery is reported, and no further call to the model is let through.
    const late = fixture();
    await late.task.start({ id: "fixture", prompt: "hello", brain: "brain", bounds: { lifetime_ms: 5 * 60_000 } });
    const lost = late.records.get("state");
    lost.created_at = Date.now() - (5 * 60_000 - 1_000);
    lost.checkpoint = { record: { id: "cp" }, at: Date.now() - 60_000, took_ms: 10 };
    late.records.set("state", lost);
    late.container.running = false;
    const launches: string[] = [];
    late.container.exec = async (argv) => (argv[0] === "/bin/sh" && launches.push("agent"), late.process);
    late.restoring = async () => {
      const state = late.records.get("state");
      state.created_at -= 2_000;
      late.records.set("state", state);
    };
    await late.task.alarm();
    await Promise.all(late.background);
    expect(launches).toEqual([]);
    expect(await late.task.status()).toMatchObject({ phase: "failed", error: "exceeded the maximum lifetime" });
    expect(late.reported).not.toContain("recovered");
    expect(await late.task.countModelCall()).toBe(false);

    // Given none, or nothing that is a bound: its own.
    const plain = fixture();
    await plain.task.start({ id: "fixture", prompt: "hello", bounds: { lifetime_ms: -5, model_calls: 1.5 } as never });
    expect(((await plain.task.status()) as { bounds?: unknown }).bounds).toBeUndefined();
    // Eleven minutes old, it is not ended for its age: whatever its watchdog makes of it, that is not why.
    const old = plain.records.get("state");
    old.created_at = Date.now() - 11 * 60_000;
    plain.records.set("state", old);
    await plain.task.alarm();
    expect(((await plain.task.status()) as { error?: string }).error).not.toBe("exceeded the maximum lifetime");
  });

  it("does not go on to launch a task that was stopped while it was being set up", async () => {
    const { task, container, process } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const launched: string[] = [];
    container.exec = async (argv) => {
      if (argv[0] === "git") {
        entered.resolve();
        await release.promise;
      }
      if (argv[0] === "/bin/sh") launched.push("agent");
      return process;
    };
    const pending = task.start({ id: "fixture", prompt: "hello", repository: "https://github.com/acme/app" });
    await entered.promise;
    expect(await task.cancel()).toEqual({ ok: true });
    release.resolve();
    expect((await pending).phase).toBe("cancelled");
    expect(launched).toEqual([]);
    expect(((await task.status()) as { phase: string }).phase).toBe("cancelled");
  });
});
