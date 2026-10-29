// Command-palette panel (Ctrl+P): grouped, searchable, keyboard-driven.
// Owns its display types (categories, hints); App builds the entries from
// the SLASH_COMMANDS registry (single command system) and owns the run
// gating. Windowed like every other popup; headers render for groups
// present in the window (plus the open group when sliced mid-way).
import React from "react";
import { Box, Text } from "ink";
import { PickerMoreAbove, PickerMoreBelow, pickerWindow } from "./pickers.js";
import { theme } from "./theme.js";

export const PALETTE_WINDOW = 12;

export const PALETTE_CATEGORY_ORDER = ["Model", "Session", "Tools", "Skills", "Flow", "Extensions", "Help"] as const;
export type PaletteCategory = (typeof PALETTE_CATEGORY_ORDER)[number];

const PALETTE_CATEGORIES: Record<string, PaletteCategory> = {
  "/model": "Model",
  "/provider": "Model",
  "/effort": "Model",
  "/compact": "Session",
  "/clear": "Session",
  "/new": "Session",
  "/resume": "Session",
  "/rename": "Session",
  "/session": "Session",
  "/rewind": "Session",
  "/reload": "Session",
  "/context": "Session",
  "/telemetry": "Session",
  "/dashboard": "Session",
  "/tools": "Tools",
  "/mode": "Tools",
  "/trust": "Tools",
  "/allow": "Tools",
  "/deny": "Tools",
  "/rules": "Tools",
  "/skill": "Skills",
  "/queue": "Flow",
  "/steer": "Flow",
  "/autoscroll": "Flow",
  "/thinking": "Flow",
  "/redraw": "Flow",
  "/help": "Help",
  "/exit": "Help",
  "/quit": "Help",
};

export function paletteCategory(name: string): PaletteCategory {
  return PALETTE_CATEGORIES[name] ?? "Help";
}

// Real key bindings only — shown as row hints, never invented.
// (Mode switching lives on Tab alone now, so no command carries it.)
export const PALETTE_HINTS: Record<string, string> = {
  "/exit": "Ctrl+C",
  "/quit": "Ctrl+C",
};

export type PaletteEntry = {
  name: string;
  description: string;
  category: PaletteCategory;
  hint: string | null;
};

export type PalettePanelProps = {
  entries: PaletteEntry[];
  index: number;
  filter: string;
  // Row cap (Phase 1 containment): the panel clips its own overflow instead
  // of growing the frame to the viewport — App passes
  // `overlayRows(rows, RESERVED_FOOTER_ROWS.palette)`. Undefined keeps the
  // legacy PALETTE_WINDOW byte-identically.
  maxRows?: number;
};

// Panel rows besides the windowed rows: borders 2 + bold header 1 + filter
// line 1 + above/below indicators 2.
const PALETTE_CHROME_ROWS = 6;

export const PalettePanel = React.memo(function PalettePanel({ entries, index, filter, maxRows }: PalettePanelProps) {
  const hi = entries.length === 0 ? 0 : Math.max(0, Math.min(index, entries.length - 1));
  const windowRows =
    maxRows === undefined
      ? PALETTE_WINDOW
      : Math.max(1, Math.min(PALETTE_WINDOW, maxRows - PALETTE_CHROME_ROWS));
  const win = pickerWindow(entries.length, hi, windowRows);
  const slice = entries.slice(win.start, win.end);
  const rows: React.ReactNode[] = [];
  let lastCat: string | null = null;
  if (slice.length > 0 && win.start > 0) {
    // Sliced mid-group: name the open group so rows never float headerless.
    lastCat = slice[0]!.category;
    rows.push(
      <Text key={`cat-${lastCat}`} dimColor>
        {lastCat}
      </Text>
    );
  }
  slice.forEach((e, k) => {
    const i = win.start + k;
    if (e.category !== lastCat) {
      lastCat = e.category;
      rows.push(
        <Text key={`cat-${e.category}-${i}`} dimColor>
          {e.category}
        </Text>
      );
    }
    rows.push(
      <Text key={`${e.name}-${i}`} color={i === hi ? theme.color.menuSelection : undefined}>
        {i === hi ? `${theme.symbol.select} ` : theme.spacing.rowIndent}
        {e.name}
        {e.description ? ` ${theme.symbol.descSeparator} ${e.description}` : ""}
        {e.hint ? <Text dimColor> · {e.hint}</Text> : null}
      </Text>
    );
  });
  return (
    // flexShrink=0: footer-cluster anchoring (ticket 05) — same contract as
    // PickerShell; the list truncates via pickerWindow instead of squeezing.
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle={theme.border.style}
      borderColor={theme.border.menu}
      paddingX={theme.spacing.pickerPadX}
      maxHeight={maxRows}
      overflow="hidden"
    >
      {/* Clip, never squeeze (Phase 1 spike): a height-capped Box shrinks
        direct flex children fractionally, overprinting rows onto each other.
        Long descriptions wrap and inflate the natural row count past the
        window's entry math, so the unsquishable wrapper keeps every row at
        its natural height and the panel clips its tail cleanly instead. */}
      <Box flexDirection="column" flexShrink={0}>
        <Text bold>Search commands — type to filter (↑/↓ + Enter to run, Esc closes):</Text>
        <Text>
          <Text color={theme.color.inputPrompt} bold>
            {theme.symbol.inputPrompt}{" "}
          </Text>
          {filter}
          <Text color={theme.color.mutedPaint}>{theme.symbol.cursorBlock}</Text>
        </Text>
        <PickerMoreAbove count={win.start} />
        {rows}
        <PickerMoreBelow count={entries.length - win.end} />
        {entries.length === 0 ? <Text dimColor>No commands match — backspace to widen.</Text> : null}
      </Box>
    </Box>
  );
});
