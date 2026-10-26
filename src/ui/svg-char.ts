// SVG subset -> character grid. Zero dependencies, local only. Companion
// producer to mermaid-layout: same CharCanvas + PaintedRow output contract
// (rows of coalesced style runs, one <Text> per style change).
//
// Supported subset (deliberate, documented): <svg> root with viewBox or
// width/height; <g> fill/stroke/translate inheritance; <rect>, <circle>,
// <ellipse>, <line>, <polyline>, <polygon>, <text>, and <path> with
// M/L/H/V/C/Q/S/Z (+ relative forms). Everything else is skipped per
// element — unknown decoration never fails the whole picture; only a
// missing coordinate system or an empty element set declines (caller falls
// back to the code block).
//
// Rendering decisions (documented, not silent):
// - Fills are ignored; shapes render outline-only. On a dark terminal the
//   outline carries the structure; shading a char grid buys little.
// - Arcs (A/a) render as straight segments to their endpoint — honest
//   approximation, flagged here rather than guessed prettier.
// - transforms other than translate() are ignored.
// - Curves sample to per-cell dots ('·'); orthogonal strokes use real
//   box-drawing glyphs via CharCanvas.
import { CharCanvas, type CellStyle } from "./char-canvas.js";
import type { PaintedRow } from "./image-paint.js";

export type SvgRenderStyles = {
  stroke?: string; // default stroke hue when none specified
};

export function renderSvg(
  text: string,
  cols: number,
  rowsCap: number,
  styles?: SvgRenderStyles,
): PaintedRow[] | null {
  const grid = svgGrid(text, cols, rowsCap, styles);
  return grid ? grid.toRows() : null;
}

// --- Parsing -------------------------------------------------------------

type GState = { fill?: string; stroke?: string; dx: number; dy: number };

type Draw =
  | { kind: "box"; x: number; y: number; w: number; h: number; rounded: boolean; stroke?: string }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; stroke?: string }
  | { kind: "segment"; x1: number; y1: number; x2: number; y2: number; stroke?: string }
  | { kind: "poly"; pts: [number, number][]; closed: boolean; stroke?: string }
  | { kind: "dots"; pts: [number, number][]; stroke?: string }
  | { kind: "text"; x: number; y: number; s: string; anchor: string; color?: string };

function attrsOf(tag: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    map.set(m[1]!, m[2] ?? m[3] ?? "");
  }
  return map;
}

function num(map: Map<string, string>, key: string): number | null {
  const v = map.get(key);
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const NAMED_COLORS: Record<string, string> = {
  black: "rgb(0,0,0)",
  white: "rgb(255,255,255)",
  red: "rgb(255,0,0)",
  green: "rgb(0,128,0)",
  lime: "rgb(0,255,0)",
  blue: "rgb(0,0,255)",
  yellow: "rgb(255,255,0)",
  cyan: "rgb(0,255,255)",
  magenta: "rgb(255,0,255)",
  gray: "rgb(128,128,128)",
  grey: "rgb(128,128,128)",
  orange: "rgb(255,165,0)",
  purple: "rgb(128,0,128)",
};

// Returns a css color, `null` for explicit none, or undefined (inherit).
function color(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (s === "" || s === "none") return null;
  if (s === "currentColor" || s === "inherit") return undefined;
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return `rgb(${parseInt(hex[0]! + hex[0]!, 16)},${parseInt(hex[1]! + hex[1]!, 16)},${parseInt(hex[2]! + hex[2]!, 16)})`;
    }
    if (hex.length === 6) {
      return `rgb(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)})`;
    }
    return undefined;
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (rgb) {
    return `rgb(${Math.round(Number(rgb[1]))},${Math.round(Number(rgb[2]))},${Math.round(Number(rgb[3]))})`;
  }
  return NAMED_COLORS[s.toLowerCase()];
}

// viewBox / width / height -> canvas mapping. Cell aspect is ~1:2 (glyph),
// so vertical units halve: pixelsH = rows * 2.
function coordinateSystem(
  rootAttrs: Map<string, string>,
  cols: number,
  rows: number,
): { scale: number; ox: number; oy: number } | null {
  let vx = 0;
  let vy = 0;
  let vw: number | null = null;
  let vh: number | null = null;
  const vb = rootAttrs.get("viewBox");
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      vx = parts[0]!;
      vy = parts[1]!;
      vw = parts[2]!;
      vh = parts[3]!;
    }
  }
  if (vw === null || vh === null || vw <= 0 || vh <= 0) {
    vw = num(rootAttrs, "width");
    vh = num(rootAttrs, "height");
  }
  if (vw === null || vh === null || vw <= 0 || vh <= 0) return null;
  if (vw > 4096 || vh > 4096) return null;
  // Usable cell area: one-cell margin; pixelsW = cols-2, pixelsH = (rows-2)*2.
  const scale = Math.min((cols - 2) / vw, ((rows - 2) * 2) / vh);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return { scale, ox: 1 - vx * scale, oy: 1 - vy * scale };
}

// --- Path data -----------------------------------------------------------

// Tokenize + execute a `d` attribute. Unknown commands skip their payload
// conservatively (letters resync); arcs approximate to a line.
function pathToSegments(d: string): { segs: [number, number, number, number][]; dots: [number, number][] } {
  const segs: [number, number, number, number][] = [];
  const dots: [number, number][] = [];
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  let cmd = "";
  const next = (): number => {
    const v = Number(tokens[i]);
    i += 1;
    return Number.isFinite(v) ? v : 0;
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i += 1;
      if (cmd === "Z" || cmd === "z") {
        segs.push([cx, cy, sx, sy]);
        continue;
      }
      continue;
    }
    switch (cmd) {
      case "M":
      case "m": {
        const x = next() + (cmd === "m" ? cx : 0);
        const y = next() + (cmd === "m" ? cy : 0);
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        cmd = cmd === "m" ? "l" : "L"; // implicit lineto after moveto
        break;
      }
      case "L":
      case "l": {
        const x = next() + (cmd === "l" ? cx : 0);
        const y = next() + (cmd === "l" ? cy : 0);
        segs.push([cx, cy, x, y]);
        cx = x;
        cy = y;
        break;
      }
      case "H":
      case "h": {
        const x = next() + (cmd === "h" ? cx : 0);
        segs.push([cx, cy, x, cy]);
        cx = x;
        break;
      }
      case "V":
      case "v": {
        const y = next() + (cmd === "v" ? cy : 0);
        segs.push([cx, cy, cx, y]);
        cy = y;
        break;
      }
      case "C":
      case "c":
      case "Q":
      case "q":
      case "S":
      case "s":
      case "T":
      case "t": {
        const rel = cmd === "c" || cmd === "q" || cmd === "s" || cmd === "t";
        const arity = cmd.toLowerCase() === "c" || cmd.toLowerCase() === "s" ? 6 : 4;
        const x0 = cx;
        const y0 = cy;
        const vals: number[] = [];
        for (let k = 0; k < arity; k++) vals.push(next() + (rel ? (k % 2 === 0 ? cx : cy) : 0));
        const x = vals[arity - 2]!;
        const y = vals[arity - 1]!;
        // Sample the curve as dots (control points ignored — outline shape
        // dominates at cell resolution).
        for (let s = 1; s <= 6; s++) {
          const tt = s / 7;
          dots.push([x0 + (x - x0) * tt, y0 + (y - y0) * tt]);
        }
        cx = x;
        cy = y;
        break;
      }
      case "A":
      case "a": {
        // Arc approximated by its endpoint chord.
        next();
        next();
        next();
        const large = next();
        void large;
        const sweep = next();
        void sweep;
        const x = next() + (cmd === "a" ? cx : 0);
        const y = next() + (cmd === "a" ? cy : 0);
        segs.push([cx, cy, x, y]);
        cx = x;
        cy = y;
        break;
      }
      default: {
        i += 1; // unknown payload token: skip one, keep scanning
      }
    }
  }
  return { segs, dots };
}

// --- Element walk ---------------------------------------------------------

function svgGrid(
  text: string,
  cols: number,
  rowsCap: number,
  styles?: SvgRenderStyles,
): CharCanvas | null {
  // <text> needs its content: capture those first, then hide them from the
  // element scan (their inner text is not attribute grammar).
  const texts: { attrs: Map<string, string>; s: string }[] = [];
  const textRe = /<text\b([^>]*)>([^<]*)<\/text\s*>/g;
  let m: RegExpExecArray | null;
  const scrubbed = text.replace(textRe, (_all, tag, content) => {
    texts.push({ attrs: attrsOf(tag as string), s: decodeText(content as string) });
    return "";
  });

  const root = scrubbed.match(/<svg\b([^>]*)>/i);
  if (!root) return null;
  const cs = coordinateSystem(attrsOf(root[1]!), cols, rowsCap);
  if (!cs) return null;

  const draw: Draw[] = [];
  const gStack: GState[] = [{ dx: 0, dy: 0 }];
  const elRe = /<(\/?)(g|rect|circle|ellipse|line|polyline|polygon|path)\b([^>]*?)(\/?)>/g;
  while ((m = elRe.exec(scrubbed)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2]!;
    const attrs = attrsOf(m[3] ?? "");
    if (tag === "g") {
      if (closing) {
        if (gStack.length > 1) gStack.pop();
      } else {
        const parent = gStack[gStack.length - 1]!;
        const fill = color(attrs.get("fill")) ?? parent.fill ?? undefined;
        const stroke = color(attrs.get("stroke")) ?? parent.stroke ?? undefined;
        const tr = attrs.get("transform");
        const translate = tr?.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/);
        const dx = translate ? Number(translate[1]) : 0;
        const dy = translate ? Number(translate[2]) : 0;
        gStack.push({ fill, stroke, dx: parent.dx + (Number.isFinite(dx) ? dx : 0), dy: parent.dy + (Number.isFinite(dy) ? dy : 0) });
      }
      continue;
    }
    if (closing) continue;
    const g = gStack[gStack.length - 1]!;
    const stroke = color(attrs.get("stroke")) ?? g.stroke ?? styles?.stroke;
    pushElement(tag, attrs, g, stroke, draw);
  }
  for (const t of texts) {
    const g = gStack[0]!;
    const c = color(t.attrs.get("fill")) ?? g.fill ?? undefined;
    const x = (num(t.attrs, "x") ?? 0) + g.dx;
    const y = (num(t.attrs, "y") ?? 0) + g.dy;
    draw.push({ kind: "text", x, y, s: t.s, anchor: (t.attrs.get("text-anchor") ?? "").trim(), color: c ?? undefined });
  }
  if (draw.length === 0) return null;

  // Rasterize: viewBox units -> cells. Straight axis-aligned segments go
  // through hline/vline for real box glyphs; the rest sample to dots.
  const canvas = new CharCanvas(cols, Math.max(2, rowsCap));
  const cellOf = (x: number, y: number): [number, number] => [
    Math.round(x * cs.scale + cs.ox),
    Math.round(y * cs.scale / 2 + cs.oy),
  ];
  const cellStyle = (c: string | undefined): CellStyle | undefined => (c ? { fg: c } : undefined);

  for (const d of draw) {
    const style = d.kind === "text" ? cellStyle(d.color) : cellStyle(d.stroke);
    switch (d.kind) {
      case "box": {
        const [x1, y1] = cellOf(d.x, d.y);
        const [x2, y2] = cellOf(d.x + d.w, d.y + d.h);
        canvas.box(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1) + 1, Math.abs(y2 - y1) + 1, "solid", style, d.rounded);
        break;
      }
      case "ellipse": {
        const [cx, cy] = cellOf(d.cx, d.cy);
        const [rx, ry] = cellOf(d.rx, d.ry);
        ellipseDots(canvas, cx, cy, Math.max(1, Math.abs(rx)), Math.max(1, Math.abs(ry)), style);
        break;
      }
      case "segment": {
        const [x1, y1] = cellOf(d.x1, d.y1);
        const [x2, y2] = cellOf(d.x2, d.y2);
        drawSegment(canvas, x1, y1, x2, y2, style);
        break;
      }
      case "poly": {
        for (let k = 0; k < d.pts.length - 1; k++) {
          const [x1, y1] = cellOf(d.pts[k]![0], d.pts[k]![1]);
          const [x2, y2] = cellOf(d.pts[k + 1]![0], d.pts[k + 1]![1]);
          drawSegment(canvas, x1, y1, x2, y2, style);
        }
        if (d.closed && d.pts.length > 2) {
          const [x1, y1] = cellOf(d.pts[d.pts.length - 1]![0], d.pts[d.pts.length - 1]![1]);
          const [x2, y2] = cellOf(d.pts[0]![0], d.pts[0]![1]);
          drawSegment(canvas, x1, y1, x2, y2, style);
        }
        break;
      }
      case "dots": {
        for (const [px, py] of d.pts) {
          const [x, y] = cellOf(px, py);
          canvas.put(x, y, "·", style);
        }
        break;
      }
      case "text": {
        const [x, y] = cellOf(d.x, d.y);
        const offset = d.anchor === "middle" ? Math.floor(d.s.length / 2) : d.anchor === "end" ? d.s.length : 0;
        canvas.text(x - offset, y, d.s, cellStyle(d.color));
        break;
      }
    }
  }
  return canvas;
}

function pushElement(
  tag: string,
  attrs: Map<string, string>,
  g: GState,
  stroke: string | undefined,
  draw: Draw[],
): void {
  const dx = g.dx;
  const dy = g.dy;
  const n = (k: string): number | null => {
    const v = num(attrs, k);
    return v === null ? null : v;
  };
  switch (tag) {
    case "rect": {
      const x = (n("x") ?? 0) + dx;
      const y = (n("y") ?? 0) + dy;
      const w = n("width");
      const h = n("height");
      if (w === null || h === null || w <= 0 || h <= 0) return;
      draw.push({ kind: "box", x, y, w, h, rounded: (n("rx") ?? 0) > 0, stroke });
      return;
    }
    case "circle": {
      const cx = (n("cx") ?? 0) + dx;
      const cy = (n("cy") ?? 0) + dy;
      const r = n("r");
      if (r === null || r <= 0) return;
      draw.push({ kind: "ellipse", cx, cy, rx: r, ry: r, stroke });
      return;
    }
    case "ellipse": {
      const cx = (n("cx") ?? 0) + dx;
      const cy = (n("cy") ?? 0) + dy;
      const rx = n("rx");
      const ry = n("ry");
      if (rx === null || ry === null || rx <= 0 || ry <= 0) return;
      draw.push({ kind: "ellipse", cx, cy, rx, ry, stroke });
      return;
    }
    case "line": {
      const x1 = n("x1");
      const y1 = n("y1");
      const x2 = n("x2");
      const y2 = n("y2");
      if (x1 === null || y1 === null || x2 === null || y2 === null) return;
      draw.push({ kind: "segment", x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy, stroke });
      return;
    }
    case "polyline":
    case "polygon": {
      const pts = (attrs.get("points") ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter((v) => Number.isFinite(v));
      if (pts.length < 4) return;
      const pairs: [number, number][] = [];
      for (let k = 0; k + 1 < pts.length; k += 2) {
        pairs.push([pts[k]! + dx, pts[k + 1]! + dy]);
      }
      draw.push({ kind: "poly", pts: pairs, closed: tag === "polygon", stroke });
      return;
    }
    case "path": {
      const dd = attrs.get("d");
      if (!dd) return;
      const parsed = pathToSegments(dd);
      const sx = dx;
      const sy = dy;
      for (const [x1, y1, x2, y2] of parsed.segs) {
        draw.push({ kind: "segment", x1: x1 + sx, y1: y1 + sy, x2: x2 + sx, y2: y2 + sy, stroke });
      }
      if (parsed.dots.length > 0) {
        draw.push({ kind: "dots", pts: parsed.dots.map(([x, y]) => [x + sx, y + sy]), stroke });
      }
      return;
    }
    default:
      return;
  }
}

// Axis-aligned segments paint with box glyphs; anything else samples dots
// along the way (per-cell, deduped by put).
function drawSegment(
  canvas: CharCanvas,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  style?: CellStyle,
): void {
  if (y1 === y2) {
    canvas.hline(x1, x2, y1, "solid", style);
    return;
  }
  if (x1 === x2) {
    canvas.vline(x1, y1, y2, "solid", style);
    return;
  }
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    canvas.put(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), "·", style);
  }
}

function ellipseDots(
  canvas: CharCanvas,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  style?: CellStyle,
): void {
  // Aspect: vertical cells cover 2 pixel rows, so sample with the same
  // 1:2 stretch the coordinate mapping applies.
  const steps = Math.max(16, Math.round((rx + ry) * 4));
  for (let s = 0; s < steps; s++) {
    const t = (s / steps) * Math.PI * 2;
    canvas.put(Math.round(cx + rx * Math.cos(t)), Math.round(cy + ry * Math.sin(t)), "·", style);
  }
}

// XML predefined entities in SVG <text> content. &amp; decodes LAST so a
// literal "&lt;" in the source (written as &amp;lt;) stays "&lt;" instead
// of double-decoding to "<".
function decodeText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
