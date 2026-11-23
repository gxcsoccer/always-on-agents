import { describe, expect, it } from "vitest";

import type { Principal } from "../src/events";
import { type Asked, type Facts, type Reply, decidingReply, speaksAgainst } from "../src/brain/approval";
import type { InboxRow } from "../src/brain/store";

/**
 * Whose message decides an approval question, as a judgement on facts handed to it: no database,
 * no connector, no worker. What the Brain looks up for it is given here as plain values.
 */
const ASKED: Asked = { code: "ABCD", ask: "ask:t1:1" };

let made = 0;
/** A member's message about nothing in particular, unless said otherwise. `revision` is when its source says it was said. */
function said(text: string, over: { person?: string; question?: string; subject?: string; revision?: number; received_at?: number; id?: number } = {}): Reply {
  const id = over.id ?? ++made;
  const principal: Principal = { kind: "human", id: over.person ?? "alice", explicit: true };
  const data = { ...(over.question ? { question: over.question } : {}), ...(over.subject ? { subject: over.subject, revision: over.revision ?? 1, holder: "h" } : {}) };
  const event: InboxRow = { id, source: "feishu", source_id: `om_${id}`, kind: "message", session_key: "chat", principal: JSON.stringify(principal), text, data: JSON.stringify(data), reply_to: null, received_at: over.received_at ?? 10_000 + id };
  return { event, principal };
}

/** The facts of a shared conversation where alice asked for the task, and nothing else has happened. */
function facts(replies: Reply[], over: Partial<Facts> = {}): Facts {
  return { replies, unresolved: false, queued: () => ({ events: [], unresolved: false }), used: () => new Set(), shared: true, requestedBy: "alice", saidMore: () => false, stillStands: () => true, ...over };
}

describe("whose message decides an approval question", () => {
  it("is nobody's while no member has answered", () => {
    expect(() => decidingReply("allow", ASKED, facts([]))).toThrow("nobody here has answered the question yet; wait for a reply");
    expect(() => decidingReply("deny", ASKED, facts([]))).toThrow("nobody here has answered the question yet; wait for a reply");
  });

  describe("for a refusal", () => {
    it("is the last message that refuses, from any member", () => {
      const first = said("deny ABCD", { person: "bob" });
      const second = said("不同意 ABCD", { person: "carol" });
      expect(decidingReply("deny", ASKED, facts([first, said("hmm"), second, said("ok then")]))).toMatchObject({ event: second.event });
    });

    it("needs a message that says so", () => {
      expect(() => decidingReply("deny", ASKED, facts([said("I am not sure"), said("approve ABCD")]))).toThrow('no reply so far refuses this. A refusal is a message that says "deny ABCD". Call this tool again whenever a new reply arrives');
    });

    it("takes a plain no that is tied to the question, and not one tied to another", () => {
      const tied = said("不行", { question: ASKED.ask });
      expect(decidingReply("deny", ASKED, facts([tied]))).toMatchObject({ event: tied.event });
      expect(() => decidingReply("deny", ASKED, facts([said("deny ABCD", { question: "ask:other" })]))).toThrow("no reply so far refuses this");
    });

    it("asks nothing about what is waiting, what was used, or who asked for the task", () => {
      const refusal = said("deny ABCD", { person: "bob" });
      const never = () => {
        throw new Error("not to be asked");
      };
      expect(decidingReply("deny", { ...ASKED, truncated: true }, facts([refusal], { queued: never, used: never, saidMore: never, stillStands: never, requestedBy: null, unresolved: true }))).toMatchObject({ event: refusal.event });
    });
  });

  describe("for an approval", () => {
    it("is the requester's message that says just that, by the code", () => {
      const approval = said("approve ABCD");
      expect(decidingReply("allow", ASKED, facts([said("looks fine", { person: "bob" }), approval]))).toMatchObject({ event: approval.event, principal: approval.principal });
    });

    it("cannot be given to what was too long to show in full", () => {
      expect(() => decidingReply("allow", { ...ASKED, truncated: true }, facts([said("approve ABCD")]))).toThrow("the action is too long to be shown in full, so it cannot be approved; it can only be refused");
    });

    it("loses to a refusal from any member, whichever came first", () => {
      expect(() => decidingReply("allow", ASKED, facts([said("deny ABCD", { person: "bob" }), said("approve ABCD")]))).toThrow("a reply refuses this; pass on a denial, not an approval");
      expect(() => decidingReply("allow", ASKED, facts([said("approve ABCD"), said("deny ABCD", { person: "bob" })]))).toThrow("a reply refuses this; pass on a denial, not an approval");
    });

    it("loses to anything waiting that is about this question and is not an approval", () => {
      const approval = said("approve ABCD");
      const waiting = (reply: Reply) => facts([approval], { queued: () => ({ events: [reply.event], unresolved: false }) });
      expect(() => decidingReply("allow", ASKED, waiting(said("ABCD? let me think", { person: "bob" })))).toThrow("a reply refuses this; pass on a denial, not an approval");
      expect(() => decidingReply("allow", ASKED, waiting(said("hmm", { person: "bob", question: ASKED.ask })))).toThrow("a reply refuses this; pass on a denial, not an approval");
      // Waiting, but not about this question, or itself an approval: nothing against it.
      expect(decidingReply("allow", ASKED, waiting(said("lunch?", { person: "bob" })))).toMatchObject({ event: approval.event });
      expect(decidingReply("allow", ASKED, waiting(said("ABCD is bad", { person: "bob", question: "ask:other" })))).toMatchObject({ event: approval.event });
      expect(decidingReply("allow", ASKED, waiting(said("approve ABCD", { person: "bob" })))).toMatchObject({ event: approval.event });
    });

    it("waits while a reply was edited and its new text has not arrived, waiting or already seen", () => {
      const approval = said("approve ABCD");
      const edited = "a reply here was edited and its new text has not arrived yet; call this tool again when it has";
      expect(() => decidingReply("allow", ASKED, facts([approval], { queued: () => ({ events: [], unresolved: true }) }))).toThrow(edited);
      expect(() => decidingReply("allow", ASKED, facts([approval], { unresolved: true }))).toThrow(edited);
      // A refusal is still told first.
      expect(() => decidingReply("allow", ASKED, facts([approval, said("deny ABCD", { person: "bob" })], { unresolved: true }))).toThrow("a reply refuses this");
    });

    it("needs a message whose only words are the approval", () => {
      expect(() => decidingReply("allow", ASKED, facts([said("sure, go ahead"), said("approve ABCD once CI is green")]))).toThrow('no reply so far is an approval. An approval is a message whose only words are "approve ABCD" (mentioning you in front of it is fine; anything after it, or any other wording, is not). Tell them that, and call this tool again whenever a new reply arrives');
    });

    it("takes a plain yes that is tied to the question", () => {
      const tied = said("可以", { question: ASKED.ask });
      expect(decidingReply("allow", ASKED, facts([tied]))).toMatchObject({ event: tied.event });
      expect(() => decidingReply("allow", ASKED, facts([said("可以", { question: "ask:other" })]))).toThrow("no reply so far is an approval");
    });

    it("cannot rest on a message already used to approve a question", () => {
      const approval = said("approve ABCD");
      expect(() => decidingReply("allow", ASKED, facts([approval], { used: () => new Set([approval.event.id]) }))).toThrow("that reply was already used to approve another question");
      const again = said("approve ABCD");
      expect(decidingReply("allow", ASKED, facts([approval, again], { used: () => new Set([approval.event.id]) }))).toMatchObject({ event: again.event });
    });

    it("in a shared conversation is only the requester's to give, and nobody's when no person asked", () => {
      const bob = said("approve ABCD", { person: "bob" });
      expect(() => decidingReply("allow", ASKED, facts([bob]))).toThrow("only alice, who requested this task, can approve it");
      expect(() => decidingReply("allow", ASKED, facts([bob], { requestedBy: null }))).toThrow("this task was not started by a person, so nobody can approve this; it can only be refused");
      // In a person's own conversation, their word is enough.
      expect(decidingReply("allow", ASKED, facts([bob], { shared: false, requestedBy: null }))).toMatchObject({ event: bob.event });
    });

    it("is the approval said last, by the source's time where it tells, else as stored", () => {
      const newer = said("approve ABCD", { subject: "c1", revision: 30_000 });
      const older = said("approve ABCD", { subject: "c2", revision: 20_000 });
      expect(decidingReply("allow", ASKED, facts([newer, older]))).toMatchObject({ event: newer.event });
      const first = said("approve ABCD", { received_at: 50_000 });
      const second = said("approve ABCD", { received_at: 50_000 });
      expect(decidingReply("allow", ASKED, facts([first, second]))).toMatchObject({ event: second.event });
    });

    it("has to be that person's last word", () => {
      const approval = said("approve ABCD");
      const more = said("actually, hold on a second");
      expect(() => decidingReply("allow", ASKED, facts([approval, more]))).toThrow('alice said something after approving; ask them to confirm by sending just "approve ABCD" again');
      // Someone else speaking afterwards takes nothing back.
      expect(decidingReply("allow", ASKED, facts([approval, said("nice", { person: "bob" })]))).toMatchObject({ event: approval.event });
      // By the source's time: a remark that arrived later but was said earlier is not after it.
      const dated = said("approve ABCD", { subject: "c1", revision: 30_000 });
      const earlier = said("one question first", { subject: "c2", revision: 20_000 });
      expect(decidingReply("allow", ASKED, facts([dated, earlier]))).toMatchObject({ event: dated.event });
    });

    it("has to be their last word counting what the Brain alone can look up", () => {
      const approval = said("approve ABCD");
      const asked: Reply[] = [];
      expect(() => decidingReply("allow", ASKED, facts([approval], { saidMore: (deciding) => (asked.push(deciding), true) }))).toThrow("alice said something after approving");
      expect(asked.map((each) => each.event.id)).toEqual([approval.event.id]);
    });

    it("needs a fresh confirmation when they said something else in the same instant, as far as the source can tell", () => {
      const approval = said("approve ABCD", { subject: "c1", revision: 30_000 });
      const same = said("and thanks", { subject: "c2", revision: 30_000 });
      expect(() => decidingReply("allow", ASKED, facts([same, approval]))).toThrow('alice said something else at the same moment as approving; ask them to confirm by sending just "approve ABCD" again');
      // Arrival times order themselves: two messages received at once are not "the same instant".
      const first = said("ok", { received_at: 60_000 });
      const second = said("approve ABCD", { received_at: 60_000 });
      expect(decidingReply("allow", ASKED, facts([first, second]))).toMatchObject({ event: second.event });
      // Nor is it when only one of them carries its source's time.
      const dated = said("approve ABCD", { subject: "c3", revision: 70_000 });
      const undated = said("ok", { received_at: 70_000, id: dated.event.id - 1_000 });
      expect(decidingReply("allow", ASKED, facts([undated, dated]))).toMatchObject({ event: dated.event });
    });

    it("has to be what they still say", () => {
      const approval = said("approve ABCD");
      expect(() => decidingReply("allow", ASKED, facts([approval], { stillStands: () => false }))).toThrow("that reply has since been edited or deleted; it no longer approves anything");
      // Told before "said something after": an edited approval approves nothing either way.
      expect(() => decidingReply("allow", ASKED, facts([approval], { stillStands: () => false, saidMore: () => true }))).toThrow("that reply has since been edited or deleted");
    });
  });
});

describe("whether anything said since speaks against an approval on record", () => {
  const ON_RECORD = { code: "ABCD", ask: "ask:t1:1" };
  const approver = said("approve ABCD", { received_at: 20_000 }).event;
  const against = (later: InboxRow[], unresolved = false) => speaksAgainst({ events: later, unresolved }, ON_RECORD, approver, "alice");

  it("is not so for silence, for talk of other things by others, or for another approval", () => {
    expect(against([])).toBe(false);
    expect(against([said("lunch?", { person: "bob" }).event])).toBe(false);
    // Someone else speaking after the approval, about something else, takes nothing back.
    expect(against([said("lunch?", { person: "bob", received_at: 25_000 }).event])).toBe(false);
    expect(against([said("approve ABCD", { person: "bob" }).event])).toBe(false);
    expect(against([said("ABCD is wrong", { person: "bob", question: "ask:other" }).event])).toBe(false);
  });

  it("is so for anything about this question that is not an approval, by its code or by being tied to it", () => {
    expect(against([said("deny ABCD", { person: "bob" }).event])).toBe(true);
    expect(against([said("what is ABCD?", { person: "bob" }).event])).toBe(true);
    expect(against([said("hmm", { person: "bob", question: ON_RECORD.ask }).event])).toBe(true);
  });

  it("is so for anything the approver said at or after the approval, and not for what they said before it", () => {
    expect(against([said("thanks", { received_at: 20_000 }).event])).toBe(true);
    expect(against([said("thanks", { received_at: 25_000 }).event])).toBe(true);
    expect(against([said("one moment", { received_at: 15_000 }).event])).toBe(false);
    // Unless the approval itself is no longer on record to compare with.
    expect(speaksAgainst({ events: [said("thanks", { received_at: 25_000 }).event], unresolved: false }, ON_RECORD, undefined, "alice")).toBe(false);
  });

  it("is so while an edit among them has not arrived", () => {
    expect(against([], true)).toBe(true);
  });
});
