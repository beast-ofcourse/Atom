// SVG fence block: local subset rendering with byte-identical code block
// fallback (same contract as MermaidBlock — see svg-char.ts for the exact
// supported subset and documented rendering decisions).
import React from "react";
import { CodeBlock, LIVE_CODEBLOCK_LINES } from "./CodeBlock.js";
import { PaintedRowsView, paintRowsCap } from "./PaintedView.js";
import { cachePainted, paintKeyHash } from "../image-paint.js";
import { renderSvg } from "../svg-char.js";
import { FALLBACK_SIZE, useTerminalSize } from "../layout.js";

export type SvgBlockProps = {
  lines: string[];
  gap?: boolean;
  visibleLinesMax?: number;
};

const SVG_MAX_LINES = 400;

export const SvgBlock = React.memo(function SvgBlock({
  lines,
  gap = false,
  visibleLinesMax = LIVE_CODEBLOCK_LINES,
}: SvgBlockProps) {
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
  const fallback = (
    <CodeBlock lang="svg" lines={lines} gap={gap} visibleLinesMax={visibleLinesMax} />
  );
  const text = lines.join("\n");
  if (columns < 50 || lines.length > SVG_MAX_LINES) return fallback;
  const rowsCap = paintRowsCap(rows);
  const painted = cachePainted(`svg:${paintKeyHash(text)}`, columns - 2, rowsCap, () =>
    renderSvg(text, columns - 2, rowsCap),
  );
  if (!painted) return fallback;
  return <PaintedRowsView rows={painted} gap={gap} />;
});
