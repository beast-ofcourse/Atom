// Approval-time + transcript diff view: the unified, word-highlighted,
// syntax-colored preview for write/edit calls.
//
// The view owns its own wrapping. Ink wraps whatever string it is handed, so a
// row that carries a line-number gutter and a `-`/`+` marker would lose both on
// the continuation row and read as a context line — the reported "diff is cut
// off / text floats outside the block". Instead every logical diff line is
// pre-wrapped by ui/diff-layout (word boundaries, hard split for tokens wider
// than the body, tabs expanded once) and rendered as rows that already fit,
// each `wrap="truncate"` so Ink can never re-wrap and break the geometry.
//
// Layout, one terminal row per display row (gutter = old no, new no, marker,
// rule; the marker and the line's own indentation repeat on continuation rows):
//
//   +1 −1 · src/http/profile.ts · L3
//   @@ -1,5 +1,5 @@
//   1 1   │ // header
//   3   - │ const result = await fetchUserProfile(userId, {
//       - │     includePermissions: false, timeoutMs: 15000 });
//     3 + │ const result = await fetchUserProfile(userId, {
//       + │     includePermissions: true, timeoutMs: 15000 });
//
// Width is owned by the caller: `columns` is the exact content width (an
// approval frame passes its content box, /diff passes its own). With no
// `columns` the view measures the terminal and reserves the App inset. It
// never applies the 100-column widget cap — a framed surface is the one that
// must hand in its real box.
//
// All paint comes from ui/theme tokens (Ink supports color + backgroundColor
// on Text — verified against the installed Ink 7 typings).
import React from "react";
import { Box, Text } from "ink";
import { computeDiff, hunksRange, rangeLabel, type DiffHunk, type DiffResult, type WordRun } from "./diff.js";
import { highlightLine, isHighlightLang, type SyntaxKind } from "./highlight.js";
import { rowWindow, wrapLine, type Segment } from "./diff-layout.js";
import { useThrottledTerminalSize } from "./layout.js";
import { theme } from "./theme.js";

export type DiffViewProps = {
  oldText: string | null; // null = new file (all additions)
  newText: string;
  // Highlight family id ("c"/"py"/"sh"/"data", see ui/highlight).
  // Null/unknown = plain paint (add/del line tint, as before).
  lang?: string | null;
  // Tool-arg path for the shared summary header (null/absent = counts +
  // range only). Threaded from the DiffPreview payload — never invented.
  path?: string | null;
  // Rendered body-row budget (hunk headers excluded). A windowed list ends
  // with a dim "… N more rows" trailer. Defaults to the transcript window.
  maxRows?: number;
  // Scroll offset in rendered rows, for callers that own a fixed viewport
  // (/diff's detail pane). Clamped to the last full window; an offset above
  // the window prints a "↑ N more rows" hint.
  scroll?: number;
  // Exact content width in terminal cells. Absent = measure the terminal and
  // reserve the App inset. A framed caller MUST pass its content box.
  columns?: number;
};

// Transcript window: enough rows to read a real change, few enough that a
// 400-changed-line diff cannot push the composer off screen (committed rows
// live in Ink's scrollback, so they are never reclaimed).
export const TRANSCRIPT_DIFF_MAX_ROWS = 60;

// Columns the App reserves around the transcript (one cell per side).
const APP_INSET = 2;

// Smallest body the wrapper will produce. Below this the gutter alone is wider
// than the terminal; rows then exceed the box and Ink clips them, the least-bad
// outcome at a width where nothing else can fit either.
const MIN_BODY_COLUMNS = 8;

function syntaxColor(kind: SyntaxKind): string | undefined {
  if (kind === "keyword") return theme.color.synKeyword;
  if (kind === "string") return theme.color.synString;
  if (kind === "number") return theme.color.synNumber;
  return undefined; // comment → dim, plain → line paint
}

// One diff line body, painted from pre-split segments. Segmentation happens
// once per row inside the parent's layout memo (ui/diff-layout), so this
// component only maps segment → <Text>: it can no longer misalign a
// changed-word run against a syntax span with two cursor offsets, which is
// where a split run used to paint the wrong characters.
//
// Memoized: `segments` keeps identity from that memo, so unrelated parent
// renders (busy ticks, keystrokes, appends elsewhere) skip the map entirely.
export const LineBody = React.memo(function LineBody({
  segments,
  base,
  lang,
}: {
  segments: readonly Segment[];
  base: "add" | "del";
  lang: string | null;
}) {
  const baseColor = base === "add" ? theme.color.success : theme.color.toolError;
  const hlBg = base === "add" ? theme.color.diffAddBg : theme.color.diffDelBg;
  // Unknown language: plain text keeps the line's add/del tint (the +/- marker
  // is the only identity there). Known language: syntax hues paint, plain text
  // stays terminal-default so the code reads like code.
  const tintPlain = !isHighlightLang(lang);
  return (
    <Text color={tintPlain ? baseColor : undefined}>
      {segments.map((segment, k) => {
        if (segment.changed) {
          // Changed words keep the high-contrast background treatment —
          // syntax hues would muddy the signal.
          return (
            <Text key={k} backgroundColor={hlBg} color={theme.color.diffChangedFg} bold>
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === "comment") {
          return (
            <Text key={k} dimColor>
              {segment.text}
            </Text>
          );
        }
        const fg =
          segment.kind === null || segment.kind === "plain"
            ? tintPlain
              ? baseColor
              : undefined
            : syntaxColor(segment.kind);
        return (
          <Text key={k} color={fg}>
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
});

// Ticket 02 signature header: ONE quiet dim line — change counts, path,
// line range — shared verbatim by the unified view, the side-by-side view
// (ui/side-by-side), the approval modal, the committed transcript, and the
// /diff review. Changed rows carry +/- color + word backgrounds; context
// rows stay dim so unchanged text reads subordinate.
export function DiffSummary({
  adds,
  dels,
  isNewFile,
  path,
  range,
}: {
  adds: number;
  dels: number;
  isNewFile: boolean;
  path?: string | null;
  range?: string | null;
}) {
  return (
    <Text dimColor>
      {isNewFile ? "new file " : ""}+{adds} −{dels}
      {path ? ` ${theme.symbol.separator} ${path}` : ""}
      {range ? ` ${theme.symbol.separator} ${range}` : ""}
    </Text>
  );
}

// One wording for the no-op case, shared with the side-by-side view: a
// preview whose inputs are byte-identical reports the file as unchanged, so
// both layouts read the same in the transcript.
export const UNCHANGED_NOTICE = "no changes — file unchanged";

type LineKind = "context" | "del" | "add";

// A hunk line with the file line numbers the hunk header implies. The engine
// carries no per-line numbers, so they are derived the way `git diff` does:
// context advances both sides, a deletion advances old only, an addition new
// only. `showOld` is false for a new file (no old side to number).
type NumberedLine = {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  runs: WordRun[];
};

function numberHunk(hunk: DiffHunk, showOld: boolean): NumberedLine[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => {
    if (line.kind === "context") {
      const numbered: NumberedLine = {
        kind: "context",
        oldNo: showOld ? oldNo : null,
        newNo,
        text: line.text,
        runs: [],
      };
      oldNo += 1;
      newNo += 1;
      return numbered;
    }
    if (line.kind === "del") {
      const numbered: NumberedLine = {
        kind: "del",
        oldNo: showOld ? oldNo : null,
        newNo: null,
        text: line.text,
        runs: line.runs,
      };
      oldNo += 1;
      return numbered;
    }
    const numbered: NumberedLine = {
      kind: "add",
      oldNo: null,
      newNo,
      text: line.text,
      runs: line.runs,
    };
    newNo += 1;
    return numbered;
  });
}

// One rendered row. Numbers are null on continuation rows (only the first row
// of a wrapped line carries them); the marker and the paint stay.
type BodyRow = {
  kind: LineKind;
  marker: " " | "-" | "+";
  markerColor: string | undefined;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  segments: Segment[];
};

type HunkBlock = { header: string; rows: BodyRow[] };

// "<old> <new> <marker> │ ": two number columns, the +/- marker, the rule and
// the space that starts the body. The numbers are variable width, the rest is
// fixed, so this is the constant part of the gutter width.
const GUTTER_FIXED = 6;

// Whole diff → wrapped, numbered, gutter-ready blocks plus the gutter widths
// the rows were sized against. Runs once per (diff, width, lang): the busy
// tick repaints from the memo, never re-wraps.
function buildLayout(
  diff: DiffResult,
  contentW: number,
  lang: string | null
): { blocks: HunkBlock[]; oldW: number; newW: number } {
  const showOld = !diff.isNewFile;
  const numbered = diff.hunks.map((hunk) => numberHunk(hunk, showOld));

  let oldW = 0;
  let newW = 0;
  for (const lines of numbered) {
    for (const line of lines) {
      if (line.oldNo !== null) oldW = Math.max(oldW, String(line.oldNo).length);
      if (line.newNo !== null) newW = Math.max(newW, String(line.newNo).length);
    }
  }
  const bodyW = Math.max(MIN_BODY_COLUMNS, contentW - (oldW + newW + GUTTER_FIXED));
  const langKnown = isHighlightLang(lang);

  const blocks = diff.hunks.map((hunk, hi) => {
    const rows = numbered[hi]!.flatMap((line): BodyRow[] => {
      // Context rows stay plain dim (unchanged text is subordinate); changed
      // rows get the syntax + word paint.
      const spans = langKnown && line.kind !== "context" ? highlightLine(line.text, lang) : [];
      const wrapped = wrapLine(line.text, bodyW, line.runs, spans);
      const marker: BodyRow["marker"] =
        line.kind === "del" ? "-" : line.kind === "add" ? "+" : " ";
      const markerColor =
        line.kind === "del" ? theme.color.toolError : line.kind === "add" ? theme.color.success : undefined;
      return wrapped.map((row, ri) => ({
        kind: line.kind,
        marker,
        markerColor,
        oldNo: ri === 0 ? line.oldNo : null,
        newNo: ri === 0 ? line.newNo : null,
        text: row.text,
        segments: row.segments,
      }));
    });
    return { header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, rows };
  });
  return { blocks, oldW, newW };
}

function padNumber(no: number | null, width: number): string {
  if (width === 0) return "";
  if (no === null) return " ".repeat(width);
  return String(no).padStart(width, " ");
}

function DiffViewInner({
  oldText,
  newText,
  lang = null,
  path = null,
  maxRows = TRANSCRIPT_DIFF_MAX_ROWS,
  scroll = 0,
  columns,
}: DiffViewProps) {
  // Hooks run before every early return: the width is measured even when the
  // diff turns out to be binary/skipped/unchanged.
  const terminal = useThrottledTerminalSize(64);
  const diff = React.useMemo(() => computeDiff(oldText, newText), [oldText, newText]);
  const contentW = Math.max(1, columns ?? terminal.columns - APP_INSET);
  const { blocks, oldW, newW } = React.useMemo(
    () =>
      diff.hunks.length === 0
        ? { blocks: [], oldW: 0, newW: 0 }
        : buildLayout(diff, contentW, lang),
    [diff, contentW, lang]
  );

  if (diff.skipped) {
    return <Text dimColor>{diff.skipped}</Text>;
  }
  if (diff.hunks.length === 0) {
    // Empty hunks mean identical inputs (the engine's no-op short-circuit);
    // anything else (an empty new file) has no body to show.
    const unchanged = oldText !== null && oldText === newText;
    return <Text dimColor>({unchanged ? UNCHANGED_NOTICE : "no visible changes"})</Text>;
  }

  // Scroll window over the wrapped body rows. Hunk headers are chrome, so a
  // page holds the same number of code rows at any offset.
  const totalRows = blocks.reduce((sum, block) => sum + block.rows.length, 0);
  const { start, end } = rowWindow(totalRows, maxRows, scroll);
  const belowRows = totalRows - end;

  const renderRow = (row: BodyRow, key: string): React.ReactNode => (
    <Text key={key} wrap="truncate">
      <Text dimColor>
        {padNumber(row.oldNo, oldW)} {padNumber(row.newNo, newW)}{" "}
      </Text>
      <Text color={row.markerColor} dimColor={row.markerColor === undefined}>
        {row.marker}
      </Text>
      <Text dimColor> {theme.symbol.bar} </Text>
      {row.kind === "context" ? (
        <Text dimColor>{row.text}</Text>
      ) : (
        <LineBody segments={row.segments} base={row.kind} lang={lang} />
      )}
    </Text>
  );

  const rendered: React.ReactNode[] = [];
  // A hunk whose body is entirely outside the window prints no header — an
  // orphan "@@" above nothing reads as a corruption, not as a window.
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
        <Text dimColor>{block.header}</Text>
        {block.rows.slice(from, to).map((row, ri) => renderRow(row, `${bi}-${from + ri}`))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <DiffSummary
        adds={diff.adds}
        dels={diff.dels}
        isNewFile={diff.isNewFile}
        path={path}
        range={diff.isNewFile ? null : rangeLabel(hunksRange(diff.hunks))}
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

export const DiffView = React.memo(DiffViewInner);
