// Runs the real pi (0.87.1) with the repository's real container/gate.ts, against a model that
// answers by rote and a stand-in for the task's Durable Object, and checks what reaches the model.
// Not part of the tests: it needs pi installed, which the repository does not depend on.
//   mkdir /tmp/pi && cd /tmp/pi && npm init -y && npm install --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
//   PI=/tmp/pi/node_modules/.bin/pi node eval/lab/notes.lab.mjs container/gate.ts
// (The version is the one the sandbox image installs: see the Dockerfile.)
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolve } from "node:path";
const GATE = resolve(process.argv[2] ?? "container/gate.ts");
const PI = process.env.PI ?? join(new URL(".", import.meta.url).pathname, "node_modules/.bin/pi");
const HERE = new URL(".", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "steer-lab-"));
const body = (req) => new Promise((resolve) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => resolve(s ? JSON.parse(s) : {})); });
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// ---- the model: says "ok" to everything; records what it was sent ----
const model = { calls: [], fail: false, tool: false };
const modelServer = createServer(async (req, res) => {
  const q = await body(req);
  model.calls.push(q.messages ?? q.input ?? q);
  if (model.fail) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "no" } })); }
  res.writeHead(200, { "content-type": "text/event-stream" });
  // Asked to, it first runs a command (once), as an agent at work would.
  const first = model.tool && model.calls.length === 1;
  const said = first ? [[{ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo at-work" }) } }] }, null], [{}, "tool_calls"]] : [[{ role: "assistant", content: `ok ${model.calls.length}` }, null], [{}, "stop"]];
  for (const [delta, reason] of said) {
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
});

// ---- the task: the protocol of TaskSandbox.callback("notes"), as designed ----
const task = { taken: [], closed: false, run: "r1", fetches: [], hangFirst: 0, down: false, onlyFinal: false };
const taskServer = createServer(async (req, res) => {
  const q = await body(req);
  if (!req.url.endsWith("/callback/notes")) { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
  if (task.down) return req.socket.destroy();
  const answer = () => {
    if (q.run !== task.run) return { ok: false };
    const missing = task.spent || (task.onlyFinal && !q.final) ? [] : task.taken.filter((n) => !q.have.includes(n.id));
    if (q.final && missing.length === 0) task.closed = true;
    return { ok: true, notes: missing };
  };
  const reply = answer();
  task.fetches.push({ final: q.final, have: q.have, gave: (reply.notes ?? []).map((n) => n.id), run: q.run });
  if (task.hangFirst > 0) { task.hangFirst--; return; } // the answer never arrives
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(reply));
});

const modelPort = await listen(modelServer);
const taskPort = await listen(taskServer);
const conf = join(root, "config"); mkdirSync(conf);
writeFileSync(join(conf, "models.json"), JSON.stringify({ providers: { probe: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake", contextWindow: 64000, maxTokens: 1000 }] }, probe2: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-responses", apiKey: "x", models: [{ id: "fake", contextWindow: 64000, maxTokens: 1000 }] } } }));

function pi(sessions, { resume = false, run = "r1", provider = "probe", prompt = "do the thing" } = {}) {
  const cwd = join(root, "job"); mkdirSync(cwd, { recursive: true });
  const taskDir = join(root, "task"); mkdirSync(taskDir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: conf, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TMPDIR: root, TASK_ID: "task-X", TASK_PASS: "p", TASK_RUN: run, TASK_DIRECTORY: taskDir, GATE_BRAIN_URL: `http://127.0.0.1:${taskPort}`, GATE_NOTES_TIMEOUT_MS: "700" };
  const args = ["--mode", "json", "--no-approve", "--provider", provider, "--model", "fake", "--extension", GATE, "--session-dir", sessions, ...(resume ? ["--continue"] : []), "--", prompt];
  return new Promise((resolve) => {
    const child = spawn(PI, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c)); child.stderr.on("data", (c) => (err += c));
    const started = Date.now();
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - started, settled: (out.match(/"type":"agent_settled"/g) ?? []).length }));
  });
}
const reset = (over = {}) => { Object.assign(task, { taken: [], closed: false, run: "r1", fetches: [], hangFirst: 0, down: false, onlyFinal: false, spent: false }, over); model.calls = []; model.fail = false; model.tool = false; };
/** How often each note's text is in each request to the model. */
const seen = (...texts) => model.calls.map((messages) => texts.map((text) => JSON.stringify(messages).split(text).length - 1));
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     ${JSON.stringify(detail)}`}`); };
let n = 0;
const fresh = () => join(root, `sessions-${++n}`);

// A. A note is there from the start: brought in after the first step, once.
reset({ taken: [{ id: "a", text: "NOTE-ALPHA" }] });
let s = fresh();
let r = await pi(s);
check("A one note, taken before the first step ends: in the next request once, the agent goes on a step, the run closes", r.code === 0 && r.settled === 1 && JSON.stringify(seen("NOTE-ALPHA")) === "[[0],[1]]" && task.closed && task.fetches.at(-1).final === true && task.fetches.at(-1).have.includes("a"), { r: { code: r.code, err: r.err.slice(0, 300) }, seen: seen("NOTE-ALPHA"), fetches: task.fetches });
check("A the note says that the last reply is still the whole result", JSON.stringify(model.calls.at(-1)).includes("Your last reply is still the one result of the whole task"), model.calls.at(-1));
const sessionWithA = join(root, "copy-with-a"); cpSync(s, sessionWithA, { recursive: true });

// B. A note that comes only at the last fetch: one more step, then closed.
reset({ taken: [{ id: "b", text: "NOTE-BETA" }], onlyFinal: true });
r = await pi(fresh());
check("B a note given only at the last fetch: the agent takes one more step and reads it; then the run closes", r.code === 0 && r.settled === 1 && JSON.stringify(seen("NOTE-BETA")) === "[[0],[1]]" && task.closed, { seen: seen("NOTE-BETA"), fetches: task.fetches, err: r.err.slice(0, 300) });

// C. The answer to a fetch is lost: had again at the next fetch, in the session once.
reset({ taken: [{ id: "c", text: "NOTE-GAMMA" }], hangFirst: 1 });
r = await pi(fresh());
check("C the answer to the first fetch never arrives: the note is had again, and is in the session once", r.code === 0 && seen("NOTE-GAMMA").at(-1)[0] === 1 && task.closed && task.fetches[0].gave.includes("c"), { seen: seen("NOTE-GAMMA"), fetches: task.fetches, err: r.err.slice(0, 300) });

// D. Several notes at once: one message, each once, their ids all kept.
reset({ taken: [{ id: "d1", text: "NOTE-DELTA-1" }, { id: "d2", text: "NOTE-DELTA-2" }] });
s = fresh();
r = await pi(s);
check("D two notes at once: one more request, each in it once, both ids reported as held afterwards", r.code === 0 && JSON.stringify(seen("NOTE-DELTA-1", "NOTE-DELTA-2")) === "[[0,0],[1,1]]" && ["d1", "d2"].every((id) => task.fetches.at(-1).have.includes(id)), { seen: seen("NOTE-DELTA-1", "NOTE-DELTA-2"), fetches: task.fetches });

// E. No notes at all: one request, the run closes, nothing more.
reset();
r = await pi(fresh());
check("E no notes: one request to the model, and the run is closed at the last fetch", r.code === 0 && model.calls.length === 1 && task.closed && task.fetches.every((f) => f.gave.length === 0), { calls: model.calls.length, fetches: task.fetches });

// F. The task cannot be reached at all: the agent still ends, in a bounded time.
reset({ down: true });
r = await pi(fresh());
check("F the task cannot be reached: the agent ends all the same, soon", r.code === 0 && r.settled === 1 && r.ms < 15_000, { code: r.code, ms: r.ms, err: r.err.slice(0, 300) });

// G. Resumed (a new process, a new run) from a copy that holds A, with B taken meanwhile: A is not written again, B is.
reset({ taken: [{ id: "a", text: "NOTE-ALPHA" }, { id: "b", text: "NOTE-BETA" }], run: "r2" });
r = await pi(sessionWithA, { resume: true, run: "r2", prompt: "go on" });
check("G resumed from a copy that holds A: A is reported as held and not written again; B is brought in", r.code === 0 && task.fetches[0].have.includes("a") && JSON.stringify(seen("NOTE-ALPHA", "NOTE-BETA").at(-1)) === "[1,1]", { seen: seen("NOTE-ALPHA", "NOTE-BETA"), fetches: task.fetches, err: r.err.slice(0, 300) });

// H. A process of an earlier run: gets nothing, closes nothing.
reset({ taken: [{ id: "h", text: "NOTE-ETA" }], run: "r2" });
r = await pi(fresh(), { run: "r1" });
check("H a process of an earlier run is given nothing and does not close the run", r.code === 0 && seen("NOTE-ETA").every((c) => c[0] === 0) && !task.closed, { seen: seen("NOTE-ETA"), closed: task.closed });

// I. The model call fails: no note is brought in on top of the failure.
reset({ taken: [{ id: "i", text: "NOTE-IOTA" }] });
model.fail = true;
r = await pi(fresh());
check("I the step fails at the model: nothing is fetched for it, and nothing is asked of the model again for a note's sake", task.fetches.length === 0 && seen("NOTE-IOTA").every((c) => c[0] === 0), { calls: model.calls.length, fetches: task.fetches });

// K. The agent is running a command when the note is there: it is in the very next request, with the command's result, and costs no request of its own.
reset({ taken: [{ id: "k", text: "NOTE-KAPPA" }] });
model.tool = true;
r = await pi(fresh());
check("K a note taken while the agent runs a command: in the next request, together with the command's result; no request more than without it", r.code === 0 && model.calls.length === 2 && JSON.stringify(seen("NOTE-KAPPA")) === "[[0],[1]]" && JSON.stringify(model.calls[1]).includes("at-work") && task.closed, { calls: model.calls.length, seen: seen("NOTE-KAPPA"), fetches: task.fetches, err: r.err.slice(0, 300) });

// L. The task has no step left to give: it hands nothing out, and the agent ends as it would have, with its own last reply.
reset({ taken: [{ id: "l", text: "NOTE-LAMBDA" }], spent: true });
r = await pi(fresh());
check("L a task with no step left hands nothing out: one request, the agent ends well, the run is closed", r.code === 0 && r.settled === 1 && model.calls.length === 1 && task.closed && seen("NOTE-LAMBDA").every((c) => c[0] === 0), { calls: model.calls.length, fetches: task.fetches });

// J. What goes to a Responses-style model for a note in the session (for the sandbox's outbound check).
reset({ taken: [{ id: "a", text: "NOTE-ALPHA" }], run: "r3" });
model.fail = true;
r = await pi(sessionWithA, { resume: true, run: "r3", provider: "probe2", prompt: "go on" });
const items = model.calls[0];
writeFileSync(join(root, "responses-input.json"), JSON.stringify(items, null, 2));
const noteItem = Array.isArray(items) ? items.find((item) => JSON.stringify(item).includes("NOTE-ALPHA")) : undefined;
check("J a note in the session goes to a Responses-style model as a plain user message", noteItem !== undefined && (noteItem.type === undefined || noteItem.type === "message") && noteItem.role === "user", noteItem ?? items);
console.log("     the item:", JSON.stringify(noteItem));

modelServer.close(); taskServer.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} as expected; working directory ${root}`);
process.exit(results.every(Boolean) ? 0 : 1);
