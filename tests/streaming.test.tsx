// Streaming + retry tests. Network is ALWAYS mocked — never hit live Zen
// (the free tier is 429-limited). SSE bodies use REAL `new Response(...)`
// with genuine web streams so the parser is exercised for real.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  chatCompletion,
  runAgenticLoop,
  type ChatMessage,
  type Phase,
} from "../src/zen.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
const SSE_DONE = "data: [DONE]\n\n";

function contentChunk(content: string): string {
  return sseData({ choices: [{ delta: { content } }] });
}

function thinkingChunk(reasoning: string): string {
  return sseData({ choices: [{ delta: { reasoning_content: reasoning } }] });
}

function toolChunk(index: number, id: string | undefined, name: string | undefined, args: string): string {
  const fn: Record<string, string> = {};
  if (name !== undefined) fn["name"] = name;
  // Always send arguments (may be a fragment) to exercise concatenation.
  fn["arguments"] = args;
  const entry: Record<string, unknown> = { index, function: fn };
  if (id !== undefined) entry["id"] = id;
  entry["type"] = "function";
  return sseData({ choices: [{ delta: { tool_calls: [entry] } }] });
}

// Real Response with a genuine web ReadableStream yielding exactly these
// string chunks (lets tests split SSE lines across chunk boundaries).
function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// Same but with a delay between chunks so the TUI can render intermediate
// draft frames before the final chunk arrives.
function delayedStreamResponse(chunks: string[], gapMs: number): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
        await new Promise((r) => setTimeout(r, gapMs));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function mockFetchSequence(responses: Array<Response | { ok: false; status: number; text: string; retryAfter?: string }>, captured?: unknown[]) {
  let i = 0;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (captured) {
      try {
        captured.push(JSON.parse(String((init as unknown as { body?: unknown })?.body ?? "{}")));
      } catch {
        captured.push({});
      }
    }
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Response) return next;
    const headers =
      next.retryAfter !== undefined
        ? { get: (k: string) => (k.toLowerCase() === "retry-after" ? next.retryAfter! : null) }
        : undefined;
    return { ok: false, status: next.status, text: async () => next.text, headers } as unknown as Response;
  });
  return () => i;
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

describe("SSE parser", () => {
  test("splits lines across chunk boundaries and stops at [DONE]", async () => {
    // First SSE line is split mid-JSON across two stream chunks.
    const part1 = `data: {"choices":[{"delta":{"content":"hel`;
    const part2 = `lo"}}]}\n\n${contentChunk(" world")}${SSE_DONE}data: {"choices":[{"delta":{"content":"IGNORED"}}]}\n\n`;
    const captured: unknown[] = [];
    mockFetchSequence([streamResponse([part1, part2])], captured);
    const history: ChatMessage[] = [{ role: "system", content: "s" }];
    history.push({ role: "user", content: "hi" });
    const tokens: string[] = [];
    const msg = await chatCompletion(ENDPOINT, "k", "m", history, {
      onToken: (t) => tokens.push(t),
      sleep: async () => {},
    });
    expect(msg.content).toBe("hello world");
    expect(msg.tool_calls).toBeUndefined();
    // Live tokens accumulate.
    expect(tokens.at(-1)).toBe("hello world");
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    // Streaming POST flag is sent.
    expect((captured[0] as { stream?: unknown }).stream).toBe(true);
  });

  test("ignores :comment lines and skips malformed JSON data lines", async () => {
    const sse =
      `: keep-alive comment\n\n` +
      `data: not-json-at-all\n\n` +
      `: another comment\n` +
      `${contentChunk("ok")}` +
      `data: {"broken": \n\n` +
      SSE_DONE;
    mockFetchSequence([streamResponse([sse])]);
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    const msg = await chatCompletion(ENDPOINT, "k", "m", history, { sleep: async () => {} });
    expect(msg.content).toBe("ok");
  });

  test("accumulates tool_call deltas by index (id first-wins, name/args concat)", async () => {
    const sse =
      toolChunk(0, "call_1", "re", "") +
      toolChunk(0, undefined, "ad", '{"path":') +
      toolChunk(0, undefined, undefined, '"a.txt"}') +
      SSE_DONE;
    mockFetchSequence([streamResponse([sse])]);
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "read it" },
    ];
    const phases: Array<{ p: Phase; d?: string }> = [];
    const deltas: string[] = [];
    const msg = await chatCompletion(ENDPOINT, "k", "m", history, {
      onPhase: (p, d) => phases.push({ p, d }),
      onToolDelta: (n) => deltas.push(n),
      sleep: async () => {},
    });
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0]!.id).toBe("call_1");
    expect(msg.tool_calls![0]!.function.name).toBe("read");
    expect(msg.tool_calls![0]!.function.arguments).toBe('{"path":"a.txt"}');
    // Live tool hint fired as fragments arrived ("re" -> "read").
    expect(deltas).toEqual(["re", "read"]);
    expect(phases.some((x) => x.p === "tool" && x.d === "read")).toBe(true);
  });

  test("supports new Response(sseString) single-string bodies", async () => {
    const sseString = `${contentChunk("single-string-ok")}${SSE_DONE}`;
    globalThis.fetch = vi.fn(async () => new Response(sseString));
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    const msg = await chatCompletion(ENDPOINT, "k", "m", history, { sleep: async () => {} });
    expect(msg.content).toBe("single-string-ok");
  });

  test("nameless partial tool calls are dropped with warning, never in history", async () => {
    const sse = contentChunk("final-hi") + toolChunk(0, "call_9", undefined, "{}") + SSE_DONE;
    mockFetchSequence([streamResponse([sse])]);
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    const warnings: string[] = [];
    let executed = 0;
    const reply = await runAgenticLoop(ENDPOINT, "k", "m", history, {
      execute: async () => {
        executed += 1;
        return "should-not-run";
      },
      onWarning: (m) => warnings.push(m),
      sleep: async () => {},
    });
    expect(reply).toBe("final-hi");
    expect(executed).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("call_9");
    // History keeps pairing valid: no assistant tool_calls, no stray tool msgs.
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "final-hi" });
  });
});

describe("thinking channel", () => {
  test("reasoning_content streams to onThinking, never into content", async () => {
    mockFetchSequence([
      streamResponse([thinkingChunk("let me "), thinkingChunk("think"), contentChunk("he"), contentChunk("llo"), SSE_DONE]),
    ]);
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    const thoughts: string[] = [];
    const tokens: string[] = [];
    const msg = await chatCompletion(ENDPOINT, "k", "m", history, {
      onThinking: (t) => thoughts.push(t),
      onToken: (t) => tokens.push(t),
      sleep: async () => {},
    });
    expect(thoughts).toEqual(["let me ", "let me think"]);
    expect(tokens.at(-1)).toBe("hello");
    expect(tokens.every((t) => !t.includes("think"))).toBe(true);
    expect(msg.content).toBe("hello");
  });

  test("no thinking deltas means onThinking never fires", async () => {
    mockFetchSequence([streamResponse([contentChunk("plain"), SSE_DONE])]);
    let fired = 0;
    const msg = await chatCompletion(
      ENDPOINT,
      "k",
      "m",
      [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ],
      {
        onThinking: () => {
          fired += 1;
        },
        sleep: async () => {},
      }
    );
    expect(fired).toBe(0);
    expect(msg.content).toBe("plain");
  });

  test("onThinking flows through the full agentic loop, not just chatCompletion", async () => {
    mockFetchSequence([
      streamResponse([thinkingChunk("plan forming"), contentChunk("answer"), SSE_DONE]),
    ]);
    const thoughts: string[] = [];
    const reply = await runAgenticLoop(ENDPOINT, "k", "m", [{ role: "user", content: "hi" }], {
      onThinking: (t) => thoughts.push(t),
      sleep: async () => {},
    });
    expect(reply).toBe("answer");
    expect(thoughts).toEqual(["plan forming"]);
  });

  test("non-streaming bodies with reasoning_content fire onThinking once", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "done", reasoning_content: "thought it over" } }],
          }),
        }) as unknown as Response
    );
    const thoughts: string[] = [];
    const msg = await chatCompletion(
      ENDPOINT,
      "k",
      "m",
      [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ],
      { onThinking: (t) => thoughts.push(t), sleep: async () => {} }
    );
    expect(thoughts).toEqual(["thought it over"]);
    expect(msg.content).toBe("done");
  });

  test("thinking renders in its own block above the streaming draft", async () => {
    // Lazy construction: ReadableStream.start() runs (and its gaps elapse)
    // at construction, so build the stream when fetch fires — otherwise the
    // thinking window closes before the turn even starts.
    globalThis.fetch = vi.fn(
      async () =>
        delayedStreamResponse(
          [thinkingChunk("considering options"), contentChunk("final answer"), SSE_DONE],
          150
        )
    );
    const app = render(<App {...baseProps()} />);
    try {
      // Thinking renders only while the /thinking toggle is on (default off).
      app.stdin.write("/thinking");
      app.stdin.write("\r");
      await waitForFrame(app, "thinking shown");
      app.stdin.write("think then answer");
      app.stdin.write("\r");
      await waitForFrame(app, "considering options");
      // The thinking block carries its own marker — the answer draft never does.
      expect(app.lastFrame()).toContain("💭");
      await waitForFrame(app, "final answer");
      await waitForFrame(app, "esc stops");
    } finally {
      app.unmount();
    }
  });

  test("long thinking output stays as-is (head never cut off)", async () => {
    // Regression: the thinking block used to tail-window past ~1200 chars,
    // silently dropping the head mid-stream. It must render everything.
    const head = `HEADMARK-${"h".repeat(1500)}`;
    const tail = `TAILMARK-${"t".repeat(100)}`;
    globalThis.fetch = vi.fn(
      async () =>
        delayedStreamResponse(
          [thinkingChunk(head), thinkingChunk(tail), contentChunk("final answer"), SSE_DONE],
          150
        )
    );
    const app = render(<App {...baseProps()} />);
    try {
      // Thinking renders only while the /thinking toggle is on (default off).
      app.stdin.write("/thinking");
      app.stdin.write("\r");
      await waitForFrame(app, "thinking shown");
      app.stdin.write("think long then answer");
      app.stdin.write("\r");
      await waitForFrame(app, "TAILMARK-");
      // Head AND tail visible together — nothing was cleared.
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("HEADMARK-");
      expect(frame).toContain("TAILMARK-");
      await waitForFrame(app, "final answer");
    } finally {
      app.unmount();
    }
  });
});

describe("retry policy", () => {
  test("500 then success retries with 1s backoff and succeeds", async () => {
    const sleeps: number[] = [];
    const phases: Array<{ p: Phase; d?: string }> = [];
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "recovered" } }] }) } as unknown as Response;
    });
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    const msg = await chatCompletion(ENDPOINT, "k", "m", history, {
      onPhase: (p, d) => phases.push({ p, d }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(msg.content).toBe("recovered");
    expect(n).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(phases.some((x) => x.p === "retry")).toBe(true);
  });

  test("429 with Retry-After is honored (seconds), capped at 30s", async () => {
    // Case 1: Retry-After: 2 => 2000ms.
    {
      const sleeps: number[] = [];
      let n = 0;
      globalThis.fetch = vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return {
            ok: false,
            status: 429,
            text: async () => "slow down",
            headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "2" : null) },
          } as unknown as Response;
        }
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ok2" } }] }) } as unknown as Response;
      });
      const history: ChatMessage[] = [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ];
      const msg = await chatCompletion(ENDPOINT, "k", "m", history, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(msg.content).toBe("ok2");
      expect(sleeps).toEqual([2000]);
    }
    // Case 2: Retry-After: 120 => capped at 30000ms.
    {
      const sleeps: number[] = [];
      let n = 0;
      globalThis.fetch = vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return {
            ok: false,
            status: 503,
            text: async () => "busy",
            headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "120" : null) },
          } as unknown as Response;
        }
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ok3" } }] }) } as unknown as Response;
      });
      const history: ChatMessage[] = [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ];
      const msg = await chatCompletion(ENDPOINT, "k", "m", history, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(msg.content).toBe("ok3");
      expect(sleeps).toEqual([30000]);
    }
  });

  test("exponential backoff is 1s then 2s across two retries", async () => {
    const sleeps: number[] = [];
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n <= 2) return { ok: false, status: 502, text: async () => "bad gateway" } as unknown as Response;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "third-try" } }] }) } as unknown as Response;
    });
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    const msg = await chatCompletion(ENDPOINT, "k", "m", history, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(msg.content).toBe("third-try");
    expect(n).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  test("401 fails fast with a single attempt", async () => {
    const sleeps: number[] = [];
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return { ok: false, status: 401, text: async () => "unauthorized" } as unknown as Response;
    });
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    await expect(
      chatCompletion(ENDPOINT, "k", "m", history, { sleep: async (ms) => void sleeps.push(ms) })
    ).rejects.toThrow("Zen HTTP 401");
    expect(n).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("network throw is retried then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("fetch failed");
      return { ok: true, json: async () => ({ choices: [{ message: { content: "net-ok" } }] }) } as unknown as Response;
    });
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
    const msg = await chatCompletion(ENDPOINT, "k", "m", history, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(msg.content).toBe("net-ok");
    expect(n).toBe(2);
    expect(sleeps).toEqual([1000]);
  });
});

describe("streaming TUI", () => {
  test("tokens render live (draft updates) with final committed once", async () => {
    const first = contentChunk("Hello-STEAM-");
    const second = contentChunk("WORLD-DONE");
    globalThis.fetch = vi.fn(async () => delayedStreamResponse([first, `${second}${SSE_DONE}`], 80));
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      // Intermediate draft (first token) appears before the stream finishes.
      await waitForFrame(app, "Hello-STEAM-");
      // Status bar shows a live phase while busy.
      expect(app.lastFrame()).toMatch(/streaming|thinking|calling/);
      await waitForFrame(app, "WORLD-DONE");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Hello-STEAM-WORLD-DONE");
    } finally {
      app.unmount();
    }
  });

  test("tool-call deltas show a live activity line before execution completes", async () => {
    // The tool delta and [DONE] ride in separate chunks with a real delay
    // between them, so the live hint is observable (frame polls run every
    // 25ms) before execution completes. A single chunk carrying [DONE] lets
    // the whole turn finish in ~1ms on a warm worker and the transient hint
    // never flushes a frame.
    const toolSseHead = toolChunk(0, "call_1", "read", '{"path":"src/zen.ts"}');
    const finalSse = `${contentChunk("grounded-final-XYZ")}${SSE_DONE}`;
    let n = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      void init;
      if (n === 1) return delayedStreamResponse([toolSseHead, SSE_DONE], 80);
      return delayedStreamResponse([finalSse], 20);
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("what does zen do");
      app.stdin.write("\r");
      // Live activity line from the streamed tool delta, before the tool result line.
      // (Bare tool name at this point — the target lands with the commit.)
      await waitForFrame(app, "Reading");
      await waitForFrame(app, "⚙ read src/zen.ts");
      await waitForFrame(app, "grounded-final-XYZ");
    } finally {
      app.unmount();
    }
  });

  test("retry emits a dim status line and then succeeds (Retry-After: 0 = instant)", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: false,
          status: 500,
          text: async () => "boom-transient",
          headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "0" : null) },
        } as unknown as Response;
      }
      return streamResponse([`${contentChunk("retry-success-QQ")}${SSE_DONE}`]);
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "retrying");
      await waitForFrame(app, "retry-success-QQ");
      expect(n).toBe(2);
    } finally {
      app.unmount();
    }
  });

  test("truncated stream is a clean error and the turn rolls back", async () => {
    let n = 0;
    const seen: number[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      const body = JSON.parse(String((init as unknown as { body?: unknown })?.body ?? "{}")) as {
        messages?: unknown[];
      };
      seen.push(body.messages?.length ?? 0);
      if (n === 1) {
        // SSE ends without [DONE]: truncated.
        return streamResponse([contentChunk("partial-AAA")]);
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "recovered-BBB" } }] }) } as unknown as Response;
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "Truncated stream");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "recovered-BBB");
      // Failed streaming turn left history clean ([3,3]) but preserved the
      // streamed partial on display (marked) instead of vanishing it.
      expect(seen).toEqual([3, 3]);
      expect(app.lastFrame()).toContain("partial-AAA");
      expect(app.lastFrame()).toContain("partial output preserved");
    } finally {
      app.unmount();
    }
  });

  test("malformed SSE lines never crash the turn", async () => {
    const sse = `data: {oops\n\n: comment\n\ndata: still-not-json\n\n${contentChunk("fine-after-junk")}${SSE_DONE}`;
    globalThis.fetch = vi.fn(async () => streamResponse([sse]));
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "fine-after-junk");
    } finally {
      app.unmount();
    }
  });
});
