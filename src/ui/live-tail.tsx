// Live-tail leaf: the dynamic zone between the committed <Static>
// transcript and the modals — empty-state hints, the streaming answer
// draft, the transient thinking block, and the tool-call hint. Re-renders
// every tick by design (unlike TranscriptView/InputBox); all paint comes
// from ui/theme tokens. The streaming-markdown chunk owns this file next.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { activityText } from "./activity.js";
import { modelForLive } from "./tool-model.js";
import { ThinkingBlock } from "./components/ThinkingBlock.js";
import { MarkdownDraft } from "./components/Markdown.js";
import { Spinner } from "./components/Activity.js";
import { LiveToolCall } from "./components/ToolCall.js";
import { StepBlockList } from "./components/StepBlockList.js";
import { toStepBlocks } from "./step-blocks.js";

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
  // Sequenced lanes: which lane owns the live zone (store-driven, so no
  // App render rides along). The tail renders ONLY the active lane — the
  // inactive lane stays committed-or-pending off-screen until its turn.
  // Null (or a lane with no text) falls back to showing whatever is live.
  activeLane?: "draft" | "thinking" | null;
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
  // Step-ordered live blocks (ticket 02): per-step thinking/text segments
  // built from the loop's step-tagged deltas, riding the store snapshot.
  // Null/absent = no step blocks yet (legacy callers, idle/cleared).
  stepBlocks?: readonly import("./step-blocks.js").StepBlock[] | null;
  // Opt-in gate for the ordered block list: false (default) keeps today's
  // single-lane live zone byte-identical; true renders the step blocks
  // INSTEAD of the legacy thinking/draft lanes (no duplicate paint), with
  // the streaming cursor on the latest block. From ticket 03 the tool hint
  // is sequenced too (blocksOwnTool suppresses the legacy tool lane).
  useStepBlocks?: boolean;
};

// Live thinking window: single source in ThinkingBlock (re-exported here
// so existing `from "../live-tail.js"` importers keep working).
export { LIVE_THINKING_LINES } from "./components/ThinkingBlock.js";

// Live tool row: the committed widget's running twin. Same bordered frame
// (running/queued tint) so live → committed settles without a visual jump.
// Falls back to nothing when the hint is unparseable (never a crash frame).
function LiveToolHint({ toolHint, toolElapsedSecs }: { toolHint: string; toolElapsedSecs: number | null }) {
  const elapsedMs = toolElapsedSecs !== null ? Math.max(0, toolElapsedSecs * 1000) : null;
  const status: "queued" | "running" = toolElapsedSecs === null ? "queued" : "running";
  const live = modelForLive(toolHint, elapsedMs, status);
  if (!live) return null;
  const showDur = toolElapsedSecs !== null && toolElapsedSecs >= 2;
  const durTail = showDur ? ` ${theme.symbol.separator} ${Math.round(toolElapsedSecs as number)}s` : "";
  return (
    <LiveToolCall
      name={live.name || toolHint}
      target={live.target}
      kind={live.kind}
      status={status}
      durationMs={elapsedMs !== null && elapsedMs >= 1000 ? elapsedMs : undefined}
      verb={`${theme.symbol.workTool} ${activityText(toolHint)}${durTail}`}
    />
  );
}

export const LiveTail = React.memo(function LiveTail({ isEmpty, sessionHint, emptySessionTitle, draft, thinking, activeLane = null, busy, held, toolHint, toolElapsedSecs, elapsedSecs, showThinking = true, hasHadOutput = false, columns, stepBlocks = null, useStepBlocks = false }: LiveTailProps) {
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
  // Ticket 02 ordered blocks: per-step thinking/text segments from the
  // loop's step-tagged deltas. Opt-in via useStepBlocks — when on, these
  // blocks REPLACE the legacy lanes (no duplicate paint); when off, today's
  // lanes paint exactly as before. The /thinking toggle still hides thinking
  // (rendering-only, same meaning as the lane prop). Held freezes the whole
  // live zone, blocks included.
  const orderedBlocks =
    useStepBlocks && !freezeLive && stepBlocks !== null && stepBlocks.length > 0
      ? showThinking
        ? stepBlocks
        : stepBlocks.filter((b) => b.kind !== "thinking")
      : null;
  const showsOrderedBlocks = orderedBlocks !== null && orderedBlocks.length > 0;
  const thinkingLaneOn = activeLane !== "draft" && showsThinking && !showsOrderedBlocks;
  const draftLaneOn = activeLane !== "thinking" && showsDraft && !showsOrderedBlocks;
  // Ticket 03 (no double tool paint): when the ordered blocks carry the
  // live tool row (started → running, committed → done block), the legacy
  // tool-hint lane must NOT paint it too — one tool row, never two. The
  // lane stays for legacy frames (useStepBlocks off), held freeze (blocks
  // hidden), and the announce→start window before the first block appends.
  const blocksOwnTool =
    orderedBlocks !== null && orderedBlocks.some((b) => b.kind === "tool");
  const showsToolHint = busy && !!toolHint && !blocksOwnTool;
  // Gap line: busy with nothing live yet (the submit→first-output window).
  // Suppressed once output appeared (hasHadOutput): the answer is committed
  // and visible above — a slow teardown must not resurrect the gap.
  const showsThinkingGap = !freezeLive && busy && !draft && !thinking && !toolHint && !hasHadOutput && !showsOrderedBlocks;
  // Ticket 01 sidecar: the ordered block model derived from the same lane
  // inputs, mounted beside today's lanes below. Inert by default (enabled
  // unset → null): derivation runs, nothing paints, frames stay identical.
  const sidecarBlocks = toStepBlocks({ draft, thinking, toolHint, activeLane, showThinking });
  if (
    !isEmpty &&
    !freezeLive &&
    !showsDraft &&
    !showsThinking &&
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
      {!freezeLive && thinking && showThinking && thinkingLaneOn ? (
        // Thinking precedes the draft in the live zone: reasoning is
        // transient and dim (quoteBar), the answer is the primary body.
        // Order prevents the two from visually fighting during streaming;
        // both converge to the committed transcript (thinking turn + ATOM>
        // markdown) without a jump.
        <ThinkingBlock content={thinking} variant="live" columns={columns} />
      ) : null}
      {draftLaneOn && draft ? (
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
      {showsToolHint && toolHint ? (
        <LiveToolHint toolHint={toolHint} toolElapsedSecs={toolElapsedSecs} />
      ) : null}
      {/* Ticket 02 ordered blocks: per-step thinking/text segments, live.
          Enabled via useStepBlocks — settled blocks committed, streaming
          cursor on the latest. Replaces the legacy lanes above (they bail
          via showsOrderedBlocks), so no text ever paints twice. */}
      {showsOrderedBlocks && orderedBlocks ? (
        <StepBlockList blocks={orderedBlocks} enabled columns={columns} toolElapsedSecs={toolElapsedSecs} />
      ) : null}
      {/* Ticket 01 sidecar: ordered block list beside the lanes. Inert
          (enabled unset → null) — present in the tree, absent on screen. */}
      <StepBlockList blocks={sidecarBlocks} columns={columns} toolElapsedSecs={toolElapsedSecs} />
      {!freezeLive && busy && !draft && !thinking && !toolHint && !hasHadOutput ? (
        <Spinner elapsedSecs={elapsedSecs} />
      ) : null}
    </Box>
  );
});
