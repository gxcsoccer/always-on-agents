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
  /**
   * Set where the connector knows the account as this person only because they connected it
   * themselves (authorised as it, in their own conversation), not because an operator linked it.
   * Their word counts where they speak; what takes more than that (changing what the agent is
   * told to do for everyone there from now on) is not theirs on that strength alone.
   */
  self_connected?: true;
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
  /**
   * For a notification of which only the latest state means anything (a pull request was pushed
   * to again, say): the connector names what it is the state of (`key`) and when that state was
   * so (`at`, by the source's own clock). As such an event is taken in, earlier ones under the
   * same key that nobody has taken up yet are dropped; one that arrives after a later one under
   * its key is itself dropped. `void`: this one only ends the others (the pull request was
   * closed): it is kept so that it is not taken in twice, and nothing is done about it. Only
   * events that carry the same key are touched: never what a person wrote, nor anything else.
   */
  supersedes?: { key: string; at: number; void?: true };
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

/**
 * One message further up the chain of replies a message stands in, as kept with that message
 * (`data.chain`): its name; where it had to be fetched, the person's own words and what they
 * link, or that it is not theirs. A last entry `cut` says the chain goes on but was not followed.
 */
export type ChainLevel = { subject?: string; text?: string; documents?: unknown[]; hidden?: true; cut?: true };

/**
 * What stands above the message a message replies to, nearest first. Read the same way by
 * everything that goes by it. A message kept before the whole chain was followed has one such
 * level at most: what its fetched parent, the person's own, was written in reply to.
 */
export function chainLevels(data: Record<string, unknown> | undefined): ChainLevel[] {
  if (Array.isArray(data?.chain)) return (data.chain as unknown[]).filter((each): each is ChainLevel => typeof each === "object" && each !== null);
  const quoted = data?.quoted as { text?: unknown; replies_to?: unknown } | undefined;
  return typeof quoted?.text === "string" && typeof quoted.replies_to === "string" ? [{ subject: quoted.replies_to }] : [];
}
