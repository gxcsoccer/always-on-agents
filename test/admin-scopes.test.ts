/**
 * An operator can ask which scopes there are: each says so of itself when something comes to it.
 */
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { brain, installFakeModel, message } from "./helpers";

beforeEach(() => installFakeModel());

const admin = (path: string, authorised = true) => (exports as any).default.fetch(new Request(`https://agent.test/v1/admin/${path}`, { headers: authorised ? { authorization: "Bearer test-admin" } : {} })) as Promise<Response>;
const listed = async (query = "") => ((await (await admin(`scopes${query}`)).json()) as { scopes: { name: string; tenant: string; kind: string; first_at: number; noted_at: number }[] }).scopes;

describe("which scopes there are", () => {
  it("lists a scope once something has come to it, by its name, and only to an operator", async () => {
    const chat = brain("chat");
    const person = brain("user");
    const quiet = brain("chat");
    await chat.stub.ingest(message("hello", { session_key: "chat" }));
    await person.stub.ingest(message("hello"));
    // Told once, however much comes within the hour.
    await chat.stub.ingest(message("again", { session_key: "chat" }));

    const all = await listed();
    const mine = (name: string) => all.filter((each) => each.name === name);
    expect(mine(chat.name)).toEqual([{ name: chat.name, tenant: chat.name.split(":")[0], kind: "chat", first_at: expect.any(Number), noted_at: expect.any(Number) }]);
    expect(mine(person.name)).toHaveLength(1);
    // One nothing has come to is not there.
    expect(mine(quiet.name)).toEqual([]);
    // By kind, and by tenant.
    expect((await listed("?kind=chat")).every((each) => each.kind === "chat")).toBe(true);
    expect((await listed("?kind=chat")).some((each) => each.name === chat.name)).toBe(true);
    expect(await listed(`?tenant=${chat.name.split(":")[0]}`)).toEqual(mine(chat.name));
    expect((await admin("scopes", false)).status).toBe(401);
  });

  it("says when it was last told of a scope, told again no more than once an hour", async () => {
    const { name, stub } = brain("chat");
    await stub.ingest(message("hello", { session_key: "chat" }));
    const [first] = (await listed()).filter((each) => each.name === name);
    // An hour and more later, something comes again.
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => void state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'listed_at'", String(first.noted_at - 2 * 3_600_000)));
    await stub.ingest(message("later", { session_key: "chat" }));
    const [again] = (await listed()).filter((each) => each.name === name);
    expect(again.first_at).toBe(first.first_at);
    expect(again.noted_at).toBeGreaterThanOrEqual(first.noted_at);
  });
});
