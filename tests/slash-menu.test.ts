// Pure slash-menu builder + context-chars label. No TUI, no network.
import { describe, expect, test } from "vitest";
import {
  SLASH_MENU_SKILL_CAP,
  buildSlashMenu,
} from "../src/App.js";

const SKILLS = [
  { name: "code-review", description: "Review code." },
  { name: "codebase-memory", description: "Map the codebase." },
  { name: "deploy", description: "Ship it." },
];

describe("buildSlashMenu", () => {
  test("bare slash lists commands only (menu can never take over)", () => {
    const menu = buildSlashMenu("/", SKILLS);
    expect(menu.moreSkills).toBe(0);
    expect(menu.items.every((i) => i.skill === undefined)).toBe(true);
    expect(menu.items[0]?.name).toBe("/model");
  });

  test("commands come first, then prefix-matching skills as /skill:name", () => {
    const menu = buildSlashMenu("/code", SKILLS);
    expect(menu.moreSkills).toBe(0);
    expect(menu.items.map((i) => i.name)).toEqual([
      "/skill:code-review",
      "/skill:codebase-memory",
    ]);
    expect(menu.items[0]?.skill).toBe("code-review");
  });

  test("full /skill:name prefix matches too", () => {
    const menu = buildSlashMenu("/skill:dep", SKILLS);
    expect(menu.items.map((i) => i.name)).toEqual(["/skill:deploy"]);
  });

  test("command prefix still wins first slot (/mode → /model, /models, then /mode)", () => {
    const menu = buildSlashMenu("/mode", SKILLS);
    expect(menu.items[0]?.name).toBe("/model");
    expect(menu.items[1]?.name).toBe("/models");
    expect(menu.items[2]?.name).toBe("/mode");
  });

  test("skill rows cap at 8 with a more-count", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `cap-${i}`,
      description: "Cap skill.",
    }));
    const menu = buildSlashMenu("/cap", many);
    expect(menu.items).toHaveLength(SLASH_MENU_SKILL_CAP);
    expect(menu.moreSkills).toBe(12 - SLASH_MENU_SKILL_CAP);
    expect(menu.items.map((i) => i.name)).toEqual(
      Array.from({ length: SLASH_MENU_SKILL_CAP }, (_, i) => `/skill:cap-${i}`)
    );
  });
});
