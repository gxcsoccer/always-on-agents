/**
 * Handing work to Doubao Work for a person, through the chat connector they write in: the whole
 * way, with the real Brain and stand-ins for the two outside services.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { doubaoConnector, grantName } from "../src/connectors/doubao";
import { challengeOf } from "../src/connectors/feishu-grant";
import { normalize } from "../src/connectors/feishu";
import { scopeName } from "../src/events";
import type { FeishuApp } from "../src/registry";
import { call, installFakeModel, model, modelCalls, say, wake } from "./helpers";

const TENANT = "work";
const CHAT_APP = "cli_chat";
const WORK_APP = "cli_work";
const ORG = "org_w";
const APP: FeishuApp = { app_id: CHAT_APP, tenant: TENANT, app_secret: "chat-secret", encrypt_key: null, verification_token: null, bot_open_id: "ou_bot", token: null, token_expires_at: null, transport: "long_connection", oauth_v2: 0, oauth_offline: 0 };
const SCOPE = "auth:user.id:read doubao:session.event:write doubao:session.message:read doubao:session:write";

/** Doubao Work and the chat service, as far as these tests need them. */
const world = {
  /** What the bot sent in the chat: cards and words. */
  sent: [] as { to: string; type: string; content: any }[],
  codes: new Map<string, { union_id: string; open_id: string; tenant_key: string; challenge: string; redirect: string }>(),
  tokens: new Map<string, { union_id: string; open_id: string; tenant_key: string; good: boolean }>(),
  /** Conversations in Doubao Work: whose, and the messages in each, oldest first. */
  sessions: new Map<string, { owner: string; messages: any[] }>(),
  /** Every write Doubao took, by its key. */
  taken: new Map<string, { body: string; answer: any }>(),
  /** Every write asked of Doubao, as made. */
  writes: [] as { path: string; body: any; bearer: string }[],
  /** How many of the next writes Doubao takes without the answer coming back. */
  dropAnswers: 0,
  /** How many of the next writes get no answer and are not taken either. */
  /** Cards replaced where they were shown. */
  closed: [] as any[],
  unreachable: 0,
  /** Doubao's account service gives no answer at all. */
  accountsDown: false,
  /** How many of the next writes Doubao takes and answers "ok" to, without saying what it made of them. */
  bareAnswers: 0,
  /** Runs while a write is being made, before Doubao takes it. */
  duringWrite: undefined as undefined | (() => unknown),
  /** How many messages Doubao lists at a time. */
  pageSize: 100,
  /** Every listing of messages asked of Doubao. */
  listings: [] as string[],
  /** Everything the person has allowed the Doubao app, here or elsewhere. */
  scope: SCOPE,
  /** Whether a token is issued for only what the exchange asks for, as Doubao does. */
  narrows: true,
  issued: 0,
};

function installWorld() {
  world.sent.length = 0;
  world.codes.clear();
  world.tokens.clear();
  world.sessions.clear();
  world.taken.clear();
  world.writes.length = 0;
  world.dropAnswers = 0;
  world.closed.length = 0;
  world.unreachable = 0;
  world.accountsDown = false;
  world.scope = SCOPE;
  world.narrows = true;
  world.bareAnswers = 0;
  world.duringWrite = undefined;
  world.pageSize = 100;
  world.listings.length = 0;
  const modelFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host === "model.test") return modelFetch(input, init);
    const bearer = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.host === "open.feishu.cn") {
      if (url.pathname.endsWith("/auth/v3/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "t-app", expire: 7200 });
      if (url.pathname.endsWith("/im/v1/messages") || /\/im\/v1\/messages\/[^/]+\/reply$/.test(url.pathname)) {
        const content = JSON.parse(body.content);
        const words = body.msg_type === "text" || body.msg_type === "post";
        world.sent.push({ to: body.receive_id ?? "reply", type: words ? "text" : body.msg_type, content: body.msg_type === "post" ? { text: content.zh_cn.content.flat().map((each: any) => each.text).join("") } : content });
        return Response.json({ code: 0, data: { message_id: `om_sent_${world.sent.length}` } });
      }
      if (init?.method === "PATCH") world.closed.push(JSON.parse(body.content));
      // Reactions and the like: taken, and of no interest here.
      return Response.json({ code: 0, data: {} });
    }
    if (world.accountsDown && url.host === "accounts.doubao.com") throw new Error("network");
    if (url.host === "accounts.doubao.com" && url.pathname === "/oauth/v3/token") {
      const consent = world.codes.get(body.code);
      world.codes.delete(body.code);
      if (body.client_id !== WORK_APP || body.client_secret !== "work-secret") return Response.json({ code: 20002 }, { status: 400 });
      if (!consent || consent.redirect !== body.redirect_uri || (await challengeOf(String(body.code_verifier))) !== consent.challenge) return Response.json({ code: 20003 }, { status: 400 });
      const token = `d-${++world.issued}`;
      world.tokens.set(token, { ...consent, good: true });
      return Response.json({ code: 0, access_token: token, expires_in: 7200, token_type: "Bearer", scope: world.narrows && typeof body.scope === "string" ? body.scope.split(" ").filter((each: string) => world.scope.split(" ").includes(each)).join(" ") : world.scope });
    }
    const user = world.tokens.get(bearer);
    if (url.host === "accounts.doubao.com" && url.pathname === "/open-apis/authen/v1/user_info") return user?.good ? Response.json({ code: 0, data: { open_id: user.open_id, union_id: user.union_id, tenant_key: user.tenant_key } }) : Response.json({ code: 99991668 }, { status: 401 });
    if (url.host !== "open.doubao.com" || !url.pathname.startsWith("/open-apis/agent/v1/sessions")) throw new Error(`unexpected fetch to ${url.href}`);
    if (!user?.good) return Response.json({ code: 99991677 }, { status: 401 });
    const into = /\/sessions\/([^/]+)\/(events|messages)$/.exec(url.pathname);
    if (into?.[2] === "messages") {
      const session = world.sessions.get(into[1]);
      if (!session || session.owner !== user.union_id) return Response.json({ code: 3440004 }, { status: 404 });
      world.listings.push(url.search);
      const newestFirst = [...session.messages].reverse();
      const from = Number(url.searchParams.get("page_token") ?? 0);
      const more = from + world.pageSize < newestFirst.length;
      return Response.json({ code: 0, data: { messages: newestFirst.slice(from, from + world.pageSize), has_more: more, ...(more ? { page_token: String(from + world.pageSize) } : {}) } });
    }
    // A write. The same key with the same words is answered as it was the first time; with other words it is refused.
    world.writes.push({ path: url.pathname, body, bearer });
    await world.duringWrite?.();
    if (world.unreachable > 0) return (world.unreachable--, Promise.reject(new Error("network")));
    const before = world.taken.get(body.uuid);
    if (before) return before.body === JSON.stringify(body) ? Response.json(before.answer) : Response.json({ code: 3440009, msg: "request conflict" }, { status: 409 });
    const id = into ? into[1] : `sess_${world.sessions.size + 1}`;
    if (into && world.sessions.get(id)?.owner !== user.union_id) return Response.json({ code: 3440004 }, { status: 404 });
    const session = world.sessions.get(id) ?? { owner: user.union_id, messages: [] };
    world.sessions.set(id, session);
    const mine = { id: `msg_${id}_${session.messages.length + 1}`, session_id: id, role: "user", status: "completed", items: [{ type: "text", text: (body.initial_events ?? body.events)[0].contents[0].text }] };
    session.messages.push(mine);
    const answer = { code: 0, data: { ...(into ? {} : { id }), messages: [mine] } };
    world.taken.set(body.uuid, { body: JSON.stringify(body), answer });
    if (world.dropAnswers > 0) return (world.dropAnswers--, Promise.reject(new Error("network")));
    if (world.bareAnswers > 0) return (world.bareAnswers--, Response.json({ code: 0, data: {} }));
    return Response.json(answer);
  });
}

/** Doubao's reply to the newest thing asked in a conversation. */
function doubaoReplies(session: string, text: string, status = "completed", artifacts: any[] = [], to = -1) {
  const messages = world.sessions.get(session)!.messages;
  const asked = messages.filter((each) => each.role === "user").at(to);
  const at = messages.findIndex((each) => each.role === "assistant" && each.reply_id === asked.id);
  const reply = { id: `reply_${asked.id}`, session_id: session, role: "assistant", status, reply_id: asked.id, items: [{ type: "reasoning", text: "thinking" }, ...(text ? [{ type: "text", text }] : []), ...artifacts] };
  if (at >= 0) messages[at] = reply;
  else messages.push(reply);
}

let people = 0;
/** Each time that is made to have come is a different one. */
let ticks = 0;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const rowsOf = (stub: any, query: string, ...args: unknown[]): Promise<any[]> => runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec(query, ...(args as any[])).toArray());
const admin = (method: string, path: string, body?: unknown) => (exports as any).default.fetch(new Request(`https://agent.test/v1/admin/${path}`, { method, headers: { authorization: "Bearer test-admin", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })) as Promise<Response>;
const pair = (more: Record<string, unknown> = {}) => admin("POST", "doubao/apps", { for: { connector: "feishu", app_id: CHAT_APP }, app_id: WORK_APP, app_secret: "work-secret", ...more });

function someone() {
  const openId = `ou_w${++people}`;
  const unionId = `on_w${people}`;
  const stub = (env as any).BRAIN.getByName(scopeName({ tenant: TENANT, kind: "user", id: openId })) as any;
  let n = 0;
  const event = (text: string, union: string | undefined = unionId, replyingTo?: string) =>
    normalize(APP, {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", tenant_key: ORG, app_id: CHAT_APP },
      event: { sender: { sender_type: "user", tenant_key: ORG, sender_id: { open_id: openId, ...(union ? { union_id: union } : {}) } }, message: { message_id: `om_${openId}_${++n}`, chat_id: `oc_${openId}`, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }), ...(replyingTo ? { parent_id: replyingTo } : {}) } },
    })!.event;
  const quiet = async () => {
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
  };
  const says = async (text: string, union?: string, replyingTo?: string) => {
    await stub.ingest(event(text, union, replyingTo));
    await quiet();
  };
  const grant = async () => (env as any).DOUBAO_GRANTS.getByName(await grantName({ chat_app_id: CHAT_APP, tenant_key: ORG, open_id: openId })) as any;
  /** Lets what is due happen: the grant telling the Brain, the Brain carrying on. */
  const settle = async () => {
    await runDurableObjectAlarm(await grant());
    await vi.waitFor(async () => expect((await runInDurableObject(await grant(), (_i: unknown, state: DurableObjectState) => state.storage.get<any>("grant")))?.owed).toBeUndefined(), { interval: 5 });
    await quiet();
  };
  /** As though the time to ask again about what is waited for had come. */
  const later = async () => {
    await rowsOf(stub, "UPDATE continuations SET check_at = ? WHERE status = 'waiting' AND check_at IS NOT NULL", ++ticks);
    await quiet();
  };
  /** The id the chat gave the bot's message that said exactly this. */
  const sentAs = (text: string) => `om_sent_${world.sent.findIndex((each) => each.type === "text" && each.content.text === text) + 1}`;
  const heard = () => world.sent.filter((each) => each.to === `oc_${openId}` && each.type === "text").map((each) => String(each.content.text));
  const cards = () => world.sent.filter((each) => each.to === `oc_${openId}` && each.type === "interactive").map((each) => each.content);
  const requests = (): Promise<{ status: string; why: string | null; condition: string }[]> => rowsOf(stub, "SELECT status, why, condition FROM continuations ORDER BY rowid");
  return { openId, unionId, stub, event, says, quiet, settle, later, heard, cards, requests, grant, sentAs };
}

type Person = ReturnType<typeof someone>;
const linkOn = (card: any) => new URL(card.elements.find((e: any) => e.tag === "action").actions[0].url);
/** The person goes through Doubao's consent page as some account, and comes back. */
async function consent(authorize: URL, as: { unionId: string; openId?: string; org?: string }): Promise<Response> {
  const back = new URL(authorize.searchParams.get("redirect_uri")!);
  back.searchParams.set("state", authorize.searchParams.get("state")!);
  const code = `code${Math.random().toString(36).slice(2)}`;
  world.codes.set(code, { union_id: as.unionId, open_id: as.openId ?? "ou_under_the_other_app", tenant_key: as.org ?? ORG, challenge: authorize.searchParams.get("code_challenge")!, redirect: authorize.searchParams.get("redirect_uri")! });
  back.searchParams.set("code", code);
  return (exports as any).default.fetch(new Request(back));
}
const toolOutputs = (asked: any = modelCalls.at(-1)): any[] => {
  const input = asked.input as any[];
  return input.slice(input.map((each) => each.role).lastIndexOf("user") + 1).filter((each) => each.type === "function_call_output").map((each) => JSON.parse(each.output));
};
const asks = (text: string, carry_on = false) => call("doubao_ask", { text, carry_on });
const UNDER_WAY = "已经交出去处理了，需要一些时间。完成后我会把结果发给你。";
/** Asks for something, authorises when invited, and is left with the work handed over. */
async function handsOver(person: Person, text = "调研一下向量数据库") {
  model.replies([asks(text)], [say("")]);
  await person.says(`让豆包${text}`);
  expect((await consent(linkOn(person.cards().at(-1)), person)).status).toBe(200);
  await person.settle();
  return [...world.sessions.keys()].at(-1)!;
}

beforeEach(async () => {
  installFakeModel();
  installWorld();
  const registry = (env as any).REGISTRY.getByName("global");
  await registry.createTenant(TENANT, TENANT);
  await registry.setFeishuApp(TENANT, { app_id: CHAT_APP, app_secret: "chat-secret", bot_open_id: "ou_bot", transport: "long_connection" });
  await admin("DELETE", `doubao/apps/${CHAT_APP}`);
});

describe("handing work to Doubao Work", () => {
  it("is not there at all until the operator pairs the chat app, and never names the secret back", async () => {
    const ann = someone();
    model.replies([say("好的")]);
    await ann.says("让豆包调研一下");
    expect(modelCalls[0].tools.map((t: any) => t.name)).not.toContain("doubao_ask");

    const set = await pair();
    expect(set.status).toBe(200);
    expect(JSON.stringify(await set.json())).not.toContain("work-secret");
    expect(await (await admin("GET", `doubao/apps/${CHAT_APP}`)).text()).not.toContain("work-secret");
    model.replies([say("好的")]);
    await ann.says("让豆包调研一下");
    expect(modelCalls[1].tools.map((t: any) => t.name)).toContain("doubao_ask");
    // An unknown chat app cannot be paired; a person's id under one app is not who they are under another.
    expect((await admin("POST", "doubao/apps", { for: { connector: "feishu", app_id: "cli_unknown" }, app_id: WORK_APP, app_secret: "s" })).status).toBe(404);
    expect((await pair({ match: "open_id" })).status).toBe(400);

    expect((await admin("DELETE", `doubao/apps/${CHAT_APP}`)).status).toBe(200);
    model.replies([say("好的")]);
    await ann.says("让豆包调研一下");
    expect(modelCalls[2].tools.map((t: any) => t.name)).not.toContain("doubao_ask");
  });

  it("asks the person to authorise, hands the work over once as them, says so, and brings the reply back when it is done", async () => {
    await pair();
    const bea = someone();
    model.replies([asks("调研一下向量数据库")], [say("")]);
    await bea.says("让豆包调研一下向量数据库");
    // Nothing was sent to Doubao; she is shown how to authorise, with the paired app and for these things only.
    expect(world.writes).toEqual([]);
    expect(toolOutputs()).toEqual([{ waiting: true, request: expect.any(String), note: expect.stringContaining("only they can do") }]);
    const authorize = linkOn(bea.cards()[0]);
    expect(authorize.origin + authorize.pathname).toBe("https://accounts.doubao.com/open-apis/authen/v1/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: WORK_APP, redirect_uri: "https://agent.test/v1/doubao/oauth/callback", scope: "doubao:session:write doubao:session.event:write doubao:session.message:read", code_challenge_method: "S256" });

    // She authorises (under the other app she has another open_id; it is the union_id that says it is her).
    const back = await consent(authorize, bea);
    expect(await back.text()).toContain("授权成功");
    await bea.settle();
    // Handed over once, as her, in her words as the model put them; and she is told so by the system.
    expect(world.writes.map((each) => [each.path, each.body.initial_events[0].contents[0].text])).toEqual([["/open-apis/agent/v1/sessions", "调研一下向量数据库"]]);
    expect(bea.heard()).toEqual([UNDER_WAY]);
    expect((await bea.requests()).map((each) => each.status)).toEqual(["waiting"]);

    // Doubao is still at it: asked again later, and nothing is said meanwhile.
    doubaoReplies("sess_1", "", "in_progress");
    await bea.later();
    expect(bea.heard()).toEqual([UNDER_WAY]);
    // Done: its words and what it made are put before the model, and her answer goes out.
    doubaoReplies("sess_1", "向量数据库有三类。", "completed", [{ type: "artifact", name: "调研报告", artifact_type: "doc", url: "https://example.doubao.com/docx/abc" }]);
    model.replies([call("send_message", { text: "豆包的结论：向量数据库有三类。" })], [say("")]);
    await bea.later();
    expect(toolOutputs(modelCalls.at(-2))).toEqual([{ text: "向量数据库有三类。", made: [{ name: "调研报告", kind: "doc", link: "https://example.doubao.com/docx/abc" }], note: expect.any(String) }]);
    expect(bea.heard()).toEqual([UNDER_WAY, "豆包的结论：向量数据库有三类。"]);
    expect(world.writes).toHaveLength(1);
    expect((await bea.requests()).map((each) => each.status)).toEqual(["done"]);
    expect(await (await bea.grant()).status()).toMatchObject({ authorised: true, work: { answered: 1 } });
  });

  it("with a standing authorisation hands over at once, and a follow-up goes into the same conversation", async () => {
    await pair();
    const cy = someone();
    const session = await handsOver(cy);
    doubaoReplies(session, "第一版。");
    model.replies([call("send_message", { text: "第一版。" })], [say("")]);
    await cy.later();

    model.replies([asks("再补充成本对比", true)], [say("")]);
    await cy.says("让豆包再补充成本对比");
    expect(toolOutputs()).toEqual([{ waiting: true, request: expect.any(String), note: expect.stringContaining("handed over") }]);
    expect(world.writes.map((each) => each.path)).toEqual(["/open-apis/agent/v1/sessions", `/open-apis/agent/v1/sessions/${session}/events`]);
    expect(cy.cards()).toHaveLength(1);
    doubaoReplies(session, "成本对比如下。");
    model.replies([call("send_message", { text: "成本对比如下。" })], [say("")]);
    await cy.later();
    expect(cy.heard().at(-1)).toBe("成本对比如下。");
  });

  it("carries an unmarked follow-up on with Doubao when the last answer was Doubao's, and not past an answer of the agent's own", async () => {
    await pair();
    const cy = someone();
    const first = await handsOver(cy, "调研 A");
    doubaoReplies(first, "A 的结论。");
    model.replies([call("send_message", { text: "A 的结论。" })], [say("")]);
    await cy.later();
    // A second piece of work, so that "the only recent one" could not tell which.
    model.replies([asks("调研 B")], [say("")]);
    await cy.says("让豆包调研 B");
    const second = [...world.sessions.keys()].at(-1)!;
    doubaoReplies(second, "B 的结论。");
    model.replies([call("send_message", { text: "B 的结论。" })], [say("")]);
    await cy.later();
    expect(cy.heard().at(-1)).toBe("B 的结论。");

    // No name, no reply marked: it follows the answer they last had, which was Doubao's on B.
    const before = world.writes.length;
    model.replies([asks("再深入一点", true)], [say("")]);
    await cy.says("再深入一点");
    expect(toolOutputs()).toEqual([{ waiting: true, request: expect.any(String), note: expect.stringContaining("handed over") }]);
    expect(world.writes.slice(before).map((each) => each.path)).toEqual([`/open-apis/agent/v1/sessions/${second}/events`]);
    doubaoReplies(second, "更深入的 B。");
    model.replies([call("send_message", { text: "更深入的 B。" })], [say("")]);
    await cy.later();

    // Something new still has to name Doubao, whatever the last answer was.
    model.replies([asks("调研 C")], [say("没发出去")]);
    await cy.says("调研 C");
    expect(JSON.stringify(toolOutputs())).toContain("has not asked for Doubao");

    // The agent answers something itself. What comes after that no longer follows Doubao's answer.
    model.replies([call("send_message", { text: "我自己答的。" })], [say("")]);
    await cy.says("你怎么看");
    const then = world.writes.length;
    model.replies([asks("再补充", true)], [say("没发出去")]);
    await cy.says("再补充");
    expect(JSON.stringify(toolOutputs())).toContain("has not asked for Doubao");
    expect(world.writes).toHaveLength(then);
  });

  it("does not guess around a reply the person marked, and starts nothing new on the strength of a reply", async () => {
    await pair();
    const cy = someone();
    model.replies([call("send_message", { text: "我自己的看法。" })], [say("")]);
    await cy.says("你怎么看向量数据库");
    const session = await handsOver(cy, "调研 A");
    doubaoReplies(session, "A 的结论。");
    model.replies([call("send_message", { text: "A 的结论。" })], [say("")]);
    await cy.later();
    const before = world.writes.length;

    // The last answer was Doubao's, but they reply to the agent's own earlier one.
    model.replies([asks("再解释一下", true)], [say("")]);
    await cy.says("再解释一下", undefined, cy.sentAs("我自己的看法。"));
    expect(JSON.stringify(toolOutputs())).toContain("replies to something that is not a piece of work");
    // Replying to Doubao's answer says which to go on with, and no more: it does not start something new.
    model.replies([asks("调研 C")], [say("")]);
    await cy.says("调研 C", undefined, cy.sentAs("A 的结论。"));
    expect(JSON.stringify(toolOutputs())).toContain("Something new is handed to Doubao only when they say so");
    expect(world.writes).toHaveLength(before);
    // And going on with what they replied to still works.
    model.replies([asks("补充成本", true)], [say("")]);
    await cy.says("补充成本", undefined, cy.sentAs("A 的结论。"));
    expect(world.writes.slice(before).map((each) => each.path)).toEqual([`/open-apis/agent/v1/sessions/${session}/events`]);
  });

  it("asks for a token for this work only, whatever else the person has allowed the app before", async () => {
    await pair();
    const dee = someone();
    world.scope = `${SCOPE} doubao:session:read doubao:session:delete`;
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    expect((await consent(linkOn(dee.cards()[0]), dee)).status).toBe(200);
    expect(await (await dee.grant()).status()).toMatchObject({ authorised: true });
  });

  it("ends the wait when the authorisation does not go through, says so once, and does the work once when asked again", async () => {
    await pair();
    const dee = someone();
    const NOT_DONE = "授权没有完成，你要我做的事还没有做。还需要的话，请再跟我说一遍。";
    // The token comes back reaching further than was asked: not kept.
    world.scope = `${SCOPE} doubao:session:read`;
    world.narrows = false;
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    const first = linkOn(dee.cards()[0]);
    expect((await consent(first, dee)).status).toBe(400);
    await dee.settle();
    expect(await dee.requests()).toMatchObject([{ status: "void" }]);
    expect(dee.heard().filter((each) => each === NOT_DONE)).toHaveLength(1);
    // The card that led nowhere no longer offers its way in.
    await vi.waitFor(() => expect(world.closed.map((each) => each.header.title.content)).toEqual(["这次请求已结束"]), { interval: 5 });
    // The same link once more changes nothing and says nothing more.
    expect((await consent(first, dee)).status).toBe(400);
    await dee.quiet();
    expect(dee.heard().filter((each) => each === NOT_DONE)).toHaveLength(1);

    // Asked again in the same words: a new way in, and the work is handed over once.
    world.narrows = true;
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    expect(dee.cards()).toHaveLength(2);
    expect((await consent(linkOn(dee.cards()[1]), dee)).status).toBe(200);
    await dee.settle();
    expect(world.writes).toHaveLength(1);
    expect((await dee.requests()).map((each) => each.status)).toEqual(["void", "waiting"]);
  });

  it("ends the wait as well when Doubao cannot be reached while the authorisation is being checked", async () => {
    await pair();
    const dee = someone();
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    world.accountsDown = true;
    const link = linkOn(dee.cards()[0]);
    expect((await consent(link, dee)).status).toBe(400);
    world.accountsDown = false;
    await dee.settle();
    expect(await dee.requests()).toMatchObject([{ status: "void" }]);
    expect(dee.heard().filter((each) => each.startsWith("授权没有完成"))).toHaveLength(1);
    expect((await consent(link, dee)).status).toBe(400);
    expect(await (await dee.grant()).status()).toMatchObject({ authorised: false });
  });

  it("answers each request by its own invitation, however many came to nothing since", async () => {
    await pair();
    const dee = someone();
    const grant = await dee.grant();
    const who = { chat_app_id: CHAT_APP, tenant_key: ORG, open_id: dee.openId, union_id: dee.unionId };
    const app = await (env as any).REGISTRY.getByName("global").doubaoApp(CHAT_APP);
    world.scope = `${SCOPE} doubao:session:read`;
    world.narrows = false;
    const nonces: string[] = [];
    for (let i = 0; i < 25; i++) {
      const made = await grant.invite(who, "https://agent.test/v1/doubao/oauth/callback", app, 1);
      nonces.push(made.nonce);
      const card = await grant.card(await grantName(who), made.nonce);
      expect((await consent(new URL(card.action.url), dee)).status).toBe(400);
    }
    expect(new Set(nonces).size).toBe(25);
    // Then one works.
    world.narrows = true;
    const good = await grant.invite(who, "https://agent.test/v1/doubao/oauth/callback", app, 1);
    expect((await consent(new URL((await grant.card(await grantName(who), good.nonce)).action.url), dee)).status).toBe(200);
    const scope = { tenant: TENANT, kind: "user" as const, id: dee.openId };
    const on = async (nonce: string) => doubaoConnector.holds!(env as any, scope, `doubao|auth|${await grantName(who)}|${nonce}`, 1);
    expect(await on(nonces[0])).toEqual({ state: "gone", refused: true });
    expect(await on(nonces[24])).toEqual({ state: "gone", refused: true });
    expect(await on(good.nonce)).toMatchObject({ state: "holds" });
    // One nobody was ever shown is nobody's to wait on.
    expect(await on("never_made_never_made_never_made")).toEqual({ state: "gone" });
  });

  it("counts each invitation as done when it was done, not when a later one was", async () => {
    await pair();
    const dee = someone();
    const grant = await dee.grant();
    const who = { chat_app_id: CHAT_APP, tenant_key: ORG, open_id: dee.openId, union_id: dee.unionId };
    const app = await (env as any).REGISTRY.getByName("global").doubaoApp(CHAT_APP);
    const name = await grantName(who);
    const first = await grant.invite(who, "https://agent.test/v1/doubao/oauth/callback", app, 1);
    // The first is made to be near its end, so that a second one is made beside it.
    await runInDurableObject(grant, async (_i: unknown, state: DurableObjectState) => {
      const stored = (await state.storage.get<any>("grant"))!;
      stored.pending[0].expires_at = Date.now() + 60_000;
      await state.storage.put("grant", stored);
    });
    const second = await grant.invite(who, "https://agent.test/v1/doubao/oauth/callback", app, 1);
    expect(second.nonce).not.toBe(first.nonce);
    const firstCard = await grant.card(name, first.nonce);
    const secondCard = await grant.card(name, second.nonce);
    expect((await consent(new URL(firstCard.action.url), dee)).status).toBe(200);
    const scope = { tenant: TENANT, kind: "user" as const, id: dee.openId };
    const firstDone = ((await doubaoConnector.holds!(env as any, scope, `doubao|auth|${name}|${first.nonce}`, 1)) as any).since;
    await sleep(15);
    expect((await consent(new URL(secondCard.action.url), dee)).status).toBe(200);
    expect(await doubaoConnector.holds!(env as any, scope, `doubao|auth|${name}|${first.nonce}`, 1)).toEqual({ state: "holds", since: firstDone });
    expect(((await doubaoConnector.holds!(env as any, scope, `doubao|auth|${name}|${second.nonce}`, 1)) as any).since).toBeGreaterThan(firstDone);
  });

  it("says that waiting has stopped, and not to ask again, when a new authorisation fails for work already handed over", async () => {
    await pair();
    const dee = someone();
    await handsOver(dee);
    for (const token of world.tokens.values()) token.good = false;
    await dee.later();
    world.scope = `${SCOPE} doubao:session:read`;
    world.narrows = false;
    expect((await consent(linkOn(dee.cards().at(-1)), dee)).status).toBe(400);
    await dee.settle();
    expect(dee.heard().at(-1)).toBe("重新授权没有完成，我不再等之前交出去处理的那件事了。它可能还在那边继续，你可以直接去那边看。");
    expect(world.writes).toHaveLength(1);
  });

  it("does not take up a request whose own way in failed, even after another one worked", async () => {
    await pair();
    const dee = someone();
    world.narrows = false;
    world.scope = `${SCOPE} doubao:session:read`;
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    const failed = (await dee.requests())[0].condition;
    expect((await consent(linkOn(dee.cards()[0]), dee)).status).toBe(400);
    // Before the Brain has heard of that, they authorise through another way in.
    world.narrows = true;
    const grant = await dee.grant();
    const held = await grant.held();
    const again = await grant.invite({ chat_app_id: CHAT_APP, tenant_key: ORG, open_id: dee.openId, union_id: dee.unionId }, "https://agent.test/v1/doubao/oauth/callback", await (env as any).REGISTRY.getByName("global").doubaoApp(CHAT_APP), held.generation);
    const card = await grant.card(failed.split("|")[2], again.nonce);
    expect((await consent(new URL(card.action.url), dee)).status).toBe(200);
    expect(await doubaoConnector.holds!(env as any, { tenant: TENANT, kind: "user", id: dee.openId }, failed, held.generation)).toEqual({ state: "gone", refused: true });
    await dee.settle();
    expect(await dee.requests()).toMatchObject([{ status: "void" }]);
    expect(world.writes).toEqual([]);
  });

  it("keeps nothing when another account completes the authorisation, or when more is granted than was asked", async () => {
    await pair();
    const dee = someone();
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    const other = await consent(linkOn(dee.cards()[0]), { unionId: "on_someone_else" });
    expect(other.status).toBe(403);
    expect(await (await dee.grant()).status()).toMatchObject({ authorised: false });
    expect(world.writes).toEqual([]);

    // Asked again: a new way in. This time the token reaches further than was asked for.
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    world.scope = `${SCOPE} doubao:session:read`;
    world.narrows = false;
    expect((await consent(linkOn(dee.cards().at(-1)), dee)).status).toBe(400);
    expect(await (await dee.grant()).status()).toMatchObject({ authorised: false });
    // And the right account in another organisation is not her either.
    world.scope = SCOPE;
    world.narrows = true;
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    expect((await consent(linkOn(dee.cards().at(-1)), { unionId: dee.unionId, org: "org_other" })).status).toBe(403);
    expect(world.writes).toEqual([]);
  });

  it("sends nothing unless the person named Doubao themselves, or where who they are cannot be told", async () => {
    await pair();
    const eli = someone();
    model.replies([asks("调研一下竞品")], [say("我来查")]);
    await eli.says("调研一下竞品");
    expect(JSON.stringify(toolOutputs())).toContain("has not asked for Doubao");
    expect(eli.cards()).toEqual([]);
    // Having named it another time is not asking for it now.
    model.replies([say("豆包工作是一个办公智能体。")]);
    await eli.says("豆包是什么？");
    model.replies([asks("调研一下竞品")], [say("我来查")]);
    await eli.says("那调研一下竞品吧");
    expect(JSON.stringify(toolOutputs())).toContain("has not asked for Doubao");
    expect(eli.cards()).toEqual([]);

    // Their message came without the id they are matched by.
    const fay = someone();
    model.replies([asks("调研一下竞品")], [say("不行")]);
    await fay.stub.ingest(fay.event("让豆包调研一下竞品", ""));
    await fay.quiet();
    expect(toolOutputs()[0].error).toContain("could not be told");
    expect(world.writes).toEqual([]);
  });

  it("does not hand the same work over twice when the answer to handing it over is lost", async () => {
    await pair();
    const gus = someone();
    world.dropAnswers = 1;
    const session = await handsOver(gus);
    // Taken the first time; asked again with the same key and words, Doubao named the same conversation.
    expect(world.writes).toHaveLength(2);
    expect(world.writes[0].body).toEqual(world.writes[1].body);
    expect(world.sessions.size).toBe(1);
    expect(world.sessions.get(session)!.messages).toHaveLength(1);
    expect(gus.heard()).toEqual([UNDER_WAY]);
  });

  it("says it cannot tell, and stops, when Doubao cannot be reached while handing over", async () => {
    await pair();
    const hal = someone();
    world.unreachable = 2;
    model.replies([asks("调研一下向量数据库")], [say("")]);
    await hal.says("让豆包调研一下向量数据库");
    model.replies([call("send_message", { text: "没能确认豆包是否收到。" })], [say("")]);
    expect((await consent(linkOn(hal.cards()[0]), hal)).status).toBe(200);
    await hal.settle();
    expect(world.writes).toHaveLength(2);
    expect(toolOutputs(modelCalls.at(-2))[0].error).toContain("could not be confirmed");
    expect(hal.heard()).toEqual(["没能确认豆包是否收到。"]);
    expect(await (await hal.grant()).status()).toMatchObject({ work: { lost: 1 } });
  });

  it("does not use an authorisation given under a pairing the operator has since changed", async () => {
    await pair();
    const ida = someone();
    const session = await handsOver(ida);
    doubaoReplies(session, "好了。");
    model.replies([call("send_message", { text: "好了。" })], [say("")]);
    await ida.later();

    await pair();
    model.replies([asks("再来一份")], [say("")]);
    await ida.says("让豆包再来一份");
    // Not sent with the old token: she is asked to authorise under the pairing in force now.
    expect(world.writes).toHaveLength(1);
    expect(ida.cards()).toHaveLength(2);
  });

  it("gives the work up at its one deadline, whatever it was waiting on", async () => {
    await pair();
    const jo = someone();
    await handsOver(jo);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
    try {
      await jo.quiet();
      await jo.later();
    } finally {
      clock.mockRestore();
    }
    expect((await jo.requests()).map((each) => each.status)).toEqual(["expired"]);
    expect(world.writes).toHaveLength(1);
    // She was told it was under way; she is told, once, that it is no longer waited for.
    await jo.quiet();
    expect(jo.heard()).toEqual([UNDER_WAY, expect.stringContaining("没有在时限内完成")]);
  });

  it("does not try a second time once its deadline has passed, and says it cannot tell", async () => {
    await pair();
    const lu = someone();
    model.replies([asks("调研一下向量数据库")], [say("")]);
    await lu.says("让豆包调研一下向量数据库");
    // The first try gets no answer, and by then its time is up.
    world.unreachable = 1;
    const real = Date.now;
    let clock: any;
    world.duringWrite = () => void (clock ??= vi.spyOn(Date, "now").mockImplementation(() => real() + 61 * 60_000));
    model.replies([call("send_message", { text: "没能确认。" })], [say("")]);
    try {
      expect((await consent(linkOn(lu.cards()[0]), lu)).status).toBe(200);
      await lu.settle();
    } finally {
      clock?.mockRestore();
    }
    expect(world.writes).toHaveLength(1);
    expect(await (await lu.grant()).status()).toMatchObject({ work: { lost: 1 } });
  });

  it("takes an answer that does not say what was made of it as not knowing, never as not done", async () => {
    await pair();
    const mo = someone();
    world.bareAnswers = 1;
    model.replies([asks("调研一下向量数据库")], [say("")]);
    await mo.says("让豆包调研一下向量数据库");
    model.replies([call("send_message", { text: "没能确认豆包是否收到。" })], [say("")]);
    expect((await consent(linkOn(mo.cards()[0]), mo)).status).toBe(200);
    await mo.settle();
    expect(toolOutputs(modelCalls.at(-2))[0].error).toContain("could not be confirmed");
    expect(await (await mo.grant()).status()).toMatchObject({ work: { lost: 1 } });
  });

  it("carries on the piece of work whose answer the person replied to, and does not guess between several", async () => {
    await pair();
    const ned = someone();
    const a = await handsOver(ned, "调研A");
    doubaoReplies(a, "A 的结论。");
    model.replies([call("send_message", { text: "A 的结论。" })], [say("")]);
    await ned.later();
    model.replies([asks("调研B")], [say("")]);
    await ned.says("让豆包调研B");
    const b = [...world.sessions.keys()].at(-1)!;
    expect(b).not.toBe(a);
    doubaoReplies(b, "B 的结论。");
    model.replies([call("send_message", { text: "B 的结论。" })], [say("")]);
    await ned.later();

    // The agent says something of its own, so the last answer they had is neither piece of work.
    model.replies([call("send_message", { text: "好的。" })], [say("")]);
    await ned.says("谢谢");
    // Two lately, and nothing says which: nothing is sent, and the model is told to ask.
    model.replies([asks("补充成本", true)], [say("你指哪一份？")]);
    await ned.says("让豆包补充成本");
    expect(toolOutputs()[0].error).toContain("cannot be told which");
    expect(world.writes).toHaveLength(2);
    // Replying to A's answer says it is A, without naming Doubao again.
    model.replies([asks("补充成本", true)], [say("")]);
    await ned.says("这份再补充成本", undefined, ned.sentAs("A 的结论。"));
    expect(world.writes.map((each) => each.path).at(-1)).toBe(`/open-apis/agent/v1/sessions/${a}/events`);
  });

  it("no longer hands on what Doubao brought back once the pairing it was asked under has changed", async () => {
    await pair();
    const oz = someone();
    const session = await handsOver(oz);
    const asked = world.listings.length;
    await pair();
    doubaoReplies(session, "做完了。");
    await oz.later();
    expect((await oz.requests()).map((each) => each.status)).toEqual(["void"]);
    await oz.quiet();
    expect(oz.heard()).toEqual([UNDER_WAY, expect.stringContaining("不再等了")]);
    // Doubao was not even asked: the old authorisation is not used under the new pairing.
    expect(world.listings).toHaveLength(asked);
  });

  it("goes on looking from where it stopped in a conversation longer than one look covers", async () => {
    await pair();
    const quin = someone();
    const session = await handsOver(quin);
    doubaoReplies(session, "找到了。");
    const messages = world.sessions.get(session)!.messages;
    for (let i = 0; i < 14; i++) messages.push({ id: `later_${i}`, session_id: session, role: i % 2 ? "assistant" : "user", status: "completed", reply_id: `later_${i - 1}`, items: [{ type: "text", text: "别的" }] });
    world.pageSize = 2;
    world.listings.length = 0;
    await quin.later();
    // Five pages, and not there yet.
    expect(world.listings.map((each) => new URLSearchParams(each).get("page_token"))).toEqual([null, "2", "4", "6", "8"]);
    model.replies([call("send_message", { text: "找到了。" })], [say("")]);
    await quin.later();
    expect(world.listings.slice(5).map((each) => new URLSearchParams(each).get("page_token"))[0]).toBe("10");
    expect(quin.heard().at(-1)).toBe("找到了。");
  });

  it("tells the person that waiting ended also when the last thing it waited on was their authorising again", async () => {
    await pair();
    const rae = someone();
    await handsOver(rae);
    for (const token of world.tokens.values()) token.good = false;
    await rae.later();
    expect(rae.cards()).toHaveLength(2);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
    try {
      await rae.quiet();
    } finally {
      clock.mockRestore();
    }
    await rae.quiet();
    expect((await rae.requests()).map((each) => each.status)).toEqual(["expired"]);
    expect(rae.heard()).toEqual([UNDER_WAY, expect.stringContaining("没有在时限内完成")]);
  });

  it("still gives what Doubao brought back after the person's token has run out by itself, and not after it was taken away", async () => {
    await pair();
    const sam = someone();
    const session = await handsOver(sam);
    doubaoReplies(session, "好了。");
    model.replies([call("send_message", { text: "好了。" })], [say("")]);
    await sam.later();
    const condition = (await rowsOf(sam.stub, "SELECT condition FROM continuations"))[0].condition as string;
    const scope = { tenant: TENANT, kind: "user" as const, id: sam.openId };
    for (const token of world.tokens.values()) token.good = false;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 60 * 60_000);
    try {
      expect(await doubaoConnector.holds!(env as any, scope, condition, 1)).toMatchObject({ state: "holds" });
    } finally {
      clock.mockRestore();
    }
    expect((await admin("DELETE", `doubao/grants/${CHAT_APP}/${ORG}/${sam.openId}`)).status).toBe(200);
    expect(await doubaoConnector.holds!(env as any, scope, condition, 1)).toEqual({ state: "gone" });
  });

  it("does not send a second time with an authorisation that was taken away between the tries", async () => {
    await pair();
    const tess = someone();
    model.replies([asks("调研一下向量数据库")], [say("")]);
    await tess.says("让豆包调研一下向量数据库");
    world.unreachable = 1;
    // Taken away while the first try is on its way, which then brings no answer.
    world.duringWrite = () => admin("DELETE", `doubao/grants/${CHAT_APP}/${ORG}/${tess.openId}`);
    model.replies([call("send_message", { text: "没能确认。" })], [say("")]);
    expect((await consent(linkOn(tess.cards()[0]), tess)).status).toBe(200);
    await tess.settle();
    expect(world.writes).toHaveLength(1);
  });

  it("finds the reply further back than the first page of a long conversation", async () => {
    await pair();
    const pat = someone();
    const session = await handsOver(pat);
    doubaoReplies(session, "第一份。");
    model.replies([call("send_message", { text: "第一份。" })], [say("")]);
    await pat.later();
    // A follow-up, and after it more talk in the same conversation (from Doubao Work itself, say).
    model.replies([asks("再补充", true)], [say("")]);
    await pat.says("让豆包再补充");
    doubaoReplies(session, "补充好了。");
    const messages = world.sessions.get(session)!.messages;
    for (let i = 0; i < 5; i++) messages.push({ id: `later_${i}`, session_id: session, role: i % 2 ? "assistant" : "user", status: "completed", reply_id: `later_${i - 1}`, items: [{ type: "text", text: "别的" }] });
    world.pageSize = 2;
    model.replies([call("send_message", { text: "补充好了。" })], [say("")]);
    await pat.later();
    expect(pat.heard().at(-1)).toBe("补充好了。");
    expect(world.listings.length).toBeGreaterThan(1);
  });

  it("keeps the key of a piece of work that has not ended, however many come after it", async () => {
    const grant = (env as any).DOUBAO_GRANTS.getByName(await grantName({ chat_app_id: CHAT_APP, tenant_key: ORG, open_id: "ou_many" })) as any;
    const who = { chat_app_id: CHAT_APP, tenant_key: ORG, open_id: "ou_many", union_id: "on_many" };
    const first = await grant.begin(who, "call_first", "一", { carryOn: false }, "p1", 1);
    await grant.advance("call_first", "submitting");
    for (let i = 0; i < 49; i++) {
      await grant.begin(who, `call_${i}`, "x", { carryOn: false }, "p1", 1);
      await grant.advance(`call_${i}`, "submitting");
      await grant.advance(`call_${i}`, "failed");
    }
    // One that has ended stays as it ended.
    expect(await grant.advance("call_0", "submitted")).toMatchObject({ stage: "failed" });
    // No room is made while any of these calls could still be made again, ended or not: a new one is refused.
    expect(await grant.begin(who, "call_more", "x", { carryOn: false }, "p1", 1)).toBe("full");
    // Nor just past the deadline: the same call made again is the same piece of work, with the same key and the same deadline.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
    try {
      expect(await grant.begin(who, "call_more", "x", { carryOn: false }, "p1", 1)).toBe("full");
      expect(await grant.begin(who, "call_first", "一", { carryOn: false }, "p1", 1)).toEqual({ ...first, stage: "submitting" });
      expect(await grant.begin(who, "call_0", "x", { carryOn: false }, "p1", 1)).toMatchObject({ stage: "failed" });
      // Long after, when nothing can ask about them again, they make room.
      clock.mockReturnValue(Date.now() + 4 * 60 * 60_000);
      expect(await grant.begin(who, "call_more", "x", { carryOn: false }, "p1", 1)).toMatchObject({ stage: "asked" });
    } finally {
      clock.mockRestore();
    }
  });

  it("asks for authorisation again, and for the same reply, when the authorisation ends while Doubao is at work", async () => {
    await pair();
    const kai = someone();
    const session = await handsOver(kai);
    for (const token of world.tokens.values()) token.good = false;
    await kai.later();
    // The same piece of work: nothing handed over again, a new way in shown.
    expect(world.writes).toHaveLength(1);
    expect(kai.cards()).toHaveLength(2);
    doubaoReplies(session, "做完了。");
    model.replies([call("send_message", { text: "做完了。" })], [say("")]);
    expect((await consent(linkOn(kai.cards().at(-1)), kai)).status).toBe(200);
    await kai.settle();
    await kai.later();
    expect(world.writes).toHaveLength(1);
    expect(kai.heard().at(-1)).toBe("做完了。");
  });
});
