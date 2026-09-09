// Task B smoothness tests: throttled streaming drafts (byte-exact
// convergence, flush-on-done) and 1s-timer isolation from the transcript.
// Network is ALWAYS mocked here — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import {
  App,
  DRAFT_THROTTLE_MS,
  createDraftThrottler,
} from "../src/App.js";
import { inputRenderProbe } from "../src/ui/input.js";
import {
  TranscriptView,
  renderTranscriptItem,
  transcriptRenderProbe,
  type StaticItem,
  type Turn,
} from "../src/ui/transcript.js";

const ESC_CH = String.fromCharCode(27);

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// Deterministic manual clock: no fake-timer globals, full control over when
// trailing paints fire.
function makeManualClock() {
  let nowMs = 0;
  const timers = new Map<number, { cb: () => void; at: number }>();
  let seq = 1;
  const setTimeoutFn = ((cb: (...args: unknown[]) => void, ms?: number) => {
    const id = seq++;
    const delay = ms ?? 0;
    timers.set(id, {
      cb: () => cb(),
      at: nowMs + delay,
    });
    return id as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => {
    timers.delete(id as number);
  }) as unknown as typeof clearTimeout;
  function advance(ms: number) {
    nowMs += ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of timers) {
        if (t.at <= nowMs && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) return;
      const t = timers.get(nextId);
      timers.delete(nextId);
      t?.cb();
    }
  }
  return {
    now: () => nowMs,
    setTimeoutFn,
    clearTimeoutFn,
    advance,
    pendingTimers: () => timers.size,
  };
}

function makeThrottler(clock: ReturnType<typeof makeManualClock>) {
  const flushed: string[] = [];
  const th = createDraftThrottler({
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onFlush: (t) => flushed.push(t),
  });
  return { th, flushed };
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

describe("draft throttler", () => {
  test("throttle window is ~64ms", () => {
    expect(DRAFT_THROTTLE_MS).toBe(64);
  });

  test("rapid burst coalesces; trailing paint converges byte-exact", () => {
    const clock = makeManualClock();
    const { th, flushed } = makeThrottler(clock);
    let full = "";
    for (let i = 0; i < 50; i++) {
      full += `tok${i} `;
      th.push(full);
    }
    // First push paints immediately; the other 49 coalesce into one trailer.
    expect(flushed).toEqual(["tok0 "]);
    expect(clock.pendingTimers()).toBe(1);
    expect(th.getPending()).toBe(full);
    clock.advance(DRAFT_THROTTLE_MS);
    expect(flushed).toHaveLength(2);
    expect(flushed.at(-1)).toBe(full);
    expect(th.getPending()).toBeNull();
    expect(clock.pendingTimers()).toBe(0);
  });

  test("flush() delivers the exact full text without advancing the clock", () => {
    const clock = makeManualClock();
    const { th, flushed } = makeThrottler(clock);
    let full = "";
    for (let i = 0; i < 10; i++) {
      full += `w${i}-`;
      th.push(full);
    }
    th.flush(); // done-signal: never lose trailing tokens
    expect(flushed.at(-1)).toBe(full);
    expect(th.getPending()).toBeNull();
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(1000);
    expect(flushed.filter((f) => f === full)).toHaveLength(1);
  });

  test("paints resume at full rate once the window passes", () => {
    const clock = makeManualClock();
    const { th, flushed } = makeThrottler(clock);
    th.push("a");
    expect(flushed).toEqual(["a"]);
    clock.advance(DRAFT_THROTTLE_MS);
    th.push("ab");
    expect(flushed).toEqual(["a", "ab"]);
    th.push("abc"); // same tick: coalesced, not painted
    expect(flushed).toEqual(["a", "ab"]);
    clock.advance(DRAFT_THROTTLE_MS);
    expect(flushed).toEqual(["a", "ab", "abc"]);
  });

  test("cancel() drops pending text; reset() re-arms immediate paint", () => {
    const clock = makeManualClock();
    const { th, flushed } = makeThrottler(clock);
    th.push("a");
    th.push("ab");
    th.cancel();
    clock.advance(1000);
    expect(flushed).toEqual(["a"]);
    expect(th.getPending()).toBeNull();
    th.reset();
    th.push("b");
    expect(flushed).toEqual(["a", "b"]);
  });
});

describe("timer isolation", () => {
  test("TranscriptView memo: same-props rerender skips Static children", () => {
    const turns: Turn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    let itemCalls = 0;
    const renderItem = (item: StaticItem) => {
      itemCalls += 1;
      return renderTranscriptItem(item);
    };
    const app = render(
      <TranscriptView turns={turns} clearGen={0} renderItem={renderItem} />
    );
    try {
      // Banner + 2 turns render once on mount.
      expect(itemCalls).toBe(3);
      const probeBefore = transcriptRenderProbe.count;
      // Same props (simulating a parent re-render like a timer tick).
      app.rerender(
        <TranscriptView turns={turns} clearGen={0} renderItem={renderItem} />
      );
      expect(transcriptRenderProbe.count).toBe(probeBefore);
      expect(itemCalls).toBe(3);
      // New transcript identity still renders (memo is not stuck).
      const more: Turn[] = [...turns, { role: "user", content: "again" }];
      app.rerender(
        <TranscriptView turns={more} clearGen={0} renderItem={renderItem} />
      );
      expect(transcriptRenderProbe.count).toBe(probeBefore + 1);
      expect(app.lastFrame()).toContain("again");
    } finally {
      app.unmount();
    }
  });

  test("App 1s tick updates the status clock without re-rendering the transcript", async () => {
    let fakeNow = 1_000_000;
    const tickCbs: Array<() => void> = [];
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}) // never resolves: turn stays busy
    );
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
      await waitForFrame(app, "thinking… 0s");
      expect(tickCbs).toHaveLength(1);
      const probeBefore = transcriptRenderProbe.count;
      fakeNow += 1000;
      tickCbs[0]?.();
      await waitForFrame(app, "thinking… 1s");
      // The tick ran (clock updated) but the Static subtree never re-rendered.
      expect(transcriptRenderProbe.count).toBe(probeBefore);
    } finally {
      app.unmount();
    }
  });

  test("input paints exactly once per keystroke; busy ticks skip idle input", async () => {
    let fakeNow = 1_000_000;
    const tickCbs: Array<() => void> = [];
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}) // never resolves: turn stays busy
    );
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
      await new Promise((r) => setTimeout(r, 100));
      const base = inputRenderProbe.count;
      // Two chars = two handler calls = two input paints, no more.
      app.stdin.write("h");
      await new Promise((r) => setTimeout(r, 40));
      app.stdin.write("i");
      await new Promise((r) => setTimeout(r, 40));
      expect(inputRenderProbe.count - base).toBe(2);
      // Three arrows: cursor 2→1→0 paints twice; 0→0 bails out via setState
      // equality, painting nothing.
      const beforeArrows = inputRenderProbe.count;
      for (let k = 0; k < 3; k++) {
        app.stdin.write(`${ESC_CH}[D`);
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(inputRenderProbe.count - beforeArrows).toBe(2);
      // Busy with idle input: 1s ticks must not repaint the input box.
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "thinking… 0s");
      expect(tickCbs).toHaveLength(1);
      const beforeTick = inputRenderProbe.count;
      fakeNow += 1000;
      tickCbs[0]?.();
      await waitForFrame(app, "thinking… 1s");
      expect(inputRenderProbe.count).toBe(beforeTick);
    } finally {
      app.unmount();
    }
  });
});
