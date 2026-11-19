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
import type { OutboundMessage } from "./index";

const API = "https://open.feishu.cn/open-apis";
/** Feishu signs with a timestamp; anything much older is a replay. */
const MAX_SKEW_S = 10 * 60;

export async function handleFeishuWebhook(request: Request, env: Env, appId: string): Promise<Response> {
  const app = await registry(env).feishuApp(appId);
  if (!app) return json({ error: "unknown app" }, 404);
  // Events are accepted only encrypted and signed. The Verification Token alone is a fixed string in
  // the body: it proves nothing about freshness, so an app without an Encrypt Key is not served.
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
  const rejected = () => json({ error: "not accepted" }, 401);
  if (typeof body.encrypt !== "string") return rejected();

  // The signature covers the raw body, so it is checked before anything is decrypted. The one
  // exception is the address check Feishu performs when the webhook URL is saved: Feishu does not
  // sign it. Being able to produce a body that decrypts to a well-formed challenge is its proof.
  const signed = await verifySignature(app.encrypt_key, raw, request.headers.get("x-lark-request-timestamp"), request.headers.get("x-lark-request-nonce"), request.headers.get("x-lark-signature"));
  try {
    body = JSON.parse(await decrypt(app.encrypt_key, body.encrypt));
  } catch {
    return rejected();
  }
  if (body?.type === "url_verification") {
    if (typeof body.challenge !== "string" || body.challenge.length > 200) return rejected();
    if (app.verification_token && body.token !== app.verification_token) return rejected();
    return json({ challenge: body.challenge });
  }
  if (!signed) return rejected();
  if (app.verification_token && body.header?.token !== app.verification_token) return rejected();
  if (body.header?.app_id !== app.app_id) return rejected();

  // A button pressed on one of the agent's cards. Feishu shows what we return as a toast.
  if (body.header?.event_type === "card.action.trigger") {
    const pressed = normalizeCardAction(app, body);
    if (!pressed) return json({ toast: { type: "error", content: "这个操作无法处理" } });
    await env.BRAIN.getByName(scopeName(pressed.scope)).ingest(pressed.event);
    return json({ toast: { type: "info", content: `已收到：${pressed.event.text}，结果会在对话里回复` } });
  }

  const normalized = normalize(app, body);
  if (!normalized) return json({ ignored: true });
  const brain = env.BRAIN.getByName(scopeName(normalized.scope));
  return json({ ...(await brain.ingest(normalized.event)), scope: scopeName(normalized.scope) });
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
  if (!value || value.aoa !== "answer" || !/^[A-Z0-9]{4}$/.test(String(value.code)) || (value.decision !== "approve" && value.decision !== "deny")) return undefined;
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
      text: `${value.decision} ${value.code}`,
      data: { chat_id: chatId, card: true, route_by_code: true },
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
      data: { message_id: message.message_id, chat_id: message.chat_id, chat_type: message.chat_type, route_by_code: true },
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
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1_000 - seconds) > MAX_SKEW_S) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(timestamp + nonce + encryptKey + raw)));
  let diff = 0;
  for (let i = 0; i < digest.length; i++) diff |= digest[i] ^ Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  return diff === 0;
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
export async function deliverFeishu(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<void> {
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
  const result = (await response.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (!response.ok || result.code !== 0) throw new Error(`Feishu returned ${response.status} code ${result.code}: ${String(result.msg).slice(0, 200)}`);
}

/**
 * The approval question as a card. Everything that comes from the task is plain text, so nothing in
 * a command or a branch name can be rendered as formatting or as a link.
 */
export function approvalCard(ask: NonNullable<OutboundMessage["ask"]>, to: "chat" | "user"): unknown {
  const plain = (content: string) => ({ tag: "plain_text", content });
  const button = (label: string, type: string, decision: "approve" | "deny") => ({
    tag: "button",
    text: plain(label),
    type,
    value: { aoa: "answer", decision, code: ask.code, to },
  });
  return {
    config: { wide_screen_mode: true },
    header: { template: "orange", title: plain(`需要你批准 · ${ask.code}`) },
    elements: [
      { tag: "div", text: plain(`任务：${ask.title}`) },
      { tag: "div", text: plain(ask.kind === "push" ? "它要推送代码：" : "它要执行这条命令：") },
      { tag: "div", text: plain(ask.detail) },
      ...(ask.can_approve ? [] : [{ tag: "div", text: plain("内容太长，无法完整显示，所以只能拒绝。") }]),
      { tag: "action", actions: [...(ask.can_approve ? [button("批准", "primary", "approve")] : []), button("拒绝", "danger", "deny")] },
      { tag: "note", elements: [plain(ask.can_approve ? `也可以直接回复：approve ${ask.code} 或 deny ${ask.code}` : `也可以直接回复：deny ${ask.code}`)] },
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
