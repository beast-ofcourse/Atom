// Local tool executors for the Ink chatbot's OpenAI-style function-calling loop.
// Node builtins + global fetch only. Every executor returns a string and
// NEVER throws across the tool boundary: failures come back as "Error: ..."
// strings so the model can see and react to them.
//
// Organization: one responsibility per module under src/tools/ (shared kernel,
// overflow spills, read fingerprints, filesystem/search/shell/web/todo
// executors, and the registry that owns names, validation, and dispatch).
// This file is a pure barrel so every existing `from "./tools.js"` /
// `"../src/tools.js"` import keeps working untouched.
export * from "./tools/custom.js";
export * from "./tools/compaction-hooks.js";
export * from "./tools/intercept.js";
export * from "./tools/overrides.js";
export * from "./tools/provider-hooks.js";
export * from "./tools/filesystem.js";
export * from "./tools/fingerprints.js";
export * from "./tools/dir-cache.js";
export * from "./tools/overflow.js";
export * from "./tools/read-cache.js";
export * from "./tools/registry.js";
export * from "./tools/ripgrep.js";
export * from "./tools/search.js";
export * from "./tools/shared.js";
export * from "./tools/shell.js";
export * from "./tools/todo.js";
export * from "./tools/web.js";

// update_goal tool definition (ticket 03): the goal-scoped disposition
// report the model calls at the end of each goal turn — `continue` (with
// the next action), `complete`, or `blocked` (with a reason). Declared here
// and NOT in the builtin registry: src/tools/registry.ts stays untouched
// (its 13-entry pin holds) because the loop intercepts update_goal by name
// (runOneTool/runOneToolWithArgs, ask_question-style — validated via
// validateUpdateGoalArgs in src/goal.ts, never needs approval, resolved
// without an executor), so no registry entry is needed for the report path.
// Model-visible schema (chat-payload `tools`) wiring arrives with a later
// ticket; until then the goal follow-up message (goalFollowUp in
// src/goal.ts) carries the usage instructions every goal turn.
import type { ToolDefinition } from "./tools/registry.js";
export const UPDATE_GOAL_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: "update_goal",
    description:
      "Report this goal turn's outcome (goal-scoped: only available during an active goal turn). " +
      "WHEN to use: at the end of each goal turn — status \"continue\" with the next action, " +
      "or \"complete\"/\"blocked\" with a reason. " +
      "A \"complete\" lands only on genuinely finished work: verified checks and resolved todos. " +
      "Checks you could not run go in \"unverified\" (recorded openly in the closing summary, never a gate). " +
      "WHEN NOT to use: never outside a goal turn (it records nothing there); " +
      "a turn with no report continues the goal.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["continue", "complete", "blocked"],
          description: "Turn outcome: \"continue\" (keep working), \"complete\" (goal done), \"blocked\" (cannot proceed).",
        },
        next: {
          type: "string",
          description: "Next action (only with status \"continue\"; omit otherwise).",
        },
        reason: {
          type: "string",
          description: "Why the goal is done or stuck (required with \"complete\"/\"blocked\"; omit otherwise).",
        },
        unverified: {
          type: "array",
          items: { type: "string" },
          description:
            "Checks that could not be run (only with status \"complete\"; omit otherwise). " +
            "Recorded openly in the closing summary; at most 10 non-empty items of 200 characters each.",
        },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
};
