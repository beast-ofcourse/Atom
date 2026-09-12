// Picker shells: the shared chrome behind every dropdown/popup in the TUI
// (model, skills, provider, effort, rewind, rewind-scope, slash menu).
// Prop-driven; all paint comes from ui/theme tokens. Per-picker polish
// chunks restyle this one shell instead of six copies.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

export type PickerShellProps = {
  title: string;
  borderColor?: string;
  children: React.ReactNode;
};

export function PickerShell({
  title,
  borderColor = theme.border.picker,
  children,
}: PickerShellProps) {
  return (
    // flexShrink=0: footer-cluster anchoring (ticket 05) — a tall list never
    // squeezes when the terminal runs short; it truncates via pickerWindow.
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle={theme.border.style}
      borderColor={borderColor}
      paddingX={theme.spacing.pickerPadX}
    >
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

export function PickerMoreAbove({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Text dimColor>
      {theme.symbol.moreAbove} {count} more
    </Text>
  );
}

export function PickerMoreBelow({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Text dimColor>
      {theme.symbol.moreBelow} {count} more
    </Text>
  );
}

// Visible window for a picker: at most `visible` rows, scrolled so the
// highlight stays visible (centered while scrolling, pinned at both ends).
// Pure — the frame never grows past the window no matter how many rows
// the list holds. Shared by every windowed popup (pickers, slash menu,
// palette).
export const MODEL_PICKER_VISIBLE = 10;

export function pickerWindow(
  total: number,
  highlight: number,
  visible: number = MODEL_PICKER_VISIBLE
): { start: number; end: number } {
  if (total <= visible) return { start: 0, end: total };
  const h = Math.max(0, Math.min(highlight, total - 1));
  const start = Math.max(0, Math.min(h - Math.floor(visible / 2), total - visible));
  return { start, end: start + visible };
}

export type PickerRowProps = {
  highlighted: boolean;
  highlightColor?: string;
  children: React.ReactNode;
};

export function PickerRow({
  highlighted,
  highlightColor = theme.color.selection,
  children,
}: PickerRowProps) {
  return (
    <Text color={highlighted ? highlightColor : undefined}>
      {highlighted ? `${theme.symbol.select} ` : theme.spacing.rowIndent}
      {children}
    </Text>
  );
}
