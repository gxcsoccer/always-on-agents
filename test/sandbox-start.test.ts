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
  },
  DirectoryBackupGateway: class {},
}));

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
  return { task: new TaskSandbox(ctx as never, env as never), container, reported, background, records, process };
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
