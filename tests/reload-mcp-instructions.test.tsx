// /reload finishing job — ticket 04. Manager-level tests pin MCP
// add/remove/reconfigure/unreachable across refresh; App-level tests pin
// edited instruction files reaching subsequent turns with history intact,
// the five-source summary line, and the help/docs wording.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App, helpListText, SLASH_COMMANDS } from "../src/App.js";
import { projectConfigPath } from "../src/config.js";
import { McpManager, mcpManager } from "../src/mcp/manager.js";
import { clearExtensionCommands } from "../src/extension-commands.js";
import {
  clearCompactionHooks,
  clearExtensionPromptHints,
  clearExtensionTools,
  clearProviderHooks,
  clearToolInterceptors,
  clearToolOverrides,
} from "../src/tools.js";

let dirs: string[] = [];
let managers: McpManager[] = [];
const savedAtomHome = process.env.ATOM_HOME;
const savedAgentsPath = process.env.OPENCODE_AGENTS_PATH;
async function tmpDir(prefix: string): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function track(m: McpManager): McpManager {
  managers.push(m);
  return m;
}
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
  await mcpManager.resetForTests();
  if (savedAtomHome === undefined) delete process.env.ATOM_HOME;
  else process.env.ATOM_HOME = savedAtomHome;
  if (savedAgentsPath === undefined) delete process.env.OPENCODE_AGENTS_PATH;
  else process.env.OPENCODE_AGENTS_PATH = savedAgentsPath;
  delete process.env.ATOM_EXTENSIONS;
  clearExtensionCommands();
  clearExtensionTools();
  clearToolInterceptors();
  clearToolOverrides();
  clearExtensionPromptHints();
  clearProviderHooks();
  clearCompactionHooks();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const d of dirs) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fsp.rm(d, { recursive: true, force: true });
        break;
      } catch {
        if (attempt === 9) throw new Error(`could not remove ${d}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  dirs = [];
});

// Minimal stdio MCP stub: initialize / tools/list / tools/call(add); any
// other method with an id gets method-not-found (capability probes off).
const STDIO_STUB = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } }) + "\\n");
    } else if (m.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } }] } }) + "\\n");
    } else if (m.method === "tools/call") {
      const a = m.params.arguments;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(a.a + a.b) }] } }) + "\\n");
    } else if (m.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } }) + "\\n");
    }
  }
});
`;
async function writeStub(dir: string, name: string): Promise<string> {
  const p = path.join(dir, name);
  await fsp.writeFile(p, STDIO_STUB, "utf8");
  return p;
}
async function writeMcpJson(projectDir: string, mcp: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(projectConfigPath(projectDir), JSON.stringify({ mcp }), "utf8");
}

describe("MCP refresh across config edits", () => {
  test("added, removed, and reconfigured servers take effect; unreachable is a status, never a throw", async () => {
    process.env.ATOM_HOME = await tmpDir("atom-mcp-home-");
    const project = await tmpDir("atom-mcp-proj-");
    const stubA = await writeStub(project, "stub-a.mjs");
    const stubB = await writeStub(project, "stub-b.mjs");
    await writeMcpJson(project, { calc: { type: "local", command: ["node", stubA] } });
    const mgr = track(new McpManager());
    await mgr.refresh(project);
    expect(mgr.status()["calc"]?.status).toBe("connected");
    expect(mgr.names()).toContain("calc_add");
    expect(await mgr.execute("calc_add", { a: 2, b: 3 }, project)).toBe("5");

    // Add a second server: its tools appear, the first server is untouched.
    await writeMcpJson(project, {
      calc: { type: "local", command: ["node", stubA] },
      calc2: { type: "local", command: ["node", stubB] },
    });
    await mgr.refresh(project);
    expect(mgr.names()).toContain("calc_add");
    expect(mgr.names()).toContain("calc2_add");

    // Remove the first: its tools disappear.
    await writeMcpJson(project, { calc2: { type: "local", command: ["node", stubB] } });
    await mgr.refresh(project);
    expect(mgr.names()).not.toContain("calc_add");
    expect(mgr.names()).toContain("calc2_add");

    // Reconfigure the survivor to an unreachable command: failed status,
    // no throw, and the manager stays usable.
    await writeMcpJson(project, { calc2: { type: "local", command: ["atom-definitely-missing-binary-xyz"] } });
    await mgr.refresh(project);
    expect(mgr.status()["calc2"]?.status).toBe("failed");
    expect(mgr.names()).not.toContain("calc2_add");
    // Unknown-tool execution still answers with an Error string (never throws).
    expect(await mgr.execute("calc2_add", {}, project)).toMatch(/^Error: /);
  });
});

// ---- App-level /reload ----

const realFetch = globalThis.fetch;
function mockChatCapture(bodies: string[]) {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    try {
      bodies.push(String(init?.body ?? ""));
    } catch {
      // capture is best-effort; the turn must never break on it
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) } as Response;
  });
}
async function waitForFrame(app: { lastFrame: () => string | undefined }, needle: string, timeout = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
function baseProps(home: string) {
  return {
    apiKey: "test-key",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
    skillDirs: { projectDir: home, homeDir: home },
    configDirs: { projectDir: home, homeDir: home },
    authHome: home,
  };
}

describe("/reload App: MCP, instructions, summary, help", () => {
  test("edited instruction files reach subsequent turns while history is untouched", async () => {
    const home = await tmpDir("atom-reload-instr-");
    process.env.ATOM_HOME = home;
    const agentsFile = path.join(home, "AGENTS.md");
    await fsp.writeFile(agentsFile, "# V1 marker: AGENTS-V1-MARKER\n", "utf8");
    process.env.OPENCODE_AGENTS_PATH = agentsFile;
    const bodies: string[] = [];
    mockChatCapture(bodies);
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "hello");
      await waitForFrame(app, "ok");
      await new Promise((r) => setTimeout(r, 800));
      // Edit the instruction file, then reload.
      await fsp.writeFile(agentsFile, "# V2 marker: AGENTS-V2-MARKER\n", "utf8");
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      expect(app.lastFrame()).toMatch(/instructions: 1 file/);
      expect(app.lastFrame()).toContain("hello");
      // The next turn carries the edited instructions (wait for its POST —
      // "ok" is already on screen from the first turn, so poll the capture).
      bodies.length = 0;
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "second");
      const start = Date.now();
      while (bodies.length === 0) {
        if (Date.now() - start > 15000) throw new Error(`no model POST after reload:\n${app.lastFrame()}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      const lastBody = bodies[bodies.length - 1] ?? "";
      expect(lastBody).toContain("AGENTS-V2-MARKER");
    } finally {
      app.unmount();
    }
  });

  test("MCP add/remove take effect; unreachable server warns without crashing the session", async () => {
    const home = await tmpDir("atom-reload-mcp-");
    process.env.ATOM_HOME = home;
    const stub = await writeStub(home, "stub.mjs");
    await writeMcpJson(home, { calc: { type: "local", command: ["node", stub] } });
    const bodies: string[] = [];
    mockChatCapture(bodies);
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "hello");
      await waitForFrame(app, "ok");
      await new Promise((r) => setTimeout(r, 800));
      // New server appears after reload (wait on its distinctive summary).
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "1 connected");
      expect(app.lastFrame()).toMatch(/mcp: 1 server\(s\) \(1 connected/);
      expect(mcpManager.names()).toContain("calc_add");
      // Removed server disappears after reload.
      await writeMcpJson(home, {});
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "mcp: 0 server(s)");
      expect(mcpManager.names()).not.toContain("calc_add");
      // Unreachable server becomes an inline warning, never a crash.
      await writeMcpJson(home, { ghost: { type: "local", command: ["atom-definitely-missing-binary-xyz"] } });
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, 'mcp warning: server "ghost" failed');
      expect(app.lastFrame()).toMatch(/1 failed/);
      // The session survived all three reloads.
      expect(app.lastFrame()).toContain("hello");
    } finally {
      app.unmount();
    }
  });

  test("summary covers every source with counts; help states what /reload preserves", async () => {
    const home = await tmpDir("atom-reload-sum-");
    process.env.ATOM_HOME = home;
    const bodies: string[] = [];
    mockChatCapture(bodies);
    const app = render(<App {...baseProps(home)} />);
    try {
      await new Promise((r) => setTimeout(r, 400));
      app.stdin.write("/reload");
      app.stdin.write("\r");
      await waitForFrame(app, "Reloaded");
      const frame = app.lastFrame() ?? "";
      // The summary wraps across terminal lines, so pin the source order
      // with newline-tolerant matching plus each per-source count.
      expect(frame.replace(/\n/g, " ")).toMatch(/Reloaded config: .*; skills: .*; extensions: .*; mcp: .*; instructions: .*— conversation kept\./);
      expect(frame).toMatch(/config: (project \+ global|project|global|none)/);
      expect(frame).toMatch(/skills: \d+ total/);
      expect(frame).toMatch(/extensions: \d+ loaded/);
      expect(frame).toMatch(/mcp: \d+ server\(s\)/);
      expect(frame).toMatch(/instructions: (none|\d+ file)/);
    } finally {
      app.unmount();
    }
    // Help text and command docs mention /reload and its preserves.
    expect(helpListText()).toMatch(/\/reload/);
    expect(helpListText()).toMatch(/conversation.*session.*trust.*mode/i);
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/reload");
    expect(cmd!.description).toMatch(/MCP/i);
    expect(cmd!.description).toMatch(/instruction/i);
    expect(cmd!.description).toMatch(/conversation.*session.*trust.*mode kept/i);
  });
});
