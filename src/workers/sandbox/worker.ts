/** The sandbox as a worker: a coding agent in a container of its own, one for each piece of work. */
import type { Worker } from "../types";

export const sandboxWorker: Worker = {
  name: "sandbox",
  description: "A coding agent that runs in its own sandbox: it can run shell commands, write code and use git. It cannot open links that need a login, message anyone or post anywhere.",
  acts_as: "agent",
  options: { repository: { type: ["string", "null"], description: "An https://github.com/... URL to clone first, or null." } },
  async start(env, work) {
    const repository = typeof work.options.repository === "string" ? work.options.repository : undefined;
    const started = await env.TASKS.getByName(work.id).start({ id: work.id, prompt: work.brief, repository, brain: work.brain, ...(work.accept_by !== undefined ? { accept_by: work.accept_by } : {}), ...(work.bounds ? { bounds: work.bounds } : {}) });
    return started.phase === "failed" || started.phase === "lost" ? { state: "refused", error: started.error ?? "unknown error" } : { state: "started" };
  },
  async standing(env, id) {
    return env.TASKS.getByName(id).claimed();
  },
  async cancel(env, id) {
    await env.TASKS.getByName(id).cancel();
    return "stopped";
  },
};
