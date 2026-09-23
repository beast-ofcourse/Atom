// StepBlockList: the ordered block-list renderer (ticket 01 sidecar).
//
// Mounted BESIDE today's lanes inside LiveTail, inert by default: `enabled`
// is false unless a later ticket opts in, and an empty list renders nothing.
// Either way the component returns null today, so committed output, lane
// paint, collapse, and paint scheduling stay byte-identical.
//
// When enabled, each block reuses the canonical live leaves (ThinkingBlock
// variant="live", MarkdownDraft, LiveToolCall via modelForLive) so the
// sidecar speaks the same visual language as the lanes it will replace —
// no new chrome, no literal colors or glyphs (theme tokens only).
import React from "react";
import { Box, Text } from "ink";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { MarkdownBody, MarkdownDraft } from "./Markdown.js";
import { LiveToolCall, ToolCall } from "./ToolCall.js";
import { activityText } from "../activity.js";
import { theme } from "../theme.js";
import { modelForLive } from "../tool-model.js";
import type { StepBlock, StepToolState } from "../step-blocks.js";
import type { Turn } from "../transcript.js";

export type StepBlockListProps = {
  blocks: readonly StepBlock[];
  /** Opt-in gate. Defaults to false (inert sidecar — returns null). */
  enabled?: boolean;
  /** Terminal width for quote-bar alignment in ThinkingBlock. */
  columns?: number;
  /** Display-only seconds since the current tool started (null when unknown). */
  toolElapsedSecs?: number | null;
};

// Live tool row: same running twin as LiveTail's LiveToolHint (same frame,
// same verb tail), so enabling the sidecar never introduces a second tool
// dialect. Falls back to nothing on unparseable hints (never a crash frame).
function StepToolRow({ hint, toolElapsedSecs }: { hint: string; toolElapsedSecs: number | null }) {
  const elapsedMs = toolElapsedSecs !== null ? Math.max(0, toolElapsedSecs * 1000) : null;
  const status: "queued" | "running" = toolElapsedSecs === null ? "queued" : "running";
  const live = modelForLive(hint, elapsedMs, status);
  if (!live) return null;
  const showDur = toolElapsedSecs !== null && toolElapsedSecs >= 2;
  const durTail = showDur ? ` ${theme.symbol.separator} ${Math.round(toolElapsedSecs as number)}s` : "";
  return (
    <LiveToolCall
      name={live.name || hint}
      target={live.target}
      kind={live.kind}
      status={status}
      durationMs={elapsedMs !== null && elapsedMs >= 1000 ? elapsedMs : undefined}
      verb={`${theme.symbol.workTool} ${activityText(hint)}${durTail}`}
    />
  );
}

// Completed tool block (ticket 03): the committed ToolCall presenter with
// synthetic turns built from the block's payload — same widget, audit line,
// summary, and error card the transcript renders, no new chrome. Error
// keeps the labelTurn/errorTurn pairing classifyToolError expects (same
// shape transcript admitStaticBatch builds). Falls back to a label-only
// turn if the payload is somehow missing (never a crash frame).
function StepToolDone({ tool }: { tool: StepToolState }) {
  const labelTurn: Turn = {
    role: "tool",
    content: tool.label,
    ms: tool.durationMs ?? undefined,
    summary: tool.summary,
  };
  if (tool.errorLine !== null) {
    const errorTurn: Turn = {
      role: "tool",
      content: `  ${theme.symbol.detailMark} ${tool.errorLine}`,
      error: true,
    };
    return <ToolCall turn={errorTurn} label={labelTurn} />;
  }
  return <ToolCall turn={labelTurn} />;
}

export const StepBlockList = React.memo(function StepBlockList({
  blocks,
  enabled = false,
  columns,
  toolElapsedSecs = null,
}: StepBlockListProps) {
  // Inert until a later ticket opts in; empty lists mount nothing (same
  // restraint as LiveTail's empty-zone guard — no blank lines spent).
  if (!enabled || blocks.length === 0) return null;
  // Cursor on the latest: settled blocks render committed leaves (whole
  // thinking block, cursor-free markdown body), only the tail block streams
  // (tail-windowed thinking + streaming cursor). One streaming cursor per
  // list, always on the newest segment.
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        const live = index === blocks.length - 1;
        if (block.kind === "thinking") {
          return <ThinkingBlock key={block.id} content={block.text} variant={live ? "live" : "committed"} columns={columns} />;
        }
        if (block.kind === "text") {
          return (
            <Box key={block.id} flexDirection="column">
              <Text wrap="wrap">
                <Text color={theme.color.assistant} bold>
                  {theme.symbol.speakerAssistant}
                </Text>
              </Text>
              {live ? <MarkdownDraft text={block.text} /> : <MarkdownBody text={block.text} />}
            </Box>
          );
        }
        if (block.kind === "tool") {
          // Running → StepToolRow (live twin). Done → ToolCall presenter
          // from the payload (same widget the transcript settles into).
          if (block.done && block.tool) return <StepToolDone key={block.id} tool={block.tool} />;
          return <StepToolRow key={block.id} hint={block.text} toolElapsedSecs={toolElapsedSecs} />;
        }
        return null;
      })}
    </Box>
  );
});
