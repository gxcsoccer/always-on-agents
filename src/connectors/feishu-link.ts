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
 * What arrives here is not signed or encrypted, and need not be: it comes over a TLS connection
 * that this object opened, to a Feishu host, at an address Feishu gave in exchange for the app's
 * own secret. Who is at the other end is settled by that, not by anything inside a message. It is
 * then handled by the same code as a webhook delivery.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { registry } from "../registry";
import type { FeishuApp } from "../registry";
import { receiveFeishu } from "./feishu";
import { CONTROL, DATA, type Frame, decodeFrame, encodeFrame, headerOf } from "./feishu-frame";

const ENDPOINT = "https://open.feishu.cn/callback/ws/endpoint";
/** The connection address Feishu returns must be on one of its own hosts. */
const FEISHU_HOST = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/;
/** How often the watchdog looks. */
const WATCH_MS = 15_000;
/** Feishu says how often to ping; this is used until it has. */
const DEFAULT_PING_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** After a failed attempt the next one waits this long, doubling up to the limit, with some spread. */
const RETRY_FIRST_MS = 15_000;
const RETRY_LIMIT_MS = 10 * 60_000;
/** Feishu rejecting the app's credentials will not mend itself: look again only now and then. */
const RETRY_REJECTED_MS = 30 * 60_000;
/** A message can arrive in several frames; an incomplete one is dropped after this long. */
const PARTS_TTL_MS = 60_000;
const MAX_PARTS = 64;
const MAX_PARTIAL_MESSAGES = 32;
const MAX_BUFFERED_BYTES = 2_000_000;
const MAX_FRAME_BYTES = 1_000_000;
/** Messages being handled at once. Beyond this Feishu is told to deliver again later. */
const MAX_IN_FLIGHT = 16;

/** Why something went wrong, as one of a fixed set of words: never text that came from outside. */
type Trouble = "discovery_unreachable" | "discovery_refused" | "credentials_rejected" | "address_not_feishu" | "upgrade_refused" | "frame_invalid" | "handling_failed" | "too_busy";

interface LinkStats {
  connects: number;
  connected_at?: number;
  last_frame_at?: number;
  last_event_at?: number;
  events: number;
  failures: number;
  trouble?: Trouble;
  /** A number that goes with the trouble (an HTTP status or Feishu's code), if there is one. */
  trouble_code?: number;
  trouble_at?: number;
  retry_at?: number;
}

export class FeishuLink extends DurableObject<Env> {
  #socket?: WebSocket;
  #serviceId = 0;
  #pingEveryMs = DEFAULT_PING_MS;
  #lastPingAt = 0;
  #lastFrameAt = 0;
  #connecting = false;
  #inFlight = 0;
  #parts = new Map<string, { parts: (Uint8Array | undefined)[]; bytes: number; at: number }>();

  /**
   * Says which app this object serves and makes sure the watchdog is running. `fresh` is passed
   * when the app's registration has just been written: whatever went wrong before is forgotten.
   */
  async ensure(appId: string, fresh = false): Promise<{ connected: boolean }> {
    this.ctx.storage.kv.put("app_id", appId);
    if (fresh) this.#note({ failures: 0, retry_at: undefined, trouble: undefined, trouble_code: undefined });
    const alarm = await this.ctx.storage.getAlarm();
    if (fresh || alarm === null || alarm > Date.now() + WATCH_MS) await this.ctx.storage.setAlarm(Date.now() + 100);
    return { connected: this.#open() };
  }

  async status(): Promise<Record<string, unknown>> {
    return { app_id: this.ctx.storage.kv.get("app_id") ?? null, connected: this.#open(), ping_every_ms: this.#pingEveryMs, in_flight: this.#inFlight, ...this.#stats() };
  }

  async alarm(): Promise<void> {
    const appId = this.ctx.storage.kv.get<string>("app_id");
    if (!appId) return;
    // Rearm first: whatever throws below, the watchdog keeps running.
    await this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
    const app = await this.#wanted(appId);
    if (!app) {
      // The app was removed or switched back to webhooks: stop.
      this.#drop();
      this.ctx.storage.kv.delete("app_id");
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    for (const [id, entry] of this.#parts) if (now - entry.at > PARTS_TTL_MS) this.#parts.delete(id);
    if (this.#open()) {
      // A connection that has said nothing for well over two ping periods is taken for dead.
      if (now - this.#lastFrameAt <= this.#pingEveryMs * 2 + 30_000) {
        if (now - this.#lastPingAt >= this.#pingEveryMs) this.#ping();
        return;
      }
      this.#drop();
    }
    if ((this.#stats().retry_at ?? 0) > now) return;
    await this.#connect(app);
  }

  /** The app, if it exists and its events are meant to arrive over this connection. */
  async #wanted(appId: string): Promise<FeishuApp | undefined> {
    const app = await registry(this.env).feishuApp(appId);
    return app && app.transport === "long_connection" ? app : undefined;
  }

  #open(): boolean {
    return this.#socket !== undefined && this.#socket.readyState === 1;
  }

  #stats(): LinkStats {
    return { connects: 0, events: 0, failures: 0, ...(this.ctx.storage.kv.get<LinkStats>("stats") ?? {}) };
  }

  #note(change: Partial<LinkStats>): void {
    this.ctx.storage.kv.put("stats", { ...this.#stats(), ...change });
  }

  #trouble(trouble: Trouble, code?: number): void {
    this.#note({ trouble, trouble_code: code, trouble_at: Date.now() });
    console.log(JSON.stringify({ feishu_link: trouble, code: code ?? null, app: this.ctx.storage.kv.get("app_id") ?? null }));
  }

  /** Records a failed attempt to connect and when the next one may be made. */
  #failed(trouble: Trouble, code?: number): void {
    const failures = this.#stats().failures + 1;
    const wait = trouble === "credentials_rejected" || trouble === "address_not_feishu" ? RETRY_REJECTED_MS : Math.min(RETRY_FIRST_MS * 2 ** Math.min(failures - 1, 10), RETRY_LIMIT_MS);
    // Spread out, so that many objects failing together do not all come back together.
    this.#note({ failures, retry_at: Date.now() + Math.round(wait * (0.75 + Math.random() * 0.5)) });
    this.#trouble(trouble, code);
  }

  #drop(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#parts.clear();
    try {
      socket?.close(1000, "closing");
    } catch {
      // Already closed.
    }
  }

  async #connect(app: FeishuApp): Promise<void> {
    if (this.#connecting) return;
    this.#connecting = true;
    try {
      let discovery: Response;
      try {
        discovery = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", locale: "zh" },
          body: JSON.stringify({ AppID: app.app_id, AppSecret: app.app_secret }),
          redirect: "error",
          signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
        });
      } catch {
        return this.#failed("discovery_unreachable");
      }
      const found = (await discovery.json().catch(() => ({}))) as { code?: number; data?: { URL?: string; ClientConfig?: { PingInterval?: number } } };
      if (!discovery.ok) return this.#failed("discovery_refused", discovery.status);
      // Feishu answers 200 with its own code: 0 is success, 1 is a fault on its side, anything
      // else says the request itself is not acceptable (wrong secret, long connection not allowed).
      if (found.code !== 0 || !found.data?.URL) return this.#failed(found.code === 1 ? "discovery_refused" : "credentials_rejected", Number.isInteger(found.code) ? found.code : undefined);

      let address: URL;
      try {
        address = new URL(found.data.URL);
      } catch {
        return this.#failed("address_not_feishu");
      }
      // Encrypted, and to Feishu: the secret was sent to open.feishu.cn, and what comes back is
      // only followed if it stays within Feishu's own names.
      if (address.protocol !== "wss:" || !FEISHU_HOST.test(address.hostname)) return this.#failed("address_not_feishu");
      this.#serviceId = Number(address.searchParams.get("service_id") ?? 0);
      const interval = found.data.ClientConfig?.PingInterval;
      if (typeof interval === "number" && interval > 0 && interval < 3_600) this.#pingEveryMs = interval * 1_000;

      address.protocol = "https:";
      let response: Response;
      try {
        response = await fetch(address.toString(), { headers: { Upgrade: "websocket" }, redirect: "error", signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      } catch {
        return this.#failed("discovery_unreachable");
      }
      const socket = response.webSocket;
      if (!socket) return this.#failed("upgrade_refused", response.status);
      // The registration may have changed while this was being set up.
      if (!(await this.#wanted(app.app_id))) {
        socket.accept();
        socket.close(1000, "closing");
        return;
      }
      // Frames are binary. Asked for as array buffers: the default hands them over as blobs.
      socket.binaryType = "arraybuffer";
      socket.accept();
      socket.addEventListener("message", (event) => {
        this.ctx.waitUntil(this.#onMessage(socket, event.data).catch(() => this.#trouble("frame_invalid")));
      });
      const gone = () => {
        if (this.#socket === socket) this.#socket = undefined;
      };
      socket.addEventListener("close", gone);
      socket.addEventListener("error", gone);
      this.#drop();
      this.#socket = socket;
      this.#lastFrameAt = Date.now();
      this.#lastPingAt = 0;
      this.#note({ connects: this.#stats().connects + 1, connected_at: Date.now(), failures: 0, retry_at: undefined, trouble: undefined, trouble_code: undefined });
      this.#ping();
    } finally {
      this.#connecting = false;
    }
  }

  #ping(): void {
    this.#lastPingAt = Date.now();
    if (this.#open()) this.#socket?.send(encodeFrame({ seqId: 0n, logId: 0n, service: this.#serviceId, method: CONTROL, headers: [{ key: "type", value: "ping" }] }));
  }

  async #onMessage(socket: WebSocket, data: unknown): Promise<void> {
    // Only the connection in use speaks: one that was replaced may still deliver what it had queued.
    if (socket !== this.#socket) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : undefined;
    if (!bytes || bytes.length > MAX_FRAME_BYTES) return this.#trouble("frame_invalid");
    const frame = decodeFrame(bytes);
    this.#lastFrameAt = Date.now();
    this.#note({ last_frame_at: this.#lastFrameAt });
    if (frame.method === CONTROL) {
      // A pong can carry new settings.
      if (headerOf(frame, "type") === "pong" && frame.payload?.length) {
        try {
          const settings = JSON.parse(new TextDecoder().decode(frame.payload)) as { PingInterval?: number };
          if (typeof settings.PingInterval === "number" && settings.PingInterval > 0 && settings.PingInterval < 3_600) this.#pingEveryMs = settings.PingInterval * 1_000;
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
    if (this.#inFlight >= MAX_IN_FLIGHT) {
      // Told to Feishu as a failure, so that it delivers the message again.
      reply.code = 500;
      this.#trouble("too_busy");
    } else {
      this.#inFlight += 1;
      try {
        const body = JSON.parse(new TextDecoder().decode(payload));
        const app = await this.#wanted(this.ctx.storage.kv.get<string>("app_id") ?? "");
        if (!app || body?.header?.app_id !== app.app_id) throw new Error("not for this app");
        const answer = await receiveFeishu(this.env, app, body, (work) => this.ctx.waitUntil(work));
        // Only a card callback has an answer Feishu shows to anyone.
        if (body?.header?.event_type === "card.action.trigger") reply.data = base64(JSON.stringify(answer));
        this.#note({ events: this.#stats().events + 1, last_event_at: Date.now() });
      } catch {
        reply.code = 500;
        this.#trouble("handling_failed");
      } finally {
        this.#inFlight -= 1;
      }
    }
    if (socket === this.#socket && socket.readyState === 1) {
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
    if (sum > MAX_PARTS || !Number.isInteger(seq) || seq < 0 || seq >= sum || !id || id.length > 200) return undefined;
    let entry = this.#parts.get(id);
    if (!entry) {
      // Bounded in how many messages are half-arrived and in how much they hold between them.
      let buffered = 0;
      for (const other of this.#parts.values()) buffered += other.bytes;
      if (this.#parts.size >= MAX_PARTIAL_MESSAGES || buffered + part.length > MAX_BUFFERED_BYTES) {
        this.#trouble("too_busy");
        return undefined;
      }
      entry = { parts: new Array<Uint8Array | undefined>(sum).fill(undefined), bytes: 0, at: Date.now() };
      this.#parts.set(id, entry);
    }
    if (entry.parts.length !== sum) return undefined;
    entry.bytes += part.length - (entry.parts[seq]?.length ?? 0);
    entry.parts[seq] = part;
    if (entry.bytes > MAX_BUFFERED_BYTES) {
      this.#parts.delete(id);
      return undefined;
    }
    if (entry.parts.some((p) => p === undefined)) return undefined;
    this.#parts.delete(id);
    const whole = new Uint8Array(entry.bytes);
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
