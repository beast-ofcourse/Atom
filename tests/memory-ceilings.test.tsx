// Memory-ceiling pins (Extreme-fast 4.3): every unbounded-growth
// candidate has a test pinning its cap. Long sessions must not grow heap
// via caches — each of these asserts the bound, not just the behavior.
// Real temp dirs/files, no network. (.tsx so ui modules import cleanly.)
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SCROLLBACK_WINDOW, applyScrollAction } from "../src/ui/transcript.js";
import { parseMarkdownCached } from "../src/ui/markdown.js";
import { readTool } from "../src/tools/filesystem.js";
import { clearReadCache, getReadCacheStats } from "../src/tools/read-cache.js";
import {
  READ_FINGERPRINT_CAP,
  readFingerprints,
  setReadFingerprint,
} from "../src/tools/fingerprints.js";
import {
  clearDirListingCache,
  getDirListingStats,
  listFiles,
} from "../src/tools/dir-cache.js";
import {
  cachedRealpath,
  getRealpathCacheStats,
} from "../src/tools/dir-cache.js";
import {
  clearSearchResultCache,
  getSearchResultCacheStats,
} from "../src/tools/search.js";
import { grepTool } from "../src/tools/search.js";
import {
  bashOutputTool,
  bashTool,
  getBgTaskCount,
} from "../src/tools/shell.js";
import {
  clearExtensionDiscoveryCache,
  discoverExtensionEntries,
  getExtensionDiscoveryCacheStats,
  resetExtensionDiscoveryCacheStats,
} from "../src/extensions.js";

afterEach(() => {
  clearReadCache();
  clearDirListingCache();
  clearSearchResultCache();
  clearExtensionDiscoveryCache();
});

describe("memory ceilings", () => {
  test("scrollback window is 300 and governs the commit frontier", () => {
    // SCROLLBACK_WINDOW bounds the scroll frontier, not React heap: Static
    // output can never retract once printed, so the window pins where PgUp
    // freezes and where Home jumps — heap itself is bounded by compaction +
    // the parse/inspector/tool caches pinned below.
    expect(SCROLLBACK_WINDOW).toBe(300);
    // Short history: PgUp freezes at the committed count, never the window.
    expect(applyScrollAction(null, 42, { kind: "pageUp" })).toBe(42);
    // Deep history: PgUp holds back to a page above the tail…
    expect(applyScrollAction(null, 500, { kind: "pageUp" })).toBe(490);
    // …while Home jumps to the window edge, and End resumes the live tail.
    expect(applyScrollAction(null, 500, { kind: "home" })).toBe(300);
    expect(applyScrollAction(100, 500, { kind: "end" })).toBe(null);
    expect(applyScrollAction(null, 500, { kind: "pageDown" })).toBe(null);
  });

  test("markdown parse cache evicts past 300 entries", () => {
    const first = parseMarkdownCached("ceiling-probe-zero");
    expect(parseMarkdownCached("ceiling-probe-zero")).toBe(first);
    for (let i = 0; i < 300; i++) parseMarkdownCached(`ceiling-probe-${i}`);
    // 301 distinct inputs in a 300-cap FIFO: the oldest is re-parsed.
    expect(parseMarkdownCached("ceiling-probe-zero")).not.toBe(first);
  });

  test("read cache never exceeds 500 entries", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atom-ceil-read-"));
    try {
      const abs = path.join(dir, "big.txt");
      writeFileSync(
        abs,
        Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n"),
        "utf8",
      );
      for (let off = 1; off <= 501; off++) {
        await readTool({ path: abs, offset: off, limit: 1 }, dir);
      }
      expect(getReadCacheStats().size).toBeLessThanOrEqual(500);
      // The first window was evicted: re-reading it misses (no hit).
      const before = getReadCacheStats();
      await readTool({ path: abs, offset: 1, limit: 1 }, dir);
      expect(getReadCacheStats().hits).toBe(before.hits);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale-read fingerprints cap at 500 and fail open", async () => {
    expect(READ_FINGERPRINT_CAP).toBe(500);
    readFingerprints.clear();
    for (let i = 0; i < 550; i++)
      setReadFingerprint(`/ceiling/fp-${i}.ts`, "ab".repeat(20));
    expect(readFingerprints.size).toBeLessThanOrEqual(500);
    expect(readFingerprints.has("/ceiling/fp-0.ts")).toBe(false);
    expect(readFingerprints.has("/ceiling/fp-549.ts")).toBe(true);
    readFingerprints.clear();
  });

  test("directory listing cache never exceeds 50 entries", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "atom-ceil-list-"));
    try {
      for (let i = 0; i < 55; i++) {
        const sub = path.join(root, `d${i}`);
        mkdirSync(sub, { recursive: true });
        writeFileSync(path.join(sub, "f.txt"), "x\n", "utf8");
        await listFiles(sub, root);
      }
      expect(getDirListingStats().size).toBeLessThanOrEqual(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("realpath cache never exceeds 500 entries", () => {
    for (let i = 0; i < 550; i++) cachedRealpath(`/ceiling/rp-${i}/file.ts`);
    expect(getRealpathCacheStats().size).toBeLessThanOrEqual(500);
  });

  test("search result cache never exceeds 100 entries", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atom-ceil-res-"));
    try {
      writeFileSync(path.join(dir, "f.txt"), "needle\n", "utf8");
      for (let i = 0; i < 105; i++) {
        await grepTool({ pattern: `needle-${i}-zzz` }, dir);
      }
      expect(getSearchResultCacheStats().size).toBeLessThanOrEqual(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("background task records cap at 20, oldest evicted first", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "atom-ceil-bg-"));
    try {
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        const started = JSON.parse(
          await bashTool(
            { command: "echo ceiling-probe", runInBackground: true },
            cwd,
          ),
        ) as { backgroundTaskId: string };
        ids.push(started.backgroundTaskId);
      }
      expect(getBgTaskCount()).toBeLessThanOrEqual(20);
      // The first task's record is gone: polling reports unknown, and the
      // newest task is still pollable.
      expect(await bashOutputTool({ taskId: ids[0]!, timeoutMs: 100 })).toMatch(
        /^Error: unknown background task/,
      );
      expect(
        await bashOutputTool({ taskId: ids[24]!, timeoutMs: 5000 }),
      ).toContain("ceiling-probe");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("extension scope scans cache on mtime; explicit clear re-discovers", () => {
    const home = mkdtempSync(path.join(tmpdir(), "atom-ceil-ext-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "atom-ceil-proj-"));
    try {
      const scopeDir = path.join(cwd, ".atom", "extensions");
      mkdirSync(scopeDir, { recursive: true });
      clearExtensionDiscoveryCache();
      resetExtensionDiscoveryCacheStats();
      const before = discoverExtensionEntries({ home, cwd }).length;
      // Unchanged tree: the second discovery is a cache hit, same entries.
      expect(discoverExtensionEntries({ home, cwd }).length).toBe(before);
      expect(getExtensionDiscoveryCacheStats().hits).toBeGreaterThanOrEqual(1);
      // A real install changes the scope name set: visible with no clear,
      // even inside one mtime tick (mtime alone would serve stale here).
      const extDir = path.join(scopeDir, "fresh-ext");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        path.join(extDir, "index.js"),
        "module.exports = {};\n",
        "utf8",
      );
      expect(discoverExtensionEntries({ home, cwd }).length).toBe(before + 1);
      // Explicit clear drops cached entries (the /reload contract).
      clearExtensionDiscoveryCache();
      expect(getExtensionDiscoveryCacheStats().size).toBe(0);
      expect(discoverExtensionEntries({ home, cwd }).length).toBe(before + 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
