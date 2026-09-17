// Ticket 06: intercepted tools are first-class registry entries — schema,
// validator, and executor in one place — and the loop dispatches everything
// through the registry with no name checks. These tests pin the single
// source: one list drives model visibility (allToolDefinitions) and
// executability (toolNames + runInterceptedTool + the pipeline gate).
import { describe, expect, test, vi } from "vitest";
import {
  allToolDefinitions,
  APPROVAL_TOOLS,
  executeTool,
  isCustomTool,
  isInterceptedTool,
  needsApproval,
  registerExtensionTool,
  runInterceptedTool,
  toolNames,
  TOOL_DEFINITIONS,
  UPDATE_GOAL_TOOL_DEFINITION,
  validateToolArgs,
} from "../src/tools.js";
import { planToolCall, runPlannedToolCall } from "../src/agent/tool-pipeline.js";
import { planBatches } from "../src/scheduler.js";
import { runLoopWithChat, type ChatMessage, type ChatResult, type ToolCall } from "../src/zen.js";

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const ASK = { question: "Which?", options: ["A", "B"] };
const REPORT = { status: "continue", next: "Probe X" };

describe("one list drives visibility and executability", () => {
  test("toolNames and allToolDefinitions agree on the builtin set, incl. intercepted tools", () => {
    const builtinKnown = toolNames().filter((n) => !isCustomTool(n)).sort();
    const builtinVisible = allToolDefinitions()
      .map((t) => t.function.name)
      .filter((n) => !isCustomTool(n))
      .sort();
    expect(builtinVisible).toEqual(builtinKnown);
    expect(builtinKnown).toContain("ask_question");
    expect(builtinKnown).toContain("update_goal");
  });

  test("TOOL_DEFINITIONS stays 13 executor builtins; update_goal lives beside them as intercepted", () => {
    // Ticket 06: the 13-entry pin holds (scheduler-effects completeness and
    // the executor dispatch both key off it); update_goal's schema is the
    // exported registry definition, which is also what the model sees.
    expect(TOOL_DEFINITIONS).toHaveLength(13);
    expect(TOOL_DEFINITIONS.map((t) => t.function.name)).not.toContain("update_goal");
    expect(UPDATE_GOAL_TOOL_DEFINITION.function.name).toBe("update_goal");
    expect(
      allToolDefinitions().find((t) => t.function.name === "update_goal")
    ).toBe(UPDATE_GOAL_TOOL_DEFINITION);
  });

  test("a name hidden from the registry is rejected by schema AND execution consistently", async () => {
    const name = "frobnicate_no_such_tool";
    expect(toolNames()).not.toContain(name);
    expect(allToolDefinitions().some((t) => t.function.name === name)).toBe(false);
    expect(isInterceptedTool(name)).toBe(false);
    const execute = vi.fn(async () => "must-not-run");
    const { plan } = await planToolCall(name, {}, undefined);
    expect(plan.unknown).toMatch(/^Error: unknown tool/);
    const outcome = await runPlannedToolCall(call("c1", name, {}), plan, null, undefined, execute);
    expect(outcome.decision).toBe("unknown-tool");
    expect(outcome.result).toMatch(/^Error: unknown tool/);
    expect(execute).not.toHaveBeenCalled();
    expect(await executeTool(name, {})).toMatch(/^Error: unknown tool/);
  });
});

describe("update_goal dispatches through the registry", () => {
  test("valid report resolves via the recorder with a goal-report decision, executor never runs", async () => {
    const execute = vi.fn(async () => "must-not-run");
    const approve = vi.fn(async () => "once" as const);
    const { plan, preDecision } = await planToolCall("update_goal", REPORT, { approve } as never);
    expect(plan.unknown).toBeNull();
    expect(plan.invalid).toBeNull();
    expect(preDecision).toBeNull();
    const outcome = await runPlannedToolCall(
      call("c1", "update_goal", REPORT),
      plan,
      preDecision,
      { approve } as never,
      execute,
      () => "(goal report recorded — Hi)"
    );
    expect(outcome.decision).toBe("goal-report");
    expect(outcome.result).toBe("(goal report recorded — Hi)");
    expect(execute).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  test("no recorder is the outside-turn error; bad args are invalid-call; nothing records", async () => {
    const execute = vi.fn(async () => "must-not-run");
    const recorder = vi.fn(() => "recorded");
    const { plan } = await planToolCall("update_goal", REPORT, undefined);
    const outside = await runPlannedToolCall(
      call("c1", "update_goal", REPORT),
      plan,
      null,
      undefined,
      execute
    );
    expect(outside.decision).toBe("goal-report");
    expect(outside.result).toContain("update_goal is only available during an active goal turn");
    expect(recorder).not.toHaveBeenCalled();
    const bad = await runPlannedToolCall(
      call("c2", "update_goal", { status: "complete" }),
      (await planToolCall("update_goal", { status: "complete" }, undefined)).plan,
      null,
      undefined,
      execute,
      recorder
    );
    expect(bad.decision).toBe("invalid-args");
    expect(bad.result.startsWith("Error: invalid call:")).toBe(true);
    expect(recorder).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("direct executeTool validates then reports the outside-turn error (never unknown-tool)", async () => {
    expect(await executeTool("update_goal", REPORT)).toContain(
      "update_goal is only available during an active goal turn"
    );
    expect(await executeTool("update_goal", { status: "complete" })).toMatch(
      /^Error: invalid call:/
    );
  });
});

describe("ask_question dispatches through the registry", () => {
  test("valid question resolves via askUser with an ask-question decision, executor never runs", async () => {
    const execute = vi.fn(async () => "must-not-run");
    const approve = vi.fn(async () => "once" as const);
    const askUser = vi.fn(async () => "A");
    const { plan, preDecision } = await planToolCall("ask_question", ASK, { approve } as never);
    expect(plan.unknown).toBeNull();
    expect(plan.invalid).toBeNull();
    const outcome = await runPlannedToolCall(
      call("c1", "ask_question", ASK),
      plan,
      preDecision,
      { approve, askUser } as never,
      execute
    );
    expect(outcome.decision).toBe("ask-question");
    expect(outcome.result).toBe(JSON.stringify({ answer: "A" }));
    expect(askUser).toHaveBeenCalledWith("Which?", ["A", "B"], false, { index: 1, total: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  test("no UI hook is the hook-missing error; bad args are invalid-call; hook never fires", async () => {
    const execute = vi.fn(async () => "must-not-run");
    const askUser = vi.fn(async () => "A");
    const { plan } = await planToolCall("ask_question", ASK, undefined);
    const noHook = await runPlannedToolCall(
      call("c1", "ask_question", ASK),
      plan,
      null,
      undefined,
      execute
    );
    expect(noHook.decision).toBe("ask-question");
    expect(noHook.result).toBe("Error: ask_question has no UI hook");
    const badArgs = { question: "q?", options: ["only-one"] };
    const bad = await runPlannedToolCall(
      call("c2", "ask_question", badArgs),
      (await planToolCall("ask_question", badArgs, undefined)).plan,
      null,
      { askUser } as never,
      execute
    );
    expect(bad.decision).toBe("invalid-args");
    expect(bad.result.startsWith("Error: invalid call:")).toBe(true);
    expect(askUser).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("registry runner validates beside the schema: direct executeTool matches the pipeline", async () => {
    expect(await executeTool("ask_question", ASK)).toBe("Error: ask_question has no UI hook");
    expect(await executeTool("ask_question", { question: "q?", options: ["x"] })).toMatch(
      /^Error: invalid call:/
    );
    expect(validateToolArgs("ask_question", ASK)).toBeNull();
    expect(validateToolArgs("update_goal", REPORT)).toBeNull();
  });
});

describe("intercepted-tool invariants", () => {
  test("both names are intercepted, approval-free, and excluded from APPROVAL_TOOLS", () => {
    expect(isInterceptedTool("ask_question")).toBe(true);
    expect(isInterceptedTool("update_goal")).toBe(true);
    expect(isInterceptedTool("read")).toBe(false);
    expect(needsApproval("ask_question")).toBe(false);
    expect(needsApproval("update_goal")).toBe(false);
    expect(APPROVAL_TOOLS.has("ask_question")).toBe(false);
    expect(APPROVAL_TOOLS.has("update_goal")).toBe(false);
  });

  test("runInterceptedTool returns null for executor tools", async () => {
    expect(await runInterceptedTool("read", { path: "a.txt" }, {})).toBeNull();
  });

  test("an extension tool cannot collide with the intercepted update_goal name", () => {
    expect(() =>
      registerExtensionTool({
        name: "update_goal",
        description: "shadow",
        parameters: { type: "object" },
        execute: async () => "shadow",
      })
    ).toThrow(/collides with a builtin tool/);
    expect(toolNames().filter((n) => n === "update_goal")).toHaveLength(1);
  });

  test("the scheduler keeps update_goal a serial singleton (no effect metadata needed)", () => {
    const batches = planBatches([call("u1", "update_goal", REPORT)]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]!.parallelKey).toBeNull();
  });

  test("serial sink pairing survives: started before, finished in the commit funnel", async () => {
    const started: Array<{ toolCallId: string; name: string }> = [];
    const finished: Array<{ toolCallId: string; name: string; isError: boolean }> = [];
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "go" },
    ];
    let n = 0;
    const chatFn = async (): Promise<ChatResult> => {
      n += 1;
      return n === 1
        ? { content: null, tool_calls: [call("c1", "ask_question", ASK)] }
        : { content: "done" };
    };
    const reply = await runLoopWithChat(chatFn, history, {
      execute: async () => "must-not-run",
      askUser: async () => "A",
      turnEvents: {
        onToolStarted: (info) => void started.push({ toolCallId: info.toolCallId, name: info.name }),
        onToolFinished: (info) =>
          void finished.push({ toolCallId: info.toolCallId, name: info.name, isError: info.isError }),
      },
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    expect(started).toEqual([{ toolCallId: "c1", name: "ask_question" }]);
    expect(finished).toEqual([{ toolCallId: "c1", name: "ask_question", isError: false }]);
    const tool = history.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(tool?.content).toBe(JSON.stringify({ answer: "A" }));
  });
});
