// Mermaid fence block: local flowchart rendering with byte-identical code
// block fallback. No network, no new dependencies — parsing + layout are
// pure (mermaid-parse/mermaid-layout), and any construct outside the
// documented subset declines to the plain ```mermaid code block the
// transcript painted before this feature existed. Painted rows memoize per
// fence text + width (cachePainted), so busy ticks never re-layout.
import React from "react";
import { CodeBlock, LIVE_CODEBLOCK_LINES } from "./CodeBlock.js";
import { PaintedRowsView, paintRowsCap } from "./PaintedView.js";
import { cachePainted, paintKeyHash } from "../image-paint.js";
import { parseFlowchart } from "../mermaid-parse.js";
import { layoutFlowchart, type MermaidRenderStyles } from "../mermaid-layout.js";
import { FALLBACK_SIZE, useTerminalSize } from "../layout.js";
import { theme } from "../theme.js";

export type MermaidBlockProps = {
  lines: string[];
  gap?: boolean;
  visibleLinesMax?: number;
};

// Beyond this, the fence is reference material, not a picture — the code
// block's own windowing handles it better than a giant diagram would.
const DIAGRAM_MAX_LINES = 200;

// Diagram hues reuse the theme palette by role: cyan = navigation for node
// borders, gray for edge labels. Edge strokes stay default (no hue).
function diagramStyles(): MermaidRenderStyles {
  return { node: theme.color.link, muted: theme.color.mutedPaint };
}

export const MermaidBlock = React.memo(function MermaidBlock({
  lines,
  gap = false,
  visibleLinesMax = LIVE_CODEBLOCK_LINES,
}: MermaidBlockProps) {
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
    <CodeBlock lang="mermaid" lines={lines} gap={gap} visibleLinesMax={visibleLinesMax} />
  );
  const text = lines.join("\n");
  if (columns < 50 || lines.length > DIAGRAM_MAX_LINES) return fallback;
  const rowsCap = paintRowsCap(rows);
  const painted = cachePainted(`mermaid:${paintKeyHash(text)}`, columns - 2, rowsCap, () => {
    const flow = parseFlowchart(text);
    if (!flow) return null;
    return layoutFlowchart(flow, columns - 2, rowsCap, diagramStyles());
  });
  if (!painted) return fallback;
  return <PaintedRowsView rows={painted} gap={gap} />;
});
