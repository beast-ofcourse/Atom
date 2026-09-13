// Turn-continuation seam (ticket 03): the todo guard and verification gate
// run as entries in one chain (TURN_END_GATES) evaluated before final-text
// commit. Structure-only pin: behavior is covered unmodified by
// loop-todo-guard.test.ts and loop-verification-gate.test.ts — this file
// pins the seam itself (gate order, first-non-pass-wins precedence, and the
// documented attachment point for future gates).
import { describe, expect, test } from "vitest";
import {
  evaluateTurnEnd,
  todoCompletionGate,
  TURN_END_GATES,
  verificationGate,
  type TurnEndGate,
} from "../src/zen.js";

describe("turn-continuation seam", () => {
  test("chain holds the todo guard before the verification gate", () => {
    expect(TURN_END_GATES).toEqual([todoCompletionGate, verificationGate]);
  });

  test("first non-pass gate wins: open todos beat an unverified write", async () => {
    const outcome = evaluateTurnEnd("done", {
      step: 0,
      maxSteps: 30,
      filesWritten: true,
      verifiedAfterWrite: false,
      openTodos: [{ content: "Finish it", status: "in_progress" }],
    });
    expect(outcome.kind).toBe("continue");
    if (outcome.kind === "continue") {
      expect(outcome.followUp).toContain("todo guard");
      expect(outcome.followUp).toContain("Finish it");
    }
  });

  test("spent budget + open todos ends blocked, never unverified", async () => {
    const outcome = evaluateTurnEnd("done", {
      step: 0,
      maxSteps: 0,
      filesWritten: true,
      verifiedAfterWrite: false,
      openTodos: [{ content: "Finish it", status: "in_progress" }],
    });
    expect(outcome.kind).toBe("end");
    if (outcome.kind === "end") {
      expect(outcome.finalText).toContain("(blocked:");
      expect(outcome.finalText).not.toContain("(unverified:");
    }
  });

  test("future gates attach at the end of the chain and see a clean pass-through", () => {
    const custom: TurnEndGate = (finalText) =>
      finalText === "custom-trigger"
        ? { action: "end", finalText: "custom-gate result" }
        : { action: "pass" };
    const attached = [...TURN_END_GATES, custom];
    const hit = evaluateTurnEnd(
      "custom-trigger",
      { step: 0, maxSteps: 30, filesWritten: false, verifiedAfterWrite: false, openTodos: [] },
      attached
    );
    expect(hit).toEqual({ kind: "end", finalText: "custom-gate result" });
    const miss = evaluateTurnEnd(
      "plain answer",
      { step: 0, maxSteps: 30, filesWritten: false, verifiedAfterWrite: false, openTodos: [] },
      attached
    );
    expect(miss).toEqual({ kind: "end", finalText: "plain answer" });
  });
});
