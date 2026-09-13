// Activity indicators: honest liveness without animation.
//
// Contract:
//   Spinner { elapsedSecs } — thinking-gap line (busy, no draft/thinking/tool).
//   Progress { toolHint, toolElapsedSecs } — running-tool line (first-class
//     ToolCall header: [glyph] name kind running · duration + verb line).
// Both are presentational: elapsed values arrive from the 1s busy tick via
// props; no timers, no spinners, no state. Liveness reads from ticking
// seconds per theme law (see ui/activity + ui/theme).
import React from "react";
import { Box, Text } from "ink";
import { activityText, parseActivityHint } from "../activity.js";
import { theme } from "../theme.js";
import { formatDuration, getToolKind, kindLabel } from "../tool-model.js";

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
  const durHeader = toolElapsedSecs !== null ? formatDuration(toolElapsedSecs * 1000) : null;
  const showDur = toolElapsedSecs !== null && toolElapsedSecs >= 2;
  const legacyDur = showDur ? ` ${theme.symbol.separator} ${toolElapsedSecs}s` : ` ${theme.symbol.ellipsis}`;
  // Header: [glyph] name kind status · duration  (first-class)
  // Body:  legacy verb line (`◉ Reading src/zen.ts …`) keeps the pinned
  // substring for existing tests while the header provides the prompt's
  // [icon] name status duration summary shape. Both lines share the same
  // live lifecycle; the transcript's committed ToolCall mirrors this header
  // so live → committed settles without a visual jump.
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text color={color} dimColor={isQueued}>{glyph}</Text> <Text bold>{name || toolHint}</Text>{" "}
        <Text dimColor>
          {kindLabel(kind)} {status}{showDur && durHeader ? ` ${theme.symbol.separator} ${durHeader}` : ` ${theme.symbol.ellipsis}`}
        </Text>
      </Text>
      <Text dimColor wrap="wrap">
        {theme.symbol.workTool} {activityText(toolHint)}
        {legacyDur}
      </Text>
    </Box>
  );
});
