import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { privateSessionKey } from "../src/events";
import { type Acting, type Continuation, type Guard, Requests, type RequestsHost, type Source, calledOff } from "../src/brain/requests";
import { migrate } from "../src/brain/schema";
import { BrainStore, type InboxRow, type RunRow } from "../src/brain/store";

/**
 * Requests that wait, guards and follow-ups, by themselves: the part is built on a real Brain's
 * storage with a stand-in for what the Brain hands it, and rows are put there with plain SQL.
 * No model, no connector, no run, no alarm. What needs a connector to be asked (whether a
 * condition holds, a source read again) is left to the tests of the whole flow.
 */
const SESSION = "s1";
const SESSION_KEY = "dm";
/** The name of the line that tells a request's conversation how its way in fared. */
const told = (interaction: string, request: string) => `invited:${JSON.stringify([interaction, request])}`;
const PRIVATE_KEY = privateSessionKey("feishu", { app_id: "cli_1", tenant_key: "org_1" });
const TARGET = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_1" } });
const ELSEWHERE = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_then" } });
const PERSON: Acting = { connector: "feishu", person: "ou_1", origin: { app_id: "cli_1", tenant_key: "org_1" }, said: [], recent: [], recentIds: [] };

afterEach(() => vi.restoreAllMocks());

let scopes = 0;
function within<T>(use: (bench: ReturnType<typeof bench>) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(`acme:user:requests-${++scopes}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));
}

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  const woken: number[] = [];
  const appended: unknown[] = [];
  const settings: Record<string, string> = {};
  const host: RequestsHost & { acting: Acting | undefined } = {
    env: settings as unknown as Env,
    outside: new Set<string>(),
    acting: PERSON,
    wakeBy: async (at) => void woken.push(at),
    append: (sessionId, runId, item, outside) => void appended.push({ sessionId, runId, item, outside }),
    actingFor: () => host.acting,
    actingOn: () => host.acting,
    // As the Brain's own does, as far as the row goes: one row per key, where the request's answer belongs.
    enqueueMessage: (idem, sessionId, runId, text, _ask, _review, bound) => {
      const target = bound?.continuation?.target ?? bound?.target ?? store.rows<{ target: string | null }>("SELECT target FROM sessions WHERE id = ?", sessionId)[0]?.target;
      if (!target) throw new Error("there is nowhere to send a message in this conversation");
      store.sql.exec("INSERT OR IGNORE INTO outbox (idem, run_id, target, text, next_at, created_at, continuation, interaction) VALUES (?, ?, ?, ?, 0, 0, ?, ?)", idem, runId, target, text, bound?.continuation?.id ?? null, bound?.interaction ?? null);
      return { ok: true };
    },
    notice: (which) => `notice:${which}`,
    // The person's own chat with the bot, as the connector would address it from a verified origin.
    direct: (connector, origin, person) => (settings.noDirect ? undefined : { connector, address: { app_id: origin.app_id, open_id: person } }),
    // In the conversation the request was made in, for that person's eyes only, where the connector can.
    aside: (connector, origin, person, from) => (settings.noAside ? undefined : { connector, address: { app_id: origin.app_id, chat_id: from.address.chat_id, visible_to: person } }),
  };
  const requests = new Requests(store, host);
  store.sql.exec("INSERT INTO sessions (id, session_key, target, created_at, updated_at) VALUES (?, ?, ?, 1, 1)", SESSION, SESSION_KEY, TARGET);

  let made = 0;
  /** A request as it is kept, waiting unless said otherwise. */
  const request = (id: string, over: Partial<Continuation> & { check_at?: number | null } = {}): Continuation => {
    const row = { person: null as string | null, session_id: SESSION, events: JSON.stringify({ said: [], recent: [] }), connector: "feishu", tool: "feishu_read_document", args: "{}", target: TARGET, subject: "grant_1", condition: "cond_1", generation: 1, interaction: `int:${id}`, until: Date.now() + 3_600_000, status: "waiting", run_id: null, call_id: null, claimed_at: null, check_at: null, ...over };
    store.sql.exec(
      "INSERT INTO continuations (person, id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, run_id, call_id, claimed_at, check_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.person,
      id,
      row.session_id,
      row.events,
      row.connector,
      row.tool,
      row.args,
      row.target,
      row.subject,
      row.condition,
      row.generation,
      row.interaction,
      row.until,
      row.status,
      row.run_id,
      row.call_id,
      row.claimed_at,
      row.check_at,
      ++made,
    );
    return kept(id);
  };
  const kept = (id: string) => store.rows<Continuation & { check_at: number | null; ended_at: number | null; created_at: number }>("SELECT * FROM continuations WHERE id = ?", id)[0];
  let said = 0;
  /** The id the source gave a stored message, which is not the row's own id. */
  const sourceId = (id: number) => store.rows<{ source_id: string }>("SELECT source_id FROM inbox WHERE id = ?", id)[0].source_id;
  /** A message of the person's as it is stored, claimed by a run if one is named. Its id. */
  const message = (text: string | null, data: Record<string, unknown> = {}, runId: string | null = null, by = "ou_1", status?: string): number => {
    const id = `om_${++said}`;
    return store.rows<{ id: number }>(
      "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, reply_to, status, run_id, received_at) VALUES ('feishu', ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      id,
      SESSION_KEY,
      JSON.stringify({ kind: "human", id: by, explicit: true }),
      text,
      JSON.stringify({ message_id: id, direct: true, ...data }),
      TARGET,
      status ?? (runId ? "claimed" : "done"),
      runId,
      Date.now(),
    )[0].id;
  };
  const run = (id: string): RunRow => {
    store.sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES (?, ?, 'running', ?)", id, SESSION, Date.now());
    return store.rows<RunRow>("SELECT * FROM runs WHERE id = ?", id)[0];
  };
  /** A message to deliver, as it is kept. */
  const outgoing = (idem: string, over: { run_id?: string | null; status?: string; started?: number; text?: string; continuation?: string; interaction?: string; receipt?: string; review?: string; error?: string } = {}) =>
    void store.sql.exec(
      "INSERT INTO outbox (idem, run_id, target, text, status, started, next_at, created_at, continuation, interaction, receipt, review, error) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)",
      idem,
      over.run_id ?? null,
      TARGET,
      over.text ?? "text",
      over.status ?? "pending",
      over.started ?? 0,
      over.continuation ?? null,
      over.interaction ?? null,
      over.receipt ?? null,
      over.review ?? null,
      over.error ?? null,
    );
  const sent = (idem: string) => store.rows<Record<string, unknown>>("SELECT * FROM outbox WHERE idem = ?", idem)[0];
  const audited = (action: string) => store.rows<{ detail: string }>("SELECT detail FROM audit WHERE action = ? ORDER BY id", action).map((each) => JSON.parse(each.detail) as Record<string, unknown>);
  const hints = () => store.rows<{ source_id: string }>("SELECT source_id FROM inbox WHERE source = 'request' ORDER BY id").map((each) => each.source_id);
  return { store, host, settings, requests, woken, appended, request, kept, message, sourceId, run, outgoing, sent, audited, hints };
}

describe("requests that wait, by themselves", () => {
  it("ends a request once, says so once, and never reopens one that has ended", async () => {
    await within(({ requests, request, kept, audited }) => {
      for (const status of ["waiting", "resuming", "answering"]) request(`r_${status}`, { status });
      request("r_done", { status: "done" });
      const before = Date.now();
      requests.endRequest("r_waiting", "expired", "it was not done in time");
      requests.endRequest("r_resuming", "void", "gone");
      requests.endRequest("r_answering", "done", "answered");
      expect(kept("r_waiting")).toMatchObject({ status: "expired", why: "it was not done in time" });
      expect(kept("r_resuming")).toMatchObject({ status: "void", why: "gone" });
      expect(kept("r_answering")).toMatchObject({ status: "done", why: "answered" });
      expect(kept("r_waiting").ended_at).toBeGreaterThanOrEqual(before);

      // A second ending, an ending of one that had already ended, and one of a request there is not.
      const first = kept("r_waiting");
      requests.endRequest("r_waiting", "cancelled", "something else");
      requests.endRequest("r_done", "failed", "too late");
      requests.endRequest("r_unknown", "void", "nothing");
      expect(kept("r_waiting")).toEqual(first);
      expect(kept("r_done")).toMatchObject({ status: "done", why: null, ended_at: null });
      expect(audited("request.ended")).toEqual([
        { request: "r_waiting", as: "expired", why: "it was not done in time" },
        { request: "r_resuming", as: "void", why: "gone" },
        { request: "r_answering", as: "done", why: "answered" },
      ]);
    });
  });

  it("keeps one reason to ask per request and reason, in the request's own conversation", async () => {
    await within(({ store, requests, request, hints }) => {
      const one = request("r1");
      const two = request("r2");
      requests.hint(one, "reported:authorised");
      requests.hint(one, "reported:authorised");
      requests.hint(one, "due:1");
      requests.hint(two, "reported:authorised");
      // A request whose conversation is not on record: nothing.
      requests.hint(request("r_lost", { session_id: "s_unknown" }), "reported:authorised");
      expect(hints()).toEqual(["r1:reported:authorised", "r1:due:1", "r2:reported:authorised"]);
      const [row] = store.rows<Record<string, string>>("SELECT * FROM inbox WHERE source_id = 'r1:due:1'");
      expect(row).toMatchObject({ source: "request", kind: "request.ready", session_key: SESSION_KEY, status: "pending", text: null });
      expect(JSON.parse(row.data)).toEqual({ request: "r1" });
      expect(JSON.parse(row.principal)).toEqual({ kind: "automation", id: "request", explicit: false });
    });
  });

  it("has every waiting request of a subject asked again when its connector reports, and wakes the Brain", async () => {
    await within(async ({ requests, request, hints, woken }) => {
      request("r_mine");
      request("r_other_subject", { subject: "grant_2" });
      request("r_other_connector", { connector: "github" });
      request("r_ended", { status: "done" });
      const before = Date.now();
      expect(await requests.conditionReported("feishu", "grant_1", "authorised")).toEqual({ ok: true });
      expect(hints()).toEqual(["r_mine:reported:authorised"]);
      expect(woken).toHaveLength(1);
      expect(woken[0]).toBeGreaterThanOrEqual(before + 50);
    });
  });

  it("asks once about a passed deadline and once about each re-ask whose time has come, and about no other", async () => {
    await within(({ requests, request, kept, hints }) => {
      const now = 5_000_000_000;
      request("r_until", { until: now });
      request("r_check", { until: now + 10_000, check_at: now });
      request("r_later", { until: now + 1, check_at: now + 1 });
      request("r_plain", { until: now + 1 });
      request("r_ended", { until: now - 1, check_at: now - 1, status: "expired" });
      request("r_resuming", { until: now - 1, status: "resuming" });
      requests.deadlines(now);
      expect(hints()).toEqual([`r_until:deadline:${now}:cond_1:1`, `r_check:check:${now}`]);
      expect(kept("r_until").check_at).toBeNull();
      expect(kept("r_check").check_at).toBeNull();
      expect(kept("r_later").check_at).toBe(now + 1);
      expect(kept("r_ended").check_at).toBe(now - 1);
      // It only gave a reason to ask: nothing has ended.
      expect(kept("r_until").status).toBe("waiting");
      // Looked at again: each reason is kept once.
      requests.deadlines(now);
      requests.deadlines(now + 1);
      expect(hints()).toEqual([
        `r_until:deadline:${now}:cond_1:1`,
        `r_check:check:${now}`,
        `r_later:check:${now + 1}`,
        `r_later:deadline:${now + 1}:cond_1:1`,
        `r_plain:deadline:${now + 1}:cond_1:1`,
      ]);
      expect(kept("r_later").check_at).toBeNull();
    });
  });

  it("keeps a wait's scheduled re-ask when another wait wakes the Brain first", async () => {
    await within(({ store, requests, request, hints }) => {
      const now = 5_000_000_000;
      // A's deadline passed and was looked at; its owner could not be asked, so it is asked again later.
      request("a", { until: now - 20_000 });
      requests.deadlines(now - 20_000);
      store.sql.exec("UPDATE continuations SET check_at = ? WHERE id = 'a'", now + 40_000);
      request("b", { until: now + 90_000, check_at: now });
      requests.deadlines(now);
      expect(hints()).toEqual([`a:deadline:${now - 20_000}:cond_1:1`, `b:check:${now}`]);
      expect(requests.nextWakeAt(now)).toBe(now + 40_000);
      requests.deadlines(now + 40_000);
      expect(hints()).toContain(`a:check:${now + 40_000}`);
    });
  });

  it("still looks at the deadline when a re-ask just before it used its minute, or was set beyond it", async () => {
    await within(async ({ requests, request, kept, hints }) => {
      const now = 5_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      // Its scheduled re-ask comes 20 s before its deadline; no connector of that name can say
      // whether anything holds, so asking fails and it is put off a minute, past the deadline.
      request("r", { connector: "unknown", until: now + 20_000, check_at: now });
      requests.deadlines(now);
      await requests.resume({ id: 0, data: JSON.stringify({ request: "r" }) } as InboxRow);
      expect(kept("r").check_at).toBe(now + 60_000);
      expect(requests.nextWakeAt(now)).toBe(now + 20_000);
      clock.mockReturnValue(now + 20_000);
      requests.deadlines(now + 20_000);
      expect(hints()).toEqual([`r:check:${now}`, `r:deadline:${now + 20_000}:cond_1:1`]);
      expect(kept("r").check_at).toBe(now + 60_000);
    });
  });

  it("finds the request a run carries on, and takes it as being carried on only while it is", async () => {
    await within(({ store, requests, request }) => {
      request("r1", { status: "resuming", run_id: "run_1", call_id: "resume_1" });
      request("r2");
      expect(requests.continuationOf("run_1")?.id).toBe("r1");
      expect(requests.resumed("run_1")?.id).toBe("r1");
      expect(requests.continuationOf("run_other")).toBeUndefined();
      expect(requests.resumed("run_other")).toBeUndefined();
      for (const status of ["answering", "waiting", "done"]) {
        store.sql.exec("UPDATE continuations SET status = ? WHERE id = 'r1'", status);
        expect(requests.continuationOf("run_1"), status).toMatchObject({ id: "r1", status });
        expect(requests.resumed("run_1"), status).toBeUndefined();
      }
    });
  });

  it("rests a run on the events it claimed, and a carried-on run on the messages that made the request, all of them or none", async () => {
    await within(({ store, requests, request, message }) => {
      const first = message("总结", {}, "run_1");
      message("别的", {}, "run_other");
      const second = message("还有这个", {}, "run_1");
      expect(requests.basis("run_1").map((each) => each.id)).toEqual([first, second]);
      expect(requests.basis("run_1")[0]).toMatchObject({ text: "总结", source: "feishu", session_key: SESSION_KEY });
      expect(requests.basis("run_none")).toEqual([]);

      // Carried on: what was stored with the request, whatever run those messages belonged to, oldest first.
      const asked = message("读一下");
      const also = message("就这篇");
      request("r1", { status: "resuming", run_id: "run_2", events: JSON.stringify({ said: [also, asked], recent: [first] }) });
      expect(requests.basis("run_2").map((each) => each.text)).toEqual(["读一下", "就这篇"]);
      // No longer being carried on: the run has claimed nothing itself.
      store.sql.exec("UPDATE continuations SET status = 'answering' WHERE id = 'r1'");
      expect(requests.basis("run_2")).toEqual([]);
      store.sql.exec("UPDATE continuations SET status = 'resuming' WHERE id = 'r1'");

      // One of them has lost its text, or is gone: there is nothing to rest on.
      store.sql.exec("UPDATE inbox SET text = NULL WHERE id = ?", also);
      expect(requests.basis("run_2")).toEqual([]);
      store.sql.exec("UPDATE inbox SET text = '就这篇' WHERE id = ?", also);
      expect(requests.basis("run_2")).toHaveLength(2);
      store.sql.exec("DELETE FROM inbox WHERE id = ?", asked);
      expect(requests.basis("run_2")).toEqual([]);
    });
  });

  it("writes a carried-on request's answer as a draft, replaces it when written again, and leaves one already begun", async () => {
    await within(({ store, requests, request, run, sent }) => {
      const carried = request("r1", { status: "resuming", run_id: "run_1", target: ELSEWHERE });
      const running = run("run_1");
      expect(requests.draft(carried, running, "first")).toEqual({ ok: true });
      // Where the request came from, not where the conversation points now.
      expect(sent("answer:r1")).toMatchObject({ status: "draft", text: "first", run_id: "run_1", continuation: "r1", target: ELSEWHERE, started: 0 });
      requests.draft(carried, running, "second", true);
      expect(store.rows("SELECT id FROM outbox")).toHaveLength(1);
      // Written by the model: the agent's own words.
      expect(sent("answer:r1")).toMatchObject({ status: "draft", text: "second", authored: 1 });
      // The system's fixed words in its place: not the agent's, whatever was there before.
      requests.draft(carried, running, "not answered");
      expect(sent("answer:r1")).toMatchObject({ status: "draft", text: "not answered", authored: 0 });
      requests.draft(carried, running, "second", true);
      // An attempt to hand it over has begun: what was written stands.
      store.sql.exec("UPDATE outbox SET status = 'pending', started = 1 WHERE idem = 'answer:r1'");
      requests.draft(carried, running, "third");
      expect(sent("answer:r1")).toMatchObject({ status: "pending", text: "second", started: 1 });
      // And so does one that has been sent.
      store.sql.exec("UPDATE outbox SET status = 'sent', started = 0 WHERE idem = 'answer:r1'");
      requests.draft(carried, running, "fourth");
      expect(sent("answer:r1")).toMatchObject({ status: "sent", text: "second" });
    });
  });

  it("lists as cancellable what waits or is carried on, and an answer only while nothing of it has been handed over", async () => {
    await within(({ requests, request, outgoing }) => {
      request("r_waiting");
      request("r_resuming", { status: "resuming" });
      request("r_unsent", { status: "answering" });
      outgoing("answer:r_unsent", { continuation: "r_unsent" });
      request("r_begun", { status: "answering" });
      outgoing("answer:r_begun", { continuation: "r_begun", started: 1 });
      request("r_sent", { status: "answering" });
      outgoing("answer:r_sent", { continuation: "r_sent", status: "sent" });
      request("r_no_answer", { status: "answering" });
      request("r_done", { status: "done" });
      request("r_cancelled", { status: "cancelled" });
      request("r_elsewhere", { session_id: "s2" });
      expect(requests.cancellable(SESSION).map((each) => each.id)).toEqual(["r_waiting", "r_resuming", "r_unsent"]);
      expect(requests.cancellable("s2").map((each) => each.id)).toEqual(["r_elsewhere"]);
      expect(requests.cancellable("s_none")).toEqual([]);
    });
  });

  it("calls a request off: ended as cancelled by that call, its unsent answer emptied, a choice recorded only when it was one", async () => {
    await within(({ store, requests, request, kept, outgoing, sent, audited }) => {
      const which = `asked_which:${SESSION}:`;
      const asked = { ids: ["r1", "r2"], question: "which:call_0" };
      store.setMeta(which, JSON.stringify(asked));
      const one = request("r1", { status: "answering" });
      outgoing("answer:r1", { continuation: "r1", text: "what it read", review: "{}", error: "busy" });
      outgoing("answer:r_other", { continuation: "r_other", text: "another's" });
      requests.cancel(one, "call_9");
      expect(kept("r1")).toMatchObject({ status: "cancelled", why: calledOff("call_9") });
      expect(kept("r1").why).toBe("the person called it off (call_9)");
      expect(sent("answer:r1")).toMatchObject({ status: "void", text: "", review: null, error: null });
      expect(sent("answer:r_other")).toMatchObject({ status: "pending", text: "another's" });
      // No choice was made by this.
      expect(JSON.parse(store.meta(which)!)).toEqual(asked);

      // One whose answer is already on its way: the request ends, the answer is not touched. This one was the answer to "which?".
      const two = request("r2", { status: "answering" });
      outgoing("answer:r2", { continuation: "r2", text: "on its way", started: 1 });
      requests.cancel(two, "call_10", 42);
      expect(kept("r2")).toMatchObject({ status: "cancelled", why: calledOff("call_10") });
      expect(sent("answer:r2")).toMatchObject({ status: "pending", text: "on its way" });
      expect(JSON.parse(store.meta(which)!)).toEqual({ ...asked, chose: 42 });
      expect(audited("request.ended").map((each) => each.request)).toEqual(["r1", "r2"]);

      // Called off again by another call: it stays as the first one left it.
      requests.cancel(kept("r1"), "call_11");
      expect(kept("r1").why).toBe(calledOff("call_9"));
      expect(audited("request.ended")).toHaveLength(2);
    });
    // Where no question was asked, a choice has nowhere to be recorded and none is made up.
    await within(({ store, requests, request }) => {
      requests.cancel(request("r1"), "call_1", 7);
      expect(store.meta(`asked_which:${SESSION}:`)).toBeUndefined();
    });
  });

  it("gives a request kept before it was recorded the writer of the message it rests on", async () => {
    await runInDurableObject(env.BRAIN.getByName(`acme:user:requests-${++scopes}`), (_instance: unknown, state: DurableObjectState) => {
      const { store, request, kept, message } = bench(state);
      const asked = message("read it", {}, null, "ou_7");
      request("r_old", { events: JSON.stringify({ said: [asked], recent: [] }) });
      request("r_gone", { events: JSON.stringify({ said: [99_999], recent: [] }) });
      // As a deployment before this step has it.
      store.sql.exec("ALTER TABLE continuations DROP COLUMN person");
      store.sql.exec("ALTER TABLE continuations DROP COLUMN direct");
      store.sql.exec("ALTER TABLE runs DROP COLUMN closed");
      store.sql.exec("UPDATE meta SET value = '25' WHERE key = 'schema_version'");
      migrate(state.storage);
      expect(kept("r_old").person).toBe("ou_7");
      expect(kept("r_gone").person).toBeNull();
    });
  });

  it("carries over a question asked before whose requests were recorded, and keeps its one answer one", async () => {
    await runInDurableObject(env.BRAIN.getByName(`acme:user:requests-${++scopes}`), async (_instance: unknown, state: DurableObjectState) => {
      const { store, requests, request, message, run } = bench(state);
      // A private conversation, as before the step: two requests of one person, and "which one?" already delivered.
      store.sql.exec("UPDATE sessions SET session_key = ? WHERE id = ?", PRIVATE_KEY, SESSION);
      const private_ = (text: string, runId: string | null = null) => {
        const id = message(text, {}, runId);
        store.sql.exec("UPDATE inbox SET session_key = ? WHERE id = ?", PRIVATE_KEY, id);
        return id;
      };
      const asked = private_("read both");
      request("r1", { events: JSON.stringify({ said: [asked], recent: [] }) });
      request("r2", { events: JSON.stringify({ said: [asked], recent: [] }) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.sql.exec("INSERT INTO outbox (idem, target, text, status, next_at, created_at, sent_at, receipt) VALUES ('which:old', ?, 'which?', 'sent', 0, 0, ?, ?)", TARGET, Date.now(), JSON.stringify({ subject: "feishu:message:om_which", holder: "" }));
      store.setMeta(`asked_which:${SESSION}`, JSON.stringify({ ids: ["r1", "r2"], question: "which:old" }));
      store.sql.exec("ALTER TABLE continuations DROP COLUMN person");
      store.sql.exec("ALTER TABLE continuations DROP COLUMN direct");
      store.sql.exec("ALTER TABLE runs DROP COLUMN closed");
      store.sql.exec("UPDATE meta SET value = '25' WHERE key = 'schema_version'");
      migrate(state.storage);
      expect(store.meta(`asked_which:${SESSION}`)).toBeUndefined();
      expect(JSON.parse(store.meta(`asked_which:${SESSION}:ou_1`)!)).toEqual({ ids: ["r1", "r2"], question: "which:old" });

      // Their reply to that question still picks one.
      const picking = run("run_pick");
      const choice = private_("第一个", "run_pick");
      store.sql.exec("UPDATE inbox SET data = json_set(data, '$.replies_to', 'feishu:message:om_which') WHERE id = ?", choice);
      const picked = requests.mayCancel(picking, "r1", "call_1");
      expect(picked).toMatchObject({ record: { id: "r1" }, choosing: choice });
      requests.cancel(picked.record, "call_1", picked.choosing);
      expect(JSON.parse(store.meta(`asked_which:${SESSION}:ou_1`)!).chose).toBe(choice);
    });
    // A request whose person was never recorded: the choice is still used up, under the person who made it.
    await within(async ({ store, requests, request, kept, message, run, sent }) => {
      store.sql.exec("UPDATE sessions SET session_key = ? WHERE id = ?", PRIVATE_KEY, SESSION);
      request("r1");
      request("r2");
      const first = run("run_1");
      store.sql.exec("UPDATE inbox SET session_key = ? WHERE id = ?", PRIVATE_KEY, message("取消", {}, "run_1"));
      expect(() => requests.mayCancel(first, "r1", "call_1")).toThrow(/more than one request could be meant/);
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.sql.exec("UPDATE outbox SET status = 'sent', sent_at = ?, receipt = ? WHERE idem = 'which:call_1'", Date.now(), JSON.stringify({ subject: "feishu:message:om_w", holder: "" }));
      const second = run("run_2");
      const choice = message("第一个", {}, "run_2");
      store.sql.exec("UPDATE inbox SET session_key = ? WHERE id = ?", PRIVATE_KEY, choice);
      const picked = requests.mayCancel(second, "r1", "call_2");
      expect(picked.choosing).toBe(choice);
      requests.cancel(picked.record, "call_2", picked.choosing);
      expect(JSON.parse(store.meta(`asked_which:${SESSION}:ou_1`)!).chose).toBe(choice);
      expect(() => requests.mayCancel(second, "r2", "call_3")).toThrow(/already been taken as choosing one request/);
      void kept;
      void sent;
    });
  });

  it("keeps a choice made before the upgrade used up, when the request it chose is gone but who chose is known", async () => {
    await runInDurableObject(env.BRAIN.getByName(`acme:user:requests-${++scopes}`), async (_instance: unknown, state: DurableObjectState) => {
      const { store, requests, request, message, run } = bench(state);
      store.sql.exec("UPDATE sessions SET session_key = ? WHERE id = ?", PRIVATE_KEY, SESSION);
      const private_ = (text: string, runId: string | null = null) => {
        const id = message(text, {}, runId);
        store.sql.exec("UPDATE inbox SET session_key = ? WHERE id = ?", PRIVATE_KEY, id);
        return id;
      };
      const asked = private_("read the second");
      // The first was called off by the choice, and what it rested on is no longer on record.
      request("r1", { status: "cancelled", events: JSON.stringify({ said: [99_999], recent: [] }) });
      request("r2", { events: JSON.stringify({ said: [asked], recent: [] }) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.sql.exec("INSERT INTO outbox (idem, target, text, status, next_at, created_at, sent_at, receipt) VALUES ('which:old', ?, 'which?', 'sent', 0, 0, ?, ?)", TARGET, Date.now(), JSON.stringify({ subject: "feishu:message:om_which", holder: "" }));
      run("run_pick");
      const choice = private_("第一个", "run_pick");
      store.setMeta(`asked_which:${SESSION}`, JSON.stringify({ ids: ["r1", "r2"], question: "which:old", chose: choice }));
      store.sql.exec("ALTER TABLE continuations DROP COLUMN person");
      store.sql.exec("ALTER TABLE continuations DROP COLUMN direct");
      store.sql.exec("ALTER TABLE runs DROP COLUMN closed");
      store.sql.exec("UPDATE meta SET value = '25' WHERE key = 'schema_version'");
      migrate(state.storage);
      expect(JSON.parse(store.meta(`asked_which:${SESSION}:ou_1`)!).chose).toBe(choice);
      const running = store.rows<RunRow>("SELECT * FROM runs WHERE id = 'run_pick'")[0];
      expect(() => requests.mayCancel(running, "r2", "call_2")).toThrow(/already been taken as choosing one request/);
    });
    // Where what is on record points at more than one person, nothing is guessed: the question is dropped.
    await runInDurableObject(env.BRAIN.getByName(`acme:user:requests-${++scopes}`), (_instance: unknown, state: DurableObjectState) => {
      const { store, request, message } = bench(state);
      request("r1", { events: JSON.stringify({ said: [message("one", {}, null, "ou_1")], recent: [] }) });
      request("r2", { events: JSON.stringify({ said: [message("two", {}, null, "ou_2")], recent: [] }) });
      store.setMeta(`asked_which:${SESSION}`, JSON.stringify({ ids: ["r1", "r2"], question: "which:old" }));
      store.sql.exec("ALTER TABLE continuations DROP COLUMN person");
      store.sql.exec("ALTER TABLE continuations DROP COLUMN direct");
      store.sql.exec("ALTER TABLE runs DROP COLUMN closed");
      store.sql.exec("UPDATE meta SET value = '25' WHERE key = 'schema_version'");
      migrate(state.storage);
      expect(store.rows("SELECT key FROM meta WHERE key LIKE 'asked_which:%'")).toEqual([]);
    });
  });

  it("takes a request whose person was never recorded as anyone's only in a private conversation", async () => {
    await within(({ store, requests, request }) => {
      request("r_legacy");
      // Here the conversation is one that several people share.
      expect(requests.cancellable(SESSION, "ou_1")).toEqual([]);
      store.sql.exec("UPDATE sessions SET session_key = ? WHERE id = ?", PRIVATE_KEY, SESSION);
      expect(requests.cancellable(SESSION, "ou_1").map((each) => each.id)).toEqual(["r_legacy"]);
    });
  });

  it("keeps each person's requests apart where several people share a conversation", async () => {
    await within(async ({ store, host, requests, request, kept, message, run, outgoing, sent }) => {
      const bob: Acting = { ...PERSON, person: "ou_2" };
      request("r_a1", { person: "ou_1" });
      request("r_a2", { person: "ou_1" });
      request("r_b", { person: "ou_2" });
      // Listed for the person whose run it is, and for nobody else.
      expect(requests.cancellable(SESSION, "ou_1").map((each) => each.id)).toEqual(["r_a1", "r_a2"]);
      expect(requests.cancellable(SESSION, "ou_2").map((each) => each.id)).toEqual(["r_b"]);
      expect(requests.cancellable(SESSION, "ou_3")).toEqual([]);

      // Bob cannot call off Alice's, and is not told what hers are.
      host.acting = bob;
      const his = run("run_bob");
      message("不用了", {}, "run_bob", "ou_2");
      let refusal = "";
      try {
        requests.mayCancel(his, "r_a1", "call_b1");
      } catch (error) {
        refusal = String(error);
      }
      expect(refusal).toMatch(/not a request this could be about/);
      expect(refusal).not.toMatch(/r_a1|r_a2/);
      expect(kept("r_a1").status).toBe("waiting");
      // His own, the only one of his, he can.
      expect(requests.mayCancel(his, "r_b", "call_b2").record.id).toBe("r_b");

      // Alice has two: she is asked which. The question is hers alone.
      host.acting = PERSON;
      const hers = run("run_alice");
      message("取消", {}, "run_alice", "ou_1");
      expect(() => requests.mayCancel(hers, "r_a1", "call_a1")).toThrow(/more than one request could be meant/);
      expect(sent("which:call_a1").text).not.toMatch(/r_b/);
      expect(store.meta(`asked_which:${SESSION}:ou_1`)).toBeDefined();
      expect(store.meta(`asked_which:${SESSION}:ou_2`)).toBeUndefined();
      // The question reaches the chat; Bob writes first, then Alice. Hers is the answer to it, not his.
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.sql.exec("UPDATE outbox SET status = 'sent', sent_at = ?, receipt = ? WHERE idem = 'which:call_a1'", Date.now(), JSON.stringify({ subject: "feishu:message:om_which", holder: "" }));
      message("我也看看", {}, null, "ou_2");
      const answering = run("run_alice_2");
      const choice = message("第一个", {}, "run_alice_2", "ou_1");
      expect(requests.mayCancel(answering, "r_a1", "call_a2")).toMatchObject({ record: { id: "r_a1" }, choosing: choice });
      requests.cancel(kept("r_a1"), "call_a2", choice);
      expect(JSON.parse(store.meta(`asked_which:${SESSION}:ou_1`)!).chose).toBe(choice);

      // An answer waits for its own person's unhandled words, not for anyone else's.
      request("r_ans", { person: "ou_1", status: "answering", claimed_at: Date.now() });
      outgoing("answer:r_ans", { continuation: "r_ans" });
      const row = sent("answer:r_ans") as never;
      message("大家好", {}, null, "ou_2", "pending");
      expect(await requests.gate(row)).not.toBe("hold");
      message("等等", {}, null, "ou_1", "pending");
      expect(await requests.gate(row)).toBe("hold");
    });
  });

  it("takes a reply to be about a request only through that request's answer, its invitation, or a message it was tied to", async () => {
    await within(({ requests, host, request, message, sourceId, run, outgoing }) => {
      const asked = message("读一下这篇");
      const loose = message("顺便说一句");
      request("r_a", { person: "ou_1", events: JSON.stringify({ said: [asked, loose], recent: [], bound: [asked] }) });
      // Tied to no message by its tool: only what the system sent for it is about it.
      request("r_b", { person: "ou_1", events: JSON.stringify({ said: [loose], recent: [] }) });
      outgoing("answer:r_a", { continuation: "r_a", status: "sent", receipt: JSON.stringify({ subject: "feishu:message:om_answer_a" }) });
      outgoing("invite:int:r_b", { interaction: "int:r_b", status: "sent", receipt: JSON.stringify({ subject: "feishu:message:om_invite_b" }) });
      outgoing("unrelated", { status: "sent", receipt: JSON.stringify({ subject: "feishu:message:om_unrelated" }) });
      let runs = 0;
      /** Which of the two a message written as a reply to that could be calling off. */
      const about = (subject: string) => {
        const id = `run_${++runs}`;
        const running = run(id);
        message("不用了", { replies_to: subject }, id);
        return ["r_a", "r_b"].filter((each) => {
          try {
            return requests.mayCancel(running, each, `call_${id}_${each}`).record.id === each;
          } catch {
            return false;
          }
        });
      };
      expect(about("feishu:message:om_answer_a")).toEqual(["r_a"]);
      expect(about("feishu:message:om_invite_b")).toEqual(["r_b"]);
      expect(about(`feishu:message:${sourceId(asked)}`)).toEqual(["r_a"]);
      // In the request's batch, and not what its tool tied it to.
      expect(about(`feishu:message:${sourceId(loose)}`)).toEqual([]);
      expect(about("feishu:message:om_unrelated")).toEqual([]);
      expect(about("feishu:message:om_nothing")).toEqual([]);

      const running = run("run_last");
      message("不用了", { replies_to: "feishu:message:om_unrelated" }, "run_last");
      expect(() => requests.mayCancel(running, "r_a", "call_x")).toThrow("there is no request that this could be about");
      // Nothing was ended by asking, and nobody was asked which.
      expect(requests.cancellable(SESSION).map((each) => each.id)).toEqual(["r_a", "r_b"]);
      // Not the person's own run: not at all, whatever it replies to.
      host.acting = undefined;
      expect(() => requests.mayCancel(running, "r_a", "call_y")).toThrow(/only be cancelled when the person themselves asks/);
    });
  });

  it("shows everything waited on in one shape, newest request first", async () => {
    await within(({ store, requests, request, outgoing }) => {
      const states = { waiting: "waiting", resuming: "continuing", answering: "answer to be sent", done: "done", failed: "failed", cancelled: "withdrawn", expired: "withdrawn", void: "withdrawn", unverified: "cannot be verified" };
      for (const status of Object.keys(states)) request(`r_${status}`, { status });
      // The way in was shown for one of them, and written but not delivered for another.
      outgoing("invite:int:r_waiting", { interaction: "int:r_waiting", status: "sent" });
      outgoing("invite:int:r_resuming", { interaction: "int:r_resuming" });
      const requested = requests.waits();
      expect(requested.map((each) => each.kind)).toEqual(Object.keys(states).map(() => "request"));
      expect(requested.map((each) => [each.id, each.state])).toEqual(Object.entries(states).map(([status, state]) => [`r_${status}`, state]).reverse());
      expect(requested.filter((each) => each.shown).map((each) => each.id)).toEqual(["r_waiting"]);
      expect(requested.map((each) => each.since)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);

      // Approval questions are looked at where they are kept.
      store.sql.exec("INSERT INTO outbox (idem, target, text, status, next_at, created_at, ask, closed) VALUES ('ask:open', ?, 'q', 'sent', 0, 11, '{}', NULL), ('ask:refused', ?, 'q', 'pending', 0, 12, '{}', ?)", TARGET, TARGET, JSON.stringify({ state: "refused" }));
      expect(requests.waits().filter((each) => each.kind === "approval")).toEqual([
        { kind: "approval", id: "ask:refused", state: "refused", shown: false, since: 12 },
        { kind: "approval", id: "ask:open", state: "waiting", shown: true, since: 11 },
      ]);
    });
  });
});

describe("what a run read under, by itself", () => {
  const source: Source = { connector: "feishu", tool: "feishu_read_document", args: JSON.stringify({ document: "https://example.feishu.cn/docx/Doc1" }), identity: "docx:Doc1", condition: "cond_1", generation: 3 };
  const guard: Guard = { connector: "feishu", condition: "cond_1", generation: 3 };

  it("notes which thing a read was of, and under what, and nothing of what it said", async () => {
    await within(({ store, requests }) => {
      requests.noteSource("run_1", source);
      requests.noteSource("run_1", { ...source, identity: "docx:Doc2" });
      expect(JSON.parse(store.meta("sources:run_1") ?? "null")).toEqual([source, { ...source, identity: "docx:Doc2" }]);
      expect(requests.guards("run_1")).toEqual([guard]);
    });
  });

  it("gives each thing a run read under once, and nothing for a read made under nothing", async () => {
    await within(({ requests }) => {
      expect(requests.guards("run_1")).toEqual([]);
      const free: Source = { ...source, condition: undefined, generation: undefined };
      requests.noteSource("run_1", free);
      expect(requests.guards("run_1")).toEqual([]);
      requests.noteSource("run_1", source);
      requests.noteSource("run_1", { ...source, identity: "docx:Doc2" });
      requests.noteSource("run_1", { ...source, generation: 4 });
      expect(requests.guards("run_1")).toEqual([guard, { ...guard, generation: 4 }]);
      expect(requests.guards("run_other")).toEqual([]);
    });
  });

  it("takes a read an earlier version noted for reopening a kept answer as no longer to be relied on, without asking anyone", async () => {
    await within(async ({ store, requests }) => {
      // Left by version 21 in a run that was paused part way: the answer was kept until a time.
      store.setMeta("sources:run_old", JSON.stringify([{ ...source, until: 9e15 }]));
      expect(requests.guards("run_old")).toEqual([{ ...guard, retired: true }]);
      expect(await requests.over(requests.guards("run_old"))).toBe("it rested on an answer kept for follow-ups, which are retired");
    });
  });

  it("ties to what a run read under only that run's messages not yet handed over", async () => {
    await within(({ store, requests, outgoing, sent }) => {
      outgoing("pending", { run_id: "run_1" });
      outgoing("draft", { run_id: "run_1", status: "draft" });
      outgoing("sent", { run_id: "run_1", status: "sent" });
      outgoing("void", { run_id: "run_1", status: "void" });
      outgoing("other_run", { run_id: "run_2" });
      outgoing("no_run");
      const guarded = () => store.rows<{ idem: string }>("SELECT idem FROM outbox WHERE guard IS NOT NULL ORDER BY id").map((each) => each.idem);
      // A run that read under nothing ties nothing.
      requests.stampGuards("run_1");
      expect(guarded()).toEqual([]);
      // Noting a read does it at once.
      requests.noteSource("run_1", source);
      expect(guarded()).toEqual(["pending", "draft"]);
      expect(JSON.parse(sent("pending").guard as string)).toEqual([guard]);
      // A message written afterwards is tied when asked, with everything read by then.
      requests.noteSource("run_1", { ...source, generation: 4 });
      outgoing("later", { run_id: "run_1" });
      requests.stampGuards("run_1");
      expect(guarded()).toEqual(["pending", "draft", "later"]);
      for (const idem of ["pending", "draft", "later"]) expect(JSON.parse(sent(idem).guard as string), idem).toEqual([guard, { ...guard, generation: 4 }]);
    });
  });
});

describe("when requests next need the Brain awake", () => {
  const NOW = 1_800_000_000_000;

  it("asks for nothing when nothing waits", async () => {
    await within(({ requests }) => expect(requests.nextWakeAt(NOW)).toBeNull());
  });

  it("asks to be woken at a waiting request's deadline, or at its next check if that comes first", async () => {
    await within(({ requests, request }) => {
      request("a", { until: NOW + 60_000 });
      expect(requests.nextWakeAt(NOW)).toBe(NOW + 60_000);
      request("b", { until: NOW + 90_000, check_at: NOW + 20_000 });
      expect(requests.nextWakeAt(NOW)).toBe(NOW + 20_000);
    });
  });

  it("looks again in a minute at a wait whose time is up, until it has been dealt with", async () => {
    await within(({ requests, request }) => {
      request("late", { until: NOW - 5_000 });
      expect(requests.nextWakeAt(NOW)).toBe(NOW + 60_000);
    });
  });

  it("does not let a wait whose time is up hold back another wait's earlier check", async () => {
    await within(({ requests, request }) => {
      request("late", { until: NOW - 5_000 });
      request("b", { until: NOW + 90_000, check_at: NOW + 20_000 });
      expect(requests.nextWakeAt(NOW)).toBe(NOW + 20_000);
    });
  });

  it("looks again at a wait whose time is up when its own next check is due", async () => {
    await within(({ requests, request }) => {
      // Its owner could not be asked; it is to be asked again in half a minute.
      request("late", { until: NOW - 5_000, check_at: NOW + 30_000 });
      expect(requests.nextWakeAt(NOW)).toBe(NOW + 30_000);
    });
  });

  it("does not let a missed check put off the same wait's coming deadline", async () => {
    await within(({ requests, request }) => {
      request("w", { until: NOW + 10_000, check_at: NOW - 1 });
      expect(requests.nextWakeAt(NOW)).toBe(NOW + 10_000);
    });
  });

  it("ignores requests that are no longer waiting", async () => {
    await within(({ requests, request }) => {
      request("resuming", { until: NOW + 1_000, status: "resuming" });
      request("done", { until: NOW + 1_000, status: "done" });
      expect(requests.nextWakeAt(NOW)).toBeNull();
    });
  });

});

describe("keeping a request that has to wait", () => {
  const waiting = { on: "authorisation", subject: "grant_1", condition: "cond_1", generation: 1, until: Date.now() + 600_000, interaction: "grant_1.nonce", request: { document: "docx:abc" } };

  it("keeps the record, puts the way in before the person and asks once whether it already holds, together", async () => {
    await within(({ requests, store, run, message, audited, hints }) => {
      const active = run("r1");
      const said = message("总结一下", {}, "r1");
      const result = requests.wait(active, { connector: "feishu", events: { said: [said], recent: [] } }, "call_1", "feishu_read_document", waiting);
      expect(result).toMatchObject({ waiting: true, request: "call_1" });
      expect(store.rows("SELECT id, status, args FROM continuations")).toEqual([{ id: "call_1", status: "waiting", args: JSON.stringify(waiting.request) }]);
      expect(store.rows("SELECT idem, interaction FROM outbox")).toEqual([{ idem: "invite:grant_1.nonce", interaction: "grant_1.nonce" }]);
      expect(audited("request.waiting")).toHaveLength(1);
      expect(hints()).toHaveLength(1);
    });
  });

  describe("a way in shown to the person alone, where they asked", () => {
    const HERE = JSON.stringify({ connector: "feishu", address: { app_id: "cli_1", chat_id: "oc_1", visible_to: "ou_1" } });
    const DIRECT = JSON.stringify({ connector: "feishu", address: { app_id: "cli_1", open_id: "ou_1" } });
    const acting = { connector: "feishu", person: "ou_1", origin: { app_id: "cli_1", tenant_key: "org_1" } };
    const asking = (use: (all: ReturnType<typeof bench>, invite: () => Record<string, any>) => void | Promise<void>, set: (all: ReturnType<typeof bench>) => void = () => undefined) =>
      within(async (all) => {
        set(all);
        const said = all.message("总结一下", {}, "r1");
        all.requests.wait(all.run("r1"), { ...acting, events: { said: [said], recent: [] } }, "call_1", "feishu_read_document", { ...waiting, privately: "here" });
        await use(all, () => all.sent("invite:grant_1.nonce"));
      });

    it("goes where the connector says that is, and nothing more is said once it is there", async () => {
      await asking(({ requests, store, kept }, invite) => {
        expect(invite().target).toBe(HERE);
        expect(kept("call_1").direct).toBe(2);
        requests.shown(invite() as never, "reached");
        expect(store.rows("SELECT idem FROM outbox")).toHaveLength(1);
      });
    });

    it("goes to the person directly where the connector cannot show it there", async () => {
      await asking(
        ({ kept }, invite) => {
          expect(invite().target).toBe(DIRECT);
          expect(kept("call_1").direct).toBe(1);
        },
        ({ settings }) => (settings.noAside = "1"),
      );
    });

    it("goes to the person directly instead, once, when it was certainly not shown there; how that goes is said as for any sent directly", async () => {
      await asking(({ requests, store, kept, sent }, invite) => {
        store.sql.exec("UPDATE outbox SET status = 'dead', attempts = 1, started = 1 WHERE idem = 'invite:grant_1.nonce'");
        requests.shown(invite() as never, "failed");
        // The one that failed stays as it is; another is made, for the same way in, to them directly.
        expect(invite()).toMatchObject({ target: HERE, status: "dead" });
        const direct = () => sent("invite:grant_1.nonce:direct");
        expect(direct()).toMatchObject({ target: DIRECT, interaction: "grant_1.nonce" });
        expect(kept("call_1").direct).toBe(1);
        expect(sent(told("grant_1.nonce", "call_1"))).toBeUndefined();
        // Told again that the first failed (a repeat): nothing more is made.
        requests.shown(invite() as never, "failed");
        expect(store.rows("SELECT idem FROM outbox")).toHaveLength(2);
        // It reaches them there: the conversation is told so. Had it failed too, that is said, and it is not moved again.
        requests.shown(direct() as never, "reached");
        expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ target: TARGET, text: "notice:invitedElsewhere" });
      });
      await asking(({ requests, store, sent }, invite) => {
        store.sql.exec("UPDATE outbox SET status = 'dead', attempts = 1, started = 1 WHERE idem = 'invite:grant_1.nonce'");
        requests.shown(invite() as never, "failed");
        store.sql.exec("UPDATE outbox SET status = 'dead' WHERE idem = 'invite:grant_1.nonce:direct'");
        requests.shown(sent("invite:grant_1.nonce:direct") as never, "failed");
        expect(store.rows("SELECT idem FROM outbox WHERE interaction IS NOT NULL")).toHaveLength(2);
        expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ text: "notice:inviteNotSent" });
      });
    });

    it("is made up for at the next look when going to them directly could not be written down at once: one card, however often it is looked at", async () => {
      await asking(({ requests, store, host, kept, sent }, invite) => {
        store.sql.exec("UPDATE outbox SET status = 'dead', attempts = 1, started = 1, uncertain = 0 WHERE idem = 'invite:grant_1.nonce'");
        const enqueue = host.enqueueMessage;
        host.enqueueMessage = (idem, ...rest) => {
          if (idem.endsWith(":direct")) throw new Error("the queue could not be written");
          return enqueue(idem, ...rest);
        };
        expect(() => requests.shown(invite() as never, "failed")).not.toThrow();
        expect(kept("call_1").direct).toBe(2);
        expect(sent("invite:grant_1.nonce:direct")).toBeUndefined();
        // Nothing is said yet where they asked: it is still going to them directly, and that is what will be said.
        expect(sent(told("grant_1.nonce", "call_1"))).toBeUndefined();
        // And it is looked at again soon, by itself, well before the request's time is up.
        const next = requests.nextWakeAt(Date.now())!;
        expect(next - Date.now()).toBeLessThanOrEqual(5_000);
        expect(kept("call_1").until - next).toBeGreaterThan(60_000);
        host.enqueueMessage = enqueue;
        requests.deadlines(Date.now());
        requests.deadlines(Date.now());
        expect(store.rows("SELECT idem FROM outbox WHERE interaction IS NOT NULL ORDER BY id")).toEqual([{ idem: "invite:grant_1.nonce" }, { idem: "invite:grant_1.nonce:direct" }]);
        expect(kept("call_1").direct).toBe(1);
        // Made up for: nothing more to look at before the request's own time.
        expect(requests.nextWakeAt(Date.now())).toBe(kept("call_1").until);
        // Shown, as far as anyone looking can tell, once that one has arrived; and where they asked is told that, in one line.
        store.sql.exec("UPDATE outbox SET status = 'sent' WHERE idem = 'invite:grant_1.nonce:direct'");
        requests.shown(sent("invite:grant_1.nonce:direct") as never, "reached");
        expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ text: "notice:invitedElsewhere" });
        expect(requests.waits().find((each) => each.id === "call_1")).toMatchObject({ shown: true });
      });
      // Not for one whose outcome is unknown, nor for a request that has ended.
      await asking(({ requests, store }) => {
        store.sql.exec("UPDATE outbox SET status = 'unverified', started = 1, uncertain = 1 WHERE idem = 'invite:grant_1.nonce'");
        requests.deadlines(Date.now());
        expect(store.rows("SELECT idem FROM outbox WHERE interaction IS NOT NULL")).toHaveLength(1);
      });
      await asking(({ requests, store }) => {
        store.sql.exec("UPDATE outbox SET status = 'dead', started = 1, uncertain = 0 WHERE idem = 'invite:grant_1.nonce'");
        requests.endRequest("call_1", "cancelled", "x");
        requests.deadlines(Date.now());
        expect(store.rows("SELECT idem FROM outbox WHERE interaction IS NOT NULL")).toHaveLength(1);
      });
    });

    it("says so where the request was made when they cannot be reached directly either, or when it cannot be told whether it was shown", async () => {
      await asking(
        async ({ requests, store, sent }, invite) => {
          store.sql.exec("UPDATE outbox SET status = 'dead', attempts = 1, started = 1 WHERE idem = 'invite:grant_1.nonce'");
          requests.shown(invite() as never, "failed");
          expect(store.rows("SELECT idem FROM outbox WHERE interaction IS NOT NULL")).toHaveLength(1);
          const line = sent(told("grant_1.nonce", "call_1"));
          expect(line).toMatchObject({ target: TARGET, text: "notice:inviteNotShown" });
          expect(await requests.gate(line as never)).toBe("send");
        },
        ({ settings }) => (settings.noDirect = "1"),
      );
      await asking(({ requests, store, sent }, invite) => {
        store.sql.exec("UPDATE outbox SET status = 'unverified', started = 1, uncertain = 1 WHERE idem = 'invite:grant_1.nonce'");
        requests.shown(invite() as never, "unknown");
        expect(invite()).toMatchObject({ target: HERE, status: "unverified" });
        expect(store.rows("SELECT idem FROM outbox WHERE interaction IS NOT NULL")).toHaveLength(1);
        expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ target: TARGET, text: "notice:inviteUnknownHere" });
      });
    });

    it("is one request when the same messages ask for the same thing twice over: one answer will come of it", async () => {
      await asking(({ requests, store, kept, hints }) => {
        const before = hints().length;
        const said = (JSON.parse(kept("call_1").events) as { said: number[] }).said;
        const again = requests.wait(store.rows<RunRow>("SELECT * FROM runs WHERE id = 'r1'")[0], { ...acting, events: { said, recent: [] } }, "call_1b", "feishu_read_document", { ...waiting, privately: "here" });
        expect(again).toMatchObject({ waiting: true, request: "call_1" });
        // Kept, so that the second call has this for its answer if it is made again after an interruption.
        expect(JSON.parse(store.meta("waited:call_1b")!)).toEqual({ request: "call_1", run: "r1" });
        expect(store.rows("SELECT id FROM continuations")).toEqual([{ id: "call_1" }]);
        expect(store.rows("SELECT idem FROM outbox")).toHaveLength(1);
        expect(hints().length).toBe(before);
        // Something else asked for by the same messages is its own request.
        requests.wait(store.rows<RunRow>("SELECT * FROM runs WHERE id = 'r1'")[0], { ...acting, events: { said, recent: [] } }, "call_other", "feishu_read_document", { ...waiting, request: { document: "another" }, privately: "here" });
        expect(store.rows("SELECT id FROM continuations ORDER BY rowid")).toEqual([{ id: "call_1" }, { id: "call_other" }]);
      });
    });

    it("is never put where everyone would see it: with no way to show it to the person alone, nothing waits", async () => {
      await within((all) => {
        all.settings.noAside = "1";
        all.settings.noDirect = "1";
        const said = all.message("总结一下", {}, "r1");
        expect(() => all.requests.wait(all.run("r1"), { ...acting, events: { said: [said], recent: [] } }, "call_1", "feishu_read_document", { ...waiting, privately: "here" })).toThrow(/cannot be reached directly/);
        expect(all.store.rows("SELECT 1 FROM outbox")).toEqual([]);
      });
    });
  });

  it("puts the way in before the person themselves where the tool says so, and tells the conversation only how that went", async () => {
    const to = JSON.stringify({ connector: "feishu", address: { app_id: "cli_1", open_id: "ou_1" } });
    const acting = { connector: "feishu", person: "ou_1", origin: { app_id: "cli_1", tenant_key: "org_1" } };
    const asking = (use: (bench_: ReturnType<typeof bench>, invite: () => Record<string, unknown>) => void | Promise<void>, privately = true) =>
      within(async (all) => {
        const active = all.run("r1");
        const said = all.message("总结一下", {}, "r1");
        all.requests.wait(active, { ...acting, events: { said: [said], recent: [] } }, "call_1", "feishu_read_document", { ...waiting, ...(privately ? { privately: true } : {}) });
        await use(all, () => all.sent("invite:grant_1.nonce"));
      });
    // To the person, as the connector addresses them from where the request verifiably came: not to where it was made.
    await asking(async ({ requests, sent, store }, invite) => {
      expect(invite().target).toBe(to);
      expect(store.rows("SELECT idem FROM outbox")).toHaveLength(1);
      // It reached them: the conversation is told so, once, without the way in itself.
      requests.shown(invite() as never, "reached");
      requests.shown(invite() as never, "reached");
      expect(store.rows("SELECT idem FROM outbox")).toHaveLength(2);
      const line = sent(told("grant_1.nonce", "call_1"));
      expect(line).toMatchObject({ target: TARGET, text: "notice:invitedElsewhere", interaction: null, continuation: null });
      // Sent only while that request still waits.
      expect(await requests.gate(line as never)).toBe("send");
      requests.endRequest("call_1", "cancelled", "x");
      expect(await requests.gate(line as never)).toBe("void");
    });
    // It did not reach them, or there is no telling: each is said as what it is.
    await asking(({ requests, sent }, invite) => {
      requests.shown(invite() as never, "failed");
      expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ text: "notice:inviteNotSent" });
    });
    await asking(({ requests, sent }, invite) => {
      requests.shown(invite() as never, "unknown");
      expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ text: "notice:inviteUnknown" });
    });
    // A request no longer waiting is told nothing.
    await asking(({ requests, store }, invite) => {
      requests.endRequest("call_1", "cancelled", "x");
      requests.shown(invite() as never, "reached");
      expect(store.rows("SELECT idem FROM outbox")).toHaveLength(1);
    });
    // A second request that comes to wait on a way in already delivered is told at once.
    await asking(({ requests, store, run, message, sent }, invite) => {
      store.sql.exec("UPDATE outbox SET status = 'sent', sent_at = 1 WHERE idem = 'invite:grant_1.nonce'");
      const next = run("r2");
      const said = message("再读一篇", {}, "r2");
      requests.wait(next, { ...acting, events: { said: [said], recent: [] } }, "call_2", "feishu_read_document", { ...waiting, privately: true });
      expect(sent(told("grant_1.nonce", "call_2"))).toMatchObject({ text: "notice:invitedElsewhere" });
      expect(sent(told("grant_1.nonce", "call_1"))).toBeUndefined();
      void invite;
    });
    // A reply to that line is about that request.
    await asking(({ requests, store, run, message, kept }, invite) => {
      requests.shown(invite() as never, "reached");
      store.sql.exec("UPDATE outbox SET status = 'sent', sent_at = 1, receipt = ? WHERE idem = ?", JSON.stringify({ subject: "feishu:message:om_told", holder: "" }), told("grant_1.nonce", "call_1"));
      const calling = run("r_off");
      message("算了", { replies_to: "feishu:message:om_told" }, "r_off");
      expect(requests.mayCancel(calling, "call_1", "call_off").record.id).toBe("call_1");
      void kept;
    });
    // A way in that was set aside unsent, because nobody waited on it any more, goes out again for a new request.
    await asking(({ requests, store, run, message }, invite) => {
      requests.endRequest("call_1", "cancelled", "x");
      store.sql.exec("UPDATE outbox SET status = 'void' WHERE idem = 'invite:grant_1.nonce'");
      const next = run("r2");
      const said = message("再读一篇", {}, "r2");
      requests.wait(next, { ...acting, events: { said: [said], recent: [] } }, "call_2", "feishu_read_document", { ...waiting, privately: true });
      expect(invite()).toMatchObject({ status: "pending", target: to });
    });
    // One that definitely did not get there is tried afresh when they ask again; one that may have is not sent twice.
    await asking(({ requests, store, run, message, sent }, invite) => {
      store.sql.exec("UPDATE outbox SET status = 'dead', attempts = 1, started = 1 WHERE idem = 'invite:grant_1.nonce'");
      const next = run("r2");
      requests.wait(next, { ...acting, events: { said: [message("再问一次", {}, "r2")], recent: [] } }, "call_2", "feishu_read_document", { ...waiting, privately: true });
      expect(invite()).toMatchObject({ status: "pending", attempts: 0 });
      store.sql.exec("UPDATE outbox SET status = 'unverified' WHERE idem = 'invite:grant_1.nonce'");
      const third = run("r3");
      requests.wait(third, { ...acting, events: { said: [message("第三次", {}, "r3")], recent: [] } }, "call_3", "feishu_read_document", { ...waiting, privately: true });
      expect(invite().status).toBe("unverified");
      expect(sent(told("grant_1.nonce", "call_3"))).toMatchObject({ text: "notice:inviteUnknown" });
    });
    // Tried once and put off, then set aside because they called it off: asked again, it goes out, no sooner than it was told to.
    await asking(({ requests, store, run, message }, invite) => {
      const later = Date.now() + 300_000;
      requests.endRequest("call_1", "cancelled", "x");
      store.sql.exec("UPDATE outbox SET status = 'void', started = 1, uncertain = 0, attempts = 1, next_at = ? WHERE idem = 'invite:grant_1.nonce'", later);
      requests.wait(run("r2"), { ...acting, events: { said: [message("再问一次", {}, "r2")], recent: [] } }, "call_2", "feishu_read_document", { ...waiting, privately: true });
      expect(invite()).toMatchObject({ status: "pending", next_at: later });
    });
    // The way in failed, and word of that is still on its way when it is tried afresh and arrives: nobody is then told it did not.
    await asking(({ requests, store, run, message, sent }, invite) => {
      store.sql.exec("UPDATE outbox SET status = 'dead', attempts = 1, started = 1 WHERE idem = 'invite:grant_1.nonce'");
      requests.shown(invite() as never, "failed");
      expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ status: "pending", text: "notice:inviteNotSent" });
      requests.wait(run("r2"), { ...acting, events: { said: [message("再问一次", {}, "r2")], recent: [] } }, "call_2", "feishu_read_document", { ...waiting, privately: true });
      // Being tried again: what was to be said of the first try is no longer true, and is not said.
      expect(sent(told("grant_1.nonce", "call_1")).status).toBe("void");
      store.sql.exec("UPDATE outbox SET status = 'sent', sent_at = 1 WHERE idem = 'invite:grant_1.nonce'");
      requests.shown(invite() as never, "reached");
      expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ status: "pending", text: "notice:invitedElsewhere" });
      expect(sent(told("grant_1.nonce", "call_2"))).toMatchObject({ status: "pending", text: "notice:invitedElsewhere" });
      // A line that has gone out, or may have, is not said again in other words.
      store.sql.exec("UPDATE outbox SET status = 'sent' WHERE idem = ?", told("grant_1.nonce", "call_1"));
      requests.shown(invite() as never, "failed");
      expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ status: "sent", text: "notice:invitedElsewhere" });
    });
    // The same, where word of the failure was tried once and nobody knows whether it arrived: it is not tried again, and stays on record as such.
    await asking(async ({ requests, store, run, message, sent }, invite) => {
      store.sql.exec("UPDATE outbox SET status = 'dead', attempts = 1, started = 1 WHERE idem = 'invite:grant_1.nonce'");
      requests.shown(invite() as never, "failed");
      store.sql.exec("UPDATE outbox SET started = 1, uncertain = 1, attempts = 1 WHERE idem = ?", told("grant_1.nonce", "call_1"));
      requests.wait(run("r2"), { ...acting, events: { said: [message("再问一次", {}, "r2")], recent: [] } }, "call_2", "feishu_read_document", { ...waiting, privately: true });
      expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ status: "unverified", text: "notice:inviteNotSent" });
      store.sql.exec("UPDATE outbox SET status = 'sent', sent_at = 1 WHERE idem = 'invite:grant_1.nonce'");
      requests.shown(invite() as never, "reached");
      // Not said again in other words either: it may be in front of them already.
      expect(sent(told("grant_1.nonce", "call_1"))).toMatchObject({ status: "unverified", text: "notice:inviteNotSent" });
      expect(sent(told("grant_1.nonce", "call_2"))).toMatchObject({ status: "pending", text: "notice:invitedElsewhere" });
    });
    // A request's id may hold any character: which request a line is about is not read off punctuation.
    await within(async ({ requests, run, message, sent }) => {
      const active = run("r1");
      requests.wait(active, { ...acting, events: { said: [message("总结一下", {}, "r1")], recent: [] } }, "call:step1", "feishu_read_document", { ...waiting, interaction: "grant:1.nonce", privately: true });
      requests.shown(sent("invite:grant:1.nonce") as never, "reached");
      const line = sent(told("grant:1.nonce", "call:step1"));
      expect(line).toMatchObject({ text: "notice:invitedElsewhere" });
      expect(await requests.gate(line as never)).toBe("send");
    });
    // Two questions in one batch, each replied to where it was asked: the line and the answer go to the one the tool tied the request to.
    await within(({ requests, store, run, message, kept, sent }) => {
      const active = run("r1");
      const a = message("读 A", {}, "r1");
      const b = message("读 B", {}, "r1");
      const at = (id: string) => JSON.stringify({ connector: "feishu", address: { app_id: "cli_1", chat_id: "oc_1", message_id: id } });
      store.sql.exec("UPDATE inbox SET reply_to = ? WHERE id = ?", at("om_a"), a);
      store.sql.exec("UPDATE inbox SET reply_to = ? WHERE id = ?", at("om_b"), b);
      requests.wait(active, { ...acting, events: { said: [a, b], recent: [], bound: [a] } }, "call_a", "feishu_read_document", { ...waiting, privately: true });
      expect(kept("call_a").target).toBe(at("om_a"));
      requests.shown(sent("invite:grant_1.nonce") as never, "reached");
      expect(sent(told("grant_1.nonce", "call_a")).target).toBe(at("om_a"));
      // Tied to neither, with two places it could be: the answer goes where it always did, and no line is put under a guess.
      requests.wait(active, { ...acting, events: { said: [a, b], recent: [] } }, "call_x", "feishu_read_document", { ...waiting, interaction: "grant_1.other", privately: true });
      requests.shown(sent("invite:grant_1.other") as never, "reached");
      expect(sent(told("grant_1.other", "call_x"))).toBeUndefined();
    });
    // Where the way in goes to the conversation itself, as it always has, there is nothing more to say.
    await asking(({ requests, store }, invite) => {
      expect(invite().target).toBe(TARGET);
      requests.shown(invite() as never, "reached");
      expect(store.rows("SELECT idem FROM outbox")).toHaveLength(1);
    }, false);
    // A connector that cannot address the person directly: nothing is kept, and the tool's answer is not used.
    await within(({ requests, store, run, message, settings }) => {
      settings.noDirect = "1";
      const active = run("r1");
      const said = message("总结一下", {}, "r1");
      expect(() => requests.wait(active, { ...acting, events: { said: [said], recent: [] } }, "call_1", "feishu_read_document", { ...waiting, privately: true })).toThrow(/cannot be reached directly/);
      expect(store.rows("SELECT id FROM continuations")).toEqual([]);
      expect(store.rows("SELECT idem FROM outbox")).toEqual([]);
    });
  });

  it("keeps nothing at all if any part of that step fails", async () => {
    await within(({ requests, store, host, run, message, audited, hints }) => {
      const active = run("r1");
      const said = message("总结一下", {}, "r1");
      // The invitation is written, and then the step fails: the record must not be left behind
      // without the message that shows the way in, nor the message without the record.
      const enqueue = host.enqueueMessage;
      host.enqueueMessage = (...args) => {
        enqueue(...args);
        throw new Error("stop");
      };
      expect(() => requests.wait(active, { connector: "feishu", events: { said: [said], recent: [] } }, "call_1", "feishu_read_document", waiting)).toThrow("stop");
      expect(store.rows("SELECT id FROM continuations")).toEqual([]);
      expect(store.rows("SELECT idem FROM outbox")).toEqual([]);
      expect(audited("request.waiting")).toEqual([]);
      expect(hints()).toEqual([]);
    });
  });
});
