/**
 * Feishu (Lark) connector.
 *
 * Inbound: events and card callbacks of a bot app. Each tenant registers its own app. They arrive
 * one of two ways, chosen per app:
 *   - over the long connection (see feishu-link.ts), which this deployment opens to Feishu;
 *   - at a webhook, where the app id is in the path and the app's Encrypt Key proves a request
 *     came from Feishu: only encrypted and signed deliveries are accepted.
 * Either way the same function, `receiveFeishu`, handles what arrived. A direct message becomes an
 * event in the sender's user scope; a group message that mentions the bot becomes an event in that
 * chat's scope; a press on an approval card becomes the presser's own "approve" or "deny".
 *
 * Identity: the sender's (or presser's) open_id, as Feishu states it. A direct message, a mention
 * and a button press are each the person deliberately addressing the agent.
 *
 * Outbound: replies as the bot, using the app's tenant_access_token. An approval question goes out
 * as a card, and is replaced by a closed card once it is decided or withdrawn.
 */
import type { Env } from "../env";
import { type InboundEvent, type Scope, type Target, privateSessionKey, scopeName } from "../events";
import { type FeishuApp, registry } from "../registry";
import { API, hex, tenantAccessToken } from "./feishu-api";
import { type DocumentRef, authorisationHolds, documentsIn, handleOauthCallback, invitationFor, readDocument } from "./feishu-docs";
import { grantOf } from "./feishu-grant";
import { type ApprovalQuestion, type Connector, DeliveryRejected, DeliveryVoid, type OutboundMessage, type Outcome, type Receipt } from "./types";

export const feishuConnector: Connector = {
  name: "feishu",
  async http(request, env, path, ingress) {
    if (path[0] === "events" && path[1] && request.method === "POST") return handleFeishuWebhook(request, env, path[1], (work) => ingress.defer(work));
    // Where Feishu sends a person back to after they authorise reading their documents.
    if (path[0] === "oauth" && path[1] === "callback" && path.length === 2 && request.method === "GET") return handleOauthCallback(request, env);
    return json({ error: "not found" }, 404);
  },
  async admin({ method, path, url, body }, env) {
    if (path[0] === "feishu-links" && path[1] && method === "GET") return json(await env.FEISHU_LINKS.getByName(path[1]).status());
    // How this one app's authorisations are obtained: which token endpoint, and whether they can be renewed.
    if (path[0] === "feishu-apps" && path[1] && path[2] === "oauth" && path.length === 3 && method === "POST") {
      const { token_endpoint: endpoint, offline_access: offline } = await body();
      if (endpoint === undefined && offline === undefined) return json({ error: "give token_endpoint, offline_access, or both" }, 400);
      if (endpoint !== undefined && endpoint !== "v2" && endpoint !== "v3") return json({ error: "token_endpoint must be v2 or v3" }, 400);
      if (offline !== undefined && typeof offline !== "boolean") return json({ error: "offline_access must be true or false" }, 400);
      const now = await registry(env).setFeishuOauth(path[1], { token_endpoint: endpoint, offline_access: offline });
      return now ? json({ ok: true, ...now }) : json({ error: "unknown app" }, 404);
    }
    // One person's authorisation to read their documents: whether it stands, and taking it away.
    if (path[0] === "feishu-grants" && path.length === 4 && (method === "GET" || method === "DELETE")) {
      const who = { app_id: path[1], tenant_key: path[2], open_id: path[3] };
      const grant = await grantOf(env, who);
      if (method === "DELETE") await grant.drop(who);
      return json(await grant.status());
    }
    if (path[0] !== "tenants" || path[2] !== "feishu-apps" || method !== "POST") return undefined;
    const app = await body();
    await registry(env).setFeishuApp(path[1], {
      app_id: String(app.app_id ?? ""),
      app_secret: String(app.app_secret ?? ""),
      encrypt_key: app.encrypt_key ? String(app.encrypt_key) : undefined,
      verification_token: app.verification_token ? String(app.verification_token) : undefined,
      bot_open_id: app.bot_open_id ? String(app.bot_open_id) : undefined,
      transport: app.transport === undefined ? undefined : app.transport,
    });
    // Over the long connection there is nothing for Feishu to call; we connect to it instead.
    if (app.transport === "long_connection") {
      return json({ ok: true, transport: "long_connection", link: await env.FEISHU_LINKS.getByName(String(app.app_id)).ensure(String(app.app_id), true) });
    }
    return json({ ok: true, webhook: `${url.origin}/v1/feishu/events/${app.app_id}` });
  },
  /**
   * Makes sure each long connection's watchdog is running. The watchdog rearms itself; this is for
   * the case where it could not, such as an object that failed to start.
   */
  async scheduled(env) {
    for (const appId of await registry(env).feishuLongConnectionApps()) {
      await env.FEISHU_LINKS.getByName(appId).ensure(appId).catch((err) => console.log(JSON.stringify({ feishu_link_not_ensured: String(err).slice(0, 300), app: appId })));
    }
  },
  // A bot's messages cannot be changed by anyone else, and a person's are read once: no `standing`.
  // Feishu drops a repeat of the same message within an hour.
  channel: { deliver: deliverFeishu, amend: amendFeishu, received: receivedFeishu, unreceived: unreceivedFeishu, dedupeMs: 60 * 60_000 },
  tools: [readDocument],
  holds: (env, _scope, condition, generation) => authorisationHolds(env, condition, generation),
};

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
          // Nothing of the error itself is logged: its text can quote what the person sent.
          void err;
          console.log(JSON.stringify({ feishu_press_not_filed: true, app: app.app_id }));
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
      // In a direct chat, the same conversation as that person's own messages there.
      session_key: group ? "chat" : privateSessionKey("feishu", { app_id: app.app_id, tenant_key: String(operator.tenant_key) }),
      principal: { kind: "human", id: openId, explicit: true },
      text: `${value.decision === "approve_all" ? "approve all" : value.decision} ${value.code}`,
      // Which question's card was pressed. The press answers that question and no other.
      data: { chat_id: chatId, card: true, route_by_code: true, question: value.q, origin: { app_id: app.app_id, tenant_key: String(operator.tenant_key) } },
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
  // The documents the person linked, taken from what they typed before anything is put into it:
  // a mentioned person's display name is theirs to choose, and is not the sender's word.
  let documents: DocumentRef[] = [];
  if (message.message_type === "text") {
    try {
      text = String(JSON.parse(message.content).text ?? "");
    } catch {
      return undefined;
    }
    documents = documentsIn(text);
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
      // A direct chat is that person's private conversation through this app, apart from any
      // other way their scope can be reached.
      session_key: group ? (thread ? `thread:${thread}` : "chat") : privateSessionKey("feishu", { app_id: app.app_id, tenant_key: String(sender.tenant_key) }),
      principal: { kind: "human", id: openId, explicit: true },
      text,
      data: {
        // Which app received it and which organisation the sender belongs to, both as Feishu
        // stated them in the verified event.
        origin: { app_id: app.app_id, tenant_key: String(sender.tenant_key) },
        // An ordinary message written to the agent in a direct chat.
        ...(group ? {} : { direct: true }),
        // Which documents this message links to, for a tool that reads what the person pointed at.
        ...(documents.length ? { documents } : {}),
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
  // What the person is to act on, made now and kept nowhere. One that can no longer be used is
  // not sent at all: there is nothing left to act on.
  const invitation = message.interaction ? await invitationFor(env, message.interaction) : undefined;
  if (message.interaction && !invitation) throw new DeliveryVoid("the invitation can no longer be used");
  // An approval question or an invitation goes out as a card. The agent's own words go as
  // Markdown (a post with one md element), or as text where a post would be too large; the
  // system's fixed words as text. A message whose sending began under the earlier encoding (0)
  // is sent exactly as it was then: as text, verbatim. Decided from the message alone, so every
  // attempt sends the very same thing.
  const card = message.ask ? approvalCard(message.ask, scope.kind === "chat" ? "chat" : "user") : invitation;
  const current = message.encoding !== 0;
  const envelope = (msgType: string, content: string) => (messageId ? { msg_type: msgType, content, uuid, reply_in_thread: thread === "1" } : { receive_id: chatId, msg_type: msgType, content, uuid });
  const post = !card && current && message.authored ? envelope("post", JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: quiet(message.text) }]] } })) : undefined;
  // Feishu takes a post of up to 30 KB, measured as the request is sent.
  const fits = post !== undefined && new TextEncoder().encode(JSON.stringify(post)).length <= MAX_POST_BYTES;
  const body = card ? envelope("interactive", JSON.stringify(card)) : fits ? post! : envelope("text", JSON.stringify({ text: current && message.authored ? quiet(message.text) : message.text }));

  const response = messageId
    ? await fetch(`${API}/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      })
    : await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
  const result = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { message_id?: string } };
  const said = `Feishu returned ${response.status} code ${result.code}: ${String(result.msg).slice(0, 200)}`;
  // Feishu answered and said no: nothing was posted. A failure on its side leaves that open.
  if (response.status < 500 && typeof result.code === "number" && result.code !== 0) throw new DeliveryRejected(said);
  if (!response.ok || result.code !== 0) throw new Error(said);
  // Which message this is, so a reply to it can be told from a reply to anything else, and so a
  // question's card can be closed later. Accepted without saying which message it became is not
  // something to count as delivered.
  if (!result.data?.message_id) throw new Error("Feishu accepted the message without naming it");
  return { subject: `feishu:message:${result.data.message_id}`, holder: "" };
}

/** Feishu's limit for a post, in bytes of the request, with a margin. */
const MAX_POST_BYTES = 29_000;

/**
 * The agent's words as Feishu shows them, minus their one way of acting: Feishu's mention markup
 * (`<at user_id="…">`, `<at id=…>`, `</at>`) notifies whoever it names, everyone even. Every such
 * piece of markup the model wrote or quoted is shown as the text it is (a zero-width space after
 * the `<`), in code too: working out for certain where Markdown code begins and ends is not worth
 * any chance of a mention in prose notifying someone. Nothing else is touched: other tags keep
 * their names and case.
 */
function quiet(text: string): string {
  return text.replace(/<(\/?)(at)(?=[\s>])/gi, "<\u200b$1$2");
}

/** "Got it", as a reaction on the person's own message. Nothing is added to the chat. */
export async function receivedFeishu(env: Env, _scope: Scope, event: { data?: Record<string, unknown>; reply_to?: Target; wanted(): boolean }): Promise<string | undefined> {
  const messageId = typeof event.data?.message_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(event.data.message_id) ? event.data.message_id : undefined;
  const appId = event.reply_to?.address.app_id;
  // Only a message a person wrote: a button press has no message of theirs to mark.
  if (!messageId || !appId || event.data?.card !== undefined) return undefined;
  const token = await tenantAccessToken(env, appId);
  // Too late to mean "it has arrived": nothing is posted.
  if (!event.wanted()) return undefined;
  const response = await fetch(`${API}/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ reaction_type: { emoji_type: "Get" } }),
  });
  const result = (await response.json().catch(() => ({}))) as { code?: number; data?: { reaction_id?: unknown } };
  // Which reaction it is, to take it off again: without that it cannot be.
  const id = result.data?.reaction_id;
  return response.ok && result.code === 0 && typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : undefined;
}

/** Takes the "got it" reaction off the person's message again, once it has been dealt with. Only the app that put it on can. */
export async function unreceivedFeishu(env: Env, _scope: Scope, event: { data?: Record<string, unknown>; reply_to?: Target }, mark: string): Promise<"removed" | "retry" | "permanent"> {
  const messageId = typeof event.data?.message_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(event.data.message_id) ? event.data.message_id : undefined;
  const appId = event.reply_to?.address.app_id;
  if (!messageId || !appId || !/^[A-Za-z0-9_-]{1,200}$/.test(mark)) return "permanent";
  const token = await tenantAccessToken(env, appId);
  const response = await fetch(`${API}/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(mark)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  const result = (await response.json().catch(() => ({}))) as { code?: number };
  // Off; or the message itself is gone (230110), and the reaction with it.
  if ((response.ok && result.code === 0) || result.code === 230110) return "removed";
  // Busy, limited, an earlier attempt still in progress (231015), the app's token just lapsed, or no answer: it may be taken off later. Anything else Feishu refused.
  const later = response.status === 429 || response.status >= 500 || result.code === undefined || [231015, 99991400, 99991663].includes(result.code);
  return later ? "retry" : "permanent";
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
    const ended = { approved: ["green", "已批准"], refused: ["red", "已拒绝"], withdrawn: ["grey", "已失效"], unknown: ["grey", "结果无法核实"] }[outcome.state];
    const note = outcome.state === "withdrawn" ? "这个请求已经不再等待答复。" : outcome.state === "unknown" ? "已经有人作答，但无法确认这个答复是否生效。这个请求不再等待答复。" : outcome.state === "approved" && outcome.standing ? "已批准。这个任务之后推送同样的分支不会再问，包括改写该分支历史的推送。" : `${ended[1]}。`;
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
