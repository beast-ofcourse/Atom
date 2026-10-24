// Side-by-side diff view: BEFORE (left) vs AFTER (right), aligned rows,
// preserved line numbers.
//
// Presentation only — the rows come from computeSideBySide (ui/diff-engine);
// tool behavior is untouched.
//
// Contract:
// - left = original, right = result. A paired change shares one row group, so
//   corresponding lines sit opposite each other; context lines show on both
//   sides; an unpaired line leaves the opposite pane blank.
// - Both panes WRAP (ui/diff-layout) instead of truncating: a 300-column line
//   is shown whole over several rows instead of losing its tail to an ellipsis.
//   A wrapped line keeps its number on the first row, repeats its `-`/`+`
//   marker on every continuation row, and the shorter pane of the group pads
//   with blank rows — so the `│` separator never moves, whatever the content.
// - Hunks only. Every hunk after the first is introduced by its `@@ … @@`
//   header, so the jump between hunks is visible instead of silent.
// - Width: `columns` is the exact content width when the caller already owns
//   one; otherwise the throttled terminal width minus the App inset. Below
//   SBS_NARROW_COLUMNS the view degrades to the stacked unified DiffView
//   rather than splitting the terminal into two unreadable slivers.
// - Wrapping is memoized on (rows, width, lang): a busy tick repaints the
//   memoized rows and never re-wraps.
// All paint comes from ui/theme tokens.
import React from "react";
import { Box, Text } from "ink";
import { computeSideBySide, rangeLabel, sbsRange, type SBSHunk, type SBSRow, type WordRun } from "./diff.js";
import { DiffSummary, DiffView, LineBody, UNCHANGED_NOTICE } from "./diff-view.js";
import { displayWidth, rowWindow, wrapLine, type Segment } from "./diff-layout.js";
import { highlightLine, isHighlightLang } from "./highlight.js";
import { theme } from "./theme.js";
import { useThrottledTerminalSize } from "./layout.js";

export type SideBySideDiffViewProps = {
  oldText: string | null; // null = new file (all additions)
  newText: string;
  lang?: string | null;
  // Tool-arg path for the shared summary header (null/absent = counts +
  // range only). Threaded from the DiffPreview payload — never invented.
  path?: string | null;
  // Rendered body-row budget (wrapped rows; hunk headers and the summary line
  // are excluded). An explicit value windows the list with a dim
  // "… N more rows" trailer. Defaults to Infinity — callers that own a
  // scrollable pane pass their own budget.
  maxRows?: number;
  // Scroll offset in rendered rows, for callers that own a fixed viewport
  // (/diff's detail pane). Clamped to the last full window.
  scroll?: number;
  // Exact content width in terminal cells (tests / callers that already own
  // their budget, e.g. the /diff panel). Absent = measure the terminal and
  // reserve the App inset.
  columns?: number;
};

// Two panes need room to breathe. At 140 cells each pane gets ~62 body cells
// (gutter included) — enough for real code to read without wrapping every
// line. Below this the stacked unified view is strictly better.
export const SBS_NARROW_COLUMNS = 140;

// One rendered cell of a pane: a wrapped row of one logical line. `no` is set
// on the first row only; the marker repeats on continuation rows so a wrapped
// `-` line still reads as a deletion.
type PaneRow = {
  no: number | null;
  marker: " " | "-" | "+";
  text: string;
  // Null for context rows: they paint as plain dim text (no word background,
  // no syntax hue), so unchanged code stays subordinate to the change.
  segments: Segment[] | null;
};

// One terminal row of the view. A null side is an empty pane: either the line
// is absent from that side (pure add/del) or the opposite pane wrapped into
// more rows than this one did.
type DisplayRow = {
  changed: boolean;
  left: PaneRow | null;
  right: PaneRow | null;
};

type DisplayBlock = {
  // `@@ … @@` for every hunk after the first; null for the first hunk, whose
  // position the summary line already implies.
  header: string | null;
  rows: DisplayRow[];
};

type Layout = {
  numW: number;
  contentW: number;
  paneW: number;
  blocks: DisplayBlock[];
};

// Widest line number the gutter must hold. Numbers are per side but the
// column is shared, so both panes pad to the same width.
function widestNumber(rows: readonly SBSRow[]): number {
  let widest = 1;
  for (const row of rows) {
    if (row.kind === "context") {
      widest = Math.max(widest, row.oldNo, row.newNo);
      continue;
    }
    if (row.oldNo !== null) widest = Math.max(widest, row.oldNo);
    if (row.newNo !== null) widest = Math.max(widest, row.newNo);
  }
  return String(widest).length;
}

// One changed line → its wrapped pane rows (marker + syntax + word paint).
// A null text means the line does not exist on this side.
function wrapChanged(
  text: string | null,
  runs: readonly WordRun[],
  marker: "-" | "+",
  no: number | null,
  contentW: number,
  lang: string | null
): PaneRow[] | null {
  if (text === null) return null;
  const spans = isHighlightLang(lang) ? highlightLine(text, lang) : [];
  return wrapLine(text, contentW, runs, spans).map((row, index) => ({
    no: index === 0 ? no : null,
    marker,
    text: row.text,
    segments: row.segments,
  }));
}

function wrapContext(text: string, no: number, contentW: number): PaneRow[] {
  return wrapLine(text, contentW).map((row, index) => ({
    no: index === 0 ? no : null,
    marker: " ",
    text: row.text,
    segments: null,
  }));
}

// Stack the two panes of one logical row: the shorter side pads with blank
// rows (null), which keeps the separator column fixed.
function alignPanes(
  left: PaneRow[] | null,
  right: PaneRow[] | null,
  changed: boolean
): DisplayRow[] {
  const height = Math.max(left?.length ?? 0, right?.length ?? 0);
  const rows: DisplayRow[] = [];
  for (let i = 0; i < height; i += 1) {
    rows.push({ changed, left: left?.[i] ?? null, right: right?.[i] ?? null });
  }
  return rows;
}

function buildRow(row: SBSRow, contentW: number, lang: string | null): DisplayRow[] {
  if (row.kind === "context") {
    return alignPanes(
      wrapContext(row.text, row.oldNo, contentW),
      wrapContext(row.text, row.newNo, contentW),
      false
    );
  }
  const changed =
    row.oldRuns.some((run) => run.changed) ||
    row.newRuns.some((run) => run.changed) ||
    (row.oldText === null) !== (row.newText === null);
  return alignPanes(
    wrapChanged(row.oldText, row.oldRuns, "-", row.oldNo, contentW, lang),
    wrapChanged(row.newText, row.newRuns, "+", row.newNo, contentW, lang),
    changed
  );
}

// Engine rows → display blocks, one per hunk, with the wrapped rows already
// aligned per pane. Runs once per (rows, width, lang).
function buildDisplay(
  rows: readonly SBSRow[],
  hunks: readonly SBSHunk[],
  contentW: number,
  lang: string | null
): DisplayBlock[] {
  const perRow = rows.map((row) => buildRow(row, contentW, lang));
  return hunks.map((hunk, index) => {
    const end = index + 1 < hunks.length ? hunks[index + 1]!.rowStart : rows.length;
    return {
      header: index === 0 ? null : hunk.header,
      rows: perRow.slice(hunk.rowStart, end).flat(),
    };
  });
}

function SideBySideInner({
  oldText,
  newText,
  lang = null,
  path = null,
  maxRows = Infinity,
  scroll = 0,
  columns,
}: SideBySideDiffViewProps) {
  let throttledColumns: number | undefined;
  try {
    throttledColumns = useThrottledTerminalSize(64).columns;
  } catch {
    throttledColumns = undefined;
  }
  // Row budget in terminal cells. An explicit `columns` is the caller's exact
  // content box; otherwise measure the live terminal — throttled, so a resize
  // drag coalesces — and reserve the App inset (one cell per side).
  const totalW =
    columns ?? (throttledColumns === undefined ? 100 : Math.max(1, throttledColumns - 2));
  // Diff computation is expensive (Myers + wordRuns): memoize on content only.
  // Width and language only affect the wrapping below.
  const sbs = React.useMemo(() => computeSideBySide(oldText, newText), [oldText, newText]);

  // Hooks must run in the same order on every render, so the layout memo sits
  // above all early returns and yields null for the degenerate cases.
  const sep = ` ${theme.symbol.bar} `;
  const sepW = displayWidth(sep);
  const layout = React.useMemo((): Layout | null => {
    if (sbs.kind !== "diff" || totalW < SBS_NARROW_COLUMNS) return null;
    const numW = widestNumber(sbs.rows);
    // "<no> <marker> " is the fixed part of a pane's gutter; the body fills
    // the rest. `sepHolds` the two padding cells around the rule.
    const gutterW = numW + 3;
    const contentW = Math.max(8, Math.floor((totalW - sepW - gutterW * 2) / 2));
    return {
      numW,
      contentW,
      paneW: gutterW + contentW,
      blocks: buildDisplay(sbs.rows, sbs.hunks, contentW, lang),
    };
  }, [sbs, totalW, sepW, lang]);

  if (sbs.kind === "same") {
    return <Text dimColor>{UNCHANGED_NOTICE}</Text>;
  }
  if (sbs.kind === "binary") {
    return <Text dimColor>binary file changed</Text>;
  }
  if (sbs.kind === "skipped") {
    return <Text dimColor>{sbs.reason}</Text>;
  }
  // Graceful narrow-terminal degrade: one stacked column keeps every character
  // instead of crushing two panes into unreadable slivers. The caller's width
  // budget is handed on — the unified view must not re-derive a wider one from
  // the terminal and overflow the surface that asked for this layout.
  if (layout === null) {
    return (
      <DiffView
        oldText={oldText}
        newText={newText}
        lang={lang}
        path={path}
        maxRows={maxRows}
        scroll={scroll}
        columns={columns}
      />
    );
  }

  const { numW, contentW, paneW, blocks } = layout;

  // One pane cell, padded to the exact pane width so the separator lands in the
  // same column on every row. `dim` marks an unchanged pair (word-identical
  // lines that only moved): its number and marker stay subordinate.
  const renderPane = (row: PaneRow | null, dim: boolean): React.ReactNode => {
    if (row === null) return <Text>{" ".repeat(paneW)}</Text>;
    const num = row.no === null ? " ".repeat(numW) : String(row.no).padStart(numW, " ");
    const accent =
      row.marker === "-" ? theme.color.toolError : row.marker === "+" ? theme.color.success : undefined;
    const pad = " ".repeat(Math.max(0, contentW - displayWidth(row.text)));
    return (
      <Text>
        <Text color={accent} dimColor={accent === undefined || dim}>
          {num}{" "}
        </Text>
        <Text color={accent} dimColor={accent === undefined || dim}>
          {row.marker}{" "}
        </Text>
        {row.segments === null ? (
          <Text dimColor>{row.text}</Text>
        ) : (
          <LineBody segments={row.segments} base={row.marker === "-" ? "del" : "add"} lang={lang} />
        )}
        {pad}
      </Text>
    );
  };

  const rendered: React.ReactNode[] = [];
  // Hunk headers are chrome: the window holds the same number of code rows at
  // any offset, and a hunk with no visible row prints no header.
  const totalRows = blocks.reduce((sum, block) => sum + block.rows.length, 0);
  const { start, end } = rowWindow(totalRows, maxRows, scroll);
  const belowRows = totalRows - end;
  let cursor = 0;
  for (let bi = 0; bi < blocks.length; bi += 1) {
    const block = blocks[bi]!;
    const blockStart = cursor;
    cursor += block.rows.length;
    const from = Math.max(0, start - blockStart);
    const to = Math.min(block.rows.length, end - blockStart);
    if (to <= from) continue;
    rendered.push(
      <Box key={bi} flexDirection="column">
        {block.header === null ? null : <Text dimColor>{block.header}</Text>}
        {block.rows.slice(from, to).map((row, ri) => (
          <Text key={ri} wrap="truncate">
            {renderPane(row.left, !row.changed)}
            <Text dimColor>{sep}</Text>
            {renderPane(row.right, !row.changed)}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <DiffSummary
        adds={sbs.adds}
        dels={sbs.dels}
        isNewFile={sbs.isNewFile}
        path={path}
        range={sbs.isNewFile ? null : rangeLabel(sbsRange(sbs.rows))}
      />
      {start > 0 ? (
        <Text dimColor>
          {theme.symbol.moreAbove} {start} more row{start === 1 ? "" : "s"}
        </Text>
      ) : null}
      {rendered}
      {belowRows > 0 ? (
        <Text dimColor>
          {theme.symbol.ellipsis} {belowRows} more row{belowRows === 1 ? "" : "s"}
        </Text>
      ) : null}
    </Box>
  );
}

export const SideBySideDiffView = React.memo(SideBySideInner);
