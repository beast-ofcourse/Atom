// Input leaf: the boxed prompt surface. Prop-driven + memoized on
// (input, cursor) so timer ticks never repaint it.
import React from "react";
import { Box, Text } from "ink";

// Render-count probe for the input-smoothness test: incremented on every
// InputBox render (one keystroke must paint the input exactly once; the 1s
// busy-tick must leave it unchanged while idle input sits still).
export const inputRenderProbe = { count: 0 };

export type InputBoxProps = { input: string; cursor: number };

// The input is the one boxed, prominent surface: a quiet gray frame sets it
// apart from the transcript above and the status line below. Memoized on
// (input, cursor) so elapsed-timer ticks, token paints, and unrelated App
// state churn never repaint it — keystrokes stay at exactly one paint each,
// which is what makes navigation feel instant instead of choppy.
export const InputBox = React.memo(function InputBox({ input, cursor }: InputBoxProps) {
  inputRenderProbe.count += 1;
  // Defensive clamp: the ref is the source of truth mid-tick and always
  // stays in range, but state may lag it by one render.
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan" bold>
        ›{" "}
      </Text>
      <Text>
        {input.slice(0, safeCursor)}
        <Text color="gray">█</Text>
        {input.slice(safeCursor)}
      </Text>
    </Box>
  );
});

