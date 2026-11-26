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
  // Paragraph by paragraph: a code span or a link may run over the lines of one, and never past a blank line.
  const out: string[] = [];
  let fence: { char: string; length: number; quoted: boolean } | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) out.push(paragraph(lines.join("\n")));
    lines = [];
  };
  for (const line of text.split("\n")) {
    // A fence wherever one may stand: at the start of a line, or after the marks of quotations and of list items on it,
    // however far in. (Taken more widely than Markdown takes it: what is between two of them is left as it is.)
    const fenced = /^(?:\s*(?:>|[-*+]|\d{1,9}[.)])(?=\s|$))*\s*(`{3,}|~{3,})(.*)$/.exec(line);
    // A block of code opened inside a quotation ends where the quotation does, closed or not: what follows a blank line after it is prose again.
    if (fence?.quoted && line.trim() === "") fence = undefined;
    if (fence) {
      if (fenced && fenced[1][0] === fence.char && fenced[1].length >= fence.length && fenced[2].trim() === "") fence = undefined;
      out.push(line);
    } else if (fenced && !(fenced[1][0] === "`" && fenced[2].includes("`"))) {
      flush();
      fence = { char: fenced[1][0], length: fenced[1].length, quoted: /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)*>/.test(line) };
      out.push(line);
    } else if (line.trim() === "") {
      flush();
      out.push(line);
    } else lines.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * A paragraph with its code spans and its escaped characters hidden, read from left to right as
 * Markdown reads them: a run of backticks opens a span that the next run of exactly as many
 * closes, and nothing within it is an escape; outside one, a backslash takes the character after
 * it. A run that nothing closes is left showing.
 */
function uncoded(text: string): string {
  let out = "";
  for (let at = 0; at < text.length; ) {
    if (text[at] === "`") {
      let run = at;
      while (text[run] === "`") run++;
      const length = run - at;
      // The next run of backticks of the very same length.
      let close = -1;
      for (let next = run; next < text.length; ) {
        if (text[next] !== "`") {
          next++;
          continue;
        }
        let end = next;
        while (text[end] === "`") end++;
        if (end - next === length) {
          close = end;
          break;
        }
        next = end;
      }
      const upTo = close === -1 ? run : close;
      out += close === -1 ? text.slice(at, run) : text.slice(at, upTo).replace(/[^\n]/g, HIDDEN);
      at = upTo;
    } else if (text[at] === "\\" && at + 1 < text.length && text[at + 1] !== "\n") {
      // (A whole character, where it is written with two units.)
      const taken = String.fromCodePoint(text.codePointAt(at + 1)!).length;
      out += HIDDEN.repeat(1 + taken);
      at += 1 + taken;
    } else out += text[at++];
  }
  return out;
}

/** One paragraph, with each `**…**` in it that certainly did not hold made to; left whole where what in it is code or a link is not plain. */
function paragraph(text: string): string {
  // What is not prose keeps its place and is not looked into.
  const hide = (found: string) => found.replace(/[^\n]/g, HIDDEN);
  const seen = uncoded(text)
    // A link or a picture with where it leads, where its ends are plain: brackets within its words one deep, and an address
    // written bare (no angle brackets, no title, no space), with brackets one deep. Any other is left showing its brackets.
    .replace(/!?\[(?:[^\[\]]|\[[^\[\]]*\])*\]\((?:[^()\s<>"']|\([^()\s<>"']*\))*\)/g, hide)
    .replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[[ xX]\](?=\s)/gm, (found, lead: string) => lead + HIDDEN.repeat(found.length - lead.length))
    // (A bare address ends where the characters an address is written with end: words written right after it, with no space, are not part of it.)
    .replace(/<\/?[A-Za-z][^>]*>|<[^>\s]+>|https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+/g, hide);
  // A backtick left over is a code span whose end is not on hand; a bracket left over, a link whose
  // words, name or address (given here or defined elsewhere) cannot be told apart from prose. Left whole.
  if (/[`\[\]]/.test(seen)) return text;
  const lines = text.split("\n");
  const seenLines = seen.split("\n");
  // A line indented far enough to be code somewhere (under a list item it may be) is left as it is.
  return lines.map((line, n) => (/^(?: {0,3}> ?)*(?: {4}|\t| {0,3}\t)/.test(line) ? line : strong(line, seenLines[n]))).join("\n");
}

/** One line of prose (and the same line with what is not prose hidden), with each `**…**` in it that certainly did not hold made to. */
function strong(line: string, seen: string): string {
  // The marks: two asterisks by themselves, taken two by two. An odd number of them, or any other asterisk on the line, or
  // an underscore that could be a mark (emphasis within emphasis, or beside it), and it is not plainly this case. (An
  // underscore within a word, as in a name written with them, is no mark.)
  const marks = [...seen.matchAll(/(?<![*_])\*\*(?![*_])/g)].map((each) => each.index);
  if (marks.length === 0 || marks.length % 2 === 1 || /\*|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/.test(seen.replace(/(?<![*_])\*\*(?![*_])/g, ""))) return line;
  let out = "";
  let from = 0;
  for (let n = 0; n < marks.length; n += 2) {
    const [open, close] = [marks[n], marks[n + 1]];
    // (What stands just outside each mark, as a whole character: one written with two units is one.)
    const left = [...seen.slice(0, open)].at(-1);
    const right = [...seen.slice(close + 2)][0];
    out += line.slice(from, open) + mended(line.slice(open + 2, close), seen.slice(open + 2, close), left, right);
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
