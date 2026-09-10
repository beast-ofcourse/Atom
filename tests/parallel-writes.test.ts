// Per-file parallel writes (issue 02): independent writes to different
// files execute concurrently in one batch while same-file mutations stay
// strictly ordered. Approvals resolve serially before execution; denials and
// stale-read refusals land inline without executing. No fetch, no repo
// writes — executors are injected fakes except the symlink probe, which
// uses a temp dir and skips when symlinks need privilege.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalFileKey } from "../src/scheduler.js";
import { clearTodos } from "../src/tools.js";
import {
  planToolBatches,
  runLoopWithChat,
  type AgenticOpts,
  type ChatMessage,
  type ChatResult,
  type ToolCall,
} from "../src/zen.js";

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

function scriptedChat(script: ChatResult[]) {
  let n = 0;
  return async (): Promise<ChatResult> => script[Math.min(n++, script.length - 1)]!;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function toolIds(history: ChatMessage[]): (string | undefined)[] {
  return history
    .filter((m) => m.role === "tool")
    .map((m) => (m as { tool_call_id?: string }).tool_call_id);
}

describe("canonicalFileKey", () => {
  test("empty, non-string, and null-byte targets are unknown (serial)", () => {
    expect(canonicalFileKey("")).toBeNull();
    expect(canonicalFileKey(undefined)).toBeNull();
    expect(canonicalFileKey(42)).toBeNull();
    expect(canonicalFileKey("a\0b")).toBeNull();
  });

  test("dotdot spellings share a key; different files do not", () => {
    expect(canonicalFileKey("sub/../a.txt")).toBe(canonicalFileKey("a.txt"));
    expect(canonicalFileKey("a.txt")).not.toBe(canonicalFileKey("b.txt"));
  });

  test("symlinked spellings resolve to the same file", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-mq-"));
    try {
      const real = path.join(dir, "real.md");
      const link = path.join(dir, "link.md");
      await fsp.writeFile(real, "x", "utf8");
      try {
        await fsp.symlink(real, link);
      } catch {
        return; // symlink creation needs privilege (Windows): skip
      }
      expect(canonicalFileKey(link)).toBe(canonicalFileKey(real));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("planToolBatches: per-file writes", () => {
  test("write + edit to disjoint files share one batch", () => {
    expect(
      batchIds(
        planToolBatches([
          call("a", "write", { path: "a.md", content: "x" }),
          call("b", "edit", { path: "b.md", oldString: "x", newString: "y" }),
        ])
      )
    ).toEqual([["a", "b"]]);
  });

  test("write/write, write/edit, and edit/edit on one file split in order", () => {
    const args = { content: "x" };
    expect(
      batchIds(planToolBatches([call("a", "write", { path: "f.md", ...args }), call("b", "write", { path: "f.md", content: "y" })]))
    ).toEqual([["a"], ["b"]]);
    expect(
      batchIds(
        planToolBatches([
          call("a", "write", { path: "f.md", content: "x" }),
          call("b", "edit", { path: "f.md", oldString: "x", newString: "y" }),
        ])
      )
    ).toEqual([["a"], ["b"]]);
    expect(
      batchIds(
        planToolBatches([
          call("a", "edit", { path: "f.md", oldString: "x", newString: "y" }),
          call("b", "edit", { path: "f.md", oldString: "y", newString: "z" }),
        ])
      )
    ).toEqual([["a"], ["b"]]);
  });

  test("write-after-read on one file splits; cross-file does not", () => {
    expect(
      batchIds(
        planToolBatches([
          call("a", "read", { path: "f.md" }),
          call("b", "write", { path: "f.md", content: "x" }),
        ])
      )
    ).toEqual([["a"], ["b"]]);
    expect(
      batchIds(
        planToolBatches([
          call("a", "read", { path: "f.md" }),
          call("b", "write", { path: "g.md", content: "x" }),
        ])
      )
    ).toEqual([["a", "b"]]);
  });

  test("bash between disjoint writes still splits everything", () => {
    expect(
      batchIds(
        planToolBatches([
          call("a", "write", { path: "a.md", content: "x" }),
          call("b", "bash", { command: "echo hi" }),
          call("c", "write", { path: "c.md", content: "y" }),
        ])
      )
    ).toEqual([["a"], ["b"], ["c"]]);
  });
});

describe("execution: per-file parallelism", () => {
  test("disjoint writes overlap in time and commit in call order", async () => {
    const events: string[] = [];
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c1", "write", { path: "a.md", content: "x" }),
            call("c2", "write", { path: "b.md", content: "y" }),
          ],
        },
        { content: "both written" },
      ]),
      history,
      {
        execute: async (_name, args) => {
          const p = String((args as Record<string, unknown>)["path"]);
          events.push(`start:${p}`);
          started += 1;
          if (started === 2) release();
          await Promise.race([
            gate,
            sleep(2000).then(() => {
              throw new Error("writes did not run concurrently");
            }),
          ]);
          events.push(`end:${p}`);
          return `wrote ${p}`;
        },
        sleep: async () => {},
      } satisfies AgenticOpts
    );
    expect(reply).toBe("both written");
    // Both started before either finished: genuine overlap, in call order.
    expect(events).toEqual(["start:a.md", "start:b.md", "end:a.md", "end:b.md"]);
    expect(toolIds(history)).toEqual(["c1", "c2"]);
    const tools = history.filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(tools.map((t) => t.content)).toEqual(["wrote a.md", "wrote b.md"]);
  });

  test("same-file writes never interleave (strict program order)", async () => {
    const events: string[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c1", "write", { path: "f.md", content: "one" }),
            call("c2", "write", { path: "f.md", content: "two" }),
          ],
        },
        { content: "done" },
      ]),
      history,
      {
        execute: async (_name, args) => {
          const c = String((args as Record<string, unknown>)["content"]);
          events.push(`start:${c}`);
          await sleep(30);
          events.push(`end:${c}`);
          return "ok";
        },
        sleep: async () => {},
      } satisfies AgenticOpts
    );
    expect(reply).toBe("done");
    expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
    expect(toolIds(history)).toEqual(["c1", "c2"]);
  });

  test("approvals resolve serially in order; denial lands inline unexecuted", async () => {
    const prompts: string[] = [];
    const executed: string[] = [];
    let approving = false;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c1", "write", { path: "a.md", content: "x" }),
            call("c2", "write", { path: "b.md", content: "y" }),
          ],
        },
        { content: "done" },
      ]),
      history,
      {
        execute: async (_name, args) => {
          executed.push(String((args as Record<string, unknown>)["path"]));
          return "ok";
        },
        approve: async (_name, args) => {
          // Concurrent prompts would overlap here: fail loudly if so.
          expect(approving).toBe(false);
          approving = true;
          await sleep(10);
          approving = false;
          const p = String((args as Record<string, unknown>)["path"]);
          prompts.push(p);
          return p === "a.md" ? "once" : "no";
        },
        sleep: async () => {},
      } satisfies AgenticOpts
    );
    expect(reply).toBe("done");
    expect(prompts).toEqual(["a.md", "b.md"]);
    expect(executed).toEqual(["a.md"]);
    const tools = history.filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(tools).toHaveLength(2);
    expect(tools[0]!.content).toBe("ok");
    expect(tools[1]!.content).toContain("denied by user");
    expect(toolIds(history)).toEqual(["c1", "c2"]);
  });

  test("cancel during the approval pre-pass runs nothing and commits nothing", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const history = baseHistory();
    await expect(
      runLoopWithChat(
        scriptedChat([
          {
            content: null,
            tool_calls: [
              call("c1", "write", { path: "a.md", content: "x" }),
              call("c2", "write", { path: "b.md", content: "y" }),
            ],
          },
        ]),
        history,
        {
          execute: async (_name, args) => {
            executed.push(String((args as Record<string, unknown>)["path"]));
            return "ok";
          },
          approve: async () => {
            controller.abort();
            await sleep(5);
            return "once" as const;
          },
          signal: controller.signal,
          sleep: async () => {},
        } satisfies AgenticOpts
      )
    ).rejects.toMatchObject({ name: "LoopCancelledError" });
    expect(executed).toEqual([]);
    expect(history.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  test("stale-read refusal commits inline without executing", async () => {
    const executed: string[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c1", "write", { path: "a.md", content: "x" }),
            call("c2", "edit", { path: "b.md", oldString: "x", newString: "y" }),
          ],
        },
        { content: "done" },
      ]),
      history,
      {
        execute: async (name, args) => {
          if (name === "edit") {
            return "Error: invalid call: stale read — b.md changed since you last read it. Read it again before editing. Fix the arguments and retry.";
          }
          executed.push(String((args as Record<string, unknown>)["path"]));
          return "ok";
        },
        sleep: async () => {},
      } satisfies AgenticOpts
    );
    expect(reply).toBe("done");
    expect(executed).toEqual(["a.md"]);
    const tools = history.filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(tools).toHaveLength(2);
    expect(tools[0]!.content).toBe("ok");
    expect(tools[1]!.content).toContain("stale read");
    expect(toolIds(history)).toEqual(["c1", "c2"]);
  });
});
