// Ticket 05 goal tests: novelty progress guard and stall redirect. Pure
// helper tests plus loop-level scripted runs (mocked chatFn) — no TUI, no
// network.
import { afterEach, describe, expect, test } from "vitest";
import { clearTodos } from "../src/tools.js";
import { runLoopWithChat, type ChatMessage, type ChatResult } from "../src/zen.js";
import {
  emptyGoalProgress,
  GOAL_STALL_REPEATS,
  goalFollowUp,
  goalProgressFingerprint,
  goalStallNudge,
  goalStallReached,
  noteGoalProgress,
  resetGoalStall,
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

function globCall(id: string): ChatResult {
  return {
    content: "working",
    tool_calls: [{ id, function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }],
  };
}

describe("goal progress pure helpers (ticket 05)", () => {
  test("fingerprint is stable for identical input and splits on any change", () => {
    const args = { pattern: "*.ts" };
    const a = goalProgressFingerprint("glob", args, "same-result");
    expect(goalProgressFingerprint("glob", { pattern: "*.ts" }, "same-result")).toBe(a);
    // Key order never aliases (stable args).
    expect(goalProgressFingerprint("glob", { pattern: "*.ts" }, "same-result")).toBe(a);
    expect(goalProgressFingerprint("glob", args, "other-result")).not.toBe(a);
    expect(goalProgressFingerprint("glob", { pattern: "*.js" }, "same-result")).not.toBe(a);
    expect(goalProgressFingerprint("read", args, "same-result")).not.toBe(a);
  });

  test("fingerprint stays bounded for huge results (never retains the text)", () => {
    const big = "x".repeat(200_000);
    const key = goalProgressFingerprint("read", { path: "a.txt" }, big);
    expect(key.length).toBeLessThan(100);
    expect(key).not.toContain(big.slice(0, 100));
  });

  test("exact repeats do not advance progress; novel evidence does", () => {
    const progress = emptyGoalProgress();
    // First commit advances.
    expect(noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "same-result", false)).toBe(true);
    expect(progress.novel).toBe(1);
    expect(progress.stale).toBe(0);
    // Same call twice with the same result advances once — the repeat is stale.
    expect(noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "same-result", false)).toBe(false);
    expect(progress.novel).toBe(1);
    expect(progress.stale).toBe(1);
    // New result, new args, and new tool each advance and reset the streak.
    expect(noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "new-result", false)).toBe(true);
    expect(noteGoalProgress(progress, "glob", { pattern: "*.js" }, "new-result", false)).toBe(true);
    expect(noteGoalProgress(progress, "read", { path: "a.txt" }, "new-result", false)).toBe(true);
    expect(progress.novel).toBe(4);
    expect(progress.stale).toBe(0);
  });

  test("error results never count (owned by the error-streak machinery)", () => {
    const progress = emptyGoalProgress();
    expect(noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "Error: boom", true)).toBe(false);
    expect(progress.novel).toBe(0);
    expect(progress.stale).toBe(0);
    // A later success still counts as the first novel commit.
    expect(noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "ok", false)).toBe(true);
    expect(progress.novel).toBe(1);
    expect(progress.stale).toBe(0);
  });

  test("stall fires at the threshold and reset starts a fresh epoch (seen-set kept)", () => {
    expect(GOAL_STALL_REPEATS).toBe(3);
    const progress = emptyGoalProgress();
    noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "same-result", false);
    expect(goalStallReached(progress)).toBe(false);
    noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "same-result", false);
    expect(goalStallReached(progress)).toBe(false);
    noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "same-result", false);
    expect(goalStallReached(progress)).toBe(false);
    noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "same-result", false);
    expect(goalStallReached(progress)).toBe(true);
    resetGoalStall(progress);
    expect(goalStallReached(progress)).toBe(false);
    // The repeat is still a repeat after the reset (no fresh progress).
    expect(noteGoalProgress(progress, "glob", { pattern: "*.ts" }, "same-result", false)).toBe(false);
    expect(progress.novel).toBe(1);
    expect(progress.stale).toBe(1);
  });

  test("nudge names the objective in the existing notice voice", () => {
    const nudge = goalStallNudge("Ship v2", GOAL_STALL_REPEATS);
    expect(nudge.startsWith("(goal")).toBe(true);
    expect(nudge.endsWith(")")).toBe(true);
    expect(nudge).toContain("Ship v2");
    expect(nudge).toContain("stalled");
    expect(nudge).toContain("stays active");
  });
});

describe("goal stall redirect (loop level)", () => {
  test("pure repeats past the threshold inject a visible nudge and the goal continues", async () => {
    const g = liveGoal("Ship v2");
    // Posts 1–4 commit the identical result (1 novel + 3 stale); post 5 ends
    // the text turn so the stall fires; post 6 ends the run (goal cleared on
    // the 6th request, as /goal clear would mid-run).
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 6) g.state.cleared = true;
    };
    let posts = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts <= 4) return globCall(`c${posts}`);
        return { content: posts === 5 ? "still working" : "done" };
      },
      history,
      { execute: async () => "same-result", goal: g.hook }
    );
    expect(reply).toBe("done");
    expect(posts).toBe(6);
    const users = history.filter((m) => m.role === "user").map((m) => m.content);
    // Base prompt plus exactly one stall nudge (post-5 turn end).
    expect(users).toHaveLength(2);
    expect(users[1]).toContain("(goal stalled");
    expect(users[1]).toContain("Ship v2");
    // Stalling never pauses, clears, or ends the goal by itself.
    expect(g.state.active).toBe(true);
    expect(g.state.pauses).toEqual([]);
  });

  test("novel evidence advances progress — no nudge, generic continuation", async () => {
    const g = liveGoal("Ship v2");
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 4) g.state.cleared = true;
    };
    let posts = 0;
    let calls = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts <= 2) return globCall(`c${posts}`);
        return { content: posts === 3 ? "halfway" : "done" };
      },
      history,
      {
        // Every commit returns distinct evidence, so nothing repeats.
        execute: async () => `fresh-result-${(calls += 1)}`,
        goal: g.hook,
      }
    );
    expect(reply).toBe("done");
    const users = history.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toHaveLength(2);
    expect(users[1]).toBe(goalFollowUp("Ship v2"));
    expect(g.state.active).toBe(true);
    expect(g.state.pauses).toEqual([]);
  });

  test("the goal stays live across multiple stall epochs (recurring nudges, never paused)", async () => {
    const g = liveGoal("Ship v2");
    // Tool posts 1–4 (novel + 3 stale), final post 5 → nudge #1; tool posts
    // 6–8 (3 more stale), final post 9 → nudge #2; post 10 ends the run.
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 10) g.state.cleared = true;
    };
    let posts = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts <= 4 || (posts >= 6 && posts <= 8)) return globCall(`c${posts}`);
        return { content: posts < 9 ? "still working" : "done" };
      },
      history,
      { execute: async () => "same-result", goal: g.hook }
    );
    expect(reply).toBe("done");
    expect(posts).toBe(10);
    const users = history.filter((m) => m.role === "user").map((m) => m.content);
    const nudges = users.filter((u) => typeof u === "string" && u.includes("(goal stalled"));
    expect(nudges).toHaveLength(2);
    expect(g.state.active).toBe(true);
    expect(g.state.pauses).toEqual([]);
  });
});
