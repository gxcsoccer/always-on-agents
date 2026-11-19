import type { BrainAgent } from "./brain/agent";
import type { Registry } from "./registry";
import type { TaskSandbox } from "./workers/sandbox/task";

export interface Env {
  BRAIN: DurableObjectNamespace<BrainAgent>;
  TASKS: DurableObjectNamespace<TaskSandbox>;
  REGISTRY: DurableObjectNamespace<Registry>;
  CHECKPOINTS: R2Bucket;

  /** Where model calls go. The Brain calls it directly; the sandbox proxy adds the key for this host. */
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY: string;
  BRAIN_MODEL: string;
  WORKER_MODEL: string;

  /** Guards the admin API: creating tenants and inspecting state. */
  ADMIN_KEY: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** The GitHub App the agent acts as. With these set, tokens are issued per installation and per repository. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** The agent's account name on GitHub (an App's bot is `<app-slug>`), used to recognise mentions. */
  GITHUB_BOT_HANDLE?: string;
  /** The address commits are made under; for an App, `<bot user id>+<app-slug>[bot]@users.noreply.github.com`. */
  GITHUB_BOT_EMAIL?: string;
  /** Optional: a regular expression for shell commands inside the sandbox that a person must approve. Default: none. */
  GATE_HOLD_PATTERN?: string;
  /** A single deployment-wide token, used only when no App is configured. For local development. */
  GITHUB_TOKEN?: string;
}
