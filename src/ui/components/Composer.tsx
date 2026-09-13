// Composer: the input zone as a UI concept.
//
// Contract:
//   props.input — current draft text; props.cursor — offset 0..length.
//   props.busy — working state (dims the box, never hides input; status bar
//     carries the esc/queue hint so no extra line is spent above it).
//   props.queue — queued follow-ups (visible first + count, hidden when empty).
//   props.steerPending — active steer text (hidden when null).
// Delegates the boxed surface to InputBox; owns the indicator lines so App
// no longer assembles them inline. No key handling, no submit logic here.
import React from "react";
import { Box, Text } from "ink";
import { InputBox } from "../input.js";

export type ComposerProps = {
  input: string;
  cursor: number;
  busy?: boolean;
  queue?: string[];
  steerPending?: string | null;
  // Terminal width, threaded to the memoized InputBox so resizes repaint it
  // (memo only reacts to props). Falls back to the live size inside InputBox.
  columns?: number;
};

export const Composer = React.memo(function Composer({
  input,
  cursor,
  busy = false,
  queue = [],
  steerPending = null,
  columns,
}: ComposerProps) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {steerPending ? <Text dimColor>Steering: {steerPending}</Text> : null}
      {queue.length > 0 ? (
        <Text dimColor>
          Queued ({queue.length}): {queue[0]}
          {queue.length > 1 ? ` +${queue.length - 1} more (/queue)` : ""}
        </Text>
      ) : null}
      <InputBox input={input} cursor={cursor} busy={busy} columns={columns} />
    </Box>
  );
});
