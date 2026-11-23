/**
 * The approval rules, as judgements on facts.
 *
 * The model proposes a decision on a worker's question; whether a person actually said it is
 * decided here, from the messages themselves. Nothing in this file reads the database, asks a
 * connector or calls a worker: what has to be looked up is handed in (see Facts), by Tasks.answer,
 * which also does everything that follows from the judgement.
 */
import type { Principal } from "../events";
import { saidAt } from "./revisions";
import type { InboxRow } from "./store";

/** A member's message, with who wrote it. */
export type Reply = { event: InboxRow; principal: Principal };

/** The question as it was put: its code, the message it was shown in, and whether it could be shown in full. */
export interface Asked {
  code: string;
  ask?: string;
  truncated?: boolean;
}

/** What the judgement rests on. The functions are asked only where the rules need them, and in the rules' order. */
export interface Facts {
  /** Members' messages since the question went out that a run has seen, up to date with their sources, in the order stored. */
  replies: Reply[];
  /** Whether one of those was edited and its new text has not arrived. */
  unresolved: boolean;
  /** Members' messages since the question went out that are still waiting in the inbox, likewise. */
  queued(): { events: InboxRow[]; unresolved: boolean };
  /** The messages already on record as deciding a question. */
  used(): Set<number | null>;
  /** Whether the conversation is one that several people are in. */
  shared: boolean;
  /** The one person who asked for the task, if there was exactly one. */
  requestedBy: string | null;
  /** Whether the author of this reply has said anything since that is not among `replies`. */
  saidMore(deciding: Reply): boolean;
  /** Whether a message still says what it said when it was read. */
  stillStands(event: InboxRow): boolean;
}

/**
 * The message a decision on this question rests on, or an error that says why there is none (yet).
 *
 * An approval counts only if a member's message, sent after the question, says just that; outside
 * a private conversation, only from the one person who asked for the task; only as that person's
 * last word; and never against a refusal from anyone. A refusal needs any member's message that
 * says so.
 */
export function decidingReply(decision: "allow" | "deny", asked: Asked, facts: Facts): Reply {
  if (facts.replies.length === 0) throw new Error("nobody here has answered the question yet; wait for a reply");

  // What each reply says about this question, read from its own words. The model proposes a
  // decision; it only goes through if a person's message actually says it.
  // A button press is about the question whose card it was on, and about no other.
  const about = (event: InboxRow) => isAbout(event, asked.ask);
  // One that is tied to this very question (a press on its card, a reply to its message) need
  // not repeat the code: "可以" under the question is an answer to it.
  const tied = (event: InboxRow) => isTiedTo(event, asked.ask);
  const says = (event: InboxRow) => saysAbout(event, asked);
  const read = facts.replies.map((reply) => ({ ...reply, says: says(reply.event) }));
  let deciding: (typeof read)[number];
  if (decision === "deny") {
    // A refusal has to be said too: "deny <code>". An unrelated message is not one.
    const refusals = read.filter(({ says }) => says === "deny");
    if (refusals.length === 0) throw new Error(`no reply so far refuses this. A refusal is a message that says "deny ${asked.code}". Call this tool again whenever a new reply arrives`);
    deciding = refusals.at(-1)!;
  } else {
    if (asked.truncated) throw new Error("the action is too long to be shown in full, so it cannot be approved; it can only be refused");
    // A refusal from any member wins over an approval, whichever came first. That includes one
    // that arrived after this run started and is still waiting in the inbox.
    const queued = facts.queued();
    const waiting = queued.events.some((event) => about(event) && (tied(event) || quotes(event.text ?? "", asked.code)) && says(event) !== "allow");
    if (waiting || read.some(({ says }) => says === "deny")) throw new Error("a reply refuses this; pass on a denial, not an approval");
    // The same goes for a waiting reply that has been edited into something not yet seen.
    if (queued.unresolved) throw new Error("a reply here was edited and its new text has not arrived yet; call this tool again when it has");
    // A reply that was edited since, whose new text has not arrived yet, may now be a refusal.
    if (facts.unresolved) throw new Error("a reply here was edited and its new text has not arrived yet; call this tool again when it has");
    let approvals = read.filter(({ says }) => says === "allow");
    if (approvals.length === 0) throw new Error(`no reply so far is an approval. An approval is a message whose only words are "approve ${asked.code}" (mentioning you in front of it is fine; anything after it, or any other wording, is not). Tell them that, and call this tool again whenever a new reply arrives`);
    // One message approves one question.
    const used = facts.used();
    approvals = approvals.filter(({ event }) => !used.has(event.id));
    if (approvals.length === 0) throw new Error("that reply was already used to approve another question");
    if (facts.shared) {
      if (!facts.requestedBy) throw new Error("this task was not started by a person, so nobody can approve this; it can only be refused");
      approvals = approvals.filter(({ principal }) => principal.id === facts.requestedBy);
      if (approvals.length === 0) throw new Error(`only ${facts.requestedBy}, who requested this task, can approve it`);
    }
    // "Last" is by when a thing was said, where the source tells us: deliveries can arrive out
    // of order, and a "wait" sent after the approval may get here before it.
    const bySaid = (a: (typeof read)[number], b: (typeof read)[number]) => saidAt(a.event) - saidAt(b.event) || a.event.id - b.event.id;
    deciding = [...approvals].sort(bySaid).at(-1)!;
    // The approval has to be that person's last word. If they said anything after it, they may
    // have been taking it back, and there is no reading that safely.
    const theirs = read.filter(({ principal }) => principal.id === deciding.principal.id).sort(bySaid);
    const lastWord = theirs.at(-1)!;
    // Said in the same instant as far as the source can tell: which came last is anyone's guess.
    // (Only where the time is the source's, which may be coarse. Arrival times order themselves.)
    if (theirs.some(({ event }) => event.id !== deciding.event.id && fromSource(event) && fromSource(deciding.event) && saidAt(event) === saidAt(deciding.event))) {
      throw new Error(`${deciding.principal.id} said something else at the same moment as approving; ask them to confirm by sending just "approve ${asked.code}" again`);
    }
    // Including anything of theirs that arrived after this run started and is still in the inbox.
    // And, for an approval that was typed elsewhere in the chat and brought here, anything
    // they have said since in the place they typed it.
    const saidMore = facts.saidMore(deciding);
    // And it has to be what they still say: not a comment since edited or deleted.
    if (!facts.stillStands(deciding.event)) throw new Error("that reply has since been edited or deleted; it no longer approves anything");
    if (lastWord.event.id !== deciding.event.id || saidMore) throw new Error(`${deciding.principal.id} said something after approving; ask them to confirm by sending just "approve ${asked.code}" again`);
  }
  return deciding;
}

/**
 * Whether anything members have said since speaks against an approval that is on record but was
 * not confirmed by the worker: anything about the question that is not an approval, anything the
 * approver said at or after approving, or an edit among them that has not arrived.
 */
export function speaksAgainst(later: { events: InboxRow[]; unresolved: boolean }, onRecord: { code: string; ask?: string }, approver: InboxRow | undefined, decidedBy: string): boolean {
  return (
    later.unresolved ||
    later.events.some(
      (event) =>
        // The same test as for a fresh decision: anything about this question, by its code or
        // by being tied to it, that is not an approval.
        (isAbout(event, onRecord.ask) && (isTiedTo(event, onRecord.ask) || quotes(event.text ?? "", onRecord.code)) && saysAbout(event, onRecord) !== "allow") ||
        ((JSON.parse(event.principal) as Principal).id === decidedBy && approver !== undefined && saidAt(event) >= saidAt(approver)),
    )
  );
}

/** A button press or a reply to a question's message is about that question and no other. */
function isAbout(event: InboxRow, ask: string | undefined): boolean {
  const question = event.data ? (JSON.parse(event.data) as { question?: string }).question : undefined;
  return question === undefined || question === ask;
}

function isTiedTo(event: InboxRow, ask: string | undefined): boolean {
  return ask !== undefined && (event.data ? (JSON.parse(event.data) as { question?: string }).question : undefined) === ask;
}

/** What a message says about one open question: by its code, or, if it is tied to the question, in plain words. */
function saysAbout(event: InboxRow, pending: { code: string; ask?: string }): "allow" | "deny" | undefined {
  if (!isAbout(event, pending.ask)) return undefined;
  return isTiedTo(event, pending.ask) ? readTiedDecision(event.text ?? "", pending.code) : readDecision(event.text ?? "", pending.code);
}

/**
 * What a reply says when it is tied to one question (a press on its card, a reply to its message).
 * It need not name the code, and a plain yes is an approval; anything refusing is a refusal, and
 * anything else is nothing.
 */
export function readTiedDecision(text: string, code: string): "allow" | "deny" | undefined {
  const named = readDecision(text, code);
  if (named) return named;
  if (/(?<![A-Za-z])(deny|denied|refuse|refused|reject|rejected|don'?t|do not|not|never|no|stop|cancel|wait)(?![A-Za-z])|拒绝|不同意|不批准|否决|不要|不行|不可以|别|取消|等等|等一下|先别/i.test(text)) return "deny";
  const bare = text.replace(/[\s:：,，.。!！~～]+/g, " ").trim().toLowerCase();
  return /^(approve all|全部批准|都批准|approve|approved|yes|ok|okay|同意|批准|可以|好|好的|行|确认|通过)$/.test(bare) ? "allow" : undefined;
}

/** Whether an approval also says "and for the rest of this task". Only ever read from an approval. */
export function wantsStanding(text: string): boolean {
  return /(?<![A-Za-z])approve all(?![A-Za-z])|全部批准|都批准/i.test(text);
}

/** Whether the time a message was said comes from its source rather than from its arrival. */
function fromSource(event: InboxRow): boolean {
  const data = event.data ? (JSON.parse(event.data) as { subject?: string; revision?: number }) : {};
  return Boolean(data.subject) && typeof data.revision === "number";
}

/** Whether a message mentions this question's code at all. */
export function quotes(text: string, code: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "i").test(text);
}

/**
 * What a person's reply says about the question with this code: an approval, a refusal, or nothing.
 * A refusal is checked first because "不同意 X" contains "同意 X".
 */
export function readDecision(text: string, code: string): "allow" | "deny" | undefined {
  if (!new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "i").test(text)) return undefined;
  // Refusal first, on the message exactly as written: any refusing or negating word next to the
  // code makes it a refusal, wherever it sits and whatever it is attached to. English words are
  // matched whole, so "notebook" or "another" is not one.
  if (/(?<![A-Za-z])(deny|denied|refuse|refused|reject|rejected|don'?t|do not|not|never|no|stop|cancel)(?![A-Za-z])|拒绝|不同意|不批准|否决|不要|不行|别|取消/i.test(text)) return "deny";
  // An approval is the whole message and nothing else: "approve CODE". Anything longer could be a
  // condition or a different statement. Mentions are not stripped here: each connector removes the
  // agent's own, where it knows which that is, and a message addressed to anyone else is not for us.
  const bare = text.replace(/[\s:：,，.。!！]+/g, " ").trim();
  if (new RegExp(`^(?:approve all|approve|全部批准|都批准|同意|批准) ?${code}$`, "i").test(bare)) return "allow";
  return undefined;
}
