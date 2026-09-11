// Extension-registered model-callable tools (ticket 02): registration seam,
// model-visible definitions, mid-turn dispatch + pairing, inline validation
// errors, serial-by-default scheduling, builtin-identical cancellation, and
// the ticket-01 stale-generation rule for the new API method. Pure unit
// tests — tmpdir files for extension loading, no TUI, no network.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadExtensions, type ExtensionAPI } from "../src/extensions.js";
import { planBatches } from "../src/scheduler.js";
import {
  TOOL_DEFINITIONS,
  allToolDefinitions,
  clearExtensionTools,
  executeTool,
  needsApproval,
  registerExtensionTool,
  toolNames,
  validateToolArgs,
  type ExtensionToolDefinition,
} from "../src/tools.js";
import {
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
  type ToolCall,
} from "../src/zen.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-02-"));
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
  for (const key of ["__capTool", "__freshTool"]) {
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

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];
}

function scriptedChat(script: ChatResult[]) {
  let n = 0;
  return async (): Promise<ChatResult> => script[Math.min(n++, script.length - 1)]!;
}

function echoDef(name: string, opts?: { requireApproval?: boolean }): ExtensionToolDefinition {
  return {
    name,
    description: "Echo back the text field.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (args) => `echo:${String(args["text"])}`,
    ...(opts?.requireApproval !== undefined ? { requireApproval: opts.requireApproval } : {}),
  };
}

describe("registration seam", () => {
  test("builtin names, duplicates, and bad shapes throw loudly", () => {
    expect(() =>
      registerExtensionTool({ ...echoDef("read") })
    ).toThrow(/collides with a builtin/);
    registerExtensionTool(echoDef("dup_tool"));
    expect(() => registerExtensionTool(echoDef("dup_tool"))).toThrow(/already registered/);
    expect(() => registerExtensionTool({ ...echoDef("has space") })).toThrow(/invalid name/);
    expect(() => registerExtensionTool({ ...echoDef("nodesc"), description: "  " })).toThrow(
      /non-empty description/
    );
    expect(() =>
      registerExtensionTool({ ...echoDef("noschema"), parameters: { type: "string" } })
    ).toThrow(/parameters schema/);
    expect(() =>
      registerExtensionTool({ ...echoDef("noexec"), execute: "x" as never })
    ).toThrow(/execute function/);
  });

  test("unregister removes the tool from names and definitions", () => {
    const unregister = registerExtensionTool(echoDef("gone_tool"));
    expect(toolNames()).toContain("gone_tool");
    unregister();
    expect(toolNames()).not.toContain("gone_tool");
    expect(allToolDefinitions().some((t) => t.function.name === "gone_tool")).toBe(false);
  });

  test("TOOL_DEFINITIONS stays builtin-only; allToolDefinitions adds customs", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.function.name).sort()).toEqual(
      ["ask_question", "bash", "bash_output", "edit", "glob", "grep", "read", "todo_get", "todo_update", "todowrite", "webfetch", "websearch", "write"]
    );
    registerExtensionTool(echoDef("visible_tool"));
    const defs = allToolDefinitions();
    const found = defs.find((t) => t.function.name === "visible_tool");
    expect(found?.type).toBe("function");
    expect(found?.function.description).toContain("Echo back");
    expect(found?.function.parameters).toMatchObject({ type: "object" });
    expect(toolNames()).toContain("visible_tool");
  });
});

describe("extension file registration", () => {
  test("api.registerTool from a loaded extension goes model-visible", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "echoer.js",
      `module.exports = function (api) { api.registerTool({ name: "file_echo", description: "Echo back the text field.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, execute: async (args) => "echo:" + args.text }); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.errors).toEqual([]);
    expect(toolNames()).toContain("file_echo");
    expect(await executeTool("file_echo", { text: "hi" })).toBe("echo:hi");
  });

  test("factory that registers then throws leaves no tool behind", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "flaky.js",
      `module.exports = function (api) { api.registerTool({ name: "flaky_tool", description: "d", parameters: { type: "object" }, execute: async () => "x" }); throw new Error("boom-after-register"); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("boom-after-register"))).toBe(true);
    expect(toolNames()).not.toContain("flaky_tool");
  });

  test("duplicate tool across extensions fails the second one alone", async () => {
    const root = makeTempRoot();
    const first = writeExt(
      root,
      "first.js",
      `module.exports = function (api) { api.registerTool({ name: "shared_tool", description: "d", parameters: { type: "object" }, execute: async () => "first" }); };`
    );
    const second = writeExt(
      root,
      "second.js",
      `module.exports = function (api) { api.registerTool({ name: "shared_tool", description: "d", parameters: { type: "object" }, execute: async () => "second" }); };`
    );
    const runtime = await loadExtensions({ entryPaths: [first, second] });
    expect(runtime.loaded.map((e) => e.name)).toEqual(["first"]);
    expect(runtime.errors.some((e) => e.error.includes("already registered"))).toBe(true);
    expect(await executeTool("shared_tool", {})).toBe("first");
  });
});

describe("mid-turn dispatch and pairing", () => {
  test("model call returns through the shared loop, paired by call id", async () => {
    registerExtensionTool(echoDef("echo_turn"));
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "echo_turn", { text: "hi" })] },
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
    expect(tools[0]).toMatchObject({ tool_call_id: "c1", content: "echo:hi" });
  });

  test("validation failures are inline errors; the implementation never runs", async () => {
    let ran = 0;
    registerExtensionTool({
      ...echoDef("echo_valid"),
      execute: async (args) => {
        ran += 1;
        return `echo:${String(args["text"])}`;
      },
    });
    const missing = await executeTool("echo_valid", {});
    expect(missing).toMatch(/^Error: invalid call:.*missing required field "text"/);
    const wrongType = await executeTool("echo_valid", { text: 42 });
    expect(wrongType).toMatch(/^Error: invalid call:.*must be a string/);
    const extra = await executeTool("echo_valid", { text: "hi", bogus: 1 });
    expect(extra).toMatch(/^Error: invalid call:.*unknown field "bogus"/);
    expect(ran).toBe(0);
    expect(validateToolArgs("echo_valid", {})).toContain("missing required field");
    // Unknown names still list customs in Available.
    expect(await executeTool("nope", {})).toMatch(/Available:.*echo_valid/);
  });

  test("throwing implementation degrades to an Error result, never a crash", async () => {
    registerExtensionTool({
      ...echoDef("echo_boom"),
      execute: async () => {
        throw new Error("boom-impl");
      },
    });
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "echo_boom", { text: "hi" })] },
        { content: "recovered" },
      ]),
      history
    );
    expect(reply).toBe("recovered");
    const tools = history.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect((tools[0] as { content: string }).content).toContain("boom-impl");
  });
});

describe("scheduler: custom tools are always serial", () => {
  test("two custom calls never share a batch; reads split around them", () => {
    registerExtensionTool(echoDef("sched_a"));
    registerExtensionTool(echoDef("sched_b"));
    const batches = planBatches([
      call("a", "sched_a", { text: "1" }),
      call("b", "sched_b", { text: "2" }),
    ]);
    expect(batches.map((b) => b.map((m) => m.call.id))).toEqual([["a"], ["b"]]);
    expect(batches.every((b) => b[0]!.parallelKey === null)).toBe(true);
    const mixed = planBatches([
      call("r1", "read", { path: "a.txt" }),
      call("c", "sched_a", { text: "1" }),
      call("r2", "read", { path: "b.txt" }),
    ]);
    expect(mixed.map((b) => b.map((m) => m.call.id))).toEqual([["r1"], ["c"], ["r2"]]);
  });
});

describe("cancellation matches builtin semantics", () => {
  test("abort mid-execution rejects; the paired result stays committed for rollback", async () => {
    const controller = new AbortController();
    registerExtensionTool({
      ...echoDef("cancel_tool"),
      execute: async () => {
        controller.abort();
        return "late-result";
      },
    });
    const history = baseHistory();
    await expect(
      runLoopWithChat(
        scriptedChat([{ content: null, tool_calls: [call("c1", "cancel_tool", { text: "x" })] }]),
        history,
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "LoopCancelledError" });
    // In-flight execution ran to completion and committed exactly once —
    // the caller rolls the partial turn back, so pairing stays valid.
    const tools = history.filter((m) => m.role === "tool") as Array<{
      tool_call_id: string;
      content: string;
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ tool_call_id: "c1", content: "late-result" });
  });

  test("pre-aborted signal runs nothing", async () => {
    let ran = 0;
    registerExtensionTool({
      ...echoDef("cancel_pre"),
      execute: async () => {
        ran += 1;
        return "x";
      },
    });
    const controller = new AbortController();
    controller.abort();
    const history = baseHistory();
    await expect(
      runLoopWithChat(
        scriptedChat([{ content: null, tool_calls: [call("c1", "cancel_pre", { text: "x" })] }]),
        history,
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "LoopCancelledError" });
    expect(ran).toBe(0);
    expect(history.filter((m) => m.role === "tool")).toHaveLength(0);
  });
});

describe("stale-generation rule covers registerTool", () => {
  test("captured api throws after invalidate; emit-time api stays live", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "cap.js",
          `module.exports = function (api) { globalThis.__capTool = api; api.on("session_start", (fresh) => { globalThis.__freshTool = fresh; }); };`
        ),
      ],
    });
    const captured = (globalThis as Record<string, unknown>).__capTool as ExtensionAPI;
    runtime.invalidate("stale after test switch");
    expect(() =>
      captured.registerTool({
        name: "stale_tool",
        description: "d",
        parameters: { type: "object" },
        execute: async () => "x",
      })
    ).toThrow("stale after test switch");
    await runtime.emit("session_start", { reason: "switch" });
    const fresh = (globalThis as Record<string, unknown>).__freshTool as ExtensionAPI;
    const unregister = fresh.registerTool(echoDef("fresh_tool"));
    expect(toolNames()).toContain("fresh_tool");
    unregister();
    expect(toolNames()).not.toContain("fresh_tool");
  });
});

describe("approval policy", () => {
  test("custom tools require approval by default; pure helpers may opt out", () => {
    registerExtensionTool(echoDef("gated_tool"));
    registerExtensionTool(echoDef("free_tool", { requireApproval: false }));
    expect(needsApproval("gated_tool")).toBe(true);
    expect(needsApproval("free_tool")).toBe(false);
    // Builtin policy is untouched.
    expect(needsApproval("write")).toBe(true);
    expect(needsApproval("read")).toBe(false);
  });
});
