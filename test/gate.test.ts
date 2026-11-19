import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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

  it("does not take a refusal, or a plain approval, as approval for the task", async () => {
    const { stub } = await runningTask();
    await stub.authorize("r1", "push", repo, move("a", "b"));
    await stub.answer("deny", "", "q-1", true);
    await stub.authorize("r1", "push", repo, move("a", "b"));
    expect(await stub.authorize("r2", "push", repo, move("a", "b"))).toMatchObject({ state: "pending" });
  });
});
