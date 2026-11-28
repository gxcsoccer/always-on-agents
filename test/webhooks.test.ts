import { DeliveryDeferred, DeliveryRejected } from "../src/connectors";
import { deliverFeishu, feishuConnector, handleFeishuWebhook, quotedFeishu } from "../src/connectors/feishu";
import { grantName, grantOf } from "../src/connectors/feishu-grant";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { call, installFakeModel, model, modelCalls, say, wake } from "./helpers";

beforeEach(() => installFakeModel());

const registry = () => (env as any).REGISTRY.getByName("global");
const brainFor = (scope: string) => (env as any).BRAIN.getByName(scope);
const post = (path: string, body: string, headers: Record<string, string>) =>
  (exports as any).default.fetch(new Request(`https://agent.test${path}`, { method: "POST", body, headers })) as Promise<Response>;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

let counter = 0;
async function tenant() {
  const id = `wh${++counter}`;
  await registry().createTenant(id, id);
  return id;
}

describe("the GitHub webhook endpoint", () => {
  async function sign(secret: string, body: string) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
  }
  const deliver = async (secret: string, type: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    return post("/v1/github/webhook", body, { "x-github-event": type, "x-hub-signature-256": await sign(secret, body) });
  };
  const comment = (repo: string, id: number, body: string, association = "OWNER") => ({
    action: "created",
    repository: { full_name: repo },
    sender: { login: "dana", id: 77, type: "User" },
    issue: { number: 3, pull_request: {} },
    comment: { id, body, author_association: association, user: { id: 77 } },
  });

  it("accepts an event signed with the repository's own secret and puts it in that tenant's repository scope", async () => {
    const t = await tenant();
    const { webhook_secret } = await registry().linkGithubRepo(`${t}/demo`, t);
    const response = await deliver(webhook_secret, "issue_comment", comment(`${t}/demo`, 1, "@always-on-agent hello"));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, duplicate: false, scope: `${t}:repo:${t}/demo` });
    expect((await brainFor(`${t}:repo:${t}/demo`).inspect()).inbox.pending).toBe(1);
    // The same comment delivered again is a duplicate, whatever the delivery header says.
    expect(await (await deliver(webhook_secret, "issue_comment", comment(`${t}/demo`, 1, "@always-on-agent hello"))).json()).toMatchObject({ duplicate: true });
  });

  it("looks at a pull request as it stands: of several pushes that wait only the latest is taken up, and none once it is closed", async () => {
    const id = await tenant();
    const repo = `acme/${id}`;
    const { webhook_secret } = await registry().linkGithubRepo(repo, id);
    const brain = brainFor(`${id}:repo:${repo}`);
    const word = (action: string, sha: string, updated_at: string, number = 7) => deliver(webhook_secret, "pull_request", { action, repository: { full_name: repo }, sender: { login: "dana", id: 5, type: "User" }, pull_request: { id: 900 + number, number, title: "Add retry", html_url: `https://github.com/${repo}/pull/${number}`, head: { ref: "retry", sha }, base: { ref: "main" }, user: { login: "dana" }, updated_at } });
    const waiting = () => runInDurableObject(brain, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec("SELECT source_id, status FROM inbox ORDER BY id").toArray().map((row) => `${String(row.source_id).split(":").slice(2, 4).join(":")} ${row.status}`));
    // Nothing is taken up yet (the Brain is not woken between them here): three pushes to one pull request, one to another.
    expect((await word("opened", "a1", "2026-11-28T01:00:00Z")).status).toBe(202);
    await word("synchronize", "a2", "2026-11-28T02:00:00Z");
    await word("synchronize", "a3", "2026-11-28T03:00:00Z");
    await word("opened", "b1", "2026-11-28T02:30:00Z", 8);
    expect(await waiting()).toEqual(["opened:a1 dropped", "synchronize:a2 dropped", "synchronize:a3 pending", "opened:b1 pending"]);
    // The first is merged: nothing of it waits any more, and that it was closed is not something to take up either.
    expect((await word("closed", "a3", "2026-11-28T04:00:00Z")).status).toBe(202);
    expect(await waiting()).toEqual(["opened:a1 dropped", "synchronize:a2 dropped", "synchronize:a3 dropped", "opened:b1 pending", "closed:a3 dropped"]);
    // Only the other pull request is brought before the model.
    model.replies([say("")]);
    await wake(brain);
    expect(modelCalls).toHaveLength(1);
    const shown = JSON.stringify(modelCalls[0].input);
    expect(shown).toContain("Pull request #8");
    expect(shown).not.toContain("Pull request #7");
  });

  it("takes up no word of a pull request by itself where the deployment has not said to, and still answers someone who asks there", async () => {
    const id = await tenant();
    const repo = `acme/${id}`;
    const { webhook_secret } = await registry().linkGithubRepo(repo, id);
    const brain = brainFor(`${id}:repo:${repo}`);
    const word = (action: string, sha: string, updated_at?: string) => deliver(webhook_secret, "pull_request", { action, repository: { full_name: repo }, sender: { login: "dana", id: 5, type: "User" }, pull_request: { id: 907, number: 7, title: "Add retry", html_url: `https://github.com/${repo}/pull/7`, head: { ref: "retry", sha }, base: { ref: "main" }, user: { login: "dana" }, ...(updated_at ? { updated_at } : {}) } });
    const statuses = () => runInDurableObject(brain, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec("SELECT kind, status FROM inbox ORDER BY id").toArray().map((row) => `${row.kind} ${row.status}`));
    // One that waits from when it was still looked at by itself.
    await word("opened", "a1", "2026-11-28T01:00:00Z");
    expect(await statuses()).toEqual(["github.pull_request pending"]);
    (env as any).GITHUB_AUTO_REVIEW = "off";
    try {
      expect((await word("synchronize", "a2", "2026-11-28T02:00:00Z")).status).toBe(202);
      // Neither waits now; the same one again is the one held.
      expect(await statuses()).toEqual(["github.pull_request dropped", "github.pull_request dropped"]);
      expect(await (await word("synchronize", "a2", "2026-11-28T02:00:00Z")).json()).toMatchObject({ duplicate: true });
      expect(await (await word("synchronize", "a3")).json()).toMatchObject({ ignored: expect.any(String) });
      await wake(brain);
      expect(modelCalls).toHaveLength(0);
      // Someone asks in the pull request: that is taken up as ever.
      model.replies([say("")]);
      expect((await deliver(webhook_secret, "issue_comment", { ...comment(repo, 31, "@always-on-agent please review this"), issue: { number: 7, pull_request: {} } })).status).toBe(202);
      await wake(brain);
      expect(modelCalls).toHaveLength(1);
      expect(JSON.stringify(modelCalls[0].input)).toContain("please review this");
      // Where nothing of it waits, the Brain is not woken for it at all: not when it arrives, nor when it is delivered again.
      const quiet = await tenant();
      const { webhook_secret: other } = await registry().linkGithubRepo(`acme/${quiet}`, quiet);
      const pushed = () => deliver(other, "pull_request", { action: "opened", repository: { full_name: `acme/${quiet}` }, sender: { login: "dana", id: 5, type: "User" }, pull_request: { id: 1, number: 1, title: "t", html_url: "https://github.com/x/y/pull/1", head: { ref: "r", sha: "s" }, base: { ref: "main" }, user: { login: "dana" }, updated_at: "2026-11-28T01:00:00Z" } });
      await pushed();
      await pushed();
      expect(await runInDurableObject(brainFor(`${quiet}:repo:acme/${quiet}`), (_i: unknown, state: DurableObjectState) => state.storage.getAlarm())).toBeNull();
    } finally {
      (env as any).GITHUB_AUTO_REVIEW = "on";
    }
  });

  it("spends nothing, once pull requests are no longer looked at by themselves, on word of them that already waits or was taken up and put off; with no further word arriving", async () => {
    const id = await tenant();
    const repo = `acme/${id}`;
    const { webhook_secret } = await registry().linkGithubRepo(repo, id);
    const brain = brainFor(`${id}:repo:${repo}`);
    const sql = (query: string, ...args: unknown[]) => runInDurableObject(brain, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec(query, ...(args as any[])).toArray());
    const word = (number: number, sha: string, updated_at: string) => deliver(webhook_secret, "pull_request", { action: "opened", repository: { full_name: repo }, sender: { login: "dana", id: 5, type: "User" }, pull_request: { id: 900 + number, number, title: "Add retry", html_url: `https://github.com/${repo}/pull/${number}`, head: { ref: "retry", sha }, base: { ref: "main" }, user: { login: "dana" }, updated_at } });
    // Taken in while they were looked at by themselves. One of them from before anything was kept of which it is the state of.
    await word(7, "a1", "2026-11-28T01:00:00Z");
    await word(8, "b1", "2026-11-28T01:00:00Z");
    await sql("UPDATE inbox SET data = json_remove(data, '$.supersedes')");
    await sql("DELETE FROM latest_states");
    // And a person asks something in one of them.
    await deliver(webhook_secret, "issue_comment", { ...comment(repo, 41, "@always-on-agent what does this change?"), issue: { number: 8, pull_request: {} } });
    (env as any).GITHUB_AUTO_REVIEW = "off";
    try {
      model.replies([say("")]);
      for (let i = 0; i < 5; i++) await wake(brain);
      // Only what the person asked was brought before the model.
      expect(modelCalls).toHaveLength(1);
      expect(JSON.stringify(modelCalls[0].input)).toContain("what does this change?");
      expect(JSON.stringify(modelCalls[0].input)).not.toContain("was opened by");
      expect((await sql("SELECT kind, status FROM inbox ORDER BY id")).map((row) => `${row.kind} ${row.status}`)).toEqual(["github.pull_request dropped", "github.pull_request dropped", "message done"]);
    } finally {
      (env as any).GITHUB_AUTO_REVIEW = "on";
    }

    // A run that took such word up and was put off before doing anything (the allowance was used up): ended with nothing spent.
    await word(9, "c1", "2026-11-28T02:00:00Z");
    const [event] = await sql("SELECT id, session_key FROM inbox WHERE status = 'pending'");
    await sql("INSERT INTO sessions (id, session_key, created_at, updated_at) VALUES ('s-held', ?, 1, 1) ON CONFLICT DO NOTHING", event.session_key);
    const session = (await sql("SELECT id FROM sessions WHERE session_key = ?", event.session_key))[0].id;
    await sql("INSERT INTO runs (id, session_id, status, started_at, retry_at) VALUES ('r-held', ?, 'running', 1, 1)", session);
    await sql("UPDATE inbox SET status = 'claimed', run_id = 'r-held' WHERE id = ?", event.id);
    await sql("INSERT INTO meta (key, value) VALUES ('active_run', 'r-held') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    (env as any).GITHUB_AUTO_REVIEW = "off";
    try {
      const before = modelCalls.length;
      for (let i = 0; i < 3; i++) await wake(brain);
      expect(modelCalls).toHaveLength(before);
      expect((await sql("SELECT status FROM runs WHERE id = 'r-held'"))[0].status).toBe("done");
      expect((await sql("SELECT status FROM inbox WHERE id = ?", event.id))[0].status).toBe("dropped");
    } finally {
      (env as any).GITHUB_AUTO_REVIEW = "on";
    }
  });

  it("gives the same refusal for a wrong secret, another repository's secret and an unregistered repository", async () => {
    const a = await tenant();
    const b = await tenant();
    const secretA = (await registry().linkGithubRepo(`${a}/demo`, a)).webhook_secret;
    await registry().linkGithubRepo(`${b}/demo`, b);
    const refusals = await Promise.all([
      deliver("wrong", "issue_comment", comment(`${a}/demo`, 1, "@always-on-agent hi")),
      // Tenant A's secret cannot sign an event in the name of tenant B's repository.
      deliver(secretA, "issue_comment", comment(`${b}/demo`, 1, "@always-on-agent hi")),
      deliver(secretA, "issue_comment", comment("nobody/nothing", 1, "@always-on-agent hi")),
    ]);
    const bodies = await Promise.all(refusals.map((r) => r.text()));
    expect(refusals.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(new Set(bodies).size).toBe(1);
    expect((await brainFor(`${b}:repo:${b}/demo`).inspect()).inbox.pending).toBe(0);
  });

  it("keeps user ids free of ':' from now on, and leaves links made before that as they are", async () => {
    const t = await tenant();
    // Called inside the object: a rejection carried back over RPC is reported as unhandled here.
    const refusal = await runInDurableObject(registry(), (instance: any) => instance.linkIdentity(t, "github", "5", "github:someone").then(() => "linked", String));
    expect(refusal).toMatch(/cannot contain ':'/);
    // Ids that were always fine stay fine, whatever else is in them.
    await registry().linkIdentity(t, "github", "6", "member@example.test");
    await registry().linkIdentity(t, "github", "6", "member@example.test");
    // A link made before the rule can be made again unchanged.
    await runInDurableObject(registry(), (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO identities (tenant, provider, external_id, user_id) VALUES (?, 'github', '7', 'github:old')", t);
    });
    await registry().linkIdentity(t, "github", "7", "github:old");
    expect(await registry().resolveIdentity(t, "github", "7")).toBe("github:old");
  });

  it("links a person by account id and lets them answer an open question without a mention", async () => {
    const t = await tenant();
    const repo = `${t}/demo`;
    const { webhook_secret } = await registry().linkGithubRepo(repo, t);
    await registry().linkIdentity(t, "github", "77", "dana");
    const brain = brainFor(`${t}:repo:${repo}`);

    // An unaddressed comment with a code-shaped word, while nothing is open, is other people's talk.
    expect(await (await deliver(webhook_secret, "issue_comment", comment(repo, 1, "HTTP looks fine"))).json()).toMatchObject({ ignored: expect.any(String) });

    model.replies([call("dispatch_task", { title: "fix", brief: "b", repository: `https://github.com/${repo}` })], [say("")]);
    await deliver(webhook_secret, "issue_comment", comment(repo, 2, "@always-on-agent please fix it"));
    await wake(brain);
    const state = await brain.inspect();
    expect(state.tasks[0]).toMatchObject({ status: "running", requested_by: "dana" });

    await brain.taskEvent(state.tasks[0].id, 1, "needs_input", { source: "gate", id: "q-1", command: "rm -rf x" });
    const code = (await brain.outboxSince("github", 0)).find((m: any) => m.text.includes("needs approval")).text.match(/approve ([A-Z0-9]{4})/)[1];
    // Now the same kind of unaddressed comment is a reply, because it quotes the open question's code.
    expect(await (await deliver(webhook_secret, "issue_comment", comment(repo, 3, `no ${code}`))).json()).toMatchObject({ accepted: true });
    // And one from somebody without standing in the repository still is not.
    expect((await deliver(webhook_secret, "issue_comment", comment(repo, 4, `approve ${code}`, "NONE"))).status).toBe(202);
    expect((await brain.inspect()).recent_events.filter((e: any) => e.text?.includes(code) && e.kind === "message")).toHaveLength(1);
    // The same code quoted in another pull request is not a reply to this one's question.
    const elsewhere = { ...comment(repo, 5, `deny ${code}`), issue: { number: 9, pull_request: {} } };
    expect(await (await deliver(webhook_secret, "issue_comment", elsewhere)).json()).toMatchObject({ ignored: expect.any(String) });
    // A request with no event header, or a body that is not JSON, is refused like any other.
    expect((await post("/v1/github/webhook", "{}", {})).status).toBe(401);
    expect((await post("/v1/github/webhook", "not json", { "x-github-event": "ping" })).status).toBe(401);
    // So is one whose fields are of types that cannot be what they claim.
    expect((await post("/v1/github/webhook", JSON.stringify({ installation: { id: { toString: 1 } } }), { "x-github-event": "ping" })).status).toBe(401);
  });
});

describe("the Feishu webhook endpoint", () => {
  const ENCRYPT_KEY = "test-encrypt-key";
  async function encrypt(plain: string) {
    const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ENCRYPT_KEY)), { name: "AES-CBC" }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(plain)));
    return btoa(String.fromCharCode(...iv, ...data));
  }
  async function deliver(appId: string, payload: unknown, options: { sign?: boolean; age?: number } = {}) {
    const body = JSON.stringify({ encrypt: await encrypt(JSON.stringify(payload)) });
    const timestamp = String(Math.floor(Date.now() / 1_000) - (options.age ?? 0));
    const signature = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${timestamp}nonce${ENCRYPT_KEY}${body}`)));
    const headers: Record<string, string> = options.sign === false ? {} : { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": "nonce", "x-lark-signature": signature };
    return post(`/v1/feishu/events/${appId}`, body, headers);
  }
  const message = (appId: string, id: string, text: string, chat: "p2p" | "group" = "p2p", mentions: unknown[] = []) => ({
    schema: "2.0",
    header: { event_id: `ev-${id}`, event_type: "im.message.receive_v1", app_id: appId, tenant_key: "org" },
    event: {
      sender: { sender_type: "user", tenant_key: "org", sender_id: { open_id: "ou_frank" } },
      message: { message_id: id, chat_id: chat === "p2p" ? "oc_dm" : "oc_group", chat_type: chat, message_type: "text", content: JSON.stringify({ text }), mentions },
    },
  });
  async function app() {
    const t = await tenant();
    const appId = `cli_${t}`;
    await registry().setFeishuApp(t, { app_id: appId, app_secret: "s", encrypt_key: ENCRYPT_KEY, bot_open_id: "ou_bot" });
    return { t, appId };
  }

  it("tells the person to press again when a card press could not be filed, and never says it was received", async () => {
    const { appId } = await app();
    const press = (decision: string) => ({
      schema: "2.0",
      header: { event_id: `press-${decision}`, event_type: "card.action.trigger", app_id: appId, tenant_key: "org" },
      event: { operator: { open_id: "ou_frank", tenant_key: "org" }, action: { value: { aoa: "answer", decision, code: "K7PW", q: "ask:11111111-2222-3333-4444-555555555555:1", to: "chat" } }, context: { open_chat_id: "oc_group" } },
    });
    const request = async (payload: unknown) => {
      const body = JSON.stringify({ encrypt: await encrypt(JSON.stringify(payload)) });
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const signature = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${timestamp}nonce${ENCRYPT_KEY}${body}`)));
      return new Request(`https://agent.test/v1/feishu/events/${appId}`, { method: "POST", body, headers: { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": "nonce", "x-lark-signature": signature } });
    };
    // Filed: the person is told so.
    const filed = await handleFeishuWebhook(await request(press("deny")), env as any, appId);
    expect(((await filed.json()) as any).toast).toMatchObject({ type: "info" });
    // The store fails: a refusal must not be reported as received.
    const broken = { ...(env as any), BRAIN: { getByName: () => ({ ingest: () => Promise.reject(new Error("storage is unavailable")) }) } };
    const lost = await handleFeishuWebhook(await request(press("deny")), broken, appId);
    const toast = ((await lost.json()) as any).toast;
    expect(toast.type).toBe("error");
    expect(toast.content).toContain("请再点一次");
    expect(toast.content).not.toContain("已收到");
    // The store is slow: the answer goes back in time, says it is not confirmed, and filing goes on.
    let finish: () => void = () => {};
    const deferred: Promise<unknown>[] = [];
    const slow = { ...(env as any), BRAIN: { getByName: () => ({ ingest: () => new Promise<void>((resolve) => (finish = resolve)) }) } };
    const started = Date.now();
    const pending = await handleFeishuWebhook(await request(press("approve")), slow, appId, (work) => deferred.push(work));
    expect(Date.now() - started).toBeLessThan(2_900);
    expect(((await pending.json()) as any).toast).toMatchObject({ type: "warning" });
    expect(deferred).toHaveLength(1);
    finish();
    expect(await deferred[0]).toBe("filed");
  });

  it("answers Feishu's address check, which is encrypted but not signed", async () => {
    const { appId } = await app();
    const response = await deliver(appId, { type: "url_verification", challenge: "abc" }, { sign: false });
    expect(await response.json()).toEqual({ challenge: "abc" });
  });

  it("accepts an encrypted, signed message and routes it by sender and chat", async () => {
    const { t, appId } = await app();
    expect(await (await deliver(appId, message(appId, "om_1", "hello"))).json()).toMatchObject({ accepted: true, scope: `${t}:user:ou_frank` });
    expect(await (await deliver(appId, message(appId, "om_1", "hello"))).json()).toMatchObject({ duplicate: true });
    const mention = { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" };
    expect(await (await deliver(appId, message(appId, "om_2", "@_user_1 hi", "group", [mention]))).json()).toMatchObject({ scope: `${t}:chat:oc_group` });
    expect(await (await deliver(appId, message(appId, "om_3", "lunch?", "group"))).json()).toEqual({ ignored: true });
  });

  it("files and acknowledges a group reply without asking Feishu anything; the replied-to message is fetched for the Brain when it asks", async () => {
    const { t, appId } = await app();
    const asked: string[] = [];
    let lapsed = 0;
    let issued = 0;
    const modelFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://model.test/")) return modelFetch(input, init);
      // What the agent says back is no part of this either.
      if (url.endsWith("/reply")) return Response.json({ code: 0, data: { message_id: "om_said" } });
      // The "got it" reaction on the message is no part of this; nor is which call asked for the app's token.
      if (url.endsWith("/reactions")) return Response.json({ code: 0, data: {} });
      if (url.endsWith("/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: `t-${++issued}`, expire: 7200 });
      asked.push(`${url.replace("https://open.feishu.cn/open-apis", "")} as ${String((init?.headers as Record<string, string>)?.authorization)}`);
      // The first token has lapsed early: a fresh one is got and the look-up made again.
      if (lapsed-- > 0) return Response.json({ code: 99991663 }, { status: 400 });
      return Response.json({ code: 0, data: { items: [{ message_id: "om_parent", msg_type: "text", chat_id: "oc_group", sender: { id: "ou_frank", sender_type: "user", tenant_key: "org" }, body: { content: JSON.stringify({ text: "the notes https://x.feishu.cn/docx/D1" }) } }] } });
    });
    const mention = { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" };
    const body = message(appId, "om_r1", "@_user_1 look into it", "group", [mention]);
    expect(await (await deliver(appId, { ...body, event: { ...body.event, message: { ...body.event.message, parent_id: "om_parent" } } })).json()).toMatchObject({ accepted: true });
    expect(asked.filter((each) => each.startsWith("/im/v1/messages/om_parent"))).toEqual([]);
    // The Brain asks through the connector as it takes the message up, and the model is shown what came back.
    model.replies([say("ok")]);
    await wake(brainFor(`${t}:chat:oc_group`));
    expect(JSON.stringify(modelCalls.at(-1).input)).toContain("[An earlier message of theirs that this leads back to, which you were not sent:]\\nthe notes https://x.feishu.cn/docx/D1");
    expect(asked.filter((each) => each.startsWith("/im/v1/messages/om_parent"))).toHaveLength(1);
    asked.length = 0;
    lapsed = 1;
    const event = { principal: { kind: "human" as const, id: "ou_frank", explicit: true }, data: { replies_to: "feishu:message:om_parent", origin: { app_id: appId, tenant_key: "org" } } };
    expect(await quotedFeishu(env as any, { tenant: t, kind: "chat", id: "oc_group" }, event)).toEqual({ text: "the notes https://x.feishu.cn/docx/D1" });
    // Asked twice, the second time with a newer token.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/^\/im\/v1\/messages\/om_parent\?user_id_type=open_id as Bearer t-\d+$/);
    expect(asked[1]).toMatch(/^\/im\/v1\/messages\/om_parent\?user_id_type=open_id as Bearer t-\d+$/);
    expect(asked[1]).not.toBe(asked[0]);
    // Not in a direct chat, and not through an app of another tenant.
    asked.length = 0;
    expect(await quotedFeishu(env as any, { tenant: t, kind: "user", id: "ou_frank" }, event)).toBeUndefined();
    expect(await quotedFeishu(env as any, { tenant: "another", kind: "chat", id: "oc_group" }, event)).toEqual({});
    expect(asked).toEqual([]);
  });

  it("shows a card to one person alone in a chat when the address names who may see it, and says exactly how that went", async () => {
    const { t, appId } = await app();
    const who = { app_id: appId, tenant_key: "org_x", open_id: "ou_frank" };
    const grant = await grantOf(env as any, who);
    const made = (await grant.invite(who, "https://agent.test/v1/feishu/oauth/callback", ["docx:document:readonly"], { generation: 1 }, { brain: `${t}:chat:oc_group`, key: "om_q" })) as { nonce: string };
    const interaction = `${await grantName(who)}.${made.nonce}`;
    const here = { connector: "feishu", address: { app_id: appId, chat_id: "oc_group", visible_to: "ou_frank" } };
    const scope = { tenant: t, kind: "chat" as const, id: "oc_group" };
    const message = { id: 1, idem: "invite:x", text: "需要你先授权", created_at: 0, interaction };
    const asked: { url: string; body: any }[] = [];
    let answer: () => Response = () => Response.json({ code: 0, data: { message_id: "om_card" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "t-1", expire: 7200 });
      asked.push({ url: url.replace("https://open.feishu.cn/open-apis", ""), body: JSON.parse(String(init?.body)) });
      return answer();
    });
    expect(await deliverFeishu(env as any, scope, here, message)).toEqual({ subject: "feishu:message:om_card", holder: "" });
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe("/ephemeral/v1/send");
    expect(asked[0].body).toMatchObject({ chat_id: "oc_group", open_id: "ou_frank", msg_type: "interactive" });
    // Nothing that would make Feishu drop a repeat goes along: there is no such thing here.
    expect(asked[0].body.uuid).toBeUndefined();
    expect(JSON.stringify(asked[0].body.card)).toContain("accounts.feishu.cn");
    // Taken, even where Feishu does not say which message it became: a second one is never made for that.
    answer = () => Response.json({ code: 0, data: {} });
    expect(await deliverFeishu(env as any, scope, here, message)).toBeUndefined();
    // Told to come back later: nothing was shown. Refused: nothing was shown. Anything else: no telling.
    answer = () => Response.json({ code: 99991400, msg: "too many" }, { status: 429 });
    expect(await deliverFeishu(env as any, scope, here, message).catch((error) => error)).toBeInstanceOf(DeliveryDeferred);
    answer = () => Response.json({ code: 230002, msg: "not in chat" }, { status: 400 });
    expect(await deliverFeishu(env as any, scope, here, message).catch((error) => error)).toBeInstanceOf(DeliveryRejected);
    answer = () => new Response("bad gateway", { status: 502 });
    const unknown = await deliverFeishu(env as any, scope, here, message).catch((error) => error);
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown instanceof DeliveryRejected || unknown instanceof DeliveryDeferred).toBe(false);
    // Only a way in is shown like this: words for one person in front of the others are not something Feishu has.
    await expect(deliverFeishu(env as any, scope, here, { id: 2, idem: "m", text: "hello", created_at: 0 })).rejects.toBeInstanceOf(DeliveryRejected);
    // And never to someone directly and in a chat at once.
    await expect(deliverFeishu(env as any, scope, { connector: "feishu", address: { app_id: appId, open_id: "ou_frank", visible_to: "ou_frank" } }, message)).rejects.toThrow("bad Feishu address");
    // Where that is, from where a request verifiably came; and that a repeat is never dropped there.
    expect(feishuConnector.channel!.aside!({ app_id: appId, tenant_key: "org_x" }, "ou_frank", { connector: "feishu", address: { app_id: appId, chat_id: "oc_group", message_id: "om_q" } })).toEqual(here);
    expect(feishuConnector.channel!.aside!({ app_id: appId, tenant_key: "org_x" }, "ou_frank", { connector: "feishu", address: { app_id: "cli_other", chat_id: "oc_group" } })).toBeUndefined();
    expect(feishuConnector.channel!.aside!({ app_id: appId, tenant_key: "org_x" }, "ou_frank", { connector: "feishu", address: { app_id: appId, open_id: "ou_frank" } })).toBeUndefined();
    // What a message sent to an address is written under: the message a reply in a chat names, and nothing else.
    const under = feishuConnector.channel!.under!;
    expect(under({ connector: "feishu", address: { app_id: appId, chat_id: "oc_group", message_id: "om_q" } })).toBe("feishu:message:om_q");
    expect([{ app_id: appId, chat_id: "oc_group" }, { app_id: appId, open_id: "ou_frank" }, { app_id: appId, chat_id: "oc_group", message_id: "om_q", thread: "1" }, { app_id: appId, chat_id: "oc_group", visible_to: "ou_frank" }, { app_id: appId, chat_id: "oc_group", message_id: "not an id!" }].map((address) => under({ connector: "feishu", address: address as any }))).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const window = feishuConnector.channel!.dedupeMs as (target: any) => number;
    expect([window(here), window({ connector: "feishu", address: { app_id: appId, chat_id: "oc_group" } })]).toEqual([0, 3_600_000]);
  });

  it("sends to a person directly when the address names them, and to a chat when it names that", async () => {
    const { t, appId } = await app();
    const asked: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "t-1", expire: 7200 });
      asked.push({ url: url.replace("https://open.feishu.cn/open-apis", ""), body: JSON.parse(String(init?.body)) });
      return Response.json({ code: 0, data: { message_id: `om_${asked.length}` } });
    });
    const scope = { tenant: t, kind: "chat" as const, id: "oc_group" };
    const message = { id: 1, idem: "m1", text: "hello", created_at: 0 };
    expect(await deliverFeishu(env as any, scope, { connector: "feishu", address: { app_id: appId, open_id: "ou_frank" } }, message)).toEqual({ subject: "feishu:message:om_1", holder: "" });
    expect(await deliverFeishu(env as any, scope, { connector: "feishu", address: { app_id: appId, chat_id: "oc_group" } }, { ...message, idem: "m2" })).toMatchObject({ subject: "feishu:message:om_2" });
    expect(asked.map((each) => [each.url, each.body.receive_id])).toEqual([
      ["/im/v1/messages?receive_id_type=open_id", "ou_frank"],
      ["/im/v1/messages?receive_id_type=chat_id", "oc_group"],
    ]);
    // Not now (limited, or the app's token lapsed early) is not a refusal: nothing was posted, and it can go later.
    const answers: [number, unknown, Record<string, string>?][] = [[429, { code: 99991400, msg: "too many" }, { "retry-after": "900" }], [400, { code: 99991663, msg: "token" }], [400, { code: 230002, msg: "not in chat" }]];
    let tokens = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: `t-again-${++tokens}`, expire: 7200 });
      const [status, body, headers] = answers.shift()!;
      return Response.json(body, { status, headers });
    });
    const person = { connector: "feishu", address: { app_id: appId, open_id: "ou_frank" } };
    const before = Date.now();
    const limited = await deliverFeishu(env as any, scope, person, message).catch((error) => error);
    expect(limited).toBeInstanceOf(DeliveryDeferred);
    // For as long as Feishu says, however long: never sooner.
    expect(limited.notBefore - before).toBeGreaterThanOrEqual(900_000);
    expect(await deliverFeishu(env as any, scope, person, message).catch((error) => error)).toBeInstanceOf(DeliveryDeferred);
    // The lapsed token was forgotten: the next attempt asks for a fresh one.
    expect(await deliverFeishu(env as any, scope, person, message).catch((error) => error)).toBeInstanceOf(DeliveryRejected);
    expect(tokens).toBe(1);
    // Neither named: nowhere to send.
    await expect(deliverFeishu(env as any, scope, { connector: "feishu", address: { app_id: appId } }, message)).rejects.toThrow("bad Feishu address");
  });

  it("refuses unsigned, stale and plaintext events, and events for an app it does not know, all alike", async () => {
    const { appId } = await app();
    const refusals = [
      await deliver(appId, message(appId, "om_9", "hi"), { sign: false }),
      await deliver(appId, message(appId, "om_9", "hi"), { age: 3_600 }),
      await post(`/v1/feishu/events/${appId}`, JSON.stringify(message(appId, "om_9", "hi")), {}),
      // Signed and encrypted correctly, but the envelope names a different app.
      await deliver(appId, message("cli_other", "om_9", "hi")),
    ];
    expect(refusals.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(new Set(await Promise.all(refusals.map((r) => r.text()))).size).toBe(1);
    expect((await post("/v1/feishu/events/cli_unknown", "{}", {})).status).toBe(404);
  });

  it("does not let one tenant take over another tenant's app registration", async () => {
    const { appId } = await app();
    const other = await tenant();
    // Called inside the object and caught there: a refusal thrown across the RPC boundary is also
    // reported by the test runtime as an unhandled error, which fails the run although the test passes.
    const refusal = await runInDurableObject(registry(), async (instance: any) => {
      try {
        await instance.setFeishuApp(other, { app_id: appId, app_secret: "x", encrypt_key: "k" });
        return "accepted";
      } catch (err) {
        return String(err);
      }
    });
    expect(refusal).toMatch(/another tenant/);
    // And the registration is still the first tenant's.
    expect((await registry().feishuApp(appId))?.tenant).not.toBe(other);
  });
});
