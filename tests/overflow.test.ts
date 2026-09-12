// Real-usage overflow trigger (ticket 02): auto-compaction fires on the
// provider's real reported total vs usable = verified window − reserve.
// Hermetic ATOM_HOME (temp dir) plus repo root has no atom.json, so no real
// config can leak in; env vars saved/restored per file.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { globalConfigPath, loadAtomConfig } from "../src/config.js";
import { contextWindowFor } from "../src/context-windows.js";
import {
  OVERFLOW_RESERVE_DEFAULT,
  compactAutoEnabled,
  compactReserveTokens,
  realTotalTokens,
  realUsagePct,
  shouldAutoCompactReal,
  usableLimitFor,
} from "../src/overflow.js";
import type { Usage } from "../src/zen.js";

const savedEnv = { ...process.env };
let dirs: string[] = [];

async function isolateHome(): Promise<string> {
  for (const k of ["ATOM_COMPACT_AUTO", "ATOM_COMPACT_RESERVE", "ATOM_COMPACT_PCT"]) {
    delete process.env[k];
  }
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-overflow-"));
  dirs.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

async function writeGlobalConfig(home: string, body: string): Promise<void> {
  await fsp.mkdir(path.join(home, ".atom"), { recursive: true });
  await fsp.writeFile(globalConfigPath(home), body, "utf8");
}

afterEach(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

const SMALL = "kimi-k2.5"; // 262144 window
const BIG = "deepseek-v4-pro"; // 1000000 window
const RESERVE = OVERFLOW_RESERVE_DEFAULT; // 20000

describe("realTotalTokens", () => {
  test("prefers total_tokens; else sums prompt+completion+cache parts", async () => {
    await isolateHome();
    expect(realTotalTokens({ total_tokens: 100, prompt_tokens: 400, completion_tokens: 100 })).toBe(100);
    expect(
      realTotalTokens({ prompt_tokens: 1000, completion_tokens: 200, cacheReadTokens: 50, cacheWriteTokens: 25 })
    ).toBe(1275);
    expect(realTotalTokens({ prompt_tokens: 900 })).toBe(900);
  });

  test("undefined when nothing usable was reported", async () => {
    await isolateHome();
    expect(realTotalTokens(null)).toBeUndefined();
    expect(realTotalTokens(undefined)).toBeUndefined();
    expect(realTotalTokens({})).toBeUndefined();
  });
});

describe("usable limit", () => {
  test("usable = window − reserve (default 20k)", async () => {
    await isolateHome();
    expect(usableLimitFor(SMALL)).toBe(contextWindowFor(SMALL)! - RESERVE);
    expect(usableLimitFor(BIG)).toBe(contextWindowFor(BIG)! - RESERVE);
  });

  test("unknown-window models have no usable limit (never invented)", async () => {
    await isolateHome();
    expect(usableLimitFor("mystery-model-xyz")).toBeUndefined();
  });

  test("reserve clamps sanely: below max-output floors to 4096", async () => {
    await isolateHome();
    expect(usableLimitFor(SMALL, 1)).toBe(contextWindowFor(SMALL)! - 4096);
  });
});

describe("shouldAutoCompactReal: at/below/above the line", () => {
  for (const model of [SMALL, BIG]) {
    test(`${model}: below quiet, at/above fires (total_tokens)`, async () => {
      await isolateHome();
      const usable = contextWindowFor(model)! - RESERVE;
      const opts = { auto: true, reserve: RESERVE };
      expect(shouldAutoCompactReal(model, { total_tokens: usable - 1 }, opts)).toBe(false);
      expect(shouldAutoCompactReal(model, { total_tokens: usable }, opts)).toBe(true);
      expect(shouldAutoCompactReal(model, { total_tokens: usable + 5000 }, opts)).toBe(true);
    });

    test(`${model}: parts-sum path (no total_tokens) honors the same line`, async () => {
      await isolateHome();
      const usable = contextWindowFor(model)! - RESERVE;
      const opts = { auto: true, reserve: RESERVE };
      const below: Usage = { prompt_tokens: usable - 101, completion_tokens: 50, cacheReadTokens: 25, cacheWriteTokens: 25 };
      expect(realTotalTokens(below)).toBe(usable - 1);
      expect(shouldAutoCompactReal(model, below, opts)).toBe(false);
      const at: Usage = { prompt_tokens: usable - 100, completion_tokens: 50, cacheReadTokens: 25, cacheWriteTokens: 25 };
      expect(shouldAutoCompactReal(model, at, opts)).toBe(true);
    });
  }

  test("no real usage reported → never fires (nothing estimated)", async () => {
    await isolateHome();
    const usable = contextWindowFor(SMALL)! - RESERVE;
    expect(shouldAutoCompactReal(SMALL, null, { auto: true, reserve: RESERVE })).toBe(false);
    expect(shouldAutoCompactReal(SMALL, {}, { auto: true, reserve: RESERVE })).toBe(false);
    expect(shouldAutoCompactReal(SMALL, { total_tokens: usable + 1 }, { auto: true })).toBe(true);
  });

  test("default config path (no opts): fires on real usage with default reserve", async () => {
    const home = await isolateHome();
    expect(loadAtomConfig(process.cwd(), home).config).toEqual({});
    const usable = contextWindowFor(SMALL)! - RESERVE;
    expect(shouldAutoCompactReal(SMALL, { total_tokens: usable - 1 })).toBe(false);
    expect(shouldAutoCompactReal(SMALL, { total_tokens: usable })).toBe(true);
  });
});

describe("auto=false disables auto-compaction only", () => {
  test("opts auto=false: way over the line stays quiet", async () => {
    await isolateHome();
    const usable = contextWindowFor(BIG)! - RESERVE;
    expect(shouldAutoCompactReal(BIG, { total_tokens: usable * 2 }, { auto: false })).toBe(false);
  });

  test("atom.json compactAuto=false disables; manual path untouched (no module gate on it)", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(home, JSON.stringify({ compactAuto: false }));
    expect(compactAutoEnabled()).toBe(false);
    const usable = contextWindowFor(SMALL)! - RESERVE;
    expect(shouldAutoCompactReal(SMALL, { total_tokens: usable + 1000 })).toBe(false);
  });

  test("env ATOM_COMPACT_AUTO=0 disables and wins over file=true", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(home, JSON.stringify({ compactAuto: true }));
    process.env.ATOM_COMPACT_AUTO = "0";
    expect(compactAutoEnabled()).toBe(false);
    const usable = contextWindowFor(SMALL)! - RESERVE;
    expect(shouldAutoCompactReal(SMALL, { total_tokens: usable + 1000 })).toBe(false);
  });

  test("env ATOM_COMPACT_AUTO=1 enables; invalid env falls through to file", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(home, JSON.stringify({ compactAuto: false }));
    process.env.ATOM_COMPACT_AUTO = "1";
    expect(compactAutoEnabled()).toBe(true);
    process.env.ATOM_COMPACT_AUTO = "maybe";
    expect(compactAutoEnabled()).toBe(false);
  });
});

describe("custom reserve changes the usable limit", () => {
  test("opts reserve shifts the firing line", async () => {
    await isolateHome();
    const window = contextWindowFor(SMALL)!;
    const usage: Usage = { total_tokens: window - RESERVE - 1 };
    // Below the default line…
    expect(shouldAutoCompactReal(SMALL, usage, { auto: true, reserve: RESERVE })).toBe(false);
    // …but above it once the buffer grows to 40k.
    expect(shouldAutoCompactReal(SMALL, usage, { auto: true, reserve: 40_000 })).toBe(true);
    expect(usableLimitFor(SMALL, 40_000)).toBe(window - 40_000);
  });

  test("atom.json compactReserve honored; env wins over file", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(home, JSON.stringify({ compactReserve: 40000 }));
    expect(compactReserveTokens()).toBe(40000);
    expect(usableLimitFor(SMALL)).toBe(contextWindowFor(SMALL)! - 40000);
    process.env.ATOM_COMPACT_RESERVE = "10000";
    expect(compactReserveTokens()).toBe(10000);
    expect(usableLimitFor(SMALL)).toBe(contextWindowFor(SMALL)! - 10000);
  });

  test("invalid env reserve falls through; out-of-range file value clamps", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(home, JSON.stringify({ compactReserve: 10000 }));
    process.env.ATOM_COMPACT_RESERVE = "nope";
    expect(compactReserveTokens()).toBe(10000);
    await writeGlobalConfig(home, JSON.stringify({ compactReserve: 10 }));
    delete process.env.ATOM_COMPACT_RESERVE;
    expect(compactReserveTokens()).toBe(4096);
  });
});

describe("unknown-limit models never fire, never fabricate a percent", () => {
  test("huge real usage on an unknown window stays quiet", async () => {
    await isolateHome();
    expect(shouldAutoCompactReal("mystery-model-xyz", { total_tokens: 50_000_000 }, { auto: true })).toBe(false);
    expect(shouldAutoCompactReal("mystery-model-xyz", { total_tokens: 50_000_000 })).toBe(false);
  });

  test("realUsagePct: undefined without a window or without usage; honest within", async () => {
    await isolateHome();
    expect(realUsagePct({ total_tokens: 50_000_000 }, "mystery-model-xyz")).toBeUndefined();
    expect(realUsagePct(null, SMALL)).toBeUndefined();
    expect(realUsagePct({}, SMALL)).toBeUndefined();
    const window = contextWindowFor(SMALL)!;
    expect(realUsagePct({ total_tokens: window / 2 }, SMALL)).toBe(50);
  });
});

describe("config validation", () => {
  test("non-boolean compactAuto ignored with warning; reserve clamps with warning", async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-overflow-p-"));
    dirs.push(project);
    const home = await isolateHome();
    await fsp.writeFile(
      path.join(project, "atom.json"),
      JSON.stringify({ compactAuto: "yes", compactReserve: 10 }),
      "utf8"
    );
    const { config, warnings } = loadAtomConfig(project, home);
    expect(config.compactAuto).toBeUndefined();
    expect(config.compactReserve).toBe(4096);
    expect(warnings.join("\n")).toContain("compactAuto");
    expect(warnings.join("\n")).toContain("clamped");
  });
});
