/**
 * Doubao Work: handing a piece of work to its agent as the person who asked, and bringing back
 * what it made of it.
 *
 * This connector plugs into another (see `Connector.serves`). It has no way in or out of its own:
 * a person reaches the agent through the chat connector, which says who they are, and this adds
 * one thing the agent can do for them. Which chat app may use it, with which Doubao app's
 * credentials, is the operator's to set at run time (`admin`); nothing about any particular app
 * is written here.
 *
 * Doubao Work speaks for a user only (never for an app), with the same authorisation protocol as
 * Feishu on its own hosts. It sends nothing back by itself: a reply is found by asking again.
 * See docs/design/doubao-work.zh-CN.md for what was measured against the real service.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { type InboundEvent, type Scope, scopeName } from "../events";
import { type DoubaoApp, registry } from "../registry";
import { challengeOf, grantsKey, lifetime, open, random, seal } from "./feishu-grant";
import type { Connector, ConnectorTool, Holds, Invitation, ToolContext, Waiting } from "./types";

const ACCOUNTS = "https://accounts.doubao.com";
const API = "https://open.doubao.com/open-apis/agent/v1";
/** What a person is asked to allow: starting a conversation, sending into one, and reading what comes back. */
const SCOPES = ["doubao:session:write", "doubao:session.event:write", "doubao:session.message:read"];
/** What Doubao adds to every grant by itself: who the token is for. */
const ALWAYS = "auth:user.id:read";
const INVITATION_TTL_MS = 10 * 60_000;
/** How long past its time an invitation's record is kept: longer than a request waiting on it can still be asked about. */
const INVITATION_KEPT_MS = 60 * 60_000;
const MAX_INVITATIONS = 100;
/** How long one piece of work may take from when it was handed over. */
const WORK_LIMIT_MS = 60 * 60_000;
const EXPIRY_MARGIN_MS = 60_000;
const MAX_TEXT = 8_000;
const MAX_REPLY = 60_000;

/** A person as the chat connector verified them, and as Doubao has to see them. */
interface Who {
  chat_app_id: string;
  tenant_key: string;
  open_id: string;
  /** The same person under any app of the same developer, where the chat connector gave it. */
  union_id?: string;
}

/**
 * One piece of work handed over: what was to be sent (never changed), and how far it got.
 * "asked": kept, nothing sent yet. "submitting": about to be sent, or sent and not heard back.
 * "submitted": Doubao has it. "answered": its reply is kept here. "lost": it may or may not have
 * been taken. "failed": it was certainly not taken.
 */
interface Op {
  text: string;
  uuid: string;
  stage: (typeof STAGES)[number];
  /** The conversation it goes into; absent for one it starts itself until Doubao has named it. */
  session?: string;
  fresh: boolean;
  message?: string;
  created_at: number;
  /** When it is given up, whatever it waits on: set once, as it is first asked for. */
  deadline: number;
  /** The pairing and the generation of the person's authorisation it was asked under: it is carried on under no other. */
  pairing: string;
  generation: number;
  /** How far back the look for its reply has got, where the conversation is longer than one look covers. */
  cursor?: string;
  reply?: { status: string; text: string; artifacts: { name: string; kind: string; link?: string }[]; truncated?: boolean };
}
const STAGES = ["asked", "submitting", "submitted", "answered", "lost", "failed"] as const;

interface Stored {
  who: Who;
  generation: number;
  /**
   * The invitations made, each with how it ended once someone came back through it: `taken` while
   * that is being worked out, then `done` or `refused`. Kept past its time for as long as a
   * request could still wait on it, so that each request is answered by its own invitation.
   */
  pending: { nonce: string; verifier: string; redirect: string; expires_at: number; app_id: string; pairing: string; state?: "taken" | "done" | "refused"; at?: number }[];
  grant?: { sealed: string; version: string; expires_at: number; since: number; pairing: string };
  owed?: { event: string; attempts: number };
  ops: Record<string, Op>;
}

const ENDED: Op["stage"][] = ["answered", "lost", "failed"];
/** Which stage may follow which. Nothing follows one that has ended. */
const NEXT: Record<Op["stage"], Op["stage"][]> = { asked: ["submitting"], submitting: ["submitted", "lost", "failed"], submitted: ["answered"], answered: [], lost: [], failed: [] };
const MAX_OPS = 50;
/** How long after its deadline a piece of work is still kept: longer than a request can be carried on after it. */
const KEPT_AFTER_MS = 2 * 60 * 60_000;
const CARRY_ON_WITHIN_MS = 24 * 60 * 60_000;

const same = (a: Who, b: Who) => a.chat_app_id === b.chat_app_id && a.tenant_key === b.tenant_key && a.open_id === b.open_id;

export class DoubaoGrant extends DurableObject<Env> {
  /** Makes an invitation for this person to authorise under one pairing, unless they already have. */
  async invite(who: Who, redirect: string, app: Pick<DoubaoApp, "app_id" | "version">, generation: number): Promise<"superseded" | "full" | { nonce: string; expires_at: number; generation: number }> {
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [], ops: {} };
    if (!same(stored.who, who)) throw new Error("this authorisation belongs to someone else");
    if (stored.generation !== generation || (stored.grant && stored.grant.pairing === app.version && usable(stored.grant))) return "superseded";
    const now = Date.now();
    // As the chat connector says they are now: the id they are matched by is kept with the invitation's owner.
    stored.who = who;
    stored.pending = stored.pending.filter((each) => each.expires_at + INVITATION_KEPT_MS > now);
    let pending = stored.pending.find((each) => !each.state && each.redirect === redirect && each.app_id === app.app_id && each.pairing === app.version && each.expires_at - now > 3 * 60_000);
    if (!pending) {
      // None is dropped to make room: a request may still be waiting on each.
      if (stored.pending.length >= MAX_INVITATIONS) return "full";
      pending = { nonce: random(32), verifier: random(48), redirect, expires_at: now + INVITATION_TTL_MS, app_id: app.app_id, pairing: app.version };
      stored.pending = [...stored.pending, pending];
    }
    void this.ctx.storage.put("grant", stored);
    return { nonce: pending.nonce, expires_at: pending.expires_at, generation: stored.generation };
  }

  /** What to show for one invitation, made as it is sent; null once it can no longer be used. */
  async card(name: string, nonce: string): Promise<Invitation | null> {
    const stored = await this.#load();
    const pending = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || !pending || pending.state || pending.expires_at <= Date.now()) return null;
    const url = `${ACCOUNTS}/open-apis/authen/v1/authorize?${new URLSearchParams({ client_id: pending.app_id, response_type: "code", redirect_uri: pending.redirect, scope: SCOPES.join(" "), state: `${name}.${pending.nonce}`, code_challenge: await challengeOf(pending.verifier), code_challenge_method: "S256" })}`;
    return {
      title: "需要你的授权",
      text: "要把这件事交给豆包工作，需要你先授权。授权后我只能以你的身份在豆包工作里发起对话、读取它的回复。",
      action: { label: "去授权", url },
      note: "链接 10 分钟内有效，只对你本人有效。这次授权约两小时后过期。授权完成后我会接着处理，你不用再发一遍。",
    };
  }

  /** Takes an invitation out, once. */
  async redeem(nonce: string): Promise<{ who: Who; verifier: string; redirect: string; generation: number; app_id: string; pairing: string } | null> {
    const stored = await this.#load();
    const found = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || !found || found.state) return null;
    if (found.expires_at <= Date.now()) return null;
    found.state = "taken";
    void this.ctx.storage.put("grant", stored);
    return { who: stored.who, verifier: found.verifier, redirect: found.redirect, generation: stored.generation, app_id: found.app_id, pairing: found.pairing };
  }

  /** Keeps the token an authorisation produced, unless the grant was taken away since it began. The person's Brain is owed word of it. */
  async install(nonce: string, generation: number, pairing: string, token: { access_token: string; expires_at: number }): Promise<boolean> {
    const version = random(16);
    const sealed = await seal(await this.#key(), token.access_token, version);
    const stored = await this.#load();
    const through = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || stored.generation !== generation || through?.state !== "taken") return false;
    through.state = "done";
    // When this one was done: a later one being done as well does not move it.
    through.at = Date.now();
    stored.grant = { sealed, version, expires_at: token.expires_at, since: Date.now(), pairing };
    stored.owed = { event: version, attempts: 0 };
    void this.ctx.storage.put("grant", stored);
    void this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  /**
   * An invitation someone came back through came to nothing: whoever waits on it is owed word. Says
   * how the invitation stands after this, which is "done" if the token was in fact kept.
   */
  async refuse(nonce: string): Promise<"done" | "refused" | undefined> {
    const stored = await this.#load();
    const through = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || !through || through.state !== "taken") return through?.state === "done" || through?.state === "refused" ? through.state : undefined;
    through.state = "refused";
    stored.owed = { event: `refused:${nonce}`, attempts: 0 };
    void this.ctx.storage.put("grant", stored);
    void this.ctx.storage.setAlarm(Date.now());
    return "refused";
  }

  /**
   * Whether the person's authorisation stands now, for a request that was shown one invitation:
   * in this generation and under the pairing in force, and since when. The request is answered by
   * its own invitation first. If that came to nothing the request is over, whatever was authorised
   * since through another; while someone's coming back through it is still being worked out, not yet.
   */
  async covers(generation: number, nonce: string): Promise<Holds> {
    const stored = await this.#load();
    if ((stored?.generation ?? 1) !== generation) return { state: "gone" };
    const shown = stored?.pending.find((each) => each.nonce === nonce);
    if (!shown) return { state: "gone" };
    if (shown.state === "refused") return { state: "gone", refused: true };
    if (shown.state === "taken") return { state: "not_yet" };
    if (!stored?.grant || !usable(stored.grant)) return { state: "not_yet" };
    const app = await registry(this.env).doubaoApp(stored.who.chat_app_id);
    if (!app) return { state: "gone" };
    return app.version === stored.grant.pairing ? { state: "holds", since: shown.state === "done" && shown.at ? Math.min(shown.at, stored.grant.since) : stored.grant.since } : { state: "not_yet" };
  }

  /**
   * The token, for the connector's own calls, and which generation this is. Only one given under
   * the pairing the operator has in force now: after the pairing is changed or removed, what was
   * authorised before is not used. Never leaves the Worker.
   */
  async held(): Promise<{ generation: number; pairing?: string; token?: string; version?: string }> {
    const stored = await this.#load();
    const generation = stored?.generation ?? 1;
    const app = stored ? await registry(this.env).doubaoApp(stored.who.chat_app_id) : null;
    const pairing = app ? { pairing: app.version } : {};
    if (!stored?.grant || !app || app.version !== stored.grant.pairing || !usable(stored.grant)) return { generation, ...pairing };
    try {
      return { generation, ...pairing, token: await open(await this.#key(), stored.grant.sealed, stored.grant.version), version: stored.grant.version };
    } catch {
      return { generation, ...pairing };
    }
  }

  /** Forgets a token Doubao turned away, if it is still the one held. */
  async refused(version: string): Promise<void> {
    const stored = await this.#load();
    if (!stored || stored.grant?.version !== version) return;
    delete stored.grant;
    void this.ctx.storage.put("grant", stored);
  }

  /** Forgets the token and closes every open invitation. What was handed over stays on record. */
  async drop(): Promise<void> {
    const stored = await this.#load();
    if (!stored) return;
    void this.ctx.storage.put("grant", { ...stored, generation: stored.generation + 1, pending: [], grant: undefined, owed: undefined });
    void this.ctx.storage.deleteAlarm();
  }

  /** For the operator: whether there is a grant and until when, and how many pieces of work stand where. Never the token, nor what was asked. */
  async status(): Promise<{ authorised: boolean; expires_at?: number; pending: number; work: Record<string, number> }> {
    const stored = await this.#load();
    const work: Record<string, number> = {};
    for (const each of Object.values(stored?.ops ?? {})) work[each.stage] = (work[each.stage] ?? 0) + 1;
    return { authorised: Boolean(stored?.grant && usable(stored.grant, 0)), ...(stored?.grant ? { expires_at: stored.grant.expires_at } : {}), pending: stored?.pending.filter((each) => !each.state && each.expires_at > Date.now()).length ?? 0, work };
  }

  /** One piece of work, by the call that handed it over. */
  async op(call: string): Promise<Op | undefined> {
    return (await this.#load())?.ops[call];
  }

  /**
   * Keeps a piece of work as it is first asked for: what is to be sent, the key that makes
   * sending it twice the same as once, when it is given up, under which pairing and generation,
   * and which conversation it goes into. Asked for again by the same call, it is the one kept.
   *
   * To carry on: the conversation of the piece of work the person points at (`from`: the call
   * whose answer they replied to), or, pointing at none, of the only one they had here in the
   * last day. Several, and it is not guessed.
   *
   * A piece of work is never dropped to make room while the call that made it could still be
   * made again. With no room left, a new one is refused.
   */
  async begin(who: Who, call: string, text: string, to: { carryOn: boolean; from?: string }, pairing: string, generation: number): Promise<Op | "nothing_to_carry_on" | "several" | "not_found" | "full"> {
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [], ops: {} };
    if (!same(stored.who, who)) throw new Error("this record belongs to someone else");
    if (stored.ops[call]) return stored.ops[call];
    const now = Date.now();
    const under = (each: Op) => each.session !== undefined && each.pairing === pairing && each.generation === generation && (each.stage === "submitted" || each.stage === "answered");
    let session: string | undefined;
    if (to.carryOn && to.from !== undefined) {
      const pointed = stored.ops[to.from];
      if (!pointed || !under(pointed)) return "not_found";
      session = pointed.session;
    } else if (to.carryOn) {
      const lately = [...new Set(Object.values(stored.ops).filter((each) => under(each) && now - each.created_at < CARRY_ON_WITHIN_MS).map((each) => each.session!))];
      if (lately.length !== 1) return lately.length === 0 ? "nothing_to_carry_on" : "several";
      session = lately[0];
    }
    // Only once nothing can ask about it again: the request it belongs to ends at its deadline at
    // the latest, and may be carried on for a while after. Until then its key and its outcome are
    // what keep the same call from being done a second time, whatever stage it is at.
    const over = (each: Op) => now >= each.deadline + KEPT_AFTER_MS;
    const kept = Object.entries(stored.ops).sort(([, a], [, b]) => a.created_at - b.created_at);
    while (kept.length >= MAX_OPS) {
      const oldest = kept.findIndex(([, each]) => over(each));
      if (oldest < 0) return "full";
      kept.splice(oldest, 1);
    }
    const op: Op = { text, uuid: crypto.randomUUID(), stage: "asked", fresh: !to.carryOn, ...(session ? { session } : {}), created_at: now, deadline: now + WORK_LIMIT_MS, pairing, generation };
    stored.ops = { ...Object.fromEntries(kept), [call]: op };
    void this.ctx.storage.put("grant", stored);
    return op;
  }

  /** Records how far a piece of work has got: only to a stage that may follow the one it is at. One that has ended stays as it ended. */
  async advance(call: string, stage: Op["stage"], more: Pick<Op, "session" | "message" | "reply"> = {}): Promise<Op | undefined> {
    const stored = await this.#load();
    const before = stored?.ops[call];
    if (!stored || !before) return undefined;
    if (!NEXT[before.stage].includes(stage)) return before;
    const now = { ...before, ...more, stage };
    stored.ops[call] = now;
    void this.ctx.storage.put("grant", stored);
    return now;
  }

  /** Notes how far back the look for a reply has got (nothing: start from the newest again). */
  async looked(call: string, cursor?: string): Promise<void> {
    const stored = await this.#load();
    const op = stored?.ops[call];
    if (!stored || !op || op.cursor === cursor) return;
    if (cursor === undefined) delete op.cursor;
    else op.cursor = cursor;
    void this.ctx.storage.put("grant", stored);
  }

  /** Tells the person's Brain that their authorisation has changed, until it has heard. */
  async alarm(): Promise<void> {
    const stored = await this.#load();
    if (!stored?.owed) return;
    const { event, attempts } = stored.owed;
    let heard = false;
    try {
      const app = await registry(this.env).doubaoApp(stored.who.chat_app_id);
      if (app) heard = (await this.env.BRAIN.getByName(scopeName({ tenant: app.tenant, kind: "user", id: stored.who.open_id })).conditionReported(app.chat_connector, await grantName(stored.who), event)).ok;
    } catch {
      heard = false;
    }
    const after = await this.#load();
    if (after?.owed?.event !== event) return;
    if (heard) delete after.owed;
    else after.owed = { event, attempts: attempts + 1 };
    void this.ctx.storage.put("grant", after);
    if (!heard) void this.ctx.storage.setAlarm(Date.now() + Math.min(600_000, 15_000 * 2 ** Math.min(attempts, 10)));
  }

  #load(): Promise<Stored | undefined> {
    return this.ctx.storage.get<Stored>("grant");
  }

  async #key(): Promise<CryptoKey> {
    const secret = grantsKey(this.env);
    if (!secret) throw new Error("GRANTS_KEY is not set");
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("always-on-agents doubao grant"), info: new TextEncoder().encode(this.ctx.id.toString()) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
}

function usable(grant: NonNullable<Stored["grant"]>, margin = EXPIRY_MARGIN_MS): boolean {
  return grant.expires_at - margin > Date.now();
}

/** The name of the object that holds this person's grant: theirs under that chat app, apart from anything else's grants. */
export async function grantName(who: Pick<Who, "chat_app_id" | "tenant_key" | "open_id">): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["doubao", who.chat_app_id, who.tenant_key, who.open_id]))));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function redirectUri(env: Env): string | undefined {
  const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/, "");
  return origin && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin) ? `${origin}/v1/doubao/oauth/callback` : undefined;
}

/** One call to Doubao as the person. Throws only when no answer came back at all. */
async function asPerson(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; code?: number; data: any }> {
  const response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const answer = ((await response.json().catch(() => null)) ?? {}) as { code?: unknown; data?: unknown };
  return { status: response.status, ...(typeof answer.code === "number" ? { code: answer.code } : {}), data: answer.data && typeof answer.data === "object" ? answer.data : {} };
}

/** Whether the person themselves named Doubao, in what they just wrote or wrote here shortly before. */
const NAMED = /豆包|doubao/i;

export const doubaoAsk: ConnectorTool = {
  name: "doubao_ask",
  description:
    "Hand a piece of work to Doubao Work (豆包工作), as the person you are talking to and with their own account there. Use it in two cases, and never on your own initiative. One: the person themselves plainly asks, in this message, for Doubao to do something (research, write a document, and the like). Two: your last answer to them was what Doubao made for them, and what they write now goes on with that piece of work (more depth, a correction, the next part): then carry it on with Doubao (`carry_on` true) without their having to name Doubao again. Something they ask of you yourself (what you think, to answer here, a different subject, anything they would not want written into that Doubao conversation) you answer yourself. If they say not to use Doubao, do not. If it cannot be told whether they mean you or Doubao and it matters where their words go, ask them once which. `text` is what to ask Doubao: the person's own request, in their words where those are enough. Doubao knows nothing of this conversation, so add what it needs from here to understand the request (what a \"this\" or \"that\" refers to, say), and nothing else: no requirements, scope, format or guesses at what they mean that they did not state. `carry_on`: false for something new (they have to have named Doubao in this message); true for a follow-up to a piece of work Doubao already did for this person: the one whose answer they replied to, else the one your last answer to them came from, else the only recent one; where it cannot be told which, you are told to ask them. Doubao takes a while: the system tells the person it has been handed over, and its result is brought back when it is done. Calling a request off stops the waiting here; it does not stop Doubao.",
  effect: "act",
  optional: true,
  parameters: { text: { type: "string" }, carry_on: { type: "boolean" } },
  run: ask,
  // A piece of work handed over for the person is theirs to point at for as long as its record is kept: the call itself checks that.
  links: (_message, request) => typeof request.op === "string",
};

const UNCERTAIN = "it could not be confirmed whether Doubao took this; nothing more was sent, so that it is not done twice. The person can look in Doubao Work, or ask again";

async function ask(context: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const { env, origin } = context;
  const text = String(args.text ?? "").trim();
  if (!text) return { error: "say what Doubao is to do" };
  if (text.length > MAX_TEXT) return { error: `that is too long to hand over: at most ${MAX_TEXT} characters` };
  const carryOn = args.carry_on === true;
  if (context.scope.kind !== "user") return { error: "this can only be done for one person, in their own conversation" };
  const redirect = redirectUri(env);
  if (!redirect || !grantsKey(env)) return { error: "handing work to Doubao is not set up on this deployment" };
  const app = await registry(env).doubaoApp(origin.app_id ?? "");
  if (!app || app.tenant !== context.scope.tenant || !origin.tenant_key) return { error: "handing work to Doubao is not set up for this conversation" };
  // What they point at, if their message replies to an answer that was written from one piece of work handed over here.
  const pointed = typeof context.answering?.source?.op === "string" ? context.answering.source.op : undefined;
  // Their own word for it, in what they just wrote: not what the model was led to ask for, nor
  // something they said another time. (Or their reply to what Doubao made for them.)
  // Or, for a follow-up only: the last answer they had from the agent when they wrote was what Doubao made for them, not long ago.
  const followed = carryOn && pointed === undefined && typeof context.latest?.source.op === "string" && Date.now() - context.latest.sent_at < CARRY_ON_WITHIN_MS ? context.latest.source.op : undefined;
  if (!context.said.some((each) => NAMED.test(each.text)) && pointed === undefined && followed === undefined) return { error: "the person has not asked for Doubao in this message, and it does not follow on an answer Doubao made for them; nothing was sent. If they want this handed to Doubao, they can say so" };
  // Who they are on the other side, as the chat connector verified it with each of their messages.
  const ids = new Set(context.said.map((each) => each.data.union_id));
  const union = ids.size === 1 && typeof [...ids][0] === "string" && [...ids][0] !== "" ? ([...ids][0] as string) : undefined;
  if (app.match === "union_id" && !union) return { error: "who this person is on Doubao's side could not be told from their message; nothing was sent" };
  const who: Who = { chat_app_id: app.chat_app_id, tenant_key: origin.tenant_key, open_id: context.person, ...(union ? { union_id: union } : {}) };
  const name = await grantName(who);
  const grant = env.DOUBAO_GRANTS.getByName(name);
  const request = { text, carry_on: carryOn };
  const CHANGED = { error: "the person's authorisation, or how this is set up, changed while this was under way; nothing more was done. They can ask again" };

  const { generation, token, version } = await grant.held();
  if (context.resuming && generation !== context.resuming.generation) return CHANGED;
  // Kept as it is first asked for. The same call made again (carried on, or after an interruption) is the same piece of work.
  const op = await grant.begin(who, context.callId, text, { carryOn, ...(carryOn && (pointed ?? followed) !== undefined ? { from: pointed ?? followed } : {}) }, app.version, generation);
  if (op === "nothing_to_carry_on") return { error: "there is no recent piece of work with Doubao to carry on for this person; set `carry_on` to false to start a new one" };
  if (op === "several") return { error: "the person has had more than one piece of work with Doubao lately, and it cannot be told which this follows; nothing was sent. Ask them which one: replying to the answer in question says it. Or start a new one with `carry_on` false" };
  if (op === "not_found") return { error: "the piece of work this replies to can no longer be carried on (it is too old, or the authorisation changed since); nothing was sent. Start a new one with `carry_on` false" };
  if (op === "full") return { error: "too many pieces of work with Doubao are under way for this person; nothing was sent. Try again when one has finished" };
  // Carried on only under what it was asked under: also what it has already brought back.
  if (op.pairing !== app.version || op.generation !== generation) return CHANGED;
  const condition = `doubao|reply|${name}|${context.callId}`;
  if (op.stage === "answered" && op.reply) {
    // What an answer written from this rests on: a reply to that answer points at this piece of work.
    context.identified?.({ op: context.callId }, `doubao:${name}:${context.callId}`, { condition, generation });
    return answered(op);
  }
  if (op.stage === "lost") return { error: UNCERTAIN };
  if (op.stage === "failed") return { error: "Doubao did not take this; nothing was sent. The person can ask again" };

  // One limit for the whole of it, whatever it has waited on: nothing is sent, or asked for, past it.
  const late = () => Date.now() >= op.deadline;
  if (late()) return { error: op.stage === "asked" ? "this was not done in time; nothing was sent. The person can ask again" : "Doubao did not finish this in time. What it makes of it can still be seen in Doubao Work" };
  if (!token || !version) return authorise();
  if (op.stage === "submitted") return reply();

  // Written down before anything is sent, and sent exactly as recorded: Doubao gives the same
  // answer for the same key and words, so a second try after silence does not do it twice.
  await grant.advance(context.callId, "submitting");
  const contents = [{ type: "text", text: op.text }];
  // It was already being sent once (this call is made again after an interruption): it may have been taken then.
  let maybeTaken = op.stage === "submitting";
  let sent: Awaited<ReturnType<typeof asPerson>> | undefined;
  for (let tries = 0; tries < 2 && !sent; tries++) {
    // The last thing before each send, with nothing waited for in between: everything it was
    // asked under still stands, asked now (the same authorisation, the same pairing, a token
    // that is still good), and then that its time is not up.
    const now = await grant.held();
    if (now.generation !== op.generation || now.pairing !== op.pairing || !now.token || now.version !== version || late()) break;
    const going = op.fresh ? asPerson(now.token, "POST", "/sessions", { uuid: op.uuid, initial_events: [{ type: "user.message", contents }] }) : asPerson(now.token, "POST", `/sessions/${encodeURIComponent(op.session!)}/events`, { uuid: op.uuid, events: [{ type: "user.message", contents }] });
    try {
      const got = await going;
      // No answer worth the name: it may have been taken.
      if (got.status >= 500 || got.status === 429) maybeTaken = true;
      else sent = got;
    } catch {
      maybeTaken = true;
    }
  }
  const again = maybeTaken;
  if (!sent) {
    // Never sent at all (what it rested on changed, or its time ran out, before the first try): said as that.
    if (!maybeTaken) return await grant.advance(context.callId, "failed"), late() ? { error: "this was not done in time; nothing was sent. The person can ask again" } : CHANGED;
    // Tried, and not known to have failed.
    await grant.advance(context.callId, "lost");
    return { error: UNCERTAIN };
  }
  if (sent.status === 401) {
    await grant.refused(version);
    // Turned away for who is asking: nothing of it was taken. Still to be sent, once they have authorised again.
    return again ? (await grant.advance(context.callId, "lost"), { error: UNCERTAIN }) : authorise();
  }
  const mine = (Array.isArray(sent.data.messages) ? sent.data.messages : []).find((each: any) => each?.role === "user" && typeof each.id === "string");
  const session = op.fresh ? sent.data.id : op.session;
  if (sent.status !== 200 || sent.code !== 0 || typeof session !== "string" || !mine) {
    // A conflict on a second try can mean the first was taken; on a first try, that nothing was.
    // And "taken" without saying what became of it is not a refusal.
    if (again || (sent.status >= 200 && sent.status < 300 && (sent.code === 0 || sent.code === undefined))) return await grant.advance(context.callId, "lost"), { error: UNCERTAIN };
    await grant.advance(context.callId, "failed");
    return { error: sent.status === 409 && !op.fresh ? "that conversation with Doubao is still working on something else; wait for it to finish, or start a new one with `carry_on` false" : `Doubao did not take this (status ${sent.status}); nothing was started` };
  }
  await grant.advance(context.callId, "submitted", { session, message: mine.id });
  return reply();

  function reply(): Waiting {
    return { waiting: { on: "reply", subject: name, condition, generation, until: (op as Op).deadline, request } };
  }
  async function authorise(): Promise<unknown> {
    const invitation = await grant.invite(who, redirect!, app!, generation);
    if (invitation === "superseded") return { error: "the person's authorisation changed just now; nothing was sent. They can ask again" };
    if (invitation === "full") return { error: "too many authorisations were begun and not finished in the last hour; nothing was sent. They can ask again later" };
    return { waiting: { on: "authorisation", subject: name, condition: `doubao|auth|${name}|${invitation.nonce}`, generation: invitation.generation, until: Math.min(invitation.expires_at, (op as Op).deadline), interaction: `doubao.${name}.${invitation.nonce}`, request } } satisfies Waiting;
  }
}

/** What a finished piece of work came to, for the model: Doubao's words and what it made. */
function answered(op: Op): unknown {
  const reply = op.reply!;
  if (reply.status !== "completed") return { error: `Doubao did not finish this: its reply ended as ${reply.status}` };
  return { text: reply.text, ...(reply.truncated ? { truncated: true } : {}), ...(reply.artifacts.length > 0 ? { made: reply.artifacts } : {}), note: "This is Doubao's reply, not the person's words. A follow-up to it can be handed over with `carry_on` true." };
}

/** Whether a condition of this connector's holds: the person's authorisation, or the reply to something handed over. Nothing for a condition that is not its own. */
async function holds(env: Env, scope: Scope, condition: string, generation: number): Promise<Holds | undefined> {
  const part = condition.split("|");
  if (part[0] !== "doubao") return undefined;
  if (scope.kind !== "user" || !/^[0-9a-f]{64}$/.test(part[2] ?? "")) return { state: "gone" };
  const grant = env.DOUBAO_GRANTS.getByName(part[2]);
  if (part[1] === "auth" && part.length === 4) return grant.covers(generation, part[3]);
  if (part[1] !== "reply" || part.length !== 4) return { state: "gone" };
  const op = await grant.op(part[3]);
  if (!op || (op.stage !== "submitted" && op.stage !== "answered")) return { state: "gone" };
  // Only under what it was asked under, asked now: an authorisation taken away, or another pairing, ends it, also once it is answered.
  const held = await grant.held();
  if (held.generation !== generation || op.generation !== generation || held.pairing !== op.pairing) return { state: "gone" };
  // What it brought back is kept here and is the person's own: it stays theirs to be given
  // after their token has run out by itself. (Taken away, or another pairing: not, as above.)
  if (op.stage === "answered") return { state: "holds", since: op.created_at };
  // Past its time: said without asking Doubao, so that it ends also when Doubao cannot be reached.
  if (Date.now() >= op.deadline) return { state: "not_yet" };
  // Their authorisation ran out while Doubao was at work. The wait for the reply is over for
  // now: the call is made again, finds that, and asks them to authorise, within the same time.
  if (!held.token || !held.version) return { state: "holds", since: Date.now() };
  // The reply to that very message: found by what it answers, and done only when it says so
  // itself. Newest first, a page at a time, as far back as the message it answers and no further.
  // A look covers five pages. In a conversation longer than that the next look goes on from
  // where this one stopped, until the message it answers has been passed; then from the newest again.
  let reply: any;
  let page = op.cursor;
  let resume: string | undefined;
  for (let pages = 0; pages < 5 && !reply; pages++) {
    if (Date.now() >= op.deadline) return { state: "not_yet" };
    const listed = await asPerson(held.token, "GET", `/sessions/${encodeURIComponent(op.session!)}/messages?order=desc${page ? `&page_token=${encodeURIComponent(page)}` : ""}`);
    if (listed.status === 401) {
      await grant.refused(held.version);
      return { state: "holds", since: Date.now() };
    }
    if (listed.status !== 200 || listed.code !== 0) throw new Error("Doubao cannot be asked just now");
    const messages: any[] = Array.isArray(listed.data.messages) ? listed.data.messages : [];
    reply = messages.find((each) => each?.role === "assistant" && each.reply_id === op.message);
    const next = listed.data.has_more === true && typeof listed.data.page_token === "string" && listed.data.page_token !== "" ? listed.data.page_token : undefined;
    // Found, though perhaps not done: looked at again on this same page. Passed the message it answers, or the end: from the newest again.
    resume = reply ? page : !next || messages.some((each) => each?.id === op.message) ? undefined : next;
    if (reply || resume === undefined) break;
    page = next;
  }
  await grant.looked(part[3], resume);
  const age = Date.now() - op.created_at;
  if (!reply || !["completed", "failed", "cancelled"].includes(reply.status)) return { state: "not_yet", again_in_ms: age < 30_000 ? 5_000 : age < 300_000 ? 15_000 : 60_000 };
  const items: any[] = Array.isArray(reply.items) ? reply.items : [];
  const text = items.filter((each) => each?.type === "text" && typeof each.text === "string").map((each) => each.text).join("\n");
  const link = (each: any): string | undefined => [each.url, each[each.artifact_type]?.url].find((url) => typeof url === "string" && /^https:\/\//.test(url));
  const artifacts = items.filter((each) => each?.type === "artifact" && each.state !== "deleted").slice(0, 20).map((each) => ({ name: String(each.name ?? "").slice(0, 200), kind: String(each.artifact_type ?? "").slice(0, 50), ...(link(each) ? { link: link(each)!.slice(0, 1_000) } : {}) }));
  await grant.advance(part[3], "answered", { reply: { status: String(reply.status), text: text.slice(0, MAX_REPLY), artifacts, ...(text.length > MAX_REPLY ? { truncated: true } : {}) } });
  return { state: "holds", since: Date.now() };
}

/** Whether the tool is for whoever wrote this message: one written to the agent alone, through a chat app the operator has paired. */
async function offers(env: Env, event: InboundEvent): Promise<string[]> {
  const appId = (event.data?.origin as { app_id?: unknown } | undefined)?.app_id;
  if (event.data?.direct !== true || typeof appId !== "string") return [];
  return (await registry(env).doubaoPaired(appId)) ? [doubaoAsk.name] : [];
}

/** Where Doubao sends the person's browser after the consent page. Nothing here trusts the browser. */
async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = /^([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(url.searchParams.get("state") ?? "");
  if (!state || !grantsKey(env)) return page("这个链接无法使用", "请回到聊天里，重新向我发起请求。", 400);
  const grant = env.DOUBAO_GRANTS.getByName(state[1]);
  const invitation = await grant.redeem(state[2]);
  if (!invitation || (await grantName(invitation.who)) !== state[1]) return page("这个链接已经用过或已失效", "链接只能使用一次，并且 10 分钟内有效。请回到聊天里，重新向我发起请求。", 400);
  const { who } = invitation;
  const nonce = state[2];
  const failed = page("授权没有成功", "请回到聊天里，需要的话再跟我说一遍。如果一直不成功，请联系管理员。", 400);
  const succeeded = page("授权成功", "现在可以回到聊天里。如果你刚才的请求还在等待，我会接着处理，不用再发一遍。");
  // From here the invitation is spent: however this ends, whoever waits on it is told.
  const refused = async (why: string, shown = failed) => {
    console.log(JSON.stringify({ doubao_authorisation_refused: why }));
    // Unless the token was in fact kept, which is then how it ended.
    return (await grant.refuse(nonce)) === "done" ? succeeded : shown;
  };
  try {
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.has("error") || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) return await refused("not_consented", page("没有授权", "你没有完成授权，我不会以你的身份使用豆包工作。需要时可以回到聊天里重新发起请求。"));
    const app = await registry(env).doubaoApp(who.chat_app_id);
    if (!app || app.app_id !== invitation.app_id || app.version !== invitation.pairing) return await refused("not_set_up");
    // The token is asked for these and nothing else, whatever else the person has allowed the app before.
    const exchange = await fetch(`${ACCOUNTS}/oauth/v3/token`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ grant_type: "authorization_code", client_id: app.app_id, client_secret: app.app_secret, code, redirect_uri: invitation.redirect, code_verifier: invitation.verifier, scope: SCOPES.join(" ") }) });
    const issued = (((await exchange.json().catch(() => null)) as unknown) ?? {}) as { code?: number; access_token?: string; expires_in?: number; scope?: string };
    if (!exchange.ok || issued.code !== 0 || typeof issued.access_token !== "string" || !issued.access_token || !lifetime(issued.expires_in)) return await refused("exchange_failed");
    // For what was asked and nothing more (Doubao adds knowing who the token is for by itself).
    const granted = String(issued.scope ?? "").split(/\s+/).filter(Boolean);
    if (SCOPES.some((each) => !granted.includes(each))) return await refused("scope_missing");
    if (granted.some((each) => !SCOPES.includes(each) && each !== ALWAYS)) return await refused("scope_too_wide");
    // Whose token is it? The person the invitation was made for, in the same organisation: by the id the operator chose to go by.
    const asked = await fetch(`${ACCOUNTS}/open-apis/authen/v1/user_info`, { headers: { authorization: `Bearer ${issued.access_token}` } });
    const info = (await asked.json().catch(() => ({}))) as { code?: number; data?: { open_id?: string; union_id?: string; tenant_key?: string } };
    if (!asked.ok || info.code !== 0) return await refused("identity_unknown");
    const theirs = app.match === "open_id" ? info.data?.open_id === who.open_id : typeof who.union_id === "string" && who.union_id !== "" && info.data?.union_id === who.union_id;
    if (!theirs || !who.tenant_key || info.data?.tenant_key !== who.tenant_key) return await refused("another_account", page("授权的账号不对", "完成授权的账号，不是发起请求的那个账号，所以没有生效。请用发起请求的账号重新操作。", 403));
    if (!(await grant.install(nonce, invitation.generation, invitation.pairing, { access_token: issued.access_token, expires_at: Date.now() + lifetime(issued.expires_in) * 1_000 }))) return await refused("superseded");
    return succeeded;
  } catch {
    // No answer from Doubao, or none from our own record of whether the token was kept.
    return await refused("interrupted");
  }
}

/** A page with fixed words only: nothing from the request is ever written into it. */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.5rem;color:#1f2329}h1{font-size:1.4rem}p{line-height:1.7;color:#51565d}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" } });
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export const doubaoConnector: Connector = {
  name: "doubao",
  serves: ["feishu"],
  async http(request, env, path) {
    if (path[0] === "oauth" && path[1] === "callback" && path.length === 2 && request.method === "GET") return callback(request, env);
    return json({ error: "not found" }, 404);
  },
  async admin({ method, path, body }, env) {
    // Which chat app's people may hand work to Doubao, and with which Doubao app. The secret is never given back.
    if (path[0] === "doubao" && path[1] === "apps" && path.length === 2 && method === "POST") {
      const given = await body();
      const chat = given.for as { connector?: unknown; app_id?: unknown } | undefined;
      if (chat?.connector !== "feishu" || typeof chat.app_id !== "string" || typeof given.app_id !== "string" || typeof given.app_secret !== "string" || !given.app_id || !given.app_secret) return json({ error: "give for: { connector: \"feishu\", app_id }, app_id and app_secret" }, 400);
      if (given.match !== undefined && given.match !== "union_id" && given.match !== "open_id") return json({ error: "match must be union_id or open_id" }, 400);
      // A person's open_id is theirs under one app only: it says who they are on both sides only where both sides are that app.
      if (given.match === "open_id" && given.app_id !== chat.app_id) return json({ error: "match can be open_id only where the Doubao app is the chat app itself" }, 400);
      const set = await registry(env).setDoubaoApp({ chat_connector: "feishu", chat_app_id: chat.app_id, app_id: given.app_id, app_secret: given.app_secret, match: given.match === "open_id" ? "open_id" : "union_id" });
      return set ? json({ ok: true, for: { connector: "feishu", app_id: chat.app_id }, match: set.match }) : json({ error: "unknown chat app" }, 404);
    }
    if (path[0] === "doubao" && path[1] === "apps" && path[2] && path.length === 3 && method === "DELETE") return json({ ok: true, removed: await registry(env).removeDoubaoApp(path[2]) });
    if (path[0] === "doubao" && path[1] === "apps" && path[2] && path.length === 3 && method === "GET") {
      const app = await registry(env).doubaoApp(path[2]);
      return app ? json({ for: { connector: app.chat_connector, app_id: app.chat_app_id }, match: app.match, set: true }) : json({ set: false });
    }
    // One person's authorisation: whether it stands, and taking it away.
    if (path[0] === "doubao" && path[1] === "grants" && path.length === 5 && (method === "GET" || method === "DELETE")) {
      const grant = env.DOUBAO_GRANTS.getByName(await grantName({ chat_app_id: path[2], tenant_key: path[3], open_id: path[4] }));
      if (method === "DELETE") await grant.drop();
      return json(await grant.status());
    }
    return undefined;
  },
  tools: [doubaoAsk],
  holds,
  offers,
  async invitation(env, interaction) {
    const found = /^doubao\.([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(interaction);
    if (!found) return undefined;
    return env.DOUBAO_GRANTS.getByName(found[1]).card(found[1], found[2]);
  },
};
