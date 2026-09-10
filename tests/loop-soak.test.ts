// Long-session soak + multi-step task test: a full explore → plan →
// implement → verify → report arc through the REAL loop and REAL executors
// (tmp dir, no network, no TUI). Exercises: todowrite/todo_update guard,
// write-denial recovery, malformed + unknown tool results, ask_question hook,
// parallel read batches, the verification gate after a code write, read-cache
// hits on re-reads, pairing integrity across ~18 tool rounds, and LoopStats.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearTodos,
  executeTool,
  getTodos,
} from "../src/tools.js";
import {
  clearReadCache,
  getReadCacheStats,
  resetReadCacheStats,
} from "../src/tools/read-cache.js";
import {
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
  type LoopStats,
} from "../src/zen.js";

afterEach(() => {
  clearTodos();
  clearReadCache();
  resetReadCacheStats();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "implement the feature" },
  ];
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function seedFixtures(dir: string): void {
  writeFileSync(path.join(dir, "main.ts"), "export const main = 1;\n", "utf8");
  writeFileSync(path.join(dir, "util.ts"), "export const util = 2;\n", "utf8");
  writeFileSync(path.join(dir, "README.md"), "# demo\n", "utf8");
}

describe("long-session soak: explore → implement → verify", () => {
  test("18-round arc completes verified with pairing intact and sane stats", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atom-soak-"));
    try {
      seedFixtures(dir);
      clearReadCache();
      resetReadCacheStats();
      const history = baseHistory();
      const queue: ChatResult[] = [
        // 1. plan the work
        toolCall("t1", "todowrite", {
          todos: [
            { content: "Explore sources", status: "in_progress" },
            { content: "Implement feature", status: "pending" },
            { content: "Verify and report", status: "pending" },
          ],
        }),
        // 2-3. explore in parallel batches (glob+grep batch; read+read batch)
        {
          content: null,
          tool_calls: [
            { id: "t2a", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } },
            { id: "t2b", type: "function", function: { name: "grep", arguments: '{"pattern":"export"}' } },
          ],
        },
        {
          content: null,
          tool_calls: [
            { id: "t3a", type: "function", function: { name: "read", arguments: '{"path":"main.ts"}' } },
            { id: "t3b", type: "function", function: { name: "read", arguments: '{"path":"util.ts"}' } },
          ],
        },
        // 4. malformed args (invalid JSON) — inline error, block continues
        { content: null, tool_calls: [{ id: "t4", type: "function", function: { name: "read", arguments: "not-json{{{" } }] },
        // 5. unknown tool — listed error, never executes
        toolCall("t5", "frobnicate", { x: 1 }),
        // 6. write denied once (approval hook) — model must replan, not retry blindly
        toolCall("t6", "write", { path: "feature.ts", content: "export const f = 1;\n" }),
        // 7. write allowed on the re-attempt — arms the verification gate (.ts)
        toolCall("t7", "write", { path: "feature.ts", content: "export const f = 1;\n" }),
        // 8. ask which test command to run (hook) — exercises ask_question
        toolCall("t8", "ask_question", { question: "Which check?", options: ["quick echo", "full suite"] }),
        // 9. run the check — heuristic verification command, exit 0 clears the gate
        toolCall("t9", "bash", { command: "echo vitest pass" }),
        // 10. re-read main.ts — identical args+unchanged file → read-cache hit
        toolCall("t10", "read", { path: "main.ts" }),
        // 11-16. march the checklist shut via updates
        toolCall("t11", "todo_update", { index: 1, status: "completed" }),
        toolCall("t12", "todo_update", { index: 2, status: "in_progress" }),
        toolCall("t13", "todo_update", { index: 2, status: "completed" }),
        toolCall("t14", "todo_update", { index: 3, status: "in_progress" }),
        toolCall("t15", "todo_update", { index: 3, status: "completed" }),
        // 17. progress the plan item state (second todowrite replaces cleanly)
        toolCall("t16", "todowrite", { todos: [] }),
        { content: "done: feature implemented and verified" },
      ];
      let posts = 0;
      const warnings: string[] = [];
      let writeAttempts = 0;
      let stats: LoopStats | null = null;
      const reply = await runLoopWithChat(
        async () => {
          posts += 1;
          return queue.length > 1 ? queue.shift()! : queue[queue.length - 1]!;
        },
        history,
        {
          execute: (name, args) => executeTool(name, args, dir),
          askUser: async () => "quick echo",
          approve: async (name) => {
            if (name === "write") {
              writeAttempts += 1;
              return writeAttempts === 1 ? "no" : "once";
            }
            return "once";
          },
          onWarning: (m) => void warnings.push(m),
          onLoopStats: (s) => {
            stats = s;
          },
          sleep: async () => {},
        }
      );
      expect(reply).toBe("done: feature implemented and verified");
      // Session state: checklist fully resolved, feature on disk.
      expect(getTodos()).toEqual([]);
      // Pairing: every assistant tool_call has exactly one tool result.
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
      expect(calls.size).toBe(18);
      // One POST per scripted round (16 tool rounds + final answer).
      expect(posts).toBe(17);
      // Failures observed AND recovered from (bad JSON, unknown, denial).
      const toolContents = history
        .filter((m) => m.role === "tool")
        .map((m) => String((m as { content: string }).content));
      expect(toolContents.some((c) => c.includes("invalid JSON"))).toBe(true);
      expect(toolContents.some((c) => c.includes("unknown tool"))).toBe(true);
      expect(toolContents.some((c) => c.includes("denied by user"))).toBe(true);
      expect(toolContents.some((c) => c.includes('"answer"'))).toBe(true);
      // No truncation/intervention noise on a healthy run.
      expect(warnings).toEqual([]);
      // Stats sanity.
      expect(stats).not.toBeNull();
      const s = stats as unknown as LoopStats;
      expect(s.modelCalls).toBe(17);
      expect(s.toolCalls).toBe(18);
      expect(s.failures).toBe(3);
      expect(s.steps).toBe(17);
      expect(s.bottleneck?.name.length).toBeGreaterThan(0);
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof s.contextGrowthChars).toBe("number");
      // The re-read was served from cache (same path+window, file untouched).
      expect(getReadCacheStats().hits).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("todo guard refuses to end on open todos, then finishes when resolved", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atom-soak-todo-"));
    try {
      seedFixtures(dir);
      const history = baseHistory();
      const queue: ChatResult[] = [
        toolCall("t1", "todowrite", { todos: [{ content: "Only task", status: "in_progress" }] }),
        { content: "trying to end early" }, // guard must continue, not end
        toolCall("t2", "todo_update", { index: 1, status: "completed" }),
        { content: "really done" },
      ];
      let posts = 0;
      const reply = await runLoopWithChat(
        async () => {
          posts += 1;
          return queue.length > 1 ? queue.shift()! : queue[queue.length - 1]!;
        },
        history,
        { execute: (name, args) => executeTool(name, args, dir), sleep: async () => {} }
      );
      expect(reply).toBe("really done");
      expect(posts).toBe(4);
      expect(JSON.stringify(history)).toContain("todo guard");
      expect(getTodos()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
