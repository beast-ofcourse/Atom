// Adapter translation + SSE + dispatcher tests (mocked fetch only).
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  anthropicThinkingFor,
  buildAnthropicBody,
  buildGeminiBody,
  geminiThinkingLevelFor,
  isEffortRejection,
  parseAnthropicJson,
  parseGeminiJson,
  parseAnthropicModelsList,
  parseGeminiModelsList,
  parseOpenAIModelsList,
  readAnthropicSSEMessage,
  readGeminiSSEMessage,
  validateProviderKey,
} from "../src/adapters.js";
import {
  chatCompletionForProvider,
  fetchModelsForProvider,
  type ChatMessage,
} from "../src/zen.js";
import { getProvider } from "../src/providers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
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
});

function historyWithTools(): ChatMessage[] {
  return [
    { role: "system", content: "sys-one" },
    { role: "system", content: "sys-two" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "doing",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "file-bytes" },
  ];
}

describe("request bodies", () => {
  test("anthropic: system joined, assistant tool_calls to tool_use, tool to tool_result, tools converted", () => {
    const body = buildAnthropicBody(historyWithTools(), "claude-sonnet-4-5");
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toBe("sys-one\n\nsys-two");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.tools![0]).toMatchObject({ name: "read" });
    expect((body.tools![0] as { input_schema?: unknown }).input_schema).toBeDefined();
    const assistant = body.messages.find((m) => m.role === "assistant") as {
      content: Array<Record<string, unknown>>;
    };
    expect(assistant.content.some((b) => b["type"] === "text" && b["text"] === "doing")).toBe(true);
    expect(
      assistant.content.some(
        (b) => b["type"] === "tool_use" && b["id"] === "call_1" && b["name"] === "read"
      )
    ).toBe(true);
    const toolMsg = body.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content)
    ) as { content: Array<Record<string, unknown>> };
    const result = toolMsg.content.find((b) => b["type"] === "tool_result") as Record<string, unknown>;
    expect(result["tool_use_id"]).toBe("call_1");
  });

  test("gemini: system_instruction, user/model roles, functionCall/Response, declarations", () => {
    const body = buildGeminiBody(historyWithTools(), "gemini-2.5-flash");
    expect(body.system_instruction).toEqual({ parts: [{ text: "sys-one\n\nsys-two" }] });
    expect(body.tools![0]?.functionDeclarations[0]).toMatchObject({ name: "read" });
    const modelMsg = body.contents.find((c) => c.role === "model");
    expect(
      (modelMsg?.parts as Array<Record<string, unknown>>).some(
        (p) => (p["functionCall"] as Record<string, unknown>)?.["name"] === "read"
      )
    ).toBe(true);
    const resp = body.contents.find(
      (c) =>
        c.role === "user" &&
        (c.parts as Array<Record<string, unknown>>).some((p) => p["functionResponse"] !== undefined)
    );
    const part = (resp?.parts as Array<Record<string, unknown>>).find(
      (p) => p["functionResponse"] !== undefined
    ) as Record<string, { name: string; response: { result: string } }>;
    expect(part.functionResponse.name).toBe("read");
    expect(part.functionResponse.response.result).toBe("file-bytes");
  });
});

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe("anthropic SSE", () => {
  test("multi-chunk input_json accumulates, text streams, usage maps, tool_use normalizes", async () => {
    const body =
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read"}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    // Split mid-JSON across transport chunks (line buffering).
    const res = sseResponse([body.slice(0, 200), body.slice(200)]);
    const tokens: string[] = [];
    const msg = await readAnthropicSSEMessage(res, { onToken: (t) => tokens.push(t) });
    expect(msg.content).toBe("hello");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0]).toMatchObject({
      id: "toolu_1",
      function: { name: "read", arguments: '{"path":"a.txt"}' },
    });
    expect(tokens.at(-1)).toBe("hello");
    expect(msg.usage).toMatchObject({ prompt_tokens: 4 });
  });

  test("message_start cache folds into prompt_tokens (real input-side total)", async () => {
    // input_tokens excludes cache_read/_creation; the stable prefix rides as
    // cache, so load/spend must see input + cache, not input alone.
    const body =
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":9000,"cache_creation_input_tokens":500}}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const msg = await readAnthropicSSEMessage(sseResponse([body]));
    expect(msg.usage).toMatchObject({
      prompt_tokens: 9600,
      completion_tokens: 6,
      total_tokens: 9606,
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
    });
  });

  test("nameless tool_use dropped with warning (parity)", async () => {
    const body =
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "final-hi" } }) +
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9" } }) +
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }) +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const warnings: string[] = [];
    const msg = await readAnthropicSSEMessage(sseResponse([body]), {
      onWarning: (m) => warnings.push(m),
    });
    expect(msg.content).toBe("final-hi");
    expect(msg.tool_calls).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("toolu_9");
  });

  test("non-streaming JSON parses (content + usage)", () => {
    const msg = parseAnthropicJson({
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "t1", name: "glob", input: { pattern: "*.ts" } },
      ],
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    expect(msg.content).toBe("done");
    expect(msg.tool_calls![0]!.function.arguments).toBe('{"pattern":"*.ts"}');
    expect(msg.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });
});

describe("gemini SSE", () => {
  test("text + functionCall accumulate, usageMetadata maps", async () => {
    const body =
      sse({ candidates: [{ content: { role: "model", parts: [{ text: "hi-" }] } }] }) +
      sse({
        candidates: [
          { content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.txt" } } }] } },
        ],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
      });
    const msg = await readGeminiSSEMessage(sseResponse([body]));
    expect(msg.content).toBe("hi-");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0]).toMatchObject({
      function: { name: "read", arguments: '{"path":"a.txt"}' },
    });
    expect(msg.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  });

  test("non-streaming :generateContent parses", () => {
    const msg = parseGeminiJson({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    });
    expect(msg.content).toBe("ok");
    expect(msg.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
});

describe("models lists", () => {
  test("non-zen openai-kind accepts all ids; anthropic/gemini parse; any failure falls back", () => {
    expect(parseOpenAIModelsList({ data: [{ id: "a" }, { id: "gpt-x" }] }, ["f"])).toEqual(["a", "gpt-x"]);
    expect(parseOpenAIModelsList({ nope: 1 }, ["f"])).toEqual(["f"]);
    expect(parseAnthropicModelsList({ data: [{ id: "c1" }] }, ["f"])).toEqual(["c1"]);
    expect(parseGeminiModelsList({ models: [{ name: "models/gemini-2.5-flash" }] }, ["f"])).toEqual([
      "gemini-2.5-flash",
    ]);
  });

  test("fetchModelsForProvider: live ok per kind, fallback on failure", async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("api.openai.com")) return { ok: true, json: async () => ({ data: [{ id: "gpt-x" }] }) } as Response;
      if (u.includes("anthropic")) return { ok: true, json: async () => ({ data: [{ id: "c-live" }] }) } as Response;
      if (u.includes("googleapis")) return { ok: true, json: async () => ({ models: [{ name: "models/g-live" }] }) } as Response;
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });
    await expect(fetchModelsForProvider("openai", "test-key")).resolves.toEqual(["gpt-x"]);
    await expect(fetchModelsForProvider("anthropic", "test-key")).resolves.toEqual(["c-live"]);
    await expect(fetchModelsForProvider("google-gemini", "test-key")).resolves.toEqual(["g-live"]);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchModelsForProvider("mistral", "test-key")).resolves.toEqual(
      getProvider("mistral")!.fallbackModels
    );
  });
});

describe("dispatcher (mocked)", () => {
  function history(): ChatMessage[] {
    return [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
  }
  test("zen: stream flag + tools, auto omits effort; any model sends it", async () => {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "z" } }] }) } as Response;
    });
    const msg = await chatCompletionForProvider("opencode-zen", "test-key", "big-pickle", history(), {
      sleep: async () => {},
    });
    expect(msg.content).toBe("z");
    expect(seen[0]?.["stream"]).toBe(true);
    expect("reasoning_effort" in (seen[0] ?? {})).toBe(false);
    await chatCompletionForProvider("opencode-zen", "test-key", "big-pickle", history(), {
      reasoningEffort: "max",
      sleep: async () => {},
    });
    expect(seen[1]?.["reasoning_effort"]).toBe("max");
  });

  test("every openai-chat provider sends reasoning_effort (no zen-only gating)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "o" } }] }) } as Response;
    });
    for (const provider of ["openai", "deepseek", "mistral", "kilo"] as const) {
      await chatCompletionForProvider(provider, "test-key", "any-model", history(), {
        reasoningEffort: "high",
        sleep: async () => {},
      });
    }
    expect(seen).toHaveLength(4);
    for (const body of seen) expect(body["reasoning_effort"]).toBe("high");
    // …and auto still omits it everywhere.
    await chatCompletionForProvider("openai", "test-key", "any-model", history(), {
      reasoningEffort: "auto",
      sleep: async () => {},
    });
    expect("reasoning_effort" in (seen[4] ?? {})).toBe(false);
  });

  test("anthropic maps effort to a thinking budget; gemini to a thinking level", async () => {
    const seenAnthropic: Array<Record<string, unknown>> = [];
    const seenGemini: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (rawUrl: unknown, init?: RequestInit) => {
      const u = String(rawUrl);
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
      if (u.includes("anthropic")) {
        seenAnthropic.push(body);
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "a" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        } as Response;
      }
      seenGemini.push(body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "g" }] } }],
        }),
      } as Response;
    });
    await chatCompletionForProvider("anthropic", "test-key", "claude-sonnet-4-5", history(), {
      reasoningEffort: "medium",
      sleep: async () => {},
    });
    expect(seenAnthropic[0]?.["thinking"]).toEqual({ type: "enabled", budget_tokens: 2048 });
    await chatCompletionForProvider("anthropic", "test-key", "claude-sonnet-4-5", history(), {
      reasoningEffort: "auto",
      sleep: async () => {},
    });
    expect("thinking" in (seenAnthropic[1] ?? {})).toBe(false);
    await chatCompletionForProvider("google-gemini", "test-key", "gemini-2.5-flash", history(), {
      reasoningEffort: "max",
      sleep: async () => {},
    });
    expect(
      (seenGemini[0]?.["generationConfig"] as Record<string, unknown>)?.["thinkingConfig"]
    ).toEqual({ thinkingLevel: "high" });
    await chatCompletionForProvider("google-gemini", "test-key", "gemini-2.5-flash", history(), {
      reasoningEffort: "auto",
      sleep: async () => {},
    });
    expect("generationConfig" in (seenGemini[1] ?? {})).toBe(false);
  });

  test("400 naming the knob retries once without it (openai-chat + anthropic + gemini)", async () => {
    const warnings: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const rejected = new Set<string>();
    globalThis.fetch = vi.fn(async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      const isAnthropic = url.includes("anthropic");
      const isGemini = url.includes("googleapis");
      if (!rejected.has(url)) {
        rejected.add(url);
        const text = isAnthropic
          ? "thinking: budget_tokens must be enabled per model"
          : isGemini
            ? "thinking_level unsupported for this model"
            : "Invalid reasoning_effort for this model";
        return { ok: false, status: 400, text: async () => text } as Response;
      }
      if (isAnthropic) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "a-ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        } as Response;
      }
      if (isGemini) {
        return {
          ok: true,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "g-ok" }] } }] }),
        } as Response;
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "z-ok" } }] }) } as Response;
    });
    const warnOpts = { onWarning: (m: string) => warnings.push(m), sleep: async () => {} };
    const z = await chatCompletionForProvider("opencode-zen", "test-key", "m", history(), {
      ...warnOpts,
      reasoningEffort: "low",
    });
    expect(z.content).toBe("z-ok");
    expect(seen[0]?.["reasoning_effort"]).toBe("low");
    expect("reasoning_effort" in (seen[1] ?? {})).toBe(false);
    const a = await chatCompletionForProvider("anthropic", "test-key", "m", history(), {
      ...warnOpts,
      reasoningEffort: "low",
    });
    expect(a.content).toBe("a-ok");
    expect(seen[2]).toMatchObject({ thinking: { type: "enabled" } });
    expect("thinking" in (seen[3] ?? {})).toBe(false);
    const g = await chatCompletionForProvider("google-gemini", "test-key", "m", history(), {
      ...warnOpts,
      reasoningEffort: "low",
    });
    expect(g.content).toBe("g-ok");
    expect(
      ((seen[4]?.["generationConfig"] ?? {}) as Record<string, unknown>)["thinkingConfig"]
    ).toEqual({ thinkingLevel: "low" });
    expect("generationConfig" in (seen[5] ?? {})).toBe(false);
    expect(warnings).toHaveLength(3);
    for (const w of warnings) expect(w).toContain("is not supported by");
  });

  test("anthropic + gemini normalize through JSON fallback (tools + usage)", async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("anthropic")) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "a-hi" }],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: "model", parts: [{ text: "g-hi" }] } }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
        }),
      } as Response;
    });
    const a = await chatCompletionForProvider("anthropic", "test-key", "claude-sonnet-4-5", history(), {
      sleep: async () => {},
    });
    expect(a).toMatchObject({ content: "a-hi", usage: { prompt_tokens: 2 } });
    const g = await chatCompletionForProvider("google-gemini", "test-key", "gemini-2.5-flash", history(), {
      sleep: async () => {},
    });
    expect(g).toMatchObject({ content: "g-hi", usage: { total_tokens: 5 } });
  });

  test("effort mapping helpers are pure and narrow", () => {
    // Anthropic budgets under a normal cap.
    expect(anthropicThinkingFor("low", 4096)).toBe(1024);
    expect(anthropicThinkingFor("medium", 4096)).toBe(2048);
    expect(anthropicThinkingFor("high", 4096)).toBe(3072);
    expect(anthropicThinkingFor("max", 4096)).toBe(3500);
    // Auto/unknown omits.
    expect(anthropicThinkingFor("auto", 4096)).toBeUndefined();
    expect(anthropicThinkingFor(undefined, 4096)).toBeUndefined();
    expect(anthropicThinkingFor("bogus", 4096)).toBeUndefined();
    // A cap too small for the want shrinks to cap - 1 (never 400s)…
    expect(anthropicThinkingFor("medium", 2000)).toBe(1999);
    expect(anthropicThinkingFor("low", 1025)).toBe(1024);
    // …and a cap too small for the 1024 minimum omits the knob.
    expect(anthropicThinkingFor("low", 1024)).toBeUndefined();
    expect(anthropicThinkingFor("high", 100)).toBeUndefined();
    // Gemini levels; Max rides high, the deepest level the API offers.
    expect(geminiThinkingLevelFor("low")).toBe("low");
    expect(geminiThinkingLevelFor("medium")).toBe("medium");
    expect(geminiThinkingLevelFor("high")).toBe("high");
    expect(geminiThinkingLevelFor("max")).toBe("high");
    expect(geminiThinkingLevelFor("auto")).toBeUndefined();
    expect(geminiThinkingLevelFor(undefined)).toBeUndefined();
    expect(geminiThinkingLevelFor("bogus")).toBeUndefined();
    // Rejection detection is knob-names only — unrelated 400s stay loud.
    expect(isEffortRejection("Invalid reasoning_effort for this model")).toBe(true);
    expect(isEffortRejection("thinking: budget_tokens must be < max_tokens")).toBe(true);
    expect(isEffortRejection("thinking_level unsupported")).toBe(true);
    expect(isEffortRejection("reasoning effort not supported")).toBe(true);
    expect(isEffortRejection("invalid tool schema: missing properties")).toBe(false);
    expect(isEffortRejection("rate limit exceeded")).toBe(false);
    expect(isEffortRejection("")).toBe(false);
  });

  test("validateProviderKey per kind (ok + 401 stays)", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    await expect(validateProviderKey("openai", "test-key")).resolves.toMatchObject({ ok: true });
    await expect(validateProviderKey("anthropic", "test-key")).resolves.toMatchObject({ ok: true });
    await expect(validateProviderKey("google-gemini", "test-key")).resolves.toMatchObject({ ok: true });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const bad = await validateProviderKey("anthropic", "test-key");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("401");
  });
});
