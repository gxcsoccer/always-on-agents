/** The sandbox as a worker: a coding agent in a container of its own, one for each piece of work. */
import type { Started, Worker } from "../types";

export const sandboxWorker: Worker = {
  name: "sandbox",
  description:
    "A coding agent that runs in its own sandbox: it runs shell commands, reads and changes code, runs what is already there, and uses git on the repository you gave it. It cannot open links that need a login, message anyone, post a comment or open a pull request, and it cannot download packages from registries such as npm: never ask it to. For a day after a piece of its work ended well it can go on from it (continue_from): the files as it left them and what it did are there again in a new sandbox; nothing that was approved then is. Ask for what you need in its final answer; you are the one who tells people. When you pass a result on, say what was found, and leave out what it could not do only because of how you briefed it.",
  acts_as: "agent",
  options: { repository: { type: ["string", "null"], description: "An https://github.com/... URL to clone first, or null." } },
  accepts(options, scope) {
    const repository = options.repository ?? null;
    if (repository === null) return;
    if (typeof repository !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/.test(repository)) throw new Error("repository must be an https://github.com/owner/name URL");
    // Credentials for a repository are lent only inside that repository's own scope, so that is the
    // only repository such a scope may send this worker to.
    if (scope.kind === "repo" && repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").toLowerCase() !== scope.id.toLowerCase()) throw new Error(`in this repository's conversation a task can only work on ${scope.id}`);
  },
  goes_on: true,
  async start(env, work) {
    const repository = typeof work.options.repository === "string" ? work.options.repository : undefined;
    // Going on from an earlier task: what it left is asked of it, and handed to the new one.
    let seed: { from: string; record: unknown; cwd: string; repository?: string } | undefined;
    const child = env.TASKS.getByName(work.id);
    const told = (state: { phase: string; error?: string }): Started => (state.phase === "failed" || state.phase === "lost" ? { state: "refused", error: state.error ?? "unknown error" } : { state: "started" });
    if (work.continue_from !== undefined) {
      // A start made again: one that was already taken answers for itself. What the earlier task
      // still keeps matters only to a start that is the first.
      const standing = await child.status();
      if ("phase" in standing) return told(standing as { phase: string; error?: string });
      const left = await env.TASKS.getByName(work.continue_from).snapshot();
      if (!left) {
        // Not kept. Before saying that nothing was started, the new task's id is closed, so that an
        // earlier attempt at this start still on its way cannot begin after this answer; if it
        // has begun meanwhile, that is what happened.
        if ((await child.claimed()) === "there") {
          const now = await child.status();
          if ("phase" in now) return told(now as { phase: string; error?: string });
        }
        return { state: "refused", error: "what that earlier piece of work left is no longer kept (it is kept for a day after it ends): hand this over as something new, and put what it needs to know in the brief" };
      }
      // It works where the earlier one worked. Another repository is other work.
      const same = (url: string) => url.replace(/\.git$/, "").toLowerCase();
      if (repository !== undefined && (left.repository === undefined || same(repository) !== same(left.repository))) return { state: "refused", error: `that earlier piece of work was ${left.repository ? `on ${left.repository}` : "not on a repository"}: to go on with it leave repository null; for another repository hand this over as something new` };
      seed = { from: work.continue_from, record: left.record, cwd: left.cwd, ...(left.repository ? { repository: left.repository } : {}) };
    }
    const started = await child.start({ id: work.id, prompt: work.brief, repository: seed ? undefined : repository, brain: work.brain, ...(work.accept_by !== undefined ? { accept_by: work.accept_by } : {}), ...(work.bounds ? { bounds: work.bounds } : {}), ...(seed ? { seed: seed as never } : {}) });
    return told(started);
  },
  tell: (env, id, note) => env.TASKS.getByName(id).tell(note),
  told: (env, id, noteId) => env.TASKS.getByName(id).told(noteId),
  answer: (env, id, decision, reason, question, standing) => env.TASKS.getByName(id).answer(decision, reason, question, standing),
  decisionOn: (env, id, question) => env.TASKS.getByName(id).decisionOn(question),
  async standing(env, id) {
    return env.TASKS.getByName(id).claimed();
  },
  async cancel(env, id) {
    await env.TASKS.getByName(id).cancel();
    return "stopped";
  },
};
