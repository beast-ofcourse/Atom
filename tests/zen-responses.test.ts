// Zen Responses-family transport (muse-spark-*, incl. the free
// contributor tiers). Wire shapes verified live 2026-09-12 against
// POST https://opencode.ai/zen/v1/responses. Fully mocked — never hits
// the real API.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildResponsesBody,
  isResponsesEffortRejection,
  parseResponsesObject,
  readResponsesSSEMessage,
} from "../src/adapters.js";
import {
  chatCompletionForProvider,
  fetchModelsForProvider,
  isZenResponsesModel,
  responsesEffortParam,
  responsesEndpointFor,
  type ChatMessage,
} from "../src/zen.js";
import {
  clearProviderHooks,
  registerBeforeRequest,
} from "../src/tools/provider-hooks.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  clearProviderHooks();
});

const noSleep = { sleep: async () => {} };

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
const sseEvent = (event: string, o: unknown) => `event: ${event}\ndata: ${JSON.stringify(o)}\n\n`;

function completedObject(overrides?: Record<string, unknown>) {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "mango", annotations: [] }],
      },
    ],
    usage: { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
    reasoning: { effort: "high" },
    ...(overrides ?? {}),
  };
}

describe("family routing", () => {
  test("muse-spark-* rides responses; everything else chat", () => {
    expect(isZenResponsesModel("muse-spark-1.2-contributor-free")).toBe(true);
    expect(isZenResponsesModel("muse-spark-1.3")).toBe(true);
    expect(isZenResponsesModel("big-pickle")).toBe(false);
    expect(isZenResponsesModel("deepseek-v4-flash-free")).toBe(false);
    expect(isZenResponsesModel("gpt-5-nano")).toBe(false);
  });

  test("responsesEndpointFor derives /responses from chat URLs", () => {
    expect(responsesEndpointFor("https://opencode.ai/zen/v1/chat/completions")).toBe(
      "https://opencode.ai/zen/v1/responses"
    );
    expect(responsesEndpointFor("https://opencode.ai/zen/v1/responses")).toBe(
      "https://opencode.ai/zen/v1/responses"
    );
    expect(responsesEndpointFor("https://example.test/weird")).toBe(
      "https://opencode.ai/zen/v1/responses"
    );
  });

  test("responsesEffortParam maps the knob (max rides high)", () => {
    expect(responsesEffortParam(undefined)).toBeUndefined();
    expect(responsesEffortParam("auto")).toBeUndefined();
    expect(responsesEffortParam("low")).toBe("low");
    expect(responsesEffortParam("medium")).toBe("medium");
    expect(responsesEffortParam("high")).toBe("high");
    expect(responsesEffortParam("max")).toBe("high");
    expect(isResponsesEffortRejection("reasoning is not supported")).toBe(true);
    expect(isResponsesEffortRejection("invalid image input")).toBe(false);
  });
});

describe("buildResponsesBody", () => {
  const history = (): ChatMessage[] => [
    { role: "system", content: "sys-one" },
    { role: "system", content: "sys-two" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "doing",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "file-bytes" },
    { role: "user", content: "again" },
  ];

  test("system joins to instructions; tool roundtrip maps to function_call items", () => {
    const body = buildResponsesBody(history(), "muse-spark-1.2-contributor-free");
    expect(body.model).toBe("muse-spark-1.2-contributor-free");
    expect(body.instructions).toBe("sys-one\n\nsys-two");
    expect(body.input).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "doing" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: '{"path":"a"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "file-bytes" },
      { role: "user", content: "again" },
    ]);
    expect(body.tools![0]).toMatchObject({ type: "function", name: "read" });
  });

  test("includeTools:false omits the tools key entirely", () => {
    const body = buildResponsesBody(history(), "m", { includeTools: false });
    expect("tools" in body).toBe(false);
  });

  test("stripMedia turns descriptors into prose markers", () => {
    const h: ChatMessage[] = [{ role: "user", content: "see [media:k3xq9z image/png 41204B]" }];
    const body = buildResponsesBody(h, "m", { stripMedia: true });
    expect(JSON.stringify(body.input)).toContain("[image omitted: image/png]");
  });
});

describe("parseResponsesObject", () => {
  test("text + usage + reasoning label", () => {
    const r = parseResponsesObject(completedObject());
    expect(r.content).toBe("mango");
    expect(r.tool_calls).toBeUndefined();
    expect(r.usage).toEqual({ prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 });
    expect(r.reasoning).toBe("high");
  });

  test("function_call items become tool calls (call_id wins)", () => {
    const r = parseResponsesObject(
      completedObject({
        output: [
          {
            id: "fc_1",
            type: "function_call",
            status: "completed",
            name: "ping_tool",
            call_id: "call_9",
            arguments: '{"x":"hello"}',
          },
        ],
      })
    );
    expect(r.content).toBeNull();
    expect(r.tool_calls).toEqual([
      { id: "call_9", type: "function", function: { name: "ping_tool", arguments: '{"x":"hello"}' } },
    ]);
  });

  test("incomplete status flags truncated; empty output throws", () => {
    const r = parseResponsesObject(completedObject({ status: "incomplete" }));
    expect(r.truncated).toBe(true);
    expect(() => parseResponsesObject({ output: [] })).toThrow("Empty reply");
  });

  test("nameless function_call dropped with the turn surviving on text", () => {
    const r = parseResponsesObject(
      completedObject({
        output: [
          { id: "fc_x", type: "function_call", call_id: "call_x", arguments: "{}" },
          {
            id: "msg_2",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
      })
    );
    expect(r.content).toBe("done");
    expect(r.tool_calls).toBeUndefined();
  });
});

describe("readResponsesSSEMessage", () => {
  test("live event shape: deltas stream, completed object decides", async () => {
    const chunks = [
      sseEvent("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: "man" }),
      sseEvent("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: "go" }),
      sseEvent("response.completed", { type: "response.completed", response: completedObject() }),
      sseEvent("ping", { type: "ping", cost: "0" }),
    ];
    const tokens: string[] = [];
    const phases: string[] = [];
    const r = await readResponsesSSEMessage(sseResponse(chunks), {
      onToken: (t) => tokens.push(t),
      onPhase: (p) => phases.push(p),
    });
    expect(r.content).toBe("mango");
    expect(tokens.at(-1)).toBe("mango");
    expect(phases).toContain("streaming");
    expect(r.usage).toMatchObject({ prompt_tokens: 15 });
  });

  test("function_call streams name live, args come from the completed object", async () => {
    const chunks = [
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_9", name: "ping_tool", arguments: "" },
      }),
      sseEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"x":"hel',
      }),
      sseEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: 'lo"}',
      }),
      sseEvent("response.completed", {
        type: "response.completed",
        response: completedObject({
          output: [
            {
              id: "fc_1",
              type: "function_call",
              status: "completed",
              name: "ping_tool",
              call_id: "call_9",
              arguments: '{"x":"hello"}',
            },
          ],
        }),
      }),
    ];
    const seen: Array<[string, number]> = [];
    const r = await readResponsesSSEMessage(sseResponse(chunks), {
      onToolDelta: (name, i) => seen.push([name, i]),
    });
    expect(seen).toEqual([["ping_tool", 0]]);
    expect(r.tool_calls![0]).toMatchObject({
      function: { name: "ping_tool", arguments: '{"x":"hello"}' },
    });
  });

  test("failed terminal event throws; EOF without completed throws", async () => {
    await expect(
      readResponsesSSEMessage(
        sseResponse([
          sseEvent("response.failed", {
            type: "response.failed",
            response: { error: { message: "boom-upstream" } },
          }),
        ])
      )
    ).rejects.toThrow("boom-upstream");
    await expect(
      readResponsesSSEMessage(
        sseResponse([
          sseEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: 0,
            delta: "half",
          }),
        ])
      )
    ).rejects.toThrow("Truncated stream");
  });

  test("non-SSE JSON body parses as a response object", async () => {
    const enc = new TextEncoder();
    const json = JSON.stringify(completedObject());
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(json));
        c.close();
      },
    });
    const r = await readResponsesSSEMessage(
      new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } })
    );
    expect(r.content).toBe("mango");
  });
});

describe("dispatcher + transport", () => {  function history(): ChatMessage[] {
    return [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
  }

  test("zen muse-spark POSTs input-shaped body to /responses with identity headers", async () => {
    let url = "";
    let headers: unknown;
    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (u: unknown, init?: RequestInit) => {
      url = String(u);
      headers = (init as { headers?: unknown })?.headers;
      body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
      return sseResponse([
        sseEvent("response.completed", { type: "response.completed", response: completedObject() }),
      ]);
    });
    const r = await chatCompletionForProvider(
      "opencode-zen",
      "z-key",
      "muse-spark-1.2-contributor-free",
      history(),
      noSleep
    );
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
    expect(body["model"]).toBe("muse-spark-1.2-contributor-free");
    expect(body["stream"]).toBe(true);
    expect(Array.isArray(body["input"])).toBe(true);
    expect("messages" in body).toBe(false);
    expect(headers).toMatchObject({
      Authorization: "Bearer z-key",
      "User-Agent": "opencode/1.18.16",
    });
    expect((headers as Record<string, string>)["x-opencode-session"]).toMatch(/^ses_/);
    expect(r.content).toBe("mango");
  });

  test("zen chat models stay on /chat/completions; non-zen untouched", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: unknown) => {
      urls.push(String(u));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "z" } }] }) } as Response;
    });
    await chatCompletionForProvider("opencode-zen", "k", "big-pickle", history(), noSleep);
    expect(urls[0]).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  test("anonymous responses POST sends identity with no Authorization", async () => {
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return sseResponse([
        sseEvent("response.completed", { type: "response.completed", response: completedObject() }),
      ]);
    });
    await chatCompletionForProvider("opencode-zen", "", "muse-spark-1.3-contributor-free", history(), noSleep);
    expect(JSON.stringify(headers)).not.toContain("Bearer");
    expect((headers as Record<string, string>)["x-opencode-session"]).toMatch(/^ses_/);
  });

  test("400 naming reasoning retries once without it (warning fired)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    let n = 0;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      n++;
      if (n === 1) {
        return { ok: false, status: 400, text: async () => "reasoning is not supported" } as Response;
      }
      return sseResponse([
        sseEvent("response.completed", { type: "response.completed", response: completedObject() }),
      ]);
    });
    const r = await chatCompletionForProvider("opencode-zen", "k", "muse-spark-1.2", history(), {
      ...noSleep,
      reasoningEffort: "high",
      onWarning: (m) => warnings.push(m),
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ reasoning: { effort: "high" } });
    expect("reasoning" in bodies[1]!).toBe(false);
    expect(warnings.join(" ")).toContain("reasoning effort");
    expect(r.content).toBe("mango");
  });

  test("before-request hook sees the responses URL and can edit headers", async () => {
    const seen: string[] = [];
    registerBeforeRequest(({ url }) => {
      seen.push(String(url));
      return { headers: { "x-probe": "1" } };
    }, "probe");
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const headers = (init as { headers?: unknown })?.headers as Record<string, string>;
      expect(headers["x-probe"]).toBe("1");
      return sseResponse([
        sseEvent("response.completed", { type: "response.completed", response: completedObject() }),
      ]);
    });
    await chatCompletionForProvider("opencode-zen", "k", "muse-spark-1.2", history(), noSleep);
    expect(seen[0]).toContain("/responses");
  });
});

describe("free-model listing", () => {
  test("live ids without metadata list when curated (incl. responses free tiers)", async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          // Live Zen shape: bare ids, no compatibility metadata.
          data: [
            { id: "muse-spark-1.3-contributor-free" },
            { id: "muse-spark-1.2-contributor-free" },
            { id: "deepseek-v4-flash-free" },
            { id: "mimo-v2.5-free" },
            { id: "claude-sonnet-4-5" },
          ],
        }),
      } as Response;
    });
    const models = await fetchModelsForProvider("opencode-zen", "k");
    expect(models).toContain("muse-spark-1.3-contributor-free");
    expect(models).toContain("muse-spark-1.2-contributor-free");
    expect(models).toContain("deepseek-v4-flash-free");
    expect(models).toContain("mimo-v2.5-free");
    // Uncurated, unservable families stay out.
    expect(models).not.toContain("claude-sonnet-4-5");
  });
});
