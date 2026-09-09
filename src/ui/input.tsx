// Input leaf: the boxed prompt surface. Prop-driven + memoized on
// (input, cursor) so timer ticks never repaint it. Multiline aware: the
// cursor rides line/col and long lines wrap via Ink. Deliberately bare —
// no placeholder text, no hints; the box + cursor is the affordance.
// Paint from ui/theme tokens — no literal colors or glyphs here.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { lineColOf, splitInputLines } from "./input-model.js";

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
  const lines = splitInputLines(input);
  const { line: cline, col: ccol } = lineColOf(input, safeCursor);
  return (
    <Box borderStyle={theme.border.style} borderColor={theme.border.input} paddingX={theme.spacing.pickerPadX}>
      <Text color={theme.color.inputPrompt} bold>
        {theme.symbol.inputPrompt}{" "}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {lines.map((ln, i) => {
          if (i !== cline) return <Text key={i}>{ln.length > 0 ? ln : " "}</Text>;
          // See-through cursor: the character under the cursor renders in
          // inverse video instead of inserting a block glyph beside it, so
          // letters never shift aside as the cursor moves (the old block
          // made the line wobble on every arrow-key step). At end of line
          // (or on an empty line) an inverse space holds the cell.
          const before = ln.slice(0, ccol);
          const at = ln.slice(ccol, ccol + 1);
          const after = ln.slice(ccol + 1);
          return (
            <Text key={i}>
              {before}
              <Text inverse>{at.length > 0 ? at : " "}</Text>
              {after}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
});
