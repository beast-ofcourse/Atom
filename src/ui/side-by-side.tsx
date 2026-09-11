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
// - width-aware: panes split the measured terminal (local useStdout, same
//   pattern as StatusBarHost); long lines truncate per pane with …
//   (code-point safe); below NARROW_COLUMNS the view degrades to the
//   stacked unified DiffView instead of destroying the layout.
// - computed once per mount (useMemo, keyed on inputs + pane width) and
//   capped (maxRows + trailer) — never recomputed per tick, never floods.
// All paint comes from ui/theme tokens.
import React from "react";
import { Box, Text } from "ink";
import { useStdout } from "ink";
import { computeSideBySide, wordRuns, type SBSRow, type WordRun } from "./diff.js";
import { DiffView, LineBody } from "./diff-view.js";
import { theme } from "./theme.js";

export type SideBySideDiffViewProps = {
  oldText: string | null; // null = new file (all additions)
  newText: string;
  lang?: string | null;
  // Max rendered rows (context + change). Extra rows collapse into a
  // dim "… N more rows" trailer. Defaults to Infinity.
  maxRows?: number;
  // Terminal width override (tests). Default: live useStdout, else 100.
  columns?: number;
};

// Below this width two panes cannot breathe — stack unified instead.
export const SBS_NARROW_COLUMNS = 70;

// Committed-transcript cap (rows, context + change): the scrollback shows
// the reviewable head; the file on disk is the whole truth. The engine
// still truncates past 400 changed lines with its own notice.
export const TRANSCRIPT_DIFF_MAX_LINES = 120;

type DisplayCell = { no: number | null; text: string; runs: WordRun[] } | null;
type DisplayRow =
  | { kind: "context"; left: { no: number; text: string }; right: { no: number; text: string } }
  | { kind: "change"; changed: boolean; left: DisplayCell; right: DisplayCell };

function truncateTo(s: string, width: number): string {
  const chars = [...s];
  if (chars.length <= width) return s;
  if (width < 4) return "";
  return chars.slice(0, width - 1).join("") + theme.symbol.ellipsis;
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
  const len = [...s].length;
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

function SideBySideInner({
  oldText,
  newText,
  lang = null,
  maxRows = Infinity,
  columns,
}: SideBySideDiffViewProps) {
  let stdoutCols: number | undefined;
  try {
    stdoutCols = useStdout()?.stdout?.columns;
  } catch {
    stdoutCols = undefined;
  }
  const totalW = columns ?? stdoutCols ?? 100;
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
    return <DiffView oldText={oldText} newText={newText} lang={lang} maxLines={maxRows} />;
  }

  const sep = ` ${theme.symbol.bar} `;
  const paneW = Math.max(20, Math.floor((totalW - sep.length) / 2));
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

  const renderCell = (
    no: number | null,
    body: React.ReactNode,
    opts: { dim?: boolean; numColor?: string }
  ) => {
    const num = no === null ? " ".repeat(numW) : padEnd(String(no), numW);
    return (
      <Text>
        <Text color={opts.numColor} dimColor={opts.numColor === undefined || opts.dim}>
          {num}{" "}
        </Text>
        {body}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {sbs.isNewFile ? "new file " : ""}+{sbs.adds} −{sbs.dels}
      </Text>
      <Text>
        <Text bold>{padEnd("BEFORE", paneW)}</Text>
        <Text dimColor>{sep}</Text>
        <Text bold>AFTER</Text>
      </Text>
      {shown.map((r, k) => {
        if (r.kind === "context") {
          return (
            <Text key={k}>
              {renderCell(r.left.no, <Text dimColor>{r.left.text}</Text>, { dim: true })}
              <Text dimColor>{sep}</Text>
              {renderCell(r.right.no, <Text dimColor>{r.right.text}</Text>, { dim: true })}
            </Text>
          );
        }
        const leftNumColor = r.left !== null && r.changed ? theme.color.toolError : undefined;
        const rightNumColor =
          r.right !== null && r.changed ? theme.color.success : undefined;
        return (
          <Text key={k}>
            {r.left !== null
              ? renderCell(
                  r.left.no,
                  <LineBody lineText={r.left.text} runs={r.left.runs} base="del" lang={lang} />,
                  { numColor: leftNumColor, dim: !r.changed }
                )
              : renderCell(null, <Text>{padEnd("", contentW)}</Text>, { dim: true })}
            <Text dimColor>{sep}</Text>
            {r.right !== null
              ? renderCell(
                  r.right.no,
                  <LineBody lineText={r.right.text} runs={r.right.runs} base="add" lang={lang} />,
                  { numColor: rightNumColor, dim: !r.changed }
                )
              : renderCell(null, <Text>{padEnd("", contentW)}</Text>, { dim: true })}
          </Text>
        );
      })}
      {overflow > 0 ? <Text dimColor>… {overflow} more row{overflow === 1 ? "" : "s"}</Text> : null}
      {sbs.truncated ? <Text dimColor>(diff truncated at 400 changed lines)</Text> : null}
    </Box>
  );
}

export const SideBySideDiffView = React.memo(SideBySideInner);
