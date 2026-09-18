// /effort + banner + Static tests. Network ALWAYS mocked — never live Zen.
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { ATOM_ART } from "../src/ui/transcript.js";
import {
  EFFORT_OPTIONS,
  isEffortSupported,
  normalizeEffort,
  reasoningEffortParam,
} from "../src/zen.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const realFetch = globalThis.fetch;

// Dock hygiene: these suites pin the dock path (ATOM_DOCK=1); the saved value
// is restored after every test so no other suite observes the override.
const SAVED_DOCK = process.env.ATOM_DOCK;

beforeEach(() => {
  process.env.ATOM_DOCK = "1";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  if (SAVED_DOCK === undefined) delete process.env.ATOM_DOCK;
  else process.env.ATOM_DOCK = SAVED_DOCK;
});

function baseProps(model = "big-pickle") {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    // Pinned: effort applies on every provider/model — the server vetoes via
    // 400, never a local allowlist (see the rejection test below).
    initialProvider: "opencode-zen" as const,
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

async function waitForFrameAbsent(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for absence of ${JSON.stringify(needle)}:\n${app.lastFrame()}`
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
  test("renders once with ATOM art only (dock is the sole info bar)", () => {
    mockChatCapture(["ok"], []);
    const app = render(<App {...baseProps()} />);
    try {
      const frame = app.lastFrame() ?? "";
      // Block-letter identity (first art line).
      expect(frame).toContain(ATOM_ART[0]);
      for (const line of ATOM_ART) expect(frame).toContain(line);
      // Once: first art line appears exactly once.
      expect(countOccurrences(frame, ATOM_ART[0]!)).toBe(1);
      // No header block, no hint lines in any frame.
      expect(frame).not.toContain("Atom · minimal");
      expect(frame).not.toContain("Tab toggles");
      expect(frame).not.toContain("Commands: /model");
      // Dock frame present with display-only action chips.
      expect(frame).toContain("╭");
      expect(frame).toContain("/model");
      expect(frame).toContain("/provider");
      // Dock pills carry provider/model/token/reasoning/mode.
      for (const seg of [
        "opencode-zen/big-pickle",
        "token: n/a",
        "reasoning: auto",
        "mode: normal",
      ]) {
        expect(frame).toContain(seg);
      }
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
      expect(app.lastFrame()).toContain("Auto");
      expect(app.lastFrame()).toContain("Max");
      // Down x3: auto -> low -> medium -> high.
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "reasoning: high");
      expect(app.lastFrame()).not.toContain("Select reasoning effort");
      expect(app.lastFrame()).not.toContain("(unsupported)");
      // Dock frame owns the pills (picker rendered above it, now closed).
      expect(app.lastFrame()).toContain("╭");
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
      // Dock keeps the Composer visible under the picker, so "›" can never
      // prove the close — wait for the picker itself to leave instead.
      await waitForFrameAbsent(app, "Select reasoning effort");
      expect(app.lastFrame()).not.toContain("Select reasoning effort");
      expect(app.lastFrame()).toContain("reasoning: auto");
    } finally {
      app.unmount();
    }
  });

  test("wire values are exactly auto/low/medium/high/max, model-agnostic", () => {
    expect([...EFFORT_OPTIONS]).toEqual(["auto", "low", "medium", "high", "max"]);
    // Sent for every model — support is assumed, the server vetoes via 400.
    expect(reasoningEffortParam("low", "kimi-k2.5")).toBe("low");
    expect(reasoningEffortParam("medium", "glm-5.3-flash")).toBe("medium");
    expect(reasoningEffortParam("high", "big-pickle")).toBe("high");
    expect(reasoningEffortParam("max", "deepseek-v4-pro")).toBe("max");
    expect(reasoningEffortParam("max", "some-future-model")).toBe("max");
    expect(reasoningEffortParam("max")).toBe("max");
    // Auto (and the legacy "default") omits; unknown omits.
    expect(reasoningEffortParam("auto", "kimi-k2.5")).toBeUndefined();
    expect(reasoningEffortParam("default", "kimi-k2.5")).toBeUndefined();
    expect(reasoningEffortParam(undefined, "kimi-k2.5")).toBeUndefined();
    expect(reasoningEffortParam("xhigh" as string, "kimi-k2.5")).toBeUndefined();
    // Legacy alias + fallback normalization.
    expect(normalizeEffort("default")).toBe("auto");
    expect(normalizeEffort("auto")).toBe("auto");
    expect(normalizeEffort("high")).toBe("high");
    expect(normalizeEffort("bogus")).toBe("auto");
    expect(normalizeEffort(undefined)).toBe("auto");
    // Support is provider-wide, never per-model: any model on a known
    // provider is supported; only empty models / unknown providers are not.
    expect(isEffortSupported("kimi-k2.5")).toBe(true);
    expect(isEffortSupported("big-pickle")).toBe(true);
    expect(isEffortSupported("big-pickle", "opencode-zen")).toBe(true);
    expect(isEffortSupported("kimi-k2.5", "openai")).toBe(true);
    expect(isEffortSupported("claude-sonnet-4-5", "anthropic")).toBe(true);
    expect(isEffortSupported("gemini-2.5-flash", "google-gemini")).toBe(true);
    expect(isEffortSupported("")).toBe(false);
    expect(isEffortSupported("x", "no-such-provider")).toBe(false);
  });
});

describe("effort sending (server-authoritative, never preemptively gated)", () => {
  test("POST contains reasoning_effort for every model (no allowlist)", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockChatCapture(["ok1", "ok2"], captured);
    // big-pickle was previously "unsupported" — now it sends like the rest.
    const app = render(<App {...baseProps("big-pickle")} />);
    try {
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      // auto -> low -> medium -> high -> max (4 downs for max).
      for (let i = 0; i < 4; i++) app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "reasoning: max");
      expect(app.lastFrame()).not.toContain("(unsupported)");
      // Reasoning pill lives in the dock frame.
      expect(app.lastFrame()).toContain("╭");
      expect(app.lastFrame()).toContain("reasoning: max");
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "ok1");
      const last = captured.at(-1) ?? {};
      expect(last["reasoning_effort"]).toBe("max");
      expect(last["model"]).toBe("big-pickle");
    } finally {
      app.unmount();
    }
  });

  test("Auto omits reasoning_effort", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockChatCapture(["hi-back"], captured);
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "hi-back");
      const last = captured.at(-1) ?? {};
      expect("reasoning_effort" in last).toBe(false);
      expect(app.lastFrame()).toContain("reasoning: auto");
      expect(app.lastFrame()).toContain("╭");
    } finally {
      app.unmount();
    }
  });

  test("only a real server 400 vetoes the knob: warn + retry once without it", async () => {
    const captured: Array<Record<string, unknown>> = [];
    let calls = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      try {
        captured.push(JSON.parse(String((init as unknown as { body?: unknown })?.body ?? "{}")));
      } catch {
        captured.push({});
      }
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => "Invalid value for 'reasoning_effort': unsupported for model big-pickle",
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "recovered-reply" } }] }),
      } as Response;
    });
    const app = render(<App {...baseProps("big-pickle")} />);
    try {
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      app.stdin.write("\u001B[B"); // auto -> low
      app.stdin.write("\r");
      await waitForFrame(app, "reasoning: low");
      expect(app.lastFrame()).not.toContain("(unsupported)");
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "recovered-reply");
      // The rejection surfaces as a warning; the turn still completes.
      await waitForFrame(app, 'reasoning effort "low" is not supported by big-pickle');
      expect(captured.length).toBe(2);
      expect(captured[0]?.["reasoning_effort"]).toBe("low");
      expect("reasoning_effort" in (captured[1] ?? {})).toBe(false);
      // Setting kept — dock pill still shows the effort, never "(unsupported)".
      expect(app.lastFrame()).toContain("reasoning: low");
      expect(app.lastFrame()).not.toContain("(unsupported)");
      expect(app.lastFrame()).toContain("╭");
    } finally {
      app.unmount();
    }
  });

  test("an unrelated 400 still fails loudly (no silent effort drop)", async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 400,
        text: async () => "invalid tool schema: missing properties",
      } as Response;
    });
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      for (let i = 0; i < 3; i++) app.stdin.write("\u001B[B"); // -> high
      app.stdin.write("\r");
      await waitForFrame(app, "reasoning: high");
      expect(app.lastFrame()).toContain("╭");
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "Zen HTTP 400");
      expect(app.lastFrame()).not.toContain("is not supported by");
    } finally {
      app.unmount();
    }
  });

  test("effort survives /model switches and is sent for every model", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockChatCapture(["a1", "a2", "a3"], captured);
    const app = render(<App {...baseProps("kimi-k2.5")} />);
    try {
      // Set high.
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

      // Switch to big-pickle via picker (kimi-k2.5 is index 1, up -> big-pickle):
      // effort persists AND is still sent — no gating, no warning.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B[A"); // up: kimi-k2.5 -> big-pickle
      app.stdin.write("\r");
      await waitForFrame(app, "big-pickle");
      await waitForFrame(app, "reasoning: high");
      expect(app.lastFrame()).not.toContain("(unsupported)");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "a2");
      expect(captured.at(-1)?.["reasoning_effort"]).toBe("high");

      // Switch back to kimi-k2.5: effort still high, still sent.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B[B"); // big-pickle -> kimi-k2.5
      app.stdin.write("\r");
      await waitForFrame(app, "kimi-k2.5");
      await waitForFrame(app, "reasoning: high");
      expect(app.lastFrame()).not.toContain("(unsupported)");
      app.stdin.write("third");
      app.stdin.write("\r");
      await waitForFrame(app, "a3");
      expect(captured.at(-1)?.["reasoning_effort"]).toBe("high");
      // Dock pills track the effort across both switches.
      expect(app.lastFrame()).toContain("╭");
      expect(app.lastFrame()).toContain("reasoning: high");
    } finally {
      app.unmount();
    }
  });

  test("/help documents /effort levels and server-authoritative support", async () => {
    mockChatCapture(["ok"], []);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/help");
      app.stdin.write("\r");
      await waitForFrame(app, "/effort");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Max");
      expect(frame).toContain("Auto");
      expect(frame).toContain("reasoning_effort");
      expect(frame).toContain("thinking");
    } finally {
      app.unmount();
    }
  });
});
