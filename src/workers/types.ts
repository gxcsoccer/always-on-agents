/**
 * A worker: somewhere the agent can hand a piece of work to, that takes a while and gives a
 * result back. Every worker is listed in the deployment's configuration (`src/agent.config.ts`);
 * the Brain has none of its own. See docs/design/workers.zh-CN.md.
 *
 * This is the part of the contract that is in use so far: starting a piece of work and stopping
 * it. What comes with later steps (work done in a person's own name, being asked how a piece of
 * work stands, carrying an earlier piece on) is added when something calls it.
 */
import type { Env } from "../env";

/** One piece of work, as the Brain hands it over. `id` is the Brain's, kept before the worker is asked: the same id is the same piece of work. */
export interface Work {
  id: string;
  /** Everything the worker needs: it knows nothing of the conversation. */
  brief: string;
  /** The worker's own options, as it declares them in `options`. */
  options: Record<string, unknown>;
  /** The scope name of the Brain to report to. */
  brain: string;
}

/**
 * How starting went. Throwing means it is not known whether the worker took the work: the Brain
 * then tries to stop it, and says so.
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
  /** Starts a piece of work. The same `work.id` again is the same piece of work, not a second one. */
  start(env: Env, work: Work): Promise<Started>;
  /**
   * Stops a piece of work, for those that can be stopped. Says which it was: the work itself
   * has stopped, or only the waiting for it here (it may go on over there).
   */
  cancel?(env: Env, id: string): Promise<"stopped" | "no_longer_waited_for">;
}
