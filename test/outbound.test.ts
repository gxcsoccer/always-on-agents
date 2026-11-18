import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyGit, describePush, parseReceivePack } from "../src/workers/sandbox/outbound";
import { task } from "./helpers";

/** What the proxy let through to the outside world. */
let forwarded: { url: string; method: string; headers: Headers; body: string }[] = [];

beforeEach(() => {
  forwarded = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    forwarded.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text() });
    return new Response("upstream ok");
  });
});

let counter = 0;
/** A proxy bound to a fresh task, the way each sandbox gets its own. */
async function proxyFor(policy: Parameters<any>[0] = {}) {
  const taskId = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  await task(taskId).configure(policy);
  const proxy = (exports as any).Outbound({ props: { taskId } });
  const send = (url: string, init?: RequestInit) => proxy.fetch(new Request(url, init)) as Promise<Response>;
  const recorded = async (method: string) => (await task(taskId).calls()).filter((c: any) => c.method === method).map((c: any) => c.args);
  return { send, recorded };
}

const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);
const pushBody = (...commands: string[]) =>
  new TextEncoder().encode(commands.map((c, i) => pkt(i === 0 ? `${c}\0report-status side-band-64k\n` : `${c}\n`)).join("") + "0000PACK....");

describe("reading a push", () => {
  it("lists exactly which refs would move", () => {
    expect(parseReceivePack(pushBody(`${A} ${B} refs/heads/main`, `${ZERO} ${B} refs/tags/v1`))).toEqual([
      { old: A, new: B, ref: "refs/heads/main" },
      { old: ZERO, new: B, ref: "refs/tags/v1" },
    ]);
  });

  it("reads a push from a shallow clone, which lists its shallow boundary first", () => {
    // Captured from `git push` in a --depth 1 clone (git 2.54).
    const body = new TextEncoder().encode(pkt(`shallow ${A}\n`) + pkt(`${A} ${B} refs/heads/main\0 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.54.0\n`) + "0000PACK....");
    expect(parseReceivePack(body)).toEqual([{ old: A, new: B, ref: "refs/heads/main" }]);
    // A shallow line after the commands have started is not part of the grammar.
    const odd = new TextEncoder().encode(pkt(`${A} ${B} refs/heads/main\0caps\n`) + pkt(`shallow ${A}\n`) + "0000");
    expect(parseReceivePack(odd)).toBeUndefined();
  });

  it("refuses to interpret anything it does not fully understand", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(parseReceivePack(bytes("not a pkt-line"))).toBeUndefined();
    expect(parseReceivePack(bytes(pkt(`${A} ${B} refs/heads/main\n`)))).toBeUndefined(); // no flush packet
    expect(parseReceivePack(bytes(pkt("push-cert\0report-status\n") + "0000"))).toBeUndefined();
    expect(parseReceivePack(bytes(pkt(`${A} ${B} HEAD\n`) + "0000"))).toBeUndefined();
    expect(parseReceivePack(bytes(pkt(`${A} ${B} refs/heads/a b\n`) + "0000"))).toBeUndefined();
    expect(parseReceivePack(bytes("ffff" + "x".repeat(10)))).toBeUndefined();
  });

  it("describes a push in words a person can decide on", () => {
    // Commit ids are shown whole: this line is what a person approves.
    expect(describePush("acme/demo", [{ old: A, new: B, ref: "refs/heads/main" }])).toBe(`push to acme/demo: move branch main from ${A} to ${B}`);
    expect(describePush("acme/demo", [{ old: A, new: ZERO, ref: "refs/heads/old" }])).toContain("delete branch old");
    expect(describePush("acme/demo", [{ old: ZERO, new: B, ref: "refs/tags/v1" }])).toContain(`create tag v1 at ${B}`);
  });

  it("recognises git endpoints and nothing else on github.com", () => {
    const at = (path: string, method = "GET") => classifyGit(new URL(`https://github.com${path}`), method);
    expect(at("/acme/demo.git/info/refs?service=git-upload-pack")).toMatchObject({ repo: "acme/demo", push: false });
    expect(at("/acme/demo/info/refs?service=git-receive-pack")).toMatchObject({ repo: "acme/demo", push: true });
    expect(at("/acme/demo/git-receive-pack", "POST")).toMatchObject({ push: true });
    expect(at("/acme/demo/git-receive-pack", "GET")).toBeUndefined();
    expect(at("/acme/demo")).toBeUndefined();
    expect(at("/acme/demo/info/refs")).toBeUndefined();
    expect(at("/acme/../info/refs?service=git-upload-pack")).toBeUndefined();
  });
});

describe("what a sandbox can reach", () => {
  it("passes reports home with the task's credential, and nothing else decides whose task it is", async () => {
    const { send, recorded } = await proxyFor();
    const ok = await send("http://brain.internal/callback/progress", { method: "POST", headers: { "x-task-token": "good", "x-task-id": "someone-elses-task" }, body: '{"message":"step 1"}' });
    expect(ok.status).toBe(200);
    expect(await recorded("callback")).toEqual([{ kind: "progress", token: "good", body: { message: "step 1" } }]);
    expect((await send("http://brain.internal/callback/progress", { method: "POST", headers: { "x-task-token": "forged" }, body: "{}" })).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("blocks every other host and records the attempt", async () => {
    const { send, recorded } = await proxyFor();
    expect((await send("https://example.com/")).status).toBe(403);
    expect((await send("http://api.openai.com/v1/responses", { method: "POST", body: "{}" })).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect((await recorded("observe")).map((o: any) => o.body.host)).toEqual(["example.com", "api.openai.com"]);
  });
});

describe("the model key", () => {
  const callModel = (send: (url: string, init?: RequestInit) => Promise<Response>, model: string, path = "/v1/responses") =>
    send(`https://model.test${path}`, { method: "POST", headers: { authorization: "Bearer provided-by-worker" }, body: JSON.stringify({ model, input: "hi" }) });

  it("is added by the proxy, replacing whatever the guest sent", async () => {
    const { send } = await proxyFor();
    expect((await callModel(send, "test-model")).status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].headers.get("authorization")).toBe("Bearer test-key");
    expect(JSON.parse(forwarded[0].body)).toEqual({ model: "test-model", input: "hi" });
  });

  it("does not let the guest have the provider reach out on its behalf", async () => {
    const { send } = await proxyFor();
    const withTools = (tools: unknown) => send("https://model.test/v1/responses", { method: "POST", body: JSON.stringify({ model: "test-model", input: "hi", tools }) });
    expect((await withTools([{ type: "function", name: "bash" }])).status).toBe(200);
    expect((await withTools([{ type: "mcp", server_url: "https://attacker.example/mcp" }])).status).toBe(403);
    expect((await withTools([{ type: "function", name: "bash" }, { type: "web_search" }])).status).toBe(403);
    expect((await withTools("not a list")).status).toBe(403);
    // Hosted tools can also be smuggled in as conversation items.
    const withInput = (input: unknown) => send("https://model.test/v1/responses", { method: "POST", body: JSON.stringify({ model: "test-model", input }) });
    expect((await withInput([{ role: "user", content: "hi" }, { type: "function_call", call_id: "c", name: "bash", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "ok" }, { type: "reasoning", summary: [] }])).status).toBe(200);
    expect((await withInput([{ type: "mcp_approval_response", approve: true, approval_request_id: "x" }])).status).toBe(403);
    expect((await withInput([{ type: "mcp_list_tools", server_label: "x", tools: [] }])).status).toBe(403);
    expect((await withInput(["a string item"])).status).toBe(403);
    expect((await send("https://model.test/v1/responses/compact", { method: "POST", body: JSON.stringify({ model: "test-model" }) })).status).toBe(403);
    expect(forwarded).toHaveLength(2);
  });

  it("pays only for the configured model, on the model endpoint, within the task's allowance", async () => {
    const { send } = await proxyFor({ modelCalls: 1 });
    expect((await callModel(send, "a-pricier-model")).status).toBe(403);
    expect((await callModel(send, "test-model", "/v1/files")).status).toBe(403);
    expect((await send("https://model.test/v1/responses", { method: "POST", body: "not json" })).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect((await callModel(send, "test-model")).status).toBe(200);
    expect((await callModel(send, "test-model")).status).toBe(429);
    expect(forwarded).toHaveLength(1);
  });
});

describe("git over the proxy", () => {
  const advert = "https://github.com/acme/demo.git/info/refs?service=git-upload-pack";
  const push = (send: (url: string, init?: RequestInit) => Promise<Response>, repo = "acme/demo", body: BodyInit = pushBody(`${A} ${B} refs/heads/main`)) =>
    send(`https://github.com/${repo}.git/git-receive-pack`, { method: "POST", body });

  it("lends the token only for the repository the task was started on", async () => {
    const { send } = await proxyFor({ repository: "acme/demo" });
    await send(advert);
    await send("https://github.com/acme/secret.git/info/refs?service=git-upload-pack", { headers: { authorization: "Basic guessed" } });
    expect(forwarded[0].headers.get("authorization")).toBe(`Basic ${btoa("x-access-token:test-github-token")}`);
    expect(forwarded[1].headers.get("authorization")).toBeNull();
  });

  it("offers nothing on github.com except git", async () => {
    const { send } = await proxyFor({ repository: "acme/demo" });
    expect((await send("https://github.com/acme/demo/settings")).status).toBe(403);
    expect((await send("https://github.com/login/oauth/access_token", { method: "POST", body: "x" })).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("never pushes to a repository the task was not started on", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "allow", reason: "" }] });
    expect((await push(send, "acme/other")).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect(await recorded("authorize")).toHaveLength(0);
  });

  it("holds a push until someone approves exactly those refs, then forwards it unchanged", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "pending", reason: "" }, { state: "allow", reason: "ok" }] });
    const body = pushBody(`${A} ${B} refs/heads/main`);
    const response = await push(send, "acme/demo", body);
    expect(response.status).toBe(200);
    const asked = await recorded("authorize");
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ action: "git_push", resource: "acme/demo", refs: [{ old: A, new: B, ref: "refs/heads/main" }] });
    // Both polls belong to the same held request, which has an id of its own.
    expect(asked[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(asked[1].requestId).toBe(asked[0].requestId);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].body).toBe(new TextDecoder().decode(body));
    expect(forwarded[0].headers.get("authorization")).toContain("Basic ");
  });

  it("gives two identical pushes two separate questions", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "allow", reason: "" }] });
    await push(send);
    await push(send);
    const [first, second] = await recorded("authorize");
    expect(first.requestId).not.toBe(second.requestId);
  });

  it("does not forward a push that was denied or that it cannot read", async () => {
    const denied = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "deny", reason: "not on main" }] });
    const response = await push(denied.send);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not on main");

    const unreadable = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "allow", reason: "" }] });
    expect((await push(unreadable.send, "acme/demo", "garbage")).status).toBe(403);
    expect(await unreadable.recorded("authorize")).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
  });
});
