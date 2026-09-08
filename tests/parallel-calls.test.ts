// Parallel independent tool calls (ticket 05, blocked by 03): read-only,
// non-overlapping calls in one model turn execute concurrently (~1x instead
// of ~Nx) with results re-paired in call order; writes, approval-gated
// tools, and overlapping paths stay strictly serial.
import { afterEach, describe, expect, test } from "vitest";
import {
  planToolBatches,
  runLoopWithChat,
  type AgenticOpts,
  type ChatMessage,
  type ChatResult,
  type ToolCall,
} from "../src/zen.js";
import { clearTodos } from "../src/tools.js";

afterEach(() => {
  clearTodos();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];
}

function call(id: string, name: string, args: Record<string, unknown> | string): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

function batchIds(batches: ReturnType<typeof planToolBatches>): string[][] {
  return batches.map((b) => b.map((m) => m.call.id));
}

describe("planToolBatches", () => {
  test("disjoint reads batch together", () => {
    expect(
      batchIds(planToolBatches([call("a", "read", { path: "a.txt" }), call("b", "read", { path: "b.txt" })]))
    ).toEqual([["a", "b"]]);
  });

  test("mixed read-only tools batch together", () => {
    const calls = [
      call("a", "read", { path: "a.txt" }),
      call("b", "glob", { pattern: "*.ts" }),
      call("c", "grep", { pattern: "foo" }),
      call("d", "webfetch", { url: "https://example.com/x" }),
      call("e", "websearch", { query: "bar" }),
      call("f", "bash_output", { taskId: "t1" }),
    ];
    expect(batchIds(planToolBatches(calls))).toEqual([["a", "b", "c", "d", "e", "f"]]);
  });

  test("same tool + same target serializes (overlap)", () => {
    expect(
      batchIds(planToolBatches([call("a", "read", { path: "a.txt" }), call("b", "read", { path: "a.txt" })]))
    ).toEqual([["a"], ["b"]]);
  });

  test("write splits the block: read-after-write stays ordered", () => {
    expect(
      batchIds(
        planToolBatches([
          call("a", "read", { path: "a.txt" }),
          call("b", "write", { path: "b.txt", content: "x" }),
          call("c", "read", { path: "c.txt" }),
        ])
      )
    ).toEqual([["a"], ["b"], ["c"]]);
  });

  test("approval tools, ask_question, todo writes, unknown, and invalid calls stay serial", () => {
    const calls = [
      call("a", "bash", { command: "ls" }),
      call("b", "edit", { path: "a", oldString: "x", newString: "y" }),
      call("c", "ask_question", { question: "q?", options: ["a"] }),
      call("d", "todo_update", { index: 1, status: "completed" }),
      call("e", "todowrite", { todos: [] }),
      call("f", "nope", {}),
      call("g", "read", {}), // failed validation
      call("h", "read", "not-json{{{"),
    ];
    expect(batchIds(planToolBatches(calls)).map((b) => b.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  test("empty block plans no batches", () => {
    expect(planToolBatches([])).toEqual([]);
  });
});

function scriptedChat(script: ChatResult[]) {
  let n = 0;
  return async (): Promise<ChatResult> => script[Math.min(n++, script.length - 1)]!;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("parallel execution", () => {
  test("three disjoint reads complete in ~1x single-call time, re-paired in order", async () => {
    const started: string[] = [];
    const history = baseHistory();
    const labels: string[] = [];
    const t0 = Date.now();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c1", "read", { path: "a.txt" }),
            call("c2", "read", { path: "b.txt" }),
            call("c3", "read", { path: "c.txt" }),
          ],
        },
        { content: "all three read" },
      ]),
      history,
      {
        execute: async (name, args) => {
          started.push(String((args as Record<string, unknown>)["path"]));
          await sleep(200);
          return `content-of-${String((args as Record<string, unknown>)["path"])}`;
        },
        onToolActivity: (label) => void labels.push(label),
        sleep: async () => {},
      } satisfies AgenticOpts
    );
    const wall = Date.now() - t0;
    expect(reply).toBe("all three read");
    // Serial floor is 600ms; parallel hovers near 200ms. 400ms tolerates
    // loaded CI in both directions.
    expect(wall).toBeLessThan(400);
    // All three started (in call order) and each result re-paired by id.
    expect(started).toEqual(["a.txt", "b.txt", "c.txt"]);
    const tools = history.filter((m) => m.role === "tool") as Array<{ tool_call_id: string; content: string }>;
    expect(tools.map((t) => t.tool_call_id)).toEqual(["c1", "c2", "c3"]);
    expect(tools.map((t) => t.content)).toEqual(["content-of-a.txt", "content-of-b.txt", "content-of-c.txt"]);
    // The transcript shows each call separately, in order.
    expect(labels).toEqual(["⚙ read a.txt", "⚙ read b.txt", "⚙ read c.txt"]);
  });

  test("overlapping reads stay strictly serial (first ends before second starts)", async () => {
    const events: string[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [call("c1", "read", { path: "a.txt" }), call("c2", "read", { path: "a.txt" })],
        },
        { content: "done" },
      ]),
      history,
      {
        execute: async (name, args) => {
          const p = String((args as Record<string, unknown>)["path"]);
          events.push(`start:${p}`);
          await sleep(50);
          events.push(`end:${p}`);
          return "x";
        },
        sleep: async () => {},
      } satisfies AgenticOpts
    );
    expect(reply).toBe("done");
    expect(events).toEqual(["start:a.txt", "end:a.txt", "start:a.txt", "end:a.txt"]);
  });

  test("write + surrounding reads stay strictly serial in program order", async () => {
    const events: string[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c1", "read", { path: "a.txt" }),
            call("c2", "write", { path: "b.txt", content: "x" }),
            call("c3", "read", { path: "c.txt" }),
          ],
        },
        { content: "done" },
      ]),
      history,
      {
        execute: async (name, args) => {
          const tag = name === "write" ? "write:b.txt" : `read:${String((args as Record<string, unknown>)["path"])}`;
          events.push(`start:${tag}`);
          await sleep(20);
          events.push(`end:${tag}`);
          return "ok";
        },
        sleep: async () => {},
      } satisfies AgenticOpts
    );
    expect(reply).toContain("done");
    // The write still arms the verification gate through the batched path.
    expect(reply).toContain("(unverified:");
    expect(events).toEqual([
      "start:read:a.txt",
      "end:read:a.txt",
      "start:write:b.txt",
      "end:write:b.txt",
      "start:read:c.txt",
      "end:read:c.txt",
    ]);
  });
});
