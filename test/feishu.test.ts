import { describe, expect, it } from "vitest";

import { decrypt, normalize, verifySignature } from "../src/connectors/feishu";
import type { FeishuApp } from "../src/registry";

const app: FeishuApp = { app_id: "cli_test", tenant: "acme", app_secret: "s", encrypt_key: "k", verification_token: "v", bot_open_id: "ou_bot", token: null, token_expires_at: null };

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
    expect(result?.event).toMatchObject({ source: "feishu", source_id: "om_1", session_key: "dm", text: "hello", principal: { kind: "human", id: "ou_alice", explicit: true } });
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
  });
});
