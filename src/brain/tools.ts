/**
 * The tools the Brain's model can call. Each one is a thin, validated wrapper over something the
 * Brain's Durable Object does; all state changes go through `ToolHost`.
 *
 * Every tool must be safe to execute twice with the same call id: after a crash the Brain re-runs
 * any tool call that has no recorded output.
 */
import type { ToolDefinition } from "../model/openai";

export interface ToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

export interface ToolHost {
  /** A tool that is not one of the Brain's own: a connector's, if this run may use it. */
  connectorTool(callId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  sendMessage(callId: string, text: string): unknown;
  sendReview(callId: string, summary: string, commit: string | null, comments: { path: string; line: number; body: string }[]): unknown;
  memoryList(): unknown;
  memoryRead(path: string): unknown;
  memoryWrite(path: string, content: string): unknown;
  memoryDelete(path: string): unknown;
  setTimer(callId: string, delaySeconds: number, note: string, repeatEverySeconds: number | null): unknown;
  listTimers(): unknown;
  cancelTimer(id: string): unknown;
  dispatchTask(callId: string, title: string, brief: string, repository: string | null): Promise<unknown>;
  taskStatus(taskId: string): Promise<unknown>;
  answerTask(callId: string, taskId: string, decision: "allow" | "deny", reason: string): Promise<unknown>;
  cancelTask(taskId: string): Promise<unknown>;
  cancelRequest(requestId: string): unknown;
}

/** The longest message the Brain can send. */
export const MAX_MESSAGE_TEXT = 8_000;
const MAX_REVIEW_COMMENTS = 30;
const string = { type: "string" } as const;
const nullable = (type: string) => ({ type: [type, "null"] });

function tool(name: string, description: string, properties: Record<string, unknown>): ToolDefinition {
  return {
    type: "function",
    name,
    description,
    strict: true,
    parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  };
}

/** A connector's tool, as the model is told about it. */
export function describeTool(name: string, description: string, properties: Record<string, unknown>): ToolDefinition {
  return tool(name, description, properties);
}

export const TOOLS: ToolDefinition[] = [
  tool(
    "send_message",
    "Send a message to the people in this conversation. This is the only way they hear from you: text you write outside this tool is not shown to anyone. Send nothing when there is nothing worth their attention.",
    { text: string },
  ),
  tool(
    "send_review",
    "Post a code review on the pull request this conversation is about: a summary, and comments attached to lines of the change. Use it instead of send_message when findings point at particular lines. It comments only; it neither approves nor requests changes. Where comments cannot be attached to lines, the same review is sent as one message.",
    {
      summary: { type: "string", description: "The verdict and anything not tied to a line, including what was and was not checked." },
      commit: { ...nullable("string"), description: "The full SHA of the commit that was reviewed, or null if you do not know it. Without it no comment is attached to a line." },
      comments: {
        type: "array",
        description: "One per finding that points at a line. Empty if there are none.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path from the repository root." },
            line: { type: "integer", description: "Line number in the new version of the file. It must be a line the change touches or shows." },
            body: { type: "string", description: "What is wrong and what would go wrong because of it." },
          },
          required: ["path", "line", "body"],
          additionalProperties: false,
        },
      },
    },
  ),
  tool("memory_list", "List the files in your long-term memory.", {}),
  tool("memory_read", "Read one memory file.", { path: string }),
  tool(
    "memory_write",
    "Create or replace a memory file. Keep only what you could not look up again. Paths look like notes/preferences.md; index.md and instructions.md are loaded at the start of every run.",
    { path: string, content: string },
  ),
  tool("memory_delete", "Delete a memory file that is no longer true or useful.", { path: string }),
  tool(
    "set_timer",
    "Wake yourself up later. When the timer fires you get an event containing the note, in this same conversation. Use it for follow-ups and recurring work.",
    {
      delay_seconds: { type: "integer", description: "Seconds from now until it first fires." },
      note: { type: "string", description: "What you should do when it fires. Write it for a future you with no other context." },
      repeat_every_seconds: { ...nullable("integer"), description: "Null for a one-off; otherwise the interval, at least 60." },
    },
  ),
  tool("list_timers", "List your active timers.", {}),
  tool("cancel_timer", "Cancel a timer.", { id: string }),
  tool(
    "dispatch_task",
    "Hand a piece of work to a coding agent that runs in its own sandbox: it can run shell commands, write code and use git. Use it for anything that takes more than a moment. You are told when it finishes, fails or needs approval; do not wait for it.",
    {
      title: { type: "string", description: "A few words, shown to people." },
      brief: { type: "string", description: "Everything the worker needs. It knows nothing about this conversation. It cannot message anyone or post anywhere: say what you want back in its final answer." },
      repository: { ...nullable("string"), description: "An https://github.com/... URL to clone first, or null." },
    },
  ),
  tool("task_status", "Look up a task's current state and latest progress.", { task_id: string }),
  tool(
    "answer_task",
    "Answer a task that is waiting for approval. Only pass on a decision a person just gave you in this conversation; you may not approve on your own.",
    { task_id: string, decision: { type: "string", enum: ["allow", "deny"] }, reason: string },
  ),
  tool("cancel_task", "Stop a task and discard its sandbox.", { task_id: string }),
  tool(
    "cancel_request",
    "Call off a request of the person's that is still waiting or under way (they are listed for you under \"Requests that are waiting\"). Use it when the person says they no longer want it, or want something else instead of it; not because they went on to talk about something else. If it tells you more than one request could be meant, ask the person which.",
    { request_id: string },
  ),
];

/** Runs one tool call and returns the JSON string the model will see. Never throws. */
export async function executeTool(host: ToolHost, call: ToolCall): Promise<string> {
  let args: Record<string, any>;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return JSON.stringify({ error: "arguments were not valid JSON" });
  }
  try {
    return JSON.stringify((await route(host, call, args)) ?? { ok: true });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

function route(host: ToolHost, call: ToolCall, a: Record<string, any>): unknown {
  switch (call.name) {
    case "send_message":
      return host.sendMessage(call.call_id, text(a.text, "text", MAX_MESSAGE_TEXT));
    case "send_review": {
      if (!Array.isArray(a.comments) || a.comments.length > MAX_REVIEW_COMMENTS) throw new Error(`comments must be a list of at most ${MAX_REVIEW_COMMENTS}`);
      const comments = a.comments.map((c: Record<string, unknown>, i: number) => ({
        path: text(c?.path, `comments[${i}].path`, 300),
        line: integer(c?.line, `comments[${i}].line`),
        body: text(c?.body, `comments[${i}].body`, 2_000),
      }));
      if (comments.some((c) => c.line < 1 || !/^[^\s\\][^\n\\]*$/.test(c.path) || c.path.startsWith("/") || c.path.split("/").includes(".."))) throw new Error("each comment needs a path inside the repository and a line number of at least 1");
      const commit = a.commit == null ? null : text(a.commit, "commit", 40);
      if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full 40-character SHA, or null");
      return host.sendReview(call.call_id, text(a.summary, "summary", 4_000), commit, comments);
    }
    case "memory_list":
      return host.memoryList();
    case "memory_read":
      return host.memoryRead(text(a.path, "path", 200));
    case "memory_write":
      return host.memoryWrite(text(a.path, "path", 200), text(a.content, "content", 64_000, true));
    case "memory_delete":
      return host.memoryDelete(text(a.path, "path", 200));
    case "set_timer":
      return host.setTimer(call.call_id, integer(a.delay_seconds, "delay_seconds"), text(a.note, "note", 2_000), a.repeat_every_seconds == null ? null : integer(a.repeat_every_seconds, "repeat_every_seconds"));
    case "list_timers":
      return host.listTimers();
    case "cancel_timer":
      return host.cancelTimer(text(a.id, "id", 200));
    case "dispatch_task":
      return host.dispatchTask(call.call_id, text(a.title, "title", 120), text(a.brief, "brief", 20_000), a.repository == null ? null : text(a.repository, "repository", 300));
    case "task_status":
      return host.taskStatus(text(a.task_id, "task_id", 64));
    case "answer_task":
      if (a.decision !== "allow" && a.decision !== "deny") throw new Error("decision must be allow or deny");
      return host.answerTask(call.call_id, text(a.task_id, "task_id", 64), a.decision, text(a.reason, "reason", 1_000, true));
    case "cancel_task":
      return host.cancelTask(text(a.task_id, "task_id", 64));
    case "cancel_request":
      return host.cancelRequest(text(a.request_id, "request_id", 200));
    default:
      return host.connectorTool(call.call_id, call.name, a);
  }
}

function text(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (!allowEmpty && value.trim() === "") throw new Error(`${name} must not be empty`);
  if (value.length > max) throw new Error(`${name} is longer than ${max} characters`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
