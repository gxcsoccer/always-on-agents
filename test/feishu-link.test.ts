import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL, DATA, type Frame, decodeFrame, encodeFrame, headerOf } from "../src/connectors/feishu-frame";

const registry = () => (env as any).REGISTRY.getByName("global");
let counter = 0;

/** A stand-in for Feishu: answers endpoint discovery here, and holds the other end of the connection in an object of its own. */
function fakeFeishu(options: { discovery?: unknown; address?: string } = {}) {
  const peerName = `peer-${++counter}`;
  const peer = (env as any).FAKE_FEISHU.getByName(peerName) as any;
  const state = { discoveries: 0, secrets: [] as string[] };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://open.feishu.cn/callback/ws/endpoint") {
      state.discoveries += 1;
      state.secrets.push(JSON.parse(String(init?.body)).AppSecret);
      return Response.json(options.discovery ?? { code: 0, data: { URL: options.address ?? "wss://msg-frontier.feishu.cn/ws/v2?device_id=1&service_id=7", ClientConfig: { PingInterval: 120 } } });
    }
    // The handle is made where it is used: this runs inside the connection object, not the test.
    if (url.startsWith("https://msg-frontier.feishu.cn/")) return (env as any).FAKE_FEISHU.getByName(peerName).fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
    throw new Error(`unexpected fetch to ${url}`);
  });
  const received = async (): Promise<Frame[]> => ((await peer.received()) as number[][]).map((bytes) => decodeFrame(Uint8Array.from(bytes)));
  const waitFor = async (count: number): Promise<Frame[]> => {
    for (let i = 0; i < 150; i++) {
      const frames = await received();
      if (frames.length >= count) return frames;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${count} frames`);
  };
  const send = (bytes: Uint8Array) => peer.send([...bytes]) as Promise<void>;
  const data = (type: string, body: unknown) =>
    encodeFrame({ seqId: 5n, logId: 6n, service: 7, method: DATA, headers: [{ key: "type", value: type }, { key: "message_id", value: `m-${++counter}` }, { key: "sum", value: "1" }, { key: "seq", value: "0" }], payload: new TextEncoder().encode(JSON.stringify(body)) });
  return { state, peer, waitFor, send, data };
}

async function linkedApp(transport: "long_connection" | "webhook" = "long_connection") {
  const tenant = `link${++counter}`;
  await registry().createTenant(tenant, tenant);
  const appId = `cli_${tenant}`;
  await registry().setFeishuApp(tenant, { app_id: appId, app_secret: "the-secret", encrypt_key: "k", bot_open_id: "ou_bot", transport });
  const link = (env as any).FEISHU_LINKS.getByName(appId) as any;
  return { tenant, appId, link };
}

const message = (appId: string, id: string, text: string) => ({
  schema: "2.0",
  header: { event_id: `ev-${id}`, event_type: "im.message.receive_v1", app_id: appId, tenant_key: "org" },
  event: { sender: { sender_type: "user", tenant_key: "org", sender_id: { open_id: "ou_frank" } }, message: { message_id: id, chat_id: "oc_dm", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
});

afterEach(() => vi.unstubAllGlobals());

describe("the Feishu long connection", () => {
  it("connects with the app's secret, pings, takes an event in and acknowledges it", async () => {
    const feishu = fakeFeishu();
    const { tenant, appId, link } = await linkedApp();
    await link.ensure(appId, true);
    await runDurableObjectAlarm(link);
    const [ping] = await feishu.waitFor(1);
    expect(feishu.state.secrets).toEqual(["the-secret"]);
    // The first thing sent is the ping, addressed to the service Feishu named.
    expect(ping).toMatchObject({ method: CONTROL, service: 7 });
    expect(headerOf(ping, "type")).toBe("ping");
    expect(await link.status()).toMatchObject({ connected: true, connects: 1 });

    // An event arrives as a binary frame; it reaches the person's own conversation and is acknowledged.
    await feishu.send(feishu.data("event", message(appId, "om_1", "hello over the link")));
    const ack = (await feishu.waitFor(2))[1];
    expect(ack).toMatchObject({ method: DATA, seqId: 5n, logId: 6n });
    expect(headerOf(ack, "biz_rt")).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(ack.payload))).toEqual({ code: 200 });
    const scope = await (env as any).BRAIN.getByName(`${tenant}:user:ou_frank`).inspect();
    expect(scope.recent_events[0]).toMatchObject({ kind: "message", text: "hello over the link" });
    expect(await link.status()).toMatchObject({ events: 1 });
  });

  it("answers a card press with what Feishu should show, and only after the press is filed", async () => {
    const feishu = fakeFeishu();
    const { tenant, appId, link } = await linkedApp();
    await link.ensure(appId, true);
    await runDurableObjectAlarm(link);
    await feishu.waitFor(1);
    const press = {
      schema: "2.0",
      header: { event_id: "press-1", event_type: "card.action.trigger", app_id: appId, tenant_key: "org" },
      event: { operator: { open_id: "ou_frank", tenant_key: "org" }, action: { value: { aoa: "answer", decision: "deny", code: "K7PW", q: "ask:11111111-2222-3333-4444-555555555555:1", to: "user" } }, context: { open_chat_id: "oc_dm" } },
    };
    // Sent as type "card" here; Feishu's newer callbacks come as "event". Both are taken.
    await feishu.send(feishu.data("card", press));
    const answer = JSON.parse(new TextDecoder().decode((await feishu.waitFor(2))[1].payload));
    expect(answer.code).toBe(200);
    const shown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(answer.data), (c) => c.charCodeAt(0))));
    expect(shown.toast).toMatchObject({ type: "info" });
    expect(shown.toast.content).toContain("已收到你的选择：拒绝");
    const scope = await (env as any).BRAIN.getByName(`${tenant}:user:ou_frank`).inspect();
    expect(scope.recent_events[0]).toMatchObject({ kind: "message", text: "deny K7PW" });
  });

  it("puts a message that came in pieces back together, and tells Feishu to redeliver what it cannot handle", async () => {
    const feishu = fakeFeishu();
    const { tenant, appId, link } = await linkedApp();
    await link.ensure(appId, true);
    await runDurableObjectAlarm(link);
    await feishu.waitFor(1);
    const whole = new TextEncoder().encode(JSON.stringify(message(appId, "om_2", "in two parts")));
    const half = Math.floor(whole.length / 2);
    const piece = (seq: number, bytes: Uint8Array) => encodeFrame({ seqId: 1n, logId: 1n, service: 7, method: DATA, headers: [{ key: "type", value: "event" }, { key: "message_id", value: "split-1" }, { key: "sum", value: "2" }, { key: "seq", value: String(seq) }], payload: bytes });
    await feishu.send(piece(1, whole.subarray(half)));
    await feishu.send(piece(0, whole.subarray(0, half)));
    expect(JSON.parse(new TextDecoder().decode((await feishu.waitFor(2))[1].payload))).toEqual({ code: 200 });
    expect((await (env as any).BRAIN.getByName(`${tenant}:user:ou_frank`).inspect()).recent_events[0]).toMatchObject({ text: "in two parts" });

    // A message for some other app, or one that is not JSON, is refused so that it comes again
    // (or is seen to fail), and nothing of it is kept in the status.
    await feishu.send(feishu.data("event", message("cli_someone_else", "om_3", "not ours")));
    expect(JSON.parse(new TextDecoder().decode((await feishu.waitFor(3))[2].payload))).toEqual({ code: 500 });
    const status = await link.status();
    expect(status.trouble).toBe("handling_failed");
    expect(JSON.stringify(status)).not.toContain("not ours");
    expect(JSON.stringify(status)).not.toContain("the-secret");
  });

  it("only follows an encrypted address on a Feishu host, and backs off when refused", async () => {
    for (const address of ["wss://evil.example/ws?service_id=1", "ws://msg-frontier.feishu.cn/ws?service_id=1", "wss://feishu.cn.evil.example/ws"]) {
      const feishu = fakeFeishu({ address });
      const { appId, link } = await linkedApp();
      await link.ensure(appId, true);
      await runDurableObjectAlarm(link);
      const status = await link.status();
      expect(status).toMatchObject({ connected: false, trouble: "address_not_feishu" });
      expect(await feishu.peer.connected()).toBe(false);
      vi.unstubAllGlobals();
    }
    // Rejected credentials: not asked again every few seconds.
    const feishu = fakeFeishu({ discovery: { code: 1000040345, msg: "secret=the-secret is wrong" } });
    const { appId, link } = await linkedApp();
    await link.ensure(appId, true);
    await runDurableObjectAlarm(link);
    await runDurableObjectAlarm(link);
    await runDurableObjectAlarm(link);
    expect(feishu.state.discoveries).toBe(1);
    const status = await link.status();
    expect(status).toMatchObject({ connected: false, trouble: "credentials_rejected", trouble_code: 1000040345 });
    expect(status.retry_at - Date.now()).toBeGreaterThan(10 * 60_000);
    expect(JSON.stringify(status)).not.toContain("the-secret");
  });

  it("serves an app through one way in only", async () => {
    const feishu = fakeFeishu();
    // Set to the long connection: the webhook address refuses it.
    const linked = await linkedApp("long_connection");
    const refused = await (env as any).REGISTRY.getByName("global").feishuApp(linked.appId);
    expect(refused.transport).toBe("long_connection");
    const { default: worker } = await import("./entry");
    const viaWebhook = await (worker as any).fetch(new Request(`https://agent.test/v1/feishu/events/${linked.appId}`, { method: "POST", body: JSON.stringify({ encrypt: "AAAA" }) }), env);
    expect(viaWebhook.status).toBe(401);
    // Set to the webhook: the object does not connect, and stops watching.
    const hooked = await linkedApp("webhook");
    await hooked.link.ensure(hooked.appId, true);
    await runDurableObjectAlarm(hooked.link);
    expect(await hooked.link.status()).toMatchObject({ connected: false, app_id: null });
    expect(feishu.state.discoveries).toBe(0);
  });
});
