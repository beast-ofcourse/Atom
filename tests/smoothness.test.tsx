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
import { LiveTail } from "../src/ui/live-tail.js";
import { approvalRenderProbe, questionRenderProbe } from "../src/ui/modals.js";
import { statusBarRenderProbe } from "../src/ui/status-bar.js";
import { todoPanelRenderProbe } from "../src/ui/todo-panel.js";
import { ApprovalBox, QuestionBox } from "../src/ui/modals.js";
import { StatusBar } from "../src/ui/status-bar.js";
import { TodoPanel } from "../src/ui/todo-panel.js";
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
      // New transcript identity still renders (memo is not stuck). The
      // commit takes two View passes (render + suffix-admission), but the
      // new row mounts exactly once.
      const more: Turn[] = [...turns, { role: "user", content: "again" }];
      const rowsBefore = itemCalls;
      app.rerender(
        <TranscriptView turns={more} clearGen={0} renderItem={renderItem} />
      );
      expect(transcriptRenderProbe.count).toBe(probeBefore + 2);
      expect(itemCalls - rowsBefore).toBeLessThanOrEqual(2);
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
      await waitForFrame(app, "thinking…");
      expect(tickCbs).toHaveLength(1);
      const probeBefore = transcriptRenderProbe.count;
      fakeNow += 1000;
      tickCbs[0]?.();
      await waitForFrame(app, "1s");
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
      await waitForFrame(app, "thinking…");
      expect(tickCbs).toHaveLength(1);
      const beforeTick = inputRenderProbe.count;
      fakeNow += 1000;
      tickCbs[0]?.();
      await waitForFrame(app, "1s");
      expect(inputRenderProbe.count).toBe(beforeTick);
    } finally {
      app.unmount();
    }
  });
});

describe("autoscroll command", () => {
  function mountApp() {
    return render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="big-pickle"
        initialModels={["big-pickle"]}
      />
    );
  }

  async function submitLine(
    app: { stdin: { write: (s: string) => void } },
    line: string
  ): Promise<void> {
    app.stdin.write(line);
    await new Promise((r) => setTimeout(r, 40));
    app.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));
  }

  test("bare toggles off→on→off (off by default); on/off set explicitly", async () => {
    const app = mountApp();
    try {
      await submitLine(app, "/autoscroll");
      await waitForFrame(app, "autoscroll on — following the latest");
      await submitLine(app, "/autoscroll");
      await waitForFrame(app, "autoscroll off — the view freezes");
      await submitLine(app, "/autoscroll on");
      await waitForFrame(app, "autoscroll on — following the latest");
      await submitLine(app, "/autoscroll on");
      await waitForFrame(app, "already on");
    } finally {
      app.unmount();
    }
  });

  test("invalid arg prints usage; explicit off is idempotent", async () => {
    const app = mountApp();
    try {
      await submitLine(app, "/autoscroll sideways");
      await waitForFrame(app, "usage: /autoscroll [on|off]");
      await submitLine(app, "/autoscroll off");
      await waitForFrame(app, "already off");
    } finally {
      app.unmount();
    }
  });

  test("off (the default) freezes a following view mid-turn (pending indicator, no yank)", async () => {
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}) // never resolves: turn stays busy
    );
    const app = mountApp();
    try {
      await submitLine(app, "hi");
      // The user's own message lands below a frozen viewport instead of
      // yanking it: the pending indicator offers the jump back.
      await waitForFrame(app, "new — End for latest");
    } finally {
      app.unmount();
    }
  });

  test("runs while busy (view-only, never touches the turn)", async () => {
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}) // never resolves: turn stays busy
    );
    const app = mountApp();
    try {
      await submitLine(app, "hi");
      await waitForFrame(app, "thinking…");
      await submitLine(app, "/autoscroll");
      await waitForFrame(app, "autoscroll on — following the latest");
      await submitLine(app, "/autoscroll");
      await waitForFrame(app, "autoscroll off — the view freezes");
    } finally {
      app.unmount();
    }
  });
});

describe("leaf memoization (flicker fix)", () => {
  test("StatusBar skips same-props churn, paints changed props", () => {
    const props = {
      provider: "p",
      model: "m",
      usageTotals: null,
      contextLoad: null,
      reasoningDisplay: "default",
      mode: "normal",
      trustAll: false,
      busy: false,
      phaseLabel: "idle",
      elapsedSecs: 0,
      stalled: false,
      approvalPending: false,
    };
    const app = render(<StatusBar {...props} />);
    try {
      const base = statusBarRenderProbe.count;
      app.rerender(<StatusBar {...props} />);
      expect(statusBarRenderProbe.count).toBe(base);
      app.rerender(<StatusBar {...props} elapsedSecs={1} busy />);
      expect(statusBarRenderProbe.count).toBe(base + 1);
    } finally {
      app.unmount();
    }
  });

  test("ApprovalBox skips ticks, paints nav selection once", () => {
    const props = { toolName: "read", description: "⚙ read a.txt", selected: 0, diff: null };
    const app = render(<ApprovalBox {...props} />);
    try {
      const base = approvalRenderProbe.count;
      app.rerender(<ApprovalBox {...props} />);
      expect(approvalRenderProbe.count).toBe(base);
      app.rerender(<ApprovalBox {...props} selected={1} />);
      expect(approvalRenderProbe.count).toBe(base + 1);
    } finally {
      app.unmount();
    }
  });

  test("QuestionBox skips ticks, paints nav selection once", () => {
    const props = {
      question: "Pick?",
      options: ["a", "b"],
      allowCustom: false,
      askCustom: "",
      askSelIndex: 0,
    };
    const app = render(<QuestionBox {...props} />);
    try {
      const base = questionRenderProbe.count;
      app.rerender(<QuestionBox {...props} />);
      expect(questionRenderProbe.count).toBe(base);
      app.rerender(<QuestionBox {...props} askSelIndex={1} />);
      expect(questionRenderProbe.count).toBe(base + 1);
    } finally {
      app.unmount();
    }
  });

  test("TodoPanel skips same-snapshot churn, paints new snapshots", () => {
    const items = [{ content: "x", status: "pending" as const }];
    const app = render(<TodoPanel items={items} />);
    try {
      const base = todoPanelRenderProbe.count;
      app.rerender(<TodoPanel items={items} />);
      expect(todoPanelRenderProbe.count).toBe(base);
      app.rerender(<TodoPanel items={[...items]} />);
      expect(todoPanelRenderProbe.count).toBe(base + 1);
    } finally {
      app.unmount();
    }
  });
});

describe("thinking command", () => {
  function mountApp() {
    return render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="big-pickle"
        initialModels={["big-pickle"]}
      />
    );
  }

  async function submitLine(
    app: { stdin: { write: (s: string) => void } },
    line: string
  ): Promise<void> {
    app.stdin.write(line);
    await new Promise((r) => setTimeout(r, 40));
    app.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));
  }

  test("bare toggles show/hide with confirms; args print usage", async () => {
    const app = mountApp();
    try {
      await submitLine(app, "/thinking");
      await waitForFrame(app, "thinking shown");
      await submitLine(app, "/thinking");
      await waitForFrame(app, "thinking hidden");
      await submitLine(app, "/thinking extra");
      await waitForFrame(app, "usage: /thinking");
    } finally {
      app.unmount();
    }
  });

  test("runs while busy (rendering-only, never touches the turn)", async () => {
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}) // never resolves: turn stays busy
    );
    const app = mountApp();
    try {
      await submitLine(app, "hi");
      await waitForFrame(app, "thinking…");
      await submitLine(app, "/thinking");
      await waitForFrame(app, "thinking shown");
    } finally {
      app.unmount();
    }
  });

  test("TranscriptView thinking toggle is forward-only (static commits)", () => {
    const turns: Turn[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "round one musings", thinking: true },
      { role: "assistant", content: "done" },
    ];
    const app = render(<TranscriptView turns={turns} clearGen={0} showThinking={false} />);
    try {
      // Hidden at commit time stays hidden: Static rows can neither hide
      // nor reshuffle after printing, so the toggle covers the live block
      // plus future rounds, never past commits.
      expect(app.lastFrame()).not.toContain("musings");
      expect(app.lastFrame()).toContain("done");
      app.rerender(<TranscriptView turns={turns} clearGen={0} showThinking />);
      expect(app.lastFrame()).not.toContain("musings");
      // …but rounds committed while shown do print.
      const more: Turn[] = [
        ...turns,
        { role: "assistant", content: "round two musings", thinking: true },
      ];
      app.rerender(<TranscriptView turns={more} clearGen={0} showThinking />);
      expect(app.lastFrame()).toContain("round two musings");
    } finally {
      app.unmount();
    }
  });

  test("LiveTail hides the live thinking block unless shown", () => {
    const base = {
      isEmpty: false,
      sessionHint: false,
      draft: null,
      busy: true,
      elapsedSecs: 3,
      toolHint: null,
      toolElapsedSecs: null,
    } as const;
    const app = render(<LiveTail {...base} thinking="live musings" />);
    try {
      expect(app.lastFrame()).toContain("live musings"); // default: legacy show
      app.rerender(<LiveTail {...base} thinking="live musings" showThinking={false} />);
      expect(app.lastFrame()).not.toContain("live musings");
    } finally {
      app.unmount();
    }
  });

  test("per-round thinking commits while shown; toggle is forward-only", async () => {    const enc = new TextEncoder();
    const stream = (chunks: string[]): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const x of chunks) c.enqueue(enc.encode(x));
            c.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return stream([
          sse({ choices: [{ delta: { reasoning_content: "first-round musings" } }] }),
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      type: "function",
                      function: { name: "glob", arguments: '{"pattern":"*.ts"}' },
                    },
                  ],
                },
              },
            ],
          }),
          "data: [DONE]\n\n",
        ]);
      }
      return stream([
        sse({ choices: [{ delta: { reasoning_content: "second-round verdict" } }] }),
        sse({ choices: [{ delta: { content: "done" } }] }),
        "data: [DONE]\n\n",
      ]);
    });
    const app = mountApp();
    try {
      await submitLine(app, "/thinking");
      await waitForFrame(app, "thinking shown");
      await submitLine(app, "go");
      // Both rounds committed while shown (first at the next POST, second
      // at turn end).
      await waitForFrame(app, "first-round musings");
      await waitForFrame(app, "second-round verdict");
      await waitForFrame(app, "done");
      // Hide: the live block goes quiet, but already-printed commits stay
      // printed (Static rows can neither hide nor reshuffle) — the toggle
      // is forward-only by design (see THINKING_USAGE).
      await submitLine(app, "/thinking");
      await waitForFrame(app, "thinking hidden");
      await new Promise((r) => setTimeout(r, 200));
      expect(app.lastFrame()).toContain("first-round musings");
      expect(app.lastFrame()).toContain("second-round verdict");
      expect(app.lastFrame()).toContain("done");
      // Show again: past commits are untouched, and the record is intact.
      await submitLine(app, "/thinking");
      await waitForFrame(app, "thinking shown");
      expect(app.lastFrame()).toContain("first-round musings");
    } finally {
      app.unmount();
    }
  });
});
