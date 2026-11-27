/**
 * An operator can ask which scopes there are: each says so of itself when it wakes.
 */
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { brain, installFakeModel, message, model, say, wake } from "./helpers";

beforeEach(() => installFakeModel());

type Listed = { name: string; tenant: string; kind: string; first_at: number; noted_at: number };
const admin = (path: string, authorised = true) => (exports as any).default.fetch(new Request(`https://agent.test/v1/admin/${path}`, { headers: authorised ? { authorization: "Bearer test-admin" } : {} })) as Promise<Response>;
/** Every scope listed, read a page at a time by where each page says to go on from. */
async function listed(query = "", limit = 500): Promise<Listed[]> {
  const all: Listed[] = [];
  for (let after: string | null = ""; after !== null; ) {
    const page = (await (await admin(`scopes?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ""}${query}`)).json()) as { scopes: Listed[]; next: string | null };
    all.push(...page.scopes);
    after = page.next;
  }
  return all;
}
const of = async (name: string) => (await listed()).filter((each) => each.name === name);
const registry = () => (env as any).REGISTRY.getByName("global");
/** Something comes to a scope and it wakes for it; what it tells the registry beside that has been told by the time this is over. */
async function comes(stub: any, text: string) {
  model.replies([say("")]);
  await stub.ingest(message(text, { session_key: "chat" }));
  await wake(stub);
  await vi.waitFor(async () => expect(await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec("SELECT value FROM meta WHERE key = 'listed_at'").toArray().length)).toBe(1));
}

describe("which scopes there are", () => {
  it("lists a scope once it has woken for something, by its name, and only to an operator", async () => {
    const chat = brain("chat");
    const quiet = brain("chat");
    await comes(chat.stub, "hello");
    expect(await of(chat.name)).toEqual([{ name: chat.name, tenant: chat.name.split(":")[0], kind: "chat", first_at: expect.any(Number), noted_at: expect.any(Number) }]);
    // One nothing has come to is not there.
    expect(await of(quiet.name)).toEqual([]);
    // By kind, and by tenant; a page at a time, every one reached.
    expect((await listed("&kind=chat")).some((each) => each.name === chat.name)).toBe(true);
    expect((await listed("&kind=repo")).some((each) => each.name === chat.name)).toBe(false);
    expect(await listed(`&tenant=${chat.name.split(":")[0]}`)).toEqual(await of(chat.name));
    await comes(brain("chat").stub, "hello");
    await comes(brain("chat").stub, "hello");
    expect((await listed("", 1)).map((each) => each.name)).toEqual((await listed()).map((each) => each.name));
    expect((await listed("", 1)).length).toBeGreaterThanOrEqual(3);
    // Not to anyone else; not kept by anything in between; and a name given as nothing is a mistake, not everything.
    expect((await admin("scopes", false)).status).toBe(401);
    expect((await admin("scopes")).headers.get("cache-control")).toBe("no-store");
    expect((await admin("scopes?tenant=")).status).toBe(400);
    // As many at once as it says, and no other number passes for one.
    expect((await Promise.all(["0", "500", "501", "1000", "-1", "x"].map(async (limit) => (await admin(`scopes?limit=${limit}`)).status)))).toEqual([400, 200, 400, 400, 400, 400]);
  });

  it("is told of a scope once an hour at most, and again after that", async () => {
    const { name, stub } = brain("chat");
    await comes(stub, "hello");
    // Told long ago, as far as the registry knows.
    await runInDurableObject(registry(), (_i: unknown, state: DurableObjectState) => void state.storage.sql.exec("UPDATE scopes SET noted_at = 5, first_at = 5 WHERE name = ?", name));
    // Within the hour: not told again, however often it wakes.
    model.replies([say("")]);
    await stub.ingest(message("again", { session_key: "chat" }));
    await wake(stub);
    expect((await of(name))[0].noted_at).toBe(5);
    // An hour and more since it was last told: told again, and when it was first told stays.
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => void state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key IN ('listed_at', 'listed_tried')"));
    model.replies([say("")]);
    await stub.ingest(message("later", { session_key: "chat" }));
    await wake(stub);
    await vi.waitFor(async () => expect((await of(name))[0].noted_at).toBeGreaterThan(5));
    expect((await of(name))[0].first_at).toBe(5);
  });

  it("never stands in the way of the waking it is done beside: where the registry cannot be reached at all, what came is still dealt with", async () => {
    const { name, stub } = brain("chat");
    model.replies([say("")]);
    await stub.ingest(message("hello", { session_key: "chat" }));
    // Getting ready to tell the registry throws: what it notes for itself first cannot be written.
    // (Whatever it has told so far is undone first, so that this waking is one at which it tells.)
    await runInDurableObject(registry(), (_i: unknown, state: DurableObjectState) => void state.storage.sql.exec("DELETE FROM scopes WHERE name = ?", name));
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key IN ('listed_at', 'listed_tried')");
      state.storage.sql.exec("CREATE TRIGGER no_listing BEFORE INSERT ON meta WHEN NEW.key = 'listed_tried' BEGIN SELECT RAISE(ABORT, 'cannot be noted'); END");
    });
    await wake(stub);
    // (It did try, and could not: nothing says it tried or told.)
    expect(await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => state.storage.sql.exec("SELECT key FROM meta WHERE key LIKE 'listed_%'").toArray())).toEqual([]);
    expect((await stub.inspect()).inbox).toMatchObject({ pending: 0, done: 1 });
    expect(await of(name)).toEqual([]);
  });

  it("is told at the next waking where telling was cut short, and no sooner than a minute after one that failed", async () => {
    const { name, stub } = brain("chat");
    // It tried, and nothing says the registry was told: as after an interruption between the two.
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('listed_tried', ?)", String(Date.now()));
    });
    model.replies([say("")]);
    await stub.ingest(message("hello", { session_key: "chat" }));
    await wake(stub);
    // Within the minute it is not tried again.
    expect(await of(name)).toEqual([]);
    // After it, the next waking tells.
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => void state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'listed_tried'"));
    await comes(stub, "again");
    expect(await of(name)).toHaveLength(1);
  });
});
