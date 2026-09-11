// Ticket 02 goal tests: auto-continue turns, pause on cancel/budget,
// rollback-then-carry-on, cumulative stats. Loop-level (mocked chatFn)
// plus pure helper tests — no TUI, no network.
import { afterEach, describe, expect, test } from "vitest";
import { clearTodos } from "../src/tools.js";
import {
  LoopCancelledError,
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
} from "../src/zen.js";
import {
  emptyGoalStats,
  formatGoalTokens,
  formatGoalWorkMs,
  goalFollowUp,
  goalPausedNotice,
  goalPauseNotice,
  goalResumeNotice,
  goalStatsText,
  goalStatusText,
  goalTokensForUsage,
  parseGoalCommand,
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

describe("goal pure helpers (ticket 02)", () => {
  test("parse: pause/resume (any case); set still verbatim", () => {
    expect(parseGoalCommand("/goal pause")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("/goal PAUSE")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("/goal resume")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("/goal ReSuMe")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("/goal Ship v2")).toEqual({ kind: "set", objective: "Ship v2" });
  });

  test("status shows state plus cumulative stats; fresh goal reads zeros", () => {
    const fresh = goalStatusText({ objective: "Ship v2", active: true });
    expect(fresh).toContain("Ship v2");
    expect(fresh).toContain("[active]");
    expect(fresh).toContain("turns 0");
    expect(fresh).toContain("requests 0");
    const full = goalStatusText({
      objective: "Ship v2",
      active: true,
      stats: { turns: 3, requests: 12, tokens: 4500, workMs: 83000 },
    });
    expect(full).toContain("turns 3");
    expect(full).toContain("requests 12");
    expect(full).toContain("tokens 4.5K");
    expect(full).toContain("work 1m23s");
    const paused = goalStatusText({ objective: "Ship v2", active: false, stats: emptyGoalStats() });
    expect(paused).toContain("[paused]");
  });

  test("token slice prefers totals, falls back to prompt+completion, never estimates", () => {
    expect(goalTokensForUsage({ total_tokens: 10 })).toBe(10);
    expect(goalTokensForUsage({ prompt_tokens: 7, completion_tokens: 2 })).toBe(9);
    expect(goalTokensForUsage({})).toBe(0);
  });

  test("formatters stay compact and total", () => {
    expect(formatGoalTokens(999)).toBe("999");
    expect(formatGoalTokens(1500)).toBe("1.5K");
    expect(goalStatsText(emptyGoalStats())).toContain("turns 0");
    expect(formatGoalWorkMs(4000)).toBe("4s");
    expect(formatGoalWorkMs(83000)).toBe("1m23s");
  });

  test("notices name the objective and point at resume", () => {
    expect(goalFollowUp("Ship v2")).toContain("Ship v2");
    const paused = goalPausedNotice("Ship v2", "(cancelled)");
    expect(paused).toContain("paused");
    expect(paused).toContain("Ship v2");
    expect(paused).toContain("/goal resume");
    expect(goalPauseNotice(null)).toContain("nothing to pause");
    expect(goalPauseNotice({ objective: "A", active: true })).toContain("paused");
    expect(goalResumeNotice(null)).toContain("set one with /goal");
    expect(goalResumeNotice({ objective: "A", active: false })).toContain("resumed");
    expect(goalResumeNotice({ objective: "A", active: true })).toContain("already active");
  });
});

describe("goal auto-continue (loop level)", () => {
  test("scripted two-turn goal finishes with no further user input", async () => {
    const g = liveGoal("Ship v2");
    // The second request clears the goal first (as /goal clear would
    // mid-run — slash runs while busy), so the second turn-end returns.
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 2) g.state.cleared = true;
    };
    let posts = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: posts === 1 ? "first" : "second" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply).toBe("second");
    expect(posts).toBe(2);
    // Both turns committed through the gate seam: assistant final plus the
    // single goal follow-up — no synthetic user message beyond it.
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(history[2]).toEqual({ role: "assistant", content: "first" });
    expect(history[3]).toEqual({ role: "user", content: goalFollowUp("Ship v2") });
    expect(history[4]).toEqual({ role: "assistant", content: "second" });
    // Continuations + 1: two turns taken, two model requests observed.
    expect(g.state.turns).toBe(2);
    expect(g.state.requests).toBe(2);
    expect(g.state.pauses).toEqual([]);
  });

  test("cancel mid-continuation stops the turn and pauses (never clears) with a notice", async () => {
    const g = liveGoal("Ship v2");
    const controller = new AbortController();
    let posts = 0;
    const history = baseHistory();
    await expect(
      runLoopWithChat(
        async (): Promise<ChatResult> => {
          posts += 1;
          // Abort lands between the POST and the continuation check, so the
          // cancel must win before any second turn starts.
          controller.abort();
          return { content: "done-ish" };
        },
        history,
        { execute: async () => "tool-result", goal: g.hook, signal: controller.signal }
      )
    ).rejects.toThrow("(cancelled)");
    expect(posts).toBe(1);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toHaveLength(1);
    expect(g.state.pauses[0]).toContain("paused");
    expect(g.state.pauses[0]).toContain("Ship v2");
    expect(g.state.pauses[0]).toContain("/goal resume");
    // Nothing committed past the base history — the caller rolls back.
    expect(history).toEqual(baseHistory());
  });

  test("cancel thrown by the POST itself also pauses with a notice", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    await expect(
      runLoopWithChat(
        async (): Promise<ChatResult> => {
          throw new LoopCancelledError();
        },
        history,
        { execute: async () => "tool-result", goal: g.hook }
      )
    ).rejects.toThrow("(cancelled)");
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toHaveLength(1);
  });

  test("failed POST keeps the splice contract and the goal carries on", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    const rollbackTo = history.length;
    await expect(
      runLoopWithChat(
        async (): Promise<ChatResult> => {
          throw new Error("boom");
        },
        history,
        { execute: async () => "tool-result", goal: g.hook }
      )
    ).rejects.toThrow("boom");
    // Existing contract: the caller splices the partial turn away…
    history.splice(rollbackTo);
    expect(history).toEqual(baseHistory());
    // …and the goal is untouched (no pause, still active — it carries on).
    expect(g.state.active).toBe(true);
    expect(g.state.pauses).toEqual([]);
    // The very next run continues the goal normally (clear-on-request ends
    // it so this script terminates after one turn).
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      g.state.cleared = true;
    };
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => ({ content: "recovered" }),
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply).toBe("recovered");
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: "recovered" });
  });

  test("spent step budget pauses the goal with a notice instead of spinning", async () => {
    const g = liveGoal("Ship v2");
    let posts = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: "done" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook, maxSteps: 0 }
    );
    expect(reply).toBe("done");
    expect(posts).toBe(1);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toHaveLength(1);
    expect(g.state.pauses[0]).toContain("budget");
    expect(g.state.pauses[0]).toContain("/goal resume");
    expect(g.state.turns).toBe(1);
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  test("tool-call budget exhaustion pauses the goal with a notice", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => ({
        content: "working",
        tool_calls: [
          { id: "c1", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } },
          { id: "c2", function: { name: "glob", arguments: '{"pattern":"*.js"}' } },
        ],
      }),
      history,
      {
        execute: async () => "tool-result",
        goal: g.hook,
        maxTotalToolCalls: 1,
      }
    );
    expect(reply).toContain("too many tool calls");
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toHaveLength(1);
    expect(g.state.pauses[0]).toContain("Ship v2");
  });
});
