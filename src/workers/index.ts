/** The workers this deployment is made of: see `src/agent.config.ts`. */
import config from "../agent.config";
import type { Worker } from "./types";

export type { Started, Work, Worker } from "./types";

const byName = new Map(config.workers.map((each) => [each.name, each]));
if (byName.size !== config.workers.length) throw new Error("two workers have the same name");

/** Every worker this deployment lists. */
export function workers(): Worker[] {
  return config.workers;
}

/** The deployment's guidance on which worker a piece of work goes to, in words. */
export function guidance(): string {
  return config.guidance.trim();
}

/**
 * Every worker this deployment has, offered for new work or retired: a piece of work written for
 * a worker is carried through by that worker (its reports, its questions, its stopping) also
 * after the deployment stopped offering it.
 */
const known = new Map<string, Worker>([...(config.retired ?? []), ...config.workers].map((each) => [each.name, each]));

/** The worker of this name, for work that was already written for it: listed for new work or not. */
export function workerKnown(name: string): Worker | undefined {
  return known.get(name);
}

/** The worker listed under this name, if this deployment has it. */
export function workerNamed(name: string): Worker | undefined {
  return byName.get(name);
}
