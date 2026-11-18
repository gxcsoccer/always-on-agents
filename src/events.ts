/**
 * The vocabulary shared by connectors, the Brain and workers.
 *
 * A scope is the unit that owns an inbox, a memory and an outbox: one user, one group chat, or one
 * repository. Each scope is one Durable Object, so nothing is shared between scopes except by
 * posting an event to another scope's inbox.
 */

export type ScopeKind = "user" | "chat" | "repo";

export interface Scope {
  tenant: string;
  kind: ScopeKind;
  id: string;
}

const PART = /^[A-Za-z0-9._\-/]{1,128}$/;

export function scopeName(scope: Scope): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(scope.tenant)) throw new Error("invalid tenant id");
  if (!PART.test(scope.id)) throw new Error("invalid scope id");
  return `${scope.tenant}:${scope.kind}:${scope.id}`;
}

export function parseScope(name: string): Scope {
  const [tenant, kind, ...rest] = name.split(":");
  if (!tenant || (kind !== "user" && kind !== "chat" && kind !== "repo") || rest.length === 0) {
    throw new Error(`invalid scope name: ${name}`);
  }
  return { tenant, kind, id: rest.join(":") };
}

/** Who caused an event. Authorization decisions are made on this, never on message text. */
export interface Principal {
  kind: "human" | "automation" | "worker" | "timer";
  /** Stable id within the tenant, e.g. a user id or "github:octocat". */
  id: string;
  display?: string;
  /**
   * True when a person deliberately addressed the agent: a direct message, an @-mention, a slash
   * command. False for things that merely happened, such as a CI run or a push.
   */
  explicit: boolean;
}

/** Where a reply should go. Interpreted by the connector named in it. */
export interface Target {
  connector: string;
  address: Record<string, string>;
}

export interface InboundEvent {
  /** Connector or subsystem that produced the event. Part of the dedupe key. */
  source: string;
  /** The source's own unique id for this event. Part of the dedupe key. */
  source_id: string;
  /** e.g. "message", "github.pull_request", "timer", "worker.result". */
  kind: string;
  /** Events with the same key continue the same conversation. */
  session_key: string;
  principal: Principal;
  text?: string;
  data?: Record<string, unknown>;
  reply_to?: Target;
}

/** Events a worker sends back to the Brain that started it. */
export type WorkerEventKind = "progress" | "needs_input" | "result" | "failed" | "lost" | "recovered";
