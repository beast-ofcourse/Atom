// ContextManager tests: window-derived budgets, usage answers, compaction
// decisions, and pairing-safe trimming. Hermetic ATOM_HOME (temp dir) so no
// real atom.json can leak in; env vars saved/restored per file.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  HARD_CEILING_FLOOR_CHARS,
  OUTPUT_RESERVE_TOKENS,
  SAFETY_MARGIN_PCT,
  createContextManager,
} from "../src/context-manager.js";
import type { ChatMessage } from "../src/zen.js";
import { contextWindowFor } from "../src/context-windows.js";

const savedEnv = { ...process.env };
let dirs: string[] = [];

async function isolateHome(): Promise<string> {
  for (const k of [
    "ATOM_MAX_HISTORY_MESSAGES",
    "ATOM_MAX_HISTORY_CHARS",
    "ATOM_MAX_TOOL_STEPS",
    "ATOM_COMPACT_PCT",
  ]) {
    delete process.env[k];
  }
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-ctx-"));
  dirs.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

afterEach(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

function sysHistory(sysChars: number, extra: ChatMessage[] = []): ChatMessage[] {
  return [{ role: "system", content: "s".repeat(sysChars) }, ...extra];
}

describe("budget derivation", () => {
  test("1M-window model gets a window-derived allowance, not the 200K floor", async () => {
    await isolateHome();
    const mgr = createContextManager({ model: "deepseek-v4-pro", toolsChars: 15111 });
    const b = mgr.budget(sysHistory(4000));
    expect(b.windowTokens).toBe(1_000_000);
    expect(b.systemTokens).toBe(1000);
    expect(b.toolsTokens).toBe(3777);
    expect(b.outputReserveTokens).toBe(OUTPUT_RESERVE_TOKENS);
    expect(b.safetyMarginTokens).toBe(Math.floor(1_000_000 * SAFETY_MARGIN_PCT));
    // window − system − tools − reserve − margin, in tokens then chars.
    expect(b.historyTokens).toBe(1_000_000 - 1000 - 3777 - 4096 - 50000);
    expect(b.historyChars).toBe((1_000_000 - 1000 - 3777 - 4096 - 50000) * 4);
    expect(b.hardCeilingExplicit).toBe(false);
    expect(b.effectiveMaxChars).toBe((1_000_000 - 1000 - 3777 - 4096 - 50000) * 4);
    expect(b.effectiveMaxChars).toBeGreaterThan(HARD_CEILING_FLOOR_CHARS);
    expect(b.effectiveMaxMessages).toBe(100);
  });

  test("unknown-window model keeps the legacy ceiling exactly", async () => {
    await isolateHome();
    const mgr = createContextManager({ model: "mystery-model-xyz", toolsChars: 15111 });
    const b = mgr.budget(sysHistory(4000));
    expect(b.windowTokens).toBeUndefined();
    expect(b.historyTokens).toBeUndefined();
    expect(b.historyChars).toBeUndefined();
    expect(b.effectiveMaxChars).toBe(HARD_CEILING_FLOOR_CHARS);
    expect(b.effectiveMaxChars).toBe(200_000);
    expect(b.effectiveMaxMessages).toBe(100);
  });

  test("explicit ceiling caps the derived budget but never raises an unknown one silently", async () => {
    await isolateHome();
    process.env.ATOM_MAX_HISTORY_CHARS = "50000";
    const known = createContextManager({ model: "deepseek-v4-pro", toolsChars: 0 });
    const b = known.budget(sysHistory(0));
    expect(b.hardCeilingExplicit).toBe(true);
    expect(b.effectiveMaxChars).toBe(50000);
    const unknown = createContextManager({ model: "mystery-model-xyz", toolsChars: 0 });
    expect(unknown.budget(sysHistory(0)).effectiveMaxChars).toBe(50000);
  });

  test("env ceiling larger than the window still respects the window", async () => {
    await isolateHome();
    // kimi-k2.5: 262144 window. A 2M-char ceiling must not push past it.
    process.env.ATOM_MAX_HISTORY_CHARS = "2000000";
    const mgr = createContextManager({ model: "kimi-k2.5", toolsChars: 0 });
    const b = mgr.budget(sysHistory(0));
    const window = contextWindowFor("kimi-k2.5")!;
    expect(b.historyChars).toBeLessThan(2000000);
    expect(b.effectiveMaxChars).toBe(b.historyChars);
    expect(b.historyTokens).toBeLessThanOrEqual(window);
  });
});

describe("usage answers", () => {
  test("chars, messages, turns, load, and pct", async () => {
    await isolateHome();
    const mgr = createContextManager({ model: "deepseek-v4-pro" });
    const history: ChatMessage[] = [
      { role: "system", content: "s".repeat(100) },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const u = mgr.usage(history);
    expect(u.historyChars).toBe(104);
    expect(u.historyMessages).toBe(3);
    expect(u.userTurns).toBe(1);
    expect(u.loadTokens).toBe(26);
    expect(u.loadPct).toBe(0);
  });

  test("reported prompt_tokens win; unknown window has no pct", async () => {
    await isolateHome();
    const mgr = createContextManager({ model: "mystery-model-xyz" });
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    expect(mgr.usage(history, 45056).loadTokens).toBe(45056);
    expect(mgr.usage(history, 45056).loadPct).toBeUndefined();
    expect(mgr.usage(history).loadTokens).toBe(0);
  });
});

describe("needsCompaction", () => {
  test("pct-of-window trigger; never for unknown windows", async () => {
    await isolateHome();
    const mgr = createContextManager({ model: "kimi-k2.5" });
    const window = contextWindowFor("kimi-k2.5")!;
    expect(mgr.needsCompaction(Math.ceil(window * 0.83))).toBe(true);
    expect(mgr.needsCompaction(Math.floor(window * 0.83) - 1)).toBe(false);
    const unknown = createContextManager({ model: "mystery-model-xyz" });
    expect(unknown.needsCompaction(1_000_000)).toBe(false);
    expect(unknown.needsCompaction(0)).toBe(false);
  });
});

describe("trimForSend", () => {
  function bigHistory(turns: number): ChatMessage[] {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < turns; i++) {
      history.push({ role: "user", content: `q${i} ${"x".repeat(500)}` });
      history.push({ role: "assistant", content: `a${i} ${"y".repeat(500)}` });
    }
    return history;
  }

  test("drops oldest turns under an explicit ceiling, keeps system + pins, notifies once", async () => {
    await isolateHome();
    const mgr = createContextManager({
      model: "mystery-model-xyz",
      hardCeilingChars: 3000,
      hardCeilingMessages: 100,
    });
    const history = bigHistory(10);
    const notices: string[] = [];
    const out = mgr.trimForSend(history, (m) => void notices.push(m));
    expect(out.droppedTurns).toBeGreaterThan(0);
    expect(notices).toHaveLength(1);
    expect(history[0]).toEqual({ role: "system", content: "sys" });
    // Latest turn survives (assistant answer still the tail).
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: `a9 ${"y".repeat(500)}` });
  });

  test("window-derived caps let large histories ride on large windows", async () => {
    await isolateHome();
    const mgr = createContextManager({ model: "deepseek-v4-pro", toolsChars: 0 });
    const history = bigHistory(10);
    const before = history.length;
    const out = mgr.trimForSend(history);
    // ~10K chars of history against a ~3.7M-char derived cap: nothing drops.
    expect(out.droppedTurns).toBe(0);
    expect(history.length).toBe(before);
  });
});
