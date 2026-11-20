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
 * Every authorisation belongs to a generation. Dropping the grant starts a new one, and anything
 * begun in an earlier generation (an invitation still open in a browser, a callback on its way)
 * can no longer install a token.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";

/** A person as one Feishu app sees them: the app, the organisation, and their id under that app. */
export interface Who {
  app_id: string;
  tenant_key: string;
  open_id: string;
}

interface Pending {
  /** The tool call that asked; a repeat of that call gets the same invitation. */
  call: string;
  nonce: string;
  verifier: string;
  expires_at: number;
}

interface Stored {
  who: Who;
  generation: number;
  pending: Pending[];
  grant?: { sealed: string; expires_at: number; scope: string };
}

/** How long an invitation to authorise can be used. Feishu's own code lasts five minutes after consent. */
const INVITATION_TTL_MS = 10 * 60_000;
const MAX_PENDING = 3;
/** A token this close to expiring is treated as expired, so a read does not fail halfway. */
const EXPIRY_MARGIN_MS = 60_000;

export class FeishuGrant extends DurableObject<Env> {
  /**
   * Starts an authorisation for this person. Returns the `state` to send them to Feishu with and
   * the PKCE challenge; the verifier stays here.
   */
  async begin(who: Who, call: string): Promise<{ state: string; challenge: string }> {
    const name = await grantName(who);
    const fresh = { nonce: random(32), verifier: random(48) };
    // Nothing is awaited between reading the record and writing it back, so two calls cannot interleave.
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [] };
    if (JSON.stringify(stored.who) !== JSON.stringify(who)) throw new Error("this authorisation belongs to someone else");
    const now = Date.now();
    stored.pending = stored.pending.filter((each) => each.expires_at > now);
    let pending = stored.pending.find((each) => each.call === call);
    if (!pending) {
      pending = { call, ...fresh, expires_at: now + INVITATION_TTL_MS };
      stored.pending = [...stored.pending, pending].slice(-MAX_PENDING);
    }
    void this.ctx.storage.put("grant", stored);
    return { state: `${name}.${pending.nonce}`, challenge: await challengeOf(pending.verifier) };
  }

  /**
   * Takes an invitation out of the record, once: what came back from Feishu names it by its nonce.
   * Returns nothing for one that is unknown, used, expired, or from before the grant was dropped.
   */
  async redeem(nonce: string): Promise<{ who: Who; verifier: string; generation: number } | null> {
    const stored = await this.#load();
    if (!stored) return null;
    const found = stored.pending.find((each) => each.nonce === nonce);
    if (!found) return null;
    stored.pending = stored.pending.filter((each) => each !== found);
    void this.ctx.storage.put("grant", stored);
    if (found.expires_at <= Date.now()) return null;
    return { who: stored.who, verifier: found.verifier, generation: stored.generation };
  }

  /** Keeps the token an authorisation produced, unless the grant has been dropped since it began. */
  async install(generation: number, token: { access_token: string; expires_at: number; scope: string }): Promise<boolean> {
    const key = await this.#key();
    const current = await this.#load();
    if (!current || current.generation !== generation) return false;
    // Sealed for this generation only; awaited before the record is read again below.
    const sealed = await seal(key, token.access_token, String(generation));
    const stored = await this.#load();
    if (!stored || stored.generation !== generation) return false;
    stored.grant = { sealed, expires_at: token.expires_at, scope: token.scope };
    void this.ctx.storage.put("grant", stored);
    return true;
  }

  /** The person's token, if they have authorised and it has not expired. */
  async accessToken(): Promise<string | null> {
    const stored = await this.#load();
    if (!stored?.grant || stored.grant.expires_at - Date.now() < EXPIRY_MARGIN_MS) return null;
    try {
      return await open(await this.#key(), stored.grant.sealed, String(stored.generation));
    } catch {
      // Sealed under another key, or damaged: as good as not there.
      return null;
    }
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
