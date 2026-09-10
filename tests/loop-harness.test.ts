// Hardened-loop integration tests: repetition guard, error-streak recovery,
// malformed-response tolerance, total-call budget, timeouts, normalization,
// and per-turn stats. Direct chatFn mocks (no fetch, no network).
import { afterEach, describe, expect, test } from "vitest";
import { clearTodos } from "../src/tools.js";
import {
  executeWithTimeout,
  resolveMaxTotalToolCalls,
  resolveToolTimeoutMs,
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
  type LoopStats,
} from "../src/zen.js";

afterEach(() => {
  clearTodos();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

function toolMsg(id: string, name: string, args: unknown): ChatResult {
  return {
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

// Scripted chatFn: pops per POST, repeats the last forever. Counts POSTs.
function scripted(replies: ChatResult[]) {
  const queue = [...replies];
  let n = 0;
  const fn = async (_h: ChatMessage[]): Promise<ChatResult> => {
    n += 1;
    return (queue.length > 1 ? queue.shift() : queue[0]) as ChatResult;
  };
  return { fn, count: () => n };
}

function assertPairingIntact(history: ChatMessage[]): void {
  const calls = new Set<string>();
  for (const m of history) {
    if (m.role === "assistant" && m.tool_calls !== undefined) {
      for (const c of m.tool_calls) calls.add(c.id);
    }
  }
  const seen = new Set<string>();
  for (const m of history) {
    if (m.role === "tool") {
      expect(calls.has(m.tool_call_id)).toBe(true);
      seen.add(m.tool_call_id);
    }
  }
  expect(seen).toEqual(calls);
}

describe("resolve helpers", () => {
  test("tool timeout: undefined → 60s default; <=0/NaN → disabled; clamps", () => {
    expect(resolveToolTimeoutMs(undefined)).toBe(60_000);
    expect(resolveToolTimeoutMs(NaN)).toBe(60_000);
    expect(resolveToolTimeoutMs(0)).toBeNull();
    expect(resolveToolTimeoutMs(-5)).toBeNull();
    expect(resolveToolTimeoutMs(500)).toBe(1000);
    expect(resolveToolTimeoutMs(500_000)).toBe(120_000);
    expect(resolveToolTimeoutMs(5000)).toBe(5000);
  });

  test("total-call budget: default 200, min 1", () => {
    expect(resolveMaxTotalToolCalls(undefined)).toBe(200);
    expect(resolveMaxTotalToolCalls(NaN)).toBe(200);
    expect(resolveMaxTotalToolCalls(0)).toBe(1);
    expect(resolveMaxTotalToolCalls(5)).toBe(5);
  });
});

describe("executeWithTimeout", () => {
  test("fast executors pass through untouched", async () => {
    const out = await executeWithTimeout(async () => "fine", "read", {}, 60_000, null);
    expect(out).toBe("fine");
  });

  test("null timeout disables the race (direct await)", async () => {
    const out = await executeWithTimeout(async () => "direct", "read", {}, null, null);
    expect(out).toBe("direct");
  });

  test("hung executor resolves to a timeout Error result (never throws)", async () => {
    const out = await executeWithTimeout(
      () => new Promise<string>(() => {}),
      "grep",
      {},
      1000,
      null
    );
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("timed out after 1000ms");
  });

  test("already-aborted signal refuses to start (no new executions)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let ran = false;
    const p = executeWithTimeout(
      async () => {
        ran = true;
        return "should-not-run";
      },
      "read",
      {},
      60_000,
      ctrl.signal
    );
    await expect(p).rejects.toThrow("(cancelled)");
    expect(ran).toBe(false);
  });

  test("mid-execution abort does NOT drop the in-flight result (pinned contract)", async () => {
    const ctrl = new AbortController();
    const p = executeWithTimeout(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("finished"), 50)),
      "read",
      {},
      60_000,
      ctrl.signal
    );
    setTimeout(() => ctrl.abort(), 10);
    // The tool runs to completion; the caller stops the turn afterwards.
    await expect(p).resolves.toBe("finished");
  });
});

describe("pinned maxSteps contract (track-only default)", () => {
  test("always-same-call still stops at maxSteps with 1+steps POSTs", async () => {
    const always = toolMsg("c", "glob", { pattern: "*" });
    const { fn, count } = scripted([always]);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: async () => "tool-result",
      maxSteps: 2,
      sleep: async () => {},
    });
    expect(reply).toContain("(stopped: too many tool steps)");
    expect(count()).toBe(3);
    assertPairingIntact(history);
  });
});

describe("repetition guard (opt-in)", () => {
  test("identical calls halt early with a stop notice, not maxSteps", async () => {
    const same = toolMsg("c", "read", { path: "a.txt" });
    const { fn, count } = scripted([same]);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: async () => "ok",
      maxSteps: 30,
      maxRepeatedCalls: 3,
      sleep: async () => {},
    });
    expect(reply).toContain("repeated");
    expect(count()).toBeLessThan(10); // far short of the 31-POST maxSteps path
    assertPairingIntact(history);
    // Guard guidance reached the model as an inline error result.
    const tools = history.filter((m) => m.role === "tool");
    expect(tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(tools)).toContain("loop guard");
  });

  test("varied calls never trip the guard", async () => {
    const { fn } = scripted([
      toolMsg("c1", "read", { path: "a.txt" }),
      toolMsg("c2", "read", { path: "b.txt" }),
      { content: "done" },
    ]);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: async () => "ok",
      maxRepeatedCalls: 3,
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    assertPairingIntact(history);
  });
});

describe("error-streak recovery", () => {
  function errThenFinal(): { fn: (h: ChatMessage[]) => Promise<ChatResult>; count: () => number } {
    return scripted([
      toolMsg("e1", "read", { path: "x1" }),
      toolMsg("e2", "read", { path: "x2" }),
      toolMsg("e3", "read", { path: "x3" }),
      { content: "giving up" },
    ]);
  }

  test("3 consecutive errors hold final text for a fix-forward attempt", async () => {
    const { fn } = errThenFinal();
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: async () => "Error: nope",
      sleep: async () => {},
    });
    expect(reply).toBe("giving up");
    expect(JSON.stringify(history)).toContain("(recovery:");
    assertPairingIntact(history);
  });

  test("disabled with maxConsecutiveErrors: 0 (ends immediately)", async () => {
    const { fn } = errThenFinal();
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: async () => "Error: nope",
      maxConsecutiveErrors: 0,
      sleep: async () => {},
    });
    expect(reply).toBe("giving up");
    expect(JSON.stringify(history)).not.toContain("(recovery:");
  });

  test("single error still ends normally (may be a reported blocker)", async () => {
    const { fn } = scripted([toolMsg("e1", "read", { path: "x" }), { content: "blocked: disk gone" }]);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: async () => "Error: nope",
      sleep: async () => {},
    });
    expect(reply).toBe("blocked: disk gone");
    expect(JSON.stringify(history)).not.toContain("(recovery:");
  });
});

describe("malformed model responses", () => {
  test("nameless tool call drops with a warning; turn ends gracefully", async () => {
    const warnings: string[] = [];
    const bad = {
      content: null,
      tool_calls: [{ id: "x", type: "function", function: {} }],
    } as unknown as ChatResult;
    const { fn } = scripted([bad]);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      onWarning: (m) => void warnings.push(m),
      sleep: async () => {},
    });
    expect(typeof reply).toBe("string");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("no function name"))).toBe(true);
    assertPairingIntact(history);
  });

  test("non-object message never crashes the loop", async () => {
    const fn = async (): Promise<ChatResult> => "garbage" as unknown as ChatResult;
    const history = baseHistory();
    const warnings: string[] = [];
    const reply = await runLoopWithChat(fn, history, {
      onWarning: (m) => void warnings.push(m),
      sleep: async () => {},
    });
    expect(typeof reply).toBe("string");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("total-call budget", () => {
  test("one block exceeding the budget stops before execution", async () => {
    let executions = 0;
    const three: ChatResult = {
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
        { id: "b", type: "function", function: { name: "read", arguments: '{"path":"b"}' } },
        { id: "c", type: "function", function: { name: "read", arguments: '{"path":"c"}' } },
      ],
    };
    const { fn } = scripted([three]);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: async () => {
        executions += 1;
        return "ok";
      },
      maxTotalToolCalls: 2,
      sleep: async () => {},
    });
    expect(reply).toContain("too many tool calls");
    expect(executions).toBe(0);
  });
});

describe("normalization + stats", () => {
  test("non-string execute results coerce to JSON in history", async () => {
    const { fn } = scripted([toolMsg("c1", "glob", { pattern: "*" }), { content: "done" }]);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: (async () => ({ weird: 1 })) as unknown as () => Promise<string>,
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    const tools = history.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect((tools[0] as { content: string }).content).toBe('{"weird":1}');
  });

  test("onLoopStats reports the measured turn summary", async () => {
    const { fn } = scripted([toolMsg("c1", "read", { path: "a" }), { content: "done" }]);
    const history = baseHistory();
    let stats: LoopStats | null = null;
    const reply = await runLoopWithChat(fn, history, {
      execute: async () => "ok",
      onLoopStats: (s) => {
        stats = s;
      },
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    expect(stats).not.toBeNull();
    const s = stats as unknown as LoopStats;
    expect(s.modelCalls).toBe(2);
    expect(s.toolCalls).toBe(1);
    expect(s.failures).toBe(0);
    expect(s.steps).toBe(2);
    expect(s.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.bottleneck?.name).toBe("read");
    expect(typeof s.contextGrowthChars).toBe("number");
    expect(typeof s.cacheHits).toBe("number");
  });

  test("failures + bottleneck reflect error results", async () => {
    const { fn } = scripted([toolMsg("c1", "read", { path: "a" }), { content: "done" }]);
    const history = baseHistory();
    let stats: LoopStats | null = null;
    await runLoopWithChat(fn, history, {
      execute: async () => "Error: bad",
      onLoopStats: (s) => {
        stats = s;
      },
      sleep: async () => {},
    });
    expect((stats as unknown as LoopStats).failures).toBe(1);
    expect((stats as unknown as LoopStats).toolCalls).toBe(1);
  });

  test("parallel batches still commit in call order", async () => {
    const both: ChatResult = {
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
        { id: "b", type: "function", function: { name: "read", arguments: '{"path":"b"}' } },
      ],
    };
    const { fn } = scripted([both, { content: "done" }]);
    const history = baseHistory();
    const seen: string[] = [];
    const reply = await runLoopWithChat(fn, history, {
      execute: async (_n, a) => {
        seen.push(String(a["path"]));
        return `content-${String(a["path"])}`;
      },
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    const tools = history.filter((m) => m.role === "tool") as Array<{ tool_call_id: string }>;
    expect(tools.map((t) => t.tool_call_id)).toEqual(["a", "b"]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});
