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
    // A fence as Markdown reads one: indented by no more than three spaces (after the marks of a
    // quotation, if it is in one), and, where it is of backticks, with no backtick in what
    // follows it on the line. Anything else that looks like one is prose, and what comes after
    // it is prose: read as a fence it would hide a mention that notifies.
    const fenced = /^((?: {0,3}> ?)* {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    const opener = fenced && !(fenced[2][0] === "`" && fenced[3].includes("`")) ? fenced : null;
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

/** Punctuation and whitespace as Markdown's rule for emphasis takes them (the start and the end of a line count as whitespace). */
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
/** Full-width punctuation: what is written right against the words in Chinese and Japanese, with no space after it. */
const WIDE = /[、-〿！-／：-＠［-｀｛-･‘’“”…—]/;
/** Marks that come in pairs: one of them is never moved without the other. */
const PAIRS: Record<string, string> = { "（": "）", "「": "」", "『": "』", "【": "】", "《": "》", "〈": "〉", "〔": "〕", "［": "］", "｛": "｝", "“": "”", "‘": "’" };
const OPENERS = Object.keys(PAIRS);
const CLOSERS = Object.values(PAIRS);
/** Stands in a line for what is not to be read as prose (code, a link, an escaped character), so that places in it stay where they are. */
const HIDDEN = "";

/**
 * A text with its strong emphasis (`**…**`) made to hold where it certainly did not: where
 * full-width punctuation stands just inside a mark and a word just outside it, which by
 * Markdown's rule makes the mark no mark at all (`**标题：**正文` is shown with its asterisks).
 * The punctuation is moved to the other side of the mark (`**标题**：正文`), and with a bracket or
 * a quotation mark its other half, where that is at the other end. Nothing else is changed:
 * emphasis that holds already, code, links, escaped characters, single asterisks, and anything
 * that is not plainly this case. The words read the same before and after; doing it twice
 * changes nothing more.
 */
export function emphasised(text: string): string {
  let fence: { char: string; length: number } | undefined;
  let before: "start" | "blank" | "code" | "prose" = "start";
  let listed = false;
  return text
    .split("\n")
    .map((line) => {
      const fenced = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (fenced && fenced[1][0] === fence.char && fenced[1].length >= fence.length && fenced[2].trim() === "") fence = undefined;
        return line;
      }
      if (fenced && !(fenced[1][0] === "`" && fenced[2].includes("`"))) {
        fence = { char: fenced[1][0], length: fenced[1].length };
        before = "prose";
        return line;
      }
      // (An indented line is code where Markdown reads it so, as in `prose` above; here what is not plainly prose is left alone.)
      const blank = line.trim() === "";
      const indented = /^( {4}|\t)/.test(line);
      if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line)) listed = true;
      else if (!blank && !indented && before === "blank") listed = false;
      if (!blank && indented && !listed && before !== "prose") {
        before = "code";
        return line;
      }
      before = blank ? (before === "code" ? "code" : "blank") : "prose";
      return blank ? line : strong(line);
    })
    .join("\n");
}

/** One line of prose, with each `**…**` in it that certainly did not hold made to. */
function strong(line: string): string {
  // What is not prose keeps its place and is not looked into. A code span that does not close on
  // this line may run on to another: where it ends is not plain, and the line is left alone.
  const hide = (found: string) => HIDDEN.repeat(found.length);
  const seen = line
    .replace(/\\[\s\S]/g, hide)
    .replace(/(`+)(?:(?!\1(?!`))[\s\S])*?\1(?!`)/g, hide)
    .replace(/!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/\S+/g, hide);
  if (seen.includes("`")) return line;
  // The marks: two asterisks by themselves, taken two by two. An odd number of them, or any other asterisk on the line, or
  // an underscore that could be a mark (emphasis within emphasis, or beside it), and it is not plainly this case. (An
  // underscore within a word, as in a name written with them, is no mark.)
  const marks = [...seen.matchAll(/(?<![*_])\*\*(?![*_])/g)].map((each) => each.index);
  if (marks.length === 0 || marks.length % 2 === 1 || /\*|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/.test(seen.replace(/(?<![*_])\*\*(?![*_])/g, ""))) return line;
  let out = "";
  let from = 0;
  for (let n = 0; n < marks.length; n += 2) {
    const [open, close] = [marks[n], marks[n + 1]];
    out += line.slice(from, open) + mended(line.slice(open + 2, close), seen.slice(open + 2, close), seen[open - 1], seen[close + 2]);
    from = close + 2;
  }
  return out + line.slice(from);
}

/** Whether a mark opens (with `inner` just inside it and `outer` just outside), or closes, by Markdown's rule; the edge of the line is whitespace. */
const holds = (inner: string | undefined, outer: string | undefined): boolean =>
  inner !== undefined && !SPACE.test(inner) && (!PUNCT.test(inner) || outer === undefined || SPACE.test(outer) || PUNCT.test(outer));

/** What stands between two marks, with the marks (and what was moved outside them): as it was, unless it is plainly the case that is mended. */
function mended(inside: string, seen: string, left: string | undefined, right: string | undefined): string {
  const asWas = `**${inside}**`;
  const chars = [...inside];
  const shown = [...seen];
  // (Code or a link right against a mark, inside or out: not looked into, so not plain.)
  if (chars.length !== shown.length || chars.length === 0 || [left, right, shown[0], shown.at(-1)].includes(HIDDEN)) return asWas;
  const opens = holds(shown[0], left);
  const closes = holds(shown.at(-1), right);
  if (opens && closes) return asWas;
  // Only this: a mark with full-width punctuation just inside it and a word just outside. (Whitespace inside a mark is something else.)
  if (SPACE.test(shown[0]) || SPACE.test(shown.at(-1)!)) return asWas;
  if ((!opens && !WIDE.test(shown[0])) || (!closes && !WIDE.test(shown.at(-1)!))) return asWas;
  const [first, last] = [chars[0], chars.at(-1)!];
  const paired = PAIRS[first] === last && chars.length > 2;
  let [lead, body, trail] = ["", chars, ""];
  if (paired) [lead, body, trail] = [first, chars.slice(1, -1), last];
  else if (OPENERS.includes(first) || CLOSERS.includes(first) || OPENERS.includes(last) || CLOSERS.includes(last)) {
    // Half of a pair at one end, its other half not at the other: moving it would leave the pair half in, half out. But a
    // mark that is no half of anything may still be moved at the other end, where the half stays inside and holds as it is.
    if (!opens && (OPENERS.includes(first) || CLOSERS.includes(first))) return asWas;
    if (!closes && (OPENERS.includes(last) || CLOSERS.includes(last))) return asWas;
    if (!opens) [lead, body] = [first, chars.slice(1)];
    if (!closes) [body, trail] = [body.slice(0, -1), last];
  } else {
    if (!opens) [lead, body] = [first, chars.slice(1)];
    if (!closes) [body, trail] = [body.slice(0, -1), last];
  }
  // Marks that come in pairs: within what is emphasised now each has its other half, or it is not plain what was meant.
  const depth: string[] = [];
  for (const each of body) {
    if (OPENERS.includes(each)) depth.push(PAIRS[each]);
    else if (CLOSERS.includes(each) && depth.pop() !== each) return asWas;
  }
  if (depth.length > 0) return asWas;
  // As mended, both marks hold; otherwise it is left as it was.
  if (body.length === 0 || !holds(body[0], lead || left) || !holds(body.at(-1), trail || right)) return asWas;
  return `${lead}**${body.join("")}**${trail}`;
}
