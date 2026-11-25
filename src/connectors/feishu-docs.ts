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
import { type FeishuApp, registry } from "../registry";
import { type Scope, chainLevels, scopeName } from "../events";
import { API, type ChatFacts, TOKEN_V2, TOKEN_V3, chatFactsFor } from "./feishu-api";
import { OFFLINE, SCOPES, type Who, grantName, grantsKey, lifetime, sameSet } from "./feishu-grant";
import { type ConnectorTool, type Holds, type ToolContext, type Waiting, isWaiting } from "./types";

/** How much of a document one read returns. */
export const MAX_DOCUMENT_TEXT = 40_000;
/** Below this much text, what else a document holds is looked up and reported. */
const SPARSE_TEXT = 500;
/** Kinds of block whose content is not in a document's text (Feishu's block_type numbers). */
const NOT_TEXT: Record<number, string> = { 18: "table (bitable)", 21: "diagram", 23: "file", 26: "embedded page", 27: "image", 29: "mind map", 30: "sheet", 40: "add-on", 43: "whiteboard" };
/** Feishu's codes for "this user token is no good": invalid, expired, or lacking what the person must grant. */
const REAUTHORISE = new Set([99991668, 99991677, 99991679]);
/** Feishu's code for "the person has not granted the permission this call needs". */
const NOT_COVERED = 99991679;

export const readDocument: ConnectorTool = {
  name: "feishu_read_document",
  description:
    "Read a Feishu document as the person you are talking to, with their own access. `document` is the document's link as the person wrote it (https://….feishu.cn/docx/… or …/wiki/…, and the same on ….larkoffice.com; as plain text in their message). Only a document the person pointed at can be read: one they linked themselves, in this request or in their own messages here over the last day; or one linked in a colleague's message that this very request was written in reply to. For a follow-up, answer from what you already said if that is enough; read again only when more is needed. If you are not sure which document they mean, ask them.",
  effect: "read",
  // Also where several people talk, for the one who asked: only in a chat that is the
  // organisation's own, with the bot in it, through an app whose operator turned this on (see `read`).
  shared: true,
  parameters: { document: { type: "string" } },
  run: reported,
  links: (message, request, kept) => {
    const target = documentOf(String(request.document ?? ""));
    // By the same measure the read itself goes by: for a new request, what counts as linked
    // lately now; for one being carried on, the messages kept for it as they were taken then.
    return target !== undefined && (kept ? documentsOf : linkedLately)(message).some((each) => each.kind === target.kind && each.token === target.token);
  },
};

/** The documents a person's message linked, as the connector recorded them when it arrived. */
function documentsOf(message: { data: Record<string, unknown> }): DocumentRef[] {
  return [...ownDocuments(message), ...quotedDocuments(message)];
}

/** How far back a message of the person's own counts as something they linked lately (as the Brain's own look-back). */
const LATELY_MS = 24 * 3_600_000;

/**
 * What a message counts as having linked lately, for a later message that does not stand in its
 * chain of replies: what it links itself, and what the person's own message it replied to links
 * if that one was written within the last day (the connector says when). A message that only
 * pointed at something old does not make the old thing recent.
 */
function linkedLately(message: { data: Record<string, unknown> }): DocumentRef[] {
  const quoted = message.data.quoted as { at?: unknown; other?: unknown } | undefined;
  const at = quoted?.at;
  // What a colleague linked, in a message the person once replied to, is what that one reply pointed at: it is not something they linked lately.
  return [...ownDocuments(message), ...(quoted?.other !== true && typeof at === "number" && Date.now() - at <= LATELY_MS ? quotedDocuments(message) : [])];
}

const whole = <T extends DocumentRef>(each: T | undefined): each is T => Boolean(each) && (each!.kind === "docx" || each!.kind === "wiki") && typeof each!.token === "string" && /^[A-Za-z0-9]{10,64}$/.test(each!.token);

/** The documents a message itself links. */
function ownDocuments(message: { data: Record<string, unknown> }): DocumentRef[] {
  return (Array.isArray(message.data.documents) ? (message.data.documents as DocumentRef[]) : []).filter(whole);
}

/**
 * The documents linked by the message this one was written in reply to (the person's own
 * earlier one, or a colleague's that the connector gave as what the reply points at),
 * where that had to be fetched (a group sends the agent only what mentions it): each with the
 * link as written there, where the connector kept it. Not this message's own: what it points at.
 */
function quotedDocuments(message: { data: Record<string, unknown> }): (DocumentRef & { link?: string })[] {
  return fetchedDocuments((message.data.quoted as { documents?: unknown } | undefined)?.documents);
}

/** Documents as the connector recorded them for a message it fetched: each whole, with its link only where that names the same document. */
function fetchedDocuments(documents: unknown): (DocumentRef & { link?: string })[] {
  return (Array.isArray(documents) ? (documents as (DocumentRef & { link?: unknown })[]) : []).filter((each) => whole(each)).map((each) => {
    const named = typeof each.link === "string" ? documentOf(each.link) : undefined;
    return { kind: each.kind, token: each.token, ...(named && named.kind === each.kind && named.token === each.token ? { link: each.link as string } : {}) };
  });
}

/**
 * The documents the chain of replies these messages stand in leads back to, of the person's own
 * linking: in the message replied to and in everything further up that the Brain followed.
 * Their own words the connector fetched (kept with the message), and their own earlier messages
 * on record here (`recent` holds only theirs). Of anyone else's, only what a colleague linked in
 * the very message replied to, which the connector kept with this one; and nothing an answer
 * of the agent's says. Good for this request alone: it is read off the request's own messages.
 */
function ledBackTo(context: ToolContext): (DocumentRef & { link?: string; message?: { text: string; data: Record<string, unknown> } })[] {
  const found: (DocumentRef & { link?: string; message?: { text: string; data: Record<string, unknown> } })[] = [];
  for (const message of context.said) {
    const levels = chainLevels(message.data);
    found.push(...quotedDocuments(message), ...levels.flatMap((level) => fetchedDocuments(level.documents)));
    const subjects = [message.data.replies_to, ...levels.map((level) => level.subject)].filter((each): each is string => typeof each === "string");
    for (const earlier of context.recent) {
      if (typeof earlier.data.message_id !== "string" || !subjects.includes(`feishu:message:${earlier.data.message_id}`)) continue;
      const written = linksIn(earlier.text);
      for (const each of ownDocuments(earlier)) found.push({ ...each, link: written.find((link) => link.kind === each.kind && link.token === each.token)?.link, message: earlier });
    }
  }
  return found.filter((each, index) => found.findIndex((other) => other.kind === each.kind && other.token === each.token) === index);
}

/**
 * Whether a chat is the organisation's own, with the bot in it, as Feishu says right now:
 * "internal" only when every part of that was said outright. "external" when Feishu said the chat
 * includes people from outside. Anything else (a call that failed, a field that was not there,
 * another organisation's chat, the bot not in it) is not known.
 */
export function chatIs(facts: ChatFacts, tenantKey: string): "internal" | "external" | "unknown" {
  if (facts.info.status === 200 && facts.info.code === 0 && facts.info.external === true) return "external";
  const internal = facts.info.status === 200 && facts.info.code === 0 && facts.info.external === false && facts.info.tenant_key === tenantKey && tenantKey !== "" && facts.member.status === 200 && facts.member.code === 0 && facts.member.is_in_chat === true;
  return internal ? "internal" : "unknown";
}

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
  ["reply_no_link", "the person wrote this as a reply to a message that does not link a document"],
  ["reply_several_links", "the message the person replied to links several documents"],
  ["answer_without_one_source", "the person replied to an answer of yours that does not rest on one document"],
  ["answer_from_another", "the person replied to an answer written from another document"],
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
  return linksIn(text).map(({ kind, token }) => ({ kind, token }));
}

/**
 * The documents a person's text links, each with the link as they wrote it, down to its path: the
 * same scheme and host, without the query or fragment. What was read is recorded by this link,
 * not by whatever host a model wrote for the same document.
 */
export function linksIn(text: string): (DocumentRef & { link: string })[] {
  const found: (DocumentRef & { link: string })[] = [];
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
    const written = documentOf(trimmed(whole)) ? trimmed(whole) : sentenceGoesOn && documentOf(trimmed(whole.slice(0, cut))) ? trimmed(whole.slice(0, cut)) : undefined;
    const each = written === undefined ? undefined : documentOf(written);
    if (each && written && !found.some((seen) => seen.kind === each.kind && seen.token === each.token)) {
      const url = new URL(written);
      found.push({ ...each, link: `${url.origin}/${each.kind}/${each.token}` });
    }
  }
  return found;
}

async function read(context: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const { env, origin } = context;
  const target = documentOf(String(args.document ?? "").trim());
  if (!target) return { error: "that is not a link to a Feishu document (https://….feishu.cn/docx/… or …/wiki/…, or the same on ….larkoffice.com)" };
  // The document is the person's choice: one they linked themselves, in this request or in their
  // own messages here over the last day (which of those is the model's to say). A reply to one of
  // their own messages names what it is about exactly; a reply to one of the agent's answers can
  // only be about what that answer was written from. Text the agent has read or written cannot
  // widen any of this, and neither can a word that merely looks like a document's id.
  const documents = documentsOf;
  const matches = (each: DocumentRef) => each.kind === target.kind && each.token === target.token;
  // What this request itself links. What the message it replies to links is not that: it is
  // what the reply points at, and is judged as such below.
  const now = context.said.flatMap(ownDocuments);
  let chosen = now;
  // The messages that named the document read: the link recorded for it is the one written there.
  let naming: { text: string; data: Record<string, unknown> }[] = context.said;
  const repliedTo = context.said.map((message) => message.data.replies_to).filter((each): each is string => typeof each === "string");
  // Messages that link this very document: written now, and earlier.
  const linkingNow = context.said.filter((message) => ownDocuments(message).some(matches));
  // The link the person wrote for this document in a message they replied to that had to be fetched.
  let quotedLink: string | undefined;
  // What counted as linked lately is judged when the request is made. One being carried on
  // rests on the very messages kept for it then (the Brain hands back exactly those), as they
  // were taken then: time that has passed while the person authorised changes nothing.
  const lately = context.resuming ? documentsOf : linkedLately;
  const linkingEarlier = context.recent.filter((message) => lately(message).some(matches));
  // What the chain of replies leads back to, of their own linking. Where it holds several
  // documents, which is meant is the model's to say from what it is shown: any of them can be read.
  const led = ledBackTo(context);
  const hit = led.find(matches);
  const fromChain = () => {
    chosen = [...now, target];
    quotedLink = hit!.link;
    naming = hit!.message ? [hit!.message] : [];
    if (hit!.message) context.relied?.("recent", context.recent.indexOf(hit!.message));
    if (context.said.length === 1) context.relied?.("said", 0);
  };
  if (now.length === 0 && repliedTo.length > 0 && !context.answering) {
    // A reply to something that is not an answer of the agent's, linking nothing itself: it is
    // about what the chain leads back to, and about nothing else they happen to have linked.
    if (led.length === 0) return { error: "the person wrote this as a reply to a message that does not link a document (or that is no longer on record), so it is not known which document they mean; ask them to send the link" };
    if (!hit) return { error: "the messages this one was written in reply to link other documents, not that one; read one of those, or ask the person which they mean" };
    fromChain();
  } else if (hit && linkingNow.length === 0) {
    // Also where it replies to an answer of the agent's: what the person linked up the chain is theirs to have read.
    fromChain();
  } else {
    // A reply to one of the agent's answers, linking nothing new for this document, and nothing
    // of theirs up its chain names it either: the one thing that answer was written from and
    // the person can still point at, if there is one.
    // (One that read nothing points at no document: the reply is then an ordinary request.)
    if (context.answering && !context.answering.nothing && linkingNow.length === 0) {
      const source = documentOf(String(context.answering.source?.document ?? ""));
      if (!source) return { error: "the person replied to an answer of yours that does not rest on one document they linked here in the last day: answer from what you said, or ask them to send the link" };
      if (!matches(source)) return { error: "the person replied to an answer written from another document; read that one, or ask them which they mean" };
    }
    if (linkingNow.length > 0) {
      // Linked in this request: that link, as written now, whatever was linked before.
      naming = linkingNow;
    } else if (linkingEarlier.length > 0) {
      // Linked earlier by them (whatever else this request links): the latest such message is
      // what the request rests on, and is kept while it waits.
      const latest = linkingEarlier.at(-1)!;
      chosen = [...now, target];
      naming = [latest];
      // Where that message only pointed at it (a reply to one the agent was never sent), the link as written there.
      quotedLink = quotedDocuments(latest).find((each) => matches(each) && each.link)?.link;
      context.relied?.("recent", context.recent.indexOf(latest));
      // And the one message that asked for it now ("总结"), where there is exactly one: a reply to
      // that is about this request too. With several, which of them asked is not known.
      if (context.said.length === 1) context.relied?.("said", 0);
    }
  }
  // Which of the messages just written name this document: a reply to one of those is about it.
  context.said.forEach((message, index) => {
    if (ownDocuments(message).some((each) => each.kind === target.kind && each.token === target.token)) context.relied?.("said", index);
  });
  // Where several people talk, the agent is sent only what mentions it: a link they posted without that never arrived.
  const shared = context.scope.kind === "chat";
  if (!chosen.some(matches)) return { error: `only a document the person linked themselves can be read: in this request, or in their own messages here over the last day; ask them to ${shared ? "reply to their message with the link and mention you, to send the link again, or (for a colleague's message that links it) to reply to that message and mention you" : "send the link"}` };

  const redirect = redirectUri(env);
  // Which of the two settings is missing or malformed is said apart, so the operator can tell.
  if (!redirect) return { error: "reading documents is not set up on this deployment (address)" };
  if (!grantsKey(env)) return { error: "reading documents is not set up on this deployment (key)" };
  const who: Who = { app_id: origin.app_id ?? "", tenant_key: origin.tenant_key ?? "", open_id: context.person };
  const app = await registry(env).feishuApp(who.app_id);
  if (!app || app.tenant !== context.scope.tenant || !who.tenant_key) return { error: "this conversation does not come through a Feishu app of this tenant" };

  // Where several people talk, what is read is said in front of all of them. So only where the
  // operator turned that on for this app, and only in a chat Feishu says, now, is the
  // organisation's own with the bot in it. Asked on every call, a request carried on included.
  // Otherwise the matter ends here in the system's own words: nothing is read, nobody is asked
  // to authorise, and the model is not left to find another way.
  let place: { turn: number; mode: string | undefined; name: string } | undefined;
  if (shared) {
    if (!app.group_documents) return { settled: { say: "chatUnknown" } };
    const named: { name?: string } = {};
    let facts: ChatFacts;
    try {
      facts = await chatFactsFor(env, app.app_id, context.scope.id, named);
    } catch {
      facts = { info: { status: 0, missing: [] }, member: { status: 0 } };
    }
    const is = chatIs(facts, who.tenant_key);
    if (is !== "internal") return { settled: { say: is === "external" ? "externalChat" : "chatUnknown" } };
    place = { turn: app.group_documents_gen ?? 0, mode: facts.info.chat_mode, name: named.name ?? "" };
  }

  // Everything that does not depend on the grant is done before the grant is looked at, so that
  // nothing is waited for between looking and using what was found.
  const name = await grantName(who);
  // The link as far as it identifies the document: this, not what the model wrote, is what a
  // request that has to wait is carried on with.
  // As the person wrote it (their host) in the message that named it; the model's host only failing that.
  // The latest of those messages that links it, if several do.
  const theirs = [...naming].reverse().flatMap((message) => linksIn(message.text)).find((each) => each.kind === target.kind && each.token === target.token);
  const canonical = theirs?.link ?? quotedLink ?? `${new URL(String(args.document).trim()).origin}/${target.kind}/${target.token}`;
  const grant = env.FEISHU_GRANTS.getByName(name);
  const { generation, credential, unreadable } = await grant.held();
  // The authorisation was taken away, or replaced, while this read was under way: what the old
  // token fetched is not handed on, and this read does not ask for a new one.
  const superseded = { error: "the person's authorisation changed while this was being read; nothing was read. They can ask again" };
  // A request that waited is carried on under the authorisation it waited for, and in its time.
  // Past either, it is over: nothing is read, and it is not started again under a newer one.
  const lapsed = () => context.resuming !== undefined && Date.now() > context.resuming.notAfter;
  if (context.resuming && (generation !== context.resuming.generation || lapsed())) return superseded;
  // What this request needs the person to have allowed: documents, and wiki pages only for one.
  // Where the operator has turned it on for this app, also leave to renew the token without them.
  const needed = [...(target.kind === "wiki" ? ["docx:document:readonly", "wiki:node:read"] : ["docx:document:readonly"]), ...(app.oauth_offline ? [OFFLINE] : [])];
  // Not yet, then: the request waits for the person to authorise, and the Brain carries it on
  // when they have. What it waits for is named here; the invitation is the Brain's to send, and
  // its link is made only as it is sent.
  // What a read here rests on, beyond the grant: asked again before anything read is passed on.
  const under = place ? `chat|${name}|${app.app_id}|${place.turn}|${who.tenant_key}|${[...needed].sort().join(" ")}` : conditionOf(name, needed);
  const invite = async (refused?: { version: string; rotation: number }) => {
    if (!place) {
      const invitation = await grant.invite(who, redirect, needed, { generation, ...(refused ? { refused } : {}) });
      if (invitation === "superseded") return superseded;
      // It waits on the person being authorised, whichever card does it; and on the card it was shown not having failed.
      return { waiting: { on: "authorisation", subject: name, condition: `invited|${name}|${invitation.nonce}|${[...needed].sort().join(" ")}`, generation: invitation.generation, until: invitation.expires_at, interaction: `${name}.${invitation.nonce}`, request: { document: canonical } } } satisfies Waiting;
    }
    // Where several people talk, the invitation is this question's alone: named by the message
    // that asked, as Feishu named it. It waits on that very invitation being answered by the
    // person, not on their being authorised some way or other, and on this still being turned on
    // as it is now. The card is for their eyes only: where they asked if Feishu can show it
    // there to one person (not in a topic chat), directly otherwise.
    // Which question: the message of this request that names the document (the latest of them, or
    // the latest of all where an earlier one named it), and the document. One card says one thing.
    const asking = (linkingNow.at(-1) ?? context.said.at(-1))?.data.message_id;
    if (typeof asking !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(asking)) return { error: "which message asked for this could not be told, so the person was not asked to authorise; ask them to send the link again" };
    const invitation = await grant.invite(who, redirect, needed, { generation, ...(refused ? { refused } : {}) }, { brain: scopeName(context.scope), key: `${asking}|${target.kind}:${target.token}`, label: canonical, place: place.name });
    if (invitation === "superseded") return superseded;
    const condition = `asked|${name}|${invitation.nonce}|${app.app_id}|${place.turn}|${[...needed].sort().join(" ")}`;
    return { waiting: { on: "authorisation", subject: name, condition, generation: invitation.generation, until: invitation.expires_at, interaction: `${name}.${invitation.nonce}`, request: { document: canonical }, privately: place.mode === "topic" ? true : "here" } } satisfies Waiting;
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
  // A document can hold things that are not text (a whiteboard, a sheet, images), and the text
  // says nothing of them. Where there is little text, what else is there is looked up, so that
  // "almost empty" is not mistaken for "could not be opened". Failing to learn it changes nothing.
  let unread: { holds: string[]; note: string } | undefined;
  if (String(raw.data?.content ?? "").length < SPARSE_TEXT) {
    // Optional: if Feishu cannot be reached for this, the text read stands as it is.
    const blocks = await asPerson(`/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?page_size=500`).catch(() => ({ status: 0, code: undefined, data: undefined, gone: false }));
    if (blocks.gone) return superseded;
    if (blocks.status === 200 && blocks.code === 0 && Array.isArray(blocks.data?.items)) {
      const counts = new Map<string, number>();
      for (const each of blocks.data.items as { block_type?: unknown }[]) {
        const kind = NOT_TEXT[Number(each.block_type)];
        if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      const more = blocks.data.has_more === true;
      if (counts.size > 0 || more) {
        unread = {
          holds: [...counts].map(([kind, count]) => `${count} ${kind}`),
          note: `The document was opened, and this is all the text in it.${counts.size > 0 ? " It also holds content that is not text, which this tool cannot read: if the text does not answer the person, say that the rest is in that form. It is not a matter of permissions." : ""}${more ? " Only the first part of the document's structure was looked at, so there may be more that is not text." : ""}`,
        };
      }
    } else {
      unread = { holds: [], note: "The document was opened, and this is all the text in it. Whether it also holds content that is not text (a whiteboard, a sheet, images) could not be found out." };
    }
  }
  // Asked last of all, just before the text is handed on: the authorisation is still the one read under.
  const end = await grant.finish(credential.version);
  if (end !== "ok") return superseded;
  // What was read, as Feishu resolved it: a wiki page can come to hold another document.
  context.identified?.({ document: canonical }, `docx:${documentId}`, { condition: under, generation });
  const text = String(raw.data?.content ?? "");
  return {
    text: text.slice(0, MAX_DOCUMENT_TEXT),
    ...(text.length > MAX_DOCUMENT_TEXT ? { truncated: true, note: `only the first ${MAX_DOCUMENT_TEXT} characters are shown` } : {}),
    // Said about the document, not read from it: kept apart (see ToolResultAside).
    ...(unread ? { aside: { ...(unread.holds.length > 0 ? { not_read: unread.holds } : {}), note: unread.note } } : {}),
  };
}

/** What a read waits on: this person's grant covering these scopes. */
function conditionOf(grant: string, scope: string[]): string {
  return `${grant}:${[...scope].sort().join(" ")}`;
}

/**
 * Whether what a read was waiting on, or was read under, holds now. Asked of the grant itself,
 * and, where several people talk, of the app's setting and of Feishu about the chat.
 */
export async function authorisationHolds(env: Env, scope: Scope, condition: string, generation: number): Promise<Holds> {
  const scopesOf = (text: string) => (/^[a-z_:. ]{1,200}$/.test(text) && text.split(" ").every((each) => SCOPES.includes(each)) ? text.split(" ") : undefined);
  // Still turned on for this app, the very time it was when this began: off, or off and on again, and it is over.
  const turnedOn = async (appId: string, turn: string) => {
    const app = await registry(env).feishuApp(appId);
    return app !== null && app.tenant === scope.tenant && Boolean(app.group_documents) && String(app.group_documents_gen ?? 0) === turn ? app : undefined;
  };
  const part = condition.split("|");
  // A question asked where several people talk, waiting for its own invitation to be answered.
  if (part[0] === "asked" && part.length === 6) {
    const needed = scopesOf(part[5]);
    if (scope.kind !== "chat" || !needed || !/^[0-9a-f]{64}$/.test(part[1]) || !(await turnedOn(part[3], part[4]))) return { state: "gone" };
    return env.FEISHU_GRANTS.getByName(part[1]).answered(part[2], needed, generation);
  }
  // Something read there: the grant still covers it, it is still turned on as it was, and the
  // chat is still the organisation's own with the bot in it.
  if (part[0] === "chat" && part.length === 6) {
    const needed = scopesOf(part[5]);
    const app = needed && /^[0-9a-f]{64}$/.test(part[1]) && scope.kind === "chat" ? await turnedOn(part[2], part[3]) : undefined;
    if (!needed || !app) return { state: "gone" };
    const held = await env.FEISHU_GRANTS.getByName(part[1]).covers(needed, generation);
    if (held.state !== "holds") return held;
    // Could not be asked just now: the caller puts it off and asks again; it is not taken for a no.
    const facts = await chatFactsFor(env, app.app_id, scope.id);
    // Not answered, told to come back later, or the app's own token turned away: not a no.
    const unasked = (answer: { status: number; code?: number }) => answer.status === 0 || answer.status === 429 || answer.status >= 500 || answer.code === 99991663;
    if (unasked(facts.info) || unasked(facts.member)) throw new Error("Feishu cannot be asked about the chat just now");
    return chatIs(facts, part[4]) === "internal" ? held : { state: "gone" };
  }
  // A request in the person's own conversation, waiting to be authorised, by the card it was shown or another.
  if (part[0] === "invited" && part.length === 4) {
    const needed = scopesOf(part[3]);
    if (!needed || !/^[0-9a-f]{64}$/.test(part[1]) || !/^[A-Za-z0-9_-]{20,100}$/.test(part[2])) return { state: "gone" };
    return env.FEISHU_GRANTS.getByName(part[1]).invited(part[2], needed, generation);
  }
  // Something read there (and a request that began waiting before it waited on its own card).
  const found = /^([0-9a-f]{64}):([a-z_:. ]{1,200})$/.exec(condition);
  const needed = found ? scopesOf(found[2]) : undefined;
  if (!found || !needed) return { state: "gone" };
  return env.FEISHU_GRANTS.getByName(found[1]).covers(needed, generation);
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
  if (!invitation || (await grantName(invitation.who)) !== state[1]) return page("这个链接已经用过或已失效", "链接只能使用一次，并且 10 分钟内有效。如果你刚刚已经完成授权，请回到飞书等待结果；否则请重新向我发起请求。", 400);
  const { who } = invitation;
  const code = url.searchParams.get("code") ?? "";
  // An invitation made for one question was claimed by this answer. However it ends short of
  // the person's own token being kept, that invitation is over (a no-op for any other kind).
  if (url.searchParams.has("error") || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) {
    await grant.fail(state[2], invitation);
    return page("没有授权", "你没有完成授权，我不会读取你的文档。需要时可以回到飞书重新发起请求。");
  }

  const refused = async (why: string, answer?: { status: number; code?: unknown; endpoint?: "v2" | "v3" }) => {
    await grant.fail(state[2], invitation);
    // Which step failed, for the operator, and for a call Feishu turned down, its HTTP status and
    // Feishu's own numeric error code: both from fixed lists. Nothing else Feishu or the browser
    // sent is logged.
    const code = answer && typeof answer.code === "number" && Number.isInteger(answer.code) ? answer.code : undefined;
    console.log(JSON.stringify({ feishu_authorisation_refused: why, app: who.app_id, ...(answer ? { status: answer.status, ...(code !== undefined ? { code } : {}), ...(answer.endpoint ? { endpoint: answer.endpoint } : {}) } : {}) }));
    return page("授权没有成功", "请回到飞书，重新向我发起请求。如果一直不成功，请联系管理员。", 400);
  };
  // Everything up to keeping the token: whatever goes wrong in it, also something thrown (a
  // connection that broke, an answer that is not what it should be, the registry not answering),
  // ends the invitation like any other failure. Keeping the token comes after, on its own: if
  // that throws, whether it was kept is not known, and the invitation is not called failed.
  const prepared = await (async (): Promise<Response | { app: FeishuApp; issued: { access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number }; granted: string[]; lasting: boolean }> => {
  const app = await registry(env).feishuApp(who.app_id);
  if (!app) return refused("unknown_app");
  // Lasting authorisations were turned off for this app after the invitation went out: it is
  // turned away before anything is asked of Feishu.
  if (invitation.scope.includes(OFFLINE) && !app.oauth_offline) return refused("offline_turned_off");
  // Only what the invitation asked the person for is asked of Feishu, whatever else they have
  // allowed the app before: Feishu's consent is cumulative, and a token for all of it is not ours
  // to hold. The code is used once.
  // One endpoint per code, chosen by the app's setting; never one after the other.
  // No answer at all (the connection broke) is a failure like any other: the invitation is spent.
  const exchange = await fetch(app.oauth_v2 ? TOKEN_V2 : TOKEN_V3, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: app.app_id, client_secret: app.app_secret, code, redirect_uri: invitation.redirect, code_verifier: invitation.verifier, scope: invitation.scope.join(" ") }),
  }).catch(() => undefined);
  if (!exchange) return refused("exchange_unanswered");
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
  const asked = await fetch(`${API}/authen/v1/user_info`, { headers: { authorization: `Bearer ${issued.access_token}` } }).catch(() => undefined);
  if (!asked) return refused("identity_unanswered");
  const told = ((await asked.json().catch(() => null)) as unknown) ?? {};
  const info = (typeof told === "object" ? told : {}) as { code?: number; data?: { open_id?: string; tenant_key?: string } };
  if (!asked.ok || info.code !== 0) return refused("identity_unknown", { status: asked.status, code: info.code });
  if (info.data?.open_id !== who.open_id || info.data?.tenant_key !== who.tenant_key) {
    await grant.fail(state[2], invitation);
    console.log(JSON.stringify({ feishu_authorisation_refused: "another_account", app: who.app_id }));
    return page("授权的账号不对", "完成授权的飞书账号，不是发起请求的那个账号，所以没有生效。请用发起请求的账号重新操作。", 403);
  }

  // With the person's leave to act while they are away comes a second token, for getting a new
  // first one when it runs out. It is asked for only where the invitation asked for that leave.
  const lasting = invitation.scope.includes(OFFLINE) && typeof issued.refresh_token === "string" && issued.refresh_token !== "" && lifetime(issued.refresh_token_expires_in) > 0;
  if (invitation.scope.includes(OFFLINE) && !lasting) return refused("no_refresh_token");
  // And if it was turned off while Feishu was answering, what came back is not kept.
  if (invitation.scope.includes(OFFLINE) && !(await registry(env).feishuApp(who.app_id))?.oauth_offline) return refused("offline_turned_off");
  return { app, issued: issued as { access_token: string }, granted, lasting };
  })().catch(() => refused("interrupted"));
  if (prepared instanceof Response) return prepared;
  const { app, issued, granted, lasting } = prepared;
  const kept = await grant.install(invitation.generation, {
    access_token: issued.access_token,
    expires_at: Date.now() + lifetime(issued.expires_in) * 1_000,
    scope: granted.join(" "),
    ...(lasting ? { refresh: { token: issued.refresh_token as string, expires_at: Date.now() + lifetime(issued.refresh_token_expires_in) * 1_000, endpoint: app.oauth_v2 ? ("v2" as const) : ("v3" as const) } } : {}),
  }, invitation.ask ? state[2] : undefined);
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
