// Phase 6 pins (goal-tools-refactor): the goal-tool contract is visible in
// the system prompt, /goal usage, /help text, and slash menu. Wording pins
// (not full snapshots) so prose can evolve without churn.
import { describe, expect, test } from "vitest";
import { SYSTEM_PROMPT } from "../src/system.js";
import {
  buildSlashMenu,
  commandUsage,
  helpListText,
  GOAL_USAGE,
} from "../src/App.js";

describe("goal-tool contract surface", () => {
  test("system prompt names all six tools with create restraint + evidence rule", () => {
    for (const name of [
      "get_goal",
      "update_goal",
      "create_goal",
      "pause_goal",
      "resume_goal",
      "clear_goal",
    ]) {
      expect(SYSTEM_PROMPT).toContain(name);
    }
    expect(SYSTEM_PROMPT).toContain("never inferred");
    expect(SYSTEM_PROMPT).toContain("complete only on evidence");
  });

  test("/goal usage + /help carry the tool mirror", () => {
    expect(GOAL_USAGE).toContain("pause/resume/clear_goal");
    expect(GOAL_USAGE).toContain("never inferred");
    expect(commandUsage("/goal")).toBe(GOAL_USAGE);
    expect(helpListText()).toContain("create_goal only on explicit /goal intent");
    expect(helpListText()).toContain("complete only on evidence");
  });

  test("slash menu /goal entry mentions the model tools", () => {
    const menu = buildSlashMenu("/", []);
    const entry = menu.items.find((c) => c.name === "/goal");
    expect(entry?.description).toContain("pause/resume/clear");
  });
});
