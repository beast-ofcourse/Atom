// Issue 04: budgeted tail + prune of old tool outputs (mocked fetch only).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  COMPACT_KEEP_TOKENS,
  COMPACT_PRUNED_TOOL_OUTPUT,
  COMPACT_TAIL_MAX_TOKENS,
  COMPACT_TAIL_MIN_TOKENS,
  COMPACT_TOOL_OUTPUT_CAP,
  buildCompactedHistory,
  pruneOldToolOutputs,
  requestCompactSummary,
  splitHistoryForCompaction,
  tailKeepTokensForModel,
} from "../src/compact.js";
import type { ChatMessage } from "../src/zen.js";

// Small windows to prove scaling inside the band: the repo's real verified
// windows are all >= 200K (every one clamps to the max), so a mock tiny
// window stands in for a small-window model. Unknown models stay fixed.
vi.mock("../src/context-windows.js", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("../src/context-windows.js")>();
  // NOTE: contextWindowFor must be overridden too — the original closes over
  // the original CONTEXT_WINDOWS binding, so extra map keys alone are invisible.
  const windows: Record<string, number> = {
    ...orig.CONTEXT_WINDOWS,
    "tiny-test-model": 32_000,
    "min-test-model": 21_000,
  };
  return {
    ...orig,
    CONTEXT_WINDOWS: windows,
    contextWindowFor: (model: string): number | undefined => windows[model],
  };
});

const SAVED_RESERVE = process.env.ATOM_COMPACT_RESERVE;
const SAVED_PRUNE = process.env.ATOM_COMPACT_PRUNE;

beforeEach(() => {
  // Deterministic usable limits: usable = window − 20000.
  process.env.ATOM_COMPACT_RESERVE = "20000";
  // Prune gate (issue 05): these tests rely on prune being on.
  process.env.ATOM_COMPACT_PRUNE = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (SAVED_RESERVE === undefined) delete process.env.ATOM_COMPACT_RESERVE;
  else process.env.ATOM_COMPACT_RESERVE = SAVED_RESERVE;
  if (SAVED_PRUNE === undefined) delete process.env.ATOM_COMPACT_PRUNE;
  else process.env.ATOM_COMPACT_PRUNE = SAVED_PRUNE;
});

function textTurn(i: number, padChars: number): ChatMessage[] {
  return [
    { role: "user", content: `q${i}-${"x".repeat(padChars)}` },
    { role: "assistant", content: `a${i}` },
  ];
}

function toolTurn(i: number, outputChars: number): ChatMessage[] {
  return [
    { role: "user", content: `q${i}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `c${i}`,
          type: "function",
          function: { name: "read", arguments: '{"path":"src/a.ts"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: `c${i}`, content: `r${i}-` + "z".repeat(outputChars) },
    { role: "assistant", content: `a${i}` },
  ];
}

describe("budgeted tail (criterion 1)", () => {
  test("scales with the usable limit inside the min/max band", () => {
    // tiny: usable 12000 → 25% = 3000 (inside the band, no clamp).
    expect(tailKeepTokensForModel("tiny-test-model")).toBe(3000);
    // 1M window (deepseek-v4-pro): usable 980000 → 25% = 245000 → max 15000.
    expect(tailKeepTokensForModel("deepseek-v4-pro")).toBe(COMPACT_TAIL_MAX_TOKENS);
    expect(tailKeepTokensForModel("tiny-test-model")).toBeLessThan(
      tailKeepTokensForModel("deepseek-v4-pro")
    );
  });

  test("min clamp binds on very small usable limits", () => {
    // min-test-model: usable 1000 → 25% = 250 → min 2000.
    expect(tailKeepTokensForModel("min-test-model")).toBe(COMPACT_TAIL_MIN_TOKENS);
  });

  test("unknown/blank models fall back to the fixed tail (never fabricated)", () => {
    expect(tailKeepTokensForModel("big-pickle")).toBe(COMPACT_KEEP_TOKENS);
    expect(tailKeepTokensForModel(undefined)).toBe(COMPACT_KEEP_TOKENS);
    expect(tailKeepTokensForModel("")).toBe(COMPACT_KEEP_TOKENS);
    expect(COMPACT_KEEP_TOKENS).toBe(20000);
  });

  test("split with a model keeps a smaller tail on small windows than on 1M windows", () => {
    // ~20K estimated tokens total: exceeds both budgets, so no
    // collapse-to-newest-turn rule interferes with the comparison.
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 20; i++) history.push(...textTurn(i, 4000));
    const small = splitHistoryForCompaction(history, COMPACT_KEEP_TOKENS, "tiny-test-model");
    const big = splitHistoryForCompaction(history, COMPACT_KEEP_TOKENS, "deepseek-v4-pro");
    expect(small.tail.length).toBeGreaterThan(0);
    expect(big.tail.length).toBeGreaterThan(0);
    expect(small.tail.length).toBeLessThan(big.tail.length);
    // Whole user-turns, newest turn kept on both.
    expect(small.tail[0]?.role).toBe("user");
    expect(big.tail[0]?.role).toBe("user");
    const last = history.at(-1);
    expect(small.tail.at(-1)).toEqual(last);
    expect(big.tail.at(-1)).toEqual(last);
    // No model → legacy fixed tail, byte-identical to an explicit 20k.
    const legacy = splitHistoryForCompaction(history);
    const explicit = splitHistoryForCompaction(history, 20000);
    expect(legacy).toEqual(explicit);
  });
});

describe("prune old tool outputs (criterion 2)", () => {
  test("bulky head outputs become the cleared marker; small ones pass through", () => {
    const head: ChatMessage[] = [
      { role: "user", content: "q0" },
      { role: "tool", tool_call_id: "c-big", content: "z".repeat(5000) },
      { role: "tool", tool_call_id: "c-small", content: "short result" },
      { role: "assistant", content: "a0" },
    ];
    const pruned = pruneOldToolOutputs(head);
    expect(pruned).toHaveLength(head.length);
    const big = pruned.find((m) => (m as { tool_call_id?: string }).tool_call_id === "c-big");
    expect(big?.content).toBe(COMPACT_PRUNED_TOOL_OUTPUT);
    // Existing `[truncated: ...]` family — no second convention invented.
    expect(String(big?.content).startsWith("[truncated")).toBe(true);
    const small = pruned.find((m) => (m as { tool_call_id?: string }).tool_call_id === "c-small");
    expect(small?.content).toBe("short result");
    // Boundary: exactly at the cap stays verbatim.
    const edge = pruneOldToolOutputs([
      { role: "tool", tool_call_id: "e", content: "y".repeat(COMPACT_TOOL_OUTPUT_CAP) },
    ]);
    expect(edge[0]?.content).toBe("y".repeat(COMPACT_TOOL_OUTPUT_CAP));
    // Idempotent.
    expect(pruneOldToolOutputs(pruned)).toEqual(pruned);
    // Input not mutated.
    expect((head[1] as { content: string }).content.length).toBe(5000);
  });

  test("retained tail outputs stay intact; newest turn never pruned", () => {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 4; i++) history.push(...toolTurn(i, 5000));
    // Newest turn carries the bulky output.
    const split = splitHistoryForCompaction(history, 8000);
    expect(split.head.length).toBeGreaterThan(0);
    const prunedHead = pruneOldToolOutputs(split.head);
    for (const m of prunedHead) {
      if (m.role === "tool") expect(m.content).toBe(COMPACT_PRUNED_TOOL_OUTPUT);
    }
    // Tail untouched: bulky newest output keeps its original (capped) bytes,
    // never the cleared marker; newest turn present.
    for (const m of split.tail) {
      if (m.role === "tool") {
        expect(m.content).not.toBe(COMPACT_PRUNED_TOOL_OUTPUT);
        expect(String(m.content)).toContain("[truncated");
      }
    }
    expect(JSON.stringify(split.tail)).toContain("q3");
    expect(split.tail.at(-1)).toEqual(history.at(-1));
  });
});

describe("large dump end-to-end with mocked summary POST (criterion 3)", () => {
  test("a session with a very large tool dump compacts and work continues", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "DUMP-SUMMARY" } }] }),
      } as unknown as Response;
    });
    try {
      const history: ChatMessage[] = [{ role: "system", content: "sys" }];
      history.push(...toolTurn(0, 200_000)); // ~200KB dump in an old turn.
      history.push(...toolTurn(1, 100));
      history.push(...textTurn(2, 10));
      const split = splitHistoryForCompaction(history, 8000);
      expect(split.head.length).toBeGreaterThan(0);
      expect(JSON.stringify(split.head).length).toBeGreaterThan(200_000);

      const summary = await requestCompactSummary({
        provider: "opencode-zen",
        apiKey: "k",
        model: "m",
        systemContent: "sys",
        head: split.head,
      });
      expect(summary).toBe("DUMP-SUMMARY");
      // The POST carried the marker, not the 200KB blob.
      const body = posts.at(-1)!;
      const dumped = JSON.stringify(body);
      expect(dumped).toContain(COMPACT_PRUNED_TOOL_OUTPUT);
      expect(dumped.length).toBeLessThan(50_000);

      const next = buildCompactedHistory(
        history[0]!,
        summary,
        split.tail,
        split.olderTurnCount,
        "2026-01-01T00:00:00.000Z"
      );
      expect(next[0]).toEqual({ role: "system", content: "sys" });
      expect(String((next[1] as { content: string }).content)).toContain("DUMP-SUMMARY");
      // Work continues: the newest turn survived verbatim at the end.
      expect(JSON.stringify(next)).toContain("q2-");
      expect(next.at(-1)).toEqual(history.at(-1));
      // And the compacted session itself compacts again cleanly (mocked).
      const again = splitHistoryForCompaction([
        ...next,
        { role: "user", content: "follow-up" },
        { role: "assistant", content: "ack" },
      ]);
      expect(JSON.stringify(again.tail)).toContain("follow-up");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("safety invariants (criterion 4)", () => {
  test("single-turn and empty-head cases stay quiet", () => {
    // System only.
    expect(
      splitHistoryForCompaction([{ role: "system", content: "s" }])
    ).toEqual({ head: [], tail: [], olderTurnCount: 0 });
    // Single user turn: nothing older to summarize.
    const single = splitHistoryForCompaction([
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    expect(single.olderTurnCount === 0 || single.head.length === 0).toBe(true);
    // No user turns at all.
    expect(
      splitHistoryForCompaction([
        { role: "system", content: "s" },
        { role: "assistant", content: "yo" },
      ])
    ).toEqual({ head: [], tail: [], olderTurnCount: 0 });
    // Pruning an empty head is a no-op.
    expect(pruneOldToolOutputs([])).toEqual([]);
  });

  test("newest turn is never dropped, even when it alone exceeds the budget", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...textTurn(0, 100),
      ...textTurn(1, 100),
      // Newest turn alone (~12K chars ≈ 3K tokens) exceeds a tiny budget.
      ...textTurn(2, 12_000),
    ];
    const split = splitHistoryForCompaction(history, 800);
    expect(split.tail.length).toBeGreaterThan(0);
    expect(split.tail[0]?.role).toBe("user");
    expect(split.tail.at(-1)).toEqual(history.at(-1));
    expect(JSON.stringify(split.tail)).toContain("q2-");
  });
});
