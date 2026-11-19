/**
 * Connectors: one per external system. A connector owns three things for its system:
 *   - inbound:  verify a request really came from the system, and turn it into an inbox event
 *   - identity: say who caused the event and whether they were deliberately addressing the agent
 *   - outbound: deliver a message to an address in that system
 *
 * The Brain never talks to an external system directly. It reads events and writes outbox rows;
 * connectors do the rest.
 */
import type { Env } from "../env";
import type { Scope, Target } from "../events";
import { amendFeishu, deliverFeishu } from "./feishu";
import { deliverGithub } from "./github";

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
}

export interface ApprovalQuestion {
  /** Names this one question for good. Codes are short and come round again; this does not. */
  id: string;
  code: string;
  /** The task's title. */
  title: string;
  kind: "command" | "push";
  /** The command, or what would be pushed where. Shown literally. */
  detail: string;
  /** False when the action is too long to show in full: it can then only be refused. */
  can_approve: boolean;
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
export type Outcome = { state: "approved" | "refused"; by?: string } | { state: "withdrawn" };

/**
 * Marks a delivered approval question as closed where it is shown, if the connector can: the
 * question stops inviting an answer and says how it ended. Best effort; nothing depends on it.
 */
export async function amend(env: Env, target: Target, receipt: Receipt, ask: ApprovalQuestion, outcome: Outcome): Promise<void> {
  if (target.connector === "feishu") await amendFeishu(env, target, receipt, ask, outcome);
}

/** Sends one message. Throwing means "not delivered, try again later". */
export async function deliver(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<Receipt | void> {
  switch (target.connector) {
    case "console":
      // Pull-based: the client reads the outbox through the API, so writing the row was the delivery.
      return;
    case "github":
      return deliverGithub(env, scope, target, message);
    case "feishu":
      return deliverFeishu(env, scope, target, message);
    default:
      throw new Error(`no connector named "${target.connector}"`);
  }
}
