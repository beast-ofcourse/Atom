// Ticket 06 goal tests: honest completion gate. Pure helper tests (no TUI)
// plus loop-level tests (mocked chatFn) — no network. Covers: `complete`
// with unverified code continues and names the files, `complete` with open
// todos continues, declared-unrunnable checks are recorded openly without
// blocking a clean completion, a clean `complete` ends with the reason, and
// `blocked` still stops unconditionally (even when dirty).
import { afterEach, describe, expect, test } from "vitest";
import { clearTodos, todowriteTool, UPDATE_GOAL_TOOL_DEFINITION } from "../src/tools.js";
import {
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
} from "../src/zen.js";
import type { ToolCall } from "../src/agent/types.js";
import { MAX_TODO_ROUNDS, MAX_VERIFY_ROUNDS } from "../src/agent/gates.js";
import {
  GOAL_UNVERIFIED_MAX_ITEMS,
  GOAL_UNVERIFIED_MAX_LENGTH,
  goalVerdictNotice,
  sameGoalDisposition,
  updateGoalDisposition,
  validateUpdateGoalArgs,
} from "../src/goal.js";

afterEach(() => {
  clearTodos();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

// Live-goal double: mirrors the App wiring (getGoal reads live state,
// pauseGoal flips active with a notice and preserves everything else,
// counters accumulate incrementally).
function liveGoal(objective = "Ship v2") {
  const state = {
    active: true,
    cleared: false,
    pauses: [] as string[],
    turns: 0,
    requests: 0,
  };
  return {
    state,
    hook: {
      getGoal: () => (state.cleared ? null : { objective, active: state.active }),
      pauseGoal: (notice: string) => {
        state.pauses.push(notice);
        state.active = false;
      },
      onGoalRequest: () => {
        state.requests += 1;
      },
      onGoalTurn: () => {
        state.turns += 1;
      },
    },
  };
}

let callSeq = 0;
function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  callSeq += 1;
  return { id: `c${callSeq}`, function: { name, arguments: JSON.stringify(args) } };
}

function userTexts(history: ChatMessage[]): string[] {
  return history
    .filter((m) => m.role === "user")
    .map((m) => (m as { content: string }).content);
}

describe("unverified channel (pure helpers)", () => {
  test("validate: complete takes an optional bounded unverified list", () => {
    expect(validateUpdateGoalArgs({ status: "complete", reason: "Done" })).toBeNull();
    expect(
      validateUpdateGoalArgs({ status: "complete", reason: "Done", unverified: ["e2e suite (no browser here)"] })
    ).toBeNull();
    expect(validateUpdateGoalArgs({ status: "complete", reason: "Done", unverified: [] })).toBeNull();
  });

  test("validate: non-array, empty items, over-count, and over-length are model mistakes", () => {
    expect(
      validateUpdateGoalArgs({ status: "complete", reason: "Done", unverified: "nope" })
    ).toContain('"unverified"');
    expect(
      validateUpdateGoalArgs({ status: "complete", reason: "Done", unverified: ["ok", "  "] })
    ).toContain('"unverified"');
    expect(
      validateUpdateGoalArgs({ status: "complete", reason: "Done", unverified: [42] })
    ).toContain('"unverified"');
    const tooMany = Array.from({ length: GOAL_UNVERIFIED_MAX_ITEMS + 1 }, (_, i) => `check ${i}`);
    expect(
      validateUpdateGoalArgs({ status: "complete", reason: "Done", unverified: tooMany })
    ).toContain('"unverified"');
    expect(
      validateUpdateGoalArgs({
        status: "complete",
        reason: "Done",
        unverified: ["x".repeat(GOAL_UNVERIFIED_MAX_LENGTH + 1)],
      })
    ).toContain('"unverified"');
  });

  test("unverified is complete-only: other statuses ignore it like any unknown field", () => {
    expect(validateUpdateGoalArgs({ status: "continue", unverified: ["x"] })).toBeNull();
    expect(validateUpdateGoalArgs({ status: "blocked", reason: "Stuck", unverified: ["x"] })).toBeNull();
    expect(updateGoalDisposition({ status: "blocked", reason: "Stuck" })).toEqual({
      status: "blocked",
      reason: "Stuck",
    });
  });

  test("updateGoalDisposition carries the trimmed list; sameGoalDisposition compares it", () => {
    expect(
      updateGoalDisposition({ status: "complete", reason: "Done", unverified: ["  a  ", "b"] })
    ).toEqual({ status: "complete", reason: "Done", unverified: ["a", "b"] });
    expect(updateGoalDisposition({ status: "complete", reason: "Done" })).toEqual({
      status: "complete",
      reason: "Done",
    });
    expect(
      sameGoalDisposition(
        { status: "complete", reason: "A", unverified: ["x"] },
        { status: "complete", reason: "A", unverified: ["x"] }
      )
    ).toBe(true);
    expect(
      sameGoalDisposition(
        { status: "complete", reason: "A", unverified: ["x"] },
        { status: "complete", reason: "A" }
      )
    ).toBe(false);
    expect(
      sameGoalDisposition(
        { status: "complete", reason: "A", unverified: ["x"] },
        { status: "complete", reason: "A", unverified: ["y"] }
      )
    ).toBe(false);
  });

  test("verdict prints the declared list openly; absent/empty reads as before", () => {
    expect(goalVerdictNotice("Ship v2", "complete", "Done")).toBe(`(goal complete — "Ship v2": Done)`);
    expect(goalVerdictNotice("Ship v2", "complete", "Done", [])).toBe(
      `(goal complete — "Ship v2": Done)`
    );
    const verdict = goalVerdictNotice("Ship v2", "complete", "Done", [
      "e2e suite (no browser here)",
      "perf bench",
    ]);
    expect(verdict).toContain("Done");
    expect(verdict).toContain("(unverified: e2e suite (no browser here), perf bench)");
    // Blocked never carries the segment.
    expect(goalVerdictNotice("Ship v2", "blocked", "Stuck", ["x"])).toBe(
      `(goal blocked — "Ship v2": Stuck)`
    );
  });

  test("tool definition exposes the unverified channel", () => {
    const props = UPDATE_GOAL_TOOL_DEFINITION.function.parameters["properties"] as Record<
      string,
      unknown
    >;
    expect(typeof props["unverified"]).toBe("object");
    expect(UPDATE_GOAL_TOOL_DEFINITION.function.parameters["required"]).toEqual(["status"]);
    expect(UPDATE_GOAL_TOOL_DEFINITION.function.description).toContain("unverified");
  });
});

describe("honest completion gate (loop level)", () => {
  test("complete with unverified code continues and names the files; goal stays live", async () => {
    const g = liveGoal("Ship v2");
    // Terminate by clearing on the final request (as /goal clear would
    // mid-run); the run must never pause with a complete verdict before that.
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 7) g.state.cleared = true;
    };
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [
              toolCall("write", { path: "src/foo.ts", content: "export const x = 1;" }),
              toolCall("update_goal", { status: "complete", reason: "Done" }),
            ],
          };
        }
        if (posts <= 6) return { content: "all done" };
        return { content: "finished" };
      },
      history,
      { execute: async () => "ok", goal: g.hook }
    );
    expect(reply.startsWith("finished")).toBe(true);
    // The spent pinned gate appends its exhaustion label to the final turn
    // (pre-existing gate behavior) — the point is no `complete` verdict.
    expect(reply).toContain("(unverified: src/foo.ts changed without a passing verification run");
    // 3 pinned verification nags, then the honesty gate's own continue once
    // the pinned rounds are spent (4 total proves the gate fired — the pinned
    // gate alone caps at MAX_VERIFY_ROUNDS).
    const verificationFollowUps = userTexts(history).filter((t) =>
      t.includes("verification required")
    );
    expect(MAX_VERIFY_ROUNDS).toBe(3);
    expect(verificationFollowUps).toHaveLength(MAX_VERIFY_ROUNDS + 1);
    for (const followUp of verificationFollowUps) expect(followUp).toContain("src/foo.ts");
    expect(posts).toBe(7);
    // The false `complete` never landed: no verdict, goal cleared (not paused).
    expect(g.state.pauses).toEqual([]);
    expect(g.state.active).toBe(true);
  });

  test("complete with open todos continues instead of ending", async () => {
    await todowriteTool({ todos: [{ content: "Ship it", status: "pending" }] });
    const g = liveGoal("Ship v2");
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 7) g.state.cleared = true;
    };
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [toolCall("update_goal", { status: "complete", reason: "Done" })],
          };
        }
        if (posts <= 6) return { content: "all done" };
        return { content: "finished" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply.startsWith("finished")).toBe(true);
    // The spent pinned gate appends its exhaustion label to the final turn
    // (pre-existing gate behavior) — the point is no `complete` verdict.
    expect(reply).toContain("(blocked: 1 open todo(s) remain after 3 guard rounds");
    // 3 pinned todo nags, then the honesty gate's own continue (4 total).
    const todoFollowUps = userTexts(history).filter((t) => t.includes("todo guard"));
    expect(MAX_TODO_ROUNDS).toBe(3);
    expect(todoFollowUps).toHaveLength(MAX_TODO_ROUNDS + 1);
    for (const followUp of todoFollowUps) expect(followUp).toContain("Ship it");
    expect(posts).toBe(7);
    expect(g.state.pauses).toEqual([]);
    expect(g.state.active).toBe(true);
  });

  test("declared-unrunnable checks are recorded openly and do not block a clean completion", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [
              toolCall("update_goal", {
                status: "complete",
                reason: "Done",
                unverified: ["e2e browser suite (no launcher in this env)"],
              }),
            ],
          };
        }
        return { content: "all done" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    const verdict = `(goal complete — "Ship v2": Done) (unverified: e2e browser suite (no launcher in this env))`;
    expect(reply).toBe(`all done\n${verdict}`);
    expect(posts).toBe(2);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toEqual([verdict]);
    expect(g.state.turns).toBe(1);
  });

  test("a clean complete ends the goal with a closing summary carrying the reason", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [toolCall("update_goal", { status: "complete", reason: "Shipped it" })],
          };
        }
        return { content: "all done" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply).toBe(`all done\n(goal complete — "Ship v2": Shipped it)`);
    expect(posts).toBe(2);
    expect(g.state.active).toBe(false);
    expect(g.state.turns).toBe(1);
  });

  test("blocked still stops unconditionally, even with unverified code pending", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "trying",
            tool_calls: [
              toolCall("write", { path: "src/foo.ts", content: "export const x = 1;" }),
              toolCall("update_goal", { status: "blocked", reason: "No API key" }),
            ],
          };
        }
        return { content: "wrapping up" };
      },
      history,
      { execute: async () => "ok", goal: g.hook }
    );
    // 3 pinned nags first (the report survives guard `continue`s), then the
    // blocked verdict stops — never converted into another verification round.
    // The spent pinned gate's exhaustion label stays on the final text
    // (pre-existing gate behavior); the verdict is appended after it.
    expect(posts).toBe(MAX_VERIFY_ROUNDS + 2);
    expect(reply).toContain(`(goal blocked — "Ship v2": No API key)`);
    expect(reply.startsWith("wrapping up")).toBe(true);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toEqual([`(goal blocked — "Ship v2": No API key)`]);
    expect(g.state.turns).toBe(1);
  });

  test("an evaluator complete verdict goes through the same honesty gate", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    let judges = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [toolCall("write", { path: "src/foo.ts", content: "export const x = 1;" })],
          };
        }
        return { content: "all done" };
      },
      history,
      {
        execute: async () => "ok",
        goal: g.hook,
        goalJudge: async () => {
          judges += 1;
          // First the judge wrongly calls it done (the gate must continue),
          // then it reports stuck (which stops).
          if (judges === 1) return { status: "complete", reason: "Judge says done" };
          return { status: "blocked", reason: "Judge stuck" };
        },
      }
    );
    // The judge's false `complete` never lands; its `blocked` does.
    expect(judges).toBe(2);
    const verificationFollowUps = userTexts(history).filter((t) =>
      t.includes("verification required")
    );
    expect(verificationFollowUps).toHaveLength(MAX_VERIFY_ROUNDS + 1);
    for (const followUp of verificationFollowUps) expect(followUp).toContain("src/foo.ts");
    expect(reply).toContain(`(goal blocked — "Ship v2": Judge stuck)`);
    expect(reply).not.toContain("Judge says done");
    expect(g.state.active).toBe(false);
  });
});
