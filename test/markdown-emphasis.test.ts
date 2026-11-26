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
    ["- 一\n  - **嵌套：**内容", "- 一\n  - **嵌套**：内容"],
    ["- [ ] **待办：**写测试", "- [ ] **待办**：写测试"],
    // Beside emphasis that holds, on its line and over lines: that stays between the same marks.
    ["**甲** 和 **乙：**丙", "**甲** 和 **乙**：丙"],
    ["**第一段\n尾** 之后 **标题：**正文", "**第一段\n尾** 之后 **标题**：正文"],
    // Before and after a block of code that begins at the very start of a line, and ends within three spaces of it.
    ["**前：**文\n\n```ts\nconst a = '**代码：**不动';\n  ```\n\n**后：**文", "**前**：文\n\n```ts\nconst a = '**代码：**不动';\n  ```\n\n**后**：文"],
    ["1. **步骤：**做\n\n~~~\n**代码：**不动\n~~~\n\n2. **结论：**好", "1. **步骤**：做\n\n~~~\n**代码：**不动\n~~~\n\n2. **结论**：好"],
    // Up to a fence that is in something, or further in: what comes before it is mended, and nothing from it on.
    ["**前：**文\n\n- ```\n  code\n  ```\n\n**后：**文", "**前**：文\n\n- ```\n  code\n  ```\n\n**后：**文"],
    ["请看 https://example.com/a?b=1 ，**结论：**通过。", "请看 https://example.com/a?b=1 ，**结论**：通过。"],
    ["**提示：**字😀", "**提示**：字😀"],
    ["😀字**（注）**", "😀字（**注**）"],
    ["**见[文[档]](https://example.com/a_(b))：**正文", "**见[文[档]](https://example.com/a_(b))**：正文"],
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
    // A backslash within code escapes nothing: the span ends at its backtick, and the next one is another span.
    "路径 `C:\\` 和 `**配置：**D:\\`",
    // A longer run of backticks within a span does not close it.
    "``a```**标题：**正文``",
    "```a`` **标题：**正文 ``b```",
    "\\`**标题：**正文`",
    // An escaped character right against a mark is not looked into.
    "\\\\**结论：**通过",
    "> ```\n> **标题：**正文\n> 仍在引用里",
    "``a ` **小标题：**正文``",
    "```\n**小标题：**正文\n```",
    "~~~md\n**小标题：**正文\n~~~",
    "说明\n\n    **小标题：**正文",
    "> ```\n> **小标题：**正文\n> ```",
    "\\*\\*小标题：\\*\\*正文",
    "[**小标题：**正文](https://example.com)",
    "**小标题：**`code`",
    "`code`**：注**",
    "**标题：**https://example.com",
    // Not plainly this case: one mark alone, other emphasis beside or within it, half of a pair, a span that does not close, whitespace inside.
    // Emphasis that holds because what stands outside it is a symbol, though written with two units.
    "**提示：**😀",
    "😀**（注）**",
    // Code that runs over lines, or stands indented under a list item; a link defined elsewhere, or whose ends are not plain.
    "`一行\n**标题：**正文\n三行`",
    "- 项\n\n      **标题：**正文",
    "- 一\n    - **嵌套：**内容",
    "\t**标题：**正文",
    // A fence on the line of a list item's mark, or of a quotation's; a link whose address or title holds a closing bracket.
    "- ~~~text\n  **标题：**正文\n  ~~~",
    "- ```\n  **标题：**正文\n  ```",
    "1. > ~~~\n   > **标题：**正文\n   > ~~~",
    "[文档](<guide)/**标题：**正文>)",
    "[文档](/guide \"题)**标题：**正文\")",
    "[文档](/guide '题)**标题：**正文')，**后面：**也不动",
    // Within a block of code, a line that only looks like the fence that would end it: a list item's, one further in, a shorter one, one of the other kind.
    "~~~md\n- ~~~\n**标题：**正文\n~~~",
    "~~~md\n    ~~~\n**标题：**正文\n~~~",
    "  ~~~md\n    ~~~\n**标题：**正文\n  ~~~",
    "   ~~~md\n    ~~~\n**标题：**正文\n~~~",
    "-   ~~~\n  ~~~\n    **标题：**正文\n    ~~~",
    "- ~~~\n      ~~~\n  **标题：**正文\n  ~~~",
    "> ~~~\n>      ~~~\n> **标题：**正文\n> ~~~",
    "  > ~~~md\n>     ~~~\n> **标题：**正文\n> ~~~",
    "1. > ~~~\n   > ~~~\n   > **标题：**正文",
    "````md\n```\n**标题：**正文\n````",
    "~~~md\n```\n**标题：**正文\n~~~",
    "~~~md\n> ~~~\n**标题：**正文\n~~~",
    "- ~~~\n  code\n~~~\n**标题：**正文",
    // A bare address with words right against it: where it ends is not ours to say.
    "https://example.com/文档/**标题：**正文",
    "请看 https://example.com/a?b=1，**结论：**通过。",
    "www.example.com/文档/**标题：**正文",
    // From a fence that is in something, or further in, nothing is touched, whether or not it seems to end.
    "1. 示例\n\n    ```\n    第一段\n    ```\n\n```\n**标题：**正文\n```",
    "- 项\n\n   ```\n   code\n```\n**标题：**正文\n```",
    ">~~~text\n>code\n>~~~\n\n**结论：**通过",
    "- ```\n  code\n  ```\n- **结论：**通过",
    "  ~~~\ncode\n ~~~\n**结论：**通过",
    "  > ~~~md\n>    ~~~\n> **标题：**正文",
    "> ```\n> code\n\n**结论：**通过",
    // Nor from a line that begins as markup of another kind may, within which a fence is no fence.
    "<pre>\n```\n</pre>\n**标题：**正文\n```",
    "<details>\n**标题：**正文",
    // Lines ended with a carriage return; markup of another kind within a quotation, or within a line.
    "~~~md\r\n**标题：**正文\r\n~~~\r\n",
    "> <pre>\n> **标题：**正文\n> </pre>",
    "参见 <a title=\"A > B\" href=\"/文档/**标题：**正文\">手册</a>",
    // An address of another kind, and one with a space that is no plain space in it.
    "ftp://example.com/资料/**标题：**正文",
    "https://example.com/资料\u00a0**标题：**正文",
    "mailto:a@example.com?subject=**标题：**正文",
    // Emphasis that runs over lines and holds: the marks on one line belong to two of them.
    "**第一段\n尾**（旁注）**新段\n结束**",
    // Words struck through in the same paragraph: their marks are paired along with these.
    "~~旧的~~ **标题：**正文",
    // Mending one would undo emphasis that holds between other marks.
    "正文**：注**后文**尾**",
    "[r]: /guide/**标题：**正文",
    "[r]: </guide/**标题：**正文> \"**题：**文\"",
    "见[**标题：**正文][r]",
    "见[文[档[深]]](https://example.com)，**标题：**正文",
    "[**标题：**正文]",
    "![图](https://example.com/a.png \"**题：**文\")",
    "<a href=\"/**标题：**正文\">x</a>",
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
    const text = ["# 结果", "", "**结论：**通过。", "", "```ts", "const a = '**结论：**x';", "```", "", "> **引用：**原话", "", "1. **第一：**甲", "", "    **续行：**乙", "", "末段有`未闭合的代码", "**这段：**不动"].join("\n");
    expect(emphasised(text)).toBe(["# 结果", "", "**结论**：通过。", "", "```ts", "const a = '**结论：**x';", "```", "", "> **引用**：原话", "", "1. **第一**：甲", "", "    **续行：**乙", "", "末段有`未闭合的代码", "**这段：**不动"].join("\n"));
  });
});
