// Live-tail leaf: the dynamic zone between the committed <Static>
// transcript and the modals — empty-state hints, the streaming answer
// draft, the transient thinking block, and the tool-call hint. Re-renders
// every tick by design (unlike TranscriptView/InputBox); all paint comes
// from ui/theme tokens. The streaming-markdown chunk owns this file next.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { ThinkingBlock } from "./components/ThinkingBlock.js";
import { MarkdownDraft } from "./components/Markdown.js";
import { Progress, Spinner } from "./components/Activity.js";

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
  // Gap guard (see LiveTailHost): true once any output appeared this turn.
  // Hides the thinking-gap spinner so the beat between the final commit and
  // the busy teardown never reads as a still-thinking agent. Defaults to
  // false so existing call sites keep the legacy gap behavior.
  hasHadOutput?: boolean;
  /** Terminal width for quote-bar alignment in ThinkingBlock. */
  columns?: number;
};

// Live thinking window: single source in ThinkingBlock (re-exported here
// so existing `from "../live-tail.js"` importers keep working).
export { LIVE_THINKING_LINES } from "./components/ThinkingBlock.js";

export const LiveTail = React.memo(function LiveTail({ isEmpty, sessionHint, emptySessionTitle, draft, thinking, busy, held, toolHint, toolElapsedSecs, elapsedSecs, showThinking = true, hasHadOutput = false, columns }: LiveTailProps) {
  // Held view (user scrolled up mid-turn): the growing draft/thinking blocks
  // are replaced by one static line so the frame stops gaining terminal
  // lines — the terminal stops yanking and scrollback stays readable. The
  // turn keeps running underneath; End resumes the live view. One-line
  // status (tool hint, thinking tick) keeps updating in place: same line,
  // no growth, no yank.
  const freezeLive = held === true && busy;
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
  // Gap line: busy with nothing live yet (the submit→first-output window).
  // Suppressed once output appeared (hasHadOutput): the answer is committed
  // and visible above — a slow teardown must not resurrect the gap.
  const showsThinkingGap = !freezeLive && busy && !draft && !thinking && !toolHint && !hasHadOutput;
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
      {!freezeLive && thinking && showThinking ? (
        // Thinking precedes the draft in the live zone: reasoning is
        // transient and dim (quoteBar), the answer is the primary body.
        // Order prevents the two from visually fighting during streaming;
        // both converge to the committed transcript (thinking turn + ATOM>
        // markdown) without a jump.
        <ThinkingBlock content={thinking} variant="live" columns={columns} />
      ) : null}
      {!freezeLive && draft ? (
        <Box flexDirection="column">
          <Text wrap="wrap">
            <Text color={theme.color.assistant} bold>
              {theme.symbol.speakerAssistant}
            </Text>
          </Text>
          {/* Streaming body: fence/marker-tolerant markdown that converges
              to the committed shape, so commit never visually jumps. The
              thinking block above stays raw text (stable, never restructured
              mid-stream). */}
          <MarkdownDraft text={draft} />
        </Box>
      ) : null}
      {busy && toolHint ? (
        <Progress toolHint={toolHint} toolElapsedSecs={toolElapsedSecs} />
      ) : null}
      {!freezeLive && busy && !draft && !thinking && !toolHint && !hasHadOutput ? (
        <Spinner elapsedSecs={elapsedSecs} />
      ) : null}
    </Box>
  );
});
