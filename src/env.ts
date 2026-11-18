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
  /** A single deployment-wide token, used only when no App is configured. For local development. */
  GITHUB_TOKEN?: string;
}
