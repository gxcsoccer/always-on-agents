import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * One alarm serves the whole Brain. Whatever part has the earliest thing to do decides when it
 * rings next, and no part can be left out of that: here three of them each hold one future
 * thing, and each in turn holds the earliest.
 */
const TARGET = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_1" } });
let scopes = 0;

describe("the next wake-up", () => {
  for (const earliest of ["timer", "answer", "outbox"] as const) {
    it(`is set for the earliest of the parts' times: the ${earliest}`, async () => {
      const stub = env.BRAIN.getByName(`acme:user:wake-${++scopes}`);
      const now = Date.now();
      const at = (part: string) => now + (part === earliest ? 60_000 : 600_000 + ["timer", "answer", "outbox"].indexOf(part) * 60_000);
      await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
        const sql = state.storage.sql;
        sql.exec("INSERT INTO timers (id, due_at, session_key, note, created_at) VALUES ('t1', ?, 'dm', 'n', ?)", at("timer"), now);
        sql.exec("INSERT INTO answers (id, session_id, outbox_id, subject, target, connector, sources, quotes, text, expires_at, created_at) VALUES ('ans_1', 's1', 1, 'feishu:message:1', ?, 'feishu', '[]', '[]', 't', ?, ?)", TARGET, at("answer"), now);
        sql.exec("INSERT INTO outbox (idem, target, text, next_at, created_at) VALUES ('m1', ?, 'hello', ?, ?)", TARGET, at("outbox"), now);
        await state.storage.setAlarm(now + 5);
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const alarm = await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => state.storage.getAlarm());
      expect(alarm).toBe(at(earliest));
    });
  }
});
