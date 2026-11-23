import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * One alarm serves the whole Brain. Whatever part has the earliest thing to do decides when it
 * rings next, and no part can be left out of that: here four of them each hold one future
 * thing, and each in turn holds the earliest.
 */
const TARGET = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_1" } });
let scopes = 0;

describe("the next wake-up", () => {
  for (const earliest of ["timer", "wait", "outbox", "question"] as const) {
    it(`is set for the earliest of the parts' times: the ${earliest}`, async () => {
      const stub = env.BRAIN.getByName(`acme:user:wake-${++scopes}`);
      const now = Date.now();
      const at = (part: string) => now + (part === earliest ? 60_000 : 600_000 + ["timer", "wait", "outbox", "question"].indexOf(part) * 60_000);
      await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
        const sql = state.storage.sql;
        sql.exec("INSERT INTO timers (id, due_at, session_key, note, created_at) VALUES ('t1', ?, 'dm', 'n', ?)", at("timer"), now);
        sql.exec(
          "INSERT INTO continuations (id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, created_at) VALUES ('w1', 's1', '{\"said\":[],\"recent\":[]}', 'feishu', 'feishu_read_document', '{}', ?, 'grant_1', 'cond_1', 1, 'int:w1', ?, 'waiting', ?)",
          TARGET,
          at("wait"),
          now,
        );
        sql.exec("INSERT INTO outbox (idem, target, text, next_at, created_at) VALUES ('m1', ?, 'hello', ?, ?)", TARGET, at("outbox"), now);
        // Far enough ahead that the clock cannot reach it first: the test runs it by hand.
        sql.exec("INSERT INTO unsettled (ask, task_id, question_id, next_at) VALUES ('ask:1', 't1', 'q1', ?)", at("question"));
        await state.storage.setAlarm(now + 10_000);
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const alarm = await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => state.storage.getAlarm());
      expect(alarm).toBe(at(earliest));
    });
  }
});
