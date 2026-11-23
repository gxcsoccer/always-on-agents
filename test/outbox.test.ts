import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { DeliveryDeferred, DeliveryRejected, DeliveryVoid, type OutboundMessage, type Receipt } from "../src/connectors";
import type { Target } from "../src/events";
import { Outbox, type OutboxHost } from "../src/brain/outbox";
import type { Continuation } from "../src/brain/requests";
import { BrainStore } from "../src/brain/store";

/**
 * The outbox by itself, on a real Brain's storage: messages are kept, delivered in order and
 * ended in one of a few ways. What hands a message to a channel, and the part that knows about
 * requests that wait, are stand-ins. No model, no connector, no run, no alarm.
 */
const SESSION = "s1";
/** A channel that drops a repeat for an hour, and one that makes no such promise. */
const TARGET = JSON.stringify({ connector: "feishu", address: { chat_id: "oc_1" } });
const PLAIN = JSON.stringify({ connector: "plain", address: { to: "x" } });
const RECEIPT: Receipt = { subject: "feishu:message:om_out", holder: "bot" };

let scopes = 0;
function within<T>(use: (bench: ReturnType<typeof bench>) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(`acme:user:outbox-${++scopes}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));
}

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  const delivered: { target: Target; message: OutboundMessage }[] = [];
  const stamped: string[] = [];
  const ended: { id: string; status: string; why: string }[] = [];
  const closed: string[] = [];
  const outside = new Set<string>();
  /** What the channel does with a message, by its key: the default is to take it. */
  const channel: Record<string, (message: OutboundMessage) => Receipt | void> = {};
  /** What the requests part says of a message before each attempt, by its key. */
  const gates: Record<string, "send" | "hold" | "wait" | "void" | "unasked"> = {};
  const settings = { sessionKey: 'private:feishu:[["app_id","cli_1"]]', reads: {} as Record<string, unknown[]> };
  const host: OutboxHost = {
    deliver: async (target, message) => {
      delivered.push({ target, message });
      return (channel[message.idem] ?? (() => RECEIPT))(message);
    },
    sawOutside: (runId) => outside.has(runId),
    showClosed: (ask) => void closed.push(ask),
    requests: {
      stampGuards: (runId) => void stamped.push(runId),
      gate: async (row) => gates[row.idem as string] ?? "send",
      endRequest: (id, status, why) => void ended.push({ id, status, why }),
      sessionKeyOf: () => settings.sessionKey,
      readsOf: (runId) => settings.reads[runId] ?? [],
    },
  };
  const outbox = new Outbox(store, host);
  store.sql.exec("INSERT INTO sessions (id, session_key, target, created_at, updated_at) VALUES (?, 'dm', ?, 1, 1)", SESSION, TARGET);

  const run = (id: string, session = SESSION) => void store.sql.exec("INSERT INTO runs (id, session_id, status, started_at) VALUES (?, ?, 'running', ?)", id, session, Date.now());
  /** A row as it is kept. */
  const row = (idem: string) => store.rows<Record<string, any>>("SELECT * FROM outbox WHERE idem = ?", idem)[0];
  /** Changes a kept row directly: what an earlier wake-up, or another part, left on it. */
  const set = (idem: string, fields: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(fields)) store.sql.exec(`UPDATE outbox SET ${name} = ? WHERE idem = ?`, value, idem);
  };
  const sent = () => delivered.map((each) => each.message.idem);
  const said = (text: string) => void store.sql.exec("INSERT INTO inbox (source, source_id, kind, session_key, principal, text, status, received_at) VALUES ('feishu', ?, 'message', 'dm', '{}', ?, 'done', 1)", `om_${text}`, text);
  /** What was recorded as said to the person, in order. */
  const kept = () => store.rows<Record<string, any>>("SELECT * FROM said ORDER BY outbox_id").map(({ sent_at, ...rest }) => ({ ...rest, reads: JSON.parse(rest.reads) }));
  return { store, host, outbox, delivered, stamped, ended, closed, outside, channel, gates, settings, run, row, set, sent, said, kept };
}

const fails = (err: Error) => () => {
  throw err;
};

describe("the outbox, by itself", () => {
  describe("keeping a message", () => {
    it("addresses it to where the conversation is answered, once per key", async () => {
      await within(({ outbox, row, store }) => {
        expect(outbox.enqueue("m1", SESSION, null, "hello")).toEqual({ ok: true });
        outbox.enqueue("m1", SESSION, null, "hello again");
        expect(store.rows("SELECT 1 FROM outbox")).toHaveLength(1);
        expect(row("m1")).toMatchObject({ target: TARGET, text: "hello", status: "pending", run_id: null, attempts: 0, private: 0, ask: null, review: null, continuation: null, interaction: null });
        expect(row("m1").next_at).toBeLessThanOrEqual(Date.now());
      });
    });

    it("sends a waiting request's answer where the request came from, then where it is told, then the conversation, then the scope's default", async () => {
      await within(({ outbox, row, store }) => {
        const continuation = { id: "r1", target: PLAIN } as Continuation;
        outbox.enqueue("a", SESSION, null, "t", undefined, undefined, { continuation, interaction: "int:r1", target: "elsewhere" });
        expect(row("a")).toMatchObject({ target: PLAIN, continuation: "r1", interaction: "int:r1" });
        outbox.enqueue("b", SESSION, null, "t", undefined, undefined, { target: PLAIN });
        expect(row("b").target).toBe(PLAIN);
        store.sql.exec("INSERT INTO sessions (id, session_key, target, created_at, updated_at) VALUES ('s2', 'ci', NULL, 1, 1)");
        expect(() => outbox.enqueue("c", "s2", null, "t")).toThrow("there is nowhere to send a message in this conversation");
        store.setMeta("default_target", PLAIN);
        outbox.enqueue("c", "s2", null, "t");
        expect(row("c").target).toBe(PLAIN);
      });
    });

    it("keeps an approval question and a review as data beside the words", async () => {
      await within(({ outbox, row }) => {
        const ask = { code: "A1" } as never;
        const review = { summary: "fine", comments: [] } as never;
        outbox.enqueue("q", SESSION, null, "may I?", ask);
        outbox.enqueue("r", SESSION, null, "review", undefined, review);
        expect(JSON.parse(row("q").ask)).toEqual({ code: "A1" });
        expect(JSON.parse(row("r").review)).toEqual({ summary: "fine", comments: [] });
      });
    });

    it("marks a message private when its run has read outside text, and has the run's guards stamped on it", async () => {
      await within(({ outbox, row, outside, stamped }) => {
        outside.add("run_out");
        outbox.enqueue("m1", SESSION, "run_out", "from outside");
        outbox.enqueue("m2", SESSION, "run_in", "from inside");
        outbox.enqueue("m3", SESSION, null, "from the system");
        expect([row("m1").private, row("m2").private, row("m3").private]).toEqual([1, 0, 0]);
        // Asked for every message a run writes, and for none that no run wrote.
        expect(stamped).toEqual(["run_out", "run_in"]);
      });
    });
  });

  describe("the system's own notices", () => {
    it("are said in the language the person last wrote in here", async () => {
      await within(({ outbox, said }) => {
        const english = outbox.notice("notAnswered", SESSION);
        expect(english).toMatch(/^I could not finish/);
        said("帮我看一下");
        const chinese = outbox.notice("notAnswered", SESSION);
        expect(chinese).toMatch(/[一-鿿]/);
        said("thanks");
        expect(outbox.notice("notAnswered", SESSION)).toBe(english);
        expect(outbox.notice("which", SESSION)).not.toBe(english);
      });
    });

    it("never fail the caller for having nowhere to go", async () => {
      await within(({ outbox, store, row }) => {
        store.sql.exec("INSERT INTO sessions (id, session_key, target, created_at, updated_at) VALUES ('s2', 'ci', NULL, 1, 1)");
        expect(() => outbox.notify("n1", "s2", null, "nobody hears this")).not.toThrow();
        expect(row("n1")).toBeUndefined();
        outbox.notify("n2", SESSION, null, "someone does", { id: "r1", target: PLAIN } as Continuation);
        expect(row("n2")).toMatchObject({ text: "someone does", target: PLAIN, continuation: "r1" });
      });
    });
  });

  describe("delivering", () => {
    it("hands messages over in the order they were written, and records each as sent with its receipt", async () => {
      await within(async ({ outbox, row, delivered, sent }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        outbox.enqueue("m2", SESSION, null, "two");
        const before = Date.now();
        await outbox.flush();
        expect(sent()).toEqual(["m1", "m2"]);
        expect(delivered[0]).toMatchObject({ target: JSON.parse(TARGET), message: { id: row("m1").id, idem: "m1", text: "one", created_at: row("m1").created_at } });
        expect(delivered[0].message).not.toHaveProperty("ask");
        expect(row("m1")).toMatchObject({ status: "sent", error: null, started: 1 });
        expect(JSON.parse(row("m1").receipt)).toEqual(RECEIPT);
        expect(row("m1").sent_at).toBeGreaterThanOrEqual(before);
        // Nothing is left to do: a second pass sends nothing again.
        await outbox.flush();
        expect(sent()).toEqual(["m1", "m2"]);
      });
    });

    it("passes on the question, the review and the interaction a message carries", async () => {
      await within(async ({ outbox, delivered }) => {
        outbox.enqueue("q", SESSION, null, "may I?", { code: "A1" } as never);
        outbox.enqueue("r", SESSION, null, "review", undefined, { summary: "fine", comments: [] } as never);
        outbox.enqueue("i", SESSION, null, "authorise", undefined, undefined, { interaction: "int:1" });
        await outbox.flush();
        expect(delivered.map((each) => each.message)).toMatchObject([{ ask: { code: "A1" } }, { review: { summary: "fine" } }, { interaction: "int:1" }]);
      });
    });

    it("takes the time a message was really posted from the receipt, when an earlier attempt had landed", async () => {
      await within(async ({ outbox, row, channel }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        channel.m1 = () => ({ ...RECEIPT, posted_at: 1234 });
        await outbox.flush();
        expect(row("m1").sent_at).toBe(1234);
      });
    });

    it("keeps everything behind the oldest message waiting while that one backs off", async () => {
      await within(async ({ outbox, set, sent }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        outbox.enqueue("m2", SESSION, null, "two");
        set("m1", { next_at: Date.now() + 60_000 });
        await outbox.flush();
        expect(sent()).toEqual([]);
      });
    });

    it("tries a failed message again later, counting the attempt, and holds the queue meanwhile", async () => {
      await within(async ({ outbox, row, set, channel, sent }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        outbox.enqueue("m2", SESSION, null, "two");
        channel.m1 = fails(new Error("the network went away"));
        const before = Date.now();
        await outbox.flush();
        expect(sent()).toEqual(["m1"]);
        // It may have arrived: nothing said it had not.
        expect(row("m1")).toMatchObject({ status: "pending", attempts: 1, started: 1, uncertain: 1, error: "Error: the network went away" });
        expect(row("m1").next_at).toBeGreaterThanOrEqual(before + 2_000);
        expect(row("m1").first_attempt_at).toBeGreaterThanOrEqual(before);
        // The second failure waits longer than the first.
        set("m1", { next_at: 0 });
        await outbox.flush();
        expect(row("m1").attempts).toBe(2);
        expect(row("m1").next_at).toBeGreaterThanOrEqual(before + 10_000);
        // Once it goes through, the one behind it follows.
        delete channel.m1;
        set("m1", { next_at: 0 });
        await outbox.flush();
        expect(sent()).toEqual(["m1", "m1", "m1", "m2"]);
        expect(row("m1").status).toBe("sent");
      });
    });

    it("knows a refusal from the outside system reached nobody", async () => {
      await within(async ({ outbox, row, channel }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        channel.m1 = fails(new DeliveryRejected("no"));
        await outbox.flush();
        expect(row("m1")).toMatchObject({ status: "pending", attempts: 1, uncertain: 0 });
      });
    });

    it("gives a message up after its last retry: as failed when it reached nobody, as unverified when it may have", async () => {
      await within(async ({ outbox, row, set, channel, sent, ended, store }) => {
        outbox.enqueue("refused", SESSION, null, "one", undefined, undefined, { continuation: { id: "r1", target: TARGET } as Continuation });
        outbox.enqueue("lost", SESSION, null, "two", undefined, undefined, { continuation: { id: "r2", target: TARGET } as Continuation });
        outbox.enqueue("lost-plain", SESSION, null, "three", undefined, undefined, { target: PLAIN });
        outbox.enqueue("after", SESSION, null, "four");
        channel.refused = fails(new DeliveryRejected("no"));
        channel.lost = fails(new Error("timeout"));
        channel["lost-plain"] = fails(new Error("timeout"));
        for (const idem of ["refused", "lost", "lost-plain"]) set(idem, { attempts: 5 });
        await outbox.flush();
        expect(row("refused")).toMatchObject({ status: "dead", attempts: 6 });
        // Only where the channel has a horizon for repeats can "may have arrived" be told from "failed".
        expect(row("lost")).toMatchObject({ status: "unverified", attempts: 6 });
        expect(row("lost-plain")).toMatchObject({ status: "dead", attempts: 6 });
        expect(ended).toEqual([
          { id: "r1", status: "failed", why: "its answer could not be delivered" },
          { id: "r2", status: "unverified", why: "its answer could not be delivered" },
        ]);
        // None of them keeps the message behind it waiting.
        expect(sent()).toEqual(["refused", "lost", "lost-plain", "after"]);
        expect(store.rows("SELECT 1 FROM outbox WHERE status = 'pending'")).toEqual([]);
      });
    });

    it("waits exactly as long as the outside system asks, and gives up on a wait too long to hold the queue for", async () => {
      await within(async ({ outbox, row, channel, sent }) => {
        const soon = Date.now() + 30 * 60_000;
        outbox.enqueue("m1", SESSION, null, "one");
        channel.m1 = fails(new DeliveryDeferred("slow down", soon));
        await outbox.flush();
        expect(row("m1")).toMatchObject({ status: "pending", next_at: soon, uncertain: 0 });

        // Until then it is not tried again, and nothing behind it goes first.
        outbox.enqueue("m2", SESSION, null, "two");
        await outbox.flush();
        expect(sent()).toEqual(["m1"]);
      });
      await within(async ({ outbox, row, channel, sent }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        outbox.enqueue("m2", SESSION, null, "two");
        channel.m1 = fails(new DeliveryDeferred("come back next week", Date.now() + 7 * 86_400_000));
        await outbox.flush();
        expect(row("m1").status).toBe("dead");
        expect(row("m1").error).toMatch(/^asked to wait longer than a message is held for; /);
        expect(sent()).toEqual(["m1", "m2"]);
      });
    });

    it("ends a message the channel found nothing left to send of, without trying again", async () => {
      await within(async ({ outbox, row, set, channel, sent, ended }) => {
        outbox.enqueue("fresh", SESSION, null, "invite", undefined, undefined, { continuation: { id: "r1", target: TARGET } as Continuation, interaction: "int:r1" });
        outbox.enqueue("tried", SESSION, null, "invite", undefined, undefined, { continuation: { id: "r2", target: TARGET } as Continuation, interaction: "int:r2" });
        outbox.enqueue("after", SESSION, null, "next");
        channel.fresh = channel.tried = fails(new DeliveryVoid("the invitation can no longer be used"));
        // An earlier attempt of this one was never heard of.
        set("tried", { uncertain: 1, started: 1, first_attempt_at: Date.now() });
        await outbox.flush();
        expect(row("fresh")).toMatchObject({ status: "void", text: "", uncertain: 0, attempts: 0 });
        expect(row("tried")).toMatchObject({ status: "unverified", text: "", uncertain: 1 });
        expect(ended).toEqual([
          { id: "r1", status: "void", why: "there was nothing left to send" },
          { id: "r2", status: "unverified", why: "its answer may have been delivered; that could not be verified" },
        ]);
        expect(sent()).toEqual(["fresh", "tried", "after"]);
      });
    });

    it("keeps the error of a private message as the fact only, and empties the message once it will not be sent again", async () => {
      await within(async ({ outbox, row, set, channel, outside }) => {
        outside.add("run_out");
        outbox.enqueue("secret", SESSION, "run_out", "what the document said");
        channel.secret = fails(new Error("could not send: what the document said"));
        await outbox.flush();
        expect(row("secret")).toMatchObject({ status: "pending", text: "what the document said", error: "delivery failed; the details are not kept" });
        delete channel.secret;
        set("secret", { next_at: 0 });
        await outbox.flush();
        expect(row("secret")).toMatchObject({ status: "sent", text: "", error: null });
        // One that is not private keeps its words.
        outbox.enqueue("open", SESSION, null, "hello");
        await outbox.flush();
        expect(row("open")).toMatchObject({ status: "sent", text: "hello" });
      });
    });

    it("reports an answered request as done, and only once its answer is handed over", async () => {
      await within(async ({ outbox, ended, channel, set }) => {
        outbox.enqueue("answer:r1", SESSION, null, "the answer", undefined, undefined, { continuation: { id: "r1", target: TARGET } as Continuation });
        channel["answer:r1"] = fails(new Error("timeout"));
        await outbox.flush();
        expect(ended).toEqual([]);
        delete channel["answer:r1"];
        set("answer:r1", { next_at: 0 });
        await outbox.flush();
        expect(ended).toEqual([{ id: "r1", status: "done", why: "answered" }]);
      });
    });
  });

  describe("what the requests part says before each attempt", () => {
    it("holds a message back for a short or a long while, and nothing behind it goes first", async () => {
      await within(async ({ outbox, row, gates, sent }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        outbox.enqueue("m2", SESSION, null, "two");
        gates.m1 = "hold";
        const before = Date.now();
        await outbox.flush();
        expect(sent()).toEqual([]);
        expect(row("m1").next_at).toBeGreaterThanOrEqual(before + 3_000);
        expect(row("m1").next_at).toBeLessThan(before + 60_000);
        expect(row("m1").attempts).toBe(0);
      });
      await within(async ({ outbox, row, gates, sent }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        gates.m1 = "wait";
        const before = Date.now();
        await outbox.flush();
        expect(sent()).toEqual([]);
        expect(row("m1").next_at).toBeGreaterThanOrEqual(before + 60_000);
      });
    });

    it("asks again before every attempt, not only the first", async () => {
      await within(async ({ outbox, row, set, gates, channel, sent }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        channel.m1 = fails(new DeliveryRejected("no"));
        await outbox.flush();
        gates.m1 = "void";
        delete channel.m1;
        set("m1", { next_at: 0 });
        await outbox.flush();
        expect(sent()).toEqual(["m1"]);
        expect(row("m1")).toMatchObject({ status: "void", text: "" });
      });
    });

    it("does not send a message that no longer stands, removes its words, and tells the person in fixed words", async () => {
      await within(async ({ outbox, row, set, run, gates, sent, ended, store }) => {
        run("run_1");
        outbox.enqueue("m1", SESSION, "run_1", "written from a document");
        set("m1", { guard: "[]", review: "{}" });
        outbox.enqueue("m2", SESSION, null, "next");
        gates.m1 = "void";
        await outbox.flush();
        expect(row("m1")).toMatchObject({ status: "void", text: "", review: null, guard: null });
        expect(row("withheld:run_1")).toMatchObject({ status: "sent", run_id: null });
        expect(row("withheld:run_1").text).toBe(outbox.notice("notSent", SESSION));
        expect(sent()).toEqual(["m2", "withheld:run_1"]);
        expect(ended).toEqual([]);
        expect(store.rows("SELECT 1 FROM outbox")).toHaveLength(3);
      });
    });

    it("ends the request a voided answer belonged to, and says nothing when the person called it off or it was only an invitation", async () => {
      await within(async ({ outbox, row, run, gates, ended, store }) => {
        run("run_1");
        const request = (id: string, status: string) =>
          void store.sql.exec("INSERT INTO continuations (id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, created_at) VALUES (?, ?, '{}', 'feishu', 't', '{}', ?, 'g', 'c', 1, 'i', 0, ?, 0)", id, SESSION, TARGET, status);
        request("r1", "resuming");
        outbox.enqueue("answer:r1", SESSION, "run_1", "an answer", undefined, undefined, { continuation: { id: "r1", target: TARGET } as Continuation });
        gates["answer:r1"] = "void";
        await outbox.flush();
        expect(ended).toEqual([{ id: "r1", status: "void", why: "it no longer stood when its answer was to be sent" }]);
        expect(row("withheld:run_1").text).toBe(outbox.notice("notSent", SESSION));
      });
      await within(async ({ outbox, row, run, gates, ended, store }) => {
        run("run_1");
        store.sql.exec("INSERT INTO continuations (id, session_id, events, connector, tool, args, target, subject, condition, generation, interaction, until, status, created_at) VALUES ('r2', ?, '{}', 'feishu', 't', '{}', ?, 'g', 'c', 1, 'i', 0, 'cancelled', 0)", SESSION, TARGET);
        outbox.enqueue("answer:r2", SESSION, "run_1", "an answer", undefined, undefined, { continuation: { id: "r2", target: TARGET } as Continuation });
        outbox.enqueue("invite:int:r3", SESSION, "run_1", "authorise", undefined, undefined, { continuation: { id: "r3", target: TARGET } as Continuation, interaction: "int:r3" });
        gates["answer:r2"] = gates["invite:int:r3"] = "void";
        await outbox.flush();
        expect(ended.map((each) => each.id)).toEqual(["r2", "r3"]);
        expect(row("withheld:run_1")).toBeUndefined();
      });
    });

    it("records a voided message that an earlier attempt may have delivered as unverified, and says nothing", async () => {
      await within(async ({ outbox, row, set, run, gates, ended }) => {
        run("run_1");
        outbox.enqueue("answer:r1", SESSION, "run_1", "an answer", undefined, undefined, { continuation: { id: "r1", target: TARGET } as Continuation });
        set("answer:r1", { uncertain: 1, started: 1, first_attempt_at: Date.now() });
        gates["answer:r1"] = "void";
        await outbox.flush();
        expect(row("answer:r1")).toMatchObject({ status: "unverified", text: "" });
        expect(ended).toEqual([{ id: "r1", status: "unverified", why: "its answer may have been delivered; that could not be verified" }]);
        expect(row("withheld:run_1")).toBeUndefined();
      });
    });

    it("puts off a message whose condition's owner could not be asked a bounded number of times, then gives it up and says so", async () => {
      await within(async ({ outbox, row, set, run, gates, sent }) => {
        run("run_1");
        outbox.enqueue("m1", SESSION, "run_1", "written from a document");
        set("m1", { guard: "[]" });
        gates.m1 = "unasked";
        const before = Date.now();
        for (let i = 1; i <= 8; i++) {
          await outbox.flush();
          expect(row("m1")).toMatchObject({ status: "pending", unasked: i, attempts: 0 });
          expect(row("m1").next_at).toBeGreaterThanOrEqual(before + 60_000);
          set("m1", { next_at: 0 });
        }
        await outbox.flush();
        expect(row("m1")).toMatchObject({ status: "void", text: "" });
        expect(row("withheld:run_1").text).toBe(outbox.notice("unchecked", SESSION));
        expect(sent()).toEqual(["withheld:run_1"]);
      });
    });

    it("starts the count of postponements afresh once the owner could be asked again", async () => {
      await within(async ({ outbox, row, set, gates, channel }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        gates.m1 = "unasked";
        await outbox.flush();
        expect(row("m1").unasked).toBe(1);
        gates.m1 = "send";
        channel.m1 = fails(new DeliveryRejected("no"));
        set("m1", { next_at: 0 });
        await outbox.flush();
        expect(row("m1")).toMatchObject({ unasked: 0, attempts: 1, status: "pending" });
      });
    });
  });

  it("does not send a second copy once the channel would no longer drop a repeat of an attempt never heard of", async () => {
    await within(async ({ outbox, row, set, sent }) => {
      outbox.enqueue("old", SESSION, null, "one");
      outbox.enqueue("recent", SESSION, null, "two");
      outbox.enqueue("plain", SESSION, null, "three", undefined, undefined, { target: PLAIN });
      set("old", { uncertain: 1, started: 1, first_attempt_at: Date.now() - 61 * 60_000 });
      set("recent", { uncertain: 1, started: 1, first_attempt_at: Date.now() - 59 * 60_000 });
      set("plain", { uncertain: 1, started: 1, first_attempt_at: Date.now() - 61 * 60_000 });
      await outbox.flush();
      expect(row("old")).toMatchObject({ status: "unverified", text: "" });
      // Within the hour the repeat is dropped by the channel; a channel with no such horizon is simply tried.
      expect(sent()).toEqual(["recent", "plain"]);
    });
  });

  it("keeps the time of a message's first attempt through every retry: the channel's horizon for repeats is counted from it", async () => {
    await within(async ({ outbox, row, set, channel }) => {
      const first = Date.now() - 59 * 60_000;
      outbox.enqueue("m1", SESSION, null, "one");
      set("m1", { uncertain: 1, started: 1, first_attempt_at: first });
      channel.m1 = fails(new Error("timeout"));
      await outbox.flush();
      expect(row("m1")).toMatchObject({ status: "pending", attempts: 1, first_attempt_at: first });
    });
  });

  describe("an approval question that was closed", () => {
    it("holds the queue for the rest of the wake-up when it was closed while an attempt that failed was on its way, and leaves it at the next", async () => {
      await within(async ({ outbox, row, set, channel, sent }) => {
        outbox.enqueue("q", SESSION, null, "may I?", { code: "A1" } as never);
        outbox.enqueue("m2", SESSION, null, "next");
        // Answered elsewhere while the channel is being waited on; then the channel is not heard from.
        channel.q = () => {
          set("q", { closed: '{"how":"answered"}' });
          throw new Error("timeout");
        };
        await outbox.flush();
        expect(sent()).toEqual(["q"]);
        expect([row("q").status, row("m2").status]).toEqual(["pending", "pending"]);
        // The next wake-up takes it out of the queue, lets the message behind it through, and
        // does not look for the question before its back-off is over.
        await outbox.flush();
        expect(sent()).toEqual(["q", "m2"]);
        expect(row("q")).toMatchObject({ status: "reconciling", attempts: 1 });
      });
    });

    it("is not sent at all if no attempt was ever begun, whatever back-off it is in", async () => {
      await within(async ({ outbox, row, set, sent }) => {
        outbox.enqueue("q", SESSION, null, "may I?", { code: "A1" } as never);
        outbox.enqueue("m2", SESSION, null, "next");
        set("q", { closed: '{"how":"answered"}', next_at: Date.now() + 600_000 });
        await outbox.flush();
        expect(row("q").status).toBe("withdrawn");
        expect(sent()).toEqual(["m2"]);
      });
    });

    it("is found again under its own key if an attempt was begun, outside the queue, and then shown as closed", async () => {
      await within(async ({ outbox, row, set, channel, sent, closed }) => {
        outbox.enqueue("q", SESSION, null, "may I?", { code: "A1" } as never);
        outbox.enqueue("m2", SESSION, null, "next");
        set("q", { closed: '{"how":"answered"}', started: 1, next_at: 0 });
        channel.q = fails(new Error("timeout"));
        await outbox.flush();
        // It holds nothing up, and its failing leaves it to be tried again by itself.
        expect(sent()).toEqual(["m2", "q"]);
        expect(row("q")).toMatchObject({ status: "reconciling", attempts: 1 });
        expect(closed).toEqual([]);
        delete channel.q;
        set("q", { next_at: 0 });
        await outbox.flush();
        expect(row("q").status).toBe("sent");
        expect(closed).toEqual(["q"]);
      });
    });

    it("is shown as closed on delivery in any case: it may have been closed on its way", async () => {
      await within(async ({ outbox, closed }) => {
        outbox.enqueue("q", SESSION, null, "may I?", { code: "A1" } as never);
        outbox.enqueue("m", SESSION, null, "plain");
        await outbox.flush();
        expect(closed).toEqual(["q"]);
      });
    });
  });

  it("leaves nothing that ties a message to what was read on a row that has ended, however it ended", async () => {
    await within(async ({ outbox, row, store }) => {
      for (const status of ["pending", "draft", "sent", "void", "dead", "unverified", "withdrawn"]) {
        store.sql.exec("INSERT INTO outbox (idem, target, text, status, next_at, created_at, source, guard) VALUES (?, ?, 't', ?, ?, 0, '{}', '[]')", status, TARGET, status, Date.now() + 600_000);
      }
      await outbox.flush();
      const tied = store.rows<{ idem: string }>("SELECT idem FROM outbox WHERE source IS NOT NULL OR guard IS NOT NULL ORDER BY id").map((each) => each.idem);
      expect(tied).toEqual(["pending", "draft"]);
      expect(row("pending").status).toBe("pending");
    });
  });

  describe("emptying what a run wrote", () => {
    it("removes the words of the run's private messages that will not be sent again, and of no others", async () => {
      await within(({ outbox, row, store }) => {
        const put = (idem: string, runId: string, status: string, isPrivate: number, error: string | null = null) =>
          void store.sql.exec("INSERT INTO outbox (idem, run_id, target, text, status, next_at, created_at, private, review, error) VALUES (?, ?, ?, 'words', ?, 0, 0, ?, '{}', ?)", idem, runId, TARGET, status, isPrivate, error);
        put("sent", "run_1", "sent", 1);
        put("dead", "run_1", "dead", 1, "it quoted the words");
        put("unverified", "run_1", "unverified", 1);
        put("pending", "run_1", "pending", 1);
        put("reconciling", "run_1", "reconciling", 1);
        put("open", "run_1", "sent", 0);
        put("other", "run_2", "sent", 1);
        outbox.scrub("run_id = ?", "run_1");
        expect(row("sent")).toMatchObject({ text: "", review: null, error: null });
        expect(row("dead")).toMatchObject({ text: "", review: null, error: "delivery failed; the details are not kept" });
        expect(row("unverified").text).toBe("");
        for (const idem of ["pending", "reconciling", "open", "other"]) expect(row(idem)).toMatchObject({ text: "words", review: "{}" });
        outbox.scrub("id = ?", row("other").id);
        expect(row("other").text).toBe("");
      });
    });
  });

  describe("when it next has something to do", () => {
    it("is when the oldest undelivered message is due, even if a later one is due sooner", async () => {
      await within(({ outbox, set }) => {
        expect(outbox.nextWakeAt(0)).toBeNull();
        outbox.enqueue("m1", SESSION, null, "one");
        outbox.enqueue("m2", SESSION, null, "two");
        set("m1", { next_at: 9_000 });
        set("m2", { next_at: 1_000 });
        expect(outbox.nextWakeAt(0)).toBe(9_000);
      });
    });

    it("is the earliest of that and of the closed questions still being looked for", async () => {
      await within(({ outbox, set, store }) => {
        outbox.enqueue("m1", SESSION, null, "one");
        set("m1", { next_at: 9_000 });
        for (const [idem, at] of [["q1", 7_000], ["q2", 5_000]] as const) store.sql.exec("INSERT INTO outbox (idem, target, text, status, next_at, created_at) VALUES (?, ?, 't', 'reconciling', ?, 0)", idem, TARGET, at);
        expect(outbox.nextWakeAt(0)).toBe(5_000);
        set("m1", { next_at: 2_000 });
        expect(outbox.nextWakeAt(0)).toBe(2_000);
      });
    });

    it("is never, for messages that have ended or are only drafts", async () => {
      await within(({ outbox, store }) => {
        for (const status of ["draft", "sent", "void", "dead", "unverified", "withdrawn"]) store.sql.exec("INSERT INTO outbox (idem, target, text, status, next_at, created_at) VALUES (?, ?, 't', ?, 1, 0)", status, TARGET, status);
        expect(outbox.nextWakeAt(0)).toBeNull();
      });
    });
  });

  describe("what was said", () => {
    const READ_A = { connector: "feishu", tool: "feishu_read_document", args: JSON.stringify({ document: "https://x.feishu.cn/docx/AAAAAAAAAA" }), identity: "docx:AAAAAAAAAA" };

    it("keeps the words the person was actually sent, once, with what had been read when they were written", async () => {
      await within(async ({ outbox, run, row, settings, outside, kept }) => {
        run("r1");
        outside.add("r1");
        settings.reads.r1 = [READ_A];
        outbox.enqueue("msg:c1", SESSION, "r1", "A has three items");
        // Read later in the same run: not what the first message was written from.
        settings.reads.r1 = [READ_A, { ...READ_A, identity: "docx:BBBBBBBBBB" }];
        outbox.enqueue("msg:c2", SESSION, "r1", "B has two");
        await outbox.flush();
        await outbox.flush();
        expect(kept()).toEqual([
          { outbox_id: row("msg:c1").id, run_id: "r1", session_id: SESSION, text: "A has three items", receipt_subject: RECEIPT.subject, reads: [READ_A] },
          { outbox_id: row("msg:c2").id, run_id: "r1", session_id: SESSION, text: "B has two", receipt_subject: RECEIPT.subject, reads: [READ_A, { ...READ_A, identity: "docx:BBBBBBBBBB" }] },
        ]);
        // The outbox's own copy of a private message is still emptied once it has gone out.
        expect(row("msg:c1")).toMatchObject({ status: "sent", text: "" });
      });
    });

    it("keeps the words as they finally went out, not as first written", async () => {
      await within(async ({ outbox, run, set, kept }) => {
        run("r1");
        outbox.enqueue("answer:q1", SESSION, "r1", "first draft");
        set("answer:q1", { text: "final words" });
        await outbox.flush();
        expect(kept().map((each) => each.text)).toEqual(["final words"]);
      });
    });

    it("keeps nothing that did not reach the person, nothing that was not the agent's own message, and nothing outside a private conversation", async () => {
      await within(async ({ outbox, run, set, channel, gates, settings, kept }) => {
        run("r1");
        outbox.enqueue("msg:void", SESSION, "r1", "withheld");
        gates["msg:void"] = "void";
        outbox.enqueue("msg:dead", SESSION, "r1", "refused");
        channel["msg:dead"] = fails(new DeliveryRejected("no"));
        set("msg:dead", { attempts: 5 });
        outbox.enqueue("msg:gone", SESSION, "r1", "nothing to send");
        channel["msg:gone"] = fails(new DeliveryVoid());
        outbox.enqueue("ask:q1", SESSION, "r1", "may I?", { code: "A1" } as never);
        outbox.notify("budget:r1", SESSION, "r1", "paused until tomorrow");
        await outbox.flush();
        expect(kept()).toEqual([]);
        settings.sessionKey = "chat:oc_9";
        outbox.enqueue("msg:group", SESSION, "r1", "in a group");
        await outbox.flush();
        expect(kept()).toEqual([]);
      });
    });
  });
});
