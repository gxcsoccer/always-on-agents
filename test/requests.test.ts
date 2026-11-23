import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { type Acting, type Continuation, type Guard, Requests, type RequestsHost, type Source, calledOff } from "../src/brain/requests";
import { BrainStore, type RunRow } from "../src/brain/store";

/**
 * Requests that wait, guards and follow-ups, by themselves: the part is built on a real Brain's
 * storage with a stand-in for what the Brain hands it, and rows are put there with plain SQL.
 * No model, no connector, no run, no alarm. What needs a connector to be asked (whether a
 * condition holds, a source read again) is left to the tests of the whole flow.
 */
const SESSION = "s1";
const SESSION_KEY = "dm";
const TARGET = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_1" } });
const ELSEWHERE = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_then" } });
const PERSON: Acting = { connector: "feishu", person: "ou_1", origin: { app_id: "cli_1", tenant_key: "org_1" }, said: [], recent: [], recentIds: [] };

let scopes = 0;
function within<T>(use: (bench: ReturnType<typeof bench>) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(`acme:user:requests-${++scopes}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));
}

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  const woken: number[] = [];
  const appended: unknown[] = [];
  const settings: { FOLLOW_UPS?: string } = { FOLLOW_UPS: "on" };
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
  };
  const requests = new Requests(store, host);
  store.sql.exec("INSERT INTO sessions (id, session_key, target, created_at, updated_at) VALUES (?, ?, ?, 1, 1)", SESSION, SESSION_KEY, TARGET);

  let made = 0;
  /** A request as it is kept, waiting unless said otherwise. */
  const request = (id: string, over: Partial<Continuation> & { check_at?: number | null } = {}): Continuation => {
    const row = { session_id: SESSION, events: JSON.stringify({ said: [], recent: [] }), connector: "feishu", tool: "feishu_read_document", args: "{}", target: TARGET, subject: "grant_1", condition: "cond_1", generation: 1, interaction: `int:${id}`, until: Date.now() + 3_600_000, status: "waiting", run_id: null, call_id: null, claimed_at: null, check_at: null, ...over };
    store.sql.exec(
      "INSERT INTO continuations (id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, run_id, call_id, claimed_at, check_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
  /** A message of the person's as it is stored, claimed by a run if one is named. Its id. */
  const message = (text: string | null, data: Record<string, unknown> = {}, runId: string | null = null): number => {
    const id = `om_${++said}`;
    return store.rows<{ id: number }>(
      "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, reply_to, status, run_id, received_at) VALUES ('feishu', ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      id,
      SESSION_KEY,
      JSON.stringify({ kind: "human", id: "ou_1", explicit: true }),
      text,
      JSON.stringify({ message_id: id, direct: true, ...data }),
      TARGET,
      runId ? "claimed" : "done",
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
  return { store, host, settings, requests, woken, appended, request, kept, message, run, outgoing, sent, audited, hints };
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

  it("asks once more about a wait whose time is up or whose next look is due, and about no other", async () => {
    await within(({ requests, request, kept, hints }) => {
      const now = 5_000_000_000;
      const minute = Math.floor(now / 60_000);
      request("r_until", { until: now, check_at: now + 9 });
      request("r_check", { until: now + 10_000, check_at: now });
      request("r_later", { until: now + 1, check_at: now + 1 });
      request("r_plain", { until: now + 1 });
      request("r_ended", { until: now - 1, check_at: now - 1, status: "expired" });
      request("r_resuming", { until: now - 1, status: "resuming" });
      requests.deadlines(now);
      expect(hints()).toEqual([`r_until:due:${minute}`, `r_check:due:${minute}`]);
      expect(kept("r_until").check_at).toBeNull();
      expect(kept("r_check").check_at).toBeNull();
      expect(kept("r_later").check_at).toBe(now + 1);
      expect(kept("r_ended").check_at).toBe(now - 1);
      // It only gave a reason to ask: nothing has ended.
      expect(kept("r_until").status).toBe("waiting");
      // Again within the same minute: the same reason, kept once.
      requests.deadlines(now + 1);
      expect(hints()).toEqual([`r_until:due:${minute}`, `r_check:due:${minute}`, `r_later:due:${minute}`, `r_plain:due:${minute}`]);
      expect(kept("r_later").check_at).toBeNull();
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
      requests.draft(carried, running, "second");
      expect(store.rows("SELECT id FROM outbox")).toHaveLength(1);
      expect(sent("answer:r1")).toMatchObject({ status: "draft", text: "second" });
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
      const which = `asked_which:${SESSION}`;
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
      expect(store.meta(`asked_which:${SESSION}`)).toBeUndefined();
    });
  });

  it("takes a reply to be about a request only through that request's answer, its invitation, or a message it was tied to", async () => {
    await within(({ requests, host, request, message, run, outgoing }) => {
      const asked = message("读一下这篇");
      const loose = message("顺便说一句");
      request("r_a", { events: JSON.stringify({ said: [asked, loose], recent: [], bound: [asked] }) });
      // Tied to no message by its tool: only what the system sent for it is about it.
      request("r_b", { events: JSON.stringify({ said: [loose], recent: [] }) });
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
      expect(about(`feishu:message:om_${asked}`)).toEqual(["r_a"]);
      // In the request's batch, and not what its tool tied it to.
      expect(about(`feishu:message:om_${loose}`)).toEqual([]);
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
  const source: Source = { connector: "feishu", tool: "feishu_read_document", args: JSON.stringify({ document: "https://example.feishu.cn/docx/Doc1" }), call: "call_1", events: { said: [1], recent: [], bound: [1] }, fingerprint: "abc", identity: "docx:Doc1", condition: "cond_1", generation: 3 };
  const guard: Guard = { connector: "feishu", condition: "cond_1", generation: 3 };

  it("reads whether follow-ups are on from the deployment's setting each time it is asked", async () => {
    await within(({ requests, host, settings }) => {
      expect(requests.followUps()).toBe(true);
      settings.FOLLOW_UPS = "off";
      expect(requests.followUps()).toBe(false);
      delete settings.FOLLOW_UPS;
      expect(requests.followUps()).toBe(false);
      settings.FOLLOW_UPS = "ON";
      expect(requests.followUps()).toBe(false);
      // The Brain's settings replaced as a whole, not only changed.
      host.env = { FOLLOW_UPS: "on" } as unknown as Env;
      expect(requests.followUps()).toBe(true);
    });
  });

  it("notes only what a read was made under where nothing is kept for follow-ups, and the whole source where it is", async () => {
    await within(({ store, requests, settings }) => {
      const noted = (runId: string) => JSON.parse(store.meta(`sources:${runId}`) ?? "null") as unknown;
      expect(noted("run_off")).toBeNull();
      settings.FOLLOW_UPS = "off";
      requests.noteSource("run_off", source);
      // Not which document, not on whose message, not what it said.
      expect(noted("run_off")).toEqual([guard]);
      settings.FOLLOW_UPS = "on";
      requests.noteSource("run_on", source);
      requests.noteSource("run_on", { ...source, call: "call_2", identity: "docx:Doc2" });
      expect(noted("run_on")).toEqual([source, { ...source, call: "call_2", identity: "docx:Doc2" }]);
      // Either way, what the run stands under is the same.
      expect(requests.guards("run_off")).toEqual([guard]);
      expect(requests.guards("run_on")).toEqual([guard]);
    });
  });

  it("gives each thing a run read under once, and nothing for a read made under nothing", async () => {
    await within(({ requests }) => {
      expect(requests.guards("run_1")).toEqual([]);
      const free: Source = { ...source, condition: undefined, generation: undefined };
      requests.noteSource("run_1", free);
      expect(requests.guards("run_1")).toEqual([]);
      requests.noteSource("run_1", source);
      requests.noteSource("run_1", { ...source, call: "call_2" });
      requests.noteSource("run_1", { ...source, generation: 4 });
      // Read again to reopen a kept answer: also until that answer is no longer kept.
      requests.noteSource("run_1", { ...source, until: 99 });
      requests.noteSource("run_1", { ...source, until: 99 });
      expect(requests.guards("run_1")).toEqual([guard, { ...guard, generation: 4 }, { ...guard, until: 99 }]);
      expect(requests.guards("run_other")).toEqual([]);
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
