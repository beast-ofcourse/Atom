// Width matrix: the unified diff must reflow at every terminal width, never
// truncate, and keep its gutter aligned — and the side-by-side view must only
// split the terminal once there is room for two readable panes.
//
// The observable is the painted frame (ink-testing-library renders at 100
// columns, so a row wider than that is clipped by the harness, not by the
// component): row COUNT is what a width change moves, and it is visible at any
// width. Row WIDTH is asserted only up to the 100-cell harness screen.
// Component tests only: no App harness, no network.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { DiffView } from "../src/ui/diff-view.js";
import { SideBySideDiffView, SBS_NARROW_COLUMNS } from "../src/ui/side-by-side.js";
import { theme } from "../src/ui/theme.js";

const WIDTHS = [40, 60, 100, 140, 200] as const;
const HARNESS_COLUMNS = 100;

// One over-long added line: wider than every width in the matrix, so the only
// way it can reach the screen is by wrapping.
const LONG = `const payload = "${"x".repeat(260)}"; // LONG_TAIL_TOKEN`;
const OLD = "keep\nanchor";
const NEW = `keep\n${LONG}\nanchor`;

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function rows(frame: string): string[] {
  return frame
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
}

// Body rows (the ones carrying a gutter rule) — hunk headers and the summary
// line have none.
function bodyRows(frame: string): string[] {
  return rows(frame).filter((l) => l.includes(theme.symbol.bar));
}

describe("unified diff: one column that reflows with the width", () => {
  const frames = WIDTHS.map((columns) => frameOf(<DiffView oldText={OLD} newText={NEW} columns={columns} />));

  test("a narrower column produces more rows (wrap, never truncate)", () => {
    const counts = frames.map((f) => bodyRows(f).length);
    for (let i = 1; i < counts.length; i += 1) {
      // Strictly fewer rows as the column grows: the content is being
      // re-flowed, not dropped.
      expect(counts[i]!).toBeLessThan(counts[i - 1]!);
    }
    expect(counts[0]!).toBeGreaterThan(counts[counts.length - 1]!);
  });

  test("no width drops a character: the tail token survives every layout", () => {
    // Only the widths that fit the 100-cell harness screen can be checked for
    // an ellipsis: wider rows are clipped by the test renderer itself, which
    // appends its own `…` (the component never does).
    for (const columns of WIDTHS.filter((w) => w <= HARNESS_COLUMNS)) {
      expect(frameOf(<DiffView oldText={OLD} newText={NEW} columns={columns} />)).not.toContain(
        theme.symbol.ellipsis
      );
    }
    // The tail sits on the last row of the wrapped line — visible at the
    // narrow widths where that row is short.
    expect(frames[0]!).toContain("LONG_TAIL_TOKEN");
    expect(frames[1]!).toContain("LONG_TAIL_TOKEN");
  });

  test("every row stays inside the harness screen at every width", () => {
    for (const frame of frames) {
      for (const line of rows(frame)) {
        expect([...line].length).toBeLessThanOrEqual(HARNESS_COLUMNS);
      }
    }
  });

  test("the gutter rule keeps one column across the wrapped rows", () => {
    for (const frame of frames) {
      const columns = bodyRows(frame).map((l) => l.indexOf(theme.symbol.bar));
      expect(columns.length).toBeGreaterThan(1);
      expect(new Set(columns).size).toBe(1);
    }
  });
});

describe("side-by-side: panes only when two panes can breathe", () => {
  const renderAt = (columns: number) =>
    frameOf(<SideBySideDiffView oldText={OLD} newText={NEW} lang={null} columns={columns} />);

  test("below the threshold it degrades to the single unified column", () => {
    // 60 is narrower than the test terminal (100), so this is also the case
    // that proves the degraded column honours the caller's budget instead of
    // re-deriving a width from the terminal.
    for (const columns of [60, SBS_NARROW_COLUMNS - 1]) {
      const frame = renderAt(columns);
      expect(frame).toContain("@@");
      // One rule per body row: the gutter, no pane split.
      const bars = bodyRows(frame).map((l) => l.split(theme.symbol.bar).length - 1);
      expect(new Set(bars)).toEqual(new Set([1]));
      for (const line of rows(frame)) {
        expect([...line].length).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("at and above the threshold it shows two panes with a fixed separator", () => {
    // Widths whose separator and right-pane head still fall inside the
    // 100-cell harness screen — beyond that the frame cannot show the split.
    for (const columns of [SBS_NARROW_COLUMNS, SBS_NARROW_COLUMNS + 20]) {
      const frame = renderAt(columns);
      const body = bodyRows(frame);
      expect(body.length).toBeGreaterThan(1);
      // Exactly one rule per row: the pane separator. The panes' own gutters
      // carry the line number and the `-`/`+` marker, not a second rule.
      const bars = body.map((l) => l.split(theme.symbol.bar).length - 1);
      expect(new Set(bars)).toEqual(new Set([1]));
      // The separator never moves between rows.
      const separators = body.map((l) => l.indexOf(theme.symbol.bar));
      expect(new Set(separators).size).toBe(1);
      // Both panes are painted: a context line appears on each side.
      const context = body.find((l) => l.includes("keep"));
      expect(context).toBeDefined();
      expect(context!.split("keep").length - 1).toBe(2);
    }
  });
});
