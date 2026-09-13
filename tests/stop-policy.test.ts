// Unified stop policy: every turn-end stop decides through decideTurnEnd
// directly — no full loop run, no ambient todo list. The loop's own suites
// (loop-todo-guard, loop-verification-gate, goal-continue/disposition,
// verification-continue) pin the end-to-end behavior unchanged; this file
// pins each stop's decision in isolation through its own interface.
import { describe, expect, test } from "vitest";
import { decideTurnEnd, type StopContext } from "../src/agent/gates.js";
import { ErrorStreakTracker } from "../src/agent/loop-guard.js";
import { emptyGoalProgress, type GoalProgressState } from "../src/goal.js";

function streak(n: number): ErrorStreakTracker {
  const t = new ErrorStreakTracker(3);
  for (let i = 0; i < n; i++) t.noteResult(true);
  return t;
}

function stalled(): GoalProgressState {
  return { seen: new Set<string>(), novel: 0, stale: 3 };
}

function baseCtx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    step: 0,
    maxSteps: 30,
    filesWritten: false,
    verifiedAfterWrite: false,
    openTodos: [],
    errorStreak: new ErrorStreakTracker(3),
    disposition: null,
    goal: null,
    toolCalls: 0,
    maxTotalToolCalls: Number.POSITIVE_INFINITY,
    goalEngaged: false,
    goalProgress: emptyGoalProgress(),
    judge: null,
    ...overrides,
  };
}

const LIVE_GOAL = { objective: "Ship it" };

describe("decideTurnEnd", () => {
  test("plain end commits final text with no accounting", () => {
    const d = decideTurnEnd("done", baseCtx());
    expect(d).toEqual({ kind: "end", via: "end", finalText: "done", noteGoalTurn: false });
  });

  test("plain end of an engaged run still counts its goal turn", () => {
    const d = decideTurnEnd("done", baseCtx({ goalEngaged: true }));
    expect(d.kind).toBe("end");
    if (d.kind === "end") expect(d.noteGoalTurn).toBe(true);
  });

  test("open todos continue with the guard voice", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({ openTodos: [{ content: "Finish it", status: "in_progress" }] })
    );
    expect(d.kind).toBe("continue");
    if (d.kind === "continue") {
      expect(d.via).toBe("todoCompletionGate");
      expect(d.followUp).toContain("todo guard");
      expect(d.followUp).toContain("Finish it");
      expect(d.noteGoalTurn).toBe(false);
    }
  });

  test("spent budget with open todos ends blocked", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({
        step: 30,
        openTodos: [{ content: "Finish it", status: "in_progress" }],
      })
    );
    expect(d.kind).toBe("end");
    if (d.kind === "end") expect(d.finalText).toContain("(blocked:");
  });

  test("unverified code continues with the verification voice", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({ filesWritten: true, needsVerification: true, unverifiedPaths: ["src/a.ts"] })
    );
    expect(d.kind).toBe("continue");
    if (d.kind === "continue") {
      expect(d.via).toBe("verification");
      expect(d.followUp).toContain("verification required");
      expect(d.followUp).toContain("src/a.ts");
    }
  });

  test("a `complete` after an exhausted todo guard continues through the honesty probe", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({
        goal: LIVE_GOAL,
        disposition: { status: "complete", reason: "all green" },
        openTodos: [{ content: "Finish it", status: "in_progress" }],
        todoRounds: 3,
      })
    );
    expect(d.kind).toBe("continue");
    if (d.kind === "continue") {
      expect(d.via).toBe("honesty");
      expect(d.followUp).toContain("todo guard");
      expect(d.noteGoalTurn).toBe(false);
    }
  });

  test("a `complete` after an exhausted verification gate continues with the verification voice", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({
        goal: LIVE_GOAL,
        disposition: { status: "complete", reason: "all green" },
        filesWritten: true,
        needsVerification: true,
        unverifiedPaths: ["src/a.ts"],
        verifyRounds: 3,
      })
    );
    expect(d.kind).toBe("continue");
    if (d.kind === "continue") {
      expect(d.via).toBe("honesty");
      expect(d.followUp).toContain("verification required");
    }
  });

  test("a clean `complete` ends with a verdict and a pause notice", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({ goal: LIVE_GOAL, disposition: { status: "complete", reason: "all green" } })
    );
    expect(d.kind).toBe("end");
    if (d.kind === "end") {
      expect(d.via).toBe("goalVerdict");
      expect(d.finalText).toContain('(goal complete — "Ship it": all green)');
      expect(d.pauseNotice).toContain('(goal complete — "Ship it": all green)');
      expect(d.noteGoalTurn).toBe(true);
    }
  });

  test("an honest-blocked `complete` on a spent budget ends paused, never spinning", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({
        step: 30,
        goal: LIVE_GOAL,
        disposition: { status: "complete", reason: "all green" },
        openTodos: [{ content: "Finish it", status: "in_progress" }],
      })
    );
    expect(d.kind).toBe("end");
    if (d.kind === "end") {
      expect(d.via).toBe("honestyBudget");
      expect(d.pauseNotice).toContain("(budget spent)");
      expect(d.noteGoalTurn).toBe(true);
    }
  });

  test("a `blocked` report stops unconditionally, skipping honesty", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({
        goal: LIVE_GOAL,
        disposition: { status: "blocked", reason: "no API key" },
      })
    );
    expect(d.kind).toBe("end");
    if (d.kind === "end") {
      expect(d.via).toBe("goalVerdict");
      expect(d.finalText).toContain('(goal blocked — "Ship it": no API key)');
      expect(d.pauseNotice).toContain('(goal blocked — "Ship it": no API key)');
    }
  });

  test("terminal reports need a live goal — otherwise the turn ends plainly", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({ goal: null, disposition: { status: "complete", reason: "all green" } })
    );
    expect(d).toEqual({ kind: "end", via: "end", finalText: "done", noteGoalTurn: false });
  });

  test("an error streak holds final text for a fix-forward attempt", () => {
    const d = decideTurnEnd("done", baseCtx({ errorStreak: streak(3) }));
    expect(d.kind).toBe("continue");
    if (d.kind === "continue") {
      expect(d.via).toBe("errorStreak");
      expect(d.assistantText).toBe("done");
      expect(d.followUp).toContain("recovery");
      expect(d.noteGoalTurn).toBe(false);
    }
  });

  test("a single error still ends normally", () => {
    const d = decideTurnEnd("done", baseCtx({ errorStreak: streak(1) }));
    expect(d).toEqual({ kind: "end", via: "end", finalText: "done", noteGoalTurn: false });
  });

  test("a live goal continues the turn with accounting", () => {
    const d = decideTurnEnd("done", baseCtx({ goal: LIVE_GOAL }));
    expect(d.kind).toBe("continue");
    if (d.kind === "continue") {
      expect(d.via).toBe("goalContinue");
      expect(d.followUp).toContain("(goal continues:");
      expect(d.noteGoalTurn).toBe(true);
    }
  });

  test("a `continue` report's next action becomes the follow-up", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({ goal: LIVE_GOAL, disposition: { status: "continue", next: "run the tests" } })
    );
    expect(d.kind).toBe("continue");
    if (d.kind === "continue") expect(d.followUp).toBe("run the tests");
  });

  test("a stalled run gets the replan nudge and the epoch resets", () => {
    const progress = stalled();
    const d = decideTurnEnd("done", baseCtx({ goal: LIVE_GOAL, goalProgress: progress }));
    expect(d.kind).toBe("continue");
    if (d.kind === "continue") {
      expect(d.via).toBe("goalContinue");
      expect(d.followUp).toContain("goal stalled");
    }
    expect(progress.stale).toBe(0);
  });

  test("a live goal on a spent budget ends paused", () => {
    const d = decideTurnEnd("done", baseCtx({ step: 30, goal: LIVE_GOAL }));
    expect(d.kind).toBe("end");
    if (d.kind === "end") {
      expect(d.via).toBe("goalBudget");
      expect(d.pauseNotice).toContain("(budget spent)");
      expect(d.noteGoalTurn).toBe(true);
    }
  });

  test("a dropped judge ends normally with no pause", () => {
    const d = decideTurnEnd(
      "done",
      baseCtx({ judge: { kind: "dropped" }, goalEngaged: true })
    );
    expect(d.kind).toBe("end");
    if (d.kind === "end") {
      expect(d.via).toBe("judgeDropped");
      expect(d.finalText).toBe("done");
      expect(d.pauseNotice).toBeUndefined();
      expect(d.noteGoalTurn).toBe(true);
    }
  });

  test("a failed judge pauses with the truncated error", () => {
    const d = decideTurnEnd("done", baseCtx({ goal: LIVE_GOAL, judge: { kind: "failed", message: "boom" } }));
    expect(d.kind).toBe("end");
    if (d.kind === "end") {
      expect(d.via).toBe("judgePause");
      expect(d.pauseNotice).toContain("(judge failed: boom)");
      expect(d.noteGoalTurn).toBe(true);
    }
  });

  test("an unclear judge pauses instead of looping", () => {
    const d = decideTurnEnd("done", baseCtx({ goal: LIVE_GOAL, judge: { kind: "unclear" } }));
    expect(d.kind).toBe("end");
    if (d.kind === "end") {
      expect(d.via).toBe("judgePause");
      expect(d.pauseNotice).toContain("judge unclear");
    }
  });
});
