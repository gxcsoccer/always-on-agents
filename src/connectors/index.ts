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
import { deliverFeishu } from "./feishu";
import { deliverGithub } from "./github";

export interface OutboundMessage {
  id: number;
  /** Stable across retries, so a connector can avoid sending the same message twice. */
  idem: string;
  text: string;
  /** When the message was written, in ms. */
  created_at?: number;
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
