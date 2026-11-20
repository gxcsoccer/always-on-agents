/**
 * What a connector is.
 *
 * A connector joins the agent to one outside system. It is a plain object listed in
 * `src/agent.config.ts`; everything the rest of the code knows about an outside system it learns
 * through this interface. A connector contributes any of these, each on its own:
 *
 *   - `http`:      requests under /v1/<name>/…, such as the system's webhooks
 *   - `admin`:     the operator's requests for setting it up
 *   - `scheduled`: work to do every minute, such as keeping a connection open
 *   - `channel`:   delivering the agent's messages to a conversation in that system
 *   - `tools`:     things the agent can do in that system on one person's behalf
 *
 * A connector that only reports events (a CI notifier, say) has `http` and nothing else.
 *
 * What a connector may not decide. It says who caused an event; whether that person's word counts
 * is decided by the Brain, and only for connectors the deployment lists as trusted (see
 * `agent.config.ts`). A connector outside that list can inform the agent and nothing more.
 *
 * What this interface does not do. Connectors are first-party code compiled into the Worker: each
 * one is handed the whole environment and writes its own name on the events it hands over. The
 * trusted list therefore guards against a connector being relied on by oversight, not against one
 * that misstates where its events came from. Review a connector as you would any code that holds
 * the deployment's secrets.
 */
import type { Env } from "../env";
import type { Scope, Target } from "../events";

export interface Connector {
  /** Lowercase; also the first path segment of its routes and the `source` of its events. */
  name: string;
  /** Handles a request under /v1/<name>/. `path` is what follows the name. */
  http?(request: Request, env: Env, path: string[], ingress: Ingress): Promise<Response>;
  /** Handles an admin request it owns, already authenticated. Returns undefined for any other. */
  admin?(request: AdminRequest, env: Env): Promise<Response | undefined>;
  /** Called every minute. */
  scheduled?(env: Env): Promise<void>;
  channel?: Channel;
  /** Named `<connector name>_…`. See ConnectorTool for when they are offered. */
  tools?: ConnectorTool[];
}

/**
 * Something the agent can do in an outside system for one person, as that person.
 *
 * A connector's tools are offered only where it is beyond doubt whose authority a call carries:
 * in a person's own private conversation, in a run started by nothing but that person's own
 * messages, all of which arrived through this connector with the same verified origin. The Brain
 * decides this; the model cannot choose whom a tool acts for, and neither can the tool's
 * arguments.
 *
 * What a tool returns comes from outside and may be written by anyone, and what the model goes on
 * to say carries it. The Brain treats it so: from the first such call on, the run can only reply
 * to the person and read again; and when the run ends everything it produced is removed from the
 * conversation's record, leaving a note that something was read.
 *
 * A tool call may be repeated after an interruption, so a tool must be safe to run twice.
 */
export interface ConnectorTool {
  name: string;
  description: string;
  /**
   * What the tool does to the outside system. Only "read" exists: a tool that looks and changes
   * nothing. Once a run has read outside text, reading again is the only thing a connector's tool
   * may still do in it.
   */
  effect: "read";
  /** JSON Schema properties. Every one is required; use a nullable type for an optional value. */
  parameters: Record<string, unknown>;
  run(context: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

export interface ToolContext {
  env: Env;
  scope: Scope;
  /** The one person this run acts for, as the connector identified them. */
  person: string;
  /** What the connector verified about where that person's messages came from. */
  origin: Record<string, string>;
  /** Names this call; the same on a repeat. */
  callId: string;
}

export interface Ingress {
  /** Keeps the invocation alive for work that continues after the response. */
  defer(work: Promise<unknown>): void;
}

export interface AdminRequest {
  method: string;
  /** The path after /v1/admin/. */
  path: string[];
  url: URL;
  /** The JSON body, or {} when there is none. */
  body(): Promise<Record<string, any>>;
}

export interface Channel {
  /**
   * Sends one message. Throwing means "not delivered, try again later"; it must be safe to repeat
   * (see `idem`). A channel with `standing` must return a Receipt for an approval question: a
   * question posted where it can be changed, and not identifiable there, cannot be approved.
   */
  deliver(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<Receipt | void>;
  /**
   * Marks a delivered approval question as closed where it is shown, if the system can: the
   * question stops inviting an answer and says how it ended. Best effort; nothing depends on it.
   */
  amend?(env: Env, target: Target, receipt: Receipt, ask: ApprovalQuestion, outcome: Outcome): Promise<void>;
  /**
   * Required of a system where what was said can be changed afterwards (edited or deleted). Says
   * what a message says now, so that an approval is never acted on unseen. Such a connector gives
   * its events a `subject`, a `revision` and a `holder`; this is asked about that subject before
   * any approval read from it counts. It throws if the system cannot be asked. Returns undefined
   * only for a subject that is not this connector's in this scope.
   *
   * A connector whose events carry a subject but which has no `standing` cannot carry approvals:
   * the Brain refuses them.
   */
  standing?(env: Env, scope: Scope, subject: string): Promise<Standing | undefined>;
}

/**
 * Thrown by `deliver` when the outside system said not to try again before a certain time. The
 * message is retried as after any failure, but no sooner than that.
 */
export class DeliveryDeferred extends Error {
  constructor(
    message: string,
    /** In ms since the epoch. */
    readonly notBefore: number,
  ) {
    super(message);
    this.name = "DeliveryDeferred";
  }
}

/** Where a revisable message stands at its source right now. */
export type Standing = { revision: number; holder: string; deleted: boolean; edited: boolean };

export interface OutboundMessage {
  id: number;
  /** Stable across retries, so a connector can avoid sending the same message twice. */
  idem: string;
  text: string;
  /** When the message was written, in ms. */
  created_at?: number;
  /**
   * Set when the message is an approval question. `text` says the same in words; a connector that
   * can show something better than text (buttons, say) builds it from this.
   */
  ask?: ApprovalQuestion;
  /**
   * Set when the message is a code review. `text` says the same in words (the summary, then each
   * comment with its file and line); a connector that can attach comments to lines builds them
   * from this.
   */
  review?: CodeReview;
}

export interface CodeReview {
  summary: string;
  /** The commit that was reviewed, if known. Lines are only meaningful against it. */
  commit?: string;
  comments: { path: string; line: number; body: string }[];
}

export interface ApprovalQuestion {
  /** Names this one question for good, across scopes. A code is unique only within its scope. */
  id: string;
  code: string;
  /** The task's title. */
  title: string;
  kind: "command" | "push";
  /** The command, or what would be pushed where. Shown literally. */
  detail: string;
  /** False when the action is too long to show in full: it can then only be refused. */
  can_approve: boolean;
  /** For a push: where to, and which refs would move from which commit to which. */
  resource?: string;
  refs?: { ref: string; old: string; new: string }[];
  /** Whether the person may also approve the same kind of action for the rest of the task. */
  standing_offered?: boolean;
}

/**
 * Where a delivered message now lives, if it is somewhere other people can change it: the subject
 * names it and the holder is the fingerprint of the text as it was posted.
 */
export interface Receipt {
  subject: string;
  holder: string;
  /** When it was actually posted, if that was on an earlier attempt than the one that confirmed it. */
  posted_at?: number;
}

/** How an approval question ended. */
export type Outcome =
  | { state: "approved" | "refused"; by?: string; standing?: boolean }
  | { state: "withdrawn" }
  /** An answer was sent and it can no longer be found out whether it took effect. */
  | { state: "unknown" };
