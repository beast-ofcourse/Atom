// Sequenced streaming lanes: thinking and preview take turns owning the
// live zone (opencode-style ordered blocks), and the transcript commits
// them in arrival order — thinking, preview, thinking, preview — with
// suffix-only pins so alternating lanes never duplicate or omit segments.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { LiveTail } from "../src/ui/live-tail.js";
import { createStreamStore } from "../src/ui/stream-store.js";

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

describe("stream store active lane", () => {
  test("writes claim the lane; clearing falls back; explicit wins", () => {
    const store = createStreamStore();
    expect(store.getActiveLane()).toBeNull();
    store.setDraft("hello");
    expect(store.getActiveLane()).toBe("draft");
    store.setThinking("hmm");
    expect(store.getActiveLane()).toBe("thinking");
    store.setThinking(null);
    expect(store.getActiveLane()).toBe("draft");
    store.setDraft(null);
    expect(store.getActiveLane()).toBeNull();
    store.set({ draft: "a", thinking: "b", activeLane: "draft" });
    expect(store.getActiveLane()).toBe("draft");
    store.clear();
    expect(store.getActiveLane()).toBeNull();
  });
});

describe("live tail lane gating", () => {
  const base = {
    isEmpty: false,
    sessionHint: false,
    busy: true,
    elapsedSecs: 1,
    toolHint: null,
    toolElapsedSecs: null,
  } as const;
  test("only the active lane paints — no same-frame pileup", () => {
    const both = render(
      <LiveTail {...base} draft="preview text" thinking="reasoning trace" activeLane="thinking" />
    );
    try {
      expect(both.lastFrame()).toContain("reasoning trace");
      expect(both.lastFrame()).not.toContain("preview text");
    } finally {
      both.unmount();
    }
    const draftOn = render(
      <LiveTail {...base} draft="preview text" thinking="reasoning trace" activeLane="draft" />
    );
    try {
      expect(draftOn.lastFrame()).toContain("preview text");
      expect(draftOn.lastFrame()).not.toContain("reasoning trace");
    } finally {
      draftOn.unmount();
    }
    const unset = render(
      <LiveTail {...base} draft="preview text" thinking="reasoning trace" activeLane={null} />
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
});
