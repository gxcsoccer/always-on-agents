import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

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
