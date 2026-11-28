/**
 * The connectors this deployment runs, and the only place the rest of the code reaches them.
 *
 * The Brain never talks to an outside system directly. It reads events and writes outbox rows;
 * connectors do the rest. Which connectors exist is decided in `src/agent.config.ts`; what a
 * connector is, in `./types`.
 */
import config from "../agent.config";
import { TOOLS } from "../brain/tools";
import type { Env } from "../env";
import type { InboundEvent, Principal, Scope, Target } from "../events";
import type { ApprovalQuestion, Connector, ConnectorTool, Holds, OutboundMessage, Outcome, Picture, PictureRef, Quoted, Receipt, Shows, Standing } from "./types";
import { DeliveryVoid } from "./types";

export type * from "./types";
export { DeliveryDeferred, DeliveryRejected, DeliveryVoid, isSettled, isWaiting, markOf } from "./types";

const RESERVED = new Set(["admin", "worker", "timer", "system"]);
const byName = new Map<string, Connector>();
const toolNames = new Set<string>();
for (const connector of config.connectors) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(connector.name) || RESERVED.has(connector.name)) throw new Error(`"${connector.name}" cannot be a connector's name`);
  if (byName.has(connector.name)) throw new Error(`two connectors are named "${connector.name}"`);
  for (const tool of connector.tools ?? []) {
    if (toolNames.has(tool.name) || TOOLS.some((own) => own.name === tool.name)) throw new Error(`two tools are named "${tool.name}"`);
    toolNames.add(tool.name);
    if (tool.effect !== "read" && tool.effect !== "act") throw new Error(`tool "${tool.name}" must declare what it does: read or act`);
    if (!tool.name.startsWith(`${connector.name.replace(/-/g, "_")}_`) || !/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) throw new Error(`tool "${tool.name}" must be named ${connector.name}_…`);
  }
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

/** Whether an event that waits is still to be taken up, as its connector says now (see Connector.wanted). */
export function wanted(env: Env, source: string, kind: string): boolean {
  return byName.get(source)?.wanted?.(env, { kind }) ?? true;
}

/**
 * Whether whoever wrote a message that came through a connector may write to a repository (see
 * Connector.writes): said by that connector, or by one plugged into it. Nothing where none of
 * them has such a word to say.
 */
export function writes(env: Env, source: string, scope: Scope, by: { person: string; data: Record<string, unknown> }, repo: string): Promise<"yes" | "no" | "unconnected" | "unknown"> | undefined {
  const saying = [byName.get(source), ...serving(source)].find((each) => each?.writes);
  return saying?.writes?.(env, source, scope, by, repo);
}

/** Whether it can be asked, of messages that come through a connector, if their authors may write to a repository. */
export function saysWhoWrites(source: string): boolean {
  return [byName.get(source), ...serving(source)].some((each) => each?.writes !== undefined);
}

/** The tools a connector offers, if any. Whether they are offered in a given run is the Brain's decision. */
export function toolsOf(name: string): ConnectorTool[] {
  return [...(byName.get(name)?.tools ?? []), ...serving(name).flatMap((each) => each.tools ?? [])];
}

/** The connectors that plug into this one: their tools are for its people too. */
function serving(name: string): Connector[] {
  return connectors.filter((each) => each.name !== name && (each.serves ?? []).includes(name));
}

/** Which optional tools of the connectors plugged into an event's source are for whoever caused it. None where one of them cannot say. */
export async function offeredFor(env: Env, event: InboundEvent): Promise<string[]> {
  const names: string[] = [];
  for (const each of serving(event.source)) {
    const own = new Set((each.tools ?? []).filter((tool) => tool.optional).map((tool) => tool.name));
    if (own.size === 0 || !each.offers) continue;
    try {
      names.push(...(await each.offers(env, event)).filter((name) => own.has(name)));
    } catch {
      // Not known: not offered.
    }
  }
  return names;
}

/** Sends one message. Throwing means "not delivered, try again later". */
export async function deliver(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<Receipt | void> {
  const channel = byName.get(target.connector)?.channel;
  if (!channel) throw new Error(`no connector named "${target.connector}" delivers messages`);
  // What is to be shown may be a plugged-in connector's to say: asked now, as it is sent.
  // One that can no longer be used is not sent at all.
  if (message.interaction) {
    for (const each of serving(target.connector)) {
      const invitation = await each.invitation?.(env, message.interaction);
      if (invitation === null) throw new DeliveryVoid("the invitation can no longer be used");
      if (invitation) return channel.deliver(env, scope, target, { ...message, invitation });
    }
  }
  return channel.deliver(env, scope, target, message);
}

/**
 * Shows a delivered invitation as over, where the connector can, unless whoever made it says it
 * can still be used: then it stays as it is, and resolves to false.
 */
export async function closeInvitation(env: Env, target: Target, receipt: Receipt, interaction: string, how: "used" | "over"): Promise<boolean> {
  const channel = byName.get(target.connector)?.channel;
  if (!channel?.closeInvitation) return false;
  for (const each of serving(target.connector)) {
    const invitation = await each.invitation?.(env, interaction);
    if (invitation) return false;
    if (invitation === null) return (await channel.closeInvitation(env, target, receipt, interaction, how), true);
  }
  return channel.closeInvitation(env, target, receipt, interaction, how);
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

/** Whether a condition a connector's tool named holds now, asked of that connector. Throws if it cannot be asked. */
export async function holds(env: Env, name: string, scope: Scope, condition: string, generation: number): Promise<Holds> {
  // A connector that plugs into this one is asked first: it answers only for conditions of its own.
  for (const each of serving(name)) {
    const answer = await each.holds?.(env, scope, condition, generation);
    if (answer) return answer;
  }
  const ask = byName.get(name)?.holds;
  if (!ask) throw new Error(`connector "${name}" cannot say whether a condition holds`);
  const answer = await ask(env, scope, condition, generation);
  if (!answer) throw new Error(`no connector says whether that condition holds`);
  return answer;
}

/** For how long this connector's system drops a repeated message, if it says. */
export function dedupeWindow(target: Target): number | undefined {
  const window = byName.get(target.connector)?.channel?.dedupeMs;
  return typeof window === "function" ? window(target) : window;
}

/** Shows a person that their message has arrived, where the connector can. Never throws; the mark it put on, only if the outside system confirmed it. */
export async function received(env: Env, name: string, scope: Scope, event: { source_id: string; data?: Record<string, unknown>; reply_to?: Target; wanted(): boolean }): Promise<string | undefined> {
  const show = byName.get(name)?.channel?.received;
  if (!show) return undefined;
  return show(env, scope, event).catch(() => undefined);
}

/** Where a person is reached directly through a connector, from a verified origin. Undefined where they cannot be. */
export function direct(name: string, origin: Record<string, string>, person: string): Target | undefined {
  try {
    return byName.get(name)?.channel?.direct?.(origin, person);
  } catch {
    return undefined;
  }
}

/** What a message sent to this address comes to there, where its connector says. Only its two answers, as plain yes or no. */
export function shows(scope: Scope, target: Target): Shows | undefined {
  try {
    const said = byName.get(target.connector)?.channel?.shows?.(scope, target);
    return said ? { markdown: said.markdown === true, reminds: said.reminds === true } : undefined;
  } catch {
    return undefined;
  }
}

/** An address in the same conversation at which only this person sees what is sent, where the connector has one. */
export function aside(name: string, origin: Record<string, string>, person: string, from: Target): Target | undefined {
  try {
    return byName.get(name)?.channel?.aside?.(origin, person, from);
  } catch {
    return undefined;
  }
}

/** The message something sent to this address is written under, where the connector says. */
export function under(target: Target): string | undefined {
  try {
    return byName.get(target.connector)?.channel?.under?.(target);
  } catch {
    return undefined;
  }
}

/** The message one was written in reply to, where the connector can fetch it. Never throws; undefined where it does not apply. */
export async function quoted(env: Env, name: string, scope: Scope, event: { principal: Principal; data?: Record<string, unknown>; signal?: AbortSignal }): Promise<Quoted | undefined> {
  const ask = byName.get(name)?.channel?.quoted;
  if (!ask) return undefined;
  return ask(env, scope, event).catch(() => ({}));
}

/** The pictures named, fetched through the connector they came by: null for each that cannot be had. Never throws. */
export async function pictures(env: Env, name: string, scope: Scope, event: { data?: Record<string, unknown> }, refs: PictureRef[]): Promise<(Picture | null)[]> {
  const fetchThem = byName.get(name)?.channel?.pictures;
  const none = refs.map(() => null);
  if (!fetchThem) return none;
  const got = await fetchThem(env, scope, event, refs).catch(() => none);
  return got.length === refs.length ? got : none;
}

/** Takes off a mark `received` put on. Never throws. */
export async function unreceived(env: Env, name: string, scope: Scope, event: { data?: Record<string, unknown>; reply_to?: Target }, mark: string): Promise<"removed" | "retry" | "permanent"> {
  const take = byName.get(name)?.channel?.unreceived;
  if (!take) return "permanent";
  return take(env, scope, event, mark).catch(() => "retry" as const);
}
