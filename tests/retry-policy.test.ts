// Transport retry policy tests: 10 retries with exponential backoff for
// rate limits (429 + Retry-After) and weak-network throws; fail-fast for
// other 4xx; cancellations never retry. Sleeps are injected (instant).
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MAX_RETRIES,
  chatCompletion,
  getRetryDelay,
  type ChatMessage,
} from "../src/zen.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function httpFail(status: number, retryAfter: string | null = null) {
  return {
    ok: false,
    status,
    text: async () => "limited",
    headers: { get: (k: string) => (k === "Retry-After" ? retryAfter : null) },
  } as unknown as Response;
}

function jsonOk(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

const HISTORY: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("retry policy shape", () => {
  test("ten retries", () => {
    expect(MAX_RETRIES).toBe(10);
  });
  test("backoff doubles from 1s under a 30s cap", () => {
    expect(getRetryDelay(0)).toBe(1000);
    expect(getRetryDelay(1)).toBe(2000);
    expect(getRetryDelay(2)).toBe(4000);
    expect(getRetryDelay(3)).toBe(8000);
    expect(getRetryDelay(5)).toBe(30000);
    expect(getRetryDelay(10)).toBe(30000);
  });
  test("Retry-After seconds win over backoff", () => {
    expect(getRetryDelay(0, httpFail(429, "5"))).toBe(5000);
    expect(getRetryDelay(3, httpFail(429, "120"))).toBe(30000);
  });
  test("Retry-After garbage falls back to backoff", () => {
    expect(getRetryDelay(1, httpFail(429, "soon"))).toBe(2000);
    expect(getRetryDelay(0, httpFail(429, ""))).toBe(1000);
  });
});

describe("chatCompletion retries", () => {
  test("429s retry then succeed; phases count 1/10, 2/10", async () => {
    let calls = 0;
    const delays: number[] = [];
    const phases: string[] = [];
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) return httpFail(429);
      return jsonOk("recovered");
    });
    const res = await chatCompletion("https://x", "k", "m", HISTORY, {
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      onPhase: (p, detail) => {
        if (p === "retry") phases.push(detail ?? "");
      },
    });
    expect(res.content).toBe("recovered");
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
    expect(phases).toEqual([
      "attempt 1/10 after 1000ms (HTTP 429)",
      "attempt 2/10 after 2000ms (HTTP 429)",
    ]);
  });
  test("persistent 429 fails after eleven attempts", async () => {
    let calls = 0;
    let sleeps = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return httpFail(429);
    });
    await expect(
      chatCompletion("https://x", "k", "m", HISTORY, {
        sleep: async () => {
          sleeps += 1;
        },
      })
    ).rejects.toThrow("HTTP 429");
    expect(calls).toBe(11);
    expect(sleeps).toBe(10);
  });
  test("weak-network throws retry then succeed", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      return jsonOk("back");
    });
    const res = await chatCompletion("https://x", "k", "m", HISTORY, {
      sleep: async () => {},
    });
    expect(res.content).toBe("back");
    expect(calls).toBe(2);
  });
  test("non-retryable 400 fails fast with one call", async () => {
    let calls = 0;
    let sleeps = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return httpFail(400);
    });
    await expect(
      chatCompletion("https://x", "k", "m", HISTORY, {
        sleep: async () => {
          sleeps += 1;
        },
      })
    ).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
    expect(sleeps).toBe(0);
  });
});
