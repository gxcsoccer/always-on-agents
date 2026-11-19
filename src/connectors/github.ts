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
import { type InboundEvent, type Principal, type Scope, type Target, scopeName } from "../events";
import { registry } from "../registry";
import { githubTokenFor } from "./github-app";
import type { OutboundMessage } from "./index";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// A verb in any capitalisation, a separator, then a four-character code. The code's own case is
// checked by the Brain; here the point is only that "Deny K7PW" must not be dropped while
// "approve K7PW" gets through, which would discard a person's change of mind.
const DECISION_REPLY = /^\s*(?:approve|deny|同意|批准|拒绝|不同意)[\s:：]+[A-Za-z0-9]{4}\s*[.!。！]?\s*$/i;
const MENTION = /(^|\s)@always-on-agent\b|^\s*\/agent\b/i;

export async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const type = request.headers.get("x-github-event");
  if (!type) return json({ error: "missing GitHub headers" }, 400);
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }

  // Nothing in the body is believed yet; it is only used to pick which secret must have signed it.
  // An App delivery names its installation and is signed with the App's secret. A webhook set on
  // one repository names only the repository and is signed with that repository's own secret, so
  // knowing one repository's secret is no help in forging events for another.
  const installation = payload?.installation?.id;
  const repoName: unknown = payload?.repository?.full_name;
  const linkedRepo = typeof repoName === "string" && /^[\w.-]+\/[\w.-]+$/.test(repoName) ? await registry(env).githubRepo(repoName) : null;
  let tenant: string | null;
  let secret: string | null | undefined;
  if (installation) {
    tenant = await registry(env).tenantForGithubInstallation(String(installation));
    secret = env.GITHUB_WEBHOOK_SECRET;
    // A repository claimed by one tenant must not arrive through another tenant's installation.
    if (tenant && linkedRepo && linkedRepo.tenant !== tenant) return json({ ignored: "this repository is linked to a different tenant" }, 202);
  } else {
    tenant = linkedRepo?.tenant ?? null;
    secret = linkedRepo?.secret;
  }
  if (!tenant) return json({ ignored: "this installation or repository is not linked to a tenant" }, 202);
  if (!secret) return json({ error: "no webhook secret is configured for this source" }, 503);
  if (!(await verifySignature(secret, raw, request.headers.get("x-hub-signature-256")))) return json({ error: "bad signature" }, 401);

  const normalized = normalize(type, payload);
  if (!normalized) return json({ ignored: `nothing to do for ${type}.${payload.action ?? ""}` }, 202);

  // A linked account acts as that tenant user; an unlinked one is still identified, just not as a
  // user. Accounts are linked by GitHub's numeric id, which never changes hands. A login can be
  // renamed and then claimed by someone else.
  if (normalized.event.principal.kind === "human") {
    const accountId = normalized.event.principal.id.replace(/^github:/, "");
    const user = await registry(env).resolveIdentity(tenant, "github", accountId);
    if (user) normalized.event.principal.id = user;
  }

  const scope: Scope = { tenant, kind: "repo", id: normalized.repo };
  const brain = env.BRAIN.getByName(scopeName(scope));
  const result = await brain.ingest(normalized.event);
  return json({ ...result, scope: scopeName(scope), kind: normalized.event.kind }, 202);
}

/**
 * Exported for tests. Returns undefined for events the agent does not act on.
 *
 * The dedupe id is built from the signed body (what happened, to what, at which revision), not from
 * the delivery header: that header is outside the signature, so a captured request could be replayed
 * under a new delivery id.
 */
export function normalize(type: string, payload: any): { repo: string; event: InboundEvent } | undefined {
  const repo: string | undefined = payload.repository?.full_name;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  const sender = payload.sender ?? {};
  const base = { source: "github" };
  // Identified by the account's numeric id; the login is only for display.
  const account = `github:${Number.isInteger(sender.id) ? sender.id : `login:${sender.login}`}`;
  const person = (explicit: boolean): Principal =>
    sender.type === "Bot"
      ? { kind: "automation", id: account, display: sender.login, explicit: false }
      : { kind: "human", id: account, display: sender.login, explicit };
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

  if (type === "issue_comment" && payload.action === "created") {
    const body: string = payload.comment?.body ?? "";
    // Comments that do not address the agent are other people's conversation. A bare reply to an
    // approval question ("approve K7PW") is addressed to it without saying so.
    if ((!MENTION.test(body) && !DECISION_REPLY.test(body)) || sender.type === "Bot") return undefined;
    // The agent's own comments carry a marker. When it posts under a person's token they come back
    // looking like that person's words; they are not, and must never be read as a request or a reply.
    if (body.includes("<!-- always-on-agent:")) return undefined;
    // Anyone can comment on a public repository. Only people with a standing in it can give the
    // agent work; a mention from anyone else is not acted on.
    if (!TRUSTED_ASSOCIATIONS.has(payload.comment?.author_association)) return undefined;
    const number = payload.issue.number;
    return {
      repo,
      event: {
        ...base,
        source_id: `comment:${payload.comment.id}`,
        kind: "message",
        session_key: `pr:${number}`,
        principal: person(true),
        text: body,
        data: { number, comment_id: payload.comment.id, is_pull_request: Boolean(payload.issue.pull_request) },
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
export async function deliverGithub(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<void> {
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

  // Only comments since this message was written can be an earlier attempt at it. The list is
  // oldest-first and paged, so follow it to the end rather than trusting the first page.
  const since = new Date((message.created_at ?? Date.now()) - 60_000).toISOString();
  for (let page = 1; page <= 10; page++) {
    const recent = await fetch(`${comments}?per_page=100&page=${page}&since=${encodeURIComponent(since)}`, { headers });
    if (!recent.ok) throw new Error(`GitHub returned ${recent.status} listing comments`);
    const batch = (await recent.json()) as { body?: string }[];
    if (batch.some((comment) => comment.body?.includes(marker))) return;
    if (batch.length < 100) break;
  }

  // A question someone will approve is shown literally. Rendered as Markdown, a branch called
  // __release__ would appear as "release" in bold, which is not the branch being pushed.
  const shown = message.idem.startsWith("ask:") ? `<pre>${message.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>` : message.text;
  const response = await fetch(comments, { method: "POST", headers, body: JSON.stringify({ body: `${shown}\n\n${marker}` }) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
