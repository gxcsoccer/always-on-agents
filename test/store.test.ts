import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MIGRATIONS, migrate } from "../src/brain/schema";
import { BrainStore } from "../src/brain/store";

/**
 * The Brain's database, by itself: every part of the Brain works through this one object, so what
 * it promises is tested here without a model, a connector or a run. It is built on a real Brain's
 * storage, whose tables that Brain has already created.
 */
let scopes = 0;
function within<T>(use: (store: BrainStore, state: DurableObjectState) => T | Promise<T>, name = `acme:user:store-${++scopes}`): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(name), (_instance: unknown, state: DurableObjectState) => use(new BrainStore(state), state));
}

afterEach(() => vi.restoreAllMocks());

describe("the steps a Brain's database is brought up to date by", () => {
  it("are only ever added at the end: a database that had the earlier ones gets the new one, and none again", async () => {
    // Where each of the latest sits, by number: a step put in before one that databases already ran is never run for them.
    const at = (table: string) => MIGRATIONS.findIndex((step) => step.includes(`CREATE TABLE IF NOT EXISTS ${table} `));
    expect([at("task_lends"), at("latest_states"), at("approvals_void")]).toEqual([41, 42, 43]);
    expect(MIGRATIONS).toHaveLength(44);
    // A database as the version before this one left it: brought up to date, it has the new table.
    await within((store, state) => {
      store.sql.exec("DROP TABLE approvals_void");
      store.setMeta("schema_version", "43");
      migrate(state.storage);
      expect(store.meta("schema_version")).toBe("44");
      expect(store.rows("SELECT event_id FROM approvals_void")).toEqual([]);
      expect(store.rows("SELECT key FROM latest_states")).toEqual([]);
    });
  });
});

describe("the Brain's store", () => {
  it("reads rows with bound values, and an empty list when nothing matches", async () => {
    await within((store) => {
      store.sql.exec("INSERT INTO meta (key, value) VALUES ('a', '1'), ('b', '2')");
      expect(store.rows<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key = ?", "b")).toEqual([{ key: "b", value: "2" }]);
      expect(store.rows("SELECT key FROM meta WHERE key = ?", "missing")).toEqual([]);
      expect(store.rows<{ n: number }>("SELECT COUNT(*) AS n FROM meta WHERE key IN (?, ?)", "a", "b")).toEqual([{ n: 2 }]);
    });
  });

  it("keeps one value per key, and has none for a key never set", async () => {
    await within((store) => {
      expect(store.meta("active_run")).toBeUndefined();
      store.setMeta("active_run", "r1");
      expect(store.meta("active_run")).toBe("r1");
      store.setMeta("active_run", "r2");
      expect(store.meta("active_run")).toBe("r2");
      expect(store.rows("SELECT key FROM meta WHERE key = 'active_run'")).toHaveLength(1);
    });
  });

  it("takes an event once per source and source id, and stores it as it was handed over", async () => {
    await within((store) => {
      const event = {
        source: "feishu",
        source_id: "om_1",
        kind: "message",
        session_key: "dm",
        principal: { kind: "human" as const, id: "ou_1", explicit: true },
        text: "hello",
        data: { message_id: "om_1", direct: true },
        reply_to: { connector: "feishu", address: { chat_id: "oc_1" } },
      };
      expect(store.insertEvent(event)).toBe(true);
      // The same event again, however it differs otherwise, is the one already held.
      expect(store.insertEvent({ ...event, text: "hello again" })).toBe(false);
      const [row] = store.rows<Record<string, unknown>>("SELECT * FROM inbox");
      expect(row).toMatchObject({ source: "feishu", source_id: "om_1", kind: "message", session_key: "dm", text: "hello", status: "pending" });
      expect(JSON.parse(row.principal as string)).toEqual(event.principal);
      expect(JSON.parse(row.data as string)).toEqual(event.data);
      expect(JSON.parse(row.reply_to as string)).toEqual(event.reply_to);
      expect(typeof row.received_at).toBe("number");
      // The same id from another source is another event.
      expect(store.insertEvent({ ...event, source: "github" })).toBe(true);
      expect(store.rows("SELECT id FROM inbox")).toHaveLength(2);
    });
  });

  it("keeps waiting only the latest of the events that say how one thing stands, and nothing of one that only ends them", async () => {
    await within((store) => {
      const pushed = (id: string, key: string, at: number, more: Record<string, unknown> = {}) => store.insertEvent({ source: "github", source_id: id, kind: "github.pull_request", session_key: "pr:7", principal: { kind: "human", id: "github:1", explicit: false }, text: id, data: { number: 7 }, supersedes: { key, at }, ...more });
      const how = () => Object.fromEntries(store.rows<{ source_id: string; status: string }>("SELECT source_id, status FROM inbox ORDER BY id").map((row) => [row.source_id, row.status]));
      // What a person wrote there, and something else that happened, are never touched by any of it.
      store.insertEvent({ source: "github", source_id: "comment:1", kind: "message", session_key: "pr:7", principal: { kind: "human", id: "github:1", explicit: true }, text: "please look" });
      store.insertEvent({ source: "github", source_id: "ci:1", kind: "github.ci_failed", session_key: "pr:7", principal: { kind: "automation", id: "ci", explicit: false } });
      expect(pushed("a", "pr:99", 100)).toBe(true);
      expect(pushed("b", "pr:99", 200)).toBe(true);
      // Another pull request's are its own.
      expect(pushed("other", "pr:55", 150)).toBe(true);
      expect(how()).toEqual({ "comment:1": "pending", "ci:1": "pending", a: "dropped", b: "pending", other: "pending" });
      // What it was superseded under is kept with it.
      expect(JSON.parse(store.rows<{ data: string }>("SELECT data FROM inbox WHERE source_id = 'b'")[0].data)).toEqual({ number: 7, supersedes: { key: "pr:99", at: 200 } });
      // The same one again is the one held: it supersedes nothing a second time.
      expect(pushed("a", "pr:99", 999)).toBe(false);
      expect(how().b).toBe("pending");
      // One that has been taken up is left alone, whatever comes after.
      store.sql.exec("UPDATE inbox SET status = 'claimed' WHERE source_id = 'b'");
      expect(pushed("c", "pr:99", 300)).toBe(true);
      expect(how()).toMatchObject({ b: "claimed", c: "pending" });
      // One that arrives after a later one was superseded before it came: kept, and not waiting.
      expect(pushed("old", "pr:99", 250)).toBe(true);
      expect(how()).toMatchObject({ old: "dropped", c: "pending" });
      // At the very same moment, the one that arrives later stands.
      expect(pushed("d", "pr:99", 300)).toBe(true);
      expect(how()).toMatchObject({ c: "dropped", d: "pending" });
      // One that only ends the others: they wait no longer, and neither does it. It is kept, so that it is not taken in twice.
      expect(pushed("closed", "pr:99", 400, { supersedes: { key: "pr:99", at: 400, void: true } })).toBe(true);
      expect(how()).toMatchObject({ d: "dropped", closed: "dropped", b: "claimed", other: "pending", "comment:1": "pending", "ci:1": "pending" });
      expect(pushed("closed", "pr:99", 400, { supersedes: { key: "pr:99", at: 400, void: true } })).toBe(false);
      // A push from before it was closed, arriving after: not waited on. Opened again later: that waits.
      expect(pushed("stale", "pr:99", 350)).toBe(true);
      expect(pushed("reopened", "pr:99", 500)).toBe(true);
      expect(how()).toMatchObject({ stale: "dropped", reopened: "pending" });
      // And an old word that it was closed, arriving after it was opened again, ends nothing.
      expect(pushed("closed-late", "pr:99", 450, { supersedes: { key: "pr:99", at: 450, void: true } })).toBe(true);
      expect(how()).toMatchObject({ "closed-late": "dropped", reopened: "pending" });
      // At the very same moment as one that only ends the others, that one stands, whichever of the two arrives first.
      expect(pushed("closed-2", "pr:99", 600, { supersedes: { key: "pr:99", at: 600, void: true } })).toBe(true);
      expect(pushed("same-moment-after", "pr:99", 600)).toBe(true);
      expect(how()).toMatchObject({ reopened: "dropped", "same-moment-after": "dropped" });
      expect(pushed("first", "pr:77", 600)).toBe(true);
      expect(pushed("then-closed", "pr:77", 600, { supersedes: { key: "pr:77", at: 600, void: true } })).toBe(true);
      expect(how()).toMatchObject({ first: "dropped", "then-closed": "dropped" });
      // Which state was the latest is kept apart from the events: it is still known when their words are gone.
      store.sql.exec("UPDATE inbox SET text = NULL, data = NULL");
      expect(pushed("long-after", "pr:99", 550)).toBe(true);
      expect(how()["long-after"]).toBe("dropped");
      expect(pushed("again-open", "pr:99", 700)).toBe(true);
      expect(how()["again-open"]).toBe("pending");
      expect(store.rows("SELECT key, at, void FROM latest_states WHERE source = 'github' ORDER BY key")).toEqual([{ key: "pr:55", at: 150, void: 0 }, { key: "pr:77", at: 600, void: 1 }, { key: "pr:99", at: 700, void: 0 }]);
      // Nothing an event happens to carry in its own data puts it under a key: only what was said of it as it was handed over.
      store.insertEvent({ source: "github", source_id: "comment:2", kind: "message", session_key: "pr:7", principal: { kind: "human", id: "github:1", explicit: true }, text: "look", data: { supersedes: { key: "pr:99", at: 1 }, number: 7 } });
      expect(JSON.parse(store.rows<{ data: string }>("SELECT data FROM inbox WHERE source_id = 'comment:2'")[0].data)).toEqual({ number: 7 });
      expect(pushed("closed-3", "pr:99", 800, { supersedes: { key: "pr:99", at: 800, void: true } })).toBe(true);
      expect(how()).toMatchObject({ "comment:2": "pending", "again-open": "dropped" });
      // The same key from another source is something else.
      expect(store.insertEvent({ source: "elsewhere", source_id: "x", kind: "note", session_key: "pr:7", principal: { kind: "automation", id: "x", explicit: false }, supersedes: { key: "pr:99", at: 900 } })).toBe(true);
      expect(how()).toMatchObject({ x: "pending" });
    });
  });

  it("stores what an event does not have as nothing, not as text", async () => {
    await within((store) => {
      store.insertEvent({ source: "timer", source_id: "t1", kind: "timer.fired", session_key: "dm", principal: { kind: "timer", id: "t1", explicit: false } });
      expect(store.rows("SELECT text, data, reply_to FROM inbox")).toEqual([{ text: null, data: null, reply_to: null }]);
    });
  });

  it("records who did what, with the detail as data", async () => {
    await within((store) => {
      const before = Date.now();
      store.audit("ou_1", "tool.used", { tool: "read", call: "c1" });
      const [row] = store.rows<{ at: number; actor: string; action: string; detail: string }>("SELECT at, actor, action, detail FROM audit");
      expect(row).toMatchObject({ actor: "ou_1", action: "tool.used" });
      expect(JSON.parse(row.detail)).toEqual({ tool: "read", call: "c1" });
      expect(row.at).toBeGreaterThanOrEqual(before);
    });
  });

  it("knows which scope it belongs to from the name the Brain is addressed by", async () => {
    await within((store) => {
      expect(store.scopeName()).toBe("acme:user:ou_store");
      expect(store.scope()).toEqual({ tenant: "acme", kind: "user", id: "ou_store" });
    }, "acme:user:ou_store");
  });

  it("logs one line of JSON that names the event and the scope", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    await within((store) => store.log("run_abandoned", { run: "r1" }), "acme:user:ou_log");
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({ event: "run_abandoned", scope: "acme:user:ou_log", run: "r1" });
  });

  it("commits everything a transaction did, and hands back what it returned", async () => {
    await within((store) => {
      const result = store.transaction(() => {
        store.setMeta("a", "1");
        store.audit("(system)", "x", {});
        return 7;
      });
      expect(result).toBe(7);
      expect(store.meta("a")).toBe("1");
      expect(store.rows("SELECT 1 FROM audit")).toHaveLength(1);
    });
  });

  it("undoes everything a transaction did when it throws, across tables", async () => {
    await within((store) => {
      store.setMeta("a", "before");
      expect(() =>
        store.transaction(() => {
          store.setMeta("a", "after");
          store.audit("(system)", "x", {});
          store.insertEvent({ source: "s", source_id: "1", kind: "message", session_key: "dm", principal: { kind: "human", id: "p", explicit: true } });
          throw new Error("stop");
        }),
      ).toThrow("stop");
      expect(store.meta("a")).toBe("before");
      expect(store.rows("SELECT 1 FROM audit")).toEqual([]);
      expect(store.rows("SELECT 1 FROM inbox")).toEqual([]);
    });
  });

  it("is the same database for every part built on the same storage", async () => {
    await within((store, state) => {
      const other = new BrainStore(state);
      store.setMeta("shared", "yes");
      expect(other.meta("shared")).toBe("yes");
      // One part's writes inside another's transaction are undone with it.
      expect(() =>
        store.transaction(() => {
          other.setMeta("shared", "no");
          throw new Error("stop");
        }),
      ).toThrow("stop");
      expect(other.meta("shared")).toBe("yes");
    });
  });
});
