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
import type { Connector, OutboundMessage, Receipt, Standing } from "./types";

export const githubConnector: Connector = {
  name: "github",
  async http(request, env, path) {
    if (path[0] === "webhook" && request.method === "POST") return handleGithubWebhook(request, env);
    return json({ error: "not found" }, 404);
  },
  async admin({ method, path, body }, env) {
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
    if (user) event.principal = { ...event.principal, id: user, unlinked: undefined };
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

  // A question someone will approve is shown literally. Rendered as Markdown, a branch called
  // __release__ would appear as "release" in bold, which is not the branch being pushed.
  const shown = message.idem.startsWith("ask:") ? `<pre>${message.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>` : message.text;
  const posted = `${shown}\n\n${marker}`;

  // Only comments since this message was written can be an earlier attempt at it. The list is
  // oldest-first and paged, so follow it to the end rather than trusting the first page.
  const since = new Date((message.created_at ?? Date.now()) - 60_000).toISOString();
  for (let page = 1; page <= 10; page++) {
    const recent = await fetch(`${comments}?per_page=100&page=${page}&since=${encodeURIComponent(since)}`, { headers });
    if (!recent.ok) throw new Error(`GitHub returned ${recent.status} listing comments`);
    const batch = (await recent.json()) as { id: number; body?: string; created_at?: string }[];
    const earlier = batch.find((comment) => comment.body?.includes(marker));
    // The receipt is for the text as written here, not as found: if someone already changed the
    // comment, it must not pass for what the agent said.
    if (earlier) return { subject: `github:comment:${earlier.id}`, holder: fingerprint(posted), posted_at: Date.parse(earlier.created_at ?? "") || undefined };
    if (batch.length < 100) break;
  }

  const response = await fetch(comments, { method: "POST", headers, body: JSON.stringify({ body: posted }) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const created = (await response.json()) as { id: number };
  return { subject: `github:comment:${created.id}`, holder: fingerprint(posted) };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
