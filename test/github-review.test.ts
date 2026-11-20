import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commentableLines, githubConnector, inert, literal } from "../src/connectors/github";
import type { CodeReview } from "../src/connectors/types";
import type { Env } from "../src/env";

const HEAD = "a".repeat(40);
const PATCH = ["@@ -1,3 +1,4 @@", " one", "-two", "+TWO", "+two and a half", " three", "@@ -10,2 +11,2 @@", " ten", "+eleven"].join("\n");

/** Stands in for GitHub's API for one pull request, and records what was posted. */
function github(options: { pull?: number; reviews?: any[]; pages?: number; refuse?: unknown } = {}) {
  const posted: { url: string; body: any }[] = [];
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.replace("https://api.github.com/repos/acme/demo", "").split("?")[0];
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push({ url: path, body });
      if (path === "/pulls/7/reviews" && options.refuse && body.comments.length > 0) return Response.json(options.refuse, { status: 422 });
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
      return Response.json(batch, { headers: pages > 1 ? { link: `<https://api.github.com/x?per_page=100&page=${pages}>; rel="last"` } : {} });
    }
    if (path === "/pulls/7/files") return Response.json([{ filename: "src/a.ts", patch: PATCH }, { filename: "logo.png" }]);
    if (path === "/issues/7/comments") return Response.json([]);
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
    expect(posted[0].body.body).toContain("the review in words");
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

  it("makes what a worker wrote inert: no one is notified and no change is offered", async () => {
    const posted = github();
    await send({
      summary: "Ask @octocat about this.",
      commit: HEAD,
      comments: [
        { path: "src/a.ts", line: 2, body: "Use this:\n```suggestion\nrm -rf /\n```" },
        { path: "odd`name.ts", line: 3, body: "cc @someone" },
      ],
    });
    const sent = JSON.stringify(posted[0].body);
    expect(sent).not.toMatch(/@octocat|@someone/);
    expect(sent).not.toContain("```suggestion");
    expect(inert("email a@b.co, @x")).toBe("email a@\u200bb.co, @\u200bx");
    // A path is shown as it is, whatever it contains.
    expect(posted[0].body.body).toContain(literal("odd`name.ts:3"));
    expect(literal("odd`name.ts")).toBe("`` odd`name.ts ``");
  });

  it("sends the review as an ordinary comment where the conversation is not a pull request", async () => {
    const posted = github({ pull: 404 });
    expect(await send()).toMatchObject({ subject: "github:comment:99" });
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/issues/7/comments");
    expect(posted[0].body.body).toContain("the review in words");
  });
});
