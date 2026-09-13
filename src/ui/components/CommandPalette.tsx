// CommandPalette: searchable command index as a UI concept.
//
// Contract:
//   props.entries — paletteEntries() output (same SLASH_COMMANDS registry the
//   slash menu uses); props.index — highlight; props.filter — query text.
// Delegates to PalettePanel; owns no filtering, no dispatch, no busy-gate.
import React from "react";
import { PalettePanel, type PalettePanelProps } from "../palette.js";

export type CommandPaletteProps = PalettePanelProps;

export const CommandPalette = React.memo(function CommandPalette(props: CommandPaletteProps) {
  return <PalettePanel {...props} />;
});
