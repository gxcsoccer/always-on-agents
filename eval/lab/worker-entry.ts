// Local only, never deployed: an entry for `wrangler dev` that starts a sandbox task directly, so that
// what the unit tests stand in for (the Worker runtime, the task's Durable Object, the container built
// from the Dockerfile, the outbound proxy, the model) is the real thing. It calls the real model: it
// needs OPENAI_API_KEY in a git-ignored .dev.vars, and costs tokens.
//
//   sed -e 's#"main": "src/index.ts"#"main": "eval/lab/worker-entry.ts"#' -e 's#"name": "always-on-agent"#"name": "always-on-agent-lab"#' wrangler.jsonc > wrangler.lab.jsonc
//   npx wrangler dev -c wrangler.lab.jsonc --port 8799 --local      (Docker has to be running)
//   curl -X POST localhost:8799/lab/<uuid>/start -d '{"prompt":"run `sleep 25`, then say DONE"}'
//   curl -X POST localhost:8799/lab/<uuid>/tell  -d '{"id":"n1","text":"also say PINEAPPLE"}'
//   curl localhost:8799/lab/<uuid>/status
//   rm wrangler.lab.jsonc
import main from "../../src/index";
import type { Env } from "../../src/env";

export { BrainAgent } from "../../src/brain/agent";
export { Registry } from "../../src/registry";
export { FeishuGrant } from "../../src/connectors/feishu-grant";
export { DoubaoGrant } from "../../src/connectors/doubao";
export { FeishuLink } from "../../src/connectors/feishu-link";
export { Outbound } from "../../src/workers/sandbox/outbound";
export { DirectoryBackupGateway, TaskSandbox } from "../../src/workers/sandbox/task";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const [lab, id, what] = url.pathname.split("/").filter(Boolean);
    if (lab !== "lab") return main.fetch(request, env, ctx);
    const task = env.TASKS.getByName(id);
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
    const out = (value: unknown) => new Response(JSON.stringify(value, null, 1), { headers: { "content-type": "application/json" } });
    try {
      if (what === "start") return out(await task.start({ id, prompt: String(body.prompt), ...(body.bounds ? { bounds: body.bounds } : {}) }));
      if (what === "tell") return out(await task.tell({ id: String(body.id), text: String(body.text) }));
      if (what === "told") return out(await task.told(String(body.id)));
      if (what === "alarm") return out((await (task as any).alarm(), "ok"));
      if (what === "files") return new Response(await task.readFiles(body.which ?? "hooks"));
      const state = (await task.status()) as any;
      return out({ phase: state.phase, error: state.error, run: state.run, notes: (state.notes ?? []).map((n: any) => ({ id: n.id, held: n.held === state.run })), notes_closed: state.notes_closed === state.run, model_calls: state.model_calls, result: state.runs?.at(-1)?.result?.text });
    } catch (err) {
      return out({ error: String(err) });
    }
  },
  scheduled: (main as any).scheduled,
};
