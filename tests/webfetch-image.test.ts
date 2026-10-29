// webfetch image mode: one call stores a web image in the media store and
// returns the paintable descriptor — the replacement for the hand-rolled
// curl/shell chain that failed on Windows shells, tool timeouts, and hosts
// that block curl. Network is ALWAYS mocked (stub resolver + fake fetch);
// storage goes to a temp ATOM_HOME.
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webfetchTool } from "../src/tools.js";
import { defaultNetworkPolicy } from "../src/policy.js";
import { loadMediaRaw } from "../src/media.js";

const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let home: string | null = null;

function stubResolve(table: Record<string, string[]>) {
  return async (host: string) => table[host] ?? [];
}

const opts = () => ({
  policy: defaultNetworkPolicy(),
  resolveHost: stubResolve({ "example.com": ["93.184.215.14"] }),
});

// Minimal PNG: magic bytes + IHDR length/type + filler (decode is not this
// tool's job — the store contract is).
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 1, 2, 3, 4,
]);

function mockImage(bytes: Uint8Array, mime: string): void {
  // slice() copies into a fresh ArrayBuffer — the cast only satisfies the
  // DOM lib's ArrayBufferLike variance, the backing is guaranteed.
  const body = bytes.slice().buffer as ArrayBuffer;
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": mime } })) as typeof fetch;
}

afterEach(async () => {
  globalThis.fetch = savedFetch;
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (home !== null) {
    await rm(home, { recursive: true, force: true });
    home = null;
  }
});

async function tempHome(): Promise<void> {
  home = await mkdtemp(join(tmpdir(), "atom-webfetch-image-"));
  process.env.ATOM_HOME = home;
}

describe("webfetch format:image", () => {
  test("stores a PNG and returns its descriptor; bytes land in the media store", async () => {
    await tempHome();
    mockImage(PNG_BYTES, "image/png");
    const out = await webfetchTool({ url: "https://example.com/diagram.png", format: "image" }, opts());
    const m = /^\[media:([A-Za-z0-9_-]+) image\/png (\d+)B\]$/.exec(out);
    expect(m).not.toBeNull();
    const stored = loadMediaRaw(m![1]!);
    expect(stored).not.toBeNull();
    expect(stored!.mime).toBe("image/png");
    expect(stored!.raw.length).toBe(PNG_BYTES.length);
    expect(Buffer.from(PNG_BYTES).equals(stored!.raw)).toBe(true);
  });

  test("non-image content-type is refused, nothing stored", async () => {
    await tempHome();
    mockImage(new TextEncoder().encode("<html>not an image</html>"), "text/html");
    const out = await webfetchTool({ url: "https://example.com/page", format: "image" }, opts());
    expect(out).toMatch(/^Error:.*not a supported image/);
    expect(out).toContain("supported:");
  });

  test("unsupported image mime is refused with the supported list", async () => {
    await tempHome();
    mockImage(PNG_BYTES, "image/avif");
    const out = await webfetchTool({ url: "https://example.com/pic.avif", format: "image" }, opts());
    expect(out).toMatch(/^Error:.*image\/avif/);
    expect(out).toContain("image/png");
  });

  test("non-PNG image stores with a paint note (GIF reaches vision, not pixels)", async () => {
    await tempHome();
    mockImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]), "image/gif");
    const out = await webfetchTool({ url: "https://example.com/anim.gif", format: "image" }, opts());
    // Multiline: the descriptor is line 1, the paint note follows.
    expect(out).toMatch(/^\[media:\S+ image\/gif \d+B\]$/m);
    expect(out).toContain("does not paint as pixels");
  });

  test("oversize image is refused, not partially stored", async () => {
    await tempHome();
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big[0] = 0x89;
    mockImage(big, "image/png");
    const out = await webfetchTool({ url: "https://example.com/huge.png", format: "image" }, opts());
    expect(out).toMatch(/^Error:.*media cap/);
  });

  test("empty body is refused", async () => {
    await tempHome();
    mockImage(new Uint8Array(0), "image/png");
    const out = await webfetchTool({ url: "https://example.com/empty.png", format: "image" }, opts());
    expect(out).toMatch(/^Error:.*empty image body/);
  });
});
