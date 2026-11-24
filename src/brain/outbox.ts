/**
 * The outbox: messages to deliver, retried independently of the run that wrote them.
 *
 * A message is kept first and delivered afterwards, strictly in order. It ends as sent, as not
 * sent at all (void, withdrawn), as given up (dead), or as one that may have arrived without our
 * hearing so (unverified). The Brain builds this part on its own database; what it needs from the
 * rest of the Brain it is handed (OutboxHost).
 */
import { type ApprovalQuestion, type CodeReview, DeliveryDeferred, DeliveryRejected, DeliveryVoid, type OutboundMessage, type Receipt, dedupeWindow } from "../connectors";
import { type Target, isPrivateSession } from "../events";
import type { Continuation, Requests } from "./requests";
import type { BrainStore, Row, Wakes } from "./store";

const OUTBOX_RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 300_000, 900_000];
/**
 * The longest an outside system's request to wait is waited out. The queue delivers in order, so a
 * message that waits holds back those behind it; one asked to wait longer than this is given up
 * as undeliverable rather than sent early or held indefinitely.
 */
const MAX_DEFERRAL_MS = 24 * 60 * 60_000;
const DELIVERY_WITHHELD = "delivery failed; the details are not kept";
/** How long a message that must not go out yet is left before it is looked at again. */
const HELD_MS = 3_000;
/** The same, when what it waits on will not change within this wake-up. */
const HELD_LONG_MS = 60_000;
/**
 * What the system itself says to a person about a request of theirs, in fixed words. Said in the
 * language they last wrote in here, as far as that can be told without a model: Chinese if their
 * latest message has Chinese characters in it, English otherwise.
 */
export type NoticeKey = keyof typeof NOTICES;
const NOTICES = {
  withheld: { en: "I stopped before finishing: the authorisation for what I was reading has ended. Please ask again.", zh: "我在完成之前停下了：读取所依据的授权已经结束。请再问一次。" },
  retired: { en: "I stopped before finishing: this rested on an earlier answer of mine that is no longer kept. Please ask again.", zh: "我在完成之前停下了：这件事依据的是我之前的一份答复，那份答复已经不再保存。请再问一次。" },
  notSent: { en: "I did not send what I had written for you: the authorisation for what I had read has ended, or too much time had passed. Please ask again.", zh: "我写好的内容没有发给你：读取所依据的授权已经结束，或者已经过了太久。请再问一次。" },
  notAnswered: { en: "I could not finish what you asked for earlier. Please ask again.", zh: "你之前让我做的事我没能完成，请再问一次。" },
  limit: { en: "I have reached today's usage limit here and could not finish what you asked for earlier. Please ask again tomorrow.", zh: "我今天的用量已经用完，没能完成你之前让我做的事。请明天再问一次。" },
  which: { en: "More than one of your requests could be meant. Which one?", zh: "你指的可能不止一件事，是哪一件？" },
  unchecked: { en: "I did not send what I had written for you: I could not confirm that the authorisation for what I had read still stands. Please ask again.", zh: "我写好的内容没有发给你：我没能确认读取所依据的授权是否仍然有效。请再问一次。" },
  invite: { en: "I need you to authorise this before I can go on.", zh: "需要你先授权，我才能继续。" },
  invitedElsewhere: { en: "I need you to authorise this before I can go on. I have sent you how in a direct message.", zh: "需要你先授权，我才能继续。授权卡片已私聊发你。" },
  inviteNotSent: { en: "I need you to authorise this before I can go on, but I could not reach you in a direct message. Message me directly and ask again.", zh: "需要你先授权，我才能继续，但授权卡片没能私聊发给你。请私聊我再问一次。" },
  inviteUnknown: { en: "I need you to authorise this before I can go on. I cannot tell whether what I sent you in a direct message arrived; please look there first.", zh: "需要你先授权，我才能继续。我无法确认授权卡片是否送达，请先看看和我的私聊。" },
  tomorrow: { en: "I have reached today's usage limit here and will pick this up tomorrow.", zh: "我今天的用量已经用完，明天接着处理。" },
  failed: { en: "Something went wrong on my side and I could not finish handling that. Please try again.", zh: "我这边出了问题，没能处理完。请再试一次。" },
} as const;
/** How often a way in is tried before it is given up. */
const MAX_INVITE_ATTEMPTS = 3;
/** How often a message whose condition's owner cannot be asked is put off before it is given up. */
const MAX_UNASKED = 8;

/** What the outbox needs from the Brain it is part of. */
export interface OutboxHost {
  /** Hands a message to the channel it is addressed to. Throws as a connector's `deliver` does. */
  deliver(target: Target, message: OutboundMessage): Promise<Receipt | void>;
  /** Whether this run has been given text from outside by a connector's tool. */
  sawOutside(runId: string): boolean;
  /** Replaces a delivered question by its closed form. Never holds anything up. */
  showClosed(ask: string): void;
  /** Requests that wait: whether a message may go out, and how the request it answers ended. */
  readonly requests: Pick<Requests, "stampGuards" | "gate" | "endRequest" | "sessionKeyOf" | "readsOf" | "shown">;
}

export class Outbox implements Wakes {
  readonly #s: BrainStore;
  readonly #b: OutboxHost;

  constructor(store: BrainStore, host: OutboxHost) {
    this.#s = store;
    this.#b = host;
  }

  /** When the queue's oldest message is due, or a closed question is next looked for. */
  nextWakeAt(_now: number): number | null {
    const candidates: number[] = [];
    const outbox = this.#s.rows<{ next_at: number }>("SELECT next_at FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0]?.next_at;
    if (outbox != null) candidates.push(outbox);
    const reconciling = this.#s.rows<{ next_at: number | null }>("SELECT MIN(next_at) AS next_at FROM outbox WHERE status = 'reconciling'")[0]?.next_at;
    if (reconciling != null) candidates.push(reconciling);
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  enqueue(idem: string, sessionId: string, runId: string | null, text: string, ask?: ApprovalQuestion, review?: CodeReview, bound?: { continuation?: Continuation; interaction?: string; target?: string; authored?: boolean }): { ok: true } {
    // The answer to a request that waited goes where the request came from, as it was then.
    const target = bound?.continuation?.target ?? bound?.target ?? this.#s.rows<Row>("SELECT target FROM sessions WHERE id = ?", sessionId)[0]?.target ?? this.#s.meta("default_target");
    if (!target) throw new Error("there is nowhere to send a message in this conversation");
    const now = Date.now();
    this.#s.sql.exec(
      "INSERT OR IGNORE INTO outbox (idem, run_id, target, text, next_at, created_at, ask, review, continuation, interaction, reads, authored) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      idem,
      runId,
      target,
      text,
      now,
      now,
      ask ? JSON.stringify(ask) : null,
      review ? JSON.stringify(review) : null,
      bound?.continuation?.id ?? null,
      bound?.interaction ?? null,
      // What the run had read by now: what these words can have been written from.
      runId ? JSON.stringify(this.#b.requests.readsOf(runId)) : null,
      bound?.authored ? 1 : 0,
    );
    if (runId && this.#b.sawOutside(runId)) this.#s.sql.exec("UPDATE outbox SET private = 1 WHERE idem = ?", idem);
    if (runId) this.#b.requests.stampGuards(runId);
    return { ok: true };
  }

  /** One of the system's fixed notices, in the language the person last wrote in in this conversation. */
  notice(which: keyof typeof NOTICES, sessionId: string): string {
    const last = this.#s.rows<{ text: string | null }>("SELECT text FROM inbox WHERE kind = 'message' AND text IS NOT NULL AND session_key = (SELECT session_key FROM sessions WHERE id = ?) ORDER BY id DESC LIMIT 1", sessionId)[0]?.text ?? "";
    return NOTICES[which][/[\u4e00-\u9fff]/.test(last) ? "zh" : "en"];
  }

  /** A message from the system rather than the model. Having nowhere to send it must never fail the caller. */
  notify(idem: string, sessionId: string, runId: string | null, text: string, continuation?: Continuation): void {
    try {
      this.enqueue(idem, sessionId, runId, text, undefined, undefined, continuation ? { continuation } : undefined);
    } catch {
      // Conversations started by automation (a CI run on a branch, say) can have no reply address.
    }
  }

  /** Delivers strictly in order: the oldest undelivered message goes first, even while it is backing off. */
  async flush(): Promise<void> {
    try {
      for (;;) {
        const row = this.#s.rows<Row>("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 1")[0];
        if (!row) return;
        // A closed question leaves the ordered queue at once, whatever back-off it is in, so it
        // never holds up the messages behind it. If no attempt to send it was ever begun, nobody
        // has seen it and it is simply not sent. If one was begun, it may have reached people
        // although we never heard so: it is set aside to be found and shown as closed (below).
        if (row.ask && row.closed) {
          this.#s.sql.exec("UPDATE outbox SET status = ?, error = NULL WHERE id = ? AND status = 'pending'", row.started ? "reconciling" : "withdrawn", row.id);
          continue;
        }
        if (row.next_at > Date.now()) {
          // Still backing off. A way in that nobody waits on any more is not waited for, though:
          // it is set aside now, so what follows is not held behind it. One that someone still
          // waits on keeps its time.
          if (!row.interaction || (await this.#b.requests.gate(row)) !== "void") return;
          this.#s.sql.exec("UPDATE outbox SET status = ?, text = '', error = NULL WHERE id = ? AND status = 'pending'", row.uncertain ? "unverified" : "void", row.id);
          continue;
        }
        // A message tied to a request, or one that shows something to act on, goes out only
        // while that still stands; this is looked at before every attempt, not only the first.
        const gate = await this.#b.requests.gate(row);
        // Its condition's owner could not be asked. Put off a bounded number of times, then
        // given up as one that may not go out: later messages are not held behind it for good.
        // Counted by themselves: they are not attempts to deliver, and a message whose owner
        // could be asked again has all of its delivery attempts left.
        const unasked = gate === "unasked" && row.unasked + 1 > MAX_UNASKED;
        if (gate === "unasked" && !unasked) {
          this.#s.sql.exec("UPDATE outbox SET unasked = unasked + 1, next_at = ? WHERE id = ? AND status = 'pending'", Date.now() + HELD_LONG_MS, row.id);
          return;
        }
        if (gate !== "unasked" && row.unasked) this.#s.sql.exec("UPDATE outbox SET unasked = 0 WHERE id = ?", row.id);
        if (gate === "hold" || gate === "wait") {
          this.#s.sql.exec("UPDATE outbox SET next_at = ? WHERE id = ? AND status = 'pending'", Date.now() + (gate === "hold" ? HELD_MS : HELD_LONG_MS), row.id);
          return;
        }
        // An earlier attempt whose outcome was never heard, in a system that would no longer
        // drop a repeat: it may have arrived, and a second copy could not be told from the first.
        const window = row.ask ? undefined : dedupeWindow((JSON.parse(row.target) as Target).connector);
        const stale = Boolean(row.uncertain) && window !== undefined && row.first_attempt_at != null && Date.now() - row.first_attempt_at >= window;
        if (gate === "void" || unasked || stale) {
          // Not sent (again). What it said is removed. If an attempt may have reached the person,
          // the record says so: it is not shown as never sent.
          const how = row.uncertain ? "unverified" : "void";
          this.#s.sql.exec("UPDATE outbox SET status = ?, text = '', review = NULL, error = NULL WHERE id = ? AND status = 'pending'", how, row.id);
          // Something written for the person that will now certainly not reach them, and not
          // because they called it off: they are told so, in fixed words, rather than left waiting.
          const calledOff = row.continuation ? this.#s.rows<{ status: string }>("SELECT status FROM continuations WHERE id = ?", row.continuation)[0]?.status === "cancelled" : false;
          const session = this.#s.rows<{ session_id: string }>("SELECT session_id FROM runs WHERE id = ?", row.run_id ?? "")[0]?.session_id;
          if (how === "void" && !calledOff && !row.interaction && session && (row.guard || row.continuation)) this.notify(`withheld:${row.run_id ?? row.idem}`, session, null, this.notice(unasked ? "unchecked" : "notSent", session));
          if (row.continuation) this.#b.requests.endRequest(row.continuation, how, how === "void" ? "it no longer stood when its answer was to be sent" : "its answer may have been delivered; that could not be verified");
          if (how === "unverified") this.#s.log("message_unverified", { outbox_id: row.id });
          continue;
        }
        if (await this.#attempt(row, "pending")) continue;
        // Not delivered. One that is still to be tried holds the queue; one that has left it
        // (nothing to send, or given up) does not keep the messages behind it waiting.
        if (this.#s.rows<{ status: string }>("SELECT status FROM outbox WHERE id = ?", row.id)[0]?.status === "pending") return;
      }
    } finally {
      // However a message ended (sent, void, given up, unverified), what tied it to something
      // read is of no further use and does not stay on its row.
      this.#s.sql.exec("UPDATE outbox SET source = NULL, guard = NULL, reads = NULL WHERE status NOT IN ('pending', 'draft') AND (source IS NOT NULL OR guard IS NOT NULL OR reads IS NOT NULL)");
      await this.#reconcileClosed();
    }
  }

  /**
   * Closed questions whose delivery was begun but never confirmed. Each is sent again under its own
   * id, which the connector does not duplicate, to learn where it is, and is then shown as closed.
   * Outside the ordered queue: these hold nothing up, and one failing does not stop the others.
   */
  async #reconcileClosed(): Promise<void> {
    for (const row of this.#s.rows<Row>("SELECT * FROM outbox WHERE status = 'reconciling' AND next_at <= ? ORDER BY id LIMIT 20", Date.now())) await this.#attempt(row, "reconciling");
  }

  /** One attempt to deliver a row. Returns whether it was delivered. */
  async #attempt(row: Row, status: "pending" | "reconciling"): Promise<boolean> {
    // Recorded before anything is sent: if this instance dies between the send and the receipt,
    // the row still says that an attempt was begun.
    // Likewise that its outcome is not known: it stays so unless the channel says, of this very
    // attempt, that nothing was posted. An instance that dies after the channel took the message
    // leaves a row that says "may have arrived", not one that looks untouched.
    // Its encoding is fixed now, before anything is sent: the current one for a first attempt, the
    // earlier one for a row whose sending began before there was a choice.
    const wire = typeof row.wire === "number" ? row.wire : row.started ? 0 : 1;
    this.#s.sql.exec("UPDATE outbox SET started = 1, uncertain = 1, first_attempt_at = COALESCE(first_attempt_at, ?), wire = ? WHERE id = ?", Date.now(), wire, row.id);
    try {
      // The time it was written goes along, so a retry looks for an earlier attempt in the same place every time.
      const receipt = await this.#b.deliver(JSON.parse(row.target) as Target, { id: row.id, idem: row.idem, text: row.text, authored: row.authored === 1, encoding: wire, created_at: row.created_at, ...(row.ask ? { ask: JSON.parse(row.ask) as ApprovalQuestion } : {}), ...(row.review ? { review: JSON.parse(row.review) as CodeReview } : {}), ...(row.interaction ? { interaction: row.interaction as string } : {}) });
      // If an earlier attempt had in fact been posted, that is when people could first answer it.
      const sentAt = receipt?.posted_at ?? Date.now();
      this.#s.transaction(() => {
        this.#s.sql.exec("UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL, receipt = ? WHERE id = ? AND status = ?", sentAt, receipt ? JSON.stringify(receipt) : null, row.id, status);
        // What the person was told, in their private conversation, as it reached them: part of
        // the conversation's history from now on, whatever becomes of this row. Only the agent's
        // own messages (not questions, notices or reviews), and only the words that went out.
        const nowSent = this.#s.rows<{ status: string }>("SELECT status FROM outbox WHERE id = ?", row.id)[0]?.status === "sent";
        if (nowSent && this.#isOwnPrivateMessage(row)) {
          this.#s.sql.exec(
            "INSERT OR IGNORE INTO said (outbox_id, run_id, session_id, text, sent_at, receipt_subject, reads) SELECT ?, ?, session_id, ?, ?, ?, ? FROM runs WHERE id = ?",
            row.id,
            row.run_id,
            row.text,
            sentAt,
            receipt?.subject ?? null,
            row.reads ?? "[]",
            row.run_id,
          );
        }
      });
      this.scrub("id = ?", row.id);
      if (row.continuation) {
        // From the request being taken up (its condition holding) to its answer being handed over.
        const taken = this.#s.rows<{ claimed_at: number | null }>("SELECT claimed_at FROM continuations WHERE id = ?", row.continuation)[0]?.claimed_at;
        if (taken) this.#s.log("request_answered", { claim_to_receipt_ms: Date.now() - taken });
        this.#b.requests.endRequest(row.continuation, "done", "answered");
      }
      // A way in that reached the person: where it was put somewhere else than the request was made, that place is told.
      if (row.interaction) this.#b.requests.shown(row, "reached");
      // It may have been closed while it was on its way.
      if (row.ask) this.#b.showClosed(row.idem);
      return true;
    } catch (err) {
      // The connector found nothing left to send: nothing was posted, and it is not tried again.
      // That settles this attempt, not an earlier one whose outcome was never heard.
      if (err instanceof DeliveryVoid) {
        const how = row.uncertain ? "unverified" : "void";
        this.#s.sql.exec("UPDATE outbox SET status = ?, text = '', error = NULL, uncertain = ? WHERE id = ? AND status = ?", how, row.uncertain ? 1 : 0, row.id, status);
        if (row.continuation) this.#b.requests.endRequest(row.continuation, how, how === "void" ? "there was nothing left to send" : "its answer may have been delivered; that could not be verified");
        return false;
      }
      // Whether this attempt can have reached anyone. Only the outside system saying no, or
      // saying not yet, settles that it did not.
      const uncertain = Boolean(row.uncertain) || !(err instanceof DeliveryRejected || err instanceof DeliveryDeferred);
      const attempts = row.attempts + 1;
      // The outside system may have said not to try again before a certain time. That time is
      // kept exactly: the message is not sent sooner. One too far off to wait for, in a queue
      // that delivers in order, ends here as undeliverable instead, and is not sent again.
      const notBefore = err instanceof DeliveryDeferred && Number.isFinite(err.notBefore) ? err.notBefore : 0;
      const tooFar = notBefore > Date.now() + MAX_DEFERRAL_MS;
      // A way in is not kept at the head of the queue, where it would hold back everything else
      // said in the conversation while its own time runs out: refused, it is given up at once;
      // unanswered, after a few quick tries.
      const dead = tooFar || attempts > OUTBOX_RETRY_DELAYS_MS.length || (Boolean(row.interaction) && (err instanceof DeliveryRejected || attempts >= MAX_INVITE_ATTEMPTS));
      const nextAt = Math.max(Date.now() + (OUTBOX_RETRY_DELAYS_MS[attempts - 1] ?? 0), notBefore);
      // An error can quote what was being sent. For a message from a run that read outside text, only the fact is kept.
      const isPrivate = this.#s.rows<{ private: number }>("SELECT private FROM outbox WHERE id = ?", row.id)[0]?.private === 1;
      const why = isPrivate ? DELIVERY_WITHHELD : `${tooFar ? "asked to wait longer than a message is held for; " : ""}${String(err)}`.slice(0, 500);
      // Given up on: where the system has a horizon for repeats and an attempt may have arrived,
      // that is what is recorded, not that it failed. Approval questions keep their own reckoning.
      const gaveUp = uncertain && !row.ask && dedupeWindow((JSON.parse(row.target) as Target).connector) !== undefined ? "unverified" : "dead";
      this.#s.sql.exec("UPDATE outbox SET status = ?, attempts = ?, next_at = ?, error = ?, uncertain = ? WHERE id = ?", dead ? gaveUp : status, attempts, nextAt, why, uncertain ? 1 : 0, row.id);
      if (dead) this.#s.log("message_undeliverable", { outbox_id: row.id, error: isPrivate ? DELIVERY_WITHHELD : String(err).slice(0, 300) });
      if (dead && row.continuation) this.#b.requests.endRequest(row.continuation, gaveUp === "dead" ? "failed" : "unverified", "its answer could not be delivered");
      // A way in given up on: where it was put somewhere else than the request was made, that place is told it did not get there.
      if (dead && row.interaction) this.#b.requests.shown(row, gaveUp === "dead" ? "failed" : "unknown");
      this.scrub("id = ?", row.id);
      return false;
    }
  }

  /**
   * Empties messages written in a run that read outside text, once they will not be sent again:
   * delivered, or given up. Their words, any structured form of them, and any error text are
   * removed; what is needed to know they were sent, and where, stays. While a message is still to
   * be delivered or reconciled it is kept, since it cannot be sent otherwise.
   */
  /** One of the agent's own messages (written with send_message, or a request's answer), to a person in their private conversation. */
  #isOwnPrivateMessage(row: Row): boolean {
    // Written by the model, under one of the keys its own messages go by; never the system's fixed words.
    const own = row.authored === 1 && typeof row.idem === "string" && (row.idem.startsWith("msg:") || row.idem.startsWith("answer:"));
    return own && !row.ask && !row.review && typeof row.run_id === "string" && isPrivateSession(this.#b.requests.sessionKeyOf(row.target, row.run_id));
  }

  scrub(which: "id = ?" | "run_id = ?", value: number | string): void {
    this.#s.sql.exec(
      `UPDATE outbox SET text = '', review = NULL, error = CASE WHEN error IS NULL THEN NULL ELSE ? END WHERE ${which} AND private = 1 AND status IN ('sent', 'dead', 'unverified') AND (text != '' OR review IS NOT NULL OR (error IS NOT NULL AND error != ?))`,
      DELIVERY_WITHHELD,
      value,
      DELIVERY_WITHHELD,
    );
  }
}
