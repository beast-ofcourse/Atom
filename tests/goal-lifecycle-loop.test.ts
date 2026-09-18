// Phase 4 pins (goal-tools-refactor): model-initiated lifecycle at loop
// level. Mocked chatFn, session-owned state double — no network, no TUI.
// Inits: tool effects equal slash effects; missing wiring degrades.
// Mock shape: round 1 carries the lifecycle call, round 2 the terminal
// update_goal report, round 3 final text (a turn ends only on a round with
// no tool calls — returning calls forever spins, by loop design).
import { describe, expect, test } from "vitest";
import { runLoopWithChat, type ChatMessage, type ChatResult } from "../src/zen.js";
import type { ToolCall } from "../src/agent/types.js";

let callSeq = 0;
function goalCall(name: string, args: Record<string, unknown>): ToolCall {
  callSeq += 1;
  return { id: `g${callSeq}`, function: { name, arguments: JSON.stringify(args) } };
}

function completeCall(): ToolCall {
  return goalCall("update_goal", { status: "complete", reason: "done" });
}

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

// Session double: mirrors the App wiring (full GoalState, pause preserves,
// set replaces with fresh stats, resume re-arms, clear nulls).
function session(objective?: string, active = true) {
  const state = {
    goal:
      objective === undefined
        ? null
        : {
            objective,
            active,
            stats: { turns: 0, requests: 0, tokens: 0, workMs: 0 },
          },
    pauses: [] as string[],
    sets: [] as Array<{ objective: string; tokenBudget?: number }>,
    resumes: 0,
    clears: 0,
    requests: 0,
    turns: 0,
  };
  return {
    state,
    hook: {
      getGoal: () =>
        state.goal === null
          ? null
          : {
              objective: state.goal.objective,
              active: state.goal.active,
              stats: { ...state.goal.stats },
            },
      pauseGoal: (notice: string) => {
        state.pauses.push(notice);
        if (state.goal) state.goal.active = false;
      },
      onGoalRequest: () => {
        state.requests += 1;
      },
      onGoalTurn: () => {
        state.turns += 1;
      },
      setGoal: (obj: string, tokenBudget?: number) => {
        state.sets.push({ objective: obj, tokenBudget });
        state.goal = {
          objective: obj,
          active: true,
          stats: { turns: 0, requests: 0, tokens: 0, workMs: 0 },
        };
      },
      resumeGoal: () => {
        state.resumes += 1;
        if (state.goal) state.goal.active = true;
      },
      clearGoal: () => {
        state.clears += 1;
        state.goal = null;
      },
    },
  };
}

function toolTexts(history: ChatMessage[]): string[] {
  return history
    .filter((m) => m.role === "tool")
    .map((m) => (m as { content: string }).content);
}

describe("model-initiated lifecycle", () => {
  test("pause_goal pauses with the model reason; run ends plainly", async () => {
    const s = session("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "pausing",
            tool_calls: [goalCall("pause_goal", { reason: "waiting on creds" })],
          };
        }
        return { content: "coasting" };
      },
      history,
      { execute: async () => "must-not-run", goal: s.hook }
    );
    expect(s.state.goal?.active).toBe(false);
    expect(s.state.pauses).toHaveLength(1);
    expect(s.state.pauses[0]).toContain("waiting on creds");
    expect(toolTexts(history).join("\n")).toContain("(goal paused —");
    expect(reply).toBe("coasting");
  });

  test("get_goal reads objective and state without mutating", async () => {
    const s = session("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return { content: null, tool_calls: [goalCall("get_goal", {})] };
        }
        if (posts === 2) {
          return { content: null, tool_calls: [completeCall()] };
        }
        return { content: "done" };
      },
      history,
      { execute: async () => "must-not-run", goal: s.hook }
    );
    expect(toolTexts(history).join("\n")).toContain("Ship v2");
    expect(posts).toBe(3);
    expect(reply).toContain("done");
  });

  test("create_goal with no live goal creates it with budget; run engages", async () => {
    const s = session();
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: null,
            tool_calls: [goalCall("create_goal", { objective: "Ship v2", token_budget: 40000 })],
          };
        }
        if (posts === 2) {
          return { content: null, tool_calls: [completeCall()] };
        }
        return { content: "working on it" };
      },
      history,
      { execute: async () => "must-not-run", goal: s.hook }
    );
    expect(s.state.sets).toEqual([{ objective: "Ship v2", tokenBudget: 40000 }]);
    expect(s.state.goal?.objective).toBe("Ship v2");
    expect(toolTexts(history).join("\n")).toContain("(goal set —");
    // The created goal engages the run (requests counted past creation).
    expect(s.state.requests).toBeGreaterThanOrEqual(1);
    expect(typeof reply).toBe("string");
  });

  test("duplicate create keeps the first goal; nothing replaced", async () => {
    const s = session("Original");
    const history = baseHistory();
    let posts = 0;
    await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: null,
            tool_calls: [goalCall("create_goal", { objective: "Hijack" })],
          };
        }
        if (posts === 2) {
          return { content: null, tool_calls: [completeCall()] };
        }
        return { content: "done" };
      },
      history,
      { execute: async () => "must-not-run", goal: s.hook }
    );
    expect(s.state.sets).toEqual([]);
    expect(s.state.goal?.objective).toBe("Original");
    expect(toolTexts(history).join("\n")).toContain("already live");
  });

  test("clear_goal ends the run; engaged turn still counted", async () => {
    const s = session("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: "dropping it",
            tool_calls: [goalCall("clear_goal", {})],
          };
        }
        return { content: "done" };
      },
      history,
      { execute: async () => "must-not-run", goal: s.hook }
    );
    expect(s.state.clears).toBe(1);
    expect(s.state.goal).toBeNull();
    expect(toolTexts(history).join("\n")).toContain("(goal cleared —");
    expect(reply).toBe("done");
    expect(s.state.turns).toBe(1);
  });

  test("resume_goal re-arms a paused goal; continuation follows", async () => {
    const s = session("Ship v2", false);
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: null,
            tool_calls: [goalCall("resume_goal", {})],
          };
        }
        if (posts === 2) {
          return { content: null, tool_calls: [completeCall()] };
        }
        return { content: "onward" };
      },
      history,
      { execute: async () => "must-not-run", goal: s.hook }
    );
    expect(s.state.resumes).toBe(1);
    expect(toolTexts(history).join("\n")).toContain("(goal resumed —");
    // Resumed goal auto-continued past the resuming turn into the verdict turn.
    expect(posts).toBe(3);
    expect(typeof reply).toBe("string");
  });

  test("missing session wiring degrades to outside errors, never throws", async () => {
    const s = session("Ship v2");
    const bareHook = {
      getGoal: s.hook.getGoal,
      pauseGoal: s.hook.pauseGoal,
    };
    const history = baseHistory();
    let posts = 0;
    await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: null,
            tool_calls: [
              goalCall("clear_goal", {}),
              goalCall("resume_goal", {}),
            ],
          };
        }
        if (posts === 2) {
          return { content: null, tool_calls: [completeCall()] };
        }
        return { content: "done" };
      },
      history,
      { execute: async () => "must-not-run", goal: bareHook }
    );
    const texts = toolTexts(history).join("\n");
    expect(texts).toContain("clear_goal is only available during a session turn");
    // resume on an active goal answers from state (no wiring needed).
    expect(texts).toContain("already active");
    expect(s.state.goal?.objective).toBe("Ship v2");
  });
});
