/**
 * The Worker entry: a stateless ingress. It authenticates, works out which tenant and scope a
 * request belongs to, and hands it to that scope's Brain. It holds no state and does no work itself,
 * so it can answer webhooks quickly.
 */
import { handleConsole } from "./connectors/console";
import { handleFeishuWebhook } from "./connectors/feishu";
import { handleGithubWebhook } from "./connectors/github";
import type { Env } from "./env";
import { registry } from "./registry";

export { BrainAgent } from "./brain/agent";
export { Registry } from "./registry";
export { Outbound } from "./workers/sandbox/outbound";
export { DirectoryBackupGateway, TaskSandbox } from "./workers/sandbox/task";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/healthz") return json({ ok: true });
      if (path[0] !== "v1") return json({ error: "not found" }, 404);

      if (path[1] === "github" && path[2] === "webhook" && request.method === "POST") return handleGithubWebhook(request, env);

      if (path[1] === "feishu" && path[2] === "events" && path[3] && request.method === "POST") return handleFeishuWebhook(request, env, path[3]);

      if (path[1] === "console") {
        const tenant = await registry(env).authenticate(bearer(request));
        if (!tenant) return json({ error: "missing or unknown API key" }, 401);
        return handleConsole(request, env, tenant, path.slice(2));
      }

      if (path[1] === "admin") {
        if (!env.ADMIN_KEY || !(await sameSecret(bearer(request), env.ADMIN_KEY))) return json({ error: "missing or wrong admin key" }, 401);
        return admin(request, env, path.slice(2), url);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.log(JSON.stringify({ request_failed: String(err), path: url.pathname }));
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
  if (path[0] === "tenants" && path[2] === "github-installations" && method === "POST") {
    await registry(env).linkGithubInstallation(String((await body()).installation_id ?? ""), path[1]);
    return json({ ok: true });
  }
  if (path[0] === "tenants" && path[2] === "github-repos" && method === "POST") {
    await registry(env).linkGithubRepo(String((await body()).repo ?? ""), path[1]);
    return json({ ok: true });
  }
  if (path[0] === "tenants" && path[2] === "feishu-apps" && method === "POST") {
    const app = await body();
    await registry(env).setFeishuApp(path[1], {
      app_id: String(app.app_id ?? ""),
      app_secret: String(app.app_secret ?? ""),
      encrypt_key: app.encrypt_key ? String(app.encrypt_key) : undefined,
      verification_token: app.verification_token ? String(app.verification_token) : undefined,
      bot_open_id: app.bot_open_id ? String(app.bot_open_id) : undefined,
    });
    return json({ ok: true, webhook: `${url.origin}/v1/feishu/events/${app.app_id}` });
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
