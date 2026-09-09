// Prompt-cache architecture tests: stable-prefix assembly, provider
// capability declarations, usage-field parsing, and adapter boundaries.
// Pure unit tests (no TUI); network never touched (only builders/parsers).
import { describe, expect, test, vi } from "vitest";
import {
  assemblePrefix,
  ephemeralBreakpoint,
  providerCacheSupport,
  splitSystemHead,
} from "../src/prompt-cache.js";
import {
  buildAnthropicBody,
  buildGeminiBody,
  parseAnthropicJson,
  parseGeminiJson,
} from "../src/adapters.js";
import { chatCompletion, parseUsage } from "../src/zen.js";
import type { ChatMessage } from "../src/zen.js";

const STABLE = "You are ATOM, a coding agent.";
const ENV_A = "[env cwd=/repo branch=main status=clean node=v22 time=2026-01-01T00:00:00.000Z]";
const ENV_B = "[env cwd=/repo branch=main status=dirty:3 node=v22 time=2026-06-01T00:00:00.000Z]";
const WITH_ENV_A = `${STABLE}\n\n${ENV_A}`;
const WITH_ENV_B = `${STABLE}\n\n${ENV_B}`;

function sysHistory(system: string): ChatMessage[] {
  return [
    { role: "system", content: system },
    { role: "user", content: "hi" },
  ];
}

describe("assemblePrefix", () => {
  test("splits stable base from the env tail; null dynamic without one", () => {
    const split = assemblePrefix({ systemContent: WITH_ENV_A });
    expect(split.stableSystem).toBe(STABLE);
    expect(split.dynamicSystem).toBe(ENV_A);
    const plain = assemblePrefix({ systemContent: STABLE });
    expect(plain.stableSystem).toBe(STABLE);
    expect(plain.dynamicSystem).toBeNull();
  });

  test("fingerprint is stable across dynamic tails, sensitive to stable/tools", () => {
    const a = assemblePrefix({ systemContent: WITH_ENV_A, toolsJson: "[tools]" });
    const b = assemblePrefix({ systemContent: WITH_ENV_B, toolsJson: "[tools]" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    const otherStable = assemblePrefix({ systemContent: `${STABLE}!\n\n${ENV_A}`, toolsJson: "[tools]" });
    expect(otherStable.fingerprint).not.toBe(a.fingerprint);
    const otherTools = assemblePrefix({ systemContent: WITH_ENV_A, toolsJson: "[other]" });
    expect(otherTools.fingerprint).not.toBe(a.fingerprint);
    const noTools = assemblePrefix({ systemContent: WITH_ENV_A });
    expect(noTools.fingerprint).not.toBe(a.fingerprint);
  });

  test("ephemeralBreakpoint returns fresh markers", () => {
    expect(ephemeralBreakpoint()).toEqual({ type: "ephemeral" });
    expect(ephemeralBreakpoint()).not.toBe(ephemeralBreakpoint());
  });
});

describe("splitSystemHead", () => {
  test("passes history through untouched without an env tail", () => {
    const history = sysHistory(STABLE);
    const out = splitSystemHead(history);
    expect(out).toBe(history);
    expect(out).toHaveLength(2);
  });

  test("splits [stable, dynamic, ...rest] without mutating input", () => {
    const history = sysHistory(WITH_ENV_A);
    const out = splitSystemHead(history);
    expect(out).not.toBe(history);
    expect(out).toEqual([
      { role: "system", content: STABLE },
      { role: "system", content: ENV_A },
      { role: "user", content: "hi" },
    ]);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "system", content: WITH_ENV_A });
  });

  test("non-system head passes through", () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(splitSystemHead(history)).toBe(history);
  });
});

describe("providerCacheSupport", () => {
  test("anthropic declares explicit breakpoints; mistral is conservative", () => {
    expect(providerCacheSupport("anthropic")).toMatchObject({
      explicitBreakpoints: true,
      implicitPrefix: true,
      usageCacheFields: true,
    });
    expect(providerCacheSupport("mistral")).toEqual({
      explicitBreakpoints: false,
      implicitPrefix: false,
      usageCacheFields: false,
      notes: expect.any(String),
    });
    expect(providerCacheSupport("openai").usageCacheFields).toBe(true);
    expect(providerCacheSupport("deepseek").usageCacheFields).toBe(true);
    expect(providerCacheSupport("google-gemini").usageCacheFields).toBe(true);
  });

  test("unknown providers get the conservative default", () => {
    expect(providerCacheSupport("nope")).toMatchObject({
      explicitBreakpoints: false,
      implicitPrefix: false,
      usageCacheFields: false,
    });
  });
});

describe("usage cache fields (reported-only)", () => {
  test("openai details + deepseek names parse; absent stays absent", () => {
    expect(
      parseUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 } })
    ).toEqual({ prompt_tokens: 10, cacheReadTokens: 4 });
    expect(parseUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 7 })).toEqual({
      prompt_tokens: 10,
      cacheReadTokens: 7,
    });
    // No cache fields reported → no cache keys (never zero-claims).
    expect(parseUsage({ prompt_tokens: 10 })).toEqual({ prompt_tokens: 10 });
    expect(parseUsage({})).toBeUndefined();
  });

  test("anthropic usage carries creation/read counters", () => {
    const msg = parseAnthropicJson({
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 20,
      },
    });
    expect(msg.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      cacheWriteTokens: 50,
      cacheReadTokens: 20,
    });
  });

  test("gemini usageMetadata carries cachedContentTokenCount", () => {
    const msg = parseGeminiJson({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        totalTokenCount: 110,
        cachedContentTokenCount: 30,
      },
    });
    expect(msg.usage).toMatchObject({ cacheReadTokens: 30, total_tokens: 110 });
  });
});

describe("adapter boundaries", () => {
  function toolHistory(system: string): ChatMessage[] {
    return [
      { role: "system", content: system },
      { role: "user", content: "do it" },
    ];
  }

  test("anthropic: plain system stays a legacy string with unmarked tools", () => {
    const body = buildAnthropicBody(toolHistory("sys"), "claude-sonnet-4-5");
    expect(body.system).toBe("sys");
    const tools = body.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => (t as { cache_control?: unknown }).cache_control === undefined)).toBe(true);
  });

  test("anthropic: env tail becomes blocks with breakpoints on stable head + last tool", () => {
    const body = buildAnthropicBody(toolHistory(WITH_ENV_A), "claude-sonnet-4-5");
    expect(body.system).toEqual([
      { type: "text", text: STABLE, cache_control: { type: "ephemeral" } },
      { type: "text", text: ENV_A },
    ]);
    const tools = body.tools ?? [];
    expect(tools.length).toBeGreaterThan(1);
    expect((tools[tools.length - 1] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(
      tools.slice(0, -1).every((t) => (t as { cache_control?: unknown }).cache_control === undefined)
    ).toBe(true);
  });

  test("gemini: plain system stays one part; env tail splits into two", () => {
    const plain = buildGeminiBody(toolHistory("sys"), "gemini-2.5-flash");
    expect(plain.system_instruction).toEqual({ parts: [{ text: "sys" }] });
    const split = buildGeminiBody(toolHistory(WITH_ENV_A), "gemini-2.5-flash");
    expect(split.system_instruction).toEqual({
      parts: [{ text: STABLE }, { text: ENV_A }],
    });
  });

  test("openai-chat: env tail becomes a second system message; plain passes through", async () => {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) } as Response;
    });
    try {
      await chatCompletion("https://example.test/v1/chat/completions", "k", "m", sysHistory(STABLE));
      expect((seen[0]?.["messages"] as unknown[])).toHaveLength(2);
      await chatCompletion("https://example.test/v1/chat/completions", "k", "m", sysHistory(WITH_ENV_A));
      expect(seen[1]?.["messages"]).toEqual([
        { role: "system", content: STABLE },
        { role: "system", content: ENV_A },
        { role: "user", content: "hi" },
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
