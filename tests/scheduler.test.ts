// Effect-aware scheduler tests: metadata-driven batching with the
// per-file contract pinned — reads batch, disjoint-file writes batch,
// same-file mutations/process/interactive stay serial, commits stay
// ordered, cancel aborts without partial commits.
// Planner unit tests run against src/scheduler.ts directly; ordering and
// cancellation run end-to-end through runLoopWithChat (execution untouched).
import { afterEach, describe, expect, test } from "vitest";
import {
  TOOL_EFFECTS,
  planBatches,
  type SchedulableCall,
} from "../src/scheduler.js";
import { TOOL_DEFINITIONS } from "../src/tools.js";
import {
  clearDirListingCache,
  getRealpathCacheStats,
  resetRealpathCacheStats,
} from "../src/tools.js";
import {
  runLoopWithChat,
  type AgenticOpts,
  type ChatMessage,
  type ChatResult,
  type ToolCall,
} from "../src/zen.js";

function call(id: string, name: string, args: Record<string, unknown> | string): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

function batchIds(batches: { call: SchedulableCall }[][]): (string | undefined)[][] {
  return batches.map((b) => b.map((m) => m.call.id as string | undefined));
}

describe("TOOL_EFFECTS completeness", () => {
  test("every known tool declares effects (missing metadata must be explicit)", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(TOOL_EFFECTS[name], `tool "${name}" lacks effect metadata`).toBeDefined();
    }
  });

  test("effect spot checks: writes mutate, bash spawns globally, interactive/exclusive serialize", () => {
    expect(TOOL_EFFECTS["write"]?.filesystem).toBe("write");
    expect(TOOL_EFFECTS["edit"]?.filesystem).toBe("write");
    expect(TOOL_EFFECTS["bash"]).toMatchObject({
      filesystem: "write",
      network: "write",
      process: "spawn",
    });
    expect(TOOL_EFFECTS["ask_question"]?.interactive).toBe(true);
    expect(TOOL_EFFECTS["todowrite"]?.exclusive).toBe(true);
    expect(TOOL_EFFECTS["todo_update"]?.exclusive).toBe(true);
    expect(TOOL_EFFECTS["todo_get"]?.exclusive).toBe(true);
    expect(TOOL_EFFECTS["read"]?.filesystem).toBe("read");
    expect(TOOL_EFFECTS["webfetch"]?.network).toBe("read");
    expect(TOOL_EFFECTS["websearch"]?.network).toBe("read");
  });
});

describe("planBatches: reads", () => {
  test("independent filesystem + network reads batch together", () => {
    expect(
      batchIds(
        planBatches([
          call("a", "read", { path: "a.txt" }),
          call("b", "read", { path: "b.txt" }),
          call("c", "grep", { pattern: "foo" }),
          call("d", "webfetch", { url: "https://example.com/x" }),
          call("e", "websearch", { query: "bar" }),
        ])
      )
    ).toEqual([["a", "b", "c", "d", "e"]]);
  });

  test("same tool + same target batches (reads never race each other)", () => {
    expect(
      batchIds(planBatches([call("a", "read", { path: "a.txt" }), call("b", "read", { path: "a.txt" })]))
    ).toEqual([["a", "b"]]);
    expect(
      batchIds(
        planBatches([
          call("a", "webfetch", { url: "https://example.com/" }),
          call("b", "webfetch", { url: "https://example.com/" }),
        ])
      )
    ).toEqual([["a", "b"]]);
  });

  test("different tools over the same string are disjoint read footprints", () => {
    expect(
      batchIds(planBatches([call("a", "read", { path: "x" }), call("b", "grep", { pattern: "x" })]))
    ).toEqual([["a", "b"]]);
  });
});

describe("planBatches: writes batch per file", () => {
  test("read + write on the same path stay serial in order", () => {
    expect(
      batchIds(
        planBatches([
          call("a", "read", { path: "a.txt" }),
          call("b", "write", { path: "a.txt", content: "x" }),
          call("c", "read", { path: "a.txt" }),
        ])
      )
    ).toEqual([["a"], ["b"], ["c"]]);
  });

  test("disjoint files batch together: reads, writes, and edits in one batch", () => {
    expect(
      batchIds(
        planBatches([
          call("a", "read", { path: "a.txt" }),
          call("b", "write", { path: "b.txt", content: "x" }),
          call("c", "read", { path: "c.txt" }),
          call("d", "edit", { path: "d.txt", oldString: "x", newString: "y" }),
        ])
      )
    ).toEqual([["a", "b", "c", "d"]]);
  });

  test("multiple writes to disjoint files batch; same-file repeats split", () => {
    expect(
      batchIds(
        planBatches([
          call("a", "write", { path: "a.txt", content: "x" }),
          call("b", "edit", { path: "b.txt", oldString: "x", newString: "y" }),
          call("c", "write", { path: "c.txt", content: "z" }),
        ])
      )
    ).toEqual([["a", "b", "c"]]);
    expect(
      batchIds(
        planBatches([
          call("a", "write", { path: "a.txt", content: "x" }),
          call("b", "write", { path: "a.txt", content: "y" }),
        ])
      )
    ).toEqual([["a"], ["b"]]);
  });

  test("dotdot spellings resolve to the same file and split", () => {
    expect(
      batchIds(
        planBatches([
          call("a", "write", { path: "sub/../a.txt", content: "x" }),
          call("b", "write", { path: "a.txt", content: "y" }),
        ])
      )
    ).toEqual([["a"], ["b"]]);
  });
});

describe("planBatches: process, interactive, ambient state", () => {
  test("bash splits batchable reads around it (global spawn conflict)", () => {
    expect(
      batchIds(
        planBatches([
          call("a", "read", { path: "a.txt" }),
          call("b", "bash", { command: "ls" }),
          call("c", "read", { path: "c.txt" }),
        ])
      )
    ).toEqual([["a"], ["b"], ["c"]]);
  });

  test("bash_output batches across and within tasks (concurrent polls are side-effect-free)", () => {
    expect(
      batchIds(
        planBatches([
          call("a", "bash_output", { taskId: "t1" }),
          call("b", "bash_output", { taskId: "t2" }),
        ])
      )
    ).toEqual([["a", "b"]]);
    expect(
      batchIds(
        planBatches([
          call("a", "bash_output", { taskId: "t1" }),
          call("b", "bash_output", { taskId: "t1" }),
        ])
      )
    ).toEqual([["a", "b"]]);
  });

  test("ask_question, todos, unknown, malformed, and invalid calls stay serial", () => {
    const calls = [
      call("a", "ask_question", { question: "q?", options: ["x", "y"] }),
      call("b", "todowrite", { todos: [] }),
      call("c", "todo_update", { index: 1, status: "completed" }),
      call("d", "todo_get", {}),
      call("e", "nope", {}),
      call("f", "read", {}), // failed validation
      call("g", "read", "not-json{{{"),
    ];
    expect(batchIds(planBatches(calls)).map((b) => b.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  test("empty block plans no batches", () => {
    expect(planBatches([])).toEqual([]);
  });
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];
}

function scriptedChat(script: ChatResult[]) {
  let n = 0;
  return async (): Promise<ChatResult> => script[Math.min(n++, script.length - 1)]!;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("execution: ordering", () => {
  test("staggered batch completion still commits in call order", async () => {
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c1", "read", { path: "slow.txt" }),
            call("c2", "read", { path: "fast.txt" }),
          ],
        },
        { content: "done" },
      ]),
      history,
      {
        execute: async (name, args) => {
          const p = String((args as Record<string, unknown>)["path"]);
          // Slow call first, fast call second: completion order is inverted.
          await sleep(p === "slow.txt" ? 120 : 10);
          return `content-of-${p}`;
        },
        sleep: async () => {},
      } satisfies AgenticOpts
    );
    expect(reply).toBe("done");
    const tools = history.filter((m) => m.role === "tool") as Array<{
      tool_call_id: string;
      content: string;
    }>;
    expect(tools.map((t) => t.tool_call_id)).toEqual(["c1", "c2"]);
    expect(tools.map((t) => t.content)).toEqual(["content-of-slow.txt", "content-of-fast.txt"]);
  });
});

describe("execution: cancellation", () => {
  test("pre-aborted signal runs nothing and rejects with LoopCancelledError", async () => {
    const history = baseHistory();
    const started: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      runLoopWithChat(
        scriptedChat([
          {
            content: null,
            tool_calls: [
              call("c1", "read", { path: "a.txt" }),
              call("c2", "read", { path: "b.txt" }),
            ],
          },
        ]),
        history,
        {
          execute: async (name, args) => {
            started.push(String((args as Record<string, unknown>)["path"]));
            return "x";
          },
          sleep: async () => {},
          signal: controller.signal,
        } satisfies AgenticOpts
      )
    ).rejects.toMatchObject({ name: "LoopCancelledError" });
    expect(started).toEqual([]);
    expect(history.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  test("mid-batch cancel aborts the turn with no partial commits", async () => {
    const history = baseHistory();
    const events: string[] = [];
    await expect(
      runLoopWithChat(
        scriptedChat([
          {
            content: null,
            tool_calls: [
              call("c1", "read", { path: "a.txt" }),
              call("c2", "read", { path: "b.txt" }),
            ],
          },
        ]),
        history,
        {
          execute: async (name, args) => {
            const p = String((args as Record<string, unknown>)["path"]);
            events.push(`start:${p}`);
            await sleep(20);
            if (p === "b.txt") {
              // Cancellation landing mid-batch: converted to LoopCancelledError.
              throw new DOMException("This operation was aborted", "AbortError");
            }
            events.push(`end:${p}`);
            return "x";
          },
          sleep: async () => {},
        } satisfies AgenticOpts
      )
    ).rejects.toMatchObject({ name: "LoopCancelledError" });
    // Both started (Promise.all), the finished one's result is discarded —
    // the caller rolls the partial turn back, pairing stays valid.
    expect(events).toEqual(["start:a.txt", "start:b.txt", "end:a.txt"]);
    expect(history.filter((m) => m.role === "tool")).toHaveLength(0);
  });
});

describe("realpath cache (2B.1)", () => {
  test("repeat write plans hit the cache; invalidation re-resolves", () => {
    const writes = [
      call("w1", "write", { path: "plan-cache-a.txt", content: "x" }),
      call("w2", "write", { path: "plan-cache-b.txt", content: "y" }),
    ];
    clearDirListingCache();
    resetRealpathCacheStats();
    planBatches(writes);
    const first = getRealpathCacheStats();
    expect(first.misses).toBe(2);
    planBatches(writes);
    const second = getRealpathCacheStats();
    // Same targets, warm cache: zero new resolutions.
    expect(second.misses).toBe(first.misses);
    expect(second.hits).toBe(first.hits + 2);
    clearDirListingCache();
    planBatches(writes);
    expect(getRealpathCacheStats().misses).toBe(first.misses + 2);
  });

  test("planned members carry index + malformed (no indexOf downstream)", () => {
    const batches = planBatches([
      call("c1", "read", { path: "a.txt" }),
      call("c2", "read", "not-json{{{"),
    ]);
    const flat = batches.flat();
    expect(flat.map((m) => m.index)).toEqual([0, 1]);
    expect(flat.map((m) => m.malformed)).toEqual([false, true]);
    expect(flat[1]!.parsed).toEqual({});
  });
});

afterEach(() => {
  // No global state touched (no todos, no fetch mocking in this file).
});
