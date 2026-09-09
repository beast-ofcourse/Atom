// TUI tests via ink-testing-library. Network is ALWAYS mocked here —
// the live Zen free tier is rate-limited (HTTP 429), so never verify
// against the live API.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { FALLBACK_MODELS, fetchModels } from "../src/zen.js";

const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// Mock the chat POST path with a fixed reply.
function mockChatReply(reply: string) {
  const calls: Array<{ model: unknown; messages: unknown }> = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: unknown;
      messages?: unknown;
    };
    calls.push({ model: body.model, messages: body.messages });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
    } as Response;
  });
  return calls;
}

// Mock the chat POST path with an HTTP error.
function mockChatError(status: number, text: string) {
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status,
    text: async () => text,
  })) as unknown as typeof fetch;
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

describe("send/receive", () => {
  test("typing a message + Enter renders the reply via the Zen POST path", async () => {
    const calls = mockChatReply("hello back");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "hello back");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("big-pickle"); // status line shows current model
      expect(frame).toContain("hi");
      // Provider path: one POST with {model, messages} incl. system prompt.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe("big-pickle");
      const messages = calls[0]?.messages as Array<{
        role: string;
        content: string;
      }>;
      // System prompt is the default plus the repo AGENTS.md (if present).
      expect(messages[0]?.role).toBe("system");
      // Task 1 (plans/tasks.md): base prompt rewritten as operating contract.
      expect(messages[0]?.content.startsWith("You are ATOM, a long-horizon coding agent")).toBe(true);
      expect(messages.at(-1)).toEqual({ role: "user", content: "hi" });
    } finally {
      app.unmount();
    }
  });

  test("errors render inline without crashing, and the failed turn rolls back", async () => {
    mockChatError(429, "FreeUsageLimitError: quota exhausted for today");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "Zen HTTP 429");
      expect(app.lastFrame()).toContain("FreeUsageLimitError");
      // App still alive: clear works after the error.
      app.stdin.write("/clear");
      app.stdin.write("\r");
      await waitForFrame(app, "Say hi");
    } finally {
      app.unmount();
    }
  });

  test("failed turn is not kept in history for the next request", async () => {
    let n = 0;
    const seen: number[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: unknown[];
      };
      seen.push(body.messages?.length ?? 0);
      if (n === 1) {
        // 400 fails fast (no retry); 500/429/502/503/504 are retried
        // transparently (see tests/streaming.test.tsx).
        return { ok: false, status: 400, text: async () => "boom" } as Response;
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "recovered" } }] }),
      } as Response;
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "Zen HTTP 400");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "recovered");
      // Both requests carry [stable, dynamic env] system + one user turn
      // (failed turn rolled back) — one more wire message than history.
      expect(seen).toEqual([3, 3]);
    } finally {
      app.unmount();
    }
  });
});

describe("/model dropdown", () => {
  test("arrow keys + Enter select, status line and next request use the new model", async () => {
    // NOTE: reply needle must be unique — "ok" is a substring of the
    // "token: n/a" status line. The submit pipeline (SUBMIT_PIPELINE_STAGES,
    // tests/submit-order.test.ts) runs env refresh + skill discovery before
    // the first POST, so wait for the loop-entry reply, not the status line.
    const calls = mockChatReply("ok-model-select-xyz");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      expect(app.lastFrame()).toContain("kimi-k2.5");
      app.stdin.write("[B"); // down arrow -> kimi-k2.5
      app.stdin.write("\r"); // select
      // Dropdown closed, status line shows the new model.
      await waitForFrame(app, "model: kimi-k2.5");
      // Subsequent requests use the selected model.
      app.stdin.write("hey");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-model-select-xyz");
      expect(calls.at(-1)?.model).toBe("kimi-k2.5");
    } finally {
      app.unmount();
    }
  });

  test("Esc cancels without changing the model", async () => {
    mockChatReply("ok");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B[B"); // move, then cancel
      // Separate data event: a lone ESC coalesced with the arrow sequence
      // would look like the start of an incomplete escape sequence.
      await new Promise((r) => setTimeout(r, 60));
      app.stdin.write("\u001B"); // escape
      // Dropdown closed -> input box (prompt › with cursor) renders again.
      // NOTE: "█" alone also matches the input cursor block, so wait for the
      // input prompt "›" which only renders when the picker is closed.
      await waitForFrame(app, "›");
      expect(app.lastFrame()).not.toContain("Select model");
      expect(app.lastFrame()).toContain("model: big-pickle");
    } finally {
      app.unmount();
    }
  });
});

describe("/clear", () => {
  test("clears history", async () => {
    mockChatReply("hello back");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "hello back");
      app.stdin.write("/clear");
      app.stdin.write("\r");
      await waitForFrame(app, "Say hi");
      expect(app.lastFrame()).not.toContain("hello back");
    } finally {
      app.unmount();
    }
  });
});

describe("missing key", () => {
  test("TUI starts without a key and guides to /provider (no POST)", async () => {
    const savedEnv = { ...process.env };
    const savedAtomHome = process.env.ATOM_HOME;
    const savedHome = process.env.HOME;
    try {
      for (const k of [
        "OPENCODE_ZEN_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "MISTRAL_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
      ]) {
        delete process.env[k];
      }
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      process.env.ATOM_HOME = await mkdtemp(join(tmpdir(), "atom-no-key-"));
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls += 1;
        return { ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) } as Response;
      });
      const app = render(
        <App apiKey="" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={MODELS} />
      );
      try {
        // TUI runs (banner + status) and advertises /provider.
        expect(app.lastFrame()).toContain("/provider");
        app.stdin.write("hi");
        app.stdin.write("\r");
        await waitForFrame(app, "Missing API key");
        // No network POST without a key.
        expect(calls).toBe(0);
        expect(app.lastFrame()).toContain("/provider");
      } finally {
        app.unmount();
      }
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in savedEnv)) delete process.env[k];
      }
      for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
      if (savedAtomHome === undefined) delete process.env.ATOM_HOME;
      else process.env.ATOM_HOME = savedAtomHome;
      void savedHome;
    }
  });
});

describe("fetchModels fallback", () => {
  test("HTTP 429 falls back to the curated list", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(fetchModels(ENDPOINT, "test-key")).resolves.toEqual(
      FALLBACK_MODELS
    );
  });

  test("network failure falls back to the curated list", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(fetchModels(ENDPOINT, "test-key")).resolves.toEqual(
      FALLBACK_MODELS
    );
  });

  test("live ids outside the compatible set are not offered", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "big-pickle" }, { id: "gpt-x" }] }),
    })) as unknown as typeof fetch;
    await expect(fetchModels(ENDPOINT, "test-key")).resolves.toEqual([
      "big-pickle",
    ]);
  });
});

// Session trust tier (Task 4, plans/tasks.md): one approval covers a whole
// task's write/edit/bash calls without global yolo. Real tool execution
// (like the App-TUI interrupt tests in tests/loop-hardening.test.tsx), so
// probe files are created under cwd and removed before/after each test.
describe("/trust tier", () => {
  function toolMsg(id: string, name: string, args: Record<string, unknown>) {
    return {
      message: {
        content: null,
        tool_calls: [
          { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    };
  }

  function textMsg(content: string) {
    return { message: { content } };
  }

  // Queue-backed chat mock (single-JSON path): each POST pops the next
  // scripted assistant message, repeating the last forever.
  function mockChatScriptMessages(messages: unknown[]) {
    const queue = [...messages];
    globalThis.fetch = vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { ok: true, json: async () => ({ choices: [next] }) } as Response;
    });
  }

  async function cleanProbes(...probes: string[]) {
    const { rm } = await import("node:fs/promises");
    for (const p of probes) {
      try {
        await rm(p, { force: true });
      } catch {
        // ignore
      }
    }
  }

  test("default is normal without trust; /trust toggles +trust in status and /mode, again revokes", async () => {
    mockChatReply("ok");
    const app = render(<App {...baseProps()} />);
    try {
      expect(app.lastFrame()).toContain("mode: normal");
      expect(app.lastFrame()).not.toContain("+trust");
      // "/trust" prefix-matches only itself, so Enter runs it directly.
      app.stdin.write("/trust");
      app.stdin.write("\r");
      await waitForFrame(app, "trust: on");
      expect(app.lastFrame()).toContain("mode: normal+trust");
      // /mode names the tier. NOTE: "/mode" is a prefix of "/model", so the
      // slash menu highlights "/model" first — arrow down once to run "/mode".
      app.stdin.write("/mode");
      await waitForFrame(app, "Atom commands");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "(write/edit/bash auto-approved; /trust revokes)");
      // Toggling again revokes back to per-tool prompting.
      app.stdin.write("/trust");
      app.stdin.write("\r");
      await waitForFrame(app, "trust: off");
    } finally {
      app.unmount();
    }
  });

  test("trusted session auto-approves a write with no prompt and keeps the ⚙ audit line", async () => {
    const probe = "trust-probe-auto.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hello" }),
      textMsg("written"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/trust");
      app.stdin.write("\r");
      await waitForFrame(app, "trust: on");
      app.stdin.write("please write it");
      app.stdin.write("\r");
      // The turn completes with zero approval keypresses — without trust it
      // would stall forever on the approval prompt.
      await waitForFrame(app, "written");
      expect(app.lastFrame()).toContain(`⚙ write ${probe}`);
      expect(app.lastFrame()).not.toContain("allow this tool?");
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(probe, "utf8")).resolves.toBe("hello");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("[t] in the approval prompt trusts the whole session: the next write runs unprompted", async () => {
    const probeA = "trust-probe-t-a.txt";
    const probeB = "trust-probe-t-b.txt";
    await cleanProbes(probeA, probeB);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probeA, content: "a" }),
      toolMsg("c2", "write", { path: probeB, content: "b" }),
      textMsg("both done"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("do both writes");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      expect(app.lastFrame()).toContain("[t]rust all");
      // One keypress trusts the session: both writes run, loop verifies done.
      app.stdin.write("t");
      await waitForFrame(app, "both done");
      expect(app.lastFrame()).toContain(`⚙ write ${probeA}`);
      expect(app.lastFrame()).toContain(`⚙ write ${probeB}`);
      expect(app.lastFrame()).toContain("mode: normal+trust");
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(probeA, "utf8")).resolves.toBe("a");
      await expect(readFile(probeB, "utf8")).resolves.toBe("b");
    } finally {
      app.unmount();
      await cleanProbes(probeA, probeB);
    }
  });

  test("denial path unchanged: n denies one call, denial feeds back as a result, file untouched", async () => {
    const probe = "trust-probe-deny.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("understood, denied"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it please");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("n");
      await waitForFrame(app, "understood, denied");
      expect(app.lastFrame()).toContain("denied by user: write");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});

// Scoped allow/deny rules (ticket 03): /allow + /deny add `tool[:glob]`
// patterns consulted in approve() before prompting. Same real-execution TUI
// style as the /trust tier above — probes under cwd, cleaned up each test.
describe("scoped rules /allow /deny /rules", () => {
  function toolMsg(id: string, name: string, args: Record<string, unknown>) {
    return {
      message: {
        content: null,
        tool_calls: [
          { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    };
  }

  function textMsg(content: string) {
    return { message: { content } };
  }

  function mockChatScriptMessages(messages: unknown[]) {
    const queue = [...messages];
    globalThis.fetch = vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { ok: true, json: async () => ({ choices: [next] }) } as Response;
    });
  }

  async function cleanProbes(...probes: string[]) {
    const { rm } = await import("node:fs/promises");
    for (const p of probes) {
      try {
        await rm(p, { force: true });
      } catch {
        // ignore
      }
    }
  }

  test("allow-pattern calls flow unprompted with the ⚙ audit line", async () => {
    const probe = "rules-probe-allow.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hello" }),
      textMsg("written"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/allow write:rules-probe-*.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "allowed: write:rules-probe-*.txt");
      app.stdin.write("please write it");
      app.stdin.write("\r");
      // Zero approval keypresses — without the rule the turn would stall on
      // the approval prompt.
      await waitForFrame(app, "written");
      expect(app.lastFrame()).toContain(`⚙ write ${probe}`);
      expect(app.lastFrame()).not.toContain("allow this tool?");
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(probe, "utf8")).resolves.toBe("hello");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("deny-pattern calls are refused pre-execution with a replan-friendly result", async () => {
    const probe = "rules-probe-deny.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("understood, denied"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/deny write:rules-probe-deny.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "denied: write:rules-probe-deny.txt");
      app.stdin.write("write it please");
      app.stdin.write("\r");
      // Zero keypresses: refused before execution with no prompt — the model
      // sees the standard denial result and replans.
      await waitForFrame(app, "understood, denied");
      expect(app.lastFrame()).toContain("denied by user: write");
      expect(app.lastFrame()).not.toContain("allow this tool?");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("deny beats trust: a trusted session still refuses denied patterns", async () => {
    const probe = "rules-probe-deny-trust.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("understood, denied"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/trust");
      app.stdin.write("\r");
      await waitForFrame(app, "trust: on");
      app.stdin.write("/deny write:rules-probe-deny-trust.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "denied: write:rules-probe-deny-trust.txt");
      app.stdin.write("write it please");
      app.stdin.write("\r");
      await waitForFrame(app, "understood, denied");
      expect(app.lastFrame()).toContain("denied by user: write");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("/rules lists rules and /rules clear restores per-call prompting", async () => {
    const probe = "rules-probe-clear.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("understood, denied"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/allow write:rules-probe-clear.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "allowed: write:rules-probe-clear.txt");
      app.stdin.write("/rules");
      app.stdin.write("\r");
      await waitForFrame(app, "allow: write:rules-probe-clear.txt");
      app.stdin.write("/rules clear");
      app.stdin.write("\r");
      await waitForFrame(app, "(rules cleared)");
      // Prompting is back: the write now asks, and n denies it.
      app.stdin.write("write it please");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("n");
      await waitForFrame(app, "understood, denied");
      expect(app.lastFrame()).toContain("denied by user: write");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});
