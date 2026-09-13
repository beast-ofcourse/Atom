// Streaming commit contract: pinned inter-tool chatter must never render
// twice, and the running-tool line must not survive into the next POST.
//
// Defects covered (see ui/tool-call-state + App onToolActivity):
// 1. The painted draft lane used to stay live after its text was pinned to
//    the transcript at a tool commit, so the same paragraph rendered twice
//    (committed MarkdownText + live MarkdownStream) for the whole next POST.
// 2. The tool hint survived the next model POST, so the Progress line read
//    as "running" while the model was thinking.
//
// Method: POST 1 streams chatter + a read call; POST 2 hangs, freezing the
// post-commit window deterministically. Network is ALWAYS mocked.
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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("streaming commit contract", () => {
  test("pinned chatter renders once and the running line clears on the next POST", async () => {
    const chatter = "Alpha chatter pinned once.";
    const post1 = streamResponse([
      sseData({ choices: [{ delta: { content: chatter } }] }),
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
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
    // POST 2 hangs: the post-commit window stays open for inspection instead
    // of racing the next token paint.
    let posts = 0;
    globalThis.fetch = vi.fn(async () => {
      posts += 1;
      if (posts === 1) return post1;
      return new Promise<Response>(() => {});
    });
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={["big-pickle"]} />
    );
    try {
      app.stdin.write("check the package file");
      app.stdin.write("\r");
      // Tool commit landed (audit line) and the hanging POST 2 started.
      await waitForFrame(app, "⚙ read package.json");
      // Settle past the 64ms trailing paint window so any stale trailing
      // paint would have landed by assertion time.
      await new Promise((r) => setTimeout(r, 300));
      const frame = app.lastFrame() ?? "";
      // The pinned chatter lives in the transcript exactly once — never
      // duplicated by a stale live draft beside it.
      expect(frame).toContain(chatter);
      expect(countOccurrences(frame, chatter)).toBe(1);
      // The finished tool's running line is gone: the next POST is model
      // thinking, not tool execution.
      expect(frame).not.toContain("Reading package.json");
    } finally {
      app.unmount();
    }
  });
});
