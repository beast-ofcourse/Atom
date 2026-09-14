// Tool-output inspector: browse + expand past tool results without
// destroying transcript readability.
//
// Why a separate panel: committed <Static> items freeze on commit, so
// expand/collapse can never happen in the scrollback itself. Instead the
// TUI retains each tool result (display-only, capped) and this panel —
// mounted in the dynamic zone in place of the input — renders the browse
// list and the scrollable expanded view. No execution code is touched:
// records arrive from the existing onToolActivity payloads.
//
// Performance: the expanded view renders only a fixed viewport slice;
// stored results are char-capped with an explicit truncation flag; the
// record list itself is capped and windowed.
import React from "react";
import { Box, Text } from "ink";
import { truncateHead } from "../tools/shared.js";
import { theme } from "./theme.js";
import { useTerminalSize } from "./layout.js";

export const MAX_TOOL_RECORDS = 50;
export const STORE_CHARS = 32768;
export const VIEWPORT_LINES = 20;
export const LIST_WINDOW = 15;

export type ToolRecord = {
  id: number;
  label: string;
  result: string;
  truncated: boolean;
  isError: boolean;
  ms: number;
  lineCount: number;
};

export function createToolRecord(
  id: number,
  label: string,
  result: string,
  isError: boolean,
  ms: number
): ToolRecord {
  const text = result ?? "";
  const truncated = text.length > STORE_CHARS;
  // Line-aware store cap (issue 04): the stored head never ends mid-line.
  // Single-giant-line inputs keep the hard cut (documented tail edge case),
  // so over-cap single-line results still store exactly STORE_CHARS.
  const stored = truncated
    ? truncateHead(text, STORE_CHARS, "\n[truncated: stored output exceeded 32KB]").head
    : text;
  return {
    id,
    label,
    result: stored,
    truncated,
    isError,
    ms,
    lineCount: stored.length === 0 ? 0 : stored.split("\n").length,
  };
}

// Centered window over a list: {slice, start, above, below}. Pure — the
// panel and its tests share it.
export function windowedList<T>(items: T[], index: number, size: number): {
  slice: T[];
  start: number;
  above: number;
  below: number;
} {
  if (items.length <= size) return { slice: items, start: 0, above: 0, below: 0 };
  const half = Math.floor(size / 2);
  let start = Math.max(0, Math.min(index - half, items.length - size));
  return {
    slice: items.slice(start, start + size),
    start,
    above: start,
    below: items.length - (start + size),
  };
}

// Collapsed one-liner state (ticket 03): running lives in the live tail
// (never retained), so retained rows are terminal — success, failed, or
// denied. Denials arrive as error results whose text names the denial
// (loop's `Error: denied by user: <name>`, same grammar the ticket-04
// classifier reads); they render with the calm denied glyph, never the
// failure cross. Pure — rows and the expanded header share it.
export type ToolBlockState = "ok" | "failed" | "denied";

export function toolBlockState(rec: Pick<ToolRecord, "isError" | "label" | "result">): ToolBlockState {
  if (rec.isError && /denied by user/i.test(`${rec.label} ${rec.result}`)) return "denied";
  return rec.isError ? "failed" : "ok";
}

const TOOL_STATE_GLYPH: Record<ToolBlockState, string> = {
  ok: theme.symbol.toolOk,
  failed: theme.symbol.toolFail,
  denied: theme.symbol.toolDenied,
};

function formatDur(ms: number): string {
  return ` ${theme.symbol.separator} ${Math.max(1, Math.round(ms / 1000))}s`;
}

export type InspectorPanelProps = {
  records: ToolRecord[];
  index: number;
  expanded: boolean;
  scroll: number;
};

export function InspectorPanel({ records, index, expanded, scroll }: InspectorPanelProps) {
  const sel = Math.max(0, Math.min(index, records.length - 1));
  const rec = records[sel];
  if (!rec) return null;
  let columns = 80;
  try {
    columns = useTerminalSize().columns;
  } catch {
    columns = 80;
  }
  const ruleLen = Math.max(10, Math.min(32, columns - 4));

  if (!expanded) {
    const win = windowedList(records, sel, LIST_WINDOW);
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">Tool outputs {theme.symbol.descSeparator} select to inspect (Enter expands, Esc closes):</Text>
        {win.above > 0 ? (
          <Text dimColor>
            {theme.symbol.moreAbove} {win.above} more
          </Text>
        ) : null}
        {win.slice.map((r, k) => {
          const i = win.start + k;
          const hi = i === sel;
          const st = toolBlockState(r);
          return (
            <Text
              key={r.id}
              wrap="truncate"
              color={
                hi
                  ? theme.color.selection
                  : st === "failed"
                    ? theme.color.toolError
                    : st === "denied"
                      ? theme.color.warning
                      : undefined
              }
            >
              {hi ? `${theme.symbol.select} ` : theme.spacing.rowIndent}
              {TOOL_STATE_GLYPH[st]}{" "}
              {r.label}
              {r.ms >= 2000 ? formatDur(r.ms) : ""}
            </Text>
          );
        })}
        {win.below > 0 ? (
          <Text dimColor>
            {theme.symbol.moreBelow} {win.below} more
          </Text>
        ) : null}
        <Text dimColor wrap="truncate">
          {theme.symbol.moreAbove}/{theme.symbol.moreBelow} move · Enter/Ctrl+O expands · Esc closes
        </Text>
      </Box>
    );
  }

  const lines = rec.result.split("\n");
  const total = lines.length;
  const maxOffset = Math.max(0, total - VIEWPORT_LINES);
  const off = Math.max(0, Math.min(scroll, maxOffset));
  const view = lines.slice(off, off + VIEWPORT_LINES);
  const rule = theme.symbol.rule.repeat(ruleLen);
  const expandedState = toolBlockState(rec);
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">
        <Text
          color={
            expandedState === "failed"
              ? theme.color.toolError
              : expandedState === "denied"
                ? theme.color.warning
                : theme.color.success
          }
        >
          {TOOL_STATE_GLYPH[expandedState]}{" "}
        </Text>
        {rec.label}
        {rec.ms >= 2000 ? formatDur(rec.ms) : ""}
        <Text dimColor>
          {" "}
          {theme.symbol.separator} {rec.lineCount} line{rec.lineCount === 1 ? "" : "s"}
        </Text>
      </Text>
      {rec.truncated ? (
        <Text dimColor wrap="wrap">(stored output truncated at {Math.round(STORE_CHARS / 1024)}KB)</Text>
      ) : null}
      <Text dimColor wrap="truncate">{rule}</Text>
      {view.map((ln, k) => (
        <Text key={off + k} wrap="wrap">{ln.length > 0 ? ln : " "}</Text>
      ))}
      <Text dimColor wrap="truncate">{rule}</Text>
      <Text dimColor wrap="truncate">
        {off > 0 ? `${theme.symbol.moreAbove} ${off} more ` : ""}
        {theme.symbol.moreAbove}/{theme.symbol.moreBelow} scroll · PgUp/PgDn jump · Enter/Ctrl+O collapses · Esc closes
        {maxOffset - off > 0 ? ` ${theme.symbol.moreBelow} ${maxOffset - off} more` : ""}
      </Text>
    </Box>
  );
}
