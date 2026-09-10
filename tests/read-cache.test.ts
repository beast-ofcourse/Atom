// Read-cache tests: hits skip disk I/O, mutations invalidate, TTL + opt-out
// behave, errors never poison. Real temp files, no network.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readTool, writeTool, editTool } from "../src/tools/filesystem.js";
import {
  clearReadCache,
  getReadCacheStats,
  resetReadCacheStats,
} from "../src/tools/read-cache.js";

const SAVED_CACHE = process.env.ATOM_READ_CACHE;

afterEach(() => {
  clearReadCache();
  resetReadCacheStats();
  if (SAVED_CACHE === undefined) delete process.env.ATOM_READ_CACHE;
  else process.env.ATOM_READ_CACHE = SAVED_CACHE;
});

function tmpFile(name: string, content: string): { dir: string; abs: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "atom-cache-"));
  const abs = path.join(dir, name);
  writeFileSync(abs, content, "utf8");
  return { dir, abs };
}

describe("read cache", () => {
  test("second identical read hits (no second disk read needed)", async () => {
    const { dir, abs } = tmpFile("a.txt", "hello\nworld\n");
    try {
      resetReadCacheStats();
      const first = await readTool({ path: abs }, dir);
      expect(first).toContain("1: hello");
      const afterFirst = getReadCacheStats();
      expect(afterFirst.stores).toBe(1);
      expect(afterFirst.hits).toBe(0);

      const second = await readTool({ path: abs }, dir);
      expect(second).toBe(first);
      const afterSecond = getReadCacheStats();
      expect(afterSecond.hits).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("different windows are different keys", async () => {
    const { dir, abs } = tmpFile("b.txt", "l1\nl2\nl3\n");
    try {
      resetReadCacheStats();
      await readTool({ path: abs, offset: 1, limit: 1 }, dir);
      await readTool({ path: abs, offset: 2, limit: 1 }, dir);
      const s = getReadCacheStats();
      expect(s.stores).toBe(2);
      expect(s.hits).toBe(0);
      // Re-reading the first window now hits.
      await readTool({ path: abs, offset: 1, limit: 1 }, dir);
      expect(getReadCacheStats().hits).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeTool invalidates so read→write→read sees fresh bytes", async () => {
    const { dir, abs } = tmpFile("c.txt", "v1\n");
    try {
      resetReadCacheStats();
      expect(await readTool({ path: abs }, dir)).toContain("v1");
      expect(getReadCacheStats().hits).toBe(0);
      expect(await readTool({ path: abs }, dir)).toContain("v1");
      expect(getReadCacheStats().hits).toBe(1);
      await writeTool({ path: abs, content: "v2\n" }, dir);
      const fresh = await readTool({ path: abs }, dir);
      expect(fresh).toContain("v2");
      expect(fresh).not.toContain("v1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("editTool invalidates too", async () => {
    const { dir, abs } = tmpFile("d.txt", "aaa\n");
    try {
      await readTool({ path: abs }, dir);
      await readTool({ path: abs }, dir);
      expect(getReadCacheStats().hits).toBe(1);
      await editTool({ path: abs, oldString: "aaa", newString: "bbb" }, dir);
      const fresh = await readTool({ path: abs }, dir);
      expect(fresh).toContain("bbb");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("external mtime change misses (stat-validated, no stale bytes)", async () => {
    const { dir, abs } = tmpFile("e.txt", "one\n");
    try {
      resetReadCacheStats();
      await readTool({ path: abs }, dir);
      // Bypass writeTool (no invalidation) with visibly different bytes.
      writeFileSync(abs, "one\ntwo\nthree\nfour\n", "utf8");
      const fresh = await readTool({ path: abs }, dir);
      expect(fresh).toContain("four");
      // The stale entry missed (no hit counted for the changed read).
      expect(getReadCacheStats().hits).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors never cache; ATOM_READ_CACHE=0 disables", async () => {
    const { dir } = tmpFile("f.txt", "x\n");
    try {
      resetReadCacheStats();
      const missing = path.join(dir, "nope.txt");
      await readTool({ path: missing }, dir);
      await readTool({ path: missing }, dir);
      expect(getReadCacheStats().stores).toBe(0);

      process.env.ATOM_READ_CACHE = "0";
      clearReadCache();
      resetReadCacheStats();
      const abs = path.join(dir, "f.txt");
      const a = await readTool({ path: abs }, dir);
      const b = await readTool({ path: abs }, dir);
      expect(a).toBe(b);
      expect(getReadCacheStats().hits).toBe(0);
      expect(getReadCacheStats().stores).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.ATOM_READ_CACHE;
    }
  });
});
