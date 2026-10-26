// Character-grid canvas for vector-ish terminal rendering (SVG subset +
// mermaid flowcharts). Same output contract as image-paint (`PaintedRow`):
// rows of coalesced style runs, one <Text> per run at the component layer.
//
// Straight strokes register a connection bitmask per cell (which neighbors
// the stroke touches) plus that stroke's weight, and junction glyphs
// (┌ ┘ ┼ ├ …) resolve once at paint time: elbows form corners, crossings
// form ┼, lines joining a box border merge cleanly. Explicit `put()`
// glyphs (labels, arrowheads) always win over junction resolution.
//
// All geometry is integer cell space; blank cells stay blank (no background
// paint) so the canvas drops onto any theme. Pure + synchronous: producers
// call, memoize, paint.
import type { PaintedRow } from "./image-paint.js";

export type CellStyle = { fg?: string; bg?: string };

// Stroke weight: shaft family. Solid ─ │; dotted ┄ ┆; thick ━ ┃. Corners
// reuse the weight's shaft glyph — there is no real dotted corner char
// worth faking, dots read fine at the turn.
export type Stroke = "solid" | "dotted" | "thick";

// Connection bits a stroke writes into a cell.
const N = 1;
const E = 2;
const S = 4;
const W = 8;

const WEIGHTS: Record<Stroke, number> = { solid: 0, dotted: 1, thick: 2 };

// Full solid-mask table (16 combinations). An end cell links only toward
// its own body, so a turn resolves as a corner glyph, never a cross.
const SOLID_MASKS: Record<number, string> = {
  [0]: "─",
  [E]: "─",
  [W]: "─",
  [E | W]: "─",
  [N]: "│",
  [S]: "│",
  [N | S]: "│",
  [E | S]: "┌",
  [W | S]: "┐",
  [E | N]: "└",
  [W | N]: "┘",
  [E | W | S]: "┬",
  [E | W | N]: "┴",
  [N | S | E]: "├",
  [N | S | W]: "┤",
  [N | S | E | W]: "┼",
};

// Non-solid weights keep their shaft glyphs for every mask.
function shaftFor(weight: 1 | 2, mask: number): string {
  const horizontal = (mask & E) !== 0 || (mask & W) !== 0;
  if (weight === 1) return horizontal ? "┄" : "┆";
  return horizontal ? "━" : "┃";
}

export class CharCanvas {
  readonly cols: number;
  readonly rows: number;
  private glyph: (string | undefined)[] = [];
  private style: (CellStyle | undefined)[] = [];
  private links: number[] = [];
  private weight: number[] = [];

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    const n = this.cols * this.rows;
    this.glyph = new Array<string | undefined>(n).fill(undefined);
    this.style = new Array<CellStyle | undefined>(n).fill(undefined);
    this.links = new Array<number>(n).fill(0);
    this.weight = new Array<number>(n).fill(WEIGHTS.solid);
  }

  private idx(x: number, y: number): number {
    return y * this.cols + x;
  }

  private inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  // Explicit glyph: wins over any junction resolution at this cell.
  put(x: number, y: number, ch: string, style?: CellStyle): void {
    if (!this.inside(x, y)) return;
    const i = this.idx(x, y);
    this.glyph[i] = ch;
    this.style[i] = style ?? this.style[i];
  }

  // True when nothing was drawn here — used by layout to test label fit.
  isBlank(x: number, y: number): boolean {
    if (!this.inside(x, y)) return false;
    const i = this.idx(x, y);
    return this.glyph[i] === undefined && this.links[i] === 0;
  }

  // Horizontal stroke. End cells link toward the line body only, so an
  // elbow (hline ending where a vline starts at the same cell) resolves as
  // a corner rather than a cross.
  hline(x1: number, x2: number, y: number, stroke: Stroke, style?: CellStyle): void {
    if (!this.inside(0, y)) return;
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    const wt = WEIGHTS[stroke];
    for (let x = lo; x <= hi; x++) {
      if (x < 0 || x >= this.cols) continue;
      const i = this.idx(x, y);
      this.links[i] |= x === lo ? E : x === hi ? W : E | W;
      this.weight[i] = wt;
      this.style[i] = style ?? this.style[i];
    }
  }

  // Vertical stroke; same end-cell rule as hline.
  vline(x: number, y1: number, y2: number, stroke: Stroke, style?: CellStyle): void {
    if (!this.inside(x, 0)) return;
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    const wt = WEIGHTS[stroke];
    for (let y = lo; y <= hi; y++) {
      if (y < 0 || y >= this.rows) continue;
      const i = this.idx(x, y);
      this.links[i] |= y === lo ? S : y === hi ? N : N | S;
      this.weight[i] = wt;
      this.style[i] = style ?? this.style[i];
    }
  }

  // Arrowhead apex at a cell. Weight is carried by the shaft; dotted and
  // thick arrows share the solid tip family.
  arrow(x: number, y: number, dir: "right" | "left" | "down" | "up", style?: CellStyle): void {
    const ch = dir === "right" ? "▸" : dir === "left" ? "◂" : dir === "down" ? "▾" : "▴";
    this.put(x, y, ch, style);
  }

  text(x: number, y: number, s: string, style?: CellStyle): void {
    for (let k = 0; k < s.length; k++) {
      this.put(x + k, y, s[k]!, style);
    }
  }

  // Box with optional rounded corners (solid only; other weights use their
  // square corners). Interior stays untouched so labels drawn earlier
  // survive border-after-text ordering.
  box(
    x: number,
    y: number,
    w: number,
    h: number,
    stroke: Stroke,
    style?: CellStyle,
    rounded = true,
  ): void {
    if (w < 2 || h < 2) return;
    const x2 = x + w - 1;
    const y2 = y + h - 1;
    if (rounded && stroke === "solid") {
      this.put(x, y, "╭", style);
      this.put(x2, y, "╮", style);
      this.put(x, y2, "╰", style);
      this.put(x2, y2, "╯", style);
    } else {
      const heavy = stroke === "thick";
      this.put(x, y, heavy ? "┏" : "┌", style);
      this.put(x2, y, heavy ? "┓" : "┐", style);
      this.put(x, y2, heavy ? "┗" : "└", style);
      this.put(x2, y2, heavy ? "┛" : "┘", style);
    }
    if (x2 > x + 1) {
      this.hline(x + 1, x2 - 1, y, stroke, style);
      this.hline(x + 1, x2 - 1, y2, stroke, style);
    }
    if (y2 > y + 1) {
      this.vline(x, y + 1, y2 - 1, stroke, style);
      this.vline(x2, y + 1, y2 - 1, stroke, style);
    }
  }

  // Rows of coalesced runs: junction glyphs resolve from the link masks,
  // then identical-style neighbors merge into one run — one <Text> per
  // style change, the same node budget as the raster painter.
  toRows(): PaintedRow[] {
    const rows: PaintedRow[] = [];
    for (let y = 0; y < this.rows; y++) {
      const runs: PaintedRow["runs"] = [];
      let cur: { text: string; fg?: string; bg?: string } | null = null;
      const flush = () => {
        if (cur && cur.text.length > 0) runs.push({ ...cur });
        cur = null;
      };
      for (let x = 0; x < this.cols; x++) {
        const i = this.idx(x, y);
        const explicit = this.glyph[i];
        let ch: string;
        if (explicit !== undefined) {
          ch = explicit;
        } else {
          const mask = this.links[i];
          const wt = this.weight[i];
          ch = wt === WEIGHTS.solid ? (SOLID_MASKS[mask] ?? "─") : shaftFor(wt === 1 ? 1 : 2, mask);
        }
        const st = this.style[i];
        if (cur && cur.fg === st?.fg && cur.bg === st?.bg) {
          cur.text += ch;
        } else {
          flush();
          cur = { text: ch, fg: st?.fg, bg: st?.bg };
        }
      }
      flush();
      rows.push({ runs });
    }
    return rows;
  }
}
