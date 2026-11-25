/**
 * What a worker may ask people to approve, in the shapes the Brain reads: for any worker, and
 * kept apart from every worker's own code so that the Brain needs none of it.
 */

/** One change to a branch or tag that a push would make. */
export interface RefUpdate {
  ref: string;
  old: string;
  new: string;
}

const ZERO = /^0+$/;

/**
 * Whether a push is the kind that may be approved for the rest of a task: updates or creations of
 * branches only. A tag, a deletion, or anything mixed with one is always asked about by itself.
 */
export function standingEligible(refs: RefUpdate[]): boolean {
  return refs.length > 0 && refs.every((r) => /^refs\/heads\/[^\s]+$/.test(r.ref) && !ZERO.test(r.new));
}
