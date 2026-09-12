// Input leaf: the boxed prompt surface. Prop-driven + memoized on
// (input, cursor, busy) so timer ticks never repaint it. Multiline aware: the
// cursor rides line/col and long lines wrap via Ink.
// Footer-cluster states: idle shows just the box + cursor; busy dims the
// whole surface and carries its own interrupt hint, so the input never
// vanishes mid-turn — Enter while busy queues, esc stops.
// Paint from ui/theme tokens — no literal colors or glyphs here.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { lineColOf, splitInputLines } from "./input-model.js";

// Render-count probe for the input-smoothness test: incremented on every
// InputBox render (one keystroke must paint the input exactly once; the 1s
// busy-tick must leave it unchanged while idle input sits still).
export const inputRenderProbe = { count: 0 };

export type InputBoxProps = { input: string; cursor: number; busy?: boolean };

// The input is the one boxed, prominent surface: a quiet gray frame sets it
// apart from the transcript above and the status line below. Memoized on
// (input, cursor, busy) so elapsed-timer ticks, token paints, and unrelated
// App state churn never repaint it — keystrokes stay at exactly one paint
// each, which is what makes navigation feel instant instead of choppy.
// `busy` flips only at turn boundaries (never per tick/token), so the
// working state costs exactly one extra paint per turn edge.
export const InputBox = React.memo(function InputBox({ input, cursor, busy = false }: InputBoxProps) {
  inputRenderProbe.count += 1;
  // Defensive clamp: the ref is the source of truth mid-tick and always
  // stays in range, but state may lag it by one render.
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  const lines = splitInputLines(input);
  const { line: cline, col: ccol } = lineColOf(input, safeCursor);
  return (
    <Box flexDirection="column" flexShrink={0}>
    <Box borderStyle={theme.border.style} borderColor={theme.border.input} paddingX={theme.spacing.pickerPadX}>
      <Text color={theme.color.inputPrompt} bold dimColor={busy}>
        {theme.symbol.inputPrompt}{" "}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {lines.map((ln, i) => {
          if (i !== cline)
            return (
              <Text key={i} dimColor={busy}>
                {ln.length > 0 ? ln : " "}
              </Text>
            );
          // See-through cursor: the character under the cursor renders in
          // inverse video instead of inserting a block glyph beside it, so
          // letters never shift aside as the cursor moves (the old block
          // made the line wobble on every arrow-key step). At end of line
          // (or on an empty line) an inverse space holds the cell.
          const before = ln.slice(0, ccol);
          const at = ln.slice(ccol, ccol + 1);
          const after = ln.slice(ccol + 1);
          return (
            <Text key={i} dimColor={busy}>
              {before}
              <Text inverse>{at.length > 0 ? at : " "}</Text>
              {after}
            </Text>
          );
        })}
      </Box>
    </Box>
    {/* Working state: the box stays mounted and editable (typing + Enter
        queue follow-ups) but dimmed, with the interrupt hint attached — the
        status bar carries the clock, this line carries the action. Static
        text (no elapsed seconds) so the 1s busy tick never repaints it. */}
    {busy ? (
      <Text dimColor>
        {theme.symbol.workTool} working {theme.symbol.separator} esc stops {theme.symbol.separator} Enter queues
      </Text>
    ) : null}
    </Box>
  );
});
