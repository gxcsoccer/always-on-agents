// First: it adds a connector to the configuration, which the modules below read as they load.
import "./notes";
import { TaskSandbox } from "../src/workers/sandbox/task";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../src/env";
import production from "../src/index";

export { BrainAgent } from "../src/brain/agent";
export { FeishuGrant } from "../src/connectors/feishu-grant";
export { DoubaoGrant } from "../src/connectors/doubao";
export { GithubGrant } from "../src/connectors/github-grant";
export { FeishuLink } from "../src/connectors/feishu-link";
export { Registry } from "../src/registry";
export { Outbound } from "../src/workers/sandbox/outbound";

/** Stands in for the sandbox worker: records what the Brain asked of it and answers as told. */
export class FakeTask extends DurableObject {
  async start(input: unknown) {
    this.#record("start", input);
    this.ctx.storage.kv.put("started", true);
    // A test can have the start take effect and the word of it never get back: by what the work is said to be.
    if (String((input as { prompt?: unknown })?.prompt ?? "").includes("(the start is not answered)")) throw new Error("connection lost");
    return { phase: "running" };
  }
  /** As the real task: takes what is said to it while it is at work; or says that it takes no more, for a note that says so. */
  async tell(note: { id: string; text: string }) {
    this.#record("tell", note);
    return { state: note.text.includes("(too late)") ? "closed" : "taken" };
  }
  async told(noteId: string) {
    return ((this.ctx.storage.kv.get("calls") as { method: string; args: any }[] | undefined) ?? []).some((each) => each.method === "tell" && each.args?.id === noteId && !String(each.args.text).includes("(too late)")) ? "taken" : "none";
  }
  /** As the real task: how it stands, or that there is none. */
  async status() {
    return this.ctx.storage.kv.get("started") === true ? { phase: "running" } : { error: "no such task" };
  }
  /** As the real task: what it left for a later one to go on from, once it was started with a repository or without. */
  async snapshot() {
    const first = ((this.ctx.storage.kv.get("calls") as { method: string; args: any }[] | undefined) ?? []).find((each) => each.method === "start")?.args;
    if (!first) return null;
    return { record: { id: "kept", dir: "/workspace/job" }, cwd: first.repository ? "/workspace/job/repo" : "/workspace/job/scratch", ...(first.repository ? { repository: first.repository } : {}), until: Date.now() + 3_600_000 };
  }
  /** As the real task: whether it was ever started here. (The real one also closes an id it never took; nothing here starts one afterwards.) */
  async claimed() {
    return this.ctx.storage.kv.get("started") === true ? "there" : "none";
  }
  async answer(decision: string, reason: string, questionId?: string, standing = false) {
    this.#record("answer", { decision, reason, questionId, standing });
    // Like the real task: the first answer to a question stands, with the reach it was given.
    const answers = (this.ctx.storage.kv.get("answers") as Record<string, { decision: string; standing: boolean }> | undefined) ?? {};
    answers[questionId ?? ""] ??= { decision, standing: decision === "allow" && standing };
    this.ctx.storage.kv.put("answers", answers);
    // A test can have the answer take a while to be confirmed once it has taken effect, so that other things happen meanwhile.
    const delay = (this.#policy() as { answerDelayMs?: number }).answerDelayMs;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    // A test can have the answer take effect and the word of it never get back.
    if ((this.#policy() as { answerUnheard?: boolean }).answerUnheard) throw new Error("connection lost");
    return { ok: true, ...answers[questionId ?? ""] };
  }
  async decisionOn(questionId: string) {
    // A test can have the task's records be gone, as they are some time after a task ends.
    if ((this.#policy() as { forgotten?: boolean }).forgotten) return { state: "unknown" };
    const answers = (this.ctx.storage.kv.get("answers") as Record<string, { decision: string; standing: boolean }> | undefined) ?? {};
    return answers[questionId] ? { state: "decided", ...answers[questionId] } : { state: "undecided" };
  }
  async cancel() {
    this.#record("cancel", {});
    return { ok: true };
  }
  // --- the side the outbound proxy talks to; answers are whatever the test configured ---
  async configure(policy: { answerDelayMs?: number; answerUnheard?: boolean; forgotten?: boolean; repository?: string; verdicts?: { state: string; reason: string }[]; modelCalls?: number; ended?: boolean; tokenWithdrawnAfter?: number; unlent?: boolean; lendingFails?: boolean; endsWhileLending?: boolean }) {
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
    // A test can have the credential withdrawn after it has been asked for a number of times.
    const asked = ((this.ctx.storage.kv.get("token_asks") as number | undefined) ?? 0) + 1;
    this.ctx.storage.kv.put("token_asks", asked);
    const limit = (this.#policy() as { tokenWithdrawnAfter?: number }).tokenWithdrawnAfter;
    if (limit !== undefined && asked > limit) return undefined;
    return (this.#policy().repository ?? "") ? "test-github-token" : undefined;
  }
  /** As the real task: a credential that can only read, lent where the other is; none where the test says the task is not lent one. A test can have the lending fail, or the task end while it is asked. */
  async githubReadToken() {
    const policy = this.#policy() as { repository?: string; unlent?: boolean; lendingFails?: boolean; endsWhileLending?: boolean };
    if (policy.lendingFails) throw new Error("GitHub refused to issue a token: 500");
    if (policy.endsWhileLending) {
      this.ctx.storage.kv.put("policy", { ...policy, ended: true });
      return undefined;
    }
    return (policy.repository ?? "") && !policy.unlent ? "test-read-token" : undefined;
  }
  async noteGithubRead(kind: string, status: number, seen: Record<string, unknown>) {
    // (Which search a page was of, and which page, are kept apart for the tests that ask about them.)
    const { of, page, cut, ...flags } = seen;
    this.#record("noteGithubRead", { kind, status, ...Object.fromEntries(Object.entries(flags).filter(([, value]) => value)) });
    if (of !== undefined) this.#record("searchPage", { of, page, more: flags.more === true, ...(cut ? { cut: true } : {}) });
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

/** The production entry itself: requests are routed to connectors exactly as they are when deployed. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return production.fetch(request, env, ctx);
  },
};


/**
 * The real task object, with a container that is never running. Enough to exercise what the object
 * does on its own: the questions it holds for the gate, and when it lets go of them.
 */
export class GateTask extends TaskSandbox {
  constructor(ctx: DurableObjectState, env: any) {
    // Own properties on the real state object, in front of the runtime's own.
    Object.defineProperty(ctx, "container", { value: { running: false }, configurable: true });
    Object.defineProperty(ctx, "exports", { value: { Outbound: () => ({}), DirectoryBackupGateway: {} }, configurable: true });
    super(ctx as any, env);
  }
}


/**
 * The other end of a Feishu long connection, for tests. It lives in its own object so that the
 * connection crosses a real boundary, as it does in production: a test tells it what to send and
 * asks it what it received.
 */
export class FakeFeishu extends DurableObject {
  #server?: WebSocket;
  #received: number[][] = [];
  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.binaryType = "arraybuffer";
    server.accept();
    server.addEventListener("message", (event) => {
      this.#received.push([...new Uint8Array(event.data as ArrayBuffer)]);
    });
    this.#server = server;
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async send(bytes: number[]): Promise<void> {
    this.#server?.send(Uint8Array.from(bytes));
  }
  async received(): Promise<number[][]> {
    return this.#received;
  }
  async connected(): Promise<boolean> {
    return this.#server !== undefined;
  }
}
