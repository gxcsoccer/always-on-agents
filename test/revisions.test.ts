import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Standing } from "../src/connectors";
import { NOT_FOR_THE_AGENT } from "../src/events";
import { Revisions, type RevisionsHost, saidAt } from "../src/brain/revisions";
import { BrainStore, type InboxRow } from "../src/brain/store";

/**
 * What the Brain knows about messages that can change after they were said (an edited or deleted
 * comment), by itself on a real Brain's storage. The connector that can be asked what a message
 * says now is a stand-in. No model, no run, no alarm.
 */
let scopes = 0;
function within<T>(use: (bench: ReturnType<typeof bench>) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.BRAIN.getByName(`acme:repo:revisions-${++scopes}`), (_instance: unknown, state: DurableObjectState) => use(bench(state)));
}

function bench(state: DurableObjectState) {
  const store = new BrainStore(state);
  /** What each source says a subject is now; a missing subject is one the source does not know. */
  const now: Record<string, Standing | Error> = {};
  const asked: string[] = [];
  const settings = { revisable: new Set(["github"]) };
  const host: RevisionsHost = {
    isDecider: (principal) => principal.kind === "human" && principal.explicit,
    canRevisit: (source) => settings.revisable.has(source),
    standingOf: async (source, subject) => {
      asked.push(`${source}:${subject}`);
      const said = now[subject];
      if (said instanceof Error) throw said;
      return said;
    },
  };
  const revisions = new Revisions(store, host);
  let made = 0;
  /** A message as it is stored. With a subject it is one that can change; `revision` is also when it was said. */
  const message = (over: { subject?: string; revision?: number; holder?: string; session?: string; person?: string; explicit?: boolean; source?: string; received_at?: number; routed_from?: string } = {}): InboxRow => {
    const data = { ...(over.subject ? { subject: over.subject, revision: over.revision ?? 1, holder: over.holder ?? "h1" } : {}), ...(over.routed_from ? { routed_from: over.routed_from } : {}) };
    const id = store.rows<{ id: number }>(
      "INSERT INTO inbox (source, source_id, kind, session_key, principal, text, data, status, received_at) VALUES (?, ?, 'message', ?, ?, 'words', ?, 'done', ?) RETURNING id",
      over.source ?? "github",
      `m${++made}`,
      over.session ?? "pr:1",
      JSON.stringify({ kind: "human", id: over.person ?? "alice", explicit: over.explicit ?? true }),
      JSON.stringify(data),
      over.received_at ?? 1_000 + made,
    )[0].id;
    return store.rows<InboxRow>("SELECT * FROM inbox WHERE id = ?", id)[0];
  };
  const known = (subject: string) => store.rows<{ revision: number; deleted: number; holder: string }>("SELECT revision, deleted, holder FROM revisions WHERE subject = ?", subject)[0];
  return { store, host, revisions, now, asked, settings, message, known };
}

describe("messages that can change, by themselves", () => {
  describe("what is known of a subject", () => {
    it("starts with the first thing heard, and only moves forward", async () => {
      await within(({ revisions, known }) => {
        revisions.revise("c1", 5, false, "h5");
        expect(known("c1")).toEqual({ revision: 5, deleted: 0, holder: "h5" });
        revisions.revise("c1", 7, false, "h7");
        expect(known("c1")).toEqual({ revision: 7, deleted: 0, holder: "h7" });
        // Heard out of order: the older revision changes nothing.
        revisions.revise("c1", 6, false, "h6");
        expect(known("c1")).toEqual({ revision: 7, deleted: 0, holder: "h7" });
        // The same again is the same.
        revisions.revise("c1", 7, false, "h7");
        expect(known("c1")).toEqual({ revision: 7, deleted: 0, holder: "h7" });
      });
    });

    it("stays deleted once deleted, whatever is heard afterwards", async () => {
      await within(({ revisions, known }) => {
        revisions.revise("c1", 5, false, "h5");
        revisions.revise("c1", 0, true, "");
        expect(known("c1")).toEqual({ revision: 5, deleted: 1, holder: "h5" });
        revisions.revise("c1", 9, false, "h9");
        expect(known("c1").deleted).toBe(1);
        // First heard of as deleted.
        revisions.revise("c2", 3, true, "");
        expect(known("c2")).toMatchObject({ deleted: 1 });
      });
    });

    it("leaves nobody holding a revision that two different texts claim", async () => {
      await within(({ revisions, known }) => {
        revisions.revise("c1", 5, false, "one text");
        revisions.revise("c1", 5, false, "another text");
        expect(known("c1")).toEqual({ revision: 5, deleted: 0, holder: "" });
      });
    });

    it("keeps a revision known not to be for the agent as that, whichever of the two was heard first", async () => {
      await within(({ revisions, known }) => {
        revisions.revise("c1", 5, false, "a text");
        revisions.revise("c1", 5, false, NOT_FOR_THE_AGENT);
        expect(known("c1").holder).toBe(NOT_FOR_THE_AGENT);
        revisions.revise("c2", 5, false, NOT_FOR_THE_AGENT);
        revisions.revise("c2", 5, false, "a text");
        expect(known("c2").holder).toBe(NOT_FOR_THE_AGENT);
      });
    });
  });

  describe("whether a message still says what it said", () => {
    it("always does when it cannot change", async () => {
      await within(({ revisions, message }) => {
        const plain = message();
        expect(revisions.standing(plain)).toBe("stands");
        expect(revisions.stillStands(plain)).toBe(true);
      });
    });

    it("does only while its subject is at the revision and text it was read from", async () => {
      await within(({ revisions, message }) => {
        const read = message({ subject: "c1", revision: 5, holder: "h5" });
        // Nothing is known of the subject: that it still says so is not assumed.
        expect(revisions.standing(read)).toBe("changed");
        revisions.revise("c1", 5, false, "h5");
        expect(revisions.standing(read)).toBe("stands");
        revisions.revise("c1", 6, false, "h6");
        expect(revisions.standing(read)).toBe("changed");
        expect(revisions.stillStands(read)).toBe(false);
        // The message that carries the new text stands.
        expect(revisions.standing(message({ subject: "c1", revision: 6, holder: "h6" }))).toBe("stands");
      });
    });

    it("does not when nobody holds its revision, or another text does", async () => {
      await within(({ revisions, message }) => {
        const read = message({ subject: "c1", revision: 5, holder: "h5" });
        revisions.revise("c1", 5, false, "other");
        expect(revisions.standing(read)).toBe("changed");
        const second = message({ subject: "c2", revision: 5, holder: "h5" });
        revisions.revise("c2", 5, false, "h5");
        revisions.revise("c2", 5, false, "other");
        expect(revisions.standing(second)).toBe("changed");
      });
    });

    it("is gone when deleted, and withdrawn when edited into something not for the agent", async () => {
      await within(({ revisions, message }) => {
        const deleted = message({ subject: "c1", revision: 5, holder: "h5" });
        revisions.revise("c1", 5, false, "h5");
        revisions.revise("c1", 5, true, "");
        expect(revisions.standing(deleted)).toBe("deleted");
        const edited = message({ subject: "c2", revision: 5, holder: "h5" });
        revisions.revise("c2", 6, false, NOT_FOR_THE_AGENT);
        expect(revisions.standing(edited)).toBe("withdrawn");
        // Only an earlier text is withdrawn by it: at that very revision it has simply changed.
        expect(revisions.standing(message({ subject: "c2", revision: 6, holder: "h6" }))).toBe("changed");
      });
    });
  });

  describe("bringing a set of messages up to date", () => {
    it("keeps what stands and what cannot change, and drops what is deleted or withdrawn", async () => {
      await within(({ revisions, message }) => {
        const plain = message();
        const stands = message({ subject: "c1", revision: 5, holder: "h5" });
        const deleted = message({ subject: "c2", revision: 5, holder: "h5" });
        const withdrawn = message({ subject: "c3", revision: 5, holder: "h5" });
        revisions.revise("c1", 5, false, "h5");
        revisions.revise("c2", 5, true, "");
        revisions.revise("c3", 6, false, NOT_FOR_THE_AGENT);
        const { events, unresolved } = revisions.reconcile([plain, stands, deleted, withdrawn]);
        expect(events.map((each) => each.id)).toEqual([plain.id, stands.id]);
        expect(unresolved).toBe(false);
      });
    });

    it("drops an edited message once the edit has arrived as a message of its own, whichever arrived first", async () => {
      await within(({ revisions, message }) => {
        const old = message({ subject: "c1", revision: 5, holder: "h5" });
        const edit = message({ subject: "c1", revision: 6, holder: "h6" });
        revisions.revise("c1", 6, false, "h6");
        expect(revisions.reconcile([old])).toEqual({ events: [], unresolved: false });
        expect(revisions.reconcile([old, edit]).events.map((each) => each.id)).toEqual([edit.id]);
      });
    });

    it("keeps an edited message, as unresolved, while the edit is known of but has not arrived", async () => {
      await within(({ revisions, message }) => {
        const old = message({ subject: "c1", revision: 5, holder: "h5" });
        const plain = message();
        revisions.revise("c1", 6, false, "h6");
        const { events, unresolved } = revisions.reconcile([old, plain]);
        expect(events.map((each) => each.id)).toEqual([old.id, plain.id]);
        expect(unresolved).toBe(true);
      });
    });
  });

  describe("whether the author of a moved reply has spoken since, where they typed it", () => {
    it("is never so for a reply that was not moved", async () => {
      await within(({ revisions, message }) => {
        const reply = message({ session: "pr:1" });
        message({ session: "pr:1", received_at: 9_000 });
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(false);
      });
    });

    it("counts only the same person's later messages in that conversation, after the given time", async () => {
      await within(({ revisions, message }) => {
        const reply = message({ session: "task", routed_from: "pr:2", received_at: 2_000 });
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(false);
        message({ session: "pr:2", person: "bob", received_at: 3_000 });
        message({ session: "pr:3", received_at: 3_000 });
        message({ session: "pr:2", received_at: 1_500 });
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(false);
        message({ session: "pr:2", received_at: 3_000 });
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(true);
        // Not counted when it arrived before the time asked about.
        expect(revisions.saidSinceWhereTyped(reply, 3_000)).toBe(false);
      });
    });

    it("goes by when things were said at the source, and ignores what has since been deleted", async () => {
      await within(({ revisions, message }) => {
        const reply = message({ session: "task", routed_from: "pr:2", subject: "c1", revision: 500, received_at: 2_000 });
        // Arrived later, but said earlier.
        message({ session: "pr:2", subject: "c2", revision: 400, received_at: 3_000 });
        revisions.revise("c2", 400, false, "h1");
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(false);
        message({ session: "pr:2", subject: "c3", revision: 600, received_at: 3_000 });
        revisions.revise("c3", 600, false, "h1");
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(true);
        revisions.revise("c3", 600, true, "");
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(false);
      });
    });

    it("takes two messages said at the same moment in the order they arrived", async () => {
      await within(({ revisions, message }) => {
        // Said at the same moment as the reply, and stored before it: not later, however late it was received.
        message({ session: "pr:2", subject: "c0", revision: 500, received_at: 9_000 });
        revisions.revise("c0", 500, false, "h1");
        const reply = message({ session: "task", routed_from: "pr:2", subject: "c1", revision: 500, received_at: 2_000 });
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(false);
        // Stored after it: later, however early it was received.
        message({ session: "pr:2", subject: "c2", revision: 500, received_at: 1_000 });
        revisions.revise("c2", 500, false, "h1");
        expect(revisions.saidSinceWhereTyped(reply, 0)).toBe(true);
      });
    });
  });

  describe("looking again at the sources before an approval counts", () => {
    it("asks each subject of the source it came through", async () => {
      await within(async ({ revisions, message, now, asked, settings, known }) => {
        settings.revisable.add("gitlab");
        const a = message({ source: "github", subject: "github:c1" });
        const again = message({ source: "github", subject: "github:c1" });
        const b = message({ source: "gitlab", subject: "gitlab:c1" });
        now["github:c1"] = { revision: 2, holder: "h2", deleted: false, edited: true };
        now["gitlab:c1"] = { revision: 3, holder: "h3", deleted: false, edited: true };
        await revisions.refreshStanding([a, b, again]);
        expect(asked).toEqual(["github:github:c1", "gitlab:gitlab:c1"]);
        expect([known("github:c1").revision, known("gitlab:c1").revision]).toEqual([2, 3]);
      });
    });

    it("asks each subject's source once and records what it says now", async () => {
      await within(async ({ revisions, message, now, asked, known }) => {
        const a = message({ subject: "c1", revision: 5, holder: "h5" });
        const again = message({ subject: "c1", revision: 5, holder: "h5" });
        const b = message({ subject: "c2", revision: 5, holder: "h5" });
        const plain = message();
        now.c1 = { revision: 6, holder: "h6", deleted: false, edited: true };
        now.c2 = { revision: 5, holder: "h5", deleted: true, edited: false };
        await revisions.refreshStanding([a, again, b, plain]);
        expect(asked).toEqual(["github:c1", "github:c2"]);
        expect(known("c1")).toEqual({ revision: 6, deleted: 0, holder: "h6" });
        expect(known("c2")).toMatchObject({ deleted: 1 });
        expect(revisions.standing(a)).toBe("changed");
      });
    });

    it("refuses when a deciding reply came through a connector that cannot say what it says now", async () => {
      await within(async ({ revisions, message, asked }) => {
        const reply = message({ source: "chat", subject: "c1" });
        await expect(revisions.refreshStanding([reply])).rejects.toThrow('a reply here came through "chat", which cannot confirm what the reply says now, so nothing can be approved on it');
        expect(asked).toEqual([]);
      });
    });

    it("leaves such a message alone when nobody's approval rests on it", async () => {
      await within(async ({ revisions, message, asked }) => {
        await revisions.refreshStanding([message({ source: "chat", subject: "c1", explicit: false })]);
        expect(asked).toEqual([]);
      });
    });

    it("refuses when the source does not know a deciding reply, and passes on that the source could not be asked", async () => {
      await within(async ({ revisions, message, now }) => {
        const reply = message({ subject: "c1" });
        await expect(revisions.refreshStanding([reply])).rejects.toThrow('"github" does not recognise a reply here as one of its messages');
        // One that decides nothing is passed over.
        await revisions.refreshStanding([message({ subject: "c2", explicit: false })]);
        now.c1 = new Error("GitHub is down");
        await expect(revisions.refreshStanding([reply])).rejects.toThrow("GitHub is down");
      });
    });
  });

  it("takes when a message was said from its source if that tells, and from its arrival otherwise", async () => {
    await within(({ message }) => {
      expect(saidAt(message({ subject: "c1", revision: 500, received_at: 9_000 }))).toBe(500);
      expect(saidAt(message({ received_at: 9_000 }))).toBe(9_000);
    });
  });
});
