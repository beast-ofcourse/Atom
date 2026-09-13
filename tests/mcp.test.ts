// MCP servers (tickets 01 local stdio + 02 remote HTTP): config parsing,
// tool-name mapping, live round-trips against in-test stub servers, and
// failure surfacing. Hermetic: every test uses temp dirs, an isolated
// ATOM_HOME, and ephemeral ports; stub children are shut down in afterEach
// so no process or port ever leaks into other suites.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadAtomConfig, projectConfigPath } from "../src/config.js";
import { McpManager, mcpManager } from "../src/mcp/manager.js";
import {
  authFilePath,
  getEntryForUrl,
  isTokenExpired,
  loadAuthFile,
  removeEntry,
  saveAuthFile,
  setClientInfo,
  setTokens,
} from "../src/mcp/auth.js";
import { startCallbackServer } from "../src/mcp/oauth.js";
import {
  mcpToolName,
  parseMcpServerEntry,
  sanitizeMcpName,
} from "../src/mcp/config.js";
import { checkRules, parseRuleInput } from "../src/permissions.js";
import { decidePolicy } from "../src/policy.js";
import {
  chatToolDefinitions,
  describeToolCall,
  executeTool,
  needsApproval,
  toolNames,
  validateToolArgs,
} from "../src/tools.js";

const savedAtomHome = process.env.ATOM_HOME;
let dirs: string[] = [];
let managers: McpManager[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function track(manager: McpManager): McpManager {
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
  await mcpManager.resetForTests();
  if (savedAtomHome === undefined) delete process.env.ATOM_HOME;
  else process.env.ATOM_HOME = savedAtomHome;
  // Windows holds cwd locks on freshly-killed children: retry removals
  // briefly instead of failing the suite on EBUSY.
  for (const d of dirs) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fsp.rm(d, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 9) throw e;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  dirs = [];
});

// ATOM_HOME points at an empty dir so the real global config can never
// leak servers into these tests.
async function isolateHome(): Promise<void> {
  process.env.ATOM_HOME = await tmpDir("atom-mcp-home-");
}

async function writeAtomJson(projectDir: string, mcp: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(projectConfigPath(projectDir), JSON.stringify({ mcp }), "utf8");
}

// Minimal stdio MCP stub: initialize / tools/list / tools/call(add).
// Writes NDJSON on stdout like a real local server.
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

async function writeStdioStub(dir: string): Promise<string> {
  const p = path.join(dir, "mcp-stdio-stub.mjs");
  await fsp.writeFile(p, STDIO_STUB, "utf8");
  return p;
}

type HttpStubMode = "json" | "sse" | "auth";

async function startHttpStub(mode: HttpStubMode): Promise<{ server: Server; url: string; seen: { authorization?: string } }> {
  const seen: { authorization?: string } = {};
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      if (mode === "auth") {
        res.writeHead(401).end();
        return;
      }
      let msg: { id?: number; method?: string; params?: { arguments?: { a: number; b: number } } } = {};
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (msg.method === "initialize") {
        seen.authorization = req.headers["authorization"];
        const result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } };
        if (mode === "sse") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        }
        return;
      }
      if (msg.method === "tools/list") {
        const result = {
          tools: [
            {
              name: "add",
              description: "Add two numbers",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
                additionalProperties: false,
              },
            },
          ],
        };
        if (mode === "sse") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        }
        return;
      }
      if (msg.method === "tools/call") {
        const a = msg.params?.arguments ?? { a: 0, b: 0 };
        const result = { content: [{ type: "text", text: String(a.a + a.b) }] };
        if (mode === "sse") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        }
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/mcp`, seen };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("mcp config entry validation", () => {
  test("valid local and remote entries parse", () => {
    expect(parseMcpServerEntry({ type: "local", command: ["npx", "-y", "x"] })).toEqual({
      type: "local",
      command: ["npx", "-y", "x"],
    });
    expect(parseMcpServerEntry({ type: "remote", url: "https://mcp.example.com/mcp" })).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
    });
  });

  test("bad entries return error fragments, never throw", () => {
    expect(typeof parseMcpServerEntry({ type: "local", command: [] })).toBe("string");
    expect(typeof parseMcpServerEntry({ type: "local" })).toBe("string");
    expect(typeof parseMcpServerEntry({ type: "remote", url: "notaurl" })).toBe("string");
    expect(typeof parseMcpServerEntry({ type: "remote" })).toBe("string");
    expect(typeof parseMcpServerEntry({ type: "smtp" })).toBe("string");
    expect(typeof parseMcpServerEntry("nope")).toBe("string");
  });

  test("invalid enabled/timeout fall back with warnings instead of dropping", () => {
    const warnings: string[] = [];
    const parsed = parseMcpServerEntry(
      { type: "local", command: ["x"], enabled: "yes", timeout: -5 },
      (m) => warnings.push(m)
    );
    expect(typeof parsed).not.toBe("string");
    expect(warnings).toHaveLength(2);
  });

  test("tool-name sanitization folds unsafe chars", () => {
    expect(sanitizeMcpName("my-server.v2")).toBe("my-server_v2");
    expect(mcpToolName("my-server", "do thing")).toBe("my-server_do_thing");
  });

  test("atom.json mcp key loads with per-entry warnings", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    await writeAtomJson(project, {
      good: { type: "local", command: ["x"] },
      bad: { type: "local", command: [] },
    });
    const loaded = loadAtomConfig(project);
    expect(Object.keys(loaded.config.mcp ?? {})).toEqual(["good"]);
    expect(loaded.warnings.some((w) => w.includes('"mcp.bad"'))).toBe(true);
  });
});

describe("mcp local stdio round-trip (ticket 01)", () => {
  test("spawn, list, validate, call, status", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStdioStub(project);
    await writeAtomJson(project, { t1: { type: "local", command: [process.execPath, stub] } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual(["t1_add"]);
    expect(manager.status()["t1"]).toEqual({ status: "connected", tools: 1 });
    expect(manager.validateArgs("t1_add", { a: 1, b: 2 })).toBeNull();
    expect(manager.validateArgs("t1_add", { a: 1 })).toContain('missing required field "b"');
    expect(await manager.execute("t1_add", { a: 1, b: 2 }, project)).toBe("3");
  });

  test("disabled servers never spawn", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStdioStub(project);
    await writeAtomJson(project, { t1: { type: "local", command: [process.execPath, stub], enabled: false } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual([]);
    expect(manager.status()["t1"]).toEqual({ status: "disabled" });
  });

  test("sanitized-name collision: first wins, loser collected in warnings() (never console)", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStdioStub(project);
    // "sv.one" and "sv_one" both sanitize to sv_one_add for tool "add".
    await writeAtomJson(project, {
      "sv.one": { type: "local", command: [process.execPath, stub] },
      sv_one: { type: "local", command: [process.execPath, stub] },
    });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual(["sv_one_add"]);
    expect(manager.status()["sv.one"]).toEqual({ status: "connected", tools: 1 });
    expect(manager.status()["sv_one"]).toEqual({ status: "connected", tools: 0 });
    const warnings = manager.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sv_one.add");
    expect(warnings[0]).toContain("already claimed");
  });

  test("missing binary fails cleanly with an Error string", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    await writeAtomJson(project, { t1: { type: "local", command: ["atom-definitely-missing-binary-xyz"] } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual([]);
    const status = manager.status()["t1"];
    expect(status.status).toBe("failed");
    expect(await manager.execute("t1_anything", {}, project)).toMatch(/^Error: unknown tool/);
  });
});

describe("mcp remote HTTP round-trip (ticket 02)", () => {
  test("connect, headers, call, status", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await startHttpStub("json");
    try {
      await writeAtomJson(project, {
        r1: { type: "remote", url: stub.url, headers: { Authorization: "Bearer SECRET" } },
      });
      const manager = track(new McpManager());
      await manager.refresh(project);
      expect(manager.names()).toEqual(["r1_add"]);
      expect(manager.status()["r1"]).toEqual({ status: "connected", tools: 1 });
      expect(await manager.execute("r1_add", { a: 4, b: 5 }, project)).toBe("9");
      expect(stub.seen.authorization).toBe("Bearer SECRET");
    } finally {
      await closeServer(stub.server);
    }
  });

  test("SSE event-stream responses parse", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await startHttpStub("sse");
    try {
      await writeAtomJson(project, { r1: { type: "remote", url: stub.url } });
      const manager = track(new McpManager());
      await manager.refresh(project);
      expect(manager.names()).toEqual(["r1_add"]);
      expect(await manager.execute("r1_add", { a: 2, b: 3 }, project)).toBe("5");
    } finally {
      await closeServer(stub.server);
    }
  });

  test("unreachable server fails without blocking", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    await writeAtomJson(project, { r1: { type: "remote", url: "http://127.0.0.1:1/mcp" } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual([]);
    expect(manager.status()["r1"]?.status).toBe("failed");
  });

  test("401 becomes needs_auth, not a generic failure", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await startHttpStub("auth");
    try {
      await writeAtomJson(project, { r1: { type: "remote", url: stub.url } });
      const manager = track(new McpManager());
      await manager.refresh(project);
      expect(manager.status()["r1"]).toEqual({ status: "needs_auth" });
      expect(manager.names()).toEqual([]);
    } finally {
      await closeServer(stub.server);
    }
  });
});

describe("mcp registry integration", () => {
  test("names, definitions, approval, validation, and executeTool", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStdioStub(project);
    await writeAtomJson(project, { t1: { type: "local", command: [process.execPath, stub] } });
    await mcpManager.refresh(project);
    expect(toolNames()).toContain("t1_add");
    expect(chatToolDefinitions().some((d) => d.function.name === "t1_add")).toBe(true);
    expect(needsApproval("t1_add")).toBe(true);
    expect(validateToolArgs("t1_add", { a: 1 })).toContain('missing required field "b"');
    expect(await executeTool("t1_add", { a: 10, b: 20 }, project)).toBe("30");
  });
});

// A stdio stub that answers initialize/list but never answers tools/call.
const HANG_STUB = `
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
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "hang", description: "Never answers", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } }) + "\\n");
    } else if (m.method === "tools/call") {
      // Hang deliberately: the timeout path under test. Every other unknown
      // method still gets a fast method-not-found (like a real server).
    } else if (m.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } }) + "\\n");
    }
  }
});
`;

// A stdio stub whose tool returns a ~200KB text payload.
const BIG_STUB = `
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
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "big", description: "Huge output", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } }) + "\\n");
    } else if (m.method === "tools/call") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "y".repeat(200 * 1024) }] } }) + "\\n");
    } else if (m.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } }) + "\\n");
    }
  }
});
`;

async function writeStub(dir: string, name: string, source: string): Promise<string> {
  const p = path.join(dir, name);
  await fsp.writeFile(p, source, "utf8");
  return p;
}

function mustParse(pattern: string, kind: "allow" | "deny") {
  const rule = parseRuleInput(pattern, kind);
  if (!rule) throw new Error(`test rule rejected: ${pattern}`);
  return rule;
}

describe("mcp approval, permissions, timeouts (ticket 03)", () => {
  test("glob tool-part scopes a whole server; exact names stay exact", () => {
    const allowServer = mustParse("t1_*", "allow");
    expect(parseRuleInput("t1_*", "allow")).not.toBeNull();
    expect(checkRules([allowServer], "t1_add", {})).toBe("allow");
    expect(checkRules([allowServer], "t1_other", {})).toBe("allow");
    expect(checkRules([allowServer], "t2_add", {})).toBeNull();
    // No wildcards still means equality: `write` never matches `writer`.
    expect(checkRules([mustParse("write", "allow")], "writer", { path: "x" })).toBeNull();
    expect(checkRules([mustParse("write", "allow")], "write", { path: "x" })).toBe("allow");
  });

  test("deny wins over allow for MCP names", () => {
    const rules = [mustParse("t1_add", "allow"), mustParse("t1_*", "deny")];
    expect(checkRules(rules, "t1_add", {})).toBe("deny");
    expect(checkRules(rules, "t1_other", {})).toBe("deny");
  });

  test("approval policy: prompt in normal, auto-run in yolo, allow-rule wins", () => {
    const base = {
      trustAll: false,
      alwaysAllowed: new Set<string>(),
      skillGrants: new Set<string>(),
      approvalGated: true,
    };
    expect(decidePolicy("t1_add", {}, { ...base, mode: "normal", rules: [] })).toEqual({ kind: "prompt" });
    expect(decidePolicy("t1_add", {}, { ...base, mode: "yolo", rules: [] })).toEqual({
      kind: "allow",
      via: "yolo",
    });
    expect(
      decidePolicy("t1_add", {}, { ...base, mode: "normal", rules: [mustParse("t1_*", "allow")] })
    ).toEqual({ kind: "allow", via: "allow-rule" });
    expect(
      decidePolicy(
        "t1_add",
        {},
        { ...base, mode: "yolo", rules: [mustParse("t1_*", "deny"), mustParse("t1_*", "allow")] }
      )
    ).toEqual({ kind: "deny" });
  });

  test("hanging server times out naming the server and tool", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-hang-stub.mjs", HANG_STUB);
    await writeAtomJson(project, { t3: { type: "local", command: [process.execPath, stub], timeout: 300 } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual(["t3_hang"]);
    const out = await manager.execute("t3_hang", {}, project);
    expect(out).toMatch(/^Error: /);
    expect(out).toContain("t3_hang");
    expect(out).toContain('"t3"');
    expect(out).toContain("timed out");
    const status = manager.status()["t3"];
    expect(status.status).toBe("connected");
  });

  test("oversized output truncates with a followable pointer", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-big-stub.mjs", BIG_STUB);
    await writeAtomJson(project, { t4: { type: "local", command: [process.execPath, stub] } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    const out = await manager.execute("t4_big", {}, project);
    expect(out.length).toBeLessThan(100 * 1024);
    expect(out).toContain("[truncated: mcp t4_big output exceeded 64KB;");
    expect(out).toContain("[overflow:");
    expect(out).toContain("use read with offset/limit to page through it]");
  });

  test("MCP calls render a one-line activity label", () => {
    expect(describeToolCall("t1_add", { a: 1 })).toBe("⚙ t1_add");
  });
});

// A stdio stub with tools + resources (+templates) + prompts.
const RESOURCE_STUB = `
let buf = "";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const sendErr = (id) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "not found" } }) + "\\n");
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
      send(m.id, { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "stub", version: "0" } });
    } else if (m.method === "tools/list") {
      send(m.id, { tools: [] });
    } else if (m.method === "resources/list") {
      send(m.id, { resources: [
        { uri: "stub://docs", name: "docs", mimeType: "text/plain" },
        { uri: "stub://blob", name: "blob", mimeType: "image/png" },
      ] });
    } else if (m.method === "resources/templates/list") {
      send(m.id, { resourceTemplates: [{ uriTemplate: "stub://doc/{id}", name: "doc" }] });
    } else if (m.method === "resources/read") {
      const uri = m.params.uri;
      if (uri === "stub://docs") send(m.id, { contents: [{ uri, mimeType: "text/plain", text: "hello docs" }] });
      else if (uri === "stub://blob") send(m.id, { contents: [{ uri, mimeType: "image/png", blob: "iVBORw0KGgo=" }] });
      else if (uri === "stub://big") send(m.id, { contents: [{ uri, mimeType: "text/plain", text: "z".repeat(100 * 1024) }] });
      else sendErr(m.id);
    } else if (m.method === "prompts/list") {
      send(m.id, { prompts: [{ name: "greet", description: "Greet someone", arguments: [{ name: "who", required: true }] }] });
    } else if (m.method === "prompts/get") {
      const who = (m.params.arguments || {}).who || "there";
      send(m.id, { description: "A greeting", messages: [{ role: "user", content: { type: "text", text: "hi " + who } }] });
    }
  }
});
`;

// A tools-only stdio stub: resources/prompts answer method-not-found.
const PLAIN_STUB = `
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
    const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
    } else {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } });
    }
  }
});
`;

describe("mcp resources and prompts (ticket 04)", () => {
  async function resourceProject(): Promise<{ project: string; manager: McpManager }> {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-res-stub.mjs", RESOURCE_STUB);
    await writeAtomJson(project, { res: { type: "local", command: [process.execPath, stub] } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    return { project, manager };
  }

  test("list + scoped list + templates", async () => {
    const { manager } = await resourceProject();
    expect(manager.status()["res"]?.status).toBe("connected");
    const all = await manager.listResources();
    expect(all.map((r) => r.resource["uri"]).sort()).toEqual(["stub://blob", "stub://docs"]);
    expect(all[0]?.server).toBe("res");
    const scoped = await manager.listResources("res");
    expect(scoped).toHaveLength(2);
    const templates = await manager.listResourceTemplates();
    expect(templates.map((t) => t.template["uriTemplate"])).toEqual(["stub://doc/{id}"]);
  });

  test("read text, blob omission, oversized truncation", async () => {
    const { manager } = await resourceProject();
    expect(await manager.readResource("res", "stub://docs")).toContain("hello docs");
    const blob = await manager.readResource("res", "stub://blob");
    expect(blob).toContain("[Binary MCP resource omitted: stub://blob (image/png,");
    const big = await manager.readResource("res", "stub://big");
    expect(big.length).toBeLessThan(80 * 1024);
    expect(big).toContain("[truncated: mcp resource output exceeded 64KB;");
  });

  test("unknown resource URI is a clean Error", async () => {
    const { manager } = await resourceProject();
    expect(await manager.readResource("res", "stub://missing")).toMatch(/^Error: /);
  });

  test("unsupported server names its supporters, never crashes", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const resStub = await writeStub(project, "mcp-res-stub.mjs", RESOURCE_STUB);
    const plainStub = await writeStub(project, "mcp-plain-stub.mjs", PLAIN_STUB);
    await writeAtomJson(project, {
      res: { type: "local", command: [process.execPath, resStub] },
      plain: { type: "local", command: [process.execPath, plainStub] },
    });
    const manager = track(new McpManager());
    await manager.refresh(project);
    // Cross-server list only surfaces the supporting server's resources.
    const all = await manager.listResources();
    expect(all.every((r) => r.server === "res")).toBe(true);
    // Scoped to the plain server: error names the supporter.
    await expect(manager.listResources("plain")).rejects.toThrow(/does not support resources.*res/);
    expect(await manager.readResource("plain", "stub://docs")).toMatch(/does not support resources.*res/);
    expect(await manager.getPrompt("plain", "greet", {})).toMatch(/does not support prompts/);
  });

  test("prompts list and get, with string-arg enforcement", async () => {
    const { manager } = await resourceProject();
    const prompts = await manager.listPrompts();
    expect(prompts.map((p) => p.prompt["name"])).toEqual(["greet"]);
    expect(await manager.getPrompt("res", "greet", { who: "atom" })).toContain("hi atom");
    expect(await manager.getPrompt("res", "greet", { who: 42 })).toMatch(/must be a string/);
  });

  test("resource tools join the registry only with support present", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const plainStub = await writeStub(project, "mcp-plain-stub.mjs", PLAIN_STUB);
    await writeAtomJson(project, { plain: { type: "local", command: [process.execPath, plainStub] } });
    await mcpManager.refresh(project);
    expect(toolNames()).not.toContain("list_mcp_resources");
    expect(toolNames()).toContain("plain_ping");

    const resStub = await writeStub(project, "mcp-res-stub.mjs", RESOURCE_STUB);
    await writeAtomJson(project, {
      plain: { type: "local", command: [process.execPath, plainStub] },
      res: { type: "local", command: [process.execPath, resStub] },
    });
    await mcpManager.refresh(project);
    expect(toolNames()).toContain("list_mcp_resources");
    expect(toolNames()).toContain("list_mcp_resource_templates");
    expect(toolNames()).toContain("read_mcp_resource");
    expect(needsApproval("read_mcp_resource")).toBe(true);
    expect(await executeTool("list_mcp_resources", {}, project)).toContain("stub://docs");
    expect(await executeTool("list_mcp_resources", { server: "res" }, project)).toContain("stub://docs");
    expect(await executeTool("read_mcp_resource", { server: "res", uri: "stub://docs" }, project)).toContain(
      "hello docs"
    );
    expect(validateToolArgs("read_mcp_resource", { server: "res" })).toContain('missing required field "uri"');
  });
});

type OAuthStub = {
  server: Server;
  url: string;
  seen: { registerBody: unknown; tokenGrants: string[]; authorizeHit: boolean };
};

async function startOAuthStub(opts?: { noRegister?: boolean }): Promise<OAuthStub> {
  const seen: OAuthStub["seen"] = { registerBody: undefined, tokenGrants: [], authorizeHit: false };
  let base = "";
  const json = (res: ServerResponse, payload: unknown): void => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
        json(res, {
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(opts?.noRegister ? {} : { registration_endpoint: `${base}/register` }),
        });
      } else if (url.pathname === "/register" && req.method === "POST") {
        try {
          seen.registerBody = JSON.parse(body);
        } catch {
          seen.registerBody = null;
        }
        json(res, { client_id: "stub-client", client_secret: "stub-secret", client_id_issued_at: 1 });
      } else if (url.pathname === "/authorize") {
        seen.authorizeHit = true;
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "AUTHCODE-1");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: redirect.toString() }).end();
      } else if (url.pathname === "/token" && req.method === "POST") {
        const p = new URLSearchParams(body);
        seen.tokenGrants.push(p.get("grant_type") ?? "?");
        if (
          p.get("grant_type") === "authorization_code" &&
          p.get("code") === "AUTHCODE-1" &&
          p.get("code_verifier")
        ) {
          json(res, { access_token: "tok-1", refresh_token: "ref-1", expires_in: 3600, token_type: "Bearer" });
        } else if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "ref-1") {
          json(res, { access_token: "tok-2", expires_in: 3600, token_type: "Bearer" });
        } else if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "ref-old") {
          json(res, { access_token: "tok-new", expires_in: 3600, token_type: "Bearer" });
        } else {
          res.writeHead(400).end();
        }
      } else if (url.pathname === "/mcp" && req.method === "POST") {
        const auth = req.headers.authorization ?? "";
        if (auth !== "Bearer tok-1" && auth !== "Bearer tok-2" && auth !== "Bearer tok-new") {
          res.writeHead(401).end();
          return;
        }
        let m: { id?: number; method?: string; params?: { arguments?: Record<string, unknown> } } = {};
        try {
          m = JSON.parse(body);
        } catch {
          res.writeHead(400).end();
          return;
        }
        if (m.method === "initialize") {
          json(res, {
            jsonrpc: "2.0",
            id: m.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-stub", version: "0" },
            },
          });
        } else if (m.method === "tools/list") {
          json(res, {
            jsonrpc: "2.0",
            id: m.id,
            result: {
              tools: [
                {
                  name: "whoami",
                  description: "Who",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            },
          });
        } else if (m.method === "tools/call") {
          json(res, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "authed" }] } });
        } else {
          json(res, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } });
        }
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { server, url: `${base}/mcp`, seen };
}

// Drive the headless "browser": capture the authorize URL from onRedirect,
// follow its redirect into the loopback callback, then await the flow.
async function driveBrowserFlow<T>(authPromise: Promise<T>, redirect: () => string | undefined): Promise<T> {
  let url: string | undefined;
  for (let i = 0; i < 100 && !url; i++) {
    url = redirect();
    if (!url) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!url) throw new Error("OAuth flow never redirected");
  const first = await fetch(url, { redirect: "manual" });
  const location = first.headers.get("location");
  if (!location) throw new Error("authorize endpoint did not redirect");
  await first.arrayBuffer().catch(() => {});
  await fetch(location).then((r) => r.arrayBuffer().catch(() => {}));
  return authPromise;
}

describe("mcp OAuth (ticket 05)", () => {
  test("token store round-trips, binds URLs, and sanitizes", async () => {
    await isolateHome();
    const file = authFilePath();
    saveAuthFile({ servers: {} }, file);
    const loaded = loadAuthFile(file);
    setTokens(loaded, "s", { accessToken: "a", refreshToken: "r", expiresAt: 999, scope: "x" }, "https://x/mcp");
    saveAuthFile(loaded, file);
    const reread = loadAuthFile(file);
    expect(getEntryForUrl(reread, "s", "https://x/mcp")?.tokens?.accessToken).toBe("a");
    // URL change invalidates.
    expect(getEntryForUrl(reread, "s", "https://y/mcp")).toBeUndefined();
    expect(isTokenExpired({ accessToken: "a", expiresAt: Date.now() / 1000 - 10 })).toBe(true);
    expect(isTokenExpired({ accessToken: "a", expiresAt: Date.now() / 1000 + 3600 })).toBe(false);
    expect(isTokenExpired({ accessToken: "a" })).toBe(false);
    expect(removeEntry(reread, "s")).toBe(true);
    expect(removeEntry(reread, "s")).toBe(false);
    // Malformed files read as empty, never throw.
    await fsp.writeFile(file, "{nope", "utf8");
    expect(loadAuthFile(file)).toEqual({ servers: {} });
  });

  test("full browser flow with dynamic registration", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await startOAuthStub();
    try {
      await writeAtomJson(project, { priv: { type: "remote", url: stub.url } });
      const manager = track(new McpManager());
      await manager.refresh(project);
      expect(manager.status()["priv"]).toEqual({ status: "needs_auth" });
      expect(manager.getAuthStatus("priv", project)).toBe("not_authenticated");
      let redirectUrl: string | undefined;
      const status = await driveBrowserFlow(
        manager.authenticate("priv", {
          openBrowser: false,
          onRedirect: (url) => {
            redirectUrl = url;
          },
          cwd: project,
        }),
        () => redirectUrl
      );
      expect(status).toEqual({ status: "connected", tools: 1 });
      // Registration committed the loopback redirect URI.
      const registered = stub.seen.registerBody as Record<string, unknown>;
      expect(stub.seen.authorizeHit).toBe(true);
      expect(registered["redirect_uris"] as string[]).toHaveLength(1);
      expect((registered["redirect_uris"] as string[])[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(stub.seen.tokenGrants).toEqual(["authorization_code"]);
      // Credentials persisted and bound: tools callable, status authenticated.
      expect(manager.getAuthStatus("priv", project)).toBe("authenticated");
      expect(await manager.execute("priv_whoami", {}, project)).toBe("authed");
      const stored = loadAuthFile();
      expect(stored.servers["priv"]?.tokens?.accessToken).toBe("tok-1");
      expect(stored.servers["priv"]?.tokens?.refreshToken).toBe("ref-1");
      expect(stored.servers["priv"]?.clientInfo?.clientId).toBe("stub-client");
    } finally {
      await closeServer(stub.server);
    }
  });

  test("expired tokens refresh inline and keep the old refresh token", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await startOAuthStub();
    try {
      await writeAtomJson(project, { priv: { type: "remote", url: stub.url } });
      const file = loadAuthFile();
      setTokens(
        file,
        "priv",
        { accessToken: "tok-dead", refreshToken: "ref-old", expiresAt: Date.now() / 1000 - 10 },
        stub.url
      );
      setClientInfo(file, "priv", { clientId: "stub-client", clientSecret: "stub-secret" }, stub.url);
      saveAuthFile(file);
      const manager = track(new McpManager());
      await manager.refresh(project);
      expect(manager.status()["priv"]).toEqual({ status: "connected", tools: 1 });
      expect(stub.seen.tokenGrants).toEqual(["refresh_token"]);
      expect(await manager.execute("priv_whoami", {}, project)).toBe("authed");
      // Server omitted a fresh refresh token: the old one is retained.
      const stored = loadAuthFile();
      expect(stored.servers["priv"]?.tokens?.accessToken).toBe("tok-new");
      expect(stored.servers["priv"]?.tokens?.refreshToken).toBe("ref-old");
      expect(manager.getAuthStatus("priv", project)).toBe("authenticated");
    } finally {
      await closeServer(stub.server);
    }
  });

  test("expired tokens without refresh report expired state", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await startOAuthStub();
    try {
      await writeAtomJson(project, { priv: { type: "remote", url: stub.url } });
      const file = loadAuthFile();
      setTokens(file, "priv", { accessToken: "tok-dead", expiresAt: Date.now() / 1000 - 10 }, stub.url);
      saveAuthFile(file);
      const manager = track(new McpManager());
      expect(manager.getAuthStatus("priv", project)).toBe("expired");
      await manager.refresh(project);
      expect(manager.status()["priv"]).toEqual({ status: "needs_auth" });
    } finally {
      await closeServer(stub.server);
    }
  });

  test("logout removes credentials", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await startOAuthStub();
    try {
      await writeAtomJson(project, { priv: { type: "remote", url: stub.url } });
      const manager = track(new McpManager());
      let redirectUrl: string | undefined;
      await driveBrowserFlow(
        manager.authenticate("priv", {
          openBrowser: false,
          onRedirect: (url) => {
            redirectUrl = url;
          },
          cwd: project,
        }),
        () => redirectUrl
      );
      expect(await manager.removeAuth("priv")).toBe(true);
      expect(await manager.removeAuth("priv")).toBe(false);
      expect(manager.getAuthStatus("priv", project)).toBe("not_authenticated");
      await manager.refresh(project);
      expect(manager.status()["priv"]).toEqual({ status: "needs_auth" });
    } finally {
      await closeServer(stub.server);
    }
  });

  test("no registration endpoint without clientId fails with guidance", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await startOAuthStub({ noRegister: true });
    try {
      await writeAtomJson(project, { priv: { type: "remote", url: stub.url } });
      const manager = track(new McpManager());
      const status = await manager.authenticate("priv", { openBrowser: false, cwd: project });
      expect(status.status).toBe("failed");
      if (status.status === "failed") expect(status.error).toMatch(/pre-registered/);
      expect(stub.seen.authorizeHit).toBe(false);
    } finally {
      await closeServer(stub.server);
    }
  });

  test("callback rejects a forged state (CSRF)", async () => {
    const callback = await startCallbackServer();
    try {
      const pending = callback.waitForCode("real-state", 800);
      const forged = await fetch(`${callback.redirectUri}?code=EVIL&state=forged-state`);
      expect(forged.status).toBe(400);
      await forged.arrayBuffer().catch(() => {});
      await expect(pending).rejects.toThrow(/timed out/);
      // The real state still resolves afterwards.
      const pending2 = callback.waitForCode("real-state", 2000);
      const legit = await fetch(`${callback.redirectUri}?code=GOOD&state=real-state`);
      expect(legit.status).toBe(200);
      await legit.arrayBuffer().catch(() => {});
      await expect(pending2).resolves.toBe("GOOD");
    } finally {
      await callback.close();
    }
  });
});

// A stdio stub that serves initialize/list, then exits on its own.
const EXIT_STUB = `
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
    const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "bye", description: "Bye", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
      setTimeout(() => process.exit(0), 200);
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } });
    }
  }
});
`;

// A stdio stub whose tool catalog grows: first tools/list answers one tool
// and announces list_changed; later lists answer two.
const GROW_STUB = `
let buf = "";
let lists = 0;
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } });
    } else if (m.method === "tools/list") {
      lists += 1;
      const tools = lists === 1
        ? [{ name: "g_one", description: "One", inputSchema: { type: "object", properties: {}, additionalProperties: false } }]
        : [
            { name: "g_one", description: "One", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
            { name: "g_two", description: "Two", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
          ];
      send({ jsonrpc: "2.0", id: m.id, result: { tools } });
      if (lists === 1) {
        // Announce asynchronously (like a real server would after a change),
        // so the client is fully connected when the hook fires.
        setTimeout(() => {
          send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
        }, 400);
      }
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } });
    }
  }
});
`;

async function waitFor(cond: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("mcp manage and harden (ticket 06)", () => {
  test("toggle round-trip persists and reconnects", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-stub.mjs", STDIO_STUB);
    await writeAtomJson(project, { t1: { type: "local", command: [process.execPath, stub] } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual(["t1_add"]);

    const disabled = await manager.setServerEnabled("t1", false, project);
    expect(disabled).toEqual({ status: "disabled" });
    expect(manager.names()).toEqual([]);
    const persisted = JSON.parse(await fsp.readFile(projectConfigPath(project), "utf8")) as {
      mcp: Record<string, { enabled: boolean }>;
    };
    expect(persisted.mcp["t1"]?.enabled).toBe(false);

    const enabled = await manager.setServerEnabled("t1", true, project);
    expect(enabled).toEqual({ status: "connected", tools: 1 });
    expect(manager.names()).toEqual(["t1_add"]);
    expect(await manager.execute("t1_add", { a: 1, b: 1 }, project)).toBe("2");
  });

  test("toggling an unknown server returns null", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    await writeAtomJson(project, {});
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(await manager.setServerEnabled("ghost", false, project)).toBeNull();
  });

  test("exited process evicts tools and marks failed", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-exit-stub.mjs", EXIT_STUB);
    await writeAtomJson(project, { t1: { type: "local", command: [process.execPath, stub] } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual(["t1_bye"]);
    await waitFor(() => manager.status()["t1"]?.status === "failed", "eviction after process exit");
    expect(manager.names()).toEqual([]);
    expect(await manager.execute("t1_bye", {}, project)).toMatch(/^Error: unknown tool/);
  });

  test("one failing server never blocks the rest", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-stub.mjs", STDIO_STUB);
    await writeAtomJson(project, {
      good: { type: "local", command: [process.execPath, stub] },
      bad: { type: "local", command: ["atom-definitely-missing-binary-xyz"] },
      off: { type: "local", command: [process.execPath, stub], enabled: false },
    });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.status()["good"]).toEqual({ status: "connected", tools: 1 });
    expect(manager.status()["bad"]?.status).toBe("failed");
    expect(manager.status()["off"]).toEqual({ status: "disabled" });
    expect(manager.names()).toEqual(["good_add"]);
    expect(await manager.execute("good_add", { a: 5, b: 6 }, project)).toBe("11");
  });

  test("list_changed notification refreshes the catalog live", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-grow-stub.mjs", GROW_STUB);
    await writeAtomJson(project, { g: { type: "local", command: [process.execPath, stub] } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual(["g_g_one"]);
    await waitFor(() => manager.names().includes("g_g_two"), "live catalog refresh");
    expect(manager.status()["g"]).toEqual({ status: "connected", tools: 2 });
  });

  test("CLI --mcp-list reports live status outside the TUI", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isInteger(major) || major < 20) return;
    await isolateHome();
    const home = process.env.ATOM_HOME!;
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-stub.mjs", STDIO_STUB);
    await writeAtomJson(project, { t1: { type: "local", command: [process.execPath, stub] } });
    const cli = path.resolve(process.cwd(), "src", "cli.tsx");
    // Run the real CLI through the tsx runner entry (absolute paths: the
    // child cwd is the hermetic project dir, so bare specifiers would not
    // resolve there). stderr is captured so a non-zero exit explains itself.
    const tsxCli = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const run = (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [tsxCli, cli, ...args],
          { cwd: project, env: { ...process.env, ATOM_HOME: home } },
          (error, stdout, stderr) => {
            resolve({
              stdout: String(stdout),
              stderr: String(stderr),
              code: error && "code" in error ? Number(error.code) : 0,
            });
          }
        ).on("error", reject);
      });
    const listed = await run(["--mcp-list"]);
    if (listed.code !== 0) throw new Error(`CLI failed: ${listed.stderr}`);
    expect(listed.stdout).toContain("t1: connected (1 tool(s))");
    const bare = await tmpDir("atom-mcp-bare-");
    const emptyOut = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      execFile(
        process.execPath,
        [tsxCli, cli, "--mcp-list"],
        { cwd: bare, env: { ...process.env, ATOM_HOME: home } },
        (error, stdout, stderr) => {
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            code: error && "code" in error ? Number(error.code) : 0,
          });
        }
      ).on("error", reject);
    });
    if (emptyOut.code !== 0) throw new Error(`CLI failed: ${emptyOut.stderr}`);
    expect(emptyOut.stdout).toContain("No MCP servers configured");
  }, 120000);

  test("toggle refuses to clobber an invalid project config", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    const stub = await writeStub(project, "mcp-stub.mjs", STDIO_STUB);
    await writeAtomJson(project, { t1: { type: "local", command: [process.execPath, stub] } });
    const manager = track(new McpManager());
    await manager.refresh(project);
    expect(manager.names()).toEqual(["t1_add"]);
    // Corrupt the project file after load: the toggle must refuse rather
    // than replace it with a config containing only the MCP key.
    await fsp.writeFile(projectConfigPath(project), "{corrupt", "utf8");
    expect(await manager.setServerEnabled("t1", false, project)).toBeNull();
    expect(await fsp.readFile(projectConfigPath(project), "utf8")).toBe("{corrupt");
  });

  test("legacy SSE fallback carries tools/call", async () => {
    await isolateHome();
    const project = await tmpDir("atom-mcp-proj-");
    let stream: ServerResponse | null = null;
    const frame = (payload: unknown): void => {
      stream?.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/mcp") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        stream = res;
        frame({ jsonrpc: "2.0", method: "endpoint-ignored" });
        res.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      if (req.method === "POST" && url.pathname === "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/messages") {
        let body = "";
        req.on("data", (c) => {
          body += c.toString("utf8");
        });
        req.on("end", () => {
          let m: { id?: number; method?: string; params?: { arguments?: { a: number; b: number } } } = {};
          try {
            m = JSON.parse(body);
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (m.method === "initialize") {
            frame({
              jsonrpc: "2.0",
              id: m.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "sse-stub", version: "0" },
              },
            });
          } else if (m.method === "tools/list") {
            frame({
              jsonrpc: "2.0",
              id: m.id,
              result: {
                tools: [
                  {
                    name: "add",
                    description: "Add",
                    inputSchema: {
                      type: "object",
                      properties: { a: { type: "number" }, b: { type: "number" } },
                      required: ["a", "b"],
                      additionalProperties: false,
                    },
                  },
                ],
              },
            });
          } else if (m.method === "tools/call") {
            const a = m.params?.arguments ?? { a: 0, b: 0 };
            frame({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(a.a + a.b) }] } });
          } else if (m.id !== undefined) {
            frame({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } });
          }
          res.writeHead(202).end();
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
    let manager: McpManager | undefined;
    try {
      await writeAtomJson(project, { sse: { type: "remote", url: stubUrl } });
      manager = track(new McpManager());
      await manager.refresh(project);
      expect(manager.names()).toEqual(["sse_add"]);
      expect(await manager.execute("sse_add", { a: 7, b: 8 }, project)).toBe("15");
    } finally {
      if (manager) await manager.shutdown();
      // Close the SSE stream side before closing the server, otherwise
      // the server's keep-alive holds the test open until timeout.
      if (stream) {
        try {
          (stream as unknown as { destroy: () => void }).destroy();
        } catch {}
        stream = null;
      }
      await closeServer(server);
    }
  });
});
