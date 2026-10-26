// Raster painter tests: half-block run merging, alpha handling, aspect fit,
// bounded paint cache with negative-result caching, and stable paint keys.
import { describe, expect, test } from "vitest";
import {
  agentGridFor,
  cachePainted,
  clearPaintCache,
  paintHalfBlocks,
  paintKeyHash,
  pixelGridFor,
  type PaintedRow,
} from "../src/ui/image-paint.js";

function px(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const o = (y * width + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
  return { width, height, rgba };
}

describe("paintHalfBlocks", () => {
  test("coalesces identical neighbors into one run per row", () => {
    // 2 wide, 2 tall, all same opaque color -> one row, one run of "▀".
    const img = px(2, 2, () => [10, 20, 30, 255]);
    const rows = paintHalfBlocks(img);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runs).toEqual([
      { text: "▀▀", fg: "rgb(10,20,30)", bg: "rgb(10,20,30)" },
    ]);
  });

  test("splits runs on color change and paints transparent cells blank", () => {
    const img = px(3, 2, (x) => (x === 1 ? [0, 0, 0, 0] : [255, 0, 0, 255]));
    const rows = paintHalfBlocks(img);
    // Explicit undefined keys: Vitest 5 compares them against missing keys.
    expect(rows[0]!.runs).toEqual([
      { text: "▀", fg: "rgb(255,0,0)", bg: "rgb(255,0,0)" },
      { text: " ", fg: undefined, bg: undefined },
      { text: "▀", fg: "rgb(255,0,0)", bg: "rgb(255,0,0)" },
    ]);
  });

  test("bottom-only pixel uses ▄ with fg only", () => {
    const img = px(1, 2, (_x, y) => (y === 1 ? [0, 255, 0, 255] : [0, 0, 0, 0]));
    const rows = paintHalfBlocks(img);
    expect(rows[0]!.runs).toEqual([{ text: "▄", fg: "rgb(0,255,0)" }]);
  });

  test("sub-threshold alpha reads as background", () => {
    const img = px(1, 2, () => [10, 10, 10, 100]);
    const rows = paintHalfBlocks(img);
    expect(rows[0]!.runs).toEqual([{ text: " " }]);
  });

  test("odd raster height: sentinel bottom row stays blank", () => {
    const img = px(1, 3, (_x, y) => (y < 2 ? [1, 2, 3, 255] : [0, 0, 0, 0]));
    const rows = paintHalfBlocks(img);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.runs).toEqual([{ text: " " }]);
  });
});

describe("pixelGridFor", () => {
  test("fits wide image into cols", () => {
    const grid = pixelGridFor(100, 50, 50, 10);
    expect(grid.tw).toBeLessThanOrEqual(50);
    expect(grid.th).toBeLessThanOrEqual(20);
  });
  test("fits tall image into rows cap", () => {
    const grid = pixelGridFor(10, 400, 80, 5);
    expect(grid.th).toBeLessThanOrEqual(10);
  });
});

describe("agentGridFor", () => {
  const img = { w: 100, h: 50 };

  test("no hints delegate to aspect-fit (never upscale)", () => {
    const grid = agentGridFor(img.w, img.h, 200, 60);
    // 200x60 budget would allow 200x120 px; no-hint path clamps to native.
    expect(grid.tw).toBeLessThanOrEqual(img.w);
    expect(grid.th).toBeLessThanOrEqual(img.h);
  });

  test("width hint only: height follows aspect (1 row = 2 pixel rows)", () => {
    // tw=50 covers 100px wide; th = 50*50/(2*100) = 12.5 -> 13.
    expect(agentGridFor(img.w, img.h, 80, 60, 50)).toEqual({ tw: 50, th: 13 });
  });

  test("height hint only: width follows aspect", () => {
    // th=10 covers 20px tall; tw = 10*2*100/50 = 40.
    expect(agentGridFor(img.w, img.h, 80, 60, undefined, 10)).toEqual({ tw: 40, th: 10 });
  });

  test("both hints win verbatim within the budget", () => {
    expect(agentGridFor(img.w, img.h, 80, 60, 30, 8)).toEqual({ tw: 30, th: 8 });
  });

  test("hints clamp into the terminal budget, never overflow", () => {
    expect(agentGridFor(img.w, img.h, 80, 60, 500, 500)).toEqual({ tw: 80, th: 60 });
    expect(agentGridFor(4, 4, 80, 60, undefined, 500)).toEqual({ tw: 80, th: 60 });
  });

  test("hints may upscale a small image", () => {
    // 2x1 hinted to 10 wide: tw=10, th = 10*1/(2*2) = 2.5 -> 3.
    expect(agentGridFor(2, 1, 80, 60, 10)).toEqual({ tw: 10, th: 3 });
  });
});

describe("cachePainted", () => {
  test("memoizes per key and caches negative results", () => {
    clearPaintCache();
    let calls = 0;
    const compute = (): PaintedRow[] | null => {
      calls += 1;
      return [{ runs: [{ text: "x" }] }];
    };
    const first = cachePainted("k", 80, 10, compute);
    const second = cachePainted("k", 80, 10, compute);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    const negative = cachePainted("k2", 80, 10, () => null);
    expect(negative).toBeNull();
    expect(cachePainted("k2", 80, 10, compute)).toBeNull();
    expect(calls).toBe(1); // negative hit: compute not re-run
    expect(paintKeyHash("abc")).toBe(paintKeyHash("abc"));
    expect(paintKeyHash("abc")).not.toBe(paintKeyHash("abd"));
  });
});
