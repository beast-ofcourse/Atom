// Side-by-side diff view for write/edit results: BEFORE pane (left) vs
// AFTER pane (right), aligned rows, preserved line numbers.
//
// Requirements it answers (presentation only — data comes from the
// existing approve-time preview / commit slot, tool behavior untouched):
// - left = original, right = result; additions right, removals left,
//   context on both sides; paired changes share ONE row so corresponding
//   lines align; changed regions pop via the existing word-background +
//   add/del line-number treatment; syntax colors reused per cell.
// - hunks only (configurable context in the engine) — never whole files.
// - width-aware: panes split the width actually available to this view — an
//   explicit `columns` (callers inside a frame pass
//   layout.frameContentWidth of their frame) or the measured terminal
//   (useThrottledTerminalSize, same pattern as StatusBarHost) minus the App
//   inset; long lines truncate per pane with … (code-point safe); below
//   NARROW_COLUMNS the view degrades to the stacked unified DiffView instead
//   of destroying the layout.
// - computed once per mount (useMemo, keyed on inputs + pane width) and
//   rendered whole (an explicit maxRows windows it when a caller passes one)
//   — never recomputed per tick, never floods via re-computation.
// All paint comes from ui/theme tokens.
import React from "react";
import { Box, Text } from "ink";
import { computeSideBySide, rangeLabel, sbsRange, wordRuns, type SBSRow, type WordRun } from "./diff.js";
import { DiffSummary, DiffView, LineBody } from "./diff-view.js";
import { theme } from "./theme.js";
import { useThrottledTerminalSize } from "./layout.js";

export type SideBySideDiffViewProps = {
  oldText: string | null; // null = new file (all additions)
  newText: string;
  lang?: string | null;
  // Tool-arg path for the shared summary header (null/absent = counts +
  // range only). Threaded from the DiffPreview payload — never invented.
  path?: string | null;
  // Max rendered rows (context + change). An explicit value windows the
  // list with a dim "… N more rows" trailer; the default renders
  // everything. Defaults to Infinity.
  maxRows?: number;
  // Terminal width override (tests). Callers inside a framed surface (a
  // bordered Box with padding) must pass that frame's CONTENT width —
  // layout.frameContentWidth(frameWidth, paddingX) — never the terminal
  // width: the frame is capped (widgetWidth) and inset, so terminal-derived
  // panes overflow the box and Ink clips the right pane at the border.
  // Default: throttled live terminal size minus the App inset, else 100.
  columns?: number;
};

// Below this width two panes cannot breathe — stack unified instead.
export const SBS_NARROW_COLUMNS = 70;

// Uncapped: views render the full row list (smooth via per-mount useMemo +
// append-once Static + word-token/Myers fallbacks in the engine). maxRows
// remains as an opt-in window for callers/tests that want a collapsed tail.
// Retained for compatibility.
export const TRANSCRIPT_DIFF_MAX_LINES = Infinity;

type DisplayCell = { no: number | null; text: string; runs: WordRun[] } | null;
type DisplayRow =
  | { kind: "context"; left: { no: number; text: string }; right: { no: number; text: string } }
  | { kind: "change"; changed: boolean; left: DisplayCell; right: DisplayCell };

// Terminal-cell width helpers: the old truncateTo/padEnd counted code
// points, so tabs (1 cp, N columns), CJK/emoji (1 cp, 2 columns), and
// unpadded short lines all shifted the │ separator per row — the "messy
// spacing" in the report. These helpers normalize first, then measure in
// terminal cells so every row tiles exactly paneW + sep + paneW.
function expandTabs(s: string): string {
  // Repo indent is 2 spaces; a tab becomes 2 columns (compact, stable).
  return s.replace(/\t/g, "  ");
}

function cellWidth(ch: string): number {
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

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of expandTabs(s)) w += cellWidth(ch);
  return w;
}

function truncateTo(s: string, width: number): string {
  const src = expandTabs(s);
  if (displayWidth(src) <= width) return src;
  if (width < 4) return "";
  const ell = theme.symbol.ellipsis; // 1 cell
  let w = 0;
  let out = "";
  for (const ch of src) {
    const cw = cellWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + ell;
}

function padDisplay(s: string, width: number): string {
  const src = expandTabs(s);
  const w = displayWidth(src);
  if (w >= width) return src;
  return src + " ".repeat(width - w);
}

// Fit engine rows to a pane content width: truncate cell texts (with …)
// and re-derive word runs on the truncated pair so offsets always tile
// the displayed text. Runs once per mount/width — never per tick.
function fitRows(rows: SBSRow[], contentW: number): DisplayRow[] {
  return rows.map((r) => {
    if (r.kind === "context") {
      return {
        kind: "context",
        left: { no: r.oldNo, text: truncateTo(r.text, contentW) },
        right: { no: r.newNo, text: truncateTo(r.text, contentW) },
      };
    }
    const tOld = r.oldText !== null ? truncateTo(r.oldText, contentW) : null;
    const tNew = r.newText !== null ? truncateTo(r.newText, contentW) : null;
    let oldRuns: WordRun[] = [];
    let newRuns: WordRun[] = [];
    if (tOld !== null && tNew !== null) {
      const w = wordRuns(tOld, tNew);
      oldRuns = w.del;
      newRuns = w.add;
    } else if (tOld !== null) {
      oldRuns = tOld === "" ? [] : [{ text: tOld, changed: false }];
    } else if (tNew !== null) {
      newRuns = tNew === "" ? [] : [{ text: tNew, changed: false }];
    }
    const changed =
      oldRuns.some((x) => x.changed) ||
      newRuns.some((x) => x.changed) ||
      (r.oldText === null) !== (r.newText === null);
    return {
      kind: "change",
      changed,
      left: tOld !== null ? { no: r.oldNo, text: tOld, runs: oldRuns } : null,
      right: tNew !== null ? { no: r.newNo, text: tNew, runs: newRuns } : null,
    };
  });
}

function padEnd(s: string, width: number): string {
  return padDisplay(s, width);
}

function SideBySideInner({
  oldText,
  newText,
  lang = null,
  path = null,
  maxRows = Infinity,
  columns,
}: SideBySideDiffViewProps) {
  let throttledCols: number | undefined;
  try {
    throttledCols = useThrottledTerminalSize(64).columns;
  } catch {
    throttledCols = undefined;
  }
  // Row budget in terminal cells. An explicit `columns` is the caller's
  // content box and is exact (the caller already subtracted its own border
  // and padding). Otherwise measure the live terminal — throttled, so a
  // resize coalesces and never recomputes per drag event — and reserve the
  // App inset (2 cols) for the bare/frameless case.
  const totalW = columns ?? (throttledCols === undefined ? 100 : Math.max(1, throttledCols - 2));
  // Diff computation is expensive (Myers + wordRuns) – memoize on content only,
  // not on width. Width only affects the cheap `fitRows` step below.
  const sbs = React.useMemo(() => computeSideBySide(oldText, newText), [oldText, newText]);

  if (sbs.kind === "same") {
    return <Text dimColor>(no changes — file unchanged)</Text>;
  }
  if (sbs.kind === "binary") {
    return <Text dimColor>binary file changed</Text>;
  }
  if (sbs.kind === "skipped") {
    return <Text dimColor>{sbs.reason}</Text>;
  }
  // Graceful narrow-terminal degrade: stacked unified keeps every char
  // instead of crushing two panes into unreadable slivers.
  if (totalW < SBS_NARROW_COLUMNS) {
    return <DiffView oldText={oldText} newText={newText} lang={lang} path={path} maxLines={maxRows} />;
  }

  const sep = ` ${theme.symbol.bar} `;
  // `totalW` is already the width this view owns, so the rows tile it
  // directly: paneW + separator + paneW never exceeds it and the bordered
  // frame that holds us never has to clip a row.
  const availW = Math.max(SBS_NARROW_COLUMNS, totalW);
  const sepW = displayWidth(sep);
  const paneW = Math.max(20, Math.floor((availW - sepW) / 2));
  let maxNo = 0;
  for (const r of sbs.rows) {
    if (r.kind === "context") maxNo = Math.max(maxNo, r.oldNo, r.newNo);
    else {
      if (r.oldNo !== null) maxNo = Math.max(maxNo, r.oldNo);
      if (r.newNo !== null) maxNo = Math.max(maxNo, r.newNo);
    }
  }
  const numW = String(Math.max(maxNo, 1)).length;
  const contentW = Math.max(8, paneW - numW - 1);
  const view = React.useMemo(
    () => fitRows(sbs.rows, contentW),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sbs, contentW]
  );
  const shown = view.slice(0, maxRows);
  const overflow = Math.max(0, view.length - shown.length);

  // Every cell tiles exactly numW + 1 + contentW cells: the body text is
  // already truncated to contentW by fitRows, so trailing spaces pad it to
  // full width and the │ separator lands in the same column every row.
  const renderCell = (
    no: number | null,
    bodyText: string,
    body: React.ReactNode,
    opts: { dim?: boolean; numColor?: string }
  ) => {
    const num = no === null ? " ".repeat(numW) : padEnd(String(no), numW);
    const pad = " ".repeat(Math.max(0, contentW - displayWidth(bodyText)));
    return (
      <Text wrap="truncate">
        <Text color={opts.numColor} dimColor={opts.numColor === undefined || opts.dim}>
          {num}{" "}
        </Text>
        {body}
        {pad}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <DiffSummary
        adds={sbs.adds}
        dels={sbs.dels}
        isNewFile={sbs.isNewFile}
        path={path}
        range={sbs.isNewFile ? null : rangeLabel(sbsRange(sbs.rows))}
      />
      {shown.map((r, k) => {
        if (r.kind === "context") {
          return (
            <Text key={k} wrap="truncate">
              {renderCell(r.left.no, r.left.text, <Text dimColor>{r.left.text}</Text>, { dim: true })}
              <Text dimColor>{sep}</Text>
              {renderCell(r.right.no, r.right.text, <Text dimColor>{r.right.text}</Text>, { dim: true })}
            </Text>
          );
        }
        const leftNumColor = r.left !== null && r.changed ? theme.color.toolError : undefined;
        const rightNumColor =
          r.right !== null && r.changed ? theme.color.success : undefined;
        return (
          <Text key={k} wrap="truncate">
            {r.left !== null
              ? renderCell(
                  r.left.no,
                  r.left.text,
                  <LineBody lineText={r.left.text} runs={r.left.runs} base="del" lang={lang} />,
                  { numColor: leftNumColor, dim: !r.changed }
                )
              : renderCell(null, "", <Text>{""}</Text>, { dim: true })}
            <Text dimColor>{sep}</Text>
            {r.right !== null
              ? renderCell(
                  r.right.no,
                  r.right.text,
                  <LineBody lineText={r.right.text} runs={r.right.runs} base="add" lang={lang} />,
                  { numColor: rightNumColor, dim: !r.changed }
                )
              : renderCell(null, "", <Text>{""}</Text>, { dim: true })}
          </Text>
        );
      })}
      {overflow > 0 ? <Text dimColor>{theme.symbol.ellipsis} {overflow} more row{overflow === 1 ? "" : "s"}</Text> : null}
      {sbs.truncated ? <Text dimColor>(diff truncated at 400 changed lines)</Text> : null}
    </Box>
  );
}

export const SideBySideDiffView = React.memo(SideBySideInner);
