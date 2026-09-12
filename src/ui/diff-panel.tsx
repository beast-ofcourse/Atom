// Session-changes review panel for /diff: file list + unified detail.
//
// Claude-Code parity, ATOM-ified: Claude's /diff has Current (git) and
// per-turn tabs; ATOM v1 reviews SESSION changes — the committed
// write/edit previews grouped by file, latest preview per path wins.
// (A git working-tree tab needs git-subprocess plumbing; explicitly out
// of scope for this chunk — the panel is built to take more sources.)
//
// Interaction mirrors the tool-output inspector (ui/tool-inspector):
// list (↑/↓ + Enter, windowed) ⇄ detail (↑/↓ switches files, Enter/Esc
// back, Esc closes). Per-line scrolling inside the detail is a stated
// non-goal: the detail renders the full preview (uncapped), and session
// previews stay smooth via the per-mount memo + engine word fallbacks.
// All paint comes from ui/theme tokens.
import React from "react";
import { Box, Text } from "ink";
import { computeDiff, type DiffPreview } from "./diff.js";
import { SideBySideDiffView } from "./side-by-side.js";
import { theme } from "./theme.js";
import { LIST_WINDOW, windowedList } from "./tool-inspector.js";

export type SessionFileDiff = {
  path: string;
  oldText: string | null;
  newText: string;
  lang: string | null;
  adds: number;
  dels: number;
};

// Retained for compatibility (no longer applied — the panel renders the
// full preview; smoothness comes from the per-mount memo + word fallbacks,
// not from a row cap).
export const DIFF_PANEL_MAX_LINES = Infinity;

// Group committed session previews by file: latest preview per path
// wins (a later edit supersedes the earlier view of the same file),
// first-seen path order kept. Previews without a path are ungroupable
// (they still render inline in the transcript) and skipped here.
// Pure — shared by the App opener and unit tests.
export function groupSessionDiffs(
  turns: { diff?: DiffPreview | null }[]
): SessionFileDiff[] {
  const byPath = new Map<string, DiffPreview>();
  for (const t of turns) {
    const d = t.diff;
    if (!d || !d.path) continue;
    byPath.set(d.path, d);
  }
  const files: SessionFileDiff[] = [];
  for (const [p, d] of byPath) {
    let adds = 0;
    let dels = 0;
    try {
      const r = computeDiff(d.oldText, d.newText);
      adds = r.adds;
      dels = r.dels;
    } catch {
      // A preview that fails to diff still lists (counts stay 0) —
      // review must never crash on data it already rendered inline.
    }
    files.push({ path: p, oldText: d.oldText, newText: d.newText, lang: d.lang, adds, dels });
  }
  return files;
}

export type DiffPanelProps = {
  files: SessionFileDiff[];
  index: number;
  expanded: boolean;
};

export function DiffPanel({ files, index, expanded }: DiffPanelProps) {
  const sel = Math.max(0, Math.min(index, files.length - 1));
  const rec = files[sel];
  if (!rec) return null;

  if (!expanded) {
    const win = windowedList(files, sel, LIST_WINDOW);
    return (
      <Box flexDirection="column">
        <Text bold>Session changes — select a file to review (Enter expands, Esc closes):</Text>
        {win.above > 0 ? (
          <Text dimColor>
            {theme.symbol.moreAbove} {win.above} more
          </Text>
        ) : null}
        {win.slice.map((r, k) => {
          const i = win.start + k;
          const hi = i === sel;
          return (
            <Text key={r.path} color={hi ? theme.color.selection : undefined}>
              {hi ? `${theme.symbol.select} ` : theme.spacing.rowIndent}+{r.adds} −{r.dels} {r.path}
            </Text>
          );
        })}
        {win.below > 0 ? (
          <Text dimColor>
            {theme.symbol.moreBelow} {win.below} more
          </Text>
        ) : null}
        <Text dimColor>
          {theme.symbol.moreAbove}/{theme.symbol.moreBelow} move · Enter expands · Esc closes
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <SideBySideDiffView
        oldText={rec.oldText}
        newText={rec.newText}
        lang={rec.lang}
        path={rec.path}
      />
      <Text dimColor>
        {theme.symbol.moreAbove}/{theme.symbol.moreBelow} prev/next file · Enter collapses · Esc
        closes
      </Text>
    </Box>
  );
}
