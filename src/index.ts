/**
 * The Worker entry: a stateless ingress. It authenticates, works out which tenant and scope a
 * request belongs to, and hands it to that scope's Brain. It holds no state and does no work itself,
 * so it can answer webhooks quickly.
 */
import { connector, connectors } from "./connectors";
import type { Env } from "./env";
import { registry } from "./registry";

export { BrainAgent } from "./brain/agent";
export { Registry } from "./registry";
export { FeishuLink } from "./connectors/feishu-link";
export { Outbound } from "./workers/sandbox/outbound";
export { DirectoryBackupGateway, TaskSandbox } from "./workers/sandbox/task";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/healthz") return json({ ok: true });
      if (path[0] !== "v1") return json({ error: "not found" }, 404);

      if (path[1] === "admin") {
        if (!env.ADMIN_KEY || !(await sameSecret(bearer(request), env.ADMIN_KEY))) return json({ error: "missing or wrong admin key" }, 401);
        return admin(request, env, path.slice(2), url);
      }
      // Everything else under /v1/<name>/ belongs to the connector of that name.
      const owner = connector(path[1] ?? "");
      if (owner?.http) return await owner.http(request, env, path.slice(2), { defer: (work) => ctx.waitUntil(work) });
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.log(JSON.stringify({ request_failed: String(err), path: url.pathname }));
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
  /** Every minute: each connector's own upkeep. One failing does not stop the others. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const each of connectors) {
      if (each.scheduled) ctx.waitUntil(each.scheduled(env).catch((err) => console.log(JSON.stringify({ scheduled_failed: String(err).slice(0, 300), connector: each.name }))));
    }
  },
} satisfies ExportedHandler<Env>;

async function admin(request: Request, env: Env, path: string[], url: URL): Promise<Response> {
  const method = request.method;
  const body = async () => ((await request.json().catch(() => ({}))) ?? {}) as Record<string, any>;

  if (path[0] === "tenants" && path.length === 1 && method === "POST") {
    const { id, name } = await body();
    return json(await registry(env).createTenant(String(id ?? ""), String(name ?? id ?? "")), 201);
  }
  if (path[0] === "tenants" && path[2] === "chat-repos" && method === "POST") {
    const { chat, repo } = await body();
    await registry(env).linkChatRepo(path[1], String(chat ?? ""), repo === null || repo === undefined ? null : String(repo));
    return json({ ok: true });
  }
  if (path[0] === "tenants" && path[2] === "identities" && method === "POST") {
    const { provider, external_id, user_id } = await body();
    await registry(env).linkIdentity(path[1], String(provider), String(external_id), String(user_id));
    return json({ ok: true });
  }

  if (path[0] === "scopes" && path[1]) {
    const brain = env.BRAIN.getByName(decodeURIComponent(path[1]));
    if (path.length === 2 && method === "GET") return json(await brain.inspect());
    if (path[2] === "memory" && method === "GET") return json({ content: await brain.readMemory(url.searchParams.get("path") ?? "") });
  }

  if (path[0] === "tasks" && /^[0-9a-f-]{36}$/.test(path[1] ?? "")) {
    const task = env.TASKS.getByName(path[1]);
    if (path.length === 2 && method === "GET") return json(await task.status());
    if (path[2] === "probe" && method === "POST") return json(await task.probe());
    if (path[2] === "kill-container" && method === "POST") return json(await task.killContainer());
    if (path[2] === "files" && method === "GET" && (path[3] === "events" || path[3] === "hooks" || path[3] === "stderr")) {
      return new Response(await task.readFiles(path[3]), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }
  // Setting up a connector is that connector's own business.
  for (const each of connectors) {
    const response = await each.admin?.({ method, path, url, body }, env);
    if (response) return response;
  }
  return json({ error: "not found" }, 404);
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

/** Compares digests, so the comparison takes the same time wherever the inputs differ. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
