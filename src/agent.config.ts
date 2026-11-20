/**
 * What this deployment is made of. To add a connector, write one (see `src/connectors/types.ts`
 * and docs/connectors.md) and list it here.
 */
import { consoleConnector } from "./connectors/console";
import { feishuConnector } from "./connectors/feishu";
import { githubConnector } from "./connectors/github";
import type { Connector } from "./connectors/types";

const config: { connectors: Connector[]; trusted: string[] } = {
  connectors: [consoleConnector, githubConnector, feishuConnector],
  /**
   * The connectors whose account of who said something is believed: only through these can a
   * person approve an action, be credited with a request, or change the agent's standing
   * instructions. Any other connector's events inform the agent and decide nothing. List a
   * connector here only if it proves where each event came from and who caused it.
   */
  trusted: ["console", "github", "feishu"],
};

export default config;
