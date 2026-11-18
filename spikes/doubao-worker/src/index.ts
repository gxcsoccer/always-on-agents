/**
 * Spike: can a Cloudflare Durable Object drive a 豆包工作 Agent as a remote worker?
 *
 * One singleton DO holds the OAuth token, the tasks, and a log of every HTTP
 * exchange with Doubao. The log is the deliverable: read it at GET /log.
 */
import { DurableObject } from "cloudflare:workers";

interface Env {
  SPIKE: DurableObjectNamespace<Spike>;
  DOUBAO_APP_ID: string;
  DOUBAO_APP_SECRET: string;
  SPIKE_KEY: string;
  DOUBAO_API_BASE: string;
  DOUBAO_ACCOUNTS_BASE: string;
  DOUBAO_SCOPES: string;
}

interface Token {
  access_token: string;
  refresh_token?: string;
  access_expires_at: number;
  refresh_expires_at?: number;
  scope?: string;
  obtained_at: number;
  refresh_count: number;
}

interface PollSample {
  at: number;
  elapsed_ms: number;
  session_status?: string;
  reply_status?: string;
  turn_status?: string;
  items?: number;
}

interface Task {
  id: string;
  name: string;
  text: string;
  created_at: number;
  session_id?: string;
  user_message_id?: string;
  reply_message_id?: string;
  state: "dispatching" | "running" | "completed" | "failed" | "cancelled" | "requires_action" | "gave_up";
  polls: PollSample[];
  detected_at?: number;
  result?: unknown;
  error?: string;
}

interface Exchange {
  at: number;
  label: string;
  method: string;
  url: string;
  status: number;
  ms: number;
  colo?: string;
  body: string;
}

const TERMINAL_REPLY = new Set(["completed", "failed", "cancelled"]);
const POLL_STEPS_S = [2, 2, 3, 5, 5, 10, 10, 15, 30, 30, 60];
const POLL_GIVE_UP_MS = 2 * 60 * 60 * 1000;
const LOG_LIMIT = 300;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The OAuth callback is reached by the browser redirect and is protected by `state` instead.
    if (url.pathname !== "/oauth/callback") {
      const key = url.searchParams.get("key") ?? request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!env.SPIKE_KEY || key !== env.SPIKE_KEY) return json({ error: "missing or wrong key" }, 401);
    }
    return env.SPIKE.get(env.SPIKE.idFromName("default")).fetch(request);
  },
};

export class Spike extends DurableObject<Env> {
  private refreshing?: Promise<Token>;

  // ---------- storage helpers ----------

  private async log(e: Exchange) {
    const log = (await this.ctx.storage.get<Exchange[]>("log")) ?? [];
    log.push(e);
    await this.ctx.storage.put("log", log.slice(-LOG_LIMIT));
  }

  private async getTask(id: string) {
    return this.ctx.storage.get<Task>(`task:${id}`);
  }

  private async putTask(task: Task) {
    await this.ctx.storage.put(`task:${task.id}`, task);
  }

  private async listTasks() {
    return [...(await this.ctx.storage.list<Task>({ prefix: "task:" })).values()];
  }

  // ---------- HTTP to Doubao, always logged ----------

  private async call(label: string, url: string, init: RequestInit = {}) {
    const started = Date.now();
    let status = 0;
    let text = "";
    let colo: string | undefined;
    try {
      const res = await fetch(url, init);
      status = res.status;
      colo = res.headers.get("cf-ray")?.split("-")[1] ?? undefined;
      text = await res.text();
    } catch (err) {
      text = `fetch threw: ${String(err)}`;
    }
    const ms = Date.now() - started;
    await this.log({
      at: started,
      label,
      method: init.method ?? "GET",
      url: url.replace(/(code|client_secret|refresh_token)=[^&]+/g, "$1=***"),
      status,
      ms,
      colo,
      body: redact(text).slice(0, 4000),
    });
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status, ms, text, body };
  }

  private async api(label: string, path: string, init: RequestInit = {}) {
    const token = await this.accessToken();
    return this.call(label, `${this.env.DOUBAO_API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  // ---------- OAuth ----------

  private async oauthStart(origin: string) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const state = crypto.randomUUID();
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    await this.ctx.storage.put("oauth_pending", { verifier, state, redirect_uri: `${origin}/oauth/callback` });
    const u = new URL(`${this.env.DOUBAO_ACCOUNTS_BASE}/open-apis/authen/v1/authorize`);
    u.searchParams.set("client_id", this.env.DOUBAO_APP_ID);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
    u.searchParams.set("scope", this.env.DOUBAO_SCOPES);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("prompt", "consent");
    return Response.redirect(u.toString(), 302);
  }

  private async oauthCallback(url: URL) {
    const pending = await this.ctx.storage.get<{ verifier: string; state: string; redirect_uri: string }>("oauth_pending");
    if (!pending || url.searchParams.get("state") !== pending.state) return json({ error: "state mismatch" }, 400);
    const code = url.searchParams.get("code");
    if (!code) return json({ error: "no code", query: Object.fromEntries(url.searchParams) }, 400);
    await this.ctx.storage.delete("oauth_pending");
    const token = await this.tokenRequest("oauth.exchange", {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirect_uri,
      code_verifier: pending.verifier,
    });
    return json({ ok: true, token: tokenMeta(token) });
  }

  private async tokenRequest(label: string, params: Record<string, string>): Promise<Token> {
    const previous = await this.ctx.storage.get<Token>("token");
    const res = await this.call(label, `${this.env.DOUBAO_ACCOUNTS_BASE}/oauth/v3/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.DOUBAO_APP_ID,
        client_secret: this.env.DOUBAO_APP_SECRET,
        ...params,
      }),
    });
    const b = res.body;
    if (!b?.access_token) throw new Error(`${label} failed: HTTP ${res.status} ${redact(res.text).slice(0, 300)}`);
    const now = Date.now();
    const token: Token = {
      access_token: b.access_token,
      refresh_token: b.refresh_token,
      access_expires_at: now + (b.expires_in ?? 0) * 1000,
      refresh_expires_at: b.refresh_token_expires_in ? now + b.refresh_token_expires_in * 1000 : undefined,
      scope: b.scope,
      obtained_at: now,
      refresh_count: label === "oauth.refresh" ? (previous?.refresh_count ?? 0) + 1 : 0,
    };
    // The refresh token is single-use: persist the new one before anything else can run.
    await this.ctx.storage.put("token", token);
    return token;
  }

  /** Single-flight refresh. A DO interleaves requests across awaits, so two callers must share one refresh. */
  private refresh(): Promise<Token> {
    this.refreshing ??= (async () => {
      try {
        const token = await this.ctx.storage.get<Token>("token");
        if (!token?.refresh_token) throw new Error("no refresh_token; authorize again at /oauth/start");
        return await this.tokenRequest("oauth.refresh", {
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
        });
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async accessToken() {
    const token = await this.ctx.storage.get<Token>("token");
    if (!token) throw new Error("not authorized; open /oauth/start first");
    if (token.access_expires_at - Date.now() > 60_000) return token.access_token;
    return (await this.refresh()).access_token;
  }

  // ---------- tasks ----------

  private async dispatch(text: string, name: string) {
    const task: Task = { id: crypto.randomUUID(), name, text, created_at: Date.now(), state: "dispatching", polls: [] };
    // Persist before calling out: the task id is the idempotency key, so a retry reuses it.
    await this.putTask(task);
    const res = await this.api("session.create", "/agent/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        uuid: task.id,
        name,
        initial_events: [{ type: "user.message", contents: [{ type: "text", text }] }],
      }),
    });
    if (res.body?.code !== 0) {
      task.state = "failed";
      task.error = `session.create HTTP ${res.status}: ${res.text.slice(0, 500)}`;
      await this.putTask(task);
      return task;
    }
    const data = res.body.data ?? {};
    const session = data.session ?? data;
    const messages: any[] = data.messages ?? session.messages ?? [];
    task.session_id = session.id;
    task.user_message_id = messages.find((m) => m.role === "user")?.id;
    task.reply_message_id = messages.find((m) => m.role === "assistant")?.id;
    task.state = "running";
    await this.putTask(task);
    await this.scheduleNextPoll();
    return task;
  }

  private async poll(task: Task) {
    if (!task.session_id) return;
    const session = await this.api("session.get", `/agent/v1/sessions/${task.session_id}`);
    const list = await this.api(
      "message.list",
      `/agent/v1/sessions/${task.session_id}/messages?page_size=10&order=desc`,
    );
    const messages: any[] = list.body?.data?.messages ?? list.body?.data?.items ?? [];
    const reply =
      messages.find((m) => m.role === "assistant" && m.reply_id === task.user_message_id) ??
      messages.find((m) => m.role === "assistant");
    if (reply?.id) task.reply_message_id = reply.id;

    let turnStatus: string | undefined;
    let full = reply;
    if (task.reply_message_id) {
      const got = await this.api(
        "message.get",
        `/agent/v1/sessions/${task.session_id}/messages/${task.reply_message_id}`,
      );
      full = got.body?.data?.message ?? full;
      turnStatus = got.body?.data?.turn_status;
    }

    const sessionStatus: string | undefined = (session.body?.data?.session ?? session.body?.data)?.status;
    const now = Date.now();
    task.polls.push({
      at: now,
      elapsed_ms: now - task.created_at,
      session_status: sessionStatus,
      reply_status: full?.status,
      turn_status: turnStatus,
      items: full?.items?.length,
    });

    if (full?.status && TERMINAL_REPLY.has(full.status)) {
      task.state = full.status;
      task.result = full;
      task.detected_at = now;
    } else if (sessionStatus === "requires_action") {
      task.state = "requires_action";
      task.result = { session: session.body?.data, reply: full };
      task.detected_at = now;
    } else if (sessionStatus === "failed") {
      task.state = "failed";
      task.detected_at = now;
    } else if (now - task.created_at > POLL_GIVE_UP_MS) {
      task.state = "gave_up";
    }
    await this.putTask(task);
  }

  private async scheduleNextPoll() {
    const running = (await this.listTasks()).filter((t) => t.state === "running");
    if (!running.length) return;
    const next = Math.min(
      ...running.map((t) => {
        const step = POLL_STEPS_S[Math.min(t.polls.length, POLL_STEPS_S.length - 1)];
        const last = t.polls.at(-1)?.at ?? t.created_at;
        return last + step * 1000;
      }),
    );
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 500));
  }

  async alarm() {
    const now = Date.now();
    for (const task of (await this.listTasks()).filter((t) => t.state === "running")) {
      const step = POLL_STEPS_S[Math.min(task.polls.length, POLL_STEPS_S.length - 1)];
      const last = task.polls.at(-1)?.at ?? task.created_at;
      if (now >= last + step * 1000 - 250) {
        try {
          await this.poll(task);
        } catch (err) {
          task.error = String(err);
          await this.putTask(task);
        }
      }
    }
    await this.scheduleNextPoll();
  }

  // ---------- SSE experiment ----------

  /** Reads the reply stream for up to `maxMs` and reports what actually arrives on the wire. */
  private async streamExperiment(task: Task, lastEventId: string | null, maxMs: number, raw: boolean) {
    if (!task.session_id || !task.user_message_id) return json({ error: "task has no session/user message id" }, 400);
    const token = await this.accessToken();
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), maxMs);
    const frames: { t_ms: number; id?: string; event?: string; data: string }[] = [];
    let rawText = "";
    let status = 0;
    let contentType: string | null = null;
    let firstByteMs: number | undefined;
    let ended = "server closed";
    try {
      const res = await fetch(
        `${this.env.DOUBAO_API_BASE}/agent/v1/sessions/${task.session_id}/events/${task.user_message_id}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "text/event-stream",
            ...(lastEventId ? { "last-event-id": lastEventId } : {}),
          },
          signal: controller.signal,
        },
      );
      status = res.status;
      contentType = res.headers.get("content-type");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        firstByteMs ??= Date.now() - started;
        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        buffer += chunk.replace(/\r\n/g, "\n");
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const frame: { t_ms: number; id?: string; event?: string; data: string } = { t_ms: Date.now() - started, data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith("id:")) frame.id = line.slice(3).trim();
            else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
            else if (line.startsWith("data:")) frame.data += line.slice(5).trim();
          }
          frames.push(frame);
        }
      }
      if (buffer.trim()) frames.push({ t_ms: Date.now() - started, event: "(unparsed tail)", data: buffer.slice(0, 500) });
    } catch (err) {
      ended = controller.signal.aborted ? `aborted after ${maxMs}ms` : `threw: ${String(err)}`;
    } finally {
      clearTimeout(timer);
    }
    const gaps = frames.slice(1).map((f, i) => f.t_ms - frames[i].t_ms);
    const summary = {
      status,
      content_type: contentType,
      ended,
      total_ms: Date.now() - started,
      first_byte_ms: firstByteMs,
      frame_count: frames.length,
      max_gap_ms: gaps.length ? Math.max(...gaps) : 0,
      event_counts: frames.reduce<Record<string, number>>((acc, f) => {
        const k = f.event ?? "(no event)";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      last_event_id: [...frames].reverse().find((f) => f.id)?.id,
    };
    await this.log({
      at: started,
      label: "event.stream",
      method: "GET",
      url: `/agent/v1/sessions/${task.session_id}/events/${task.user_message_id}`,
      status,
      ms: summary.total_ms,
      body: JSON.stringify(summary),
    });
    if (raw) return new Response(rawText, { headers: { "content-type": "text/plain; charset=utf-8" } });
    return json({ summary, frames: frames.map((f) => ({ ...f, data: f.data.slice(0, 300) })) });
  }

  // ---------- router ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;
    try {
      if (p === "/" && method === "GET") return json({ routes: ROUTES });
      if (p === "/oauth/start") return this.oauthStart(url.origin);
      if (p === "/oauth/callback") return this.oauthCallback(url);

      if (p === "/probe") {
        // Reachability and latency without credentials. `colo` shows which Cloudflare location made the call.
        const results = [];
        for (const target of [
          `${this.env.DOUBAO_API_BASE}/agent/v1/sessions`,
          `${this.env.DOUBAO_ACCOUNTS_BASE}/oauth/v3/token`,
          "https://open.feishu.cn/open-apis/agent/v1/sessions",
        ]) {
          for (let i = 0; i < 3; i++) {
            const r = await this.call("probe", target);
            results.push({ target, status: r.status, ms: r.ms, body: r.text.slice(0, 160) });
          }
        }
        return json({ cf: (request as any).cf?.colo, results });
      }

      if (p === "/token" && method === "GET") {
        const token = await this.ctx.storage.get<Token>("token");
        return json(token ? tokenMeta(token) : { authorized: false });
      }
      if (p === "/token/refresh" && method === "POST") {
        // ?parallel=N fires N concurrent refreshes to prove the single-flight guard holds.
        const n = Math.min(Number(url.searchParams.get("parallel") ?? 1), 10);
        const results = await Promise.allSettled(Array.from({ length: n }, () => this.refresh()));
        const token = await this.ctx.storage.get<Token>("token");
        return json({
          outcomes: results.map((r) => (r.status === "fulfilled" ? "ok" : String(r.reason))),
          token: token && tokenMeta(token),
        });
      }

      if (p === "/tasks" && method === "POST") {
        const body = (await request.json()) as { text: string; name?: string };
        const name = (body.name ?? `[spike] ${body.text}`).slice(0, 60);
        return json(await this.dispatch(body.text, name));
      }
      if (p === "/tasks" && method === "GET") {
        return json(
          (await this.listTasks())
            .sort((a, b) => b.created_at - a.created_at)
            .map((t) => ({
              id: t.id,
              name: t.name,
              state: t.state,
              session_id: t.session_id,
              polls: t.polls.length,
              detect_ms: t.detected_at ? t.detected_at - t.created_at : undefined,
            })),
        );
      }

      const m = p.match(/^\/tasks\/([^/]+)(?:\/(\w+))?$/);
      if (m) {
        const task = await this.getTask(m[1]);
        if (!task) return json({ error: "no such task" }, 404);
        const action = m[2];
        if (!action && method === "GET") return json(task);
        if (action === "poll" && method === "POST") {
          await this.poll(task);
          return json(await this.getTask(task.id));
        }
        if (action === "stream" && method === "GET") {
          const maxMs = Math.min(Number(url.searchParams.get("max_ms") ?? 120_000), 600_000);
          return this.streamExperiment(task, url.searchParams.get("last_event_id"), maxMs, url.searchParams.has("raw"));
        }
        if (action === "message" && method === "POST") {
          // Sent while a reply is in progress, this should return HTTP 409.
          const body = (await request.json()) as { text: string; uuid?: string };
          const res = await this.api("event.message", `/agent/v1/sessions/${task.session_id}/events`, {
            method: "POST",
            body: JSON.stringify({
              uuid: body.uuid ?? crypto.randomUUID(),
              events: [{ type: "user.message", contents: [{ type: "text", text: body.text }] }],
            }),
          });
          const sent = res.body?.data?.messages?.find((x: any) => x.role === "user");
          if (res.body?.code === 0 && sent?.id) {
            task.user_message_id = sent.id;
            task.reply_message_id = undefined;
            task.state = "running";
            task.created_at = Date.now();
            task.polls = [];
            task.detected_at = undefined;
            await this.putTask(task);
            await this.scheduleNextPoll();
          }
          return json({ status: res.status, body: res.body ?? res.text });
        }
        if (action === "interrupt" && method === "POST") {
          const res = await this.api("event.interrupt", `/agent/v1/sessions/${task.session_id}/events`, {
            method: "POST",
            body: JSON.stringify({ uuid: crypto.randomUUID(), events: [{ type: "user.interrupt" }] }),
          });
          return json({ status: res.status, body: res.body ?? res.text });
        }
        if (action === "redispatch" && method === "POST") {
          // Replays session.create with the same uuid: what does a retried dispatch get back?
          const res = await this.api("session.create.dup", "/agent/v1/sessions", {
            method: "POST",
            body: JSON.stringify({
              uuid: task.id,
              name: task.name,
              initial_events: [{ type: "user.message", contents: [{ type: "text", text: task.text }] }],
            }),
          });
          return json({ status: res.status, body: res.body ?? res.text });
        }
      }

      if (p === "/sessions" && method === "GET") {
        // Sorted by updated_at desc: could one call per user replace one poll per task?
        const res = await this.api("session.list", `/agent/v1/sessions?page_size=${url.searchParams.get("page_size") ?? 20}`);
        return json({ status: res.status, ms: res.ms, body: res.body ?? res.text });
      }

      if (p === "/log" && method === "GET") {
        const log = (await this.ctx.storage.get<Exchange[]>("log")) ?? [];
        const label = url.searchParams.get("label");
        return json(label ? log.filter((e) => e.label.startsWith(label)) : log);
      }
      if (p === "/stats" && method === "GET") {
        const log = (await this.ctx.storage.get<Exchange[]>("log")) ?? [];
        const by: Record<string, number[]> = {};
        for (const e of log) (by[`${e.label} ${e.status}`] ??= []).push(e.ms);
        return json(
          Object.fromEntries(
            Object.entries(by).map(([k, v]) => {
              const s = [...v].sort((a, b) => a - b);
              return [k, { n: s.length, p50: s[Math.floor(s.length / 2)], max: s.at(-1) }];
            }),
          ),
        );
      }
      if (p === "/reset" && method === "POST") {
        await this.ctx.storage.deleteAll();
        return json({ ok: true });
      }
      return json({ error: "not found", routes: ROUTES }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
}

function tokenMeta(t: Token) {
  return {
    authorized: true,
    scope: t.scope,
    has_refresh_token: Boolean(t.refresh_token),
    access_expires_in_s: Math.round((t.access_expires_at - Date.now()) / 1000),
    refresh_expires_in_s: t.refresh_expires_at ? Math.round((t.refresh_expires_at - Date.now()) / 1000) : undefined,
    refresh_count: t.refresh_count,
    obtained_at: new Date(t.obtained_at).toISOString(),
  };
}

/** Keeps tokens out of the log, which is readable over HTTP. */
function redact(text: string) {
  return text.replace(/"(access_token|refresh_token)"\s*:\s*"[^"]*"/g, '"$1":"***"');
}

const ROUTES = [
  "GET  /probe                         reachability + latency, no credentials needed",
  "GET  /oauth/start                   authorize as yourself (open in a browser)",
  "GET  /token                         token expiry and scopes (never the token)",
  "POST /token/refresh?parallel=N      refresh; N>1 tests concurrent refresh",
  "POST /tasks {text,name?}            create a session with a first message, then poll by alarm",
  "GET  /tasks | /tasks/:id            poll timeline and result",
  "POST /tasks/:id/poll                poll once now",
  "GET  /tasks/:id/stream?max_ms=&last_event_id=&raw   read the SSE reply stream",
  "POST /tasks/:id/message {text}      follow-up message (409 expected while a reply is running)",
  "POST /tasks/:id/interrupt           user.interrupt",
  "POST /tasks/:id/redispatch          replay session.create with the same uuid",
  "GET  /sessions                      list sessions (updated_at desc)",
  "GET  /log?label= | /stats           every HTTP exchange with Doubao, and latency per call",
  "POST /reset                         wipe the spike's storage",
];
