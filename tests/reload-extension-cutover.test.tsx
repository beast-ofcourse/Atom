// /reload extension runtime cutover — ticket 03. App-level tests drive a
// live extension file through /reload: edited/added/removed commands take
// effect, edited tool and hook behavior takes effect, teardown/startup
// observe the reload reason, stale handles fail loudly, trust filters are
// reused without re-prompt, one broken extension stays inline, and a total
// reload failure keeps the previous extensions live.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App, buildSlashMenu, paletteEntries } from "../src/App.js";
import { getExtensionCommand, clearExtensionCommands, listExtensionCommands } from "../src/extension-commands.js";
import { grantProjectTrust, revokeProjectTrust } from "../src/project-trust.js";
import {
  allToolDefinitions,
  beforeToolInterceptors,
  clearCompactionHooks,
  clearExtensionPromptHints,
  clearExtensionTools,
  clearProviderHooks,
  clearToolInterceptors,
  clearToolOverrides,
  customToolNames,
  executeTool,
} from "../src/tools.js";

vi.mock("../src/extensions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/extensions.js")>();
  return {
    ...actual,
    loadExtensions: async (opts: never) => {
      if (process.env.ATOM_RELOAD_THROW_ONCE === "1") {
        delete process.env.ATOM_RELOAD_THROW_ONCE;
        throw new Error("synthetic total failure");
      }
      return actual.loadExtensions(opts);
    },
  };
});

let dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-reload-ext-"));
  dirs.push(d);
  return d;
}
async function writeExtFile(abs: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body, "utf8");
}
async function waitForFrame(app: { lastFrame: () => string | undefined }, needle: string, timeout = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
function baseProps(home: string, extra?: Record<string, unknown>) {
  return {
    apiKey: "test-key",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
    skillDirs: { projectDir: home, homeDir: home },
    configDirs: { projectDir: home, homeDir: home },
    authHome: home,
    ...extra,
  };
}
const realFetch = globalThis.fetch;
function mockChatScript(messages: unknown[]) {
  const q = [...messages];
  globalThis.fetch = vi.fn(async () => {
    const next = q.length > 1 ? q.shift() : q[0];
    return { ok: true, json: async () => ({ choices: [{ message: next }] }) } as Response;
  });
}
afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  delete process.env.ATOM_EXTENSIONS;
  delete process.env.ATOM_RELOAD_THROW_ONCE;
  delete (globalThis as Record<string, unknown>).__rlStaleProbe;
  clearExtensionCommands();
  clearExtensionTools();
  clearToolInterceptors();
  clearToolOverrides();
  clearExtensionPromptHints();
  clearProviderHooks();
  clearCompactionHooks();
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

// v1 factory: command rl_cut_a (A-v1), tool rl_cut_tool (tool-v1), a
// before-hook, lifecycle markers, and a stashed activation API for the
// stale-handle probe.
function extBody(marker: string, opts: { command: string; reply: string; toolDesc: string; toolReply: string }): string {
  return `const fs = require("node:fs");
module.exports = function (api) {
  globalThis.__rlStaleProbe = () => api.getSessionState();
  api.on("session_start", async (api2, info) => { fs.appendFileSync(${JSON.stringify(marker)}, "start:" + info.reason + "\\n"); });
  api.on("session_shutdown", async (api2, info) => { fs.appendFileSync(${JSON.stringify(marker)}, "shutdown:" + info.reason + "\\n"); });
  api.registerCommand({ name: ${JSON.stringify(opts.command)}, description: "cutover probe", handler: async () => ${JSON.stringify(opts.reply)} });
  api.registerTool({ name: "rl_cut_tool", description: ${JSON.stringify(opts.toolDesc)},
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ${JSON.stringify(opts.toolReply)} });
  api.onBeforeToolCall(async () => {});
};`;
}

describe("/reload extension cutover", () => {
  test("edited/added/removed commands and edited tool+hook behavior take effect, conversation kept", async () => {
    const home = await tmpDir();
    const extDir = await tmpDir();
    const entry = path.join(extDir, "cut.js");
    const marker = path.join(extDir, "events.log");
    await writeExtFile(entry, extBody(marker, { command: "rl_cut_a", reply: "A-v1", toolDesc: "tool v1", toolReply: "tool-v1" }));
    process.env.ATOM_EXTENSIONS = entry;
    grantProjectTrust(process.cwd(), home);
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps(home)} />);
    try {
      await waitForFrame(app, "extensions: 1 loaded");
      // Seed conversation history before the reload (wait for the seeded
      // turn to finish — "/" input while busy drops silently by design).
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "hello");
      await waitForFrame(app, "ok");
      // The reply paints before turn-end drain clears busy; settle so the
      // next "/" input is not dropped by the busy guard.
      await new Promise((r) => setTimeout(r, 800));
      // v1 behavior live before reload.
      app.stdin.write("/rl_cut_a");
      app.stdin.write("\r");
      await waitForFrame(app, "A-v1");
      expect(await executeTool("rl_cut_tool", {})).toBe("tool-v1");
      expect(beforeToolInterceptors().some((r) => r.owner === "cut")).toBe(true);

      // Edit: same command new reply, tool new behavior, hook re-registered.
      await writeExtFile(entry, extBody(marker, { command: "rl_cut_b", reply: "B-v2", toolDesc: "tool v2", toolReply: "tool-v2" }));
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      expect(app.lastFrame()).toMatch(/extensions: 1 loaded/);
      // Removed command is gone from the live registry, menu, and palette;
      // the new one is live in all three.
      expect(getExtensionCommand("rl_cut_a")).toBeUndefined();
      expect(getExtensionCommand("rl_cut_b")).toBeDefined();
      expect(buildSlashMenu("/rl_cut", [], listExtensionCommands()).items.map((i) => i.name)).toContain("/rl_cut_b");
      expect(paletteEntries("rl_cut").map((e) => e.name)).toContain("/rl_cut_b");
      expect(paletteEntries("rl_cut_a").map((e) => e.name)).not.toContain("/rl_cut_a");
      // Edited tool behavior takes effect; hook owner re-registered exactly once.
      expect(await executeTool("rl_cut_tool", {})).toBe("tool-v2");
      expect(allToolDefinitions().find((d) => d.function.name === "rl_cut_tool")?.function.description).toBe("tool v2");
      expect(beforeToolInterceptors().filter((r) => r.owner === "cut")).toHaveLength(1);
      // New command runs; conversation survived every reload.
      app.stdin.write("/rl_cut_b");
      app.stdin.write("\r");
      await waitForFrame(app, "B-v2");
      expect(app.lastFrame()).toContain("hello");

      // Remove the file: the command disappears on the next reload.
      await fsp.rm(entry, { force: true });
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "extensions: 0 loaded");
      expect(getExtensionCommand("rl_cut_b")).toBeUndefined();
      expect(customToolNames()).not.toContain("rl_cut_tool");
      expect(app.lastFrame()).toContain("hello");
    } finally {
      app.unmount();
    }
  });

  test("teardown then startup observe the reload reason in order", async () => {
    const home = await tmpDir();
    const extDir = await tmpDir();
    const entry = path.join(extDir, "cut.js");
    const marker = path.join(extDir, "events.log");
    await writeExtFile(entry, extBody(marker, { command: "rl_cut_a", reply: "A-v1", toolDesc: "tool v1", toolReply: "tool-v1" }));
    process.env.ATOM_EXTENSIONS = entry;
    grantProjectTrust(process.cwd(), home);
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps(home)} />);
    try {
      await waitForFrame(app, "extensions: 1 loaded");
      await new Promise((r) => setTimeout(r, 200));
      const before = await fsp.readFile(marker, "utf8");
      expect(before.trim().split("\n")).toEqual(["start:startup"]);
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      await new Promise((r) => setTimeout(r, 200));
      const after = await fsp.readFile(marker, "utf8");
      expect(after.trim().split("\n")).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
    } finally {
      app.unmount();
    }
  });

  test("handles captured before the reload fail loudly on further use", async () => {
    const home = await tmpDir();
    const extDir = await tmpDir();
    const entry = path.join(extDir, "cut.js");
    const marker = path.join(extDir, "events.log");
    await writeExtFile(entry, extBody(marker, { command: "rl_cut_a", reply: "A-v1", toolDesc: "tool v1", toolReply: "tool-v1" }));
    process.env.ATOM_EXTENSIONS = entry;
    grantProjectTrust(process.cwd(), home);
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps(home)} />);
    try {
      await waitForFrame(app, "extensions: 1 loaded");
      const oldProbe = (globalThis as Record<string, unknown>).__rlStaleProbe as () => unknown;
      expect(typeof oldProbe).toBe("function");
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      expect(() => oldProbe()).toThrow(/stale|unloaded|reload/i);
    } finally {
      app.unmount();
    }
  });

  test("trust and filters are reused: no re-prompt, revocation honored, lockdown loads nothing", async () => {
    const home = await tmpDir();
    const extDir = await tmpDir();
    const entry = path.join(extDir, "cut.js");
    const marker = path.join(extDir, "events.log");
    await writeExtFile(entry, extBody(marker, { command: "rl_cut_a", reply: "A-v1", toolDesc: "tool v1", toolReply: "tool-v1" }));
    process.env.ATOM_EXTENSIONS = entry;
    grantProjectTrust(process.cwd(), home);
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps(home)} />);
    try {
      await waitForFrame(app, "extensions: 1 loaded");
      // Granted trust survives a reload with no re-prompt.
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      expect(getExtensionCommand("rl_cut_a")).toBeDefined();
      expect(app.lastFrame()).not.toMatch(/Load them\?/);
      // Revoking trust is honored on the next reload (no silent escalation).
      revokeProjectTrust(process.cwd(), home);
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "extensions: 0 loaded");
      expect(getExtensionCommand("rl_cut_a")).toBeUndefined();
      expect(app.lastFrame()).not.toMatch(/Load them\?/);
    } finally {
      app.unmount();
    }
  });

  test("lockdown still loads nothing across reload", async () => {
    const home = await tmpDir();
    const extDir = await tmpDir();
    const entry = path.join(extDir, "cut.js");
    const marker = path.join(extDir, "events.log");
    await writeExtFile(entry, extBody(marker, { command: "rl_cut_a", reply: "A-v1", toolDesc: "tool v1", toolReply: "tool-v1" }));
    process.env.ATOM_EXTENSIONS = entry;
    grantProjectTrust(process.cwd(), home);
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps(home, { extensionsLockdown: true })} />);
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(getExtensionCommand("rl_cut_a")).toBeUndefined();
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      expect(getExtensionCommand("rl_cut_a")).toBeUndefined();
      expect(app.lastFrame()).toMatch(/extensions: 0 loaded/);
    } finally {
      app.unmount();
    }
  });

  test("one broken extension is reported inline and does not take down the rest", async () => {
    const home = await tmpDir();
    const extDir = await tmpDir();
    const good = path.join(extDir, "good.js");
    const bad = path.join(extDir, "bad.js");
    const marker = path.join(extDir, "events.log");
    await writeExtFile(good, extBody(marker, { command: "rl_cut_ok", reply: "OK", toolDesc: "tool v1", toolReply: "tool-v1" }));
    await writeExtFile(bad, `throw new Error("cutover boom");`);
    process.env.ATOM_EXTENSIONS = `${good}${path.delimiter}${bad}`;
    grantProjectTrust(process.cwd(), home);
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps(home)} />);
    try {
      // Boot announces per-extension errors in its own line format; the
      // "extension warning:" lines are the /reload cutover's format.
      await waitForFrame(app, "1 failed");
      expect(app.lastFrame()).toMatch(/cutover boom/);
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      expect(app.lastFrame()).toMatch(/extensions: 1 loaded, 1 failed/);
      expect(app.lastFrame()).toMatch(/cutover boom/);
      // The good extension survived the broken sibling.
      expect(getExtensionCommand("rl_cut_ok")).toBeDefined();
      app.stdin.write("/rl_cut_ok");
      app.stdin.write("\r");
      await waitForFrame(app, "OK");
    } finally {
      app.unmount();
    }
  });

  test("a total reload failure keeps the previous runtime live", async () => {
    const home = await tmpDir();
    const extDir = await tmpDir();
    const entry = path.join(extDir, "cut.js");
    const marker = path.join(extDir, "events.log");
    await writeExtFile(entry, extBody(marker, { command: "rl_cut_a", reply: "A-v1", toolDesc: "tool v1", toolReply: "tool-v1" }));
    process.env.ATOM_EXTENSIONS = entry;
    grantProjectTrust(process.cwd(), home);
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps(home)} />);
    try {
      await waitForFrame(app, "extensions: 1 loaded");
      process.env.ATOM_RELOAD_THROW_ONCE = "1";
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "reload failed: synthetic total failure");
      // Previous extensions were restored and still run.
      expect(getExtensionCommand("rl_cut_a")).toBeDefined();
      app.stdin.write("/rl_cut_a");
      app.stdin.write("\r");
      await waitForFrame(app, "A-v1");
    } finally {
      app.unmount();
    }
  });
});
