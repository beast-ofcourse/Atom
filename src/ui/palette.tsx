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

export const PALETTE_CATEGORY_ORDER = ["Model", "Session", "Tools", "Skills", "Flow", "Help"] as const;
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
  "/context": "Session",
  "/telemetry": "Session",
  "/dashboard": "Session",
  "/tools": "Tools",
  "/mode": "Tools",
  "/trust": "Tools",
  "/allow": "Tools",
  "/deny": "Tools",
  "/rules": "Tools",
  "/skills": "Skills",
  "/skill": "Skills",
  "/queue": "Flow",
  "/steer": "Flow",
  "/autoscroll": "Flow",
  "/thinking": "Flow",
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
};

export const PalettePanel = React.memo(function PalettePanel({ entries, index, filter }: PalettePanelProps) {
  const hi = entries.length === 0 ? 0 : Math.max(0, Math.min(index, entries.length - 1));
  const win = pickerWindow(entries.length, hi, PALETTE_WINDOW);
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
    <Box
      flexDirection="column"
      borderStyle={theme.border.style}
      borderColor={theme.border.menu}
      paddingX={theme.spacing.pickerPadX}
    >
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
  );
});
