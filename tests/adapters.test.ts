// Adapter translation + SSE + dispatcher tests (mocked fetch only).
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildAnthropicBody,
  buildGeminiBody,
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
  test("zen byte-identical: stream flag + tools, no reasoning by default; supported sends it", async () => {
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
    await chatCompletionForProvider("opencode-zen", "test-key", "kimi-k2.5", history(), {
      reasoningEffort: "max",
      sleep: async () => {},
    });
    expect(seen[1]?.["reasoning_effort"]).toBe("max");
  });

  test("non-zen never gets reasoning_effort (even when supported-model name reused)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "o" } }] }) } as Response;
    });
    await chatCompletionForProvider("openai", "test-key", "kimi-k2.5", history(), {
      reasoningEffort: "max",
      sleep: async () => {},
    });
    expect("reasoning_effort" in (seen[0] ?? {})).toBe(false);
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
