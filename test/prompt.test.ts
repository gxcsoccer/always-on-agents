import { describe, expect, it } from "vitest";
import { buildInstructions } from "../src/brain/prompt";
import { shows } from "../src/connectors";

const parts = (over: Record<string, unknown> = {}) => ({ scope: { tenant: "t", kind: "chat" as const, id: "oc_1" }, situation: "conversation" as const, now: 0, work: [], ...over });

describe("what the model is told of the place its messages are shown in", () => {
  it("is one of a few fixed sentences for each of the connector's answers, with the words on where it is", () => {
    const told = (answers?: { markdown: boolean; reminds: boolean }) => /Where you are\n[^\n]*\n?([^\n]*)/.exec(buildInstructions(parts({ shows: answers })))![1];
    expect(told({ markdown: true, reminds: true })).toBe("Your messages here are shown as Markdown. A message here can remind people: name them in notify. An @name or an id written in the text is only text, and reminds nobody.");
    expect(told({ markdown: true, reminds: false })).toBe("Your messages here are shown as Markdown. Nobody can be reminded from here: notify does nothing.");
    expect(told({ markdown: false, reminds: false })).toBe("Your messages here are shown as plain text, marks and all: write them without Markdown. Nobody can be reminded from here: notify does nothing.");
    // No answers: nothing is said.
    expect(told(undefined)).toBe("");
    // It stands with the stable text, before anything a conversation wrote.
    const whole = buildInstructions(parts({ shows: { markdown: true, reminds: true }, instructions: "be brief" }));
    expect(whole.indexOf("Your messages here")).toBeLessThan(whole.indexOf("be brief"));
  });

  it("is answered by each connector for the place a message goes to", () => {
    const chat = { tenant: "t", kind: "chat" as const, id: "oc_1" };
    const user = { tenant: "t", kind: "user" as const, id: "ou_1" };
    const at = (address: Record<string, string>, connector = "feishu") => ({ connector, address });
    // Where several people talk, by a message all of them see: people can be reminded. Alone with one person, or for one person's eyes: not.
    expect(shows(chat, at({ app_id: "cli_1", chat_id: "oc_1" }))).toEqual({ markdown: true, reminds: true });
    expect(shows(chat, at({ app_id: "cli_1", chat_id: "oc_1", visible_to: "ou_1" }))).toEqual({ markdown: true, reminds: false });
    expect(shows(user, at({ app_id: "cli_1", chat_id: "oc_2" }))).toEqual({ markdown: true, reminds: false });
    expect(shows({ tenant: "t", kind: "repo", id: "o/r" }, at({ repo: "o/r", issue: "1" }, "github"))).toEqual({ markdown: true, reminds: false });
    // A connector that says nothing, or none: nothing.
    expect(shows(chat, at({}, "no-such"))).toBeUndefined();
  });
});
