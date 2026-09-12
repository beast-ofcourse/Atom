// OOM-guard regression tests: no tool may materialize a whole file past
// READ_FILE_MAX_BYTES (1MB) — a GB input becomes ~2x bytes as UTF-16 plus
// split/join copies, enough to kill the heap in one call (observed in a
// long session). Snapshots spill large files via streaming copy; the walker
// skips oversize files like binaries; retained transcript diffs stay capped.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { editTool, grepTool, readTool } from "../src/tools.js";
import { READ_FILE_MAX_BYTES } from "../src/tools/shared.js";
import {
  capturePriorBytes,
  clearSnapshots,
  getCheckpoint,
  restoreCheckpointFiles,
} from "../src/snapshots.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-oom-"));
  dirs.push(d);
  return d;
}

async function withRgOff<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ATOM_RG;
  process.env.ATOM_RG = "0";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.ATOM_RG;
    else process.env.ATOM_RG = saved;
  }
}

afterEach(async () => {
  clearSnapshots();
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("full-read byte guard", () => {
  test("read refuses files over 1MB (plain and windowed)", async () => {
    const cwd = await tmpDir();
    const big = "x".repeat(READ_FILE_MAX_BYTES + 100);
    await fsp.writeFile(path.join(cwd, "big.bin"), big, "utf8");
    const out = await readTool({ path: "big.bin" }, cwd);
    expect(out).toMatch(/^Error: file too large to read/);
    expect(out).toContain("grep/glob");
    const windowed = await readTool({ path: "big.bin", offset: 1, limit: 5 }, cwd);
    expect(windowed).toMatch(/^Error: file too large to read/);
  });

  test("read at exactly the cap still works", async () => {
    const cwd = await tmpDir();
    const head = "l1\nl2\nl3\n";
    const pad = "p".repeat(READ_FILE_MAX_BYTES - head.length);
    await fsp.writeFile(path.join(cwd, "edge.txt"), `${head}${pad}`, "utf8");
    const out = await readTool({ path: "edge.txt", offset: 1, limit: 2 }, cwd);
    expect(out).toBe("1: l1\n2: l2");
  });

  test("edit refuses files over 1MB and leaves them untouched", async () => {
    const cwd = await tmpDir();
    const content = `needle-${"y".repeat(READ_FILE_MAX_BYTES)}`;
    const abs = path.join(cwd, "huge.txt");
    await fsp.writeFile(abs, content, "utf8");
    const out = await editTool({ path: "huge.txt", oldString: "needle", newString: "pin" }, cwd);
    expect(out).toMatch(/^Error: file too large to edit/);
    expect(out).toContain("bash");
    expect(await fsp.readFile(abs, "utf8")).toBe(content);
  });

  test("edit at exactly the cap still works", async () => {
    const cwd = await tmpDir();
    const pad = "q".repeat(READ_FILE_MAX_BYTES - "needle".length);
    await fsp.writeFile(path.join(cwd, "edge.txt"), `needle${pad}`, "utf8");
    expect(
      await editTool({ path: "edge.txt", oldString: "needle", newString: "pin" }, cwd)
    ).toContain("Edited");
  });
});

describe("snapshot streaming spill", () => {
  test("large file spills via stream (bytes stay null) and restores byte-exact", async () => {
    const cwd = await tmpDir();
    const abs = path.join(cwd, "data.bin");
    const original = `v1-${"a".repeat(300 * 1024)}`;
    await fsp.writeFile(abs, original, "utf8");
    const cp = await capturePriorBytes(abs, "write data.bin");
    expect(cp).not.toBeNull();
    const rec = getCheckpoint(cp!.id);
    expect(rec?.files).toHaveLength(1);
    // Streamed spill: nothing materialized, temp copy on disk instead.
    expect(rec!.files[0]!.bytes).toBeNull();
    expect(rec!.files[0]!.overflowPath).not.toBeNull();
    expect(rec!.files[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    await fsp.writeFile(abs, "v2", "utf8");
    expect(await restoreCheckpointFiles(cp!.id)).toContain("rewound 1 file");
    expect(await fsp.readFile(abs, "utf8")).toBe(original);
  });
});

describe("walker oversize skip", () => {
  test("grep skips files over 1MB like binaries (walker path)", async () => {
    const cwd = await tmpDir();
    const marker = "OOM-GUARD-MARKER-12345";
    await fsp.writeFile(path.join(cwd, "small.txt"), `hit ${marker} here`, "utf8");
    await fsp.writeFile(
      path.join(cwd, "big.bin"),
      `${marker}\n${"z".repeat(READ_FILE_MAX_BYTES)}`,
      "utf8"
    );
    const out = await withRgOff(() => grepTool({ pattern: marker }, cwd));
    expect(out).toContain("small.txt");
    expect(out).not.toContain("big.bin");
  });
});
