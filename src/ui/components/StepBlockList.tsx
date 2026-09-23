// StepBlockList: the ordered block-list renderer.
//
// Each block reuses the canonical live leaves (ThinkingBlock
// variant="live", MarkdownDraft, shared LiveToolRow) so the list speaks the
// same visual language as the legacy lanes it replaced — no new chrome, no
// literal colors or glyphs (theme tokens only).
import React from "react";
import { Box } from "ink";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { MarkdownBody, MarkdownDraft } from "./Markdown.js";
import { ToolCall } from "./ToolCall.js";
import { AssistantSpeakerHeader, LiveToolRow } from "./live-rows.js";
import { theme } from "../theme.js";
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

// Completed tool block: the committed ToolCall presenter with
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
  // Empty lists mount nothing (same restraint as LiveTail's empty-zone
  // guard — no blank lines spent).
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
              <AssistantSpeakerHeader />
              {live ? <MarkdownDraft text={block.text} /> : <MarkdownBody text={block.text} />}
            </Box>
          );
        }
        if (block.kind === "tool") {
          // Running → shared live row. Done → ToolCall presenter from the
          // payload (same widget the transcript settles into). The elapsed
          // clock belongs to the tail row only — settled running rows in a
          // parallel batch render queued, never with a stale duration.
          if (block.done && block.tool) return <StepToolDone key={block.id} tool={block.tool} />;
          return <LiveToolRow key={block.id} hint={block.text} toolElapsedSecs={live ? toolElapsedSecs : null} />;
        }
        return null;
      })}
    </Box>
  );
});
