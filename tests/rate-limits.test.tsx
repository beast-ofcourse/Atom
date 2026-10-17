// Rate limit awareness (src/rate-limits.ts): header-family parsing
// (OpenAI + Anthropic), reset parsing in every documented format, warning
// thresholds, per-window dedupe, and the snapshot store — plus one
// App-level proof that a POST carrying quota headers announces a warning
// in the TUI. Network is ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  RATE_LIMIT_WARN_FRACTION,
  clearRateLimitState,
  forgetRateLimit,
  getRateLimit,
  nextRateLimitWarning,
  parseRateLimitHeaders,
  rateLimitWarning,
  recordRateLimit,
} from "../src/rate-limits.js";
import { waitForFrame } from "./helpers/wait-for-frame.js";

const AT = 1_800_000_000;

beforeEach(() => clearRateLimitState());
afterEach(() => {
  clearRateLimitState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseRateLimitHeaders", () => {
  test("OpenAI requests family with a relative reset", () => {
    const snapshot = parseRateLimitHeaders(
      "openai",
      {
        "x-ratelimit-limit-requests": "500",
        "x-ratelimit-remaining-requests": "3",
        "x-ratelimit-reset-requests": "60",
      },
      AT
    );
    expect(snapshot).toEqual({
      provider: "openai",
      limit: 500,
      remaining: 3,
      resetAt: AT + 60,
      unit: "requests",
      observedAt: AT,
    });
  });

  test("OpenAI epoch and Go-duration resets both parse (counts required for a snapshot)", () => {
    const counts = {
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "50",
    };
    expect(
      parseRateLimitHeaders(
        "openai",
        { ...counts, "x-ratelimit-reset-requests": "1800000123" },
        AT
      )?.resetAt
    ).toBe(1_800_000_123);
    expect(
      parseRateLimitHeaders(
        "openai",
        { ...counts, "x-ratelimit-reset-requests": "6m0s" },
        AT
      )?.resetAt
    ).toBe(AT + 360);
    // A reset header without any quota counts is not a snapshot.
    expect(
      parseRateLimitHeaders("openai", { "x-ratelimit-reset-requests": "60" }, AT)
    ).toBeUndefined();
  });

  test("Anthropic family with an ISO reset; token family when requests are absent", () => {
    const requests = parseRateLimitHeaders(
      "anthropic",
      {
        "anthropic-ratelimit-requests-limit": "50",
        "anthropic-ratelimit-requests-remaining": "40",
        "anthropic-ratelimit-requests-reset": "2030-01-01T00:00:00Z",
      },
      AT
    );
    expect(requests?.unit).toBe("requests");
    expect(requests?.limit).toBe(50);
    expect(requests?.remaining).toBe(40);
    expect(requests?.resetAt).toBe(Date.parse("2030-01-01T00:00:00Z") / 1000);

    const tokens = parseRateLimitHeaders(
      "anthropic",
      {
        "anthropic-ratelimit-input-tokens-limit": "100000",
        "anthropic-ratelimit-input-tokens-remaining": "9000",
      },
      AT
    );
    expect(tokens?.unit).toBe("tokens");
    expect(tokens?.limit).toBe(100_000);
    expect(tokens?.remaining).toBe(9_000);
  });

  test("keys are matched case-insensitively; unknown headers yield undefined", () => {
    expect(
      parseRateLimitHeaders("openai", { "X-RateLimit-Limit-Requests": "10" }, AT)?.limit
    ).toBe(10);
    expect(
      parseRateLimitHeaders("openai", { "content-type": "application/json" }, AT)
    ).toBeUndefined();
    expect(parseRateLimitHeaders("openai", {}, AT)).toBeUndefined();
  });
});

describe("rateLimitWarning", () => {
  const snapshot = (remaining: number, resetAt?: number) => ({
    provider: "openai",
    limit: 500,
    remaining,
    unit: "requests" as const,
    observedAt: AT,
    ...(resetAt !== undefined ? { resetAt } : {}),
  });

  test("healthy quota warns nothing; threshold is the shared constant", () => {
    expect(RATE_LIMIT_WARN_FRACTION).toBe(0.1);
    expect(rateLimitWarning(snapshot(400), AT)).toBeNull();
    expect(rateLimitWarning(snapshot(51), AT)).toBeNull(); // 10.2% > 10%
  });

  test("approaching warns with counts and a reset hint", () => {
    expect(rateLimitWarning(snapshot(45, AT + 300), AT)).toBe(
      "openai: rate limit approaching — 45 of 500 requests left — resets in 5m"
    );
  });

  test("exhausted quota says reached; missing counts never warn", () => {
    expect(rateLimitWarning(snapshot(0), AT)).toBe(
      "openai: rate limit reached (0 of 500 requests left)"
    );
    expect(
      rateLimitWarning({ provider: "openai", unit: "requests", observedAt: AT }, AT)
    ).toBeNull();
    expect(
      rateLimitWarning(
        { provider: "openai", limit: 0, remaining: 0, unit: "requests", observedAt: AT },
        AT
      )
    ).toBeNull();
  });
});

describe("nextRateLimitWarning dedupe", () => {
  const crossing = (resetAt: number, remaining = 10) => ({
    provider: "openai",
    limit: 500,
    remaining,
    resetAt,
    unit: "requests" as const,
    observedAt: AT,
  });

  test("one warning per reset window; a healthy snapshot re-arms", () => {
    expect(nextRateLimitWarning(crossing(1), AT)).toContain("approaching");
    expect(nextRateLimitWarning(crossing(1), AT)).toBeNull(); // same window
    expect(nextRateLimitWarning(crossing(2), AT)).toContain("approaching"); // new window
    // Healthy POSTs re-arm the provider for the next crossing.
    expect(nextRateLimitWarning({ ...crossing(3), remaining: 400 }, AT)).toBeNull();
    expect(nextRateLimitWarning(crossing(3), AT)).toContain("approaching");
  });
});

describe("snapshot store", () => {
  test("record, read, forget", () => {
    const snapshot = parseRateLimitHeaders(
      "anthropic",
      {
        "anthropic-ratelimit-requests-limit": "10",
        "anthropic-ratelimit-requests-remaining": "2",
      },
      AT
    );
    if (!snapshot) throw new Error("expected a snapshot");
    recordRateLimit(snapshot);
    expect(getRateLimit("anthropic")?.remaining).toBe(2);
    forgetRateLimit("anthropic");
    expect(getRateLimit("anthropic")).toBeUndefined();
  });
});

// --- App-level: a POST with quota headers announces the warning ---

function mockChatWithRateHeaders(): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    headers: new Headers({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "5",
      "x-ratelimit-reset-requests": "120",
    }),
    json: async () => ({
      choices: [{ message: { content: "reply-1" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
  })) as unknown as typeof fetch;
}

describe("TUI warning", () => {
  test("a throttled response surfaces one warning line in the transcript", async () => {
    clearRateLimitState();
    mockChatWithRateHeaders();
    const app = render(
      <App
        apiKey="test-key"
        endpoint="https://opencode.ai/zen/v1/chat/completions"
        initialModel="big-pickle"
        initialModels={["big-pickle"]}
      />
    );
    try {
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "reply-1");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("rate limit approaching");
      expect(frame).toContain("5 of 100 requests left");
      // The header dump itself never reaches the transcript.
      expect(frame).not.toContain("x-ratelimit");
    } finally {
      app.unmount();
      clearRateLimitState();
    }
  });
});
