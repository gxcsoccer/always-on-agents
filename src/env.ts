import type { BrainAgent } from "./brain/agent";
import type { Registry } from "./registry";
import type { DoubaoGrant } from "./connectors/doubao";
import type { GithubGrant } from "./connectors/github-grant";
import type { FeishuGrant } from "./connectors/feishu-grant";
import type { FeishuLink } from "./connectors/feishu-link";
import type { TaskSandbox } from "./workers/sandbox/task";

export interface Env {
  BRAIN: DurableObjectNamespace<BrainAgent>;
  TASKS: DurableObjectNamespace<TaskSandbox>;
  REGISTRY: DurableObjectNamespace<Registry>;
  FEISHU_LINKS: DurableObjectNamespace<FeishuLink>;
  /** Which version of the Worker this code is, where the platform says: see wrangler.jsonc. */
  VERSION?: { id: string };
  FEISHU_GRANTS: DurableObjectNamespace<FeishuGrant>;
  DOUBAO_GRANTS: DurableObjectNamespace<DoubaoGrant>;
  GITHUB_GRANTS: DurableObjectNamespace<GithubGrant>;
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
  /** The same App's client id and secret: for acting as a person who authorised it (see connectors/github-grant.ts). */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** The agent's account name on GitHub (an App's bot is `<app-slug>`), used to recognise mentions. */
  GITHUB_BOT_HANDLE?: string;
  /** "on": a pull request that is opened or pushed to is brought before the agent by itself. Anything else: only when someone asks it there. */
  GITHUB_AUTO_REVIEW?: string;
  /** The address commits are made under; for an App, `<bot user id>+<app-slug>[bot]@users.noreply.github.com`. */
  GITHUB_BOT_EMAIL?: string;
  /** Optional: a regular expression for shell commands inside the sandbox that a person must approve. Default: none. */
  GATE_HOLD_PATTERN?: string;
  /**
   * Where this deployment is reached from outside, such as https://agent.example.com. Needed for
   * anything that sends a person's browser back here, such as authorising access to their documents.
   */
  PUBLIC_ORIGIN?: string;
  /** Seals the tokens people's authorisations produce. At least 32 characters; keep it out of storage. */
  GRANTS_KEY?: string;
  /** A single deployment-wide token, used only when no App is configured. For local development. */
  GITHUB_TOKEN?: string;
}
