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
import { API, TOKEN_V2, TOKEN_V3 } from "./feishu-api";
import { OFFLINE, SCOPES, type Who, grantName, grantsKey, lifetime, sameSet } from "./feishu-grant";
import { type ConnectorTool, type Holds, type ToolContext, type Waiting, isWaiting } from "./types";

/** How much of a document one read returns. */
export const MAX_DOCUMENT_TEXT = 40_000;
/** Feishu's codes for "this user token is no good": invalid, expired, or lacking what the person must grant. */
const REAUTHORISE = new Set([99991668, 99991677, 99991679]);
/** Feishu's code for "the person has not granted the permission this call needs". */
const NOT_COVERED = 99991679;

export const readDocument: ConnectorTool = {
  name: "feishu_read_document",
  description:
    "Read a Feishu document as the person you are talking to, with their own access. `document` is the document's link exactly as the person wrote it (https://….feishu.cn/docx/… or …/wiki/…, as plain text in their message). Only a document the person linked in this request can be read. If this request has no link, it can be about the one document they linked just before (within about ten minutes), once; if they linked several, or you are not sure which they mean, ask them to send the link together with what they want.",
  effect: "read",
  parameters: { document: { type: "string" } },
  run: reported,
};

/**
 * Runs a read and records how it ended, for the operator: one word from a fixed list ("invited"
 * covers both a card that was sent and one still being retried). What a run read is not kept anywhere, so without this there
 * is no telling afterwards why a read did not happen. Nothing of the request, the document or
 * Feishu's answer is logged.
 */
async function reported(context: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  try {
    const result = (await read(context, args)) as { text?: string; error?: string };
    const how = result.text !== undefined ? "read" : isWaiting(result) ? "invited" : (REASONS.find(([, words]) => result.error?.startsWith(words))?.[0] ?? "other");
    console.log(JSON.stringify({ feishu_read_document: how, app: context.origin.app_id ?? "" }));
    return result;
  } catch (err) {
    // Only that it threw. An error's name and message are whatever their source chose to put there.
    console.log(JSON.stringify({ feishu_read_document: "threw", app: context.origin.app_id ?? "" }));
    throw err;
  }
}

/** The ways a read is turned down, by how the answer to the model begins. */
const REASONS: [string, string][] = [
  ["not_a_link", "that is not a link"],
  ["not_linked_by_person", "only a document the person linked"],
  ["no_link", "the person has not linked a document"],
  ["several_links", "the person linked several documents"],
  ["already_read", "the document the person linked earlier has already been read"],
  ["no_public_origin", "reading documents is not set up on this deployment (address)"],
  ["no_grants_key", "reading documents is not set up on this deployment (key)"],
  ["not_this_tenants_app", "this conversation does not come through"],
  ["superseded", "the person's authorisation changed"],
  ["wiki_not_covered", "the person's authorisation does not cover"],
  ["cannot_open", "the person cannot open"],
  ["not_a_document", "that wiki page is not a document"],
  ["feishu_failed", "Feishu could not provide"],
];

/** A document a link names. */
export type DocumentRef = { kind: "docx" | "wiki"; token: string };

/**
 * The document one whole link names, if it is a link to one: https, on one of Feishu's document
 * hosts, with a path that is a docx or a wiki page and nothing more. The link is parsed as a URL
 * and judged by its own scheme, host and path; a query or fragment on it does not matter, and
 * nothing inside them is looked at. Nothing is ever fetched from the link's host.
 */
export function documentOf(link: string): DocumentRef | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  if (!/^(?:[a-z0-9-]+\.)+(?:feishu\.cn|larkoffice\.com)$/.test(url.hostname)) return undefined;
  const found = /^\/(docx|wiki)\/([A-Za-z0-9]{10,64})\/?$/.exec(url.pathname);
  return found ? { kind: found[1] as "docx" | "wiki", token: found[2] } : undefined;
}

/**
 * The documents a person linked in what they wrote.
 *
 * A link is taken whole, from where it starts to the next whitespace, and judged as one link (see
 * documentOf). A Feishu address that is only part of some other link, in its path or its query,
 * is therefore never looked at on its own: nothing after a link has begun can start another.
 * A link must begin at the start of a word, or right after words in another script or an opening
 * bracket or quote.
 *
 * People write links into sentences without spaces ("看看https://…/docx/X，谢谢"). If the whole run
 * is not a document link, the part before the first character outside ASCII is tried instead,
 * and only when that character is sentence punctuation or a closing quote or bracket and nothing
 * after it looks like more of a link. Words written straight onto the end of a link could be part
 * of its path, so such a link is not counted.
 * A link this cannot settle is not counted, and the person can paste it on a line of its own.
 */
export function documentsIn(text: string): DocumentRef[] {
  const found: DocumentRef[] = [];
  for (const word of text.split(/\s+/)) {
    const start = /[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(word);
    if (!start) continue;
    const before = word[start.index - 1];
    if (before !== undefined && /[!-~]/.test(before) && !"([{<\"'".includes(before)) continue;
    const whole = word.slice(start.index);
    // Punctuation of the sentence around a link is not part of it.
    const trimmed = (link: string) => link.replace(/[.,;:!?)\]}>"'，。；：！？、）】》」』”’]+$/u, "");
    const cut = whole.search(/[^\x00-\x7f]/);
    const rest = cut > 0 ? whole.slice(cut) : "";
    const sentenceGoesOn = /^[，。；：！？、）】》」』”’]/u.test(rest) && !/[/?#@%&=:\\]/.test(rest);
    const each = documentOf(trimmed(whole)) ?? (sentenceGoesOn ? documentOf(trimmed(whole.slice(0, cut))) : undefined);
    if (each && !found.some((seen) => seen.kind === each.kind && seen.token === each.token)) found.push(each);
  }
  return found;
}

async function read(context: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const { env, origin } = context;
  const target = documentOf(String(args.document ?? "").trim());
  if (!target) return { error: "that is not a link to a Feishu document (https://….feishu.cn/docx/… or …/wiki/…)" };
  // The document is the person's choice, and what they chose now. If this request links
  // documents, those are the choice, whatever they linked before. If it links none, it can only
  // be about the one document they linked last ("summarise it" after a link): there must be
  // exactly one, and it must not have been read on that footing already. Text the agent has read
  // cannot widen any of this, and neither can a word that merely looks like a document's id.
  const documents = (message: { data: Record<string, unknown> }) => (Array.isArray(message.data.documents) ? (message.data.documents as DocumentRef[]).filter(Boolean) : []);
  const now = context.said.flatMap(documents);
  let chosen = now;
  let carriedFrom: string | undefined;
  if (now.length === 0) {
    const last = [...context.recent].reverse().find((message) => documents(message).length > 0);
    const id = typeof last?.data.message_id === "string" ? last.data.message_id : "";
    if (!last || !id) return { error: "the person has not linked a document in this request or just before it; ask them to send the link" };
    if (documents(last).length > 1) return { error: "the person linked several documents and this request does not say which; ask them to send the one they mean together with what they want" };
    chosen = documents(last);
    carriedFrom = id;
    // This earlier message, and no other, is part of what the request rests on.
    context.relied?.(context.recent.indexOf(last));
  }
  if (!chosen.some((each) => each.kind === target.kind && each.token === target.token)) return { error: "only a document the person linked in this request can be read (or, if this request links none, the one they linked just before)" };

  const redirect = redirectUri(env);
  // Which of the two settings is missing or malformed is said apart, so the operator can tell.
  if (!redirect) return { error: "reading documents is not set up on this deployment (address)" };
  if (!grantsKey(env)) return { error: "reading documents is not set up on this deployment (key)" };
  const who: Who = { app_id: origin.app_id ?? "", tenant_key: origin.tenant_key ?? "", open_id: context.person };
  const app = await registry(env).feishuApp(who.app_id);
  if (!app || app.tenant !== context.scope.tenant || !who.tenant_key) return { error: "this conversation does not come through a Feishu app of this tenant" };

  // Everything that does not depend on the grant is done before the grant is looked at, so that
  // nothing is waited for between looking and using what was found.
  const name = await grantName(who);
  // The link as far as it identifies the document: this, not what the model wrote, is what a
  // request that has to wait is carried on with.
  const canonical = `${new URL(String(args.document).trim()).origin}/${target.kind}/${target.token}`;
  const grant = env.FEISHU_GRANTS.getByName(name);
  const { generation, credential, unreadable, answered } = await grant.held();
  // The authorisation was taken away, or replaced, while this read was under way: what the old
  // token fetched is not handed on, and this read does not ask for a new one.
  const superseded = { error: "the person's authorisation changed while this was being read; nothing was read. They can ask again" };
  // A request that waited is carried on under the authorisation it waited for, and in its time.
  // Past either, it is over: nothing is read, and it is not started again under a newer one.
  const lapsed = () => context.resuming !== undefined && Date.now() > context.resuming.notAfter;
  if (context.resuming && (generation !== context.resuming.generation || lapsed())) return superseded;
  const alreadyRead = { error: "the document the person linked earlier has already been read for them once; for more, ask them to send the link again with what they want" };
  // By another call, that is. This same call may be running again after an interruption.
  if (carriedFrom !== undefined && answered?.message === carriedFrom && answered.by !== context.callId) return alreadyRead;
  // What this request needs the person to have allowed: documents, and wiki pages only for one.
  // Where the operator has turned it on for this app, also leave to renew the token without them.
  const needed = [...(target.kind === "wiki" ? ["docx:document:readonly", "wiki:node:read"] : ["docx:document:readonly"]), ...(app.oauth_offline ? [OFFLINE] : [])];
  // Not yet, then: the request waits for the person to authorise, and the Brain carries it on
  // when they have. What it waits for is named here; the invitation is the Brain's to send, and
  // its link is made only as it is sent.
  const invite = async (refused?: { version: string; rotation: number }) => {
    const invitation = await grant.invite(who, redirect, needed, { generation, ...(refused ? { refused } : {}) });
    if (invitation === "superseded") return superseded;
    return { waiting: { on: "authorisation", subject: name, condition: conditionOf(name, needed), generation: invitation.generation, until: invitation.expires_at, interaction: `${name}.${invitation.nonce}`, request: { document: canonical } } } satisfies Waiting;
  };
  // Not authorised at all, or for documents and not for wiki pages: ask for what this needs.
  // A token that is held but can no longer be read (the key changed, say) is reported as refused,
  // which forgets exactly that one.
  if (!credential || needed.some((each) => !credential.scope.includes(each))) return invite(unreadable);

  const asPerson = async (path: string) => {
    // The last look before Feishu is asked: the token is still the person's grant, and a request
    // that waited is still in its time. Nothing else happens between this and the request.
    if (!(await grant.stands(credential.version)) || lapsed()) return { status: 0, code: undefined, data: undefined, gone: true };
    const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${credential.token}` } });
    const body = (await response.json().catch(() => ({}))) as { code?: number; data?: any };
    return { status: response.status, code: body.code, data: body.data, gone: false };
  };
  const failed = async (result: { status: number; code?: number }, step: "wiki" | "docx") => {
    // Feishu says the token does not cover looking up wiki pages. That is about this one
    // operation: the token still reads documents, and is kept.
    if (step === "wiki" && result.code === NOT_COVERED) return (await grant.stands(credential.version)) ? { error: "the person's authorisation does not cover this wiki page; ask them for the document's own link (…/docx/…)" } : superseded;
    // The token is no longer good: forget that token, and only that one, and ask again. A document
    // the person may not open says nothing about the authorisation, which is kept.
    if (result.status === 401 || REAUTHORISE.has(result.code ?? 0)) return invite({ version: credential.version, rotation: credential.rotation });
    if (!(await grant.stands(credential.version))) return superseded;
    if (result.status === 403 || result.status === 404) return { error: "the person cannot open this document, or it does not exist" };
    return { error: `Feishu could not provide the document (status ${result.status}, code ${result.code ?? "none"})` };
  };

  let documentId = target.token;
  if (target.kind === "wiki") {
    const node = await asPerson(`/wiki/v2/spaces/get_node?token=${encodeURIComponent(target.token)}`);
    if (node.gone) return superseded;
    if (node.status !== 200 || node.code !== 0) return failed(node, "wiki");
    if (!(await grant.stands(credential.version))) return superseded;
    const found = node.data?.node;
    if (found?.obj_type !== "docx" || typeof found.obj_token !== "string" || !/^[A-Za-z0-9]{10,64}$/.test(found.obj_token)) return { error: "that wiki page is not a document; only documents can be read" };
    documentId = found.obj_token;
  }
  const raw = await asPerson(`/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`);
  if (raw.gone) return superseded;
  if (raw.status !== 200 || raw.code !== 0) return failed(raw, "docx");
  // Asked last of all, just before the text is handed on. A link taken from an earlier message
  // is used up here.
  const end = await grant.finish(credential.version, carriedFrom === undefined ? undefined : { message: carriedFrom, by: context.callId });
  if (end !== "ok") return end === "taken" ? alreadyRead : superseded;
  // What was read, as Feishu resolved it: a wiki page can come to hold another document.
  context.identified?.({ document: canonical }, `docx:${documentId}`);
  const text = String(raw.data?.content ?? "");
  return { text: text.slice(0, MAX_DOCUMENT_TEXT), ...(text.length > MAX_DOCUMENT_TEXT ? { truncated: true, note: `only the first ${MAX_DOCUMENT_TEXT} characters are shown` } : {}) };
}

/** What a read waits on: this person's grant covering these scopes. */
function conditionOf(grant: string, scope: string[]): string {
  return `${grant}:${[...scope].sort().join(" ")}`;
}

/** Whether what a read was waiting on holds now, asked of the grant itself. */
export async function authorisationHolds(env: Env, condition: string, generation: number): Promise<Holds> {
  const found = /^([0-9a-f]{64}):([a-z_:. ]{1,200})$/.exec(condition);
  const scope = found?.[2].split(" ") ?? [];
  if (!found || scope.some((each) => !SCOPES.includes(each))) return { state: "gone" };
  return env.FEISHU_GRANTS.getByName(found[1]).covers(scope, generation);
}

/** The card for an invitation named by a Waiting's `interaction`, or nothing if it can no longer be used. */
export async function invitationFor(env: Env, interaction: string): Promise<unknown | null> {
  const found = /^([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(interaction);
  return found ? env.FEISHU_GRANTS.getByName(found[1]).card(found[2]) : null;
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
export async function handleOauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = /^([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(url.searchParams.get("state") ?? "");
  if (!state || !grantsKey(env)) return page("这个链接无法使用", "请回到飞书，重新向我发起请求。", 400);
  const grant = env.FEISHU_GRANTS.getByName(state[1]);
  const invitation = await grant.redeem(state[2]);
  if (!invitation || (await grantName(invitation.who)) !== state[1]) return page("这个链接已经失效", "链接只能使用一次，并且 10 分钟内有效。请回到飞书，重新向我发起请求。", 400);
  const { who } = invitation;
  const code = url.searchParams.get("code") ?? "";
  if (url.searchParams.has("error") || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) return page("没有授权", "你没有完成授权，我不会读取你的文档。需要时可以回到飞书重新发起请求。");

  const refused = (why: string, answer?: { status: number; code?: unknown; endpoint?: "v2" | "v3" }) => {
    // Which step failed, for the operator, and for a call Feishu turned down, its HTTP status and
    // Feishu's own numeric error code: both from fixed lists. Nothing else Feishu or the browser
    // sent is logged.
    const code = answer && typeof answer.code === "number" && Number.isInteger(answer.code) ? answer.code : undefined;
    console.log(JSON.stringify({ feishu_authorisation_refused: why, app: who.app_id, ...(answer ? { status: answer.status, ...(code !== undefined ? { code } : {}), ...(answer.endpoint ? { endpoint: answer.endpoint } : {}) } : {}) }));
    return page("授权没有成功", "请回到飞书，重新向我发起请求。如果一直不成功，请联系管理员。", 400);
  };
  const app = await registry(env).feishuApp(who.app_id);
  if (!app) return refused("unknown_app");
  // Lasting authorisations were turned off for this app after the invitation went out: it is
  // turned away before anything is asked of Feishu.
  if (invitation.scope.includes(OFFLINE) && !app.oauth_offline) return refused("offline_turned_off");
  // Only what the invitation asked the person for is asked of Feishu, whatever else they have
  // allowed the app before: Feishu's consent is cumulative, and a token for all of it is not ours
  // to hold. The code is used once.
  // One endpoint per code, chosen by the app's setting; never one after the other.
  const exchange = await fetch(app.oauth_v2 ? TOKEN_V2 : TOKEN_V3, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: app.app_id, client_secret: app.app_secret, code, redirect_uri: invitation.redirect, code_verifier: invitation.verifier, scope: invitation.scope.join(" ") }),
  });
  const answer = ((await exchange.json().catch(() => null)) as unknown) ?? {};
  const issued = (typeof answer === "object" ? answer : {}) as { code?: number; access_token?: string; expires_in?: number; scope?: string; refresh_token?: string; refresh_token_expires_in?: number };
  // A token that is there and has time left, or nothing.
  if (!exchange.ok || issued.code !== 0 || typeof issued.access_token !== "string" || !issued.access_token || !lifetime(issued.expires_in)) return refused("exchange_failed", { status: exchange.status, code: issued.code, endpoint: app.oauth_v2 ? "v2" : "v3" });
  const granted = String(issued.scope ?? "").split(/\s+/).filter(Boolean);
  if (invitation.scope.some((each) => !granted.includes(each))) return refused("scope_missing");
  // The token must be for what was asked and nothing more. One that reaches further is not kept.
  if (!sameSet(granted, invitation.scope)) return refused("scope_too_wide");


  // Whose token is it? The answer must be the person the invitation was sent to, in the same
  // organisation. Anyone else who opened the link and consented gets nothing installed.
  const asked = await fetch(`${API}/authen/v1/user_info`, { headers: { authorization: `Bearer ${issued.access_token}` } });
  const info = (await asked.json().catch(() => ({}))) as { code?: number; data?: { open_id?: string; tenant_key?: string } };
  if (!asked.ok || info.code !== 0) return refused("identity_unknown", { status: asked.status, code: info.code });
  if (info.data?.open_id !== who.open_id || info.data?.tenant_key !== who.tenant_key) {
    console.log(JSON.stringify({ feishu_authorisation_refused: "another_account", app: who.app_id }));
    return page("授权的账号不对", "完成授权的飞书账号，不是发起请求的那个账号，所以没有生效。请用发起请求的账号重新操作。", 403);
  }

  // With the person's leave to act while they are away comes a second token, for getting a new
  // first one when it runs out. It is asked for only where the invitation asked for that leave.
  const lasting = invitation.scope.includes(OFFLINE) && typeof issued.refresh_token === "string" && issued.refresh_token !== "" && lifetime(issued.refresh_token_expires_in) > 0;
  if (invitation.scope.includes(OFFLINE) && !lasting) return refused("no_refresh_token");
  // And if it was turned off while Feishu was answering, what came back is not kept.
  if (invitation.scope.includes(OFFLINE) && !(await registry(env).feishuApp(who.app_id))?.oauth_offline) return refused("offline_turned_off");
  const kept = await grant.install(invitation.generation, {
    access_token: issued.access_token,
    expires_at: Date.now() + lifetime(issued.expires_in) * 1_000,
    scope: granted.join(" "),
    ...(lasting ? { refresh: { token: issued.refresh_token as string, expires_at: Date.now() + lifetime(issued.refresh_token_expires_in) * 1_000, endpoint: app.oauth_v2 ? ("v2" as const) : ("v3" as const) } } : {}),
  });
  if (!kept) return refused("superseded");
  // The grant tells the person's Brain, and keeps telling it until it is heard.
  // Said so that it is true for every invitation: one whose request is waiting is carried on; one
  // from before requests were kept (or whose request has since ended) is not, and the person can tell.
  return page("授权成功", "现在可以回到飞书。如果你刚才的请求还在等待，我会接着处理，不用再发一遍；如果几分钟内没有收到结果，请把请求再发一次。");
}

/** A page with fixed words only: nothing from the request is ever written into it. */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.5rem;color:#1f2329}h1{font-size:1.4rem}p{line-height:1.7;color:#51565d}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" },
  });
}
