// Regression: a diff inside a bordered widget must fill the frame without
// losing text at the border.
//
// Reported symptom: "the diff shows up in a block with borders which cuts
// off half of the diff horizontally". Two causes, both gone now:
//  1. the preview rendered side-by-side INSIDE the frame — the content box
//     is at most 96 cells (widgetWidth cap − border − padding), so each pane
//     got ~43 cells and every real code line was ellipsized at its midpoint;
//  2. before the frame-width fix, rows were laid out from the terminal and
//     Ink clipped them at the border (an odd `…` count: the right pane's
//     tail was eaten by the frame rather than by its own truncation).
//
// The contract now: a framed diff is ONE full-width unified column
// (ui/diff-view), so the observables are:
//   - the box stays rectangular — every painted row is exactly the frame;
//   - no pane separator (│) inside a frame (panes need a real width);
//   - no source text is dropped: an over-long line is WRAPPED whole, never
//     ellipsized, and nothing is eaten by the border.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { ApprovalBox } from "../src/ui/modals.js";
import { ToolCall } from "../src/ui/components/ToolCall.js";
import { widgetWidth } from "../src/ui/layout.js";
import { theme } from "../src/ui/theme.js";

// Testing-library stdout is 100x24 (same as the App's default).
const COLUMNS = 100;
// Over-long on purpose: wider than any frame content box, so it can only
// survive by wrapping. The token at its end proves the tail reached the
// screen — a clipped or ellipsized line loses it.
const LONG_OLD = `const alpha = "${"a".repeat(120)}"; const OLD_TAIL = compute(alpha);`;
const LONG_NEW = `const alpha = "${"b".repeat(120)}"; const NEW_TAIL = compute(alpha);`;

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function rows(frame: string): string[] {
  return stripAnsi(frame)
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
}

// The frame's own left/right borders are `│` as well, so a bare "no `│`"
// assertion cannot see panes. Count them per row instead: exactly two means
// the frame sides only, a pane row carries a third (the pane separator).
function isOneColumn(lines: string[]): boolean {
  return lines.every((l) => l.split(theme.symbol.bar).length - 1 <= 2);
}

function diffTurn() {
  return {
    role: "tool" as const,
    content: `${theme.symbol.toolMark} write src/x.ts`,
    diff: { oldText: `${LONG_OLD}\n`, newText: `${LONG_NEW}\n`, lang: null, path: "src/x.ts" },
  };
}

const diff = { oldText: `${LONG_OLD}\n`, newText: `${LONG_NEW}\n`, lang: null, path: "src/x.ts" };

describe("framed diff: one full-width column, nothing lost at the border", () => {
  test("ToolCall's box stays rectangular and shows the whole line", () => {
    const lines = rows(frameOf(<ToolCall turn={diffTurn()} />));
    expect(lines.length).toBeGreaterThan(0);
    // Rectangular frame: one width for every painted row (the frame's).
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBe(widgetWidth(COLUMNS));
    // One column, not panes: only the frame's own border bars appear.
    expect(isOneColumn(lines)).toBe(true);
    // The over-long line wrapped instead of being cut: both tails reached
    // the screen and no ellipsis marked a dropped tail.
    const body = lines.join("\n");
    expect(body).toContain("OLD_TAIL");
    expect(body).toContain("NEW_TAIL");
    expect(body).not.toContain(theme.symbol.ellipsis);
  });

  test("ApprovalBox preview fills its frame the same way", () => {
    const lines = rows(
      frameOf(<ApprovalBox toolName="edit" description="⚙ edit src/x.ts" selected={0} diff={diff} />)
    );
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
    const frameW = [...widths][0]!;
    expect(frameW).toBeGreaterThan(0);
    expect(frameW).toBeLessThanOrEqual(COLUMNS);
    const body = lines.join("\n");
    expect(isOneColumn(lines)).toBe(true);
    expect(body).toContain("OLD_TAIL");
    expect(body).toContain("NEW_TAIL");
    expect(body).not.toContain(theme.symbol.ellipsis);
    // The decision UI still sits below the preview.
    expect(body).toContain("❯ [y]es once");
    expect(body).toContain("[n]o — deny this call");
  });

  test("a diff that fits renders on one row per line, unchanged", () => {
    const short = {
      oldText: "const TOKEN_EXPIRY = 3600;\n",
      newText: "const TOKEN_EXPIRY = 7200;\n",
      lang: "c",
      path: "src/x.ts",
    };
    const lines = rows(
      frameOf(<ApprovalBox toolName="edit" description="⚙ edit src/x.ts" selected={0} diff={short} />)
    );
    expect(isOneColumn(lines)).toBe(true);
    // The whole line sits on one row — no wrap, no panes, no dropped tail.
    expect(lines.some((l) => l.includes("const TOKEN_EXPIRY = 3600;"))).toBe(true);
    expect(lines.some((l) => l.includes("const TOKEN_EXPIRY = 7200;"))).toBe(true);
  });
});
