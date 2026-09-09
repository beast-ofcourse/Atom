// Live-tail leaf: the dynamic zone between the committed <Static>
// transcript and the modals — empty-state hints, the streaming answer
// draft, the transient thinking block, and the tool-call hint. Re-renders
// every tick by design (unlike TranscriptView/InputBox); all paint comes
// from ui/theme tokens. The streaming-markdown chunk owns this file next.
import React from "react";
import { Box, Text } from "ink";
import { activityText } from "./activity.js";
import { MarkdownStream } from "./markdown.js";
import { theme } from "./theme.js";

export type LiveTailProps = {
  isEmpty: boolean;
  sessionHint: boolean;
  draft: string | null;
  thinking: string | null;
  busy: boolean;
  held?: boolean;
  toolHint: string | null;
  // Display-only: seconds since the current tool started (null when unknown
  // or idle). Shown past 1s so fast calls stay a clean single line.
  toolElapsedSecs: number | null;
  // Turn-level elapsed seconds (the 1s busy tick): drives the thinking-gap
  // line below. The tick re-renders this leaf, so the number stays fresh.
  elapsedSecs: number;
};

export function LiveTail({ isEmpty, sessionHint, draft, thinking, busy, held, toolHint, toolElapsedSecs, elapsedSecs }: LiveTailProps) {
  // Held view (user scrolled up mid-turn): the growing draft/thinking blocks
  // are replaced by one static line so the frame stops gaining terminal
  // lines — the terminal stops yanking and scrollback stays readable. The
  // turn keeps running underneath; End resumes the live view. One-line
  // status (tool hint, thinking tick) keeps updating in place: same line,
  // no growth, no yank.
  const freezeLive = held === true && busy;
  return (
    <Box flexDirection="column" marginY={theme.spacing.liveTailMarginY}>
      {isEmpty ? (
        <Text dimColor>Say hi to Atom — or type / for commands, /provider to pick a provider + key, /model to switch models.</Text>
      ) : null}
      {sessionHint && isEmpty ? (
        <Text dimColor>(last session available — /resume to restore)</Text>
      ) : null}
      {freezeLive ? (
        <Text dimColor>
          {theme.symbol.moreAbove} held — turn running · End to follow
        </Text>
      ) : null}
      {!freezeLive && draft ? (
        <Box flexDirection="column">
          <Text>
            <Text color={theme.color.assistant} bold>
              {theme.symbol.speakerAssistant}{" "}
            </Text>
          </Text>
          {/* Streaming body: fence/marker-tolerant markdown that converges
              to the committed shape, so commit never visually jumps. The
              thinking block below stays raw text (stable, never restructured
              mid-stream). */}
          <MarkdownStream text={draft} />
        </Box>
      ) : null}
      {!freezeLive && thinking ? (
        <Text dimColor>
          {theme.symbol.thinking} {thinking}
          <Text color={theme.color.mutedPaint}>{theme.symbol.cursorBar}</Text>
        </Text>
      ) : null}
      {busy && toolHint ? (
        <Text dimColor>
          {theme.symbol.workTool} {activityText(toolHint)}
          {toolElapsedSecs !== null && toolElapsedSecs >= 2 ? (
            <>
              {" "}{theme.symbol.separator} {toolElapsedSecs}s
            </>
          ) : (
            theme.symbol.ellipsis
          )}
        </Text>
      ) : null}
      {!freezeLive && busy && !draft && !thinking && !toolHint ? (
        <Text dimColor>
          {theme.symbol.workThinking} Thinking{theme.symbol.ellipsis} {theme.symbol.separator} {elapsedSecs}s
        </Text>
      ) : null}
    </Box>
  );
}
