// /effort + banner + Static tests. Network ALWAYS mocked — never live Zen.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App, ATOM_ART } from "../src/App.js";
import {
  EFFORT_OPTIONS,
  REASONING_EFFORT_SUPPORTED_MODELS,
  isEffortSupported,
  reasoningEffortParam,
} from "../src/zen.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function baseProps(model = "big-pickle") {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: model,
    initialModels: MODELS,
  };
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

// Capture POST JSON bodies, reply with queued texts.
function mockChatCapture(replies: string[], captured: Array<Record<string, unknown>>) {
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    try {
      captured.push(JSON.parse(String((init as unknown as { body?: unknown })?.body ?? "{}")));
    } catch {
      captured.push({});
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: next } }] }),
    } as Response;
  });
}

function countOccurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("startup banner", () => {
  test("renders once with ATOM art + key hints", () => {
    mockChatCapture(["ok"], []);
    const app = render(<App {...baseProps()} />);
    try {
      const frame = app.lastFrame() ?? "";
      // Block-letter identity (first art line).
      expect(frame).toContain(ATOM_ART[0]);
      for (const line of ATOM_ART) expect(frame).toContain(line);
      // Tagline + one-line key hints.
      expect(frame).toContain("Tab toggles mode");
      expect(frame).toContain("/model");
      expect(frame).toContain("/effort");
      // Once: first art line appears exactly once.
      expect(countOccurrences(frame, ATOM_ART[0]!)).toBe(1);
    } finally {
      app.unmount();
    }
  });
});

describe("Static transcript", () => {
  test("keeps history visible after many turns", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockChatCapture(["r1", "r2", "r3", "r4", "r5"], captured);
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      for (let i = 1; i <= 5; i++) {
        app.stdin.write(`msg${i}`);
        app.stdin.write("\r");
        await waitForFrame(app, `r${i}`);
      }
      const frame = app.lastFrame() ?? "";
      for (let i = 1; i <= 5; i++) {
        expect(frame).toContain(`msg${i}`);
        expect(frame).toContain(`r${i}`);
      }
      // Banner still present exactly once after many turns.
      expect(frame).toContain(ATOM_ART[0]!);
      expect(countOccurrences(frame, ATOM_ART[0]!)).toBe(1);
    } finally {
      app.unmount();
    }
  });
});

describe("/effort dropdown", () => {
  test("arrow keys + Enter select, status wires to effort", async () => {
    mockChatCapture(["ok"], []);
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      expect(app.lastFrame()).toContain("Default");
      expect(app.lastFrame()).toContain("Max");
      // Down x3: default -> low -> medium -> high.
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "reasoning: high");
      expect(app.lastFrame()).not.toContain("Select reasoning effort");
      expect(app.lastFrame()).not.toContain("(unsupported)");
    } finally {
      app.unmount();
    }
  });

  test("Esc cancels without changing effort", async () => {
    mockChatCapture(["ok"], []);
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      app.stdin.write("\u001B[B");
      await new Promise((r) => setTimeout(r, 60));
      app.stdin.write("\u001B");
      await waitForFrame(app, "›");
      expect(app.lastFrame()).not.toContain("Select reasoning effort");
      expect(app.lastFrame()).toContain("reasoning: default");
    } finally {
      app.unmount();
    }
  });

  test("wire values are exactly default/low/medium/high/max", () => {
    expect([...EFFORT_OPTIONS]).toEqual(["default", "low", "medium", "high", "max"]);
    // Supported model sends through; Default omits; unknown omits.
    expect(reasoningEffortParam("low", "kimi-k2.5")).toBe("low");
    expect(reasoningEffortParam("medium", "kimi-k2.6")).toBe("medium");
    expect(reasoningEffortParam("high", "glm-5.1")).toBe("high");
    expect(reasoningEffortParam("max", "glm-5.2")).toBe("max");
    expect(reasoningEffortParam("max", "deepseek-v4-pro")).toBe("max");
    expect(reasoningEffortParam("low", "deepseek-v4-flash")).toBe("low");
    expect(reasoningEffortParam("default", "kimi-k2.5")).toBeUndefined();
    expect(reasoningEffortParam(undefined, "kimi-k2.5")).toBeUndefined();
    expect(reasoningEffortParam("high", "big-pickle")).toBeUndefined();
    expect(reasoningEffortParam("xhigh" as string, "kimi-k2.5")).toBeUndefined();
    // Support set is exactly the six verified models.
    expect([...REASONING_EFFORT_SUPPORTED_MODELS].sort()).toEqual(
      ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.1", "glm-5.2", "kimi-k2.5", "kimi-k2.6"].sort()
    );
    expect(isEffortSupported("kimi-k2.5")).toBe(true);
    expect(isEffortSupported("big-pickle")).toBe(false);
  });
});

describe("reasoning_effort gating", () => {
  test("POST contains reasoning_effort on supported model", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockChatCapture(["ok1", "ok2"], captured);
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      // default -> low -> medium -> high -> max (4 downs for max).
      for (let i = 0; i < 4; i++) app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "reasoning: max");
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "ok1");
      const last = captured.at(-1) ?? {};
      expect(last["reasoning_effort"]).toBe("max");
      expect(last["model"]).toBe("kimi-k2.5");
    } finally {
      app.unmount();
    }
  });

  test("Default omits reasoning_effort", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockChatCapture(["hi-back"], captured);
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "hi-back");
      const last = captured.at(-1) ?? {};
      expect("reasoning_effort" in last).toBe(false);
      expect(app.lastFrame()).toContain("reasoning: default");
    } finally {
      app.unmount();
    }
  });

  test("unsupported model omits param + warning + (unsupported) status", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockChatCapture(["ok"], captured);
    const app = render(<App {...baseProps("big-pickle")} />);
    try {
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      app.stdin.write("\u001B[B"); // -> low
      app.stdin.write("\r");
      await waitForFrame(app, "reasoning: low (unsupported)");
      await waitForFrame(
        app,
        "reasoning effort is not known to be supported by big-pickle — setting kept, not sent"
      );
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "ok");
      const last = captured.at(-1) ?? {};
      expect("reasoning_effort" in last).toBe(false);
      expect(app.lastFrame()).toContain("reasoning: low (unsupported)");
    } finally {
      app.unmount();
    }
  });

  test("effort survives /model switch and re-gates", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockChatCapture(["a1", "a2", "a3"], captured);
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      // Set high on supported model.
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      for (let i = 0; i < 3; i++) app.stdin.write("\u001B[B"); // -> high
      app.stdin.write("\r");
      await waitForFrame(app, "reasoning: high");
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "a1");
      expect(captured.at(-1)?.["reasoning_effort"]).toBe("high");

      // Switch to unsupported big-pickle via picker (kimi-k2.5 is index 1, up -> big-pickle).
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B[A"); // up: kimi-k2.5 -> big-pickle
      app.stdin.write("\r");
      await waitForFrame(app, "model: big-pickle");
      await waitForFrame(app, "reasoning: high (unsupported)");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "a2");
      expect("reasoning_effort" in (captured.at(-1) ?? {})).toBe(false);

      // Switch back to kimi-k2.5: effort still high, gating re-enables.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B[B"); // big-pickle -> kimi-k2.5
      app.stdin.write("\r");
      await waitForFrame(app, "model: kimi-k2.5");
      await waitForFrame(app, "reasoning: high");
      expect(app.lastFrame()).not.toContain("(unsupported)");
      app.stdin.write("third");
      app.stdin.write("\r");
      await waitForFrame(app, "a3");
      expect(captured.at(-1)?.["reasoning_effort"]).toBe("high");
    } finally {
      app.unmount();
    }
  });

  test("/help documents /effort, Max substitution, and gating", async () => {
    mockChatCapture(["ok"], []);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/help");
      app.stdin.write("\r");
      await waitForFrame(app, "/effort");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Max");
      expect(frame).toContain("reasoning_effort");
      expect(frame).toContain("kimi-k2.5");
    } finally {
      app.unmount();
    }
  });
});
