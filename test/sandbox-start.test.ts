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
/** What the connector that lends a person's authorisation answers, and what it was asked. */
const lending = { asked: [] as { lend: any; task: any }[], answer: (async () => "ghu_person") as () => Promise<string | undefined> };
vi.mock("../src/connectors/github-lend", async (original) => ({
  ...(await original<typeof import("../src/connectors/github-lend")>()),
  lentToken: async (_env: unknown, lend: unknown, task: unknown) => (lending.asked.push({ lend, task }), lending.answer()),
}));
vi.mock("@cloudflare/sandbox", () => ({
  Files: class {
    // As the real one: making a directory that is there already fails, unless asked to accept it.
    async mkdir(path: string, options?: { recursive?: boolean }) {
      if (backups.there.has(path) && !options?.recursive) throw new Error(`SandboxFileError: mkdir '${path}': File exists (os error 17)`);
      backups.there.add(path);
    }
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
      // What a workspace holds comes back with it.
      for (const each of [into.dir, `${into.dir}/task`, `${into.dir}/repo`]) backups.there.add(each);
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
const backups = { taken: 0, restored: [] as { prefix: string; id: string; dir: string }[], deleted: [] as string[], there: new Set<string>(), whileTaking: undefined as (() => Promise<void>) | undefined, deleteFails: false };
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
  const bodies: any[] = [];
  const env = { BRAIN: { getByName: () => ({ taskEvent: async (_id: string, _seq: number, kind: string, body: unknown) => (bodies.push(body), void reported.push(kind)) }) } };
  restoring.now = undefined;
  Object.assign(backups, { taken: 0, restored: [], deleted: [], there: new Set<string>(), whileTaking: undefined, deleteFails: false });
  return {
    task: new TaskSandbox(ctx as never, env as never),
    container,
    reported,
    bodies,
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
    Object.assign(backups, { taken: 0, restored: [], deleted: [], there: new Set<string>() });

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

describe("a sandbox task started again from a checkpoint while its earlier run's ending was being read", () => {
  it("is not ended by that earlier ending: the run it has now goes on, and the copy taken of the old one is put with those to remove", async () => {
    const { task, container, records } = fixture();
    await task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    ended(container, { code: "0", events: DONE });
    backups.whileTaking = async () => {
      // The container was lost and the task brought back meanwhile: it has a new run now.
      const state = records.get("state");
      state.recoveries += 1;
      state.runs.push({ kind: "resume", started_at: Date.now() });
      records.set("state", state);
    };
    backups.deleteFails = true;
    let later: Promise<unknown> | undefined;
    const first = backups.whileTaking;
    backups.whileTaking = async () => {
      await first!();
      // The new run ends well while the old one's copy is still being taken: its ending is its own, and is settled.
      backups.whileTaking = undefined;
      later = task.callback("exit", records.get("state").token, {});
      await later;
      expect(records.get("state")).toMatchObject({ phase: "succeeded", checkpoint: { final: true } });
    };
    await task.callback("exit", records.get("state").token, {});
    expect(later).toBeDefined();
    expect(records.get("state")).toMatchObject({ phase: "succeeded", checkpoint: { final: true }, stale_checkpoints: [{ id: "taken-2" }] });
  });

  it("is left running when the earlier ending comes back and nothing else has happened", async () => {
    const { task, container, records } = fixture();
    await task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    ended(container, { code: "0", events: DONE });
    backups.whileTaking = async () => {
      const state = records.get("state");
      state.recoveries += 1;
      state.runs.push({ kind: "resume", started_at: Date.now() });
      records.set("state", state);
    };
    backups.deleteFails = true;
    await task.callback("exit", records.get("state").token, {});
    const now = records.get("state");
    expect(now.phase).toBe("running");
    expect(now.runs.at(-1)).toMatchObject({ kind: "resume" });
    expect(now.runs.at(-1).ended_at).toBeUndefined();
    expect(now.checkpoint?.final).toBeUndefined();
    expect(now.stale_checkpoints).toEqual([{ id: "taken-1" }]);
    expect(await task.snapshot()).toBeNull();
  });
});

describe("a sandbox task that is told something while it is at work", () => {
  /** As the agent's process would fetch: what it holds, and whether this is its last fetch. */
  const fetch = (it: ReturnType<typeof fixture>, have: string[], final = false, run?: string) => {
    const state = it.records.get("state");
    return it.task.callback("notes", state.token, { run: run ?? state.run, have, final }) as Promise<{ ok: boolean; notes?: { id: string; text: string }[] }>;
  };

  it("takes it, hands it to the agent's process as often as that asks while its session does not hold it, and says the same to the same note again", async () => {
    const it = fixture();
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    const run = it.records.get("state").run;
    expect(typeof run).toBe("string");
    // The process was given which run it is.
    expect(await it.task.tell({ id: "n1", text: "also the footer" })).toEqual({ state: "taken" });
    expect(await it.task.tell({ id: "n1", text: "also the footer" })).toEqual({ state: "taken" });
    expect(it.records.get("state").notes).toHaveLength(1);
    // Fetched, and the answer lost: fetched again, it is there still.
    expect(await fetch(it, [])).toEqual({ ok: true, notes: [{ id: "n1", text: "also the footer" }] });
    expect(await fetch(it, [])).toEqual({ ok: true, notes: [{ id: "n1", text: "also the footer" }] });
    expect(it.records.get("state").notes[0].held).toBeUndefined();
    // Its session holds it: not given again, and known to have reached the session.
    expect(await fetch(it, ["n1"])).toEqual({ ok: true, notes: [] });
    expect(it.records.get("state").notes[0].held).toBe(run);
    // The fetching leaves no trace in the record of what happened to the task.
    expect(it.records.get("state").inbox.some((entry: any) => entry.kind === "notes")).toBe(false);
    // Too long, or too many: turned away as that, with nothing dropped to make room.
    expect(await it.task.tell({ id: "long", text: "x".repeat(4_001) })).toMatchObject({ state: "refused", error: expect.stringContaining("too long") });
    for (let n = 2; n <= 20; n++) await it.task.tell({ id: `n${n}`, text: "more" });
    expect(await it.task.tell({ id: "n21", text: "more" })).toMatchObject({ state: "refused", error: expect.stringContaining("put anything more after it") });
    expect(it.records.get("state").notes).toHaveLength(20);
  });

  it("closes at the last fetch that has nothing to give, and not before: what comes first is given, what comes after is told that no more is taken", async () => {
    const it = fixture();
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    // A last fetch that has something to give does not close.
    await it.task.tell({ id: "a", text: "A" });
    expect(await fetch(it, [], true)).toEqual({ ok: true, notes: [{ id: "a", text: "A" }] });
    expect(await it.task.tell({ id: "b", text: "B" })).toEqual({ state: "taken" });
    // The answer with A was lost and the last fetch comes again: A and B, still open.
    expect((await fetch(it, [], true)).notes?.map((note) => note.id)).toEqual(["a", "b"]);
    // Both are in the session and nothing is left: closed. What comes now is told so, the same each time.
    expect(await fetch(it, ["a", "b"], true)).toEqual({ ok: true, notes: [] });
    expect(await it.task.tell({ id: "c", text: "C" })).toEqual({ state: "closed" });
    expect(await it.task.tell({ id: "c", text: "C" })).toEqual({ state: "closed" });
    expect(await it.task.tell({ id: "a", text: "A" })).toEqual({ state: "taken" });
    expect(it.records.get("state").notes.map((note: any) => note.id)).toEqual(["a", "b"]);
  });

  it("answers only the process that is the task's now: one from before a recovery is given nothing and closes nothing; while it is being brought back, notes are taken", async () => {
    const it = fixture();
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    const old = it.records.get("state").run;
    await it.task.tell({ id: "a", text: "A" });
    // Its container is lost and it is being brought back: said meanwhile, taken.
    const state = it.records.get("state");
    state.phase = "starting";
    state.run = "the-new-run";
    it.records.set("state", state);
    expect(await it.task.tell({ id: "b", text: "B" })).toEqual({ state: "taken" });
    // The old process's last fetch comes late: nothing for it, and the run is not closed by it.
    expect(await fetch(it, ["a", "b"], true, old)).toEqual({ ok: false });
    expect(it.records.get("state").notes_closed).toBeUndefined();
    expect(await it.task.tell({ id: "c", text: "C" })).toEqual({ state: "taken" });
    // The new process, from a copy of the session that held A only: B and C.
    state.phase = "running";
    it.records.set("state", { ...it.records.get("state"), phase: "running" });
    expect((await fetch(it, ["a"])).notes?.map((note) => note.id)).toEqual(["b", "c"]);
  });

  it("does not hand out a note at the last fetch when the task has no step left to take: it ends as it was going to, and says the note was not read", async () => {
    const it = fixture();
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain", bounds: { model_calls: 3 } });
    it.records.set("state", { ...it.records.get("state"), model_calls: 3 });
    await it.task.tell({ id: "late", text: "one more thing" });
    // Not at a fetch after a step either: bringing it in would make the agent take a step it cannot take.
    expect(await fetch(it, [])).toEqual({ ok: true, notes: [] });
    expect(it.records.get("state").notes_closed).toBeUndefined();
    expect(await fetch(it, [], true)).toEqual({ ok: true, notes: [] });
    expect(await it.task.tell({ id: "later", text: "x" })).toEqual({ state: "closed" });
    ended(it.container, { code: "0", events: DONE });
    await it.task.alarm();
    await Promise.all(it.background);
    expect(await it.task.status()).toMatchObject({ phase: "succeeded" });
    expect(it.bodies.at(-1)).toMatchObject({ text: "done", notes_not_read: [{ id: "late", at: expect.any(Number) }] });
    // What was said stays with the task: only that something was, and when, goes out with the ending.
    expect(JSON.stringify(it.bodies.at(-1))).not.toContain("one more thing");
  });

  it("is closed as soon as its process is known to have exited, before the last copy is taken; and whatever its ending, says which notes were not read", async () => {
    const it = fixture();
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    await it.task.tell({ id: "read", text: "seen" });
    await fetch(it, ["read"]);
    await it.task.tell({ id: "unread", text: "never fetched" });
    ended(it.container, { code: "0", events: DONE });
    let during: unknown;
    backups.whileTaking = async () => {
      during = await it.task.tell({ id: "during", text: "said while the copy was taken" });
    };
    await it.task.alarm();
    await Promise.all(it.background);
    expect(during).toEqual({ state: "closed" });
    expect(it.bodies.at(-1).notes_not_read.map((note: any) => note.id)).toEqual(["unread"]);
    expect(JSON.stringify(it.bodies.at(-1))).not.toContain("never fetched");

    // One that fails says so too.
    const bad = fixture();
    await bad.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    await bad.task.tell({ id: "x", text: "not reached" });
    ended(bad.container, { code: "1", events: [] });
    await bad.task.alarm();
    await Promise.all(bad.background);
    expect(bad.reported.at(-1)).toBe("failed");
    expect(bad.bodies.at(-1)).toMatchObject({ notes_not_read: [{ id: "x" }] });
    // And one that ended takes no more.
    expect(await bad.task.tell({ id: "y", text: "z" })).toEqual({ state: "closed" });
  });

  it("from the moment it starts being brought back after its container was lost: answers nothing the old process asks, takes notes again, and counts as read only what the new process's session says it holds", async () => {
    const it = fixture();
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    const old = it.records.get("state").run;
    await it.task.tell({ id: "a", text: "A" });
    // The old process's session held A, and it made its last fetch: closed for that run.
    expect(await fetch(it, ["a"], true)).toEqual({ ok: true, notes: [] });
    expect(await it.task.tell({ id: "early", text: "x" })).toEqual({ state: "closed" });
    // The container is lost; it is brought back from a checkpoint taken before A was in the session.
    const lost = it.records.get("state");
    lost.checkpoint = { record: { id: "cp" }, at: Date.now() - 60_000, took_ms: 10 };
    it.records.set("state", lost);
    it.container.running = false;
    let during: unknown;
    let late: unknown;
    it.restoring = async () => {
      // While it is being restored: something said is taken; the old process's fetch is not answered.
      during = await it.task.tell({ id: "b", text: "B" });
      late = await fetch(it, ["a", "b"], true, old);
    };
    await it.task.alarm();
    await Promise.all(it.background);
    expect(during).toEqual({ state: "taken" });
    expect(late).toEqual({ ok: false });
    const now = it.records.get("state");
    expect(now.phase).toBe("running");
    expect(now.run).not.toBe(old);
    expect(now.notes_closed).toBeUndefined();
    // The new process's session holds neither: both are handed out. It ends before saying it holds them.
    expect((await fetch(it, [])).notes?.map((note) => note.id)).toEqual(["a", "b"]);
    ended(it.container, { code: "1", events: [] });
    await it.task.alarm();
    await Promise.all(it.background);
    // A was read by the run before; this run's session never said so: it is among those not confirmed.
    expect(it.bodies.at(-1).notes_not_read.map((note: any) => note.id)).toEqual(["a", "b"]);
  });

  it("says what became of a note while its record is kept, and that it cannot say once the record is gone: never that a note it took was not added", async () => {
    const it = fixture();
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    await it.task.tell({ id: "a", text: "A" });
    expect(await it.task.told("a")).toBe("taken");
    expect(await it.task.told("never")).toBe("none");
    // Its record is cleared away, as it is a day after it ended.
    it.records.delete("state");
    await expect(it.task.told("a")).rejects.toThrow("no longer kept");
    await expect(it.task.told("never")).rejects.toThrow("no longer kept");
  });

  it("takes nothing for a task that was at work before processes were given runs: its container's process never fetches, so nothing would read it", async () => {
    const it = fixture();
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    // As a task started by the version before this one stands when this one is deployed over it.
    const old = it.records.get("state");
    delete old.run;
    delete old.notes_closed;
    it.records.set("state", old);
    expect(await it.task.tell({ id: "a", text: "A" })).toEqual({ state: "closed" });
    expect(it.records.get("state").notes).toBeUndefined();
    // One that is only just being started (and will be given a run) does take.
    it.records.set("state", { ...it.records.get("state"), phase: "starting", notes_refused: [] });
    expect(await it.task.tell({ id: "b", text: "B" })).toEqual({ state: "taken" });
  });

  it("gives the process a run of its own each time it is started, before it is started", async () => {
    const it = fixture();
    const given: (string | undefined)[] = [];
    it.container.exec = async (argv: string[], options?: any) => {
      if (argv[0] === "/bin/sh" && argv.includes("agent")) given.push(options?.env?.TASK_RUN);
      return it.process;
    };
    await it.task.start({ id: "fixture", prompt: "hello", brain: "brain" });
    expect(given).toHaveLength(1);
    expect(given[0]).toBe(it.records.get("state").run);
    expect(given[0]).toMatch(/^[0-9a-f-]{36}$/);
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

describe("a sandbox task that was lent a person's own authorisation", () => {
  const LEND = { v: 1, kind: "github-person", grant: "g1", tenant: "t", person: "ou_1", connector: "feishu", origin: { app_id: "cli_1", tenant_key: "org" }, session: "private:own", ref: 7, repo: "acme/core", repo_id: 102, installation: "77", account: 5, generation: 1, mark: "m1" };
  const lentTask = async () => {
    const made = fixture();
    lending.asked.length = 0;
    lending.answer = async () => "ghu_person";
    await made.task.start({ id: "fixture", prompt: "look", brain: "t:user:ou_1", requested_by: "ou_1", repository: "https://github.com/acme/core", lend: LEND });
    return made;
  };

  it("reads with what the connector hands it for each request, keeps none of it, and is lent nothing else by that", async () => {
    const { task, records } = await lentTask();
    expect(await task.githubFetchToken()).toBe("ghu_person");
    expect(await task.githubFetchToken()).toBe("ghu_person");
    // Asked each time, with the record as it was kept and which work this is.
    expect(lending.asked).toEqual([1, 2].map(() => ({ lend: LEND, task: { id: "fixture", brain: "t:user:ou_1", repo: "acme/core" } })));
    expect(JSON.stringify([...records.values()])).not.toContain("ghu_person");
    // How it stands says nothing of what it was lent or by whom.
    expect(JSON.stringify(await task.status())).not.toMatch(/github-person|"lend"|"mark"|requested_by/);
    // A push, and GitHub's API, are lent as ever: not from the person.
    expect(await task.githubToken()).toBeUndefined();
    expect(await task.githubReadToken()).toBeUndefined();
    expect(lending.asked).toHaveLength(2);
    // No longer to be had, or it cannot be asked: the read is not to be made at all (which is not "none, as a stranger").
    lending.answer = async () => undefined;
    expect(await task.githubFetchToken()).toBe(false);
    lending.answer = async () => Promise.reject(new Error("unreachable"));
    expect(await task.githubFetchToken()).toBe(false);
    // A task that was lent nothing is as ever: none, and the connector is not asked.
    const plain = fixture();
    await plain.task.start({ id: "fixture", prompt: "look", brain: "t:user:ou_1", repository: "https://github.com/acme/core" });
    lending.asked.length = 0;
    expect(await plain.task.githubFetchToken()).toBeUndefined();
    expect(lending.asked).toEqual([]);
  });

  it("is not started with a record it cannot read", async () => {
    for (const lend of [null, {}, { ...LEND, v: 2 }, { ...LEND, mark: "" }, { ...LEND, installation: undefined }, { ...LEND, repo_id: "102" }]) {
      const { task } = fixture();
      expect(await task.start({ id: "fixture", prompt: "look", brain: "t:user:ou_1", repository: "https://github.com/acme/core", lend }), JSON.stringify(lend)).toMatchObject({ phase: "failed" });
      expect(await task.status()).toEqual({ error: "no such task" });
      // And never under that id after.
      expect(await task.start({ id: "fixture", prompt: "look", brain: "t:user:ou_1", repository: "https://github.com/acme/core" })).toMatchObject({ phase: "failed" });
    }
  });

  it("has no copy taken of what it read, while it works or when it ends, and leaves nothing to go on from", async () => {
    const { task, container, records, background } = await lentTask();
    // Progress, which is when a copy is taken of other work.
    const state = records.get("state");
    await task.callback("progress", state.token, { message: "reading" }).catch(() => undefined);
    await Promise.all(background);
    expect(backups.taken).toBe(0);
    expect(await task.snapshot()).toBe("lent");
    ended(container, { code: "0", events: DONE });
    await task.alarm();
    expect(await task.status()).toMatchObject({ phase: "succeeded" });
    expect((await task.status() as any).checkpoint).toBeUndefined();
    expect(backups.taken).toBe(0);
    expect(await task.snapshot()).toBe("lent");
  });

  it("ends, saying why, when what it was lent is gone: how it ended is written before its container is discarded, and it reads nothing after", async () => {
    const { task, container, reported, bodies, background, records } = await lentTask();
    expect(container.running).toBe(true);
    let phaseAsDiscarded: string | undefined;
    const destroy = container.destroy.bind(container);
    container.destroy = async () => {
      phaseAsDiscarded = records.get("state").phase;
      await destroy();
    };
    expect(await task.revoked()).toEqual({ ok: true });
    await Promise.all(background);
    expect(phaseAsDiscarded).toBe("failed");
    expect(container.running).toBe(false);
    expect(await task.status()).toMatchObject({ phase: "failed", error: expect.stringContaining("no longer stands") });
    expect(reported).toEqual(["failed"]);
    expect(JSON.stringify(bodies)).toContain("no longer stands");
    expect(await task.githubFetchToken()).toBe(false);
    // Told again: nothing more.
    await task.revoked();
    await Promise.all(background);
    expect(reported).toEqual(["failed"]);

    // One that had ended well already keeps its container a while: that is discarded too, and how it ended stands.
    const done = await lentTask();
    ended(done.container, { code: "0", events: DONE });
    await done.task.alarm();
    done.container.running = true;
    await done.task.revoked();
    expect(done.container.running).toBe(false);
    expect(await done.task.status()).toMatchObject({ phase: "succeeded" });

    // A task that was lent nothing is not touched.
    const plain = fixture();
    await plain.task.start({ id: "fixture", prompt: "look", brain: "t:user:ou_1" });
    await plain.task.revoked();
    expect(plain.container.running).toBe(true);
    expect(await plain.task.status()).toMatchObject({ phase: expect.not.stringMatching(/failed/) });
  });
});
