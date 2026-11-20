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
  /**
   * True when the connector identified an account in its own system but that account is not linked
   * to a user of the tenant. Such a person is known by name and is not a member of any scope.
   */
  unlinked?: boolean;
}

/**
 * For a connector whose messages can be edited: the `holder` it reports for a revision whose text
 * is no longer a message to the agent. It voids the earlier text, and no new message follows it.
 */
export const NOT_FOR_THE_AGENT = "-";

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
  /**
   * Free for the connector, with a few fields the Brain reads. One of them is `where`: a few words
   * on where the event happened ("pull request #3 of owner/name"), from what the connector verified,
   * shown to the model beside the event's text. Another is `origin`: what the connector verified
   * about where the event came from (which app, which organisation), as strings. A connector's
   * tools are offered only when every message in a run has the same origin. And `direct`: true
   * for an ordinary message a person wrote to the agent in private, as opposed to a button they
   * pressed or a reply that was routed from elsewhere.
   */
  data?: Record<string, unknown>;
  reply_to?: Target;
}

/**
 * The name of a person's private conversation through one connector, from one verified origin.
 *
 * A person's scope can be reached in more than one way: the same user id may be spoken for by a
 * tenant's backend through the console and by the person themselves in a chat product. Those are
 * different audiences and must not share a history. A connector that offers tools gives its
 * direct, private messages this key, and the Brain offers the tools in no other conversation, so
 * what is read for a person stays where only that person, through that origin, takes part.
 */
export function privateSessionKey(connector: string, origin: Record<string, string>): string {
  // The origin is written out as data, in key order, so that no choice of keys or values can make
  // two different origins read the same.
  return `private:${connector}:${JSON.stringify(Object.keys(origin).sort().map((key) => [key, origin[key]]))}`;
}

/** Whether a conversation is someone's private one through a connector (see privateSessionKey). */
export function isPrivateSession(sessionKey: string): boolean {
  return sessionKey.startsWith("private:");
}

/** Events a worker sends back to the Brain that started it. */
export type WorkerEventKind = "progress" | "needs_input" | "withdrawn" | "result" | "failed" | "lost" | "recovered";
