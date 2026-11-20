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
  /** No attempt to deliver it is made before this. */
  next_attempt_at: number;
  /** What the person is asked to allow, and all the token will be asked for. */
  scope: string[];
}

interface Stored {
  who: Who;
  generation: number;
  pending: Pending[];
  grant?: { sealed: string; expires_at: number; scope: string; version: string };
  /** The earlier message whose link has been read on the strength of a later one. See `finish`. */
  answered?: string;
}

const AUTHORIZE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
/** Everything a person is ever asked to allow: reading documents, and finding which document a wiki page is. */
export const SCOPES = ["docx:document:readonly", "wiki:node:read"];
/** What the caller knew of the grant when it decided an invitation was needed. */
export interface Seen {
  generation: number;
  /** The version of the token Feishu has just refused, if that is why. */
  refused?: string;
}
/** How long an invitation to authorise can be used. Feishu's own code lasts five minutes after consent. */
const INVITATION_TTL_MS = 10 * 60_000;
/** An invitation with less time left than this is not offered again; a new one is made. */
const INVITATION_MIN_LEFT_MS = 3 * 60_000;
const MAX_PENDING = 3;
/** A token this close to expiring is treated as expired, so a read does not fail halfway. */
const EXPIRY_MARGIN_MS = 60_000;

export class FeishuGrant extends DurableObject<Env> {
  /**
   * Makes sure this person has a usable invitation to authorise `scope` in their chat, provided the
   * grant is still as the caller saw it. If it has been dropped, replaced or installed in the
   * meantime, nothing is sent: "superseded". A token the caller reports as refused is forgotten
   * here, in the same step, and only if it is still the one held.
   *
   * An invitation that was delivered and still has time left is not sent again. "queued" means it
   * has not been delivered yet and is being retried.
   */
  async invite(who: Who, redirect: string, scope: string[], seen: Seen): Promise<"sent" | "already" | "queued" | "superseded"> {
    if (scope.length === 0 || scope.some((each) => !SCOPES.includes(each))) throw new Error("not a scope this connector asks for");
    const fresh = { nonce: random(32), verifier: random(48) };
    // Nothing is awaited between reading the record and writing it back, so two calls cannot interleave.
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [] };
    if (JSON.stringify(stored.who) !== JSON.stringify(who)) throw new Error("this authorisation belongs to someone else");
    const now = Date.now();
    if (stored.generation !== seen.generation) return "superseded";
    if (seen.refused !== undefined) {
      if (stored.grant?.version !== seen.refused) return "superseded";
      delete stored.grant;
    }
    // Someone has authorised since the caller looked: there is nothing to ask for.
    if (stored.grant && stored.grant.expires_at - now >= EXPIRY_MARGIN_MS && scope.every((each) => stored.grant!.scope.split(" ").includes(each))) return "superseded";
    stored.pending = stored.pending.filter((each) => each.expires_at > now);
    let pending = stored.pending.find((each) => each.redirect === redirect && each.expires_at - now > INVITATION_MIN_LEFT_MS && scope.every((wanted) => each.scope.includes(wanted)));
    if (!pending) {
      pending = { ...fresh, redirect, scope, expires_at: now + INVITATION_TTL_MS, delivered: false, attempts: 0, next_attempt_at: now };
      stored.pending = [...stored.pending, pending].slice(-MAX_PENDING);
    }
    // Written together with the alarm that will deliver it: from here on, an invitation that
    // exists and has not been delivered is always one that will be tried.
    void this.ctx.storage.put("grant", stored);
    this.#arm(stored);
    if (pending.delivered) return "already";
    // Not yet time to try again: the alarm has it.
    if (pending.next_attempt_at > now) return "queued";
    const how = await this.#send(pending.nonce);
    // Used or taken away while its card was on the way: there is no invitation to speak of.
    return how === "gone" ? "superseded" : how === "sent" ? "sent" : "queued";
  }

  /**
   * Sends one invitation's card. The message is named after the invitation, so Feishu shows it
   * once however often this runs. Before anything is sent, the next attempt is written down and
   * the alarm set for it: if this stops halfway, the invitation is still tried again.
   */
  async #send(nonce: string): Promise<"sent" | "failed" | "gone"> {
    const before = await this.#load();
    const pending = before?.pending.find((each) => each.nonce === nonce);
    if (!before || !pending || pending.expires_at <= Date.now()) return "gone";
    if (pending.delivered) return "sent";
    pending.attempts += 1;
    pending.next_attempt_at = Date.now() + Math.min(60_000, 5_000 * 2 ** (pending.attempts - 1));
    void this.ctx.storage.put("grant", before);
    this.#arm(before);
    const { who } = before;
    const state = `${await grantName(who)}.${pending.nonce}`;
    const url = `${AUTHORIZE}?${new URLSearchParams({ client_id: who.app_id, response_type: "code", redirect_uri: pending.redirect, scope: pending.scope.join(" "), state, code_challenge: await challengeOf(pending.verifier), code_challenge_method: "S256" })}`;
    const sent = await sendToPerson(this.env, who.app_id, who.open_id, `invite:${pending.nonce}`, { card: invitationCard(url) }).then(
      () => true,
      () => false,
    );
    // It may have been used, dropped or delivered by another attempt while this one was out.
    const after = await this.#load();
    const same = after?.pending.find((each) => each.nonce === nonce);
    if (after && same && sent && !same.delivered) {
      same.delivered = true;
      void this.ctx.storage.put("grant", after);
    }
    if (after) this.#arm(after);
    if (!same) return "gone";
    return sent || same.delivered ? "sent" : "failed";
  }

  /** Sets the alarm for the earliest invitation still to be delivered, or clears it if there is none. */
  #arm(stored: Stored): void {
    const due = stored.pending.filter((each) => !each.delivered && each.expires_at > Date.now()).map((each) => each.next_attempt_at);
    if (due.length === 0) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...due)));
  }

  /** Tries again to deliver invitations that have not reached the person and can still be used. */
  async alarm(): Promise<void> {
    const stored = await this.#load();
    if (!stored) return;
    for (const each of stored.pending) if (!each.delivered && each.expires_at > Date.now() && each.next_attempt_at <= Date.now()) await this.#send(each.nonce);
    const after = await this.#load();
    if (after) this.#arm(after);
  }

  /**
   * Takes an invitation out of the record, once: what came back from Feishu names it by its nonce.
   * Returns nothing for one that is unknown, used, expired, or from before the grant was dropped.
   */
  async redeem(nonce: string): Promise<{ who: Who; verifier: string; redirect: string; scope: string[]; generation: number } | null> {
    const stored = await this.#load();
    if (!stored) return null;
    const found = stored.pending.find((each) => each.nonce === nonce);
    if (!found) return null;
    stored.pending = stored.pending.filter((each) => each !== found);
    void this.ctx.storage.put("grant", stored);
    if (found.expires_at <= Date.now()) return null;
    return { who: stored.who, verifier: found.verifier, redirect: found.redirect, scope: found.scope, generation: stored.generation };
  }

  /**
   * Keeps the token an authorisation produced, unless the grant has been dropped since it began.
   * Invitations can overlap: one for documents, a later one for wiki pages too, completed in
   * either order. A token that covers no more than a usable one already held changes nothing, so
   * finishing the older, narrower invitation last does not take away what the wider one gave.
   */
  async install(generation: number, token: { access_token: string; expires_at: number; scope: string }): Promise<boolean> {
    // Sealed under a version of its own. All that is awaited comes before the record is read:
    // from the read to the write nothing else can run, so the decision below is about the grant
    // as it is at the moment of writing, however many installs overlap.
    const version = random(16);
    const key = await this.#key();
    const sealed = await seal(key, token.access_token, version);
    // A token already held that can no longer be opened (the key changed) is no reason to turn
    // this one away. Which version that is, is found out here, before the read that decides.
    const earlier = (await this.#load())?.grant;
    const unreadable = earlier && !(await open(key, earlier.sealed, earlier.version).then(() => true, () => false)) ? earlier.version : undefined;
    const stored = await this.#load();
    if (!stored || stored.generation !== generation) return false;
    const has = stored.grant && stored.grant.expires_at - Date.now() >= EXPIRY_MARGIN_MS && stored.grant.version !== unreadable ? stored.grant.scope.split(" ") : undefined;
    if (has && token.scope.split(" ").every((each) => has.includes(each))) return true;
    stored.grant = { sealed, expires_at: token.expires_at, scope: token.scope, version };
    void this.ctx.storage.put("grant", stored);
    return true;
  }

  /**
   * How the grant stands: its generation, and the person's token if they have authorised and it
   * has not expired, with what it covers and the version it is. Whoever uses the token asks
   * `stands` with that version before relying on anything it fetched, and hands the generation
   * back when asking for an invitation.
   */
  async held(): Promise<{ generation: number; credential?: { token: string; version: string; scope: string[] }; unreadable?: string; answered?: string }> {
    const stored = await this.#load();
    const generation = stored?.generation ?? 1;
    const answered = stored?.answered;
    if (!stored?.grant || stored.grant.expires_at - Date.now() < EXPIRY_MARGIN_MS) return { generation, answered };
    try {
      return { generation, answered, credential: { token: await open(await this.#key(), stored.grant.sealed, stored.grant.version), version: stored.grant.version, scope: stored.grant.scope.split(" ").filter(Boolean) } };
    } catch {
      // Sealed under another key, or damaged. It cannot be used; the caller reports its version
      // as refused when asking for an invitation, which forgets exactly this one.
      return { generation, answered, unreadable: stored.grant.version };
    }
  }

  /**
   * The last check before text is handed on: whether the token of this version is still the
   * person's grant. If it is, and the document was taken from an earlier message of theirs
   * rather than from the request itself, that message is noted as answered, so its link is not
   * read again on the strength of some later message.
   */
  async finish(version: string, carriedFrom?: string): Promise<boolean> {
    const stored = await this.#load();
    if (stored?.grant?.version !== version) return false;
    if (carriedFrom !== undefined && stored.answered !== carriedFrom) {
      stored.answered = carriedFrom;
      void this.ctx.storage.put("grant", stored);
    }
    return true;
  }

  /** Whether the token of this version is still the person's grant. */
  async stands(version: string): Promise<boolean> {
    return (await this.#load())?.grant?.version === version;
  }

  /** Forgets the token and closes every open invitation, including ones already on their way back. */
  async drop(who: Who): Promise<void> {
    const stored = await this.#load();
    // Also when nothing is held yet: a request that looked before this and invites after it must
    // find that something changed.
    void this.ctx.storage.put("grant", { who: stored?.who ?? who, generation: (stored?.generation ?? 1) + 1, pending: [] } satisfies Stored);
    void this.ctx.storage.deleteAlarm();
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
