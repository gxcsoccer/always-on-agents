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

/** One ref a push would move. `old` or `new` being all zeros means create or delete. */
export interface RefUpdate {
  ref: string;
  old: string;
  new: string;
}

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
    const token = own ? await this.#task.githubToken() : undefined;
    const headers = new Headers(request.headers);
    if (token) headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
    else headers.delete("authorization");

    if (!git.push) return fetch(new Request(request, { headers, redirect: "manual" }));
    if (!own) return this.#refuse(request, url, "this task may only push to the repository it was started on");
    // Asking what the remote has is harmless; the push itself is the request that carries commits.
    if (git.endpoint === "info/refs") return fetch(new Request(request, { headers, redirect: "manual" }));

    // A push is decided here, by what the request is, not by what the command looked like. The body
    // says exactly which refs would move to which commits, and that is what a person approves.
    const body = await readBounded(request, MAX_PUSH_BYTES);
    if (!body) return this.#refuse(request, url, "push is too large");
    const refs = parseReceivePack(body);
    if (!refs) return this.#refuse(request, url, "could not read what this push would change");
    // Reading the body took time; the task may have ended since the check at the door.
    if (!(await this.#task.isActive())) return new Response("this task has ended\n", { status: 403 });
    if (refs.length === 0) return fetch(url, { method: "POST", headers, body, redirect: "manual" });

    const verdict = await this.#authorize(git.repo, refs);
    if (verdict.state !== "allow") {
      return new Response(`push to ${git.repo} was not approved: ${verdict.reason}\n`, { status: 403 });
    }
    if (!(await this.#task.isActive())) return new Response("this task has ended\n", { status: 403 });
    return fetch(url, { method: "POST", headers, body, redirect: "manual" });
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
function isLocalItem(item: unknown): boolean {
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
