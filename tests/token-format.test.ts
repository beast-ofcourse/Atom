// Token-format matrix for the footer segment (pure unit tests, no network).
// Format is EXACT: `token: (P%) NK` with a verified window, bare `token: NK`
// without one, `token: n/a` until the API reports usage.
// CORRECTNESS FIX: P% tracks CURRENT context load (last prompt_tokens, else
// the 4ch/token estimate — passed explicitly); NK tracks CUMULATIVE session
// spend. Cumulative growth after compaction must NOT move P.
import { describe, expect, test } from "vitest";
import {
  contextWindowFor,
  formatTokenSegment,
} from "../src/context-windows.js";

describe("formatTokenSegment matrix", () => {
  test("no usage yet is the honest `token: n/a` (any model)", () => {
    expect(formatTokenSegment(null, "kimi-k2.5")).toBe("token: n/a");
    expect(formatTokenSegment(null, "big-pickle")).toBe("token: n/a");
    // Load alone never escapes `n/a` (honesty rule).
    expect(formatTokenSegment(null, "kimi-k2.5", 45056)).toBe("token: n/a");
  });

  test("known window renders `token: (P%) NK` from load + cumulative", () => {
    // kimi-k2.5 window is 262144: load 45056 -> 44K at 17% (forced change:
    // load is now passed explicitly; NK still comes from cumulative usage).
    expect(
      formatTokenSegment(
        { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 },
        "kimi-k2.5",
        45056
      )
    ).toBe("token: (17%) 44K");
  });

  test("P uses load, NK uses cumulative spend (compaction correctness)", () => {
    // Cumulative 200000 (195K) but current load only 45056 → P stays 17%,
    // NK reflects the spend. Before the fix both came from the cumulative.
    expect(
      formatTokenSegment({ total_tokens: 200000 }, "kimi-k2.5", 45056)
    ).toBe("token: (17%) 195K");
    // Load omitted falls back to the cumulative (backward compat).
    expect(formatTokenSegment({ total_tokens: 45056 }, "kimi-k2.5")).toBe(
      "token: (17%) 44K"
    );
  });

  test("total_tokens is preferred over in+out for NK", () => {
    expect(
      formatTokenSegment(
        { prompt_tokens: 100000, completion_tokens: 100000, total_tokens: 45056 },
        "kimi-k2.5",
        45056
      )
    ).toBe("token: (17%) 44K");
  });

  test("in+out fallback when total_tokens is absent (NK)", () => {
    expect(
      formatTokenSegment(
        { prompt_tokens: 40000, completion_tokens: 5056 },
        "kimi-k2.5",
        45056
      )
    ).toBe("token: (17%) 44K");
  });

  test("unknown window renders bare `token: NK` (never invented)", () => {
    expect(
      formatTokenSegment(
        { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 },
        "big-pickle",
        45056
      )
    ).toBe("token: 44K");
    expect(contextWindowFor("big-pickle")).toBeUndefined();
  });

  test("zero usage: `(0%) 0K` with a window, `0K` without", () => {
    expect(formatTokenSegment({ total_tokens: 0 }, "kimi-k2.5", 0)).toBe(
      "token: (0%) 0K"
    );
    expect(formatTokenSegment({}, "kimi-k2.5", 0)).toBe("token: (0%) 0K");
    expect(formatTokenSegment({ total_tokens: 0 }, "big-pickle", 0)).toBe(
      "token: 0K"
    );
  });

  test("K rounding uses Math.round(total/1024)", () => {
    expect(formatTokenSegment({ total_tokens: 1024 }, "big-pickle")).toBe(
      "token: 1K"
    );
    expect(formatTokenSegment({ total_tokens: 1023 }, "big-pickle")).toBe(
      "token: 1K"
    );
    expect(formatTokenSegment({ total_tokens: 512 }, "big-pickle")).toBe(
      "token: 1K"
    );
    expect(formatTokenSegment({ total_tokens: 511 }, "big-pickle")).toBe(
      "token: 0K"
    );
  });

  test("curated windows are present for verified models", () => {
    expect(contextWindowFor("deepseek-v4-pro")).toBe(1_000_000);
    expect(contextWindowFor("kimi-k3")).toBe(1_048_576);
    expect(contextWindowFor("glm-5.2")).toBe(1_000_000);
    expect(contextWindowFor("minimax-m2.5")).toBe(204_800);
    expect(contextWindowFor("gpt-5.6-terra")).toBe(1_050_000);
    expect(contextWindowFor("claude-sonnet-5")).toBe(1_000_000);
  });
});
