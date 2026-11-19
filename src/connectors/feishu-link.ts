/**
 * Feishu's long connection: instead of Feishu calling us, we hold a WebSocket open to Feishu and
 * events and card callbacks arrive over it. One Durable Object per Feishu app.
 *
 * Why: Feishu's servers do not reach Cloudflare reliably; a card callback that fails to arrive
 * loses a person's answer. A connection we open ourselves does not depend on that route.
 *
 * The object is kept in memory by the open connection. An alarm every few seconds is the
 * watchdog: it opens the connection if there is none, sends the ping Feishu expects, and closes a
 * connection that has gone quiet so it is opened afresh. A deploy or eviction drops the connection;
 * the next alarm (or the Worker's cron, as a second line) brings it back.
 *
 * What arrives here is not signed or encrypted, and need not be: it comes over a TLS connection we
 * opened to Feishu with the app's own secret. It is handled by the same code as a webhook delivery.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { registry } from "../registry";
import type { FeishuApp } from "../registry";
import { receiveFeishu } from "./feishu";
import { CONTROL, DATA, type Frame, decodeFrame, encodeFrame, headerOf } from "./feishu-frame";

const ENDPOINT = "https://open.feishu.cn/callback/ws/endpoint";
/** How often the watchdog looks. */
const WATCH_MS = 15_000;
/** Feishu says how often to ping; this is used until it has. */
const DEFAULT_PING_MS = 120_000;
/** A message can arrive in several frames; an incomplete one is dropped after this long. */
const PARTS_TTL_MS = 60_000;
const MAX_PARTS = 64;

interface LinkStats {
  connects: number;
  connected_at?: number;
  last_frame_at?: number;
  last_event_at?: number;
  events: number;
  last_error?: string;
  last_error_at?: number;
}

export class FeishuLink extends DurableObject<Env> {
  #socket?: WebSocket;
  #serviceId = 0;
  #pingEveryMs = DEFAULT_PING_MS;
  #lastPingAt = 0;
  #lastFrameAt = 0;
  #connecting = false;
  #parts = new Map<string, { parts: (Uint8Array | undefined)[]; at: number }>();

  /** Says which app this object serves and makes sure the watchdog is running. */
  async ensure(appId: string): Promise<{ connected: boolean }> {
    this.ctx.storage.kv.put("app_id", appId);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + WATCH_MS) await this.ctx.storage.setAlarm(Date.now() + 100);
    return { connected: this.#open() };
  }

  async status(): Promise<Record<string, unknown>> {
    return { app_id: this.ctx.storage.kv.get("app_id") ?? null, connected: this.#open(), ping_every_ms: this.#pingEveryMs, ...this.#stats() };
  }

  async alarm(): Promise<void> {
    const appId = this.ctx.storage.kv.get<string>("app_id");
    if (!appId) return;
    // Rearm first: whatever throws below, the watchdog keeps running.
    await this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
    const app = await registry(this.env).feishuApp(appId);
    if (!app || app.transport !== "long_connection") {
      // The app was removed or switched back to webhooks: stop.
      this.#drop("no longer wanted");
      this.ctx.storage.kv.delete("app_id");
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    for (const [id, entry] of this.#parts) if (now - entry.at > PARTS_TTL_MS) this.#parts.delete(id);
    if (!this.#open()) {
      await this.#connect(app);
      return;
    }
    // A connection that has said nothing for well over two ping periods is taken for dead.
    if (now - this.#lastFrameAt > this.#pingEveryMs * 2 + 30_000) {
      this.#drop("silent");
      await this.#connect(app);
      return;
    }
    if (now - this.#lastPingAt >= this.#pingEveryMs) this.#ping();
  }

  #open(): boolean {
    return this.#socket !== undefined && this.#socket.readyState === 1;
  }

  #stats(): LinkStats {
    return this.ctx.storage.kv.get<LinkStats>("stats") ?? { connects: 0, events: 0 };
  }

  #note(change: Partial<LinkStats>): void {
    this.ctx.storage.kv.put("stats", { ...this.#stats(), ...change });
  }

  #drop(why: string): void {
    const socket = this.#socket;
    this.#socket = undefined;
    try {
      socket?.close(1000, why);
    } catch {
      // Already closed.
    }
  }

  async #connect(app: FeishuApp): Promise<void> {
    if (this.#connecting) return;
    this.#connecting = true;
    try {
      const discovery = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", locale: "zh" },
        body: JSON.stringify({ AppID: app.app_id, AppSecret: app.app_secret }),
      });
      const found = (await discovery.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { URL?: string; ClientConfig?: { PingInterval?: number } } };
      if (!discovery.ok || found.code !== 0 || !found.data?.URL) throw new Error(`Feishu did not give a connection address: ${discovery.status} code ${found.code} ${String(found.msg).slice(0, 200)}`);
      const address = new URL(found.data.URL);
      this.#serviceId = Number(address.searchParams.get("service_id") ?? 0);
      if (found.data.ClientConfig?.PingInterval) this.#pingEveryMs = found.data.ClientConfig.PingInterval * 1_000;

      address.protocol = address.protocol === "ws:" ? "http:" : "https:";
      const response = await fetch(address.toString(), { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      if (!socket) throw new Error(`Feishu refused the connection: ${response.status}`);
      socket.accept();
      socket.addEventListener("message", (event) => {
        this.ctx.waitUntil(this.#onMessage(socket, event.data).catch((err) => this.#note({ last_error: `frame: ${String(err).slice(0, 200)}`, last_error_at: Date.now() })));
      });
      const gone = () => {
        if (this.#socket === socket) this.#socket = undefined;
      };
      socket.addEventListener("close", gone);
      socket.addEventListener("error", gone);
      this.#socket = socket;
      this.#lastFrameAt = Date.now();
      this.#lastPingAt = 0;
      this.#note({ connects: this.#stats().connects + 1, connected_at: Date.now() });
      this.#ping();
    } catch (err) {
      this.#note({ last_error: String(err).slice(0, 300), last_error_at: Date.now() });
      console.log(JSON.stringify({ feishu_link_not_connected: String(err).slice(0, 300), app: app.app_id }));
    } finally {
      this.#connecting = false;
    }
  }

  #send(frame: Frame): void {
    if (this.#open()) this.#socket?.send(encodeFrame(frame));
  }

  #ping(): void {
    this.#lastPingAt = Date.now();
    this.#send({ seqId: 0n, logId: 0n, service: this.#serviceId, method: CONTROL, headers: [{ key: "type", value: "ping" }] });
  }

  async #onMessage(socket: WebSocket, data: unknown): Promise<void> {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : typeof data === "string" ? new TextEncoder().encode(data) : undefined;
    if (!bytes) return;
    const frame = decodeFrame(bytes);
    this.#lastFrameAt = Date.now();
    if (frame.method === CONTROL) {
      // A pong can carry new settings.
      if (headerOf(frame, "type") === "pong" && frame.payload?.length) {
        try {
          const settings = JSON.parse(new TextDecoder().decode(frame.payload)) as { PingInterval?: number };
          if (settings.PingInterval && settings.PingInterval > 0) this.#pingEveryMs = settings.PingInterval * 1_000;
        } catch {
          // Not settings; nothing to do.
        }
      }
      return;
    }
    if (frame.method !== DATA) return;
    const type = headerOf(frame, "type");
    if (type !== "event" && type !== "card") return;
    const payload = this.#whole(frame);
    if (!payload) return;

    const started = Date.now();
    const reply: { code: number; data?: string } = { code: 200 };
    try {
      const body = JSON.parse(new TextDecoder().decode(payload));
      const appId = this.ctx.storage.kv.get<string>("app_id") ?? "";
      const app = await registry(this.env).feishuApp(appId);
      if (!app || body?.header?.app_id !== app.app_id) throw new Error("the message is not for this app");
      const answer = await receiveFeishu(this.env, app, body, (work) => this.ctx.waitUntil(work));
      // Only a card callback has an answer Feishu shows to anyone.
      if (body?.header?.event_type === "card.action.trigger") reply.data = base64(JSON.stringify(answer));
      this.#note({ events: this.#stats().events + 1, last_event_at: Date.now() });
    } catch (err) {
      // Told to Feishu as a failure, so that an event is delivered again.
      reply.code = 500;
      this.#note({ last_error: `handling: ${String(err).slice(0, 200)}`, last_error_at: Date.now() });
    }
    if (socket.readyState === 1) {
      socket.send(encodeFrame({ ...frame, headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - started) }], payload: new TextEncoder().encode(JSON.stringify(reply)) }));
    }
  }

  /** Puts a message that came in several frames back together; returns it once it is complete. */
  #whole(frame: Frame): Uint8Array | undefined {
    const sum = Number(headerOf(frame, "sum") ?? 1);
    const seq = Number(headerOf(frame, "seq") ?? 0);
    const id = headerOf(frame, "message_id") ?? "";
    const part = frame.payload ?? new Uint8Array();
    if (!Number.isInteger(sum) || sum <= 1) return part;
    if (sum > MAX_PARTS || !Number.isInteger(seq) || seq < 0 || seq >= sum || !id) return undefined;
    const entry = this.#parts.get(id) ?? { parts: new Array<Uint8Array | undefined>(sum).fill(undefined), at: Date.now() };
    if (entry.parts.length !== sum) return undefined;
    entry.parts[seq] = part;
    this.#parts.set(id, entry);
    if (entry.parts.some((p) => p === undefined)) return undefined;
    this.#parts.delete(id);
    const whole = new Uint8Array(entry.parts.reduce((n, p) => n + (p?.length ?? 0), 0));
    let at = 0;
    for (const p of entry.parts) {
      whole.set(p as Uint8Array, at);
      at += (p as Uint8Array).length;
    }
    return whole;
  }
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
