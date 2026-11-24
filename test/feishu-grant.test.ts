import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { type FeishuGrant, type Who, grantName, grantOf } from "../src/connectors/feishu-grant";

/**
 * An invitation made for one question asked where several people talk: it is that question's
 * alone, what became of it is on record under its own name, and only the Brain it was asked in
 * (and the person's own) is told. The grant object by itself; no Feishu, no model.
 */
const REDIRECT = "https://agent.test/v1/feishu/oauth/callback";
const DOCS = ["docx:document:readonly"];
const TOKEN = { access_token: "u-1", expires_at: Date.now() + 7_200_000, scope: DOCS.join(" ") };
const CHAT = "acme:chat:oc_1";

let people = 0;
async function someone() {
  const who: Who = { app_id: "cli_grant_test", tenant_key: "t1", open_id: `ou_grant_${++people}` };
  const stub = await grantOf(env as any, who);
  const inside = <T>(use: (grant: FeishuGrant, state: DurableObjectState) => T | Promise<T>) => runInDurableObject(stub, (instance: FeishuGrant, state: DurableObjectState) => use(instance, state));
  const stored = () => inside((_grant, state) => state.storage.get<any>("grant"));
  const change = (how: (stored: any) => void) =>
    inside(async (_grant, state) => {
      const record = (await state.storage.get<any>("grant"))!;
      how(record);
      await state.storage.put("grant", record);
    });
  /** An invitation for one question, by the message that asked it. */
  const asks = async (message: string, brain = CHAT) => {
    const made = await inside((grant) => grant.invite(who, REDIRECT, DOCS, { generation: 1 }, { brain, key: message }));
    if (made === "superseded") throw new Error("superseded");
    return made.nonce;
  };
  const answered = (nonce: string, generation = 1) => inside((grant) => grant.answered(nonce, DOCS, generation));
  return { who, stub, inside, stored, change, asks, answered, name: await grantName(who) };
}

describe("an invitation made for one question", () => {
  it("is that question's alone: asked again it is the same one, and another question, place or a private request gets its own", async () => {
    const p = await someone();
    const first = await p.asks("om_1");
    expect(await p.asks("om_1")).toBe(first);
    expect(await p.asks("om_2")).not.toBe(first);
    expect(await p.asks("om_1", "acme:chat:oc_other")).not.toBe(first);
    const made = await p.inside((grant) => grant.invite(p.who, REDIRECT, DOCS, { generation: 1 }));
    const own = (made as { nonce: string }).nonce;
    expect(own).not.toBe(first);
    // And one made for nobody's question in particular is not handed to a question either.
    expect([await p.asks("om_3"), await p.asks("om_1")]).not.toContain(own);
  });

  it("is pushed out by a fourth: what it led to is over, and the others stand", async () => {
    const p = await someone();
    const [a, b, c] = [await p.asks("om_1"), await p.asks("om_2"), await p.asks("om_3")];
    const d = await p.asks("om_4");
    expect(await p.answered(a)).toEqual({ state: "gone" });
    expect(await Promise.all([b, c, d].map((each) => p.answered(each)))).toEqual([{ state: "not_yet" }, { state: "not_yet" }, { state: "not_yet" }]);
    expect(await p.inside((grant) => grant.redeem(a))).toBeNull();
    expect(await p.inside((grant) => grant.card(a))).toBeNull();
  });

  it("is claimed by the first answer that comes back, and done only when the person's token is kept through it", async () => {
    const p = await someone();
    const nonce = await p.asks("om_1");
    expect(await p.answered(nonce)).toEqual({ state: "not_yet" });
    const claimed = await p.inside((grant) => grant.redeem(nonce));
    expect(claimed).toMatchObject({ who: p.who, scope: DOCS, generation: 1 });
    // A second answer for the same invitation, from a repeat or from another card showing it, gets nothing to exchange.
    expect(await p.inside((grant) => grant.redeem(nonce))).toBeNull();
    // While it is being exchanged, whoever waits on it is still waiting.
    expect(await p.answered(nonce)).toEqual({ state: "not_yet" });
    const before = Date.now();
    expect(await p.inside((grant) => grant.install(1, TOKEN, nonce))).toBe(true);
    const now = await p.answered(nonce);
    expect(now).toMatchObject({ state: "holds" });
    expect((now as { since: number }).since).toBeGreaterThanOrEqual(before);
    // Both Brains are owed word of it, each on its own, and the invitation is used up.
    const record = await p.stored();
    expect(record.owed.map((each: any) => each.to)).toContain(CHAT);
    expect(record.owed).toHaveLength(2);
    expect(record.pending).toEqual([]);
    expect(await p.inside((grant) => grant.redeem(nonce))).toBeNull();
  });

  it("is done also when the person already holds what it asks for: nothing about the token changes", async () => {
    const p = await someone();
    // The invitation is made first; then the person authorises some other way; then they answer it all the same.
    const nonce = await p.asks("om_1");
    expect(await p.inside((grant) => grant.install(1, TOKEN))).toBe(true);
    const held = (await p.stored()).grant.version;
    expect(await p.answered(nonce)).toEqual({ state: "not_yet" });
    await p.inside((grant) => grant.redeem(nonce));
    expect(await p.inside((grant) => grant.install(1, { ...TOKEN, access_token: "u-2" }, nonce))).toBe(true);
    expect((await p.stored()).grant.version).toBe(held);
    expect(await p.answered(nonce)).toMatchObject({ state: "holds" });
  });

  it("answers only for itself: the person authorising some other way does not make it done", async () => {
    const p = await someone();
    const here = await p.asks("om_1");
    const there = await p.asks("om_9", "acme:chat:oc_other");
    await p.inside((grant) => grant.redeem(there));
    await p.inside((grant) => grant.install(1, TOKEN, there));
    expect(await p.answered(there)).toMatchObject({ state: "holds" });
    expect(await p.answered(here)).toEqual({ state: "not_yet" });
    expect((await p.stored()).owed.map((each: any) => each.to)).not.toContain(CHAT);
  });

  it("is over once it is turned down, and nothing that comes later brings it back", async () => {
    const p = await someone();
    const nonce = await p.asks("om_1");
    await p.inside((grant) => grant.redeem(nonce));
    await p.inside((grant) => grant.fail(nonce));
    expect(await p.answered(nonce)).toEqual({ state: "gone" });
    expect(await p.inside((grant) => grant.install(1, TOKEN, nonce))).toBe(false);
    expect((await p.stored()).grant).toBeUndefined();
    expect(await p.answered(nonce)).toEqual({ state: "gone" });
    expect(await p.inside((grant) => grant.redeem(nonce))).toBeNull();
    // The same question asked again is given a new one.
    expect(await p.asks("om_1")).not.toBe(nonce);
  });

  it("does not stay claimed for ever: an exchange that never reported back ends it after two minutes, and a late one changes nothing", async () => {
    const p = await someone();
    const nonce = await p.asks("om_1");
    await p.inside((grant) => grant.redeem(nonce));
    await p.change((record) => (record.pending[0].redeeming = Date.now() - 121_000));
    expect(await p.answered(nonce)).toEqual({ state: "gone" });
    expect(await p.inside((grant) => grant.install(1, TOKEN, nonce))).toBe(false);
    expect(await p.answered(nonce)).toEqual({ state: "gone" });
  });

  it("has to be answered within its ten minutes, and what it led to is on record for an hour", async () => {
    const late = await someone();
    const missed = await late.asks("om_1");
    await late.inside((grant) => grant.redeem(missed));
    await late.change((record) => (record.pending[0].expires_at = Date.now() - 1));
    expect(await late.inside((grant) => grant.install(1, TOKEN, missed))).toBe(false);
    expect(await late.answered(missed)).toEqual({ state: "gone" });

    const p = await someone();
    const nonce = await p.asks("om_1");
    await p.inside((grant) => grant.redeem(nonce));
    await p.inside((grant) => grant.install(1, TOKEN, nonce));
    await p.change((record) => (record.outcomes[0].at = Date.now() - 3_600_001));
    expect(await p.answered(nonce)).toEqual({ state: "gone" });
  });

  it("is over when the authorisation is taken away or is no longer the one it was made under", async () => {
    const p = await someone();
    const nonce = await p.asks("om_1");
    await p.inside((grant) => grant.redeem(nonce));
    await p.inside((grant) => grant.install(1, TOKEN, nonce));
    expect(await p.answered(nonce, 2)).toEqual({ state: "gone" });
    await p.inside((grant) => grant.drop(p.who));
    expect(await p.answered(nonce)).toEqual({ state: "gone" });
    const open = await someone();
    const waiting = await open.asks("om_1");
    await open.inside((grant) => grant.drop(open.who));
    expect(await open.answered(waiting)).toEqual({ state: "gone" });
  });

  it("no longer holds once the token it gave has run out", async () => {
    const p = await someone();
    const nonce = await p.asks("om_1");
    await p.inside((grant) => grant.redeem(nonce));
    await p.inside((grant) => grant.install(1, TOKEN, nonce));
    await p.change((record) => (record.grant.expires_at = Date.now() - 1));
    expect(await p.answered(nonce)).toEqual({ state: "not_yet" });
  });
});

describe("telling the Brains that an invitation was answered", () => {
  it("tells each one until that one has heard, and what one heard does not clear what another is owed", async () => {
    const p = await someone();
    await (env as any).REGISTRY.getByName("global").createTenant("acme", "acme").catch(() => undefined);
    await (env as any).REGISTRY.getByName("global").setFeishuApp("acme", { app_id: p.who.app_id, app_secret: "s", transport: "long_connection" });
    const nonce = await p.asks("om_1");
    await p.inside((grant) => grant.redeem(nonce));
    await p.inside((grant) => grant.install(1, TOKEN, nonce));
    const told: string[] = [];
    await p.inside((grant: any) => {
      const real = grant.env;
      grant.env = {
        ...real,
        BRAIN: {
          getByName: (name: string) => ({
            conditionReported: async (connector: string, subject: string) => {
              told.push(`${name} ${connector} ${subject === p.name}`);
              if (name === CHAT && told.filter((each) => each.startsWith(CHAT)).length === 1) throw new Error("cannot be reached");
              return { ok: true };
            },
          }),
        },
      };
    });
    await runDurableObjectAlarm(p.stub);
    expect(told.sort()).toEqual([`${CHAT} feishu true`, `acme:user:${p.who.open_id} feishu true`].sort());
    expect((await p.stored()).owed).toMatchObject([{ to: CHAT, attempts: 1 }]);
    await runDurableObjectAlarm(p.stub);
    expect((await p.stored()).owed).toBeUndefined();
    expect(told.filter((each) => each.startsWith(CHAT))).toHaveLength(2);
  });

  it("still tells the person's own Brain what was owed to it before there was more than one to tell", async () => {
    const p = await someone();
    await (env as any).REGISTRY.getByName("global").createTenant("acme", "acme").catch(() => undefined);
    await (env as any).REGISTRY.getByName("global").setFeishuApp("acme", { app_id: p.who.app_id, app_secret: "s", transport: "long_connection" });
    await p.asks("om_1");
    await p.change((record) => (record.owed = { event: "v-old", attempts: 3 }));
    await p.inside((_grant, state) => state.storage.setAlarm(Date.now()));
    const told: string[] = [];
    await p.inside((grant: any) => {
      grant.env = { ...grant.env, BRAIN: { getByName: (name: string) => ({ conditionReported: async (_c: string, _s: string, event: string) => (told.push(`${name} ${event}`), { ok: true }) }) } };
    });
    await runDurableObjectAlarm(p.stub);
    expect(told).toEqual([`acme:user:${p.who.open_id} v-old`]);
    expect((await p.stored()).owed).toBeUndefined();
  });
});
