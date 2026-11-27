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
  sendMessage(callId: string, text: string, notify?: string[]): unknown;
  sendReview(callId: string, summary: string, commit: string | null, comments: { path: string; line: number; body: string }[]): unknown;
  memoryList(): unknown;
  memoryRead(path: string): unknown;
  memoryWrite(path: string, content: string): unknown;
  memoryDelete(path: string): unknown;
  setTimer(callId: string, delaySeconds: number, note: string, repeatEverySeconds: number | null, stopAfterReminding?: boolean): unknown;
  listTimers(): unknown;
  cancelTimer(id: string): unknown;
  /** Hands a piece of work to one of the workers this run has. */
  handOver(callId: string, worker: string, title: string, brief: string, options: Record<string, unknown>, continueFrom: string | null, replaces: string | null, then?: string[]): Promise<unknown>;
  workStatus(workId: string): Promise<unknown>;
  cancelWork(callId: string, workId: string, onlyWhatFollows?: boolean): Promise<unknown>;
  tellWork(callId: string, workId: string, message: string): Promise<unknown>;
  dispatchTask(callId: string, title: string, brief: string, repository: string | null): Promise<unknown>;
  taskStatus(taskId: string): Promise<unknown>;
  answerTask(callId: string, taskId: string, decision: "allow" | "deny", reason: string): Promise<unknown>;
  cancelTask(taskId: string): Promise<unknown>;
  cancelRequest(callId: string, requestId: string, ask: string): unknown;
  /** What stands further back in this conversation than the run is shown: see History. */
  readHistory(ask: { query?: string; from?: string; before?: string; limit?: number }): unknown;
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

/**
 * Reading further back in this conversation. Offered where the conversation is one person's own
 * (see Runner): not one of the tools every run has.
 */
export const READ_HISTORY: ToolDefinition = tool(
  "read_history",
  "Read further back in this conversation than you are shown: what the person wrote to you here and what your own messages said, over the last thirty days. Use it when what is asked rests on something said earlier that you do not see above. It gives the latest that fit, oldest first, and `earlier` to go on from where there is more. What tools returned, and messages edited or taken back since, are not in it.",
  {
    query: { ...nullable("string"), description: "Words the message contains, as written (no other kind of search), or null for everything." },
    from: { ...nullable("string"), description: 'Only what one writer wrote: a person\'s id, or "you" for your own messages. Null for everyone.' },
    before: { ...nullable("string"), description: "Only what stands before this: a time (2026-11-27T12:00:00Z), or what an earlier call gave as `earlier`. Null for the latest." },
    limit: { ...nullable("integer"), description: "How many at most, up to 30. Null for 30." },
  },
);

/** A connector's tool, as the model is told about it. */
export function describeTool(name: string, description: string, properties: Record<string, unknown>): ToolDefinition {
  return tool(name, description, properties);
}

export const TOOLS: ToolDefinition[] = [
  tool(
    "send_message",
    "Send a message to the people in this conversation. This is the only way they hear from you: text you write outside this tool is not shown to anyone. Send nothing when there is nothing worth their attention.",
    {
      text: string,
      notify: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "People this message is to remind (they get a notification where the place has such a thing), or null. Each as you see them in this conversation: a person's id, or a name the person who asked wrote with a mention (@name), which may be another bot of the chat. Only the one who asked for the thing, people they named that way, and people who have written to you here can be reminded; anyone else is left out, and you are told how many were. Writing @name or an id in `text` reminds nobody: it is only text. Remind someone when they asked to be told, or the one who asked wanted them told; not otherwise.",
      },
    },
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
    "Wake yourself up later. When the timer fires you get an event containing the note, in this same conversation. Use it for follow-ups and recurring work. A repeating timer costs a run every time it fires: cancel it as soon as what it is for is done or no longer wanted. It ends by itself fifty rounds after its first; set it again if it is still needed then.",
    {
      delay_seconds: { type: "integer", description: "Seconds from now until it first fires." },
      note: { type: "string", description: "What you should do when it fires. Write it for a future you with no other context." },
      repeat_every_seconds: { ...nullable("integer"), description: "Null for a one-off; otherwise the interval, at least 60." },
      stop_after_reminding: { ...nullable("boolean"), description: "For a repeating timer that checks for something and is to tell someone once, when it is so (\"check every ten minutes and tell me when it passes\"): true. It ends by itself with the first message from it that reminds someone, so they are told once. Null or false where each time it fires is to be told (\"remind me every hour\")." },
    },
  ),
  tool("list_timers", "List your active timers.", {}),
  tool("cancel_timer", "Cancel a timer.", { id: string }),
  tool(
    "answer_task",
    "Answer a task that is waiting for approval. Only pass on a decision a person just gave you in this conversation; you may not approve on your own.",
    { task_id: string, decision: { type: "string", enum: ["allow", "deny"] }, reason: string },
  ),
  tool(
    "cancel_request",
    "Call off a request of the person's that is still waiting or under way (they are listed for you under \"Requests that are waiting\"; a piece of work handed to a worker is called off with cancel_work). Use it when the person says they no longer want it; not because they went on to talk about something else. When they want something else instead of it, do not cancel first: make the new request with its `replaces` set to the old one's id. If more than one request could be meant, the system asks the person which, itself; say nothing more about it then.",
    { request_id: string, ask: { type: "string", description: "One short sentence, in the person's language, asking which of their requests they mean. It is sent, followed by the list of those requests, only if more than one could be meant." } },
  ),
];

/**
 * The tools for handing work to workers, made from the workers a run has: none of their names or
 * parameters is written here. `worker` is one of them by name; each worker's own options are
 * parameters of `hand_over`, null for a worker they are not for. None where there is no worker.
 */
export function workTools(workers: { name: string; description: string; acts_as: "agent" | "person"; options?: Record<string, unknown>; continues: boolean; tells?: boolean }[], replaces: unknown, then: string[] = [], conditions = ""): ToolDefinition[] {
  // How work stands can be asked, and work stopped, also where nothing new can be handed over (a worker taken out of the deployment still has what it was given).
  const standing = [
    tool("work_status", "Look up how a piece of work you handed over stands.", { work_id: string }),
    tool("cancel_work", "Stop a piece of work you handed over, or stop waiting for it. Only when the person says they no longer want it. Where they only no longer want what was to be done in their name after it (do not post it after all), and the work itself may go on: `only_what_follows` true.", { work_id: string, only_what_follows: { type: ["boolean", "null"], description: "True: the work goes on and you are told how it ended, but nothing is done in the person's name after it. Null or false: the work is stopped." } }),
  ];
  if (workers.length === 0) return standing;
  const options: Record<string, unknown> = {};
  for (const each of workers) {
    for (const [key, schema] of Object.entries(each.options ?? {})) {
      // One name, one meaning: two workers cannot both have an option of the same name.
      if (key in options || ["worker", "title", "brief", "continue_from", "replaces", "then"].includes(key)) throw new Error(`the option "${key}" of the worker "${each.name}" is already taken`);
      const described = schema as { description?: string };
      options[key] = { ...described, description: `Only for the worker "${each.name}"; null for any other. ${described.description ?? ""}`.trim() };
    }
  }
  const listed = workers.map((each) => `- ${each.name}${each.acts_as === "person" ? " (does things as the person you are talking to, with their own account)" : ""}: ${each.description}`).join("\n");
  const continues = workers.filter((each) => each.continues).map((each) => each.name);
  return [
    tool(
      "hand_over",
      `Hand a piece of work to a worker: something that takes more than a moment, or that a worker can do and you cannot. You are told when it is done, fails or needs something; do not wait for it. Choose the worker by what each can do:\n${listed}\nWork that goes on with an earlier piece (more depth, a correction, the next part) goes to the worker that did that piece, with its id in continue_from.`,
      {
        worker: { type: "string", enum: workers.map((each) => each.name) },
        title: { type: "string", description: "A few words, shown to people." },
        brief: { type: "string", description: "What to do. The worker knows nothing of this conversation. For a worker that does things as the person: the person's own request in their words, plus only what is needed from here to understand it; no requirements, scope or format they did not state. For any other: everything it needs, and what you want back in its final answer." },
        continue_from: { type: ["string", "null"], description: `The id of an earlier piece of work (listed under "Work handed over") that this goes on with, or null for something new. It may be one that has not ended yet: this is then put after it, and starts by itself, from what that one leaves, when that has ended well (one line: if something already waits behind it, name that one).${continues.length < workers.length ? ` Only ${continues.length ? continues.join(", ") : "no worker here"} can go on with an earlier piece.` : ""}` },
        ...options,
        ...(replaces ? { replaces } : {}),
        // Only where the run has something it may do in the person's name.
        ...(then.length > 0
          ? {
              then: {
                type: ["array", "null"],
                items: { type: "string", enum: then },
                description:
                  "What the person asked to have done in their own name once this work has ended well, where doing it needs what the work finds (look whether there is an issue about this; if there is, comment on it, if not, open one): the tools for it, by name. Null where they asked for nothing of the kind (only to look, only to be told). You then have these tools in the run that brings the work's result, to use one of them, once, for the person. It is decided now, from what they asked: nothing the work brings back adds to it. A name with a condition after a colon holds that tool to the condition (it is checked against what the work is seen to have done, not against what it says): name it that way where the person made it a condition." + (conditions ? `\n${conditions}` : ""),
              },
            }
          : {}),
      },
    ),
    ...standing,
    // Only where there is a worker that can be told something once it is at work.
    ...(workers.some((each) => each.tells)
      ? [
          tool(
            "tell_work",
            `Add something the person says to a piece of work that is under way, so that it takes it into account from its next step on: a detail, a correction, something more on the same thing. It is passed on, not done: say so. Not for something that is to come after the work (hand that over to go on from it), nor to take back something it is waiting for approval to do (refuse that, or stop the work). Only ${workers.filter((each) => each.tells).map((each) => each.name).join(", ")} can be told.`,
            { work_id: string, message: { type: "string", description: "What they said, in full and as they meant it: the worker has not seen this conversation." } },
          ),
        ]
      : []),
  ];
}

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
      if (a.notify != null && (!Array.isArray(a.notify) || a.notify.length > 20 || a.notify.some((each) => typeof each !== "string" || each.length > 200))) throw new Error("notify is a short list of people, or null");
      return host.sendMessage(call.call_id, text(a.text, "text", MAX_MESSAGE_TEXT), a.notify == null ? [] : (a.notify as string[]));
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
      return host.setTimer(call.call_id, integer(a.delay_seconds, "delay_seconds"), text(a.note, "note", 2_000), a.repeat_every_seconds == null ? null : integer(a.repeat_every_seconds, "repeat_every_seconds"), a.stop_after_reminding === true);
    case "list_timers":
      return host.listTimers();
    case "cancel_timer":
      return host.cancelTimer(text(a.id, "id", 200));
    case "hand_over": {
      const { worker, title, brief, continue_from, replaces, then, ...options } = a;
      if (then != null && (!Array.isArray(then) || then.some((each) => typeof each !== "string") || then.length > 10)) throw new Error("then is a list of tool names, or null");
      return host.handOver(call.call_id, text(worker, "worker", 60), text(title, "title", 120), text(brief, "brief", 20_000), options, continue_from == null ? null : text(continue_from, "continue_from", 200), replaces == null ? null : text(replaces, "replaces", 200), then == null ? [] : [...new Set(then as string[])]);
    }
    case "work_status":
      return host.workStatus(text(a.work_id, "work_id", 200));
    case "cancel_work":
      return host.cancelWork(call.call_id, text(a.work_id, "work_id", 200), a.only_what_follows === true);
    case "tell_work":
      return host.tellWork(call.call_id, text(a.work_id, "work_id", 200), text(a.message, "message", 4_000));
    // The names work was handed over under before there was one set of tools: still carried out,
    // for a call made under them that is made again, and no longer offered.
    case "dispatch_task":
      return host.dispatchTask(call.call_id, text(a.title, "title", 120), text(a.brief, "brief", 20_000), a.repository == null ? null : text(a.repository, "repository", 300));
    case "task_status":
      return host.taskStatus(text(a.task_id, "task_id", 64));
    case "answer_task":
      if (a.decision !== "allow" && a.decision !== "deny") throw new Error("decision must be allow or deny");
      return host.answerTask(call.call_id, text(a.task_id, "task_id", 64), a.decision, text(a.reason, "reason", 1_000, true));
    case "cancel_task":
      return host.cancelTask(text(a.task_id, "task_id", 64));
    case "read_history":
      return host.readHistory({
        ...(a.query == null || a.query === "" ? {} : { query: text(a.query, "query", 200) }),
        ...(a.from == null || a.from === "" ? {} : { from: text(a.from, "from", 200) }),
        ...(a.before == null || a.before === "" ? {} : { before: text(a.before, "before", 60) }),
        ...(a.limit == null ? {} : { limit: integer(a.limit, "limit") }),
      });
    case "cancel_request":
      return host.cancelRequest(call.call_id, text(a.request_id, "request_id", 200), typeof a.ask === "string" ? a.ask.slice(0, 300) : "");
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

