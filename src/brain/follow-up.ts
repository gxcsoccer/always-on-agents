/**
 * The decisions about following up on an earlier answer that do not depend on judgement: whether
 * a kept answer may be reopened at all, and what has become of a passage it rested on. They are
 * plain functions of what is known, so that they can be laid beside the strict behaviour (which
 * never reopens anything) case by case, without reading or sending anything.
 *
 * What is left to the model, by the user's decision (docs/design/agent-core-step0.md, 5.3), is
 * only whether the person's words are a follow-up to the one answer these rules leave eligible.
 */

export interface FollowUpCase {
  /** Whether follow-ups are switched on for the deployment. */
  enabled: boolean;
  /** Whether the run rests on nothing but the person's own messages in their private conversation. */
  actingForPerson: boolean;
  /** The conversation the run is in. */
  session: string;
  /** What the person's messages reply to, if they are replies. */
  repliedTo: string[];
  now: number;
  /** The answer proposed, if there is one by that id. */
  answer?: { session: string; expiresAt: number; subject: string; isLastThingSaid: boolean };
  /** A follow-up that waited and is being carried on: which answer it is about was settled when it was first made. */
  carriedOn?: boolean;
}

export type Verdict = { allow: true } | { allow: false; reason: "off" | "not_the_person" | "no_such_answer" | "another_conversation" | "expired" | "replied_to_something_else" | "not_the_last_thing_said" };

/** Before follow-ups: nothing of an answer is kept, so nothing is ever reopened. */
export function strictDecision(_: FollowUpCase): Verdict {
  return { allow: false, reason: "off" };
}

export function followUpDecision(c: FollowUpCase): Verdict {
  if (!c.enabled) return { allow: false, reason: "off" };
  if (!c.actingForPerson) return { allow: false, reason: "not_the_person" };
  if (!c.answer) return { allow: false, reason: "no_such_answer" };
  if (c.answer.session !== c.session) return { allow: false, reason: "another_conversation" };
  if (c.answer.expiresAt <= c.now) return { allow: false, reason: "expired" };
  // A reply names what it is about; nothing else does once the person has replied to something.
  if (c.repliedTo.length > 0) return c.repliedTo.every((subject) => subject === c.answer!.subject) ? { allow: true } : { allow: false, reason: "replied_to_something_else" };
  if (c.carriedOn) return { allow: true };
  return c.answer.isLastThingSaid ? { allow: true } : { allow: false, reason: "not_the_last_thing_said" };
}

/** A sentence an answer said one of its points rests on, and where it stood in what was read. */
export interface Passage {
  /** The point of the answer it was given for, in the answer's words. */
  point: string;
  quote: string;
  /** Whether it was found, in exactly one place, in what was read when the answer was written. */
  found: boolean;
  /** The text just before and just after it there. */
  before?: string;
  after?: string;
}

const AROUND = 40;
/** An anchor shorter than this (the quote stands at the very start or end, say) says too little about where it stood. */
const ANCHOR_MIN = 8;
/** A quote shorter than this is kept, but never taken as tied to a place: too many places could hold it. */
export const QUOTE_MIN = 6;

/** Ties a quote to its one place in what was read, or says it could not be. */
export function locate(point: string, quote: string, read: string[]): Passage {
  const places = quote.length < QUOTE_MIN ? [] : read.flatMap((text) => occurrences(text, quote).map((at) => ({ text, at })));
  if (places.length !== 1) return { point, quote, found: false };
  const { text, at } = places[0];
  return { point, quote, found: true, before: text.slice(Math.max(0, at - AROUND), at), after: text.slice(at + quote.length, at + quote.length + AROUND) };
}

export type PassageNow = "unchanged" | "changed" | "cannot verify";

/**
 * What has become of a passage, against the source as it reads now. "unchanged" needs the same
 * words with the same text right before or right after them; the same words somewhere else prove nothing about the point
 * they once supported. `partial` says the source was not read whole this time.
 */
export function passageNow(passage: Passage, now: string[], partial: boolean): { now: PassageNow; why: string } {
  if (!passage.found) return { now: "cannot verify", why: "it could not be tied to one place in the source when the answer was written" };
  const places = now.flatMap((text) => occurrences(text, passage.quote).map((at) => ({ before: text.slice(Math.max(0, at - AROUND), at), after: text.slice(at + passage.quote.length, at + passage.quote.length + AROUND) })));
  // The same words with the same text on one side of them, where that text is enough to tell a
  // place by. An anchor that is empty or a few characters long matches anywhere and proves nothing.
  const same = (then: string | undefined, now: string) => then !== undefined && then.length >= ANCHOR_MIN && then === now;
  const matching = places.filter((each) => same(passage.before, each.before) || same(passage.after, each.after));
  if (matching.length === 1) return { now: "unchanged", why: "the same words stand where they stood" };
  if (places.length > 0) return { now: "cannot verify", why: "the words are there, but what surrounds them is not what it was" };
  return partial ? { now: "cannot verify", why: "the source is longer than what was read this time, and the passage is not in the part read" } : { now: "changed", why: "the words are no longer there as they were" };
}

function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  if (quote === "") return found;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) found.push(at);
  return found;
}
