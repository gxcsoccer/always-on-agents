/**
 * GitHub connector.
 *
 * Inbound: webhooks, verified by their HMAC signature, mapped to a tenant through the App
 * installation, and reduced to the few event types the agent acts on. Each repository is a scope;
 * each pull request is a conversation within it.
 *
 * Identity: an event caused by a person who addressed the agent (a comment that mentions it) is
 * `explicit`. Everything else — a push, a CI result, a PR being opened — merely happened, and must
 * never be treated as that person's instruction or consent.
 */
import type { Env } from "../env";
import { type InboundEvent, NOT_FOR_THE_AGENT, type Principal, type Scope, type Target, scopeName } from "../events";
import { registry } from "../registry";
import { githubTokenFor } from "./github-app";
import { authorisationRevoked, githubComment, githubCreateIssue, githubDisconnect, grantCallback, grantConfirm, grantHolds, grantInvitation, grantName, grantOffers } from "./github-grant";
import { type CodeReview, type Connector, DeliveryDeferred, type OutboundMessage, type Receipt, type Standing } from "./types";

export const githubConnector: Connector = {
  name: "github",
  // Also plugged into the chat connector: what a person there can have done on GitHub in their own name.
  serves: ["feishu"],
  tools: [githubCreateIssue, githubComment, githubDisconnect],
  holds: grantHolds,
  offers: grantOffers,
  invitation: grantInvitation,
  async http(request, env, path) {
    if (path[0] === "webhook" && request.method === "POST") return handleGithubWebhook(request, env);
    if (path[0] === "oauth" && path[1] === "callback" && path.length === 2 && request.method === "GET") return grantCallback(request, env);
    if (path[0] === "oauth" && path[1] === "confirm" && path.length === 2 && request.method === "POST") return grantConfirm(request, env);
    return json({ error: "not found" }, 404);
  },
  async admin({ method, path, body }, env) {
    // One person's authorisation to act as them on GitHub: whether it stands, and taking it away (here only).
    if (path[0] === "github" && path[1] === "grants" && path.length === 6 && (method === "GET" || method === "DELETE")) {
      const name = await grantName({ tenant: path[2], chat_app_id: path[3], tenant_key: path[4], open_id: path[5] });
      if (method === "DELETE") await env.GITHUB_GRANTS.getByName(name).drop();
      return json(await env.GITHUB_GRANTS.getByName(name).status());
    }
    if (path[0] !== "tenants" || method !== "POST") return undefined;
    if (path[2] === "github-installations") {
      await registry(env).linkGithubInstallation(String((await body()).installation_id ?? ""), path[1]);
      return json({ ok: true });
    }
    if (path[2] === "github-repos") {
      // The secret is returned once, to be set on that repository's webhook.
      return json({ ok: true, ...(await registry(env).linkGithubRepo(String((await body()).repo ?? ""), path[1])) });
    }
    return undefined;
  },
  channel: { deliver: deliverGithub, standing: commentStanding },
};

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// The agent's own handle, whole: "@always-on-agent-staging" is someone else.
const DEFAULT_HANDLE = "always-on-agent";
/** Matches a mention of exactly this handle (not a longer one that starts with it), or "/agent". */
const mentionOf = (handle: string, flags = "i") =>
  new RegExp(`(?<![\\w@/.-])@${handle.replace(/[^\w-]/g, "")}(?:\\[bot\\])?(?![\\w-])|^\\s*\\/agent(?![\\w-])`, flags);

/**
 * A comment's own words: without the lines it quotes from others and without code. Fences follow
 * GitHub's rule: a block opened by a run of backticks or tildes is closed only by a run of the same
 * character at least as long, so a shorter fence inside it is part of the code.
 */
function ownWords(body: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number; prefix: string } | undefined;
  let quoting = false;
  for (const line of body.split("\n")) {
    // At any indentation: inside a list item a fence sits deeper than three spaces. Taking a line
    // for code when it was not only means a mention there has to be made again.
    const opener = /^([ \t>*+\-\d.)]*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // Closed only by a bare run of the same character, at least as long, in the same container:
      // a fence quoted inside the code does not end it.
      if (opener && opener[1] === fence.prefix && opener[2][0] === fence.char && opener[2].length >= fence.length && opener[3].trim() === "") fence = undefined;
      continue;
    }
    if (opener) {
      fence = { char: opener[2][0], length: opener[2].length, prefix: opener[1] };
      continue;
    }
    if (line.trim() === "") {
      quoting = false;
      continue;
    }
    // A quoted line, and the lines that run on from it until a blank one, are someone else's words.
    if (/^\s*>/.test(line)) quoting = true;
    if (quoting) continue;
    // Indented far enough to be a code block.
    if (/^( {4}|\t)/.test(line)) continue;
    kept.push(line);
  }
  // Code spans, which may run over several lines.
  return kept.join("\n").replace(/(`+)[\s\S]*?\1/g, " ");
}

/**
 * The lines of each file that a comment can be attached to: those the pull request adds or shows
 * as context, numbered as in the new version of the file. GitHub refuses a comment anywhere else,
 * and with it the whole review. Only the files in `wanted` are looked at, when it is given.
 */
export function commentableLines(files: { filename?: string; patch?: string }[], wanted?: Set<string>): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  for (const file of files) {
    if (!file.filename || !file.patch || (wanted && !wanted.has(file.filename))) continue;
    const set = new Set<number>();
    let at = 0;
    for (const line of file.patch.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) at = Number(hunk[1]);
      else if (at > 0 && (line.startsWith("+") || line.startsWith(" "))) set.add(at++);
    }
    lines.set(file.filename, set);
  }
  return lines;
}

/**
 * Makes text that came from a worker safe to post under the agent's name. A finding is evidence
 * copied from an unattended process, so it must not act on anyone: a mention would notify a
 * person, and a suggestion block would offer them a change to apply.
 *
 * Code is left exactly as it is, in fenced blocks, indented blocks and code spans alike: a
 * command someone copies must be the command that was written, and nothing in code notifies
 * anyone. In prose, a mention is put in a code span, where it is plainly visible and inert. A
 * suggestion block becomes an ordinary code block.
 *
 * `allowed`: names (in lower case) whose mention is left as it is: the ones a person wrote
 * themselves, where the text goes out in their name.
 */
export function inert(text: string, allowed?: ReadonlySet<string>): string {
  return prose(text, (passage) => passage.replace(MENTION, (match, span, name) => (span || allowed?.has(String(name).toLowerCase()) ? match : `\`@${name}\``)));
}

/**
 * The names a text mentions (@name, @org/team), in lower case, as its writer's own: not in code,
 * and not in what they quote from someone else (lines that begin with ">").
 */
export function mentionsOf(text: string): Set<string> {
  const names = new Set<string>();
  const own = text.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n");
  prose(own, (passage) => passage.replace(MENTION, (match, span, name) => (span ? match : (names.add(String(name).toLowerCase()), match))));
  return names;
}

/** A code span (left alone), or a mention. */
const MENTION = /(`+)[\s\S]*?\1|(?<![\w.`@/])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?)/g;

/**
 * A text with each passage of prose put through `change`, and its code blocks left as they are.
 * An indented line is code only where Markdown reads it so: after a blank line (or at the start),
 * and not under a list item, where an indented line is the item going on. Where it is not plain
 * which it is, it is taken as prose: a mention that would notify is the thing not to let through.
 */
function prose(text: string, change: (passage: string) => string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    // Code spans may run over several lines; everything between them is prose.
    out.push(change(lines.join("\n")));
    lines = [];
  };
  let before: "start" | "blank" | "code" | "prose" = "start";
  let listed = false;
  for (const line of text.split("\n")) {
    const opener = /^([ \t>]*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (opener && opener[2][0] === fence.char && opener[2].length >= fence.length && opener[3].trim() === "") fence = undefined;
      out.push(line);
      continue;
    }
    if (opener) {
      flush();
      fence = { char: opener[2][0], length: opener[2].length };
      out.push(/^\s*suggestion\b/i.test(opener[3]) ? `${opener[1]}${opener[2]}text` : line);
      before = "prose";
      continue;
    }
    const blank = line.trim() === "";
    const indented = /^( {4}|\t)/.test(line);
    if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line)) listed = true;
    // A list is over once something that is neither part of it nor indented under it follows a blank line.
    else if (!blank && !indented && before === "blank") listed = false;
    if (!blank && indented && !listed && before !== "prose") {
      // Indented far enough to be a code block, where one can begin.
      flush();
      out.push(line);
      before = "code";
      continue;
    }
    lines.push(line);
    // (A blank line between lines of an indented block is part of it.)
    before = blank ? (before === "code" ? "code" : "blank") : "prose";
  }
  flush();
  return out.join("\n");
}

/** A path shown literally, whatever characters it holds, spaces included. */
export function literal(path: string): string {
  const fence = "`".repeat(Math.max(0, ...[...path.matchAll(/`+/g)].map((run) => run[0].length)) + 1);
  return `${fence} ${path.replace(/[\r\n\t]/g, " ")} ${fence}`;
}

/**
 * The account this deployment posts as, where that is known: an App's bot. With a plain token, or
 * an App whose handle is not configured, it is not known, and an earlier post is then recognised
 * by its marker alone.
 */
function self(env: Env): string | undefined {
  return env.GITHUB_APP_ID && env.GITHUB_BOT_HANDLE ? `${env.GITHUB_BOT_HANDLE}[bot]`.toLowerCase() : undefined;
}

/**
 * Whether something found on GitHub is this agent's own earlier post of the message with this
 * marker: it ends in the marker and, where the posting account is known, was posted by it.
 * Someone else's text that merely quotes the marker is not.
 */
export function isOurs(found: { body?: string; user?: { login?: string } }, marker: string, own: string | undefined): boolean {
  if (!found.body?.trimEnd().endsWith(marker)) return false;
  return own === undefined || found.user?.login?.toLowerCase() === own;
}

/** Throws for a response that was not a success, carrying GitHub's own word on when to try again. */
async function refused(response: Response, doing: string): Promise<never> {
  const text = await response.text().catch(() => "");
  const said = `GitHub returned ${response.status} ${doing}: ${text.slice(0, 200)}`;
  const after = Number(response.headers.get("retry-after"));
  const reset = response.headers.get("x-ratelimit-remaining") === "0" ? Number(response.headers.get("x-ratelimit-reset")) * 1_000 : NaN;
  // GitHub's own time where it gives one. Throttled without one (a secondary rate limit), its
  // guidance is to wait at least a minute. An ordinary refusal, such as a missing permission, is
  // not slowed down.
  const throttled = response.status === 429 || (response.status === 403 && /secondary rate limit|abuse detection/i.test(text));
  const notBefore =
    Number.isFinite(after) && after > 0 ? Date.now() + after * 1_000 : Number.isFinite(reset) && reset > Date.now() ? reset : throttled ? Date.now() + SECONDARY_LIMIT_WAIT_MS : undefined;
  throw notBefore ? new DeliveryDeferred(said, notBefore) : new Error(said);
}

/** Whether GitHub asked for the next request to wait. */
function mustWait(response: Response): boolean {
  return response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0" || response.status === 429;
}

const SECONDARY_LIMIT_WAIT_MS = 60_000;
type Headers = Record<string, string>;
const SEARCH_PAGES = 10;

/**
 * An earlier attempt at this message posted as a pull request review, if one got through. Reviews
 * are listed oldest first and cannot be asked for by time, so they are read from the newest back
 * to before the message was written. If that cannot be finished, this throws: not knowing whether
 * something is already there is no reason to post it again.
 */
async function earlierReview(headers: Headers, pull: string, marker: string, since: number, own: string | undefined): Promise<Receipt | undefined> {
  type Listed = { id: number; body?: string; state?: string; submitted_at?: string; user?: { login?: string } };
  const read = async (page: number) => {
    const listed = await fetch(`${pull}/reviews?per_page=100&page=${page}`, { headers });
    if (!listed.ok) await refused(listed, "listing reviews");
    return { batch: (await listed.json()) as Listed[], link: listed.headers.get("link") ?? "" };
  };
  // A draft nobody can see yet is not a published review.
  const ours = (batch: Listed[]): Receipt | undefined => {
    const found = batch.find((each) => each.state !== "PENDING" && isOurs(each, marker, own));
    return found && { subject: `github:review:${found.id}`, holder: fingerprint(found.body ?? ""), posted_at: Date.parse(found.submitted_at ?? "") || undefined };
  };
  const first = await read(1);
  const last = Number(/[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(first.link)?.[1] ?? NaN);
  if (Number.isFinite(last)) {
    for (let page = last, pages = 0; page >= 1; page--, pages++) {
      if (pages >= SEARCH_PAGES) throw new Error("too many reviews on this pull request to tell whether this one was already posted");
      const { batch } = page === 1 ? first : await read(page);
      const found = ours(batch);
      if (found) return found;
      if (batch.some((each) => (Date.parse(each.submitted_at ?? "") || Infinity) < since)) return undefined;
    }
    return undefined;
  }
  // No "last" link: one page, or a listing that only says what comes next. Follow it to the end.
  let current = first;
  for (let page = 1; ; page++) {
    const found = ours(current.batch);
    if (found) return found;
    if (!/rel="next"/.test(current.link)) return undefined;
    if (page >= SEARCH_PAGES) throw new Error("too many reviews on this pull request to tell whether this one was already posted");
    current = await read(page + 1);
  }
}

/** An earlier attempt at this message posted as an ordinary comment, if one got through. */
async function earlierComment(headers: Headers, comments: string, marker: string, since: number, own: string | undefined): Promise<{ id: number; body?: string; created_at?: string } | undefined> {
  // Only comments since the message was written can be an earlier attempt at it. The list is
  // oldest first and paged, so it is followed to its end; if it has no end within the budget, the
  // answer is not known and nothing is posted.
  for (let page = 1; ; page++) {
    if (page > SEARCH_PAGES) throw new Error("too many comments here to tell whether this one was already posted");
    const recent = await fetch(`${comments}?per_page=100&page=${page}&since=${encodeURIComponent(new Date(since).toISOString())}`, { headers });
    if (!recent.ok) await refused(recent, "listing comments");
    const batch = (await recent.json()) as { id: number; body?: string; created_at?: string; user?: { login?: string } }[];
    const found = batch.find((comment) => isOurs(comment, marker, own));
    if (found) return found;
    if (batch.length < 100) return undefined;
  }
}

/**
 * Posts a review of the pull request's current head: the summary as its body, each comment on
 * its line. It only comments; approving or requesting changes is left to people.
 *
 * A comment on a line the change neither touches nor shows is kept, in the body, with its file
 * and line: GitHub accepts comments only on lines of the diff.
 */
async function postReview(headers: Headers, pull: string, head: string, review: CodeReview, marker: string): Promise<Receipt> {
  // Which of the lines asked for can take a comment. Pages are read as they come and only the
  // files in question are looked at; a pull request can list up to 3,000 files.
  const wanted = new Set(review.comments.map((c) => c.path));
  const lines = new Map<string, Set<number>>();
  for (let page = 1; wanted.size > 0 && page <= 30; page++) {
    const listed = await fetch(`${pull}/files?per_page=100&page=${page}`, { headers });
    if (!listed.ok) await refused(listed, "listing the changed files");
    const batch = (await listed.json()) as { filename?: string; patch?: string }[];
    for (const [path, set] of commentableLines(batch, wanted)) lines.set(path, set);
    if (batch.length < 100) break;
  }
  const placed = review.comments.filter((c) => lines.get(c.path)?.has(c.line));
  const body = (attached: typeof placed) => {
    const rest = review.comments.filter((c) => !attached.includes(c));
    return [inert(review.summary), `Reviewed at ${head.slice(0, 7)}.`, ...(rest.length > 0 ? ["Not on a line this pull request changes or shows:", ...rest.map(inWords)] : []), marker].join("\n\n");
  };
  const post = (attached: typeof placed) =>
    fetch(`${pull}/reviews`, {
      method: "POST",
      headers,
      // The commit is named, so the comments stay on the revision that was reviewed even if the
      // pull request moves between reading it and posting.
      body: JSON.stringify({ commit_id: head, event: "COMMENT", body: body(attached), comments: attached.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: inert(c.body) })) }),
    });
  let response = await post(placed);
  // GitHub would not take one of the lines after all: the same review, all in the body. Only for
  // that, and never when it asked for a pause. Any other refusal is not answered by posting again;
  // it is left to the next attempt, which first looks for what is already there.
  if (response.status === 422 && placed.length > 0 && !mustWait(response)) {
    const errors = JSON.stringify(((await response.clone().json().catch(() => ({}))) as { errors?: unknown }).errors ?? "");
    if (/\b(line|position|diff|path|hunk)\b/i.test(errors)) response = await post([]);
  }
  if (!response.ok) await refused(response, "posting the review");
  const created = (await response.json()) as { id: number; body?: string };
  return { subject: `github:review:${created.id}`, holder: fingerprint(created.body ?? "") };
}

/** One comment of a review, in words: where it is about, shown literally, then what it says. */
function inWords(comment: CodeReview["comments"][number]): string {
  return `${literal(`${comment.path}:${comment.line}`)}\n${inert(comment.body)}`;
}

/** A short fingerprint of a comment's text, to tell two revisions with the same timestamp apart. */
export function fingerprint(text: string): string {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `${(b >>> 0).toString(16)}${(a >>> 0).toString(16)}:${text.length}`;
}

/**
 * Asks GitHub what a comment says now. Webhooks can lag, so before an approval is acted on the
 * comment it was read from is looked at again. If GitHub cannot be asked, for whatever reason,
 * this throws: an approval is not acted on unseen. Returns undefined only for a subject that is
 * not a GitHub comment of this scope. A subject looks like "github:comment:123".
 */
export async function commentStanding(env: Env, scope: Scope, subject: string): Promise<Standing | undefined> {
  const id = /^github:comment:(\d+)$/.exec(subject)?.[1];
  if (!id || scope.kind !== "repo") return undefined;
  const issued = await githubTokenFor(env, scope.tenant, scope.id);
  if (!issued) throw new Error("GitHub cannot be asked what the comment says now: this tenant no longer has access to the repository");
  const response = await fetch(`https://api.github.com/repos/${scope.id}/issues/comments/${id}`, {
    headers: { authorization: `Bearer ${issued.token}`, accept: "application/vnd.github+json", "user-agent": "always-on-agent" },
  });
  if (response.status === 404 || response.status === 410) return { revision: Number.MAX_SAFE_INTEGER, holder: "", deleted: true, edited: true };
  if (!response.ok) throw new Error(`GitHub could not be asked what the comment says now (${response.status})`);
  const comment = (await response.json()) as { body?: string; updated_at?: string; created_at?: string };
  // A comment that was ever edited says so, even if it was later put back as it was.
  return { revision: Date.parse(comment.updated_at ?? comment.created_at ?? "") || 0, holder: fingerprint(comment.body ?? ""), deleted: false, edited: comment.updated_at !== comment.created_at };
}

export async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  // Until the signature has been checked the caller is unknown, so every refusal is the same 401,
  // whatever was wrong: a missing header, a body that is not JSON, an unknown source, a bad signature.
  const refused = () => json({ error: "not accepted" }, 401);
  const raw = await request.text();
  const type = request.headers.get("x-github-event");
  if (!type) return refused();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return refused();
  }

  // A person took their authorisation of the App away on GitHub. It names no installation and no
  // repository: it is the App's own, signed with the App's secret, and is about that account
  // wherever it authorised.
  if (type === "github_app_authorization") {
    if (!env.GITHUB_WEBHOOK_SECRET || !(await verifySignature(env.GITHUB_WEBHOOK_SECRET, raw, request.headers.get("x-hub-signature-256")))) return refused();
    const account: unknown = payload?.sender?.id;
    if (payload?.action !== "revoked" || typeof account !== "number") return json({ ignored: "nothing to do" }, 202);
    return json({ revoked: await authorisationRevoked(env, account) }, 202);
  }

  // Nothing in the body is believed yet; it is only used to pick which secret must have signed it.
  // An App delivery names its installation and is signed with the App's secret. A webhook set on
  // one repository names only the repository and is signed with that repository's own secret, so
  // knowing one repository's secret is no help in forging events for another.
  const installationId: unknown = payload?.installation?.id;
  const installation = typeof installationId === "number" || typeof installationId === "string" ? String(installationId) : undefined;
  const repoName: unknown = payload?.repository?.full_name;
  const linkedRepo = typeof repoName === "string" && /^[\w.-]+\/[\w.-]+$/.test(repoName) ? await registry(env).githubRepo(repoName) : null;
  let tenant: string | null;
  let secret: string | null | undefined;
  if (installation) {
    tenant = await registry(env).tenantForGithubInstallation(installation);
    secret = env.GITHUB_WEBHOOK_SECRET;
    // A repository claimed by one tenant must not arrive through another tenant's installation.
    if (tenant && linkedRepo && linkedRepo.tenant !== tenant) tenant = null;
  } else {
    tenant = linkedRepo?.tenant ?? null;
    secret = linkedRepo?.secret;
  }
  if (!tenant || !secret || !(await verifySignature(secret, raw, request.headers.get("x-hub-signature-256")))) return refused();

  const normalized = normalize(type, payload, env.GITHUB_BOT_HANDLE || DEFAULT_HANDLE);
  if (!normalized) return json({ ignored: `nothing to do for ${type}.${payload.action ?? ""}` }, 202);

  const scope: Scope = { tenant, kind: "repo", id: normalized.repo };
  const brain = env.BRAIN.getByName(scopeName(scope));

  // A comment that was edited or deleted: what was said in it before no longer stands, whoever
  // changed it and in whatever order GitHub delivers the events.
  // An edit that leaves nothing for the agent (the mention or the code was taken out, or someone
  // else made it) still voids the earlier text, and says so: no new message will follow it.
  const dropped = async (why: string) => {
    if (normalized.revise) await brain.revise(normalized.revise.subject, normalized.revise.revision, normalized.revise.deleted, normalized.revise.deleted ? "" : NOT_FOR_THE_AGENT);
    return json({ ignored: why }, 202);
  };
  const event = normalized.event;
  if (!event) return dropped("recorded");

  // A linked account acts as that tenant user; an unlinked one is still identified, just not as a
  // user. Accounts are linked by GitHub's numeric id, which never changes hands. A login can be
  // renamed and then claimed by someone else.
  if (event.principal.kind === "human") {
    const accountId = event.principal.id.replace(/^github:/, "");
    const user = await registry(env).resolveIdentity(tenant, "github", accountId);
    // A user id of the form "github:…", which can no longer be given, was never counted as a
    // member in a repository. It still is not.
    if (user) event.principal = { ...event.principal, id: user, unlinked: user.startsWith("github:") ? true : undefined };
  }
  // An unaddressed comment is only for the agent if it quotes the code of a question that is open
  // in that same pull request. The whole comment is checked, however long it is.
  if (normalized.onlyIfQuotes !== undefined && !(await brain.quotesOpenQuestion(normalized.onlyIfQuotes, event.session_key))) {
    return dropped("the comment does not address the agent");
  }
  const result = await brain.ingest(event);
  return json({ ...result, scope: scopeName(scope), kind: event.kind }, 202);
}

/**
 * Exported for tests. Returns undefined for events the agent does not act on.
 *
 * The dedupe id is built from the signed body (what happened, to what, at which revision), not from
 * the delivery header: that header is outside the signature, so a captured request could be replayed
 * under a new delivery id.
 */
export function normalize(
  type: string,
  payload: any,
  /** The agent's own account name on GitHub, which is how people address it. */
  handle: string = DEFAULT_HANDLE,
): { repo: string; event?: InboundEvent; onlyIfQuotes?: string; revise?: { subject: string; revision: number; deleted: boolean; holder: string } } | undefined {
  const repo: string | undefined = payload.repository?.full_name;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  const sender = payload.sender ?? {};
  const base = { source: "github" };
  // Identified by the account's numeric id; the login is only for display.
  const account = `github:${Number.isInteger(sender.id) ? sender.id : `login:${sender.login}`}`;
  const person = (explicit: boolean): Principal =>
    sender.type === "Bot"
      ? { kind: "automation", id: account, display: sender.login, explicit: false }
      : // Not a tenant user until the account is found to be linked to one (see handleGithubWebhook).
        { kind: "human", id: account, display: sender.login, explicit, unlinked: true };
  const replyTo = (number: number): Target => ({ connector: "github", address: { repo, number: String(number) } });

  if (type === "pull_request" && ["opened", "reopened", "ready_for_review", "synchronize"].includes(payload.action)) {
    const pr = payload.pull_request;
    return {
      repo,
      event: {
        ...base,
        source_id: `pr:${pr.id ?? pr.number}:${payload.action}:${pr.head?.sha ?? ""}`,
        kind: "github.pull_request",
        session_key: `pr:${pr.number}`,
        principal: person(false),
        text: `Pull request #${pr.number} "${pr.title}" was ${payload.action} by ${sender.login} (${pr.head?.ref} -> ${pr.base?.ref}). ${pr.html_url}`,
        data: { number: pr.number, action: payload.action, head_sha: pr.head?.sha, author: pr.user?.login },
        reply_to: replyTo(pr.number),
      },
    };
  }

  if (type === "issue_comment" && ["created", "edited", "deleted"].includes(payload.action) && Number.isInteger(payload.comment?.id)) {
    const subject = `github:comment:${payload.comment.id}`;
    const revision = Date.parse(payload.comment.updated_at ?? payload.comment.created_at ?? "") || 0;
    // A deletion says nothing; it only makes what the comment said void. It may be a moderator's
    // doing, so it is never attributed to anyone as a message.
    if (payload.action === "deleted") return { repo, revise: { subject, revision: Number.MAX_SAFE_INTEGER, deleted: true, holder: "" } };
    const body: string = String(payload.comment.body ?? "");
    // What the comment says at this revision. Two revisions can carry the same timestamp (GitHub's
    // are whole seconds); the fingerprint of the text tells them apart.
    const holder = fingerprint(body);
    const revise = { subject, revision, deleted: false, holder };

    // Only the author's own words are the author's message. Someone else editing the comment still
    // voids its earlier text (above), but does not speak for the author.
    const byAuthor = payload.comment.user?.id !== undefined && payload.comment.user.id === sender.id;
    // The agent's own comments carry a marker. When it posts under a person's token they come back
    // looking like that person's words; they are not, and must never be read as a request or a reply.
    const own = body.includes("<!-- always-on-agent:");
    // Anyone can comment on a public repository. Only people with a standing in it can give the
    // agent work or answer its questions.
    const trusted = TRUSTED_ASSOCIATIONS.has(payload.comment.author_association);
    if (!byAuthor || own || !trusted || sender.type === "Bot") return payload.action === "edited" ? { repo, revise } : undefined;

    // Comments that do not address the agent are other people's conversation, with one exception:
    // a comment that quotes the code of a question the agent has open in this pull request is a
    // reply to that question, whatever its wording. Whether it does is for the caller to ask the
    // Brain, which is given the whole text. A mention inside a quotation or code is not a mention.
    const mentioned = mentionOf(handle, "im").test(ownWords(body));
    const number = payload.issue.number;
    return {
      repo,
      revise,
      ...(mentioned ? {} : { onlyIfQuotes: body }),
      event: {
        ...base,
        source_id: payload.action === "created" ? `comment:${payload.comment.id}` : `comment:${payload.comment.id}:edited:${revision}`,
        kind: "message",
        session_key: `pr:${number}`,
        principal: person(true),
        // The agent's own handle is removed here, where it is known. Any other @handle stays in the
        // text, so "@someone-else approve K7PW" is not read as an approval addressed to this agent.
        text: `${payload.action === "edited" ? "[edited their earlier comment to] " : ""}${body.replace(mentionOf(handle, "gim"), "").trim()}`,
        data: {
          number,
          comment_id: payload.comment.id,
          is_pull_request: Boolean(payload.issue.pull_request),
          // Shown to the model next to the comment, which on its own does not say where it was made.
          where: `${payload.issue.pull_request ? "pull request" : "issue"} #${number} of ${repo}`,
          // Which revision of which comment this is, so a later edit or deletion can void it.
          subject,
          revision,
          holder,
          // Admitted only as a reply to an open question; it is not a request to the agent.
          ...(mentioned ? {} : { reply_only: true }),
        },
        reply_to: replyTo(number),
      },
    };
  }

  const failedRun = (type === "check_run" && payload.action === "completed" && payload.check_run?.conclusion === "failure" && payload.check_run) ||
    (type === "workflow_run" && payload.action === "completed" && payload.workflow_run?.conclusion === "failure" && payload.workflow_run);
  if (failedRun) {
    const number: number | undefined = failedRun.pull_requests?.[0]?.number;
    return {
      repo,
      event: {
        ...base,
        source_id: `${type}:${failedRun.id ?? failedRun.head_sha}:failure`,
        kind: "github.ci_failed",
        session_key: number ? `pr:${number}` : `ci:${failedRun.head_branch ?? "unknown"}`,
        // CI failing is nobody's request, whoever pushed or re-ran it.
        principal: { kind: "automation", id: "github:ci", display: "GitHub CI", explicit: false },
        text: `CI failed: "${failedRun.name}" on ${failedRun.head_branch ?? "?"} at ${String(failedRun.head_sha ?? "").slice(0, 7)}. ${failedRun.html_url ?? ""}`,
        data: { number, head_sha: failedRun.head_sha, name: failedRun.name },
        ...(number ? { reply_to: replyTo(number) } : {}),
      },
    };
  }
  return undefined;
}

export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const given = header.slice(7);
  // Compare every byte regardless of where the first difference is.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ Number.parseInt(given.slice(i * 2, i * 2 + 2), 16);
  return diff === 0;
}

/**
 * Posts a comment on the pull request or issue the conversation is about. The comment carries a
 * hidden marker, and a retry first looks for it: GitHub may have accepted the comment even though
 * we never saw the response.
 */
export async function deliverGithub(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<Receipt> {
  const { repo, number } = target.address;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^\d+$/.test(number ?? "")) throw new Error("bad GitHub address");
  // A repository scope speaks only on its own repository.
  if (scope.kind !== "repo" || scope.id.toLowerCase() !== repo.toLowerCase()) throw new Error("this conversation cannot post to that repository");
  const issued = await githubTokenFor(env, scope.tenant, repo);
  if (!issued) throw new Error("no GitHub credentials cover this repository for this tenant");
  const headers = {
    authorization: `Bearer ${issued.token}`,
    accept: "application/vnd.github+json",
    "user-agent": "always-on-agent",
    "content-type": "application/json",
  };
  const marker = `<!-- always-on-agent:${message.idem.replace(/[^\w:.|-]/g, "")} -->`;
  const comments = `https://api.github.com/repos/${repo}/issues/${number}/comments`;
  const pull = `https://api.github.com/repos/${repo}/pulls/${number}`;
  const own = self(env);
  const since = (message.created_at ?? Date.now()) - 60_000;

  // A review can go out in one of two forms, and which one depends on where the pull request is
  // at the moment of sending. So an earlier attempt is looked for in both places before anything
  // is posted: the pull request may have moved between that attempt and this one.
  let head: string | undefined;
  if (message.review) {
    const found = await fetch(pull, { headers });
    if (found.ok) {
      head = ((await found.json()) as { head?: { sha?: string } }).head?.sha;
      if (!head) throw new Error("GitHub did not say which commit the pull request is at");
      const earlier = await earlierReview(headers, pull, marker, since, own);
      if (earlier) return earlier;
    } else if (found.status !== 404) await refused(found, "reading the pull request");
  }

  let shown: string;
  if (message.idem.startsWith("ask:")) {
    // A question someone will approve is shown literally. Rendered as Markdown, a branch called
    // __release__ would appear as "release" in bold, which is not the branch being pushed.
    shown = `<pre>${message.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  } else if (message.review) {
    // A review in words: what a worker found, made inert. Where this is a pull request and the
    // review is not known to be of its current head, a note says which commit it covers: a
    // verdict on one commit must not be read as a verdict on another.
    const review = message.review;
    const note =
      head === undefined || review.commit === head
        ? []
        : [
            review.commit
              ? `This review is of commit ${review.commit.slice(0, 7)}. The pull request has since moved to ${head.slice(0, 7)}, which this review does not cover.`
              : `This review does not say which commit it is of. The pull request is now at ${head.slice(0, 7)}, which it may not cover.`,
          ];
    shown = [...note, inert(review.summary), ...review.comments.map(inWords)].join("\n\n");
  } else shown = message.text;
  const posted = `${shown}\n\n${marker}`;

  const earlier = await earlierComment(headers, comments, marker, since, own);
  // For a question, the receipt is for the text as written here, not as found: if someone already
  // changed the comment, it must not pass for what the agent said.
  if (earlier) return { subject: `github:comment:${earlier.id}`, holder: fingerprint(message.review ? (earlier.body ?? "") : posted), posted_at: Date.parse(earlier.created_at ?? "") || undefined };

  // Only a review known to be of the pull request's current head is posted as a review, with its
  // comments on the lines they are about. A line number means nothing against another revision.
  if (message.review && head !== undefined && message.review.commit === head) return postReview(headers, pull, head, message.review, marker);

  const response = await fetch(comments, { method: "POST", headers, body: JSON.stringify({ body: posted }) });
  if (!response.ok) await refused(response, "posting the comment");
  const created = (await response.json()) as { id: number };
  return { subject: `github:comment:${created.id}`, holder: fingerprint(posted) };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
