// Minimal PNG decode for inline terminal image painting. Zero dependencies:
// chunk walk + node:zlib inflateSync + hand-rolled unfilter. Supports the
// image classes the read-tool actually stores (diagrams, charts, screenshots):
//
//   - bit depth 8 only; color types 0 (gray), 2 (RGB), 3 (palette),
//     4 (gray+alpha), 6 (RGBA); optional tRNS for types 0/2/3.
//   - everything else (1/2/4/16-bit depths, Adam7 interlace) is rejected with
//     a clear message — painters degrade to their text path, never crash.
//
// CRCs are not verified (validation cost lives in the format, not the content;
// a corrupt IDAT surfaces as an inflate or range failure below). Oversize
// images are the caller's cap: nothing here allocates more than the declared
// pixel buffer requires.
import { inflateSync } from "node:zlib";

export type DecodedPng = {
  width: number;
  height: number;
  // Width * height * 4 bytes, row-major RGBA. Alpha 0-255.
  rgba: Uint8Array;
};

// Chunks whose absence or shape makes decode meaningless. Bail on the first
// forbidden requirement instead of producing a wrong pixel buffer.
function readU32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

// Paeth per PNG spec: predictor closest to a+b-c of the three.
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Channel counts per color type; palette pixels carry byte-per-index here and
// expand through PLTE/tRNS afterwards.
function channelsFor(colorType: number): number {
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 1; // types 0 (gray) and 3 (palette index)
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 8) throw new Error("png: truncated file");
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let k = 0; k < 8; k++) if (bytes[k] !== sig[k]) throw new Error("png: bad signature");

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idats: Uint8Array[] = [];

  let off = 8;
  let ihdrSeen = false;
  let iendSeen = false;
  while (off + 8 <= bytes.length) {
    const len = readU32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new Error("png: truncated chunk");
    const chunk = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (len !== 13) throw new Error("png: bad IHDR");
      width = readU32(chunk, 0);
      height = readU32(chunk, 4);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
      if (chunk[10] !== 0 || chunk[11] !== 0) throw new Error("png: non-standard compression/filter");
      interlace = chunk[12]!;
      ihdrSeen = true;
    } else if (type === "PLTE") {
      palette = chunk;
    } else if (type === "tRNS") {
      trns = chunk;
    } else if (type === "IDAT") {
      idats.push(chunk);
    } else if (type === "IEND") {
      iendSeen = true;
      break;
    }
    off = dataEnd + 4; // skip CRC (never reads it — see header note)
  }
  if (!ihdrSeen) throw new Error("png: missing IHDR");
  if (!iendSeen && idats.length === 0) throw new Error("png: missing image data");
  if (interlace !== 0) throw new Error("png: interlaced PNGs unsupported");
  if (bitDepth !== 8) throw new Error(`png: bit depth ${bitDepth} unsupported (need 8)`);
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) {
    throw new Error(`png: color type ${colorType} unsupported`);
  }
  if (width === 0 || height === 0) throw new Error("png: empty image");

  const channels = channelsFor(colorType);
  const stride = width * channels;
  const packed = inflateSync(Buffer.concat(idats.map((c) => Buffer.from(c))));
  if (packed.length < (stride + 1) * height) throw new Error("png: incomplete pixel data");

  const raw = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride); // first row filters against zeroes
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filterByte = packed[rowStart]!;
    const row = raw.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const i = rowStart + 1 + x;
      const a = x >= channels ? row[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = packed[i]! | 0;
      if (filterByte === 1) {
        v = (v + a) & 0xff; // Sub
      } else if (filterByte === 2) {
        v = (v + b) & 0xff; // Up
      } else if (filterByte === 3) {
        v = (v + ((a + b) >> 1)) & 0xff; // Average
      } else if (filterByte === 4) {
        v = (v + paeth(a, b, c)) & 0xff; // Paeth
      } else if (filterByte !== 0) {
        throw new Error(`png: bad filter type ${filterByte} on row ${y}`);
      }
      row[x] = v;
    }
    prev = row;
  }

  // Expand to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  const put = (idx: number, r: number, g: number, b: number, a: number) => {
    const o = idx * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  };
  if (colorType === 6) {
    rgba.set(raw);
  } else if (colorType === 2) {
    for (let p = 0; p < width * height; p++) {
      put(p, raw[p * 3]!, raw[p * 3 + 1]!, raw[p * 3 + 2]!, 255);
    }
  } else if (colorType === 0) {
    const t = trns ? trns[0] : undefined;
    for (let p = 0; p < width * height; p++) {
      const g = raw[p]!;
      put(p, g, g, g, t !== undefined && raw[p]! === t ? 0 : 255);
    }
  } else if (colorType === 4) {
    for (let p = 0; p < width * height; p++) {
      const g = raw[p * 2]!;
      put(p, g, g, g, raw[p * 2 + 1]!);
    }
  } else {
    // Palette (type 3): PLTE required; tRNS per-index alpha.
    if (!palette || palette.length % 3 !== 0 || (trns && trns.length > palette.length / 3)) {
      throw new Error("png: bad palette chunk");
    }
    for (let p = 0; p < width * height; p++) {
      const idx = raw[p]!;
      const pl = idx * 3;
      if (idx * 3 + 2 >= palette.length) throw new Error("png: palette index out of range");
      put(
        p,
        palette[pl]!,
        palette[pl + 1]!,
        palette[pl + 2]!,
        trns && idx < trns.length ? trns[idx]! : 255,
      );
    }
  }
  return { width, height, rgba };
}
