// PNG decode tests: hand-built PNGs (no fixtures) cover every supported
// color type + filter, and every documented decline path.
import { describe, expect, test } from "vitest";
import { deflateSync } from "node:zlib";
import { decodePng } from "../src/ui/png-decode.js";

// Minimal PNG encoder for tests: CRCs are zero (decoder never reads them).
function crc32(): number {
  return 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(), 0);
  return Buffer.concat([len, typeBuf, Buffer.from(data), crc]);
}

type PngOptions = {
  width: number;
  height: number;
  colorType: number;
  bitDepth?: number;
  interlace?: number;
  palette?: [number, number, number][];
  trns?: number[];
  // Row pixel values: height x (channels * width), unfiltered.
  rows: Uint8Array[];
  filters?: number[];
};

function buildPng(o: PngOptions): Buffer {
  const channels = o.colorType === 2 ? 3 : o.colorType === 4 ? 2 : o.colorType === 6 ? 4 : 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = o.bitDepth ?? 8;
  ihdr[9] = o.colorType;
  ihdr[12] = o.interlace ?? 0;
  const parts: Buffer[] = [chunk("IHDR", ihdr)];
  if (o.palette) {
    const plte = Buffer.alloc(o.palette.length * 3);
    o.palette.forEach(([r, g, b], k) => {
      plte[k * 3] = r;
      plte[k * 3 + 1] = g;
      plte[k * 3 + 2] = b;
    });
    parts.push(chunk("PLTE", plte));
  }
  if (o.trns) parts.push(chunk("tRNS", Buffer.from(o.trns)));
  const raw: number[] = [];
  o.rows.forEach((row, y) => {
    raw.push(o.filters?.[y] ?? 0);
    for (const b of row) raw.push(b);
  });
  parts.push(chunk("IDAT", deflateSync(Buffer.from(raw))));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...parts]);
}

describe("decodePng", () => {
  test("RGBA, no filter", () => {
    const png = buildPng({
      width: 2,
      height: 2,
      colorType: 6,
      rows: [
        Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 200]),
        Uint8Array.from([0, 0, 0, 0, 9, 9, 9, 255]),
      ],
    });
    const out = decodePng(png);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect([...out.rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 200, 0, 0, 0, 0, 9, 9, 9, 255]);
  });

  test("RGB with Sub filter", () => {
    // Row: pixels (10,20,30) then deltas (1,1,1).
    const png = buildPng({
      width: 2,
      height: 1,
      colorType: 2,
      filters: [1],
      rows: [Uint8Array.from([10, 20, 30, 1, 1, 1])],
    });
    const out = decodePng(png);
    expect([...out.rgba]).toEqual([10, 20, 30, 255, 11, 21, 31, 255]);
  });

  test("RGB with Up filter", () => {
    const png = buildPng({
      width: 1,
      height: 2,
      colorType: 2,
      filters: [0, 2],
      rows: [Uint8Array.from([5, 5, 5]), Uint8Array.from([3, 3, 3])],
    });
    const out = decodePng(png);
    expect([...out.rgba]).toEqual([5, 5, 5, 255, 8, 8, 8, 255]);
  });

  test("RGB with Average filter", () => {
    // Second pixel: predicted = floor(avg(left=20, up=0)) = 10, stored 5.
    const png = buildPng({
      width: 2,
      height: 1,
      colorType: 2,
      filters: [3],
      rows: [Uint8Array.from([20, 0, 0, 5, 0, 0])],
    });
    const out = decodePng(png);
    expect([...out.rgba]).toEqual([20, 0, 0, 255, 15, 0, 0, 255]);
  });

  test("RGB with Paeth filter", () => {
    // Second pixel: predicted = a = 20, stored 1 -> 21.
    const png = buildPng({
      width: 2,
      height: 1,
      colorType: 2,
      filters: [4],
      rows: [Uint8Array.from([20, 0, 0, 1, 0, 0])],
    });
    const out = decodePng(png);
    expect([...out.rgba]).toEqual([20, 0, 0, 255, 21, 0, 0, 255]);
  });

  test("grayscale + tRNS", () => {
    const png = buildPng({
      width: 2,
      height: 1,
      colorType: 0,
      trns: [100],
      rows: [Uint8Array.from([100, 50])],
    });
    const out = decodePng(png);
    expect([...out.rgba]).toEqual([100, 100, 100, 0, 50, 50, 50, 255]);
  });

  test("palette + tRNS", () => {
    const png = buildPng({
      width: 3,
      height: 1,
      colorType: 3,
      palette: [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
      trns: [255, 128],
      rows: [Uint8Array.from([0, 1, 2])],
    });
    const out = decodePng(png);
    expect([...out.rgba]).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 128,
      0, 0, 255, 255,
    ]);
  });

  test("declines: interlace, 16-bit depth, truncation, bad signature", () => {
    expect(() =>
      decodePng(buildPng({ width: 1, height: 1, colorType: 6, interlace: 1, rows: [Uint8Array.from([0, 0, 0, 0])] })),
    ).toThrow(/interlace/);
    expect(() =>
      decodePng(
        buildPng({ width: 1, height: 1, colorType: 6, bitDepth: 16, rows: [Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0])] }),
      ),
    ).toThrow(/bit depth/);
    expect(() => decodePng(Buffer.from([0, 1, 2]))).toThrow(/truncated/);
    expect(() => decodePng(Buffer.alloc(64, 0))).toThrow(/signature/);
  });
});
