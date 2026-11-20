/**
 * Reading a Feishu document as the person who asked, with their own access.
 *
 * The bot can only read what has been shared with the bot. A person's documents are theirs, so the
 * agent reads them as that person: they authorise it once in Feishu's own consent page (OAuth with
 * PKCE), and from then on the tool uses the token Feishu issued for them. What they cannot open,
 * the agent cannot open for them; what the bot could open plays no part.
 *
 * Whose token is used is never the model's choice. It is the person the Brain says the run acts
 * for (see ConnectorTool), as their verified messages identified them. Which document is read is
 * not the model's choice either: it must be one the person named in the request itself.
 *
 * The invitation to authorise is sent by the bot straight to that person's direct chat, not handed
 * to the model to pass on. What comes back from Feishu is accepted only if the account that
 * consented is the very person who was invited.
 */
import type { Env } from "../env";
import { registry } from "../registry";
import { API, sendToPerson } from "./feishu-api";
import { SCOPES, type Who, grantName, grantOf, grantsKey } from "./feishu-grant";
import type { ConnectorTool, ToolContext } from "./types";

const TOKEN = "https://accounts.feishu.cn/oauth/v3/token";
/** How much of a document one read returns. */
export const MAX_DOCUMENT_TEXT = 40_000;
/** Feishu's codes for "this user token is no good": invalid, expired, or lacking what the person must grant. */
const REAUTHORISE = new Set([99991668, 99991677, 99991679]);
/** Feishu's code for asking, at the exchange, for something the person did not grant. */
const NOT_GRANTED = 20068;

export const readDocument: ConnectorTool = {
  name: "feishu_read_document",
  description:
    "Read a Feishu document as the person you are talking to, with their own access. `document` is the document's link exactly as the person wrote it in this request (https://….feishu.cn/docx/… or …/wiki/…, as plain text in their message). Only a document the person linked in this request can be read. If the result says authorisation is needed, an invitation to authorise is in this chat, sent to the person directly: tell them to use it and then ask again.",
  effect: "read",
  parameters: { document: { type: "string" } },
  run: read,
};

/** A document a link names. */
export type DocumentRef = { kind: "docx" | "wiki"; token: string };

/**
 * The documents linked in a text: https links on Feishu's document hosts, to a docx or a wiki
 * page. Only the path is ever used; nothing is fetched from the link's host.
 */
export function documentsIn(text: string): DocumentRef[] {
  const found: DocumentRef[] = [];
  for (const each of text.matchAll(/https:\/\/(?:[A-Za-z0-9-]+\.)+(?:feishu\.cn|larkoffice\.com)\/(docx|wiki)\/([A-Za-z0-9]{10,64})(?![A-Za-z0-9_-])/g)) {
    if (!found.some((seen) => seen.kind === each[1] && seen.token === each[2])) found.push({ kind: each[1] as "docx" | "wiki", token: each[2] });
  }
  return found;
}

async function read(context: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const { env, origin } = context;
  const asked = documentsIn(String(args.document ?? "").trim());
  if (asked.length !== 1) return { error: "that is not one link to a Feishu document (https://….feishu.cn/docx/… or …/wiki/…)" };
  const target = asked[0];
  // The document is the person's choice: a link they themselves put in this request, as the
  // connector found it in what they wrote. Text the agent has read cannot send it elsewhere, and
  // neither can a word in their message that merely looks like a document's id.
  const linked = context.said.flatMap((message) => (Array.isArray(message.data.documents) ? (message.data.documents as DocumentRef[]) : []));
  if (!linked.some((each) => each?.kind === target.kind && each?.token === target.token)) return { error: "only a document the person linked in this request can be read" };

  const redirect = redirectUri(env);
  if (!redirect || !grantsKey(env)) return { error: "reading documents is not set up on this deployment" };
  const who: Who = { app_id: origin.app_id ?? "", tenant_key: origin.tenant_key ?? "", open_id: context.person };
  const app = await registry(env).feishuApp(who.app_id);
  if (!app || app.tenant !== context.scope.tenant || !who.tenant_key) return { error: "this conversation does not come through a Feishu app of this tenant" };

  const grant = await grantOf(env, who);
  // The invitation is the grant's own to send, to this person and nobody else. Its link is never
  // part of what the model is given.
  const invite = async () => {
    const how = await grant.invite(who, redirect);
    const where = how === "queued" ? "An invitation to authorise could not be delivered to them just now; it is being retried for a few minutes. If none arrives, they can ask again." : "An invitation to authorise is in this chat, sent to them directly. Tell them to use it and then ask again.";
    return { authorisation_needed: true, note: `The person has not authorised reading their documents, or the authorisation has ended. ${where} Nothing was read.` };
  };
  const credential = await grant.credential();
  if (!credential) return invite();
  // The authorisation was taken away, or replaced, while this read was under way: what the old
  // token fetched is not handed on, and this read does not ask for a new one.
  const superseded = { error: "the person's authorisation changed while this was being read; nothing was read. They can ask again" };

  const asPerson = async (path: string) => {
    const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${credential.token}` } });
    const body = (await response.json().catch(() => ({}))) as { code?: number; data?: any };
    return { status: response.status, code: body.code, data: body.data };
  };
  const failed = async (result: { status: number; code?: number }) => {
    // The token is no longer good: forget that token, and only that one, and ask again. A document
    // the person may not open says nothing about the authorisation, which is kept.
    if (result.status === 401 || REAUTHORISE.has(result.code ?? 0)) return (await grant.dropIf(credential.version)) ? invite() : superseded;
    if (!(await grant.stands(credential.version))) return superseded;
    if (result.status === 403 || result.status === 404) return { error: "the person cannot open this document, or it does not exist" };
    return { error: `Feishu could not provide the document (status ${result.status}, code ${result.code ?? "none"})` };
  };

  let documentId = target.token;
  if (target.kind === "wiki") {
    // What the person allowed may cover documents and not wiki pages. That is no fault of the grant.
    if (!credential.scope.includes("wiki:node:read")) return { error: "the person's authorisation covers documents but not wiki pages; ask them for the document's own link (…/docx/…)" };
    const node = await asPerson(`/wiki/v2/spaces/get_node?token=${encodeURIComponent(target.token)}`);
    if (node.status !== 200 || node.code !== 0) return failed(node);
    if (!(await grant.stands(credential.version))) return superseded;
    const found = node.data?.node;
    if (found?.obj_type !== "docx" || typeof found.obj_token !== "string" || !/^[A-Za-z0-9]{10,64}$/.test(found.obj_token)) return { error: "that wiki page is not a document; only documents can be read" };
    documentId = found.obj_token;
  }
  const raw = await asPerson(`/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`);
  if (raw.status !== 200 || raw.code !== 0) return failed(raw);
  // Asked last of all, just before the text is handed on.
  if (!(await grant.stands(credential.version))) return superseded;
  const text = String(raw.data?.content ?? "");
  return { text: text.slice(0, MAX_DOCUMENT_TEXT), ...(text.length > MAX_DOCUMENT_TEXT ? { truncated: true, note: `only the first ${MAX_DOCUMENT_TEXT} characters are shown` } : {}) };
}

/** Where Feishu sends the person back to. It must be registered, exactly, in the app's security settings. */
export function redirectUri(env: Env): string | undefined {
  const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/, "");
  return origin && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin) ? `${origin}/v1/feishu/oauth/callback` : undefined;
}

/**
 * Where Feishu sends the person's browser after the consent page. Nothing here trusts the browser:
 * the `state` names an invitation that was sent to one person and can be used once, the code is
 * exchanged with the verifier only we hold, and the token is kept only if Feishu says it belongs
 * to that same person.
 */
export async function handleOauthCallback(request: Request, env: Env, defer: (work: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const state = /^([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(url.searchParams.get("state") ?? "");
  if (!state || !grantsKey(env)) return page("这个链接无法使用", "请回到飞书，重新向我发起请求。", 400);
  const grant = env.FEISHU_GRANTS.getByName(state[1]);
  const invitation = await grant.redeem(state[2]);
  if (!invitation || (await grantName(invitation.who)) !== state[1]) return page("这个链接已经失效", "链接只能使用一次，并且 10 分钟内有效。请回到飞书，重新向我发起请求。", 400);
  const { who } = invitation;
  const code = url.searchParams.get("code") ?? "";
  if (url.searchParams.has("error") || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) return page("没有授权", "你没有完成授权，我不会读取你的文档。需要时可以回到飞书重新发起请求。");

  const refused = (why: string) => {
    // Which step failed, for the operator. Nothing Feishu or the browser sent is logged.
    console.log(JSON.stringify({ feishu_authorisation_refused: why, app: who.app_id }));
    return page("授权没有成功", "请回到飞书，重新向我发起请求。如果一直不成功，请联系管理员。", 400);
  };
  const app = await registry(env).feishuApp(who.app_id);
  if (!app) return refused("unknown_app");
  // Only what reading documents needs is asked for, whatever else this person has allowed the app
  // before: Feishu's consent is cumulative, and a token for all of it is not ours to hold. If the
  // person did not allow wiki pages, documents alone will do.
  const exchangeFor = async (scope: string[]) => {
    const response = await fetch(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: app.app_id, client_secret: app.app_secret, code, redirect_uri: invitation.redirect, code_verifier: invitation.verifier, scope: scope.join(" ") }),
    });
    return { ok: response.ok, ...((await response.json().catch(() => ({}))) as { code?: number; access_token?: string; expires_in?: number; scope?: string }) };
  };
  let issued = await exchangeFor(SCOPES);
  if (issued.code === NOT_GRANTED) issued = await exchangeFor(["docx:document:readonly"]);
  if (!issued.ok || issued.code !== 0 || typeof issued.access_token !== "string" || !issued.access_token) return refused("exchange_failed");
  const granted = String(issued.scope ?? "").split(/\s+/).filter(Boolean);
  if (!granted.includes("docx:document:readonly")) return refused("scope_missing");
  // The token must be for reading documents and nothing more. One that reaches further is not kept.
  if (granted.some((each) => !SCOPES.includes(each))) return refused("scope_too_wide");

  // Whose token is it? The answer must be the person the invitation was sent to, in the same
  // organisation. Anyone else who opened the link and consented gets nothing installed.
  const asked = await fetch(`${API}/authen/v1/user_info`, { headers: { authorization: `Bearer ${issued.access_token}` } });
  const info = (await asked.json().catch(() => ({}))) as { code?: number; data?: { open_id?: string; tenant_key?: string } };
  if (!asked.ok || info.code !== 0) return refused("identity_unknown");
  if (info.data?.open_id !== who.open_id || info.data?.tenant_key !== who.tenant_key) {
    console.log(JSON.stringify({ feishu_authorisation_refused: "another_account", app: who.app_id }));
    return page("授权的账号不对", "完成授权的飞书账号，不是发起请求的那个账号，所以没有生效。请用发起请求的账号重新操作。", 403);
  }

  const kept = await grant.install(invitation.generation, { access_token: issued.access_token, expires_at: Date.now() + Math.max(0, Number(issued.expires_in) || 0) * 1_000, scope: granted.join(" ") });
  if (!kept) return refused("superseded");
  defer(sendToPerson(env, who.app_id, who.open_id, `granted:${state[2]}`, { text: "授权成功。请把刚才的请求再发一次，我就可以读取文档了。" }).catch(() => undefined));
  return page("授权成功", "现在可以回到飞书，把刚才的请求再发一次。");
}

/** A page with fixed words only: nothing from the request is ever written into it. */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.5rem;color:#1f2329}h1{font-size:1.4rem}p{line-height:1.7;color:#51565d}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" },
  });
}
