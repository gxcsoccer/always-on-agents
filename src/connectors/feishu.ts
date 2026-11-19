/**
 * Feishu (Lark) connector.
 *
 * Inbound: the event subscription webhook of a bot app. Each tenant registers its own app; the
 * app id is in the webhook path, and the app's Encrypt Key and Verification Token (held in the
 * registry) prove a request came from Feishu. A direct message becomes an event in the sender's
 * user scope; a group message that @-mentions the bot becomes an event in that chat's scope.
 *
 * Identity: the sender's open_id, which Feishu puts in the signed event. A direct message or an
 * @-mention is the person deliberately addressing the agent.
 *
 * Outbound: replies as the bot, using the app's tenant_access_token.
 *
 * NOT YET VERIFIED AGAINST A REAL FEISHU APP. Signature, decryption and the event and message
 * shapes follow the open platform documentation, and decryption is checked against its published
 * test vector. The URL-verification handshake follows the long-standing documented behaviour but
 * the page describing it could not be retrieved when this was written.
 */
import type { Env } from "../env";
import { type InboundEvent, type Scope, type Target, scopeName } from "../events";
import { type FeishuApp, registry } from "../registry";
import type { ApprovalQuestion, OutboundMessage, Outcome, Receipt } from "./index";

const API = "https://open.feishu.cn/open-apis";
/** Feishu signs with a timestamp; anything much older is a replay. */
/** How long a card press may take to be filed before Feishu's three-second limit forces an answer. */
const PRESS_FILING_BUDGET_MS = 2_000;
const MAX_SKEW_S = 10 * 60;

export async function handleFeishuWebhook(request: Request, env: Env, appId: string, defer?: (work: Promise<unknown>) => void): Promise<Response> {
  const app = await registry(env).feishuApp(appId);
  if (!app) return json({ error: "unknown app" }, 404);
  // Events are accepted only encrypted and signed. The Verification Token alone is a fixed string in
  // the body: it proves nothing about freshness, so an app without an Encrypt Key is not served.
  // An app whose events arrive over the long connection is not served here at all: one way in.
  if (app.transport !== "webhook") return json({ error: "not accepted" }, 401);
  if (!app.encrypt_key) return json({ error: "the app has no encrypt key configured" }, 503);

  const raw = await request.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }

  // Every rejection below looks the same from outside, so the endpoint cannot be used to find out
  // which part of a forged request was wrong.
  // Why is logged for the operator, as one of a fixed set of reasons and a few yes/no facts about
  // the request. Nothing the sender wrote is logged, not even the names of its fields.
  const rejected = (why: "not_encrypted" | "does_not_decrypt" | "bad_signature" | "wrong_token" | "wrong_app" | "bad_challenge") => {
    const stamp = request.headers.get("x-lark-request-timestamp") ?? "";
    console.log(
      JSON.stringify({
        feishu_rejected: why,
        app: appId,
        has_signature: request.headers.has("x-lark-signature"),
        has_nonce: request.headers.has("x-lark-request-nonce"),
        timestamp: stamp === "" ? "missing" : sentAt(stamp) === undefined ? "unreadable" : "readable",
      }),
    );
    return json({ error: "not accepted" }, 401);
  };
  if (typeof body.encrypt !== "string") return rejected("not_encrypted");

  // The signature covers the raw body, so it is checked before anything is decrypted. The one
  // exception is the address check Feishu performs when the webhook URL is saved: Feishu does not
  // sign it. Being able to produce a body that decrypts to a well-formed challenge is its proof.
  const signed = await verifySignature(app.encrypt_key, raw, request.headers.get("x-lark-request-timestamp"), request.headers.get("x-lark-request-nonce"), request.headers.get("x-lark-signature"));
  try {
    body = JSON.parse(await decrypt(app.encrypt_key, body.encrypt));
  } catch {
    return rejected("does_not_decrypt");
  }
  if (body?.type === "url_verification") {
    if (typeof body.challenge !== "string" || body.challenge.length > 200) return rejected("bad_challenge");
    if (app.verification_token && body.token !== app.verification_token) return rejected("wrong_token");
    return json({ challenge: body.challenge });
  }
  if (!signed) return rejected("bad_signature");
  if (app.verification_token && body.header?.token !== app.verification_token) return rejected("wrong_token");
  if (body.header?.app_id !== app.app_id) return rejected("wrong_app");

  return json(await receiveFeishu(env, app, body, defer));
}

/**
 * Handles one event or card callback from Feishu that is known to be genuine: a webhook delivery
 * after its signature has been checked, or a frame from the long connection. Returns what Feishu
 * should be answered with.
 */
export async function receiveFeishu(env: Env, app: FeishuApp, body: any, defer?: (work: Promise<unknown>) => void): Promise<unknown> {
  // A button pressed on one of the agent's cards. Feishu shows what we return as a toast.
  if (body.header?.event_type === "card.action.trigger") {
    const pressed = normalizeCardAction(app, body);
    if (!pressed) return { toast: { type: "error", content: "这个操作无法处理" } };
    // The press is filed before the person is told it was received: a refusal that was shown as
    // received and then lost would leave an approval free to go through. Feishu, though, shows an
    // error unless it is answered within three seconds. So filing gets most of that time; if it
    // has not finished, it carries on in the background and the person is told plainly that it is
    // not confirmed yet, and if it fails they are told to press again.
    const said = pressed.event.text?.startsWith("deny") ? "拒绝" : pressed.event.text?.startsWith("approve all") ? "批准（这个任务不再问）" : "批准";
    const filing: Promise<"filed" | "failed"> = env.BRAIN.getByName(scopeName(pressed.scope))
      .ingest(pressed.event)
      .then(
        () => "filed" as const,
        (err: unknown) => {
          console.log(JSON.stringify({ feishu_press_not_filed: String(err).slice(0, 300), app: app.app_id }));
          return "failed" as const;
        },
      );
    const outcome = defer ? await Promise.race([filing, new Promise<"slow">((resolve) => setTimeout(() => resolve("slow"), PRESS_FILING_BUDGET_MS))]) : await filing;
    if (outcome === "slow") defer?.(filing);
    if (outcome === "filed") return { toast: { type: "info", content: `已收到你的选择：${said}。结果会在对话里回复` } };
    if (outcome === "failed") return { toast: { type: "error", content: `没能记下你的选择（${said}），请再点一次` } };
    return { toast: { type: "warning", content: `正在记录你的选择：${said}。如果对话里一直没有回应，请再点一次` } };
  }

  const normalized = normalize(app, body);
  if (!normalized) return { ignored: true };
  const brain = env.BRAIN.getByName(scopeName(normalized.scope));
  return { ...(await brain.ingest(normalized.event)), scope: scopeName(normalized.scope) };
}

/**
 * A press of "approve" or "refuse" on an approval card becomes that person's message "approve CODE"
 * or "deny CODE". Who pressed it comes from Feishu's signed callback, not from the card. The card's
 * own value only says which button it was and whether the card was sent to a group or a person; the
 * chat itself is taken from the callback.
 */
export function normalizeCardAction(app: FeishuApp, body: any): { scope: Scope; event: InboundEvent } | undefined {
  const { operator, action, context } = body.event ?? {};
  if (!operator?.tenant_key || operator.tenant_key !== body.header?.tenant_key) return undefined;
  const openId: unknown = operator.open_id;
  if (typeof openId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(openId)) return undefined;
  const value = action?.value;
  if (!value || value.aoa !== "answer" || !/^[A-Z0-9]{4}$/.test(String(value.code)) || !["approve", "approve_all", "deny"].includes(value.decision)) return undefined;
  if (typeof value.q !== "string" || !/^ask:[0-9a-f-]{36}:\d{1,9}$/.test(value.q)) return undefined;
  const chatId: unknown = context?.open_chat_id;
  if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(chatId) || typeof body.header?.event_id !== "string") return undefined;
  const group = value.to === "chat";
  return {
    scope: { tenant: app.tenant, kind: group ? "chat" : "user", id: group ? chatId : openId },
    event: {
      source: "feishu",
      source_id: `card:${body.header.event_id}`,
      kind: "message",
      session_key: group ? "chat" : "dm",
      principal: { kind: "human", id: openId, explicit: true },
      text: `${value.decision === "approve_all" ? "approve all" : value.decision} ${value.code}`,
      // Which question's card was pressed. The press answers that question and no other.
      data: { chat_id: chatId, card: true, route_by_code: true, question: value.q },
      reply_to: { connector: "feishu", address: { app_id: app.app_id, chat_id: chatId } },
    },
  };
}

/** Exported for tests. Returns undefined for events the agent does not act on. */
export function normalize(app: FeishuApp, body: any): { scope: Scope; event: InboundEvent } | undefined {
  if (body.schema !== "2.0" || body.header?.event_type !== "im.message.receive_v1") return undefined;
  const { sender, message } = body.event ?? {};
  // Other bots talking is not a person asking.
  if (sender?.sender_type !== "user") return undefined;
  // A group can contain people from other organisations. Only members of the organisation the app
  // is installed in are this tenant's users.
  if (!sender.tenant_key || sender.tenant_key !== body.header?.tenant_key) return undefined;
  const openId: unknown = sender.sender_id?.open_id;
  if (typeof openId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(openId)) return undefined;
  if (typeof message?.message_id !== "string" || typeof message.chat_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(message.chat_id)) return undefined;

  const mentions: any[] = Array.isArray(message.mentions) ? message.mentions : [];
  const group = message.chat_type === "group";
  if (group) {
    // In a group, only messages that @ this very bot are for the agent. Without knowing the bot's
    // own id there is no telling it from any other bot in the group, so groups are not served.
    if (!app.bot_open_id || !mentions.some((m) => m.id?.open_id === app.bot_open_id)) return undefined;
  } else if (message.chat_type !== "p2p") {
    return undefined;
  }

  let text = "";
  if (message.message_type === "text") {
    try {
      text = String(JSON.parse(message.content).text ?? "");
    } catch {
      return undefined;
    }
    // Mentions arrive as placeholders (@_user_1). They are replaced in a single pass over the
    // original text, so nothing inserted for one mention can be rewritten while handling another.
    // The bot's own is dropped: it only says the message is for the agent, which the event already
    // records. A person's display name is whatever they typed, so it is squeezed into one token and
    // no word of it can be read as part of the message ("Alice Approve" must not supply an "approve").
    const replacements = new Map<string, string>();
    for (const mention of mentions) {
      if (typeof mention.key !== "string" || !/^@_user_\d+$/.test(mention.key)) continue;
      const own = app.bot_open_id && mention.id?.open_id === app.bot_open_id;
      replacements.set(mention.key, own ? " " : `@${String(mention.name ?? "").replace(/[^\p{L}\p{N}_-]/gu, "") || "someone"}`);
    }
    // A placeholder with no entry in the mention list is kept visible as a mention of someone
    // unknown. Dropping it would turn a message addressed to somebody into one addressed to nobody.
    text = text.replace(/@_user_\d+/g, (key) => replacements.get(key) ?? "@unknown");
    text = text.replace(/\s+/g, " ").trim();
  } else {
    text = `[a ${String(message.message_type)} message, which I cannot read yet]`;
  }

  // A topic thread is a conversation of its own. An ordinary reply to a message is not: it stays in
  // the chat's conversation, which is where people answer what the agent just said.
  const thread: string | undefined = message.thread_id || undefined;
  return {
    scope: { tenant: app.tenant, kind: group ? "chat" : "user", id: group ? message.chat_id : openId },
    event: {
      source: "feishu",
      // Feishu can deliver the same message more than once, under different event ids.
      source_id: message.message_id,
      kind: "message",
      session_key: group ? (thread ? `thread:${thread}` : "chat") : "dm",
      principal: { kind: "human", id: openId, explicit: true },
      text,
      data: {
        message_id: message.message_id,
        chat_id: message.chat_id,
        chat_type: message.chat_type,
        route_by_code: true,
        // The message this one was written in reply to, if any. A reply to the agent's question is
        // an answer to that question, whatever its wording.
        // Not inside a topic: there every post points at the topic's first message, so a post
        // cannot be told from a reply to it, and an answer has to use the button or the code.
        ...(!message.thread_id && typeof (message.parent_id || message.root_id) === "string" ? { replies_to: `feishu:message:${message.parent_id || message.root_id}` } : {}),
      },
      reply_to: {
        connector: "feishu",
        address: { app_id: app.app_id, chat_id: message.chat_id, ...(group ? { message_id: message.message_id, ...(thread ? { thread: "1" } : {}) } : {}) },
      },
    },
  };
}

/** sha256(timestamp + nonce + encrypt_key + raw body), hex. */
export async function verifySignature(encryptKey: string, raw: string, timestamp: string | null, nonce: string | null, signature: string | null, now = Date.now()): Promise<boolean> {
  if (!timestamp || !nonce || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  // The signature is over the header exactly as sent. What the header holds differs: events send
  // Unix seconds, card callbacks a written-out time ("2026-11-19 14:50:01.123456789 +0800 CST m=+…").
  const seconds = sentAt(timestamp);
  if (seconds === undefined || Math.abs(now / 1_000 - seconds) > MAX_SKEW_S) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(timestamp + nonce + encryptKey + raw)));
  let diff = 0;
  for (let i = 0; i < digest.length; i++) diff |= digest[i] ^ Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  return diff === 0;
}

/** When a request says it was sent, in Unix seconds, from either form of the timestamp header. */
export function sentAt(timestamp: string): number | undefined {
  if (/^\d{9,11}$/.test(timestamp)) return Number(timestamp);
  const written = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})\b/.exec(timestamp);
  if (!written) return undefined;
  const ms = Date.parse(`${written[1]}T${written[2]}${written[3]}:${written[4]}`);
  return Number.isFinite(ms) ? ms / 1_000 : undefined;
}

/** AES-256-CBC, key = SHA-256(encrypt key), IV = the first 16 bytes of the decoded ciphertext. */
export async function decrypt(encryptKey: string, ciphertext: string): Promise<string> {
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (data.length < 32) throw new Error("ciphertext is too short");
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptKey)), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: data.subarray(0, 16) }, key, data.subarray(16));
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

/** Sends as the bot. A direct chat gets a new message; a group gets a reply to the message that asked. */
export async function deliverFeishu(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<Receipt | void> {
  const { app_id: appId, chat_id: chatId, message_id: messageId, thread } = target.address;
  if (!appId || !chatId) throw new Error("bad Feishu address");
  const token = await tenantAccessToken(env, appId);
  // Feishu drops a repeat of the same uuid within an hour, which makes a retry safe.
  const uuid = (await hex(message.idem)).slice(0, 40);
  // An approval question goes out as a card with buttons; everything else as text.
  const msgType = message.ask ? "interactive" : "text";
  const content = JSON.stringify(message.ask ? approvalCard(message.ask, scope.kind === "chat" ? "chat" : "user") : { text: message.text });

  const response = messageId
    ? await fetch(`${API}/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ msg_type: msgType, content, uuid, reply_in_thread: thread === "1" }),
      })
    : await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content, uuid }),
      });
  const result = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { message_id?: string } };
  if (!response.ok || result.code !== 0) throw new Error(`Feishu returned ${response.status} code ${result.code}: ${String(result.msg).slice(0, 200)}`);
  // Which message the question is, so a reply to it can be told from a reply to anything else,
  // and so the card can be closed later.
  if (message.ask && result.data?.message_id) return { subject: `feishu:message:${result.data.message_id}`, holder: "" };
}

/** Replaces a question's card with one that says how it ended and has no buttons. */
export async function amendFeishu(env: Env, target: Target, receipt: Receipt, ask: ApprovalQuestion, outcome: Outcome): Promise<void> {
  const messageId = /^feishu:message:([A-Za-z0-9_-]{1,100})$/.exec(receipt.subject)?.[1];
  const appId = target.address.app_id;
  if (!messageId || !appId) return;
  const token = await tenantAccessToken(env, appId);
  const response = await fetch(`${API}/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ content: JSON.stringify(approvalCard(ask, "chat", outcome)) }),
  });
  const result = (await response.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (!response.ok || result.code !== 0) throw new Error(`Feishu returned ${response.status} code ${result.code}: ${String(result.msg).slice(0, 200)}`);
}

/**
 * The approval question as a card. Everything that comes from the task is plain text, so nothing in
 * a command or a branch name can be rendered as formatting or as a link.
 */
export function approvalCard(ask: NonNullable<OutboundMessage["ask"]>, to: "chat" | "user", outcome?: Outcome): unknown {
  const plain = (content: string) => ({ tag: "plain_text", content });
  const button = (label: string, type: string, decision: "approve" | "approve_all" | "deny") => ({
    tag: "button",
    text: plain(label),
    type,
    // The question's own id goes with the press: a card left over from an earlier question that
    // happened to get the same code cannot answer a later one.
    value: { aoa: "answer", decision, code: ask.code, q: ask.id, to },
  });
  // First what would happen, in a sentence. Then the exact thing, in full, for anyone who wants
  // to check it: that is what the approval is for.
  const zero = /^0+$/;
  const moves = (ask.refs ?? []).map((r) => {
    const name = r.ref.replace(/^refs\/heads\//, "分支 ").replace(/^refs\/tags\//, "标签 ");
    if (zero.test(r.new)) return `删除${name}`;
    if (zero.test(r.old)) return `新建${name}（${r.new.slice(0, 7)}）`;
    return `更新${name}（${r.old.slice(0, 7)} → ${r.new.slice(0, 7)}）`;
  });
  const summary = ask.kind === "push" ? `把代码推送到 ${ask.resource || "仓库"}${moves.length ? `：${moves.join("；")}` : ""}` : "在沙箱里执行一条命令";
  const about = [
    { tag: "div", text: plain(`任务“${ask.title}”想要${summary}。`) },
    { tag: "note", elements: [plain(ask.kind === "push" ? `完整内容：${ask.detail}` : `命令：${ask.detail}`)] },
  ];
  // Closed: it says how it ended, and there is nothing left to press.
  if (outcome) {
    const ended = { approved: ["green", "已批准"], refused: ["red", "已拒绝"], withdrawn: ["grey", "已失效"] }[outcome.state];
    const note = outcome.state === "withdrawn" ? "这个请求已经不再等待答复。" : outcome.state === "approved" && outcome.standing ? "已批准。这个任务之后推送同样的分支不会再问，包括改写该分支历史的推送。" : `${ended[1]}。`;
    return { config: { wide_screen_mode: true, update_multi: true }, header: { template: ended[0], title: plain(`${ended[1]} · ${ask.code}`) }, elements: [...about, { tag: "note", elements: [plain(note)] }] };
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: "orange", title: plain(`需要你批准 · ${ask.code}`) },
    elements: [
      ...about,
      ...(ask.can_approve ? [] : [{ tag: "div", text: plain("内容太长，无法完整显示，所以只能拒绝。") }]),
      {
        tag: "action",
        actions: [
          ...(ask.can_approve ? [button("批准", "primary", "approve")] : []),
          ...(ask.can_approve && ask.standing_offered ? [button("批准，这个任务不再问", "default", "approve_all")] : []),
          button("拒绝", "danger", "deny"),
        ],
      },
      // What the wider approval covers is said before it is given.
      ...(ask.can_approve && ask.standing_offered ? [{ tag: "note", elements: [plain("“这个任务不再问”：这个任务之后再推送这些分支时不再询问，包括可能改写分支历史的推送；删除分支、其他分支和标签仍会询问。")] }] : []),
      // The words that always work, wherever in the chat they are typed. In a group the bot only
      // hears what mentions it, so the card says so.
      { tag: "note", elements: [plain(`${to === "chat" ? "也可以先 @我，再输入" : "也可以输入"}${ask.can_approve ? `「批准 ${ask.code}」或` : ""}「拒绝 ${ask.code}」`)] },
    ],
  };
}

/** The app's tenant_access_token, cached in the registry until shortly before it expires. */
async function tenantAccessToken(env: Env, appId: string): Promise<string> {
  const app = await registry(env).feishuApp(appId);
  if (!app) throw new Error("unknown Feishu app");
  if (app.token && app.token_expires_at && app.token_expires_at - Date.now() > 5 * 60_000) return app.token;
  const response = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: app.app_id, app_secret: app.app_secret }),
  });
  const result = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (!response.ok || result.code !== 0 || !result.tenant_access_token) throw new Error(`Feishu token request failed: ${response.status} code ${result.code} ${String(result.msg).slice(0, 200)}`);
  await registry(env).saveFeishuToken(appId, result.tenant_access_token, Date.now() + (result.expire ?? 0) * 1_000);
  return result.tenant_access_token;
}

async function hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
