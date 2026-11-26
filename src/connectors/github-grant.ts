/**
 * GitHub as the person: what the agent does on GitHub in a person's own name, where they ask for
 * it in a chat, under an authorisation they gave the deployment's GitHub App themselves.
 *
 * This plugs into a chat connector (see `Connector.serves`): the chat says who the person is, and
 * this adds something the agent can do for them: opening an issue, and commenting on one (or on
 * a pull request).
 *
 * What the person gives is a user access token of the App. It can do whatever the App may do,
 * wherever the person may: more than opening issues. What keeps it to that is this code, which
 * makes one write, to one of two fixed routes, with a title and a body, or a body; the token is kept in the person's
 * grant object, sealed, and is used there and nowhere else. See
 * docs/design/github-as-the-person.zh-CN.md.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { chainLevels, type InboundEvent, type Scope, scopeName } from "../events";
import { registry } from "../registry";
import { chatFactsFor } from "./feishu-api";
import { chatIs } from "./feishu-docs";
import { challengeOf, grantsKey, lifetime, open, random, seal } from "./feishu-grant";
import { inert } from "./github";
import { githubTokenFor } from "./github-app";
import type { ConnectorTool, Holds, Invitation, ToolContext, Waiting } from "./types";

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
const INVITATION_TTL_MS = 10 * 60_000;
/** How long whoever came back through an invitation has to say that the account is to be used. */
const CONFIRM_MS = 5 * 60_000;
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
/** How many pages of an issue's comments are gone through to find one again. */
const FIND_PAGES = 10;

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
  /** A comment, not an issue (none: an issue, as every one kept before there were comments). On which issue or pull request, by its number. */
  kind?: "comment";
  number?: number;
  /** What it is a comment on, as the person's own token saw it just before it was sent. */
  target?: { title: string; url: string };
  comment?: { id: number; url: string };
  created_at: number;
  deadline: number;
  generation: number;
  /** The GitHub account it was sent as, by number, once it was sent. */
  account?: number;
  /** The conversation it was asked in, by the scope name of its Brain. */
  brain?: string;
}
const ENDED: Op["stage"][] = ["posted", "lost", "failed"];

interface Stored {
  who: Who;
  generation: number;
  pending: { nonce: string; verifier: string; redirect: string; expires_at: number; state?: "taken" | "done" | "refused"; at?: number; brain?: string; call?: string; what?: { text: string; where: "private" | "chat"; action?: string }; held?: Held }[];
  /** `refresh`: absent where the App's tokens do not run out. `account`: whose it is on GitHub, by number. */
  grant?: { access: string; refresh?: string; version: string; expires_at: number; refresh_expires_at?: number; since: number; account: number; login: string };
  /** The GitHub account that is this person's in the tenant, by number: from when they first authorised as it until they give it up, whatever becomes of the tokens meanwhile. */
  bound?: number;
  /** Word owed of a change, to each conversation that waits on this person's authorisation, until each has heard. */
  owed?: { event: string; attempts: number; to: string[] };
}

/** What GitHub gave for an invitation someone came back through, kept until that someone has said the account is to be used: `confirm` is known to their browser alone. */
type Held = Pick<NonNullable<Stored["grant"]>, "access" | "refresh" | "version" | "expires_at" | "refresh_expires_at" | "account" | "login"> & { confirm: string; until: number };
type Acting = { token: string; version: string; account: number; login: string };

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
  #renewing?: Promise<Acting | "later" | undefined>;
  #posting = new Map<string, Promise<Op | "unauthorised" | "later" | undefined>>();

  /** Makes an invitation for this person to authorise, for one request. */
  async invite(who: Who, redirect: string, generation: number, what: { brain: string; call: string; text: string; where: "private" | "chat"; action?: string }): Promise<"superseded" | "full" | { nonce: string; expires_at: number; generation: number }> {
    const stored = (await this.#load()) ?? { who, generation: 1, pending: [] };
    if (!same(stored.who, who)) throw new Error("this authorisation belongs to someone else");
    if (stored.generation !== generation || (stored.grant && this.#usable(stored.grant))) return "superseded";
    const now = Date.now();
    stored.pending = stored.pending.filter((each) => each.expires_at + INVITATION_KEPT_MS > now);
    // One for each request: the card says which it is for. The same call made again has the same one.
    let pending = stored.pending.find((each) => !each.state && each.redirect === redirect && each.expires_at - now > 3 * 60_000 && each.brain === what.brain && each.call === what.call);
    if (!pending) {
      if (stored.pending.length >= MAX_INVITATIONS) return "full";
      pending = { nonce: random(32), verifier: random(48), redirect, expires_at: now + INVITATION_TTL_MS, brain: what.brain, call: what.call, what: { text: what.text.slice(0, 80), where: what.where, ...(what.action ? { action: what.action.slice(0, 160) } : {}) } };
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
      // What it is for, in the words of what was asked: an issue, or a comment and where (as the person themselves named it).
      text: `要以你的名义${pending.what?.action ?? "在 GitHub 上建 issue"}，需要你先授权。\n\n授权是给这个 GitHub 应用的：它在 GitHub 上被允许做的事，在你有权限的仓库里都能以你的身份做，不只是建 issue 或评论。我只用它来做你明确要求的这件事。${about}`,
      action: { label: "去授权", url },
      note: "链接 10 分钟内有效。请只由你本人打开，不要转给别人：谁打开并确认，就是把谁的 GitHub 账号交给你在这里使用。授权完成后我会接着处理，你不用再发一遍。之后随时可以让我取消，或在 GitHub 的 Settings → Applications 里撤销。",
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

  /**
   * Keeps, aside, what GitHub gave for an invitation someone came back through. Nothing is acted
   * with yet: whoever came back is first shown which account it is and asked whether it is to be
   * used (they may have been handed someone else's link). Gives what their browser has to bring back.
   */
  async hold(nonce: string, generation: number, issued: Issued, account: { id: number; login: string }): Promise<string | undefined> {
    const key = await this.#key();
    const version = random(16);
    const access = await seal(key, issued.access_token, version);
    const refresh = issued.refresh_token ? await seal(key, issued.refresh_token, version) : undefined;
    const stored = await this.#load();
    const through = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || stored.generation !== generation || through?.state !== "taken" || through.held) return undefined;
    through.held = { access, ...(refresh ? { refresh } : {}), version, ...tokensOf(issued, Date.now()), account: account.id, login: account.login, confirm: random(32), until: Date.now() + CONFIRM_MS };
    void this.ctx.storage.put("grant", stored);
    return through.held.confirm;
  }

  /**
   * The person said the account is to be used: it becomes theirs in this tenant, if it is nobody
   * else's there and they have no other, and what was held becomes their grant. "another": it is
   * not theirs to have. Nothing where there is nothing held under that word (any more).
   */
  async install(nonce: string, confirm: string): Promise<"done" | "another" | undefined> {
    const held = (stored: Stored | undefined) => {
      const through = stored?.pending.find((each) => each.nonce === nonce);
      return stored && through?.state === "taken" && through.held && through.held.confirm === confirm && through.held.until > Date.now() ? through : undefined;
    };
    const before = await this.#load();
    const first = held(before);
    if (!before || !first?.held) return undefined;
    const name = await grantName(before.who);
    const account = String(first.held.account);
    const claimed = await registry(this.env).claimGithubPerson(before.who.tenant, account, name);
    if (!claimed) return "another";
    // As things are now: the grant may have been taken away while that was asked.
    const stored = await this.#load();
    const through = held(stored);
    if (!stored || !through?.held || stored.generation !== before.generation) {
      if (claimed === "new") await registry(this.env).releaseGithubPerson(name, account);
      return undefined;
    }
    const { confirm: _spent, until: _over, ...grant } = through.held;
    const now = Date.now();
    delete through.held;
    through.state = "done";
    through.at = now;
    stored.grant = { ...grant, since: now };
    stored.bound = grant.account;
    stored.owed = this.#owed(stored, grant.version);
    void this.ctx.storage.put("grant", stored);
    void this.ctx.storage.setAlarm(now);
    return "done";
  }

  /** An invitation someone came back through came to nothing. Says how it stands after this. */
  async refuse(nonce: string): Promise<"done" | "refused" | undefined> {
    const stored = await this.#load();
    const through = stored?.pending.find((each) => each.nonce === nonce);
    if (!stored || !through || through.state !== "taken") return through?.state === "done" || through?.state === "refused" ? through.state : undefined;
    through.state = "refused";
    delete through.held;
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

  /** Which generation this is, and whether there is a token to act with now (renewed, if it had run out): "later" where that cannot be told just now. */
  async standing(): Promise<{ generation: number; authorised: boolean | "later" }> {
    const stored = await this.#load();
    const held = await this.#token();
    return { generation: stored?.generation ?? 1, authorised: held === "later" ? "later" : held !== undefined };
  }

  /** Forgets the tokens and closes every open invitation, and the account is no longer this person's here. Only here: GitHub's own record of the authorisation is the person's to remove. */
  /** `only`: where the reason is about one GitHub account (it was revoked there), and the person may hold another by now. */
  async drop(only?: number): Promise<void> {
    const stored = await this.#load();
    if (!stored || (only !== undefined && stored.bound !== only)) return;
    const owed = this.#owed(stored, `dropped:${stored.generation + 1}`);
    void this.ctx.storage.put("grant", { ...stored, generation: stored.generation + 1, pending: [], grant: undefined, bound: undefined, owed });
    void this.ctx.storage.setAlarm(Date.now());
    // That account, and no other they may have come to hold since.
    // (Given up outright, whatever is noted as theirs goes: also what a binding that was interrupted half-way left behind.)
    if (only === undefined || stored.bound !== undefined) await registry(this.env).releaseGithubPerson(await grantName(stored.who), only === undefined ? undefined : String(stored.bound));
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
  async begin(who: Who, call: string, what: Pick<Op, "repo" | "repo_id" | "private" | "title" | "body"> & Pick<Op, "kind" | "number">, brain: string): Promise<Op | "full"> {
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
   * "later": whether there is one cannot be told just now; nothing was created, and it can be asked again.
   */
  post(call: string): Promise<Op | "unauthorised" | "later" | undefined> {
    const under = this.#posting.get(call);
    if (under) return under;
    const going = this.#post(call).finally(() => this.#posting.delete(call));
    this.#posting.set(call, going);
    return going;
  }

  async #post(call: string): Promise<Op | "unauthorised" | "later" | undefined> {
    const op = await this.op(call);
    if (!op || op.stage === "posted" || op.stage === "failed") return op;
    const end = async (stage: Op["stage"], more: Partial<Op> = {}) => {
      const now: Op = { ...op, ...more, stage };
      await this.ctx.storage.put(`op:${call}`, now);
      return now;
    };
    const stands = async () => (await this.#load())?.generation === op.generation;
    const comment = op.kind === "comment";
    const mark = await markOf(this.ctx.id.toString(), call, op.kind);
    const looked = async (held: Acting) => {
      const found = comment ? await this.#findComment(held, op, mark) : await this.#find(held, op, mark);
      return found ? end("posted", comment ? { comment: found as Op["comment"] } : { issue: found as Op["issue"] }) : end("lost");
    };
    // It was being sent once already (this instance was interrupted): it may be there.
    // Or it was left as not known: looked for again, and never sent again. Not found is still not known.
    if (op.stage === "posting" || op.stage === "lost") {
      const held = await this.#token();
      return held && held !== "later" && (op.account === undefined || op.account === held.account) ? looked(held) : end("lost");
    }
    if (!(await stands())) return end("failed", { why: "changed" });
    if (Date.now() >= op.deadline) return end("failed", { why: "late" });
    const held = await this.#token();
    if (!held || held === "later") return held ?? "unauthorised";
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
    // What is commented on: that it is there, and what it is called, as the person themselves can
    // see it. Asked with their token and only now, so that nothing of a repository is told to
    // someone before they have shown they can read it.
    if (comment) {
      let at: Response;
      try {
        at = await github(held.token, `/repos/${op.repo}/issues/${op.number}`);
      } catch {
        return end("failed", { why: "unreachable" });
      }
      if (at.status === 401) return await this.#refused(held.version), "unauthorised";
      if (at.status === 404 || at.status === 410 || at.status === 301) return end("failed", { why: "no_target" });
      const it = at.ok ? ((await at.json().catch(() => null)) as { title?: unknown; html_url?: unknown } | null) : null;
      if (!it || typeof it.title !== "string" || typeof it.html_url !== "string") return end("failed", { why: "unreachable" });
      op.target = { title: it.title, url: it.html_url };
    }
    // The last thing before the send: what it was asked under still stands, and its time is not up.
    if (!(await stands())) return end("failed", { why: "changed" });
    if (Date.now() >= op.deadline) return end("failed", { why: "late" });
    // As which account: what is looked for later is this account's and no other's.
    op.account = held.account;
    await this.ctx.storage.put(`op:${call}`, { ...op, stage: "posting" } satisfies Op);
    let sent: Response | undefined;
    try {
      const text = `${op.body}\n\n${mark}`.trim();
      sent = await github(held.token, comment ? `/repos/${op.repo}/issues/${op.number}/comments` : `/repos/${op.repo}/issues`, { method: "POST", body: JSON.stringify(comment ? { body: text } : { title: op.title, body: text }) });
    } catch {
      // No answer: it may have been taken.
    }
    if (sent?.status === 201) {
      const made = (await sent.json().catch(() => null)) as { number?: unknown; id?: unknown; html_url?: unknown } | null;
      if (made && typeof made.html_url === "string") {
        if (comment && typeof made.id === "number") return end("posted", { comment: { id: made.id, url: made.html_url } });
        if (!comment && typeof made.number === "number") return end("posted", { issue: { number: made.number, url: made.html_url } });
      }
    }
    // Turned away outright: nothing was created.
    if (sent?.status === 401) return await this.#refused(held.version), await end("asked"), "unauthorised";
    if (sent && [403, 404, 410, 422].includes(sent.status)) {
      const why = comment ? (sent.status === 404 || sent.status === 410 ? "no_target" : sent.status === 422 ? "not_accepted" : "no_comment") : sent.status === 410 ? "issues_off" : sent.status === 422 ? "not_accepted" : "no_access";
      return end("failed", { why });
    }
    // Anything else is not an answer about whether it was created: looked for, once, by its mark.
    return looked(held);
  }

  /**
   * The comment of one call, if it is there: on that issue, by this person, carrying that call's
   * mark. The comments of an issue come oldest first and cannot be asked for by who wrote them, so
   * they are gone through from when this was asked, a bounded number of pages; nothing where it is
   * not found in those, or could not be looked for.
   */
  async #findComment(held: Acting, op: Op, mark: string): Promise<Op["comment"] | undefined> {
    try {
      for (let page = 1; page <= FIND_PAGES; page++) {
        const listed = await github(held.token, `/repos/${op.repo}/issues/${op.number}/comments?${new URLSearchParams({ since: new Date(op.created_at - 60_000).toISOString(), per_page: "100", page: String(page) })}`);
        if (!listed.ok) return undefined;
        const comments = (await listed.json()) as { id?: unknown; html_url?: unknown; body?: unknown; user?: { id?: unknown } }[];
        if (!Array.isArray(comments)) return undefined;
        const found = comments.find((each) => each.user?.id === held.account && typeof each.body === "string" && each.body.trimEnd().endsWith(mark));
        if (found) return typeof found.id === "number" && typeof found.html_url === "string" ? { id: found.id, url: found.html_url } : undefined;
        if (comments.length < 100) return undefined;
      }
    } catch {
      // Not looked for.
    }
    return undefined;
  }

  /** The issue of one call, if it is there: in that repository, by this person, carrying that call's mark. Nothing where it is not found, or could not be looked for. */
  async #find(held: Acting, op: Op, mark: string): Promise<Op["issue"] | undefined> {
    try {
      const listed = await github(held.token, `/repos/${op.repo}/issues?${new URLSearchParams({ creator: held.login, state: "all", since: new Date(op.created_at - 60_000).toISOString(), per_page: "100" })}`);
      if (!listed.ok) return undefined;
      const issues = (await listed.json()) as { number?: unknown; html_url?: unknown; body?: unknown; user?: { id?: unknown }; pull_request?: unknown; repository_url?: unknown }[];
      // (Also by the mark as it was written before it began as the agent's own marks do: an issue sent under that one is the same issue.)
      const marks = [mark, mark.replace("always-on-agent:", "")];
      const found = (Array.isArray(issues) ? issues : []).find((each) => !each.pull_request && each.user?.id === held.account && typeof each.body === "string" && marks.some((one) => (each.body as string).trimEnd().endsWith(one)));
      return found && typeof found.number === "number" && typeof found.html_url === "string" ? { number: found.number, url: found.html_url } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The token to act with now, and whose it is. Renewed first where it has run out and can be:
   * one renewal at a time, since GitHub takes what renews a token once only. "later": it could not
   * be renewed just now, and what is held is kept.
   */
  async #token(): Promise<Acting | "later" | undefined> {
    const grant = (await this.#load())?.grant;
    if (!grant) return undefined;
    try {
      // (Still good by itself, as against only renewable.)
      if (grant.expires_at - EXPIRY_MARGIN_MS > Date.now()) return { token: await open(await this.#key(), grant.access, grant.version), version: grant.version, account: grant.account, login: grant.login };
    } catch {
      return undefined;
    }
    if (!grant.refresh || (grant.refresh_expires_at ?? 0) <= Date.now()) return undefined;
    this.#renewing ??= this.#renew(grant.version).finally(() => (this.#renewing = undefined));
    return this.#renewing;
  }

  async #renew(version: string): Promise<Acting | "later" | undefined> {
    const stored = await this.#load();
    const grant = stored?.grant;
    if (!stored || !grant?.refresh || grant.version !== version || !this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET) return undefined;
    const key = await this.#key();
    const client = { id: this.env.GITHUB_CLIENT_ID, secret: this.env.GITHUB_CLIENT_SECRET };
    const issued = await (async (): Promise<(Partial<Issued> & { error?: unknown }) | null> => {
      const response = await fetch(TOKEN, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, grant_type: "refresh_token", refresh_token: await open(key, grant.refresh!, grant.version) }), signal: AbortSignal.timeout(20_000) });
      return response.ok ? response.json() : null;
    })().catch(() => null);
    const renewed = issued && typeof issued.access_token === "string" && issued.access_token !== "" ? (issued as Issued) : undefined;
    // Only GitHub saying that what was held is no good ends it. Anything else is no answer about that: it is kept.
    if (!renewed && issued?.error !== "bad_refresh_token") return "later";
    // Everything that takes time is done first; then the record is read and written in one step,
    // as it stands then: a grant taken away, or replaced, meanwhile is not written over.
    const next = random(16);
    const sealed = renewed ? { access: await seal(key, renewed.access_token, next), refresh: renewed.refresh_token ? await seal(key, renewed.refresh_token, next) : undefined } : undefined;
    const after = await this.#load();
    if (!after?.grant || after.grant.version !== version || after.generation !== stored.generation) return undefined;
    if (!renewed || !sealed) {
      delete after.grant;
      void this.ctx.storage.put("grant", after);
      return undefined;
    }
    after.grant = { ...after.grant, ...sealed, version: next, ...tokensOf(renewed, Date.now()) };
    void this.ctx.storage.put("grant", after);
    return { token: renewed.access_token, version: next, account: after.grant.account, login: after.grant.login };
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

/**
 * What an issue or a comment carries so that it can be found again: made from the call alone, it
 * shows nothing in the page and says nothing of who asked. It begins as every mark of the agent's
 * own does: what is written in a person's name comes back from GitHub looking like their words,
 * and by this it is known not to be a request of theirs (see the webhook in github.ts).
 */
async function markOf(grant: string, call: string, kind?: Op["kind"]): Promise<string> {
  return `<!-- always-on-agent:request:${(await hex(JSON.stringify([`github ${kind ?? "issue"}`, grant, call]))).slice(0, 32)} -->`;
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

type Kind = "issue" | "comment";
const NONE: Record<Kind, string> = { issue: "nothing was created", comment: "nothing was posted" };
const changed = (kind: Kind) => ({ error: `the person's GitHub authorisation changed while this was under way; ${NONE[kind]}. They can ask again` });
const uncertain = (kind: Kind) =>
  kind === "issue"
    ? "it could not be confirmed whether the issue was created; nothing more was sent, so that it is not created twice. Tell the person so, and that they can look at the repository's issues themselves: it is asked for anew only if they have seen that it is not there"
    : "it could not be confirmed whether the comment was posted; nothing more was sent, so that it is not posted twice. Tell the person so, and that they can look at the issue themselves: it is asked for anew only if they have seen that it is not there";
const why = (kind: Kind, reason: string): string | undefined =>
  ({
    changed: changed(kind).error,
    late: `this was not done in time; ${NONE[kind]}. The person can ask again`,
    unreachable: `GitHub could not be reached; ${NONE[kind]}. The person can ask again`,
    no_access: `GitHub did not let the person ${kind === "issue" ? "open an issue in" : "see"} that repository (they may not have access to it, or the GitHub App may not be allowed there); ${NONE[kind]}`,
    moved: `that name no longer means the repository it meant when this was asked; ${NONE[kind]}. The person can ask again, naming the repository as it is called now`,
    issues_off: "issues are turned off in that repository; nothing was created",
    not_accepted: `GitHub did not accept the ${kind} as written; ${NONE[kind]}`,
    no_target: "there is no issue or pull request of that number in that repository that the person can see; nothing was posted",
    no_comment: "GitHub did not let the person comment there (the conversation may be locked, or they may not be allowed to); nothing was posted",
  })[reason];

export const githubCreateIssue: ConnectorTool = {
  name: "github_create_issue",
  description:
    "Opens an issue on GitHub as the person who asked, in their own name. Only when they ask for one outright, in a repository they named themselves (`repo`, as owner/name). They are asked to authorise the first time; nothing else is asked of them before it is created, so do not ask them to confirm. Write `title` and `body` from what the person themselves said and pointed at, and from nothing else in this conversation: no one else's words or names, nothing from other topics, nothing read from documents. Where it follows a piece of work they asked for, also from what that work found for this request. If it is not plain which matter they mean, ask which.",
  effect: "act",
  optional: true,
  // Also where several people talk: for the one who asked, as them.
  shared: true,
  parameters: { repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
  run: (context, args) => act("issue", context, args),
};

export const githubComment: ConnectorTool = {
  name: "github_comment",
  description:
    "Posts a comment on an issue or a pull request on GitHub as the person who asked, in their own name (not a review of lines of code). Only when they ask for that outright, in a repository they named themselves (`repo`, as owner/name) and on the one they named (`number`). They are asked to authorise the first time; nothing else is asked of them before it is posted, so do not ask them to confirm. Write `body` from what the person themselves said and pointed at, and from nothing else in this conversation: no one else's words or names, nothing from other topics. Where it follows a piece of work they asked for, which was to find the one to comment on, `number` is the one that work found, and `body` may draw on what it found for this request. A mention (@name) notifies that person only if the person who asked wrote it so themselves; any other is shown and notifies no one.",
  effect: "act",
  optional: true,
  shared: true,
  parameters: { repo: { type: "string" }, number: { type: "integer" }, body: { type: "string" } },
  run: (context, args) => act("comment", context, args),
};

/**
 * What became of an issue or a comment is one thing; what can be checked, or said, about it at the
 * moment is another. Whatever stops a call short (a check that cannot be made just now, something
 * that has changed since), one that is there is said to be there, and one that may be is said to
 * be not known: "nothing was created" is said only of one that certainly was not.
 */
async function act(kind: Kind, context: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const seen: { op?: () => Promise<Op | undefined> } = {};
  const result = await attempt(kind, context, args, seen);
  const failed = typeof result === "object" && result !== null && "error" in result;
  const now = failed ? await seen.op?.() : undefined;
  if (now?.stage === "posting" || now?.stage === "lost") return { error: uncertain(kind) };
  // Nothing is kept of this call here: nothing was done under it and nothing begun. Said as a
  // fact about what is kept, for whoever keeps count of what a request has had done.
  if (failed && !now) return { ...(result as Record<string, unknown>), untouched: true };
  const made = now?.stage === "posted" ? receipt(now) : undefined;
  if (!made) return result;
  // Who else here may see its link could not be worked out this time: it goes to the person alone.
  return context.scope.kind === "chat" ? made.alone : made.open;
}

/** What is said of one that is there: where anyone present may see it, and where only the person may. */
function receipt(op: Op, name = op.repo): { open: Record<string, unknown>; alone: Record<string, unknown> } | undefined {
  if (op.kind === "comment") {
    if (!op.comment || op.number === undefined) return undefined;
    const on = op.target?.title ?? "";
    return {
      open: { posted: true, repo: name, number: op.number, on, url: op.comment.url, note: "The comment was posted as the person, in their name. Give them the link, and say what it is on." },
      alone: { posted: true, direct: { text: `${name}#${op.number}${on ? ` ${on}` : ""}\n${op.comment.url}` }, note: "The comment was posted as the person. Its link is being sent to them directly and is not given here: say that, and nothing more about it." },
    };
  }
  if (!op.issue) return undefined;
  return {
    open: { created: true, repo: name, number: op.issue.number, url: op.issue.url, note: "The issue was created as the person, in their name. Give them the link." },
    alone: { created: true, direct: { text: `${name}#${op.issue.number}\n${op.issue.url}` }, note: "The issue was created as the person. Its link is being sent to them directly and is not given here: say that, and nothing more about it." },
  };
}

/** Every repository a text names whole: by its address on GitHub (the first two parts of the path), or as owner/name standing by itself, never part of some other address or path. In lower case. */
function reposIn(text: string): string[] {
  const addresses = [...text.matchAll(/https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)/gi)].map((found) => found[1]);
  const bare = [...text.replace(/https?:\/\/\S+/gi, " ").matchAll(/(?<![\w.\/-])([\w.-]+\/[\w.-]+)(?![\w\/-])/g)].map((found) => found[1]);
  return [...addresses, ...bare].map((found) => found.replace(/(\.git|[.\/])+$/i, "").toLowerCase());
}

/**
 * The issues and pull requests a text points at. With their repository: by address
 * (…/issues/12, …/pull/12) or as owner/name#12. Or by number alone (#12), which says nothing of
 * where.
 */
function targetsIn(text: string): { whole: { repo: string; number: number }[]; bare: number[] } {
  const addressed = [...text.matchAll(/https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)(?!\d)/gi)];
  const rest = text.replace(/https?:\/\/\S+/gi, " ");
  const short = [...rest.matchAll(/(?<![\w.\/-])([\w.-]+\/[\w.-]+)#(\d+)(?!\d)/g)];
  const alone = [...rest.replace(/[\w.-]+\/[\w.-]+#\d+/g, " ").matchAll(/(?<![\w\/])#(\d+)(?!\d)/g)];
  return { whole: [...addressed, ...short].map((found) => ({ repo: found[1].toLowerCase(), number: Number(found[2]) })), bare: alone.map((found) => Number(found[1])) };
}

async function attempt(kind: Kind, context: ToolContext, args: Record<string, unknown>, seen: { op?: () => Promise<Op | undefined> }): Promise<unknown> {
  const { env, origin, scope } = context;
  const none = NONE[kind];
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
  seen.op = () => grant.op(context.callId);
  if (context.resuming && !kept) return changed(kind);
  // (A call's number is one kind of thing's: what was kept under it as the other is not this.)
  if (kept && (kept.kind ?? "issue") !== kind) return changed(kind);
  const repo = kept?.repo ?? String(args.repo ?? "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, "").toLowerCase();
  let fresh: (Pick<Op, "title" | "body"> & Pick<Op, "kind" | "number">) | undefined;
  if (!kept) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "name the repository as owner/name" };
    const title = kind === "issue" ? String(args.title ?? "").trim() : "";
    const written = String(args.body ?? "").trim();
    const number = Number(args.number);
    if (kind === "issue" && (!title || title.length > MAX_TITLE)) return { error: `give the issue a title of at most ${MAX_TITLE} characters` };
    if (kind === "comment" && (!Number.isSafeInteger(number) || number < 1)) return { error: "say which issue or pull request, by its number" };
    if (kind === "comment" && !written) return { error: "a comment has to say something; nothing was posted" };
    if (written.length > MAX_BODY) return { error: `the body is too long: at most ${MAX_BODY} characters` };
    const own = [...context.said, ...context.recent];
    // The messages this request comes to rest on, beside the ones it was made in.
    const rests = new Set<number>();
    const relied = (index: number) => {
      rests.add(index);
      if (index < context.said.length) context.relied?.("said", index);
      else context.relied?.("recent", index - context.said.length);
    };
    // Which repository is the person's to say, not the model's: named whole in their own words (owner/name, or its address on GitHub).
    const named = own.findIndex((each) => reposIn(each.text).includes(repo));
    if (named < 0) return { error: `the person has not named that repository themselves; ${none}. Ask them which repository they mean (as owner/name)` };
    if (kind === "issue") relied(named);
    // After a piece of work they asked for, which was to find which one: that is the work's to
    // say, in the repository they named. (Whether it is there is seen with their own token.)
    else if (context.after) relied(named);
    else {
      // So with which one is commented on, and the two go together: the one they pointed at in
      // that repository (its address, or owner/name#12). A number by itself (#12) is of the
      // repository only where they have named no other; never one repository's name with a
      // number they wrote of another.
      // Which repository a number by itself is of: the one the same message names, if it names
      // one; if it names none, the only one they have named at all.
      const everywhere = [...new Set(own.flatMap((each) => reposIn(each.text)))];
      const of = (text: string) => {
        const here = [...new Set(reposIn(text))];
        return here.length === 1 ? here[0] : here.length === 0 && everywhere.length === 1 ? everywhere[0] : undefined;
      };
      // What they point at now, worked out from their words before the call is looked at: if they
      // point at anything this time, it is that and nothing they pointed at before (they may have
      // changed their mind, to another number or another repository). Only where what they say
      // now points at nothing is what they said shortly before taken, by the same reading.
      const pointsOf = (from: number, to: number) =>
        own.slice(from, to).flatMap((each, at) => {
          const found = targetsIn(each.text);
          return [...found.whole.map((one) => ({ ...one, index: from + at, plain: true })), ...found.bare.map((bare) => ({ repo: of(each.text), number: bare, index: from + at, plain: false }))];
        });
      const now = pointsOf(0, context.said.length);
      // Going on from before: within the repository they name now, if they name one; and it is
      // the one they pointed at last, in the latest of their earlier messages that points at
      // anything there. Not whichever of the things they spoke of the call happens to name.
      const here = new Set(context.said.flatMap((each) => reposIn(each.text)));
      const within = (found: ReturnType<typeof pointsOf>) => found.filter((each) => here.size === 0 || (each.repo !== undefined && here.has(each.repo)));
      // Written as a reply: what they replied to says which, before anything else they said. The
      // message of their own nearest up the chain of replies; if that points at nothing (or it
      // was not theirs, or is not here), it is not guessed at from what else was said.
      const replied = context.said.flatMap((each) => [each.data.replies_to, ...chainLevels(each.data).map((level) => level.subject)]).filter((subject): subject is string => typeof subject === "string");
      const parent = replied.map((subject) => own.findIndex((each, index) => index >= context.said.length && typeof each.data.message_id === "string" && subject.endsWith(`:message:${each.data.message_id}`))).find((index) => index >= 0);
      const before = within(pointsOf(context.said.length, own.length));
      const last = replied.length > 0 ? (parent === undefined ? [] : within(pointsOf(parent, parent + 1))) : before.filter((each) => each.index === Math.max(...before.map((one) => one.index)));
      const points = now.length > 0 ? now : last;
      const meant = points.find((each) => each.repo === repo && each.number === number);
      // (Several at once, in that message, and it is not plain which of them is gone on with.)
      const several = now.length === 0 && new Set(last.map((each) => `${each.repo}#${each.number}`)).size > 1;
      if (!meant || several) {
        if (points.some((each) => each.number === number && each.repo === undefined)) return { error: `the person named more than one repository, and it is not plain which of them #${number} is in; nothing was posted. Ask them which one they mean (as owner/name#${number}, or by its address)` };
        if (several) return { error: "the person pointed at more than one issue or pull request before, and it is not plain which of them they mean now; nothing was posted. Ask them which one (as owner/name#number, or by its address)" };
        if (now.length === 0 && replied.length > 0 && last.length === 0) return { error: "the person wrote this as a reply, and what they replied to does not say which issue or pull request; nothing was posted. Ask them which one they mean (as owner/name#number, or by its address)" };
        return { error: `that is not the issue or pull request the person pointed at ${now.length > 0 ? "this time" : replied.length > 0 ? "in what they replied to" : "last"} (they say which as owner/name#${number}, or by its address); nothing was posted. Ask them which one they mean` };
      }
      relied(meant.index);
      if (!meant.plain) relied(named);
    }
    // In their name, a mention notifies someone only where they typed it so themselves: in what
    // they asked this time, or in an earlier message of theirs that this rests on. Which names
    // those are is what the chat connector noted of each message as it arrived, while it still
    // had its lines and its parts (not code, not a quotation, not a person of the chat they
    // mentioned there); a message it noted nothing of gives none.
    const theirs = new Set(own.filter((_, index) => index < context.said.length || rests.has(index)).flatMap((each) => (Array.isArray(each.data.handles) ? each.data.handles.map((name) => String(name).toLowerCase()) : [])));
    const body = inert(written, theirs);
    if (body.length > MAX_BODY) return { error: `the body is too long: at most ${MAX_BODY} characters` };
    fresh = kind === "comment" ? { title: "", body, kind, number } : { title, body, kind: undefined, number: undefined };
  }
  // Where several people talk: only in a chat the chat service says, now, is the organisation's own. Asked on every call.
  if (scope.kind === "chat") {
    let is: ReturnType<typeof chatIs> = "unknown";
    try {
      is = chatIs(await chatFactsFor(env, app.app_id, scope.id), who.tenant_key);
    } catch {
      // Not known.
    }
    if (is !== "internal") return { error: `${is === "external" ? "this chat includes people from outside the organisation" : "it could not be confirmed that this chat is the organisation's own"}, so nothing is done on GitHub in a person's name from here; ${none}. They can ask in a direct chat` };
  }
  const standing = await grant.standing();
  if (context.resuming && standing.generation !== context.resuming.generation) return changed(kind);
  // Last, with nothing waited for between this and the sending but the sending's own checks:
  // The repository is one of this tenant's, now: also for a request carried on.
  const repository = await repositoryOf(env, scope.tenant, repo);
  if (repository === "unknown") return { error: `it could not be confirmed with GitHub that this repository is one this organisation has connected; ${none}. The person can ask again later` };
  if (repository === "not_connected" || (kept && kept.repo_id !== repository.id)) return { error: `that repository is not one this organisation has connected here (the GitHub App is not installed for it), so nothing is done there; ${none}` };

  const op = kept ?? (await grant.begin(who, context.callId, { repo, repo_id: repository.id, private: repository.private, ...fresh! }, scopeName(scope)));
  if (op === "full") return { error: `too many issues and comments were asked for and are still being kept track of for this person; ${none}. Try again later` };
  if (op.generation !== standing.generation) return changed(kind);
  // (One left as not known is looked for again, where there is a token to look with.)
  const done = op.stage === "posted" || op.stage === "failed" ? op : standing.authorised === "later" ? "later" : standing.authorised || op.stage === "lost" ? await grant.post(context.callId) : "unauthorised";
  if (done === undefined) return changed(kind);
  // Once it was sent, or may have been, nothing that fails afterwards says that it was not created.
  if ((op.stage === "posting" || op.stage === "lost") && typeof done === "string") return { error: uncertain(kind) };
  if (done === "later") return { error: `GitHub could not be asked just now whether the person's authorisation still stands; ${none}, and nothing about their authorisation was changed. They can ask again in a little while` };
  if (done === "unauthorised") {
    if (Date.now() >= op.deadline) return { error: why(kind, "late") };
    const about = kind === "comment" ? `${op.repo}#${op.number}` : op.title;
    const invitation = await grant.invite(who, redirect, standing.generation, { brain: scopeName(scope), call: context.callId, text: context.said.map((each) => each.text.trim()).filter(Boolean).join(" ") || about, where: scope.kind === "chat" ? "chat" : "private", ...(kind === "comment" ? { action: `在 ${op.repo}#${op.number} 下发表评论` } : {}) });
    if (invitation === "superseded") return { error: `the person's GitHub authorisation changed just now; ${none}. They can ask again` };
    if (invitation === "full") return { error: `too many authorisations were begun and not finished in the last hour; ${none}. They can ask again later` };
    return { waiting: { on: "authorisation", subject: name, condition: `github|auth|${name}|${invitation.nonce}`, generation: invitation.generation, until: Math.min(invitation.expires_at, op.deadline), interaction: `github.${name}.${invitation.nonce}`, ...(scope.kind === "chat" ? { privately: true as const } : {}), request: kind === "comment" ? { repo: op.repo, number: op.number } : { repo: op.repo, title: op.title } } } satisfies Waiting;
  }
  if (done.stage === "lost") return { error: uncertain(kind) };
  // Where several people talk, what tells of a repository the others may not be able to see is
  // the person's alone: unless this chat is set up to work on that repository. As things are now,
  // asked again after the sending (a repository can be made private meanwhile); where it cannot
  // be told, it is taken as one they may not see.
  const hidden = async () => {
    if (scope.kind !== "chat") return false;
    // First that the name still means the repository this was done in: a chat set up for a
    // repository is set up for it by name, and a name can come to mean another one.
    const now = await repositoryOf(env, scope.tenant, repo);
    if (typeof now !== "object" || now.id !== op.repo_id) return true;
    return now.private && (await registry(env).chatRepo(scope.tenant, scope.id)) !== repo;
  };
  const made = done.stage === "posted" ? receipt(done, repository.name) : undefined;
  if (!made) {
    const reason = why(kind, done.why ?? "") ?? `the ${kind} was not ${kind === "issue" ? "created" : "posted"}`;
    // Why a comment could not be posted says whether what it was to be on is there.
    if (kind === "comment" && (done.why === "no_target" || done.why === "no_comment") && (await hidden())) {
      return { error: "the comment was not posted. Why is being sent to the person directly and is not given here: say that, and nothing more about it", direct: { text: `${op.repo}#${op.number}: ${reason}` } };
    }
    return { error: reason };
  }
  if (await hidden()) {
    return { ...made.alone, note: `The ${kind} was ${kind === "issue" ? "created" : "posted"} as the person. The repository is not public and this chat is not set up for it, so its link is being sent to them directly and is not given here: say that, and nothing more about it.` };
  }
  return made.open;
}

export const githubDisconnect: ConnectorTool = {
  name: "github_disconnect",
  description: "Takes away, here, the person's authorisation to act on GitHub as them: when they ask for that outright. They are asked to authorise again the next time they want something done as them.",
  effect: "act",
  optional: true,
  parameters: {},
  run: async (context) => {
    const { env, origin, scope } = context;
    const app = await registry(env).feishuApp(origin.app_id ?? "");
    if (scope.kind !== "user" || !app || app.tenant !== scope.tenant || !origin.tenant_key) return { error: "this can only be done by the person, in their own chat with the agent" };
    await env.GITHUB_GRANTS.getByName(await grantName({ tenant: scope.tenant, chat_app_id: app.app_id, tenant_key: origin.tenant_key, open_id: context.person })).drop();
    return { ok: true, note: "Their authorisation is no longer used here, and what was kept of it is gone. GitHub still lists the app as authorised until they remove it there themselves (Settings → Applications → Authorized GitHub Apps): tell them both." };
  },
};

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
  return (await registry(env).feishuApp(appId)) ? [githubCreateIssue.name, githubComment.name, githubDisconnect.name] : [];
}

export async function grantInvitation(env: Env, interaction: string): Promise<Invitation | null | undefined> {
  const found = /^github\.([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(interaction);
  return found ? env.GITHUB_GRANTS.getByName(found[1]).card(found[1], found[2]) : undefined;
}

/** The person took their authorisation of the App away on GitHub: every grant of that account, in every tenant, is over. */
export async function authorisationRevoked(env: Env, account: number): Promise<number> {
  const names = await registry(env).githubGrantsOf(String(account));
  await Promise.all(names.map((each) => env.GITHUB_GRANTS.getByName(each).drop(account)));
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
    if (!/^[A-Za-z0-9-]{1,39}$/.test(account.login)) return await refused("identity_unknown");
    // Nothing is acted with yet. Whoever is at this browser may have been handed someone else's
    // link, and GitHub does not ask again once the App is authorised: they are shown the account
    // and asked. What they send back carries a word only this page was given.
    const confirm = await grant.hold(state[2], invitation.generation, issued as Issued, { id: account.id, login: account.login });
    if (!confirm) return await refused("superseded");
    return page("确认使用这个 GitHub 账号", `即将把 GitHub 账号 @${account.login} 交给聊天里向我发起这次请求的人使用：之后我会按那个人在聊天里的要求，以 @${account.login} 的名义在 GitHub 上操作。如果这次请求不是你自己在聊天里发起的（比如链接是别人发给你的），请直接关闭这个页面。`, 200, `<form method="post" action="/v1/github/oauth/confirm"><input type="hidden" name="state" value="${state[1]}.${state[2]}"><input type="hidden" name="confirm" value="${confirm}"><button type="submit">是我发起的，确认</button></form>`);
  } catch {
    return await refused("interrupted");
  }
}

/** The person at the browser said the account is to be used. */
export async function grantConfirm(request: Request, env: Env): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const state = /^([0-9a-f]{64})\.([A-Za-z0-9_-]{20,100})$/.exec(String(form?.get("state") ?? ""));
  const confirm = String(form?.get("confirm") ?? "");
  if (!state || !/^[A-Za-z0-9_-]{20,100}$/.test(confirm) || !setUp(env)) return page("这个链接无法使用", "请回到聊天里，重新向我发起请求。", 400);
  const grant = env.GITHUB_GRANTS.getByName(state[1]);
  try {
    const how = await grant.install(state[2], confirm);
    if (how === "done") return page("授权成功", "现在可以回到聊天里。如果你刚才的请求还在等待，我会接着处理，不用再发一遍。");
    if (how === undefined) return page("这个链接已经用过或已失效", "请回到聊天里，重新向我发起请求。", 400);
    console.log(JSON.stringify({ github_authorisation_refused: "another_person" }));
    await grant.refuse(state[2]);
    return page("这个 GitHub 账号不能用在这里", "在这个组织里，这个 GitHub 账号已经属于另一位成员，或者你已经授权过另一个 GitHub 账号。要换账号，请先在聊天里让我取消原来的授权；否则请用你自己的账号重新操作，或联系管理员。", 403);
  } catch {
    return page("授权没有成功", "请回到聊天里，需要的话再跟我说一遍。如果一直不成功，请联系管理员。", 400);
  }
}

/** A page of this module's own words: nothing from the request is written into it but what was checked letter by letter first. */
function page(title: string, body: string, status = 200, form = ""): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.5rem;color:#1f2329}h1{font-size:1.4rem}p{line-height:1.7;color:#51565d}button{font-size:1rem;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#1f2329;color:#fff}</style></head><body><h1>${title}</h1><p>${body}</p>${form}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", "x-content-type-options": "nosniff" } });
}
