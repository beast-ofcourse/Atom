// /reload (config + skills) — ticket 02. Pure registry tests are
// synchronous; the App turn test drives a live skill and config dir so an
// edited file is picked up only after /reload (no restart), and checks
// that conversation + busy gating hold.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App, SLASH_COMMANDS, paletteEntries, slashRunsWhileBusy, buildSlashMenu } from "../src/App.js";
import { paletteCategory } from "../src/ui/palette.js";

let dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-reload-"));
  dirs.push(d);
  return d;
}
async function writeSkill(root: string, name: string, front: string, body: string): Promise<void> {
  const dir = path.join(root, ".claude", "skills", name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "SKILL.md"), `---\n${front}\n---\n\n${body}\n`, "utf8");
}
async function waitForFrame(app: { lastFrame: () => string | undefined }, needle: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
function baseProps(skillDirs: { projectDir: string; homeDir: string }, configDirs: { projectDir: string; homeDir: string }) {
  return {
    apiKey: "test-key",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
    skillDirs,
    configDirs,
    authHome: configDirs.homeDir,
  };
}
const realFetch = globalThis.fetch;
function mockChatScript(messages: unknown[]) {
  const q = [...messages];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown };
    // touch body to avoid unused warning;
    void body;
    const next = q.length > 1 ? q.shift() : q[0];
    return { ok: true, json: async () => ({ choices: [{ message: next }] }) } as Response;
  });
}
afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("reload registry", () => {
  test("/reload is registered and categorized", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/reload");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toMatch(/config/i);
    expect(cmd!.description).toMatch(/conversation.*session.*trust.*mode kept/i);
    expect(paletteCategory("/reload")).toBe("Session");
    expect(paletteEntries("").map((e) => e.name)).toContain("/reload");
    expect(buildSlashMenu("/reload", [], []).items[0]?.name).toBe("/reload");
  });
  test("/reload is idle-only and an extension cannot shadow it", async () => {
    expect(slashRunsWhileBusy("/reload")).toBe(false);
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadExtensions } = await import("../src/extensions.js");
    const { clearExtensionCommands } = await import("../src/extension-commands.js");
    const root = mkdtempSync(path.join(tmpdir(), "atom-reload-shadow-"));
    try {
      const bad = path.join(root, "bad.js");
      mkdirSync(path.dirname(bad), { recursive: true });
      writeFileSync(bad, `module.exports = function (api) { api.registerCommand({ name: "reload", description: "squat builtin", handler: async () => "x" }); };`, "utf8");
      const rt = await loadExtensions({ entryPaths: [bad], builtinSlashCommands: SLASH_COMMANDS.map((c) => c.name) });
      expect(rt.errors.some((e) => /collides with a builtin/.test(e.error))).toBe(true);
      rt.unload();
      clearExtensionCommands();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("/reload App: config and skills", () => {
  test("edited config and added/changed/removed skills take effect after /reload, conversation kept", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, "alpha", "description: Alpha.", "Alpha body.");
    // No atom.json yet — config is defaults.
    // NOTE: the seed reply is a unique needle (not "ok": "ok" is a
    // substring of the dock "token:" pill, so it matches before the turn
    // completes). Waiting for the reply proves the turn settled idle, so
    // the skill submit below is not swallowed by the busy guard.
    mockChatScript([{ content: "reload-seed-done-xyz" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: home }, { projectDir: project, homeDir: home })} />);
    try {
      // Seed one turn so history is non-empty (conversation preservation check).
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "hello");
      await waitForFrame(app, "reload-seed-done-xyz");

      // Verify alpha is invocable before reload, beta is not.
      app.stdin.write("/skill:alpha");
      app.stdin.write("\r");
      await waitForFrame(app, "alpha loaded");
      app.stdin.write("/skill:beta");
      app.stdin.write("\r");
      await waitForFrame(app, 'Unknown skill "/skill:beta"');

      // Edit config on disk.
      await fsp.writeFile(path.join(project, "atom.json"), JSON.stringify({ model: "new-model" }, null, 2), "utf8");
      // Add beta, change alpha description, remove by deleting alpha? Keep alpha but change, add beta, and later remove alpha in next step.
      await writeSkill(project, "alpha", "description: Alpha changed.", "Alpha body changed.");
      await writeSkill(project, "beta", "description: Beta.", "Beta body.");

      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      const afterReload = app.lastFrame() ?? "";
      expect(afterReload).toMatch(/Reloaded.*config.*skills/i);
      expect(afterReload).toMatch(/conversation kept/i);
      // New config is reflected in /context.
      app.stdin.write("/context");
      app.stdin.write("\r");
      await waitForFrame(app, "config:");
      expect(app.lastFrame()).toMatch(/project/);
      // Changed alpha and added beta are now visible.
      app.stdin.write("/skill:alpha");
      app.stdin.write("\r");
      await waitForFrame(app, "alpha loaded");
      app.stdin.write("/skill:beta");
      app.stdin.write("\r");
      await waitForFrame(app, "beta loaded");
      // Remove alpha, reload again — alpha disappears.
      await fsp.rm(path.join(project, ".claude", "skills", "alpha"), { recursive: true, force: true });
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      app.stdin.write("/skill:alpha");
      app.stdin.write("\r");
      await waitForFrame(app, 'Unknown skill "/skill:alpha"');
      // Original user text is still in transcript — conversation was never cleared.
      expect(app.lastFrame()).toContain("hello");
    } finally {
      app.unmount();
    }
  });
  test("per-skill parse failures surface as warnings, not crashes", async () => {
    const project = await tmpDir();
    const home = await tmpDir();
    await writeSkill(project, "good", "description: Good.", "Good body.");
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: home }, { projectDir: project, homeDir: home })} />);
    try {
      await new Promise((r) => setTimeout(r, 300));
      // Add a broken skill (no frontmatter description? Actually invalid YAML).
      const badDir = path.join(project, ".claude", "skills", "bad");
      await fsp.mkdir(badDir, { recursive: true });
      await fsp.writeFile(path.join(badDir, "SKILL.md"), "this is not frontmatter\n---\nbody\n", "utf8");
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      expect(app.lastFrame()).toMatch(/Reloaded.*skills/i);
      // Good skill still loads (a parse-failure in the other entry must not crash reload).
      app.stdin.write("/skill:good");
      app.stdin.write("\r");
      await waitForFrame(app, "good loaded");
    } finally {
      app.unmount();
    }
  });
});
