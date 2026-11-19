// pi extension: holds risky tool calls until the Worker answers.
//
// It runs inside the pi process, so it can simply await the answer. The answer lives in the task's
// Durable Object and is fetched over brain.internal; nothing in the container's filesystem decides.
// If this handler throws, pi blocks the tool call, so every failure here fails closed.
import { appendFileSync } from "node:fs";

const TASK_DIRECTORY = process.env.TASK_DIRECTORY ?? "/workspace/job/task";
const WAIT_SECONDS = Number(process.env.GATE_WAIT_SECONDS ?? 3300);
const POLL_MS = Number(process.env.GATE_POLL_MS ?? 2000);
// Nothing a command does inside the sandbox outlives the sandbox, so by default nothing here needs
// a person: deleting a directory the agent made a minute ago is not a decision for anyone. What
// does reach the outside (a push, any network request) is decided by the Worker's outbound proxy,
// which sees the real request rather than the text of a command. A deployment that wants a person
// asked about some local commands all the same can name them with GATE_HOLD_PATTERN.
const RISKY = process.env.GATE_HOLD_PATTERN ? new RegExp(process.env.GATE_HOLD_PATTERN) : undefined;

async function ask(kind: string, body: unknown): Promise<{ ok: boolean; decision?: string; reason?: string }> {
  const response = await fetch(`http://brain.internal/callback/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-task-id": process.env.TASK_ID ?? "",
      "x-task-token": process.env.TASK_PASS ?? "",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return (await response.json()) as { ok: boolean; decision?: string; reason?: string };
}

function log(entry: Record<string, unknown>) {
  try {
    appendFileSync(`${TASK_DIRECTORY}/hooks.jsonl`, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  } catch {
    // The log is for debugging; it must never decide the outcome.
  }
}

export default function (pi: any) {
  pi.on("tool_call", async (event: any) => {
    const command = event.toolName === "bash" ? String(event.input?.command ?? "") : "";
    const risky = RISKY !== undefined && RISKY.test(command);
    const entry = {
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      input_keys: Object.keys(event.input ?? {}),
      command: command.slice(0, 200),
      risky,
    };
    if (!risky) {
      log({ ...entry, decision: "none" });
      return undefined;
    }

    const call = { tool_use_id: event.toolCallId, tool_name: event.toolName, command };
    const asked = await ask("needs_input", call).catch(() => ({ ok: false }));
    if (!asked.ok) {
      log({ ...entry, decision: "block", why: "could not reach a reviewer" });
      return { block: true, reason: "Could not reach a reviewer, so this command was not run." };
    }
    log({ ...entry, decision: "waiting" });

    const deadline = Date.now() + WAIT_SECONDS * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      // A failed poll is not an answer; keep waiting.
      const reply = await ask("decision", call).catch(() => undefined);
      if (reply?.decision === "allow") {
        log({ ...entry, decision: "allow", waited_ms: Date.now() - (deadline - WAIT_SECONDS * 1000) });
        return undefined;
      }
      if (reply?.decision === "deny") {
        log({ ...entry, decision: "deny", reason: reply.reason });
        return { block: true, reason: `Denied by reviewer: ${reply.reason || "no reason given"}` };
      }
    }
    // Tell the Worker the question is withdrawn, so it stops showing as open.
    await ask("gate_timeout", call).catch(() => undefined);
    log({ ...entry, decision: "block", why: "timeout" });
    return { block: true, reason: "No reviewer answered in time, so this command was not run." };
  });
}
