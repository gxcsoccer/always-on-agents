import { DurableObject } from "cloudflare:workers";

import { handleFeishuWebhook } from "../src/connectors/feishu";
import { handleGithubWebhook } from "../src/connectors/github";
import type { Env } from "../src/env";

export { BrainAgent } from "../src/brain/agent";
export { Registry } from "../src/registry";
export { Outbound } from "../src/workers/sandbox/outbound";

/** Stands in for the sandbox worker: records what the Brain asked of it and answers as told. */
export class FakeTask extends DurableObject {
  async start(input: unknown) {
    this.#record("start", input);
    return { phase: "running" };
  }
  async answer(decision: string, reason: string, questionId?: string) {
    this.#record("answer", { decision, reason, questionId });
    return { ok: true };
  }
  async cancel() {
    this.#record("cancel", {});
    return { ok: true };
  }
  // --- the side the outbound proxy talks to; answers are whatever the test configured ---
  async configure(policy: { repository?: string; verdicts?: { state: string; reason: string }[]; modelCalls?: number; ended?: boolean }) {
    this.ctx.storage.kv.put("policy", policy);
  }
  #policy() {
    return (this.ctx.storage.kv.get("policy") as { repository?: string; verdicts?: { state: string; reason: string }[]; modelCalls?: number; ended?: boolean } | undefined) ?? {};
  }
  async callback(kind: string, token: string, body: unknown) {
    this.#record("callback", { kind, token, body });
    return { ok: token === "good" };
  }
  async isActive() {
    return this.#policy().ended !== true;
  }
  async githubToken() {
    return (this.#policy().repository ?? "") ? "test-github-token" : undefined;
  }
  async repository() {
    return this.#policy().repository ?? "";
  }
  async countModelCall() {
    const policy = this.#policy();
    const left = policy.modelCalls ?? 1_000;
    this.ctx.storage.kv.put("policy", { ...policy, modelCalls: left - 1 });
    return left > 0;
  }
  async withdraw(requestId: string) {
    this.#record("withdraw", { requestId });
  }
  async authorize(requestId: string, action: string, resource: string, refs: unknown) {
    this.#record("authorize", { requestId, action, resource, refs });
    const policy = this.#policy();
    const [next, ...rest] = policy.verdicts ?? [{ state: "deny", reason: "not configured" }];
    if (rest.length > 0) this.ctx.storage.kv.put("policy", { ...policy, verdicts: rest });
    return next;
  }
  async observe(kind: string, body: unknown) {
    this.#record("observe", { kind, body });
  }

  async calls(): Promise<{ method: string; args: unknown }[]> {
    return (this.ctx.storage.kv.get("calls") as { method: string; args: unknown }[] | undefined) ?? [];
  }
  #record(method: string, args: unknown) {
    const calls = (this.ctx.storage.kv.get("calls") as unknown[] | undefined) ?? [];
    calls.push({ method, args });
    this.ctx.storage.kv.put("calls", calls);
  }
}

/** Routes the two webhook endpoints to the real handlers, as the production entry does. */
export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname.split("/").filter(Boolean);
    if (path[1] === "github" && path[2] === "webhook") return handleGithubWebhook(request, env);
    if (path[1] === "feishu" && path[2] === "events" && path[3]) return handleFeishuWebhook(request, env, path[3]);
    return new Response("test worker");
  },
};
