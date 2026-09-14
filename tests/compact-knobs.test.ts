// Config knobs parity (ticket 01): compactTailTurns, compactPreserveRecentTokens,
// compactPrune — file+env acceptance, precedence (env wins), invalid-value
// fallback, and untouched auto=false semantics. Hermetic ATOM_HOME (temp dir);
// env vars saved/restored per file like tests/overflow.test.ts.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  COMPACT_PRESERVE_RECENT_MAX_TOKENS,
  COMPACT_PRESERVE_RECENT_MIN_TOKENS,
  compactPreserveRecentTokens,
  compactPruneEnabled,
  compactTailTurns,
} from "../src/compact.js";
import { globalConfigPath, loadAtomConfig } from "../src/config.js";
import { compactAutoEnabled, shouldAutoCompactReal } from "../src/overflow.js";

const savedEnv = { ...process.env };
let dirs: string[] = [];

const KNOB_ENVS = [
  "ATOM_COMPACT_TAIL_TURNS",
  "ATOM_COMPACT_PRESERVE_RECENT_TOKENS",
  "ATOM_COMPACT_PRUNE",
  "ATOM_COMPACT_AUTO",
  "ATOM_COMPACT_RESERVE",
  "ATOM_COMPACT_PCT",
];

async function isolateHome(): Promise<string> {
  for (const k of KNOB_ENVS) delete process.env[k];
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-knobs-"));
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

describe("defaults (unset)", () => {
  test("tail turns + preserve tokens unset (no caps); prune off", async () => {
    await isolateHome();
    expect(compactTailTurns()).toBeUndefined();
    expect(compactPreserveRecentTokens()).toBeUndefined();
    expect(compactPruneEnabled()).toBe(false);
  });
});

describe("file acceptance", () => {
  test("valid knobs load from atom.json", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(
      home,
      JSON.stringify({ compactTailTurns: 5, compactPreserveRecentTokens: 20000, compactPrune: true })
    );
    expect(compactTailTurns()).toBe(5);
    expect(compactPreserveRecentTokens()).toBe(20000);
    expect(compactPruneEnabled()).toBe(true);
  });

  test("0 tail turns loads as 0 (documented: no turn-count cap)", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(home, JSON.stringify({ compactTailTurns: 0 }));
    expect(compactTailTurns()).toBe(0);
  });

  test("invalid values fall back per-key with warnings; loading never throws", async () => {
    const project = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-knobs-p-"));
    dirs.push(project);
    const home = await isolateHome();
    await fsp.writeFile(
      path.join(project, "atom.json"),
      JSON.stringify({ compactTailTurns: -3, compactPrune: "yes", compactPreserveRecentTokens: 10 }),
      "utf8"
    );
    const { config, warnings } = loadAtomConfig(project, home);
    expect(config.compactTailTurns).toBeUndefined();
    expect(config.compactPrune).toBeUndefined();
    // Preserve clamps like the other ranged keys (with a warning).
    expect(config.compactPreserveRecentTokens).toBe(COMPACT_PRESERVE_RECENT_MIN_TOKENS);
    const flat = warnings.join("\n");
    expect(flat).toContain("compactTailTurns");
    expect(flat).toContain("compactPrune");
    expect(flat).toContain("clamped");
    // Readers see the same fallback through the live paths (global home):
    // invalid file values ignored, out-of-range file value clamped.
    await writeGlobalConfig(
      home,
      JSON.stringify({ compactTailTurns: -3, compactPrune: "yes", compactPreserveRecentTokens: 10 })
    );
    expect(compactTailTurns()).toBeUndefined();
    expect(compactPruneEnabled()).toBe(false);
    expect(compactPreserveRecentTokens()).toBe(COMPACT_PRESERVE_RECENT_MIN_TOKENS);
  });
});

describe("precedence (env wins)", () => {
  test("env overrides file for all three knobs", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(
      home,
      JSON.stringify({ compactTailTurns: 5, compactPreserveRecentTokens: 20000, compactPrune: false })
    );
    expect(compactTailTurns()).toBe(5);
    process.env.ATOM_COMPACT_TAIL_TURNS = "9";
    process.env.ATOM_COMPACT_PRESERVE_RECENT_TOKENS = "30000";
    process.env.ATOM_COMPACT_PRUNE = "1";
    expect(compactTailTurns()).toBe(9);
    expect(compactPreserveRecentTokens()).toBe(30000);
    expect(compactPruneEnabled()).toBe(true);
  });

  test("invalid env falls through to file; out-of-range env clamps", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(
      home,
      JSON.stringify({ compactTailTurns: 4, compactPreserveRecentTokens: 8000, compactPrune: true })
    );
    process.env.ATOM_COMPACT_TAIL_TURNS = "nope";
    process.env.ATOM_COMPACT_PRESERVE_RECENT_TOKENS = "nope";
    process.env.ATOM_COMPACT_PRUNE = "maybe";
    expect(compactTailTurns()).toBe(4);
    expect(compactPreserveRecentTokens()).toBe(8000);
    expect(compactPruneEnabled()).toBe(true);
    process.env.ATOM_COMPACT_PRESERVE_RECENT_TOKENS = "999999999";
    expect(compactPreserveRecentTokens()).toBe(COMPACT_PRESERVE_RECENT_MAX_TOKENS);
    process.env.ATOM_COMPACT_TAIL_TURNS = "-2";
    expect(compactTailTurns()).toBe(4);
  });
});

describe("auto=false semantics untouched", () => {
  test("manual path has no gate on the new knobs; auto=false still only quiets auto", async () => {
    const home = await isolateHome();
    await writeGlobalConfig(
      home,
      JSON.stringify({ compactAuto: false, compactTailTurns: 3, compactPrune: true })
    );
    expect(compactAutoEnabled()).toBe(false);
    // New knobs read independently — they never flip the auto switch.
    expect(compactTailTurns()).toBe(3);
    expect(compactPruneEnabled()).toBe(true);
    const { splitHistoryForCompaction } = await import("../src/compact.js");
    const history = [
      { role: "system", content: "sys" },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ] as Parameters<typeof splitHistoryForCompaction>[0];
    // Manual split works with auto off (no mechanics rewire — same budget path).
    const split = splitHistoryForCompaction(history);
    expect(split.olderTurnCount).toBeGreaterThanOrEqual(0);
    expect(shouldAutoCompactReal("mystery-model-xyz", { total_tokens: 1 })).toBe(false);
  });
});
