// ThinkingBlock: the single canonical thinking renderer.
//
// Contract:
//   props.content — full reasoning text (committed round or live partial)
//   props.variant — "committed" renders the whole block (transcript history);
//                   "live" renders the tail window + streaming cursor.
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

// Live thinking window (render-stability): single source — live-tail
// re-exports this (no cycle: live-tail -> ThinkingBlock one-way).
export const LIVE_THINKING_LINES = 8;

// Committed thinking wraps after this many lines to keep long reasoning
// from dominating the conversation (hundreds of lines would drown the
// answer). The tail notice makes the cap observable; the full thinking
// stays in the live turn's telemetry, not the scrollback.
export const COMMITTED_THINKING_LINES = 24;

// Pre-wrap a line to a given width, prefixing every wrapped segment with
// `prefix`. Empty lines produce a single prefixed empty line. Breaks on
// word boundaries when possible (space-delimited); falls back to hard
// break when a single word exceeds the width. The trailing segment is
// returned WITHOUT a newline (the caller decides).
function wrapWithPrefix(text: string, width: number, prefix: string): string[] {
  if (width <= prefix.length) return [prefix + text];
  const avail = width - prefix.length;
  const words = text.split(/(\s+)/);
  const segments: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length <= avail) {
      current += word;
    } else {
      if (current.length > 0) segments.push(prefix + current);
      // Word longer than avail: hard-break it character by character.
      let rest = word;
      while (rest.length > avail) {
        segments.push(prefix + rest.slice(0, avail));
        rest = rest.slice(avail);
      }
      current = rest;
    }
  }
  if (current.length > 0 || segments.length === 0) segments.push(prefix + current);
  return segments;
}

export type ThinkingBlockProps = {
  content: string;
  variant: "committed" | "live";
  /** Terminal width for quote-bar alignment. Falls back to 100. */
  columns?: number;
};

export const ThinkingBlock = React.memo(function ThinkingBlock({ content, variant, columns }: ThinkingBlockProps) {
  const cols = typeof columns === "number" && columns > 0 ? columns : 100;
  const prefix = `${theme.symbol.quoteBar} `;
  if (variant === "committed") {
    const bodyLines = content.split("\n");
    const capped = bodyLines.length > COMMITTED_THINKING_LINES;
    const visible = capped ? bodyLines.slice(0, COMMITTED_THINKING_LINES) : bodyLines;
    const remaining = bodyLines.length - visible.length;
    return (
      <Box flexDirection="column">
        <Text><Text color={theme.color.quoteAccent}>{theme.symbol.thinking} thinking</Text>{capped ? <Text dimColor>{` ${theme.symbol.ellipsis} ${remaining} more`}</Text> : null}</Text>
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
            {theme.symbol.quoteBar} {theme.symbol.ellipsis} {remaining} more lines
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
      <Text><Text color={theme.color.quoteAccent}>{theme.symbol.thinking} thinking</Text>{truncated ? <Text dimColor>{` ${theme.symbol.ellipsis}`}</Text> : null}</Text>
      {tail.flatMap((line, idx) => {
        const isLast = idx === tail.length - 1;
        const wrapped = wrapWithPrefix(line, cols, prefix);
        return wrapped.map((seg, wIdx) => (
          <Text key={`${idx}-${wIdx}`} dimColor>
            {seg}
            {isLast && wIdx === wrapped.length - 1 ? (
              <Text color={theme.color.mutedPaint}>{theme.symbol.cursorBar}</Text>
            ) : null}
          </Text>
        ));
      })}
    </Box>
  );
});
