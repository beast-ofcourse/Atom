// Phase 1 pins (goal-tools-refactor): lifecycle validators, pure
// transitions, notices, and advisory budget persist. Pure level, no TUI.
import { describe, expect, test } from "vitest";
import {
  clearGoalState,
  createGoalState,
  goalCreateIntentFromHistory,
  goalCreateNotice,
  goalGetText,
  hasGoalCreateIntent,
  pauseGoalState,
  resolveGoalTools,
  resolveGoalToolVisibility,
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

describe("visibility struct", () => {
  test("resolveGoalTools: undefined/true full, false none, struct copied", () => {
    expect(resolveGoalTools(undefined)).toEqual({
      update: true,
      get: true,
      create: true,
      pause: true,
      resume: true,
      clear: true,
    });
    expect(resolveGoalTools(true)).toEqual(resolveGoalTools(undefined));
    expect(resolveGoalTools(false)).toEqual({
      update: false,
      get: false,
      create: false,
      pause: false,
      resume: false,
      clear: false,
    });
    const struct = { update: true, get: true, create: false, pause: false, resume: false, clear: false };
    const out = resolveGoalTools(struct);
    expect(out).toEqual(struct);
    expect(out).not.toBe(struct);
  });

  test("resolveGoalToolVisibility: state-by-intent matrix", () => {
    // No goal, no intent: everything hidden.
    expect(resolveGoalToolVisibility(null, false)).toEqual(resolveGoalTools(false));
    // No goal + intent: create only.
    expect(resolveGoalToolVisibility(null, true)).toEqual({
      ...resolveGoalTools(false),
      create: true,
    });
    // Active, no intent: report + read + pause + clear.
    expect(
      resolveGoalToolVisibility({ objective: "Ship v2", active: true }, false)
    ).toEqual({ update: true, get: true, create: false, pause: true, resume: false, clear: true });
    // Active + intent: create joins.
    expect(
      resolveGoalToolVisibility({ objective: "Ship v2", active: true }, true)
    ).toMatchObject({ update: true, pause: true, resume: false, create: true });
    // Paused: read + resume + clear (update/pause absent — get stays readable).
    expect(
      resolveGoalToolVisibility({ objective: "Ship v2", active: false }, false)
    ).toEqual({ update: false, get: true, create: false, pause: false, resume: true, clear: true });
    // Malformed snapshot reads as no-goal.
    expect(
      resolveGoalToolVisibility({ objective: "", active: true }, false)
    ).toEqual(resolveGoalTools(false));
    expect(
      resolveGoalToolVisibility(undefined, true)
    ).toEqual({ ...resolveGoalTools(false), create: true });
  });
});

describe("create-intent detection", () => {
  test("only /goal lines carrying an objective count", () => {
    expect(hasGoalCreateIntent("/goal Ship the migration")).toBe(true);
    expect(hasGoalCreateIntent("  /goal Ship it  ")).toBe(true);
    expect(hasGoalCreateIntent("note\n/goal Fix flaky test\nmore")).toBe(true);
    expect(hasGoalCreateIntent("/goal")).toBe(false);
    expect(hasGoalCreateIntent("/goal pause")).toBe(false);
    expect(hasGoalCreateIntent("/goal resume")).toBe(false);
    expect(hasGoalCreateIntent("/goal clear")).toBe(false);
    expect(hasGoalCreateIntent("ship it")).toBe(false);
    expect(hasGoalCreateIntent("/goalsetting tips")).toBe(false);
    expect(hasGoalCreateIntent("")).toBe(false);
  });

  test("history scan reads user string content only", () => {
    expect(
      goalCreateIntentFromHistory([
        { role: "system", content: "/goal Ship it" },
        { role: "user", content: "hi" },
      ])
    ).toBe(false);
    expect(
      goalCreateIntentFromHistory([{ role: "user", content: "/goal Ship it" }])
    ).toBe(true);
    expect(goalCreateIntentFromHistory([])).toBe(false);
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
