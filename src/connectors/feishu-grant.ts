/**
 * One person's authorisation for the agent to read Feishu as them, through one app.
 *
 * There is one object per person per app, named by a hash of who they are (see `grantName`). It
 * holds two things: the authorisations that person has been invited to give and has not yet
 * completed, and the token Feishu issued once they did.
 *
 * The token is kept encrypted with a key that is not in this object's storage: it is derived from
 * the deployment's GRANTS_KEY secret. A copy of the storage alone does not yield a token.
 *
 * The invitation to authorise is this object's to send: a fixed card, to that one person, from the
 * bot. It is sent once per invitation however often it is asked for, retried for as long as the
 * invitation can still be used, and its link is never given to the model.
 *
 * Every token kept here has a version of its own. A read that began under one version is not
 * finished, and cannot take the grant away, once another token or none is in its place.
 *
 * Every authorisation belongs to a generation. Dropping the grant starts a new one, and anything
 * begun in an earlier generation (an invitation still open in a browser, a callback on its way)
 * can no longer install a token.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { sendToPerson } from "./feishu-api";

/** A person as one Feishu app sees them: the app, the organisation, and their id under that app. */
export interface Who {
  app_id: string;
  tenant_key: string;
  open_id: string;
}

interface Pending {
  nonce: string;
  verifier: string;
  /** Where Feishu is to send the person back to. */
  redirect: string;
  expires_at: number;
  /** Whether Feishu has confirmed that the card reached the person's chat. */
  delivered: boolean;
  attempts: number;
}

interface Stored {
  who: Who;
  generation: number;
  pending: Pending[];
  grant?: { sealed: string; expires_at: number; scope: string; version: string };
}

const AUTHORIZE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
/** What the person is asked to allow: reading documents, and finding which document a wiki page is. */
export const SCOPES = ["docx:document:readonly", "wiki:node:read"];
/** How long an invitation to authorise can be used. Feishu's own code lasts five minutes after consent. */
const INVITATION_TTL_MS = 10 * 60_000;
/** An invitation with less time left than this is not offered again; a new one is made. */
const INVITATION_MIN_LEFT_MS = 3 * 60_000;
const MAX_PENDING = 3;
/** A token this close to expiring is treated as expired, so a read does not fail halfway. */
const EXPIRY_MARGIN_MS = 60_000;

export class FeishuGrant extends DurableObject<Env> {
  /**
   * Makes sure this person has a usable invitation to authorise in their chat. One that was
   * delivered and still has time left is not sent again. "queued" means it could not be delivered
   * just now and is being retried.
   */
  async invite(who: Who, redirect: string): Promise<"sent" | "already" | "queued"> {
    const fresh = { nonce: random(32), verifier: random(48) };
    // Nothing is awaited between reading the record and writing it back, so two calls cannot interleave.
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [] };
    if (JSON.stringify(stored.who) !== JSON.stringify(who)) throw new Error("this authorisation belongs to someone else");
    const now = Date.now();
    stored.pending = stored.pending.filter((each) => each.expires_at > now);
    let pending = stored.pending.find((each) => each.redirect === redirect && each.expires_at - now > INVITATION_MIN_LEFT_MS);
    if (pending?.delivered) return "already";
    if (!pending) {
      pending = { ...fresh, redirect, expires_at: now + INVITATION_TTL_MS, delivered: false, attempts: 0 };
      stored.pending = [...stored.pending, pending].slice(-MAX_PENDING);
    }
    void this.ctx.storage.put("grant", stored);
    return (await this.#send(pending.nonce)) ? "sent" : "queued";
  }

  /**
   * Sends one invitation's card. The message is named after the invitation, so Feishu shows it
   * once however often this runs. A failure is retried from the alarm until the invitation expires.
   */
  async #send(nonce: string): Promise<boolean> {
    const before = await this.#load();
    const pending = before?.pending.find((each) => each.nonce === nonce);
    if (!before || !pending || pending.delivered || pending.expires_at <= Date.now()) return false;
    const { who } = before;
    const state = `${await grantName(who)}.${pending.nonce}`;
    const url = `${AUTHORIZE}?${new URLSearchParams({ client_id: who.app_id, response_type: "code", redirect_uri: pending.redirect, scope: SCOPES.join(" "), state, code_challenge: await challengeOf(pending.verifier), code_challenge_method: "S256" })}`;
    const sent = await sendToPerson(this.env, who.app_id, who.open_id, `invite:${pending.nonce}`, { card: invitationCard(url) }).then(
      () => true,
      () => false,
    );
    const after = await this.#load();
    const same = after?.pending.find((each) => each.nonce === nonce);
    if (!after || !same) return sent;
    if (sent) same.delivered = true;
    else {
      same.attempts += 1;
      void this.ctx.storage.setAlarm(Date.now() + Math.min(60_000, 5_000 * 2 ** (same.attempts - 1)));
    }
    void this.ctx.storage.put("grant", after);
    return sent;
  }

  /** Tries again to deliver invitations that have not reached the person and can still be used. */
  async alarm(): Promise<void> {
    const stored = await this.#load();
    for (const each of stored?.pending ?? []) if (!each.delivered && each.expires_at > Date.now()) await this.#send(each.nonce);
  }

  /**
   * Takes an invitation out of the record, once: what came back from Feishu names it by its nonce.
   * Returns nothing for one that is unknown, used, expired, or from before the grant was dropped.
   */
  async redeem(nonce: string): Promise<{ who: Who; verifier: string; redirect: string; generation: number } | null> {
    const stored = await this.#load();
    if (!stored) return null;
    const found = stored.pending.find((each) => each.nonce === nonce);
    if (!found) return null;
    stored.pending = stored.pending.filter((each) => each !== found);
    void this.ctx.storage.put("grant", stored);
    if (found.expires_at <= Date.now()) return null;
    return { who: stored.who, verifier: found.verifier, redirect: found.redirect, generation: stored.generation };
  }

  /** Keeps the token an authorisation produced, unless the grant has been dropped since it began. */
  async install(generation: number, token: { access_token: string; expires_at: number; scope: string }): Promise<boolean> {
    const key = await this.#key();
    const current = await this.#load();
    if (!current || current.generation !== generation) return false;
    // Sealed under a version of its own; awaited before the record is read again below.
    const version = random(16);
    const sealed = await seal(key, token.access_token, version);
    const stored = await this.#load();
    if (!stored || stored.generation !== generation) return false;
    stored.grant = { sealed, expires_at: token.expires_at, scope: token.scope, version };
    void this.ctx.storage.put("grant", stored);
    return true;
  }

  /**
   * The person's token, if they have authorised and it has not expired, with what it covers and
   * the version it is. Whoever uses it asks `stands` with that version before relying on anything
   * the token fetched.
   */
  async credential(): Promise<{ token: string; version: string; scope: string[] } | null> {
    const stored = await this.#load();
    if (!stored?.grant || stored.grant.expires_at - Date.now() < EXPIRY_MARGIN_MS) return null;
    try {
      return { token: await open(await this.#key(), stored.grant.sealed, stored.grant.version), version: stored.grant.version, scope: stored.grant.scope.split(" ").filter(Boolean) };
    } catch {
      // Sealed under another key, or damaged: as good as not there.
      return null;
    }
  }

  /** Whether the token of this version is still the person's grant. */
  async stands(version: string): Promise<boolean> {
    return (await this.#load())?.grant?.version === version;
  }

  /**
   * Forgets the token of this version, because Feishu refused it. Does nothing, and says so, if
   * another token or none has taken its place since: an old read's failure says nothing about that.
   */
  async dropIf(version: string): Promise<boolean> {
    const stored = await this.#load();
    if (!stored?.grant || stored.grant.version !== version) return false;
    delete stored.grant;
    void this.ctx.storage.put("grant", stored);
    return true;
  }

  /** Forgets the token and closes every open invitation, including ones already on their way back. */
  async drop(): Promise<void> {
    const stored = await this.#load();
    if (!stored) return;
    void this.ctx.storage.put("grant", { who: stored.who, generation: stored.generation + 1, pending: [] } satisfies Stored);
  }

  /** For the operator: whether there is a grant, and until when. Never the token. */
  async status(): Promise<{ authorised: boolean; expires_at?: number; scope?: string; pending: number }> {
    const stored = await this.#load();
    const live = stored?.grant && stored.grant.expires_at > Date.now() ? stored.grant : undefined;
    return { authorised: Boolean(live), ...(live ? { expires_at: live.expires_at, scope: live.scope } : {}), pending: stored?.pending.filter((each) => each.expires_at > Date.now()).length ?? 0 };
  }

  #load(): Promise<Stored | undefined> {
    return this.ctx.storage.get<Stored>("grant");
  }

  async #key(): Promise<CryptoKey> {
    const secret = grantsKey(this.env);
    if (!secret) throw new Error("GRANTS_KEY is not set");
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("always-on-agents feishu grant"), info: new TextEncoder().encode(this.ctx.id.toString()) },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
}

function invitationCard(url: string): unknown {
  const plain = (content: string) => ({ tag: "plain_text", content });
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: plain("需要你的授权") },
    elements: [
      { tag: "div", text: plain("要读取你的飞书文档，需要你先授权。授权后我只能以你的身份读取文档，你打不开的文档我也读不到。") },
      { tag: "action", actions: [{ tag: "button", text: plain("去授权"), type: "primary", url }] },
      { tag: "note", elements: [plain("链接 10 分钟内有效，只对你本人有效。授权完成后，请把刚才的请求再发一次。")] },
    ],
  };
}

/** The deployment's key for sealing tokens, if one long enough to be a key is set. */
export function grantsKey(env: Env): string | undefined {
  return env.GRANTS_KEY && env.GRANTS_KEY.length >= 32 ? env.GRANTS_KEY : undefined;
}

/** The name of the object that holds this person's grant. */
export async function grantName(who: Who): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([who.app_id, who.tenant_key, who.open_id]))));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function grantOf(env: Env, who: Who): Promise<DurableObjectStub<FeishuGrant>> {
  return env.FEISHU_GRANTS.getByName(await grantName(who));
}

/** The PKCE challenge for a verifier: base64url(SHA-256(verifier)). */
export async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function random(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function seal(key: CryptoKey, plain: string, bound: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(bound) }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  let binary = "";
  for (const byte of out) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function open(key: CryptoKey, sealed: string, bound: string): Promise<string> {
  const data = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12), additionalData: new TextEncoder().encode(bound) }, key, data.subarray(12));
  return new TextDecoder().decode(plain);
}
