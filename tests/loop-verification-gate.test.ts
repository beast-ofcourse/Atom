// Verification gate (Task 7): "done" requires evidence. When files were
// written (write/edit executed successfully) and no bash test/typecheck/
// build command ran after the last write, the turn still ends but the
// result is labeled unverified — never silently accepted. Turns with no
// writes (questions, explanations, read-only work) are unaffected. No
// fetch, no repo writes — the chatFn is scripted and todo state is the
// real module-global list (vitest isolates files, so each test file seeds
// its own state; every test here runs with a clean list so the Task 3
// todo guard stays out of the way).
import { afterEach, describe, expect, test } from "vitest";
import {
  runLoopWithChat,
  type AgenticOpts,
  type ChatMessage,
  type ChatResult,
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

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function scriptedChat(script: ChatResult[]) {
  let n = 0;
  return async (_h: ChatMessage[], _o?: AgenticOpts): Promise<ChatResult> =>
    script[Math.min(n++, script.length - 1)]!;
}

const WRITE = { path: "a.txt", content: "hi" };

describe("verification gate", () => {
  test("write executes, final text, no bash test call → unverified flag appended", async () => {
    const phases: string[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([toolCall("w1", "write", WRITE), { content: "done, all tests pass" }]),
      history,
      { execute: async () => "ok", sleep: async () => {}, onPhase: (p) => void phases.push(p) }
    );
    // The turn still ends (never blocked) but the claim is labeled.
    expect(reply).toContain("done, all tests pass");
    expect(reply).toContain("(unverified:");
    expect(reply).toContain("npm test");
    expect(reply).toContain("npm run typecheck");
    // History matches the return, phase contract intact.
    expect(history.at(-1)).toEqual({ role: "assistant", content: reply });
    expect(phases).toContain("done");
  });

  test("edit arms the gate the same way write does", async () => {
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        toolCall("e1", "edit", { path: "a.txt", oldString: "x", newString: "y" }),
        { content: "done" },
      ]),
      history,
      { execute: async () => "ok", sleep: async () => {} }
    );
    expect(reply).toContain("(unverified:");
  });

  test("write then bash test command then final → returned clean, no flag", async () => {
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        toolCall("w1", "write", WRITE),
        toolCall("b1", "bash", { command: "npm test" }),
        { content: "done, tests pass" },
      ]),
      history,
      { execute: async () => "ok", sleep: async () => {} }
    );
    expect(reply).toBe("done, tests pass");
  });

  test("write then tsc typecheck then final → returned clean, no flag", async () => {
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        toolCall("w1", "write", WRITE),
        toolCall("b1", "bash", { command: "npx tsc --noEmit" }),
        { content: "done, typecheck clean" },
      ]),
      history,
      { execute: async () => "ok", sleep: async () => {} }
    );
    expect(reply).toBe("done, typecheck clean");
  });

  test("bash test BEFORE the write does not count — order matters", async () => {
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        toolCall("b1", "bash", { command: "npm test" }),
        toolCall("w1", "write", WRITE),
        { content: "done" },
      ]),
      history,
      { execute: async () => "ok", sleep: async () => {} }
    );
    expect(reply).toContain("(unverified:");
  });

  test("non-test bash after the write does not clear the gate", async () => {
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        toolCall("w1", "write", WRITE),
        toolCall("b1", "bash", { command: "ls -la" }),
        { content: "done" },
      ]),
      history,
      { execute: async () => "ok", sleep: async () => {} }
    );
    expect(reply).toContain("(unverified:");
  });

  test("pure Q&A (no tools at all) → unchanged behavior, no flag", async () => {
    const phases: string[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(scriptedChat([{ content: "just an answer" }]), history, {
      sleep: async () => {},
      onPhase: (p) => void phases.push(p),
    });
    expect(reply).toBe("just an answer");
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(phases).toContain("done");
  });

  test("read-only tools (glob) + final → unchanged behavior, no flag", async () => {
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([toolCall("g1", "glob", { pattern: "*.ts" }), { content: "found a.ts" }]),
      history,
      { execute: async () => "tool-result", sleep: async () => {} }
    );
    expect(reply).toBe("found a.ts");
  });

  test("denied write + final → no flag (nothing was written)", async () => {
    const history = baseHistory();
    let executed = 0;
    const reply = await runLoopWithChat(
      scriptedChat([toolCall("w1", "write", WRITE), { content: "understood, denied" }]),
      history,
      {
        approve: async () => "no",
        execute: async () => {
          executed += 1;
          return "should-not-run-after-deny";
        },
        sleep: async () => {},
      }
    );
    expect(reply).toBe("understood, denied");
    expect(executed).toBe(0);
  });

  test("invalid write args + final → no flag (the tool never ran)", async () => {
    const history = baseHistory();
    let executed = 0;
    const reply = await runLoopWithChat(
      scriptedChat([toolCall("w1", "write", { path: "a.txt" }), { content: "noted" }]),
      history,
      {
        execute: async () => {
          executed += 1;
          return "should-not-run";
        },
        sleep: async () => {},
      }
    );
    expect(reply).toBe("noted");
    expect(executed).toBe(0);
  });
});
