// Loop-hardening tests (Phase 1): validation-before-execution, error-class
// framing, sequencing, interrupt safety, retry discipline.
// Network is ALWAYS mocked — never hit live Zen (429-limited).
import React from "react";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  LoopCancelledError,
  chatCompletion,
  runLoopWithChat,
  type ChatMessage,
} from "../src/zen.js";
import {
  executeTool,
  invalidCall,
  toolNames,
  validateToolArgs,
} from "../src/tools.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

async function waitForAppFrame(
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

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];
}

// Bounded POST-counter wait: polls until the mock has seen `count` POSTs,
// then returns; throws a diagnostic instead of hanging forever when setup
// fails and no request ever starts.
async function waitForPosts(
  counter: () => number,
  count: number,
  what: string,
  timeout = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (counter() >= count) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for POST #${count} (${what})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Queue-backed chat mock (single-JSON path, no body): each POST pops the
// next scripted assistant message, repeating the last forever.
function mockChatScript(messages: unknown[]) {
  const posts: Array<Record<string, unknown>> = [];
  const queue = [...messages];
  let n = 0;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    n += 1;
    try {
      posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
    } catch {
      posts.push({});
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: true, json: async () => ({ choices: [{ message: next }] }) } as unknown as Response;
  });
  return { posts, count: () => n };
}

function toolMsg(id: string, name: string, args: unknown) {
  return {
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

describe("validation before execution", () => {
  const cases: Array<{ name: string; args: Record<string, unknown>; why: string }> = [
    { name: "read", args: {}, why: "missing required" },
    { name: "read", args: { path: 123 }, why: "wrong type" },
    { name: "read", args: { path: "a.txt", offset: "1" }, why: "wrong type" },
    { name: "write", args: { path: "a.txt" }, why: "missing required" },
    { name: "write", args: { path: "a.txt", content: 5 }, why: "wrong type" },
    { name: "edit", args: { path: "a.txt", oldString: "x" }, why: "missing required" },
    { name: "edit", args: { path: "a.txt", oldString: "x", newString: "y", replaceAll: "yes" }, why: "wrong type" },
    { name: "grep", args: {}, why: "missing required" },
    { name: "grep", args: { pattern: 7 }, why: "wrong type" },
    { name: "glob", args: {}, why: "missing required" },
    { name: "bash", args: {}, why: "missing required" },
    { name: "bash", args: { command: 42 }, why: "wrong type" },
    { name: "bash", args: { command: "echo hi", timeoutMs: "60" }, why: "wrong type" },
    { name: "webfetch", args: { url: "https://example.com/", format: "pdf" }, why: "bad enum" },
    { name: "webfetch", args: {}, why: "missing required" },
    { name: "websearch", args: {}, why: "missing required" },
    { name: "websearch", args: { query: "x", numResults: "many" }, why: "wrong type" },
    { name: "ask_question", args: { question: "q?", options: ["only-one"] }, why: "options too few" },
    { name: "ask_question", args: { question: "", options: ["a", "b"] }, why: "missing required" },
    { name: "ask_question", args: { question: "q?", options: ["a", "b"], allowCustom: "yes" }, why: "wrong type" },
  ];

  for (const { name, args, why } of cases) {
    test(`${name} ${why} → invalid call, executor NOT invoked`, async () => {
      mockChatScript([toolMsg("c1", name, args), { content: "noted" }]);
      const history = baseHistory();
      const spy = vi.fn(async () => "should-not-run");
      const reply = await runLoopWithChat(
        (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep, signal: o?.signal }),
        history,
        { execute: spy, sleep: async () => {} }
      );
      expect(reply).toBe("noted");
      expect(spy).not.toHaveBeenCalled();
      const tool = history.find((m) => m.role === "tool") as { content: string } | undefined;
      expect(tool?.content.startsWith("Error: invalid call:")).toBe(true);
      expect(tool?.content).toContain("Fix the arguments and retry.");
    });
  }

  test("validateToolArgs unit: detail mentions expected shape", () => {
    const d = validateToolArgs("read", {});
    expect(d).toContain('"path"');
    expect(invalidCall(d!).startsWith("Error: invalid call:")).toBe(true);
    expect(invalidCall(d!)).toContain("Fix the arguments and retry.");
    expect(validateToolArgs("read", { path: "a.txt" })).toBeNull();
    expect(validateToolArgs("webfetch", { url: "https://x/", format: "pdf" })).toContain("format");
  });

  test("executeTool direct: invalid args never touch the executor", async () => {
    // write with missing content must not create a file: it returns invalid
    // call instead of running.
    const r = await executeTool("write", { path: "x.txt" } as never);
    expect(r.startsWith("Error: invalid call:")).toBe(true);
  });
});

describe("unknown tool", () => {
  test("lists actual names from TOOL_DEFINITIONS, executor NOT invoked", async () => {
    mockChatScript([toolMsg("cX", "frobnicate", {}), { content: "ok" }]);
    const history = baseHistory();
    const spy = vi.fn(async () => "should-not-run");
    const reply = await runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep, signal: o?.signal }),
      history,
      { execute: spy, sleep: async () => {} }
    );
    expect(reply).toBe("ok");
    expect(spy).not.toHaveBeenCalled();
    const tool = history.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(tool?.content.startsWith('Error: unknown tool "frobnicate".')).toBe(true);
    for (const n of toolNames()) {
      expect(tool?.content).toContain(n);
    }
    expect(tool?.content).toContain("Available:");
  });
});

describe("sequencing guarantees", () => {
  test("mixed block (valid + invalid + failing) → ordered results, none skipped", async () => {
    mockChatScript([
      {
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "*.ts" }) } },
          { id: "call_2", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "a.txt" }) } },
          { id: "call_3", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "missing.txt" }) } },
        ],
      },
      { content: "done" },
    ]);
    const history = baseHistory();
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const reply = await runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep, signal: o?.signal }),
      history,
      {
        sleep: async () => {},
        execute: async (name, args) => {
          seen.push({ name, args });
          if (name === "glob") return "glob-ok";
          return "Error: no such file or directory: missing.txt";
        },
      }
    );
    expect(reply).toBe("done");
    // Executor ran for the two valid calls only (invalid write skipped).
    expect(seen.map((s) => s.name)).toEqual(["glob", "read"]);
    // Each result pairs with its tool_call_id in order.
    const tools = history.filter((m) => m.role === "tool") as Array<{ tool_call_id: string; content: string }>;
    expect(tools.map((t) => t.tool_call_id)).toEqual(["call_1", "call_2", "call_3"]);
    expect(tools[0]?.content).toBe("glob-ok");
    expect(tools[1]?.content.startsWith("Error: invalid call:")).toBe(true);
    expect(tools[2]?.content.startsWith("Error:")).toBe(true);
    expect(tools[2]?.content.startsWith("Error: invalid call:")).toBe(false);
  });

  test("bad JSON args yield inline invalid-call result and the block continues", async () => {
    mockChatScript([
      {
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: "not-json{{{" } },
          { id: "c2", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "*" }) } },
        ],
      },
      { content: "ok" },
    ]);
    const history = baseHistory();
    const spy = vi.fn(async () => "glob-ok");
    const reply = await runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep, signal: o?.signal }),
      history,
      { execute: spy, sleep: async () => {} }
    );
    expect(reply).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    const tools = history.filter((m) => m.role === "tool") as Array<{ tool_call_id: string; content: string }>;
    expect(tools).toHaveLength(2);
    expect(tools[0]?.tool_call_id).toBe("c1");
    expect(tools[0]?.content.startsWith("Error: invalid call:")).toBe(true);
    expect(tools[1]?.tool_call_id).toBe("c2");
    expect(tools[1]?.content).toBe("glob-ok");
  });
});

describe("retry discipline", () => {
  test("denial is final: no retry, no rollback (tool result, 2 POSTs, no sleeps)", async () => {
    const sleeps: number[] = [];
    const m = mockChatScript([
      toolMsg("c1", "write", { path: "a.txt", content: "hi" }),
      { content: "understood, denied" },
    ]);
    const history = baseHistory();
    let approvals = 0;
    const reply = await runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: async (ms) => void sleeps.push(ms), signal: o?.signal }),
      history,
      {
        approve: async () => {
          approvals += 1;
          return "no";
        },
        execute: async () => "should-not-run-after-deny",
        sleep: async (ms) => void sleeps.push(ms),
      }
    );
    expect(reply).toBe("understood, denied");
    expect(approvals).toBe(1);
    expect(m.count()).toBe(2);
    expect(sleeps).toEqual([]);
    const tool = history.find((mm) => mm.role === "tool") as { content: string } | undefined;
    expect(tool?.content).toBe("Error: denied by user: write");
  });

  test("validation failures never retry the POST (2 POSTs, no backoff sleeps)", async () => {
    const sleeps: number[] = [];
    const m = mockChatScript([toolMsg("c1", "read", {}), { content: "ok" }]);
    const history = baseHistory();
    const spy = vi.fn(async () => "x");
    const reply = await runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: async (ms) => void sleeps.push(ms), signal: o?.signal }),
      history,
      { execute: spy, sleep: async (ms) => void sleeps.push(ms) }
    );
    expect(reply).toBe("ok");
    expect(spy).not.toHaveBeenCalled();
    expect(m.count()).toBe(2);
    expect(sleeps).toEqual([]);
  });
});

describe("interrupt safety (loop core)", () => {
  test("cancel mid-POST → LoopCancelledError, single POST, no retry", async () => {
    const ctrl = new AbortController();
    let posts = 0;
    const sleeps: number[] = [];
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          posts += 1;
          const sig = (init as { signal?: AbortSignal } | undefined)?.signal;
          if (sig?.aborted) {
            reject(new DOMException("This operation was aborted", "AbortError"));
            return;
          }
          sig?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        })
    );
    const history = baseHistory();
    const p = runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: async (ms) => void sleeps.push(ms), signal: o?.signal }),
      history,
      { execute: async () => "x", sleep: async (ms) => void sleeps.push(ms), signal: ctrl.signal }
    );
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrowError(LoopCancelledError);
    expect(posts).toBe(1);
    expect(sleeps).toEqual([]);
    // No assistant push happened mid-POST: history still system+user.
    expect(history.map((mm) => mm.role)).toEqual(["system", "user"]);
  });

  test("cancel mid-tool → current tool finishes, no new POSTs/executions", async () => {
    const ctrl = new AbortController();
    const m = mockChatScript([toolMsg("c1", "read", { path: "a.txt" }), { content: "never" }]);
    const history = baseHistory();
    let executions = 0;
    const p = runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep, signal: o?.signal }),
      history,
      {
        signal: ctrl.signal,
        sleep: async () => {},
        execute: async () => {
          executions += 1;
          await new Promise((r) => setTimeout(r, 200));
          return "tool-done";
        },
      }
    );
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrowError(LoopCancelledError);
    expect(executions).toBe(1);
    // Current tool finished and its result was recorded, but no resend POST.
    expect(m.count()).toBe(1);
    expect(history.map((mm) => mm.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  test("cancel mid-approval → whole-turn cancel, executor NOT invoked", async () => {
    const ctrl = new AbortController();
    const m = mockChatScript([toolMsg("c1", "write", { path: "a.txt", content: "hi" }), { content: "never" }]);
    const history = baseHistory();
    const spy = vi.fn(async () => "should-not-run");
    const p = runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep, signal: o?.signal }),
      history,
      {
        signal: ctrl.signal,
        sleep: async () => {},
        execute: spy,
        approve: (_name, _args) =>
          new Promise<never>((_resolve, reject) => {
            ctrl.signal.addEventListener("abort", () => reject(new LoopCancelledError()), { once: true });
          }),
      }
    );
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrowError(LoopCancelledError);
    expect(spy).not.toHaveBeenCalled();
    expect(m.count()).toBe(1);
  });
});

describe("interrupt safety (App TUI)", () => {
  function baseProps() {
    return {
      apiKey: "test-key",
      endpoint: ENDPOINT,
      initialModel: "big-pickle",
      initialModels: ["big-pickle"],
    };
  }

  test("cancel mid-POST → (cancelled), rollback, clean state, next turn works", async () => {
    let posts = 0;
    const seen: number[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      posts += 1;
      if (posts === 1) {
        const sig = (init as { signal?: AbortSignal } | undefined)?.signal;
        // Hang until the turn is cancelled (Ctrl+C aborts the signal).
        await new Promise<never>((_resolve, reject) => {
          if (sig?.aborted) {
            reject(new DOMException("This operation was aborted", "AbortError"));
            return;
          }
          sig?.addEventListener(
            "abort",
            () => reject(new DOMException("This operation was aborted", "AbortError")),
            { once: true }
          );
        });
        throw new Error("unreachable");
      }
      try {
        const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
          messages?: unknown[];
        };
        seen.push(body.messages?.length ?? 0);
      } catch {
        seen.push(0);
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "recovered" } }] }) } as unknown as Response;
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      // Wait for POST #1 to actually be in flight (not a fixed sleep): the
      // cancel targets an in-flight POST — racing pre-POST work instead
      // strands the mock's posts===1 branch onto the NEXT turn and hangs it.
      await waitForPosts(() => posts, 1, "first turn POST before cancel");
      app.stdin.write("\u0003");
      await waitForAppFrame(app, "(cancelled)");
      expect(app.lastFrame()).not.toContain("denied by user");
      // Clean state: approval/question modals cleared, busy cleared — the
      // next turn sends a clean [stable, dynamic env] system+user POST
      // (rollback removed turn 1; +1 wire message for the split).
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForAppFrame(app, "recovered");
      expect(seen).toEqual([3]);
      expect(posts).toBe(2);
    } finally {
      app.unmount();
    }
  });

  test("Esc mid-POST stops the response like Ctrl+C, next turn works", async () => {
    let posts = 0;
    const seen: number[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      posts += 1;
      if (posts === 1) {
        const sig = (init as { signal?: AbortSignal } | undefined)?.signal;
        // Hang until the turn is cancelled (Esc aborts the signal).
        await new Promise<never>((_resolve, reject) => {
          if (sig?.aborted) {
            reject(new DOMException("This operation was aborted", "AbortError"));
            return;
          }
          sig?.addEventListener(
            "abort",
            () => reject(new DOMException("This operation was aborted", "AbortError")),
            { once: true }
          );
        });
        throw new Error("unreachable");
      }
      try {
        const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
          messages?: unknown[];
        };
        seen.push(body.messages?.length ?? 0);
      } catch {
        seen.push(0);
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "recovered" } }] }) } as unknown as Response;
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      // Wait for POST #1 to actually be in flight (not a fixed sleep): same
      // race as the Ctrl+C test above — cancelling pre-POST work instead
      // strands the mock's posts===1 branch onto the next turn and hangs it.
      await waitForPosts(() => posts, 1, "first turn POST before Esc");
      app.stdin.write(String.fromCharCode(27)); // Esc stops the response
      await waitForAppFrame(app, "(cancelled)");
      expect(app.lastFrame()).not.toContain("denied by user");
      // Clean state: the next turn sends a clean [stable, dynamic env]
      // system+user POST (+1 wire message for the split).
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForAppFrame(app, "recovered");
      expect(seen).toEqual([3]);
      expect(posts).toBe(2);
    } finally {
      app.unmount();
    }
  });

  test("Ctrl+C during approval cancels the whole turn (not a denial), executor never runs", async () => {
    const probe = "cancel-probe-xyz.txt";
    try {
      const { rm } = await import("node:fs/promises");
      await rm(probe, { force: true });
    } catch {
      // ignore
    }
    let posts = 0;
    globalThis.fetch = vi.fn(async () => {
      posts += 1;
      if (posts === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "write", arguments: JSON.stringify({ path: probe, content: "hi" }) },
                    },
                  ],
                },
              },
            ],
          }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "after-cancel" } }] }) } as unknown as Response;
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("do write");
      app.stdin.write("\r");
      await waitForAppFrame(app, "allow this tool");
      app.stdin.write("\u0003");
      await waitForAppFrame(app, "(cancelled)");
      expect(app.lastFrame()).not.toContain("denied by user");
      expect(app.lastFrame()).not.toContain("allow this tool");
      expect(existsSync(probe)).toBe(false);
      // Next turn works (busy/modal state clean).
      app.stdin.write("hi again");
      app.stdin.write("\r");
      await waitForAppFrame(app, "after-cancel");
    } finally {
      app.unmount();
      try {
        const { rm } = await import("node:fs/promises");
        await rm(probe, { force: true });
      } catch {
        // ignore
      }
    }
  });
});
