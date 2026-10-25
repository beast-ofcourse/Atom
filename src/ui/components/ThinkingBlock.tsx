// ThinkingBlock: the single canonical thinking renderer.
//
// Contract:
//   props.content — full reasoning text (committed round or live partial)
//   props.variant — "committed" renders the whole block (transcript history);
//                   "live" renders the tail window + streaming cursor.
//   props.columns — optional terminal width override. When absent the block
//   measures the terminal itself via useTerminalSize (the same leaf pattern
//   as ToolCall/pickers/modals), so every call site — including the committed
//   transcript chain, which never threads a width — wraps at the real
//   terminal width and re-wraps on resize. Measurement is in terminal CELLS
//   (diff-layout displayWidth), not string lengths, so CJK/emoji fill the
//   line by display width instead of overflowing.
//   No business logic: no timers, no store reads, no history mutation.
//   All paint from ui/theme tokens. Thinking is intentionally unobtrusive:
//   dim, quoteBar-indented, and (live) windowed — it never competes with the
//   final answer body, and collapsibility is handled via windowing/truncation
//   rather than interactive expand inside the append-only <Static> transcript
//   (which freezes on commit; see transcript adornment notes).
//
// Reuses LIVE_THINKING_LINES from live-tail so the tail window stays single-sourced.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { useTerminalSize } from "../layout.js";
import { cellWidth, displayWidth } from "../diff-layout.js";

// Live thinking window (render-stability): single source — live-tail
// re-exports this (no cycle: live-tail -> ThinkingBlock one-way).
export const LIVE_THINKING_LINES = 8;

// Committed thinking wraps after this many lines to keep long reasoning
// from dominating the conversation (hundreds of lines would drown the
// answer). The tail notice makes the cap observable; the full thinking
// stays in the live turn's telemetry, not the scrollback.
export const COMMITTED_THINKING_LINES = 24;

// Pre-wrap a line to a given terminal width, prefixing every wrapped
// segment with `prefix`. Wraps on word boundaries when possible; a single
// token wider than the budget hard-breaks on CODE-POINT boundaries (never
// mid surrogate pair), each chunk measured in terminal cells so wide
// glyphs (CJK, emoji) cannot overflow. A break drops the trailing
// whitespace that preceded it (standard word wrap) so no row paints
// trailing filler; in-line spacing and leading indentation are preserved.
// Empty lines produce a single prefixed empty line. The trailing segment
// is returned WITHOUT a newline (the caller decides).
// Exported for regression tests (tests/thinking-width.test.tsx); it is a
// pure helper and not part of any component API.
export function wrapWithPrefix(
  text: string,
  width: number,
  prefix: string,
): string[] {
  const avail = width - displayWidth(prefix);
  if (avail <= 0) return [prefix + text];
  const tokens = text.split(/(\s+)/);
  const segments: string[] = [];
  let current = "";
  let currentCells = 0;
  for (const token of tokens) {
    const tokenCells = displayWidth(token);
    if (currentCells + tokenCells <= avail) {
      current += token;
      currentCells += tokenCells;
      continue;
    }
    // Overflow: flush the finished row without its trailing whitespace.
    const flushed = current.replace(/\s+$/, "");
    if (flushed.length > 0) segments.push(prefix + flushed);
    if (tokenCells > avail) {
      // Token alone exceeds the budget: hard-break code-point by code
      // point, never splitting a surrogate pair (for..of iterates code
      // points). The leftover chunk stays pending for the next row.
      let chunk = "";
      let chunkCells = 0;
      for (const ch of token) {
        const chCells = cellWidth(ch);
        if (chunkCells + chCells > avail && chunk.length > 0) {
          segments.push(prefix + chunk);
          chunk = "";
          chunkCells = 0;
        }
        chunk += ch;
        chunkCells += chCells;
      }
      current = chunk;
      currentCells = chunkCells;
    } else if (/^\s+$/.test(token)) {
      // Pure whitespace at a break is the word-wrap separator: drop it so
      // the next row never starts with filler spaces.
      current = "";
      currentCells = 0;
    } else {
      // Token fits alone (word) — open the next row with it.
      current = token;
      currentCells = tokenCells;
    }
  }
  const tail = current.replace(/\s+$/, "");
  if (tail.length > 0 || segments.length === 0) segments.push(prefix + tail);
  return segments;
}

export type ThinkingBlockProps = {
  content: string;
  variant: "committed" | "live";
  /** Terminal width for quote-bar alignment. Falls back to a live measure. */
  columns?: number;
};

export const ThinkingBlock = React.memo(function ThinkingBlock({
  content,
  variant,
  columns,
}: ThinkingBlockProps) {
  // Unconditional hook: absent columns means "measure the live terminal".
  // useTerminalSize subscribes to `resize`, so the block re-wraps on width
  // change; an explicit prop overrides (call sites that already measure).
  const measured = useTerminalSize();
  const cols =
    typeof columns === "number" && columns > 0 ? columns : measured.columns;
  const prefix = `${theme.symbol.quoteBar} `;
  if (variant === "committed") {
    const bodyLines = content.split("\n");
    const capped = bodyLines.length > COMMITTED_THINKING_LINES;
    const visible = capped
      ? bodyLines.slice(0, COMMITTED_THINKING_LINES)
      : bodyLines;
    const remaining = bodyLines.length - visible.length;
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={theme.color.quoteAccent}>
            {theme.symbol.thinking} thinking
          </Text>
          {capped ? (
            <Text
              dimColor
            >{` ${theme.symbol.ellipsis} ${remaining} more`}</Text>
          ) : null}
        </Text>
        {visible.flatMap((line, idx) => {
          const wrapped = wrapWithPrefix(line, cols, prefix);
          return wrapped.map((seg, wIdx) => (
            <Text key={`${idx}-${wIdx}`} dimColor>
              {seg}
            </Text>
          ));
        })}
        {capped ? (
          <Text dimColor>
            {theme.symbol.quoteBar} {theme.symbol.ellipsis} {remaining} more
            lines
          </Text>
        ) : null}
      </Box>
    );
  }
  const lines = content.split("\n");
  const tail = lines.slice(-LIVE_THINKING_LINES);
  const truncated = lines.length > tail.length;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.color.quoteAccent}>
          {theme.symbol.thinking} thinking
        </Text>
        {truncated ? <Text dimColor>{` ${theme.symbol.ellipsis}`}</Text> : null}
      </Text>
      {tail.flatMap((line, idx) => {
        const isLast = idx === tail.length - 1;
        const wrapped = wrapWithPrefix(line, cols, prefix);
        return wrapped.map((seg, wIdx) => (
          <Text key={`${idx}-${wIdx}`} dimColor>
            {seg}
            {isLast && wIdx === wrapped.length - 1 ? (
              <Text color={theme.color.mutedPaint}>
                {theme.symbol.cursorBar}
              </Text>
            ) : null}
          </Text>
        ));
      })}
    </Box>
  );
});
