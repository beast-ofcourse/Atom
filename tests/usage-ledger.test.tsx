// Per-step usage ledger (realtime-token-usage 05): one row per model POST.
//
// Pure helper pins plus App-level proof: multi-POST sessions list each
// step with its breakdown, no-usage POSTs render explicit not-reported
// rows, compaction POSTs are visually distinct, and a fresh session shows
// the empty state. Network is ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  MAX_USAGE_STEPS,
  formatStepUsage,
  recordUsageStep,
  stepsForSession,
  type UsageStep,
} from "../src/usage-ledger.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockChatQueue(turns: Array<{ reply: string; usage?: unknown }>) {
  const posts: Array<Record<string, unknown>> = [];
  const queue = [...turns];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
    } catch {
      body = {};
    }
    posts.push(body);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: next.reply } }],
        ...(next.usage !== undefined ? { usage: next.usage } : {}),
      }),
    } as unknown as Response;
  });
  return posts;
}

async function waitForFrame(
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

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}

// --- pure helpers ---

describe("recordUsageStep", () => {
  test("assigns seq, keeps kinds, caps oldest-first, ignores invalid", () => {
    let steps: UsageStep[] = [];
    steps = recordUsageStep(steps, {
      kind: "turn",
      sessionId: "s1",
      model: "m",
      usage: { prompt_tokens: 10 },
    });
    steps = recordUsageStep(steps, { kind: "compaction", sessionId: "s1", model: "m" });
    expect(steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(steps[1]!.usage).toBe(null); // not-reported default, never zeros
    // Invalid input never throws and changes nothing.
    expect(recordUsageStep(steps, { kind: "nope", sessionId: "s1", model: "m" } as never)).toBe(steps);
    expect(recordUsageStep("x" as never, { kind: "turn", sessionId: "s1", model: "m" })).toBe("x");
    // Cap evicts oldest.
    let many: UsageStep[] = [];
    for (let i = 0; i < MAX_USAGE_STEPS + 5; i++) {
      many = recordUsageStep(many, { kind: "turn", sessionId: "s1", model: "m", usage: null });
    }
    expect(many).toHaveLength(MAX_USAGE_STEPS);
    expect(many[0]!.seq).toBe(6);
  });

  test("stepsForSession isolates sessions", () => {
    let steps: UsageStep[] = [];
    steps = recordUsageStep(steps, { kind: "turn", sessionId: "a", model: "m", usage: null });
    steps = recordUsageStep(steps, { kind: "turn", sessionId: "b", model: "m", usage: null });
    expect(stepsForSession(steps, "a").map((s) => s.seq)).toEqual([1]);
    expect(stepsForSession(steps, "b").map((s) => s.seq)).toEqual([2]);
    expect(stepsForSession(steps, "zzz")).toEqual([]);
  });
});

describe("formatStepUsage", () => {
  test("breakdown parts, null when nothing reported", () => {
    expect(formatStepUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })).toBe(
      "in 100 · out 20 · total 120"
    );
    expect(
      formatStepUsage({ prompt_tokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1 })
    ).toBe("in 5 · cache read 3/write 1");
    expect(formatStepUsage(null)).toBe(null);
    expect(formatStepUsage(undefined)).toBe(null);
    expect(formatStepUsage({})).toBe(null);
  });
});

// --- App-level dialog ---

describe("usage ledger dialog", () => {
  test("multi-POST session shows one row per POST with breakdowns", async () => {
    mockChatQueue([
      { reply: "r1", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
      { reply: "r2", usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("one");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("two");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      app.stdin.write("/usage");
      app.stdin.write("\r");
      await waitForFrame(app, "Usage ledger");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("#1");
      expect(frame).toContain("#2");
      expect(frame).toContain("[turn]");
      expect(frame).toContain("in 100");
      expect(frame).toContain("in 150");
      // Esc closes back to the composer.
      app.stdin.write(String.fromCharCode(27));
      await new Promise((r) => setTimeout(r, 150));
      expect(app.lastFrame()).not.toContain("Usage ledger");
    } finally {
      app.unmount();
    }
  });

  test("a POST that reported no usage shows an explicit not-reported row", async () => {
    mockChatQueue([{ reply: "r1" }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("one");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("/usage");
      app.stdin.write("\r");
      await waitForFrame(app, "Usage ledger");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("#1");
      expect(frame).toContain("n/a (not reported)");
    } finally {
      app.unmount();
    }
  });

  test("compaction POSTs are distinguishable from turn steps", async () => {
    mockChatQueue([
      { reply: "r1", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      { reply: "r2", usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
      { reply: "SUMMARY-TEXT", usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await waitForFrame(app, "context compacted:");
      app.stdin.write("/usage");
      app.stdin.write("\r");
      await waitForFrame(app, "Usage ledger");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("[turn]");
      expect(frame).toContain("[compact]");
      expect(frame).toContain("in 30");
    } finally {
      app.unmount();
    }
  });

  test("fresh session renders the empty state without errors", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/usage");
      app.stdin.write("\r");
      await waitForFrame(app, "Usage ledger");
      expect(app.lastFrame()).toContain("no model calls yet");
    } finally {
      app.unmount();
    }
  });
});
