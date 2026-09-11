// Ticket 04 goal tests: evaluator fallback for missing reports. Pure helper
// tests (no TUI) plus loop-level tests (mocked chatFn, fake judge runner —
// no network) plus one fetch-mocked transport test for the judge POST
// contract. Covers: strict-but-tolerant verdict parsing, the recent-turns
// tail, exactly-one-judge-call per report-less turn, verdicts driving the
// model-report path, error/unclear pausing with preservation, the no-runner
// preservation of today's continue, and the judge performing no tool
// executions and no state mutations.
import { afterEach, describe, expect, test, vi } from "vitest";
import { clearTodos } from "../src/tools.js";
import {
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
} from "../src/zen.js";
import type { ToolCall } from "../src/agent/types.js";
import {
  GOAL_JUDGE_TAIL_MESSAGES,
  goalFollowUp,
  parseGoalJudgeVerdict,
  recentTurnsForJudge,
} from "../src/goal.js";
import {
  buildGoalJudgeInstruction,
  buildGoalJudgeMessages,
  GOAL_JUDGE_MAX_TOKENS,
  requestGoalVerdict,
  type GoalJudgeInput,
} from "../src/agent/goal-evaluator.js";

afterEach(() => {
  clearTodos();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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

describe("parseGoalJudgeVerdict (ticket 04)", () => {
  test("clear verdicts parse to dispositions", () => {
    expect(parseGoalJudgeVerdict('{"status": "continue", "next": "Probe X"}')).toEqual({
      status: "continue",
      next: "Probe X",
    });
    expect(parseGoalJudgeVerdict('{"status": "complete", "reason": "Done"}')).toEqual({
      status: "complete",
      reason: "Done",
    });
    expect(parseGoalJudgeVerdict('{"status": "blocked", "reason": "Stuck"}')).toEqual({
      status: "blocked",
      reason: "Stuck",
    });
  });

  test("code fences and surrounding prose are tolerated", () => {
    expect(
      parseGoalJudgeVerdict('```json\n{"status": "complete", "reason": "Done"}\n```')
    ).toEqual({ status: "complete", reason: "Done" });
    expect(
      parseGoalJudgeVerdict('verdict:\n{"status": "blocked", "reason": "No key"} — done')
    ).toEqual({ status: "blocked", reason: "No key" });
  });

  test("empty next on continue reads as absent (still a clear verdict)", () => {
    expect(parseGoalJudgeVerdict('{"status": "continue", "next": "   "}')).toEqual({
      status: "continue",
    });
    expect(parseGoalJudgeVerdict('{"status": "continue"}')).toEqual({ status: "continue" });
  });

  test("anything else counts as unclear → null", () => {
    expect(parseGoalJudgeVerdict("")).toBeNull();
    expect(parseGoalJudgeVerdict("looks done to me")).toBeNull();
    expect(parseGoalJudgeVerdict('{"status": "pause"}')).toBeNull();
    expect(parseGoalJudgeVerdict('{"status": "complete"}')).toBeNull();
    expect(parseGoalJudgeVerdict('{"status": "blocked", "reason": "  "}')).toBeNull();
    expect(parseGoalJudgeVerdict('{"status": "continue", "next": 42}')).toBeNull();
    expect(parseGoalJudgeVerdict("[1, 2]")).toBeNull();
    expect(parseGoalJudgeVerdict('"continue"')).toBeNull();
    expect(parseGoalJudgeVerdict(null as unknown as string)).toBeNull();
  });

  test("payloads are trimmed", () => {
    expect(parseGoalJudgeVerdict('{"status": "complete", "reason": "  Done  "}')).toEqual({
      status: "complete",
      reason: "Done",
    });
  });
});

describe("recentTurnsForJudge (ticket 04)", () => {
  test("short histories pass through; long ones cap at the tail", () => {
    expect(recentTurnsForJudge(baseHistory())).toEqual(baseHistory());
    const long: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    const tail = recentTurnsForJudge(long);
    expect(tail).toHaveLength(GOAL_JUDGE_TAIL_MESSAGES);
    expect(tail[0]).toEqual({ role: "user", content: `m${50 - GOAL_JUDGE_TAIL_MESSAGES}` });
    expect(tail.at(-1)).toEqual({ role: "user", content: "m49" });
  });

  test("non-array input reads as empty", () => {
    expect(recentTurnsForJudge(null as unknown as ChatMessage[])).toEqual([]);
  });
});

describe("judge prompt shape (ticket 04)", () => {
  test("instruction names the goal and demands one JSON verdict", () => {
    const text = buildGoalJudgeInstruction("Ship v2");
    expect(text).toContain("Ship v2");
    expect(text).toContain('"continue"');
    expect(text).toContain('"complete"');
    expect(text).toContain('"blocked"');
    expect(text).toContain("JSON object only");
  });

  test("messages are system + recent turns + instruction", () => {
    const turns = baseHistory().slice(1);
    const msgs = buildGoalJudgeMessages("sys", "Ship v2", turns);
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs.at(-1)?.role).toBe("user");
    expect((msgs.at(-1) as { content: string }).content).toContain("Ship v2");
    expect(msgs).toHaveLength(turns.length + 2);
  });

  test("missing system content falls back to a judge default", () => {
    const msgs = buildGoalJudgeMessages(undefined, "Ship v2", []);
    expect((msgs[0] as { content: string }).content).toContain("judge");
  });
});

describe("judge POST contract (ticket 04)", () => {
  // Scripted non-streaming JSON reply; records every POST body.
  function mockChatQueue(replies: string[]) {
    const posts: Array<Record<string, unknown>> = [];
    const queue = [...replies];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
      } catch {
        body = {};
      }
      posts.push(body);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: next } }] }),
      } as unknown as Response;
    });
    return posts;
  }

  test("no `tools` key, small output cap, verdict parsed", async () => {
    const posts = mockChatQueue(['{"status": "complete", "reason": "Done"}']);
    const verdict = await requestGoalVerdict({
      provider: "opencode-zen",
      apiKey: "test-key",
      model: "kimi-k2.5",
      systemContent: "sys",
      goal: "Ship v2",
      turns: [{ role: "user", content: "go" }],
    });
    expect(verdict).toEqual({ status: "complete", reason: "Done" });
    expect(posts).toHaveLength(1);
    const body = posts[0]!;
    expect("tools" in body).toBe(false);
    expect(body["max_tokens"]).toBe(GOAL_JUDGE_MAX_TOKENS);
    expect(GOAL_JUDGE_MAX_TOKENS).toBeLessThanOrEqual(512);
    const msgs = body["messages"] as ChatMessage[];
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect((msgs.at(-1) as { content: string }).content).toContain("Ship v2");
  });

  test("unparseable judge output resolves null (never throws)", async () => {
    mockChatQueue(["looks done to me"]);
    const verdict = await requestGoalVerdict({
      provider: "opencode-zen",
      apiKey: "test-key",
      model: "kimi-k2.5",
      goal: "Ship v2",
      turns: [],
    });
    expect(verdict).toBeNull();
  });

  test("empty judge reply throws (the loop pauses on it)", async () => {
    mockChatQueue(["   "]);
    await expect(
      requestGoalVerdict({
        provider: "opencode-zen",
        apiKey: "test-key",
        model: "kimi-k2.5",
        goal: "Ship v2",
        turns: [],
      })
    ).rejects.toThrow("Empty reply");
  });

  test("judge usage forwards when reported", async () => {
    const posts = mockChatQueue(['{"status": "continue"}']);
    expect(posts).toHaveLength(0);
    const seen: unknown[] = [];
    const verdict = await requestGoalVerdict({
      provider: "opencode-zen",
      apiKey: "test-key",
      model: "kimi-k2.5",
      goal: "Ship v2",
      turns: [],
      onUsage: (u) => {
        seen.push(u);
      },
    });
    expect(verdict).toEqual({ status: "continue" });
    // No usage payload in the mocked reply → nothing forwarded, never throws.
    expect(seen).toEqual([]);
  });
});

describe("evaluator fallback (loop level)", () => {
  test("two consecutive report-less turns trigger exactly two judge calls, one per turn", async () => {
    const g = liveGoal("Ship v2");
    // The third request clears the goal (as /goal clear would mid-run), so
    // the script terminates after the second continued turn ends normally.
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 3) g.state.cleared = true;
    };
    const inputs: GoalJudgeInput[] = [];
    let posts = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: posts === 1 ? "first" : posts === 2 ? "second" : "third" };
      },
      history,
      {
        execute: async () => "tool-result",
        goal: g.hook,
        goalJudge: async (input) => {
          inputs.push(input);
          return { status: "continue" };
        },
      }
    );
    expect(reply).toBe("third");
    expect(posts).toBe(3);
    // Exactly one judge call per report-less turn — no more, no fewer.
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.goal).toBe("Ship v2");
      // The judge sees the recent tail only, never more than the cap.
      expect(input.turns.length).toBeLessThanOrEqual(GOAL_JUDGE_TAIL_MESSAGES);
    }
    // Both continuations flow through the generic follow-up (no next given).
    expect(history.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history[3]).toEqual({ role: "user", content: goalFollowUp("Ship v2") });
    expect(history[5]).toEqual({ role: "user", content: goalFollowUp("Ship v2") });
    expect(g.state.turns).toBe(3);
    expect(g.state.pauses).toEqual([]);
  });

  test("a model report suppresses the judge entirely", async () => {
    const g = liveGoal("Ship v2");
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 3) g.state.cleared = true;
    };
    let judgeCalls = 0;
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
        return { content: posts === 2 ? "checkpoint" : "finished" };
      },
      history,
      {
        execute: async () => "tool-result",
        goal: g.hook,
        goalJudge: async () => {
          judgeCalls += 1;
          return { status: "continue" };
        },
      }
    );
    expect(reply).toBe("finished");
    expect(posts).toBe(3);
    expect(judgeCalls).toBe(0);
    expect(history[5]).toEqual({ role: "user", content: "Probe X" });
  });

  test("judge continue with a next action drives the follow-up like a model report", async () => {
    const g = liveGoal("Ship v2");
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 2) g.state.cleared = true;
    };
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: posts === 1 ? "checkpoint" : "finished" };
      },
      history,
      {
        execute: async () => "tool-result",
        goal: g.hook,
        goalJudge: async () => ({ status: "continue", next: "Probe the auth module" }),
      }
    );
    expect(reply).toBe("finished");
    expect(posts).toBe(2);
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(history[3]).toEqual({ role: "user", content: "Probe the auth module" });
    expect(g.state.active).toBe(true);
    expect(g.state.pauses).toEqual([]);
  });

  test("judge complete stops the loop with a verdict like a model report", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: "wrapping up" };
      },
      history,
      {
        execute: async () => "tool-result",
        goal: g.hook,
        goalJudge: async () => ({ status: "complete", reason: "Shipped" }),
      }
    );
    const verdict = `(goal complete — "Ship v2": Shipped)`;
    expect(reply).toBe(`wrapping up\n${verdict}`);
    expect(posts).toBe(1);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toEqual([verdict]);
    expect(g.state.turns).toBe(1);
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: reply });
  });

  test("judge blocked stops the loop with a blocked verdict", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: "wrapping up" };
      },
      history,
      {
        execute: async () => "tool-result",
        goal: g.hook,
        goalJudge: async () => ({ status: "blocked", reason: "No API key" }),
      }
    );
    expect(reply).toBe(`wrapping up\n(goal blocked — "Ship v2": No API key)`);
    expect(posts).toBe(1);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toHaveLength(1);
    expect(g.state.pauses[0]).toContain("No API key");
  });

  test("unclear judge verdict pauses with a notice and preserves the goal", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: "plain end" };
      },
      history,
      {
        execute: async () => "tool-result",
        goal: g.hook,
        goalJudge: async () => null,
      }
    );
    // The turn ends with its own text — the pause notice lands via the
    // callback (same contract as the spent-budget pause).
    expect(reply).toBe("plain end");
    expect(posts).toBe(1);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toHaveLength(1);
    expect(g.state.pauses[0]).toContain("Ship v2");
    expect(g.state.pauses[0]).toContain("judge unclear");
    expect(g.state.pauses[0]).toContain("/goal resume");
    expect(g.state.turns).toBe(1);
    // Preserved, never cleared: the objective is still there for /goal resume.
    expect(g.hook.getGoal()).toEqual({ objective: "Ship v2", active: false });
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  test("judge error pauses with a notice and preserves the goal", async () => {
    const g = liveGoal("Ship v2");
    const history = baseHistory();
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: "plain end" };
      },
      history,
      {
        execute: async () => "tool-result",
        goal: g.hook,
        goalJudge: async () => {
          throw new Error("boom");
        },
      }
    );
    expect(reply).toBe("plain end");
    expect(posts).toBe(1);
    expect(g.state.active).toBe(false);
    expect(g.state.pauses).toHaveLength(1);
    expect(g.state.pauses[0]).toContain("Ship v2");
    expect(g.state.pauses[0]).toContain("judge failed");
    expect(g.state.pauses[0]).toContain("boom");
    expect(g.state.pauses[0]).toContain("/goal resume");
    expect(g.hook.getGoal()).toEqual({ objective: "Ship v2", active: false });
  });

  test("no runner configured preserves today's behavior (report-less turn continues)", async () => {
    const g = liveGoal("Ship v2");
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
    expect(history[3]).toEqual({ role: "user", content: goalFollowUp("Ship v2") });
    expect(g.state.pauses).toEqual([]);
  });

  test("the judge performs no tool executions and no state mutations", async () => {
    const g = liveGoal("Ship v2");
    g.hook.onGoalRequest = () => {
      g.state.requests += 1;
      if (g.state.requests === 2) g.state.cleared = true;
    };
    const seen: string[] = [];
    const historyLenAtJudge: number[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => ({ content: "done" }),
      history,
      {
        execute: async (name) => {
          seen.push(name);
          return "tool-result";
        },
        goal: g.hook,
        goalJudge: async (input) => {
          // Read-only by contract: observe without touching.
          historyLenAtJudge.push(history.length);
          expect(input.turns.length).toBeLessThanOrEqual(GOAL_JUDGE_TAIL_MESSAGES);
          return { status: "continue" };
        },
      }
    );
    expect(reply).toBe("done");
    // No tool executions anywhere (the turn ran no tools, the judge ran none).
    expect(seen).toEqual([]);
    // The judge path wrote nothing: the committed history is exactly the
    // two-turn shape (assistant final + one follow-up per continuation).
    expect(history.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(historyLenAtJudge).toEqual([2]);
  });
});
