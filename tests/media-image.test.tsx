// MediaImage tests: fallback keeps the descriptor line byte-identical; a
// stored PNG paints. Uses ATOM_HOME redirect + a tiny generated PNG.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import React from "react";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { MediaImage } from "../src/ui/components/MediaImage.js";
import { clearPaintCache } from "../src/ui/image-paint.js";

let savedHome: string | undefined;
let mediaHome: string;

beforeAll(() => {
  savedHome = process.env.ATOM_HOME;
  mediaHome = mkdtempSync(join(tmpdir(), "atom-media-"));
  process.env.ATOM_HOME = mediaHome;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.ATOM_HOME;
  else process.env.ATOM_HOME = savedHome;
});

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, "latin1"), Buffer.from(data), Buffer.alloc(4)]);
}

// 2x1 red/green opaque PNG, filter 0.
function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function store(id: string, bytes: Buffer, mime: string): void {
  // mediaDir() = $ATOM_HOME/.atom/media (atomDir appends ".atom") — the
  // store fixture must mirror the loader's path.
  const dir = join(mediaHome, ".atom", "media");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.bin`), bytes);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ mime, name: `${id}.png`, bytes: bytes.length }));
}

const DESCRIPTOR = "[media:mid1 image/png 46B]";

describe("MediaImage", () => {
  test("missing media keeps the plain text line", () => {
    clearPaintCache();
    const app = render(
      <MediaImage id="missing" mime="image/png" rawText="[media:missing image/png 46B]" />,
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame).toContain("[media:missing image/png 46B]");
    expect(frame).not.toContain("▀");
  });

  test("non-PNG mime keeps the text line", () => {
    clearPaintCache();
    store("m2", Buffer.alloc(4), "image/jpeg");
    const app = render(
      <MediaImage id="m2" mime="image/jpeg" rawText="[media:m2 image/jpeg 4B]" />,
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame).toContain("[media:m2 image/jpeg 4B]");
  });

  test("stored PNG paints half-block rows", () => {
    clearPaintCache();
    store("mid1", tinyPng(), "image/png");
    const app = render(<MediaImage id="mid1" mime="image/png" rawText={DESCRIPTOR} />);
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame).toContain("▀");
    expect(frame).not.toContain("[media:mid1");
  });

  test("agent size hints upscale the paint (10 cells wide from a 2px image)", () => {
    clearPaintCache();
    store("mh", tinyPng(), "image/png");
    const app = render(
      <MediaImage
        id="mh"
        mime="image/png"
       
        rawText="[media:mh image/png 46B w=10 h=3]"
        w={10}
        h={3}
      />,
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    // The hint upscaled 2x1 px to a 10x3 grid: three rows of ten ▀ cells
    // (unhinted, a 2px image would paint a single ▀).
    expect(frame).toContain("▀▀▀▀▀▀▀▀▀▀");
    expect(frame).not.toContain("[media:mh");
  });
});
