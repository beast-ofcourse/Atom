// Sequenced streaming: thinking and preview coexist as ordered blocks; the
// transcript commits them in arrival order — thinking, preview, thinking,
// preview — with no exclusive lane and no freeze/pin on channel switch.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { LiveTail } from "../src/ui/live-tail.js";
import { createStreamStore } from "../src/ui/stream-store.js";
import { applyStepDelta } from "../src/ui/step-blocks.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
const SSE_DONE = "data: [DONE]\n\n";
const contentChunk = (c: string) => sse({ choices: [{ delta: { content: c } }] });
const thinkingChunk = (c: string) => sse({ choices: [{ delta: { reasoning_content: c } }] });
function toolChunk(name: string, args: string) {
  return sse({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name, arguments: args } }] } }],
  });
}
function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
async function waitForFrame(app: { lastFrame(): string | undefined }, needle: string, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout)
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
function mountApp() {
  return render(
    <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={["big-pickle"]} />
  );
}
async function submitLine(app: { stdin: { write: (s: string) => void } }, line: string) {
  app.stdin.write(line);
  await new Promise((r) => setTimeout(r, 40));
  app.stdin.write("\r");
  await new Promise((r) => setTimeout(r, 40));
}

describe("stream store fields", () => {
  test("draft and thinking write independently; no active lane", () => {
    const store = createStreamStore();
    expect(store.getSnapshot()).toEqual({ draft: null, thinking: null, stepBlocks: null });
    store.setDraft("hello");
    expect(store.getDraft()).toBe("hello");
    store.setThinking("hmm");
    expect(store.getSnapshot()).toEqual({ draft: "hello", thinking: "hmm", stepBlocks: null });
    store.set({ draft: "a", thinking: "b" });
    expect(store.getSnapshot()).toEqual({ draft: "a", thinking: "b", stepBlocks: null });
    store.clear();
    expect(store.getSnapshot()).toEqual({ draft: null, thinking: null, stepBlocks: null });
  });
});

describe("live tail ordered blocks", () => {
  const base = {
    isEmpty: false,
    sessionHint: false,
    busy: true,
    elapsedSecs: 1,
    toolHint: null,
    toolElapsedSecs: null,
  } as const;
  test("both segments paint once each in list order — no exclusive lane", () => {
    const blocks = applyStepDelta(
      applyStepDelta([], { lane: "thinking", text: "reasoning trace" }),
      { lane: "text", text: "preview text" },
    );
    const both = render(
      <LiveTail {...base} draft="preview text" thinking="reasoning trace" stepBlocks={blocks} />,
    );
    try {
      const frame = both.lastFrame() ?? "";
      expect(frame).toContain("reasoning trace");
      expect(frame).toContain("preview text");
      // Segmented blocks, not a second full cumulative beside them.
      expect(frame.split("preview text")).toHaveLength(2);
      expect(frame.indexOf("reasoning trace")).toBeLessThan(frame.indexOf("preview text"));
    } finally {
      both.unmount();
    }
  });

  test("without blocks, legacy draft and thinking lanes both paint", () => {
    const unset = render(
      <LiveTail {...base} draft="preview text" thinking="reasoning trace" />,
    );
    try {
      expect(unset.lastFrame()).toContain("preview text");
      expect(unset.lastFrame()).toContain("reasoning trace");
    } finally {
      unset.unmount();
    }
  });
});

describe("interleaved thinking/content sequencing", () => {
  test("one POST, alternating lanes → ordered suffix blocks, no dup, no loss", async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse([
        thinkingChunk("mulling it "),
        contentChunk("First bit "),
        thinkingChunk("over "),
        contentChunk("and more "),
        SSE_DONE,
      ])
    );
    const app = mountApp();
    try {
      await submitLine(app, "go");
      await waitForFrame(app, "and more");
      const frame = app.lastFrame() ?? "";
      // Arrival order survives in the transcript: T1 < D1 < T2 < tail.
      const iT1 = frame.indexOf("mulling it");
      const iD1 = frame.indexOf("First bit");
      const iT2 = frame.indexOf("over");
      const iTail = frame.indexOf("and more");
      expect(iT1).toBeGreaterThanOrEqual(0);
      expect(iD1).toBeGreaterThan(iT1);
      expect(iT2).toBeGreaterThan(iD1);
      expect(iTail).toBeGreaterThan(iT2);
      // Suffix pins: the full cumulative strings never print whole twice.
      expect(frame).not.toContain("First bit and more");
      expect(frame).not.toContain("mulling it over");
      // Each block holds only its own segment: no block duplicates another.
      expect(frame.split("First bit").length - 1).toBe(1);
      expect(frame.split("mulling it").length - 1).toBe(1);
    } finally {
      app.unmount();
    }
  });

  test("tool flow pins once: opener not duplicated by final reply", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return streamResponse([
          contentChunk("Checking files "),
          toolChunk("glob", '{"pattern":"*.ts"}'),
          SSE_DONE,
        ]);
      }
      return streamResponse([
        thinkingChunk("Reviewing "),
        contentChunk("Found 3 files"),
        SSE_DONE,
      ]);
    });
    const app = mountApp();
    try {
      await submitLine(app, "go");
      await waitForFrame(app, "Found 3 files");
      const frame = app.lastFrame() ?? "";
      const order = ["Checking files", "glob", "Reviewing", "Found 3 files"].map((s) => frame.indexOf(s));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(frame.split("Checking files").length - 1).toBe(1);
    } finally {
      app.unmount();
    }
  });

  test("Esc mid-thinking freezes reasoning above the cancelled line", async () => {
    const enc = new TextEncoder();
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const signal = (init as { signal?: AbortSignal })?.signal;
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(thinkingChunk("mid-stream musings ")));
          // Hang until the interrupt aborts the request.
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const app = mountApp();
    try {
      await submitLine(app, "go");
      await waitForFrame(app, "mid-stream musings");
      app.stdin.write("\u001b");
      await waitForFrame(app, "(cancelled)");
      const frame = app.lastFrame() ?? "";
      // Frozen as-is (opencode parity): reasoning stays visible, then the
      // rollback line — never a vanishing block.
      expect(frame).toContain("mid-stream musings");
      expect(frame.indexOf("mid-stream musings")).toBeLessThan(frame.indexOf("(cancelled)"));
    } finally {
      app.unmount();
    }
  });
});
