import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { Marks, type MarksHost } from "../src/brain/marks";
import { BrainStore } from "../src/brain/store";

/**
 * The marks a channel put on people's messages to say they arrived, by themselves: kept with the
 * message, and taken off once it has been dealt with. The channel is a stand-in.
 */
let scopes = 0;
function within<T>(use: (bench: ReturnType<typeof bench>) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(`acme:user:marks-${++scopes}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));
}

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  /** What the channel answers when asked to take a mark off, by mark: the default is that it is gone. */
  const answers: Record<string, ("removed" | "retry" | "permanent")[]> = {};
  const asked: { source: string; mark: string; message: unknown }[] = [];
  const host: MarksHost = {
    unmark: async (source, event, mark) => {
      asked.push({ source, mark, message: event.data?.message_id });
      return answers[mark]?.shift() ?? "removed";
    },
  };
  const marks = new Marks(store, host);
  let made = 0;
  const message = (status: string) => {
    const id = `om_${++made}`;
    store.sql.exec("INSERT INTO inbox (source, source_id, kind, session_key, principal, data, status, received_at) VALUES ('feishu', ?, 'message', 'dm', '{}', ?, ?, 1)", id, JSON.stringify({ message_id: id }), status);
    return id;
  };
  const row = (id: string) => store.rows<{ mark: string | null; mark_attempts: number; mark_next_at: number | null }>("SELECT mark, mark_attempts, mark_next_at FROM inbox WHERE source_id = ?", id)[0];
  return { store, marks, answers, asked, message, row };
}

describe("the marks on people's messages, by themselves", () => {
  it("keeps a mark with its message, and says it is due to come off at once if the message has been dealt with already", async () => {
    await within(({ marks, message, row }) => {
      const pending = message("pending");
      const done = message("done");
      expect(marks.keep("feishu", pending, "r_1")).toBe(false);
      expect(marks.keep("feishu", done, "r_2")).toBe(true);
      expect(row(pending).mark).toBe("r_1");
      expect(row(done).mark).toBe("r_2");
      expect(marks.keep("feishu", "om_unknown", "r_3")).toBe(false);
    });
  });

  it("takes off the marks of messages that have been dealt with, and of no others", async () => {
    await within(async ({ marks, message, row, asked }) => {
      const handled = { done: message("done"), dead: message("dead"), pending: message("pending"), claimed: message("claimed") };
      for (const [status, id] of Object.entries(handled)) marks.keep("feishu", id, `r_${status}`);
      expect(marks.nextWakeAt(1_000)).toBeLessThanOrEqual(1_000);
      await marks.clear(1_000);
      expect(asked.map((each) => [each.mark, each.message]).sort()).toEqual([["r_dead", handled.dead], ["r_done", handled.done]]);
      expect(row(handled.done).mark).toBeNull();
      expect(row(handled.dead).mark).toBeNull();
      expect(row(handled.pending).mark).toBe("r_pending");
      expect(row(handled.claimed).mark).toBe("r_claimed");
      expect(marks.nextWakeAt(1_000)).toBeNull();
    });
  });

  it("tries again later when the channel is busy, gives up after a few tries, and stops at once on a refusal", async () => {
    await within(async ({ marks, message, row, answers, asked }) => {
      const busy = message("done");
      const refused = message("done");
      marks.keep("feishu", busy, "r_busy");
      marks.keep("feishu", refused, "r_refused");
      answers.r_busy = ["retry", "retry", "removed"];
      answers.r_refused = ["permanent"];
      await marks.clear(1_000);
      expect(row(refused).mark).toBeNull();
      expect(row(busy)).toMatchObject({ mark: "r_busy", mark_attempts: 1 });
      const next = row(busy).mark_next_at!;
      expect(next).toBeGreaterThan(1_000);
      expect(marks.nextWakeAt(1_000)).toBe(next);
      // Not before its time.
      await marks.clear(next - 1);
      expect(asked.filter((each) => each.mark === "r_busy")).toHaveLength(1);
      await marks.clear(next);
      await marks.clear(row(busy).mark_next_at!);
      expect(row(busy).mark).toBeNull();
      expect(asked.filter((each) => each.mark === "r_busy")).toHaveLength(3);

      const stuck = message("done");
      marks.keep("feishu", stuck, "r_stuck");
      answers.r_stuck = Array(20).fill("retry");
      for (let i = 0; i < 20 && row(stuck).mark; i++) await marks.clear(row(stuck).mark_next_at ?? 1_000);
      expect(row(stuck).mark).toBeNull();
      expect(asked.filter((each) => each.mark === "r_stuck").length).toBeLessThanOrEqual(6);
    });
  });
});
