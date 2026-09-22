// Regression: a diff inside a bordered widget must size its panes to the
// frame's CONTENT box, never to the raw terminal width.
//
// Bug (reported: "the diff shows up in a block with borders which cuts off
// half of the diff horizontally"): ToolCall framed the diff in a Box whose
// outer width is capped by widgetWidth() and inset by border(2) +
// paddingX(2), but never told SideBySideDiffView how wide that box was. The
// view fell back to the live terminal width and laid out rows wider than the
// box, so Ink truncated them at the border: the right pane lost its tail
// (its own `…` truncation never ran) instead of truncating inside the pane.
//
// The observable test is the ellipsis count: each pane truncates long lines
// on its own budget, so a row with a long line on both sides carries two `…`
// — one per pane. A row clipped by the frame carries ONE (the left pane's)
// because the right pane's tail is cut by the border rather than by the pane,
// so an odd count is the failure signature.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { ToolCall } from "../src/ui/components/ToolCall.js";
import { SideBySideDiffView } from "../src/ui/side-by-side.js";
import { frameContentWidth, widgetWidth } from "../src/ui/layout.js";
import { theme } from "../src/ui/theme.js";

// Testing-library stdout is 100x24 (same as the App's default), which is
// exactly where the frame/content mismatch bites: widgetWidth(100) = 96.
const COLUMNS = 100;

const LONG_OLD = `const alpha = "${"a".repeat(120)}";`;
const LONG_NEW = `const alpha = "${"b".repeat(150)}";`;

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function diffTurn() {
  return {
    role: "tool" as const,
    content: `${theme.symbol.toolMark} write src/x.ts`,
    diff: { oldText: `${LONG_OLD}\n`, newText: `${LONG_NEW}\n`, lang: null, path: "src/x.ts" },
  };
}

function stripAnsiLines(frame: string): string[] {
  return stripAnsi(frame)
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
}

// Change rows only — separated by ` │ `, not by the frame's side borders.
function paneRows(lines: string[]): string[] {
  return lines.filter((l) => l.includes(` ${theme.symbol.bar} `));
}

function ellipses(line: string): number {
  return (line.match(/…/g) ?? []).length;
}

describe("diff panes fit the frame that contains them", () => {
  test("ToolCall's bordered frame truncates inside each pane, not at the border", () => {
    const rows = paneRows(stripAnsiLines(frameOf(<ToolCall turn={diffTurn()} />)));
    expect(rows.length).toBeGreaterThan(0);
    // Both long lines are truncated by their own pane: two ellipses, one per
    // pane (the pre-fix frame clipped the right one at the border).
    const longRow = rows.filter((l) => l.includes("const alpha"));
    expect(longRow).toHaveLength(1);
    expect(ellipses(longRow[0]!)).toBe(2);
    // Never an odd count anywhere: that is a pane whose tail the border ate.
    for (const row of rows) expect(ellipses(row) % 2).toBe(0);
  });

  test("rows stay inside the box and tile one width", () => {
    const lines = stripAnsiLines(frameOf(<ToolCall turn={diffTurn()} />));
    const frameW = widgetWidth(COLUMNS);
    const contentW = frameContentWidth(frameW);
    // The frame is rectangular: every painted line is exactly the box width.
    for (const line of lines.filter((l) => l.length > 0)) {
      expect([...line].length).toBe(frameW);
    }
    // …and the panes only use the box's interior (borders + padding are the
    // frame's, never the diff's).
    const body = paneRows(lines);
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) expect([...row].length).toBeLessThanOrEqual(contentW + 4);
  });

  test("an explicit width is the frame's content width (shared helper)", () => {
    // The contract call sites use: border(1/side) + paddingX are the box's,
    // so the view's budget is what is left inside.
    expect(frameContentWidth(96, 1)).toBe(92);
    expect(frameContentWidth(96, 0)).toBe(94);
    expect(frameContentWidth(20, 1)).toBe(16);
    const inner = frameContentWidth(widgetWidth(COLUMNS));
    const rows = paneRows(
      stripAnsiLines(
        frameOf(
        <Box
          flexDirection="column"
          borderStyle={theme.border.style}
          paddingX={1}
          width={widgetWidth(COLUMNS)}
        >
            <SideBySideDiffView
              oldText={`${LONG_OLD}\n`}
              newText={`${LONG_NEW}\n`}
              lang={null}
              columns={inner}
            />
          </Box>
        )
      )
    );
    expect(rows.length).toBeGreaterThan(0);
    const longRow = rows.filter((l) => l.includes("const alpha"));
    expect(longRow).toHaveLength(1);
    expect(ellipses(longRow[0]!)).toBe(2);
  });
});
