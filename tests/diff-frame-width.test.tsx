// Regression: the diff must use every cell it is given, and no source text may
// be lost at a frame's border.
//
// History: the preview used to render side-by-side INSIDE the bordered widget
// (content box ≤ 96 cells, ~43 per pane), so every real code line was
// ellipsized at its midpoint; rows laid out from the terminal were then
// clipped at the border. The fix went further than a width pass-through:
//
//  - a diff-bearing tool turn is FRAMELESS (ui/components/ToolCall). A border
//    plus padding costs four cells of code width and is what made a long line
//    wrap early on a wide terminal. Its rows now span the whole transcript.
//  - a dialog that must stay framed (ApprovalBox) passes its CONTENT box to
//    the diff, so the diff's rows fit inside the frame exactly.
//  - in both cases the body is ONE unified column (ui/diff-view) laid out by
//    ui/diff-layout: an over-long line is WRAPPED whole, never ellipsized, and
//    every row carries the line-number gutter (`old new marker │`).
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { ApprovalBox } from "../src/ui/modals.js";
import { ToolCall } from "../src/ui/components/ToolCall.js";
import { widgetWidth } from "../src/ui/layout.js";
import { theme } from "../src/ui/theme.js";

// Testing-library stdout is 100x24 (same as the App's default).
const COLUMNS = 100;
// Frameless transcript rows own the terminal minus the App inset; a framed
// dialog owns its width minus border and padding (ApprovalBox caps at 100).
const TRANSCRIPT_WIDTH = COLUMNS - 2;
// Over-long on purpose: wider than any content box, so it can only survive by
// wrapping. The token at its end proves the tail reached the screen — a
// clipped or ellipsized line loses it.
const LONG_OLD = `const alpha = "${"a".repeat(120)}"; const OLD_TAIL = compute(alpha);`;
const LONG_NEW = `const alpha = "${"b".repeat(120)}"; const NEW_TAIL = compute(alpha);`;
// Border glyphs of theme.border.style ("round"). A frameless surface paints
// none of them; a framed one paints the corners.
const BORDER_GLYPHS = ["╭", "╮", "╰", "╯"];

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

// Terminal-cell width, computed independently of the component so the test
// pins the contract rather than the implementation.
function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  )
    return 2;
  return 1;
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cellWidth(ch);
  return w;
}

// Cell columns of every rule glyph (`│`) on a row. A frameless diff row has
// exactly one (its gutter); a framed dialog row has two (the frame's sides)
// and a diff row inside it has three (both sides + its gutter). A fourth would
// mean a pane split.
function barColumns(line: string): number[] {
  const columns: number[] = [];
  let width = 0;
  for (const ch of line) {
    if (ch === theme.symbol.bar) columns.push(width);
    width += cellWidth(ch);
  }
  return columns;
}

function diffTurn() {
  return {
    role: "tool" as const,
    content: `${theme.symbol.toolMark} write src/x.ts`,
    diff: { oldText: `${LONG_OLD}\n`, newText: `${LONG_NEW}\n`, lang: null, path: "src/x.ts" },
  };
}

const diff = { oldText: `${LONG_OLD}\n`, newText: `${LONG_NEW}\n`, lang: null, path: "src/x.ts" };

describe("a diff-bearing tool turn is frameless and owns the full width", () => {
  const lines = rows(frameOf(<ToolCall turn={diffTurn()} />));

  test("paints no frame at all", () => {
    expect(lines.length).toBeGreaterThan(0);
    const body = lines.join("\n");
    for (const glyph of BORDER_GLYPHS) expect(body).not.toContain(glyph);
    // `─` only ever comes from a border rule on these surfaces.
    expect(body).not.toContain("─");
  });

  test("wraps the whole long line instead of cutting it", () => {
    const body = lines.join("\n");
    expect(body).toContain("OLD_TAIL");
    expect(body).toContain("NEW_TAIL");
    // Wrapping, never truncation: no ellipsis marks a dropped tail.
    expect(body).not.toContain(theme.symbol.ellipsis);
  });

  test("a wrapped row fills the transcript width exactly", () => {
    // The widest painted row is the full width the diff was given — proof the
    // rows are not squeezed into a narrower content box.
    const widest = Math.max(...lines.map(displayWidth));
    expect(widest).toBe(TRANSCRIPT_WIDTH);
    // Wider than the old framed card could ever be (frame border + padding).
    expect(widest).toBeGreaterThan(widgetWidth(COLUMNS) - 2 - 2);
  });

  test("every row keeps the gutter rule in one column", () => {
    const columns = lines.map(barColumns).filter((cols) => cols.length > 0);
    // One rule per body row, all in the same cell column: the gutter lines up
    // across a wrapped line (header rows carry no rule at all).
    expect(columns.length).toBeGreaterThan(4);
    const distinct = new Set(columns.map((cols) => cols.join(",")));
    expect(distinct.size).toBe(1);
  });
});

describe("a framed dialog passes its content box to the diff", () => {
  test("ApprovalBox stays rectangular and loses no text", () => {
    const lines = rows(
      frameOf(<ApprovalBox toolName="edit" description="⚙ edit src/x.ts" selected={0} diff={diff} />)
    );
    // Rectangular: one width for every painted row (the dialog's own).
    const widths = new Set(lines.map(displayWidth));
    expect(widths.size).toBe(1);
    const frameW = [...widths][0]!;
    expect(frameW).toBe(Math.min(COLUMNS - 2, 100));

    const body = lines.join("\n");
    expect(body).toContain("OLD_TAIL");
    expect(body).toContain("NEW_TAIL");
    expect(body).not.toContain(theme.symbol.ellipsis);

    // One column, not panes: a diff row carries the frame's two sides plus its
    // own gutter rule — never a second (pane) rule. Border-only rows carry two.
    const barCounts = lines.map((l) => barColumns(l).length).filter((n) => n > 0);
    expect(barCounts.every((n) => n === 2 || n === 3)).toBe(true);
    const diffRows = barCounts.filter((n) => n === 3);
    expect(diffRows.length).toBeGreaterThan(3);

    // The decision UI still sits below the preview.
    expect(body).toContain("❯ [y]es once");
    expect(body).toContain("[n]o — deny this call");
  });

  test("a diff that fits renders one row per line, inside the frame", () => {
    const short = {
      oldText: "const TOKEN_EXPIRY = 3600;\n",
      newText: "const TOKEN_EXPIRY = 7200;\n",
      lang: "c",
      path: "src/x.ts",
    };
    const lines = rows(
      frameOf(<ApprovalBox toolName="edit" description="⚙ edit src/x.ts" selected={0} diff={short} />)
    );
    // The whole line sits on one row — no wrap, no panes, no dropped tail.
    expect(lines.some((l) => l.includes("const TOKEN_EXPIRY = 3600;"))).toBe(true);
    expect(lines.some((l) => l.includes("const TOKEN_EXPIRY = 7200;"))).toBe(true);
    // Every diff row keeps the gutter inside the frame (two source lines plus
    // the trailing empty line the text ends with) — one rule each, no panes.
    const barCounts = lines.map((l) => barColumns(l).length).filter((n) => n > 0);
    const diffRows = barCounts.filter((n) => n === 3);
    expect(diffRows).toHaveLength(3);
    expect(barCounts.every((n) => n === 2 || n === 3)).toBe(true);
  });
});
