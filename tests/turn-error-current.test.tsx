// Failed-turn partial output, current error surfacing.
//
// Same scenario as the stale "streamed text survives a fail-fast second
// POST" case: the first POST streams text plus a tool call, the tool-round
// POST fails fast with HTTP 400. Current behavior keeps the streamed text on
// display beside an `error>` card (`<Provider>: request failed (HTTP 400).`)
// and still renders the audit line. The stale suite waits for a
// "partial output preserved" marker that no longer exists, so it times out.
// Network is ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

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

function httpFail(status: number): Response {
  return {
    ok: false,
    status,
    text: async () => "bad",
    headers: { get: () => null },
  } as unknown as Response;
}

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

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}

describe("failed turns preserve partial output (current surfacing)", () => {
  test("streamed text stays beside the error card with the audit line", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return streamResponse([
          sseData({ choices: [{ delta: { content: "half answer here" } }] }),
          sseData({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"package.json"}' },
                    },
                  ],
                },
              },
            ],
          }),
          SSE_DONE,
        ]);
      }
      // Tool-round POST fails fast (400 never retries).
      return httpFail(400);
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("read it");
      app.stdin.write("\r");
      await waitForFrame(app, "error>");
      const frame = app.lastFrame() ?? "";
      // The streamed text stays on display…
      expect(frame).toContain("half answer here");
      // …alongside the failure, and the audit line still rendered.
      expect(frame).toContain("HTTP 400");
      expect(frame).toContain("⚙ read package.json");
    } finally {
      app.unmount();
    }
  });
});
