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
  // Active session title, shown as its own dim line while the transcript is
  // empty (fresh mount / cleared view). Own line, never a status-bar
  // segment — the sole info bar has a fixed width budget and a ~30-char
  // title wraps `mode: X` onto its own line. Absent/blank hides the line.
  emptySessionTitle?: string | null;
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
  // Thinking visibility (the /thinking toggle, rendering-only): false hides
  // the live thinking block too, so the toggle covers the whole TUI.
  // Defaults to true (legacy always-show); App passes its toggle.
  showThinking?: boolean;
};

// Live thinking window (render-stability): reasoning streams at token rate,
// and painting the full accumulated text every 64ms both churns frame
// height and re-lays-out an ever-growing block. The live view shows only
// the tail — the full text still commits to the transcript at the round
// boundary, so nothing is ever lost.
export const LIVE_THINKING_LINES = 8;

export const LiveTail = React.memo(function LiveTail({ isEmpty, sessionHint, emptySessionTitle, draft, thinking, busy, held, toolHint, toolElapsedSecs, elapsedSecs, showThinking = true }: LiveTailProps) {
  // Held view (user scrolled up mid-turn): the growing draft/thinking blocks
  // are replaced by one static line so the frame stops gaining terminal
  // lines — the terminal stops yanking and scrollback stays readable. The
  // turn keeps running underneath; End resumes the live view. One-line
  // status (tool hint, thinking tick) keeps updating in place: same line,
  // no growth, no yank.
  const freezeLive = held === true && busy;
  const thoughtLines = thinking !== null ? thinking.split("\n") : [];
  const thoughtTail = thoughtLines.slice(-LIVE_THINKING_LINES);
  const thoughtTruncated = thoughtLines.length > thoughtTail.length;
  // Restraint (ticket 07): an empty live zone mounts nothing. The Box below
  // carries marginY, which Ink paints as blank lines even with no children —
  // without this guard every idle frame with history wasted two vertical
  // lines between the transcript and the input. When the transcript is empty
  // the hint lines always render, so only the non-empty, nothing-live case
  // collapses. Mirror the JSX conditions below (falsy draft/toolHint render
  // nothing there, so they count as nothing here too).
  const showsDraft = !freezeLive && !!draft;
  const showsThinking = !freezeLive && thinking !== null && showThinking;
  const showsToolHint = busy && !!toolHint;
  const showsThinkingGap = !freezeLive && busy && !draft && !thinking && !toolHint;
  if (
    !isEmpty &&
    !freezeLive &&
    !showsDraft &&
    !showsThinking &&
    !showsToolHint &&
    !showsThinkingGap
  ) {
    return null;
  }
  return (
    <Box flexDirection="column" marginY={theme.spacing.liveTailMarginY}>
      {isEmpty ? (
        <Text dimColor>Say hi to Atom — or type / for commands, /provider to pick a provider + key, /model to switch models.</Text>
      ) : null}
      {isEmpty && emptySessionTitle && emptySessionTitle.trim() ? (
        <Text dimColor>Session: {emptySessionTitle.trim()}</Text>
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
      {!freezeLive && thinking && showThinking ? (
        // Grouped thinking unit: dim labeled header + quoteBar-prefixed tail
        // body reads as one quiet block, structurally separate from the
        // answer draft above (magenta ATOM> + markdown). Tail-window behavior
        // unchanged; divider lives inside this row's own box (no extra
        // Static rows). Muted = dimColor per theme law, never gray paint
        // (cursor glyph keeps the reserved mutedPaint shade).
        <Box flexDirection="column">
          <Text dimColor>
            {theme.symbol.thinking} thinking{thoughtTruncated ? ` ${theme.symbol.ellipsis}` : ""}
          </Text>
          {thoughtTail.map((line, idx) => (
            <Text key={idx} dimColor>
              {`${theme.symbol.quoteBar} ${line}`}
              {idx === thoughtTail.length - 1 ? (
                <Text color={theme.color.mutedPaint}>{theme.symbol.cursorBar}</Text>
              ) : null}
            </Text>
          ))}
        </Box>
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
});
