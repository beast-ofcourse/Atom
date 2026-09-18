// Phase 2 pins (goal-tools-refactor): lifecycle tool registry coverage —
// definitions registered, validators wired, collisions reserved,
// context-free degradation, scheduler singletons.
import { describe, expect, test, vi } from "vitest";
import {
  allToolDefinitions,
  CLEAR_GOAL_TOOL_DEFINITION,
  CREATE_GOAL_TOOL_DEFINITION,
  executeTool,
  GET_GOAL_TOOL_DEFINITION,
  isInterceptedTool,
  needsApproval,
  PAUSE_GOAL_TOOL_DEFINITION,
  registerExtensionTool,
  RESUME_GOAL_TOOL_DEFINITION,
  runInterceptedTool,
  TOOL_DEFINITIONS,
  TOOL_ONE_LINERS,
  toolNames,
  validateToolArgs,
} from "../src/tools.js";
import { planBatches } from "../src/scheduler.js";
import type { ToolCall } from "../src/agent/types.js";

const GOALS = [
  "get_goal",
  "create_goal",
  "update_goal",
  "pause_goal",
  "resume_goal",
  "clear_goal",
] as const;

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe("lifecycle definitions registered", () => {
  test("toolNames + visible schema carry all six; executor builtins stay 13", () => {
    for (const name of GOALS) expect(toolNames()).toContain(name);
    const visible = allToolDefinitions().map((t) => t.function.name);
    for (const name of GOALS) expect(visible).toContain(name);
    expect(TOOL_DEFINITIONS).toHaveLength(13);
    for (const name of GOALS) {
      expect(TOOL_DEFINITIONS.map((t) => t.function.name)).not.toContain(name);
    }
    // Exported consts are exactly what the model sees (single source).
    const byName = new Map(allToolDefinitions().map((t) => [t.function.name, t]));
    expect(byName.get("get_goal")).toBe(GET_GOAL_TOOL_DEFINITION);
    expect(byName.get("create_goal")).toBe(CREATE_GOAL_TOOL_DEFINITION);
    expect(byName.get("pause_goal")).toBe(PAUSE_GOAL_TOOL_DEFINITION);
    expect(byName.get("resume_goal")).toBe(RESUME_GOAL_TOOL_DEFINITION);
    expect(byName.get("clear_goal")).toBe(CLEAR_GOAL_TOOL_DEFINITION);
    // One-liners cover the /tools list.
    for (const name of GOALS) expect(typeof TOOL_ONE_LINERS[name]).toBe("string");
  });

  test("validators wired: valid null, invalid detail; intercepted + approval-free", () => {
    expect(validateToolArgs("get_goal", {})).toBeNull();
    expect(validateToolArgs("create_goal", { objective: "Ship v2" })).toBeNull();
    expect(validateToolArgs("create_goal", {})).not.toBeNull();
    expect(validateToolArgs("pause_goal", {})).toBeNull();
    expect(validateToolArgs("pause_goal", { reason: "" })).not.toBeNull();
    expect(validateToolArgs("resume_goal", {})).toBeNull();
    expect(validateToolArgs("clear_goal", {})).toBeNull();
    expect(validateToolArgs("clear_goal", { reason: 5 })).not.toBeNull();
    for (const name of GOALS) {
      if (name === "update_goal") continue;
      expect(isInterceptedTool(name)).toBe(true);
      expect(needsApproval(name)).toBe(false);
    }
  });
});

describe("lifecycle dispatch", () => {
  test("hooks resolve with goal-report decision; executor never runs", async () => {
    const hooks = {
      onGetGoal: vi.fn(() => "(goal [active] — Ship v2)"),
      onCreateGoal: vi.fn(() => "(goal set — Ship v2)"),
      onPauseGoal: vi.fn(() => "(goal paused — Ship v2)"),
      onResumeGoal: vi.fn(() => "(goal resumed — Ship v2)"),
      onClearGoal: vi.fn(() => "(goal cleared — Ship v2)"),
    };
    const cases: Array<[string, Record<string, unknown>, keyof typeof hooks, string]> = [
      ["get_goal", {}, "onGetGoal", "(goal [active] — Ship v2)"],
      ["create_goal", { objective: "Ship v2" }, "onCreateGoal", "(goal set — Ship v2)"],
      ["pause_goal", {}, "onPauseGoal", "(goal paused — Ship v2)"],
      ["resume_goal", {}, "onResumeGoal", "(goal resumed — Ship v2)"],
      ["clear_goal", {}, "onClearGoal", "(goal cleared — Ship v2)"],
    ];
    for (const [name, args, hook, text] of cases) {
      const out = await runInterceptedTool(name, args, hooks);
      expect(out?.decision).toBe("goal-report");
      expect(out?.result).toBe(text);
      expect(hooks[hook]).toHaveBeenCalledWith(args);
    }
  });

  test("no hooks degrade to the outside-session error; bad args never reach hooks", async () => {
    for (const name of ["get_goal", "create_goal", "pause_goal", "resume_goal", "clear_goal"]) {
      const args = name === "create_goal" ? { objective: "Ship v2" } : {};
      const hook = vi.fn(() => "must-not-run");
      const hookKey =
        `on${name.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")}` as
        "onGetGoal" | "onCreateGoal" | "onPauseGoal" | "onResumeGoal" | "onClearGoal";
      const out = await runInterceptedTool(name, args, {});
      expect(out?.decision).toBe("goal-report");
      expect(out?.result).toMatch(new RegExp(`^Error: ${name} is only available during a session turn`));
      const bad = await runInterceptedTool(
        name,
        name === "create_goal" ? {} : { reason: "" },
        { [hookKey]: hook } as never
      );
      // get_goal/resume_goal take anything object-shaped; the rest reject.
      if (name === "get_goal" || name === "resume_goal") {
        expect(bad?.result).not.toMatch(/^Error: invalid call:/);
      } else {
        expect(bad?.result).toMatch(/^Error: invalid call:/);
        expect(hook).not.toHaveBeenCalled();
      }
    }
  });

  test("direct executeTool matches the pipeline: validated, never unknown-tool", async () => {
    expect(await executeTool("get_goal", {})).toMatch(/^Error: get_goal is only available/);
    expect(await executeTool("create_goal", {})).toMatch(/^Error: invalid call:/);
    expect(await executeTool("pause_goal", { reason: "" })).toMatch(/^Error: invalid call:/);
    expect(await executeTool("bogus_goal_tool", {})).toMatch(/^Error: unknown tool/);
  });
});

describe("lifecycle reservations + scheduling", () => {
  test("extensions cannot shadow any lifecycle name; names stay unique", () => {
    for (const name of ["get_goal", "create_goal", "pause_goal", "resume_goal", "clear_goal"]) {
      expect(() =>
        registerExtensionTool({
          name,
          description: "shadow",
          parameters: { type: "object" },
          execute: async () => "shadow",
        })
      ).toThrow(/collides with a builtin tool/);
      expect(toolNames().filter((n) => n === name)).toHaveLength(1);
    }
  });

  test("scheduler keeps lifecycle tools as serial singletons (no effect metadata needed)", () => {
    for (const name of ["get_goal", "create_goal", "pause_goal", "resume_goal", "clear_goal"]) {
      const args = name === "create_goal" ? { objective: "Ship v2" } : {};
      const batches = planBatches([call("u1", name, args)]);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
      expect(batches[0]![0]!.parallelKey).toBeNull();
    }
  });
});
