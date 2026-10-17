// Per-step usage ledger (realtime-token-usage 05): one row per model POST.
//
// Pure helper pins plus App-level proof: multi-POST sessions list each
// step with its breakdown, no-usage POSTs render explicit not-reported
// rows, compaction POSTs are visually distinct, and a fresh session shows
// the empty state. Network is ALWAYS mocked — never hit live APIs.
import React from "react";
import { userInfo } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  MAX_USAGE_STEPS,
  aggregateSubscriptionUsage,
  formatStepUsage,
  formatSubscriptionUsage,
  recordUsageStep,
  stepsForSession,
  type UsageStep,
} from "../src/usage-ledger.js";
import { waitForFrame, waitForFrameAbsent } from "./helpers/wait-for-frame.js";

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

// --- subscription usage aggregates (Task 3.1) ---

function step(row: Partial<UsageStep>): UsageStep {
  return {
    seq: 1,
    kind: "turn",
    sessionId: "s1",
    model: "m",
    usage: null,
    at: "2026-10-07T00:00:00.000Z",
    ...row,
  };
}

describe("provider attribution", () => {
  test("recordUsageStep stores the provider when given; omits it otherwise", () => {
    const [withProvider] = recordUsageStep([], {
      kind: "turn",
      sessionId: "s1",
      model: "m",
      provider: "openai",
      usage: null,
    });
    expect(withProvider?.provider).toBe("openai");
    const [bare] = recordUsageStep([], { kind: "turn", sessionId: "s1", model: "m" });
    expect(bare?.provider).toBeUndefined();
  });
});

describe("user attribution (Task 3.3)", () => {
  test("recordUsageStep stores the user when given; omits empty or absent", () => {
    const [withUser] = recordUsageStep([], {
      kind: "turn",
      sessionId: "s1",
      model: "m",
      user: "alice",
      usage: null,
    });
    expect(withUser?.user).toBe("alice");
    const [empty] = recordUsageStep([], {
      kind: "turn",
      sessionId: "s1",
      model: "m",
      user: "",
      usage: null,
    });
    expect(empty?.user).toBeUndefined();
    const [bare] = recordUsageStep([], { kind: "turn", sessionId: "s1", model: "m" });
    expect(bare?.user).toBeUndefined();
  });

  test("aggregateSubscriptionUsage ignores the user field (provider/period only)", () => {
    const rows = [
      {
        ...step({ provider: "openai", usage: { prompt_tokens: 10 }, at: "2026-10-01T00:00:00.000Z" }),
        user: "alice",
      },
      {
        ...step({ provider: "openai", usage: { prompt_tokens: 5 }, at: "2026-10-02T00:00:00.000Z" }),
        user: "bob",
      },
    ];
    expect(aggregateSubscriptionUsage(rows)).toEqual([
      { provider: "openai", period: "2026-10", inputTokens: 15, outputTokens: 0 },
    ]);
  });
});

describe("aggregateSubscriptionUsage", () => {
  test("groups by provider and period, sums tokens, deterministic order", () => {
    const rows = [
      step({ provider: "openai", usage: { prompt_tokens: 100, completion_tokens: 20 }, at: "2026-10-01T10:00:00.000Z" }),
      step({ provider: "openai", usage: { prompt_tokens: 50, completion_tokens: 10 }, at: "2026-10-05T10:00:00.000Z" }),
      step({ provider: "openai", usage: { prompt_tokens: 7, completion_tokens: 3 }, at: "2026-09-15T10:00:00.000Z" }),
      step({ provider: "anthropic", usage: { prompt_tokens: 5, completion_tokens: 1 }, at: "2026-10-02T10:00:00.000Z" }),
    ];
    expect(aggregateSubscriptionUsage(rows)).toEqual([
      { provider: "anthropic", period: "2026-10", inputTokens: 5, outputTokens: 1 },
      { provider: "openai", period: "2026-10", inputTokens: 150, outputTokens: 30 },
      { provider: "openai", period: "2026-09", inputTokens: 7, outputTokens: 3 },
    ]);
  });

  test("unattributed rows and not-reported POSTs contribute nothing", () => {
    const rows = [
      step({ usage: null, at: "2026-10-01T00:00:00.000Z" }),
      step({ usage: { prompt_tokens: 42 }, at: "2026-10-01T00:00:00.000Z" }),
      step({ provider: "openai", usage: { prompt_tokens: 9, completion_tokens: 1 }, at: "2026-10-01T00:00:00.000Z" }),
    ];
    expect(aggregateSubscriptionUsage(rows)).toEqual([
      { provider: "openai", period: "2026-10", inputTokens: 9, outputTokens: 1 },
    ]);
  });

  test("cost appears only when reported; invalid limits are never attached", () => {
    const rows = [
      step({ provider: "openai", usage: { prompt_tokens: 10 }, costUsd: 0.25, at: "2026-10-01T00:00:00.000Z" }),
      step({ provider: "openai", usage: { prompt_tokens: 5 }, costUsd: 0.5, at: "2026-10-02T00:00:00.000Z" }),
      step({ provider: "anthropic", usage: { prompt_tokens: 1 }, at: "2026-10-01T00:00:00.000Z" }),
    ];
    const totals = aggregateSubscriptionUsage(rows, { openai: 500, anthropic: 0 });
    const openai = totals.find((t) => t.provider === "openai");
    expect(openai?.costUsd).toBe(0.75);
    expect(openai?.limit).toBe(500);
    const anthropic = totals.find((t) => t.provider === "anthropic");
    expect(anthropic?.costUsd).toBeUndefined(); // no pricing reported → unknown, never $0
    expect(anthropic?.limit).toBeUndefined(); // a zero limit is not a limit
  });

  test("unusable timestamps and non-array input never throw", () => {
    expect(
      aggregateSubscriptionUsage([
        step({ provider: "openai", usage: { prompt_tokens: 1 }, at: "not-a-date" }),
      ])
    ).toEqual([]);
    expect(aggregateSubscriptionUsage("x" as never)).toEqual([]);
    expect(aggregateSubscriptionUsage(undefined as never)).toEqual([]);
  });
});

describe("formatSubscriptionUsage", () => {
  test("full row carries cost and limit; minimal row does not", () => {
    expect(
      formatSubscriptionUsage({
        provider: "openai",
        period: "2026-10",
        inputTokens: 1234,
        outputTokens: 567,
        costUsd: 0.42,
        limit: 500,
      })
    ).toBe("openai 2026-10 · in 1234 · out 567 · $0.4200 · limit 500");
    expect(
      formatSubscriptionUsage({
        provider: "anthropic",
        period: "2026-10",
        inputTokens: 0,
        outputTokens: 0,
      })
    ).toBe("anthropic 2026-10 · in 0 · out 0");
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
      // Per-user attribution (Task 3.3): rows name the local OS user.
      expect(frame).toContain(`@${userInfo().username}`);
      // Provider-attributed totals footer (Task 3.1): 100 + 150 this period.
      expect(frame).toContain("Subscription totals");
      expect(frame).toContain("in 250");
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
