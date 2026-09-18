// Phase 0 baseline pins (goal-tools-refactor): current single-tool +
// slash-only lifecycle behavior, pinned before the refactor. Pure level
// (src/goal.ts), no TUI. Per-POST visibility + loop behavior already pinned
// by goal-tool-visibility.test.ts and goal-disposition.test.ts.
import { describe, expect, test } from "vitest";
import {
  emptyGoalStats,
  goalClearNotice,
  goalPauseNotice,
  goalResumeNotice,
  goalSetNotice,
  goalStatusText,
  parseGoalCommand,
  restoreGoalFromPersist,
  sameGoalDisposition,
  serializeGoalForPersist,
  updateGoalDisposition,
  validateUpdateGoalArgs,
} from "../src/goal.js";

describe("baseline: slash parser", () => {
  test("bare /goal shows status; commands case-insensitive; rest is objective", () => {
    expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
    expect(parseGoalCommand("/goal   ")).toEqual({ kind: "status" });
    expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("/goal PAUSE")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("/goal Resume")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("/goal Ship v2")).toEqual({
      kind: "set",
      objective: "Ship v2",
    });
  });
});

describe("baseline: notices", () => {
  test("set/clear/pause/resume notices describe transitions", () => {
    expect(goalSetNotice("B", null)).toContain("B");
    expect(
      goalSetNotice("B", { objective: "A", active: true })
    ).toContain("replaced");
    expect(goalClearNotice(null)).toContain("nothing to clear");
    expect(goalClearNotice({ objective: "A", active: true })).toContain("A");
    expect(goalPauseNotice(null)).toContain("nothing to pause");
    expect(
      goalPauseNotice({ objective: "A", active: false })
    ).toContain("already paused");
    expect(goalResumeNotice(null)).toContain("no goal");
    expect(
      goalResumeNotice({ objective: "A", active: true })
    ).toContain("already active");
    expect(
      goalStatusText({ objective: "A", active: true, stats: emptyGoalStats() })
    ).toContain("active");
  });
});

describe("baseline: report validation + idempotence", () => {
  test("continue/complete/blocked validate; same disposition is idempotent", () => {
    expect(validateUpdateGoalArgs({ status: "continue" })).toBeNull();
    expect(
      validateUpdateGoalArgs({ status: "continue", next: "probe the cache" })
    ).toBeNull();
    expect(validateUpdateGoalArgs({ status: "complete", reason: "done" })).toBeNull();
    expect(validateUpdateGoalArgs({ status: "blocked" })).not.toBeNull();
    expect(validateUpdateGoalArgs({ status: "bogus" })).not.toBeNull();
    const a = updateGoalDisposition({ status: "complete", reason: "done" });
    const b = updateGoalDisposition({ status: "complete", reason: "done" });
    expect(sameGoalDisposition(a, b)).toBe(true);
    expect(
      sameGoalDisposition(a, updateGoalDisposition({ status: "blocked", reason: "x" }))
    ).toBe(false);
  });
});

describe("baseline: persist round-trip", () => {
  test("serialize/restore keeps objective, flag, stats; corrupt loads null", () => {
    const live = {
      objective: "Ship v2",
      active: false,
      stats: { turns: 2, requests: 3, tokens: 100, workMs: 4000 },
    };
    const saved = serializeGoalForPersist(live);
    expect(saved).toMatchObject({ objective: "Ship v2", active: false });
    expect(restoreGoalFromPersist(saved)).toEqual(live);
    expect(serializeGoalForPersist(null)).toBeNull();
    expect(restoreGoalFromPersist(null)).toBeNull();
    expect(restoreGoalFromPersist({ objective: 5 })).toBeNull();
    expect(restoreGoalFromPersist({ objective: "x", active: "yes" })).toBeNull();
  });
});
