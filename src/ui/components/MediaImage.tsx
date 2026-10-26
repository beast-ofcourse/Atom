// Inline media descriptor: paints the stored PNG as half-block pixel art.
// The read tool stores bytes under ~/.atom/media/<id>.bin and the transcript
// carries the descriptor token `[media:<id> mime nB]`; until now the TUI
// painted that as one plain text line. This component keeps the text line
// as the *failure mode* (missing file, non-PNG, tiny terminal, decode
// refusal) and paints pixels when the PNG decodes — the descriptor text
// never changes shape, so fallback stays byte-identical.
//
// Size control: the agent may append `w=<cells>` / `h=<cells>` hints to the
// descriptor (`[media:<id> image/png 46B w=40 h=12]`). Hints are clamped
// into the terminal budget — they can size the paint, never overflow it —
// and may upscale. No hints → aspect-fit, never upscale (pixelGridFor).
//
// Perf: paint memoizes per id + hints + width (media files are immutable);
// PNG decode is bounded (oversize dims decline to the text line instead of
// blocking the frame on a 4K unfilter).
import React from "react";
import { Box, Text } from "ink";
import { cachePainted, paintHalfBlocks, agentGridFor, downscaleNearest } from "../image-paint.js";
import { decodePng } from "../png-decode.js";
import { loadMediaRaw } from "../../media.js";
import { FALLBACK_SIZE, useTerminalSize } from "../layout.js";
import { PaintedRowsView, paintRowsCap } from "./PaintedView.js";

export type MediaImageProps = {
  id: string;
  mime: string;
  /** The original descriptor paragraph — the byte-identical fallback. */
  rawText: string;
  /** Agent size hints (terminal cells), from `w=`/`h=` in the descriptor. */
  w?: number;
  h?: number;
  gap?: boolean;
};

// Decode/dims cap: 2048x2048 covers diagrams + screenshots; beyond that a
// synchronous unfilter would stall the paint scheduler for marginal gain.
const MAX_DECODE_DIM = 2048;

export const MediaImage = React.memo(function MediaImage({
  id,
  mime,
  rawText,
  w,
  h,
  gap = false,
}: MediaImageProps) {
  let columns: number;
  let rows: number;
  try {
    const size = useTerminalSize();
    columns = size.columns;
    rows = size.rows;
  } catch {
    columns = FALLBACK_SIZE.columns;
    rows = FALLBACK_SIZE.rows;
  }
  const margin = gap ? 1 : 0;
  const textLine = (
    <Box marginTop={margin}>
      <Text wrap="wrap">{rawText}</Text>
    </Box>
  );
  // PNG-only decode (this file's contract): JPEG/GIF/WebP keep the text line.
  if (columns < 40 || mime !== "image/png") return textLine;
  const rowsCap = paintRowsCap(rows);
  // Hints change the paint, so they change the cache entry too.
  const hintKey = (w !== undefined ? `|w${w}` : "") + (h !== undefined ? `|h${h}` : "");
  const painted = cachePainted(`media:${id}${hintKey}`, columns - 2, rowsCap, () => {
    const stored = loadMediaRaw(id);
    if (!stored) return null;
    let decoded: ReturnType<typeof decodePng>;
    try {
      decoded = decodePng(stored.raw);
    } catch {
      return null; // unsupported depth/interlace/corrupt: text line wins
    }
    if (decoded.width > MAX_DECODE_DIM || decoded.height > MAX_DECODE_DIM) return null;
    const grid = agentGridFor(decoded.width, decoded.height, columns - 2, rowsCap, w, h);
    const scaled = downscaleNearest(decoded, grid.tw, grid.th);
    return paintHalfBlocks(scaled);
  });
  if (!painted) return textLine;
  return <PaintedRowsView rows={painted} gap={gap} />;
});
