/** The workers this deployment is made of: see `src/agent.config.ts`. */
import config from "../agent.config";
import type { Worker } from "./types";

export type { Started, Work, Worker } from "./types";

const byName = new Map(config.workers.map((each) => [each.name, each]));
if (byName.size !== config.workers.length) throw new Error("two workers have the same name");

/** The worker listed under this name, if this deployment has it. */
export function workerNamed(name: string): Worker | undefined {
  return byName.get(name);
}
