// Phase 0.1 / Phase 1 regression net: core agent-loop correctness.
// Each test fails on the pre-fix code for the cited reason and passes after.
// Direct chatFn mocks (no fetch, no network).
import { afterEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearTodos } from "../src/tools.js";
import {
  runLoopWithChat,
  sleepOrCancel,
  type AgenticOpts,
  type ChatMessage,
  type ChatResult,
  type LoopStats,
} from "../src/zen.js";
import {
  normalizeChatResult,
  TOOL_RESULT_CAP_CHARS,
} from "../src/agent/normalize.js";
import { classifyExecutorText } from "../src/agent/tool-result.js";
import {
  getCachedRead,
  setCachedRead,
} from "../src/tools/read-cache.js";
import { bashTool, isReadOnlyCommand } from "../src/tools/shell.js";

afterEach(() => {
  clearTodos();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function scriptedChat(script: ChatResult[]) {
  let n = 0;
  const fn = async (_h: ChatMessage[], _o?: AgenticOpts): Promise<ChatResult> =>
    script[Math.min(n++, script.length - 1)]!;
  return { fn, count: () => n };
}

function toolMessages(history: ChatMessage[]): ChatMessage[] {
  return history.filter((m) => m.role === "tool");
}

describe("1A: parallel batch partial failure commits siblings in order", () => {
  test("member 2 throws: members 1+3 still commit with their ids, stats count all", async () => {
    const batch: ChatResult = {
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
        { id: "b", type: "function", function: { name: "read", arguments: '{"path":"b"}' } },
        { id: "c", type: "function", function: { name: "read", arguments: '{"path":"c"}' } },
      ],
    };
    const { fn } = scriptedChat([batch, { content: "done" }]);
    const history = baseHistory();
    let stats: LoopStats | null = null;
    const err = await runLoopWithChat(fn, history, {
      execute: async (name, args) => {
        if ((args as Record<string, unknown>)["path"] === "b") throw new Error("boom-b");
        return `content-of-${(args as Record<string, unknown>)["path"]}`;
      },
      onLoopStats: (s) => {
        stats = s;
      },
      sleep: async () => {},
    }).then(
      () => null,
      (e) => e as Error
    );
    // The turn still aborts per the rollback contract — but nothing executed
    // is silently dropped from the commit path first.
    expect(err).not.toBeNull();
    expect(String((err as Error)?.message ?? err)).toContain("boom-b");
    const tools = toolMessages(history);
    expect(tools.map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(["a", "b", "c"]);
    expect(String((tools[0] as { content: string }).content)).toContain("content-of-a");
    expect(String((tools[1] as { content: string }).content)).toContain("boom-b");
    expect(String((tools[2] as { content: string }).content)).toContain("content-of-c");
    const s = stats as unknown as LoopStats;
    expect(s.toolCalls).toBe(3);
    expect(s.failures).toBeGreaterThanOrEqual(1);
  });
});

describe("1D: thrown executions count like committed errors", () => {
  test("serial throw records toolCalls + failures", async () => {
    const { fn } = scriptedChat([toolCall("c1", "read", { path: "a" }), { content: "done" }]);
    const history = baseHistory();
    let stats: LoopStats | null = null;
    const err = await runLoopWithChat(fn, history, {
      execute: async () => {
        throw new Error("crash");
      },
      onLoopStats: (s) => {
        stats = s;
      },
      sleep: async () => {},
    }).then(
      () => null,
      (e) => e as Error
    );
    expect(err).not.toBeNull();
    const s = stats as unknown as LoopStats;
    expect(s.toolCalls).toBe(1);
    expect(s.failures).toBe(1);
  });

  test("prose starting with Error is not a failure; executor envelope is", () => {
    expect(classifyExecutorText("Error handling notes for the retry path")).toBe("ok");
    expect(classifyExecutorText("Error: boom")).toBe("failed");
    expect(classifyExecutorText("Error: read timed out after 5ms")).toBe("timed-out");
  });
});

describe("1B: vetoed calls keep start/finish balanced", () => {
  test("vetoed first call + committed second: 2 starts, 2 finishes, 1 tool message", async () => {
    const { fn } = scriptedChat([
      toolCall("v1", "read", { path: "a" }),
      toolCall("v2", "read", { path: "b" }),
      { content: "done" },
    ]);
    const history = baseHistory();
    let starts = 0;
    let finishes = 0;
    const reply = await runLoopWithChat(fn, history, {
      execute: async (_name, args) => `ok-${(args as Record<string, unknown>)["path"]}`,
      onToolResult: async ({ result }) =>
        result.includes("ok-a") ? { veto: true } : null,
      turnEvents: {
        onToolStarted: () => {
          starts += 1;
        },
        onToolFinished: () => {
          finishes += 1;
        },
      },
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    expect(starts).toBe(2);
    expect(finishes).toBe(2);
    const tools = toolMessages(history);
    expect(tools).toHaveLength(1);
    expect((tools[0] as { tool_call_id: string }).tool_call_id).toBe("v2");
  });
});

describe("1E: non-envelope bash output never verifies", () => {
  test("write + plain-text npm test + final: guard holds, ends unverified", async () => {
    const script = [
      toolCall("w1", "write", { path: "a.ts", content: "hi" }),
      toolCall("b1", "bash", { command: "npm test" }),
      { content: "done" },
      { content: "done" },
      { content: "done" },
      { content: "done" },
    ];
    const { fn, count } = scriptedChat(script);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      // Legacy-style runner: plain text, no JSON envelope with exitCode.
      execute: async (name) => (name === "bash" ? "all tests passed (plain)" : "ok"),
      sleep: async () => {},
    });
    // The guard held the turn (extra POSTs) instead of accepting the claim.
    expect(count()).toBeGreaterThan(3);
    expect(reply).toContain("(unverified:");
  });

  test("write + exit-0 envelope + final: clean, no flag", async () => {
    const { fn } = scriptedChat([
      toolCall("w1", "write", { path: "a.ts", content: "hi" }),
      toolCall("b1", "bash", { command: "npm test" }),
      { content: "done, tests pass" },
    ]);
    const history = baseHistory();
    const reply = await runLoopWithChat(fn, history, {
      execute: async (name) =>
        name === "bash"
          ? JSON.stringify({ exitCode: 0, stdout: "pass", stderr: "" })
          : "ok",
      sleep: async () => {},
    });
    expect(reply).toBe("done, tests pass");
  });
});

describe("1G: normalization safety", () => {
  test("fallback ids never collide with model-sent ids", () => {
    const raw = {
      content: null,
      tool_calls: [
        { id: "call-0", function: { name: "read", arguments: '{"path":"a"}' } },
        { function: { name: "read", arguments: '{"path":"b"}' } },
        { id: "call-0", function: { name: "read", arguments: '{"path":"c"}' } },
      ],
    };
    const { result } = normalizeChatResult(raw);
    const ids = (result.tool_calls ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("call-0");
    expect(ids[1]).not.toBe("call-0");
  });

  test("warnings bounded on adversarial tool_calls arrays", () => {
    const calls = Array.from({ length: 120 }, (_, i) => ({ nope: i }));
    const { warnings, result } = normalizeChatResult({ content: "x", tool_calls: calls });
    expect(warnings.length).toBeLessThanOrEqual(50);
    expect((result.tool_calls ?? []).length).toBeLessThanOrEqual(100);
  });

  test("oversized assistant content capped before history", () => {
    const big = "x".repeat(TOOL_RESULT_CAP_CHARS + 1000);
    const { result } = normalizeChatResult({ content: big });
    expect(typeof result.content === "string" && result.content.length).toBeLessThanOrEqual(
      TOOL_RESULT_CAP_CHARS + 200
    );
  });
});

describe("1F: shell mutations invalidate the read cache", () => {
  test("non-readonly bash clears stale read entries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-cache-"));
    try {
      const file = path.join(dir, "note.txt");
      fs.writeFileSync(file, "v1");
      const stat = fs.statSync(file);
      setCachedRead(file, 1, Number.MAX_SAFE_INTEGER, "v1", {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      }, "hash-v1");
      expect(
        getCachedRead(file, 1, Number.MAX_SAFE_INTEGER, { mtimeMs: stat.mtimeMs, size: stat.size })
      ).not.toBeNull();
      // A shell pipeline (metacharacters) is never provably read-only.
      await bashTool({ command: "echo test | cat" }, dir);
      expect(
        getCachedRead(file, 1, Number.MAX_SAFE_INTEGER, { mtimeMs: stat.mtimeMs, size: stat.size })
      ).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-only heuristic intact: bare builtins stay cached", () => {
    expect(isReadOnlyCommand("echo hi")).toBe(true);
    expect(isReadOnlyCommand("echo hi | cat")).toBe(false);
    expect(isReadOnlyCommand("node -e \"process.exit(0)\"")).toBe(false);
  });
});

describe("1H: abort-aware backoff", () => {
  test("already-aborted signal skips the wait", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const t0 = Date.now();
    await sleepOrCancel(async () => {
      await new Promise((r) => setTimeout(r, 5000));
    }, 5000, ctrl.signal);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("no signal behaves like a plain sleep", async () => {
    let waited = 0;
    await sleepOrCancel(async (ms: number) => {
      waited = ms;
    }, 1234, null);
    expect(waited).toBe(1234);
  });
});
