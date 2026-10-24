// Diff-body layout primitives: terminal-cell measurement, tab expansion, and
// the word wrap that turns one logical diff line into gutter-ready rows.
//
// Why this module exists: Ink wraps the string it is given, so a line that
// carries a `- ` prefix, a line-number gutter, or a syntax hue cannot control
// where it breaks. The diff surfaces therefore wrap themselves and hand Ink
// rows that already fit — every rendered row is `wrap="truncate"`, so Ink can
// never re-wrap and break the gutter alignment.
//
// Pure: no React, no Ink, no theme. Cell widths, tab handling, and wrapping are
// the single source shared by the unified view, the side-by-side panes, and the
// tests that pin them.
//
// Contract:
// - Rows tile the input: each row's `segments` rejoin to its `text`, and the
//   body of every row (continuation rows minus their inserted indent) rejoins
//   to `expandTabs(text)`. No character is dropped, no character is invented.
// - Changed-word runs and syntax spans follow the characters they cover, so a
//   split never moves a highlight to the wrong text.
// - A row never exceeds the requested width unless a single wide character is
//   wider than the whole budget (documented last resort, never a crash).
import type { WordRun } from "./diff.js";
import type { SyntaxKind, SyntaxRun } from "./highlight.js";

export type Segment = {
  // Literal text to paint. Never empty.
  text: string;
  // Changed-word highlight (word-level diff run).
  changed: boolean;
  // Syntax family for this text, or null for plain body text.
  kind: SyntaxKind | null;
};

export type LayoutRow = {
  // Everything to paint for this row: `indent` spaces (continuation rows
  // only) followed by the body text.
  text: string;
  // Same content as `text`, pre-split by paint (changed + syntax kind).
  segments: Segment[];
  // True for every row after the first: the line wrapped at least once.
  continuation: boolean;
  // Leading spaces inserted on a continuation row to preserve code nesting.
  // Always 0 on the first row.
  indent: number;
};

// A tab is display-only expansion: the diff engine keeps the raw text, the
// renderer normalises it. Two cells matches the repository's two-space indent.
export const TAB_CELLS = 2;

// Continuation rows keep at most this much of the line's own indentation, and
// never more than half the body width (a deep indent must not starve the text).
export const CONTINUATION_INDENT_MAX = 12;

export function expandTabs(text: string): string {
  return text.replace(/\t/g, " ".repeat(TAB_CELLS));
}

// Terminal cells occupied by one code point. Wide ranges are the standard
// East-Asian/emoji blocks; everything else is one cell.
export function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  )
    return 2;
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += ch === "\t" ? TAB_CELLS : cellWidth(ch);
  }
  return width;
}

// One expanded character with the paint it inherits from its source position.
type Cell = { ch: string; width: number; changed: boolean; kind: SyntaxKind | null };

// Expand the line into display cells, carrying each source character's run and
// syntax span forward. `runs` and `spans` both tile the ORIGINAL text, so they
// are walked with UTF-16 offsets in lockstep with the code-point iteration.
function toCells(
  text: string,
  runs: readonly WordRun[],
  spans: readonly SyntaxRun[]
): Cell[] {
  const cells: Cell[] = [];
  let offset = 0;
  let runIndex = 0;
  let runEnd = runs[0]?.text.length ?? 0;
  let spanIndex = 0;
  let spanEnd = spans[0]?.end ?? 0;

  for (const ch of text) {
    while (runIndex < runs.length && offset >= runEnd) {
      runIndex += 1;
      runEnd += runs[runIndex]?.text.length ?? 0;
    }
    const changed = runs[runIndex]?.changed ?? false;
    while (spanIndex < spans.length && offset >= spanEnd) {
      spanIndex += 1;
      spanEnd = spans[spanIndex]?.end ?? 0;
    }
    const kind: SyntaxKind | null = spans[spanIndex]?.kind ?? null;

    if (ch === "\t") {
      // Both cells inherit the tab's paint so a split can never orphan one.
      for (let k = 0; k < TAB_CELLS; k += 1) {
        cells.push({ ch: " ", width: 1, changed, kind });
      }
    } else {
      cells.push({ ch, width: cellWidth(ch), changed, kind });
    }
    offset += ch.length;
  }
  return cells;
}

// Leading whitespace of the line, capped for continuation rows. Whitespace
// cells already carry no paint (a highlight never starts inside an indent).
function continuationIndent(cells: readonly Cell[], bodyWidth: number): Cell[] {
  const cap = Math.min(CONTINUATION_INDENT_MAX, Math.floor(bodyWidth / 2));
  const indent: Cell[] = [];
  for (const cell of cells) {
    if (indent.length >= cap || cell.ch !== " ") break;
    indent.push({ ch: " ", width: 1, changed: false, kind: null });
  }
  return indent;
}

/**
 * Visible row window for a scrollable diff.
 *
 * Clamps the requested offset so the window can never scroll past the end and
 * never asks for a negative range. `maxRows` may be Infinity (render
 * everything); a non-finite or negative offset reads as the top.
 */
export function rowWindow(
  totalRows: number,
  maxRows: number,
  scroll: number
): { start: number; end: number } {
  const budget = Math.max(1, maxRows);
  const lastStart = Math.max(0, totalRows - budget);
  const requested = Number.isFinite(scroll) ? Math.floor(scroll) : 0;
  const start = Math.max(0, Math.min(requested, lastStart));
  return { start, end: Math.min(totalRows, start + budget) };
}

// End index (exclusive) of the next row: break after the last space that fits,
// hard-split when the window holds no space, and always consume at least one
// cell so a budget too small for a wide character cannot loop forever.
function rowEnd(cells: readonly Cell[], start: number, budget: number): number {
  let used = 0;
  let index = start;
  let lastSpace = -1;
  while (index < cells.length && used + cells[index]!.width <= budget) {
    if (cells[index]!.ch === " ") lastSpace = index;
    used += cells[index]!.width;
    index += 1;
  }
  if (index >= cells.length) return cells.length;
  if (lastSpace >= start) return lastSpace + 1;
  return Math.max(start + 1, index);
}

function toSegments(cells: readonly Cell[]): Segment[] {
  const segments: Segment[] = [];
  for (const cell of cells) {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.changed === cell.changed && last.kind === cell.kind) {
      last.text += cell.ch;
    } else {
      segments.push({ text: cell.ch, changed: cell.changed, kind: cell.kind });
    }
  }
  return segments;
}

/**
 * Wrap one logical diff line into display rows that fit `width` terminal cells.
 *
 * `runs` carries the changed-word paint and `spans` the syntax paint; both are
 * optional because context lines carry neither. Tabs expand to `TAB_CELLS`
 * spaces; continuation rows repeat the line's own indent (capped) so nested
 * code reads as nested code.
 */
export function wrapLine(
  text: string,
  width: number,
  runs: readonly WordRun[] = [],
  spans: readonly SyntaxRun[] = []
): LayoutRow[] {
  const cells = toCells(text, runs, spans);
  if (cells.length === 0) {
    return [{ text: "", segments: [], continuation: false, indent: 0 }];
  }
  const bodyWidth = Math.max(1, Math.floor(width));
  const indent = continuationIndent(cells, bodyWidth);
  const indentWidth = indent.length;

  const rows: LayoutRow[] = [];
  let start = 0;
  while (start < cells.length) {
    const isContinuation = start > 0;
    const prefix = isContinuation ? indent : [];
    const budget = Math.max(1, bodyWidth - prefix.length);
    const end = rowEnd(cells, start, budget);
    const rowCells = [...prefix, ...cells.slice(start, end)];
    rows.push({
      text: rowCells.map((cell) => cell.ch).join(""),
      segments: toSegments(rowCells),
      continuation: isContinuation,
      indent: prefix.length,
    });
    start = end;
  }
  return rows;
}
