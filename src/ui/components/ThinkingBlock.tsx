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

export type ThinkingBlockProps = {
  content: string;
  variant: "committed" | "live";
};

export const ThinkingBlock = React.memo(function ThinkingBlock({ content, variant }: ThinkingBlockProps) {
  if (variant === "committed") {
    const bodyLines = content.split("\n");
    const capped = bodyLines.length > COMMITTED_THINKING_LINES;
    const visible = capped ? bodyLines.slice(0, COMMITTED_THINKING_LINES) : bodyLines;
    const remaining = bodyLines.length - visible.length;
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {theme.symbol.thinking} thinking{capped ? ` ${theme.symbol.ellipsis} ${remaining} more` : ""}
        </Text>
        {visible.map((line, idx) => (
          <Text key={idx} dimColor wrap="wrap">
            {theme.symbol.quoteBar} {line}
          </Text>
        ))}
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
      <Text dimColor>
        {theme.symbol.thinking} thinking{truncated ? ` ${theme.symbol.ellipsis}` : ""}
      </Text>
      {tail.map((line, idx) => (
        <Text key={idx} dimColor wrap="wrap">
          {theme.symbol.quoteBar} {line}
          {idx === tail.length - 1 ? (
            <Text color={theme.color.mutedPaint}>{theme.symbol.cursorBar}</Text>
          ) : null}
        </Text>
      ))}
    </Box>
  );
});
