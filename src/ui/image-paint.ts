// Raster painting shared by every inline-graphic surface: inline PNG media,
// SVG fences (via src/ui/svg-char), and mermaid fences (via src/ui/mermaid).
// One renderer, three producers.
//
// Paint model: unicode half-block. One terminal row paints two pixel rows —
// `▀` with fg = top pixel, bg = bottom pixel; fully transparent cells stay
// blank so the TUI's terminal-native background shows through. Adjacent
// cells sharing both colors coalesce into one run, which keeps <Text> node
// counts near the color-change count and re-render cost in the cache.
//
// Cache: `cachePainted(key, cols, rowsCap, compute)` memoizes rows per
// producer key + terminal width (bounded FIFO). Media files are immutable
// (id keys stable for life), diagrams are pure functions of fence text —
// re-renders / scroll repaints / resize-throttled width changes never
// re-rasterize.
export type PaintRun = {
  text: string;
  fg?: string;
  bg?: string;
};

export type PaintedRow = {
  runs: PaintRun[];
};

// Aspect-fit a pixel raster into a cell budget where one cell is ~1:2
// (terminal glyph). Terminal rows get two pixel rows each. Never upscales:
// small rasters stay at native size (nearest-neighbor upscaling adds blur
// and doubles the paint budget for nothing).
export function pixelGridFor(
  width: number,
  height: number,
  cols: number,
  rowsCap: number,
): { tw: number; th: number } {
  const maxPxW = Math.max(1, cols);
  const maxPxH = Math.max(2, rowsCap * 2);
  const scale = Math.min(1, maxPxW / width, maxPxH / height);
  return { tw: Math.max(1, Math.floor(width * scale)), th: Math.max(1, Math.floor(height * scale)) };
}

// Agent-hinted paint grid (media descriptor `w=`/`h=` hints, in terminal
// cells). Hints are clamped into the terminal budget — a hint can never
// overflow the frame — and MAY upscale (nearest-neighbor is cheap; the
// agent explicitly asked for the size). One missing axis is derived from
// the image aspect (one cell row covers ~2 pixel rows). No hints delegate
// to pixelGridFor (aspect-fit, never upscale).
export function agentGridFor(
  width: number,
  height: number,
  cols: number,
  rowsCap: number,
  hintW?: number,
  hintH?: number,
): { tw: number; th: number } {
  if (hintW === undefined && hintH === undefined) {
    return pixelGridFor(width, height, cols, rowsCap);
  }
  const maxW = Math.max(1, cols);
  const maxH = Math.max(1, rowsCap);
  if (hintW !== undefined && hintH !== undefined) {
    return { tw: Math.min(hintW, maxW), th: Math.min(hintH, maxH) };
  }
  if (hintW !== undefined) {
    const tw = Math.min(hintW, maxW);
    const th = Math.max(1, Math.round((tw * height) / (2 * width)));
    return { tw, th: Math.min(th, maxH) };
  }
  const th = Math.min(hintH!, maxH);
  const tw = Math.max(1, Math.round((th * 2 * width) / height));
  return { tw: Math.min(tw, maxW), th };
}

// Nearest-neighbor downscale. Chart/diagram targets; nearest keeps structure
// crisp at these sizes (box edges stay edges) and costs one index pass.
export function downscaleNearest(
  src: { width: number; height: number; rgba: Uint8Array },
  tw: number,
  th: number,
): { width: number; height: number; rgba: Uint8Array } {
  if (tw === src.width && th === src.height) {
    return { width: tw, height: th, rgba: src.rgba };
  }
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / tw));
      const so = (sy * src.width + sx) * 4;
      const t = (y * tw + x) * 4;
      out[t] = src.rgba[so]!;
      out[t + 1] = src.rgba[so + 1]!;
      out[t + 2] = src.rgba[so + 2]!;
      out[t + 3] = src.rgba[so + 3]!;
    }
  }
  return { width: tw, height: th, rgba: out };
}

function colorCss(r: number, g: number, b: number): string {
  return `rgb(${r},${g},${b})`;
}

// Opaque threshold: below this the pixel reads as background (alpha blending
// against an unknown terminal color is guesswork — skip it).
const ALPHA_ON = 160;

export function paintHalfBlocks(
  pixels: { width: number; height: number; rgba: Uint8Array },
): PaintedRow[] {
  const rows: PaintedRow[] = [];
  for (let cy = 0; cy < pixels.height; cy += 2) {
    const runs: PaintRun[] = [];
    let cur: { text: string; fg?: string; bg?: string } | null = null;
    const flush = () => {
      if (cur && cur.text.length > 0) runs.push({ ...cur });
      cur = null;
    };
    for (let x = 0; x < pixels.width; x++) {
      const t = (cy * pixels.width + x) * 4;
      const aTop = pixels.rgba[t + 3]!;
      // Odd raster height: the sentinel bottom row is "transparent".
      const botIdx = cy + 1 < pixels.height ? (cy + 1) * pixels.width + x : -1;
      const aBot = botIdx >= 0 ? pixels.rgba[botIdx * 4 + 3]! : 0;
      let chars: string;
      let fg: string | undefined;
      let bg: string | undefined;
      const topOn = aTop >= ALPHA_ON;
      const botOn = aBot >= ALPHA_ON;
      if (topOn && botOn) {
        chars = "▀";
        fg = colorCss(pixels.rgba[t]!, pixels.rgba[t + 1]!, pixels.rgba[t + 2]!);
        bg = colorCss(pixels.rgba[botIdx * 4]!, pixels.rgba[botIdx * 4 + 1]!, pixels.rgba[botIdx * 4 + 2]!);
      } else if (topOn) {
        chars = "▀";
        fg = colorCss(pixels.rgba[t]!, pixels.rgba[t + 1]!, pixels.rgba[t + 2]!);
      } else if (botOn) {
        chars = "▄";
        fg = colorCss(pixels.rgba[botIdx * 4]!, pixels.rgba[botIdx * 4 + 1]!, pixels.rgba[botIdx * 4 + 2]!);
      } else {
        chars = " ";
      }
      if (cur && cur.fg === fg && cur.bg === bg && chars === cur.text) {
        // Identical glyph + colors: extend the run. (Blank cells carry no
        // color, so trailing/leading blanks only coalesce with blanks.)
        cur.text += chars;
      } else {
        flush();
        cur = { text: chars, fg, bg };
      }
    }
    flush();
    rows.push({ runs });
  }
  return rows;
}

// Bounded FIFO paint cache. Values may be `null` (producer declines; e.g.
// unparseable fence) — the negative result is cached too so a streaming
// draft never re-parses a failing diagram on every tick.
const PAINT_CACHE_CAP = 96;
const paintCache = new Map<string, PaintedRow[] | null>();

export function clearPaintCache(): void {
  paintCache.clear();
}

export function paintCacheProbe(): { size: number } {
  return { size: paintCache.size };
}

export function cachePainted(
  key: string,
  cols: number,
  rowsCap: number,
  compute: () => PaintedRow[] | null,
): PaintedRow[] | null {
  const cacheKey = `${key}|${cols}|${rowsCap}`;
  if (paintCache.has(cacheKey)) return paintCache.get(cacheKey) ?? null;
  const rows = compute();
  paintCache.set(cacheKey, rows);
  if (paintCache.size > PAINT_CACHE_CAP) {
    const oldest = paintCache.keys().next();
    if (!oldest.done) paintCache.delete(oldest.value);
  }
  return rows;
}

// Stable, cheap fence-content key (FNV-1a + length — collision-safe enough
// for a 96-entry cache whose misses only cost a re-render, never data).
export function paintKeyHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${s.length}`;
}
