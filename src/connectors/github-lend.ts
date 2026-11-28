/**
 * Lending a person's own GitHub authorisation to a piece of work they asked for: so that a
 * sandbox can read a private repository of theirs, in their own conversation with the agent.
 *
 * Decided here, by the connector that holds the authorisation, before the work is written (see
 * `Worker.prepareStart`), and looked at again each time the work asks for the token. What is lent
 * is the token for git to read that one repository with: never for a push, never for GitHub's
 * API. The token itself stays in the person's grant object and is handed, one request at a time,
 * to the proxy the sandbox's traffic leaves through; nothing of it is in the sandbox, in the
 * task's record, or in what the task leaves behind.
 *
 * Only alone with the agent. Where several people talk, what the work reads, says and asks would
 * be before all of them: nothing is lent there. See docs/design/github-as-the-person.zh-CN.md.
 */
import type { Env } from "../env";
import { privateSessionKey, type Scope, scopeName } from "../events";
import { registry } from "../registry";
import { covers } from "./github-app";
import type { Actor, Prepared } from "../workers/types";
import { grantName, reposIn, repositoryOf, setUp } from "./github-grant";

/** What a piece of work was lent, and on the strength of what: kept with the work, read again by this connector alone. */
export interface PersonLend {
  v: 1;
  kind: "github-person";
  /** The object that holds the person's authorisation, by name. */
  grant: string;
  tenant: string;
  person: string;
  connector: string;
  /** Through which chat app, of which organisation, they were verified. */
  origin: { app_id: string; tenant_key: string };
  /** Their own conversation with the agent, whole. */
  session: string;
  /** The message of theirs that names the repository. */
  ref: number;
  /** The repository, as lower-case owner/name and by GitHub's number for it. */
  repo: string;
  repo_id: number;
  /** The installation of the tenant's that covers it. */
  installation: string;
  /** Whose authorisation on GitHub, by number; and which giving of it (see the grant's `mark`). */
  account: number;
  generation: number;
  mark: string;
}

const ORDINARY: Prepared = { kind: "ordinary" };
const refused = (reason: string): Prepared => ({ kind: "refused", reason });
const nameOf = (repository: unknown) => (typeof repository === "string" ? repository.replace(/^https:\/\/github\.com\//i, "").replace(/(\.git|\/)+$/i, "").toLowerCase() : "");
const LATER = "it could not be found out from GitHub just now whether that repository can be read; nothing was started. The person can ask again in a little while";
/**
 * Said the same of every repository that cannot be read here, whatever the reason: that there is
 * a repository of that name, and that it is not public, is not for someone to learn who has not
 * been shown to be able to read it.
 */
const UNREADABLE =
  "that repository cannot be read from here; nothing was started. It is not one anyone may read, and nothing shows that the person may read it with a GitHub authorisation given here: there may be no repository of that name, it may not be connected to this organisation here, they may have given no authorisation that stands, or theirs may not reach it. Tell them that, without guessing which. Asking them to authorise from here is not built yet";

/** Whether anyone at all may read a repository with git: asked as a stranger would. "unknown" where GitHub gave no answer about that. */
async function anyoneReads(repo: string): Promise<boolean | "unknown"> {
  try {
    const answer = await fetch(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`, { redirect: "manual", headers: { "user-agent": "git/2.43.0" }, signal: AbortSignal.timeout(20_000) });
    await answer.body?.cancel();
    if (answer.status === 200) return true;
    // (Moved, too: what the name means now is somewhere else, and is not gone after.)
    return answer.status === 401 || answer.status === 403 || answer.status === 404 || (answer.status >= 300 && answer.status < 400) ? false : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * A look at a new piece of sandbox work before it is written. As ever, for everything but this:
 * one person, alone with the agent, named a repository. Then, if it is one of the tenant's that
 * is not public and they can read it, the work is bound to their authorisation. If anyone may
 * read it, the work is as ever. Otherwise it is not started (it could read nothing).
 */
export async function lendForStart(env: Env, about: { scope: Scope; sessionKey: string; by: string | null; options: Record<string, unknown>; continueFrom: string | null; actor?: Actor }): Promise<Prepared> {
  const { scope, actor } = about;
  const repo = nameOf(about.options.repository);
  // Work that goes on from earlier work is on what that left, and is lent nothing new.
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || about.continueFrom !== null) return ORDINARY;
  // Their own conversation, and they the one who asked: by what the host established, not by where it looks to be.
  if (scope.kind !== "user" || !actor || actor.shared) return ORDINARY;
  if (about.by === null || about.by !== actor.person || scope.id !== actor.person) return ORDINARY;
  // (Verified through the chat connector the grants are kept for: the same names in another connector's origin are other people.)
  if (actor.connector !== "feishu" || !setUp(env) || !actor.origin.app_id || !actor.origin.tenant_key) return ORDINARY;
  // (The conversation is the private one of that very origin, whole: not merely one that is private.)
  if (about.sessionKey !== privateSessionKey(actor.connector, { app_id: actor.origin.app_id, tenant_key: actor.origin.tenant_key })) return ORDINARY;
  const app = await registry(env).feishuApp(actor.origin.app_id);
  if (!app || app.tenant !== scope.tenant) return ORDINARY;
  // Which repository is the person's to say: named whole in their own words.
  const named = [...actor.said, ...actor.recent].find((each) => reposIn(each.text).includes(repo));
  if (!named) return ORDINARY;
  // Whether it is one of this tenant's, and whether anyone may read it, by the tenant's own
  // credential (one that only reads): that the person can reach a repository does not make it
  // this tenant's. (One that only reads comes from an installation and nowhere else: which one is
  // kept, to be asked about again each time.)
  const repository = await repositoryOf(env, scope.tenant, repo, "read");
  if (repository === "unknown") return refused(LATER);
  if (repository !== "not_connected" && !repository.private) return ORDINARY;
  if (repository !== "not_connected" && repository.installation) {
    const grant = await grantName({ tenant: scope.tenant, chat_app_id: app.app_id, tenant_key: actor.origin.tenant_key, open_id: actor.person });
    let sees: { account: number; generation: number; mark: string } | "unauthorised" | "later" | "no_access" | "unreachable";
    try {
      sees = await env.GITHUB_GRANTS.getByName(grant).sees(repo, repository.id);
    } catch {
      sees = "unreachable";
    }
    // Whether they can read it could not be found out just now: that, and not that they cannot.
    if (sees === "later" || sees === "unreachable") return refused(LATER);
    if (typeof sees === "object") {
      const record: PersonLend = { v: 1, kind: "github-person", grant, tenant: scope.tenant, person: actor.person, connector: actor.connector, origin: { app_id: app.app_id, tenant_key: actor.origin.tenant_key }, session: about.sessionKey, ref: named.ref, repo, repo_id: repository.id, installation: repository.installation, account: sees.account, generation: sees.generation, mark: sees.mark };
      return { kind: "bound", record: record as unknown as Record<string, unknown> };
    }
  }
  // Not theirs to read by anything shown here. What is said from here on is what a stranger could
  // find out, and nothing of what the tenant's own credential saw.
  const open = await anyoneReads(repo);
  if (open === "unknown") return refused(LATER);
  return open ? ORDINARY : refused(UNREADABLE);
}

/** A record of this kind, as it was kept; nothing for anything else. */
export function readLend(value: unknown): PersonLend | undefined {
  const lend = value as Partial<PersonLend> | null;
  if (typeof lend !== "object" || lend === null || lend.v !== 1 || lend.kind !== "github-person") return undefined;
  const text = (each: unknown) => typeof each === "string" && each !== "";
  const whole = (each: unknown) => Number.isSafeInteger(each);
  if (![lend.grant, lend.tenant, lend.person, lend.connector, lend.session, lend.repo, lend.installation, lend.mark, lend.origin?.app_id, lend.origin?.tenant_key].every(text)) return undefined;
  if (![lend.ref, lend.repo_id, lend.account, lend.generation].every(whole)) return undefined;
  return lend as PersonLend;
}

/**
 * The person's token for one read by git, for the piece of work a record was kept with: while the
 * work is still theirs and on that repository; the installation it was lent under is still this
 * tenant's and still covers that repository, which is still the one the name meant; and their
 * authorisation is the one it was lent under. Asked each time; nothing where any of that fails,
 * or cannot be found out.
 */
export async function lentToken(env: Env, lend: PersonLend, task: { id: string; brain: string; repo: string }): Promise<string | undefined> {
  if (task.brain !== scopeName({ tenant: lend.tenant, kind: "user", id: lend.person }) || task.repo !== lend.repo) return undefined;
  // An installation can be given to another tenant, a repository taken out of it, and a name can
  // come to mean another repository: what was so when the work began is asked about again.
  if ((await registry(env).tenantForGithubInstallation(lend.installation)) !== lend.tenant) return undefined;
  if ((await covers(env, lend.installation, lend.repo, lend.repo_id)) !== true) return undefined;
  return env.GITHUB_GRANTS.getByName(lend.grant).lendToken({ generation: lend.generation, mark: lend.mark, account: lend.account, task: task.id });
}

/**
 * Whether the authorisation a record was kept under still stands: for whoever is about to take in
 * what the work came to. "gone": it does not (or the record is not one of these). Throws where
 * that cannot be asked.
 */
export async function lendHolds(env: Env, record: unknown): Promise<"holds" | "gone"> {
  const lend = readLend(record);
  if (!lend) return "gone";
  return (await env.GITHUB_GRANTS.getByName(lend.grant).holds({ generation: lend.generation, mark: lend.mark, account: lend.account })) ? "holds" : "gone";
}
