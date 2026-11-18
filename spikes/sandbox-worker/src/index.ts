/**
 * Spike: a self-hosted worker agent. One Durable Object per task owns a sandbox container that
 * runs the pi coding agent headless. The questions it answers are listed in the README.
 *
 * Structure follows Cloudflare's coding-agent example (sandbox-sdk/examples/coding-agents/pi), with
 * three additions: the container reports back to the Worker, a pi extension holds risky commands
 * until the Worker says yes or no, and every observation is recorded on the task.
 */
import {
  DirectoryBackup,
  type DirectoryBackupGatewayBinding,
  type DirectoryBackupRecord,
  Files,
  SandboxFileError,
} from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Lets the container upload and download one checkpoint object in R2, and nothing else.
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

interface Env {
  TASKS: DurableObjectNamespace<TaskSandbox>;
  CHECKPOINTS: R2Bucket;
  SPIKE_KEY: string;
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  MODEL: string;
  GITHUB_TOKEN?: string;
}

interface TaskCtx extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    readonly Outbound: LoopbackForExport<typeof Outbound>;
    readonly DirectoryBackupGateway: DirectoryBackupGatewayBinding;
  };
}

type Phase = "starting" | "idle" | "running" | "needs_input" | "succeeded" | "failed" | "lost";

interface Run {
  /** `resume` continues the same pi session in a new container after the old one was lost. */
  kind: "first" | "resume";
  started_at: number;
  ended_at?: number;
  exit_code?: number;
  /** Which path noticed the exit first: the container's own report, or the alarm. */
  detected_by?: "callback" | "alarm";
  result?: ResultSummary;
}

interface ResultSummary {
  text?: string;
  stop_reason?: string;
  turns: number;
  tool_calls: number;
  duration_ms: number;
  /** Summed over every assistant message of the run. Cost is pi's own estimate in USD. */
  usage: { input: number; output: number; cache_read: number; total_tokens: number; cost_usd: number };
}

interface InboxItem {
  at: number;
  kind: string;
  body: unknown;
}

interface TaskState {
  id: string;
  /** Sent by the container with every report. Only valid for this task. */
  token: string;
  /** pi's session id, from its first event. Needed to resume later. */
  thread_id?: string;
  phase: Phase;
  prompt?: string;
  repository?: string;
  cwd: string;
  created_at: number;
  agent_version?: string;
  timings: Record<string, number>;
  runs: Run[];
  /** The tool call the gate is holding until someone answers. */
  pending?: {
    id: string;
    /** Who is holding the action: the in-process gate (a tool call) or the proxy (a network request). */
    source: "gate" | "proxy";
    tool_name?: string;
    command?: string;
    action?: string;
    resource?: string;
    asked_at: number;
  };
  /** Approvals and refusals for network actions, keyed by `action:resource`. Enforced by the proxy. */
  grants: Record<string, { state: "allow" | "deny"; reason: string; until: number }>;
  /** Counts approval requests, so each gets its own id. */
  asks: number;
  /** The latest copy of /workspace in R2: the agent's files and its session transcript. */
  checkpoint?: { record: DirectoryBackupRecord; at: number; took_ms: number };
  checkpoints_taken: number;
  /** How many times the task was restored into a new container. */
  recoveries: number;
  /** Answers, keyed by tool call id. Kept here, outside the container, so the guest cannot write one. */
  decisions: Record<string, { decision: "allow" | "deny"; reason: string; at: number }>;
  /** Stand-in for the Brain's inbox: everything the container pushed to us. */
  inbox: InboxItem[];
  /** What each alarm tick saw, to show the keep-alive actually held. */
  checks: { at: number; phase: Phase; container_running: boolean }[];
  error?: string;
}

interface StartInput {
  id: string;
  prompt?: string;
  repository?: string;
  ref?: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const BRAIN_HOST = "brain.internal";
// Everything the task owns lives under one directory created at run time. Restoring a checkpoint
// replaces that directory by rename, which fails with EXDEV on a directory that came from the image
// (such as /workspace itself).
const WORKSPACE_DIRECTORY = "/workspace/job";
const REPOSITORY_DIRECTORY = `${WORKSPACE_DIRECTORY}/repo`;
const SCRATCH_DIRECTORY = `${WORKSPACE_DIRECTORY}/scratch`;
const TASK_DIRECTORY = `${WORKSPACE_DIRECTORY}/task`;
const SESSIONS_DIRECTORY = `${TASK_DIRECTORY}/sessions`;
const STDERR_PATH = `${TASK_DIRECTORY}/stderr.log`;
const EXIT_CODE_PATH = `${TASK_DIRECTORY}/exit-code`;
const PID_PATH = `${TASK_DIRECTORY}/pid`;
const HOOK_LOG_PATH = `${TASK_DIRECTORY}/hooks.jsonl`;
const REPORT_LOG_PATH = `${TASK_DIRECTORY}/report.log`;
const EVENTS_PATH = `${TASK_DIRECTORY}/events.jsonl`;

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
// Hard limits, so no container is kept alive forever.
const STARTUP_DEADLINE_MS = 5 * 60 * 1_000;
const MAX_IDLE_MS = 15 * 60 * 1_000;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
// Checkpoints: at most this often, and a task is restored at most this many times.
const CHECKPOINT_MIN_INTERVAL_MS = 30 * 1_000;
const MAX_RECOVERIES = 2;
// A running process does not keep a container awake; requests do. Check well within the timeout.
const CHECK_INTERVAL_MS = 20 * 1_000;
// How long the proxy holds a request that needs approval, and how long an approval stays usable.
// A push is several HTTP requests; the grant has to cover all of them and nothing after.
const PROXY_HOLD_MS = 50 * 60 * 1_000;
const GRANT_TTL_MS = 2 * 60 * 1_000;
const DENIAL_TTL_MS = 60 * 1_000;
// The gate waits this long for an answer, then blocks the call.
const MAX_WAIT_FOR_ANSWER_S = 55 * 60;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// exec() does not inherit start() env, so every command that makes HTTPS requests needs these.
const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
};

// Output goes to files so the agent outlives the request that started it. The wrapper records its
// own pid: the pid that exec() returns is not the in-container pid under local dev, so a liveness
// check against it reports a live agent as dead. The last line is the deterministic completion
// report: it does not depend on the model remembering to call anything.
const TASK_SCRIPT = `echo $$ >${PID_PATH}
"$@" >${EVENTS_PATH} 2>>${STDERR_PATH}
code=$?
printf '%s\\n' "$code" >${EXIT_CODE_PATH}.tmp && mv ${EXIT_CODE_PATH}.tmp ${EXIT_CODE_PATH}
node /opt/spike/report.mjs exit "$code" >>${REPORT_LOG_PATH} 2>&1`;

const SYSTEM_PROMPT = `You are running unattended inside a sandbox; nobody is watching the terminal.
After each meaningful step, run the shell command: report progress "<one sentence on what you just finished>"
Some commands pause until a reviewer approves them; that is expected, just wait.
If a command is denied, do not retry it or work around it; say so in your final answer.`;

const RESUME_PROMPT = `The sandbox you were working in was replaced. Your files and this conversation were restored from a checkpoint, so the last few things you did before the interruption may be missing. Look at the current state of the directory, work out which steps are actually done, and continue the original task from there. Do not redo steps that are already done.`;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!env.SPIKE_KEY || key !== env.SPIKE_KEY) return json({ error: "missing or wrong key" }, 401);

    try {
      if (url.pathname === "/" && request.method === "GET") return json({ routes: ROUTES });

      if (url.pathname === "/tasks" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as Omit<StartInput, "id">;
        const id = crypto.randomUUID();
        const task = env.TASKS.getByName(id);
        await task.start({ ...body, id });
        return json(await task.status());
      }

      const match = url.pathname.match(/^\/tasks\/([0-9a-f-]{36})(?:\/([\w-]+))?$/);
      if (!match) return json({ error: "not found", routes: ROUTES }, 404);
      const task = env.TASKS.getByName(match[1]);
      const action = match[2] ?? "status";
      const method = request.method;

      if (action === "status" && method === "GET") return json(await task.status());
      if (action === "probe" && method === "POST") return json(await task.probe());
      if (action === "events" && method === "GET") return text(await task.readFiles("events"));
      if (action === "hooks" && method === "GET") return text(await task.readFiles("hooks"));
      if (action === "stderr" && method === "GET") return text(await task.readFiles("stderr"));
      if (action === "diff" && method === "GET") return json(await task.diff());
      if (action === "answer" && method === "POST") {
        const body = (await request.json()) as { decision: "allow" | "deny"; reason?: string; tool_use_id?: string };
        return json(await task.answer(body.decision, body.reason ?? "", body.tool_use_id));
      }
      if (action === "kill-container" && method === "POST") return json(await task.killContainer());
      if (action === "destroy" && method === "POST") return json(await task.destroy());
      return json({ error: "not found", routes: ROUTES }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};

const text = (body: string) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * Everything the container sends to port 80 or 443 lands here. The container has no internet and
 * holds no real credential; this is the only way out, which makes it the place to enforce policy.
 * Each task gets its own instance, told which task it serves through props, so every request can
 * be attributed and approved per task without trusting anything the guest says about itself.
 */
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

    const upstream = new URL(this.env.OPENAI_BASE_URL);
    if (url.hostname === upstream.hostname) {
      // The key is only lent to the calls the agent needs, not to the provider's whole API.
      const base = upstream.pathname.replace(/\/$/, "");
      const allowed =
        (request.method === "POST" && url.pathname.startsWith(`${base}/responses`)) ||
        (request.method === "GET" && url.pathname === `${base}/models`);
      if (!allowed) return this.#refuse(request, url, `${request.method} ${url.pathname} is not allowed from this sandbox`);
      const headers = new Headers(request.headers);
      // Replace the placeholder the agent sent with the real key.
      headers.set("authorization", `Bearer ${this.env.OPENAI_API_KEY}`);
      // Manual redirects: a credential must not follow a redirect to another host.
      return fetch(new Request(request, { headers, redirect: "manual" }));
    }

    if (url.hostname === "github.com") {
      const git = classifyGit(url, request.method);
      // Only git's smart-HTTP endpoints. The rest of github.com is not needed and not offered.
      if (!git) return this.#refuse(request, url, `only git over HTTPS is allowed on github.com`);
      if (git.write) {
        // A push is decided here, by what the request is, not by what the command looked like.
        const verdict = await this.#authorize("git_push", git.repo);
        if (verdict.state !== "allow") {
          return new Response(`push to ${git.repo} was not approved: ${verdict.reason}\n`, { status: 403 });
        }
      }
      if (!this.env.GITHUB_TOKEN) return fetch(request);
      const headers = new Headers(request.headers);
      headers.set("authorization", `Basic ${btoa(`x-access-token:${this.env.GITHUB_TOKEN}`)}`);
      return fetch(new Request(request, { headers, redirect: "manual" }));
    }

    return this.#refuse(request, url, `${url.hostname} is not reachable from this sandbox`);
  }

  /** Holds the request while the task waits for a reviewer. The guest just sees a slow response. */
  async #authorize(action: string, resource: string): Promise<{ state: "allow" | "deny" | "timeout"; reason: string }> {
    const deadline = Date.now() + PROXY_HOLD_MS;
    for (;;) {
      const verdict = await this.#task.authorize(action, resource);
      if (verdict.state === "allow" || verdict.state === "deny") return { state: verdict.state, reason: verdict.reason };
      if (Date.now() > deadline) return { state: "timeout", reason: "no reviewer answered in time" };
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  async #refuse(request: Request, url: URL, message: string): Promise<Response> {
    // Recorded on the task: a blocked request is a fact the Brain should be able to see.
    await this.#task.observe("blocked_request", { method: request.method, host: url.hostname, path: url.pathname });
    return new Response(`${message}\n`, { status: 403 });
  }
}

/** Recognises git's smart-HTTP requests and whether they write. */
function classifyGit(url: URL, method: string): { repo: string; write: boolean } | undefined {
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!match) return undefined;
  const [, owner, name, endpoint] = match;
  const service = url.searchParams.get("service");
  if (endpoint === "info/refs") {
    if (method !== "GET" || (service !== "git-upload-pack" && service !== "git-receive-pack")) return undefined;
    // The advertisement for a push is the first request of one, so it is treated as the push.
    return { repo: `${owner}/${name}`, write: service === "git-receive-pack" };
  }
  if (method !== "POST") return undefined;
  return { repo: `${owner}/${name}`, write: endpoint === "git-receive-pack" };
}

export class TaskSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  readonly #outbound: Fetcher;
  readonly #backups: DirectoryBackup;
  #checkpointing = false;

  constructor(ctx: TaskCtx, env: Env) {
    super(ctx, env);
    if (ctx.container === undefined) throw new Error("Container attachment is unavailable");
    this.#container = ctx.container;
    this.#files = new Files(this.#container);
    // The task id is this object's name. The proxy gets it from us, never from the guest.
    this.#outbound = ctx.exports.Outbound({ props: { taskId: ctx.id.name ?? "" } });
    this.#backups = new DirectoryBackup(this.#container, ctx.exports.DirectoryBackupGateway, {
      binding: "CHECKPOINTS",
      prefix: `tasks/${ctx.id.name ?? "unknown"}/`,
    });
    // A restarted instance (deploy, eviction) inherits a running container but not its wiring: the
    // inactivity timeout is per instance, and the container's route out goes through the old
    // instance's entrypoint. Without re-attaching, the agent can neither reach the model nor report.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await this.#attach();
      });
    }
  }

  // ---------- state ----------

  #state(): TaskState | undefined {
    return this.ctx.storage.kv.get<TaskState>("state");
  }

  #save(state: TaskState) {
    state.inbox = state.inbox.slice(-200);
    state.checks = state.checks.slice(-200);
    this.ctx.storage.kv.put("state", state);
  }

  // ---------- RPC surface ----------

  async start(input: StartInput): Promise<TaskState> {
    // kv is synchronous, so check-and-set cannot interleave with another start.
    if (this.#state()) throw new Error("task already started");
    const t0 = Date.now();
    const state: TaskState = {
      id: input.id,
      token: crypto.randomUUID(),
      phase: "starting",
      prompt: input.prompt,
      repository: input.repository,
      cwd: input.repository ? REPOSITORY_DIRECTORY : SCRATCH_DIRECTORY,
      created_at: t0,
      timings: {},
      runs: [],
      inbox: [],
      checks: [],
      decisions: {},
      grants: {},
      asks: 0,
      checkpoints_taken: 0,
      recoveries: 0,
    };
    this.#save(state);
    // Armed before any I/O: if this request dies mid-startup, the alarm still notices and cleans up.
    await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);

    try {
      state.agent_version = await this.#boot(input.id);
      state.timings.container_ready_ms = Date.now() - t0;

      await this.#files.mkdir(WORKSPACE_DIRECTORY);
      await this.#files.mkdir(TASK_DIRECTORY);
      if (input.repository) {
        const t1 = Date.now();
        const branch = input.ref ? ["--branch", input.ref] : [];
        const clone = await this.#run(
          ["git", "clone", "--depth", "1", ...branch, "--", input.repository, REPOSITORY_DIRECTORY],
          WORKSPACE_DIRECTORY,
          TRUST_ENV,
        );
        state.timings.clone_ms = Date.now() - t1;
        if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr.slice(-1_000)}`);
      } else {
        await this.#files.mkdir(SCRATCH_DIRECTORY);
      }

      if (input.prompt === undefined) {
        state.phase = "idle";
        this.#save(state);
        return state;
      }
      await this.#launch(state, "first");
      state.timings.launched_ms = Date.now() - t0;
      this.#save(state);
      return state;
    } catch (err) {
      state.phase = "failed";
      state.error = String(err);
      this.#save(state);
      if (this.#container.running) await this.#container.destroy();
      return state;
    }
  }

  async status(): Promise<TaskState | { error: string }> {
    const state = this.#state();
    if (!state) return { error: "no such task" };
    return { ...state, token: "(hidden)" };
  }

  /** Called through Outbound when the container reports or asks. The reply goes back to the container. */
  async callback(kind: string, token: string, body: unknown): Promise<{ ok: boolean; decision?: string; reason?: string }> {
    const state = this.#state();
    if (!state || token !== state.token) return { ok: false };
    const request = (body ?? {}) as { tool_use_id?: string; tool_name?: string; command?: string };
    // Ids come from the guest; only well-formed ones are used as keys.
    const callId = /^[\w|.:-]{1,200}$/.test(request.tool_use_id ?? "") ? (request.tool_use_id as string) : undefined;

    // The gate polls for its answer. Not recorded in the inbox: it would be one entry every two seconds.
    if (kind === "decision") {
      const answer = callId ? state.decisions[callId] : undefined;
      return answer ? { ok: true, decision: answer.decision, reason: answer.reason } : { ok: true, decision: "pending" };
    }

    state.inbox.push({ at: Date.now(), kind, body });
    if (kind === "needs_input") {
      if (!callId || state.phase !== "running") {
        this.#save(state);
        return { ok: false };
      }
      state.phase = "needs_input";
      state.pending = { id: callId, source: "gate", tool_name: request.tool_name, command: request.command, asked_at: Date.now() };
    }
    this.#save(state);
    if (kind === "exit") await this.#settle("callback");
    // A progress report means a step just finished: a good moment to copy the workspace out.
    else if (kind === "progress") this.ctx.waitUntil(this.#checkpoint());
    return { ok: true };
  }

  /**
   * Answers the call the gate is holding. The answer is stored here and handed to the gate when it
   * next polls; nothing is written into the container. No awaits, so this cannot interleave.
   */
  async answer(decision: "allow" | "deny", reason: string, toolUseId?: string): Promise<TaskState | { error: string }> {
    const state = this.#state();
    if (!state) return { error: "no such task" };
    if (state.phase !== "needs_input" || !state.pending) return { error: `task is ${state.phase}, nothing to answer` };
    if (decision !== "allow" && decision !== "deny") return { error: "decision must be allow or deny" };
    // A late answer to an earlier question must not approve whatever is pending now.
    if (toolUseId !== undefined && toolUseId !== state.pending.id) {
      return { error: `that question is no longer pending; the pending call is ${state.pending.id}` };
    }
    state.decisions[state.pending.id] = { decision, reason, at: Date.now() };
    if (state.pending.source === "proxy") {
      // Scoped to this action on this resource, and short-lived: it covers the request being held
      // and the ones that belong to the same operation, not whatever the agent tries later.
      state.grants[`${state.pending.action}:${state.pending.resource}`] = {
        state: decision,
        reason,
        until: Date.now() + (decision === "allow" ? GRANT_TTL_MS : DENIAL_TTL_MS),
      };
    }
    state.inbox.push({ at: Date.now(), kind: "answered", body: { decision, reason, tool_use_id: state.pending.id } });
    state.pending = undefined;
    state.phase = "running";
    this.#save(state);
    return { ...state, token: "(hidden)" };
  }

  /**
   * Called by the proxy for a network action that needs approval. Returns the standing answer if
   * there is one, otherwise asks (once) and reports `pending`. No awaits, so it cannot interleave.
   */
  async authorize(action: string, resource: string): Promise<{ state: "allow" | "deny" | "pending"; reason: string }> {
    const state = this.#state();
    if (!state) return { state: "deny", reason: "no such task" };
    const key = `${action}:${resource}`;
    const grant = state.grants[key];
    if (grant && grant.until > Date.now()) return { state: grant.state, reason: grant.reason };
    if (state.pending?.source === "proxy" && state.pending.action === action && state.pending.resource === resource) {
      return { state: "pending", reason: "" };
    }
    // Something else is waiting for an answer, or the task is not running: wait for our turn.
    if (state.phase !== "running") {
      return ACTIVE.has(state.phase) ? { state: "pending", reason: "" } : { state: "deny", reason: `task is ${state.phase}` };
    }
    state.asks += 1;
    state.pending = { id: `proxy-${state.asks}`, source: "proxy", action, resource, asked_at: Date.now() };
    state.phase = "needs_input";
    state.inbox.push({ at: Date.now(), kind: "needs_input", body: { source: "proxy", action, resource, id: state.pending.id } });
    this.#save(state);
    return { state: "pending", reason: "" };
  }

  /** Lets the proxy record something it saw. */
  async observe(kind: string, body: unknown): Promise<void> {
    const state = this.#state();
    if (!state) return;
    state.inbox.push({ at: Date.now(), kind, body });
    this.#save(state);
  }

  /** Checks that need no model call: credential isolation, egress blocking, the callback path. */
  async probe(): Promise<unknown> {
    const state = this.#state();
    if (!state) return { error: "no such task" };
    if (!this.#container.running) return { error: "container is not running" };
    const env = this.#agentEnv(state);
    const node = (script: string) => this.#run(["node", "-e", script], "/", env);
    const show = (r: CommandResult) => ({ exit: r.exitCode, out: (r.stdout + r.stderr).trim().slice(0, 400) });
    return {
      // Expect only the placeholder. TASK_PASS is also here: it lets the guest report on its own task, nothing else.
      keys_in_container_env: show(
        await this.#run(["/bin/sh", "-c", "env | grep -i -E 'openai|api_key|sk-|pass' || echo '(none)'"], "/", env),
      ),
      // Expect 403 from Outbound.
      blocked_host: show(
        await node(
          `fetch("https://example.com").then(async r=>console.log(r.status,(await r.text()).trim())).catch(e=>console.log("ERR",e.cause?.code??e.message))`,
        ),
      ),
      // Expect 200 although the request carries no real key: the Worker added it. Costs nothing.
      openai_without_key: show(
        await node(
          `fetch(${JSON.stringify(`${this.env.OPENAI_BASE_URL}/models`)}).then(async r=>console.log(r.status,(await r.text()).replace(/\\s+/g," ").slice(0,120))).catch(e=>console.log("ERR",e.cause?.code??e.message))`,
        ),
      ),
      // Expect ok:true and a `ping` item in the task's inbox.
      callback_to_worker: show(await this.#run(["node", "/opt/spike/report.mjs", "ping", "probe"], "/", env)),
      // Expect 403: a report with the wrong pass must be rejected.
      callback_with_wrong_pass: show(
        await this.#run(["node", "/opt/spike/report.mjs", "ping", "forged"], "/", { ...env, TASK_PASS: "wrong" }),
      ),
    };
  }

  async readFiles(which: "events" | "hooks" | "stderr"): Promise<string> {
    const state = this.#state();
    if (!state || !this.#container.running) return "";
    if (which === "hooks") return (await this.#readOptional(HOOK_LOG_PATH)) ?? "";
    if (which === "stderr") {
      return `${(await this.#readOptional(STDERR_PATH)) ?? ""}\n--- report.log ---\n${(await this.#readOptional(REPORT_LOG_PATH)) ?? ""}`;
    }
    return (await this.#readOptional(EVENTS_PATH)) ?? "";
  }

  async diff(): Promise<CommandResult | { error: string }> {
    const state = this.#state();
    if (!state || !this.#container.running) return { error: "container is not running" };
    const script = state.repository ? "git add --intent-to-add . && git diff" : "ls -la && head -c 2000 -- * 2>/dev/null";
    return this.#run(["/bin/sh", "-c", script], state.cwd, {});
  }

  /** Kills the container but keeps the task, to see how (and how fast) the loss is noticed. */
  async killContainer(): Promise<unknown> {
    const wasRunning = this.#container.running;
    if (wasRunning) await this.#container.destroy();
    return { destroyed: wasRunning, note: "state kept; the next alarm should mark the task lost" };
  }

  async destroy(): Promise<unknown> {
    await this.ctx.storage.deleteAlarm();
    if (this.#container.running) await this.#container.destroy();
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }

  // ---------- lifecycle ----------

  /** Starts a fresh container and waits until it answers. Returns the agent's version string. */
  async #boot(taskId: string): Promise<string> {
    this.#container.start({
      image: this.#container.images.sandbox,
      instance: "standard-1",
      enableInternet: false,
      labels: { spike: "sandbox-worker", task: taskId },
    });
    await this.#attach();
    // The first exec doubles as the readiness check.
    const version = await this.#run(["pi", "--version"], "/", { HOME: "/root" });
    return version.stdout.trim() || version.stderr.trim();
  }

  /**
   * Copies /workspace to R2. The agent keeps running while this happens, so the copy can catch a
   * file half-written; pi's session file is append-only, which limits the damage to its last line.
   */
  async #checkpoint(): Promise<void> {
    const before = this.#state();
    if (!before || this.#checkpointing || !ACTIVE.has(before.phase) || !this.#container.running) return;
    if (before.checkpoint && Date.now() - before.checkpoint.at < CHECKPOINT_MIN_INTERVAL_MS) return;
    this.#checkpointing = true;
    const started = Date.now();
    try {
      const record = await this.#backups.backup({ dir: WORKSPACE_DIRECTORY, name: `task ${before.id}` });
      const state = this.#state();
      if (!state) return;
      const previous = state.checkpoint?.record;
      state.checkpoint = { record, at: started, took_ms: Date.now() - started };
      state.checkpoints_taken += 1;
      this.#save(state);
      // Only the latest one is ever restored.
      if (previous) await this.#backups.delete(previous).catch(() => undefined);
    } catch (err) {
      const state = this.#state();
      if (state) {
        state.inbox.push({ at: Date.now(), kind: "checkpoint_failed", body: { message: String(err) } });
        this.#save(state);
      }
    } finally {
      this.#checkpointing = false;
    }
  }

  /** The container is gone. Puts the last checkpoint into a new one and continues the same session. */
  async #recover(): Promise<void> {
    const before = this.#state();
    if (!before?.checkpoint) return;
    const started = Date.now();
    before.recoveries += 1;
    before.pending = undefined;
    before.phase = "starting";
    before.inbox.push({ at: started, kind: "recovering", body: { message: `from checkpoint taken ${Math.round((started - before.checkpoint.at) / 1000)}s ago` } });
    this.#save(before);
    try {
      await this.#boot(before.id);
      await this.#backups.restore(before.checkpoint.record, { dir: WORKSPACE_DIRECTORY });
      const state = this.#state();
      if (!state) return;
      state.timings[`recovery_${state.recoveries}_ms`] = Date.now() - started;
      await this.#launch(state, "resume");
    } catch (err) {
      const state = this.#state();
      if (!state) return;
      state.phase = "lost";
      state.error = `recovery failed: ${String(err)}`;
      this.#save(state);
    }
  }

  /** Routes everything the container sends through Outbound, and sets the inactivity timeout. */
  async #attach(): Promise<void> {
    // Order matters: the catch-all below takes every hostname registered after it, so the
    // checkpoint gateway's host has to be claimed first or its uploads land in Outbound.
    await this.#backups.intercept();
    await this.#container.interceptOutboundHttp(BRAIN_HOST, this.#outbound);
    await this.#container.interceptAllOutboundHttp(this.#outbound);
    await this.#container.interceptOutboundHttps("*", this.#outbound);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  async alarm(): Promise<void> {
    // Rearm first: whatever throws below, the chain must not break.
    await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
    const before = this.#state();
    if (!before) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (ACTIVE.has(before.phase)) await this.#settle("alarm");
    const running = this.#container.running;
    // Touch the container: a request to it is what counts as activity.
    if (running) await this.#readOptional(PID_PATH).catch(() => undefined);

    // Every await is done. From here to #save nothing can interleave, so this cannot overwrite
    // a state that a callback settled in the meantime.
    const state = this.#state();
    if (!state) return;
    state.checks.push({ at: Date.now(), phase: state.phase, container_running: running });
    const age = Date.now() - state.created_at;
    const alive = ACTIVE.has(state.phase) || state.phase === "idle" || state.phase === "starting";
    let expired = false;
    if (alive && state.phase === "starting") {
      expired = age > STARTUP_DEADLINE_MS;
      if (expired) state.error = "startup did not finish in time";
    } else if (alive && !running) {
      if (ACTIVE.has(state.phase) && state.checkpoint && state.recoveries < MAX_RECOVERIES) {
        this.#save(state);
        await this.#recover();
        return;
      }
      state.phase = "lost";
      state.error = "container stopped before the task finished";
    } else if (alive && age > (state.phase === "idle" ? MAX_IDLE_MS : MAX_LIFETIME_MS)) {
      expired = true;
      state.error = "exceeded the maximum lifetime";
    }
    if (expired) state.phase = "failed";
    this.#save(state);

    // Also on a timer, for agents that work for a long time without reporting.
    if (ACTIVE.has(state.phase) && running) this.ctx.waitUntil(this.#checkpoint());

    const finished = !ACTIVE.has(state.phase) && state.phase !== "idle" && state.phase !== "starting";
    if (finished) await this.ctx.storage.deleteAlarm();
    // A finished task keeps its container for inspection until the inactivity timeout; an expired one does not.
    if (expired && this.#container.running) await this.#container.destroy();
  }

  #agentEnv(state: TaskState): Record<string, string> {
    return {
      ...TRUST_ENV,
      HOME: "/root",
      // pi refuses to start without a key. The Worker replaces this placeholder on the way out.
      OPENAI_API_KEY: "provided-by-worker",
      // Turn off pi's own network traffic; model calls still work.
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      TASK_ID: state.id,
      TASK_PASS: state.token,
      TASK_DIRECTORY,
      GATE_WAIT_SECONDS: String(MAX_WAIT_FOR_ANSWER_S),
    };
  }

  async #launch(state: TaskState, kind: Run["kind"]): Promise<void> {
    const argv = [
      "pi",
      "--mode",
      "json",
      "--provider",
      "openai",
      "--model",
      this.env.MODEL,
      // The gate. It runs inside the pi process; if it throws, pi blocks the tool call.
      "--extension",
      "/opt/spike/gate.ts",
      // A cloned repository must not be able to load its own extensions or settings.
      "--no-approve",
      // Sessions are kept so a later round can test resuming after a container is lost.
      "--session-dir",
      SESSIONS_DIRECTORY,
      "--append-system-prompt",
      SYSTEM_PROMPT,
      // Continue the session that was restored with the workspace.
      ...(kind === "resume" ? ["--continue"] : []),
      "--",
      kind === "resume" ? RESUME_PROMPT : (state.prompt ?? ""),
    ];

    await this.#files.remove(EXIT_CODE_PATH, { force: true });
    await this.#files.remove(PID_PATH, { force: true });
    await this.#container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", ...argv], {
      cwd: state.cwd,
      env: this.#agentEnv(state),
      stdout: "ignore",
      stderr: "ignore",
    });
    state.runs.push({ kind, started_at: Date.now() });
    state.phase = "running";
    this.#save(state);
    await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
  }

  /** Turns a finished process into a task outcome. Safe to call from both the callback and the alarm. */
  async #settle(source: "callback" | "alarm"): Promise<void> {
    const before = this.#state();
    if (!before || !ACTIVE.has(before.phase)) return;

    let exitCode: number | undefined;
    let lost: string | undefined;
    let events = "";
    let stderr = "";

    // A missing container is the alarm's business: it decides between restoring and giving up.
    if (!this.#container.running) return;
    {
      let raw = await this.#readOptional(EXIT_CODE_PATH);
      if (raw === undefined) {
        const pid = (await this.#readOptional(PID_PATH))?.trim();
        // The wrapper has not written its pid yet: it only just started.
        if (!pid && Date.now() - (before.runs.at(-1)?.started_at ?? 0) < 15_000) return;
        // kill is a shell builtin; slim images have no kill binary.
        const alive = pid ? (await this.#run(["/bin/sh", "-c", 'kill -0 "$1"', "probe", pid], "/", {})).exitCode === 0 : false;
        if (alive) return;
        // The process can finish between the two reads; its wrapper writes the code before exiting.
        raw = await this.#readOptional(EXIT_CODE_PATH);
        if (raw === undefined) lost = "agent process ended without recording an exit code";
      }
      if (raw !== undefined) {
        exitCode = Number.parseInt(raw, 10);
        events = (await this.#readOptional(EVENTS_PATH)) ?? "";
        stderr = ((await this.#readOptional(STDERR_PATH)) ?? "").slice(-2_000);
      }
    }

    // Re-read: the other path may have settled this run while we were reading files.
    const state = this.#state();
    if (!state || !ACTIVE.has(state.phase)) return;
    const run = state.runs[state.runs.length - 1];
    run.ended_at = Date.now();
    run.detected_by = source;
    run.exit_code = exitCode;
    state.pending = undefined;

    if (lost) {
      state.phase = "lost";
      state.error = lost;
    } else {
      const summary = summarize(events);
      state.thread_id = summary.session_id ?? state.thread_id;
      run.result = {
        text: summary.text?.slice(0, 4_000),
        stop_reason: summary.stop_reason,
        turns: summary.turns,
        tool_calls: summary.tool_calls,
        duration_ms: run.ended_at - run.started_at,
        usage: summary.usage,
      };
      // pi exits 0 even when the model call fails, so the outcome comes from its events: the run
      // must settle, and the last assistant message must not end in an error.
      if (exitCode !== 0) {
        state.phase = "failed";
        state.error = `pi exited with ${exitCode}: ${stderr}`;
      } else if (!summary.settled || summary.stop_reason === undefined) {
        state.phase = "failed";
        state.error = "pi exited before the agent settled";
      } else if (summary.stop_reason === "error" || summary.stop_reason === "aborted") {
        state.phase = "failed";
        state.error = summary.error ?? `pi stopped: ${summary.stop_reason}`;
      } else {
        state.phase = "succeeded";
      }
    }
    this.#save(state);
  }

  // ---------- container helpers ----------

  async #readOptional(path: string): Promise<string | undefined> {
    try {
      return await (await this.#files.readFile(path)).text();
    } catch (cause) {
      if (SandboxFileError.is(cause) && cause.code === "ENOENT") return undefined;
      throw cause;
    }
  }

  async #run(command: string[], cwd: string, env: Record<string, string>): Promise<CommandResult> {
    const process = await this.#container.exec(command, { cwd, env });
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }
}

/** Phases in which the agent process is expected to be alive. */
const ACTIVE = new Set<Phase>(["running", "needs_input"]);

/** Pulls the session id, final message, usage and failure reason out of `pi --mode json` output. */
function summarize(jsonl: string) {
  const summary = {
    session_id: undefined as string | undefined,
    settled: false,
    text: undefined as string | undefined,
    stop_reason: undefined as string | undefined,
    error: undefined as string | undefined,
    turns: 0,
    tool_calls: 0,
    usage: { input: 0, output: 0, cache_read: 0, total_tokens: 0, cost_usd: 0 },
  };
  for (const line of jsonl.split("\n")) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "session") summary.session_id = event.id;
    else if (event?.type === "agent_settled") summary.settled = true;
    else if (event?.type === "turn_end") {
      summary.turns += 1;
      summary.tool_calls += Array.isArray(event.toolResults) ? event.toolResults.length : 0;
    } else if (event?.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      summary.stop_reason = message.stopReason;
      summary.error = message.errorMessage;
      summary.text = (message.content ?? [])
        .filter((block: any) => block?.type === "text")
        .map((block: any) => block.text ?? "")
        .join("");
      const usage = message.usage ?? {};
      summary.usage.input += usage.input ?? 0;
      summary.usage.output += usage.output ?? 0;
      summary.usage.cache_read += usage.cacheRead ?? 0;
      summary.usage.total_tokens += usage.totalTokens ?? 0;
      summary.usage.cost_usd += usage.cost?.total ?? 0;
    }
  }
  summary.usage.cost_usd = Math.round(summary.usage.cost_usd * 1e6) / 1e6;
  return summary;
}

const ROUTES = [
  "POST /tasks {prompt?,repository?,ref?}              start a container; without a prompt it stays idle for /probe",
  "GET  /tasks/:id                                     phase, timings, runs, inbox (what the container pushed), alarm checks",
  "POST /tasks/:id/probe                               credential isolation, egress blocking, callback path (no model tokens)",
  "POST /tasks/:id/answer {decision,reason,tool_use_id?} answer the call the gate is holding (allow | deny)",
  "GET  /tasks/:id/events | /hooks | /stderr | /diff   raw agent events, hook log, stderr + report log, workspace diff",
  "POST /tasks/:id/kill-container                      destroy the container but keep the task (loss detection)",
  "POST /tasks/:id/destroy                             destroy the container and the task",
];
