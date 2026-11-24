import { handleFeishuWebhook, quotedFeishu } from "../src/connectors/feishu";
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
    expect(JSON.stringify(modelCalls.at(-1).input)).toContain("written as a reply to their own earlier message: \\\"the notes https://x.feishu.cn/docx/D1\\\"");
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
