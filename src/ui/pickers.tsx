// Picker shells: the shared chrome behind every dropdown/popup in the TUI
// (model, skills, provider, effort, rewind, rewind-scope, slash menu).
// Prop-driven; all paint comes from ui/theme tokens. Per-picker polish
// chunks restyle this one shell instead of six copies.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { useTerminalSize } from "./layout.js";

export type PickerShellProps = {
  title: string;
  borderColor?: string;
  children: React.ReactNode;
  // Explicit width override (e.g. full-width dock slash menu). Default keeps
  // the legacy capped width so existing popups render byte-identically.
  width?: number;
  // Row cap (Phase 1 containment): the shell clips its own overflow instead
  // of growing the frame to the viewport — the cap is the leaf's
  // `overlayRows(rows, RESERVED_FOOTER_ROWS.<mode>)` budget. Undefined keeps
  // the legacy uncapped shell (frames that already fit are unchanged).
  maxRows?: number;
};

export function PickerShell({
  title,
  borderColor = theme.border.picker,
  children,
  width: widthProp,
  maxRows,
}: PickerShellProps) {
  let columns = 80;
  try {
    columns = useTerminalSize().columns;
  } catch {
    columns = 80;
  }
  // Responsive: on very narrow the picker would otherwise force horizontal
  // scroll and break its border. Clamp to terminal minus reserve and let
  // inner rows truncate.
  const width =
    typeof widthProp === "number" && Number.isFinite(widthProp) && widthProp > 0
      ? Math.max(20, Math.floor(widthProp))
      : Math.max(20, Math.min(columns - 2, 80));
  return (
    <Box
      flexDirection="column"
      borderStyle={theme.border.style}
      borderColor={borderColor}
      paddingX={theme.spacing.pickerPadX}
      width={width}
      maxHeight={maxRows}
      overflow="hidden"
    >
      {maxRows === undefined ? (
        <>
          <Text bold wrap="truncate">{title}</Text>
          {children}
        </>
      ) : (
        // Clip, never squeeze (Phase 1 spike): a height-capped Box shrinks
        // direct children fractionally, overprinting rows onto each other.
        // The unsquishable wrapper keeps every row at its natural height so
        // the shell's own overflow="hidden" clips the tail cleanly instead.
        <Box flexDirection="column" flexShrink={0}>
          <Text bold wrap="truncate">{title}</Text>
          {children}
        </Box>
      )}
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
// palette). Phase 4: the value is a theme token (theme.layout).
export const MODEL_PICKER_VISIBLE = theme.layout.pickerVisibleRows;

// Rows a picker shell renders besides its windowed rows: top + bottom
// border (2), bold title (1), and the above/below "N more" indicators
// (2 — both show mid-list). Callers subtract this from the shell's
// `overlayRows` cap to size the window so the whole shell stays inside it.
export const PICKER_SHELL_CHROME_ROWS = 5;

// Rows a GROUPED list (model/skill pickers) can render as group headers
// inside its window ("Remote", provider names). Windowed entry math counts
// ENTRIES, but headers are extra display rows — without reserving them the
// below-indicator falls past the shell cap and gets clipped. Modeled
// worst case for the registries; a degenerate list (an entry per provider)
// can still exceed it, and then the shell clips its tail cleanly (never
// squeezes — Phase 1 spike).
export const PICKER_GROUP_HEADER_ROWS = 4;

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
