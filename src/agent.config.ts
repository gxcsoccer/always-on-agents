/**
 * What this deployment is made of. To add a connector, write one (see `src/connectors/types.ts`
 * and docs/connectors.md) and list it here. The same for a worker (`src/workers/types.ts`).
 */
import { consoleConnector } from "./connectors/console";
import { doubaoConnector, doubaoWorker } from "./connectors/doubao";
import { feishuConnector } from "./connectors/feishu";
import { githubConnector } from "./connectors/github";
import type { Connector } from "./connectors/types";
import { sandboxWorker } from "./workers/sandbox/worker";
import type { Worker } from "./workers/types";

const config: { connectors: Connector[]; workers: Worker[]; trusted: string[] } = {
  connectors: [consoleConnector, githubConnector, feishuConnector, doubaoConnector],
  /**
   * Where the agent can hand work to (see `src/workers/types.ts`). Taking one out stops new work
   * going to it; what it was already doing can still report, be answered and be stopped.
   */
  workers: [sandboxWorker, doubaoWorker],
  /**
   * The connectors whose account of who said something is believed: only through these can a
   * person approve an action, be credited with a request, or change the agent's standing
   * instructions. Any other connector's events inform the agent and decide nothing. List a
   * connector here only if it proves where each event came from and who caused it.
   */
  trusted: ["console", "github", "feishu"],
};

export default config;
