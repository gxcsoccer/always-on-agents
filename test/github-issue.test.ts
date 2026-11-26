/**
 * Opening an issue on GitHub as the person who asked, from the chat they write in: the whole way,
 * with the real Brain and stand-ins for GitHub and the chat service.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { challengeOf } from "../src/connectors/feishu-grant";
import { normalize } from "../src/connectors/feishu";
import { grantName } from "../src/connectors/github-grant";
import { scopeName } from "../src/events";
import type { FeishuApp } from "../src/registry";
import { call, installFakeModel, model, modelCalls, say, wake } from "./helpers";

const TENANT = "gh";
const CHAT_APP = "cli_gh";
const ORG = "org_gh";
const APP: FeishuApp = { app_id: CHAT_APP, tenant: TENANT, app_secret: "chat-secret", encrypt_key: null, verification_token: null, bot_open_id: "ou_bot", token: null, token_expires_at: null, transport: "long_connection", oauth_v2: 0, oauth_offline: 0 };
const PUBLIC = "acme/site";
const PRIVATE = "acme/core";

/** GitHub and the chat service, as far as these tests need them. */
const world = {
  sent: [] as { to: string; type: string; content: any }[],
  codes: new Map<string, { account: number; challenge: string; redirect: string }>(),
  /** Tokens GitHub has issued: whose, and whether each is still good. */
  tokens: new Map<string, { account: number; good: boolean }>(),
  refreshes: new Map<string, number>(),
  repos: new Map<string, { id: number; private: boolean; full_name: string; members: number[] }>(),
  issues: [] as { repo: string; number: number; html_url: string; title: string; body: string; user: { id: number } }[],
  /** Every creation asked of GitHub. */
  writes: [] as { repo: string; body: any; bearer: string }[],
  /** How many of the next creations GitHub takes without the answer coming back. */
  dropAnswers: 0,
  /** GitHub does not answer a listing of issues. */
  listingDown: false,
  /** GitHub does not answer when asked about a repository. */
  reposDown: false,
  /** GitHub gives no answer to a renewal. */
  renewalsDown: false,
  duringWrite: undefined as undefined | (() => unknown),
  renewals: 0,
  /** How long an access token lasts, in seconds. */
  lasts: 28_800,
  external: new Set<string>(),
  /** Accounts that cannot see the repositories that are not public. */
  strangers: new Set<number>(),
  issued: 0,
};
const loginOf = (account: number) => `user${account}`;


function installWorld() {
  world.sent.length = 0;
  world.codes.clear();
  world.tokens.clear();
  world.refreshes.clear();
  world.issues.length = 0;
  world.writes.length = 0;
  world.dropAnswers = 0;
  world.listingDown = false;
  world.reposDown = false;
  world.renewalsDown = false;
  world.duringWrite = undefined;
  world.renewals = 0;
  world.lasts = 28_800;
  world.external.clear();
  world.strangers.clear();
  world.repos.clear();
  world.repos.set(PUBLIC, { id: 101, private: false, full_name: "Acme/site", members: [] });
  world.repos.set(PRIVATE, { id: 102, private: true, full_name: "acme/core", members: [] });
  world.repos.set("other/thing", { id: 201, private: false, full_name: "other/thing", members: [] });
  const modelFetch = globalThis.fetch;
  const grant = (account: number) => {
    const n = ++world.issued;
    const [access, refresh] = [`ghu_${n}`, `ghr_${n}`];
    world.tokens.set(access, { account, good: true });
    world.refreshes.set(refresh, account);
    return { access_token: access, expires_in: world.lasts, refresh_token: refresh, refresh_token_expires_in: 15_897_600, token_type: "bearer", scope: "" };
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host === "model.test") return modelFetch(input, init);
    const bearer = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /, "");
    if (url.host === "open.feishu.cn") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.pathname.endsWith("/auth/v3/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "t-app", expire: 7200 });
      const chat = /\/im\/v1\/chats\/([^/]+)(\/members\/is_in_chat)?$/.exec(url.pathname);
      if (chat && (init?.method ?? "GET") === "GET") return Response.json({ code: 0, data: chat[2] ? { is_in_chat: true } : { external: world.external.has(chat[1]), tenant_key: ORG, chat_mode: "group", chat_status: "normal", name: "team" } });
      if (url.pathname.endsWith("/im/v1/messages") || /\/im\/v1\/messages\/[^/]+\/reply$/.test(url.pathname)) {
        const content = JSON.parse(body.content);
        const words = body.msg_type === "text" || body.msg_type === "post";
        world.sent.push({ to: body.receive_id ?? `reply:${/\/messages\/([^/]+)\/reply$/.exec(url.pathname)?.[1] ?? ""}`, type: words ? "text" : body.msg_type, content: body.msg_type === "post" ? { text: content.zh_cn.content.flat().map((each: any) => each.text).join("") } : content });
        return Response.json({ code: 0, data: { message_id: `om_sent_${world.sent.length}` } });
      }
      return Response.json({ code: 0, data: {} });
    }
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("client_id") !== "test-client-id" || form.get("client_secret") !== "test-client-secret") return Response.json({ error: "incorrect_client_credentials" });
      if (form.get("grant_type") === "refresh_token") {
        if (world.renewalsDown) return Response.json({ message: "unavailable" }, { status: 503 });
        world.renewals++;
        const account = world.refreshes.get(form.get("refresh_token") ?? "");
        // What renews a token is taken once, and what it renewed is no good from then on.
        world.refreshes.delete(form.get("refresh_token") ?? "");
        if (account === undefined) return Response.json({ error: "bad_refresh_token" });
        for (const [token, each] of world.tokens) if (each.account === account) world.tokens.set(token, { ...each, good: false });
        return Response.json(grant(account));
      }
      const consent = world.codes.get(form.get("code") ?? "");
      world.codes.delete(form.get("code") ?? "");
      if (!consent || consent.redirect !== form.get("redirect_uri") || (await challengeOf(String(form.get("code_verifier")))) !== consent.challenge) return Response.json({ error: "bad_verification_code" });
      return Response.json(grant(consent.account));
    }
    if (url.host !== "api.github.com") throw new Error(`unexpected fetch to ${url.href}`);
    // The tenant's own credential for its repositories, or a person's token.
    const tenant = bearer === "test-github-token";
    const user = world.tokens.get(bearer);
    if (!tenant && !user?.good) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/user") return Response.json({ id: user!.account, login: loginOf(user!.account) });
    const at = /^\/repos\/([^/]+\/[^/]+)(\/issues)?$/.exec(url.pathname);
    const repo = at ? world.repos.get(at[1].toLowerCase()) : undefined;
    if (!at || !repo || (!tenant && repo.private && world.strangers.has(user!.account))) return Response.json({ message: "Not Found" }, { status: 404 });
    if (!at[2] && world.reposDown) return Response.json({ message: "unavailable" }, { status: 503 });
    if (!at[2]) return Response.json({ id: repo.id, private: repo.private, full_name: repo.full_name });
    if ((init?.method ?? "GET") === "GET") {
      if (world.listingDown) return Response.json({ message: "down" }, { status: 502 });
      return Response.json(world.issues.filter((each) => each.repo === at[1].toLowerCase() && loginOf(each.user.id) === url.searchParams.get("creator")));
    }
    const body = JSON.parse(String(init?.body));
    world.writes.push({ repo: at[1].toLowerCase(), body, bearer });
    await world.duringWrite?.();
    const number = world.issues.length + 1;
    const made = { repo: at[1].toLowerCase(), number, html_url: `https://github.com/${repo.full_name}/issues/${number}`, title: body.title, body: body.body, user: { id: user!.account } };
    world.issues.push(made);
    if (world.dropAnswers > 0) return (world.dropAnswers--, Promise.reject(new Error("network")));
    return Response.json(made, { status: 201 });
  });
}

let people = 0;
let ticks = 0;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const rowsOf = (stub: any, query: string, ...args: unknown[]): Promise<any[]> => runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec(query, ...(args as any[])).toArray());
const admin = (method: string, path: string, body?: unknown) => (exports as any).default.fetch(new Request(`https://agent.test/v1/admin/${path}`, { method, headers: { authorization: "Bearer test-admin", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })) as Promise<Response>;
const registry = () => (env as any).REGISTRY.getByName("global");

async function rest(stub: any) {
  const busy = () =>
    runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
      const some = (query: string) => state.storage.sql.exec(query).toArray().length > 0;
      const run = state.storage.sql.exec("SELECT r.retry_at FROM runs r JOIN meta m ON m.value = r.id WHERE m.key = 'active_run'").toArray()[0] as { retry_at: number | null } | undefined;
      const next = state.storage.sql.exec("SELECT next_at FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 1").toArray()[0] as { next_at: number } | undefined;
      return (run !== undefined && !(run.retry_at && run.retry_at > Date.now())) || some("SELECT 1 FROM inbox WHERE status = 'pending'") || (next !== undefined && next.next_at <= Date.now());
    });
  for (let i = 0; i < 300; i++) {
    await wake(stub);
    if (!(await busy())) return;
    await sleep(10);
  }
  throw new Error("the Brain did not come to rest");
}

/** A person of a tenant, with a GitHub account of their own. */
function someone(tenant = TENANT, app = APP, org = ORG) {
  const openId = `ou_g${++people}`;
  const account = people;
  const who = { tenant, chat_app_id: app.app_id, tenant_key: org, open_id: openId };
  const grant = async () => (env as any).GITHUB_GRANTS.getByName(await grantName(who)) as any;
  let n = 0;
  const stored = async () => runInDurableObject(await grant(), (_i: unknown, state: DurableObjectState) => state.storage.get<any>("grant"));
  /** Where they talk to the agent: alone (their own chat), or in a chat several people share. */
  const at = (chatId?: string) => {
    const stub = (env as any).BRAIN.getByName(scopeName(chatId ? { tenant, kind: "chat", id: chatId } : { tenant, kind: "user", id: openId })) as any;
    const event = (text: string) =>
      normalize(app, {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", tenant_key: org, app_id: app.app_id },
        event: {
          sender: { sender_type: "user", tenant_key: org, sender_id: { open_id: openId } },
          message: chatId
            ? { message_id: `om_${chatId}_${openId}_${++n}`, chat_id: chatId, chat_type: "group", message_type: "text", content: JSON.stringify({ text: `@_user_1 ${text}` }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" }] }
            : { message_id: `om_${openId}_${++n}`, chat_id: `oc_${openId}`, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) },
        },
      })!.event;
    const says = async (text: string) => {
      await stub.ingest(event(text));
      await rest(stub);
    };
    /** Lets what is due happen: the grant telling the Brain, the Brain carrying on. */
    const settle = async () => {
      await runDurableObjectAlarm(await grant());
      await vi.waitFor(async () => expect((await stored())?.owed).toBeUndefined(), { interval: 5 });
      await rest(stub);
    };
    const later = async () => {
      await rowsOf(stub, "UPDATE continuations SET check_at = ? WHERE status = 'waiting' AND check_at IS NOT NULL", ++ticks);
      await rest(stub);
    };
    const to = chatId ?? `oc_${openId}`;
    const mine = (each: { to: string }) => each.to === to || each.to.startsWith(`reply:om_${chatId ? `${chatId}_` : `${openId}_`}`);
    const heard = () => world.sent.filter((each) => mine(each) && each.type === "text").map((each) => String(each.content.text));
    const cards = () => world.sent.filter((each) => mine(each) && each.type === "interactive").map((each) => each.content);
    return { stub, says, settle, later, heard, cards };
  };
  /** What they were sent directly, outside any chat they asked in. */
  const directly = (type: "text" | "interactive") => world.sent.filter((each) => each.to === openId && each.type === type).map((each) => each.content);
  return { openId, account, who, grant, stored, at, directly };
}

const linkOn = (card: any) => new URL(card.elements.find((e: any) => e.tag === "action").actions[0].url);
/** The person goes through GitHub's page as some account, comes back, and says on the page they are shown that the account is to be used. */
async function consent(authorize: URL, account: number, confirms = true): Promise<Response> {
  const back = new URL(authorize.searchParams.get("redirect_uri")!);
  back.searchParams.set("state", authorize.searchParams.get("state")!);
  const code = `code${Math.random().toString(36).slice(2)}`;
  world.codes.set(code, { account, challenge: authorize.searchParams.get("code_challenge")!, redirect: authorize.searchParams.get("redirect_uri")! });
  back.searchParams.set("code", code);
  const shown: Response = await (exports as any).default.fetch(new Request(back));
  if (shown.status !== 200 || !confirms) return shown;
  const html = await shown.text();
  expect(html).toContain(`@${loginOf(account)}`);
  return confirm(authorize.searchParams.get("state")!, /name="confirm" value="([^"]+)"/.exec(html)![1]);
}
const confirm = (state: string, word: string): Promise<Response> => (exports as any).default.fetch(new Request("https://agent.test/v1/github/oauth/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ state, confirm: word }) }));
const toolOutputs = (asked: any = modelCalls.at(-1)): any[] => {
  const input = asked.input as any[];
  return input.slice(input.map((each) => each.role).lastIndexOf("user") + 1).filter((each) => each.type === "function_call_output").map((each) => JSON.parse(each.output)).filter((each) => JSON.stringify(each) !== '{"ok":true}');
};
const opens = (repo: string, title = "重连后消息重复", body = "重连之后同一条消息收到两次。") => call("github_create_issue", { repo, title, body });
/** The model says something to the person, and stops. */
const done = (text: string) => [[call("send_message", { text })], [say("")]];
const offered = (asked: any): string[] => asked.tools.map((t: any) => t.name);
async function signed(event: string, payload: unknown, secret = "test-webhook-secret"): Promise<Response> {
  const raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return (exports as any).default.fetch(new Request("https://agent.test/v1/github/webhook", { method: "POST", headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${mac}`, "content-type": "application/json" }, body: raw }));
}
/** Asks for an issue alone with the agent, authorises when invited, and is left with it created. */
async function authorised(person: ReturnType<typeof someone>, repo = PUBLIC) {
  const alone = person.at();
  model.replies([opens(repo)], [say("")]);
  await alone.says(`在 ${repo} 提个 issue：重连后消息重复`);
  model.replies(...done("建好了"));
  expect((await consent(linkOn(alone.cards().at(-1)), person.account)).status).toBe(200);
  await alone.settle();
  return alone;
}

beforeEach(async () => {
  installFakeModel();
  installWorld();
  await registry().createTenant(TENANT, TENANT);
  await registry().setFeishuApp(TENANT, { app_id: CHAT_APP, app_secret: "chat-secret", bot_open_id: "ou_bot", transport: "long_connection" });
  for (const repo of [PUBLIC, PRIVATE]) await registry().linkGithubRepo(repo, TENANT);
});

describe("opening an issue on GitHub as the person who asked", () => {
  it("asks them to authorise once, creates it once in their name with what was asked, and says so where they asked", async () => {
    const ann = someone();
    const alone = ann.at();
    model.replies([opens(PUBLIC)], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：重连后消息重复`);
    expect(offered(modelCalls[0])).toContain("github_create_issue");
    // Nothing was created; she is shown how to authorise, and told what the authorisation covers.
    expect(world.writes).toEqual([]);
    expect(toolOutputs()).toEqual([{ waiting: true, request: expect.any(String), note: expect.any(String) }]);
    const authorize = linkOn(alone.cards()[0]);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: "test-client-id", redirect_uri: "https://agent.test/v1/github/oauth/callback", code_challenge_method: "S256" });
    expect(JSON.stringify(alone.cards()[0])).toContain("不只是建 issue");
    expect(JSON.stringify(alone.cards()[0])).toContain("重连后消息重复");

    model.replies(...done("建好了：https://github.com/Acme/site/issues/1"));
    expect((await consent(authorize, ann.account)).status).toBe(200);
    await alone.settle();
    // Once, as her, with the title and body as asked; the mark that finds it again shows nothing.
    expect(world.writes).toHaveLength(1);
    expect(world.tokens.get(world.writes[0].bearer)).toMatchObject({ account: ann.account });
    expect(world.writes[0].body.title).toBe("重连后消息重复");
    expect(world.writes[0].body.body).toMatch(/^重连之后同一条消息收到两次。\n\n<!-- request:[0-9a-f]{32} -->$/);
    expect(Object.keys(world.writes[0].body).sort()).toEqual(["body", "title"]);
    expect(toolOutputs()).toEqual([expect.objectContaining({ created: true, number: 1, url: "https://github.com/Acme/site/issues/1" })]);
    expect(alone.heard().at(-1)).toContain("https://github.com/Acme/site/issues/1");
    // The link is spent, and coming back through it again does nothing.
    expect((await consent(authorize, ann.account)).status).toBe(400);
    await alone.settle();
    expect(world.writes).toHaveLength(1);

    // The next one needs no authorisation, and nothing else is asked of her.
    model.replies([opens(PUBLIC, "第二个")], ...done("好了"));
    await alone.says(`再在 ${PUBLIC} 提一个：第二个`);
    expect(world.writes).toHaveLength(2);
    expect(alone.cards()).toHaveLength(1);
    // Nothing of a token is kept in the clear, and the operator is shown none.
    const kept = JSON.stringify(await ann.stored());
    for (const token of [...world.tokens.keys(), ...world.refreshes.keys()]) expect(kept).not.toContain(token);
    const status = await (await admin("GET", `github/grants/${TENANT}/${CHAT_APP}/${ORG}/${ann.openId}`)).text();
    expect(JSON.parse(status)).toMatchObject({ authorised: true, account: ann.account, issues: { posted: 2 } });
    expect(status).not.toMatch(/gh[ur]_/);
  });

  it("is done only in a repository the person named themselves, and only in one the tenant has connected", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const alone = ann.at();
    // The model names a repository she did not.
    model.replies([opens(PRIVATE)], ...done("哪个仓库？"));
    await alone.says("提个 issue：重连后消息重复");
    expect(toolOutputs()[0].error).toContain("has not named that repository");
    // Nor is a name that only contains it, or is contained in it, hers for that repository.
    model.replies([opens("acme/sit")], ...done("哪个仓库？"));
    await alone.says("提个 issue：重连后消息重复");
    expect(toolOutputs()[0].error).toContain("has not named that repository");
    // By its address on GitHub she has named it; an address elsewhere that ends the same way has not.
    model.replies([opens(PRIVATE, "按地址")], ...done("好了"));
    await alone.says("在 https://github.com/acme/core 提个 issue：按地址");
    expect(world.issues.at(-1)).toMatchObject({ repo: PRIVATE, title: "按地址" });
    const sofar = world.writes.length;
    model.replies([opens("docs/site")], ...done("哪个仓库？"));
    await alone.says("看 https://example.com/docs/site 提个 issue");
    expect(toolOutputs()[0].error).toContain("has not named that repository");
    expect(world.writes).toHaveLength(sofar);
    // One she named, which is not this tenant's: whatever her own account can reach there.
    model.replies([opens("other/thing")], ...done("不行"));
    await alone.says("在 other/thing 提个 issue：重连后消息重复");
    expect(toolOutputs()[0].error).toContain("not one this organisation has connected");
    // One linked to another tenant.
    await registry().createTenant("elsewhere", "elsewhere");
    await registry().linkGithubRepo("other/thing", "elsewhere");
    model.replies([opens("other/thing")], ...done("不行"));
    await alone.says("在 other/thing 提个 issue：重连后消息重复");
    expect(toolOutputs()[0].error).toContain("not one this organisation has connected");
    expect(world.writes).toHaveLength(sofar);
  });

  it("is there where several people talk, without the chat being opened to documents: the way in goes to the person alone, the result to the chat", async () => {
    const ann = someone();
    const here = ann.at("oc_team");
    model.replies([opens(PUBLIC)], [say("")]);
    await here.says(`在 ${PUBLIC} 提个 issue：重连后消息重复`);
    expect(offered(modelCalls[0])).toContain("github_create_issue");
    expect(offered(modelCalls[0])).not.toContain("feishu_read_document");
    // The card goes to her directly, never into the chat.
    expect(here.cards()).toEqual([]);
    expect(ann.directly("interactive")).toHaveLength(1);
    expect(JSON.stringify(ann.directly("interactive")[0])).toContain("结果会回到那个群里");
    model.replies(...done("建好了：https://github.com/Acme/site/issues/1"));
    expect((await consent(linkOn(ann.directly("interactive")[0]), ann.account)).status).toBe(200);
    await here.settle();
    expect(world.writes).toHaveLength(1);
    // A public repository: the link is said in the chat.
    expect(here.heard().at(-1)).toContain("https://github.com/Acme/site/issues/1");
    expect(ann.directly("text")).toEqual([]);
  });

  it("gives the link into a repository that is not public to the person alone, unless the chat is set up for that repository", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const here = ann.at("oc_team");
    model.replies([opens(PRIVATE)], ...done("建好了，链接私聊发你了"));
    await here.says(`在 ${PRIVATE} 提个 issue：重连后消息重复`);
    const made = world.issues.at(-1)!;
    expect(made.repo).toBe(PRIVATE);
    // The run in the chat is given neither the link nor the number; she is sent them directly, once.
    expect(toolOutputs()).toEqual([{ created: true, note: expect.stringContaining("sent to them directly") }]);
    expect(JSON.stringify(modelCalls.at(-1).input)).not.toContain(made.html_url);
    expect(here.heard().join("\n")).not.toContain(made.html_url);
    expect(ann.directly("text").map((each) => each.text)).toEqual([`acme/core#${made.number}\n${made.html_url}`]);
    expect(await rowsOf(here.stub, "SELECT text FROM outbox WHERE text LIKE ? AND target NOT LIKE ?", `%${made.html_url}%`, `%${ann.openId}%`)).toEqual([]);

    // A chat the operator set up to work on that repository is told.
    await registry().linkChatRepo(TENANT, "oc_core", PRIVATE);
    const there = ann.at("oc_core");
    model.replies([opens(PRIVATE, "又一个")], ...done("好了"));
    await there.says(`在 ${PRIVATE} 提个 issue：又一个`);
    expect(toolOutputs()).toEqual([expect.objectContaining({ created: true, url: world.issues.at(-1)!.html_url })]);
  });

  it("does nothing from a chat that includes people from outside, or that cannot be told to be the organisation's own", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const before = world.writes.length;
    world.external.add("oc_ext");
    const here = ann.at("oc_ext");
    model.replies([opens(PUBLIC)], ...done("这里不行"));
    await here.says(`在 ${PUBLIC} 提个 issue：重连后消息重复`);
    expect(toolOutputs()[0].error).toContain("people from outside");
    expect(world.writes).toHaveLength(before);
  });

  it("does not create it once the chat has come to include people from outside while the person was authorising", async () => {
    const ann = someone();
    const here = ann.at("oc_grows");
    model.replies([opens(PUBLIC)], [say("")]);
    await here.says(`在 ${PUBLIC} 提个 issue：重连后消息重复`);
    world.external.add("oc_grows");
    model.replies(...done("这里不行了"));
    expect((await consent(linkOn(ann.directly("interactive")[0]), ann.account)).status).toBe(200);
    await here.settle();
    expect(world.writes).toEqual([]);
  });

  it("creates one issue when the answer to creating it is lost, and says it is not known where it cannot look", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const alone = ann.at();
    // Taken, and the answer never arrives: found again by its mark, and not sent a second time.
    world.dropAnswers = 1;
    model.replies([opens(PUBLIC, "丢了回执")], ...done("好了"));
    await alone.says(`在 ${PUBLIC} 提个 issue：丢了回执`);
    expect(world.writes.filter((each) => each.body.title === "丢了回执")).toHaveLength(1);
    expect(toolOutputs()).toEqual([expect.objectContaining({ created: true, url: world.issues.at(-1)!.html_url })]);
    // The same, and it cannot be looked for either: said as not known, and left at that.
    world.dropAnswers = 1;
    world.listingDown = true;
    model.replies([opens(PUBLIC, "查不到")], ...done("不确定"));
    await alone.says(`在 ${PUBLIC} 提个 issue：查不到`);
    expect(toolOutputs()[0].error).toContain("could not be confirmed whether the issue was created");
    expect(world.writes.filter((each) => each.body.title === "查不到")).toHaveLength(1);
  });

  it("sends one creation for one call, however many times it is asked at once or again", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const grant = await ann.grant();
    const op = await grant.begin(ann.who, "call-twice", { repo: PUBLIC, repo_id: 101, private: false, title: "并发", body: "" }, "b");
    expect(op.stage).toBe("asked");
    const both = await Promise.all([grant.post("call-twice"), grant.post("call-twice")]);
    expect(both.map((each: any) => each.stage)).toEqual(["posted", "posted"]);
    expect((await grant.post("call-twice")).issue).toEqual(both[0].issue);
    expect(world.writes.filter((each) => each.body.title === "并发")).toHaveLength(1);
    // Asked for again under the same call with other words: it is the one kept.
    expect((await grant.begin(ann.who, "call-twice", { repo: PRIVATE, repo_id: 102, private: true, title: "别的", body: "" }, "b")).title).toBe("并发");
    // One the person cannot see themselves is not written to, whatever the tenant can.
    world.strangers.add(ann.account);
    await grant.begin(ann.who, "call-blind", { repo: PRIVATE, repo_id: 102, private: true, title: "看不到", body: "" }, "b");
    expect(await grant.post("call-blind")).toMatchObject({ stage: "failed", why: "no_access" });
    world.strangers.clear();
    // A name that has come to mean another repository is not written to.
    await grant.begin(ann.who, "call-moved", { repo: PUBLIC, repo_id: 999, private: false, title: "换了", body: "" }, "b");
    expect(await grant.post("call-moved")).toMatchObject({ stage: "failed", why: "moved" });
    expect(world.writes.filter((each) => each.body.title === "换了")).toEqual([]);
  });

  it("renews a token that has run out once, however many ask at once, and asks the person again when it cannot", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const alone = ann.at();
    const grant = await ann.grant();
    // The token it holds comes to the end of its time: the next uses renew it, once between them.
    await runInDurableObject(grant, async (_i: unknown, state: DurableObjectState) => {
      const kept = (await state.storage.get<any>("grant"))!;
      await state.storage.put("grant", { ...kept, grant: { ...kept.grant, expires_at: Date.now() } });
    });
    expect(world.renewals).toBe(0);
    expect(await Promise.all([grant.standing(), grant.standing()])).toEqual([expect.objectContaining({ authorised: true }), expect.objectContaining({ authorised: true })]);
    expect(world.renewals).toBe(1);
    model.replies([opens(PUBLIC, "换新之后")], ...done("好了"));
    await alone.says(`在 ${PUBLIC} 提个 issue：换新之后`);
    expect(world.issues.at(-1)!.title).toBe("换新之后");
    // With the token the renewal gave, and no other renewal.
    expect(world.tokens.get(world.writes.at(-1)!.bearer)).toMatchObject({ good: true });
    expect(world.renewals).toBe(1);
    // GitHub no longer takes what it holds (she took the authorisation away there): she is asked again, and nothing is created meanwhile.
    for (const [token, each] of world.tokens) world.tokens.set(token, { ...each, good: false });
    const before = world.writes.length;
    model.replies([opens(PUBLIC, "失效之后")], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：失效之后`);
    expect(world.writes).toHaveLength(before);
    expect(alone.cards()).toHaveLength(2);
    model.replies(...done("建好了"));
    expect((await consent(linkOn(alone.cards()[1]), ann.account)).status).toBe(200);
    await alone.settle();
    expect(world.issues.at(-1)!.title).toBe("失效之后");
  });

  it("takes one GitHub account for one person of a tenant, and leaves the operator's word on who is who alone", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const bob = someone();
    const alone = bob.at();
    model.replies([opens(PUBLIC)], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：重连后消息重复`);
    const before = world.writes.length;
    // Bob comes back as Ann's account.
    expect((await consent(linkOn(alone.cards()[0]), ann.account)).status).toBe(403);
    await alone.settle();
    expect(world.writes).toHaveLength(before);
    expect((await bob.stored()).grant).toBeUndefined();
    expect(world.writes).toHaveLength(before);
    // An account the operator has named as a user of the tenant (for what it says on GitHub): the
    // chat knows that person by another name, so this is no reason to refuse them, and the
    // operator's word is left as it was.
    await registry().linkIdentity(TENANT, "github", "777", "owner");
    const cat = someone();
    cat.account = 777;
    await authorised(cat);
    expect(await registry().resolveIdentity(TENANT, "github", "777")).toBe("owner");
    expect((await cat.stored()).grant?.account).toBe(777);
  });

  it("creates nothing for a request that waited once the authorisation is taken away here, and keeps tenants apart", async () => {
    // The same GitHub account, authorised by a person of each of two tenants.
    await registry().createTenant("two", "two");
    await registry().setFeishuApp("two", { app_id: "cli_two", app_secret: "s", bot_open_id: "ou_bot", transport: "long_connection" });
    await registry().linkGithubRepo("two/repo", "two");
    world.repos.set("two/repo", { id: 301, private: false, full_name: "two/repo", members: [] });
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const other = someone("two", { ...APP, app_id: "cli_two", tenant: "two" }, "org_two");
    other.account = ann.account;
    await authorised(other, "two/repo");
    expect(world.issues.map((each) => each.repo)).toEqual([PUBLIC, "two/repo"]);

    // Taken away in the first tenant: the other's stands.
    expect((await admin("DELETE", `github/grants/${TENANT}/${CHAT_APP}/${ORG}/${ann.openId}`)).status).toBe(200);
    expect((await (await admin("GET", `github/grants/two/cli_two/org_two/${other.openId}`)).json()) as any).toMatchObject({ authorised: true });
    const alone = ann.at();
    model.replies([opens(PUBLIC, "解绑之后")], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：解绑之后`);
    expect(alone.cards()).toHaveLength(2);
    // Taken away again while that request waits: coming back through its card creates nothing.
    await admin("DELETE", `github/grants/${TENANT}/${CHAT_APP}/${ORG}/${ann.openId}`);
    expect((await consent(linkOn(alone.cards()[1]), ann.account)).status).toBe(400);
    await alone.settle();
    expect(world.issues.map((each) => each.title)).not.toContain("解绑之后");

    // Taken away on GitHub: an event of the App's own, naming no repository. Every grant of that account is over.
    const revoked = { action: "revoked", sender: { id: ann.account, login: loginOf(ann.account) } };
    expect((await signed("github_app_authorization", revoked, "not-the-secret")).status).toBe(401);
    expect((await (await admin("GET", `github/grants/two/cli_two/org_two/${other.openId}`)).json()) as any).toMatchObject({ authorised: true });
    const taken = await signed("github_app_authorization", revoked);
    expect(taken.status).toBe(202);
    expect(await taken.json()).toEqual({ revoked: 1 });
    expect((await (await admin("GET", `github/grants/two/cli_two/org_two/${other.openId}`)).json()) as any).toMatchObject({ authorised: false });
  });
});

describe("whose GitHub account it is", () => {
  it("is not taken from whoever merely opens the link: nothing is kept to act with until the one at the browser says so, with a word only their page has", async () => {
    const mallory = someone();
    const alone = mallory.at();
    model.replies([opens(PUBLIC)], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：重连后消息重复`);
    const authorize = linkOn(alone.cards()[0]);
    // She hands her link to someone else, whose browser GitHub sends straight back.
    const victim = 9_001;
    const shown = await consent(authorize, victim, false);
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain("如果这次请求不是你自己在聊天里发起的");
    // Nothing to act with, and she cannot say yes in their place: she has the link, not the word.
    expect((await mallory.stored()).grant).toBeUndefined();
    expect((await confirm(authorize.searchParams.get("state")!, "a".repeat(43))).status).toBe(400);
    await alone.later();
    expect((await mallory.stored()).grant).toBeUndefined();
    expect(world.writes).toEqual([]);
    expect(await registry().githubGrantsOf(String(victim))).toEqual([]);
  });

  it("is one account for a person until they give it up themselves, which they can do in their own chat", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const alone = ann.at();
    // The token is turned away, and she comes back as another account: not taken.
    for (const [token, each] of world.tokens) world.tokens.set(token, { ...each, good: false });
    world.refreshes.clear();
    await runInDurableObject(await ann.grant(), async (_i: unknown, state: DurableObjectState) => {
      const kept = (await state.storage.get<any>("grant"))!;
      await state.storage.put("grant", { ...kept, grant: { ...kept.grant, expires_at: Date.now() } });
    });
    model.replies([opens(PUBLIC, "换号")], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：换号`);
    expect((await consent(linkOn(alone.cards().at(-1)), 9_002)).status).toBe(403);
    await alone.settle();
    expect(world.issues.map((each) => each.title)).not.toContain("换号");
    // She gives the first one up, and the other can then be hers.
    const asked = modelCalls.length;
    model.replies([call("github_disconnect", {})], ...done("已取消"));
    await alone.says("取消 GitHub 授权");
    expect(offered(modelCalls[asked])).toContain("github_disconnect");
    expect(await registry().githubGrantsOf(String(ann.account))).toEqual([]);
    model.replies([opens(PUBLIC, "换号之后")], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：换号之后`);
    model.replies(...done("建好了"));
    expect((await consent(linkOn(alone.cards().at(-1)), 9_002)).status).toBe(200);
    await alone.settle();
    expect(world.issues.at(-1)).toMatchObject({ title: "换号之后", user: { id: 9_002 } });
  });

  it("keeps what it holds when GitHub cannot be asked to renew it, and says that as what it is", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const alone = ann.at();
    await runInDurableObject(await ann.grant(), async (_i: unknown, state: DurableObjectState) => {
      const kept = (await state.storage.get<any>("grant"))!;
      await state.storage.put("grant", { ...kept, grant: { ...kept.grant, expires_at: Date.now() } });
    });
    world.renewalsDown = true;
    const before = world.writes.length;
    model.replies([opens(PUBLIC, "连不上")], ...done("稍后再试"));
    await alone.says(`在 ${PUBLIC} 提个 issue：连不上`);
    expect(toolOutputs()[0].error).toContain("could not be asked just now");
    expect(world.writes).toHaveLength(before);
    expect(alone.cards()).toHaveLength(1);
    expect((await ann.stored()).grant).toBeDefined();
    world.renewalsDown = false;
    model.replies([opens(PUBLIC, "连上了")], ...done("好了"));
    await alone.says(`在 ${PUBLIC} 提个 issue：连上了`);
    expect(world.issues.at(-1)!.title).toBe("连上了");
  });

  it("finds an issue it could not confirm, when asked about that call again, and never sends it again", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const grant = await ann.grant();
    await grant.begin(ann.who, "call-lost", { repo: PUBLIC, repo_id: 101, private: false, title: "找回", body: "正文" }, "b");
    world.dropAnswers = 1;
    world.listingDown = true;
    expect(await grant.post("call-lost")).toMatchObject({ stage: "lost" });
    expect(await grant.post("call-lost")).toMatchObject({ stage: "lost" });
    // Nor is it ever said not to have been created, whatever fails afterwards: here, the token cannot be renewed just now.
    await runInDurableObject(grant, async (_i: unknown, state: DurableObjectState) => {
      const kept = (await state.storage.get<any>("grant"))!;
      await state.storage.put("grant", { ...kept, grant: { ...kept.grant, expires_at: Date.now() } });
    });
    world.renewalsDown = true;
    expect(await grant.post("call-lost")).toMatchObject({ stage: "lost" });
    world.renewalsDown = false;
    world.listingDown = false;
    expect(await grant.post("call-lost")).toMatchObject({ stage: "posted", issue: { url: world.issues.at(-1)!.html_url } });
    expect(world.writes.filter((each) => each.body.title === "找回")).toHaveLength(1);
  });

  it("says of an issue that is there that it is there, and of one that may be that it is not known, when the same call is made again and a check cannot be made", async () => {
    const ann = await (async (p) => (await authorised(p), p))(someone());
    const alone = ann.at();
    const again = async (id: string, title: string) => {
      model.replies([call("github_create_issue", { repo: PUBLIC, title, body: "" }, id)], ...done("好"));
      await alone.says(`在 ${PUBLIC} 提个 issue：${title}`);
      return toolOutputs()[0];
    };
    // Created, and the same call comes again (the run was interrupted) while GitHub cannot be asked about the repository.
    expect(await again("call_same_1", "已建成")).toMatchObject({ created: true });
    const made = world.issues.at(-1)!;
    world.reposDown = true;
    expect(await again("call_same_1", "已建成")).toMatchObject({ created: true, url: made.html_url });
    world.reposDown = false;
    // Taken by GitHub and not confirmed; then the same.
    world.dropAnswers = 1;
    world.listingDown = true;
    expect((await again("call_same_2", "待核对")).error).toContain("could not be confirmed whether the issue was created");
    world.reposDown = true;
    const second = await again("call_same_2", "待核对");
    expect(second.error).toContain("could not be confirmed whether the issue was created");
    expect(second.error).not.toContain("nothing was created");
    expect(world.writes.filter((each) => ["已建成", "待核对"].includes(each.body.title))).toHaveLength(2);
  });

  it("lets a person give up an account whose binding was interrupted half-way, and take another", async () => {
    const ann = someone();
    const alone = ann.at();
    // The account was noted as hers, and nothing more came of it.
    expect(await registry().claimGithubPerson(TENANT, "9100", await grantName(ann.who), ann.openId)).toBe("new");
    model.replies([opens(PUBLIC)], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：重连后消息重复`);
    expect((await consent(linkOn(alone.cards().at(-1)), 9_101)).status).toBe(403);
    await alone.settle();
    model.replies([call("github_disconnect", {})], ...done("已取消"));
    await alone.says("取消 GitHub 授权");
    expect(await registry().githubGrantsOf("9100")).toEqual([]);
    model.replies([opens(PUBLIC, "之后")], [say("")]);
    await alone.says(`在 ${PUBLIC} 提个 issue：之后`);
    model.replies(...done("建好了"));
    expect((await consent(linkOn(alone.cards().at(-1)), 9_101)).status).toBe(200);
    await alone.settle();
    expect(world.issues.at(-1)).toMatchObject({ title: "之后", user: { id: 9_101 } });
  });
});
