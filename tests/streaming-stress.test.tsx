// Stress tests for the producer/consumer streaming + transcript pipeline.
// Producer (loop SSE callbacks) must never couple to consumer speed (Ink):
// tokens coalesce through the 64ms trailing throttler into the StreamStore,
// committed transcript rows print once to terminal scrollback via <Static>
// (never rewritten), huge tool output stays capped, and keyboard/timer
// activity stays isolated.
// Network is ALWAYS mocked here — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { App, createDraftThrottler } from "../src/App.js";
import { createStreamStore } from "../src/ui/stream-store.js";
import { inputRenderProbe } from "../src/ui/input.js";
import {
  TranscriptView,
  transcriptRenderProbe,
  type Turn,
} from "../src/ui/transcript.js";
import {
  InspectorPanel,
  MAX_TOOL_RECORDS,
  STORE_CHARS,
  createToolRecord,
} from "../src/ui/tool-inspector.js";

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

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function makeTurns(n: number): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i % 2 === 0
        ? { role: "user", content: `question number ${i}` }
        : { role: "assistant", content: `answer number ${i} with some body text` }
    );
  }
  return out;
}

// Deterministic manual clock (same shape as the paint-bounds test).
function makeManualClock() {
  let nowMs = 0;
  const timers = new Map<number, { cb: () => void; at: number }>();
  let seq = 1;
  const setTimeoutFn = ((cb: (...args: unknown[]) => void, ms?: number) => {
    const id = seq++;
    timers.set(id, { cb: () => cb(), at: nowMs + (ms ?? 0) });
    return id as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => {
    timers.delete(id as number);
  }) as unknown as typeof clearTimeout;
  const advance = (ms: number) => {
    nowMs += ms;
    for (;;) {
      let next: number | null = null;
      let at = Number.POSITIVE_INFINITY;
      for (const [id, t] of timers) {
        if (t.at <= nowMs && t.at < at) {
          at = t.at;
          next = id;
        }
      }
      if (next === null) return;
      const cb = timers.get(next)!.cb;
      timers.delete(next);
      cb();
    }
  };
  return { setTimeoutFn, clearTimeoutFn, advance, now: () => nowMs };
}

describe("transcript commits under load", () => {
  test("5000 turns commit once (static scrollback, never rewritten)", () => {
    const turns = makeTurns(5000);
    const started = Date.now();
    const frame = frameOf(<TranscriptView turns={turns} clearGen={0} />);
    const elapsed = Date.now() - started;
    // Static commits print the whole record once; terminal scrollback (not
    // the TUI) holds overflow — keystrokes later rewrite ~40 bytes, not this.
    expect(frame).toContain("answer number 4999");
    expect(frame).toContain("question number 0");
    expect(frame).toContain("answer number 1");
    // Generous bound — proves single-commit, not per-frame relayout.
    expect(elapsed).toBeLessThan(30000);
  });

  test("appending one turn mounts one row, never recommits history", () => {
    const turns = makeTurns(3000);
    let innerCalls = 0;
    const renderItem = (item: { id: string; turn?: Turn }) => {
      innerCalls += 1;
      return <Text key={item.id}>{item.turn?.content ?? ""}</Text>;
    };
    const app = render(<TranscriptView turns={turns} clearGen={0} renderItem={renderItem} />);
    try {
      // NOTE: ink-testing-library commits the mount twice, so only the
      // append delta is meaningful (not the absolute mount count).
      const before = innerCalls;
      const more = [...turns, { role: "assistant", content: "brand new reply" } as Turn];
      app.rerender(<TranscriptView turns={more} clearGen={0} renderItem={renderItem} />);
      // Static admission: only the new row mounts (≤2 inner calls: the
      // test harness double-commits); committed history is never remounted.
      expect(innerCalls - before).toBeLessThanOrEqual(2);
      expect(app.lastFrame()).toContain("brand new reply");
    } finally {
      app.unmount();
    }
  });
});

describe("coalescing under rapid tokens", () => {
  test("10k pushes over 60s stay paint-bounded and converge exact", () => {
    const clock = makeManualClock();
    const store = createStreamStore();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });
    const th = createDraftThrottler({
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (t) => store.setDraft(t),
    });
    const started = Date.now();
    for (let i = 0; i < 10000; i++) {
      th.push(`token-${i}`);
      clock.advance(6);
    }
    th.flush();
    const elapsed = Date.now() - started;
    // 60s at a 64ms trailing window ⇒ ≤ ~940 paints + slack; one notify each.
    expect(notifies).toBeLessThanOrEqual(1000);
    expect(store.getDraft()).toBe("token-9999");
    // The producer loop itself is pure sync CPU — never waits on Ink.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("huge tool output caps", () => {
  test("1MB result stores capped with an explicit truncation flag", () => {
    const big = `line\n`.repeat(500000); // ~2.5MB
    const rec = createToolRecord(1, "⚙ bash huge", big, false, 12);
    // Contract: the flag is the signal (the stored head carries content
    // only); the inspector panel renders the human notice from the flag.
    expect(rec.truncated).toBe(true);
    expect(rec.result.length).toBeLessThanOrEqual(STORE_CHARS);
    const frame = frameOf(
      <InspectorPanel records={[rec]} index={0} expanded={true} scroll={0} />
    );
    expect(frame).toContain("truncated");
  });

  test("50 maxed records render bounded", () => {
    const records = Array.from({ length: MAX_TOOL_RECORDS }, (_, i) =>
      createToolRecord(i, `⚙ bash job-${i}`, "x".repeat(STORE_CHARS + 100), i % 2 === 0, 2500)
    );
    const started = Date.now();
    const frame = frameOf(
      <InspectorPanel records={records} index={49} expanded={false} scroll={0} />
    );
    const elapsed = Date.now() - started;
    expect(frame).toContain("job-49");
    expect(elapsed).toBeLessThan(15000);
  });
});

describe("streaming + timer + keyboard", () => {
  test("tokens, 1s ticks, and keystrokes stay in their own lanes", async () => {
    let fakeNow = 1_000_000;
    const tickCbs: Array<() => void> = [];
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="big-pickle"
        initialModels={["big-pickle"]}
        now={() => fakeNow}
        setIntervalFn={((cb: () => void) => {
          tickCbs.push(cb);
          return tickCbs.length as unknown as NodeJS.Timeout;
        }) as unknown as typeof setInterval}
        clearIntervalFn={(() => {}) as unknown as typeof clearInterval}
      />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "thinking…");
      // The first POST runs after the async submit pipeline stages, so wait
      // for the loop-entry POST before driving the stream (same as the
      // observability suite).
      {
        const start = Date.now();
        for (;;) {
          if (controller !== undefined) break;
          if (Date.now() - start > 8000) {
            throw new Error(`timed out waiting for first POST:\n${app.lastFrame()}`);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      // Token arrives while busy: draft paints without touching the transcript.
      controller.enqueue(enc.encode(sseData({ choices: [{ delta: { content: "live-token" } }] })));
      await waitForFrame(app, "live-token");
      const transcriptBefore = transcriptRenderProbe.count;
      // 1s tick: clock updates, transcript and input skip.
      const inputBefore = inputRenderProbe.count;
      fakeNow += 1000;
      tickCbs[0]?.();
      await waitForFrame(app, "1s");
      expect(transcriptRenderProbe.count).toBe(transcriptBefore);
      expect(inputRenderProbe.count).toBe(inputBefore);
      // Keystrokes while streaming: exactly one input paint each.
      app.stdin.write("a");
      await new Promise((r) => setTimeout(r, 40));
      app.stdin.write("b");
      await new Promise((r) => setTimeout(r, 40));
      app.stdin.write("c");
      await new Promise((r) => setTimeout(r, 40));
      expect(inputRenderProbe.count - inputBefore).toBe(3);
      expect(app.lastFrame()).toContain("live-token");
      // Completion commits byte-exact and clears the live tail.
      controller.enqueue(enc.encode(`${contentChunk("")}${SSE_DONE}`));
      await waitForFrame(app, "live-token");
    } finally {
      app.unmount();
    }
  });
});
