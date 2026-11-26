// pi extension. Two things.
//
// Notes: what the person who asked for this work says while it is under way is kept by the task's
// Durable Object, and brought into the session here, at the points where the agent can take it
// (after a step's tools have run, and once more before it would end). See "notes" below.
//
// The gate: holds a shell command until a person has answered, for commands the deployment
// has asked to be reviewed (GATE_HOLD_PATTERN). By default nothing is held here.
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

// Where the task's Durable Object is reached. Only ever set otherwise by a test that runs this file outside a sandbox.
const BRAIN = process.env.GATE_BRAIN_URL ?? "http://brain.internal";

async function ask(kind: string, body: unknown, timeoutMs = 20_000): Promise<{ ok: boolean; decision?: string; reason?: string; notes?: { id: string; text: string }[] }> {
  const response = await fetch(`${BRAIN}/callback/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-task-id": process.env.TASK_ID ?? "",
      "x-task-token": process.env.TASK_PASS ?? "",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as { ok: boolean; decision?: string; reason?: string; notes?: { id: string; text: string }[] };
}

function log(entry: Record<string, unknown>) {
  try {
    appendFileSync(`${TASK_DIRECTORY}/hooks.jsonl`, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  } catch {
    // The log is for debugging; it must never decide the outcome.
  }
}

// ---------- notes ----------
//
// The task keeps what it was told; this fetches what the session does not hold yet. Fetching uses
// nothing up: every time, the ids already in the session are sent, and the task answers with those
// it has taken that are not among them. So an answer that is lost is simply had again, a session
// restored from an earlier copy gets what it lacks, and nothing is ever in one session twice.
//
// A note in the session shows that it was written into this conversation; not that the model has
// acted on it. The last fetch (`final`) is where the task stops taking notes for this run, once it
// has none left to give.
const NOTE = "task-note";
const TASK = process.env.TASK_ID ?? "";
// Which run of the agent this process is: fixed by the task before the process is started. The task
// answers only the run it has now, so a process left over from before a recovery gets nothing and closes nothing.
const RUN = process.env.TASK_RUN ?? "";
const NOTES_TIMEOUT_MS = Number(process.env.GATE_NOTES_TIMEOUT_MS ?? 4_000);
const NOTE_PREAMBLE =
  "[Added by the person who asked for this work, while you were at it. Take it into account from here on. " +
  "Your last reply is still the one result of the whole task: it must hold what you had already done and found, in full, together with what comes of this.]";

/** The ids of the notes this session already holds, on the branch it is on. */
function held(ctx: any): string[] {
  try {
    return (ctx.sessionManager.getBranch() as any[])
      .filter((entry) => entry?.type === "custom_message" && entry.customType === NOTE && entry.details?.taskId === TASK)
      .flatMap((entry) => (Array.isArray(entry.details.noteIds) ? entry.details.noteIds : []))
      .map(String);
  } catch {
    return [];
  }
}

/** What to bring into the session now, as one message, or nothing. Never throws: a note that cannot be fetched now is fetched later. */
async function notes(event: any, ctx: any, final: boolean): Promise<{ entries: unknown[]; continue: true } | undefined> {
  // A step that did not go through is not continued for a note's sake: it would only be asked again and fail again.
  if (event.outcome !== "completed") return undefined;
  const have = held(ctx);
  let got: { id: string; text: string }[] | undefined;
  // The last fetch is tried a little harder: there is no later one.
  for (let attempt = 0; attempt < (final ? 3 : 1) && got === undefined; attempt++) {
    // (A moment between tries: a task object that is just being moved answers again in a few hundred milliseconds.)
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    got = await ask("notes", { run: RUN, have, final }, NOTES_TIMEOUT_MS)
      .then((reply) => (reply.ok && Array.isArray(reply.notes) ? reply.notes : undefined))
      .catch(() => undefined);
  }
  // (Asked of the session again: nothing that is in it already is written a second time, whatever the task answered.)
  const fresh = (got ?? []).filter((note) => typeof note?.id === "string" && typeof note.text === "string" && !have.includes(note.id));
  log({ notes: fresh.map((note) => note.id), final, fetched: got !== undefined });
  if (fresh.length === 0) return undefined;
  return {
    entries: [{ type: "custom_message", customType: NOTE, content: `${NOTE_PREAMBLE}\n\n${fresh.map((note) => note.text).join("\n\n")}`, display: true, details: { taskId: TASK, noteIds: fresh.map((note) => note.id) } }],
    continue: true,
  };
}

export default function (pi: any) {
  pi.on("turn_end", (event: any, ctx: any) => notes(event, ctx, false));
  pi.on("agent_before_settle", (event: any, ctx: any) => notes(event, ctx, true));

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
