/**
 * The sandbox worker: one Durable Object per task, owning a container that runs a coding agent (pi)
 * headless. The container has no internet and no credentials. Everything it sends goes through
 * `Outbound`, which adds credentials, enforces policy and holds actions that need approval.
 *
 * What it guarantees to the Brain that started it:
 *   - every report (progress, needs_input, result, failed, lost) is numbered and delivered at least once
 *   - a container that disappears is replaced from the last checkpoint and the agent continues
 *   - a deploy or eviction does not strand the agent: the outbound route is re-attached on restart
 *   - nothing is kept alive forever: startup, idle time and total lifetime are bounded
 *
 * What it does not guarantee: that the worker's own summary is true. Its reports are the guest's
 * word and are passed on as such.
 */
import {
  DirectoryBackup,
  type DirectoryBackupGatewayBinding,
  type DirectoryBackupRecord,
  Files,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../../env";
import { githubTokenFor } from "../../connectors/github-app";
import type { WorkerEventKind } from "../../events";
import { registry } from "../../registry";
import { standingEligible, BRAIN_HOST, type Outbound, type RefUpdate, describePush } from "./outbound";

// Lets the container upload and download one checkpoint object in R2, and nothing else.
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

interface TaskCtx extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    readonly Outbound: LoopbackForExport<typeof Outbound>;
    readonly DirectoryBackupGateway: DirectoryBackupGatewayBinding;
  };
}

export type Phase = "starting" | "idle" | "running" | "needs_input" | "succeeded" | "failed" | "lost" | "cancelled";

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

export interface TaskState {
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
    /** For a push: exactly which refs would move, and to which commits. */
    refs?: RefUpdate[];
    /** Identifies the exact request being held. An approval is for this and nothing else. */
    key?: string;
    /** When the held request last checked in. A request that stops checking in is gone. */
    polled_at?: number;
    asked_at: number;
  };
  /** Answers for held network actions, keyed by the exact request they were given for. Used once. */
  grants: Record<string, { state: "allow" | "deny"; reason: string; until: number; holder_seen_at?: number }>;
  /** Pushes a person approved for the rest of the task: which branches of which repository. */
  standing?: { resource: string; refs: string[] }[];
  /** Counts approval requests, so each gets its own id. */
  asks: number;
  brain?: string;
  model_calls: number;
  finished_at?: number;
  /** Held here, never in the container. Dropped with the task. */
  github_token?: { token: string; expires_at: number; source: string };
  /** When the current `starting` phase began. Startup is timed from here, not from task creation. */
  starting_since: number;
  /** Reports not yet acknowledged by the Brain, in order. Delivered at least once. */
  out: { seq: number; kind: WorkerEventKind; body: Record<string, unknown> }[];
  out_seq: number;
  /** The latest copy of /workspace in R2: the agent's files and its session transcript. */
  checkpoint?: { record: DirectoryBackupRecord; at: number; took_ms: number };
  checkpoints_taken: number;
  /** Earlier checkpoints whose deletion failed. Deleted with the task. */
  stale_checkpoints?: DirectoryBackupRecord[];
  /** How many times the task was restored into a new container. */
  recoveries: number;
  /** For the in-process gate: which question we opened for which of its tool calls. */
  gate_questions: Record<string, { id: string; command: string; closed?: boolean }>;
  /** Answers, keyed by question id. Kept here, outside the container, so the guest cannot write one. */
  decisions: Record<string, { decision: "allow" | "deny"; reason: string; at: number; standing?: boolean }>;
  /** Stand-in for the Brain's inbox: everything the container pushed to us. */
  inbox: InboxItem[];
  /** What each alarm tick saw, to show the keep-alive actually held. */
  checks: { at: number; phase: Phase; container_running: boolean }[];
  error?: string;
}

export type QuestionFate = { state: "decided"; decision: "allow" | "deny"; standing?: boolean } | { state: "pending" | "undecided" | "unknown" };

export interface StartInput {
  /** Scope name of the Brain to report to. Without it the task runs but reports to nobody. */
  brain?: string;
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
const MAX_MODEL_CALLS_PER_TASK = 400;
/** How long a finished task's record, container and checkpoint are kept for inspection. */
const PURGE_AFTER_MS = 24 * 60 * 60 * 1_000;
/** How much of the end of the agent's event log is read to work out how it ended. */
const MAX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const ADMIN_READ_BYTES = 2 * 1024 * 1024;
const MAX_IDLE_MS = 15 * 60 * 1_000;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
// Checkpoints: at most this often, and a task is restored at most this many times.
const CHECKPOINT_MIN_INTERVAL_MS = 30 * 1_000;
const MAX_RECOVERIES = 2;
const MAX_STALE_CHECKPOINTS = 20;
// A running process does not keep a container awake; requests do. Check well within the timeout.
const CHECK_INTERVAL_MS = 20 * 1_000;
// How long the proxy holds a request that needs approval, and how long an approval stays usable.
// A push is several HTTP requests; the grant has to cover all of them and nothing after.
const GRANT_TTL_MS = 2 * 60 * 1_000;
/** How long the proxy may hold a request for an answer, enforced here whatever the poller does. */
const PROXY_HOLD_MS = 50 * 60 * 1_000;
/** The holder polls every two seconds. Silence this long means it is gone. */
const PROXY_ABANDONED_MS = 60 * 1_000;
/** The gate waits 55 minutes and polls every two seconds. Past either of these it is not waiting any more. */
const GATE_HOLD_MS = 57 * 60 * 1_000;
const GATE_ABANDONED_MS = 5 * 60 * 1_000;
const MAX_SHOWN_COMMAND = 3_000;
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
node /opt/agent/report.mjs exit "$code" >>${REPORT_LOG_PATH} 2>&1`;

const SYSTEM_PROMPT = `You are running unattended inside a sandbox; nobody is watching the terminal.
Your final answer is the result of the task. It goes to the agent that gave you the task, which tells people; you cannot message anyone, post comments or open pull requests yourself, so put everything they need in that answer.
The network reaches the model and git only. You cannot install packages; if something needs that, say so instead of trying.
After each meaningful step, run the shell command: report progress "<one sentence on what you just finished>"
Some commands pause until a person approves them; that is expected, just wait. A git push in particular is held until someone approves it, which can take up to an hour: run it with a timeout of at least 3600 seconds, and never treat the wait as a failure, cancel it, or retry it while it is waiting.
If a command is denied, do not retry it or work around it; say so in your final answer.`;

const RESUME_PROMPT = `The sandbox you were working in was replaced. Your files and this conversation were restored from a checkpoint, so the last few things you did before the interruption may be missing. Look at the current state of the directory, work out which steps are actually done, and continue the original task from there. Do not redo steps that are already done.`;

export class TaskSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  readonly #outbound: Fetcher;
  readonly #backups: DirectoryBackup;
  #checkpointing = false;
  #flushing = false;

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
    const state = this.ctx.storage.kv.get<TaskState>("state");
    if (!state) return undefined;
    // Fields added after a task was created are filled in, so a task from an older deploy still loads.
    state.gate_questions ??= {};
    state.decisions ??= {};
    state.grants ??= {};
    state.out ??= [];
    state.out_seq ??= 0;
    state.asks ??= 0;
    state.model_calls ??= 0;
    for (const [callId, question] of Object.entries(state.gate_questions)) {
      if (typeof question === "string") state.gate_questions[callId] = { id: question, command: "" };
    }
    return state;
  }

  #save(state: TaskState) {
    if (!ACTIVE.has(state.phase) && state.phase !== "starting" && state.phase !== "idle") {
      // The task is over: the clock for cleaning up starts now, and no approval outlives it.
      state.finished_at ??= Date.now();
      state.grants = {};
      state.pending = undefined;
    }
    state.inbox = state.inbox.slice(-200);
    state.checks = state.checks.slice(-200);
    this.ctx.storage.kv.put("state", state);
  }

  // ---------- RPC surface ----------

  /** Starts the task, or returns where it stands if it was already started. Safe to call again. */
  async start(input: StartInput): Promise<{ phase: Phase; error?: string }> {
    const state = await this.#start(input);
    return { phase: state.phase, error: state.error };
  }

  async #start(input: StartInput): Promise<TaskState> {
    // kv is synchronous, so check-and-set cannot interleave with another start.
    // Starting twice is a retry of the same dispatch, not a second task.
    const existing = this.#state();
    if (existing) return { ...existing, token: "(hidden)" };
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
      gate_questions: {},
      decisions: {},
      grants: {},
      asks: 0,
      brain: input.brain,
      model_calls: 0,
      starting_since: t0,
      out: [],
      out_seq: 0,
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
          // Shallow, but with every branch's tip: a shallow clone otherwise knows only the default
          // branch, and a task asked to work on another one finds it does not exist.
          ["git", "clone", "--depth", "1", "--no-single-branch", ...branch, "--", input.repository, REPOSITORY_DIRECTORY],
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
      // Re-read: the agent is running now and may already have reported.
      const fresh = this.#state() ?? state;
      fresh.timings.launched_ms = Date.now() - t0;
      this.#save(fresh);
      return fresh;
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
    return { ...state, token: "(hidden)", github_token: state.github_token ? { ...state.github_token, token: "(hidden)" } : undefined };
  }

  /** Called through Outbound when the container reports or asks. The reply goes back to the container. */
  async callback(kind: string, token: string, body: unknown): Promise<{ ok: boolean; decision?: string; reason?: string }> {
    const state = this.#state();
    if (!state || token !== state.token) return { ok: false };
    const request = (body ?? {}) as { tool_use_id?: string; tool_name?: string; command?: string };
    // Ids come from the guest; only well-formed ones are used as keys.
    const callId = /^[\w|.:-]{1,200}$/.test(request.tool_use_id ?? "") ? (request.tool_use_id as string) : undefined;

    // The gate polls for its answer. Not recorded in the inbox: it would be one entry every two seconds.
    // It asks by its own call id; the answer is filed under the question id we made for that call.
    // An answer is for the command the question showed; the same call id with another command gets none.
    const command = String(request.command ?? "");
    if (kind === "decision") {
      const question = callId ? state.gate_questions[callId] : undefined;
      const answer = question && question.command === command ? state.decisions[question.id] : undefined;
      if (answer) return { ok: true, decision: answer.decision, reason: answer.reason };
      // A question that was withdrawn can no longer be answered; the gate is told so rather than left waiting.
      if (question?.closed) return { ok: true, decision: "deny", reason: "the question expired without an answer" };
      // The gate is still there. Noted now and then, so a gate that has gone away is noticed.
      if (question && state.pending?.source === "gate" && state.pending.id === question.id && Date.now() - (state.pending.polled_at ?? 0) > 20_000) {
        state.pending.polled_at = Date.now();
        this.#save(state);
      }
      return { ok: true, decision: "pending" };
    }

    state.inbox.push({ at: Date.now(), kind, body });
    if (kind === "gate_timeout") {
      // The gate stopped waiting and blocked the call. Its question no longer stands, here or in the Brain.
      const question = callId ? state.gate_questions[callId] : undefined;
      if (question) this.#closeGateQuestion(state, question.id);
      this.#save(state);
      this.ctx.waitUntil(this.#flush());
      return { ok: true };
    }
    if (kind === "needs_input") {
      if (!callId || state.phase !== "running") {
        this.#save(state);
        return { ok: false };
      }
      // The id of a question is ours, never the guest's: a guest that reuses or invents a call id
      // cannot make an old answer apply to a new question.
      if (state.gate_questions[callId]?.command === command) {
        this.#save(state);
        return { ok: true };
      }
      state.asks += 1;
      const id = `q-${state.asks}`;
      state.gate_questions[callId] = { id, command };
      state.phase = "needs_input";
      state.pending = { id, source: "gate", tool_name: request.tool_name, command, asked_at: Date.now(), polled_at: Date.now() };
      // People are shown the whole command or told that they are not; never a silent prefix.
      this.#emit(state, "needs_input", { source: "gate", id, command: command.slice(0, MAX_SHOWN_COMMAND), truncated: command.length > MAX_SHOWN_COMMAND });
    } else if (kind === "progress") {
      this.#emit(state, "progress", { message: String((body as { message?: unknown })?.message ?? "").slice(0, 1_000) });
    }
    this.#save(state);
    if (kind === "exit") await this.#settle("callback");
    // A progress report means a step just finished: a good moment to copy the workspace out.
    else if (kind === "progress") this.ctx.waitUntil(this.#checkpoint());
    this.ctx.waitUntil(this.#flush());
    return { ok: true };
  }

  /**
   * Answers the call the gate is holding. The answer is stored here and handed to the gate when it
   * next polls; nothing is written into the container. No awaits, so this cannot interleave.
   */
  async answer(decision: "allow" | "deny", reason: string, questionId?: string, standing = false): Promise<{ ok: true; decision: "allow" | "deny"; standing?: boolean } | { ok: false; error: string }> {
    const state = this.#state();
    if (!state) return { ok: false, error: "no such task" };
    if (decision !== "allow" && decision !== "deny") return { ok: false, error: "decision must be allow or deny" };
    // A question is answered once. Answering it again returns the answer it already has, which the
    // guest may have acted on; it cannot be changed after the fact.
    if (questionId !== undefined && state.decisions[questionId]) return { ok: true, decision: state.decisions[questionId].decision, standing: state.decisions[questionId].standing };
    this.#expireHold(state);
    if (state.phase !== "needs_input" || !state.pending) {
      this.#save(state);
      return { ok: false, error: `task is ${state.phase}, nothing to answer` };
    }
    // A late answer to an earlier question must not approve whatever is pending now.
    if (questionId !== undefined && questionId !== state.pending.id) {
      return { ok: false, error: "that question is no longer pending" };
    }
    // What is kept here is what took effect, and is what every later report of this decision says:
    // `standing` is true only if the approval was in fact extended to the rest of the task.
    const kept: TaskState["decisions"][string] = { decision, reason, at: Date.now(), standing: false };
    state.decisions[state.pending.id] = kept;
    if (state.pending.source === "proxy") {
      // For the one request being held: same repository, same refs, same commits. Short-lived, and
      // removed the moment the proxy collects it.
      if (!state.pending.key) return { ok: false, error: "that request is no longer being held" };
      state.grants[state.pending.key] = {
        state: decision,
        reason,
        until: Date.now() + GRANT_TTL_MS,
        // The holder must still be there to collect: it is judged by when it was last seen.
        holder_seen_at: state.pending.polled_at ?? state.pending.asked_at,
      };
      // Approved for the rest of the task as well: later pushes of the same branches to the same
      // repository go through without asking. Never a deletion, and never anything else.
      if (decision === "allow" && standing && state.pending.resource && standingEligible(state.pending.refs ?? [])) {
        state.standing = [...(state.standing ?? []), { resource: state.pending.resource, refs: (state.pending.refs ?? []).map((r) => r.ref) }];
        kept.standing = true;
      }
    }
    state.inbox.push({ at: Date.now(), kind: "answered", body: { decision, reason, tool_use_id: state.pending.id } });
    state.pending = undefined;
    state.phase = "running";
    this.#save(state);
    return { ok: true, decision, standing: kept.standing };
  }

  /**
   * What became of a question, for someone who sent an answer and never heard back. Reads only.
   *   decided:   an answer was recorded; this is what the guest was told. `standing` is absent on
   *              a record made before it was kept.
   *   pending:   the question is still the one being waited on.
   *   undecided: the task has moved past the question and no answer to it was ever recorded.
   *   unknown:   this task's records are gone (they are removed some time after it ends).
   */
  async decisionOn(questionId: string): Promise<QuestionFate> {
    const state = this.#state();
    if (!state) return { state: "unknown" };
    const held = state.decisions[questionId];
    if (held) return { state: "decided", decision: held.decision, standing: held.standing };
    return state.pending?.id === questionId ? { state: "pending" } : { state: "undecided" };
  }

  /** Whether the task is still entitled to reach the outside world. */
  async isActive(): Promise<boolean> {
    const state = this.#state();
    return Boolean(state) && (ACTIVE.has(state!.phase) || state!.phase === "starting" || state!.phase === "idle");
  }

  /** The repository this task was started on, as lowercase owner/name, or "" if none. */
  async repository(): Promise<string> {
    const match = this.#state()?.repository?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return match ? match[1].toLowerCase() : "";
  }

  /**
   * A GitHub token for this task's repository, or nothing.
   *
   * Credentials are lent only to a task that was started from that repository's own scope, which
   * exists only because GitHub delivered a signed event for it under this tenant's installation.
   * A task started from a chat can name any repository, so it gets none and can only read what is
   * public: being in a tenant is not the same as having access to all of its code. The exception
   * is a group chat that an operator has linked to one repository, for that repository only.
   */
  async githubToken(): Promise<string | undefined> {
    const state = this.#state();
    const repo = await this.repository();
    if (!state || !repo) return undefined;
    // A finished task keeps its container for a while, for inspection. Whatever is still running in
    // it gets no credentials: lending stops when the task does.
    if (!ACTIVE.has(state.phase) && state.phase !== "starting") return undefined;
    // A task with no Brain is a development probe; it gets the development token or nothing.
    if (!state.brain) return this.env.GITHUB_APP_ID || this.env.GITHUB_APP_PRIVATE_KEY ? undefined : this.env.GITHUB_TOKEN || undefined;
    const [tenant, kind, ...rest] = state.brain.split(":");
    // Lent in the repository's own conversation, or in a group chat an operator has linked to this
    // very repository. Looked up each time, so removing the link stops the lending at once.
    const entitled = async () => (kind === "repo" && rest.join(":").toLowerCase() === repo) || (kind === "chat" && (await registry(this.env).chatRepo(tenant, rest.join(":"))) === repo);
    if (!(await entitled())) return undefined;
    // Looking the link up took a moment; the task may have ended meanwhile.
    const still = this.#state();
    if (!still || (!ACTIVE.has(still.phase) && still.phase !== "starting")) return undefined;
    // Checked before the cache: a credential issued under an earlier configuration is not lent on.
    if (Boolean(this.env.GITHUB_APP_ID) !== Boolean(this.env.GITHUB_APP_PRIVATE_KEY)) return undefined;
    const source = this.env.GITHUB_APP_ID ? `app:${this.env.GITHUB_APP_ID}` : "token";
    if (still.github_token && still.github_token.source === source && still.github_token.expires_at - Date.now() > 5 * 60_000) return still.github_token.token;
    const issued = await githubTokenFor(this.env, tenant, repo);
    if (!issued) return undefined;
    // Issuing took time. If the link was removed or the task ended meanwhile, the token is not handed over.
    if (!(await entitled())) return undefined;
    const fresh = this.#state();
    if (!fresh || (!ACTIVE.has(fresh.phase) && fresh.phase !== "starting")) return undefined;
    fresh.github_token = { ...issued, source };
    this.#save(fresh);
    return issued.token;
  }

  /** Counts a model call against the task's allowance. Returns false once it is used up. */
  async countModelCall(): Promise<boolean> {
    const state = this.#state();
    if (!state || !(ACTIVE.has(state.phase) || state.phase === "starting")) return false;
    if ((state.model_calls ?? 0) >= MAX_MODEL_CALLS_PER_TASK) return false;
    state.model_calls = (state.model_calls ?? 0) + 1;
    this.#save(state);
    // A worker already running must stop spending when its tenant's daily budget is gone. Its own
    // token counts are not known here, so each call is charged an estimate; the Brain adds the
    // worker's reported total when the task ends.
    const tenant = state.brain?.split(":")[0];
    if (!tenant) return true;
    const allowed = (await registry(this.env).recordUsage(tenant, 0)).allowed;
    // The lookup took time; the task may have been cancelled or have ended meanwhile.
    const now = this.#state();
    return allowed && Boolean(now) && (ACTIVE.has(now!.phase) || now!.phase === "starting");
  }

  /**
   * Called by the proxy for a network action that needs approval. Returns the standing answer if
   * there is one, otherwise asks (once) and reports `pending`. No awaits, so it cannot interleave.
   */
  async authorize(requestId: string, action: string, resource: string, refs: RefUpdate[]): Promise<{ state: "allow" | "deny" | "pending"; reason: string }> {
    const state = this.#state();
    if (!state) return { state: "deny", reason: "no such task" };
    // An answer is filed under the id of the one held request it was given for, and removed when
    // that request collects it. No other request, however similar, can use it.
    const grant = state.grants[requestId];
    if (grant) {
      delete state.grants[requestId];
      this.#save(state);
      const present = Date.now() - (grant.holder_seen_at ?? 0) <= PROXY_ABANDONED_MS;
      if (grant.until > Date.now() && present && ACTIVE.has(state.phase)) return { state: grant.state, reason: grant.reason };
      return { state: "deny", reason: "the approval expired before it was used" };
    }
    if (state.pending?.source === "proxy" && state.pending.key === requestId) {
      this.#expireHold(state);
      if (!state.pending) {
        this.#save(state);
        this.ctx.waitUntil(this.#flush());
        return { state: "deny", reason: "the request waited too long for an answer" };
      }
      // Seen again in time: the request is still being held.
      state.pending.polled_at = Date.now();
      this.#save(state);
      return { state: "pending", reason: "" };
    }
    // Something else is waiting for an answer, or the task is not running: wait for our turn.
    if (state.phase !== "running") {
      return ACTIVE.has(state.phase) ? { state: "pending", reason: "" } : { state: "deny", reason: `task is ${state.phase}` };
    }
    // The same test when it is used as when it was given: branches only, nothing deleted.
    const covered = standingEligible(refs) && (state.standing ?? []).some((grant) => grant.resource === resource && refs.every((r) => grant.refs.includes(r.ref)));
    if (covered) {
      // Said once for this task. Still on record, and the Brain is told each time.
      const message = `under the standing approval for this task: ${describePush(resource, refs)}`;
      state.inbox.push({ at: Date.now(), kind: "standing", body: { action, resource, refs } });
      this.#emit(state, "progress", { message: message.slice(0, 1_000) });
      this.#save(state);
      this.ctx.waitUntil(this.#flush());
      return { state: "allow", reason: "standing approval" };
    }
    state.asks += 1;
    state.pending = { id: `q-${state.asks}`, source: "proxy", action, resource, refs, key: requestId, asked_at: Date.now(), polled_at: Date.now() };
    state.phase = "needs_input";
    const body = { source: "proxy", id: state.pending.id, action, resource, refs, summary: describePush(resource, refs) };
    state.inbox.push({ at: Date.now(), kind: "needs_input", body });
    this.#emit(state, "needs_input", body);
    this.#save(state);
    this.ctx.waitUntil(this.#flush());
    return { state: "pending", reason: "" };
  }

  /** The held request gave up. Its question no longer stands and no answer for it may be left behind. */
  async withdraw(requestId: string): Promise<void> {
    const state = this.#state();
    if (!state) return;
    this.#withdraw(state, requestId);
    this.#save(state);
    this.ctx.waitUntil(this.#flush());
  }

  #withdraw(state: TaskState, requestId: string): void {
    delete state.grants[requestId];
    if (state.pending?.source === "proxy" && state.pending.key === requestId) {
      state.inbox.push({ at: Date.now(), kind: "withdrawn", body: { id: state.pending.id } });
      // The Brain is told, so it stops showing a question nobody can answer any more.
      this.#emit(state, "withdrawn", { id: state.pending.id });
      state.pending = undefined;
      if (state.phase === "needs_input") state.phase = "running";
    }
  }

  /** The gate's question no longer stands, here or in the Brain, and can no longer be answered. */
  #closeGateQuestion(state: TaskState, id: string): void {
    for (const question of Object.values(state.gate_questions)) if (question.id === id) question.closed = true;
    if (state.pending?.source === "gate" && state.pending.id === id) {
      state.inbox.push({ at: Date.now(), kind: "withdrawn", body: { id } });
      this.#emit(state, "withdrawn", { id });
      state.pending = undefined;
      if (state.phase === "needs_input") state.phase = "running";
    }
  }

  /** A held request whose time is up, or whose handler has stopped checking in, no longer stands. */
  #expireHold(state: TaskState): void {
    const pending = state.pending;
    const now = Date.now();
    // The gate's own notice that it gave up can be lost, so its questions expire here as well.
    if (pending?.source === "gate" && (now - pending.asked_at > GATE_HOLD_MS || now - (pending.polled_at ?? pending.asked_at) > GATE_ABANDONED_MS)) {
      this.#closeGateQuestion(state, pending.id);
      return;
    }
    if (pending?.source !== "proxy" || !pending.key) return;
    if (now - pending.asked_at > PROXY_HOLD_MS || now - (pending.polled_at ?? pending.asked_at) > PROXY_ABANDONED_MS) this.#withdraw(state, pending.key);
  }

  /** Stops the task for good and discards its container. */
  async cancel(): Promise<{ ok: true }> {
    const state = this.#state();
    if (this.#container.running) await this.#container.destroy();
    if (state && (ACTIVE.has(state.phase) || state.phase === "starting" || state.phase === "idle")) {
      const fresh = this.#state() ?? state;
      fresh.phase = "cancelled";
      fresh.pending = undefined;
      fresh.out = [];
      this.#save(fresh);
      // The next alarm schedules the clean-up.
      await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
    }
    return { ok: true };
  }

  /** Queues a report for the Brain. The caller saves the state; delivery happens in #flush. */
  #emit(state: TaskState, kind: WorkerEventKind, body: Record<string, unknown>): void {
    if (!state.brain) return;
    state.out_seq += 1;
    state.out.push({ seq: state.out_seq, kind, body });
  }

  /** Delivers queued reports in order. A failure leaves them queued; the next alarm tries again. */
  async #flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      for (;;) {
        const state = this.#state();
        const next = state?.out[0];
        if (!state?.brain || !next) return;
        await this.env.BRAIN.getByName(state.brain).taskEvent(state.id, next.seq, next.kind, next.body);
        const fresh = this.#state();
        if (!fresh) return;
        fresh.out = fresh.out.filter((report) => report.seq !== next.seq);
        this.#save(fresh);
      }
    } catch (err) {
      console.log(JSON.stringify({ report_delivery_failed: String(err) }));
    } finally {
      this.#flushing = false;
    }
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
      callback_to_worker: show(await this.#run(["node", "/opt/agent/report.mjs", "ping", "probe"], "/", env)),
      // Expect 403: a report with the wrong pass must be rejected.
      callback_with_wrong_pass: show(
        await this.#run(["node", "/opt/agent/report.mjs", "ping", "forged"], "/", { ...env, TASK_PASS: "wrong" }),
      ),
    };
  }

  async readFiles(which: "events" | "hooks" | "stderr"): Promise<string> {
    const state = this.#state();
    if (!state || !this.#container.running) return "";
    if (which === "hooks") return (await this.#readTail(HOOK_LOG_PATH, ADMIN_READ_BYTES)) ?? "";
    if (which === "stderr") {
      return `${(await this.#readTail(STDERR_PATH, ADMIN_READ_BYTES)) ?? ""}\n--- report.log ---\n${(await this.#readTail(REPORT_LOG_PATH, ADMIN_READ_BYTES)) ?? ""}`;
    }
    return (await this.#readTail(EVENTS_PATH, ADMIN_READ_BYTES)) ?? "";
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
      labels: { app: "always-on-agents", task: taskId },
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
    // If old checkpoints cannot be deleted, stop making new ones rather than pile them up: every
    // one that is made has to be remembered until it is gone.
    if ((before.stale_checkpoints?.length ?? 0) >= MAX_STALE_CHECKPOINTS) return;
    this.#checkpointing = true;
    const started = Date.now();
    try {
      const record = await this.#backups.backup({ dir: WORKSPACE_DIRECTORY, name: `task ${before.id}` });
      const state = this.#state();
      if (!state) return;
      // The checkpoint being replaced is written down as stale in the same save that installs the
      // new one. If this object stops before the old one is deleted, the record survives and the
      // clean-up at the end of the task removes it; it is the only pointer to that object.
      const previous = state.checkpoint?.record;
      if (previous) state.stale_checkpoints = [...(state.stale_checkpoints ?? []), previous];
      state.checkpoint = { record, at: started, took_ms: Date.now() - started };
      state.checkpoints_taken += 1;
      this.#save(state);
      if (previous) {
        await this.#backups.delete(previous);
        const later = this.#state();
        if (later) {
          later.stale_checkpoints = (later.stale_checkpoints ?? []).filter((stale) => stale.id !== previous.id);
          this.#save(later);
        }
      }
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
    // Whatever was being held died with the container; its question no longer stands.
    if (before.pending) this.#emit(before, "withdrawn", { id: before.pending.id });
    before.pending = undefined;
    before.grants = {};
    before.phase = "starting";
    before.starting_since = started;
    before.inbox.push({ at: started, kind: "recovering", body: { message: `from checkpoint taken ${Math.round((started - before.checkpoint.at) / 1000)}s ago` } });
    this.#save(before);
    try {
      await this.#boot(before.id);
      await this.#backups.restore(before.checkpoint.record, { dir: WORKSPACE_DIRECTORY });
      const state = this.#state();
      if (!state) return;
      state.timings[`recovery_${state.recoveries}_ms`] = Date.now() - started;
      this.#emit(state, "recovered", { message: "the sandbox was replaced and the work resumed from a checkpoint" });
      await this.#launch(state, "resume");
      this.ctx.waitUntil(this.#flush());
    } catch (err) {
      const state = this.#state();
      if (!state) return;
      state.phase = "lost";
      state.error = `recovery failed: ${String(err)}`;
      this.#emit(state, "lost", { error: state.error });
      this.#save(state);
      this.ctx.waitUntil(this.#flush());
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
    const overdue = Date.now() - before.created_at > MAX_LIFETIME_MS;
    if (ACTIVE.has(before.phase) && !overdue) {
      try {
        await this.#settle("alarm");
      } catch (err) {
        // Whatever is wrong with the task's files, the limits below still have to be enforced.
        console.log(JSON.stringify({ event: "settle_failed", task: before.id, error: String(err) }));
      }
    }
    const running = this.#container.running;
    // Touch the container: a request to it is what counts as activity. Not once it is overdue:
    // from then on nothing the guest wrote is read again.
    if (running && !overdue) await this.#readTail(PID_PATH, 32).catch(() => undefined);

    // Every await is done. From here to #save nothing can interleave, so this cannot overwrite
    // a state that a callback settled in the meantime.
    const state = this.#state();
    if (!state) return;
    state.checks.push({ at: Date.now(), phase: state.phase, container_running: running });
    this.#expireHold(state);
    const age = Date.now() - state.created_at;
    const alive = ACTIVE.has(state.phase) || state.phase === "idle" || state.phase === "starting";
    let expired = false;
    if (alive && state.phase === "starting") {
      expired = Date.now() - (state.starting_since ?? state.created_at) > STARTUP_DEADLINE_MS;
      if (expired) state.error = "startup did not finish in time";
    } else if (alive && !running) {
      // Judged on the task's age now, not as it was before the awaits above.
      if (ACTIVE.has(state.phase) && state.checkpoint && state.recoveries < MAX_RECOVERIES && age <= MAX_LIFETIME_MS) {
        this.#save(state);
        await this.#recover();
        return;
      }
      state.phase = "lost";
      state.error = "container stopped before the task finished";
      this.#emit(state, "lost", { error: state.error });
    } else if (alive && age > (state.phase === "idle" ? MAX_IDLE_MS : MAX_LIFETIME_MS)) {
      expired = true;
      state.error = "exceeded the maximum lifetime";
    }
    if (expired) {
      state.phase = "failed";
      this.#emit(state, "failed", { error: state.error ?? "expired" });
    }
    this.#save(state);
    await this.#flush();

    // Also on a timer, for agents that work for a long time without reporting.
    if (ACTIVE.has(state.phase) && running) this.ctx.waitUntil(this.#checkpoint());

    const finished = !ACTIVE.has(state.phase) && state.phase !== "idle" && state.phase !== "starting";
    // An expired task does not keep its container; a finished one keeps it for inspection until the
    // inactivity timeout.
    if (expired && this.#container.running) await this.#container.destroy();
    // Keep waking at the usual pace until every report has reached the Brain. After that the task
    // only has to be woken once more, to remove what it left behind.
    const latest = this.#state();
    if (!finished || !latest || latest.out.length > 0) return;
    const purgeAt = (latest.finished_at ?? Date.now()) + PURGE_AFTER_MS;
    if (Date.now() >= purgeAt) return this.#purge(latest);
    await this.ctx.storage.setAlarm(purgeAt);
  }

  /** Removes everything a finished task left: its checkpoint in R2, its container, its own record. */
  async #purge(state: TaskState): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
    const records = [...(state.stale_checkpoints ?? []), ...(state.checkpoint ? [state.checkpoint.record] : [])];
    if (records.length > 0) {
      try {
        for (const record of records) await this.#backups.delete(record);
      } catch (err) {
        // The record is the only pointer to the object in R2. Keep it and try again later.
        console.log(JSON.stringify({ event: "checkpoint_delete_failed", task: state.id, error: String(err) }));
        await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1_000);
        return;
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  #agentEnv(state: TaskState): Record<string, string> {
    const handle = this.env.GITHUB_BOT_HANDLE?.replace(/[^\w-]/g, "");
    const commitName = handle ? `${handle}[bot]` : "always-on-agent";
    // Without an address of its own, one under a domain that can never belong to anybody.
    const commitEmail = this.env.GITHUB_BOT_EMAIL || "agent@always-on-agent.invalid";
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
      ...(this.env.GATE_HOLD_PATTERN ? { GATE_HOLD_PATTERN: this.env.GATE_HOLD_PATTERN } : {}),
      // Who commits are by. Set here, and in the environment so that it outranks anything the
      // agent configures for itself: left to choose, it makes up a name and an address, and
      // GitHub then credits the commit to whichever stranger owns that address.
      GIT_AUTHOR_NAME: commitName,
      GIT_AUTHOR_EMAIL: commitEmail,
      GIT_COMMITTER_NAME: commitName,
      GIT_COMMITTER_EMAIL: commitEmail,
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
      this.env.WORKER_MODEL,
      // The gate. It runs inside the pi process; if it throws, pi blocks the tool call.
      "--extension",
      "/opt/agent/gate.ts",
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
    // Re-read: the awaits above let other calls in (a cancellation, a counted model call).
    const fresh = this.#state() ?? state;
    if (fresh.phase === "cancelled") return;
    fresh.runs.push({ kind, started_at: Date.now() });
    fresh.phase = "running";
    this.#save(fresh);
    await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
  }

  /** Turns a finished process into a task outcome. Safe to call from both the callback and the alarm. */
  async #settle(source: "callback" | "alarm"): Promise<void> {
    const before = this.#state();
    if (!before || !ACTIVE.has(before.phase)) return;
    // Past its lifetime a task is ended by the alarm, without looking at its files.
    if (Date.now() - before.created_at > MAX_LIFETIME_MS) return;

    let exitCode: number | undefined;
    let lost: string | undefined;
    let events = "";
    let stderr = "";

    // A missing container is the alarm's business: it decides between restoring and giving up.
    if (!this.#container.running) return;
    {
      let raw = await this.#readTail(EXIT_CODE_PATH, 32);
      if (raw === undefined) {
        const pid = (await this.#readTail(PID_PATH, 32))?.trim();
        // The wrapper has not written its pid yet: it only just started.
        if (!pid && Date.now() - (before.runs.at(-1)?.started_at ?? 0) < 15_000) return;
        // kill is a shell builtin; slim images have no kill binary.
        const alive = pid ? (await this.#run(["/bin/sh", "-c", 'kill -0 "$1"', "probe", pid], "/", {})).exitCode === 0 : false;
        if (alive) return;
        // The process can finish between the two reads; its wrapper writes the code before exiting.
        raw = await this.#readTail(EXIT_CODE_PATH, 32);
        if (raw === undefined) lost = "agent process ended without recording an exit code";
      }
      if (raw !== undefined) {
        exitCode = Number.parseInt(raw, 10);
        // These files are written by the guest and can be any size. Only their ends are read: the
        // outcome is in the last events, and a bounded read cannot exhaust this object's memory.
        events = (await this.#readTail(EVENTS_PATH, MAX_TRANSCRIPT_TAIL_BYTES)) ?? "";
        stderr = ((await this.#readTail(STDERR_PATH, 4_000)) ?? "").slice(-2_000);
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
    if (state.phase === "succeeded") {
      this.#emit(state, "result", { text: run.result?.text ?? "", usage: run.result?.usage, turns: run.result?.turns, recoveries: state.recoveries, model_calls: state.model_calls });
    } else if (state.phase === "lost") {
      this.#emit(state, "lost", { error: state.error });
    } else {
      this.#emit(state, "failed", { error: state.error, usage: run.result?.usage, model_calls: state.model_calls });
    }
    this.#save(state);
    this.ctx.waitUntil(this.#flush());
  }

  // ---------- container helpers ----------

  /** The last `bytes` of a file in the container, or undefined if it does not exist. */
  async #readTail(path: string, bytes: number): Promise<string | undefined> {
    const result = await this.#run(["tail", "-c", String(bytes), "--", path], "/", {});
    return result.exitCode === 0 ? result.stdout : undefined;
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
      summary.text = (Array.isArray(message.content) ? message.content : [])
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
