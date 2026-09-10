// Slash-menu polish tests: fuzzy matching (prefix tier stable, fuzzy
// ranked), skill descriptions, argument-hint reuse, and App-level menu
// behavior. The existing registry/runner is untouched — only the matcher
// and row content changed.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  SLASH_MENU_SKILL_CAP,
  buildSlashMenu,
  commandUsage,
  filterSlashCommands,
  fuzzyScore,
} from "../src/App.js";

const SKILLS = [
  { name: "code-review", description: "Review code thoroughly and completely." },
  { name: "codebase-memory", description: "Map the codebase." },
  { name: "deploy", description: "Ship it." },
];

describe("fuzzyScore", () => {
  test("subsequence matches score, misses return null", () => {
    expect(fuzzyScore("cmp", "compact")).not.toBe(null);
    expect(fuzzyScore("xyz", "compact")).toBe(null);
    expect(fuzzyScore("", "compact")).toBe(0);
    expect(fuzzyScore("CMP", "compact")).not.toBe(null);
  });
  test("tighter matches score lower", () => {
    const a = fuzzyScore("mod", "model")!;
    const b = fuzzyScore("mod", "mode")!;
    expect(a).toBeLessThanOrEqual(b);
    expect(fuzzyScore("mp", "compact")!).toBeGreaterThan(fuzzyScore("cmp", "compact")!);
  });
});

describe("filterSlashCommands", () => {
  test("fuzzy finds /compact for /cmp", () => {
    const names = filterSlashCommands("/cmp").map((c) => c.name);
    expect(names[0]).toBe("/compact");
  });
  test("prefix tier keeps registry order before fuzzy", () => {
    const names = filterSlashCommands("/mod").map((c) => c.name);
    expect(names[0]).toBe("/model");
    // Registry order is stable: /models sits between /model and /mode.
    expect(names[1]).toBe("/models");
    expect(names[2]).toBe("/mode");
  });
  test("bare slash still lists every command", () => {
    expect(filterSlashCommands("/").length).toBeGreaterThan(20);
  });
  test("exact input collapses prefix-siblings (no duplicate look)", () => {
    expect(filterSlashCommands("/skill").map((c) => c.name)).toEqual(["/skill"]);
    expect(filterSlashCommands("/skills").map((c) => c.name)).toEqual(["/skills"]);
    expect(filterSlashCommands("/model").map((c) => c.name)).toEqual(["/model"]);
    expect(filterSlashCommands("/mode").map((c) => c.name)).toEqual(["/mode"]);
    // Without the leading slash too.
    expect(filterSlashCommands("skill").map((c) => c.name)).toEqual(["/skill"]);
  });
});

describe("buildSlashMenu skills", () => {
  test("fuzzy finds skills beyond prefix", () => {
    const menu = buildSlashMenu("/rvw", SKILLS);
    expect(menu.items.map((i) => i.name)).toContain("/skill:code-review");
  });
  test("skill rows carry descriptions", () => {
    const menu = buildSlashMenu("/code", SKILLS);
    const row = menu.items.find((i) => i.name === "/skill:code-review")!;
    expect(row.description).toContain("Review code");
  });
  test("long descriptions truncate with an ellipsis", () => {
    const long = [{ name: "x", description: "d".repeat(200) }];
    const menu = buildSlashMenu("/x", long);
    const row = menu.items.find((i) => i.skill === "x")!;
    expect(row.description.endsWith("…")).toBe(true);
    expect(row.description.length).toBeLessThan(200);
  });
  test("existing pins hold: /code exact, /skill:dep exact, cap exact", () => {
    // Exact /skill collapses the command tier; namespaced skill rows still
    // follow (different namespace, no duplication).
    expect(buildSlashMenu("/skill", SKILLS).items.map((i) => i.name)).toEqual([
      "/skill",
      "/skill:code-review",
      "/skill:codebase-memory",
      "/skill:deploy",
    ]);    expect(buildSlashMenu("/code", SKILLS).items.map((i) => i.name)).toEqual([
      "/skill:code-review",
      "/skill:codebase-memory",
    ]);
    expect(buildSlashMenu("/skill:dep", SKILLS).items.map((i) => i.name)).toEqual([
      "/skill:deploy",
    ]);
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `cap-${i}`, description: "Cap." }));
    const capped = buildSlashMenu("/cap", many);
    expect(capped.items).toHaveLength(SLASH_MENU_SKILL_CAP);
    expect(capped.moreSkills).toBe(12 - SLASH_MENU_SKILL_CAP);
  });
});

describe("commandUsage", () => {
  test("reuses the commands' own usage strings", () => {
    expect(commandUsage("/allow")).toContain("usage: /allow");
    expect(commandUsage("/deny")).toContain("usage: /allow");
    expect(commandUsage("/queue")).toContain("usage: /queue");
    expect(commandUsage("/steer")).toContain("usage: /steer");
    expect(commandUsage("/skill")).toContain("usage: /skill:");
    expect(commandUsage("/compact")).toContain("/compact [focus text]");
  });
  test("self-evident commands have no hint", () => {
    expect(commandUsage("/model")).toBe(null);
    expect(commandUsage("/clear")).toBe(null);
    expect(commandUsage("/help")).toBe(null);
  });
});

// --- App-level menu behavior (no network: /compact short-circuits) ---

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("App slash menu", () => {
  test("fuzzy /cmp offers /compact and Enter runs it", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/cmp");
      await waitForFrame(app, "/compact");
      app.stdin.write("\r");
      await waitForFrame(app, "nothing to compact");
    } finally {
      app.unmount();
    }
  });
  test("highlighted /allow shows its argument hint", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/all");
      await waitForFrame(app, "/allow");
      expect(app.lastFrame()).toContain("usage: /allow");
      app.stdin.write("\u001B");
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      app.unmount();
    }
  });
});
