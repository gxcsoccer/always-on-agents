/**
 * What a worker hands back, in the shapes the Brain reads: for any worker, and kept apart from
 * every worker's own code so that the Brain needs none of it.
 */

export type QuestionFate = { state: "decided"; decision: "allow" | "deny"; standing?: boolean } | { state: "pending" | "undecided" | "unknown" };

/**
 * How much of a worker's final answer is kept and passed to the Brain: the same as the longest
 * message the Brain can send, so an answer that fits can be passed on whole.
 */
export const MAX_RESULT_TEXT = 8_000;
const CUT_OFF = "\n[The worker's answer was longer than this and was cut off here.]";

/**
 * Cuts an answer that is too long, and says so at the end: a cut that cannot be seen hides
 * whatever came after it. Applied where the answer is produced and again where the Brain reads it;
 * doing it twice changes nothing.
 */
export function clipResult(text: string): string {
  return text.length <= MAX_RESULT_TEXT ? text : text.slice(0, MAX_RESULT_TEXT - CUT_OFF.length) + CUT_OFF;
}
