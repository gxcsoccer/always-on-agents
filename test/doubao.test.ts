/**
 * Handing work to Doubao Work for a person, through the chat connector they write in: the whole
 * way, with the real Brain and stand-ins for the two outside services.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { grantName } from "../src/connectors/doubao";
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
  unreachable: 0,
  scope: SCOPE,
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
  world.unreachable = 0;
  world.scope = SCOPE;
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
      // Reactions and the like: taken, and of no interest here.
      return Response.json({ code: 0, data: {} });
    }
    if (url.host === "accounts.doubao.com" && url.pathname === "/oauth/v3/token") {
      const consent = world.codes.get(body.code);
      world.codes.delete(body.code);
      if (body.client_id !== WORK_APP || body.client_secret !== "work-secret") return Response.json({ code: 20002 }, { status: 400 });
      if (!consent || consent.redirect !== body.redirect_uri || (await challengeOf(String(body.code_verifier))) !== consent.challenge) return Response.json({ code: 20003 }, { status: 400 });
      const token = `d-${++world.issued}`;
      world.tokens.set(token, { ...consent, good: true });
      return Response.json({ code: 0, access_token: token, expires_in: 7200, token_type: "Bearer", scope: world.scope });
    }
    const user = world.tokens.get(bearer);
    if (url.host === "accounts.doubao.com" && url.pathname === "/open-apis/authen/v1/user_info") return user?.good ? Response.json({ code: 0, data: { open_id: user.open_id, union_id: user.union_id, tenant_key: user.tenant_key } }) : Response.json({ code: 99991668 }, { status: 401 });
    if (url.host !== "open.doubao.com" || !url.pathname.startsWith("/open-apis/agent/v1/sessions")) throw new Error(`unexpected fetch to ${url.href}`);
    if (!user?.good) return Response.json({ code: 99991677 }, { status: 401 });
    const into = /\/sessions\/([^/]+)\/(events|messages)$/.exec(url.pathname);
    if (into?.[2] === "messages") {
      const session = world.sessions.get(into[1]);
      if (!session || session.owner !== user.union_id) return Response.json({ code: 3440004 }, { status: 404 });
      return Response.json({ code: 0, data: { messages: [...session.messages].reverse() } });
    }
    // A write. The same key with the same words is answered as it was the first time; with other words it is refused.
    world.writes.push({ path: url.pathname, body, bearer });
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
    return Response.json(answer);
  });
}

/** Doubao's reply to the newest thing asked in a conversation. */
function doubaoReplies(session: string, text: string, status = "completed", artifacts: any[] = []) {
  const messages = world.sessions.get(session)!.messages;
  const asked = messages.filter((each) => each.role === "user").at(-1);
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
  const event = (text: string, union: string | undefined = unionId) =>
    normalize(APP, {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", tenant_key: ORG, app_id: CHAT_APP },
      event: { sender: { sender_type: "user", tenant_key: ORG, sender_id: { open_id: openId, ...(union ? { union_id: union } : {}) } }, message: { message_id: `om_${openId}_${++n}`, chat_id: `oc_${openId}`, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
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
  const says = async (text: string, union?: string) => {
    await stub.ingest(event(text, union));
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
  const heard = () => world.sent.filter((each) => each.to === `oc_${openId}` && each.type === "text").map((each) => String(each.content.text));
  const cards = () => world.sent.filter((each) => each.to === `oc_${openId}` && each.type === "interactive").map((each) => each.content);
  const requests = (): Promise<{ status: string; why: string | null; condition: string }[]> => rowsOf(stub, "SELECT status, why, condition FROM continuations ORDER BY rowid");
  return { openId, unionId, stub, event, says, quiet, settle, later, heard, cards, requests, grant };
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

  it("keeps nothing when another account completes the authorisation, or when more is granted than was asked", async () => {
    await pair();
    const dee = someone();
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    const other = await consent(linkOn(dee.cards()[0]), { unionId: "on_someone_else" });
    expect(other.status).toBe(403);
    expect(await (await dee.grant()).status()).toMatchObject({ authorised: false });
    expect(world.writes).toEqual([]);

    // Asked again: a new way in. This time Doubao grants more than was asked for.
    model.replies([asks("写周报")], [say("")]);
    await dee.says("让豆包写周报");
    world.scope = `${SCOPE} doubao:session:read`;
    expect((await consent(linkOn(dee.cards().at(-1)), dee)).status).toBe(400);
    expect(await (await dee.grant()).status()).toMatchObject({ authorised: false });
    // And the right account in another organisation is not her either.
    world.scope = SCOPE;
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
    expect(toolOutputs()[0].error).toContain("has not asked for Doubao");
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
