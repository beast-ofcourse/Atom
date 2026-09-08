// Provider-seam regression tests for Task A (mocked fetch only, never live).
// Three seams where "what we send the provider / what we report back" was
// wrong: (1) Gemini 400 on `additionalProperties`, (2) per-kind usage mapping
// + hold-last-known load, (3) multi-turn memory per kind.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAnthropicBody,
  buildGeminiBody,
  parseGeminiJson,
  readAnthropicSSEMessage,
  readGeminiSSEMessage,
} from "../src/adapters.js";
import { TOOL_DEFINITIONS } from "../src/tools.js";
import {
  chatCompletionForProvider,
  runAgenticLoopForProvider,
  type ChatMessage,
} from "../src/zen.js";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let homes: string[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  const { rm } = await import("node:fs/promises");
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

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

// Recursively collect every occurrence of `key` under `value` as JSON paths.
function pathsOfKey(value: unknown, key: string, at = "$"): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...pathsOfKey(v, key, `${at}[${i}]`)));
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key) out.push(`${at}.${k}`);
      out.push(...pathsOfKey(v, key, `${at}.${k}`));
    }
  }
  return out;
}

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

// ---- Item 1: Gemini rejects `additionalProperties` ----

describe("gemini tool payload carries zero additionalProperties", () => {
  test("recursive proof over the real TOOL_DEFINITIONS (incl. ask_question array param)", () => {
    const body = buildGeminiBody(
      [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
      "gemini-2.5-flash"
    );
    const decls = body.tools![0]!.functionDeclarations;
    expect(decls.length).toBe(TOOL_DEFINITIONS.length);
    expect(pathsOfKey(body.tools, "additionalProperties")).toEqual([]);
    // Schema content survives: ask_question keeps its array param shape.
    const ask = decls.find((d) => d.name === "ask_question")!;
    const params = ask.parameters as Record<string, unknown>;
    expect(params["type"]).toBe("object");
    expect(params["required"]).toEqual(["question", "options"]);
    const options = (params["properties"] as Record<string, unknown>)["options"] as Record<string, unknown>;
    expect(options["type"]).toBe("array");
    expect(options["items"]).toEqual({ type: "string" });
  });

  test("canonical TOOL_DEFINITIONS stay OpenAI-canonical (conversion is adapter-local)", () => {
    const dumped = JSON.stringify(TOOL_DEFINITIONS);
    expect(dumped).toContain('"additionalProperties":false');
    const ask = TOOL_DEFINITIONS.find((t) => t.function.name === "ask_question")!;
    expect(JSON.stringify(ask.function.parameters)).toContain('"additionalProperties":false');
  });

  test("anthropic input_schema path is byte-identical (still carries additionalProperties)", () => {
    const body = buildAnthropicBody(
      [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
      "claude-sonnet-5"
    );
    const read = body.tools!.find((t) => t.name === "read")!;
    expect(JSON.stringify(read.input_schema)).toContain('"additionalProperties":false');
  });

  test("openai-chat POST still sends the canonical tools verbatim", async () => {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) } as Response;
    });
    await chatCompletionForProvider(
      "opencode-zen",
      "k",
      "big-pickle",
      [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ],
      { sleep: async () => {} }
    );
    expect(JSON.stringify(seen[0]?.["tools"])).toContain('"additionalProperties":false');
  });
});

// ---- Item 2a: per-kind usage mapping gaps ----

describe("usage mapping gaps", () => {
  test("gemini SSE preserves a total-only usageMetadata", async () => {
    const msg = await readGeminiSSEMessage(
      sseResponse([sse({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }], usageMetadata: { totalTokenCount: 42 } })])
    );
    expect(msg.usage).toEqual({ total_tokens: 42 });
  });

  test("gemini JSON preserves a total-only usageMetadata", () => {
    const msg = parseGeminiJson({
      candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
      usageMetadata: { totalTokenCount: 42 },
    });
    expect(msg.usage).toEqual({ total_tokens: 42 });
  });

  test("anthropic SSE recomputes the total across start + delta (no stale total)", async () => {
    const body =
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const msg = await readAnthropicSSEMessage(sseResponse([body]));
    expect(msg.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test("anthropic message_delta tolerates top-level output_tokens", async () => {
    const body =
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
      // No `usage` key: counts ride at the top level of message_delta.
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"output_tokens":5}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const msg = await readAnthropicSSEMessage(sseResponse([body]));
    expect(msg.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
});

// ---- Item 2b: hold-last-known load (report→silent→report never regresses) ----

describe("hold-last-known load", () => {
  function mockChatQueue(turns: Array<{ reply: string; usage?: unknown }>) {
    const queue = [...turns];
    globalThis.fetch = vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: next.reply } }],
          ...(next.usage !== undefined ? { usage: next.usage } : {}),
        }),
      } as Response;
    });
  }

  test("status P latches to reports: report→silent→report never regresses to estimate", async () => {
    mockChatQueue([
      { reply: "r1", usage: { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 } },
      { reply: "r2" }, // silent: no usage payload
      { reply: "r3", usage: { prompt_tokens: 20000, completion_tokens: 1000, total_tokens: 21000 } },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="kimi-k2.5" initialModels={["kimi-k2.5"]} />
    );
    try {
      app.stdin.write("one");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: (15%) 44K");
      // Silent turn: P% must hold the last report (the chars/4 estimate of
      // this tiny history would read ~0%, never 15%).
      app.stdin.write("two");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      expect(app.lastFrame()).toContain("token: (15%) 44K");
      // Next report moves both P (new load) and NK (cumulative spend).
      app.stdin.write("three");
      app.stdin.write("\r");
      await waitForFrame(app, "r3");
      await waitForFrame(app, "token: (8%) 65K");
    } finally {
      app.unmount();
    }
  });

  test("/model switch resets the load latch but keeps cumulative NK", async () => {
    mockChatQueue([
      { reply: "r1", usage: { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 } },
    ]);
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="kimi-k2.5"
        initialModels={["kimi-k2.5", "glm-5.1"]}
      />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: (15%) 44K");
      // Switch model: reported 40000 belonged to the old tokenizer, so the
      // estimate applies (a stale 40000 on glm-5.1's 200K window would read
      // (20%), never 15% or 0%-estimate).
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B[B"); // down: kimi-k2.5 -> glm-5.1
      app.stdin.write("\r");
      await waitForFrame(app, "model: glm-5.1");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("44K"); // cumulative spend untouched
      expect(frame).not.toContain("(15%)"); // old reported load gone
      expect(frame).not.toContain("(20%)"); // stale report not reused on the new window
    } finally {
      app.unmount();
    }
  });

  test("provider switch resets the load latch but keeps cumulative NK", async () => {
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
    const home = await mkdtemp(join(tmpdir(), "atom-seam-"));
    homes.push(home);
    process.env.ATOM_HOME = home;
    // Same model id both sides (claude-sonnet-5, 1M window) so only the
    // provider changes: P must fall 4% -> 0%-estimate purely from the reset.
    // Router: zen chat POST reports usage; anthropic validates + lists the
    // same model id so the switch keeps it.
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        if (u.includes("anthropic")) {
          return { ok: true, json: async () => ({ data: [{ id: "claude-sonnet-5" }] }) } as Response;
        }
        return { ok: true, json: async () => ({ data: [{ id: "x-live" }] }) } as Response;
      }
      if (u.includes("anthropic")) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "anthropic-hi" }],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "r1" } }],
          usage: { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 },
        }),
      } as Response;
    });
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="claude-sonnet-5"
        initialModels={["claude-sonnet-5"]}
      />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: (4%) 44K");
      // Switch provider to anthropic (index 2) with a pasted key; the live
      // list keeps claude-sonnet-5, so model + window are unchanged.
      app.stdin.write("/provider");
      app.stdin.write("\r");
      await waitForFrame(app, "Select provider");
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "API key for anthropic");
      app.stdin.write("test-key");
      app.stdin.write("\r");
      await waitForFrame(app, "provider: anthropic");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("model: claude-sonnet-5");
      expect(frame).toContain("44K"); // cumulative spend untouched
      expect(frame).not.toContain("(4%)"); // old provider's reported load gone
      await waitForFrame(app, "token: (0%) 44K"); // estimate applies until anthropic reports
    } finally {
      app.unmount();
    }
  });
});

// ---- Item 3: multi-turn memory per kind ----

describe("multi-turn memory carries the full in-budget history", () => {
  function openAIMock(replies: string[]) {
    const posts: Array<Record<string, unknown>> = [];
    const queue = [...replies];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      const text = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) } as unknown as Response;
    });
    return posts;
  }

  function anthropicMock(replies: string[]) {
    const posts: Array<Record<string, unknown>> = [];
    const queue = [...replies];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      const text = queue.length > 1 ? queue.shift()! : queue[0]!;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      } as unknown as Response;
    });
    return posts;
  }

  function geminiMock(replies: string[]) {
    const posts: Array<Record<string, unknown>> = [];
    const queue = [...replies];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      const text = queue.length > 1 ? queue.shift()! : queue[0]!;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: "model", parts: [{ text }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      } as unknown as Response;
    });
    return posts;
  }

  async function threePlainTurns(
    provider: "opencode-zen" | "anthropic" | "google-gemini",
    model: string
  ): Promise<void> {
    const history: ChatMessage[] = [{ role: "system", content: "s" }];
    for (const q of ["msg-one", "msg-two", "msg-three"]) {
      history.push({ role: "user", content: q });
      await runAgenticLoopForProvider(provider, "k", model, history, { sleep: async () => {} });
    }
  }

  test("openai-chat: 3rd POST carries all 3 user messages + both replies", async () => {
    const posts = openAIMock(["reply-one", "reply-two", "reply-three"]);
    await threePlainTurns("opencode-zen", "big-pickle");
    expect(posts).toHaveLength(3);
    const dumped = JSON.stringify(posts[2]);
    for (const needle of ["msg-one", "msg-two", "msg-three", "reply-one", "reply-two"]) {
      expect(dumped).toContain(needle);
    }
  });

  test("anthropic-messages: 3rd POST carries all 3 user messages + both replies", async () => {
    const posts = anthropicMock(["reply-one", "reply-two", "reply-three"]);
    await threePlainTurns("anthropic", "claude-sonnet-5");
    expect(posts).toHaveLength(3);
    const dumped = JSON.stringify(posts[2]);
    for (const needle of ["msg-one", "msg-two", "msg-three", "reply-one", "reply-two"]) {
      expect(dumped).toContain(needle);
    }
  });

  test("gemini-generate: 3rd POST carries all 3 user messages + both replies", async () => {
    const posts = geminiMock(["reply-one", "reply-two", "reply-three"]);
    await threePlainTurns("google-gemini", "gemini-2.5-flash");
    expect(posts).toHaveLength(3);
    const dumped = JSON.stringify(posts[2]);
    for (const needle of ["msg-one", "msg-two", "msg-three", "reply-one", "reply-two"]) {
      expect(dumped).toContain(needle);
    }
  });

  test("gemini behaves like the real API: 400 on additionalProperties, so the payload fix is what lets a conversation accumulate", async () => {
    // Strict seam mock: rejects exactly what Gemini rejects (the reported
    // 400 text), succeeds otherwise. Pre-fix every turn 400s and the App
    // rollback contract erases it — the conversation can never accumulate
    // (the reported "forgetting"). Post-fix all three turns commit.
    const posts: Array<Record<string, unknown>> = [];
    const queue = ["reply-one", "reply-two", "reply-three"];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
      posts.push(body);
      if (pathsOfKey(body.tools ?? {}, "additionalProperties").length > 0) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            'Invalid JSON payload received. Unknown name "additionalProperties" at ' +
            "'tools[0].function_declarations[0].parameters'",
        } as unknown as Response;
      }
      const text = queue.length > 1 ? queue.shift()! : queue[0]!;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: "model", parts: [{ text }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      } as unknown as Response;
    });
    // App submit contract: push user, run loop, roll the turn back on POST
    // failure (same splice contract as src/App.tsx).
    const history: ChatMessage[] = [{ role: "system", content: "s" }];
    for (const q of ["msg-one", "msg-two", "msg-three"]) {
      const rollbackTo = history.length;
      history.push({ role: "user", content: q });
      try {
        await runAgenticLoopForProvider("google-gemini", "k", "gemini-2.5-flash", history, {
          sleep: async () => {},
        });
      } catch {
        history.splice(rollbackTo);
      }
    }
    expect(history.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const dumped = JSON.stringify(posts[2]);
    for (const needle of ["msg-one", "msg-two", "msg-three", "reply-one", "reply-two"]) {
      expect(dumped).toContain(needle);
    }
  });
});
