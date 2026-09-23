// Live-tail leaf: the dynamic zone between the committed <Static>
// transcript and the modals — empty-state hints, the streaming answer
// draft, the transient thinking block, and the tool-call hint. Re-renders
// every tick by design (unlike TranscriptView/InputBox); all paint comes
// from ui/theme tokens.
//
// Sequencing (ticket 05): `stepBlocks` is the sole live sequencer when
// present. Thinking/text/tool segments paint in list order via StepBlockList;
// the raw draft/thinking props only feed the empty/live guards and the gap
// spinner (and the legacy lane paint when a caller mounts without blocks).
// There is no exclusive active-lane gate.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { ThinkingBlock } from "./components/ThinkingBlock.js";
import { MarkdownDraft } from "./components/Markdown.js";
import { Spinner } from "./components/Activity.js";
import { AssistantSpeakerHeader, LiveToolRow } from "./components/live-rows.js";
import { StepBlockList } from "./components/StepBlockList.js";

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
  // Step-ordered live blocks: per-step thinking/text/tool segments built
  // from the loop's step-tagged deltas, riding the store snapshot. When
  // present and non-empty they are THE sequencer (one StepBlockList, no
  // duplicate lane paint). Null/absent = no blocks yet (legacy callers,
  // idle/cleared) — then draft/thinking paint as the legacy lanes.
  stepBlocks?: readonly import("./step-blocks.js").StepBlock[] | null;
};

// Live thinking window: single source in ThinkingBlock (re-exported here
// so existing `from "../live-tail.js"` importers keep working).
export { LIVE_THINKING_LINES } from "./components/ThinkingBlock.js";

export const LiveTail = React.memo(function LiveTail({
  isEmpty,
  sessionHint,
  emptySessionTitle,
  draft,
  thinking,
  busy,
  held,
  toolHint,
  toolElapsedSecs,
  elapsedSecs,
  showThinking = true,
  hasHadOutput = false,
  columns,
  stepBlocks = null,
}: LiveTailProps) {
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
  // Ordered blocks (sole sequencer when present): per-step thinking/text/
  // tool segments. /thinking still filters thinking blocks (rendering-only).
  // Held freezes the whole live zone, blocks included.
  const orderedBlocks =
    !freezeLive && stepBlocks !== null && stepBlocks.length > 0
      ? showThinking
        ? stepBlocks
        : stepBlocks.filter((b) => b.kind !== "thinking")
      : null;
  const showsOrderedBlocks = orderedBlocks !== null && orderedBlocks.length > 0;
  // When blocks paint, the raw lanes stay dark (no duplicate text). Without
  // blocks, legacy draft/thinking lanes paint as before (both channels can
  // show — exclusivity retired with the active lane).
  const showsLegacyDraft = showsDraft && !showsOrderedBlocks;
  const showsLegacyThinking = showsThinking && !showsOrderedBlocks;
  // When the ordered blocks carry the live tool row (started → running,
  // committed → done block), the legacy tool-hint lane must NOT paint it
  // too — one tool row, never two. The lane stays for frames without a
  // tool block (announce→start window, held freeze, legacy callers).
  const blocksOwnTool =
    orderedBlocks !== null && orderedBlocks.some((b) => b.kind === "tool");
  const showsToolHint = busy && !!toolHint && !blocksOwnTool;
  // Gap line: busy with nothing live yet (the submit→first-output window).
  // Suppressed once output appeared (hasHadOutput): the answer is committed
  // and visible above — a slow teardown must not resurrect the gap. Blocks
  // count as output for the same reason the lanes did.
  const showsThinkingGap =
    !freezeLive &&
    busy &&
    !draft &&
    !thinking &&
    !toolHint &&
    !hasHadOutput &&
    !showsOrderedBlocks;
  if (
    !isEmpty &&
    !freezeLive &&
    !showsLegacyDraft &&
    !showsLegacyThinking &&
    !showsToolHint &&
    !showsThinkingGap &&
    !showsOrderedBlocks
  ) {
    return null;
  }
  // Empty + idle mounts nothing (startup hints removed): the TUI opens on
  // the banner + composer with no text clutter. isEmpty/sessionHint/
  // emptySessionTitle stay on props so App call sites are untouched.
  void sessionHint;
  void emptySessionTitle;
  if (isEmpty && !freezeLive) {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={theme.spacing.liveTailMarginY}>
      {freezeLive ? (
        <Text dimColor>
          {theme.symbol.moreAbove} held — turn running · End to follow
        </Text>
      ) : null}
      {showsLegacyThinking && thinking ? (
        // Thinking precedes the draft in the live zone: reasoning is
        // transient and dim (quoteBar), the answer is the primary body.
        // Order prevents the two from visually fighting during streaming;
        // both converge to the committed transcript (thinking turn + ATOM>
        // markdown) without a jump.
        <ThinkingBlock content={thinking} variant="live" columns={columns} />
      ) : null}
      {showsLegacyDraft && draft ? (
        <Box flexDirection="column">
          <AssistantSpeakerHeader />
          {/* Streaming body: fence/marker-tolerant markdown that converges
              to the committed shape, so commit never visually jumps. The
              thinking block above stays raw text (stable, never restructured
              mid-stream). */}
          <MarkdownDraft text={draft} />
        </Box>
      ) : null}
      {showsToolHint && toolHint ? (
        <LiveToolRow hint={toolHint} toolElapsedSecs={toolElapsedSecs} />
      ) : null}
      {/* Ordered blocks: settled blocks committed, streaming cursor on the
          latest. Replaces the legacy lanes when present (they bail via
          showsLegacy*), so no text ever paints twice. */}
      {showsOrderedBlocks && orderedBlocks ? (
        <StepBlockList blocks={orderedBlocks} enabled columns={columns} toolElapsedSecs={toolElapsedSecs} />
      ) : null}
      {showsThinkingGap ? <Spinner elapsedSecs={elapsedSecs} /> : null}
    </Box>
  );
});
