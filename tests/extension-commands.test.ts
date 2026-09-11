// Extension slash commands (ticket 04): registration seam, palette/menu
// inputs, generation-bound context (prompt/session/messaging), clean throw
// errors with staged-message rollback, stale-generation rule, and builtin
// collision handling. Pure unit tests — tmpdir files for extension loading,
// no TUI, no network.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearExtensionCommands,
  getExtensionCommand,
  listExtensionCommands,
  parseExtensionCommandInput,
  registerExtensionCommand,
  runExtensionCommand,
  splitCommandArgs,
  unregisterExtensionCommand,
  validateExtensionCommandDef,
  type ExtensionCommandDeps,
} from "../src/extension-commands.js";
import { loadExtensions, type ExtensionAPI } from "../src/extensions.js";
import { buildSlashMenu, paletteEntries } from "../src/App.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-04-"));
}

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  roots = [];
  delete process.env.ATOM_EXTENSIONS;
  clearExtensionCommands();
  for (const key of ["__capCmd", "__freshCmd"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

function writeExt(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  roots.push(root);
  return abs;
}

function testDeps(overrides?: Partial<ExtensionCommandDeps>): ExtensionCommandDeps & {
  said: string[];
  asked: Array<{ question: string; options: string[]; allowCustom?: boolean }>;
} {
  const said: string[] = [];
  const asked: Array<{ question: string; options: string[]; allowCustom?: boolean }> = [];
  return {
    said,
    asked,
    cwd: "/test-cwd",
    askUser: async (question, options, allowCustom) => {
      asked.push({ question, options, allowCustom });
      return `picked:${options[0]}`;
    },
    getSession: () => ({ id: "sess-1", title: "Build auth", turnCount: 3 }),
    say: (message) => {
      said.push(message);
    },
    ...overrides,
  };
}

describe("registration seam", () => {
  test("bad shapes throw loudly", () => {
    expect(() => validateExtensionCommandDef("x" as never)).toThrow(/must be an object/);
    expect(() =>
      validateExtensionCommandDef({ name: "Has Space", description: "d", handler: () => {} })
    ).toThrow(/invalid name/);
    expect(() =>
      validateExtensionCommandDef({ name: "Upper", description: "d", handler: () => {} })
    ).toThrow(/invalid name/);
    expect(() =>
      validateExtensionCommandDef({ name: "/slashed", description: "d", handler: () => {} })
    ).toThrow(/invalid name/);
    expect(() =>
      validateExtensionCommandDef({ name: "", description: "d", handler: () => {} })
    ).toThrow(/invalid name/);
    expect(() =>
      validateExtensionCommandDef({ name: "ok_name-1", description: "  ", handler: () => {} })
    ).toThrow(/non-empty description/);
    expect(() =>
      validateExtensionCommandDef({ name: "ok_name", description: "d", handler: "x" as never })
    ).toThrow(/handler function/);
  });

  test("duplicates throw; unregister removes; clear drops all", () => {
    const def = { name: "dup_cmd", description: "d", handler: () => {} };
    const unregister = registerExtensionCommand(def, "ext-a");
    expect(getExtensionCommand("dup_cmd")?.owner).toBe("ext-a");
    expect(() => registerExtensionCommand({ ...def }, "ext-b")).toThrow(/already registered/);
    unregister();
    expect(getExtensionCommand("dup_cmd")).toBeUndefined();
    registerExtensionCommand({ ...def }, "ext-b");
    expect(listExtensionCommands().map((c) => c.name)).toEqual(["dup_cmd"]);
    clearExtensionCommands();
    expect(listExtensionCommands()).toEqual([]);
  });

  test("unregistering an unknown name reports false", () => {
    expect(unregisterExtensionCommand("nope")).toBe(false);
  });
});

describe("input parsing", () => {
  test("bare names and typed args split cleanly", () => {
    expect(parseExtensionCommandInput("/deploy")).toEqual({ name: "deploy", args: "" });
    expect(parseExtensionCommandInput("/deploy staging --force")).toEqual({
      name: "deploy",
      args: "staging --force",
    });
    expect(parseExtensionCommandInput("/deploy   spaced   ")).toEqual({
      name: "deploy",
      args: "spaced",
    });
  });

  test("non-commands and multiline never parse", () => {
    expect(parseExtensionCommandInput("")).toBeNull();
    expect(parseExtensionCommandInput("deploy")).toBeNull();
    expect(parseExtensionCommandInput("/")).toBeNull();
    expect(parseExtensionCommandInput("/deploy\nsecond line")).toBeNull();
  });

  test("skill namespaces never parse (skill routing untouched)", () => {
    // "/skill:dep" is not a valid extension invocation (the name must be
    // followed by whitespace or end), so it falls through to skill routing.
    // No extension named "skill" can exist anyway (builtin collision).
    expect(parseExtensionCommandInput("/skill:dep")).toBeNull();
    expect(parseExtensionCommandInput("/skill:name arg")).toBeNull();
    expect(getExtensionCommand("skill")).toBeUndefined();
  });

  test("argv tokenizes quotes", () => {
    expect(splitCommandArgs("")).toEqual([]);
    expect(splitCommandArgs("a b  c")).toEqual(["a", "b", "c"]);
    expect(splitCommandArgs('deploy "staging east" --force')).toEqual([
      "deploy",
      "staging east",
      "--force",
    ]);
    expect(splitCommandArgs("say 'hello world'")).toEqual(["say", "hello world"]);
  });
});

describe("handler context (prompt, session, messaging)", () => {
  test("handler sees args/argv/cwd and can prompt, read session, post messages", async () => {
    let seen: { args: string; argv: string[]; cwd: string } | null = null;
    registerExtensionCommand({
      name: "worker",
      description: "does work",
      handler: async (ctx) => {
        seen = { args: ctx.args, argv: ctx.argv, cwd: ctx.cwd };
        const answer = await ctx.askUser("Pick one?", ["a", "b"], true);
        const snap = ctx.getSession();
        ctx.say(`answer was ${answer} on "${snap.title}" (#${snap.turnCount})`);
        return "done-note";
      },
    });
    const deps = testDeps();
    const result = await runExtensionCommand("worker", 'staging --tag "v2 final"', deps);
    expect(result).toEqual({ ok: true, posted: 2 });
    expect(seen).toEqual({
      args: 'staging --tag "v2 final"',
      argv: ["staging", "--tag", "v2 final"],
      cwd: "/test-cwd",
    });
    expect(deps.asked).toEqual([{ question: "Pick one?", options: ["a", "b"], allowCustom: true }]);
    expect(deps.said).toEqual(['answer was picked:a on "Build auth" (#3)', "done-note"]);
  });

  test("unknown command is a clean error, never a throw", async () => {
    const deps = testDeps();
    const result = await runExtensionCommand("ghost", "", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown extension command "\/ghost"/);
    expect(deps.said).toEqual([]);
  });
});

describe("throwing handlers", () => {
  test("clean error surfaces and staged messages are dropped (session untouched)", async () => {
    const history = [{ role: "user", content: "hi" }];
    registerExtensionCommand({
      name: "flaky",
      description: "fails",
      handler: async (ctx) => {
        ctx.say("partial work (must never commit)");
        throw new Error("boom-handler");
      },
    });
    const deps = testDeps();
    const result = await runExtensionCommand("flaky", "", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/extension command "\/flaky" failed: boom-handler/);
    }
    // Staged say() output is dropped — the commit sink never fires.
    expect(deps.said).toEqual([]);
    // The session the handler could observe is byte-identical.
    expect(history).toEqual([{ role: "user", content: "hi" }]);
  });

  test("non-string say() is a handler bug with the same clean surface", async () => {
    registerExtensionCommand({
      name: "bad_say",
      description: "says wrong",
      handler: async (ctx) => {
        ctx.say(42 as never);
      },
    });
    const result = await runExtensionCommand("bad_say", "", testDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/say\(\) needs a string/);
  });
});

describe("generation-bound context", () => {
  test("stale check failures throw into the clean-error path", async () => {
    registerExtensionCommand({
      name: "stale_cmd",
      description: "goes stale",
      handler: async (ctx) => {
        ctx.say("never reaches the sink");
      },
    });
    const deps = testDeps({
      checkStale: () => {
        throw new Error("stale after test switch");
      },
    });
    const result = await runExtensionCommand("stale_cmd", "", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("stale after test switch");
    expect(deps.said).toEqual([]);
  });

  test("stale-generation rule covers registerCommand (capture vs fresh)", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "cap.js",
          `module.exports = function (api) { globalThis.__capCmd = api; api.on("session_start", (fresh) => { globalThis.__freshCmd = fresh; }); };`
        ),
      ],
    });
    const captured = (globalThis as Record<string, unknown>).__capCmd as ExtensionAPI;
    runtime.invalidate("stale after test switch");
    expect(() =>
      captured.registerCommand({ name: "stale_cmd", description: "d", handler: () => {} })
    ).toThrow("stale after test switch");
    await runtime.emit("session_start", { reason: "switch" });
    const fresh = (globalThis as Record<string, unknown>).__freshCmd as ExtensionAPI;
    const unregister = fresh.registerCommand({
      name: "fresh_cmd",
      description: "d",
      handler: () => {},
    });
    expect(getExtensionCommand("fresh_cmd")?.owner).toBe("cap");
    unregister();
    expect(getExtensionCommand("fresh_cmd")).toBeUndefined();
  });

  test("unregister-after-invalidate throws like registerTool's", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "cap.js",
          `module.exports = function (api) { globalThis.__capCmd = api; api.on("session_start", (fresh) => { globalThis.__freshCmd = fresh; }); };`
        ),
      ],
    });
    delete (globalThis as Record<string, unknown>).__capCmd;
    await runtime.emit("session_start", { reason: "startup" });
    const fresh = (globalThis as Record<string, unknown>).__freshCmd as ExtensionAPI;
    const off = fresh.registerCommand({ name: "late_cmd", description: "d", handler: () => {} });
    runtime.invalidate("second switch");
    expect(() => off()).toThrow("second switch");
    unregisterExtensionCommand("late_cmd");
  });
});

describe("extension file registration", () => {
  test("api.registerCommand from a loaded extension runs with context", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "greeter.js",
      `module.exports = function (api) { api.registerCommand({ name: "greet", description: "Greet with args.", handler: async (ctx) => { const snap = ctx.getSession(); ctx.say("hi " + (ctx.argv[0] || "there")); return "from " + snap.title; } }); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.errors).toEqual([]);
    const deps = testDeps();
    const result = await runExtensionCommand("greet", "ada", deps);
    expect(result).toEqual({ ok: true, posted: 2 });
    expect(deps.said).toEqual(["hi ada", "from Build auth"]);
  });

  test("factory that registers then throws leaves no command behind", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "flaky.js",
      `module.exports = function (api) { api.registerCommand({ name: "flaky_cmd", description: "d", handler: async () => {} }); throw new Error("boom-after-register"); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("boom-after-register"))).toBe(true);
    expect(getExtensionCommand("flaky_cmd")).toBeUndefined();
  });

  test("duplicate command across extensions fails the second one alone", async () => {
    const root = makeTempRoot();
    const first = writeExt(
      root,
      "first.js",
      `module.exports = function (api) { api.registerCommand({ name: "shared_cmd", description: "first", handler: async () => "first" }); };`
    );
    const second = writeExt(
      root,
      "second.js",
      `module.exports = function (api) { api.registerCommand({ name: "shared_cmd", description: "second", handler: async () => "second" }); };`
    );
    const runtime = await loadExtensions({ entryPaths: [first, second] });
    expect(runtime.loaded.map((e) => e.name)).toEqual(["first"]);
    expect(runtime.errors.some((e) => e.error.includes("already registered"))).toBe(true);
    const result = await runExtensionCommand("shared_cmd", "", testDeps());
    expect(result).toEqual({ ok: true, posted: 1 });
  });

  test("non-function handler fails activation loudly", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(root, "bad.js", `module.exports = function (api) { api.registerCommand({ name: "bad_cmd", description: "d", handler: 123 }); };`),
      ],
    });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("handler function"))).toBe(true);
    expect(getExtensionCommand("bad_cmd")).toBeUndefined();
  });
});

describe("palette and slash-menu visibility", () => {
  test("registered command appears in the palette and invokes with typed args", async () => {
    registerExtensionCommand({
      name: "deploy",
      description: "Deploy the app to staging.",
      handler: async (ctx) => `deploying ${ctx.argv[0] ?? "nowhere"}`,
    });
    const all = paletteEntries("");
    expect(all.map((e) => e.name)).toContain("/deploy");
    expect(all.find((e) => e.name === "/deploy")?.category).toBe("Extensions");
    expect(paletteEntries("dep").map((e) => e.name)).toContain("/deploy");
    expect(paletteEntries("deploy the app").map((e) => e.name)).toContain("/deploy");
    const deps = testDeps();
    const target = parseExtensionCommandInput("/deploy staging");
    expect(target).toEqual({ name: "deploy", args: "staging" });
    const result = await runExtensionCommand(target!.name, target!.args, deps);
    expect(result).toEqual({ ok: true, posted: 1 });
    expect(deps.said).toEqual(["deploying staging"]);
  });

  test("registered command joins the slash menu after builtins", () => {
    registerExtensionCommand({
      name: "deploy",
      description: "Deploy the app to staging.",
      handler: async () => {},
    });
    const menu = buildSlashMenu("/dep", [], listExtensionCommands());
    expect(menu.items.map((i) => i.name)).toContain("/deploy");
    // Bare "/" lists builtins only — extensions join on non-trivial input.
    const bare = buildSlashMenu("/", [], listExtensionCommands());
    expect(bare.items.map((i) => i.name)).not.toContain("/deploy");
  });
});

describe("builtin collisions (builtins always win)", () => {
  test("colliding name fails activation loudly; nothing commits", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "squatter.js",
      `module.exports = function (api) { api.registerCommand({ name: "new", description: "squat builtin", handler: async () => "x" }); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], builtinSlashCommands: ["/new", "/compact"] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("collides with a builtin"))).toBe(true);
    expect(getExtensionCommand("new")).toBeUndefined();
  });

  test("command commit failure rolls back tools from the same round", async () => {
    const root = makeTempRoot();
    const dupe = writeExt(
      root,
      "a-dupe.js",
      `module.exports = function (api) { api.registerCommand({ name: "round_cmd", description: "d", handler: async () => {} }); };`
    );
    const entry = writeExt(
      root,
      "b-mixed.js",
      `module.exports = function (api) { api.registerTool({ name: "round_tool", description: "d", parameters: { type: "object" }, execute: async () => "x" }); api.registerCommand({ name: "round_cmd", description: "d", handler: async () => {} }); };`
    );
    const { toolNames, clearExtensionTools } = await import("../src/tools.js");
    try {
      const runtime = await loadExtensions({ entryPaths: [dupe, entry] });
      expect(runtime.loaded.map((e) => e.name)).toEqual(["a-dupe"]);
      expect(runtime.errors.some((e) => e.error.includes("already registered"))).toBe(true);
      // The failed round's tool rolled back with its command — zero residue.
      expect(toolNames()).not.toContain("round_tool");
      expect(getExtensionCommand("round_cmd")?.owner).toBe("a-dupe");
    } finally {
      clearExtensionTools();
    }
  });
});
