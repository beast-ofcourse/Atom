// Phase 3: tool widgets render as bordered boxes with status chrome,
// shared summary, capped preview, and byte-identical audit lines.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { LiveToolCall, ToolCall } from "../src/ui/components/ToolCall.js";
import { borderColorFor, TOOL_PREVIEW_CHARS, TOOL_PREVIEW_LINES } from "../src/ui/tool-model.js";
import { theme } from "../src/ui/theme.js";
import type { Turn } from "../src/ui/transcript.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

const audit = (content: string, extra?: Partial<Turn>): Turn => ({ role: "tool", content, ...extra });

describe("borderColorFor", () => {
  test("status maps to phase-0 border tokens", () => {
    expect(borderColorFor("success")).toBe(theme.border.tool.ok);
    expect(borderColorFor("failed")).toBe(theme.border.tool.fail);
    expect(borderColorFor("denied")).toBe(theme.border.tool.denied);
    expect(borderColorFor("cancelled")).toBe(theme.border.tool.denied);
    expect(borderColorFor("running")).toBe(theme.border.tool.running);
    expect(borderColorFor("queued")).toBe(theme.border.tool.queued);
  });
  test("preview budgets", () => {
    expect(TOOL_PREVIEW_LINES).toBe(6);
    expect(TOOL_PREVIEW_CHARS).toBe(600);
  });
});

describe("ToolCall widget", () => {
  test("success: bordered frame, header, byte-identical audit, summary", () => {
    const frame = frameOf(
      <ToolCall turn={audit("⚙ read src/a.ts", { summary: "50 lines" })} />
    );
    expect(frame).toContain("read");
    expect(frame).toContain("completed");
    expect(frame).toContain("⚙ read src/a.ts");
    expect(frame).toContain("50 lines");
    expect(frame).toContain("╭");
  });
  test("failed: error card inside frame, no raw dump", () => {
    const frame = frameOf(
      <ToolCall
        turn={audit("  ↳ Error: boom detail", { error: true })}
        label={audit("⚙ write f.txt")}
      />
    );
    expect(frame).toContain("write");
    expect(frame).toContain("failed");
    expect(frame).toContain("⚙ write f.txt");
    expect(frame).toContain("boom detail");
  });
  test("preview caps at 6 lines with more-line footer", () => {
    const result = Array.from({ length: 10 }, (_, i) => `line ${i} content here`).join("\n");
    const frame = frameOf(<ToolCall turn={audit("⚙ bash pnpm test")} result={result} />);
    expect(frame).toContain("line 0 content here");
    expect(frame).toContain("line 5 content here");
    expect(frame).not.toContain("line 9 content here");
    expect(frame).toContain("4 more lines");
  });
  test("todo renders counts, ask renders answer in question frame", () => {
    const todo = frameOf(
      <ToolCall turn={audit("⚙ todowrite 2 task(s)")} result={"Todo list (2):\n1. ✅ [completed] a\n2. 🔧 [in_progress] b"} />
    );
    expect(todo).toContain("1 done");
    expect(todo).toContain("1 in-progress");
    const ask = frameOf(
      <ToolCall turn={audit("⚙ ask_question Which?")} result={JSON.stringify({ answer: "B" })} />
    );
    expect(ask).toContain("ask_question");
    expect(ask).toContain("B");
  });
  test("chatter stays frameless", () => {
    const frame = frameOf(<ToolCall turn={audit("↻ retrying… boom")} />);
    expect(frame).toContain("retrying… boom");
    expect(frame).not.toContain("╭");
  });
});

describe("LiveToolCall widget", () => {
  test("running frame with verb tail, queued without duration", () => {
    const running = frameOf(
      <LiveToolCall name="read" target="src/a.ts" kind="file" status="running" durationMs={3000} verb="◉ Reading src/a.ts · 3s" />
    );
    expect(running).toContain("read");
    expect(running).toContain("running");
    expect(running).toContain("◉ Reading src/a.ts");
    expect(running).toContain("╭");
    const queued = frameOf(<LiveToolCall name="bash" status="queued" />);
    expect(queued).toContain("queued");
    expect(queued).toContain("…");
  });
});
