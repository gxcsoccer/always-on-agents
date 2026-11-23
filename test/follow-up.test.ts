/**
 * The strict behaviour and the proposed one, decided on the same inputs, side by side
 * (docs/design/agent-core.md, 5.8). Nothing is read or sent here: these are the decisions alone.
 *
 * What this does not measure: whether the model takes an unrelated or a negative sentence for a
 * follow-up. Under rule A that judgement is the model's; the rows marked `ruleA` are the ones
 * where the code allows and the model still has to decide.
 */
import { describe, expect, it } from "vitest";

import { type FollowUpCase, type Verdict, followUpDecision, locate, passageNow, strictDecision } from "../src/brain/follow-up";

const NOW = 1_000_000;
const kept = { session: "s1", expiresAt: NOW + 1, subjects: ["msg:answer"], isLastThingSaid: true };
const base: FollowUpCase = { enabled: true, actingForPerson: true, session: "s1", repliedTo: [], now: NOW, answer: kept };

/** Each case: what it is, whether the person has the authority for it at all, and what the proposed behaviour must decide. */
const cases: { name: string; input: FollowUpCase; inAuthority: boolean; proposed: Verdict; ruleA?: true; why?: string }[] = [
  { name: "a plain follow-up right after the answer", input: base, inAuthority: true, proposed: { allow: true }, ruleA: true, why: "the agreed positive: 'expand on the second point' with nothing said in between" },
  { name: "a reply to the answer's own message, later", input: { ...base, repliedTo: ["msg:answer"], answer: { ...kept, isLastThingSaid: false } }, inAuthority: true, proposed: { allow: true }, why: "the reply names the answer" },
  { name: "a follow-up that waited for authorisation and is carried on", input: { ...base, carriedOn: true, answer: { ...kept, isLastThingSaid: false } }, inAuthority: true, proposed: { allow: true }, why: "which answer was settled when it was first asked; everything else is checked again" },
  { name: "something else was said since, and no reply", input: { ...base, answer: { ...kept, isLastThingSaid: false } }, inAuthority: true, proposed: { allow: false, reason: "not_the_last_thing_said" } },
  { name: "a reply to the person's own message the answer was read for", input: { ...base, repliedTo: ["msg:asked"], answer: { ...kept, subjects: ["msg:answer", "msg:linked", "msg:asked"], isLastThingSaid: false } }, inAuthority: true, proposed: { allow: true }, why: "the reply names a message of the person's own that this answer's source was tied to, and no other answer's" },
  { name: "a reply to a message two kept answers were read for", input: { ...base, repliedTo: ["msg:asked"], answer: { ...kept, subjects: ["msg:answer", "msg:asked"], shared: true } }, inAuthority: true, proposed: { allow: false, reason: "reply_fits_several" } },
  { name: "a reply to a message the answer was not read for, though another answer shares one that it was", input: { ...base, repliedTo: ["msg:other"], answer: { ...kept, subjects: ["msg:answer", "msg:asked"], shared: true } }, inAuthority: true, proposed: { allow: false, reason: "replied_to_something_else" } },
  { name: "no reply at all, though another answer was read for the same message", input: { ...base, answer: { ...kept, subjects: ["msg:answer", "msg:asked"], shared: true } }, inAuthority: true, proposed: { allow: true }, ruleA: true, why: "nothing was replied to, so what two answers share is not in question: it is the last thing said" },
  { name: "a reply to some other message", input: { ...base, repliedTo: ["msg:other"] }, inAuthority: true, proposed: { allow: false, reason: "replied_to_something_else" } },
  { name: "a reply to the answer and to something else at once", input: { ...base, repliedTo: ["msg:answer", "msg:other"] }, inAuthority: true, proposed: { allow: false, reason: "replied_to_something_else" } },
  { name: "the answer is no longer kept", input: { ...base, answer: { ...kept, expiresAt: NOW } }, inAuthority: true, proposed: { allow: false, reason: "expired" } },
  { name: "no such answer", input: { ...base, answer: undefined }, inAuthority: true, proposed: { allow: false, reason: "no_such_answer" } },
  { name: "follow-ups switched off", input: { ...base, enabled: false }, inAuthority: true, proposed: { allow: false, reason: "off" } },
  { name: "a run not started by the person alone (a timer, a worker, a group)", input: { ...base, actingForPerson: false }, inAuthority: false, proposed: { allow: false, reason: "not_the_person" } },
  { name: "an answer given in another conversation", input: { ...base, answer: { ...kept, session: "s2" } }, inAuthority: false, proposed: { allow: false, reason: "another_conversation" } },
  { name: "another conversation, even as a reply to it", input: { ...base, repliedTo: ["msg:answer"], answer: { ...kept, session: "s2" } }, inAuthority: false, proposed: { allow: false, reason: "another_conversation" } },
  { name: "not the person, even right after the answer", input: { ...base, actingForPerson: false, repliedTo: ["msg:answer"] }, inAuthority: false, proposed: { allow: false, reason: "not_the_person" } },
];

describe("following up: the strict and the proposed decision on the same inputs", () => {
  it.each(cases)("$name", ({ input, proposed }) => {
    expect(strictDecision(input)).toEqual({ allow: false, reason: "off" });
    expect(followUpDecision(input)).toEqual(proposed);
  });

  it("allows nothing outside the person's authority, and every case the strict behaviour refused and this allows has its reason", () => {
    const outOfAuthorityAllows = cases.filter((each) => !each.inAuthority && followUpDecision(each.input).allow);
    expect(outOfAuthorityAllows).toEqual([]);
    const deltas = cases.filter((each) => !strictDecision(each.input).allow && followUpDecision(each.input).allow);
    expect(deltas.map((each) => each.name)).toEqual(["a plain follow-up right after the answer", "a reply to the answer's own message, later", "a follow-up that waited for authorisation and is carried on", "a reply to the person's own message the answer was read for", "no reply at all, though another answer was read for the same message"]);
    expect(deltas.every((each) => typeof each.why === "string")).toBe(true);
    // The one allowance that still rests on the model's reading of the person's words.
    expect(deltas.filter((each) => each.ruleA).map((each) => each.name)).toEqual(["a plain follow-up right after the answer", "no reply at all, though another answer was read for the same message"]);
  });
});

describe("a passage an answer rested on", () => {
  const text = "Introduction to the plan. The budget is 40 million. Details follow. The team has nine people. End of the plan.";

  it("is tied to one place, or not at all", () => {
    expect(locate("budget", "The budget is 40 million.", [text])).toMatchObject({ found: true });
    expect(locate("made up", "The budget is 50 million.", [text]).found).toBe(false);
    // The same words twice: there is no telling which place was meant.
    expect(locate("twice", "people", ["nine people and ten people"]).found).toBe(false);
  });

  it("is unchanged only where the same words stand in the same surroundings", () => {
    const budget = locate("budget", "The budget is 40 million.", [text]);
    const team = locate("team", "The team has nine people.", [text]);
    expect(passageNow(budget, [text], false).now).toBe("unchanged");
    // Another sentence was edited: this one still stands, that one does not.
    const edited = text.replace("nine", "twelve");
    expect(passageNow(budget, [edited], false).now).toBe("unchanged");
    expect(passageNow(team, [edited], false).now).toBe("changed");
    // The same words moved under another heading prove nothing about the point they supported.
    expect(passageNow(budget, ["Rejected proposals. The budget is 40 million. Rejected."], false).now).toBe("cannot verify");
    // Not read whole this time, and the passage is not in the part read.
    expect(passageNow(team, ["Introduction to the plan. The budget is 40 million."], true).now).toBe("cannot verify");
    // The last sentence of the document, moved under another heading: nothing follows it either
    // time, and an empty anchor is not evidence of anything.
    const end = "Approved for this project. The budget is 40 million.";
    const last = locate("budget", "The budget is 40 million.", [end]);
    expect(passageNow(last, ["Explicitly rejected proposal. The budget is 40 million."], false).now).toBe("cannot verify");
    expect(passageNow(last, [end], false).now).toBe("unchanged");
    // A few characters are kept, as not tied to any place.
    expect(locate("short", "九人", ["团队有九人。"])).toMatchObject({ found: false, quote: "九人" });
    // Never tied to a place when the answer was written.
    expect(passageNow(locate("made up", "nowhere", [text]), [text], false).now).toBe("cannot verify");
  });
});
