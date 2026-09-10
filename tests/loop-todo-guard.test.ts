// Todo-completion guard (Task 3): the loop may not end with final text
// while todos are open. Open todos + final-text attempt → the loop feeds
// back a guard message listing the open items and continues; clean list +
// final text → behavior unchanged. No fetch, no repo writes — the chatFn is
// scripted and todo state is the real module-global list (vitest isolates
// files, so each test seeds its own list first).
import { afterEach, describe, expect, test } from "vitest";
import {
  runLoopWithChat,
  type AgenticOpts,
  type ChatMessage,
  type ChatResult,
} from "../src/zen.js";
import { clearTodos, getTodos, todowriteTool } from "../src/tools.js";

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

// Every {role:"tool"} message must pair with an assistant tool_calls id —
// the guard injects only assistant(text) + user messages, so it can never
// orphan a tool result.
function expectPairingValid(history: ChatMessage[]): void {
  const ids = new Set<string>();
  for (const m of history) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) ids.add(c.id);
    }
  }
  for (const m of history) {
    if (m.role === "tool") expect(ids.has(m.tool_call_id)).toBe(true);
  }
}

describe("todo-completion guard", () => {
  test("open todos + final-text attempt → guard fires and the loop continues", async () => {
    await todowriteTool({
      todos: [
        { content: "Write the feature", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ],
    });
    const script: ChatResult[] = [
      { content: "early answer" },
      toolCall("c1", "todo_update", { index: 1, status: "completed" }),
      toolCall("c2", "todo_update", { index: 2, status: "completed" }),
      { content: "all done" },
    ];
    let n = 0;
    const phases: string[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (h: ChatMessage[], _o?: AgenticOpts) => script[Math.min(n++, script.length - 1)]!,
      history,
      { sleep: async () => {}, onPhase: (p) => void phases.push(p) }
    );
    // The model's first final text is NOT the turn result — the loop
    // continued through the todo tools to the verified finish.
    expect(reply).toBe("all done");
    expect(n).toBe(4);
    expect(getTodos()).toEqual([]);
    // The guard message names the open items so the model can resume.
    const guard = history.find(
      (m) => m.role === "user" && String((m as { content: string }).content).includes("todo guard")
    );
    expect(guard).toBeDefined();
    expect(String((guard as { content: string }).content)).toContain("Write the feature");
    expect(String((guard as { content: string }).content)).toContain("Run the tests");
    // The premature attempt stays in history for evidence, pairing intact.
    expect(history.filter((m) => m.role === "assistant").map((m) => (m as { content?: string }).content)).toContain(
      "early answer"
    );
    expectPairingValid(history);
    expect(phases).toContain("done");
  });

  test("open todos + spent step budget → blocked statement naming the items", async () => {
    await todowriteTool({
      todos: [{ content: "Finish the migration", status: "in_progress" }],
    });
    let n = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (_h: ChatMessage[], _o?: AgenticOpts) => {
        n += 1;
        return { content: "early answer" };
      },
      history,
      { sleep: async () => {}, maxSteps: 0 }
    );
    expect(n).toBe(1);
    expect(reply).toContain("(blocked:");
    expect(reply).toContain("Finish the migration");
    expectPairingValid(history);
  });

  test("model that never resolves todos ends blocked after bounded guard rounds", async () => {
    await todowriteTool({
      todos: [{ content: "Never resolving this", status: "in_progress" }],
    });
    let n = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (_h: ChatMessage[], _o?: AgenticOpts) => {
        n += 1;
        return { content: "still done (not really)" };
      },
      history,
      { sleep: async () => {} }
    );
    // Terminates without any step cap: guard rounds bounded, then blocked.
    expect(n).toBe(4); // 1 initial + 3 guard rounds
    expect(reply).toContain("(blocked:");
    expect(reply).toContain("Never resolving this");
    expectPairingValid(history);
  });

  test("clean list + final text → unchanged behavior (single POST, text returned)", async () => {    await todowriteTool({ todos: [] });
    let n = 0;
    const phases: string[] = [];
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (_h: ChatMessage[], _o?: AgenticOpts) => {
        n += 1;
        return { content: "just an answer" };
      },
      history,
      { sleep: async () => {}, onPhase: (p) => void phases.push(p) }
    );
    expect(reply).toBe("just an answer");
    expect(n).toBe(1);
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(phases).toContain("done");
  });
});
