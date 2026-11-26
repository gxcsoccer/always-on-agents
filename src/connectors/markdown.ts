/**
 * What a piece of Markdown says in prose and what it shows as code, as far as mentions go: which
 * names in it would notify someone, and which only stand there. Used where words go out to a place
 * that notifies (see `inert` in github.ts), and where a chat connector notes which names a person
 * typed themselves.
 */

/**
 * The names a text mentions (@name, @org/team), in lower case, as its writer's own: not in code,
 * and not in what they quote from someone else (lines that begin with ">").
 */
export function mentionsOf(text: string): Set<string> {
  const names = new Set<string>();
  // A quotation is the lines that begin with ">" and, as Markdown reads it, the lines that follow
  // them without a blank line between, whether or not those begin with ">" too.
  let quoted = false;
  const own = text
    .split("\n")
    .map((line) => {
      quoted = /^\s*>/.test(line) || (quoted && line.trim() !== "");
      return quoted ? "" : line;
    })
    .join("\n");
  prose(own, (passage) => passage.replace(MENTION, (match, span, name) => (span ? match : (names.add(String(name).toLowerCase()), match))));
  return names;
}

/** A code span (left alone), or a mention. */
export const MENTION = /(`+)[\s\S]*?\1|(?<![\w.`@/])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?)/g;

/**
 * A text with each passage of prose put through `change`, and its code blocks left as they are.
 * An indented line is code only where Markdown reads it so: after a blank line (or at the start),
 * and not under a list item, where an indented line is the item going on. Where it is not plain
 * which it is, it is taken as prose: a mention that would notify is the thing not to let through.
 */
export function prose(text: string, change: (passage: string) => string): string {
  const out: string[] = [];
  let fence: { char: string; length: number; quoted: boolean } | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    // Code spans may run over several lines; everything between them is prose.
    out.push(change(lines.join("\n")));
    lines = [];
  };
  let before: "start" | "blank" | "code" | "prose" = "start";
  let listed = false;
  for (const line of text.split("\n")) {
    const opener = /^([ \t>]*)(`{3,}|~{3,})(.*)$/.exec(line);
    // A block of code opened inside a quotation ends where the quotation does, closed or not: what follows is prose again.
    if (fence?.quoted && !/^\s*>/.test(line)) fence = undefined;
    if (fence) {
      if (opener && opener[2][0] === fence.char && opener[2].length >= fence.length && opener[3].trim() === "") fence = undefined;
      out.push(line);
      continue;
    }
    if (opener) {
      flush();
      fence = { char: opener[2][0], length: opener[2].length, quoted: opener[1].includes(">") };
      out.push(/^\s*suggestion\b/i.test(opener[3]) ? `${opener[1]}${opener[2]}text` : line);
      before = "prose";
      continue;
    }
    const blank = line.trim() === "";
    const indented = /^( {4}|\t)/.test(line);
    if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line)) listed = true;
    // A list is over once something that is neither part of it nor indented under it follows a blank line.
    else if (!blank && !indented && before === "blank") listed = false;
    if (!blank && indented && !listed && before !== "prose") {
      // Indented far enough to be a code block, where one can begin.
      flush();
      out.push(line);
      before = "code";
      continue;
    }
    lines.push(line);
    // (A blank line between lines of an indented block is part of it.)
    before = blank ? (before === "code" ? "code" : "blank") : "prose";
  }
  flush();
  return out.join("\n");
}
