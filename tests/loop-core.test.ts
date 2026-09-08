// Loop-core dedup + provider error-label tests (mocked fetch only, never live).
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  chatCompletion,
  chatCompletionForProvider,
  runAgenticLoop,
  runAgenticLoopForProvider,
  runLoopWithChat,
  type ChatMessage,
} from "../src/zen.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

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

// Queue-backed chat mock: each POST pops the next scripted assistant message,
// repeating the last forever (mirrors agent.test.tsx mockChatScript).
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

function mockHttp401() {
  let n = 0;
  globalThis.fetch = vi.fn(async () => {
    n += 1;
    return { ok: false, status: 401, text: async () => "unauthorized" } as unknown as Response;
  });
  return () => n;
}

const TOOL_THEN_FINAL = [
  {
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }],
  },
  {
    content: "found a.ts",
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  },
];

describe("loop core dedup (wrapper-equivalence)", () => {
  test("runAgenticLoop matches runLoopWithChat on tool→final incl. callbacks/usage", async () => {
    // Wrapper run.
    mockChatScript(TOOL_THEN_FINAL);
    const h1 = baseHistory();
    const phases1: string[] = [];
    const tools1: string[] = [];
    const usage1: unknown[] = [];
    const reply1 = await runAgenticLoop(ENDPOINT, "k", "m", h1, {
      execute: async () => "tool-result",
      onPhase: (p) => void phases1.push(p),
      onToolActivity: (label) => void tools1.push(label),
      onUsage: (u) => void usage1.push(u),
      sleep: async () => {},
    });

    // Core run with an equivalent chatFn (same chatCompletion wiring as the wrapper).
    mockChatScript(TOOL_THEN_FINAL);
    const h2 = baseHistory();
    const phases2: string[] = [];
    const tools2: string[] = [];
    const usage2: unknown[] = [];
    const reply2 = await runLoopWithChat(
      (h, o) =>
        chatCompletion(ENDPOINT, "k", "m", h, {
          onToken: o?.onToken,
          onPhase: o?.onPhase,
          onToolDelta: o?.onToolDelta,
          onWarning: o?.onWarning,
          sleep: o?.sleep,
          reasoningEffort: o?.reasoningEffort,
        }),
      h2,
      {
        execute: async () => "tool-result",
        onPhase: (p) => void phases2.push(p),
        onToolActivity: (label) => void tools2.push(label),
        onUsage: (u) => void usage2.push(u),
        sleep: async () => {},
      }
    );

    expect(reply1).toBe("found a.ts");
    expect(reply2).toBe(reply1);
    expect(h2.map((m) => m.role)).toEqual(h1.map((m) => m.role));
    expect(h2).toEqual(h1);
    expect(tools2).toEqual(tools1);
    expect(usage2).toEqual(usage1);
    expect(phases1).toContain("done");
    expect(phases2).toEqual(phases1);
  });

  test("runAgenticLoopForProvider (zen) matches runAgenticLoop through the same core", async () => {
    mockChatScript(TOOL_THEN_FINAL);
    const h1 = baseHistory();
    const reply1 = await runAgenticLoop(ENDPOINT, "k", "m", h1, {
      execute: async () => "tool-result",
      sleep: async () => {},
    });
    mockChatScript(TOOL_THEN_FINAL);
    const h2 = baseHistory();
    const reply2 = await runAgenticLoopForProvider("opencode-zen", "k", "m", h2, {
      execute: async () => "tool-result",
      sleep: async () => {},
    });
    expect(reply2).toBe(reply1);
    expect(h2).toEqual(h1);
  });

  test("cap enforced identically (too many tool steps)", async () => {
    const alwaysTool = [
      { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "glob", arguments: '{"pattern":"*"}' } }] },
    ];
    const m1 = mockChatScript(alwaysTool);
    const h1 = baseHistory();
    const reply1 = await runAgenticLoop(ENDPOINT, "k", "m", h1, {
      execute: async () => "tool-result",
      maxSteps: 2,
      sleep: async () => {},
    });
    expect(reply1).toContain("(stopped: too many tool steps)");
    expect(m1.count()).toBe(3);

    const m2 = mockChatScript(alwaysTool);
    const h2 = baseHistory();
    const reply2 = await runLoopWithChat(
      (h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep }),
      h2,
      { execute: async () => "tool-result", maxSteps: 2, sleep: async () => {} }
    );
    expect(reply2).toBe(reply1);
    expect(m2.count()).toBe(3);
  });

  test("rollback contract identical: POST failure throws, tool results stay; tool errors are results", async () => {
    // POST-failure path: tool round succeeds, resend fails with 400.
    let n = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }] } }],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 400, text: async () => "boom" } as unknown as Response;
    });
    const h1 = baseHistory();
    await expect(
      runAgenticLoop(ENDPOINT, "k", "m", h1, { execute: async () => "tool-result", sleep: async () => {} })
    ).rejects.toThrow("Zen HTTP 400");
    // Nothing rolled back inside the loop: assistant(tool_calls) + tool stay.
    expect(h1.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);

    // Same through the shared core directly.
    let m = 0;
    globalThis.fetch = vi.fn(async () => {
      m += 1;
      if (m === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }] } }],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 400, text: async () => "boom" } as unknown as Response;
    });
    const h2 = baseHistory();
    await expect(
      runLoopWithChat((h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep }), h2, {
        execute: async () => "tool-result",
        sleep: async () => {},
      })
    ).rejects.toThrow("Zen HTTP 400");
    expect(h2.map((mm) => mm.role)).toEqual(["system", "user", "assistant", "tool"]);

    // Tool errors are results, not throws — identical on both paths.
    mockChatScript([
      { content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "read", arguments: "not-json{{{" } }] },
      { content: "noted" },
    ]);
    const h3 = baseHistory();
    const r1 = await runAgenticLoop(ENDPOINT, "k", "m", h3, { sleep: async () => {} });
    expect(r1).toBe("noted");
    expect(h3.some((x) => x.role === "tool" && String((x as { content: string }).content).startsWith("Error:"))).toBe(true);

    mockChatScript([
      { content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "read", arguments: "not-json{{{" } }] },
      { content: "noted" },
    ]);
    const h4 = baseHistory();
    const r2 = await runLoopWithChat((h, o) => chatCompletion(ENDPOINT, "k", "m", h, { sleep: o?.sleep }), h4, {
      sleep: async () => {},
    });
    expect(r2).toBe(r1);
    expect(h4).toEqual(h3);
  });
});

describe("provider-labeled openai-chat errors", () => {
  test("chatCompletion defaults to Zen HTTP (existing contract)", async () => {
    const count = mockHttp401();
    await expect(chatCompletion(ENDPOINT, "k", "m", baseHistory(), { sleep: async () => {} })).rejects.toThrow(
      "Zen HTTP 401"
    );
    expect(count()).toBe(1);
  });

  test("chatCompletion explicit label overrides the prefix", async () => {
    mockHttp401();
    await expect(
      chatCompletion(ENDPOINT, "k", "m", baseHistory(), { sleep: async () => {} }, "OpenAI")
    ).rejects.toThrow("OpenAI HTTP 401");
  });

  test("dispatcher labels per openai-chat provider", async () => {
    const cases = [
      { provider: "opencode-zen", label: "Zen", extra: {} },
      { provider: "openai", label: "OpenAI", extra: {} },
      { provider: "deepseek", label: "DeepSeek", extra: {} },
      { provider: "mistral", label: "Mistral", extra: {} },
      { provider: "openai-compatible", label: "Provider", extra: { baseURL: "https://x.example/v1" } },
    ] as const;
    for (const { provider, label, extra } of cases) {
      const count = mockHttp401();
      await expect(
        chatCompletionForProvider(provider, "k", "m", baseHistory(), { sleep: async () => {}, ...extra })
      ).rejects.toThrow(`${label} HTTP 401`);
      expect(count()).toBe(1);
    }
  });
});
