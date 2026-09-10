// Command-palette tests: categories cover the registry, fuzzy ranking,
// busy-gate reuse, panel rendering, and the App Ctrl+P open/filter/run
// flow. The registry and runner are untouched — only indexing changed.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { SLASH_COMMANDS, paletteEntries, slashRunsWhileBusy } from "../src/App.js";
import { PALETTE_CATEGORY_ORDER, paletteCategory } from "../src/ui/palette.js";
import { PalettePanel } from "../src/ui/palette.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("palette model", () => {
  test("every command has a real category", () => {
    for (const c of SLASH_COMMANDS) {
      expect(PALETTE_CATEGORY_ORDER).toContain(paletteCategory(c.name));
    }
    expect(paletteCategory("/model")).toBe("Model");
    expect(paletteCategory("/compact")).toBe("Session");
    expect(paletteCategory("/allow")).toBe("Tools");
    expect(paletteCategory("/skill")).toBe("Skills");
    expect(paletteCategory("/queue")).toBe("Flow");
    expect(paletteCategory("/help")).toBe("Help");
    expect(paletteCategory("/nope")).toBe("Help");
  });
  test("empty query lists everything grouped by category", () => {
    const entries = paletteEntries("");
    expect(entries).toHaveLength(SLASH_COMMANDS.length);
    expect(entries[0]?.category).toBe("Model");
    expect(entries[entries.length - 1]?.category).toBe("Help");
  });
  test("fuzzy ranks prefix first", () => {
    const names = paletteEntries("cmp").map((e) => e.name);
    expect(names[0]).toBe("/compact");
  });
  test("description tier finds by meaning", () => {
    const names = paletteEntries("permission").map((e) => e.name);
    expect(names).toContain("/mode");
  });
  test("busy gate matches the slash menu contract", () => {
    expect(slashRunsWhileBusy("/compact")).toBe(true);
    expect(slashRunsWhileBusy("/queue")).toBe(true);
    expect(slashRunsWhileBusy("/steer")).toBe(true);
    expect(slashRunsWhileBusy("/model")).toBe(false);
    expect(slashRunsWhileBusy("/clear")).toBe(false);
  });
});

describe("PalettePanel", () => {
  const entries = paletteEntries("");
  test("groups render with headers and hints", () => {
    const frame = frameOf(<PalettePanel entries={entries} index={0} filter="" />);
    expect(frame).toContain("Model");
    expect(frame).toContain("Session");
    expect(frame).toContain("❯ /model");
    // Commands below the window fold render on scroll with their bound hints.
    const low = frameOf(
      <PalettePanel entries={entries} index={entries.length - 2} filter="" />
    );
    expect(low).toContain("/exit");
    expect(low).toContain("Ctrl+C");
  });
  test("filter narrows; empty result states it", () => {
    const filtered = paletteEntries("compact");
    const frame = frameOf(<PalettePanel entries={filtered} index={0} filter="compact" />);
    expect(frame).toContain("/compact");
    expect(frame).not.toContain("/model");
    expect(frame).toContain("compact");
    const empty = frameOf(<PalettePanel entries={[]} index={0} filter="zzz" />);
    expect(empty).toContain("No commands match");
  });
  test("long lists window with the highlight visible", () => {
    const last = entries.length - 1;
    const frame = frameOf(<PalettePanel entries={entries} index={last} filter="" />);
    expect(frame).toContain("/quit");
    expect(frame).toContain("↑");
  });
});

// --- App Ctrl+P flow (no network: /compact short-circuits) ---

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

describe("App palette flow", () => {
  test("Ctrl+P opens, filters, runs, and closes", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("\u0010");
      await waitForFrame(app, "Search commands");
      expect(app.lastFrame()).toContain("Model");
      app.stdin.write("cmp");
      await waitForFrame(app, "/compact");
      app.stdin.write("\r");
      await waitForFrame(app, "nothing to compact");
      expect(app.lastFrame()).not.toContain("Search commands");
    } finally {
      app.unmount();
    }
  });
  test("Ctrl+P toggles closed and Esc closes", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("\u0010");
      await waitForFrame(app, "Search commands");
      app.stdin.write("\u0010");
      await new Promise((r) => setTimeout(r, 100));
      expect(app.lastFrame()).not.toContain("Search commands");
      app.stdin.write("\u0010");
      await waitForFrame(app, "Search commands");
      app.stdin.write("\u001B");
      await new Promise((r) => setTimeout(r, 100));
      expect(app.lastFrame()).not.toContain("Search commands");
    } finally {
      app.unmount();
    }
  });
});
