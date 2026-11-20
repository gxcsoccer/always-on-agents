/**
 * The connectors this deployment runs, and the only place the rest of the code reaches them.
 *
 * The Brain never talks to an outside system directly. It reads events and writes outbox rows;
 * connectors do the rest. Which connectors exist is decided in `src/agent.config.ts`; what a
 * connector is, in `./types`.
 */
import config from "../agent.config";
import type { Env } from "../env";
import type { Scope, Target } from "../events";
import type { ApprovalQuestion, Connector, OutboundMessage, Outcome, Receipt, Standing } from "./types";

export type * from "./types";

const RESERVED = new Set(["admin", "worker", "timer", "system"]);
const byName = new Map<string, Connector>();
for (const connector of config.connectors) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(connector.name) || RESERVED.has(connector.name)) throw new Error(`"${connector.name}" cannot be a connector's name`);
  if (byName.has(connector.name)) throw new Error(`two connectors are named "${connector.name}"`);
  byName.set(connector.name, connector);
}
for (const name of config.trusted) if (!byName.has(name)) throw new Error(`trusted connector "${name}" is not one of the connectors`);
const trusted = new Set<string>(config.trusted);

export const connectors: readonly Connector[] = [...byName.values()];

export function connector(name: string): Connector | undefined {
  return byName.get(name);
}

/**
 * Whether what this source says about who spoke is believed when it matters: for approvals, for
 * crediting a request to a person, for changes to standing instructions. Decided by the deployment,
 * never by the connector itself.
 */
export function trusts(source: string): boolean {
  return trusted.has(source);
}

/** Sends one message. Throwing means "not delivered, try again later". */
export async function deliver(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<Receipt | void> {
  const channel = byName.get(target.connector)?.channel;
  if (!channel) throw new Error(`no connector named "${target.connector}" delivers messages`);
  return channel.deliver(env, scope, target, message);
}

/** Shows a delivered approval question as closed, where the connector can. */
export async function amend(env: Env, target: Target, receipt: Receipt, ask: ApprovalQuestion, outcome: Outcome): Promise<void> {
  await byName.get(target.connector)?.channel?.amend?.(env, target, receipt, ask, outcome);
}

/** Whether messages from this connector can be asked about again after the fact. */
export function canRevisit(name: string): boolean {
  return byName.get(name)?.channel?.standing !== undefined;
}

/** What a revisable message says at its source now. Throws if the source cannot be asked. */
export async function standingOf(env: Env, name: string, scope: Scope, subject: string): Promise<Standing | undefined> {
  return byName.get(name)?.channel?.standing?.(env, scope, subject);
}
