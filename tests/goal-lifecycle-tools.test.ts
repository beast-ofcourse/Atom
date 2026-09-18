// Phase 1 pins (goal-tools-refactor): lifecycle validators, pure
// transitions, notices, and advisory budget persist. Pure level, no TUI.
import { describe, expect, test } from "vitest";
import {
  clearGoalState,
  createGoalState,
  goalCreateNotice,
  goalGetText,
  pauseGoalState,
  restoreGoalFromPersist,
  resumeGoalState,
  serializeGoalForPersist,
  validateClearGoalArgs,
  validateCreateGoalArgs,
  validateGetGoalArgs,
  validatePauseGoalArgs,
  validateResumeGoalArgs,
} from "../src/goal.js";

describe("lifecycle validators", () => {
  test("create needs a non-empty objective; budget optional positive int", () => {
    expect(validateCreateGoalArgs({ objective: "Ship v2" })).toBeNull();
    expect(
      validateCreateGoalArgs({ objective: "Ship v2", token_budget: 40000 })
    ).toBeNull();
    expect(validateCreateGoalArgs({})).not.toBeNull();
    expect(validateCreateGoalArgs({ objective: "  " })).not.toBeNull();
    expect(validateCreateGoalArgs({ objective: 5 })).not.toBeNull();
    expect(
      validateCreateGoalArgs({ objective: "x", token_budget: 0 })
    ).not.toBeNull();
    expect(
      validateCreateGoalArgs({ objective: "x", token_budget: -3 })
    ).not.toBeNull();
    expect(
      validateCreateGoalArgs({ objective: "x", token_budget: 1.5 })
    ).not.toBeNull();
    expect(
      validateCreateGoalArgs({ objective: "x", token_budget: "lots" })
    ).not.toBeNull();
    expect(validateCreateGoalArgs([] as unknown as Record<string, unknown>)).not.toBeNull();
  });

  test("get/resume take no args (unknown fields ignored); pause/clear take optional reason", () => {
    expect(validateGetGoalArgs({})).toBeNull();
    expect(validateGetGoalArgs({ extra: 1 })).toBeNull();
    expect(validateResumeGoalArgs({})).toBeNull();
    expect(validatePauseGoalArgs({})).toBeNull();
    expect(validatePauseGoalArgs({ reason: "blocked on creds" })).toBeNull();
    expect(validatePauseGoalArgs({ reason: "  " })).not.toBeNull();
    expect(validateClearGoalArgs({})).toBeNull();
    expect(validateClearGoalArgs({ reason: "done elsewhere" })).toBeNull();
    expect(validateClearGoalArgs({ reason: "" })).not.toBeNull();
  });
});

describe("pure transitions", () => {
  test("create builds an active goal with fresh stats; pause/resume flip; clear nulls", () => {
    const created = createGoalState("Ship v2", 40000);
    expect(created).toMatchObject({ objective: "Ship v2", active: true, tokenBudget: 40000 });
    expect(created.stats).toEqual({ turns: 0, requests: 0, tokens: 0, workMs: 0 });
    const noBudget = createGoalState("Ship v2");
    expect(noBudget.tokenBudget).toBeUndefined();
    const paused = pauseGoalState(created);
    expect(paused).toMatchObject({ objective: "Ship v2", active: false, tokenBudget: 40000 });
    expect(pauseGoalState(paused)).toBe(paused);
    expect(pauseGoalState(null)).toBeNull();
    const resumed = resumeGoalState(paused);
    expect(resumed).toMatchObject({ active: true });
    expect(resumeGoalState(resumed)).toBe(resumed);
    expect(resumeGoalState(null)).toBeNull();
    expect(clearGoalState()).toBeNull();
  });
});

describe("lifecycle notices + read text", () => {
  test("create notice echoes objective, replace, and advisory budget", () => {
    expect(goalCreateNotice("B", null)).toContain("B");
    expect(goalCreateNotice("B", { objective: "A", active: true })).toContain("replaced");
    expect(goalCreateNotice("B", null, 40000)).toContain("40.0K");
    expect(goalGetText(null)).toContain("no goal");
    expect(goalGetText({ objective: "A", active: true })).toContain("active");
    expect(goalGetText({ objective: "A", active: false })).toContain("paused");
    expect(goalGetText({ objective: "A", active: true, tokenBudget: 40000 })).toContain("budget");
  });
});

describe("advisory budget persist", () => {
  test("budget round-trips; absent in old saves; trashed budget drops, goal survives", () => {
    const saved = serializeGoalForPersist(createGoalState("Ship v2", 40000));
    expect(saved).toMatchObject({ tokenBudget: 40000 });
    expect(restoreGoalFromPersist(saved)).toMatchObject({ tokenBudget: 40000 });
    const noBudget = serializeGoalForPersist(createGoalState("Ship v2"));
    expect(noBudget).not.toHaveProperty("tokenBudget");
    expect(restoreGoalFromPersist({ objective: "A", active: true })).toMatchObject({
      objective: "A",
      active: true,
    });
    expect(
      restoreGoalFromPersist({ objective: "A", active: true, stats: {}, tokenBudget: -5 })
    ).toMatchObject({ objective: "A" });
    expect(
      restoreGoalFromPersist({ objective: "A", active: true, stats: {}, tokenBudget: -5 })
    ).not.toHaveProperty("tokenBudget");
  });
});
