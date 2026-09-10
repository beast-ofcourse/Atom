// Search-speed tests: fast enumeration + single-pass scan keep exact output
// parity with the legacy walker, cache correctly, and never search
// node_modules/.git. Real temp dirs, no network.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearDirListingCache,
  fastListEnabled,
  getDirListingStats,
  listFiles,
  resetDirListingStats,
} from "../src/tools/dir-cache.js";
import { globTool, grepTool } from "../src/tools/search.js";

const SAVED_FAST_LIST = process.env.ATOM_FAST_LIST;

afterEach(() => {
  clearDirListingCache();
  resetDirListingStats();
  if (SAVED_FAST_LIST === undefined) delete process.env.ATOM_FAST_LIST;
  else process.env.ATOM_FAST_LIST = SAVED_FAST_LIST;
});

function tmpTree(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "atom-search-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "src", "nested"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), "export const alpha = 1;\n// MARKER-ONE\n", "utf8");
  writeFileSync(path.join(dir, "src", "b.ts"), "export const beta = 2;\n", "utf8");
  writeFileSync(path.join(dir, "src", "nested", "c.ts"), "const gamma = 3; // MARKER-ONE\n", "utf8");
  writeFileSync(path.join(dir, "README.md"), "# demo MARKER-ONE\n", "utf8");
  writeFileSync(path.join(dir, "node_modules", "dep", "x.js"), "MARKER-ONE should never match\n", "utf8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withFastList<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ATOM_FAST_LIST;
  if (value === undefined) delete process.env.ATOM_FAST_LIST;
  else process.env.ATOM_FAST_LIST = value;
  clearDirListingCache();
  try {
    return await fn();
  } finally {
    clearDirListingCache();
    if (prev === undefined) delete process.env.ATOM_FAST_LIST;
    else process.env.ATOM_FAST_LIST = prev;
  }
}

describe("parity: fast path vs legacy walker", () => {
  test("grep all modes + glob identical with and without ATOM_FAST_LIST=0", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      const cases: Array<() => Promise<string>> = [
        () => grepTool({ pattern: "MARKER-ONE" }, dir),
        () => grepTool({ pattern: "MARKER-ONE", outputMode: "files_with_matches" }, dir),
        () => grepTool({ pattern: "MARKER-ONE", outputMode: "count" }, dir),
        () => grepTool({ pattern: "export", include: "*.ts" }, dir),
        () => globTool({ pattern: "*.ts" }, dir),
        () => globTool({ pattern: "src/**/*.ts" }, dir),
        () => grepTool({ pattern: "nomatch-zzz" }, dir),
      ];
      for (const run of cases) {
        const fast = await withFastList(undefined, run);
        const legacy = await withFastList("0", run);
        expect(fast).toBe(legacy);
      }
      expect(fastListEnabled()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("node_modules never searched on either path", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      for (const v of [undefined, "0"] as const) {
        const out = await withFastList(v, () => grepTool({ pattern: "should never match" }, dir));
        expect(out).toBe("No matches.");
      }
    } finally {
      cleanup();
    }
  });

  test("truncation notes preserved (120 matching files)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atom-search-cap-"));
    try {
      for (let i = 0; i < 120; i++) {
        writeFileSync(path.join(dir, `f${i}.txt`), `HIT-${i}\n`, "utf8");
      }
      const files = await withFastList(undefined, () =>
        grepTool({ pattern: "HIT", outputMode: "files_with_matches" }, dir)
      );
      expect(files).toContain("Found 120 file(s)");
      expect(files).toContain("[truncated: more than 100 matching files]");
      const count = await withFastList(undefined, () =>
        grepTool({ pattern: "HIT", outputMode: "count" }, dir)
      );
      expect(count).toContain("Found 120 total match(es) across 120 file(s).");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dir-listing cache", () => {
  test("repeat calls hit; tool writes invalidate (nested creates included)", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      resetDirListingStats();
      await globTool({ pattern: "*.ts" }, dir);
      const afterFirst = getDirListingStats();
      expect(afterFirst.stores).toBeGreaterThanOrEqual(1);
      await globTool({ pattern: "*.ts" }, dir);
      expect(getDirListingStats().hits).toBeGreaterThanOrEqual(1);
      // A tool write nested inside the tree invalidates ancestor listings.
      const { writeTool } = await import("../src/tools/filesystem.js");
      await writeTool({ path: "src/fresh.ts", content: "export const f = 1;\n" }, dir);
      const out = await globTool({ pattern: "fresh.ts" }, dir);
      expect(out).toContain("fresh.ts");
    } finally {
      cleanup();
    }
  });

  test("bash execution clears listings (commands can touch anything)", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      const { bashTool } = await import("../src/tools/shell.js");
      await globTool({ pattern: "*.ts" }, dir);
      await globTool({ pattern: "*.ts" }, dir);
      expect(getDirListingStats().hits).toBeGreaterThanOrEqual(1);
      const before = getDirListingStats().misses;
      await bashTool(
        { command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('via-bash.txt','x')"` },
        dir
      );
      await globTool({ pattern: "via-bash.txt" }, dir);
      expect(getDirListingStats().misses).toBeGreaterThan(before);
    } finally {
      cleanup();
    }
  });
  test("listFiles matches walker output on a non-git tree", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      // tmp trees are outside any repo… unless TMPDIR sits inside one. Either
      // way the contract holds: sorted sets equal across paths.
      const a = await withFastList(undefined, () => listFiles(dir, dir));
      const b = await withFastList("0", () => listFiles(dir, dir));
      expect([...a].sort()).toEqual([...b].sort());
      // node_modules pruned on both.
      expect(a.some((p) => p.includes("node_modules"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("git enumeration", () => {
  async function git(cwd: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile("git", args, { cwd, windowsHide: true }, (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      });
    });
  }

  test("finds untracked source files, skips ignored trees", async () => {
    try {
      await git(process.cwd(), ["--version"]);
    } catch {
      return; // no git binary: fast path degrades to walker, covered above
    }
    const dir = mkdtempSync(path.join(tmpdir(), "atom-search-git-"));
    try {
      await git(dir, ["init"]);
      await git(dir, ["config", "user.email", "t@t"]);
      await git(dir, ["config", "user.name", "t"]);
      mkdirSync(path.join(dir, "dist"), { recursive: true });
      writeFileSync(path.join(dir, ".gitignore"), "dist/\n", "utf8");
      writeFileSync(path.join(dir, "tracked.ts"), "COMMITTED-MARK\n", "utf8");
      writeFileSync(path.join(dir, "fresh.ts"), "UNTRACKED-MARK\n", "utf8");
      writeFileSync(path.join(dir, "dist", "bundle.js"), "IGNORED-MARK\n", "utf8");
      await git(dir, ["add", "tracked.ts"]);
      // Tracked + untracked-non-ignored found; ignored bundle invisible.
      expect(await grepTool({ pattern: "COMMITTED-MARK" }, dir)).toContain("tracked.ts");
      expect(await grepTool({ pattern: "UNTRACKED-MARK" }, dir)).toContain("fresh.ts");
      expect(await grepTool({ pattern: "IGNORED-MARK" }, dir)).toBe("No matches.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
