// Slash-menu deep module: single engine, App re-export compat, shared matcher.
// Pure — no TUI, no network.
import { describe, expect, test } from "vitest";
import {
  SLASH_COMMANDS,
  SLASH_MENU_SKILL_CAP,
  buildSlashMenu,
  filterSlashCommands,
  filterSkillPicker,
  fuzzyScore,
  sameSkillMenuSnapshot,
  slashRunsWhileBusy,
} from "../src/ui/slash-menu.js";
import {
  SLASH_COMMANDS as AppCommands,
  buildSlashMenu as appBuildSlashMenu,
  filterSlashCommands as appFilterSlashCommands,
  fuzzyScore as appFuzzyScore,
  sameSkillMenuSnapshot as appSameSnapshot,
  slashRunsWhileBusy as appSlashRunsWhileBusy,
} from "../src/App.js";
import { filterMentionCandidates } from "../src/ui/mentions.js";

describe("slash-menu module", () => {
  test("registry holds the full command set", () => {
    expect(SLASH_COMMANDS.length).toBeGreaterThan(20);
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("/model");
  });

  test("exact command collapses prefix-siblings", () => {
    expect(filterSlashCommands("/model").map((c) => c.name)).toEqual([
      "/model",
    ]);
  });

  test("skill rows cap with a more-count", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `cap-${i}`,
      description: "Cap skill.",
    }));
    const menu = buildSlashMenu("/cap", many);
    expect(menu.items).toHaveLength(
      filterSlashCommands("/cap").length + SLASH_MENU_SKILL_CAP,
    );
    expect(menu.moreSkills).toBe(12 - SLASH_MENU_SKILL_CAP);
  });

  test("skill picker filters case-insensitively", () => {
    const entries = [
      { name: "Code-Review", userInvocable: true, source: "t" },
      { name: "deploy", userInvocable: true, source: "t" },
    ];
    expect(filterSkillPicker(entries, "code")).toHaveLength(1);
    expect(filterSkillPicker(entries, "")).toHaveLength(2);
  });

  test("snapshot equality is structural", () => {
    const a = [{ name: "x", description: "e" }];
    expect(sameSkillMenuSnapshot(a, [{ name: "x", description: "e" }])).toBe(
      true,
    );
    expect(
      sameSkillMenuSnapshot(a, [{ name: "x", description: "changed" }]),
    ).toBe(false);
  });

  test("busy-gate keeps view-only commands runnable", () => {
    expect(slashRunsWhileBusy("/compact")).toBe(true);
    expect(slashRunsWhileBusy("/model")).toBe(false);
  });
});

describe("App re-export compat", () => {
  test("App re-exports the same engine references", () => {
    expect(AppCommands).toBe(SLASH_COMMANDS);
    expect(appBuildSlashMenu).toBe(buildSlashMenu);
    expect(appFilterSlashCommands).toBe(filterSlashCommands);
    expect(appFuzzyScore).toBe(fuzzyScore);
    expect(appSameSnapshot).toBe(sameSkillMenuSnapshot);
    expect(appSlashRunsWhileBusy).toBe(slashRunsWhileBusy);
  });
});

describe("shared fuzzy matcher", () => {
  test("@ mentions rank through the same scorer", () => {
    const ranked = filterMentionCandidates(
      ["zzz-compact.md", "compact.md"],
      "cmp",
    );
    expect(ranked[0]).toBe("compact.md");
  });
});
