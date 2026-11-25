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
import guidance from "./workers.md";

const config: { connectors: Connector[]; workers: Worker[]; retired?: Worker[]; first_worker?: string; guidance: string; trusted: string[] } = {
  connectors: [consoleConnector, githubConnector, feishuConnector, doubaoConnector],
  /**
   * Where the agent can hand work to (see `src/workers/types.ts`). Taking one out stops new work
   * going to it. To have what it was already doing still report, be answered and be stopped,
   * move it to `retired` rather than deleting it, and take it out of there once none of its work
   * is left.
   */
  workers: [sandboxWorker, doubaoWorker],
  /** Workers no longer offered for new work, whose work under way is still carried through. */
  retired: [],
  /**
   * The worker that the one tool for handing work over was for before there were several
   * (`dispatch_task`). Calls of that tool made back then can still be made again after an
   * interruption; they go to this worker, while it is offered, and are refused otherwise.
   */
  first_worker: "sandbox",
  /**
   * Which worker a piece of work goes to: guidance for the agent, in words (`src/workers.md`).
   * It is the deployment's to write; nobody in a conversation can change it. Each worker says
   * what it is in its own description; this says how to choose between them here.
   */
  guidance,
  /**
   * The connectors whose account of who said something is believed: only through these can a
   * person approve an action, be credited with a request, or change the agent's standing
   * instructions. Any other connector's events inform the agent and decide nothing. List a
   * connector here only if it proves where each event came from and who caused it.
   */
  trusted: ["console", "github", "feishu"],
};

export default config;
