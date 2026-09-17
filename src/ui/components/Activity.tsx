// Activity indicators: honest liveness without animation.
//
// Contract:
//   Spinner { elapsedSecs } — thinking-gap line (busy, no draft/thinking/tool).
//   Progress { toolHint, toolElapsedSecs } — legacy running-tool line,
//     superseded by LiveToolCall (components/ToolCall.js) which carries the
//     same header + verb tail inside the widget frame. Kept exported for
//     compat; the live tail no longer mounts it.
// Both are presentational: elapsed values arrive from the 1s busy tick via
// props; no timers, no spinners, no state. Liveness reads from ticking
// seconds per theme law (see ui/activity + ui/theme).
import React from "react";
import { Box, Text } from "ink";
import { activityText, parseActivityHint } from "../activity.js";
import { theme } from "../theme.js";
import { getToolKind, kindLabel } from "../tool-model.js";

export type SpinnerProps = { elapsedSecs: number };
export type ProgressProps = {
  toolHint: string;
  toolElapsedSecs: number | null;
};

export const Spinner = React.memo(function Spinner({ elapsedSecs }: SpinnerProps) {
  return (
    <Text dimColor>
      {theme.symbol.workThinking} Thinking{theme.symbol.ellipsis} {theme.symbol.separator} {elapsedSecs}s
    </Text>
  );
});

export const Progress = React.memo(function Progress({ toolHint, toolElapsedSecs }: ProgressProps) {
  const { name } = parseActivityHint(toolHint);
  const kind = getToolKind(name);
  const isQueued = toolElapsedSecs === null;
  const glyph = isQueued ? theme.symbol.toolQueued : theme.symbol.toolRunning;
  const status: "queued" | "running" = isQueued ? "queued" : "running";
  const color = isQueued ? undefined : theme.color.warning;
  const durHeader = toolElapsedSecs !== null ? `${Math.round(toolElapsedSecs)}s` : null;
  const showDur = toolElapsedSecs !== null && toolElapsedSecs >= 2;
  // Single-line live row (flicker fix): fixed 1-row height so tool start/finish
  // never jumps the frame. Keeps pinned `◉ <Verb> <target>` via workTool verb
  // tail, plus first-class [glyph] name kind status duration shape.
  const verb = activityText(toolHint);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={color} dimColor={isQueued}>{glyph}</Text> <Text bold>{name || toolHint}</Text>{" "}
        <Text dimColor>
          {kindLabel(kind)} {status}{showDur && durHeader ? ` ${theme.symbol.separator} ${durHeader}` : ` ${theme.symbol.ellipsis}`}
        </Text>
        <Text dimColor> {theme.symbol.workTool} {verb}{showDur && durHeader ? ` ${theme.symbol.separator} ${durHeader}` : ""}</Text>
      </Text>
    </Box>
  );
});
