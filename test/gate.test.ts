import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { fromTheirs } from "../src/connectors/github-app";

/** A task that is running, as the real object would have stored it. */
async function runningTask() {
  const stub = (env as any).GATE_TASKS.getByName(crypto.randomUUID()) as any;
  await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("state", {
      id: "t1", token: "pass", phase: "running", cwd: "/workspace/job", created_at: Date.now(), starting_since: Date.now(),
      timings: {}, runs: [], grants: {}, asks: 0, model_calls: 0, out: [], out_seq: 0, checkpoints_taken: 0, recoveries: 0,
      gate_questions: {}, decisions: {}, inbox: [], checks: [],
    });
  });
  const age = (patch: Record<string, number>) =>
    runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
      const task = state.storage.kv.get("state") as any;
      Object.assign(task.pending, patch);
      state.storage.kv.put("state", task);
    });
  return { stub, age };
}

const call = { tool_use_id: "call-1", tool_name: "bash", command: "rm -r scratch" };

describe("the questions a task holds for its gate", () => {
  it("answers the gate's poll with the decision once someone has given one", async () => {
    const { stub } = await runningTask();
    expect(await stub.callback("needs_input", "pass", call)).toMatchObject({ ok: true });
    expect(await stub.callback("decision", "pass", call)).toMatchObject({ decision: "pending" });
    expect(await stub.answer("allow", "", "q-1")).toMatchObject({ ok: true, decision: "allow" });
    expect(await stub.callback("decision", "pass", call)).toMatchObject({ decision: "allow" });
    // Answered once: a second, different answer returns the first.
    expect(await stub.answer("deny", "", "q-1")).toMatchObject({ ok: true, decision: "allow" });
    // And never for another command under the same call id, or with the wrong pass.
    expect(await stub.callback("decision", "pass", { ...call, command: "rm -r /" })).toMatchObject({ decision: "pending" });
    expect(await stub.callback("decision", "wrong", call)).toEqual({ ok: false });
  });

  it("lets go of a question whose gate has stopped polling, even if the gate never said so", async () => {
    const { stub, age } = await runningTask();
    await stub.callback("needs_input", "pass", call);
    expect((await stub.status()).phase).toBe("needs_input");
    // The gate was last heard from six minutes ago.
    await age({ polled_at: Date.now() - 6 * 60_000 });
    // An approval arriving now is for a question nobody is waiting on any more.
    expect(await stub.answer("allow", "", "q-1")).toMatchObject({ ok: false });
    const status = await stub.status();
    expect(status.phase).toBe("running");
    expect(status.pending).toBeUndefined();
    expect(status.inbox.map((item: any) => item.kind)).toEqual(["needs_input", "withdrawn"]);
    // If the gate does come back, it is told no rather than left waiting.
    expect(await stub.callback("decision", "pass", call)).toMatchObject({ decision: "deny" });
  });

  it("lets go of a question that has been open longer than the gate waits", async () => {
    const { stub, age } = await runningTask();
    await stub.callback("needs_input", "pass", call);
    await age({ asked_at: Date.now() - 58 * 60_000, polled_at: Date.now() });
    expect(await stub.answer("allow", "", "q-1")).toMatchObject({ ok: false });
    expect(await stub.callback("decision", "pass", call)).toMatchObject({ decision: "deny" });
  });

  it("withdraws the question when the gate reports that it gave up", async () => {
    const { stub } = await runningTask();
    await stub.callback("needs_input", "pass", call);
    await stub.callback("gate_timeout", "pass", call);
    expect((await stub.status()).phase).toBe("running");
    expect(await stub.answer("allow", "", "q-1")).toMatchObject({ ok: false });
  });
});

describe("pushes a task holds for approval", () => {
  const repo = "acme/demo";
  const move = (from: string, to: string, ref = "refs/heads/feature") => [{ ref, old: from.repeat(40), new: to.repeat(40) }];

  it("asks every time unless the approval was given for the rest of the task", async () => {
    const { stub } = await runningTask();
    expect(await stub.authorize("r1", "push", repo, move("a", "b"))).toMatchObject({ state: "pending" });
    expect(await stub.answer("allow", "", "q-1")).toMatchObject({ ok: true });
    expect(await stub.authorize("r1", "push", repo, move("a", "b"))).toMatchObject({ state: "allow" });
    // The next push of the same branch asks again.
    expect(await stub.authorize("r2", "push", repo, move("b", "c"))).toMatchObject({ state: "pending" });
    expect((await stub.status()).pending.id).toBe("q-2");
  });

  it("lets later pushes of the same branches through once approved for the task, and nothing else", async () => {
    const { stub } = await runningTask();
    await stub.authorize("r1", "push", repo, move("a", "b"));
    expect(await stub.answer("allow", "", "q-1", true)).toMatchObject({ ok: true });
    expect(await stub.authorize("r1", "push", repo, move("a", "b"))).toMatchObject({ state: "allow" });
    // Same branch, same repository: no question, but it is on record.
    expect(await stub.authorize("r2", "push", repo, move("b", "c"))).toMatchObject({ state: "allow", reason: "standing approval" });
    expect((await stub.status()).inbox.map((item: any) => item.kind)).toContain("standing");
    // Another branch, another repository, or deleting the branch: asked as before.
    expect(await stub.authorize("r3", "push", repo, move("b", "c", "refs/heads/main"))).toMatchObject({ state: "pending" });
    await stub.answer("deny", "", "q-2");
    await stub.authorize("r3", "push", repo, move("b", "c", "refs/heads/main"));
    expect(await stub.authorize("r4", "push", "acme/other", move("b", "c"))).toMatchObject({ state: "pending" });
    await stub.answer("deny", "", "q-3");
    await stub.authorize("r4", "push", "acme/other", move("b", "c"));
    expect(await stub.authorize("r5", "push", repo, move("c", "0"))).toMatchObject({ state: "pending" });
  });

  it("never extends an approval for the task to tags or deletions, when given or when used", async () => {
    const tagged = [...move("a", "b"), { ref: "refs/tags/v1", old: "0".repeat(40), new: "b".repeat(40) }];
    // A push of a branch together with a tag, approved "for the task": it goes through, once.
    const first = await runningTask();
    await first.stub.authorize("r1", "push", repo, tagged);
    await first.stub.answer("allow", "", "q-1", true);
    expect(await first.stub.authorize("r1", "push", repo, tagged)).toMatchObject({ state: "allow" });
    expect((await first.stub.status()).standing ?? []).toEqual([]);
    expect(await first.stub.authorize("r2", "push", repo, move("b", "c"))).toMatchObject({ state: "pending" });
    // Deleting a branch, approved "for the task", gives no leave to push it again.
    const second = await runningTask();
    await second.stub.authorize("r1", "push", repo, move("a", "0"));
    await second.stub.answer("allow", "", "q-1", true);
    await second.stub.authorize("r1", "push", repo, move("a", "0"));
    expect(await second.stub.authorize("r2", "push", repo, move("0", "c"))).toMatchObject({ state: "pending" });
    // A branch approved for the task does not cover a tag pushed later.
    const third = await runningTask();
    await third.stub.authorize("r1", "push", repo, move("a", "b"));
    await third.stub.answer("allow", "", "q-1", true);
    await third.stub.authorize("r1", "push", repo, move("a", "b"));
    expect(await third.stub.authorize("r2", "push", repo, [{ ref: "refs/tags/v1", old: "0".repeat(40), new: "b".repeat(40) }])).toMatchObject({ state: "pending" });
  });

  it("does not take a refusal, or a plain approval, as approval for the task", async () => {
    const { stub } = await runningTask();
    await stub.authorize("r1", "push", repo, move("a", "b"));
    await stub.answer("deny", "", "q-1", true);
    await stub.authorize("r1", "push", repo, move("a", "b"));
    expect(await stub.authorize("r2", "push", repo, move("a", "b"))).toMatchObject({ state: "pending" });
  });
});

describe("the repository credential a task is lent", () => {
  const registry = () => (env as any).REGISTRY.getByName("global");
  /** A running task that says which conversation started it and which repository it works on. */
  async function taskFrom(brain: string, repository: string) {
    const { stub } = await runningTask();
    await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
      const task = state.storage.kv.get("state") as any;
      state.storage.kv.put("state", { ...task, brain, repository });
    });
    return stub;
  }

  it("lends it in the repository's own conversation and in a chat linked to that repository, and nowhere else", async () => {
    await registry().createTenant("lend", "lend");
    const repo = "https://github.com/acme/demo";
    expect(await (await taskFrom("lend:repo:acme/demo", repo)).githubToken()).toBe("test-github-token");
    // A chat gets nothing for any repository until an operator links it to one.
    expect(await (await taskFrom("lend:chat:oc_room", repo)).githubToken()).toBeUndefined();
    await registry().linkChatRepo("lend", "oc_room", "Acme/Demo");
    expect(await (await taskFrom("lend:chat:oc_room", repo)).githubToken()).toBe("test-github-token");
    // Only for that repository, only for that chat, and never for a direct chat.
    expect(await (await taskFrom("lend:chat:oc_room", "https://github.com/acme/other")).githubToken()).toBeUndefined();
    expect(await (await taskFrom("lend:chat:oc_elsewhere", repo)).githubToken()).toBeUndefined();
    expect(await (await taskFrom("lend:user:oc_room", repo)).githubToken()).toBeUndefined();
    // Another tenant's chat of the same name is another chat.
    await registry().createTenant("lend2", "lend2");
    expect(await (await taskFrom("lend2:chat:oc_room", repo)).githubToken()).toBeUndefined();
    // Removing the link stops the lending, for a task already running too.
    const running = await taskFrom("lend:chat:oc_room", repo);
    expect(await running.githubToken()).toBe("test-github-token");
    await registry().linkChatRepo("lend", "oc_room", null);
    expect(await running.githubToken()).toBeUndefined();
  });

  it("lends no credential to read GitHub's API with where there is no App: the deployment's own token can do more than read", async () => {
    await registry().createTenant("lend3", "lend3");
    const stub = await taskFrom("lend3:repo:acme/demo", "https://github.com/acme/demo");
    expect(await stub.githubToken()).toBe("test-github-token");
    expect(await stub.githubReadToken()).toBeUndefined();
  });

  it("keeps count of what the proxy saw of its reads of GitHub's API, searches apart from the rest", async () => {
    const stub = await taskFrom("lend3:repo:acme/demo", "https://github.com/acme/demo");
    await stub.noteGithubRead("search", 200, { read: true, more: true });
    await stub.noteGithubRead("search", 200, { read: true, none: true });
    await stub.noteGithubRead("search", 200, { read: true, incomplete: true });
    await stub.noteGithubRead("search", 200, {});
    await stub.noteGithubRead("search", 0, { incomplete: true });
    await stub.noteGithubRead("other", 403, {});
    // Pages of two searches, told apart: one read to its end, one not.
    await stub.noteGithubRead("search", 200, { read: true, more: true, of: "a", page: 1 });
    await stub.noteGithubRead("search", 200, { read: true, of: "a", page: 2 });
    await stub.noteGithubRead("search", 200, { read: true, more: true, incomplete: true, of: "b", page: 1 });
    // Turned away by the proxy itself; found more than GitHub gives; more pages read than are kept track of.
    await stub.noteGithubRead("search", 400, { rejected: true });
    await stub.noteGithubRead("search", 200, { read: true, cut: true, of: "c", page: 1 });
    for (let page = 1; page <= 201; page++) await stub.noteGithubRead("search", 200, { read: true, more: page < 201, of: "d", page });
    const reads = await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => (state.storage.kv.get("state") as any).github_reads);
    expect(reads.search.by_status).toEqual({ "200": 209, failed: 1, rejected: 1 });
    expect(reads.search.each.a).toEqual({ pages: [1, 2], last: true, incomplete: false });
    expect(reads.search.each.b).toEqual({ pages: [1], last: false, incomplete: true });
    expect(reads.search.each.c).toEqual({ pages: [1], last: true, incomplete: false, cut: true });
    expect(reads.search.each.d).toMatchObject({ last: true, incomplete: false, unsure: true });
    expect(reads.search.each.d.pages).toHaveLength(200);
    expect(reads.other).toEqual({ by_status: { "403": 1 } });
  });

  it("no longer lends what was issued from an installation that has since been given to another tenant", async () => {
    await registry().createTenant("lend4", "lend4");
    await registry().createTenant("lend5", "lend5");
    await registry().linkGithubInstallation("777", "lend4");
    const stub = await taskFrom("lend4:repo:acme/demo", "https://github.com/acme/demo");
    // As it would be kept after being issued through that installation, good for a long while yet.
    const keep = (which: string, token: string) =>
      runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
        const task = state.storage.kv.get("state") as any;
        state.storage.kv.put("state", { ...task, [which]: { token, expires_at: Date.now() + 3_600_000, source: "token", installation: "777" } });
      });
    await keep("github_token", "issued-earlier");
    expect(await stub.githubToken()).toBe("issued-earlier");
    await registry().linkGithubInstallation("777", "lend5");
    // (What it falls back to here is this test deployment's own token; the one issued earlier is not lent.)
    expect(await stub.githubToken()).not.toBe("issued-earlier");
    await keep("github_read_token", "read-issued-earlier");
    expect(await stub.githubReadToken()).toBeUndefined();
    await registry().linkGithubInstallation("777", "lend4");
    await keep("github_read_token", "read-issued-earlier");
    expect(await stub.githubReadToken()).toBe("read-issued-earlier");
    // One kept as issued through an App with no word of which installation (an earlier version kept them so) is not known to be theirs still.
    const tenantOf = async (installation: string) => (installation === "777" ? "lend4" : null);
    expect(await fromTheirs("app:1", undefined, "lend4", tenantOf)).toBe(false);
    expect(await fromTheirs("app:1", "777", "lend4", tenantOf)).toBe(true);
    expect(await fromTheirs("app:1", "777", "lend5", tenantOf)).toBe(false);
    expect(await fromTheirs("app:1", "778", "lend4", tenantOf)).toBe(false);
    // The deployment's own token, of local development, comes from none.
    expect(await fromTheirs("token", undefined, "lend4", tenantOf)).toBe(true);
  });
});
