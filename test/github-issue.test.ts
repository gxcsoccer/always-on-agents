/**
 * Opening an issue on GitHub as the person who asked, from the chat they write in: the whole way,
 * with the real Brain and stand-ins for GitHub and the chat service.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  comments: [] as { repo: string; number: number; id: number; html_url: string; body: string; user: { id: number } }[],
  /** Every comment asked of GitHub. */
  commentWrites: [] as { repo: string; number: number; body: any; bearer: string }[],
  /** Issues nobody may comment on. */
  locked: new Set<string>(),
  /** How GitHub answers when asked about an issue, where not as usual: by status. */
  looked: new Map<string, number>(),
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
  world.comments.length = 0;
  world.commentWrites.length = 0;
  world.locked.clear();
  world.looked.clear();
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
    // One issue, and its comments.
    const one = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/comments)?$/.exec(url.pathname);
    if (one) {
      const [name, number] = [one[1].toLowerCase(), Number(one[2])];
      const where = world.repos.get(name);
      const issue = world.issues.find((each) => each.repo === name && each.number === number);
      if (!where || !issue || (!tenant && where.private && world.strangers.has(user!.account))) return Response.json({ message: "Not Found" }, { status: 404 });
      if (!one[3] && world.looked.has(`${name}#${number}`)) return new Response(null, { status: world.looked.get(`${name}#${number}`)!, headers: { location: "https://api.github.com/repositories/1/issues/1" } });
      if (!one[3]) return Response.json({ number, title: issue.title, html_url: issue.html_url, locked: world.locked.has(`${name}#${number}`) });
      if ((init?.method ?? "GET") === "GET") {
        if (world.listingDown) return Response.json({ message: "down" }, { status: 502 });
        const page = Number(url.searchParams.get("page") ?? 1);
        // Oldest first, a hundred to a page, and not to be asked for by who wrote them.
        return Response.json(world.comments.filter((each) => each.repo === name && each.number === number).slice((page - 1) * 100, page * 100));
      }
      const body = JSON.parse(String(init?.body));
      world.commentWrites.push({ repo: name, number, body, bearer });
      await world.duringWrite?.();
      if (world.locked.has(`${name}#${number}`)) return Response.json({ message: "Unable to create comment because issue is locked." }, { status: 403 });
      const id = 9_000 + world.comments.length + 1;
      const made = { repo: name, number, id, html_url: `${issue.html_url}#issuecomment-${id}`, body: body.body, user: { id: user!.account } };
      world.comments.push(made);
      if (world.dropAnswers > 0) return (world.dropAnswers--, Promise.reject(new Error("network")));
      return Response.json(made, { status: 201 });
    }
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
    const event = (text: string, mentions: unknown[] = [], post?: unknown[][], parent?: string) =>
      normalize(app, {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", tenant_key: org, app_id: app.app_id },
        event: {
          sender: { sender_type: "user", tenant_key: org, sender_id: { open_id: openId } },
          message: chatId
            ? { message_id: `om_${chatId}_${openId}_${++n}`, chat_id: chatId, chat_type: "group", message_type: "text", content: JSON.stringify({ text: `@_user_1 ${text}` }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" }, ...mentions] }
            : { message_id: `om_${openId}_${++n}`, chat_id: `oc_${openId}`, chat_type: "p2p", ...(post ? { message_type: "post", content: JSON.stringify({ title: "", content: post }) } : { message_type: "text", content: JSON.stringify({ text }) }), ...(mentions.length ? { mentions } : {}), ...(parent ? { parent_id: parent, root_id: parent } : {}) },
        },
      })!.event;
    const says = async (text: string, mentions: unknown[] = [], post?: unknown[][], parent?: string) => {
      await stub.ingest(event(text, mentions, post, parent));
      await rest(stub);
      return `om_${openId}_${n}`;
    };
    /** Written as a reply to an earlier message, by that one's id. */
    const replies = (to: string, text: string) => says(text, [], undefined, to);
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
    return { stub, says, replies, settle, later, heard, cards };
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
const comments = (repo: string, number: number, body = "我这边也遇到了。") => call("github_comment", { repo, number, body });
/** An issue someone else opened, there to be commented on. */
const reported = (repo: string, number: number, title: string) => {
  const made = { repo, number, html_url: `https://github.com/${world.repos.get(repo)!.full_name}/issues/${number}`, title, body: "", user: { id: 9_999 } };
  world.issues.push(made);
  return made;
};
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
    expect(world.writes[0].body.body).toMatch(/^重连之后同一条消息收到两次。\n\n<!-- always-on-agent:request:[0-9a-f]{32} -->$/);
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
    expect(await registry().claimGithubPerson(TENANT, "9100", await grantName(ann.who))).toBe("new");
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

describe("commenting on GitHub as the person who asked", () => {
  it("asks them to authorise once, posts it once in their name on the one they named, and says what it is on", async () => {
    const ann = someone();
    const alone = ann.at();
    const issue = reported(PUBLIC, 7, "提醒的时区不对");
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await alone.says(`在 ${PUBLIC}#7 下面评论：我这边也遇到了`);
    expect(offered(modelCalls[0])).toContain("github_comment");
    // Nothing was posted, and nothing is said of the issue yet: she is shown how to authorise.
    expect(world.commentWrites).toEqual([]);
    expect(toolOutputs()).toEqual([{ waiting: true, request: expect.any(String), note: expect.any(String) }]);
    expect(JSON.stringify(alone.cards()[0])).not.toContain("提醒的时区不对");
    // The card says what it is for: a comment, and where, as she named it. Not an issue.
    expect(JSON.stringify(alone.cards()[0])).toContain("要以你的名义在 acme/site#7 下发表评论，需要你先授权");

    model.replies(...done("评论好了"));
    expect((await consent(linkOn(alone.cards()[0]), ann.account)).status).toBe(200);
    await alone.settle();
    // Once, as her, with the words as asked and nothing else; the mark is one the agent's own are known by.
    expect(world.commentWrites).toHaveLength(1);
    expect(world.tokens.get(world.commentWrites[0].bearer)).toMatchObject({ account: ann.account });
    expect(world.commentWrites[0]).toMatchObject({ repo: PUBLIC, number: 7 });
    expect(world.commentWrites[0].body.body).toMatch(/^我这边也遇到了。\n\n<!-- always-on-agent:request:[0-9a-f]{32} -->$/);
    expect(Object.keys(world.commentWrites[0].body)).toEqual(["body"]);
    expect(toolOutputs()).toEqual([expect.objectContaining({ posted: true, repo: "Acme/site", number: 7, on: "提醒的时区不对", url: `${issue.html_url}#issuecomment-9001` })]);
    // No issue was opened by it.
    expect(world.writes).toEqual([]);

    // The next needs no authorisation; named by its address this time.
    model.replies([comments(PUBLIC, 7, "再补充一点。")], ...done("好了"));
    await alone.says(`再到 https://github.com/Acme/site/issues/7 补一句：再补充一点`);
    expect(world.commentWrites).toHaveLength(2);
    expect(alone.cards()).toHaveLength(1);
    // A pull request is commented on the same way, and is named as one.
    reported(PUBLIC, 8, "修时区");
    model.replies([comments(PUBLIC, 8, "看过了。")], ...done("好了"));
    await alone.says(`在 https://github.com/acme/site/pull/8 评论：看过了`);
    expect(world.commentWrites.at(-1)).toMatchObject({ number: 8 });
  });

  it("posts nothing on one the person did not name, with nothing to say, or on what is not there", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    const cards = alone.cards().length;
    reported(PUBLIC, 7, "提醒的时区不对");
    reported(PUBLIC, 17, "别的事");
    // A number of the model's own choosing, which only looks like the one she wrote; no words; no number at all.
    const refused = async (asked: unknown) => {
      model.replies([asked as any], [say("")]);
      await alone.says(`去 ${PUBLIC}#7 评论一下，一共 17 个人遇到了`);
      return toolOutputs()[0].error as string;
    };
    expect(await refused(comments(PUBLIC, 17))).toContain("is not the issue or pull request the person pointed at");
    expect(await refused(call("github_comment", { repo: PUBLIC, number: 7, body: "  " }))).toContain("has to say something");
    expect(await refused(call("github_comment", { repo: PUBLIC, number: "7a", body: "x" }))).toContain("by its number");
    // One that is not there: said so, once her own token has looked.
    model.replies([comments(PUBLIC, 99)], [say("")]);
    await alone.says(`在 ${PUBLIC}#99 评论：我这边也遇到了`);
    expect(toolOutputs()[0].error).toContain("no issue or pull request of that number");
    // One nobody may comment on.
    world.locked.add(`${PUBLIC}#7`);
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await alone.says(`在 ${PUBLIC}#7 评论：我这边也遇到了`);
    expect(toolOutputs()[0].error).toContain("did not let the person comment there");
    expect(toolOutputs()[0].error).toContain("nothing was posted");
    world.locked.clear();
    // Moved to somewhere else: not this one to comment on. There, and not hers to see: said as that, not as GitHub being out of reach.
    for (const [status, said] of [[302, "no issue or pull request of that number"], [403, "did not let the person comment there"]] as const) {
      world.looked.set(`${PUBLIC}#7`, status);
      model.replies([comments(PUBLIC, 7)], [say("")]);
      await alone.says(`在 ${PUBLIC}#7 评论：我这边也遇到了`);
      expect(toolOutputs()[0].error).toContain(said);
    }
    expect(world.comments).toEqual([]);
    expect(alone.cards()).toHaveLength(cards);
  });

  it("finds one whose answer was lost, however far down the comments it is, and never posts it twice", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    // A busy issue: others have written a page and a half since.
    for (let i = 0; i < 150; i++) world.comments.push({ repo: PUBLIC, number: 7, id: i + 1, html_url: "x", body: `+${i}`, user: { id: 9_999 } });
    world.dropAnswers = 1;
    model.replies([comments(PUBLIC, 7)], ...done("评论好了"));
    await alone.says(`在 ${PUBLIC}#7 评论：我这边也遇到了`);
    expect(world.commentWrites).toHaveLength(1);
    expect(toolOutputs()[0]).toMatchObject({ posted: true, number: 7 });

    // Not to be found out: said as not known, with nothing sent again, then or when asked once more.
    world.dropAnswers = 1;
    world.listingDown = true;
    model.replies([comments(PUBLIC, 7, "第二条。")], ...done("不确定"));
    await alone.says(`在 ${PUBLIC}#7 再评论：第二条`);
    expect(world.commentWrites).toHaveLength(2);
    expect(toolOutputs()[0].error).toContain("could not be confirmed whether the comment was posted");
    expect(toolOutputs()[0].error).not.toContain("nothing was posted");
  });

  it("comments only on the one the person pointed at in the repository they named it in", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    for (const repo of [PUBLIC, PRIVATE]) for (const number of [7, 9]) reported(repo, number, `${repo} ${number}`);
    const asked = async (text: string, repo: string, number: number) => {
      model.replies([comments(repo, number)], ...done("好"));
      await alone.says(text);
      return toolOutputs()[0];
    };
    const both = `${PUBLIC}#7 和 ${PRIVATE}#9 是两件事，评论一下：我这边也遇到了`;
    // Two repositories, each with its own number: never one's name with the other's number.
    expect((await asked(both, PUBLIC, 9)).error).toContain("is not the issue or pull request the person pointed at");
    expect((await asked(both, PRIVATE, 7)).error).toContain("is not the issue or pull request the person pointed at");
    expect(world.commentWrites).toEqual([]);
    expect(await asked(both, PRIVATE, 9)).toMatchObject({ posted: true, repo: "acme/core", number: 9 });
    // A number by itself where two repositories are named: not plain which, so nothing.
    expect((await asked(`对比一下 ${PUBLIC} 和 ${PRIVATE}，在 #7 评论：我这边也遇到了`, PUBLIC, 7)).error).toContain("more than one repository");
    expect(world.commentWrites).toHaveLength(1);
  });

  it("takes a number by itself as of the repository the same message names, whatever was said of another before", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    for (const number of [7, 9]) reported(PUBLIC, number, `site ${number}`);
    reported(PRIVATE, 9, "core 9");
    // Something else, a moment ago.
    model.replies([say("")]);
    await alone.says(`${PRIVATE}#9 是另一件事，先不管`);
    // The number she wrote of the other repository is not this one's.
    model.replies([comments(PUBLIC, 9)], ...done("好"));
    await alone.says(`在 ${PUBLIC} 的 #7 评论：我这边也遇到了`);
    expect(toolOutputs()[0].error).toContain("is not the issue or pull request the person pointed at");
    expect(world.commentWrites).toEqual([]);
    model.replies([comments(PUBLIC, 7)], ...done("好"));
    await alone.says(`在 ${PUBLIC} 的 #7 评论：我这边也遇到了`);
    expect(world.commentWrites).toEqual([expect.objectContaining({ repo: PUBLIC, number: 7 })]);
  });

  it("comments on what the person points at now, not on what they pointed at before", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    for (const repo of [PUBLIC, PRIVATE]) for (const number of [7, 9]) reported(repo, number, `${repo} ${number}`);
    const asked = async (text: string, repo: string, number: number) => {
      model.replies([comments(repo, number)], ...done("好"));
      await alone.says(text);
      return toolOutputs()[0];
    };
    model.replies([say("")]);
    await alone.says(`先看一下 ${PUBLIC}#7`);
    // Another number of the same repository: the earlier one is not what she means any more.
    expect((await asked("改成 #9 吧，评论：我这边也遇到了", PUBLIC, 7)).error).toContain("is not the issue or pull request the person pointed at this time");
    expect(world.commentWrites).toEqual([]);
    expect(await asked("改成 #9 吧，评论：我这边也遇到了", PUBLIC, 9)).toMatchObject({ posted: true, number: 9 });
    // The same number in another repository.
    expect((await asked(`换成 ${PRIVATE} 的 #7，评论：我这边也遇到了`, PUBLIC, 7)).error).toContain("is not the issue or pull request the person pointed at this time");
    expect(await asked(`换成 ${PRIVATE} 的 #7，评论：我这边也遇到了`, PRIVATE, 7)).toMatchObject({ posted: true, repo: "acme/core", number: 7 });
    expect(world.commentWrites.map((each) => `${each.repo}#${each.number}`)).toEqual([`${PUBLIC}#9`, `${PRIVATE}#7`]);
    // Pointing at nothing this time, she goes on from what she said: the one she pointed at last, and no earlier one.
    expect((await asked("就在那下面再评论一句：我这边也遇到了", PUBLIC, 9)).error).toContain("is not the issue or pull request the person pointed at last");
    expect(await asked("就在那下面再评论一句：我这边也遇到了", PRIVATE, 7)).toMatchObject({ posted: true, number: 7 });
    const sent = world.commentWrites.length;
    // Another repository named now, and no number: nothing she pointed at in the one before is hers to go on with there.
    expect((await asked(`换到 ${PUBLIC} 那边评论：我这边也遇到了`, PRIVATE, 7)).error).toContain("is not the issue or pull request the person pointed at last");
    expect(world.commentWrites).toHaveLength(sent);
    // Two spoken of one after the other, then "that one": the later of them.
    for (const number of [7, 9]) {
      model.replies([say("")]);
      await alone.says(`再看看 ${PUBLIC}#${number}`);
    }
    expect((await asked("就在那条下面评论：我这边也遇到了", PUBLIC, 7)).error).toContain("is not the issue or pull request the person pointed at last");
    expect(world.commentWrites).toHaveLength(sent);
    expect(await asked("就在那条下面评论：我这边也遇到了", PUBLIC, 9)).toMatchObject({ posted: true, number: 9 });
    // Two at once, then "that one": not plain which.
    model.replies([say("")]);
    await alone.says(`${PUBLIC}#7 和 ${PUBLIC}#9 好像是一回事`);
    expect((await asked("就在那条下面评论：我这边也遇到了", PUBLIC, 9)).error).toContain("more than one issue or pull request before");
    expect(world.commentWrites).toHaveLength(sent + 1);
  });

  it("comments on the one in the message the person replied to, whatever they spoke of since", async () => {
    const ann = someone();
    const alone = ann.at();
    for (const number of [7, 9]) reported(PUBLIC, number, `site ${number}`);
    model.replies([say("")]);
    const first = await alone.says(`先看一下 ${PUBLIC}#7`);
    model.replies([say("")]);
    await alone.says(`再看看 ${PUBLIC}#9`);
    // She goes back to the first by replying to it. Not the one spoken of last.
    model.replies([comments(PUBLIC, 9)], ...done("好"));
    await alone.replies(first, "就在这条下面评论：我这边也遇到了");
    expect(toolOutputs()[0].error).toContain("is not the issue or pull request the person pointed at in what they replied to");
    expect(alone.cards()).toEqual([]);
    // The one she replied to; she has yet to authorise, and it is that one still when she has.
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await alone.replies(first, "就在这条下面评论：我这边也遇到了");
    expect(JSON.stringify(alone.cards()[0])).toContain("在 acme/site#7 下发表评论");
    model.replies(...done("评论好了"));
    expect((await consent(linkOn(alone.cards()[0]), ann.account)).status).toBe(200);
    await alone.settle();
    expect(world.commentWrites).toEqual([expect.objectContaining({ repo: PUBLIC, number: 7 })]);
    // A reply to something that points at nothing: asked which, not taken from what else was said.
    model.replies([say("")]);
    const idle = await alone.says("今天先这样");
    model.replies([comments(PUBLIC, 9)], ...done("好"));
    await alone.replies(idle, "就在这条下面评论：我这边也遇到了");
    expect(toolOutputs()[0].error).toContain("what they replied to does not say which");
    expect(world.commentWrites).toHaveLength(1);
  });

  it("notifies only those the person mentioned themselves in what they asked, in a comment as in an issue", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const colleague = [{ key: "@_user_1", id: { open_id: "ou_colleague" }, name: "colleague" }];
    const written = "谢谢 @Octo-Cat 的排查，另外 cc @stranger、@colleague、@quoted-one、@in-span 和 @acme/everyone。\n\n- 复现步骤\n    续行里的 @list-one\n\n```\n@in-code stays\n```";
    const sent = /^谢谢 @Octo-Cat 的排查，另外 cc `@stranger`、`@colleague`、`@quoted-one`、`@in-span` 和 `@acme\/everyone`。\n\n- 复现步骤\n    续行里的 `@list-one`\n\n```\n@in-code stays\n```\n\n<!--/;
    // A plain message of several lines. She types one name out; mentions a colleague of the chat, who is a person there
    // and not an account on GitHub; quotes a line that names someone; and shows a name in code.
    model.replies([comments(PUBLIC, 7, written)], ...done("好了"));
    await alone.says(`在 ${PUBLIC}#7 评论：谢谢 @octo-cat 和 @_user_1 的排查，写法见 \`@in-span\`\n> @quoted-one 之前说过\n这一行接着上面的引用，@stranger 也在里面`, colleague);
    expect(world.commentWrites[0].body.body).toMatch(sent);
    // The same in a message with formatting: her words, a block of code, the colleague.
    model.replies([comments(PUBLIC, 7, written)], ...done("好了"));
    await alone.says("", colleague, [[{ tag: "text", text: `在 ${PUBLIC}#7 评论：谢谢 @octo-cat 和 ` }, { tag: "at", user_id: "@_user_1" }, { tag: "text", text: " 的排查" }], [{ tag: "code_block", text: "@in-span\n@quoted-one" }]]);
    expect(world.commentWrites[1].body.body).toMatch(sent);
    // The same words give the same names whichever way they are written: a line that goes on from the one before (indented), and a quotation over two lines.
    const twoLines = ["谢谢 @octo-cat 的排查，", "    另外也请 @second-one 看一下", "> @quoted-one 之前说过", "这一行接着上面的引用，@stranger 也在里面"];
    const plain = normalize(APP, { schema: "2.0", header: { event_type: "im.message.receive_v1", tenant_key: ORG, app_id: CHAT_APP }, event: { sender: { sender_type: "user", tenant_key: ORG, sender_id: { open_id: "ou_x" } }, message: { message_id: "om_plain", chat_id: "oc_x", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: twoLines.join("\n") }) } } })!.event;
    const rich = normalize(APP, { schema: "2.0", header: { event_type: "im.message.receive_v1", tenant_key: ORG, app_id: CHAT_APP }, event: { sender: { sender_type: "user", tenant_key: ORG, sender_id: { open_id: "ou_x" } }, message: { message_id: "om_rich", chat_id: "oc_x", chat_type: "p2p", message_type: "post", content: JSON.stringify({ title: "", content: twoLines.map((text) => [{ tag: "text", text }]) }) } } })!.event;
    expect(plain.data?.handles).toEqual(["octo-cat", "second-one"]);
    expect(rich.data?.handles).toEqual(plain.data?.handles);
    // A title is the writer's too, and apart from what follows it.
    const titled = normalize(APP, { schema: "2.0", header: { event_type: "im.message.receive_v1", tenant_key: ORG, app_id: CHAT_APP }, event: { sender: { sender_type: "user", tenant_key: ORG, sender_id: { open_id: "ou_x" } }, message: { message_id: "om_titled", chat_id: "oc_x", chat_type: "p2p", message_type: "post", content: JSON.stringify({ title: "请 @in-title 看", content: [[{ tag: "text", text: "> @quoted-one 之前说过" }]] }) } } })!.event;
    expect(titled.data?.handles).toEqual(["in-title"]);
    // Nothing typed out as a mention: nobody is notified.
    model.replies([comments(PUBLIC, 7, "谢谢 @octo-cat。")], ...done("好了"));
    await alone.says(`在 ${PUBLIC}#7 评论：谢谢 octo-cat`);
    expect(world.commentWrites[2].body.body).toMatch(/^谢谢 `@octo-cat`。/);
    model.replies([opens(PUBLIC, "时区", "@stranger 说过这个。")], ...done("好了"));
    await alone.says(`在 ${PUBLIC} 提个 issue：时区`);
    expect(world.writes.at(-1)!.body.body).toMatch(/^`@stranger` 说过这个。\n\n<!--/);
  });

  it("gives the link, and what it is on, to the person alone where the others may not be able to see the repository", async () => {
    const ann = someone();
    await authorised(ann, PRIVATE);
    const issue = reported(PRIVATE, 7, "只有里面的人知道的事");
    const here = ann.at("oc_team");
    model.replies([comments(PRIVATE, 7)], ...done("评论好了，链接私下发你"));
    await here.says(`在 ${PRIVATE}#7 评论：我这边也遇到了`);
    expect(world.commentWrites).toHaveLength(1);
    expect(JSON.stringify(toolOutputs())).not.toContain("只有里面的人知道的事");
    expect(JSON.stringify(toolOutputs())).not.toContain("issuecomment");
    expect(here.heard().join("\n")).not.toContain("只有里面的人知道的事");
    expect(ann.directly("text").map((each) => each.text)).toEqual([`acme/core#7 只有里面的人知道的事\n${issue.html_url}#issuecomment-9001`]);
    // Why one could not be posted says whether what it was to be on is there: that too is hers alone.
    model.replies([comments(PRIVATE, 99)], ...done("没发成，原因私下发你"));
    await here.says(`在 ${PRIVATE}#99 评论：我这边也遇到了`);
    expect(toolOutputs()).toEqual([{ error: expect.stringContaining("Why is being sent to the person directly") }]);
    expect(JSON.stringify(toolOutputs())).not.toContain("no issue or pull request");
    expect(ann.directly("text").at(-1)!.text).toContain("acme/core#99: there is no issue or pull request of that number");
    world.locked.add(`${PRIVATE}#7`);
    model.replies([comments(PRIVATE, 7)], ...done("没发成，原因私下发你"));
    await here.says(`在 ${PRIVATE}#7 评论：我这边也遇到了`);
    expect(toolOutputs()).toEqual([{ error: expect.stringContaining("Why is being sent to the person directly") }]);
    expect(ann.directly("text").at(-1)!.text).toContain("did not let the person comment there");
    world.locked.clear();
    // In a public repository it is said where she asked, as the comment's link is.
    const open = reported(PUBLIC, 7, "提醒的时区不对");
    model.replies([comments(PUBLIC, 98)], ...done("没有这一条"));
    await here.says(`在 ${PUBLIC}#98 评论：我这边也遇到了`);
    expect(toolOutputs()[0].error).toContain("no issue or pull request of that number");
    const sentBefore = ann.directly("text").length;
    // Made private while it was being posted: by the time anything is said of it, the others may not see it.
    world.duringWrite = () => void (world.repos.get(PUBLIC)!.private = true);
    model.replies([comments(PUBLIC, 7)], ...done("评论好了，链接私下发你"));
    await here.says(`在 ${PUBLIC}#7 评论：我这边也遇到了`);
    world.duringWrite = undefined;
    expect(world.commentWrites.at(-1)).toMatchObject({ repo: PUBLIC, number: 7 });
    expect(JSON.stringify(toolOutputs())).not.toContain("issuecomment");
    expect(JSON.stringify(toolOutputs())).not.toContain("提醒的时区不对");
    expect(ann.directly("text").slice(sentBefore).map((each) => each.text)).toEqual([expect.stringContaining(`${open.html_url}#issuecomment-`)]);
    world.repos.get(PUBLIC)!.private = false;
    // Where the chat is outside the organisation's own, nothing is posted at all.
    const before = world.commentWrites.length;
    world.external.add("oc_guests");
    const guests = ann.at("oc_guests");
    model.replies([comments(PRIVATE, 7)], [say("")]);
    await guests.says(`在 ${PRIVATE}#7 评论：我这边也遇到了`);
    expect(toolOutputs()[0].error).toContain("nothing was posted");
    expect(world.commentWrites).toHaveLength(before);
  });

  it("gives it to the person alone, in a chat set up for the repository too, where it cannot be told that the name still means that repository", async () => {
    const ann = someone();
    await authorised(ann, PRIVATE);
    const issue = reported(PRIVATE, 7, "只有里面的人知道的事");
    await registry().linkChatRepo(TENANT, "oc_core_team", PRIVATE);
    const here = ann.at("oc_core_team");
    const posts = async () => {
      model.replies([comments(PRIVATE, 7)], ...done("评论好了"));
      await here.says(`在 ${PRIVATE}#7 评论：我这边也遇到了`);
      world.duringWrite = undefined;
      return JSON.stringify(toolOutputs());
    };
    // As it is set up: the chat works on this repository, so the link is given there.
    expect(await posts()).toContain("issuecomment");
    expect(ann.directly("text")).toEqual([]);
    // GitHub cannot be asked about the repository by the time it is to be said.
    world.duringWrite = () => void (world.reposDown = true);
    const unknown = await posts();
    world.reposDown = false;
    expect(unknown).not.toContain("issuecomment");
    expect(unknown).not.toContain("只有里面的人知道的事");
    expect(ann.directly("text").map((each) => each.text)).toEqual([expect.stringContaining(`${issue.html_url}#issuecomment-`)]);
    // The name has come to mean another repository.
    world.duringWrite = () => void (world.repos.get(PRIVATE)!.id = 999);
    const renamed = await posts();
    world.repos.get(PRIVATE)!.id = 102;
    expect(renamed).not.toContain("issuecomment");
    expect(renamed).not.toContain("只有里面的人知道的事");
    expect(ann.directly("text")).toHaveLength(2);
    expect(here.heard().join("\n")).not.toContain("只有里面的人知道的事");
  });

  it("still finds an issue that was sent under the mark as it used to be written, and sends neither kind again", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    const replay = async (asked: any) => {
      model.replies([asked], ...done("好"));
      await alone.says(`在 ${PUBLIC}#1 评论，或者提个 issue：升级前发的`);
      return toolOutputs()[0];
    };
    // Taken by GitHub, the answer lost, and not to be looked for: not known.
    world.dropAnswers = 1;
    world.listingDown = true;
    const issue = call("github_create_issue", { repo: PUBLIC, title: "升级前发的", body: "" }, "call_before_upgrade");
    expect((await replay(issue)).error).toContain("could not be confirmed whether the issue was created");
    // As it would be there had it been sent by the earlier version: the same mark, without what it now begins with.
    const sent = world.issues.at(-1)!;
    expect(sent.body).toContain("<!-- always-on-agent:request:");
    sent.body = sent.body.replace("always-on-agent:", "");
    world.listingDown = false;
    expect(await replay(issue)).toMatchObject({ created: true, url: sent.html_url });
    // Not there at all (someone removed it): still not known, and still not sent again.
    world.dropAnswers = 1;
    world.listingDown = true;
    const other = call("github_create_issue", { repo: PUBLIC, title: "找不到的", body: "" }, "call_not_found");
    await replay(other);
    world.issues.pop();
    world.listingDown = false;
    expect((await replay(other)).error).toContain("could not be confirmed whether the issue was created");
    expect(world.writes.filter((each) => ["升级前发的", "找不到的"].includes(each.body.title))).toHaveLength(2);
    // A comment made again by the same call is looked for, never posted again; and only by the mark as it is now.
    world.dropAnswers = 1;
    world.listingDown = true;
    const comment = call("github_comment", { repo: PUBLIC, number: 1, body: "重放的评论。" }, "call_comment_again");
    expect((await replay(comment)).error).toContain("could not be confirmed whether the comment was posted");
    world.listingDown = false;
    const posted = world.comments.at(-1)!;
    posted.body = posted.body.replace("always-on-agent:", "");
    expect((await replay(comment)).error).toContain("could not be confirmed whether the comment was posted");
    posted.body = posted.body.replace("<!-- request:", "<!-- always-on-agent:request:");
    expect(await replay(comment)).toMatchObject({ posted: true, url: posted.html_url });
    expect(world.commentWrites).toHaveLength(1);
  });

  it("is not taken for a request when it comes back from GitHub as her words", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    model.replies([comments(PUBLIC, 7, "@always-on-agent 也看一下这个。")], ...done("好了"));
    await alone.says(`在 ${PUBLIC}#7 评论：@always-on-agent 也看一下这个`);
    const posted = world.comments.at(-1)!;
    const { normalize: fromGithub } = await import("../src/connectors/github");
    const payload = (body: string) => ({ action: "created", repository: { full_name: "Acme/site" }, issue: { number: 7 }, sender: { id: ann.account, login: loginOf(ann.account), type: "User" }, comment: { id: posted.id, body, user: { id: ann.account, login: loginOf(ann.account) }, author_association: "MEMBER", created_at: "2026-11-26T00:00:00Z", updated_at: "2026-11-26T00:00:00Z" } });
    // The same words written by her own hand would be a request; with the mark they are the agent's.
    expect(fromGithub("issue_comment", payload("@always-on-agent 也看一下这个。"))?.event).toBeDefined();
    expect(fromGithub("issue_comment", payload(posted.body))).toBeUndefined();
  });
});

describe("doing for a person what they asked to have done once some work has been looked into", () => {
  const ASK = `帮我看看 https://github.com/${PUBLIC} 有没有时区相关的 issue，如果没有就提一个，如果有可以追加你的评论`;
  /** The work is handed to the sandbox; `then`: what the request said was to be done in the person's name after it. */
  const looks = (then: string[] | null, title = "查时区相关的 issue") => call("hand_over", { worker: "sandbox", title, brief: "在这个仓库的 issue 里找和提醒时区有关的。", continue_from: null, repository: `https://github.com/${PUBLIC}`, then });
  const BOTH = ["github_create_issue", "github_comment"];
  /** The person asks; the model hands the work over. The ids of the pieces of work, in the order handed over. */
  const asks = async (here: ReturnType<ReturnType<typeof someone>["at"]>, ...handed: unknown[]) => {
    model.replies(handed as any, [say("")]);
    await here.says(ASK);
    const ids = toolOutputs().map((each) => each.work_id as string);
    for (const id of ids) if (id) left.push({ stub: here.stub, id });
    return ids;
  };
  // Work left under way when a test is over is ended, so that it does not count against what the tenant may have running in the next.
  const left: { stub: any; id: string }[] = [];
  afterEach(async () => {
    model.replies(...Array(left.length * 2).fill([say("")]));
    for (const each of left.splice(0)) await each.stub.taskEvent(each.id, 99, "failed", { error: "the test is over" }).catch(() => undefined);
  });
  /** The work ends well, saying what it found; the Brain takes that up. */
  const ends = async (here: ReturnType<ReturnType<typeof someone>["at"]>, id: string, text: string, seq = 1) => {
    await here.stub.taskEvent(id, seq, "result", { text });
    await rest(here.stub);
  };
  const FOUND = "找到一条相关的：#7《提醒的时区不对》，还开着。";
  const NONE = "搜索完成，没有找到相关的 issue（开着和关着的都看了）。";

  it("comments on the one the work found, as the person, once; and what it said of the work is kept", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    const issue = reported(PUBLIC, 7, "提醒的时区不对");
    const read = async () => (await rowsOf(alone.stub, "SELECT COUNT(*) AS n FROM items WHERE outside != 0"))[0].n;
    const before = await read();
    const [id] = await asks(alone, looks(BOTH));
    // What may follow is offered by name when the work is handed over, and only what is done in a person's name.
    const handing = modelCalls.at(-2)!.tools.find((each: any) => each.name === "hand_over");
    // (Not taking the authorisation away: that is not something done once for a call.)
    expect(handing.parameters.properties.then.items.enum.sort()).toEqual([...BOTH, "github_create_issue:if_none_found"].sort());
    expect(handing.parameters.properties.then.description).toContain("- github_create_issue:if_none_found: only if the work");
    expect(world.commentWrites).toEqual([]);

    model.replies([comments(PUBLIC, 7, "我这边也遇到了：提醒按 UTC 算，差了 8 小时。")], ...done("在 #7 下评论了"));
    await ends(alone, id, FOUND);
    // The run the result started has the two tools she named and no other of the connector's; nothing more can be named to follow.
    const run = modelCalls.at(-3)!;
    expect(offered(run).filter((name) => name.startsWith("github_")).sort()).toEqual(BOTH.slice().sort());
    expect(run.tools.find((each: any) => each.name === "hand_over").parameters.properties.then).toBeUndefined();
    expect(world.commentWrites).toHaveLength(1);
    expect(world.commentWrites[0]).toMatchObject({ repo: PUBLIC, number: 7 });
    expect(world.tokens.get(world.commentWrites[0].bearer)).toMatchObject({ account: ann.account });
    expect(toolOutputs()).toEqual([expect.objectContaining({ posted: true, number: 7, on: "提醒的时区不对", url: `${issue.html_url}#issuecomment-9001` })]);
    expect(world.writes.filter((each) => each.body.title !== "重连后消息重复")).toEqual([]);
    expect(alone.heard().at(-1)).toBe("在 #7 下评论了");
    // What the run said is not taken away as words written from something read in private.
    expect(await rowsOf(alone.stub, "SELECT private FROM outbox ORDER BY id DESC LIMIT 1")).toEqual([{ private: 0 }]);
    expect(await read()).toBe(before);
  });

  it("opens one where the work found none", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    const [id] = await asks(alone, looks(BOTH));
    model.replies([opens(PUBLIC, "提醒时间没有按用户时区换算", "提醒按 UTC 触发。")], ...done("没有相关的，已新建"));
    // With the result comes what the sandbox's proxy counted of its reads, which is not the worker's to say.
    await alone.stub.taskEvent(id, 1, "result", { text: NONE, github_reads: { search: { by_status: { "200": 3 }, read: 3, more: 1, none: 1, incomplete: 0 }, other: { by_status: { "200": 3, "404": 1 } } } });
    await rest(alone.stub);
    expect(JSON.stringify(modelCalls.at(-3)!.input)).toContain("As counted where its requests went out, not as the worker says: 3 searches of issues; 0 refused or failed; 3 pages of results read; 1 of those with more pages after; 0 answered but not complete; 1 complete with nothing found; 4 other reads (1 refused or failed).");
    expect(world.writes.at(-1)).toMatchObject({ repo: PUBLIC, body: { title: "提醒时间没有按用户时区换算" } });
    expect(toolOutputs()[0]).toMatchObject({ created: true });
    expect(world.commentWrites).toEqual([]);
  });

  it("opens one only if none was found, where that was the condition, by what the work's searching shows and not by its word", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    const before = world.writes.length;
    const IF_NONE = ["github_create_issue:if_none_found", "github_comment"];
    const search = (each: Record<string, { pages: number[]; last: boolean; incomplete: boolean }>, more: Record<string, unknown> = {}) => ({ search: { by_status: { "200": 1 }, read: 1, more: 0, none: 0, incomplete: 0, each, ...more }, other: { by_status: {} } });
    const tried = async (reads: unknown) => {
      const [id] = await asks(alone, looks(IF_NONE));
      model.replies([opens(PUBLIC, "提醒时间没有按用户时区换算", "提醒按 UTC 触发。")], ...done("看结果"));
      await alone.stub.taskEvent(id, 1, "result", { text: NONE, ...(reads === undefined ? {} : { github_reads: reads }) });
      await rest(alone.stub);
      return toolOutputs()[0];
    };
    // No word from where its requests went out; no search at all; one cut short; one not read to its last page; one with a page left out; more searches than were told apart.
    expect((await tried(undefined)).error).toContain("made no search of the repository's issues that was read");
    expect((await tried({ search: { by_status: {}, read: 0, more: 0, none: 0, incomplete: 0 }, other: { by_status: { "200": 1 } } })).error).toContain("made no search");
    // One search refused (in no page that was read), another read whole: not all looked through.
    expect((await tried({ search: { by_status: { "403": 1, "200": 1 }, read: 1, more: 0, none: 1, incomplete: 0, each: { b: { pages: [1], last: true, incomplete: false } } }, other: { by_status: {} } })).error).toContain("made a search that was refused or failed");
    expect((await tried({ search: { by_status: { failed: 1, "200": 1 }, read: 1, more: 0, none: 1, incomplete: 0, each: { b: { pages: [1], last: true, incomplete: false } } }, other: { by_status: {} } })).error).toContain("made a search that was refused or failed");
    expect((await tried(search({ a: { pages: [1], last: true, incomplete: true } }))).error).toContain("was not complete");
    expect((await tried(search({ a: { pages: [1], last: true, incomplete: false }, b: { pages: [1], last: false, incomplete: false } }))).error).toContain("was not read to its last page");
    expect((await tried(search({ a: { pages: [1, 3], last: true, incomplete: false } }))).error).toContain("not every page was read");
    expect((await tried(search({ a: { pages: [1], last: true, incomplete: false } }, { others: true }))).error).toContain("more searches than were told apart");
    expect(world.writes).toHaveLength(before);
    // Two searches, each read from its first page to its last, one of them over two pages (a query put right after a refusal is no search): opened.
    // What GitHub itself refused as it was written may be something that could not be seen: not looked through. Nor one it found more of than it gives, nor one with more pages than were kept track of.
    expect((await tried({ search: { by_status: { "422": 1, "200": 1 }, read: 1, more: 0, none: 1, incomplete: 0, each: { b: { pages: [1], last: true, incomplete: false } } }, other: { by_status: {} } })).error).toContain("made a search that was refused or failed");
    expect((await tried(search({ a: { pages: [1], last: true, incomplete: false, cut: true } as never }))).error).toContain("found more than GitHub gives of one search");
    expect((await tried(search({ a: { pages: [1], last: true, incomplete: false, unsure: true } as never }))).error).toContain("more pages than could be kept track of");
    expect(world.writes).toHaveLength(before);
    expect(await tried({ search: { by_status: { rejected: 1, "200": 3 }, read: 3, more: 1, none: 1, incomplete: 0, each: { a: { pages: [1, 2], last: true, incomplete: false }, b: { pages: [1], last: true, incomplete: false } } }, other: { by_status: {} } })).toMatchObject({ created: true });
    expect(world.writes).toHaveLength(before + 1);
  });

  it("comments in the repository the work was done on, whatever other one the person has spoken of", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    for (const repo of [PUBLIC, PRIVATE]) reported(repo, 7, `${repo} 7`);
    model.replies([say("")]);
    await alone.says(`${PRIVATE} 那边也有类似的问题`);
    const [id] = await asks(alone, looks(BOTH));
    model.replies([comments(PRIVATE, 7)], [comments(PUBLIC, 7)], ...done("评论了"));
    await ends(alone, id, FOUND);
    expect(toolOutputs()[0].error).toContain("was not done on that repository (it was done on acme/site)");
    expect(world.commentWrites).toEqual([expect.objectContaining({ repo: PUBLIC, number: 7 })]);
  });

  it("comments in the repository the work was on, where that work went on from an earlier piece and was given none itself", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    // An earlier piece of work on the repository, ended well.
    const [earlier] = await asks(alone, looks(null, "先看看代码"));
    model.replies(...done("看完了"));
    await ends(alone, earlier, "看完了代码。");
    // Going on from it: no repository is given, it works on what the earlier one did.
    model.replies([call("hand_over", { worker: "sandbox", title: "接着查 issue", brief: "接着查有没有相关的 issue。", continue_from: earlier, repository: null, then: BOTH })], [say("")]);
    await alone.says(`接着刚才那个，看看 ${PUBLIC} 有没有相关的 issue，有就评论（${PRIVATE} 那边先不管）`);
    const next = toolOutputs()[0].work_id as string;
    expect(next).toBeDefined();
    expect(await rowsOf(alone.stub, "SELECT repository FROM task_then WHERE task_id = ?", next)).toEqual([{ repository: `https://github.com/${PUBLIC}` }]);
    model.replies([comments(PRIVATE, 7)], [comments(PUBLIC, 7)], ...done("评论了"));
    await ends(alone, next, FOUND);
    // Another repository is still refused; the one it was on is commented in.
    expect(toolOutputs()[0].error).toContain("was not done on that repository");
    expect(world.commentWrites).toEqual([expect.objectContaining({ repo: PUBLIC, number: 7 })]);
    // Where the worker's host says what it was on, that is what counts.
    const [told] = await asks(alone, looks(BOTH));
    model.replies([comments(PUBLIC, 7, "再说一句。")], ...done("没评"));
    await alone.stub.taskEvent(told, 1, "result", { text: FOUND, repository: `https://github.com/${PRIVATE}` });
    await rest(alone.stub);
    expect(toolOutputs()[0].error).toContain("it was done on acme/core");
    expect(world.commentWrites).toHaveLength(1);
  });

  it("says of a thing done, when asked again, only what may be said now to those who are there", async () => {
    const ann = someone();
    await authorised(ann, PRIVATE);
    const issue = reported(PRIVATE, 7, "只有里面的人知道的事");
    await registry().linkChatRepo(TENANT, "oc_core_two", PRIVATE);
    const here = ann.at("oc_core_two");
    const handed = () => call("hand_over", { worker: "sandbox", title: "查", brief: "找相关的。", continue_from: null, repository: `https://github.com/${PRIVATE}`, then: BOTH });
    model.replies([handed(), handed()], [say("")]);
    await here.says(`帮我看看 https://github.com/${PRIVATE} 有没有时区相关的 issue，如果没有就提一个，如果有可以追加你的评论`);
    const [first, second] = toolOutputs().map((each) => each.work_id as string);
    for (const id of [first, second]) left.push({ stub: here.stub, id });
    // The chat is set up for the repository: the link is given there.
    model.replies([comments(PRIVATE, 7)], ...done("评论了"));
    await ends(here, first, FOUND);
    expect(JSON.stringify(toolOutputs())).toContain(`${issue.html_url}#issuecomment-`);
    // It is no longer set up for it when the other piece of work ends and the same is asked again: not posted again, and the link is hers alone now.
    await registry().linkChatRepo(TENANT, "oc_core_two", null);
    model.replies([comments(PRIVATE, 7)], ...done("已经评论过了，链接私下发你"));
    await ends(here, second, FOUND);
    expect(world.commentWrites).toHaveLength(1);
    expect(JSON.stringify(toolOutputs())).not.toContain("issuecomment");
    expect(JSON.stringify(toolOutputs())).not.toContain("只有里面的人知道的事");
    expect(ann.directly("text").at(-1)!.text).toContain(`${issue.html_url}#issuecomment-`);
  });

  it("does nothing in their name where they only asked to have it looked into", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const [id] = await asks(alone, looks(null));
    model.replies([comments(PUBLIC, 7)], ...done("找到了 #7"));
    await ends(alone, id, FOUND);
    expect(offered(modelCalls.at(-3)!).filter((name) => name.startsWith("github_"))).toEqual([]);
    expect(toolOutputs()[0].error).toContain('there is no tool "github_comment" in this run');
    expect(world.commentWrites).toEqual([]);
  });

  it("does one thing for one request, however many pieces of work it handed over and whatever each brings back", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const before = world.writes.length;
    const [first, second, third] = await asks(alone, looks(BOTH, "查开着的"), looks(BOTH, "查关着的"), looks(BOTH, "查标题里的"));
    expect(third).toBeDefined();
    // The first brings back #7; something else is tried in the same run, and refused.
    model.replies([comments(PUBLIC, 7)], [opens(PUBLIC, "再建一个", "多出来的")], ...done("评论了"));
    await ends(alone, first, FOUND);
    expect(world.commentWrites).toHaveLength(1);
    expect(toolOutputs().at(-1).error).toContain("one thing is done in the person's name");
    // The other piece of work ends too. Another thing: refused. The same thing again: the one already done, not done twice.
    model.replies([opens(PUBLIC, "再建一个", "多出来的")], ...done("已经评论过了"));
    await ends(alone, second, NONE);
    expect(toolOutputs()[0].error).toContain("one thing is done in the person's name");
    // The result comes once more (it was delivered twice): nothing new.
    await ends(alone, second, NONE);
    expect(world.commentWrites).toHaveLength(1);
    expect(world.writes).toHaveLength(before);
    // The very same call again, when what did it no longer keeps anything of it: said again as it was said, and not done again.
    await runInDurableObject(await ann.grant(), async (_i: unknown, state: DurableObjectState) => void (await state.storage.delete([...(await state.storage.list({ prefix: "op:" })).keys()])));
    model.replies([comments(PUBLIC, 7)], ...done("已经评论过了"));
    await ends(alone, third, FOUND);
    expect(toolOutputs()[0]).toMatchObject({ done: true, note: expect.stringContaining("Nothing was sent again") });
    expect(world.commentWrites).toHaveLength(1);
    // Of what was written, nothing is kept here beside the claim: which tool, a digest, and that it has had its end.
    const kept = JSON.stringify(await rowsOf(alone.stub, "SELECT * FROM request_acts"));
    expect(kept).toContain("github_comment");
    expect(kept).not.toContain("我这边也遇到了");
  });

  it("lets a call that was not right be put right, where nothing was begun under it", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const [id] = await asks(alone, looks(BOTH));
    model.replies([call("github_comment", { repo: "site", number: 7, body: "我这边也遇到了。" })], [comments(PUBLIC, 7)], ...done("评论了"));
    await ends(alone, id, FOUND);
    expect(toolOutputs().map((each) => each.error ?? "ok")).toEqual([expect.stringContaining("owner/name"), "ok"]);
    expect(JSON.stringify(toolOutputs())).not.toContain("untouched");
    expect(world.commentWrites).toHaveLength(1);
  });

  it("asks a person who has not authorised yet, and then does that one thing where they asked", async () => {
    const ann = someone();
    const alone = ann.at();
    reported(PUBLIC, 7, "提醒的时区不对");
    const [id] = await asks(alone, looks(BOTH));
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await ends(alone, id, FOUND);
    expect(world.commentWrites).toEqual([]);
    expect(JSON.stringify(alone.cards()[0])).toContain("在 acme/site#7 下发表评论");
    model.replies(...done("评论好了"));
    expect((await consent(linkOn(alone.cards()[0]), ann.account)).status).toBe(200);
    await alone.settle();
    expect(world.commentWrites).toEqual([expect.objectContaining({ repo: PUBLIC, number: 7 })]);
    expect(alone.heard().at(-1)).toBe("评论好了");
  });

  it("does nothing once they have taken back what was to follow, and tells them what the work found all the same", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const [id] = await asks(alone, looks(BOTH));
    // While the work is under way she says not to. The work goes on.
    model.replies([call("cancel_work", { work_id: id, only_what_follows: true })], ...done("好，不发了"));
    await alone.says("先别发评论");
    expect(toolOutputs()[0]).toMatchObject({ ok: true });
    model.replies([comments(PUBLIC, 7)], ...done("找到了 #7，按你说的没有评论"));
    await ends(alone, id, FOUND);
    expect(toolOutputs()[0].error).toContain('there is no tool "github_comment" in this run');
    expect(alone.heard().slice(-2)).toEqual(["好，不发了", "找到了 #7，按你说的没有评论"]);
    expect(world.commentWrites).toEqual([]);
  });

  it("asks, at the last moment before it posts, whether it is still wanted: not once it was taken back, nor while the person has said something not yet taken up", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const grant = await ann.grant();
    const brain = scopeName({ tenant: TENANT, kind: "user", id: ann.openId });
    /** What the tool would have kept and be about to send, for the one thing a request of hers has done. */
    const about = async (text: string) => {
      await asks(alone, looks(BOTH));
      const request = (await rowsOf(alone.stub, "SELECT request FROM task_then ORDER BY rowid DESC LIMIT 1"))[0].request as string;
      await grant.begin(ann.who, `then:${request}`, { repo: PUBLIC, repo_id: 101, private: false, title: "", body: text, kind: "comment", number: 7 }, brain);
      return { request, call: `then:${request}` };
    };
    // Let go: posted.
    const wanted = await about("第一条。");
    expect(await grant.post(wanted.call)).toMatchObject({ stage: "posted" });
    expect(world.commentWrites).toHaveLength(1);
    // Taken back while it was on its way (the target had been looked at, nothing sent yet): not posted, and that is its end.
    const taken = await about("第二条。");
    await rowsOf(alone.stub, "UPDATE task_then SET withdrawn = 1 WHERE request = ?", taken.request);
    expect(await alone.stub.aboutToSend(taken.call)).toBe("withdrawn");
    expect(await grant.post(taken.call)).toMatchObject({ stage: "failed", why: "withdrawn" });
    // She has said something that has not been read yet. It may be "do not"; it may be a question. Put off, and kept as it was asked.
    const unread = await about("第三条。");
    await rowsOf(alone.stub, "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, status, received_at) SELECT source, 'om_not_read_yet', kind, session_key, principal, '等一下', data, 'pending', received_at FROM inbox WHERE kind = 'message' ORDER BY id DESC LIMIT 1");
    expect(await alone.stub.aboutToSend(unread.call)).toBe("held");
    expect(await grant.post(unread.call)).toBe("held");
    expect(await grant.op(unread.call)).toMatchObject({ stage: "asked" });
    expect(world.commentWrites).toHaveLength(1);
    // Her words taken up, and they were not "do not": it goes on, and is sent.
    await rowsOf(alone.stub, "DELETE FROM inbox WHERE source_id = 'om_not_read_yet'");
    expect(await grant.post(unread.call)).toMatchObject({ stage: "posted" });
    expect(world.commentWrites).toHaveLength(2);
    // A call nothing is kept of here was made for the person's own message, and goes.
    expect(await alone.stub.aboutToSend("call_of_her_own_message")).toBe("go");
  });

  it("decides in one place whether it is sent or taken back: let go, taking it back is told that it was too late", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const [id] = await asks(alone, looks(BOTH));
    const request = (await rowsOf(alone.stub, "SELECT request FROM task_then"))[0].request as string;
    // As it stands at the moment the tool has claimed the request's one thing and asks whether to send.
    await rowsOf(alone.stub, "INSERT INTO request_acts (request, tool, digest, at) VALUES (?, 'github_comment', 'd', 1)", request);
    expect(await alone.stub.aboutToSend(`then:${request}`)).toBe("go");
    expect(await rowsOf(alone.stub, "SELECT sending FROM request_acts")).toEqual([{ sending: 1 }]);
    // She takes it back a moment later: it had been let go, and that is what she is told. Nothing more is to follow.
    model.replies([call("cancel_work", { work_id: id, only_what_follows: true })], ...done("已经发出去了"));
    await alone.says("先别发评论");
    expect(toolOutputs()[0]).toMatchObject({ ok: true, too_late: true });
    // And the other way round: taken back first, it is not let go.
    const [other] = await asks(alone, looks(BOTH));
    const second = (await rowsOf(alone.stub, "SELECT request FROM task_then WHERE task_id = ?", other))[0].request as string;
    await rowsOf(alone.stub, "INSERT INTO request_acts (request, tool, digest, at) VALUES (?, 'github_comment', 'd', 1)", second);
    model.replies([call("cancel_work", { work_id: other, only_what_follows: true })], ...done("好，不发了"));
    await alone.says("这个也先别发");
    expect(toolOutputs()[0].too_late).toBeUndefined();
    expect(await alone.stub.aboutToSend(`then:${second}`)).toBe("withdrawn");
    expect(await rowsOf(alone.stub, "SELECT sending FROM request_acts WHERE request = ?", second)).toEqual([{ sending: 0 }]);
  });

  it("says how the one thing ended to a later result of the same request, where it waited for the person and has had its end since", async () => {
    const ann = someone();
    const alone = ann.at();
    reported(PUBLIC, 7, "提醒的时区不对");
    const [first, second] = await asks(alone, looks(BOTH, "查开着的"), looks(BOTH, "查关着的"));
    // The first result: she has to authorise. She does, and it is posted, by the run that carries the request on.
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await ends(alone, first, FOUND);
    model.replies(...done("评论好了"));
    expect((await consent(linkOn(alone.cards()[0]), ann.account)).status).toBe(200);
    await alone.settle();
    expect(world.commentWrites).toHaveLength(1);
    // What that run said is kept as words about something done, not taken away as written from something read.
    expect(await rowsOf(alone.stub, "SELECT private FROM outbox WHERE text = '评论好了'")).toEqual([{ private: 0 }]);
    // The second result. Something else: refused, as one thing was done. The same call: not told that it still waits; told what was done, and nothing is done again.
    model.replies([opens(PUBLIC, "再建一个", "多出来的")], [comments(PUBLIC, 7)], ...done("已经评论过了"));
    await ends(alone, second, FOUND);
    expect(toolOutputs()).toEqual([{ error: expect.stringContaining("one thing is done in the person's name") }, expect.objectContaining({ posted: true, number: 7 })]);
    expect(world.commentWrites).toHaveLength(1);
    expect(world.writes).toEqual([]);
  });

  it("does nothing more for a request whose one thing waited and was called off, and says that, not that it still waits", async () => {
    const ann = someone();
    const alone = ann.at();
    reported(PUBLIC, 7, "提醒的时区不对");
    const [first, second] = await asks(alone, looks(BOTH, "查开着的"), looks(BOTH, "查关着的"));
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await ends(alone, first, FOUND);
    // She no longer wants the work at all (it has ended; what follows only waits for her): that is called off with it.
    model.replies([call("cancel_work", { work_id: first, only_what_follows: null })], ...done("好，取消了"));
    await alone.says("算了，这个不要了");
    expect(await rowsOf(alone.stub, "SELECT status FROM continuations WHERE id LIKE 'then:%'")).toEqual([{ status: "cancelled" }]);
    model.replies([comments(PUBLIC, 7)], ...done("之前取消了"));
    await ends(alone, second, FOUND);
    expect(toolOutputs()[0].error).toContain('there is no tool "github_comment" in this run');
    await consent(linkOn(alone.cards()[0]), ann.account);
    await alone.settle();
    expect(world.commentWrites).toEqual([]);
  });

  it("does it for each of two people in one chat as themselves, and gives what tells of a repository the others may not see to the one who asked alone", async () => {
    const [ann, bob] = [someone(), someone()];
    await authorised(ann, PRIVATE);
    reported(PRIVATE, 7, "只有里面的人知道的事");
    const room = "oc_two";
    const [hers, his] = [ann.at(room), bob.at(room)];
    const privately = () => call("hand_over", { worker: "sandbox", title: "查", brief: "找相关的。", continue_from: null, repository: `https://github.com/${PRIVATE}`, then: BOTH });
    const asking = `帮我看看 https://github.com/${PRIVATE} 有没有时区相关的 issue，如果没有就提一个，如果有可以追加你的评论`;
    model.replies([privately()], [say("")]);
    await hers.says(asking);
    const mine = toolOutputs()[0].work_id as string;
    left.push({ stub: hers.stub, id: mine });
    model.replies([privately()], [say("")]);
    await his.says(asking);
    const theirs = toolOutputs()[0].work_id as string;
    left.push({ stub: his.stub, id: theirs });
    // His ends first. He has not authorised: the way to is sent to him alone, and nothing is posted.
    model.replies([comments(PRIVATE, 7, "我也遇到了。")], [say("")]);
    await his.stub.taskEvent(theirs, 1, "result", { text: FOUND });
    await rest(his.stub);
    expect(world.commentWrites).toEqual([]);
    expect(bob.directly("interactive")).toHaveLength(1);
    expect(ann.directly("interactive")).toEqual([]);
    // Hers: posted as her; the link and the title go to her alone, and not into the chat.
    model.replies([comments(PRIVATE, 7, "我这边也遇到了。")], ...done("评论好了，链接私下发你"));
    await hers.stub.taskEvent(mine, 1, "result", { text: FOUND });
    await rest(hers.stub);
    expect(world.commentWrites).toHaveLength(1);
    expect(world.tokens.get(world.commentWrites[0].bearer)).toMatchObject({ account: ann.account });
    expect(JSON.stringify(toolOutputs())).not.toContain("只有里面的人知道的事");
    expect(ann.directly("text").at(-1)!.text).toContain("issuecomment");
    expect(bob.directly("text")).toEqual([]);
    expect(hers.heard().join("\n")).not.toContain("只有里面的人知道的事");
    // He authorises: his is posted as him.
    model.replies(...done("评论好了，链接私下发你"));
    expect((await consent(linkOn(bob.directly("interactive")[0]), bob.account)).status).toBe(200);
    await his.settle();
    expect(world.commentWrites).toHaveLength(2);
    expect(world.tokens.get(world.commentWrites[1].bearer)).toMatchObject({ account: bob.account });
    expect(world.commentWrites[1].body.body).toContain("我也遇到了。");
  });

  it("says what became of it where it was already posted when they take it back", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const [id] = await asks(alone, looks(BOTH));
    model.replies([comments(PUBLIC, 7)], ...done("评论了"));
    await ends(alone, id, FOUND);
    expect(world.commentWrites).toHaveLength(1);
    model.replies([call("cancel_work", { work_id: id, only_what_follows: true })], ...done("已经发出去了"));
    await alone.says("先别发评论");
    expect(toolOutputs()[0]).toMatchObject({ too_late: true, note: expect.stringContaining("taking it back now does not undo it") });
    expect(world.commentWrites).toHaveLength(1);
  });

  it("carries a request on only after what the person has said since, and not at all once they have taken it back", async () => {
    const ann = someone();
    const alone = ann.at();
    reported(PUBLIC, 7, "提醒的时区不对");
    const [id] = await asks(alone, looks(BOTH));
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await ends(alone, id, FOUND);
    // She authorises: all is ready for it to be posted. Before that is taken up she says not to.
    expect((await consent(linkOn(alone.cards()[0]), ann.account)).status).toBe(200);
    await runDurableObjectAlarm(await ann.grant());
    await vi.waitFor(async () => expect((await ann.stored())?.owed).toBeUndefined(), { interval: 5 });
    model.replies([call("cancel_work", { work_id: id, only_what_follows: true })], ...done("好，不发了"));
    await alone.says("算了，先别发评论");
    await alone.later();
    expect(alone.heard().at(-1)).toBe("好，不发了");
    expect(world.commentWrites).toEqual([]);
  });

  it("calls off with it what already waits for them to authorise", async () => {
    const ann = someone();
    const alone = ann.at();
    reported(PUBLIC, 7, "提醒的时区不对");
    const [id] = await asks(alone, looks(BOTH));
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await ends(alone, id, FOUND);
    const authorize = linkOn(alone.cards()[0]);
    model.replies([call("cancel_work", { work_id: id, only_what_follows: true })], ...done("好，不发了"));
    await alone.says("算了，先别发评论");
    // She authorises all the same, afterwards: the account is hers to use here now, and nothing is posted.
    await consent(authorize, ann.account);
    await alone.settle();
    expect(world.commentWrites).toEqual([]);
  });

  it("does nothing for anyone where the messages the request was made in no longer stand as theirs, or the work did not end well", async () => {
    const ann = someone();
    const alone = await authorised(ann);
    reported(PUBLIC, 7, "提醒的时区不对");
    const [failed] = await asks(alone, looks(BOTH));
    model.replies([comments(PUBLIC, 7)], ...done("没查成"));
    await alone.stub.taskEvent(failed, 1, "failed", { error: "boom" });
    await rest(alone.stub);
    expect(toolOutputs()[0].error).toContain('there is no tool "github_comment" in this run');
    // The message it was asked in is gone from what is kept.
    const [id] = await asks(alone, looks(BOTH));
    await rowsOf(alone.stub, "UPDATE inbox SET text = NULL WHERE kind = 'message'");
    model.replies([comments(PUBLIC, 7)], ...done("找到了 #7"));
    await ends(alone, id, FOUND);
    expect(toolOutputs()[0].error).toContain('there is no tool "github_comment" in this run');
    expect(world.commentWrites).toEqual([]);
  });
});

describe("reminding people where several talk", () => {
  const colleague = { key: "@_user_2", id: { open_id: "ou_colleague" }, name: "Carol", mentioned_type: "user", tenant_key: ORG };
  const another = { key: "@_user_3", id: { open_id: "ou_bot_two" }, name: "OtherBot", mentioned_type: "bot" };
  /** What the chat was sent last, as its words. */
  const last = () => String(world.sent.filter((each) => each.type === "text").at(-1)!.content.text);

  it("reminds the one who asked and the one they named, by the chat's own mention, and nobody for anything written in the words", async () => {
    const ann = someone();
    const here = ann.at("oc_remind");
    model.replies([call("send_message", { text: "好了，结果在这里。<at user_id=\"all\"></at> <at user_id=\"ou_victim\">x</at>", notify: [ann.openId, "@Carol", "@OtherBot", "ou_stranger", "all"] })], [say("")]);
    await here.says("做完告诉我和 @_user_2，别管 @_user_3", [colleague, another]);
    // Who she named is kept of her message as the chat gave it: the person, not the other bot.
    const kept = JSON.parse((await rowsOf(here.stub, "SELECT data FROM inbox WHERE kind = 'message' ORDER BY id DESC LIMIT 1"))[0].data);
    expect(kept.mentioned).toEqual([{ id: "ou_colleague", name: "@Carol" }]);
    // Everyone a message names is kept of it, each with their name, however many: none left out, and no name left off.
    const crowd = Array.from({ length: 600 }, (_, n) => ({ key: `@_user_${n + 10}`, id: { open_id: `ou_p${n}` }, name: n === 0 || n === 599 ? "Li" : `P${n}`, mentioned_type: "user", tenant_key: ORG }));
    const noted = normalize(APP, { schema: "2.0", header: { event_type: "im.message.receive_v1", tenant_key: ORG, app_id: CHAT_APP }, event: { sender: { sender_type: "user", tenant_key: ORG, sender_id: { open_id: "ou_x" } }, message: { message_id: "om_crowd", chat_id: "oc_x", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1 hi" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" }, ...crowd, crowd[5]] } } })!.event.data!.mentioned as { id: string; name: string }[];
    expect(noted).toHaveLength(600);
    expect(noted[0]).toEqual({ id: "ou_p0", name: "@Li" });
    expect(noted.at(-1)).toEqual({ id: "ou_p599", name: "@Li" });
    expect(noted[598]).toEqual({ id: "ou_p598", name: "@P598" });
    // Not someone of another organisation, nor "everyone", whatever the chat lists for it: neither is kept as named.
    const others = [{ key: "@_user_7", id: { open_id: "ou_guest" }, name: "Guest", mentioned_type: "user", tenant_key: "org_other" }, { key: "@_user_8", id: { open_id: "all" }, name: "所有人", mentioned_type: "user", tenant_key: ORG }, { key: "@_user_9", id: { open_id: "ou_unsaid" }, name: "Unsaid", mentioned_type: "user" }];
    expect(normalize(APP, { schema: "2.0", header: { event_type: "im.message.receive_v1", tenant_key: ORG, app_id: CHAT_APP }, event: { sender: { sender_type: "user", tenant_key: ORG, sender_id: { open_id: "ou_x" } }, message: { message_id: "om_others", chat_id: "oc_x", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1 hi" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" }, ...others] } } })!.event.data!.mentioned).toBeUndefined();
    expect(toolOutputs()).toEqual([{ ok: true, reminded: 2, not_reminded: 3 }]);
    // Sent with the two mentions before the words; what the words held of mention markup notifies nobody.
    expect(last().startsWith(`<at user_id="${ann.openId}"></at> <at user_id="ou_colleague"></at> 好了，结果在这里。`)).toBe(true);
    expect(last()).not.toMatch(/<at user_id="all">|<at user_id="ou_victim">/);
    expect(last()).toContain("<\u200bat user_id=\"all\">");

    // Of one thing she is reminded once: a second message about it, asking for her again, is sent without.
    model.replies([call("send_message", { text: "补充一句。", notify: [ann.openId] })], [call("send_message", { text: "再补充。", notify: [ann.openId] })], [say("")]);
    await here.says("还有吗");
    const two = world.sent.filter((each) => each.type === "text").slice(-2).map((each) => String(each.content.text));
    expect(two).toEqual([`<at user_id="${ann.openId}"></at> 补充一句。`, "再补充。"]);
    expect(toolOutputs().slice(-2)).toEqual([{ ok: true, reminded: 1, not_reminded: 0 }, { ok: true, reminded: 0, not_reminded: 1 }]);
    // A message that asks for nobody reminds nobody, whatever its words hold.
    model.replies([call("send_message", { text: "只有字 @Carol ou_colleague。", notify: null })], [say("")]);
    await here.says("那就这样");
    expect(last()).toBe("只有字 @Carol ou_colleague。");
    // The model was told what its messages come to in this chat, in the Brain's own words.
    expect(modelCalls.at(-1).instructions).toContain("Your messages here are shown as Markdown. A message here can remind people: name them in notify.");
    // Words that begin as a heading, a list, a table or a block of code keep their first line to themselves: the mention goes on a line before them.
    for (const text of ["# 结果\n\n都好了。", "- 第一项\n- 第二项", "1. 第一步", "> 引用的话", "| 列 |\n| --- |\n| 值 |", "```\ncode\n```", "---\n\n下面是结果。", "\tcode"]) {
      model.replies([call("send_message", { text, notify: [ann.openId] })], [say("")]);
      await here.says("再说一遍");
      expect(last(), text).toBe(`<at user_id="${ann.openId}"></at>\n\n${text}`);
    }
  });

  it("reminds the one who asked when work they handed over has ended, and when a request of theirs that waited is answered", async () => {
    const ann = someone();
    const here = ann.at("oc_remind_later");
    // A task: who asked for it, and whom they named, are kept with it.
    model.replies([call("hand_over", { worker: "sandbox", title: "查一下", brief: "看看构建。", continue_from: null, repository: `https://github.com/${PUBLIC}`, then: null })], [say("")]);
    await here.says("查一下构建，做完告诉我和 @_user_2", [colleague]);
    const id = toolOutputs()[0].work_id as string;
    expect(JSON.parse((await rowsOf(here.stub, "SELECT asked FROM task_asked WHERE task_id = ?", id))[0].asked)).toMatchObject({ by: ann.openId, named: [{ id: "ou_colleague", name: "@Carol" }] });
    model.replies([call("send_message", { text: "查完了，构建是好的。", notify: [ann.openId, "@Carol"] })], [say("")]);
    await here.stub.taskEvent(id, 1, "result", { text: "构建通过。" });
    await rest(here.stub);
    expect(last()).toBe(`<at user_id="${ann.openId}"></at> <at user_id="ou_colleague"></at> 查完了，构建是好的。`);

    // Work that failed has had its end too, and she asked to be told of that.
    model.replies([call("hand_over", { worker: "sandbox", title: "再查一下", brief: "再看看构建。", continue_from: null, repository: `https://github.com/${PUBLIC}`, then: null })], [say("")]);
    await here.says("再查一次，失败了也告诉我");
    const failing = toolOutputs()[0].work_id as string;
    model.replies([call("send_message", { text: "这次没查成。", notify: [ann.openId] })], [say("")]);
    await here.stub.taskEvent(failing, 1, "failed", { error: "boom" });
    await rest(here.stub);
    expect(last()).toBe(`<at user_id="${ann.openId}"></at> 这次没查成。`);

    // A request that had to wait for her to authorise: its answer is a draft until it is let go, and reminds her then.
    reported(PUBLIC, 7, "提醒的时区不对");
    model.replies([comments(PUBLIC, 7)], [say("")]);
    await here.says(`在 ${PUBLIC}#7 评论：我这边也遇到了`);
    // (Written over once before it is sent: the last word on whom it reminds is the one that counts.)
    model.replies([call("send_message", { text: "草稿。", notify: ["ou_stranger"] })], [call("send_message", { text: "评论发好了。", notify: [ann.openId] })], [say("")]);
    expect((await consent(linkOn(ann.directly("interactive")[0]), ann.account)).status).toBe(200);
    await here.settle();
    expect(world.commentWrites).toHaveLength(1);
    expect(last()).toBe(`<at user_id="${ann.openId}"></at> 评论发好了。`);
    expect(await rowsOf(here.stub, "SELECT notify FROM outbox_reminds WHERE notify IS NOT NULL")).toEqual([]);
  });

  it("reminds nobody in a chat with one person", async () => {
    const ann = someone();
    const alone = ann.at();
    model.replies([call("send_message", { text: "好了。", notify: [ann.openId] })], [say("")]);
    await alone.says("做完告诉我");
    expect(toolOutputs()).toEqual([{ ok: true, reminded: 0, not_reminded: 1 }]);
    expect(last()).toBe("好了。");
  });

  it("reminds the one who set a timer when it fires, and once only where it was to stop after reminding", async () => {
    const ann = someone();
    const here = ann.at("oc_timer");
    model.replies([call("set_timer", { delay_seconds: 60, note: "检查构建，通过了就告诉她", repeat_every_seconds: 600, stop_after_reminding: true })], [say("")]);
    await here.says("每十分钟检查一次构建，通过了告诉我");
    const fire = async (reply: unknown[]) => {
      model.replies(...(reply as any));
      await rowsOf(here.stub, "UPDATE timers SET due_at = ? WHERE status = 'active'", Date.now() - 1);
      await rest(here.stub);
    };
    // Not yet: said without reminding anyone. The timer goes on.
    await fire([[call("send_message", { text: "还没过。", notify: null })], [say("")]]);
    expect(last()).toBe("还没过。");
    expect(await rowsOf(here.stub, "SELECT status FROM timers")).toEqual([{ status: "active" }]);
    // It has passed: she is reminded, and with that the timer has done what it was for.
    await fire([[call("send_message", { text: "构建通过了。", notify: [ann.openId] })], [say("")]]);
    expect(last()).toBe(`<at user_id="${ann.openId}"></at> 构建通过了。`);
    expect(await rowsOf(here.stub, "SELECT status FROM timers")).toEqual([{ status: "done" }]);
  });

  it("reminds the one who asked at the end of something done in several steps, each a timer set when the one before it fired", async () => {
    const ann = someone();
    const here = ann.at("oc_steps");
    const step = (text: string, more: boolean, notify: string[] | null = null) => [call("send_message", { text, notify }), ...(more ? [call("set_timer", { delay_seconds: 60, note: "下一个数", repeat_every_seconds: null, stop_after_reminding: null })] : [])];
    const fire = async () => {
      await rowsOf(here.stub, "UPDATE timers SET due_at = ? WHERE status = 'active'", Date.now() - 1);
      await rest(here.stub);
    };
    model.replies(step("1", true), [say("")]);
    await here.says("从 1 数到 4，数完提醒我");
    for (const n of [2, 3]) {
      model.replies(step(String(n), true), [say("")]);
      await fire();
      expect(last()).toBe(String(n));
    }
    model.replies(step("4，数完啦。", false, [ann.openId]), [say("")]);
    await fire();
    expect(toolOutputs()).toEqual([{ ok: true, reminded: 1, not_reminded: 0 }]);
    expect(last()).toBe(`<at user_id="${ann.openId}"></at> 4，数完啦。`);
  });

  it("reminds the one who set a timer long ago when it fires at last, however late, and nobody once it was called off", async () => {
    const ann = someone();
    const here = ann.at("oc_timer_old");
    const DAY = 86_400_000;
    // Set a year ago, to fire once; the scope was asleep for a month past the time, and wakes now. The day's clearing out runs in the same waking.
    model.replies([call("set_timer", { delay_seconds: 60, note: "到点了告诉她", repeat_every_seconds: null, stop_after_reminding: null })], [say("")]);
    await here.says("一年后提醒我续费");
    await rowsOf(here.stub, "UPDATE timers SET created_at = ?, due_at = ?", Date.now() - 396 * DAY, Date.now() - 31 * DAY);
    await rowsOf(here.stub, "DELETE FROM meta WHERE key = 'housekeeping_at'");
    model.replies([call("send_message", { text: "该续费了。", notify: [ann.openId] })], [say("")]);
    await rest(here.stub);
    expect(toolOutputs()).toEqual([{ ok: true, reminded: 1, not_reminded: 0 }]);
    expect(last()).toBe(`<at user_id="${ann.openId}"></at> 该续费了。`);

    // A repeating one that has just come due; she calls it off before its firing is taken up. What is said then reminds nobody.
    model.replies([call("set_timer", { delay_seconds: 60, note: "每小时提醒她", repeat_every_seconds: 3600, stop_after_reminding: null })], [say("")]);
    await here.says("每小时提醒我喝水");
    const id = (await rowsOf(here.stub, "SELECT id FROM timers WHERE status = 'active'"))[0].id as string;
    await rowsOf(here.stub, "UPDATE timers SET due_at = ? WHERE id = ?", Date.now() - 1, id);
    await here.stub.ingest(normalize(APP, { schema: "2.0", header: { event_type: "im.message.receive_v1", tenant_key: ORG, app_id: CHAT_APP }, event: { sender: { sender_type: "user", tenant_key: ORG, sender_id: { open_id: ann.openId } }, message: { message_id: "om_call_off", chat_id: "oc_timer_old", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1 不用提醒了" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" }] } } })!.event);
    model.replies([call("cancel_timer", { id })], [call("send_message", { text: "好，不提醒了。", notify: null })], [say("")], [call("send_message", { text: "喝水。", notify: [ann.openId] })], [say("")]);
    await rest(here.stub);
    expect(await rowsOf(here.stub, "SELECT status FROM timers WHERE id = ?", id)).toEqual([{ status: "cancelled" }]);
    expect(world.sent.filter((each) => each.type === "text").map((each) => String(each.content.text)).filter((text) => text.includes(`<at user_id="${ann.openId}"></at> 喝水`))).toEqual([]);
  });
});
