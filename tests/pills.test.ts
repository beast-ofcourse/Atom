// Brand-dock Phase 2 item 2.2 — pill helper unit tests. Same cases as
// tests/status-bar.test.tsx, tests/goal-surface.test.ts, and
// tests/layout-caps.test.tsx, run against src/ui/pills.ts.
import { describe, expect, test } from "vitest";
import { theme } from "../src/ui/theme.js";
import {
  GOAL_STATUS_OBJECTIVE_CHARS,
  fitGoalSegment,
  formatGoalSegment,
  formatStatusTokenSegment,
  isEstimatedLoad,
  markTokenEstimate,
  shortenCwd,
  shrinkTo,
  truncateGoalObjective,
} from "../src/ui/pills.js";

describe("shortenCwd", () => {
  test("home collapses and long tails cut", () => {
    expect(shortenCwd("/home/u/p", "/home/u")).toBe("~/p");
    expect(shortenCwd("/x/y", "/home/u")).toBe("/x/y");
    const long = `/home/u/${"a".repeat(40)}`;
    const short = shortenCwd(long, "/home/u");
    expect(short.length).toBeLessThanOrEqual(20);
    expect(short.startsWith("…/")).toBe(true);
  });
});

describe("shrinkTo", () => {
  test("short text passes through, tight widths cut tail-first", () => {
    expect(shrinkTo("abc", 10)).toBe("abc");
    expect(shrinkTo("abcdefghij", 7)).toBe("…/ghij");
    expect(shrinkTo("abcdefghij", 4).length).toBeLessThanOrEqual(4);
  });
  test("n < 4 yields empty (caller drops segment)", () => {
    expect(shrinkTo("abcdefghij", 3)).toBe("");
    expect(shrinkTo("abcdefghij", 0)).toBe("");
  });
});

describe("truncateGoalObjective", () => {
  test("keeps short text verbatim", () => {
    expect(truncateGoalObjective("Ship v2")).toBe("Ship v2");
  });
  test("default budget equals the token", () => {
    const long = "x".repeat(100);
    expect(truncateGoalObjective(long)).toBe(
      truncateGoalObjective(long, theme.spacing.statusGoalObjectiveChars),
    );
    expect(GOAL_STATUS_OBJECTIVE_CHARS).toBe(
      theme.spacing.statusGoalObjectiveChars,
    );
  });
  test("n < 4 yields empty", () => {
    expect(truncateGoalObjective("x".repeat(100), 3)).toBe("");
  });
});

describe("formatGoalSegment", () => {
  test("active goal renders compact segment with state marker", () => {
    expect(formatGoalSegment({ objective: "Ship v2", active: true })).toBe(
      "goal: Ship v2 [active]",
    );
  });
  test("paused reads distinct from active", () => {
    expect(formatGoalSegment({ objective: "Ship v2", active: false })).toBe(
      "goal: Ship v2 [paused]",
    );
  });
  test("no goal renders nothing (null segment)", () => {
    expect(formatGoalSegment(null)).toBeNull();
    expect(formatGoalSegment(undefined as never)).toBeNull();
    expect(formatGoalSegment({ objective: "", active: true })).toBeNull();
  });
  test("long objectives truncate with ellipsis tail", () => {
    const long = "x".repeat(100);
    const seg = formatGoalSegment({ objective: long, active: true });
    expect(seg).not.toBeNull();
    expect(seg!.length).toBeLessThan(`goal: ${long} [active]`.length);
    expect(seg).toContain("…");
    expect(seg).toContain("[active]");
  });
});

describe("fitGoalSegment", () => {
  test("drops whole when no room (never displaces)", () => {
    const goal = { objective: "Ship v2", active: true };
    expect(fitGoalSegment(goal, 0)).toBeNull();
    expect(fitGoalSegment(goal, 4)).toBeNull();
    expect(fitGoalSegment(null, 100)).toBeNull();
  });
  test("keeps full text when it fits", () => {
    const goal = { objective: "Ship v2", active: false };
    expect(fitGoalSegment(goal, 200)).toBe("goal: Ship v2 [paused]");
  });
  test("busy guest cap fits within the token", () => {
    const seg = fitGoalSegment(
      { objective: "x".repeat(100), active: true },
      theme.spacing.statusBusyGoalChars,
    );
    expect(seg).not.toBeNull();
    expect(seg!.length).toBeLessThanOrEqual(theme.spacing.statusBusyGoalChars);
  });
});

describe("token estimate helpers", () => {
  test("isEstimatedLoad: explicit latch wins, else never-reported heuristic", () => {
    expect(isEstimatedLoad(null, null)).toBe(false);
    expect(isEstimatedLoad(null, 45056)).toBe(false);
    expect(
      isEstimatedLoad({ prompt_tokens: 45056, total_tokens: 45056 }, 45056),
    ).toBe(false);
    expect(isEstimatedLoad({ total_tokens: 45056 }, 45056)).toBe(true);
    expect(isEstimatedLoad({ prompt_tokens: 1 }, 1, true)).toBe(true);
    expect(isEstimatedLoad({ total_tokens: 1 }, 1, false)).toBe(false);
  });
  test("markTokenEstimate only touches the (P%) form", () => {
    expect(markTokenEstimate("token: (17%) 44K")).toBe("token: (~17%) 44K");
    expect(markTokenEstimate("token: n/a")).toBe("token: n/a");
    expect(markTokenEstimate("token: 44K")).toBe("token: 44K");
  });
  test("formatStatusTokenSegment labels estimates, keeps exact + bare forms", () => {
    expect(
      formatStatusTokenSegment(
        { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 },
        "kimi-k2.5",
        45056,
        false,
      ),
    ).toBe("token: (17%) 44K");
    expect(formatStatusTokenSegment(null, "kimi-k2.5", 45056, true)).toBe(
      "token: n/a",
    );
    expect(
      formatStatusTokenSegment({ total_tokens: 45056 }, "big-pickle", 45056, true),
    ).toBe("token: 44K");
  });
});
