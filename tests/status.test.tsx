// Status-line + Tab-toggle + usage tests. Network is ALWAYS mocked here —
// the live Zen free tier is rate-limited (HTTP 429), so never verify
// against the live API.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { chatCompletion, type ChatMessage } from "../src/zen.js";

const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
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
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

type MockTurn = { reply: string; usage?: unknown; messageExtra?: Record<string, unknown> };

// Queue of scripted non-streaming JSON replies (no `body`, so the client
// takes the single-JSON path, exactly like tests/app.test.tsx mocks).
function mockChatQueue(turns: MockTurn[]) {
  const queue = [...turns];
  globalThis.fetch = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: next.reply, ...(next.messageExtra ?? {}) } }],
        ...(next.usage !== undefined ? { usage: next.usage } : {}),
      }),
    } as Response;
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
const SSE_DONE = "data: [DONE]\n\n";

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

describe("status line", () => {
  test("renders all five segments with honest empty state", () => {
    mockChatQueue([{ reply: "ok" }]);
    const app = render(<App {...baseProps()} />);
    try {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("opencode-zen"); // provider
      expect(frame).toContain("big-pickle"); // model
      expect(frame).toContain("token: n/a"); // no usage reported yet
      expect(frame).toContain("reasoning: default"); // never sent, none received
      expect(frame).toContain("mode: normal"); // mode
    } finally {
      app.unmount();
    }
  });

  test("no header block in any frame; status line is the sole info bar", () => {
    mockChatQueue([{ reply: "ok" }]);
    const app = render(<App {...baseProps()} />);
    try {
      const frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("Atom · minimal");
      expect(frame).not.toContain("Tab toggles");
      expect(frame).not.toContain("Commands: /model");
      // Status line carries every segment.
      for (const seg of [
        "provider: opencode-zen",
        "model: big-pickle",
        "token: n/a",
        "reasoning: default",
        "mode: normal",
      ]) {
        expect(frame).toContain(seg);
      }
    } finally {
      app.unmount();
    }
  });

  test("missing usage keeps the literal `token: n/a` after a turn", async () => {
    mockChatQueue([{ reply: "hello back" }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "hello back");
      expect(app.lastFrame()).toContain("token: n/a");
    } finally {
      app.unmount();
    }
  });

  test("usage accumulates across mocked JSON turns (bare K, unknown window)", async () => {
    mockChatQueue([
      {
        reply: "r1",
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      },
      {
        reply: "r2",
        usage: { prompt_tokens: 2000, completion_tokens: 500, total_tokens: 2500 },
      },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: 1K");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      expect(app.lastFrame()).toContain("token: 4K");
    } finally {
      app.unmount();
    }
  });

  test("known window renders `token: (P%) NK` in the status line", async () => {
    mockChatQueue([
      {
        // kimi-k2.5 window is 262144: P uses load (prompt 40000 → 15%),
        // NK uses cumulative total (45056 → 44K). Forced change: P no
        // longer tracks the cumulative spend (it must survive compaction).
        reply: "r1",
        usage: { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 },
      },
    ]);
    const app = render(
      <App {...baseProps()} initialModel="kimi-k2.5" initialModels={["kimi-k2.5"]} />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: (15%) 44K");
    } finally {
      app.unmount();
    }
  });

  test("SSE final usage chunks accumulate into the status line", async () => {
    const sse =
      sseData({ choices: [{ delta: { content: "streamed-hi" } }] }) +
      sseData({
        choices: [],
        usage: { prompt_tokens: 4000, completion_tokens: 6000, total_tokens: 10000 },
      }) +
      SSE_DONE;
    globalThis.fetch = vi.fn(async () => streamResponse([sse]));
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "streamed-hi");
      await waitForFrame(app, "token: 10K");
    } finally {
      app.unmount();
    }
  });

  test("model and mode switches update the status line", async () => {
    mockChatQueue([{ reply: "ok" }]);
    const app = render(<App {...baseProps()} />);
    try {
      // Model switch via the picker.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B[B"); // down arrow -> kimi-k2.5
      app.stdin.write("\r");
      await waitForFrame(app, "model: kimi-k2.5");
      // Mode switch via /yolo.
      app.stdin.write("/yolo");
      app.stdin.write("\r");
      await waitForFrame(app, "mode: yolo");
      // Status line still carries every segment.
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("opencode-zen");
      expect(frame).toContain("token: n/a");
      expect(frame).toContain("reasoning: default");
    } finally {
      app.unmount();
    }
  });

  test("response reasoning metadata surfaces in the status line", async () => {
    mockChatQueue([
      { reply: "deep thought", messageExtra: { reasoning_content: "some thinking trace" } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "deep thought");
      await waitForFrame(app, "reasoning: present");
    } finally {
      app.unmount();
    }
  });

  test("/clear keeps the session usage totals", async () => {
    mockChatQueue([
      {
        reply: "r1",
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "token: 1K");
      app.stdin.write("/clear");
      app.stdin.write("\r");
      await waitForFrame(app, "Say hi");
      const frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("r1");
      expect(frame).toContain("token: 1K"); // totals survive /clear
    } finally {
      app.unmount();
    }
  });
});

describe("Tab toggles mode", () => {
  test("Tab flips normal<->yolo from plain input", async () => {
    mockChatQueue([{ reply: "ok" }]);
    const app = render(<App {...baseProps()} />);
    try {
      expect(app.lastFrame()).toContain("mode: normal");
      app.stdin.write("\t");
      await waitForFrame(app, "mode: yolo");
      app.stdin.write("\t");
      await waitForFrame(app, "mode: normal");
    } finally {
      app.unmount();
    }
  });

  test("Tab in the open slash menu runs the highlight and does NOT toggle", async () => {
    mockChatQueue([{ reply: "ok" }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/");
      await waitForFrame(app, "Atom commands");
      app.stdin.write("\t"); // highlight is /model -> opens the picker
      await waitForFrame(app, "Select model");
      expect(app.lastFrame()).toContain("mode: normal");
      expect(app.lastFrame()).not.toContain("mode: yolo");
    } finally {
      app.unmount();
    }
  });
});

describe("chatCompletion usage/reasoning plumbing", () => {
  function history(): ChatMessage[] {
    return [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
  }

  test("JSON usage is returned; absent usage stays undefined (never 0)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
    })) as unknown as typeof fetch;
    const withUsage = await chatCompletion(ENDPOINT, "k", "m", history(), {
      sleep: async () => {},
    });
    expect(withUsage.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    });

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hi" } }] }),
    })) as unknown as typeof fetch;
    const withoutUsage = await chatCompletion(ENDPOINT, "k", "m", history(), {
      sleep: async () => {},
    });
    expect(withoutUsage.usage).toBeUndefined();
    expect(withoutUsage.reasoning).toBeUndefined();
  });

  test("SSE final-chunk usage is captured by the parser", async () => {
    const sse =
      sseData({ choices: [{ delta: { content: "yo" } }] }) +
      sseData({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }) +
      SSE_DONE;
    globalThis.fetch = vi.fn(async () => streamResponse([sse]));
    const msg = await chatCompletion(ENDPOINT, "k", "m", history(), {
      sleep: async () => {},
    });
    expect(msg.content).toBe("yo");
    expect(msg.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  test("malformed usage payloads are ignored, never invented", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: "lots", completion_tokens: -5 },
      }),
    })) as unknown as typeof fetch;
    const msg = await chatCompletion(ENDPOINT, "k", "m", history(), {
      sleep: async () => {},
    });
    expect(msg.usage).toBeUndefined();
  });
});
