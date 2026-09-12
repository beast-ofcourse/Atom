// Inter-tool chatter must survive the turn commit (vanish-on-commit repro).
// Loop keeps intermediate POST text in history only and returns the FINAL
// post's text as `reply`; the App used to commit `reply` verbatim, so a turn
// whose final POST is empty committed a blank assistant turn — the streamed
// answer visibly vanished while thinking (separate ref) stayed. Network is
// ALWAYS mocked (real SSE Responses, like streaming.test.tsx).
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
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function mockFetchSequence(responses: Response[]) {
  let i = 0;
  globalThis.fetch = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!);
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 10000
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

const CHATTER = "Checking the file alpha now.";
const READ_ARGS = JSON.stringify({ path: "package.json" });

function toolTurn(first: string, second: string): Response[] {
  const post1 =
    sseData({ choices: [{ delta: { content: first } }] }) +
    sseData({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: READ_ARGS } }] } }],
    }) +
    SSE_DONE;
  const post2 = second.length > 0 ? sseData({ choices: [{ delta: { content: second } }] }) + SSE_DONE : SSE_DONE;
  return [streamResponse([post1]), streamResponse([post2])];
}

describe("turn text commit (streamed chatter survives)", () => {
  test("empty final reply keeps the streamed inter-tool chatter", async () => {
    mockFetchSequence(toolTurn(CHATTER, ""));
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("read it");
      app.stdin.write("\r");
      await waitForFrame(app, "read");
      // Live draft shows it mid-stream; the bug wiped it at commit — settle
      // past turn end, then require it in the committed transcript.
      await new Promise((r) => setTimeout(r, 2500));
      expect(app.lastFrame()).toContain(CHATTER);
    } finally {
      app.unmount();
    }
  });

  test("tool chatter commits once, final summary commits once", async () => {
    mockFetchSequence(toolTurn("Checking file alpha.", "Finished reading."));
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("read it");
      app.stdin.write("\r");
      await waitForFrame(app, "Finished reading.");
      await new Promise((r) => setTimeout(r, 2500));
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Checking file alpha.");
      expect(frame).toContain("Finished reading.");
      expect(frame.split("Checking file alpha.").length - 1).toBe(1);
    } finally {
      app.unmount();
    }
  });
});
