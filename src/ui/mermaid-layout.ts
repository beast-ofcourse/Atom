// Mermaid flowchart layout: ParsedFlow -> PaintedRow[] (or null — caller
// falls back to the code block). Deterministic: same text, same picture.
//
// Geometry model: longest-path depth per node (bounded relaxation; cycles
// decline). Every node is a 3-row box with its label centered on the middle
// row; plain nodes (no brackets) are borderless boxes of the same size.
// Depth bands sit 5 rows apart (box + 2 always-free rows), so those rows
// are globally free and every edge elbow travels through one — no routed
// edge crosses a node box for adjacent-depth edges.
//
// placeSlots emits CANVAS coordinates directly: LR puts depth on X and
// stacks boxes vertically (uniform column width per depth); TD puts depth
// on Y and stacks boxes horizontally (per-node widths). Routes work on
// canvas rects, so both orientations share one drawing model.
//
// Edge labels paint ON the line (mermaid-style, glyphs replace the stroke)
// for horizontal runs; vertical straight edges place the label beside the
// line in free space. Labels never squeeze — no room, no label.
//
// Ordering within a depth is insertion order (deterministic; barycenter
// crossing reduction is a documented future step, not faked here).
// Self-loops decline at depthOf; overflow of the terminal budget declines.
//
// Known subset boundary: TD/LR edges spanning more than one depth band may
// cross an intermediate band's box; adjacent-depth edges never do.
import { CharCanvas, type CellStyle } from "./char-canvas.js";
import type { PaintedRow } from "./image-paint.js";
import type { FlowEdge, FlowNode, ParsedFlow } from "./mermaid-parse.js";

export type MermaidRenderStyles = {
  node?: string; // node border hue
  edge?: string; // edge stroke hue
  muted?: string; // edge labels
};

const BOX_H = 3; // rows per node box
const GAP_Y = 2; // always-free rows between depth bands
const SLOT_PITCH = BOX_H + GAP_Y; // 5 rows per depth band
const COL_GAP = 2; // free columns between side-by-side boxes (TD)
const GAP_X_COLS = 6; // free columns between depth columns (LR); fits short labels
const MIN_BOX_W = 4;

type Placed = FlowNode & {
  depth: number;
  slot: number;
  w: number; // box width in cells (canvas space)
  x: number; // canvas top-left (placeSlots emits canvas coords)
  y: number;
};

type Rect = { x: number; y: number; w: number; h: number };

function labelWidth(n: FlowNode): number {
  const len = [...n.label].length;
  if (n.shape === "diamond") return len + 6; // ◇ marker + interior pads
  return Math.max(MIN_BOX_W, len + 4); // borders + one pad per side
}

// Longest-path depth by bounded relaxation. Null when unsettled (cycle) or
// self-looped — both decline the whole diagram.
function depthOf(nodes: FlowNode[], edges: FlowEdge[]): Map<string, number> | null {
  const map = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const cap = nodes.length * 4 + 8;
  for (let iter = 0; iter < cap; iter++) {
    let changed = false;
    for (const e of edges) {
      if (e.from === e.to) return null;
      const want = (map.get(e.from) ?? 0) + 1;
      if ((map.get(e.to) ?? 0) < want) {
        map.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) return map;
  }
  return null;
}

function placeSlots(flow: ParsedFlow): { placed: Placed[]; depthSpan: number; stackSpan: number } | null {
  const depth = depthOf(flow.nodes, flow.edges);
  if (!depth) return null;
  const layers = new Map<number, FlowNode[]>();
  for (const n of flow.nodes) {
    const d = depth.get(n.id) ?? 0;
    const layer = layers.get(d) ?? [];
    layer.push(n);
    layers.set(d, layer);
  }
  const depths = [...layers.keys()].sort((a, b) => a - b);

  const placed: Placed[] = [];
  let depthSpan = 0; // canvas extent along the depth axis
  let stackSpan = 0; // canvas extent along the stacking axis
  if (flow.vertical) {
    // TD/TB/BT: depth bands stack downward; boxes sit side by side per band.
    for (const d of depths) {
      const layer = layers.get(d)!;
      const y = 1 + d * SLOT_PITCH;
      let left = 1;
      layer.forEach((n, slot) => {
        const w = labelWidth(n);
        placed.push({ ...n, depth: d, slot, w, x: left, y });
        left += w + COL_GAP;
      });
      depthSpan = Math.max(depthSpan, y + BOX_H);
      stackSpan = Math.max(stackSpan, left - COL_GAP);
    }
  } else {
    // LR/RL: depth columns left to right; boxes stack with a uniform
    // column width per depth (widest label in the band).
    let left = 1;
    for (const d of depths) {
      const layer = layers.get(d)!;
      const colW = Math.max(...layer.map(labelWidth));
      layer.forEach((n, slot) => {
        placed.push({ ...n, depth: d, slot, w: colW, x: left, y: 1 + slot * SLOT_PITCH });
      });
      depthSpan = Math.max(depthSpan, left + colW);
      stackSpan = Math.max(stackSpan, 1 + (layer.length - 1) * SLOT_PITCH + BOX_H);
      left += colW + GAP_X_COLS;
    }
  }
  return { placed, depthSpan, stackSpan };
}

export function layoutFlowchart(
  flow: ParsedFlow,
  colsBudget: number,
  rowsBudget: number,
  styles?: MermaidRenderStyles,
): PaintedRow[] | null {
  const geo = placeSlots(flow);
  if (!geo) return null;
  const byId = new Map(geo.placed.map((p) => [p.id, p]));

  const cols = (flow.vertical ? geo.stackSpan : geo.depthSpan) + 2;
  const rows = (flow.vertical ? geo.depthSpan : geo.stackSpan) + 2;
  if (cols > colsBudget || rows > rowsBudget) return null;

  const canvas = new CharCanvas(cols, rows);
  const nodeStyle: CellStyle | undefined = styles?.node ? { fg: styles.node } : undefined;
  const edgeStyle: CellStyle | undefined = styles?.edge ? { fg: styles.edge } : undefined;
  const mutedStyle: CellStyle | undefined = styles?.muted ? { fg: styles.muted } : undefined;

  const rects = new Map<string, Rect>();
  for (const p of geo.placed) {
    rects.set(p.id, { x: p.x, y: p.y, w: p.w, h: BOX_H });
    drawNode(canvas, p, nodeStyle);
  }
  for (const e of flow.edges) {
    const ra = rects.get(e.from);
    const rb = rects.get(e.to);
    if (!ra || !rb) return null;
    const drawn = flow.vertical
      ? routeVertical(canvas, e, ra, rb, edgeStyle, mutedStyle)
      : routeHorizontal(canvas, e, ra, rb, edgeStyle, mutedStyle);
    if (!drawn) return null;
  }
  return canvas.toRows();
}

function drawNode(canvas: CharCanvas, p: Placed, style: CellStyle | undefined): void {
  const label = p.shape === "diamond" ? `◇ ${p.label}` : p.label;
  const chars = [...label];
  if (p.shape !== "plain") {
    canvas.box(p.x, p.y, p.w, BOX_H, "solid", style, p.shape !== "rect");
  }
  const innerW = Math.max(1, p.w - 2);
  const clip = chars.length > innerW ? [...chars.slice(0, innerW - 1), "…"] : chars;
  const start = p.x + 1 + Math.floor((innerW - clip.length) / 2);
  for (let k = 0; k < clip.length; k++) {
    canvas.put(start + k, p.y + 1, clip[k]!);
  }
}

// End handling at the target border: arrow apex, o/x mark, or an open edge
// that closes the remaining gap to the border cell.
function finishAt(
  canvas: CharCanvas,
  edge: FlowEdge,
  apexX: number,
  apexY: number,
  dir: "right" | "down",
  openFrom: { x: number; y: number },
  stroke: "solid" | "dotted" | "thick",
  style?: CellStyle,
): void {
  if (edge.endMark) {
    canvas.put(apexX, apexY, edge.endMark === "o" ? "○" : "×", style);
    return;
  }
  if (edge.arrow) {
    canvas.arrow(apexX, apexY, dir, style);
    return;
  }
  canvas.hline(openFrom.x, apexX, openFrom.y, stroke, style);
  canvas.vline(openFrom.x, openFrom.y, apexY, stroke, style);
}

// Labels painted onto a stroke row: centered over the span, glyphs replace
// the line (a gap in the line reads as the label). Never squeezed.
function drawLabelOnLine(
  canvas: CharCanvas,
  row: number,
  from: number,
  to: number,
  label: string,
  style?: CellStyle,
): void {
  const chars = [...label];
  const span = Math.abs(to - from) + 1;
  if (span < chars.length + 1) return;
  const mid = Math.floor((from + to) / 2);
  const start = mid - Math.floor(chars.length / 2);
  canvas.text(start, row, label, style);
}

// Labels placed in free space: blank-checked per cell; any route crossing
// skips the label instead of overwriting it.
function drawLabelFree(
  canvas: CharCanvas,
  row: number,
  col: number,
  label: string,
  style?: CellStyle,
): void {
  const chars = [...label];
  for (let k = 0; k < chars.length; k++) {
    if (!canvas.isBlank(col + k, row)) return;
  }
  canvas.text(col, row, label, style);
}

// LR: depth on X. Source exits right border mid; target enters left.
function routeHorizontal(
  canvas: CharCanvas,
  edge: FlowEdge,
  ra: Rect,
  rb: Rect,
  edgeStyle?: CellStyle,
  mutedStyle?: CellStyle,
): boolean {
  const stroke = edge.stroke;
  const exitX = ra.x + ra.w; // first gap column right of the source box
  const entryX = rb.x - 2; // gap column left of the apex cell (rb.x - 1)
  const srcRow = ra.y + 1;
  const dstRow = rb.y + 1;
  if (ra.y === rb.y) {
    canvas.hline(exitX, entryX, srcRow, stroke, edgeStyle);
    finishAt(canvas, edge, rb.x - 1, srcRow, "right", { x: entryX, y: srcRow }, stroke, edgeStyle);
    if (edge.label) drawLabelOnLine(canvas, srcRow, exitX, entryX, edge.label, mutedStyle);
  } else {
    // Elbow through the always-free row above/below the source band.
    const bandY = dstRow < srcRow ? ra.y - GAP_Y : ra.y + BOX_H;
    canvas.vline(exitX, bandY, srcRow, stroke, edgeStyle);
    canvas.hline(exitX, entryX, bandY, stroke, edgeStyle);
    canvas.vline(entryX, bandY, dstRow, stroke, edgeStyle);
    finishAt(canvas, edge, rb.x - 1, dstRow, "right", { x: entryX, y: dstRow }, stroke, edgeStyle);
    if (edge.label) drawLabelOnLine(canvas, bandY, exitX, entryX, edge.label, mutedStyle);
  }
  if (edge.startMark) canvas.put(exitX, srcRow, edge.startMark === "o" ? "○" : "×", edgeStyle);
  return true;
}

// TD: depth on Y. Source exits bottom border center; target enters top.
function routeVertical(
  canvas: CharCanvas,
  edge: FlowEdge,
  ra: Rect,
  rb: Rect,
  edgeStyle?: CellStyle,
  mutedStyle?: CellStyle,
): boolean {
  const stroke = edge.stroke;
  const exitX = ra.x + Math.floor(ra.w / 2);
  const entryX = rb.x + Math.floor(rb.w / 2);
  const exitY = ra.y + ra.h; // first free row below the source box
  const entryY = rb.y - 1; // free row above the target's top border
  if (exitX === entryX) {
    canvas.vline(exitX, exitY, entryY, stroke, edgeStyle);
    finishAt(canvas, edge, exitX, rb.y, "down", { x: exitX, y: entryY }, stroke, edgeStyle);
    if (edge.label) drawLabelFree(canvas, Math.floor((exitY + entryY) / 2), exitX + 1, edge.label, mutedStyle);
  } else {
    // Elbow through the free row directly below the source band.
    canvas.hline(exitX, entryX, exitY, stroke, edgeStyle);
    canvas.vline(entryX, exitY, entryY, stroke, edgeStyle);
    finishAt(canvas, edge, entryX, rb.y, "down", { x: entryX, y: entryY }, stroke, edgeStyle);
    if (edge.label) drawLabelOnLine(canvas, exitY, exitX, entryX, edge.label, mutedStyle);
  }
  if (edge.startMark) canvas.put(exitX, exitY, edge.startMark === "o" ? "○" : "×", edgeStyle);
  return true;
}
