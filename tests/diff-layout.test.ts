// Unit contract for ui/diff-layout: terminal-cell measurement, tab expansion,
// and the word wrap that every diff surface now renders through.
//
// The load-bearing rules: a row never exceeds its width, no character is lost
// or invented, and changed-word / syntax paint follows the text it covers even
// when a run is split across rows.
import { describe, expect, test } from "vitest";
import { highlightLine } from "../src/ui/highlight.js";
import { cellWidth, displayWidth, expandTabs, rowWindow, wrapLine, type LayoutRow } from "../src/ui/diff-layout.js";
import type { WordRun } from "../src/ui/diff.js";

// Body text of every row with the continuation indent removed — must always
// equal the tab-expanded source line.
function bodyOf(rows: LayoutRow[]): string {
  return rows
    .map((row) => (row.continuation ? row.text.slice(row.indent) : row.text))
    .join("");
}

function widths(rows: LayoutRow[]): number[] {
  return rows.map((row) => displayWidth(row.text));
}

describe("cell measurement", () => {
  test("tabs expand to two cells; wide characters count two", () => {
    expect(expandTabs("\tx")).toBe("  x");
    expect(displayWidth("\tx")).toBe(3);
    expect(cellWidth("a")).toBe(1);
    expect(cellWidth("日")).toBe(2);
    expect(cellWidth("🎯")).toBe(2);
    expect(displayWidth("a日🎯")).toBe(5);
  });
});

describe("wrapLine", () => {
  test("a line that fits stays one row with plain segments", () => {
    const rows = wrapLine("const answer = 42;", 40);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.continuation).toBe(false);
    expect(rows[0]!.indent).toBe(0);
    expect(rows[0]!.text).toBe("const answer = 42;");
    expect(rows[0]!.segments.map((s) => s.text).join("")).toBe(rows[0]!.text);
  });

  test("wraps at word boundaries and never exceeds the width", () => {
    const line = "alpha beta gamma delta epsilon zeta";
    const rows = wrapLine(line, 18);
    expect(rows.length).toBeGreaterThan(1);
    expect(Math.max(...widths(rows))).toBeLessThanOrEqual(18);
    expect(bodyOf(rows)).toBe(line);
    // A break lands after a space, so rows do not start mid-word.
    for (const row of rows) expect(row.text.startsWith(" ")).toBe(false);
  });

  test("hard-splits a token wider than the row", () => {
    const line = "x".repeat(50);
    const rows = wrapLine(line, 10);
    expect(rows).toHaveLength(5);
    expect(Math.max(...widths(rows))).toBe(10);
    expect(bodyOf(rows)).toBe(line);
  });

  test("continuation rows repeat the line indent, capped at half the width", () => {
    const line = `${" ".repeat(20)}const value = compute(alpha, beta, gamma);`;
    const rows = wrapLine(line, 30);
    expect(rows.length).toBeGreaterThan(1);
    // Cap is min(CONTINUATION_INDENT_MAX = 12, width / 2 = 15).
    for (const row of rows.slice(1)) expect(row.indent).toBe(12);
    for (const row of rows.slice(1)) expect(row.text.startsWith(" ".repeat(12))).toBe(true);
    expect(bodyOf(rows)).toBe(expandTabs(line));
    expect(Math.max(...widths(rows))).toBeLessThanOrEqual(30);
  });

  test("expands tabs once and never emits a raw tab", () => {
    const rows = wrapLine(`\tif (ready) {\t\trun();\t}`, 40);
    for (const row of rows) expect(row.text).not.toContain("\t");
    expect(bodyOf(rows)).toBe("  if (ready) {    run();  }");
  });

  test("wide characters never overflow the row", () => {
    const rows = wrapLine("日本語テキストを表示する", 5);
    for (const row of rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(5);
    expect(bodyOf(rows)).toBe("日本語テキストを表示する");
  });

  test("a blank line is one empty row", () => {
    expect(wrapLine("", 20)).toEqual([
      { text: "", segments: [], continuation: false, indent: 0 },
    ]);
  });

  test("a degenerate width still terminates and keeps every character", () => {
    const rows = wrapLine("abc", 0);
    expect(rows).toHaveLength(3);
    expect(bodyOf(rows)).toBe("abc");
  });

  test("changed-word paint follows a run split across rows", () => {
    const line = "const ALPHA_TOKEN = 1;";
    const runs: WordRun[] = [
      { text: "const ", changed: false },
      { text: "ALPHA_TOKEN", changed: true },
      { text: " = 1;", changed: false },
    ];
    const rows = wrapLine(line, 12, runs);
    expect(rows.length).toBeGreaterThan(1);
    const changedText = rows
      .flatMap((row) => row.segments)
      .filter((segment) => segment.changed)
      .map((segment) => segment.text)
      .join("");
    expect(changedText).toBe("ALPHA_TOKEN");
    expect(bodyOf(rows)).toBe(line);
    // Every row's segments tile its own text exactly.
    for (const row of rows) {
      expect(row.segments.map((segment) => segment.text).join("")).toBe(row.text);
    }
  });

  test("syntax paint stays on the text it covers after a split", () => {
    const line = "const alpha = 1; // set";
    const spans = highlightLine(line, "c");
    const rows = wrapLine(line, 12, [], spans);
    expect(rows.length).toBeGreaterThan(1);

    const first = rows[0]!;
    const keyword = first.segments.find((segment) => segment.kind === "keyword");
    expect(keyword?.text).toBe("const");

    const numberRow = rows.find((row) => row.text.includes("1;"));
    expect(numberRow).toBeDefined();
    expect(numberRow!.segments.find((segment) => segment.kind === "number")?.text).toBe("1");

    const commentRow = rows.find((row) => row.text.includes("//"));
    expect(commentRow).toBeDefined();
    expect(commentRow!.segments.find((segment) => segment.kind === "comment")?.text).toContain("//");

    expect(bodyOf(rows)).toBe(line);
  });
});

describe("rowWindow", () => {
  test("an unbounded window renders every row from the top", () => {
    expect(rowWindow(120, Infinity, 0)).toEqual({ start: 0, end: 120 });
    expect(rowWindow(0, Infinity, 0)).toEqual({ start: 0, end: 0 });
  });

  test("the offset clamps to the last full window, never past the end", () => {
    expect(rowWindow(60, 20, 0)).toEqual({ start: 0, end: 20 });
    expect(rowWindow(60, 20, 20)).toEqual({ start: 20, end: 40 });
    expect(rowWindow(60, 20, 999)).toEqual({ start: 40, end: 60 });
    expect(rowWindow(10, 20, 0)).toEqual({ start: 0, end: 10 });
  });

  test("garbage offsets and budgets stay inside the list", () => {
    expect(rowWindow(60, 20, -5)).toEqual({ start: 0, end: 20 });
    expect(rowWindow(60, 20, Number.NaN)).toEqual({ start: 0, end: 20 });
    expect(rowWindow(60, 0, 0)).toEqual({ start: 0, end: 1 });
    expect(rowWindow(0, 20, 0)).toEqual({ start: 0, end: 0 });
  });
});
