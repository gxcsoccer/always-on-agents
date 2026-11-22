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
 * The invitation to authorise is made here and sent by the Brain, through the person's own
 * conversation: this object names it and, at the moment of sending, makes its card. The link in
 * it is never given to the model or kept by the Brain.
 *
 * Every token kept here has a version of its own. A read that began under one version is not
 * finished, and cannot take the grant away, once another token or none is in its place.
 *
 * Where the person also gave leave for it (`offline_access`), Feishu issues a second token with
 * which a new first one can be had when it runs out. That second token can be used once and is
 * replaced each time, so renewing is done here and nowhere else, one at a time; a renewal whose
 * outcome is not known for certain ends the grant, and the person is asked again.
 *
 * Every authorisation belongs to a generation. Dropping the grant starts a new one, and anything
 * begun in an earlier generation (an invitation still open in a browser, a callback on its way)
 * can no longer install a token.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { registry } from "../registry";
import { scopeName } from "../events";
import { TOKEN_V2, TOKEN_V3 } from "./feishu-api";

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
  /** What the person is asked to allow, and all the token will be asked for. */
  scope: string[];
}

interface Stored {
  who: Who;
  generation: number;
  pending: Pending[];
  grant?: {
    sealed: string;
    expires_at: number;
    scope: string;
    version: string;
    /** How many times this grant's tokens have been replaced by a renewal. Names one access token. */
    rotation?: number;
    /** The token for renewing, sealed; until when it can be used; and which endpoint issued it. */
    refresh?: { sealed: string; expires_at: number; endpoint: "v2" | "v3" };
    /** Set, with the time, just before a renewal is sent, and cleared when its outcome is recorded. */
    renewing?: number;
    /**
     * Since when each permission has been held without a break in this generation. A wider token
     * that replaces a narrower one keeps the earlier time for what the narrower already covered.
     */
    since?: Record<string, number>;
  };
  /** Set with a token that was just kept, until the person's Brain has been told (see `alarm`). */
  owed?: { event: string; attempts: number };
  /**
   * The earlier message whose link has been read on the strength of a later one, and the tool
   * call that read it. See `finish`.
   */
  answered?: { message: string; by: string };
}

const AUTHORIZE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
/**
 * Everything a person is ever asked to allow: reading documents, finding which document a wiki
 * page is, and, where the operator has turned it on for the app, leave to renew without them.
 */
export const OFFLINE = "offline_access";
export const SCOPES = ["docx:document:readonly", "wiki:node:read", OFFLINE];
/** What the caller knew of the grant when it decided an invitation was needed. */
export interface Seen {
  generation: number;
  /**
   * The token Feishu has just refused, if that is why: the grant's version and which of its
   * successive tokens it was. A refusal of a token that has since been replaced by a renewal
   * says nothing about the one held now.
   */
  refused?: { version: string; rotation: number };
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
   * Makes sure there is a usable invitation for this person to authorise `scope`, provided the
   * grant is still as the caller saw it, and names it. If the grant has been dropped, replaced or
   * installed in the meantime there is nothing to invite to: "superseded". A token the caller
   * reports as refused is forgotten here, in the same step, and only if it is still the one held.
   *
   * Nothing is sent from here. The invitation's name goes to the Brain, which puts it in front of
   * the person through the conversation's channel; the card is made when it is sent (see `card`).
   * An invitation that still has time left is named again rather than replaced, so asking twice
   * shows the person one card.
   */
  async invite(who: Who, redirect: string, scope: string[], seen: Seen): Promise<"superseded" | { nonce: string; expires_at: number; generation: number }> {
    if (scope.length === 0 || scope.some((each) => !SCOPES.includes(each))) throw new Error("not a scope this connector asks for");
    const fresh = { nonce: random(32), verifier: random(48) };
    // Nothing is awaited between reading the record and writing it back, so two calls cannot interleave.
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [] };
    if (JSON.stringify(stored.who) !== JSON.stringify(who)) throw new Error("this authorisation belongs to someone else");
    const now = Date.now();
    if (stored.generation !== seen.generation) return "superseded";
    if (seen.refused !== undefined) {
      if (stored.grant?.version !== seen.refused.version || (stored.grant.rotation ?? 0) !== seen.refused.rotation) return "superseded";
      delete stored.grant;
    }
    // Someone has authorised since the caller looked: there is nothing to ask for.
    if (stored.grant && usable(stored.grant, now) && scope.every((each) => stored.grant!.scope.split(" ").includes(each))) return "superseded";
    // An invitation of the other kind (lasting where this asks for a short one, or the reverse) is
    // from before the app's setting changed. It could no longer be completed, so it is closed:
    // not offered again, and its link no longer works.
    const lasting = scope.includes(OFFLINE);
    stored.pending = stored.pending.filter((each) => each.expires_at > now && each.scope.includes(OFFLINE) === lasting);
    let pending = stored.pending.find((each) => each.redirect === redirect && each.expires_at - now > INVITATION_MIN_LEFT_MS && scope.every((wanted) => each.scope.includes(wanted)));
    if (!pending) {
      pending = { ...fresh, redirect, scope, expires_at: now + INVITATION_TTL_MS };
      stored.pending = [...stored.pending, pending].slice(-MAX_PENDING);
    }
    void this.ctx.storage.put("grant", stored);
    return { nonce: pending.nonce, expires_at: pending.expires_at, generation: stored.generation };
  }

  /**
   * The card for one invitation, made at the moment it is sent, or nothing if the invitation has
   * been used, dropped or has run out. This is the only place its link exists outside Feishu.
   */
  async card(nonce: string): Promise<unknown | null> {
    const stored = await this.#load();
    const pending = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || !pending || pending.expires_at <= Date.now()) return null;
    const state = `${await grantName(stored.who)}.${pending.nonce}`;
    const url = `${AUTHORIZE}?${new URLSearchParams({ client_id: stored.who.app_id, response_type: "code", redirect_uri: pending.redirect, scope: pending.scope.join(" "), state, code_challenge: await challengeOf(pending.verifier), code_challenge_method: "S256" })}`;
    return invitationCard(url, pending.scope.includes(OFFLINE));
  }

  /**
   * Whether the person's authorisation covers `scope` now, in this generation, and since when:
   * the answer to "does the condition a read is waiting on hold?". "gone" once the grant has
   * been taken away since: what waited on the earlier one is not carried over to a new one.
   */
  async covers(scope: string[], generation: number): Promise<{ state: "holds"; since: number } | { state: "not_yet" | "gone" }> {
    const stored = await this.#load();
    if ((stored?.generation ?? 1) !== generation) return { state: "gone" };
    const grant = stored?.grant;
    if (!grant || !usable(grant, Date.now()) || scope.some((each) => !grant.scope.split(" ").includes(each))) return { state: "not_yet" };
    // Held since the latest of the times its parts were given. One on record from before these
    // times were kept counts as held all along.
    return { state: "holds", since: Math.max(0, ...scope.map((each) => grant.since?.[each] ?? 0)) };
  }

  /**
   * Tells the person's Brain that their authorisation has changed, until it has heard: owed from
   * the same write that kept the token, so a process that dies in between still gets it said.
   * The Brain takes it as a reason to ask `covers` again, and as nothing more.
   */
  async alarm(): Promise<void> {
    // (Before the Brain sent invitations, this alarm retried cards the grant had not managed to
    // deliver. One left over from then is not sent from here any more: it lapses within minutes,
    // and when the person asks again it is named again and sent by the Brain.)
    const stored = await this.#load();
    if (!stored?.owed) return;
    const { event, attempts } = stored.owed;
    let heard = false;
    try {
      const app = await registry(this.env).feishuApp(stored.who.app_id);
      if (app) heard = (await this.env.BRAIN.getByName(scopeName({ tenant: app.tenant, kind: "user", id: stored.who.open_id })).conditionReported("feishu", await grantName(stored.who), event)).ok;
    } catch {
      heard = false;
    }
    const after = await this.#load();
    if (after?.owed?.event !== event) return;
    // Cleared only when the Brain said it heard. Otherwise tried again, less and less often; after
    // some hours the Brain's own asking (when the person writes, and at the deadline) is all that is left.
    if (heard) delete after.owed;
    else after.owed = { event, attempts: attempts + 1 };
    void this.ctx.storage.put("grant", after);
    if (!heard && attempts < 20) void this.ctx.storage.setAlarm(Date.now() + Math.min(600_000, 15_000 * 2 ** attempts));
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
  async install(generation: number, token: { access_token: string; expires_at: number; scope: string; refresh?: { token: string; expires_at: number; endpoint: "v2" | "v3" } }): Promise<boolean> {
    // Sealed under a version of its own. All that is awaited comes before the record is read:
    // from the read to the write nothing else can run, so the decision below is about the grant
    // as it is at the moment of writing, however many installs overlap.
    const version = random(16);
    const key = await this.#key();
    const sealed = await seal(key, token.access_token, version);
    const refresh = token.refresh ? { sealed: await seal(key, token.refresh.token, `${version}:refresh`), expires_at: token.refresh.expires_at, endpoint: token.refresh.endpoint } : undefined;
    // A token already held that can no longer be opened (the key changed) is no reason to turn
    // this one away. Which version that is, is found out here, before the read that decides.
    const before = (await this.#load())?.grant;
    const unreadable = before && !(await open(key, before.sealed, before.version).then(() => true, () => false)) ? before.version : undefined;
    const stored = await this.#load();
    if (!stored || stored.generation !== generation) return false;
    const has = stored.grant && usable(stored.grant, Date.now()) && stored.grant.version !== unreadable ? stored.grant.scope.split(" ") : undefined;
    if (has && token.scope.split(" ").every((each) => has.includes(each))) return true;
    // What the token it replaces already covered, and still could, has been held since then.
    const earlier = stored.grant && usable(stored.grant, Date.now()) && stored.grant.version !== unreadable ? stored.grant : undefined;
    const since = Object.fromEntries(token.scope.split(" ").filter(Boolean).map((each) => [each, (earlier?.scope.split(" ").includes(each) ? earlier.since?.[each] : undefined) ?? Date.now()]));
    stored.grant = { sealed, expires_at: token.expires_at, scope: token.scope, version, since, ...(refresh ? { refresh } : {}) };
    stored.owed = { event: version, attempts: 0 };
    void this.ctx.storage.put("grant", stored);
    void this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  /** One renewal at a time: everyone who needs the token while it is being renewed waits for the same one. */
  #renewal?: Promise<void>;

  /**
   * Gets a new token with the one kept for that, if the first has run out. Feishu lets the second
   * token be used once and replaces it, so this must not run twice at once, and must not lose
   * what comes back.
   *
   * Before the request goes out, the grant is marked as being renewed. If the answer is a new
   * pair of tokens for exactly what the person allowed, they replace the old pair in one write.
   * In every other case (refused, an answer that cannot be read, no answer, a grant found still
   * marked from an attempt that never finished) it cannot be relied on that the old second token
   * still works, so the grant ends and the person is asked again. The grant keeps its version
   * through a renewal: it is the same authorisation.
   */
  async #renew(): Promise<void> {
    const key = await this.#key();
    const first = await this.#load();
    const grant = first?.grant;
    if (!first || !grant || grant.expires_at - Date.now() >= EXPIRY_MARGIN_MS) return;
    const end = async (why: string, answer?: { status: number; code?: unknown }) => {
      const stored = await this.#load();
      // Only the grant this attempt was about. One installed or dropped meanwhile is left alone.
      if (stored?.generation === first.generation && stored.grant?.version === grant.version) {
        delete stored.grant;
        void this.ctx.storage.put("grant", stored);
      }
      const code = answer && typeof answer.code === "number" && Number.isInteger(answer.code) ? answer.code : undefined;
      console.log(JSON.stringify({ feishu_grant_not_renewed: why, app: first.who.app_id, ...(answer ? { status: answer.status, ...(code !== undefined ? { code } : {}) } : {}) }));
    };
    if (!grant.refresh || grant.refresh.expires_at - Date.now() < EXPIRY_MARGIN_MS) return;
    // Left marked by an attempt that was cut off: whether Feishu used up the token is not known.
    if (grant.renewing !== undefined) return end("outcome_unknown");
    let token: string;
    try {
      token = await open(key, grant.refresh.sealed, `${grant.version}:refresh`);
    } catch {
      return end("unreadable");
    }
    const app = await registry(this.env).feishuApp(first.who.app_id);
    if (!app) return end("unknown_app");
    // The operator has turned lasting authorisations off for this app: nothing is renewed any
    // more, and the token for renewing is not kept. The person is invited afresh when they next ask.
    if (!app.oauth_offline) {
      const off = await this.#load();
      if (off?.generation === first.generation && off.grant?.version === grant.version && off.grant.refresh?.sealed === grant.refresh.sealed) {
        delete off.grant.refresh;
        void this.ctx.storage.put("grant", off);
      }
      return;
    }

    // Marked in one step with the check that it is still the same grant and still unmarked.
    const marked = await this.#load();
    if (marked?.generation !== first.generation || marked.grant?.version !== grant.version || marked.grant.renewing !== undefined || marked.grant.refresh?.sealed !== grant.refresh.sealed) return;
    marked.grant.renewing = Date.now();
    void this.ctx.storage.put("grant", marked);

    // The older endpoint only renews what it issued itself; the current one renews either.
    const endpoint = app.oauth_v2 && grant.refresh.endpoint === "v2" ? "v2" : "v3";
    // Asked for exactly what the person allowed, never for all they ever allowed this app.
    const response = await fetch(endpoint === "v2" ? TOKEN_V2 : TOKEN_V3, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: app.app_id, client_secret: app.app_secret, refresh_token: token, scope: grant.scope }),
    }).catch(() => undefined);
    if (!response) return end("no_answer");
    const issued = (((await response.json().catch(() => null)) as unknown) ?? {}) as { code?: number; access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string };
    if (typeof issued !== "object") return end("refused", { status: response.status });
    if (!response.ok || issued.code !== 0) return end("refused", { status: response.status, code: issued.code });
    // A pair that is whole and has time left, or nothing.
    if (typeof issued.access_token !== "string" || !issued.access_token || typeof issued.refresh_token !== "string" || !issued.refresh_token || !lifetime(issued.expires_in) || !lifetime(issued.refresh_token_expires_in)) return end("malformed", { status: response.status });
    // For exactly what the person allowed: the same set, no more, no less, nothing twice.
    if (!sameSet(String(issued.scope ?? "").split(/\s+/).filter(Boolean), grant.scope.split(" ").filter(Boolean))) return end("scope_changed");

    // The operator may have turned lasting authorisations off while Feishu was answering. Then
    // the new pair is not kept: the grant is left to lapse, without a token for renewing.
    const still = await registry(this.env).feishuApp(first.who.app_id);
    if (!still?.oauth_offline) {
      const off = await this.#load();
      if (off?.generation === first.generation && off.grant?.version === grant.version) {
        delete off.grant.refresh;
        delete off.grant.renewing;
        void this.ctx.storage.put("grant", off);
      }
      console.log(JSON.stringify({ feishu_grant_not_renewed: "turned_off", app: first.who.app_id }));
      return;
    }
    const sealed = await seal(key, issued.access_token, grant.version);
    const refresh = { sealed: await seal(key, issued.refresh_token, `${grant.version}:refresh`), expires_at: Date.now() + lifetime(issued.refresh_token_expires_in) * 1_000, endpoint } as const;
    const stored = await this.#load();
    // Dropped or replaced while Feishu was answering: the new pair belongs to a grant that is gone.
    if (stored?.generation !== first.generation || stored.grant?.version !== grant.version) return;
    stored.grant = { sealed, expires_at: Date.now() + lifetime(issued.expires_in) * 1_000, scope: grant.scope, version: grant.version, rotation: (grant.rotation ?? 0) + 1, refresh, ...(grant.since === undefined ? {} : { since: grant.since }) };
    void this.ctx.storage.put("grant", stored);
  }

  /**
   * How the grant stands: its generation, and the person's token if they have authorised and it
   * has not expired, with what it covers and the version it is. Whoever uses the token asks
   * `stands` with that version before relying on anything it fetched, and hands the generation
   * back when asking for an invitation.
   */
  async held(): Promise<{ generation: number; credential?: { token: string; version: string; rotation: number; scope: string[] }; unreadable?: { version: string; rotation: number }; answered?: { message: string; by: string } }> {
    let stored = await this.#load();
    // The generation the caller is told is the one found on arrival. If the grant is taken away
    // while this waits for a renewal, the caller must find that out when it next asks for
    // anything, not be handed the new generation as though it had looked after the change.
    const generation = stored?.generation ?? 1;
    // Run out, but renewable: renewed first, by one renewal however many are waiting.
    if (stored?.grant && stored.grant.expires_at - Date.now() < EXPIRY_MARGIN_MS && stored.grant.refresh) {
      this.#renewal ??= this.#renew().finally(() => (this.#renewal = undefined));
      await this.#renewal;
      stored = await this.#load();
    }
    const answered = stored?.answered;
    if (!stored?.grant || stored.generation !== generation || stored.grant.expires_at - Date.now() < EXPIRY_MARGIN_MS) return { generation, answered };
    const rotation = stored.grant.rotation ?? 0;
    try {
      return { generation, answered, credential: { token: await open(await this.#key(), stored.grant.sealed, stored.grant.version), version: stored.grant.version, rotation, scope: stored.grant.scope.split(" ").filter(Boolean) } };
    } catch {
      // Sealed under another key, or damaged. It cannot be used; the caller reports it as refused
      // when asking for an invitation, which forgets exactly this one.
      return { generation, answered, unreadable: { version: stored.grant.version, rotation } };
    }
  }

  /**
   * The last check before text is handed on: whether the token of this version is still the
   * person's grant ("superseded" if not). If the document was taken from an earlier message of
   * theirs rather than from the request itself, that message is noted here as answered by this
   * call, so its link is not read again on the strength of some later message: another call
   * finds it "taken". The same call asking again, after an interruption lost what it was given,
   * is let through.
   */
  async finish(version: string, carried?: { message: string; by: string }): Promise<"ok" | "superseded" | "taken"> {
    const stored = await this.#load();
    if (stored?.grant?.version !== version) return "superseded";
    if (!carried) return "ok";
    if (stored.answered?.message === carried.message) return stored.answered.by === carried.by ? "ok" : "taken";
    stored.answered = carried;
    void this.ctx.storage.put("grant", stored);
    return "ok";
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
  async status(): Promise<{ authorised: boolean; expires_at?: number; renewable_until?: number; scope?: string; pending: number }> {
    const stored = await this.#load();
    const live = stored?.grant && usable(stored.grant, Date.now(), 0) ? stored.grant : undefined;
    return { authorised: Boolean(live), ...(live ? { expires_at: live.expires_at, ...(live.refresh ? { renewable_until: live.refresh.expires_at } : {}), scope: live.scope } : {}), pending: stored?.pending.filter((each) => each.expires_at > Date.now()).length ?? 0 };
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

function invitationCard(url: string, lasting: boolean): unknown {
  const plain = (content: string) => ({ tag: "plain_text", content });
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: plain("需要你的授权") },
    elements: [
      { tag: "div", text: plain("要读取你的飞书文档，需要你先授权。授权后我只能以你的身份读取文档，你打不开的文档我也读不到。") },
      { tag: "action", actions: [{ tag: "button", text: plain("去授权"), type: "primary", url }] },
      // Said before it is given: this authorisation renews itself, and how to end it.
      ...(lasting ? [{ tag: "div", text: plain("这次授权会长期有效：到期后我会自动续期，不再每次请你授权，直到被解除或满一年。需要解除时，可以在飞书的授权管理里取消，或联系管理员。") }] : []),
      { tag: "note", elements: [plain("链接 10 分钟内有效，只对你本人有效。授权完成后我会接着处理，你不用再发一遍。")] },
    ],
  };
}

/** Whether a grant can still produce a token: its own has time left, or it can be renewed. */
function usable(grant: NonNullable<Stored["grant"]>, now: number, margin = EXPIRY_MARGIN_MS): boolean {
  return grant.expires_at - now >= margin || (grant.refresh !== undefined && grant.refresh.expires_at - now >= margin);
}

/** A lifetime in seconds as Feishu states it, or 0 if it is not a positive number. */
export function lifetime(seconds: unknown): number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** Whether two lists name the same things, each once. */
export function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && a.every((each) => b.includes(each));
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
