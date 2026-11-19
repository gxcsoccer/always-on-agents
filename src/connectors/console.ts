/**
 * Console connector: a plain HTTP channel for talking to the agent without any chat product.
 * It exists so the whole system can be exercised end to end — private chats, group chats, replies,
 * proactive messages — and it is what the deployment checks use.
 *
 * Inbound is a POST authenticated with the tenant's API key; the caller states who is speaking.
 * Outbound is pull-based: the client reads the scope's outbox.
 *
 * Trust model: the API key is a credential for the tenant's own backend, not for end users. Whoever
 * holds it can speak as any of the tenant's users and read any of their conversations, exactly as
 * that backend can. It must never be handed to a browser or an end user.
 */
import type { Env } from "../env";
import { type InboundEvent, type Scope, scopeName } from "../events";

const ID = /^[A-Za-z0-9._-]{1,64}$/;

export async function handleConsole(request: Request, env: Env, tenant: string, path: string[]): Promise<Response> {
  const [collection, id, resource] = path;
  if ((collection !== "users" && collection !== "chats") || !ID.test(id ?? "") || resource !== "messages") {
    return json({ error: "not found" }, 404);
  }
  const scope: Scope = { tenant, kind: collection === "users" ? "user" : "chat", id };
  const brain = env.BRAIN.getByName(scopeName(scope));

  if (request.method === "GET") {
    const url = new URL(request.url);
    const after = Number(url.searchParams.get("after") ?? 0);
    const wait = Math.min(Number(url.searchParams.get("wait") ?? 0), 25);
    const deadline = Date.now() + wait * 1_000;
    for (;;) {
      const messages = await brain.outboxSince(after);
      if (messages.length > 0 || Date.now() >= deadline) return json({ messages });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  if (request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { text?: unknown; user?: unknown; mention?: unknown; thread?: unknown; id?: unknown } | null;
    if (!body || typeof body.text !== "string" || body.text.trim() === "") return json({ error: "text is required" }, 400);
    const speaker = scope.kind === "user" ? id : body.user;
    if (typeof speaker !== "string" || !ID.test(speaker)) return json({ error: "user is required in a chat" }, 400);
    const addressed = scope.kind === "user" || body.mention !== false;
    // In a group, only messages that address the agent reach it.
    if (!addressed) return json({ accepted: false, ignored: "the message does not address the agent" }, 202);

    const event: InboundEvent = {
      source: "console",
      source_id: typeof body.id === "string" && ID.test(body.id) ? body.id : crypto.randomUUID(),
      kind: "message",
      session_key: scope.kind === "user" ? "dm" : typeof body.thread === "string" && ID.test(body.thread) ? `thread:${body.thread}` : "chat",
      principal: { kind: "human", id: speaker, explicit: true },
      // In this channel "@agent" is how a group message addresses the agent; it is not part of what was said.
      text: body.text.replace(/^\s*@agent(?![\w-])\s*/i, ""),
      reply_to: { connector: "console", address: {} },
    };
    return json({ ...(await brain.ingest(event)), scope: scopeName(scope) }, 202);
  }
  return json({ error: "method not allowed" }, 405);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
