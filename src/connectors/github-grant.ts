/**
 * GitHub as the person: what the agent does on GitHub in a person's own name, where they ask for
 * it in a chat, under an authorisation they gave the deployment's GitHub App themselves.
 *
 * This plugs into a chat connector (see `Connector.serves`): the chat says who the person is, and
 * this adds something the agent can do for them. One thing so far: opening an issue.
 *
 * What the person gives is a user access token of the App. It can do whatever the App may do,
 * wherever the person may: more than opening issues. What keeps it to that is this code, which
 * makes one write, to one fixed route, with a title and a body; the token is kept in the person's
 * grant object, sealed, and is used there and nowhere else. See
 * docs/design/github-as-the-person.zh-CN.md.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { type InboundEvent, type Scope, scopeName } from "../events";
import { registry } from "../registry";
import { chatFactsFor } from "./feishu-api";
import { chatIs } from "./feishu-docs";
import { challengeOf, grantsKey, lifetime, open, random, seal } from "./feishu-grant";
import { githubTokenFor } from "./github-app";
import type { ConnectorTool, Holds, Invitation, ToolContext, Waiting } from "./types";

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
const INVITATION_TTL_MS = 10 * 60_000;
/** How long an invitation is kept after its time: for as long as a request could still wait on it. */
const INVITATION_KEPT_MS = 60 * 60_000;
const MAX_INVITATIONS = 100;
/** One limit for the whole of a request, whatever it waits on. */
const LIMIT_MS = 60 * 60_000;
const KEPT_AFTER_MS = 2 * 60 * 60_000;
const EXPIRY_MARGIN_MS = 60_000;
const MAX_OPS = 30;
const MAX_TITLE = 256;
const MAX_BODY = 30_000;

/** A person as the chat connector verified them, in one tenant. */
interface Who {
  tenant: string;
  chat_app_id: string;
  tenant_key: string;
  open_id: string;
}

/**
 * One issue asked for: what is to be created, fixed as it is first asked for, and how far it got.
 * "asked": nothing sent. "posting": about to be sent, or sent and not heard back. "posted": it is
 * there. "lost": it may or may not be there. "failed": it is certainly not there.
 */
export interface Op {
  repo: string;
  /** The repository by GitHub's own number: a name can come to mean another one. */
  repo_id: number;
  private: boolean;
  title: string;
  body: string;
  stage: "asked" | "posting" | "posted" | "lost" | "failed";
  why?: string;
  issue?: { number: number; url: string };
  created_at: number;
  deadline: number;
  generation: number;
  /** The conversation it was asked in, by the scope name of its Brain. */
  brain?: string;
}
const ENDED: Op["stage"][] = ["posted", "lost", "failed"];

interface Stored {
  who: Who;
  generation: number;
  pending: { nonce: string; verifier: string; redirect: string; expires_at: number; state?: "taken" | "done" | "refused"; at?: number; brain?: string; call?: string; what?: { text: string; where: "private" | "chat" } }[];
  /** `refresh`: absent where the App's tokens do not run out. `account`: whose it is on GitHub, by number. */
  grant?: { access: string; refresh?: string; version: string; expires_at: number; refresh_expires_at?: number; since: number; account: number; login: string };
  /** Word owed of a change, to each conversation that waits on this person's authorisation, until each has heard. */
  owed?: { event: string; attempts: number; to: string[] };
}

type Issued = { access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number };

const same = (a: Who, b: Who) => a.tenant === b.tenant && a.chat_app_id === b.chat_app_id && a.tenant_key === b.tenant_key && a.open_id === b.open_id;
const headersFor = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "always-on-agent", "x-github-api-version": "2022-11-28" });
/** One call to GitHub's API. A redirect is not followed: the token goes to the address asked and no other. */
const github = (token: string, path: string, init: RequestInit = {}) => fetch(`${API}${path}`, { ...init, redirect: "manual", headers: { ...headersFor(token), ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(20_000) });

function tokensOf(issued: Issued, now: number) {
  // An App whose tokens do not run out gives no lifetime and nothing to renew with.
  return { expires_at: lifetime(issued.expires_in) ? now + lifetime(issued.expires_in) * 1_000 : Number.MAX_SAFE_INTEGER, ...(lifetime(issued.refresh_token_expires_in) ? { refresh_expires_at: now + lifetime(issued.refresh_token_expires_in) * 1_000 } : {}) };
}

export class GithubGrant extends DurableObject<Env> {
  /** Renewals and sends under way in this instance: a second asker waits for the first, and nothing is done twice. */
  #renewing?: Promise<string | undefined>;
  #posting = new Map<string, Promise<Op | "unauthorised" | undefined>>();

  /** Makes an invitation for this person to authorise, for one request. */
  async invite(who: Who, redirect: string, generation: number, what: { brain: string; call: string; text: string; where: "private" | "chat" }): Promise<"superseded" | "full" | { nonce: string; expires_at: number; generation: number }> {
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [] };
    if (!same(stored.who, who)) throw new Error("this authorisation belongs to someone else");
    if (stored.generation !== generation || (stored.grant && this.#usable(stored.grant))) return "superseded";
    const now = Date.now();
    stored.pending = stored.pending.filter((each) => each.expires_at + INVITATION_KEPT_MS > now);
    // One for each request: the card says which it is for. The same call made again has the same one.
    let pending = stored.pending.find((each) => !each.state && each.redirect === redirect && each.expires_at - now > 3 * 60_000 && each.brain === what.brain && each.call === what.call);
    if (!pending) {
      if (stored.pending.length >= MAX_INVITATIONS) return "full";
      pending = { nonce: random(32), verifier: random(48), redirect, expires_at: now + INVITATION_TTL_MS, brain: what.brain, call: what.call, what: { text: what.text.slice(0, 80), where: what.where } };
      stored.pending = [...stored.pending, pending];
    }
    void this.ctx.storage.put("grant", stored);
    return { nonce: pending.nonce, expires_at: pending.expires_at, generation: stored.generation };
  }

  /** What to show for one invitation, made as it is sent; null once it can no longer be used. */
  async card(name: string, nonce: string): Promise<Invitation | null> {
    const stored = await this.#load();
    const pending = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || !pending || pending.state || pending.expires_at <= Date.now() || !this.env.GITHUB_CLIENT_ID) return null;
    if (stored.grant && this.#usable(stored.grant)) return null;
    const about = pending.what ? `\n\n这次是为了你说的：「${pending.what.text}」。${pending.what.where === "chat" ? "这是你在群里提出的，结果会回到那个群里；仓库不公开、也没有绑定给那个群时，链接只私聊发你。" : "结果会发在你和我的这个私聊里。"}` : "";
    const url = `${AUTHORIZE}?${new URLSearchParams({ client_id: this.env.GITHUB_CLIENT_ID, redirect_uri: pending.redirect, state: `${name}.${pending.nonce}`, code_challenge: await challengeOf(pending.verifier), code_challenge_method: "S256" })}`;
    return {
      title: "需要你的 GitHub 授权",
      text: `要以你的名义在 GitHub 上建 issue，需要你先授权。\n\n授权是给这个 GitHub 应用的：它在 GitHub 上被允许做的事，在你有权限的仓库里都能以你的身份做，不只是建 issue。我只用它来做你明确要求的这件事。${about}`,
      action: { label: "去授权", url },
      note: "链接 10 分钟内有效，只对你本人有效。授权完成后我会接着处理，你不用再发一遍。之后随时可以在 GitHub 的 Settings → Applications 里撤销。",
    };
  }

  /** Takes an invitation out, once. */
  async redeem(nonce: string): Promise<{ who: Who; verifier: string; redirect: string; generation: number } | null> {
    const stored = await this.#load();
    const found = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || !found || found.state || found.expires_at <= Date.now()) return null;
    if (stored.grant && this.#usable(stored.grant)) return null;
    found.state = "taken";
    void this.ctx.storage.put("grant", stored);
    return { who: stored.who, verifier: found.verifier, redirect: found.redirect, generation: stored.generation };
  }

  /** Keeps what an authorisation produced, unless the grant was taken away since it began. */
  async install(nonce: string, generation: number, issued: Issued, account: { id: number; login: string }): Promise<boolean> {
    const key = await this.#key();
    const version = random(16);
    const access = await seal(key, issued.access_token, version);
    const refresh = issued.refresh_token ? await seal(key, issued.refresh_token, version) : undefined;
    const stored = await this.#load();
    const through = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || stored.generation !== generation || through?.state !== "taken") return false;
    const now = Date.now();
    through.state = "done";
    through.at = now;
    stored.grant = { access, ...(refresh ? { refresh } : {}), version, ...tokensOf(issued, now), since: now, account: account.id, login: account.login };
    stored.owed = this.#owed(stored, version);
    void this.ctx.storage.put("grant", stored);
    void this.ctx.storage.setAlarm(now);
    return true;
  }

  /** An invitation someone came back through came to nothing. Says how it stands after this. */
  async refuse(nonce: string): Promise<"done" | "refused" | undefined> {
    const stored = await this.#load();
    const through = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || !through || through.state !== "taken") return through?.state === "done" || through?.state === "refused" ? through.state : undefined;
    through.state = "refused";
    stored.owed = this.#owed(stored, `refused:${nonce}`);
    void this.ctx.storage.put("grant", stored);
    void this.ctx.storage.setAlarm(Date.now());
    return "refused";
  }

  /** Whether the person's authorisation stands now, for a request that was shown one invitation. */
  async covers(generation: number, nonce: string): Promise<Holds> {
    const stored = await this.#load();
    if ((stored?.generation ?? 1) !== generation) return { state: "gone" };
    const shown = stored?.pending.find((each) => each.nonce === nonce);
    if (!shown) return { state: "gone" };
    if (shown.state === "refused") return { state: "gone", refused: true };
    if (shown.state === "taken") return { state: "not_yet", again_in_ms: 3_000 };
    if (!stored?.grant || !this.#usable(stored.grant)) return { state: "not_yet" };
    return { state: "holds", since: shown.state === "done" && shown.at ? Math.min(shown.at, stored.grant.since) : stored.grant.since };
  }

  /** Which generation this is, and whether there is a token to act with now (renewed, if it had run out and can be). */
  async standing(): Promise<{ generation: number; authorised: boolean }> {
    const stored = await this.#load();
    return { generation: stored?.generation ?? 1, authorised: (await this.#token()) !== undefined };
  }

  /** Forgets the tokens and closes every open invitation. Only here: GitHub's own record of the authorisation is the person's to remove. */
  async drop(): Promise<void> {
    const stored = await this.#load();
    if (!stored) return;
    const owed = this.#owed(stored, `dropped:${stored.generation + 1}`);
    void this.ctx.storage.put("grant", { ...stored, generation: stored.generation + 1, pending: [], grant: undefined, owed });
    void this.ctx.storage.setAlarm(Date.now());
  }

  /** For the operator: whether there is a grant and for which account. Never a token, nor what was asked. */
  async status(): Promise<{ authorised: boolean; account?: number; login?: string; pending: number; issues: Record<string, number> }> {
    const stored = await this.#load();
    const issues: Record<string, number> = {};
    for (const each of (await this.ctx.storage.list<Op>({ prefix: "op:" })).values()) issues[each.stage] = (issues[each.stage] ?? 0) + 1;
    return { authorised: Boolean(stored?.grant && this.#usable(stored.grant)), ...(stored?.grant ? { account: stored.grant.account, login: stored.grant.login } : {}), pending: stored?.pending.filter((each) => !each.state && each.expires_at > Date.now()).length ?? 0, issues };
  }

  async op(call: string): Promise<Op | undefined> {
    return this.ctx.storage.get<Op>(`op:${call}`);
  }

  /** Keeps an issue as it is first asked for. Asked for again by the same call, it is the one kept, as it was kept. */
  async begin(who: Who, call: string, what: Pick<Op, "repo" | "repo_id" | "private" | "title" | "body">, brain: string): Promise<Op | "full"> {
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [] };
    if (!same(stored.who, who)) throw new Error("this record belongs to someone else");
    const before = await this.op(call);
    if (before) return before;
    const now = Date.now();
    const kept = [...(await this.ctx.storage.list<Op>({ prefix: "op:" })).entries()].sort(([, a], [, b]) => a.created_at - b.created_at);
    // One is dropped only once nothing can ask about it again.
    for (let over = kept.length - MAX_OPS + 1; over > 0; over--) {
      const oldest = kept.findIndex(([, each]) => now >= each.deadline + KEPT_AFTER_MS);
      if (oldest < 0) return "full";
      void this.ctx.storage.delete(kept.splice(oldest, 1)[0][0]);
    }
    const op: Op = { ...what, stage: "asked", created_at: now, deadline: now + LIMIT_MS, generation: stored.generation, brain };
    void this.ctx.storage.put("grant", stored);
    void this.ctx.storage.put(`op:${call}`, op);
    return op;
  }

  /**
   * Creates the issue of one call, once: as the person, in the repository it was asked for, with
   * the title and body it was kept with. Asked again while that is under way, it is the same
   * sending. "unauthorised": there is no token to act with (any more); nothing was created.
   */
  post(call: string): Promise<Op | "unauthorised" | undefined> {
    const under = this.#posting.get(call);
    if (under) return under;
    const going = this.#post(call).finally(() => this.#posting.delete(call));
    this.#posting.set(call, going);
    return going;
  }

  async #post(call: string): Promise<Op | "unauthorised" | undefined> {
    const op = await this.op(call);
    if (!op || ENDED.includes(op.stage)) return op;
    const end = async (stage: Op["stage"], more: Partial<Op> = {}) => {
      const now: Op = { ...op, ...more, stage };
      await this.ctx.storage.put(`op:${call}`, now);
      return now;
    };
    const stands = async () => (await this.#load())?.generation === op.generation;
    const mark = await markOf(this.ctx.id.toString(), call);
    // It was being sent once already (this instance was interrupted): it may be there.
    if (op.stage === "posting") {
      const held = await this.#token();
      const found = held ? await this.#find(held, op, mark) : undefined;
      return found ? end("posted", { issue: found }) : end("lost");
    }
    if (!(await stands())) return end("failed", { why: "changed" });
    if (Date.now() >= op.deadline) return end("failed", { why: "late" });
    const held = await this.#token();
    if (!held) return "unauthorised";
    // The name still means the repository it was asked for, and the person can see it.
    let seen: Response;
    try {
      seen = await github(held.token, `/repos/${op.repo}`);
    } catch {
      return end("failed", { why: "unreachable" });
    }
    if (seen.status === 401) return await this.#refused(held.version), "unauthorised";
    const repository = seen.ok ? ((await seen.json().catch(() => null)) as { id?: unknown } | null) : null;
    if (!repository) return end("failed", { why: seen.status === 404 || seen.status === 403 ? "no_access" : seen.status >= 300 && seen.status < 400 ? "moved" : "unreachable" });
    if (repository.id !== op.repo_id) return end("failed", { why: "moved" });
    // The last thing before the send: what it was asked under still stands, and its time is not up.
    if (!(await stands())) return end("failed", { why: "changed" });
    if (Date.now() >= op.deadline) return end("failed", { why: "late" });
    await this.ctx.storage.put(`op:${call}`, { ...op, stage: "posting" } satisfies Op);
    let sent: Response | undefined;
    try {
      sent = await github(held.token, `/repos/${op.repo}/issues`, { method: "POST", body: JSON.stringify({ title: op.title, body: `${op.body}\n\n${mark}`.trim() }) });
    } catch {
      // No answer: it may have been taken.
    }
    if (sent?.status === 201) {
      const made = (await sent.json().catch(() => null)) as { number?: unknown; html_url?: unknown } | null;
      if (made && typeof made.number === "number" && typeof made.html_url === "string") return end("posted", { issue: { number: made.number, url: made.html_url } });
    }
    // Turned away outright: nothing was created.
    if (sent?.status === 401) return await this.#refused(held.version), await end("asked"), "unauthorised";
    if (sent && [403, 404, 410, 422].includes(sent.status)) return end("failed", { why: sent.status === 410 ? "issues_off" : sent.status === 422 ? "not_accepted" : "no_access" });
    // Anything else is not an answer about whether it was created: looked for, once, by its mark.
    const found = await this.#find(held, op, mark);
    return found ? end("posted", { issue: found }) : end("lost");
  }

  /** The issue of one call, if it is there: in that repository, by this person, carrying that call's mark. Nothing where it is not found, or could not be looked for. */
  async #find(held: { token: string; account: number; login: string }, op: Op, mark: string): Promise<Op["issue"] | undefined> {
    try {
      const listed = await github(held.token, `/repos/${op.repo}/issues?${new URLSearchParams({ creator: held.login, state: "all", since: new Date(op.created_at - 60_000).toISOString(), per_page: "100" })}`);
      if (!listed.ok) return undefined;
      const issues = (await listed.json()) as { number?: unknown; html_url?: unknown; body?: unknown; user?: { id?: unknown }; pull_request?: unknown; repository_url?: unknown }[];
      const found = (Array.isArray(issues) ? issues : []).find((each) => !each.pull_request && each.user?.id === held.account && typeof each.body === "string" && each.body.includes(mark));
      return found && typeof found.number === "number" && typeof found.html_url === "string" ? { number: found.number, url: found.html_url } : undefined;
    } catch {
      return undefined;
    }
  }

  /** The token to act with now. Renewed first where it has run out and can be: one renewal at a time, since GitHub takes what renews a token once only. */
  async #token(): Promise<{ token: string; version: string; account: number; login: string } | undefined> {
    const stored = await this.#load();
    const grant = stored?.grant;
    if (!grant) return undefined;
    const of = (token: string, now = grant) => ({ token, version: now.version, account: now.account, login: now.login });
    try {
      // (Still good by itself, as against only renewable.)
      if (grant.expires_at - EXPIRY_MARGIN_MS > Date.now()) return of(await open(await this.#key(), grant.access, grant.version));
    } catch {
      return undefined;
    }
    if (!grant.refresh || (grant.refresh_expires_at ?? 0) <= Date.now()) return undefined;
    this.#renewing ??= this.#renew(grant.version).finally(() => (this.#renewing = undefined));
    const token = await this.#renewing;
    const now = (await this.#load())?.grant;
    return token && now ? of(token, now) : undefined;
  }

  async #renew(version: string): Promise<string | undefined> {
    const stored = await this.#load();
    const grant = stored?.grant;
    if (!stored || !grant?.refresh || grant.version !== version || !this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET) return undefined;
    const key = await this.#key();
    let issued: (Partial<Issued> & { error?: string }) | null;
    try {
      const response = await fetch(TOKEN, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.env.GITHUB_CLIENT_ID, client_secret: this.env.GITHUB_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: await open(key, grant.refresh, grant.version) }), signal: AbortSignal.timeout(20_000) });
      issued = (await response.json().catch(() => null)) as typeof issued;
      // No answer worth the name: what is held may still be good, and is kept.
      if (!response.ok || !issued) return undefined;
    } catch {
      return undefined;
    }
    const after = await this.#load();
    if (!after?.grant || after.grant.version !== version || after.generation !== stored.generation) return undefined;
    if (typeof issued.access_token !== "string" || !issued.access_token) {
      // GitHub said no to what was held: it is of no use any more.
      delete after.grant;
      void this.ctx.storage.put("grant", after);
      return undefined;
    }
    const next = random(16);
    const now = Date.now();
    after.grant = { ...after.grant, access: await seal(key, issued.access_token, next), refresh: issued.refresh_token ? await seal(key, issued.refresh_token, next) : undefined, version: next, ...tokensOf(issued as Issued, now) };
    await this.ctx.storage.put("grant", after);
    return issued.access_token;
  }

  /** Forgets a token GitHub turned away, if it is still the one held. */
  async #refused(version: string): Promise<void> {
    const stored = await this.#load();
    if (!stored || stored.grant?.version !== version) return;
    delete stored.grant;
    await this.ctx.storage.put("grant", stored);
  }

  /** Whether there is something to act with: a token still good, or one that can be renewed. */
  #usable(grant: NonNullable<Stored["grant"]>): boolean {
    return grant.expires_at - EXPIRY_MARGIN_MS > Date.now() || (grant.refresh !== undefined && (grant.refresh_expires_at ?? 0) - EXPIRY_MARGIN_MS > Date.now());
  }

  /** Word owed of a change: to each conversation an invitation that still has time came from. */
  #owed(stored: Stored, event: string): NonNullable<Stored["owed"]> {
    const now = Date.now();
    return { event, attempts: 0, to: [...new Set(stored.pending.filter((each) => each.expires_at + INVITATION_KEPT_MS > now).map((each) => each.brain).filter((each): each is string => typeof each === "string"))] };
  }

  /** Tells each conversation that is owed word, until each has heard. */
  async alarm(): Promise<void> {
    const stored = await this.#load();
    if (!stored?.owed) return;
    const { event, attempts } = stored.owed;
    const name = await grantName(stored.who);
    const heard = await Promise.all(stored.owed.to.map((each) => this.env.BRAIN.getByName(each).conditionReported("feishu", name, event).then((answer) => answer.ok, () => false)));
    const left = stored.owed.to.filter((_each, index) => !heard[index]);
    const after = await this.#load();
    if (after?.owed?.event !== event) return;
    if (left.length === 0) delete after.owed;
    else after.owed = { event, attempts: attempts + 1, to: left };
    void this.ctx.storage.put("grant", after);
    if (after.owed) void this.ctx.storage.setAlarm(Date.now() + Math.min(600_000, 15_000 * 2 ** Math.min(attempts, 10)));
  }

  #load(): Promise<Stored | undefined> {
    return this.ctx.storage.get<Stored>("grant");
  }

  async #key(): Promise<CryptoKey> {
    const secret = grantsKey(this.env);
    if (!secret) throw new Error("GRANTS_KEY is not set");
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("always-on-agents github grant"), info: new TextEncoder().encode(this.ctx.id.toString()) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
}

const hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** What an issue carries so that it can be found again: made from the call alone, it shows nothing in the page and says nothing of who asked. */
async function markOf(grant: string, call: string): Promise<string> {
  return `<!-- request:${(await hex(JSON.stringify(["github issue", grant, call]))).slice(0, 32)} -->`;
}

/** The name of the object that holds this person's grant: theirs in that tenant, under that chat app. */
export function grantName(who: Who): Promise<string> {
  return hex(JSON.stringify(["github", who.tenant, who.chat_app_id, who.tenant_key, who.open_id]));
}

function redirectUri(env: Env): string | undefined {
  const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/, "");
  return origin && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin) ? `${origin}/v1/github/oauth/callback` : undefined;
}

const setUp = (env: Env) => Boolean(redirectUri(env) && grantsKey(env) && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

/**
 * The repository as GitHub has it now, if it is one this tenant has connected: covered by an
 * installation of the App that belongs to the tenant, or (where no App is configured) linked to
 * the tenant by the operator. Asked with the tenant's own credential for it, never the person's:
 * that the person can reach a repository does not make it this tenant's.
 */
async function repositoryOf(env: Env, tenant: string, repo: string): Promise<{ id: number; private: boolean; name: string } | "not_connected" | "unknown"> {
  const linked = await registry(env).githubRepo(repo);
  if (linked && linked.tenant !== tenant) return "not_connected";
  const app = Boolean(env.GITHUB_APP_ID || env.GITHUB_APP_PRIVATE_KEY);
  if (!app && !linked) return "not_connected";
  try {
    const credential = await githubTokenFor(env, tenant, repo);
    if (!credential) return "not_connected";
    const seen = await github(credential.token, `/repos/${repo}`);
    if (seen.status === 404 || (seen.status >= 300 && seen.status < 400)) return "not_connected";
    const found = seen.ok ? ((await seen.json().catch(() => null)) as { id?: unknown; private?: unknown; full_name?: unknown } | null) : null;
    return found && typeof found.id === "number" && typeof found.private === "boolean" && typeof found.full_name === "string" && found.full_name.toLowerCase() === repo.toLowerCase() ? { id: found.id, private: found.private, name: found.full_name } : "unknown";
  } catch {
    return "unknown";
  }
}

const CHANGED = { error: "the person's GitHub authorisation changed while this was under way; nothing was created. They can ask again" };
const UNCERTAIN = "it could not be confirmed whether the issue was created; nothing more was sent, so that it is not created twice. The person can look at the repository's issues, and ask again if it is not there";
const WHY: Record<string, string> = {
  changed: CHANGED.error,
  late: "this was not done in time; nothing was created. The person can ask again",
  unreachable: "GitHub could not be reached; nothing was created. The person can ask again",
  no_access: "GitHub did not let the person open an issue in that repository (they may not have access to it, or the GitHub App may not be allowed there); nothing was created",
  moved: "that name no longer means the repository it meant when this was asked; nothing was created. The person can ask again, naming the repository as it is called now",
  issues_off: "issues are turned off in that repository; nothing was created",
  not_accepted: "GitHub did not accept the issue as written; nothing was created",
};

export const githubCreateIssue: ConnectorTool = {
  name: "github_create_issue",
  description:
    "Opens an issue on GitHub as the person who asked, in their own name. Only when they ask for one outright, in a repository they named themselves (`repo`, as owner/name). They are asked to authorise the first time; nothing else is asked of them before it is created, so do not ask them to confirm. Write `title` and `body` from what the person themselves said and pointed at, and from nothing else in this conversation: no one else's words or names, nothing from other topics, nothing read from documents. If it is not plain which matter they mean, ask which.",
  effect: "act",
  optional: true,
  // Also where several people talk: for the one who asked, as them.
  shared: true,
  parameters: { repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
  run: createIssue,
};

async function createIssue(context: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const { env, origin, scope } = context;
  if (scope.kind !== "user" && scope.kind !== "chat") return { error: "this can only be done for one person, where they talk to the agent" };
  const redirect = redirectUri(env);
  if (!redirect || !setUp(env)) return { error: "acting on GitHub as a person is not set up on this deployment" };
  const app = await registry(env).feishuApp(origin.app_id ?? "");
  if (!app || app.tenant !== scope.tenant || !origin.tenant_key) return { error: "acting on GitHub as a person is not set up for this conversation" };
  const who: Who = { tenant: scope.tenant, chat_app_id: app.app_id, tenant_key: origin.tenant_key, open_id: context.person };
  const name = await grantName(who);
  const grant = env.GITHUB_GRANTS.getByName(name);

  // What is to be created: as it was kept, for a request carried on; as asked, for a new one.
  const kept = await grant.op(context.callId);
  if (context.resuming && !kept) return CHANGED;
  const repo = kept?.repo ?? String(args.repo ?? "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!kept) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "name the repository as owner/name" };
    const title = String(args.title ?? "").trim();
    const body = String(args.body ?? "").trim();
    if (!title || title.length > MAX_TITLE) return { error: `give the issue a title of at most ${MAX_TITLE} characters` };
    if (body.length > MAX_BODY) return { error: `the body is too long: at most ${MAX_BODY} characters` };
    // Which repository is the person's to say, not the model's: named in their own words, or the one this chat is set up to work on.
    const named = [...context.said, ...context.recent].some((each) => each.text.toLowerCase().includes(repo));
    if (!named && !(scope.kind === "chat" && (await registry(env).chatRepo(scope.tenant, scope.id)) === repo)) return { error: "the person has not named that repository themselves; nothing was created. Ask them which repository they mean (as owner/name)" };
  }
  // Where several people talk: only in a chat the chat service says, now, is the organisation's own. Asked on every call.
  if (scope.kind === "chat") {
    let is: ReturnType<typeof chatIs> = "unknown";
    try {
      is = chatIs(await chatFactsFor(env, app.app_id, scope.id), who.tenant_key);
    } catch {
      // Not known.
    }
    if (is !== "internal") return { error: `${is === "external" ? "this chat includes people from outside the organisation" : "it could not be confirmed that this chat is the organisation's own"}, so nothing is done on GitHub in a person's name from here; nothing was created. They can ask in a direct chat` };
  }
  // The repository is one of this tenant's, now: also for a request carried on.
  const repository = await repositoryOf(env, scope.tenant, repo);
  if (repository === "unknown") return { error: "it could not be confirmed with GitHub that this repository is one this organisation has connected; nothing was created. The person can ask again later" };
  if (repository === "not_connected" || (kept && kept.repo_id !== repository.id)) return { error: "that repository is not one this organisation has connected here (the GitHub App is not installed for it), so nothing is done there; nothing was created" };

  const standing = await grant.standing();
  if (context.resuming && standing.generation !== context.resuming.generation) return CHANGED;
  const op = kept ?? (await grant.begin(who, context.callId, { repo, repo_id: repository.id, private: repository.private, title: String(args.title).trim(), body: String(args.body ?? "").trim() }, scopeName(scope)));
  if (op === "full") return { error: "too many issues were asked for and are still being kept track of for this person; nothing was created. Try again later" };
  if (op.generation !== standing.generation) return CHANGED;
  const done = ENDED.includes(op.stage) ? op : standing.authorised ? await grant.post(context.callId) : "unauthorised";
  if (done === undefined) return CHANGED;
  if (done === "unauthorised") {
    if (Date.now() >= op.deadline) return { error: WHY.late };
    const invitation = await grant.invite(who, redirect, standing.generation, { brain: scopeName(scope), call: context.callId, text: context.said.map((each) => each.text.trim()).filter(Boolean).join(" ") || op.title, where: scope.kind === "chat" ? "chat" : "private" });
    if (invitation === "superseded") return { error: "the person's GitHub authorisation changed just now; nothing was created. They can ask again" };
    if (invitation === "full") return { error: "too many authorisations were begun and not finished in the last hour; nothing was created. They can ask again later" };
    return { waiting: { on: "authorisation", subject: name, condition: `github|auth|${name}|${invitation.nonce}`, generation: invitation.generation, until: Math.min(invitation.expires_at, op.deadline), interaction: `github.${name}.${invitation.nonce}`, ...(scope.kind === "chat" ? { privately: true as const } : {}), request: { repo: op.repo, title: op.title } } } satisfies Waiting;
  }
  if (done.stage === "lost") return { error: UNCERTAIN };
  if (done.stage !== "posted" || !done.issue) return { error: WHY[done.why ?? ""] ?? "the issue was not created" };
  const made = { repo: repository.name, number: done.issue.number, url: done.issue.url };
  // Where several people talk, a link into a repository the others may not be able to see is the
  // person's alone: unless this chat is set up to work on that repository. As things are now.
  if (scope.kind === "chat" && repository.private && (await registry(env).chatRepo(scope.tenant, scope.id)) !== repo) {
    return { created: true, direct: { text: `${made.repo}#${made.number}\n${made.url}` }, note: "The issue was created as the person. The repository is not public and this chat is not set up for it, so its link was sent to them directly and is not given here: say that, and nothing more about it." };
  }
  return { created: true, ...made, note: "The issue was created as the person, in their name. Give them the link." };
}

/** Whether a condition of this connector's holds: the person's authorisation, for the request that was shown one invitation. */
export async function grantHolds(env: Env, scope: Scope, condition: string, generation: number): Promise<Holds | undefined> {
  const part = condition.split("|");
  if (part[0] !== "github") return undefined;
  if ((scope.kind !== "user" && scope.kind !== "chat") || part[1] !== "auth" || part.length !== 4 || !/^[0-9a-f]{64}$/.test(part[2])) return { state: "gone" };
  return env.GITHUB_GRANTS.getByName(part[2]).covers(generation, part[3]);
}

/** Whether the tool is for whoever wrote this message: written to the agent, through a chat app of a tenant, on a deployment where this is set up. */
export async function grantOffers(env: Env, event: InboundEvent): Promise<string[]> {
  const appId = (event.data?.origin as { app_id?: unknown } | undefined)?.app_id;
  if ((event.data?.direct !== true && event.data?.group !== true) || typeof appId !== "string" || !setUp(env)) return [];
  return (await registry(env).feishuApp(appId)) ? [githubCreateIssue.name] : [];
}

export async function grantInvitation(env: Env, interaction: string): Promise<Invitation | null | undefined> {
  const found = /^github\.([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(interaction);
  return found ? env.GITHUB_GRANTS.getByName(found[1]).card(found[1], found[2]) : undefined;
}

/** Takes a person's authorisation away here: their tokens are forgotten, and their GitHub account is free to be someone's again. */
export async function dropGrant(env: Env, name: string): Promise<void> {
  await env.GITHUB_GRANTS.getByName(name).drop();
  await registry(env).releaseGithubPerson(name);
}

/** The person took their authorisation of the App away on GitHub: every grant of that account, in every tenant, is over. */
export async function authorisationRevoked(env: Env, account: number): Promise<number> {
  const names = await registry(env).githubGrantsOf(String(account));
  await Promise.all(names.map((each) => dropGrant(env, each)));
  return names.length;
}

/** Where GitHub sends the person's browser after they have authorised. Nothing here trusts the browser. */
export async function grantCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = /^([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(url.searchParams.get("state") ?? "");
  if (!state || !setUp(env)) return page("这个链接无法使用", "请回到聊天里，重新向我发起请求。", 400);
  const grant = env.GITHUB_GRANTS.getByName(state[1]);
  const invitation = await grant.redeem(state[2]);
  if (!invitation || (await grantName(invitation.who)) !== state[1]) return page("这个链接已经用过或已失效", "链接只能使用一次，并且 10 分钟内有效。请回到聊天里，重新向我发起请求。", 400);
  const failed = page("授权没有成功", "请回到聊天里，需要的话再跟我说一遍。如果一直不成功，请联系管理员。", 400);
  const succeeded = page("授权成功", "现在可以回到聊天里。如果你刚才的请求还在等待，我会接着处理，不用再发一遍。");
  // From here the invitation is spent: however this ends, whoever waits on it is told.
  const refused = async (why: string, shown = failed) => {
    console.log(JSON.stringify({ github_authorisation_refused: why }));
    return (await grant.refuse(state[2])) === "done" ? succeeded : shown;
  };
  try {
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.has("error") || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) return await refused("not_consented", page("没有授权", "你没有完成授权，我不会以你的身份在 GitHub 上做任何事。需要时可以回到聊天里重新发起请求。"));
    const exchange = await fetch(TOKEN, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, client_secret: env.GITHUB_CLIENT_SECRET!, code, redirect_uri: invitation.redirect, code_verifier: invitation.verifier }), signal: AbortSignal.timeout(20_000) });
    const issued = (((await exchange.json().catch(() => null)) as unknown) ?? {}) as Partial<Issued>;
    if (!exchange.ok || typeof issued.access_token !== "string" || !issued.access_token) return await refused("exchange_failed");
    // Whose token it is: by GitHub's number for the account, which never changes hands.
    const asked = await github(issued.access_token, "/user");
    const account = (asked.ok ? await asked.json().catch(() => null) : null) as { id?: unknown; login?: unknown } | null;
    if (!account || typeof account.id !== "number" || typeof account.login !== "string") return await refused("identity_unknown");
    // One GitHub account is one person in a tenant: not someone else's already, by the operator's word or by an authorisation of theirs.
    if (!(await registry(env).claimGithubPerson(invitation.who.tenant, String(account.id), state[1], invitation.who.open_id))) return await refused("another_person", page("这个 GitHub 账号已经对应到另一个人", "在这个组织里，这个 GitHub 账号已经属于另一位成员，所以这次授权没有生效。请用你自己的 GitHub 账号重新操作，或联系管理员。", 403));
    if (!(await grant.install(state[2], invitation.generation, issued as Issued, { id: account.id, login: account.login }))) return await refused("superseded");
    return succeeded;
  } catch {
    return await refused("interrupted");
  }
}

/** A page with fixed words only: nothing from the request is ever written into it. */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.5rem;color:#1f2329}h1{font-size:1.4rem}p{line-height:1.7;color:#51565d}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" } });
}
