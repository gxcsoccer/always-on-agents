/**
 * A worker: somewhere the agent can hand a piece of work to, that takes a while and gives a
 * result back. Every worker is listed in the deployment's configuration (`src/agent.config.ts`);
 * the Brain has none of its own. See docs/design/workers.zh-CN.md.
 *
 * A worker takes work in one of two ways. One that does things in the agent's own name is
 * started (`start`) and reports back by itself. One that does things in a person's name is
 * carried by a connector's tool (`tool`): the Brain keeps what that tool cannot do yet as a
 * request that waits (for the person's authorisation, for the result), and carries it on, as for
 * any such tool. To the model both are the same: a worker to hand a piece of work to.
 */
import type { Env } from "../env";
import type { Scope } from "../events";
import type { QuestionFate } from "./result";

/** One piece of work, as the Brain hands it over. `id` is the Brain's, kept before the worker is asked: the same id is the same piece of work. */
export interface Work {
  id: string;
  /** Everything the worker needs: it knows nothing of the conversation. */
  brief: string;
  /** The worker's own options, as it declares them in `options`. */
  options: Record<string, unknown>;
  /** The scope name of the Brain to report to. */
  brain: string;
  /**
   * The latest moment the worker may first take this work, fixed when it was first written and
   * the same for every repeat of the start. A worker that would first take it later turns it
   * away, so that how long it can run is bounded from when it was handed over.
   */
  accept_by?: number;
  /**
   * The id of an earlier piece of work of this same worker's, in the same conversation, that
   * ended well: this one goes on from what that one left. The Brain has checked that much; the
   * worker says (by refusing) if what it left can no longer be had.
   */
  continue_from?: string;
  /**
   * How far the tenant lets this piece of work go: how long it may run and how often it may ask
   * the model. Fixed as the work is handed over; a worker that has such bounds of its own goes
   * by these where they are given.
   */
  bounds?: { lifetime_ms?: number; model_calls?: number };
}

/**
 * How starting went. Throwing means it is not known whether the worker took the work: the Brain
 * keeps it as not confirmed, and finds out (see `standing`).
 */
export type Started = { state: "started" } | { state: "refused"; error: string };

export interface Worker {
  /** Short and lowercase; what a piece of work is recorded under. */
  name: string;
  /** For the model: what this worker is good at, and what it cannot do. */
  description: string;
  /** In whose name it does things: the agent's own, or the person's (who then has to authorise it, in their own conversation). */
  acts_as: "agent" | "person";
  /** Its own parameters, as JSON schema properties (a repository to work in, say). */
  options?: Record<string, unknown>;
  /**
   * Looks at what it is asked to do before anything is written or started: its own options as
   * the model gave them, and where it is asked from. Throws, in words for the model, for what it
   * will not take (an option that is not what it should be, work it does not do from that place).
   */
  accepts?(options: Record<string, unknown>, scope: Scope): void;
  /**
   * For a worker the Brain starts: it can go on from an earlier piece of its own work that ended
   * well (see `Work.continue_from`), for as long as it keeps what that left. Said to the model
   * with the hand-over tool; a worker that does not say so is never asked to.
   */
  goes_on?: true;
  /**
   * Hands a piece of work under way something more that its person says, to be taken into account
   * from its next step on. `taken`: the worker has it and will bring it before its agent at the
   * next point where that can be done (taken is not read: what was not read by the time the work
   * ends is said in its ending). `closed`: this run of the work takes no more (it has ended, or is
   * about to); it can be put after it instead. The same `note.id` again gets the same answer.
   * Throwing means it is not known whether it was taken, or says why it cannot be (too long, too many).
   * A worker without this cannot be told anything once it is at work.
   */
  tell?(env: Env, id: string, note: { id: string; text: string }): Promise<{ state: "taken" } | { state: "closed" }>;
  /** Starts a piece of work. The same `work.id` again is the same piece of work, not a second one. */
  start?(env: Env, work: Work): Promise<Started>;
  /**
   * For a worker carried by a connector's tool: the tool's name. The tool is called with
   * `{ brief, continue_from }` (`continue_from`: the id of an earlier piece of work of this
   * worker to go on with, or null) and is marked `hands_to` with this worker's name. The worker
   * is there for a person wherever that tool is.
   */
  tool?: string;
  /**
   * Stops a piece of work, for those that can be stopped. Says which it was: the work itself
   * has stopped, or only the waiting for it here (it may go on over there).
   */
  cancel?(env: Env, id: string): Promise<"stopped" | "no_longer_waited_for">;
  /**
   * For a worker that asks people to approve things: passes on a person's decision on one
   * question of one piece of work. `standing`: allowed for the rest of that piece of work, where
   * the question was one that may be. Says what the worker then holds as decided (the first
   * answer to a question stands). Throwing means it is not known whether it arrived.
   */
  answer?(env: Env, id: string, decision: "allow" | "deny", reason: string, question: string, standing: boolean): Promise<{ ok: true; decision: "allow" | "deny"; standing?: boolean } | { ok: false; error: string }>;
  /** How one such question ended, by the worker's own record: asked when an answer's arrival is not known. */
  decisionOn?(env: Env, id: string, question: string): Promise<QuestionFate>;
  /**
   * Whether the worker has this piece of work at all, settled as it is asked: "there" once it has
   * taken it (whatever has become of it since: it reports that itself); "none" if it never did,
   * and then it must never take it: a start under this id that arrives later is turned away.
   * Asked when a start was not answered. Throwing means it could not be asked.
   */
  standing?(env: Env, id: string): Promise<"there" | "none">;
}
