// Shared live-zone leaves: the running tool row and the assistant speaker
// header. LiveTail (legacy lanes) and StepBlockList (ordered blocks) render
// the same live language — one definition, never two dialects.
import React from "react";
import { Text } from "ink";
import { theme } from "../theme.js";
import { activityText } from "../activity.js";
import { modelForLive } from "../tool-model.js";
import { LiveToolCall } from "./ToolCall.js";

// Assistant speaker header: the `ATOM>` row above a streaming markdown body.
// Same header in the legacy draft lane and in every live text block.
export function AssistantSpeakerHeader(): React.ReactNode {
  return (
    <Text wrap="wrap">
      <Text color={theme.color.assistant} bold>
        {theme.symbol.speakerAssistant}
      </Text>
    </Text>
  );
}

export type LiveToolRowProps = {
  /** Live hint (tool name [+ target] as announced). */
  hint: string;
  /** Display-only seconds since the current tool started (null when unknown). */
  toolElapsedSecs: number | null;
};

// Running tool row: the committed widget's running twin. Same bordered frame
// (running/queued tint) so live → committed settles without a visual jump.
// Falls back to nothing when the hint is unparseable (never a crash frame).
export const LiveToolRow = React.memo(function LiveToolRow({
  hint,
  toolElapsedSecs,
}: LiveToolRowProps) {
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
});
