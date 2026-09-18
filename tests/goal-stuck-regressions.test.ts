// Phase 7 regressions (goal-tools-refactor): Codex #24094 (stuck goal —
// tools absent while a goal lives) and #30630 (pause exists at runtime but
// the agent contract reports it unavailable). Provider-wide + loop-level.
import { afterEach, describe, expect, test, vi } from "vitest";
import { runAgenticLoopForProvider, runLoopWithChat } from "../src/zen.js";
import type { ChatMessage, ChatResult } from "../src/zen.js";
import type { ToolCall } from "../src/agent/types.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

function toolNamesOf(defs: Array<{ function: { name: string } }>): string[] {
  return defs.map((t) => t.function.name);
}

function mockChat(seen: Array<{ body: Record<string, unknown> }>) {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen.push({ body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) });
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: "done" } }] }),
    };
  }) as unknown as typeof fetch;
}

const history = (): ChatMessage[] => [
  { role: "system", content: "s" },
  { role: "user", content: "hi" },
];

describe("#24094: no stuck goals on any provider path", () => {
  test("active goal exposes get/update/pause/clear (never create/resume)", async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seen);
    await runAgenticLoopForProvider("kilo", "k", "m", history(), {
      maxSteps: 0,
      goal: {
        getGoal: () => ({ objective: "ship it", active: true }),
        pauseGoal: () => {},
      },
    });
    const names = toolNamesOf(
      seen[0]!.body["tools"] as Array<{ function: { name: string } }>
    );
    for (const name of ["get_goal", "update_goal", "pause_goal", "clear_goal"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("create_goal");
    expect(names).not.toContain("resume_goal");
  });

  test("paused goal exposes get/resume/clear (never update/pause/create)", async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seen);
    await runAgenticLoopForProvider("kilo", "k", "m", history(), {
      maxSteps: 0,
      goal: {
        getGoal: () => ({ objective: "ship it", active: false }),
        pauseGoal: () => {},
      },
    });
    const names = toolNamesOf(
      seen[0]!.body["tools"] as Array<{ function: { name: string } }>
    );
    for (const name of ["get_goal", "resume_goal", "clear_goal"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("update_goal");
    expect(names).not.toContain("pause_goal");
    expect(names).not.toContain("create_goal");
  });

  test("/goal intent without a hook arms create only (completable once live)", async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seen);
    await runAgenticLoopForProvider(
      "kilo",
      "k",
      "m",
      [
        { role: "system", content: "s" },
        { role: "user", content: "/goal Ship the migration" },
      ],
      { maxSteps: 0 }
    );
    const names = toolNamesOf(
      seen[0]!.body["tools"] as Array<{ function: { name: string } }>
    );
    expect(names).toContain("create_goal");
    expect(names).not.toContain("update_goal");
    expect(names).not.toContain("get_goal");
  });
});

describe("#30630: pause is observable and never misreported", () => {
  let callSeq = 0;
  function goalCall(name: string, args: Record<string, unknown>): ToolCall {
    callSeq += 1;
    return { id: `g${callSeq}`, function: { name, arguments: JSON.stringify(args) } };
  }

  function pausedSession() {
    const state = {
      goal: {
        objective: "Ship v2",
        active: false,
        stats: { turns: 0, requests: 0, tokens: 0, workMs: 0 },
      },
    };
    return {
      state,
      hook: {
        getGoal: () => ({ ...state.goal }),
        pauseGoal: () => {
          state.goal.active = false;
        },
        setGoal: (objective: string) => {
          state.goal = {
            objective,
            active: true,
            stats: { turns: 0, requests: 0, tokens: 0, workMs: 0 },
          };
        },
        resumeGoal: () => {
          state.goal.active = true;
        },
        clearGoal: () => {},
      },
    };
  }

  test("get_goal on a paused goal reports paused (not active, not missing)", async () => {
    const s = pausedSession();
    const h = history();
    let posts = 0;
    await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return { content: null, tool_calls: [goalCall("get_goal", {})] };
        }
        if (posts === 2) {
          return {
            content: null,
            tool_calls: [goalCall("update_goal", { status: "complete", reason: "saw paused" })],
          };
        }
        return { content: "done" };
      },
      h,
      { execute: async () => "must-not-run", goal: s.hook }
    );
    const texts = h
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: string }).content)
      .join("\n");
    expect(texts).toContain("[paused]");
    expect(texts).toContain("Ship v2");
  });

  test("pause then get in one turn agree on paused", async () => {
    const s = pausedSession();
    s.state.goal.active = true;
    const h = history();
    let posts = 0;
    await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: null,
            tool_calls: [goalCall("pause_goal", { reason: "creds" }), goalCall("get_goal", {})],
          };
        }
        if (posts === 2) {
          return {
            content: null,
            tool_calls: [goalCall("update_goal", { status: "complete", reason: "paused ok" })],
          };
        }
        return { content: "done" };
      },
      h,
      { execute: async () => "must-not-run", goal: s.hook }
    );
    const texts = h
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: string }).content)
      .join("\n");
    // Tool and read agree: pause notice plus a paused read, never a claim
    // that pause is unavailable.
    expect(texts).toContain("(goal paused —");
    expect(texts).toContain("[paused]");
    expect(texts).not.toMatch(/not expose.*pause|pause.*unavailable/i);
  });
});
