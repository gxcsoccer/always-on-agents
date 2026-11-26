import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commentableLines, githubConnector, inert, isOurs } from "../src/connectors/github";
import { mentionsOf } from "../src/connectors/markdown";
import { DeliveryDeferred } from "../src/connectors/types";
import type { CodeReview } from "../src/connectors/types";
import type { Env } from "../src/env";

const HEAD = "a".repeat(40);
const PATCH = ["@@ -1,3 +1,4 @@", " one", "-two", "+TWO", "+two and a half", " three", "@@ -10,2 +11,2 @@", " ten", "+eleven"].join("\n");

/** Stands in for GitHub's API for one pull request, and records what was posted. */
function github(options: { pull?: number; reviews?: any[]; pages?: number; nextOnly?: boolean; comments?: any[]; refuse?: unknown; refuseHeaders?: Record<string, string>; refuseStatus?: number } = {}) {
  const posted: { url: string; body: any }[] = [];
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.replace("https://api.github.com/repos/acme/demo", "").split("?")[0];
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push({ url: path, body });
      if (path === "/pulls/7/reviews" && options.refuse && (body.comments.length > 0 || options.refuseStatus)) return Response.json(options.refuse, { status: options.refuseStatus ?? 422, headers: options.refuseHeaders });
      return Response.json({ id: 99, body: body.body });
    }
    asked.push(url);
    if (path === "/pulls/7") return options.pull === 404 ? Response.json({}, { status: 404 }) : Response.json({ head: { sha: HEAD } });
    if (path === "/pulls/7/reviews") {
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 1);
      const pages = options.pages ?? 1;
      // Oldest first: what a test supplies is the newest, on the last page.
      const old = Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i, body: "an old review", state: "COMMENTED", submitted_at: "2020-01-01T00:00:00Z" }));
      const batch = page === pages ? (options.reviews ?? []) : old;
      const link = options.nextOnly ? (page < pages ? `<https://api.github.com/x?per_page=100&page=${page + 1}>; rel="next"` : "") : pages > 1 ? `<https://api.github.com/x?per_page=100&page=${pages}>; rel="last"` : "";
      return Response.json(batch, { headers: link ? { link } : {} });
    }
    if (path === "/pulls/7/files") return Response.json([{ filename: "src/a.ts", patch: PATCH }, { filename: "logo.png" }]);
    if (path === "/issues/7/comments") return Response.json(options.comments ?? []);
    throw new Error(`unexpected request to ${url}`);
  });
  return Object.assign(posted, { asked });
}

const MARKER = "<!-- always-on-agent:msg:call_1 -->";
const review: CodeReview = {
  summary: "Two problems.",
  commit: HEAD,
  comments: [
    { path: "src/a.ts", line: 2, body: "on a changed line" },
    { path: "src/a.ts", line: 7, body: "on a line the change does not show" },
    { path: "src/b.ts", line: 1, body: "in a file the change does not touch" },
  ],
};
const send = (r: CodeReview = review, text = "the review in words") =>
  githubConnector.channel!.deliver(env as unknown as Env, { tenant: "t", kind: "repo", id: "acme/demo" }, { connector: "github", address: { repo: "acme/demo", number: "7" } }, {
    id: 1,
    idem: "msg:call_1",
    text,
    created_at: Date.parse("2026-01-01T00:00:00Z"),
    review: r,
  });

afterEach(() => vi.unstubAllGlobals());

describe("a code review on GitHub", () => {
  it("knows which lines of a change a comment can be attached to", () => {
    const lines = commentableLines([{ filename: "src/a.ts", patch: PATCH }, { filename: "logo.png" }]);
    // Added and context lines, numbered as in the new file; a removed line has no number there.
    expect([...lines.get("src/a.ts")!]).toEqual([1, 2, 3, 4, 11, 12]);
    expect(lines.has("logo.png")).toBe(false);
    // Only the files asked about are looked at.
    expect(commentableLines([{ filename: "src/a.ts", patch: PATCH }], new Set(["other.ts"])).size).toBe(0);
  });

  it("puts each comment on its line, keeps the others in the body, says what it reviewed, and only comments", async () => {
    const posted = github();
    const receipt = await send();
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/pulls/7/reviews");
    expect(posted[0].body).toMatchObject({ commit_id: HEAD, event: "COMMENT", comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "on a changed line" }] });
    const body: string = posted[0].body.body;
    expect(body).toContain("Two problems.");
    expect(body).toContain("Reviewed at aaaaaaa.");
    expect(body).toContain("` src/a.ts:7 `");
    expect(body).toContain("` src/b.ts:1 `");
    expect(body).not.toContain("on a changed line");
    expect(body.endsWith(MARKER)).toBe(true);
    expect(receipt).toMatchObject({ subject: "github:review:99" });
  });

  it("does not post the same review twice when an earlier attempt got through", async () => {
    const posted = github({ reviews: [{ id: 41, body: `Two problems.\n\n${MARKER}`, state: "COMMENTED", submitted_at: "2026-01-01T00:00:05Z" }] });
    expect(await send()).toMatchObject({ subject: "github:review:41" });
    expect(posted).toHaveLength(0);
  });

  it("finds an earlier attempt among a great many reviews, by reading the newest first", async () => {
    const posted = github({ pages: 12, reviews: [{ id: 41, body: `Two problems.\n\n${MARKER}`, state: "COMMENTED", submitted_at: "2026-01-01T00:00:05Z" }] });
    expect(await send()).toMatchObject({ subject: "github:review:41" });
    expect(posted).toHaveLength(0);
    // It did not walk all twelve pages to get there.
    expect(posted.asked.filter((url) => url.includes("/reviews")).length).toBeLessThanOrEqual(2);
  });

  it("does not take a review for its own because it quotes the marker, or because it is an unpublished draft", async () => {
    const posted = github({
      reviews: [
        { id: 50, body: `I saw ${MARKER} in an earlier comment and wondered what it was.`, state: "COMMENTED", submitted_at: "2026-01-01T00:00:05Z" },
        { id: 51, body: `Two problems.\n\n${MARKER}`, state: "PENDING" },
      ],
    });
    expect(await send()).toMatchObject({ subject: "github:review:99" });
    expect(posted).toHaveLength(1);
  });

  it("posts a review of an earlier commit as a comment that says so, and never as a review of the current one", async () => {
    for (const comments of [review.comments, []]) {
      const posted = github();
      const receipt = await send({ summary: "No findings.", commit: "b".repeat(40), comments }, "No findings.");
      expect(posted).toHaveLength(1);
      expect(posted[0].url).toBe("/issues/7/comments");
      expect(posted[0].body.body).toContain("This review is of commit bbbbbbb. The pull request has since moved to aaaaaaa");
      expect(posted[0].body.body).toContain("No findings.");
      expect(receipt).toMatchObject({ subject: "github:comment:99" });
    }
  });

  it("posts a review that does not say which commit it is of as a comment that says so", async () => {
    const posted = github();
    await send({ summary: review.summary, comments: review.comments });
    expect(posted[0].url).toBe("/issues/7/comments");
    expect(posted[0].body.body).toContain("does not say which commit it is of");
    expect(posted[0].body.body).toContain("Two problems.");
    expect(posted[0].body.body).toContain("` src/a.ts:2 `\non a changed line");
  });

  it("sends the whole review in the body when GitHub will not take a line", async () => {
    const posted = github({ refuse: { message: "Unprocessable Entity", errors: ["Line could not be resolved"] } });
    await send();
    expect(posted).toHaveLength(2);
    expect(posted[1].body.comments).toEqual([]);
    expect(posted[1].body.body).toContain("on a changed line");
  });

  it("does not post again when GitHub refuses for any other reason", async () => {
    const posted = github({ refuse: { message: "Validation Failed", errors: [{ resource: "PullRequestReview", code: "custom", message: "was submitted too quickly" }] } });
    await expect(send()).rejects.toThrow(/422/);
    expect(posted).toHaveLength(1);
  });

  it("publishes one review once, even if the pull request moves between an attempt and its retry", async () => {
    const stale = { summary: "No findings.", commit: "b".repeat(40), comments: [] };
    // Posted as a review while the pull request was at the reviewed commit; it has moved on since.
    let posted = github({ reviews: [{ id: 41, body: `No findings.\n\n${MARKER}`, state: "COMMENTED", submitted_at: "2026-01-01T00:00:05Z" }] });
    expect(await send(stale)).toMatchObject({ subject: "github:review:41" });
    expect(posted).toHaveLength(0);
    // The other way round: posted as a comment while the pull request was elsewhere; it is back now.
    posted = github({ comments: [{ id: 42, body: `This review is of commit aaaaaaa…\n\n${MARKER}`, created_at: "2026-01-01T00:00:05Z" }] });
    expect(await send()).toMatchObject({ subject: "github:comment:42" });
    expect(posted).toHaveLength(0);
  });

  it("follows a listing of reviews that only says what comes next, and gives up rather than guess when it is too long", async () => {
    const earlier = [{ id: 41, body: `Two problems.\n\n${MARKER}`, state: "COMMENTED", submitted_at: "2026-01-01T00:00:05Z" }];
    let posted = github({ pages: 3, nextOnly: true, reviews: earlier });
    expect(await send()).toMatchObject({ subject: "github:review:41" });
    expect(posted).toHaveLength(0);
    posted = github({ pages: 12, nextOnly: true, reviews: earlier });
    await expect(send()).rejects.toThrow(/too many reviews/);
    expect(posted).toHaveLength(0);
  });

  it("waits as long as GitHub says before trying again, and does not post a second time meanwhile", async () => {
    for (const refusal of [
      { refuseStatus: 429, refuse: { message: "rate limited" } },
      // Even when the refusal reads like one about a line.
      { refuse: { message: "Unprocessable", errors: ["line must be part of the diff"] } },
    ]) {
      const posted = github({ ...refusal, refuseHeaders: { "retry-after": "120" } });
      const before = Date.now();
      const error = await send().then(() => undefined, (err) => err);
      expect(error).toBeInstanceOf(DeliveryDeferred);
      expect(error.notBefore).toBeGreaterThanOrEqual(before + 120_000);
      expect(error.notBefore).toBeLessThan(before + 130_000);
      expect(posted).toHaveLength(1);
    }
  });

  it("keeps GitHub's own deadline however long, waits a minute when throttled without one, and does not slow an ordinary refusal", async () => {
    const attempt = async (options: Parameters<typeof github>[0]) => {
      github(options);
      const before = Date.now();
      const error = await send().then(() => undefined, (err) => err);
      return { error, wait: error instanceof DeliveryDeferred ? error.notBefore - before : undefined };
    };
    const long = await attempt({ refuseStatus: 429, refuse: { message: "rate limited" }, refuseHeaders: { "retry-after": "7200" } });
    expect(long.wait).toBeGreaterThanOrEqual(7_200_000);
    expect(long.wait).toBeLessThan(7_210_000);
    for (const secondary of [
      { refuseStatus: 429, refuse: { message: "You have exceeded a secondary rate limit." } },
      { refuseStatus: 403, refuse: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } },
    ]) {
      const throttled = await attempt(secondary);
      expect(throttled.wait).toBeGreaterThanOrEqual(60_000);
      expect(throttled.wait).toBeLessThan(70_000);
    }
    const denied = await attempt({ refuseStatus: 403, refuse: { message: "Resource not accessible by integration" } });
    expect(denied.error).toBeInstanceOf(Error);
    expect(denied.error).not.toBeInstanceOf(DeliveryDeferred);
  });

  it("makes what a worker wrote inert without changing any code in it", async () => {
    const posted = github();
    await send({
      summary: "Ask @octocat about this. Install with `npm i @scope/pkg`, or mail a@b.co.",
      commit: HEAD,
      comments: [
        { path: "src/a.ts", line: 2, body: "Use this:\n```suggestion\nrm -rf /\n```\nor run:\n```sh\nnpm i @scope/pkg\n```" },
        { path: "odd`name  two spaces.ts", line: 3, body: "cc @some-team/reviewers" },
      ],
    });
    const body: string = posted[0].body.body;
    // In prose a mention is shown as code, where it notifies nobody.
    expect(body).toContain("Ask `@octocat` about this.");
    expect(body).toContain("cc `@some-team/reviewers`");
    // Code is exactly what was written, in a span and in a block; an address is not a mention.
    expect(body).toContain("`npm i @scope/pkg`, or mail a@b.co.");
    const inline: string = posted[0].body.comments[0].body;
    expect(inline).toContain("```sh\nnpm i @scope/pkg\n```");
    expect(inline).toContain("```text\nrm -rf /\n```");
    expect(inline).not.toContain("suggestion");
    expect(JSON.stringify(posted[0].body)).not.toContain("\u200b");
    // A path is shown as it is, whatever it contains.
    expect(body).toContain("`` odd`name  two spaces.ts:3 ``");
    expect(inert("    @indented code stays")).toBe("    @indented code stays");
    // An indented line is code only where Markdown reads it so: after a blank line, and not under a list item.
    expect(inert("text\n\n    @code block\n\n    @still code\n\nand @after")).toBe("text\n\n    @code block\n\n    @still code\n\nand `@after`");
    expect(inert("a paragraph\n    @going on")).toBe("a paragraph\n    `@going` on");
    expect(inert("- item\n\n    @under the item\n1. one\n    @under one")).toBe("- item\n\n    `@under` the item\n1. one\n    `@under` one");
    expect(inert("- item\n\nafter the list\n\n    @code again")).toBe("- item\n\nafter the list\n\n    @code again");
    // Names left as they are: the ones given, however they are cased.
    expect(inert("cc @Ann and @bob", new Set(["ann"]))).toBe("cc @Ann and `@bob`");
    // What a writer mentions themselves: not in code, nor in what they quote.
    expect([...mentionsOf("thanks @Ann\n> @quoted said so\n`@in-span` and\n```\n@fenced\n```\n\n    @indented\n\n- cc @acme/Team")]).toEqual(["ann", "acme/team"]);
  });

  it("shows paths literally in a review posted as a comment too", async () => {
    const posted = github();
    await send({ summary: "See @octocat.", commit: "b".repeat(40), comments: [{ path: "a`b.ts", line: 1, body: "x" }] });
    expect(posted[0].url).toBe("/issues/7/comments");
    expect(posted[0].body.body).toContain("`` a`b.ts:1 ``");
    expect(posted[0].body.body).toContain("See `@octocat`.");
  });

  it("knows its own earlier post by the marker at its end and, where the account is known, by who posted it", () => {
    const body = `text\n\n${MARKER}\n`;
    expect(isOurs({ body, user: { login: "Aoa-Agent[bot]" } }, MARKER, "aoa-agent[bot]")).toBe(true);
    expect(isOurs({ body, user: { login: "someone-else" } }, MARKER, "aoa-agent[bot]")).toBe(false);
    expect(isOurs({ body: `${MARKER} quoted, then more`, user: { login: "aoa-agent[bot]" } }, MARKER, "aoa-agent[bot]")).toBe(false);
    // With a plain token the account is not known: the marker alone decides.
    expect(isOurs({ body, user: { login: "someone-else" } }, MARKER, undefined)).toBe(true);
  });

  it("sends the review as an ordinary comment where the conversation is not a pull request", async () => {
    const posted = github({ pull: 404 });
    expect(await send()).toMatchObject({ subject: "github:comment:99" });
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/issues/7/comments");
    // The same review in words, with no note: there is no commit for it to be out of step with.
    expect(posted[0].body.body.startsWith("Two problems.\n\n` src/a.ts:2 `\non a changed line")).toBe(true);
  });
});
