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
    async intercept() {}
    async restore() {
      await restoring.now?.();
    }
    async backup() {
      return { id: "taken" };
    }
    async delete() {}
  },
  DirectoryBackupGateway: class {},
}));

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
