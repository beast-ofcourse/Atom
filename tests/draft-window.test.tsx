// Live-draft tail window: the streaming answer is windowed to its height
// budget so the interactive frame can never outgrow the viewport (an
// over-tall frame is what forces Ink's win32 full-screen clear mid-stream),
// while text that already fits passes through byte-exact so the memoized
// stream parser still bails.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  LIVE_DRAFT_MIN_LINES,
  LIVE_DRAFT_RESERVE_LINES,
  liveDraftMaxLines,
  tailDisplayWindow,
} from "../src/ui/layout.js";
import { MarkdownDraft } from "../src/ui/components/Markdown.js";
import { LiveTail } from "../src/ui/live-tail.js";
import type { StepBlock } from "../src/ui/step-blocks.js";

function frameOf(node: React.ReactNode): { frame: string; rows: number } {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return { frame, rows: frame.length === 0 ? 0 : frame.split("\n").length };
}

const paragraphs = (count: number): string =>
  Array.from({ length: count }, (_, i) => `paragraph line ${i}`).join("\n\n");

describe("live draft height budget", () => {
  test("reserve + floor pin the live-zone breakdown", () => {
    // footer 4 + live margin 1 + speaker header 1 + live thinking (label +
    // 8 tail lines) 9 + running tool row 1 = 16.
    expect(LIVE_DRAFT_RESERVE_LINES).toBe(16);
    expect(LIVE_DRAFT_MIN_LINES).toBe(4);
  });

  test("budget is rows minus reserve, floored at the minimum", () => {
    expect(liveDraftMaxLines(30)).toBe(14);
    expect(liveDraftMaxLines(16)).toBe(4);
    expect(liveDraftMaxLines(8)).toBe(4);
  });
});

describe("tailDisplayWindow", () => {
  test("text that fits passes through byte-exact (same reference)", () => {
    const text = "one\ntwo\nthree";
    expect(tailDisplayWindow(text, 80, 10)).toBe(text);
  });

  test("keeps the last lines that fit and drops the head", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const windowed = tailDisplayWindow(text, 80, 10);
    const kept = windowed.split("\n");
    expect(kept).toHaveLength(10);
    expect(kept.at(-1)).toBe("line 39");
    expect(windowed).not.toContain("line 0");
  });

  test("counts wrapped rows: one long line fills the whole budget", () => {
    const windowed = tailDisplayWindow("x".repeat(500), 100, 4);
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.length).toBeLessThanOrEqual(4 * 100);
    // The head is gone: the slice is the tail, not the whole paragraph.
    expect(windowed.length).toBeLessThan(500);
  });

  test("an over-wide line is cut at a word boundary, never to nothing", () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const windowed = tailDisplayWindow(words, 80, 3);
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.length).toBeLessThanOrEqual(3 * 80);
    // Whole words only: the cut edge never lands inside a token.
    expect(windowed.startsWith(" ")).toBe(false);
    expect(windowed).toMatch(/\bword\d+\b/);
  });

  test("a blank line counts as one display row", () => {
    expect(tailDisplayWindow(["a", "", "b", "c"].join("\n"), 80, 2)).toBe("b\nc");
  });

  test("degenerate budgets still return content", () => {
    expect(tailDisplayWindow("hello", 80, 0)).toBe("hello");
    expect(tailDisplayWindow("", 80, 5)).toBe("");
  });
});

describe("MarkdownDraft windowing", () => {
  test("maxLines keeps the live frame short: tail visible, head dropped", () => {
    const body = paragraphs(30);
    const budgeted = frameOf(<MarkdownDraft text={body} maxLines={5} columns={100} />);
    const full = frameOf(<MarkdownDraft text={body} columns={100} />);
    expect(budgeted.frame).toContain("paragraph line 29");
    expect(budgeted.frame).not.toContain("paragraph line 0");
    expect(budgeted.rows).toBeLessThanOrEqual(6);
    expect(budgeted.rows).toBeLessThan(full.rows);
  });

  test("without a budget the whole stream renders (legacy callers, tests)", () => {
    const { frame, rows } = frameOf(<MarkdownDraft text={paragraphs(30)} columns={100} />);
    expect(frame).toContain("paragraph line 0");
    expect(rows).toBeGreaterThan(20);
  });
});

describe("LiveTail windows the ordered live draft", () => {
  const liveBase = {
    isEmpty: false,
    sessionHint: false,
    draft: null,
    thinking: null,
    busy: true,
    held: false,
    toolHint: null,
    toolElapsedSecs: null,
    elapsedSecs: 0,
  };

  test("draftMaxLines reaches the live text block through StepBlockList", () => {
    const blocks: StepBlock[] = [
      { id: "step-0-text-0", stepId: "step-0", order: 0, kind: "text", text: paragraphs(30), done: false },
    ];
    const budgeted = frameOf(
      <LiveTail {...liveBase} stepBlocks={blocks} columns={100} draftMaxLines={5} />,
    );
    const full = frameOf(<LiveTail {...liveBase} stepBlocks={blocks} columns={100} />);
    expect(budgeted.frame).toContain("paragraph line 29");
    expect(budgeted.frame).not.toContain("paragraph line 0");
    // Budget + speaker header + live-zone margin, never the full 30 blocks.
    expect(budgeted.rows).toBeLessThanOrEqual(8);
    expect(budgeted.rows).toBeLessThan(full.rows);
  });

  test("legacy draft lane windows too (no step blocks)", () => {
    const budgeted = frameOf(
      <LiveTail {...liveBase} draft={paragraphs(30)} columns={100} draftMaxLines={5} />,
    );
    expect(budgeted.frame).toContain("paragraph line 29");
    expect(budgeted.frame).not.toContain("paragraph line 0");
    expect(budgeted.rows).toBeLessThanOrEqual(8);
  });
});
