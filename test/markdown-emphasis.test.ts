import { describe, expect, it } from "vitest";
import { emphasised } from "../src/connectors/markdown";

/** The words of a text as they are read, with the marks of strong emphasis taken out. */
const read = (text: string) => text.replaceAll("**", "");

describe("strong emphasis made to hold where full-width punctuation kept it from holding", () => {
  const mends: [string, string][] = [
    ["**小标题：**正文", "**小标题**：正文"],
    ["- **结论：**可以合入", "- **结论**：可以合入"],
    ["正文**（注）**", "正文（**注**）"],
    ["**（注）**正文", "（**注**）正文"],
    ["他说**“可以”**吗", "他说“**可以**”吗"],
    ["正文**：注**", "正文：**注**"],
    ["**原因：**甲。**结果：**乙。", "**原因**：甲。**结果**：乙。"],
    ["| **状态：**好 | 别的 |", "| **状态**：好 | 别的 |"],
    ["- 一\n    - **嵌套：**内容", "- 一\n    - **嵌套**：内容"],
    ["**见[文档](https://example.com/a_b)：**正文", "**见[文档](https://example.com/a_b)**：正文"],
    ["**（见注）。**正文", "**（见注）**。正文"],
    ["**小标题：**正文 snake_case", "**小标题**：正文 snake_case"],
  ];
  for (const [given, wanted] of mends)
    it(`mends ${given}`, () => {
      expect(emphasised(given)).toBe(wanted);
      // The words read the same; done again, nothing more changes.
      expect(read(wanted)).toBe(read(given));
      expect(emphasised(wanted)).toBe(wanted);
    });

  const kept = [
    // Emphasis that holds already.
    "**提示：** 下一步",
    "**标题**：正文",
    "**标题：**",
    "**标题：**，然后",
    "正文 **（注）**",
    "**bold:**text",
    "plain **bold** text",
    // Code, in a span or a block; an escaped mark; a link.
    "`**小标题：**正文`",
    "``a ` **小标题：**正文``",
    "```\n**小标题：**正文\n```",
    "~~~md\n**小标题：**正文\n~~~",
    "说明\n\n    **小标题：**正文",
    "\\*\\*小标题：\\*\\*正文",
    "[**小标题：**正文](https://example.com)",
    "**小标题：**`code`",
    "`code`**：注**",
    "**标题：**https://example.com",
    // Not plainly this case: one mark alone, other emphasis beside or within it, half of a pair, a span that does not close, whitespace inside.
    "**小标题：正文",
    "**小标题：***斜体*",
    "***小标题：***正文",
    "**小标题：**正文 *别的*",
    "**小标题：**正文 _斜体_",
    "**小标题：**正文 __粗体__",
    "**（注**正文",
    "**注）**正文",
    "**（甲）和（乙）**正文",
    "正文**（注**）",
    "**小标题： **正文",
    "**小标题：**正文 `未闭合",
    "****",
    "",
  ];
  for (const text of kept) it(`leaves ${JSON.stringify(text)} as it is`, () => expect(emphasised(text)).toBe(text));

  it("mends each line by itself, and leaves the rest of a text as it is", () => {
    const text = ["# 结果", "", "**结论：**通过。", "", "```ts", "const a = '**结论：**x';", "```", "", "> **引用：**原话", "", "1. **第一：**甲", "", "    **续行：**乙"].join("\n");
    expect(emphasised(text)).toBe(["# 结果", "", "**结论**：通过。", "", "```ts", "const a = '**结论：**x';", "```", "", "> **引用**：原话", "", "1. **第一**：甲", "", "    **续行**：乙"].join("\n"));
  });
});
