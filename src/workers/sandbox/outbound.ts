/**
 * The sandbox's only way out. The container has no internet and holds no real credential, so every
 * request it makes on port 80 or 443 lands here, which makes this the place where policy is
 * enforced: what the guest can reach, with whose credentials, and what has to wait for a person.
 *
 * Each task gets its own instance, told which task it serves through props. Nothing the guest says
 * about itself is used to decide whose task a request belongs to.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "../../env";

export const BRAIN_HOST = "brain.internal";

/** How long a request that needs approval is held before the guest is told no. */
const HOLD_MS = 50 * 60 * 1_000;
const HOLD_POLL_MS = 2_000;
const MAX_MODEL_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_PUSH_BYTES = 64 * 1024 * 1024;
const ZERO = /^0+$/;
/** Fields whose value the provider would fetch. */
const REMOTE_KEYS = new Set(["image_url", "file_url", "server_url", "url", "file_id", "connector_id", "container"]);
/** Input items a coding agent produces by itself: its messages, its reasoning, calls to its own tools. */
const LOCAL_ITEM_TYPES = new Set(["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"]);

/** The headers of a request to git's smart-HTTP endpoints that are passed on: those the exchange itself uses, and no others. (How long the body is, is said by the runtime as it sends what is really sent.) */
const GIT_HEADERS = ["accept", "accept-encoding", "accept-language", "content-type", "content-encoding", "git-protocol", "user-agent", "pragma", "cache-control"];

/** One ref a push would move. `old` or `new` being all zeros means create or delete. */
import type { RefUpdate } from "../questions";

export { type RefUpdate, standingEligible } from "../questions";

export class Outbound extends WorkerEntrypoint<Env, { taskId: string }> {
  get #task() {
    return this.env.TASKS.getByName(this.ctx.props.taskId);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // The container calling home. Plain HTTP is fine: this never leaves Cloudflare.
    if (url.hostname === BRAIN_HOST) {
      const token = request.headers.get("x-task-token") ?? "";
      const kind = url.pathname.split("/").filter(Boolean).pop() ?? "unknown";
      const body = await request.json().catch(() => ({}));
      const reply = await this.#task.callback(kind, token, body);
      return json(reply, reply.ok ? 200 : 403);
    }

    // A credential added to plain HTTP would cross the internet unencrypted.
    if (url.protocol !== "https:") return this.#refuse(request, url, `${url.hostname} is reachable only over HTTPS`);
    // A finished task keeps its container for inspection, and something may still be running in it.
    // Nothing leaves on its behalf any more, with or without credentials.
    if (!(await this.#task.isActive())) return new Response("this task has ended\n", { status: 403 });

    // Credentials are for an exact origin: scheme, host and port. The same host on another port is
    // a different service and gets neither a credential nor a route.
    const upstream = new URL(this.env.OPENAI_BASE_URL);
    if (url.origin === upstream.origin) return this.#model(request, url, upstream);
    if (url.origin === "https://github.com") return this.#github(request, url);
    if (url.origin === "https://api.github.com") return this.#githubApi(request, url);
    return this.#refuse(request, url, `${url.hostname} is not reachable from this sandbox`);
  }

  /** The key pays for this task's agent and nothing else: one model, bounded requests, a bounded number of calls. */
  async #model(request: Request, url: URL, upstream: URL): Promise<Response> {
    const base = upstream.pathname.replace(/\/$/, "");
    const isCall = request.method === "POST" && url.pathname === `${base}/responses`;
    const isCatalog = request.method === "GET" && url.pathname === `${base}/models`;
    if (!isCall && !isCatalog) return this.#refuse(request, url, `${request.method} ${url.pathname} is not allowed from this sandbox`);

    const headers = new Headers(request.headers);
    // Replace the placeholder the agent sent with the real key.
    headers.set("authorization", `Bearer ${this.env.OPENAI_API_KEY}`);
    // Manual redirects throughout: a credential must not follow a redirect to another host.
    if (isCatalog) return fetch(new Request(request, { headers, redirect: "manual" }));

    const bytes = await readBounded(request, MAX_MODEL_REQUEST_BYTES);
    if (!bytes) return this.#refuse(request, url, "model request is too large");
    const body = new TextDecoder().decode(bytes);
    let parsed: { model?: unknown; tools?: unknown; input?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.#refuse(request, url, "model request is not JSON");
    }
    if (parsed === null || typeof parsed !== "object") return this.#refuse(request, url, "model request is not an object");
    if (parsed.model !== this.env.WORKER_MODEL) return this.#refuse(request, url, `model ${String(parsed.model)} is not allowed from this sandbox`);
    // Every tenant's sandboxes call the provider under one key, so a request may not refer to
    // anything stored on the provider's side: that could be another tenant's conversation.
    const stored = ["previous_response_id", "conversation", "prompt", "background"].filter((field) => (parsed as Record<string, unknown>)[field] != null);
    if (stored.length > 0) return this.#refuse(request, url, `the request uses ${stored.join(", ")}, which is not allowed from this sandbox`);
    // Only tools the agent runs itself, inside the sandbox. A hosted tool (a remote MCP server, web
    // search, a code interpreter) would have the provider reach out on the guest's behalf, which
    // is a way around having no network.
    const tools = parsed.tools ?? [];
    if (!Array.isArray(tools) || tools.some((tool) => tool?.type !== "function" && tool?.type !== "custom")) {
      return this.#refuse(request, url, "only function tools may be declared from this sandbox");
    }
    // The same goes for the conversation itself: only the kinds of item a local agent produces.
    // Items that stand for hosted tools (MCP, web search, code interpreter…) are not among them.
    const input = (parsed as { input?: unknown }).input;
    if (Array.isArray(input) && input.some((item) => !isLocalItem(item))) {
      return this.#refuse(request, url, "the request contains an item type that is not allowed from this sandbox");
    }
    // Nor may anything in the request point the provider at an address to fetch: an image or file
    // given by URL is the provider making a request the guest chose. Inline data is fine.
    if (hasRemoteReference(parsed)) return this.#refuse(request, url, "the request refers to a remote URL, which is not allowed from this sandbox");
    if (!(await this.#task.countModelCall())) return new Response("this task has used its model call allowance\n", { status: 429 });
    return fetch(url, { method: "POST", headers, body, redirect: "manual" });
  }

  async #github(request: Request, url: URL): Promise<Response> {
    const git = classifyGit(url, request.method);
    // Only git's smart-HTTP endpoints. The rest of github.com is not needed and not offered.
    if (!git) return this.#refuse(request, url, "only git over HTTPS is allowed on github.com");
    const own = git.repo.toLowerCase() === (await this.#task.repository());
    // A token is lent only for the repository this task was started on, and it is one issued for
    // this task's tenant and that repository alone. Anything else is reached anonymously, so a task
    // cannot read private code it was not given.
    // Only what git's own exchange needs is passed on, made here: nothing else the guest sent goes
    // out beside a credential.
    const headers = new Headers();
    for (const name of GIT_HEADERS) if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
    // A credential is asked for by what it is for (what git reads with, or what a push goes out
    // under: the two are lent apart), and only where the request it is for is about to be sent.
    // Asking takes a moment, and no credential is also what a task that has ended is given: such a
    // one sends nothing, with a credential or without.
    const credited = async (lent: () => Promise<string | false | undefined>): Promise<Response | undefined> => {
      const token = own ? await lent() : undefined;
      if (own && !(await this.#task.isActive())) return new Response("this task has ended\n", { status: 403 });
      // Lent something that is no longer to be had: not sent as a stranger's request instead.
      if (token === false) return new Response("what this task read this repository with is no longer lent to it\n", { status: 403 });
      if (token) headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
      return undefined;
    };

    // What git reads with goes to the address made here from what the request was taken to be
    // (which repository, which of git's endpoints, for reading), not to the address as the guest wrote it.
    const reading = `https://github.com/${git.repo}.git/${git.endpoint}${git.endpoint === "info/refs" ? "?service=git-upload-pack" : ""}`;
    if (!git.push) return (await credited(() => this.#task.githubFetchToken())) ?? fetch(new Request(reading, new Request(request, { headers, redirect: "manual" })));
    if (!own) return this.#refuse(request, url, "this task may only push to the repository it was started on");
    // Asking what the remote has is harmless; the push itself is the request that carries commits.
    if (git.endpoint === "info/refs") return (await credited(() => this.#task.githubToken())) ?? fetch(new Request(request, { headers, redirect: "manual" }));

    // A push is decided here, by what the request is, not by what the command looked like. The body
    // says exactly which refs would move to which commits, and that is what a person approves.
    const body = await readBounded(request, MAX_PUSH_BYTES);
    if (!body) return this.#refuse(request, url, "push is too large");
    const refs = parseReceivePack(body);
    if (!refs) return this.#refuse(request, url, "could not read what this push would change");
    // Reading the body took time; the task may have ended since the check at the door.
    if (!(await this.#task.isActive())) return new Response("this task has ended\n", { status: 403 });
    // Whatever is sent from here on goes out under a credential asked for at that moment: reading
    // the body and waiting for a person both take time, and access may have been withdrawn since.
    const send = async (): Promise<Response> => {
      const current = await this.#task.githubToken();
      if (!current) return new Response(`this task is no longer allowed a credential for ${git.repo}\n`, { status: 403 });
      // (Asking took a moment, and a credential held from before may be handed to a task that has ended since: such a one sends nothing, approved or not.)
      if (!(await this.#task.isActive())) return new Response("this task has ended\n", { status: 403 });
      headers.set("authorization", `Basic ${btoa(`x-access-token:${current}`)}`);
      return fetch(url, { method: "POST", headers, body, redirect: "manual" });
    };
    // A push that moves no refs needs nobody's approval.
    if (refs.length === 0) return send();

    const verdict = await this.#authorize(git.repo, refs);
    if (verdict.state !== "allow") {
      return new Response(`push to ${git.repo} was not approved: ${verdict.reason}\n`, { status: 403 });
    }
    if (!(await this.#task.isActive())) return new Response("this task has ended\n", { status: 403 });
    return send();
  }

  /**
   * Reading GitHub's API: the repository this task was started on, and the search of its issues.
   * Never a write. The credential is one that can only read, lent by the same rule as the one for
   * git, and with none the read is anonymous: nothing is seen here that was not given to the task.
   */
  async #githubApi(request: Request, url: URL): Promise<Response> {
    const api = classifyApi(url, request.method);
    if (!api) return this.#refuse(request, url, "only reading the repository this task was started on is allowed on api.github.com");
    const own = await this.#task.repository();
    if (!own || ("repo" in api && api.repo.toLowerCase() !== own)) return this.#refuse(request, url, "only the repository this task was started on can be read on api.github.com");

    const kind = "search" in api ? "search" : "other";
    const target = new URL(url);
    if ("search" in api) {
      // Wherever the query says to look, it is this repository: what it names is taken out and
      // this one put in, over the whole of what is left (in brackets where that has "or", "not"
      // or brackets of its own). What comes back is gone through as well, below.
      // What is in quotes is the text being looked for, kept as it is: a bracket or a "repo:" there is not the query's own.
      const parts = (url.searchParams.get("q") ?? "").split(/("[^"]*")/);
      const asked = parts
        // (Spaces are tidied outside the quotes only: inside, two spaces are part of a name.)
        .map((part, at) => (at % 2 === 1 ? part : part.replace(/-?\b(?:repo|org|user):[^\s()]*/gi, " ").replace(/\s+/g, " ")))
        .join("")
        .trim();
      // Its shape, with each quoted text as one plain word.
      const shape = asked.replace(/"[^"]*"/g, "w");
      // What is left may no longer be a query: an "or" with nothing on one side of it, empty brackets.
      if (/^(?:OR|AND)\b|\b(?:OR|AND|NOT)$|\(\s*(?:OR|AND)\b|\b(?:OR|AND|NOT)\s*\)|\b(?:OR|AND|NOT)\s+(?:OR|AND)\b|\(\s*\)/.test(shape) || !balanced(shape)) {
        // Turned away here, before anything was asked of GitHub: told apart from what GitHub itself refuses.
        await this.#task.noteGithubRead(kind, 400, { rejected: true });
        return new Response("this search is not a query once the repositories, organisations and users it names are taken out (the search is of this task's repository only); nothing was searched. Text to look for that has brackets in it goes in double quotes\n", { status: 400 });
      }
      // Already in brackets as a whole (a next page of a search made here): not wrapped again.
      const whole = /\b(?:OR|AND|NOT)\b|[()]/.test(shape) && !enclosed(shape) ? `(${asked})` : asked;
      target.searchParams.set("q", `repo:${own} ${whole}`.trim());
      // Brackets and "or" mean what they say only where this is asked for; without it GitHub
      // answers such a query with nothing found and calls that complete. Always, whatever the guest sent.
      target.searchParams.set("advanced_search", "true");
    }
    let token: string | undefined;
    // Read with the credential that is allowed nothing, which the task has no right to: where
    // that is turned away, what the task is told is what a stranger would be.
    let optional = false;
    try {
      // What anyone may read of a public repository (its issues and pull requests, and the search
      // of them) is read with a credential also where the task is lent none by right: one that is
      // allowed nothing, which GitHub answers for what is public and for nothing else. Anything
      // else there (its files, who works on it, the repository's own description, which even
      // that one would be given of a private repository) only by right.
      // Just these: the list of issues or of pull requests, one of them, and the comments on
      // it. Named one by one, so that nothing else under them comes to be read this way by being
      // added there (what was changed on an issue, the values of its fields, the files of a pull
      // request). And listed or searched only in the plain ways, which are the same for everyone:
      // what else a listing can be narrowed by depends on who asks.
      const plain = "search" in api ? SEARCHED_BY : LISTED_BY;
      // (And only to read the thing itself: asked for by its headers alone, a refusal comes with
      // no words to tell why, so that is asked as a stranger from the start.)
      // (And asked for as a description, not in another form of it: a pull request as its diff
      // is not something that can be gone through here, and is read as a stranger would.)
      const described = (request.headers.get("accept") ?? "").split(",").map((each) => each.split(";")[0].trim().toLowerCase()).filter(Boolean).every((type) => /^(?:\*\/\*|application\/json|application\/vnd\.github(?:\.[\w.-]+)?\+json)$/.test(type));
      const open = request.method === "GET" && described && ("search" in api || OPEN_TO_ANYONE.test(url.pathname)) && [...url.searchParams.keys()].every((name) => plain.has(name));
      token = await this.#task.githubReadToken();
      if (token === undefined && open) {
        token = await this.#task.githubPublicToken();
        optional = token !== undefined;
      }
    } catch {
      await this.#task.noteGithubRead(kind, 0, {});
      return new Response("a credential to read GitHub with could not be had just now; nothing was read\n", { status: 502 });
    }
    // Lending took a moment, and no credential is also what a task that has ended is given.
    if (!(await this.#task.isActive())) return new Response("this task has ended\n", { status: 403 });
    // Made here, not passed on: what a reader needs to say, and nothing that steers the request elsewhere or overrides how it is made.
    const headers = new Headers();
    for (const name of ["accept", "if-none-match", "if-modified-since", "x-github-api-version"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("user-agent", "always-on-agent");
    if (token) headers.set("authorization", `Bearer ${token}`);
    let answer: Response;
    try {
      // Manual: a redirect is not followed on the guest's behalf.
      answer = await fetch(target, { method: request.method, headers, redirect: "manual" });
      // Turned away as the installation (not there for it, not allowed it): asked again as a
      // stranger, and that answer is the one given. How GitHub turns an installation away says
      // things a stranger is not told (that something not public is there). Being told to slow
      // down is not that, and is passed on as it is.
      // (Not "not found": no such credential is given for a repository that is not public, so
      // that is what a stranger would be told too, and asking again could only turn it into
      // being told to slow down.)
      if (optional && [401, 403, 422].includes(answer.status)) {
        // (GitHub also says "slow down" with a 403 that has allowance left and names no time to
        // wait: then it is in the words of the answer, which are read for it.)
        // (Where the words cannot be read, why it was turned away is not known: it is left at
        // that answer, and not asked a second time.)
        const said = await answer.text().catch(() => undefined);
        const slowed = answer.headers.get("x-ratelimit-remaining") === "0" || answer.headers.has("retry-after") || said === undefined || said === "" || /rate limit|abuse detection/i.test(said);
        if (slowed) answer = new Response(said ?? "", { status: answer.status, headers: answer.headers });
        else {
          // From here on it is a stranger's read, and what comes back is passed on as one.
          optional = false;
          headers.delete("authorization");
          answer = await fetch(target, { method: request.method, headers, redirect: "manual" });
        }
      }
    } catch {
      await this.#task.noteGithubRead(kind, 0, {});
      return new Response("GitHub could not be reached; nothing was read\n", { status: 502 });
    }
    // Sent somewhere else for it: an address made for whoever holds it (an archive, a file), good
    // for a while without any credential. It is not handed into the sandbox.
    const elsewhere = answer.status >= 300 && answer.status < 400 && !sameOrigin(answer.headers.get("location"), url);
    if (elsewhere) {
      await this.#task.noteGithubRead(kind, answer.status, {});
      return new Response("GitHub answers this with a download address somewhere else, which is not passed into this sandbox; use git for the files of the repository\n", { status: 403 });
    }
    if (!("search" in api) || !answer.ok || request.method === "HEAD") {
      // A file or a directory of the repository comes with an address to download it from, which
      // for a private one works for a while for whoever holds it. Read with a credential, it is
      // taken out; the content itself, which the task was given anyway, stays.
      // Only where it is that description (JSON) that was asked for: asked for as the file itself, the bytes are passed on as they are, whatever they hold.
      if (token && answer.ok && request.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/(?:contents|readme|license)(?:\/|$)/i.test(url.pathname) && /^application\/json\b/i.test(answer.headers.get("content-type") ?? "")) {
        let listed: unknown;
        try {
          // (Reading it can fail too, part of the way through: the same as not being able to read it.)
          listed = JSON.parse(await answer.text());
        } catch {
          // Counted as what the guest is told: not as a read that went well.
          await this.#task.noteGithubRead(kind, 502, {});
          return new Response("GitHub's answer could not be read\n", { status: 502 });
        }
        await this.#task.noteGithubRead(kind, answer.status, {});
        return passed(answer, JSON.stringify(withoutDownloads(listed)));
      }
      // Read with the credential the task has no right to: what only some may see of an issue
      // (the values of its fields) is taken out of the answer, whether or not GitHub would have
      // given it. An answer that cannot be gone through is not passed on as it is.
      if (optional && answer.ok && request.method === "GET" && /json/i.test(answer.headers.get("content-type") ?? "")) {
        let listed: unknown;
        try {
          listed = JSON.parse(await answer.text());
        } catch {
          await this.#task.noteGithubRead(kind, 502, {});
          return new Response("GitHub's answer could not be read\n", { status: 502 });
        }
        await this.#task.noteGithubRead(kind, answer.status, {});
        return passed(answer, JSON.stringify(withoutFields(listed)));
      }
      // (Anything else read with that credential is not a description that can be gone through: not passed on, and counted as that.)
      if (optional && answer.ok && request.method === "GET") {
        // (Letting go of it can fail too, where it broke off on its way: counted and told all the same.)
        await answer.body?.cancel().catch(() => undefined);
        await this.#task.noteGithubRead(kind, 502, {});
        return new Response("GitHub's answer is not one that can be passed on here\n", { status: 502 });
      }
      // (A search asked for by its headers alone, or refused, read nothing: counted, and not as a search that was read.)
      await this.#task.noteGithubRead(kind, answer.status, {});
      return passed(answer, answer.body);
    }
    const found = (await answer.json().catch(() => undefined)) as { items?: unknown; incomplete_results?: unknown; total_count?: unknown } | undefined;
    const rows = found && Array.isArray(found.items) ? (found.items as { repository_url?: unknown }[]) : undefined;
    if (!found || !rows || rows.some((each) => typeof each?.repository_url !== "string")) {
      // Not passed on as a list of nothing, nor with rows quietly left out: "none found" is what an issue gets opened on.
      await this.#task.noteGithubRead(kind, 502, {});
      return new Response("GitHub's answer to this search could not be read; it is not known what there is\n", { status: 502 });
    }
    const mine = rows.filter((each) => (each.repository_url as string).toLowerCase() === `https://api.github.com/repos/${own}`);
    const items = optional ? (withoutFields(mine) as typeof mine) : mine;
    // Something of another repository came back: the query was not held to this one after all, so
    // neither the count nor the pages are of this repository alone. Said as not complete; the
    // count is left out rather than made up.
    const mixed = items.length !== rows.length;
    const incomplete = mixed || found.incomplete_results !== false;
    // What this page was: read; whether there is more after it; and whether the search found nothing at all, which only its
    // first page can say, by GitHub's own count of none (a page past the last is empty too, of a search that found plenty).
    const more = /rel="next"/.test(answer.headers.get("link") ?? "");
    const first = (url.searchParams.get("page") ?? "1") === "1";
    // Which search it was a page of: the same query, sorted and cut into pages the same way. So that it can be told, of each search, whether it was read to its end.
    const of = ["q", "sort", "order", "per_page"].map((name) => target.searchParams.get(name) ?? "").join("\n");
    await this.#task.noteGithubRead(kind, answer.status, { incomplete, read: true, more, none: first && !incomplete && !more && items.length === 0 && found.total_count === 0, of, page: Number(url.searchParams.get("page") ?? "1") || 1, cut: typeof found.total_count === "number" && found.total_count > SEARCH_GIVES_AT_MOST });
    const { total_count: total, ...rest } = found;
    return passed(answer, JSON.stringify({ ...rest, ...(mixed ? {} : { total_count: total }), incomplete_results: incomplete, items }));
  }

  /**
   * Holds the request while the task waits for a reviewer. The guest just sees a slow response.
   * Each held request has its own id, made here. The answer is given for that id and can only be
   * collected by this request: an identical push sent in parallel, or later, has to be asked for
   * separately. If this request gives up, its question is withdrawn so no answer is left behind.
   */
  async #authorize(repo: string, refs: RefUpdate[]): Promise<{ state: "allow" | "deny" | "timeout"; reason: string }> {
    const requestId = crypto.randomUUID();
    const deadline = Date.now() + HOLD_MS;
    for (;;) {
      const verdict = await this.#task.authorize(requestId, "git_push", repo, refs);
      if (verdict.state === "allow" || verdict.state === "deny") return { state: verdict.state, reason: verdict.reason };
      if (Date.now() > deadline) {
        await this.#task.withdraw(requestId);
        return { state: "timeout", reason: "no reviewer answered in time" };
      }
      await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
    }
  }

  async #refuse(request: Request, url: URL, message: string): Promise<Response> {
    // Recorded on the task: a blocked request is a fact the Brain should be able to see.
    await this.#task.observe("blocked_request", { method: request.method, host: url.hostname, path: url.pathname, why: message });
    return new Response(`${message}\n`, { status: 403 });
  }
}

/** GitHub gives no more than this many results of one search, however many it found: past that, reading every page it gives is not reading them all. */
const SEARCH_GIVES_AT_MOST = 1_000;

/** GitHub's answer for the guest: what it says, and of its headers what a reader needs (how to go on, how much is left). */
function passed(answer: Response, body: BodyInit | null): Response {
  const headers = new Headers();
  for (const name of ["content-type", "link", "location", "etag", "last-modified", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "x-github-media-type"]) {
    const value = answer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(body, { status: answer.status, headers });
}

/** What of a public repository's issues and pull requests is read with the credential that is allowed nothing: the list, one of them, the comments on one or on all. */
const OPEN_TO_ANYONE = /^\/repos\/[^/]+\/[^/]+\/(?:issues|pulls)(?:\/\d+(?:\/comments)?|\/comments(?:\/\d+)?)?$/i;

/** The ways of listing issues and pull requests, and of searching them, that are the same whoever asks. */
const LISTED_BY = new Set(["state", "labels", "sort", "direction", "since", "per_page", "page", "milestone", "assignee", "creator", "mentioned", "head", "base"]);
const SEARCHED_BY = new Set(["q", "sort", "order", "per_page", "page", "advanced_search"]);

/** What GitHub says of issues, with the values of their fields taken out, however deep they are listed: those can be for some to see and not for others. */
function withoutFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/^issue_field/i.test(key)).map(([key, each]) => [key, withoutFields(each)]));
}

/** A description of a file, a directory or a licence, with every address it could be downloaded from taken out, however deep it is listed. */
function withoutDownloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDownloads);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, each]) => [key, key === "download_url" ? null : withoutDownloads(each)]));
}

/** Whether every bracket in a query is closed, and none closed that was not opened. */
function balanced(query: string): boolean {
  let depth = 0;
  for (const each of query) {
    if (each === "(") depth += 1;
    else if (each === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** Whether a query is one pair of brackets around everything in it. */
function enclosed(query: string): boolean {
  if (!query.startsWith("(") || !query.endsWith(")")) return false;
  let depth = 0;
  for (let at = 0; at < query.length; at += 1) {
    if (query[at] === "(") depth += 1;
    else if (query[at] === ")" && --depth === 0) return at === query.length - 1;
  }
  return false;
}

function sameOrigin(location: string | null, from: URL): boolean {
  if (location === null) return true;
  try {
    return new URL(location, from).origin === from.origin;
  } catch {
    return false;
  }
}

/**
 * Recognises a read of GitHub's API that a sandbox may make: anything under one repository, or
 * the search of issues. Nothing that is not a read; nothing whose path is written so as to mean
 * another place than it says (an encoded dot or slash, an empty part), or that names another
 * repository to read from.
 */
export function classifyApi(url: URL, method: string): { repo: string } | { search: true } | undefined {
  if (method !== "GET" && method !== "HEAD") return undefined;
  const path = url.pathname;
  if (path === "/search/issues") return { search: true };
  if (/%(?:2e|2f|5c)/i.test(path) || path.includes("//") || path.includes("\\")) return undefined;
  const match = path.match(/^\/repos\/([\w.-]+)\/([\w.-]+)(?:\/.*)?$/);
  if (!match) return undefined;
  const [, owner, name] = match;
  if (/^\.+$/.test(owner) || /^\.+$/.test(name)) return undefined;
  // A comparison can name the other side in another repository (owner:branch): that is a read of that one.
  if (/^\/repos\/[^/]+\/[^/]+\/compare\//i.test(path) && (path.includes(":") || /%3a/i.test(path))) return undefined;
  return { repo: `${owner}/${name}` };
}

/** Recognises git's smart-HTTP requests and whether they belong to a push. */
export function classifyGit(url: URL, method: string): { repo: string; endpoint: "info/refs" | "git-upload-pack" | "git-receive-pack"; push: boolean } | undefined {
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!match) return undefined;
  const [, owner, name] = match;
  const endpoint = match[3] as "info/refs" | "git-upload-pack" | "git-receive-pack";
  if (owner === "." || owner === ".." || name === "." || name === "..") return undefined;
  const repo = `${owner}/${name}`;
  if (endpoint === "info/refs") {
    const service = url.searchParams.get("service");
    if (method !== "GET" || (service !== "git-upload-pack" && service !== "git-receive-pack")) return undefined;
    return { repo, endpoint, push: service === "git-receive-pack" };
  }
  if (method !== "POST") return undefined;
  return { repo, endpoint, push: endpoint === "git-receive-pack" };
}

/**
 * Reads the ref updates at the start of a git-receive-pack request: pkt-lines of
 * "<old> <new> <ref>", the first one followed by a NUL and capabilities, ended by a flush packet.
 * Returns undefined for anything it does not fully understand, so an unreadable push is refused
 * rather than waved through.
 */
export function parseReceivePack(body: Uint8Array): RefUpdate[] | undefined {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const updates: RefUpdate[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) return undefined;
    const length = Number.parseInt(ascii(body.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) return undefined;
    if (length === 0) return updates;
    if (length < 5 || offset + length > body.length || updates.length >= 50) return undefined;
    let line: string;
    try {
      line = decoder.decode(body.subarray(offset + 4, offset + length));
    } catch {
      return undefined;
    }
    offset += length;
    const command = line.split("\0")[0].replace(/\n$/, "");
    // A push from a shallow clone (ours are) lists its shallow boundary first. Those lines say which
    // history the sender lacks; they do not move any ref.
    if (updates.length === 0 && /^shallow [0-9a-f]{40,64}$/.test(command)) continue;
    // Signed pushes wrap the commands in a certificate; they are not supported here.
    const match = command.match(/^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[\x21-\x7e]+)$/);
    if (!match) return undefined;
    updates.push({ old: match[1], new: match[2], ref: match[3] });
  }
}

/** One line a person can read and decide on. */
export function describePush(repo: string, refs: RefUpdate[]): string {
  // Full ids: this line is what a person approves, and a prefix is not a commit.
  const short = (sha: string) => sha;
  const parts = refs.map((r) => {
    const name = r.ref.replace(/^refs\/heads\//, "branch ").replace(/^refs\/tags\//, "tag ");
    if (ZERO.test(r.new)) return `delete ${name}`;
    if (ZERO.test(r.old)) return `create ${name} at ${short(r.new)}`;
    return `move ${name} from ${short(r.old)} to ${short(r.new)}`;
  });
  return `push to ${repo}: ${parts.join("; ")}`;
}

/**
 * An item the agent wrote out in full. An item given only by id is a reference to something stored
 * on the provider's side, which under a shared key could be anyone's; a message must carry its own
 * role and content.
 */
export function isLocalItem(item: unknown): boolean {
  if (item === null || typeof item !== "object") return false;
  const { type, role, content } = item as { type?: unknown; role?: unknown; content?: unknown };
  if (type === undefined || type === "message") {
    return typeof role === "string" && ["user", "assistant", "system", "developer"].includes(role) && (typeof content === "string" || Array.isArray(content));
  }
  if (typeof type !== "string" || !LOCAL_ITEM_TYPES.has(type)) return false;
  // A call or its output must be spelled out too; an empty shell of one is not something an agent writes.
  const fields = item as Record<string, unknown>;
  if (type === "function_call") return typeof fields.call_id === "string" && typeof fields.name === "string" && typeof fields.arguments === "string";
  if (type === "custom_tool_call") return typeof fields.call_id === "string" && typeof fields.name === "string" && typeof fields.input === "string";
  if (type === "function_call_output" || type === "custom_tool_call_output") return typeof fields.call_id === "string" && fields.output !== undefined;
  return true;
}

/** True if any image, file or server in the request is given as a URL to fetch rather than inline. */
function hasRemoteReference(value: unknown, key = "", depth = 0): boolean {
  if (depth > 40) return true;
  if (typeof value === "string") return REMOTE_KEYS.has(key) && !value.startsWith("data:");
  if (Array.isArray(value)) return value.some((entry) => hasRemoteReference(entry, key, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([name, entry]) => hasRemoteReference(entry, name, depth + 1));
  }
  return false;
}

/** Reads a request body, giving up (and returning undefined) as soon as it exceeds the limit. */
async function readBounded(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return undefined;
  if (!request.body) return new Uint8Array(new ArrayBuffer(0));
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  const out = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function ascii(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return /^[0-9a-f]{4}$/.test(out) ? out : "zzzz";
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
