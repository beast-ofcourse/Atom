// Extension tool overrides + scheduling hints + prompt hints (ticket 06):
// audited shadowing of a builtin (marker everywhere, pass-through default,
// deny-a-subset with reason, pristine restore on removal), sequential mode
// forcing the whole sibling batch serial, and hints reaching the system
// prompt through the existing assembly. Pure unit tests — tmpdir files for
// extension loading, no TUI, no network.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadExtensions, type ExtensionAPI } from "../src/extensions.js";
import { planBatches } from "../src/scheduler.js";
import {
  TOOL_DEFINITIONS,
  TOOL_ONE_LINERS,
  allToolDefinitions,
  clearExtensionTools,
  describeToolCall,
  executeTool,
  needsApproval,
  registerExtensionTool,
  registerExtensionToolOverride,
  toolExecutionMode,
  toolNames,
  unregisterExtensionToolOverride,
  type ExtensionToolDefinition,
  type ExtensionToolOverrideDefinition,
} from "../src/tools.js";
import {
  clearExtensionPromptHints,
  clearToolOverrides,
  getExtensionPromptHints,
  getToolOverride,
  isToolOverridden,
  listToolOverrides,
  registerExtensionPromptHint,
} from "../src/tools/overrides.js";
import { buildSystemPrompt, runLoopWithChat, type ChatResult, type ToolCall } from "../src/zen.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-06-"));
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
  clearExtensionTools();
  clearToolOverrides();
  clearExtensionPromptHints();
  for (const key of ["__capOver", "__freshOver"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

function writeExt(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  if (!roots.includes(root)) roots.push(root);
  return abs;
}

function writeTmpFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  if (!roots.includes(root)) roots.push(root);
  return abs;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function scriptedChat(script: ChatResult[]) {
  let n = 0;
  return async (): Promise<ChatResult> => script[Math.min(n++, script.length - 1)]!;
}

function pristineReadDescription(): string {
  return TOOL_DEFINITIONS.find((t) => t.function.name === "read")!.function.description;
}

function passthroughRead(owner = "watcher"): ExtensionToolOverrideDefinition {
  return {
    name: "read",
    execute: async (args, ctx) => ctx.passthrough(args),
  };
}

describe("audit-visible shadowing", () => {
  test("override replaces the builtin everywhere with a marker, adds no names", () => {
    const before = toolNames().length;
    const unregister = registerExtensionToolOverride(passthroughRead(), "watcher");
    try {
      // No new model-visible name: the builtin slot is shadowed, not added.
      expect(toolNames()).toHaveLength(before);
      expect(toolNames()).toContain("read");
      const defs = allToolDefinitions();
      const read = defs.find((t) => t.function.name === "read")!;
      expect(read.function.description).toContain(pristineReadDescription());
      expect(read.function.description).toContain('[overridden by extension "watcher"]');
      // Schema and position are untouched — only the description is marked.
      expect(read.function.parameters).toEqual(
        TOOL_DEFINITIONS.find((t) => t.function.name === "read")!.function.parameters
      );
      expect(defs.map((t) => t.function.name).indexOf("read")).toBe(
        TOOL_DEFINITIONS.map((t) => t.function.name).indexOf("read")
      );
      // Raw builtin table stays pristine (tests pin its entries).
      expect(pristineReadDescription()).not.toContain("overridden by");
      // Activity label and /tools one-liner carry the marker too.
      expect(describeToolCall("read", { path: "a.txt" })).toContain("(override: watcher)");
      expect(TOOL_ONE_LINERS["read"]).toContain("(override: watcher)");
      expect(isToolOverridden("read")).toBe(true);
      expect(listToolOverrides().map((o) => `${o.name}:${o.owner}`)).toEqual(["read:watcher"]);
    } finally {
      unregister();
    }
  });

  test("registration rejects non-builtins, duplicates, and bad shapes loudly", () => {
    expect(() =>
      registerExtensionToolOverride({ name: "nope_tool", execute: async () => "x" }, "w")
    ).toThrow(/not a builtin tool/);
    const unregister = registerExtensionToolOverride(passthroughRead(), "first");
    try {
      expect(() =>
        registerExtensionToolOverride(passthroughRead(), "second")
      ).toThrow(/already registered/);
      expect(() =>
        registerExtensionToolOverride({ name: "has space", execute: async () => "x" }, "w")
      ).toThrow(/invalid name/);
      expect(() =>
        registerExtensionToolOverride({ name: "read", execute: "x" as never }, "w")
      ).toThrow(/execute function/);
      expect(() =>
        registerExtensionToolOverride(
          { name: "read", execute: async () => "x", executionMode: "sideways" as never },
          "w"
        )
      ).toThrow(/executionMode/);
    } finally {
      unregister();
    }
  });

  test("overridden builtin keeps its builtin approval policy", () => {
    const unregister = registerExtensionToolOverride(passthroughRead(), "watcher");
    try {
      expect(needsApproval("read")).toBe(false);
    } finally {
      unregister();
    }
    const unregisterWrite = registerExtensionToolOverride(
      { name: "write", execute: async (args, ctx) => ctx.passthrough(args) },
      "watcher"
    );
    try {
      expect(needsApproval("write")).toBe(true);
    } finally {
      unregisterWrite();
    }
  });
});

describe("deny-a-subset with pass-through default", () => {
  test("override denies secret paths with reason, passes the rest through", async () => {
    const root = makeTempRoot();
    const pub = writeTmpFile(root, "public.txt", "public-content");
    const unregister = registerExtensionToolOverride(
      {
        name: "read",
        execute: async (args, ctx) => {
          if (String(args["path"]).includes("secret")) {
            throw new Error("denied: secret paths are off-limits");
          }
          return ctx.passthrough(args);
        },
      },
      "guard"
    );
    try {
      const denied = await executeTool("read", { path: path.join(root, "secret.txt") });
      expect(denied).toContain("denied: secret paths are off-limits");
      const passed = await executeTool("read", { path: pub });
      expect(passed).toContain("public-content");
    } finally {
      unregister();
    }
  });

  test("return-form denial commits verbatim; builtin validation still runs first", async () => {
    let ran = 0;
    const unregister = registerExtensionToolOverride(
      {
        name: "read",
        execute: async (args, ctx) => {
          ran += 1;
          if (String(args["path"]).includes("nope")) return "Error: nope by policy";
          return ctx.passthrough(args);
        },
      },
      "guard"
    );
    try {
      expect(await executeTool("read", { path: "nope.txt" })).toBe("Error: nope by policy");
      // Model mistake: invalid args never reach the override.
      const invalid = await executeTool("read", {});
      expect(invalid).toMatch(/^Error: invalid call:/);
      expect(ran).toBe(1);
    } finally {
      unregister();
    }
  });

  test("passthrough re-validates rewritten args; throwing override never crashes", async () => {
    const root = makeTempRoot();
    const pub = writeTmpFile(root, "public.txt", "public-content");
    const smuggled = registerExtensionToolOverride(
      {
        name: "read",
        execute: async (_args, ctx) => ctx.passthrough({}),
      },
      "guard"
    );
    try {
      expect(await executeTool("read", { path: pub })).toMatch(/^Error: invalid call:/);
    } finally {
      smuggled();
    }
    const boomer = registerExtensionToolOverride(
      {
        name: "read",
        execute: async () => {
          throw new Error("boom-override");
        },
      },
      "guard"
    );
    try {
      expect(await executeTool("read", { path: pub })).toBe("Error: boom-override");
    } finally {
      boomer();
    }
  });

  test("overridden builtin routes through the shared loop, paired by call id", async () => {
    const root = makeTempRoot();
    const pub = writeTmpFile(root, "public.txt", "loop-content");
    const unregister = registerExtensionToolOverride(
      {
        name: "read",
        execute: async (args, ctx) => ctx.passthrough(args),
      },
      "guard"
    );
    try {
      const history = [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ] as Parameters<typeof runLoopWithChat>[1];
      const reply = await runLoopWithChat(
        scriptedChat([
          { content: null, tool_calls: [call("c1", "read", { path: pub })] },
          { content: "done" },
        ]),
        history
      );
      expect(reply).toBe("done");
      const tools = history.filter((m) => m.role === "tool") as Array<{
        tool_call_id: string;
        content: string;
      }>;
      expect(tools).toHaveLength(1);
      expect(tools[0]!.tool_call_id).toBe("c1");
      expect(tools[0]!.content).toContain("loop-content");
    } finally {
      unregister();
    }
  });
});

describe("sequential scheduling hint", () => {
  function seqCustom(name: string): ExtensionToolDefinition {
    return {
      name,
      description: "Sequential helper.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async () => "x",
      executionMode: "sequential",
    };
  }

  test("a sequential tool forces its whole sibling batch one-at-a-time", () => {
    // Baseline: two reads batch together.
    expect(
      planBatches([call("r1", "read", { path: "a.txt" }), call("r2", "read", { path: "b.txt" })]).map(
        (b) => b.map((m) => m.call.id)
      )
    ).toEqual([["r1", "r2"]]);
    registerExtensionTool(seqCustom("seq_a"));
    // With the sequential tool anywhere in the block, everything serializes.
    expect(
      planBatches([
        call("r1", "read", { path: "a.txt" }),
        call("r2", "read", { path: "b.txt" }),
        call("c", "seq_a", { text: "1" }),
      ]).map((b) => b.map((m) => m.call.id))
    ).toEqual([["r1"], ["r2"], ["c"]]);
    expect(toolExecutionMode("seq_a")).toBe("sequential");
  });

  test("a sequential override serializes builtins that would otherwise batch", () => {
    const unregister = registerExtensionToolOverride(
      { ...passthroughRead(), executionMode: "sequential" },
      "watcher"
    );
    try {
      expect(toolExecutionMode("read")).toBe("sequential");
      expect(
        planBatches([call("r1", "read", { path: "a.txt" }), call("r2", "read", { path: "b.txt" })]).map(
          (b) => b.map((m) => m.call.id)
        )
      ).toEqual([["r1"], ["r2"]]);
    } finally {
      unregister();
    }
    expect(toolExecutionMode("read")).toBeUndefined();
  });

  test("sequential never weakens existing guarantees; parallel changes nothing", () => {
    // Same-file writes stay ordered with or without any hint in the block.
    const sameFile = planBatches([
      call("w1", "write", { path: "same.txt", content: "1" }),
      call("w2", "write", { path: "same.txt", content: "2" }),
    ]).map((b) => b.map((m) => m.call.id));
    expect(sameFile).toEqual([["w1"], ["w2"]]);
    // Disjoint writes batch today...
    const disjoint = planBatches([
      call("w1", "write", { path: "one.txt", content: "1" }),
      call("w2", "write", { path: "two.txt", content: "2" }),
    ]).map((b) => b.map((m) => m.call.id));
    expect(disjoint).toEqual([["w1", "w2"]]);
    // ...but a sequential sibling forces them serial (adds, never removes).
    registerExtensionTool(seqCustom("seq_b"));
    expect(
      planBatches([
        call("w1", "write", { path: "one.txt", content: "1" }),
        call("w2", "write", { path: "two.txt", content: "2" }),
        call("c", "seq_b", { text: "1" }),
      ]).map((b) => b.map((m) => m.call.id))
    ).toEqual([["w1"], ["w2"], ["c"]]);
    // "parallel" is advisory: custom tools stay serial singletons either way.
    registerExtensionTool({
      name: "par_a",
      description: "Parallel-declared helper.",
      parameters: { type: "object" },
      execute: async () => "x",
      executionMode: "parallel",
    });
    expect(toolExecutionMode("par_a")).toBe("parallel");
    expect(
      planBatches([call("a", "par_a", {}), call("b", "par_a", {})]).map((b) =>
        b.map((m) => m.call.id)
      )
    ).toEqual([["a"], ["b"]]);
    // Bad modes throw loudly at registration.
    expect(() =>
      registerExtensionTool({ ...seqCustom("bad_mode"), executionMode: "sideways" as never })
    ).toThrow(/executionMode/);
  });
});

describe("prompt hints reach the system context", () => {
  test("registered hints append under Extension hints; removal clears them", () => {
    const root = makeTempRoot(); // no AGENTS.md here: base is the bare SYSTEM_PROMPT
    const unregister = registerExtensionPromptHint("Prefer glob over read for discovery.", "guide");
    try {
      expect(getExtensionPromptHints()).toEqual(["Prefer glob over read for discovery."]);
      const prompt = buildSystemPrompt(root);
      expect(prompt).toContain("## Extension hints");
      expect(prompt).toContain("- Prefer glob over read for discovery.");
    } finally {
      unregister();
    }
    expect(getExtensionPromptHints()).toEqual([]);
    expect(buildSystemPrompt(root)).not.toContain("## Extension hints");
  });

  test("empty and oversize hints throw loudly", () => {
    expect(() => registerExtensionPromptHint("   ", "w")).toThrow(/non-empty/);
    expect(() => registerExtensionPromptHint("x".repeat(2001), "w")).toThrow(/exceeds 2000/);
  });
});

describe("removal restores the pristine builtin", () => {
  test("unregister leaves no residue anywhere", async () => {
    const root = makeTempRoot();
    const pub = writeTmpFile(root, "public.txt", "pristine-content");
    let ran = 0;
    const unregister = registerExtensionToolOverride(
      {
        name: "read",
        execute: async (args, ctx) => {
          ran += 1;
          return ctx.passthrough(args);
        },
      },
      "watcher"
    );
    expect(await executeTool("read", { path: pub })).toContain("pristine-content");
    expect(ran).toBe(1);
    unregister();
    // Idempotent: a second unregister is a no-op, never a crash.
    unregister();
    expect(isToolOverridden("read")).toBe(false);
    expect(listToolOverrides()).toEqual([]);
    expect(getToolOverride("read")).toBeUndefined();
    const defs = allToolDefinitions();
    expect(defs.find((t) => t.function.name === "read")!.function.description).toBe(
      pristineReadDescription()
    );
    expect(describeToolCall("read", { path: "a.txt" })).toBe("⚙ read a.txt");
    expect(TOOL_ONE_LINERS["read"]).toBe("Read a file or list a directory.");
    // Pristine behavior is back: the override never runs again.
    expect(await executeTool("read", { path: pub })).toContain("pristine-content");
    expect(ran).toBe(1);
    expect(unregisterExtensionToolOverride("read")).toBe(false);
  });
});

describe("extension host integration", () => {
  test("api.overrideTool + api.addPromptHint go model-visible through loadExtensions", async () => {
    const root = makeTempRoot();
    const pub = writeTmpFile(root, "public.txt", "host-content");
    const entry = writeExt(
      root,
      "guard.js",
      `module.exports = function (api) {
        api.overrideTool({ name: "read", execute: async (args, ctx) => {
          if (String(args.path).includes("secret")) throw new Error("denied: secret");
          return ctx.passthrough(args);
        } });
        api.addPromptHint("Always read before editing.");
      };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.errors).toEqual([]);
    expect(allToolDefinitions().find((t) => t.function.name === "read")!.function.description).toContain(
      '[overridden by extension "guard"]'
    );
    expect(buildSystemPrompt(root)).toContain("- Always read before editing.");
    expect(await executeTool("read", { path: pub })).toContain("host-content");
    expect(await executeTool("read", { path: path.join(root, "secret.txt") })).toContain(
      "denied: secret"
    );
  });

  test("factory that registers then throws leaves no override or hint behind", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "flaky.js",
      `module.exports = function (api) {
        api.overrideTool({ name: "read", execute: async (args, ctx) => ctx.passthrough(args) });
        api.addPromptHint("Flaky hint.");
        throw new Error("boom-after-override");
      };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("boom-after-override"))).toBe(true);
    expect(isToolOverridden("read")).toBe(false);
    expect(getExtensionPromptHints()).toEqual([]);
  });

  test("non-builtin override fails activation loudly; sibling hint never commits", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "bad.js",
      `module.exports = function (api) {
        api.addPromptHint("Bad hint.");
        api.overrideTool({ name: "nope_tool", execute: async () => "x" });
      };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("not a builtin tool"))).toBe(true);
    expect(getExtensionPromptHints()).toEqual([]);
  });

  test("duplicate override across extensions fails the second one alone", async () => {
    const root = makeTempRoot();
    const first = writeExt(
      root,
      "first.js",
      `module.exports = function (api) { api.overrideTool({ name: "read", execute: async (args, ctx) => "first:" + await ctx.passthrough(args) }); };`
    );
    const second = writeExt(
      root,
      "second.js",
      `module.exports = function (api) { api.overrideTool({ name: "read", execute: async () => "second" }); };`
    );
    const runtime = await loadExtensions({ entryPaths: [first, second] });
    expect(runtime.loaded.map((e) => e.name)).toEqual(["first"]);
    expect(runtime.errors.some((e) => e.error.includes("already registered"))).toBe(true);
    const pub = writeTmpFile(root, "public.txt", "dupe-content");
    expect(await executeTool("read", { path: pub })).toContain("first:");
  });

  test("command failure rolls back the same round's override too", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "mixed.js",
      `module.exports = function (api) {
        api.overrideTool({ name: "read", execute: async (args, ctx) => ctx.passthrough(args) });
        api.registerCommand({ name: "dup", description: "d", execute: async () => "x" });
        api.registerCommand({ name: "dup", description: "d", execute: async () => "x" });
      };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], builtinSlashCommands: [] });
    expect(runtime.loaded).toEqual([]);
    expect(isToolOverridden("read")).toBe(false);
  });
});

describe("stale-generation rule covers overrideTool and addPromptHint", () => {
  test("captured api throws after invalidate; emit-time api stays live", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "cap.js",
          `module.exports = function (api) { globalThis.__capOver = api; api.on("session_start", (fresh) => { globalThis.__freshOver = fresh; }); };`
        ),
      ],
    });
    const captured = (globalThis as Record<string, unknown>).__capOver as ExtensionAPI;
    runtime.invalidate("stale after test switch");
    expect(() =>
      captured.overrideTool({ name: "read", execute: async (args, ctx) => ctx.passthrough(args) })
    ).toThrow("stale after test switch");
    expect(() => captured.addPromptHint("stale hint")).toThrow("stale after test switch");
    await runtime.emit("session_start", { reason: "switch" });
    const fresh = (globalThis as Record<string, unknown>).__freshOver as ExtensionAPI;
    const unregisterOver = fresh.overrideTool(passthroughRead());
    expect(isToolOverridden("read")).toBe(true);
    unregisterOver();
    expect(isToolOverridden("read")).toBe(false);
    const unregisterHint = fresh.addPromptHint("fresh hint");
    expect(getExtensionPromptHints()).toEqual(["fresh hint"]);
    unregisterHint();
    expect(getExtensionPromptHints()).toEqual([]);
  });
});
