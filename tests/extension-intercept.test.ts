// Tool-call interception (ticket 03): pre-execution block/rewrite with
// fail-closed throws, post-execution patches, deterministic first-block-
// wins composition, serial + parallel-batch coverage, approval coherence,
// and the ticket-01 stale-generation rule for the new API methods. Pure
// unit tests — tmpdir files for extension loading, no TUI, no network.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadExtensions, type ExtensionAPI } from "../src/extensions.js";
import {
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
  type ToolCall,
} from "../src/zen.js";
import {
  applyAfterInterceptors,
  applyBeforeInterceptors,
  afterToolInterceptors,
  beforeToolInterceptors,
  clearExtensionTools,
  clearToolInterceptors,
  registerAfterToolCall,
  registerBeforeToolCall,
} from "../src/tools.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-03-"));
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
  clearToolInterceptors();
  clearExtensionTools();
  for (const key of ["__capI", "__freshI"]) {
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

function toolContents(history: ChatMessage[]): string[] {
  return history
    .filter((m) => m.role === "tool")
    .map((m) => (m as { content: string }).content);
}

describe("decision shapes (pure apply)", () => {
  test("string blocks, {block:true} uses a default reason, void passes through", async () => {
    const asString = await applyBeforeInterceptors(
      [{ owner: "a", handler: () => "nope" }],
      "bash",
      { command: "x" }
    );
    expect(asString.blocked).toContain("nope");
    const asTrue = await applyBeforeInterceptors(
      [{ owner: "a", handler: () => ({ block: true as const }) }],
      "bash",
      { command: "x" }
    );
    expect(asTrue.blocked).toContain("was blocked");
    const pass = await applyBeforeInterceptors(
      [{ owner: "a", handler: () => undefined }],
      "bash",
      { command: "x" }
    );
    expect(pass.blocked).toBeNull();
    expect(pass.args).toEqual({ command: "x" });
  });

  test("rewrites accumulate across handlers in order", async () => {
    const out = await applyBeforeInterceptors(
      [
        { owner: "a", handler: ({ args }) => ({ args: { ...args, path: "b.txt" } }) },
        {
          owner: "b",
          handler: ({ args }) => {
            expect(args["path"]).toBe("b.txt");
            return { args: { ...args, limit: 5 } };
          },
        },
      ],
      "read",
      { path: "a.txt" }
    );
    expect(out.blocked).toBeNull();
    expect(out.args).toEqual({ path: "b.txt", limit: 5 });
  });

  test("throwing before handler fails closed with the cause", async () => {
    const out = await applyBeforeInterceptors(
      [
        {
          owner: "a",
          handler: () => {
            throw new Error("boom-hook");
          },
        },
      ],
      "bash",
      { command: "x" }
    );
    expect(out.blocked).toContain("handler failed");
    expect(out.blocked).toContain("boom-hook");
  });

  test("after handlers patch cumulatively; throws fail open", async () => {
    const out = await applyAfterInterceptors(
      [
        { owner: "a", handler: ({ result }) => `${result}+patched` },
        { owner: "b", handler: () => ({ content: "final" }) },
        {
          owner: "c",
          handler: () => {
            throw new Error("boom-post");
          },
        },
      ],
      { name: "read", args: {}, result: "raw", isError: false }
    );
    expect(out).toEqual({ content: "final", isError: false });
  });
});

describe("pre-execution block", () => {
  test("destructive call blocked; model gets the reason, tool never runs, turn continues", async () => {
    const seen: string[] = [];
    registerBeforeToolCall(({ name, args }) => {
      if (name === "bash" && String(args["command"] ?? "").includes("rm -rf")) {
        return { block: "destructive commands need explicit approval" };
      }
    }, "guard");
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "bash", { command: "rm -rf /tmp/x" })] },
        { content: "done" },
      ]),
      history,
      {
        execute: async (name) => {
          seen.push(name);
          return "ran";
        },
      }
    );
    expect(reply).toBe("done");
    expect(seen).toHaveLength(0);
    expect(toolContents(history)).toHaveLength(1);
    expect(toolContents(history)[0]).toContain("destructive commands need explicit approval");
    expect((history.find((m) => m.role === "tool") as { tool_call_id: string }).tool_call_id).toBe("c1");
  });

  test("throwing pre-execution handler fails closed (blocked, turn continues)", async () => {
    let ran = 0;
    registerBeforeToolCall(() => {
      throw new Error("boom-pre");
    }, "flaky-guard");
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "recovered" },
      ]),
      history,
      {
        execute: async () => {
          ran += 1;
          return "ran";
        },
      }
    );
    expect(reply).toBe("recovered");
    expect(ran).toBe(0);
    expect(toolContents(history)).toHaveLength(1);
    expect(toolContents(history)[0]).toContain("handler failed");
  });
});

describe("arg rewrite", () => {
  test("tool executes with rewritten values", async () => {
    const seen: Array<Record<string, unknown>> = [];
    registerBeforeToolCall(({ name, args }) => {
      if (name === "read") return { args: { ...args, path: "rewritten.txt" } };
    }, "rewriter");
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "done" },
      ]),
      history,
      {
        execute: async (_name, args) => {
          seen.push(args);
          return `ok:${String(args["path"])}`;
        },
      }
    );
    expect(reply).toBe("done");
    expect(seen).toEqual([{ path: "rewritten.txt" }]);
    expect(toolContents(history)).toEqual(["ok:rewritten.txt"]);
  });

  test("invalid rewrite re-validates: inline error, never executes", async () => {
    let ran = 0;
    registerBeforeToolCall(() => ({ args: {} }), "bad-rewriter");
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "done" },
      ]),
      history,
      {
        execute: async () => {
          ran += 1;
          return "ran";
        },
      }
    );
    expect(ran).toBe(0);
    expect(toolContents(history)).toHaveLength(1);
    expect(toolContents(history)[0]).toMatch(/^Error: invalid call:/);
  });
});

describe("post-execution patch", () => {
  test("model sees the patched version", async () => {
    let ran = 0;
    registerAfterToolCall(() => "redacted", "scrubber");
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "done" },
      ]),
      history,
      {
        execute: async () => {
          ran += 1;
          return "secret-bytes";
        },
      }
    );
    expect(reply).toBe("done");
    expect(ran).toBe(1);
    expect(toolContents(history)).toEqual(["redacted"]);
  });

  test("throwing post handler keeps the original result", async () => {
    registerAfterToolCall(() => {
      throw new Error("boom-post");
    }, "flaky-patch");
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "done" },
      ]),
      history,
      { execute: async () => "original" }
    );
    expect(toolContents(history)).toEqual(["original"]);
  });
});

describe("composition", () => {
  test("two blockers compose deterministically: first-block-wins, second never runs", async () => {
    let secondRan = 0;
    registerBeforeToolCall(() => ({ block: "first says no" }), "first");
    registerBeforeToolCall(() => {
      secondRan += 1;
      return { block: "second says no" };
    }, "second");
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "bash", { command: "echo hi" })] },
        { content: "done" },
      ]),
      history,
      { execute: async () => "ran" }
    );
    expect(secondRan).toBe(0);
    expect(toolContents(history)).toHaveLength(1);
    expect(toolContents(history)[0]).toContain("first says no");
    expect(toolContents(history)[0]).not.toContain("second says no");
  });

  test("later handlers observe earlier rewrites", async () => {
    const seenBySecond: unknown[] = [];
    registerBeforeToolCall(({ args }) => ({ args: { ...args, path: "mid.txt" } }), "first");
    registerBeforeToolCall(({ args }) => {
      seenBySecond.push(args["path"]);
    }, "second");
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "done" },
      ]),
      history,
      { execute: async (_name, args) => `ok:${String(args["path"])}` }
    );
    expect(seenBySecond).toEqual(["mid.txt"]);
    expect(toolContents(history)).toEqual(["ok:mid.txt"]);
  });
});

describe("parallel batches", () => {
  test("batch member blocked while sibling executes; order and pairing intact", async () => {
    registerBeforeToolCall(({ name, args }) => {
      if (name === "read" && args["path"] === "secret.txt") return "secret files are off limits";
    }, "guard");
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c-secret", "read", { path: "secret.txt" }),
            call("c-public", "read", { path: "public.txt" }),
          ],
        },
        { content: "done" },
      ]),
      history,
      { execute: async (_name, args) => `ok:${String(args["path"])}` }
    );
    expect(reply).toBe("done");
    const tools = history.filter((m) => m.role === "tool") as Array<{
      tool_call_id: string;
      content: string;
    }>;
    expect(tools.map((t) => t.tool_call_id)).toEqual(["c-secret", "c-public"]);
    expect(tools[0]!.content).toContain("secret files are off limits");
    expect(tools[1]!.content).toBe("ok:public.txt");
  });

  test("batch rewrite executes with new args", async () => {
    const seen: string[] = [];
    registerBeforeToolCall(({ name, args }) => {
      if (name === "read" && args["path"] === "a.txt") return { args: { ...args, path: "b.txt" } };
    }, "rewriter");
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        {
          content: null,
          tool_calls: [
            call("c1", "read", { path: "a.txt" }),
            call("c2", "read", { path: "c.txt" }),
          ],
        },
        { content: "done" },
      ]),
      history,
      {
        execute: async (_name, args) => {
          seen.push(String(args["path"]));
          return `ok:${String(args["path"])}`;
        },
      }
    );
    expect(seen.sort()).toEqual(["b.txt", "c.txt"]);
    expect(toolContents(history)).toEqual(["ok:b.txt", "ok:c.txt"]);
  });
});

describe("approval coherence", () => {
  test("block short-circuits approval: no prompt for a call that never runs", async () => {
    let approvals = 0;
    registerBeforeToolCall(() => ({ block: "policy denies writes" }), "guard");
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "write", { path: "f.txt", content: "x" })] },
        { content: "done" },
      ]),
      history,
      {
        execute: async () => "ran",
        approve: async () => {
          approvals += 1;
          return "once";
        },
      }
    );
    expect(approvals).toBe(0);
    expect(toolContents(history)[0]).toContain("policy denies writes");
  });

  test("approval prompt sees rewritten args", async () => {
    const approvalArgs: Array<Record<string, unknown>> = [];
    registerBeforeToolCall(({ args }) => ({ args: { ...args, path: "safe.txt" } }), "rewriter");
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "write", { path: "risky.txt", content: "x" })] },
        { content: "done" },
      ]),
      history,
      {
        execute: async (_name, args) => `wrote:${String(args["path"])}`,
        approve: async (_name, args) => {
          approvalArgs.push(args);
          return "once";
        },
      }
    );
    expect(approvalArgs).toEqual([{ path: "safe.txt", content: "x" }]);
    expect(toolContents(history)).toEqual(["wrote:safe.txt"]);
  });
});

describe("lifecycle", () => {
  test("unregister removes the interceptor", async () => {
    const off = registerBeforeToolCall(() => ({ block: "gone soon" }), "temp");
    off();
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "done" },
      ]),
      history,
      { execute: async () => "ran-fine" }
    );
    expect(toolContents(history)).toEqual(["ran-fine"]);
    const offAfter = registerAfterToolCall(() => "patched", "temp-post");
    offAfter();
    const history2 = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "done" },
      ]),
      history2,
      { execute: async () => "ran-fine" }
    );
    expect(toolContents(history2)).toEqual(["ran-fine"]);
  });

  test("stale-generation rule covers the new API methods", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "cap.js",
          `module.exports = function (api) { globalThis.__capI = api; api.on("session_start", (fresh) => { globalThis.__freshI = fresh; }); };`
        ),
      ],
    });
    const captured = (globalThis as Record<string, unknown>).__capI as ExtensionAPI;
    runtime.invalidate("stale after test switch");
    expect(() => captured.onBeforeToolCall(() => {})).toThrow("stale after test switch");
    expect(() => captured.onAfterToolCall(() => "x")).toThrow("stale after test switch");
    await runtime.emit("session_start", { reason: "switch" });
    const fresh = (globalThis as Record<string, unknown>).__freshI as ExtensionAPI;
    const offBefore = fresh.onBeforeToolCall(() => {});
    const offAfter = fresh.onAfterToolCall(() => "x");
    expect(beforeToolInterceptors()).toHaveLength(1);
    expect(afterToolInterceptors()).toHaveLength(1);
    offBefore();
    offAfter();
    expect(beforeToolInterceptors()).toHaveLength(0);
    expect(afterToolInterceptors()).toHaveLength(0);
    // Unregister closures honor staleness like registerTool's (ticket-02 pattern).
    const offStale = fresh.onBeforeToolCall(() => {});
    runtime.invalidate("second switch");
    expect(() => offStale()).toThrow("second switch");
  });

  test("factory that registers then throws leaves no interceptor behind", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "flaky.js",
      `module.exports = function (api) { api.onBeforeToolCall(() => "blocked-by-flaky"); api.onAfterToolCall(() => "patched-by-flaky"); throw new Error("boom-after-intercept"); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("boom-after-intercept"))).toBe(true);
    expect(beforeToolInterceptors()).toHaveLength(0);
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "read", { path: "a.txt" })] },
        { content: "done" },
      ]),
      history,
      { execute: async () => "ran-fine" }
    );
    expect(toolContents(history)).toEqual(["ran-fine"]);
  });

  test("non-function handler fails activation loudly", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "bad.js",
          `module.exports = function (api) { api.onBeforeToolCall(123); };`
        ),
      ],
    });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("must be a function"))).toBe(true);
  });
});
