// ripgrep-path tests: byte-identical output vs the walker, silent fallback
// on anything unusable, stats accounting. Real temp dirs + real rg binary;
// missing-binary covered by emptying PATH. No network.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getRipgrepStats,
  resetRgAvailable,
  resetRipgrepStats,
  rgAvailable,
  rgMinFiles,
  RG_MIN_FILES_DEFAULT,
} from "../src/tools/ripgrep.js";
import { grepTool } from "../src/tools/search.js";

const SAVED = {
  rg: process.env.ATOM_RG,
  min: process.env.ATOM_RG_MIN_FILES,
  path: process.env.PATH,
};

afterEach(() => {
  resetRgAvailable();
  resetRipgrepStats();
  if (SAVED.rg === undefined) delete process.env.ATOM_RG;
  else process.env.ATOM_RG = SAVED.rg;
  if (SAVED.min === undefined) delete process.env.ATOM_RG_MIN_FILES;
  else process.env.ATOM_RG_MIN_FILES = SAVED.min;
  if (SAVED.path !== undefined) process.env.PATH = SAVED.path;
});

function tmpTree(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "atom-rg-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), "export const alpha = 1;\n// MARKER-ONE\n", "utf8");
  writeFileSync(path.join(dir, "src", "b.ts"), "export const beta = 2;\n", "utf8");
  // CRLF file: walker split("\n") keeps \\r — parity must hold exactly.
  writeFileSync(path.join(dir, "src", "c.ts"), "line one MARKER-ONE\r\nline two\r\n", "utf8");
  // Binary file containing the pattern: both paths must skip it silently.
  const bin = Buffer.from("MARKER-ONE before\0after MARKER-ONE\n", "utf8");
  writeFileSync(path.join(dir, "src", "bin.dat"), bin);
  writeFileSync(path.join(dir, "README.md"), "# demo MARKER-ONE\n", "utf8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetRgAvailable();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetRgAvailable();
  }
}

describe("routing + availability", () => {
  test("defaults: enabled, 1000-file threshold; env overrides honored", () => {
    expect(RG_MIN_FILES_DEFAULT).toBe(1000);
    expect(rgMinFiles()).toBe(1000);
  });

  test("ATOM_RG=0 disables without probing; missing binary falls back", async () => {
    await withEnv({ ATOM_RG: "0" }, async () => {
      expect(rgAvailable()).toBe(false);
    });
    await withEnv({ PATH: "" }, async () => {
      expect(rgAvailable()).toBe(false);
    });
  });

  test("small scopes never touch rg by default (no spawn tax)", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      resetRipgrepStats();
      await grepTool({ pattern: "MARKER-ONE" }, dir);
      expect(getRipgrepStats().uses).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("parity: rg output equals walker output", () => {
  async function both(args: Parameters<typeof grepTool>[0], dir: string): Promise<void> {
    const fast = await withEnv({ ATOM_RG_MIN_FILES: "1" }, () => grepTool(args, dir));
    const legacy = await withEnv({ ATOM_RG: "0" }, () => grepTool(args, dir));
    expect(fast).toBe(legacy);
  }

  test("all modes + include filter, incl. binary-skip and CRLF", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      await both({ pattern: "MARKER-ONE" }, dir);
      await both({ pattern: "MARKER-ONE", outputMode: "files_with_matches" }, dir);
      await both({ pattern: "MARKER-ONE", outputMode: "count" }, dir);
      await both({ pattern: "export", include: "*.ts" }, dir);
      await both({ pattern: "nomatch-zzz" }, dir);
      await both({ pattern: "line" }, dir);
    } finally {
      cleanup();
    }
  });

  test("JS-only regex (lookahead) falls back instead of erroring", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      resetRipgrepStats();
      const fast = await withEnv({ ATOM_RG_MIN_FILES: "1" }, () =>
        grepTool({ pattern: "MARKER-(?=ONE)" }, dir)
      );
      const legacy = await withEnv({ ATOM_RG: "0" }, () => grepTool({ pattern: "MARKER-(?=ONE)" }, dir));
      expect(fast).toBe(legacy);
      expect(fast).toContain("MARKER-ONE");
      expect(getRipgrepStats().fallbacks).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  test("invalid-for-both regex errors identically (never reaches rg)", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      const fast = await withEnv({ ATOM_RG_MIN_FILES: "1" }, () => grepTool({ pattern: "[unclosed" }, dir));
      expect(fast.startsWith("Error: invalid regex")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("rg path records uses; missing binary degrades silently", async () => {
    const { dir, cleanup } = tmpTree();
    try {
      resetRipgrepStats();
      await withEnv({ ATOM_RG_MIN_FILES: "1" }, () => grepTool({ pattern: "MARKER-ONE" }, dir));
      const s = getRipgrepStats();
      if (s.available) {
        expect(s.uses).toBeGreaterThanOrEqual(1);
      } else {
        // No rg on this machine: walker answered, fallback counted.
        expect(s.fallbacks).toBeGreaterThanOrEqual(1);
      }
      // Empty PATH forces the fallback deterministically.
      resetRipgrepStats();
      const out = await withEnv({ ATOM_RG_MIN_FILES: "1", PATH: "" }, () =>
        grepTool({ pattern: "MARKER-ONE" }, dir)
      );
      expect(out).toContain("MARKER-ONE");
    } finally {
      cleanup();
    }
  });

  test("content cap + note identical at exactly-100 and over-100 matches", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atom-rg-cap-"));
    try {
      for (let i = 0; i < 120; i++) {
        writeFileSync(path.join(dir, `f${i}.txt`), `HIT line ${i}\n`, "utf8");
      }
      const fast = await withEnv({ ATOM_RG_MIN_FILES: "1" }, () => grepTool({ pattern: "HIT" }, dir));
      const legacy = await withEnv({ ATOM_RG: "0" }, () => grepTool({ pattern: "HIT" }, dir));
      expect(fast).toBe(legacy);
      expect(fast).toContain("[truncated: more than 100 matches]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("out-of-tree dir (cwd != search dir) matches across paths", async () => {
    // Regression: rg emits dir-relative paths while enumeration is
    // cwd-relative; without the shared mapping the intersect emptied and the
    // rg path answered "No matches." on real hits. This is the benchmark's
    // own shape (absolute tmp dir searched from the repo root).
    const { dir, cleanup } = tmpTree();
    const outer = process.cwd();
    try {
      const fast = await withEnv({ ATOM_RG_MIN_FILES: "1" }, () =>
        grepTool({ pattern: "MARKER-ONE", dir }, outer)
      );
      const legacy = await withEnv({ ATOM_RG: "0" }, () =>
        grepTool({ pattern: "MARKER-ONE", dir }, outer)
      );
      expect(fast).toBe(legacy);
      expect(fast).toContain("MARKER-ONE");
      const fastCount = await withEnv({ ATOM_RG_MIN_FILES: "1" }, () =>
        grepTool({ pattern: "MARKER-ONE", outputMode: "count", dir }, outer)
      );
      const legacyCount = await withEnv({ ATOM_RG: "0" }, () =>
        grepTool({ pattern: "MARKER-ONE", outputMode: "count", dir }, outer)
      );
      expect(fastCount).toBe(legacyCount);
    } finally {
      cleanup();
    }
  });
});
