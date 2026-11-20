import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commentableLines, githubConnector } from "../src/connectors/github";
import type { CodeReview } from "../src/connectors/types";
import type { Env } from "../src/env";

const HEAD = "a".repeat(40);
const PATCH = ["@@ -1,3 +1,4 @@", " one", "-two", "+TWO", "+two and a half", " three", "@@ -10,2 +11,2 @@", " ten", "+eleven"].join("\n");

/** Stands in for GitHub's API for one pull request, and records what was posted. */
function github(options: { pull?: number; reviews?: { id: number; body: string }[]; refuseInline?: boolean } = {}) {
  const posted: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.replace("https://api.github.com/repos/acme/demo", "").split("?")[0];
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push({ url: path, body });
      if (path === "/pulls/7/reviews" && options.refuseInline && body.comments.length > 0) return Response.json({ message: "Unprocessable" }, { status: 422 });
      return Response.json({ id: 99, body: body.body });
    }
    if (path === "/pulls/7") return options.pull === 404 ? Response.json({}, { status: 404 }) : Response.json({ head: { sha: HEAD } });
    if (path === "/pulls/7/reviews") return Response.json(options.reviews ?? []);
    if (path === "/pulls/7/files") return Response.json([{ filename: "src/a.ts", patch: PATCH }, { filename: "logo.png" }]);
    if (path === "/issues/7/comments") return Response.json([]);
    throw new Error(`unexpected request to ${url}`);
  });
  return posted;
}

const review: CodeReview = {
  summary: "Two problems.",
  commit: HEAD,
  comments: [
    { path: "src/a.ts", line: 2, body: "on a changed line" },
    { path: "src/a.ts", line: 7, body: "on a line the change does not show" },
    { path: "src/b.ts", line: 1, body: "in a file the change does not touch" },
  ],
};
const send = (r: CodeReview = review) =>
  githubConnector.channel!.deliver(env as unknown as Env, { tenant: "t", kind: "repo", id: "acme/demo" }, { connector: "github", address: { repo: "acme/demo", number: "7" } }, {
    id: 1,
    idem: "msg:call_1",
    text: "the review in words",
    review: r,
  });

afterEach(() => vi.unstubAllGlobals());

describe("a code review on GitHub", () => {
  it("knows which lines of a change a comment can be attached to", () => {
    const lines = commentableLines([{ filename: "src/a.ts", patch: PATCH }, { filename: "logo.png" }]);
    // Added and context lines, numbered as in the new file; a removed line has no number there.
    expect([...lines.get("src/a.ts")!]).toEqual([1, 2, 3, 4, 11, 12]);
    expect(lines.has("logo.png")).toBe(false);
  });

  it("puts each comment on its line, keeps the others in the body, and only comments", async () => {
    const posted = github();
    const receipt = await send();
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/pulls/7/reviews");
    expect(posted[0].body).toMatchObject({ commit_id: HEAD, event: "COMMENT", comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "on a changed line" }] });
    expect(posted[0].body.body).toContain("Two problems.");
    expect(posted[0].body.body).toContain("`src/a.ts:7`");
    expect(posted[0].body.body).toContain("`src/b.ts:1`");
    expect(posted[0].body.body).not.toContain("on a changed line");
    expect(receipt).toMatchObject({ subject: "github:review:99" });
  });

  it("does not post the same review twice when an earlier attempt got through", async () => {
    const posted = github({ reviews: [{ id: 41, body: "Two problems.\n\n<!-- always-on-agent:msg:call_1 -->" }] });
    expect(await send()).toMatchObject({ subject: "github:review:41" });
    expect(posted).toHaveLength(0);
  });

  it("attaches nothing to lines when the pull request has moved on from the commit that was reviewed", async () => {
    const posted = github();
    await send({ ...review, commit: "b".repeat(40) });
    expect(posted[0].body.comments).toEqual([]);
    expect(posted[0].body.body).toContain("has moved to aaaaaaa");
    expect(posted[0].body.body).toContain("on a changed line");
  });

  it("sends the whole review in the body when GitHub refuses the lines", async () => {
    const posted = github({ refuseInline: true });
    await send();
    expect(posted).toHaveLength(2);
    expect(posted[1].body.comments).toEqual([]);
    expect(posted[1].body.body).toContain("on a changed line");
  });

  it("sends the review as an ordinary comment where the conversation is not a pull request", async () => {
    const posted = github({ pull: 404 });
    expect(await send()).toMatchObject({ subject: "github:comment:99" });
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/issues/7/comments");
    expect(posted[0].body.body).toContain("the review in words");
  });
});
