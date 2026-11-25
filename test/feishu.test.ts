import { afterEach, describe, expect, it, vi } from "vitest";

import { approvalCard, chatFacts, decrypt, normalize, normalizeCardAction, picturesBy, quotedBy, sentAt, verifySignature } from "../src/connectors/feishu";
import { privateSessionKey } from "../src/events";
import type { FeishuApp } from "../src/registry";

const Q = "ask:11111111-2222-3333-4444-555555555555:1";
const app: FeishuApp = { app_id: "cli_test", tenant: "acme", app_secret: "s", encrypt_key: "k", verification_token: "v", bot_open_id: "ou_bot", token: null, token_expires_at: null, transport: "webhook", oauth_v2: 0, oauth_offline: 0 };

async function sha256Hex(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifying that an event came from Feishu", () => {
  it("decrypts the test vector from Feishu's documentation", async () => {
    expect(await decrypt("test key", "P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=")).toBe("hello world");
  });

  it("fails to decrypt with the wrong key or a damaged ciphertext", async () => {
    await expect(decrypt("another key", "P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=")).rejects.toThrow();
    await expect(decrypt("test key", "AAAA")).rejects.toThrow();
  });

  it("accepts sha256(timestamp + nonce + key + body) and rejects anything else", async () => {
    const now = 1_800_000_000_000;
    const timestamp = String(now / 1_000);
    const body = '{"encrypt":"abc"}';
    const good = await sha256Hex(`${timestamp}nonce1key${body}`);
    expect(await verifySignature("key", body, timestamp, "nonce1", good, now)).toBe(true);
    expect(await verifySignature("key", `${body} `, timestamp, "nonce1", good, now)).toBe(false);
    expect(await verifySignature("other", body, timestamp, "nonce1", good, now)).toBe(false);
    expect(await verifySignature("key", body, timestamp, "nonce2", good, now)).toBe(false);
    expect(await verifySignature("key", body, timestamp, "nonce1", null, now)).toBe(false);
  });

  it("rejects a correctly signed event that is too old to be anything but a replay", async () => {
    const then = 1_800_000_000;
    const body = "{}";
    const signature = await sha256Hex(`${then}nkey${body}`);
    expect(await verifySignature("key", body, String(then), "n", signature, (then + 3_600) * 1_000)).toBe(false);
  });
});

describe("turning a Feishu message into an event", () => {
  const envelope = (message: Record<string, unknown>, sender: Record<string, unknown> = { sender_type: "user", tenant_key: "t", sender_id: { open_id: "ou_alice" } }) => ({
    schema: "2.0",
    header: { event_id: "ev1", event_type: "im.message.receive_v1", app_id: "cli_test", tenant_key: "t", token: "v" },
    event: { sender, message: { message_id: "om_1", chat_id: "oc_chat", message_type: "text", content: JSON.stringify({ text: "hello" }), ...message } },
  });

  it("puts a direct message in the sender's own scope", () => {
    const result = normalize(app, envelope({ chat_type: "p2p" }));
    expect(result?.scope).toEqual({ tenant: "acme", kind: "user", id: "ou_alice" });
    expect(result?.event).toMatchObject({ source: "feishu", source_id: "om_1", text: "hello", principal: { kind: "human", id: "ou_alice", explicit: true } });
    // A direct chat is that person's private conversation through this app and organisation,
    // and what they write there is an ordinary request in their own words.
    const origin = result?.event.data?.origin as Record<string, string>;
    expect(origin).toMatchObject({ app_id: "cli_test" });
    expect(origin.tenant_key).toBeTruthy();
    expect(result?.event.session_key).toBe(privateSessionKey("feishu", origin));
    // Written out as data, so no choice of values can make two origins read the same.
    expect(privateSessionKey("x", { a: "1,b=2" })).not.toBe(privateSessionKey("x", { a: "1", b: "2" }));
    expect(result?.event.data?.direct).toBe(true);
    // In a group it is neither.
    const group = normalize(app, envelope({ chat_type: "group", mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" }], content: JSON.stringify({ text: "@_user_1 hello" }) }));
    expect(group?.event.session_key).toBe("chat");
    expect(group?.event.data?.direct).toBeUndefined();
    expect(result?.event.reply_to).toEqual({ connector: "feishu", address: { app_id: "cli_test", chat_id: "oc_chat" } });
  });

  it("acts on a group message only when this bot is mentioned, and restores the names", () => {
    const mentionBot = { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" };
    const mentionCarol = { key: "@_user_2", id: { open_id: "ou_carol" }, name: "Carol", mentioned_type: "user" };
    const content = JSON.stringify({ text: "@_user_1 please help @_user_2" });

    const result = normalize(app, envelope({ chat_type: "group", content, mentions: [mentionBot, mentionCarol] }));
    expect(result?.scope).toEqual({ tenant: "acme", kind: "chat", id: "oc_chat" });
    // The bot's own mention is dropped, so a reply like "@Agent approve K7PW" reads as "approve K7PW".
    expect(result?.event.text).toBe("please help @Carol");
    expect(result?.event.session_key).toBe("chat");
    expect(result?.event.reply_to?.address).toMatchObject({ message_id: "om_1" });

    expect(normalize(app, envelope({ chat_type: "group", content, mentions: [mentionCarol] }))).toBeUndefined();
    expect(normalize(app, envelope({ chat_type: "group" }))).toBeUndefined();
    // Another bot being mentioned is not this bot being mentioned.
    expect(normalize(app, envelope({ chat_type: "group", content, mentions: [{ ...mentionBot, id: { open_id: "ou_other_bot" } }] }))).toBeUndefined();
    // And without knowing which bot it is, the app does not serve groups at all.
    expect(normalize({ ...app, bot_open_id: null }, envelope({ chat_type: "group", content, mentions: [mentionBot] }))).toBeUndefined();
  });

  it("does not let a member's display name supply the words of an approval", async () => {
    const { readDecision } = await import("../src/brain/agent");
    const bot = { key: "@_user_2", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" };
    const alice = { key: "@_user_1", id: { open_id: "ou_alice2" }, name: "Alice Approve", mentioned_type: "user" };
    const result = normalize(app, envelope({ chat_type: "group", content: JSON.stringify({ text: "@_user_1 K7PW @_user_2" }), mentions: [alice, bot] }));
    expect(result?.event.text).toBe("@AliceApprove K7PW");
    expect(readDecision(result!.event.text!, "K7PW")).toBeUndefined();
    // A placeholder that is not in the mention list stays visible; it is not silently removed.
    const unmapped = normalize(app, envelope({ chat_type: "group", content: JSON.stringify({ text: "@_user_9 approve K7PW @_user_2" }), mentions: [bot] }));
    expect(unmapped?.event.text).toBe("@unknown approve K7PW");
    expect(readDecision(unmapped!.event.text!, "K7PW")).toBeUndefined();
    // A name that itself contains a placeholder cannot be rewritten by a later mention.
    const tricky = { key: "@_user_1", id: { open_id: "ou_x" }, name: "approve @_user_2", mentioned_type: "user" };
    const again = normalize(app, envelope({ chat_type: "group", content: JSON.stringify({ text: "@_user_1 K7PW @_user_2" }), mentions: [tricky, bot] }));
    expect(readDecision(again!.event.text!, "K7PW")).toBeUndefined();
  });

  it("keeps an ordinary reply to a message in the chat's own conversation", () => {
    const mention = { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" };
    const result = normalize(app, envelope({ chat_type: "group", root_id: "om_question", parent_id: "om_question", mentions: [mention] }));
    expect(result?.event.session_key).toBe("chat");
    expect(result?.event.reply_to?.address).not.toHaveProperty("thread");
    expect(result?.event.data).toMatchObject({ route_by_code: true, replies_to: "feishu:message:om_question" });
  });

  it("reads the send time from both forms of the timestamp header, and checks the signature over the header as sent", async () => {
    expect(sentAt("1794034201")).toBe(1794034201);
    const written = "2026-11-19 14:50:01.123456789 +0800 CST m=+12345.678901234";
    expect(sentAt(written)).toBe(Date.parse("2026-11-19T14:50:01+08:00") / 1_000);
    expect(sentAt("yesterday")).toBeUndefined();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${written}nonce1k{"a":1}`)));
    const signature = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    const at = Date.parse("2026-11-19T14:50:30+08:00");
    expect(await verifySignature("k", '{"a":1}', written, "nonce1", signature, at)).toBe(true);
    // Stale, or signed over something else: no.
    expect(await verifySignature("k", '{"a":1}', written, "nonce1", signature, at + 3_600_000)).toBe(false);
    expect(await verifySignature("k", '{"a":2}', written, "nonce1", signature, at)).toBe(false);
  });

  it("shows an approval question as a card whose task-supplied text is never formatting", () => {
    const card = approvalCard({ id: Q, code: "K7PW", title: "**tidy**", kind: "command", detail: "rm -r [x](http://evil)", can_approve: true }, "chat") as any;
    const texts = JSON.stringify(card.elements.filter((e: any) => e.tag === "div" || e.tag === "note"));
    expect(texts).toContain("rm -r [x](http://evil)");
    expect(texts).not.toContain("lark_md");
    const buttons = card.elements.find((e: any) => e.tag === "action").actions;
    expect(buttons.map((b: any) => b.value)).toEqual([
      { aoa: "answer", decision: "approve", code: "K7PW", q: Q, to: "chat" },
      { aoa: "answer", decision: "deny", code: "K7PW", q: Q, to: "chat" },
    ]);
    // The typed alternative always carries the code, and in a group says to mention the bot.
    expect(JSON.stringify(card.elements.at(-1))).toContain("也可以先 @我，再输入「批准 K7PW」或「拒绝 K7PW」");
    // A push says in a sentence what would move, keeps the full detail, and offers "for this task".
    const push = approvalCard(
      { id: Q, code: "K7PW", title: "ship", kind: "push", detail: "push to acme/demo: move branch feature from aaaa to bbbb", can_approve: true, resource: "acme/demo", refs: [{ ref: "refs/heads/feature", old: "a".repeat(40), new: "b".repeat(40) }], standing_offered: true },
      "chat",
    ) as any;
    expect(JSON.stringify(push.elements[0])).toContain("把代码推送到 acme/demo：更新分支 feature（aaaaaaa → bbbbbbb）");
    expect(JSON.stringify(push.elements[1])).toContain("move branch feature from aaaa to bbbb");
    expect(push.elements.find((e: any) => e.tag === "action").actions.map((b: any) => b.value.decision)).toEqual(["approve", "approve_all", "deny"]);
    expect(normalizeCardAction(app, { schema: "2.0", header: { event_id: "e9", event_type: "card.action.trigger", tenant_key: "tk", app_id: "cli_test" }, event: { operator: { open_id: "ou_bob", tenant_key: "tk" }, action: { value: { aoa: "answer", decision: "approve_all", code: "K7PW", q: Q, to: "chat" } }, context: { open_chat_id: "oc_room" } } })?.event.text).toBe("approve all K7PW");
    // Once it is closed it says how it ended and offers nothing to press.
    const closed = approvalCard({ id: Q, code: "K7PW", title: "t", kind: "command", detail: "rm -r x", can_approve: true }, "chat", { state: "approved" }) as any;
    expect(closed.elements.some((e: any) => e.tag === "action")).toBe(false);
    expect(closed.header.title.content).toContain("已批准");
    // Too long to show: there is nothing to press but "refuse".
    const unverified = JSON.stringify(approvalCard({ id: Q, code: "K7PW", title: "t", kind: "command", detail: "rm -r x", can_approve: true }, "chat", { state: "unknown" }));
    expect(unverified).toContain("结果无法核实");
    expect(unverified).not.toContain('"tag":"button"');
    const refuseOnly = approvalCard({ id: Q, code: "K7PW", title: "t", kind: "push", detail: "…", can_approve: false }, "user") as any;
    expect(refuseOnly.elements.find((e: any) => e.tag === "action").actions.map((b: any) => b.value.decision)).toEqual(["deny"]);
  });

  it("turns a press of a card button into that person's own words", () => {
    const press = (value: unknown, extra: Record<string, unknown> = {}) => ({
      schema: "2.0",
      header: { event_id: "evt-1", event_type: "card.action.trigger", tenant_key: "tk", app_id: "cli_test" },
      event: { operator: { open_id: "ou_bob", tenant_key: "tk" }, action: { tag: "button", value }, context: { open_chat_id: "oc_room", open_message_id: "om_card" }, ...extra },
    });
    const inGroup = normalizeCardAction(app, press({ aoa: "answer", decision: "approve", code: "K7PW", q: Q, to: "chat" }));
    expect(inGroup?.scope).toEqual({ tenant: "acme", kind: "chat", id: "oc_room" });
    expect(inGroup?.event).toMatchObject({ source_id: "card:evt-1", text: "approve K7PW", principal: { id: "ou_bob", explicit: true }, data: { route_by_code: true, question: Q } });
    // A press that does not say which question it answers is nothing.
    expect(normalizeCardAction(app, press({ aoa: "answer", decision: "approve", code: "K7PW", to: "chat" }))).toBeUndefined();
    // In a direct chat the scope is the person who pressed it, whoever the card says it was for.
    expect(normalizeCardAction(app, press({ aoa: "answer", decision: "deny", code: "K7PW", q: Q, to: "user" }))?.scope).toEqual({ tenant: "acme", kind: "user", id: "ou_bob" });
    // Someone from another organisation, a value we did not write, a malformed code: nothing.
    expect(normalizeCardAction(app, press({ aoa: "answer", decision: "approve", code: "K7PW", q: Q, to: "chat" }, { operator: { open_id: "ou_x", tenant_key: "other" } }))).toBeUndefined();
    expect(normalizeCardAction(app, press({ decision: "approve", code: "K7PW" }))).toBeUndefined();
    expect(normalizeCardAction(app, press({ aoa: "answer", decision: "approve", code: "K7PW; deny", q: Q, to: "chat" }))).toBeUndefined();
    expect(normalizeCardAction(app, press({ aoa: "answer", decision: "maybe", code: "K7PW", q: Q, to: "chat" }))).toBeUndefined();
  });

  it("keeps a group thread as its own conversation and replies inside it", () => {
    const mention = { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" };
    const result = normalize(app, envelope({ chat_type: "group", thread_id: "omt_9", mentions: [mention] }));
    expect(result?.event.session_key).toBe("thread:omt_9");
    expect(result?.event.reply_to?.address).toMatchObject({ thread: "1" });
  });

  it("ignores other bots, other event types and malformed ids", () => {
    expect(normalize(app, envelope({ chat_type: "p2p" }, { sender_type: "bot", tenant_key: "t", sender_id: { open_id: "ou_x" } }))).toBeUndefined();
    // A person from another organisation in a shared group is not this tenant's user.
    expect(normalize(app, envelope({ chat_type: "p2p" }, { sender_type: "user", tenant_key: "another-org", sender_id: { open_id: "ou_guest" } }))).toBeUndefined();
    expect(normalize(app, { ...envelope({ chat_type: "p2p" }), header: { event_type: "im.chat.updated_v1" } })).toBeUndefined();
    expect(normalize(app, envelope({ chat_type: "p2p" }, { sender_type: "user", tenant_key: "t", sender_id: { open_id: "ou:../x" } }))).toBeUndefined();
    expect(normalize(app, envelope({ chat_type: "p2p", content: "not json" }))).toBeUndefined();
  });

  it("says so when a message is not text instead of dropping it", () => {
    expect(normalize(app, envelope({ chat_type: "p2p", message_type: "image", content: "{}" }))?.event.text).toContain("image");
    expect(normalize(app, envelope({ chat_type: "p2p", message_type: "file", content: "{}" }))?.event.text).toBe("[a file message, which I cannot read yet]");
    // A picture alone: marked, and named by Feishu's key and the message it is in, for fetching.
    const alone = normalize(app, envelope({ chat_type: "p2p", message_type: "image", content: JSON.stringify({ image_key: "img_v3_alone" }) }));
    expect(alone?.event.text).toBe("[picture]");
    expect((alone?.event.data as any).pictures).toEqual([{ message: (alone?.event.data as any).message_id, key: "img_v3_alone" }]);
    // A key that is not one is no picture.
    expect((normalize(app, envelope({ chat_type: "p2p", message_type: "image", content: JSON.stringify({ image_key: "../x" }) }))?.event.data as any).pictures).toBeUndefined();
    // Words and a picture in one message: the words and links are read, the picture is marked where it stands and named.
    const post = normalize(app, envelope({ chat_type: "p2p", message_type: "post", content: JSON.stringify({ title: "", content: [[{ tag: "img", image_key: "img_1" }], [{ tag: "text", text: "我想回复他，应该怎么回复？" }, { tag: "a", text: "方案", href: "https://x.feishu.cn/docx/DocPost0000000000001" }]] }) }));
    expect(post?.event.text).toBe("[picture]\n我想回复他，应该怎么回复？方案 (https://x.feishu.cn/docx/DocPost0000000000001)");
    expect((post?.event.data as any).pictures).toEqual([{ message: (post?.event.data as any).message_id, key: "img_1" }]);
    expect((post?.event.data as any).documents).toMatchObject([{ token: "DocPost0000000000001" }]);
    // In a chat: the bot's own mention is dropped as in a plain message, so a decision typed after it reads the same; a colleague is named from the event's list.
    const mentionBot = { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent", mentioned_type: "bot" };
    const mentionCarol = { key: "@_user_2", id: { open_id: "ou_carol" }, name: "Carol Lee" };
    const inChat = normalize(app, envelope({ chat_type: "group", message_type: "post", mentions: [mentionBot, mentionCarol], content: JSON.stringify({ title: "", content: [[{ tag: "at", user_id: "@_user_1", user_name: "Agent" }, { tag: "text", text: " approve K7PW" }], [{ tag: "at", user_id: "@_user_2" }, { tag: "text", text: "看一下" }]] }) }));
    expect(inChat?.event.text.split("\n")[0]).toBe("approve K7PW");
    expect(inChat?.event.text.split("\n")[1]).toMatch(/^@Carol\S*Lee 看一下$/);
  });
});

describe("fetching the message a group message was written in reply to", () => {
  afterEach(() => vi.unstubAllGlobals());
  /** Feishu answering the one look-up with this. */
  const feishu = (answer: unknown, status = 200) => {
    const asked: { url: string; bearer: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      asked.push({ url: request.url, bearer: request.headers.get("authorization") });
      return Response.json(answer, { status });
    });
    return asked;
  };
  const one = (over: Record<string, unknown>) => ({ message_id: "om_parent", msg_type: "text", chat_id: "oc_chat", sender: { id: "ou_alice", id_type: "open_id", sender_type: "user", tenant_key: "t" }, body: { content: JSON.stringify({ text: "the notes https://x.feishu.cn/docx/Doc1" }) }, ...over });
  const item = (over: Record<string, unknown>) => ({ code: 0, data: { items: [one(over)] } });
  const alice = { open_id: "ou_alice", tenant_key: "t" };
  const look = () => quotedBy("t-app", app, "oc_chat", "om_parent", alice);

  it("asks Feishu for that one message as the app, and gives the asker's own words", async () => {
    const asked = feishu(item({}));
    expect(await look()).toEqual({ text: "the notes https://x.feishu.cn/docx/Doc1" });
    expect(asked).toEqual([{ url: "https://open.feishu.cn/open-apis/im/v1/messages/om_parent?user_id_type=open_id", bearer: "Bearer t-app" }]);
  });

  it("names the people mentioned in it, flattens a post, and cuts what is long", async () => {
    feishu(item({ body: { content: JSON.stringify({ text: "@_user_1 and @_user_2\nlook" }) }, mentions: [{ key: "@_user_1", id: "cli_test", id_type: "app_id", name: "Agent" }, { key: "@_user_2", id: "ou_carol", id_type: "open_id", name: "Carol Approve" }] }));
    expect(await look()).toEqual({ text: "and @CarolApprove look" });
    feishu(item({ msg_type: "post", body: { content: JSON.stringify({ title: "Plan", content: [[{ tag: "text", text: "see " }, { tag: "a", text: "the doc", href: "https://x.feishu.cn/docx/Doc2" }], [{ tag: "at", user_id: "ou_carol", user_name: "Carol" }, { tag: "img", image_key: "k" }]] }) } }));
    expect((await look()).text).toBe("Plan\nsee the doc (https://x.feishu.cn/docx/Doc2)\n@Carol [picture]");
    expect((await look()).pictures).toEqual([{ message: expect.any(String), key: "k" }]);
    feishu(item({ body: { content: JSON.stringify({ text: "x".repeat(5_000) }) } }));
    expect((await look()).text).toHaveLength(1_000);
    // A link with nowhere to lead is its words; a post with nothing in it is not something read.
    feishu(item({ msg_type: "post", body: { content: JSON.stringify({ content: [[{ tag: "a", text: "bare" }]] }) } }));
    expect((await look()).text).toBe("bare");
    feishu(item({ msg_type: "post", body: { content: "{}" } }));
    expect(await look()).toEqual({});
    feishu(item({ msg_type: "post", body: { content: "null" } }));
    expect(await look()).toEqual({});
    feishu(item({ msg_type: "image", body: { content: JSON.stringify({ image_key: "k" }) } }));
    expect(await look()).toMatchObject({ text: "[picture]", pictures: [{ key: "k" }] });
  });

  it("gives another member's words as another member's, and nothing of a bot's, the agent's own, someone's from another organisation, or another message of a forwarded bundle", async () => {
    // A colleague, in the same organisation: what the person points at by replying. Its words and what it links, marked as not theirs; no picture of it.
    feishu(item({ sender: { id: "ou_bob", sender_type: "user", tenant_key: "t" } }));
    expect(await look()).toEqual({ text: "the notes https://x.feishu.cn/docx/Doc1", other: true });
    feishu(item({ sender: { id: "ou_bob", sender_type: "user", tenant_key: "t" }, msg_type: "image", body: { content: JSON.stringify({ image_key: "k" }) } }));
    expect(await look()).toEqual({ text: "[picture]", other: true });
    for (const sender of [
      { id: "cli_other", id_type: "app_id", sender_type: "app", tenant_key: "t" },
      { id: "cli_test", id_type: "app_id", sender_type: "app", tenant_key: "t" },
      { id: "ou_alice", sender_type: "user", tenant_key: "elsewhere" },
      { id: "ou_alice", sender_type: "anonymous", tenant_key: "t" },
    ]) {
      feishu(item({ sender }));
      expect(await look()).toEqual({});
    }
    // Only the message asked for counts, wherever it stands among those returned.
    feishu({ code: 0, data: { items: [one({ message_id: "om_inner", body: { content: JSON.stringify({ text: "inner" }) } })] } });
    expect(await look()).toEqual({});
    feishu({ code: 0, data: { items: [one({ message_id: "om_inner", body: { content: JSON.stringify({ text: "inner" }) } }), one({})] } });
    expect(await look()).toEqual({ text: "the notes https://x.feishu.cn/docx/Doc1" });
  });

  it("says only that there was one when it cannot be read: refused, gone, from another chat, malformed, or no answer", async () => {
    feishu({ code: 230027, msg: "Lack of necessary permissions" }, 400);
    expect(await look()).toEqual({});
    feishu(item({ deleted: true, body: undefined }));
    expect(await look()).toEqual({});
    feishu(item({ chat_id: "oc_elsewhere" }));
    expect(await look()).toEqual({});
    feishu(item({ body: { content: "not json" } }));
    expect(await look()).toEqual({});
    vi.stubGlobal("fetch", async () => {
      throw new Error("no route");
    });
    expect(await look()).toEqual({});
    // An id that is not one is not asked about.
    const asked = feishu(item({}));
    expect(await quotedBy("t-app", app, "oc_chat", "../x", alice)).toEqual({});
    expect(asked).toEqual([]);
  });

  it("fetches a picture by the message it is in, and gives nothing for one that is gone, too large, or not a picture", async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const asked: string[] = [];
    let cancelled = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname}${url.search} ${new Headers(init?.headers).get("authorization")}`);
      if (url.pathname.endsWith("/img_good")) return new Response(PNG, { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname.endsWith("/img_gone")) return Response.json({ code: 234003 }, { status: 400 });
      if (url.pathname.endsWith("/img_huge")) return new Response(PNG, { headers: { "content-length": String(6 * 1024 * 1024) } });
      if (url.pathname.endsWith("/img_text")) return new Response("<html>not a picture</html>");
      // Too large, and not saying how large: read only as far as a picture may be, then given up.
      if (url.pathname.endsWith("/img_endless")) {
        let sent = 0;
        return new Response(new ReadableStream({ pull: (controller) => (sent++ < 12 ? controller.enqueue(new Uint8Array(1024 * 1024).fill(sent === 1 ? 0x89 : 0)) : controller.close()), cancel: () => void (cancelled = sent) }));
      }
      throw new Error("no route");
    });
    const got = await picturesBy("t-app", [
      { message: "om_1", key: "img_good" },
      { message: "om_1", key: "img_gone" },
      { message: "om_2", key: "img_huge" },
      { message: "om_2", key: "img_text" },
      { message: "om_2", key: "img_unreachable" },
      { message: "../x", key: "img_good" },
      { message: "om_3", key: "img_endless" },
    ]);
    // What kind it is, is read from the bytes, not from what the answer calls itself.
    expect(got).toEqual([{ mime: "image/png", data: btoa(String.fromCharCode(...PNG)) }, null, null, null, null, null, null]);
    expect(cancelled).toBeGreaterThan(0);
    expect(cancelled).toBeLessThan(10);
    expect(asked[0]).toBe("/open-apis/im/v1/messages/om_1/resources/img_good?type=image Bearer t-app");
    // A name that is not one is not asked about.
    expect(asked).toHaveLength(6);
  });

  it("reports a lapsed app token as such, so the caller can get a fresh one", async () => {
    feishu({ code: 99991663, msg: "invalid access token" }, 400);
    expect(await look()).toBe("lapsed");
  });

  it("keeps an ordinary message on one line, as approvals are read from it", () => {
    const envelope = { schema: "2.0", header: { event_id: "ev1", event_type: "im.message.receive_v1", app_id: "cli_test", tenant_key: "t", token: "v" }, event: { sender: { sender_type: "user", tenant_key: "t", sender_id: { open_id: "ou_alice" } }, message: { message_id: "om_1", chat_id: "oc_chat", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "approve\nall  AB12" }) } } };
    expect(normalize(app, envelope)?.event.text).toBe("approve all AB12");
  });
});

describe("which documents a fetched message links", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("says what the fetched message was itself written in reply to, outside a topic", async () => {
    const item = (over: Record<string, unknown>) => ({ message_id: "om_p", chat_id: "oc_chat", msg_type: "text", sender: { sender_type: "user", id: "ou_alice", tenant_key: "t" }, body: { content: JSON.stringify({ text: "说了啥？" }) }, ...over });
    const fetched = async (over: Record<string, unknown>) => {
      vi.stubGlobal("fetch", async () => Response.json({ code: 0, data: { items: [item(over)] } }));
      return quotedBy("t-app", app, "oc_chat", "om_p", { open_id: "ou_alice", tenant_key: "t" });
    };
    expect(await fetched({ parent_id: "om_answer" })).toEqual({ text: "说了啥？", replies_to: "feishu:message:om_answer" });
    expect(await fetched({})).toEqual({ text: "说了啥？" });
    expect(await fetched({ parent_id: "om_answer", thread_id: "omt_1" })).toEqual({ text: "说了啥？" });
    expect(await fetched({ parent_id: "not an id!" })).toEqual({ text: "说了啥？" });
    // Only the message it replies to itself: where it started is not that.
    expect(await fetched({ root_id: "om_root" })).toEqual({ text: "说了啥？" });
    expect(await fetched({ parent_id: "om_answer", root_id: "om_root" })).toEqual({ text: "说了啥？", replies_to: "feishu:message:om_answer" });
    // A colleague's message: its words and what it links, marked as another member's, and what it was written in reply to.
    expect(await fetched({ parent_id: "om_answer", sender: { sender_type: "user", id: "ou_bob", tenant_key: "t" }, body: { content: JSON.stringify({ text: "bob's words https://x.feishu.cn/docx/BobsDoc0000000001" }) } })).toEqual({ text: "bob's words https://x.feishu.cn/docx/BobsDoc0000000001", other: true, documents: [expect.objectContaining({ token: "BobsDoc0000000001" })], replies_to: "feishu:message:om_answer" });
    // The app's own, or someone's from another organisation: nothing of what it says or links, only what it was written in reply to, so the chain can be followed past it.
    expect(await fetched({ parent_id: "om_answer", sender: { sender_type: "user", id: "ou_eve", tenant_key: "elsewhere" }, body: { content: JSON.stringify({ text: "eve's words" }) } })).toEqual({ replies_to: "feishu:message:om_answer" });
    expect(await fetched({ parent_id: "om_answer", sender: { sender_type: "app", id: "cli_test" } })).toEqual({ replies_to: "feishu:message:om_answer" });
    expect(await fetched({ sender: { sender_type: "user", id: "ou_eve", tenant_key: "elsewhere" } })).toEqual({});
    // Their own, with nothing in it that can be read: no words, but the chain goes on from it all the same.
    expect(await fetched({ parent_id: "om_answer", body: { content: JSON.stringify({ text: "" }) } })).toEqual({ replies_to: "feishu:message:om_answer" });
    expect(await fetched({ parent_id: "om_answer", body: { content: "{not json" } })).toEqual({ replies_to: "feishu:message:om_answer" });
    expect(await fetched({ parent_id: "om_answer", body: {} })).toEqual({ replies_to: "feishu:message:om_answer" });
    // When it was written goes along, as Feishu says it.
    expect(await fetched({ create_time: "1795000000000" })).toEqual({ text: "说了啥？", at: 1795000000000 });
    // Not out of another chat, not once recalled, and not inside a topic.
    expect(await fetched({ parent_id: "om_answer", chat_id: "oc_other" })).toEqual({});
    expect(await fetched({ parent_id: "om_answer", deleted: true })).toEqual({});
    expect(await fetched({ parent_id: "om_answer", thread_id: "omt_1", sender: { sender_type: "user", id: "ou_bob", tenant_key: "t" } })).toEqual({ text: "说了啥？", other: true });
    expect(await fetched({ parent_id: "om_answer", thread_id: "omt_1", sender: { sender_type: "app", id: "cli_other" } })).toEqual({});
  });

  it("goes by where a link leads, never by the words shown for it", async () => {
    const post = {
      zh_cn: {
        content: [
          [{ tag: "text", text: "看 https://x.feishu.cn/docx/Written00000000001 " }, { tag: "a", text: "https://x.feishu.cn/docx/Shown0000000000001", href: "https://x.feishu.cn/docx/Linked000000000001" }],
          [{ tag: "a", text: "点这里", href: "https://evil.example/docx/Other0000000000001" }],
        ],
      },
    };
    vi.stubGlobal("fetch", async () => Response.json({ code: 0, data: { items: [{ message_id: "om_p", chat_id: "oc_chat", msg_type: "post", sender: { sender_type: "user", id: "ou_alice", tenant_key: "t" }, body: { content: JSON.stringify(post) } }] } }));
    const found = (await quotedBy("t-app", app, "oc_chat", "om_p", { open_id: "ou_alice", tenant_key: "t" })) as { documents?: { token: string }[] };
    expect(found.documents?.map((each) => each.token)).toEqual(["Written00000000001", "Linked000000000001"]);
  });
});

describe("asking Feishu what kind of chat this is", () => {
  afterEach(() => vi.unstubAllGlobals());
  const answers = (info: unknown, member: unknown, seen: string[] = []) =>
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(`${init?.method ?? "GET"} ${url.pathname} ${new Headers(init?.headers).get("authorization")}`);
      const [status, body] = (url.pathname.endsWith("/members/is_in_chat") ? member : info) as [number, unknown];
      return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
    });

  it("reports the fields that say whose chat it is and whether the bot is in it, and nothing else Feishu said", async () => {
    const seen: string[] = [];
    answers([200, { code: 0, data: { name: "秘密项目", description: "不该出现", owner_id: "ou_owner", external: false, tenant_key: "t1", chat_mode: "group", chat_status: "normal" } }], [200, { code: 0, data: { is_in_chat: true } }], seen);
    const facts = await chatFacts("t-app", "oc_1");
    expect(facts).toEqual({
      info: { status: 200, code: 0, external: false, tenant_key: "t1", chat_mode: "group", chat_status: "normal", missing: [] },
      member: { status: 200, code: 0, is_in_chat: true },
    });
    expect(JSON.stringify(facts)).not.toMatch(/秘密|不该|ou_owner/);
    expect(seen.sort()).toEqual(["GET /open-apis/im/v1/chats/oc_1 Bearer t-app", "GET /open-apis/im/v1/chats/oc_1/members/is_in_chat Bearer t-app"]);
  });

  it("says which fields were not there, and passes on a refusal as its status and code alone", async () => {
    answers([200, { code: 0, data: { external: "no", chat_mode: "topic" } }], [400, { code: 232011, msg: "Operator and chat can NOT be in different tenants." }]);
    expect(await chatFacts("t-app", "oc_1")).toEqual({
      info: { status: 200, code: 0, chat_mode: "topic", missing: ["external", "tenant_key", "chat_status"] },
      member: { status: 400, code: 232011 },
    });
  });

  it("reports an answer that is not what Feishu sends as that, without throwing", async () => {
    answers([502, "<html>bad gateway</html>"], [200, { code: 0, data: { is_in_chat: "yes" } }]);
    expect(await chatFacts("t-app", "oc_1")).toEqual({ info: { status: 502, missing: ["external", "tenant_key", "chat_mode", "chat_status"] }, member: { status: 200, code: 0 } });
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down: secret detail");
    });
    expect(await chatFacts("t-app", "oc_1")).toEqual({ info: { status: 0, missing: ["external", "tenant_key", "chat_mode", "chat_status"] }, member: { status: 0 } });
  });
});

describe("showing something to one member of a chat", () => {
  it("is done in the chat itself, and not inside a topic: there it has to go to them directly", async () => {
    const { asideFeishu } = await import("../src/connectors/feishu");
    const origin = { app_id: "cli_test", tenant_key: "t" };
    expect(asideFeishu(origin, "ou_alice", { connector: "feishu", address: { app_id: "cli_test", chat_id: "oc_1", message_id: "om_1" } })).toEqual({ connector: "feishu", address: { app_id: "cli_test", chat_id: "oc_1", visible_to: "ou_alice" } });
    expect(asideFeishu(origin, "ou_alice", { connector: "feishu", address: { app_id: "cli_test", chat_id: "oc_1", message_id: "om_1", thread: "1" } })).toBeUndefined();
    // Not for another app's chat, nor without knowing whom.
    expect(asideFeishu({ app_id: "cli_other", tenant_key: "t" }, "ou_alice", { connector: "feishu", address: { app_id: "cli_test", chat_id: "oc_1" } })).toBeUndefined();
  });
});
