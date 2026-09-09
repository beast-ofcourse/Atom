// Transcript markdown tests: assistant turns render structure (headings,
// lists, code, links, quotes) without leaking raw markers, plain text
// paints back verbatim, and intra-word emphasis never fires.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { MarkdownStream, MarkdownText, ToolLine, closeStreamingMarkers, parseInline, parseMarkdown } from "../src/ui/markdown.js";
import { renderTranscriptItem, type StaticItem } from "../src/ui/transcript.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("parseInline", () => {
  test("bold/italic/code/link runs, markers consumed", () => {
    const runs = parseInline("a **b** c *i* d `e` f [g](http://h) end");
    expect(runs).toEqual([
      { kind: "text", text: "a " },
      { kind: "text", text: "b", bold: true, italic: undefined, strike: undefined },
      { kind: "text", text: " c " },
      { kind: "text", text: "i", bold: undefined, italic: true, strike: undefined },
      { kind: "text", text: " d " },
      { kind: "code", text: "e" },
      { kind: "text", text: " f " },
      { kind: "link", text: "g", url: "http://h" },
      { kind: "text", text: " end" },
    ]);
  });
  test("intra-word markers stay literal", () => {
    expect(parseInline("my_var_name")).toEqual([{ kind: "text", text: "my_var_name" }]);
    expect(parseInline("2*3*4")).toEqual([{ kind: "text", text: "2*3*4" }]);
  });
  test("code spans protect formatting chars", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });
});

describe("parseMarkdown", () => {
  test("heading/list/code/quote blocks", () => {
    const blocks = parseMarkdown("## Title\n\n- a\n- b\n\n```ts\nx()\n```\n\n> cited");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "code", "quote"]);
    const code = blocks[2];
    expect(code.kind === "code" && code.lang).toBe("ts");
  });
  test("unclosed fence runs to end", () => {
    const blocks = parseMarkdown("```py\nprint(1)");
    expect(blocks.map((b) => b.kind)).toEqual(["code"]);
  });
  test("plain text is one paragraph", () => {
    expect(parseMarkdown("just words")).toEqual([
      { kind: "paragraph", runs: [{ kind: "text", text: "just words" }] },
    ]);
  });
});

describe("MarkdownText", () => {
  test("markers never leak, text preserved", () => {
    const frame = frameOf(
      <MarkdownText text={"## Head\n\n- **bold** item\n\n```ts\ncode()\n```\n\nSee [docs](http://x)."} />
    );
    expect(frame).toContain("Head");
    expect(frame).toContain("bold");
    expect(frame).toContain("item");
    expect(frame).toContain("code()");
    expect(frame).toContain("ts");
    expect(frame).toContain("docs");
    expect(frame).toContain("http://x");
    expect(frame).not.toContain("##");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("```");
    expect(frame).not.toContain("[docs]");
  });
  test("plain text paints back verbatim", () => {
    const frame = frameOf(<MarkdownText text="hello back, plain and simple" />);
    expect(frame).toContain("hello back, plain and simple");
  });
});

describe("transcript assistant/tool turns", () => {
  test("assistant renders markdown with speaker label", () => {
    const item: StaticItem = {
      id: "turn-0",
      turn: { role: "assistant", content: "# T\n\n- a\n\n`x`" },
    };
    const frame = frameOf(renderTranscriptItem(item) as React.ReactNode);
    expect(frame).toContain("ATOM>");
    expect(frame).toContain("a");
    expect(frame).toContain("x");
    expect(frame).not.toContain("# T");
  });
  test("user turn stays inline verbatim", () => {
    const item: StaticItem = {
      id: "turn-0",
      turn: { role: "user", content: "do the thing - now" },
    };
    const frame = frameOf(renderTranscriptItem(item) as React.ReactNode);
    expect(frame).toContain("you>");
    expect(frame).toContain("do the thing - now");
  });
  test("tool error paints, audit line preserved", () => {
    const err = frameOf(<ToolLine content="Error: boom" error />);
    expect(err).toContain("Error: boom");
    const ok = frameOf(<ToolLine content="⚙ write ok" />);
    expect(ok).toContain("⚙ write ok");
  });
});

describe("markdown/code rendering pass (TUI chunk 17)", () => {
  const realistic = [
    "# Refactor the authentication system",
    "",
    "Done. Summary of the changes:",
    "",
    "- Added `getSession` with **retry** and *backoff*",
    "  continued: retries 3 times before surfacing `AuthError`",
    "  - nested: token refresh runs first",
    "    - deeply nested: clock-skew guard",
    "- [ ] add comprehensive tests",
    "- [x] update session docs",
    "",
    "1. First run the migration",
    "2. Then verify with the suite",
    "",
    "```ts",
    "export async function getSession(id: string): Promise<Session> {",
    "  const s = await store.load(id); // indented body",
    "  if (!s) throw new AuthError(\"missing\");",
    "  return s;",
    "}",
    "```",
    "",
    "```json",
    '{ "user": "ada", "roles": ["admin", "dev"] }',
    "```",
    "",
    "```sh",
    "pnpm test --filter auth",
    "```",
    "",
    "| File | Purpose | Lines |",
    "| --- | --- | --- |",
    "| src/auth/session.ts | session load + refresh | 120 |",
    "| tests/auth.test.ts | regression suite | 80 |",
    "",
    "See [auth docs](http://example.com/auth) for details.",
  ].join("\n");

  test("realistic agent response renders with no marker leakage", () => {
    const frame = frameOf(<MarkdownText text={realistic} />);
    expect(frame).toContain("Refactor the authentication system");
    expect(frame).toContain("getSession");
    expect(frame).toContain("retry");
    expect(frame).toContain("continued: retries 3 times");
    expect(frame).toContain("token refresh runs first");
    expect(frame).toContain("clock-skew guard");
    expect(frame).toContain("First run the migration");
    expect(frame).toContain("session load + refresh");
    expect(frame).toContain("auth docs");
    expect(frame).toContain("http://example.com/auth");
    expect(frame).toContain("│");
    expect(frame).not.toContain("##");
    expect(frame).not.toContain("```");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("[auth docs]");
    expect(frame).not.toContain("| --- |");
  });

  test("nested list indents, task boxes render", () => {
    const blocks = parseMarkdown("- a\n  - b\n    - c\n\n- [ ] todo\n- [x] done");
    expect(blocks[0]?.kind).toBe("list");
    expect(blocks[1]?.kind).toBe("list");
    if (blocks[0]?.kind === "list") {
      expect(blocks[0].items.map((it) => it.indent)).toEqual([0, 1, 2]);
    }
    if (blocks[1]?.kind === "list") {
      expect(blocks[1].items[0]?.marker).toContain("☐");
      expect(blocks[1].items[1]?.marker).toContain("☑");
    }
  });

  test("code blocks preserve indentation and handle long lines", () => {
    const longLine = `const x = "${"y".repeat(300)}";`;
    const frame = frameOf(<MarkdownText text={"```ts\n  indented();\n" + longLine + "\n```"} />);
    expect(frame).toContain("indented();");
    expect(frame).toContain("const x =");
    expect(frame).not.toContain("```");
  });

  test("tilde and unclosed fences render without leaking", () => {
    const tilde = frameOf(<MarkdownText text={"~~~sh\necho hi\n~~~"} />);
    expect(tilde).toContain("echo hi");
    expect(tilde).not.toContain("~~~");
    const unclosed = frameOf(<MarkdownText text={"```py\nprint(1)"} />);
    expect(unclosed).toContain("print(1)");
    expect(unclosed).not.toContain("```");
  });

  test("malformed table stays a paragraph, long cells truncate", () => {
    const noDelim = parseMarkdown("| a | b |\n| just text |");
    expect(noDelim.every((b) => b.kind === "paragraph")).toBe(true);
    const longCell = `| Name | Notes |\n| --- | --- |\n| bob | ${"n".repeat(200)} |`;
    const frame = frameOf(<MarkdownText text={longCell} />);
    expect(frame).toContain("bob");
    expect(frame).toContain("…");
  });

  test("streaming partials never leak markers", () => {
    expect(closeStreamingMarkers("done **half")).toBe("done **half**");
    expect(closeStreamingMarkers("done *half")).toBe("done *half*");
    expect(closeStreamingMarkers("done ~~half")).toBe("done ~~half~~");
    expect(closeStreamingMarkers("See [docs](http://x")).toBe("See [docs](http://x)");
    for (const partial of ["done **half", "done *half", "done __half", "done _half", "done ~~half", "run `cmd", "See [docs](http://x"]) {
      const frame = frameOf(<MarkdownStream text={partial} />);
      expect(frame).not.toContain("**");
      expect(frame).not.toContain("~~");
      expect(frame).not.toContain("[docs]");
    }
    expect(closeStreamingMarkers("my_var")).toBe("my_var");
    expect(closeStreamingMarkers("2*3*4")).toBe("2*3*4");
  });
});
