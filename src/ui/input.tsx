// Input leaf: the boxed prompt surface. Prop-driven + memoized on
// (input, cursor, busy) so timer ticks never repaint it. Multiline aware: the
// cursor rides line/col and long lines wrap via Ink.
// Footer-cluster states: idle shows just the box + cursor; busy dims the
// whole surface but adds no extra line — the status bar alone carries the
// interrupt hint (esc stops · Enter queues), so no vertical waste above it.
// Paint from ui/theme tokens — no literal colors or glyphs here.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { lineColOf, splitInputLines } from "./input-model.js";
import { useTerminalSize } from "./layout.js";

// Render-count probe for the input-smoothness test: incremented on every
// InputBox render (one keystroke must paint the input exactly once; the 1s
// busy-tick must leave it unchanged while idle input sits still).
export const inputRenderProbe = { count: 0 };

export type InputBoxProps = {
  input: string;
  cursor: number;
  busy?: boolean;
  // Terminal width. Optional override so memoized parents (Composer/App) can
  // push resizes through props — React.memo only re-renders on prop change,
  // so a width read inside this component alone would go stale after a
  // resize until the next keystroke. Defaults to the live terminal size.
  columns?: number;
  shellActive?: boolean;
  placeholder?: string;
  // Docked use sets framed={false} to suppress the input frame
  // (border + padding); standalone keeps framed (default true).
  framed?: boolean;
};

// The input is the one boxed, prominent surface: a quiet gray frame sets it
// apart from the transcript above and the status line below. Memoized on
// (input, cursor, busy) so elapsed-timer ticks, token paints, and unrelated
// App state churn never repaint it — keystrokes stay at exactly one paint
// each, which is what makes navigation feel instant instead of choppy.
// `busy` flips only at turn boundaries (never per tick/token), so the
// working state costs exactly one extra paint per turn edge.
export const InputBox = React.memo(function InputBox({
  input,
  cursor,
  busy = false,
  columns: columnsProp,
  shellActive = false,
  placeholder,
  framed = true,
}: InputBoxProps) {
  inputRenderProbe.count += 1;
  const effectiveInput =
    shellActive && input.length === 0 && placeholder ? placeholder : input;
  const effectiveCursor =
    shellActive && input.length === 0 && placeholder ? 0 : cursor;
  const safeCursor = Math.max(
    0,
    Math.min(effectiveCursor, effectiveInput.length),
  );
  const lines = splitInputLines(effectiveInput);
  const { line: cline, col: ccol } = lineColOf(effectiveInput, safeCursor);
  let hookColumns = 80;
  try {
    hookColumns = useTerminalSize().columns;
  } catch {
    hookColumns = 80;
  }
  const columns = columnsProp ?? hookColumns;
  const frameColor = busy
    ? theme.color.composerBusy
    : theme.color.composerFocus;
  // The box must never force horizontal scroll or break its border. We
  // clamp the inner width and let long input wrap; the cursor stays
  // attached because we render it inline (inverse) rather than as a
  // separate glyph that could detach on wrap. Inset lives in
  // theme.spacing.inputInset (brand-dock token, pins legacy 6 cols for
  // borders + padding so the frame never touches the edge).
  const innerMax = Math.max(
    10,
    columns - (framed ? theme.spacing.inputInset : 2),
  );
  const content = (
    <>
      <Text
        color={theme.color.inputPrompt}
        bold
        dimColor={busy}
        wrap="truncate"
      >
        {theme.symbol.inputPrompt}{" "}
      </Text>
      <Box flexDirection="column" flexGrow={1} width={innerMax}>
        {lines.map((ln, i) => {
          if (i !== cline)
            return (
              <Text key={i} dimColor={busy} wrap="wrap">
                {ln.length > 0 ? ln : " "}
              </Text>
            );
          const before = ln.slice(0, ccol);
          const at = ln.slice(ccol, ccol + 1);
          const after = ln.slice(ccol + 1);
          return (
            <Text key={i} dimColor={busy} wrap="wrap">
              {before}
              <Text inverse>{at.length > 0 ? at : " "}</Text>
              {after}
            </Text>
          );
        })}
      </Box>
    </>
  );
  return (
    <Box flexDirection="column" flexShrink={0} width={columns}>
      {framed ? (
        <Box
          borderStyle={theme.border.style}
          borderColor={frameColor}
          paddingX={theme.spacing.pickerPadX}
          width={columns}
        >
          {content}
        </Box>
      ) : (
        <Box width={columns}>{content}</Box>
      )}
    </Box>
  );
});
