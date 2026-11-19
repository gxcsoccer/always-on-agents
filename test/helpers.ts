/**
 * Shared test helpers: a scripted stand-in for the model (it replaces global fetch), builders for
 * events and model outputs, and handles on the objects under test.
 */
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";

import type { InboundEvent } from "../src/events";

type Output = Record<string, unknown>;

/** What the fake model will return, one entry per call, in order. */
const script: (Output[] | { status: number; body: string })[] = [];
/** The request bodies the Brain sent to the model. */
export const modelCalls: any[] = [];

export function installFakeModel() {
  script.length = 0;
  modelCalls.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://model.test/")) throw new Error(`unexpected fetch to ${url}`);
    modelCalls.push(JSON.parse(String(init?.body)));
    const next = script.shift();
    if (!next) throw new Error("the fake model was called more often than the test scripted");
    if (!Array.isArray(next)) return new Response(next.body, { status: next.status });
    return Response.json({ status: "completed", output: next, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  });
}

export const model = {
  replies(...outputs: Output[][]) {
    script.push(...outputs);
  },
  fails(status: number, body = "boom") {
    script.push({ status, body });
  },
  remaining: () => script.length,
};

let callCounter = 0;
export const call = (name: string, args: Record<string, unknown>, id = `call_${++callCounter}`): Output => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: id,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});
export const say = (text: string): Output => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

let eventCounter = 0;
export function message(text: string, overrides: Partial<InboundEvent> & { user?: string } = {}): InboundEvent {
  const { user = "alice", ...rest } = overrides;
  return {
    source: "test",
    source_id: `e${++eventCounter}`,
    kind: "message",
    session_key: "dm",
    principal: { kind: "human", id: user, explicit: true },
    text,
    reply_to: { connector: "console", address: {} },
    ...rest,
  };
}

let scopeCounter = 0;
/** A fresh scope per test, so tests cannot see each other's state. */
export function brain(kind: "user" | "chat" | "repo" = "user") {
  const name = `t${++scopeCounter}:${kind}:${kind === "repo" ? "acme/demo" : "x"}`;
  return { name, stub: (env as any).BRAIN.getByName(name) as any };
}

/** Runs the Brain's wake-up now instead of waiting for the alarm. Returns false if none was due. */
export const wake = (stub: any) => runDurableObjectAlarm(stub);

export const task = (id: string) => (env as any).TASKS.getByName(id) as any;
