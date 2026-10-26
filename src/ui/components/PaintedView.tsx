// Shared paint output view: PaintedRow[] -> Ink <Text> tree. One <Text> per
// row, one child per coalesced run — the node budget every producer
// (mermaid / svg / png media) already optimized for. Rows paint at fixed
// width, so truncation only guards resize races; wrap would re-flow pixel
// grids into noise.
import React from "react";
import { Box, Text } from "ink";
import type { PaintedRow } from "../image-paint.js";

// Diagram height budget: 3× the visible row count is usually still readable
// on tall terminals, floored at 6 rows (a minimal diagram) and capped at 90
// (a screenful and a half — beyond that it's reference material, not a
// picture). One helper, three producers: MediaImage, MermaidBlock, SvgBlock.
const PAINT_ROWS_CAP = 90;
export function paintRowsCap(rows: number): number {
  return Math.min(Math.max(6, rows * 3), PAINT_ROWS_CAP);
}

export function PaintedRowsView({ rows, gap }: { rows: PaintedRow[]; gap?: boolean }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={gap ? 1 : 0}>
      {rows.map((row, k) =>
        row.runs.length === 0 ? (
          <Text key={k}> </Text>
        ) : (
          <Text key={k} wrap="truncate">
            {row.runs.map((r, i) => (
              <Text key={i} color={r.fg} backgroundColor={r.bg}>
                {r.text}
              </Text>
            ))}
          </Text>
        ),
      )}
    </Box>
  );
}
