// Ticket 03 goal tests: disposition protocol (update_goal). Pure helper
// tests (no TUI) plus loop-level tests (mocked chatFn) — no network.
// Covers: inside/outside-turn reporting, terminal verdicts, continue
// next-action follow-ups, idempotence, post-terminal rejection, and the
// no-report-continue preservation (pinned by goal-continue.test.ts).
import { afterEach, describe, expect, test } from "vitest";
import { clearTodos, UPDATE_GOAL_TOOL_DEFINITION } from "../src/tools.js";
import {
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
} from "../src/zen.js";
import type { ToolCall } from "../src/agent/types.js";
import {
  goalFollowUp,
  goalReportAck,
  goalReportOutsideError,
  goalReportRejectedNotice,
  goalVerdictNotice,
  sameGoalDisposition,
  updateGoalDisposition,
  validateUpdateGoalArgs,
  type GoalDisposition,
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
function updateGoalCall(args: Record<string, unknown>): ToolCall {
  callSeq += 1;
  return { id: `u${callSeq}`, function: { name: "update_goal", arguments: JSON.stringify(args) } };
}

function globCall(id: string): ToolCall {
  return { id, function: { name: "glob", arguments: '{"pattern":"*.ts"}' } };
}

function toolContents(history: ChatMessage[]): string[] {
  return history
    .filter((m) => m.role === "tool")
    .map((m) => (m as { content: string }).content);
}

describe("update_goal pure helpers (ticket 03)", () => {
  test("validate: continue takes an optional next; complete/blocked require a reason", () => {
    expect(validateUpdateGoalArgs({ status: "continue" })).toBeNull();
    expect(validateUpdateGoalArgs({ status: "continue", next: "Probe X" })).toBeNull();
    expect(validateUpdateGoalArgs({ status: "complete", reason: "Done" })).toBeNull();
    expect(validateUpdateGoalArgs({ status: "blocked", reason: "Stuck" })).toBeNull();
    // Unknown fields are ignored (registry leniency).
    expect(validateUpdateGoalArgs({ status: "complete", reason: "Done", next: "X" })).toBeNull();
  });

  test("validate: missing/invalid status, empty reason, empty next are model mistakes", () => {
    expect(validateUpdateGoalArgs({})).toContain('"status"');
    expect(validateUpdateGoalArgs({ status: "pause" })).toContain('"status"');
    expect(validateUpdateGoalArgs({ status: "complete" })).toContain('"reason"');
    expect(validateUpdateGoalArgs({ status: "blocked", reason: "   " })).toContain('"reason"');
    expect(validateUpdateGoalArgs({ status: "continue", next: "" })).toContain('"next"');
    expect(validateUpdateGoalArgs({ status: "continue", next: 42 })).toContain('"next"');
    expect(validateUpdateGoalArgs([] as unknown as Record<string, unknown>)).toContain("must be an object");
  });

  test("updateGoalDisposition builds the typed value from validated args", () => {
    expect(updateGoalDisposition({ status: "continue" })).toEqual({ status: "continue" });
    expect(updateGoalDisposition({ status: "continue", next: "Probe X" })).toEqual({
      status: "continue",
      next: "Probe X",
    });
    expect(updateGoalDisposition({ status: "complete", reason: "Done" })).toEqual({
      status: "complete",
      reason: "Done",
    });
    expect(updateGoalDisposition({ status: "blocked", reason: "Stuck" })).toEqual({
      status: "blocked",
      reason: "Stuck",
    });
  });

  test("sameGoalDisposition compares status plus payload", () => {
    const cont: GoalDisposition = { status: "continue", next: "Probe X" };
    expect(sameGoalDisposition(cont, { status: "continue", next: "Probe X" })).toBe(true);
    expect(sameGoalDisposition(cont, { status: "continue" })).toBe(false);
    expect(sameGoalDisposition(cont, { status: "complete", reason: "Probe X" })).toBe(false);
    expect(
      sameGoalDisposition({ status: "complete", reason: "A" }, { status: "complete", reason: "A" })
    ).toBe(true);
    expect(
      sameGoalDisposition({ status: "complete", reason: "A" }, { status: "complete", reason: "B" })
    ).toBe(false);
    expect(
      sameGoalDisposition({ status: "complete", reason: "A" }, { status: "blocked", reason: "A" })
    ).toBe(false);
  });

  test("notices carry the reason in the existing (paren) voice; outside is a structured error", () => {
    const verdict = goalVerdictNotice("Ship v2", "complete", "Shipped");
    expect(verdict).toContain("complete");
    expect(verdict).toContain("Ship v2");
    expect(verdict).toContain("Shipped");
    expect(goalReportAck({ status: "continue", next: "Probe X" })).toContain("Probe X");
    expect(goalReportAck({ status: "continue" })).toContain("continue");
    const rejected = goalReportRejectedNotice({ status: "complete", reason: "Shipped" });
    expect(rejected).toContain("already reported");
    expect(rejected).toContain("complete");
    expect(rejected.startsWith("Error:")).toBe(false);
    const outside = goalReportOutsideError();
    expect(outside.startsWith("Error:")).toBe(true);
    expect(outside).toContain("update_goal");
  });

  test("tool definition contract: update_goal with a required status enum", () => {
    expect(UPDATE_GOAL_TOOL_DEFINITION.function.name).toBe("update_goal");
    expect(UPDATE_GOAL_TOOL_DEFINITION.function.parameters["required"]).toEqual(["status"]);
    const props = UPDATE_GOAL_TOOL_DEFINITION.function.parameters["properties"] as Record<
      string,
      { enum?: string[] }
    >;
    expect(props["status"]?.enum).toEqual(["continue", "complete", "blocked"]);
    expect(typeof props["next"]).toBe("object");
    expect(typeof props["reason"]).toBe("object");
  });
});

describe("disposition protocol (loop level)", () => {
  test("complete stops the loop and prints the reason as a verdict", async () => {
    const g = liveGoal("Ship v2");
    const seen: string[] = [];
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [updateGoalCall({ status: "complete", reason: "Shipped" })],
          };
        }
        return { content: "all done" };
      },
      history,
      {
        execute: async (name) => {
          seen.push(name);
          return "tool-result";
        },
        goal: g.hook,
      }
    );
    const verdict = `(goal complete — "Ship v2": Shipped)`;
    expect(reply).toBe(`all done\n${verdict}`);
    expect(posts).toBe(2);
    // Resolved without an executor — execute never sees the name.
    expect(seen).toEqual([]);
    // Pause-with-preservation, never clear: the verdict IS the pause notice.
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toEqual([verdict]);
    expect(g.state.turns).toBe(1);
    expect(g.state.requests).toBe(2);
    // The ack committed as the tool result; the verdict as the final text.
    expect(toolContents(history)).toEqual([goalReportAck({ status: "complete", reason: "Shipped" })]);
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: reply });
  });

  test("blocked stops the loop with a blocked verdict", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "trying",
            tool_calls: [updateGoalCall({ status: "blocked", reason: "No API key" })],
          };
        }
        return { content: "wrapping up" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply).toBe(`wrapping up\n(goal blocked — "Ship v2": No API key)`);
    expect(posts).toBe(2);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toHaveLength(1);
    expect(g.state.pauses[0]).toContain("No API key");
    expect(g.state.turns).toBe(1);
  });

  test("continue carries its next action into the following turn", async () => {
    const g = liveGoal("Ship v2");
    // The third request clears the goal (as /goal clear would mid-run), so
    // the script terminates after the continued turn ends normally.
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 3) g.state.cleared = true;
    };
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [updateGoalCall({ status: "continue", next: "Probe the auth module" })],
          };
        }
        return { content: posts === 2 ? "checkpoint" : "finished" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply).toBe("finished");
    expect(posts).toBe(3);
    // The next action — not the generic follow-up — starts the continued turn.
    expect(history.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history[5]).toEqual({ role: "user", content: "Probe the auth module" });
    expect(g.state.turns).toBe(2);
    expect(g.state.pauses).toEqual([]);
  });

  test("continue without a next action falls back to the generic follow-up", async () => {
    const g = liveGoal("Ship v2");
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 3) g.state.cleared = true;
    };
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return { content: "working", tool_calls: [updateGoalCall({ status: "continue" })] };
        }
        return { content: posts === 2 ? "checkpoint" : "finished" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply).toBe("finished");
    expect(posts).toBe(3);
    expect(history[5]).toEqual({ role: "user", content: goalFollowUp("Ship v2") });
  });

  test("duplicate same-value reports are idempotent (single effect)", async () => {
    const g = liveGoal("Ship v2");
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 3) g.state.cleared = true;
    };
    const history = baseHistory();
    let posts = 0;
    const next: GoalDisposition = { status: "continue", next: "Probe X" };
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return { content: "working", tool_calls: [updateGoalCall(next), updateGoalCall(next)] };
        }
        return { content: posts === 2 ? "checkpoint" : "finished" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply).toBe("finished");
    expect(posts).toBe(3);
    // Both calls ack the same recording; the continued turn runs once.
    expect(toolContents(history)).toEqual([goalReportAck(next), goalReportAck(next)]);
    expect(history[6]).toEqual({ role: "user", content: "Probe X" });
    expect(g.state.pauses).toEqual([]);
    expect(g.state.turns).toBe(2);
  });

  test("a report after a terminal disposition is rejected; the first report sticks", async () => {
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
              updateGoalCall({ status: "complete", reason: "Shipped" }),
              updateGoalCall({ status: "blocked", reason: "Stuck" }),
            ],
          };
        }
        return { content: "wrapping up" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    const results = toolContents(history);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(goalReportAck({ status: "complete", reason: "Shipped" }));
    expect(results[1]).toEqual(goalReportRejectedNotice({ status: "complete", reason: "Shipped" }));
    expect(reply).toBe(`wrapping up\n(goal complete — "Ship v2": Shipped)`);
    expect(reply).not.toContain("Stuck");
    expect(posts).toBe(2);
    expect(g.state.pauses).toEqual([`(goal complete — "Ship v2": Shipped)`]);
  });

  test("same value after a terminal disposition is still rejected (terminal sticks)", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [
              updateGoalCall({ status: "complete", reason: "Shipped" }),
              updateGoalCall({ status: "complete", reason: "Shipped" }),
            ],
          };
        }
        return { content: "wrapping up" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    const results = toolContents(history);
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual(goalReportRejectedNotice({ status: "complete", reason: "Shipped" }));
    expect(posts).toBe(2);
  });

  test("update_goal outside a goal turn is a structured error with zero state change", async () => {
    const g = liveGoal("Ship v2");
    g.state.active = false;
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [updateGoalCall({ status: "complete", reason: "Done" })],
          };
        }
        return { content: "plain end" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    // The turn ends normally — the error never pauses, clears, or counts.
    expect(reply).toBe("plain end");
    expect(posts).toBe(2);
    expect(toolContents(history)).toEqual([goalReportOutsideError()]);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toEqual([]);
    expect(g.state.turns).toBe(0);
  });

  test("update_goal with no goal hook at all errors cleanly and ends normally", async () => {
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [updateGoalCall({ status: "continue", next: "Probe X" })],
          };
        }
        return { content: "plain end" };
      },
      history,
      { execute: async () => "tool-result" }
    );
    expect(reply).toBe("plain end");
    expect(posts).toBe(2);
    const results = toolContents(history);
    expect(results).toHaveLength(1);
    expect(results[0]?.startsWith("Error:")).toBe(true);
    expect(results[0]).toContain("update_goal");
  });

  test("bad update_goal args are a model mistake: invalid-call error, nothing recorded", async () => {
    const g = liveGoal("Ship v2");
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 3) g.state.cleared = true;
    };
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "working",
            tool_calls: [updateGoalCall({ status: "complete" })],
          };
        }
        return { content: posts === 2 ? "checkpoint" : "finished" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    // Nothing was recorded, so the turn ends into the generic auto-continue.
    expect(reply).toBe("finished");
    expect(posts).toBe(3);
    const results = toolContents(history);
    expect(results).toHaveLength(1);
    expect(results[0]?.startsWith("Error: invalid call:")).toBe(true);
    expect(history[5]).toEqual({ role: "user", content: goalFollowUp("Ship v2") });
  });

  test("complete stops unconditionally, ahead of the error-streak hold", async () => {
    const failingExecute = async (name: string) => {
      if (name === "update_goal") throw new Error("must never reach the executor");
      return "Error: boom";
    };
    // Experiment: three failing tools plus a terminal report (report first
    // so the ack lands before the errors — the streak still ends at 3).
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
              updateGoalCall({ status: "complete", reason: "Done despite noise" }),
              globCall("c1"),
              globCall("c2"),
              globCall("c3"),
            ],
          };
        }
        return { content: "wrapping up" };
      },
      history,
      { execute: failingExecute, goal: g.hook }
    );
    expect(reply).toBe(`wrapping up\n(goal complete — "Ship v2": Done despite noise)`);
    // No fix-forward hold round: the verdict preempts it.
    expect(posts).toBe(2);
    expect(g.state.active).toBe(false);
  });

  test("control: the same three errors with no report DO trigger the hold", async () => {
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return { content: "trying", tool_calls: [globCall("c1"), globCall("c2"), globCall("c3")] };
        }
        return { content: "final answer" };
      },
      history,
      { execute: async () => "Error: boom" }
    );
    expect(reply).toBe("final answer");
    // Two bounded holds (POST2, POST3) before the turn ends at POST4.
    expect(posts).toBe(4);
  });
});
