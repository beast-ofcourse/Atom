// Hostile performance review harness: production-scale workload simulated
// against probe counts, not wall-clock flakes. Every test pins a
// propagation bound — how many units of work each event class may cause.
// Network is ALWAYS mocked here — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { App, appRenderProbe, createDraftThrottler } from "../src/App.js";
import { createStreamStore } from "../src/ui/stream-store.js";
import { LiveTailHost } from "../src/ui/live-host.js";
import { StatusBarHost } from "../src/ui/status-host.js";
import { inputRenderProbe } from "../src/ui/input.js";
import { streamParseProbe } from "../src/ui/markdown.js";
import { statusBarRenderProbe } from "../src/ui/status-bar.js";
import { SideBySideDiffView } from "../src/ui/side-by-side.js";
import {
  TranscriptView,
  transcriptRenderProbe,
  transcriptRowRenderProbe,
  type Turn,
} from "../src/ui/transcript.js";

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

function makeTurns(n: number, seed = 0): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    const k = seed + i;
    out.push(
      k % 3 === 0
        ? { role: "user", content: `question ${k} — what is the plan?` }
        : k % 3 === 1
          ? { role: "assistant", content: `answer ${k} with **bold** and \`code\` plus a list\n- a\n- b` }
          : { role: "tool", content: `⚙ read src/file-${k}.ts` }
    );
  }
  return out;
}

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

const STATUS_BASE = {
  provider: "kilo",
  model: "big-pickle",
  usageTotals: null,
  contextLoad: null,
  reasoningDisplay: "default",
  mode: "normal",
  trustAll: false,
  busy: false,
  phaseLabel: "thinking…",
  elapsedSecs: 0,
  stalled: false,
  approvalPending: false,
  cwd: "~/proj",
  branch: "main",
} as const;

describe("hostile: 10k historical messages", () => {
  test("mount commits once to scrollback; burst appends mount only new rows", () => {
    const turns = makeTurns(10000);
    const started = Date.now();
    const rowsBefore = transcriptRowRenderProbe.count;
    const app = render(<TranscriptView turns={turns} clearGen={0} />);
    try {
      const mountMs = Date.now() - started;
      // Static admission: every row mounts exactly once (×2 harness
      // commits), then never again — terminal scrollback holds overflow.
      expect(transcriptRowRenderProbe.count - rowsBefore).toBeLessThanOrEqual(20004);
      expect(app.lastFrame()).toContain("question 9999");
      expect(app.lastFrame()).toContain("question 0");
      expect(mountMs).toBeLessThan(60000);
      // Burst of 20 tool calls: only new rows mount, history untouched.
      const burst = [...turns];
      for (let i = 0; i < 20; i++) {
        burst.push({ role: "tool", content: `⚙ bash job-${i}` });
      }
      const before = transcriptRowRenderProbe.count;
      const t0 = Date.now();
      app.rerender(<TranscriptView turns={burst} clearGen={0} />);
      expect(Date.now() - t0).toBeLessThan(10000);
      expect(transcriptRowRenderProbe.count - before).toBeLessThanOrEqual(44);
      expect(app.lastFrame()).toContain("job-19");
    } finally {
      app.unmount();
    }
  });
});

describe("hostile: continuous high-rate streaming", () => {
  test("5000 pushes coalesce to throttled paints; producer never blocks", async () => {
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
    const app = render(
      <LiveTailHost
        store={store}
        isEmpty={false}
        sessionHint={false}
        busy
        held={false}
        toolHint={null}
        toolElapsedSecs={null}
        elapsedSecs={0}
        showThinking={false}
      />
    );
    try {
      const parsesBefore = streamParseProbe.count;
      const t0 = Date.now();
      let body = "";
      for (let i = 0; i < 5000; i++) {
        body += ` token-${i}`;
        th.push(body);
        clock.advance(6); // 30s of stream time
      }
      th.flush();
      const pushMs = Date.now() - t0;
      // ~30s at 64ms ⇒ ≤ ~500 paints; each paint parses exactly once.
      expect(notifies).toBeLessThanOrEqual(520);
      expect(streamParseProbe.count - parsesBefore).toBeLessThanOrEqual(520);
      expect(store.getDraft()).toBe(body);
      // Producer side is synchronous CPU only — never waits on Ink.
      expect(pushMs).toBeLessThan(8000);
      // Publication is async (React schedules); poll for the paint.
      await waitForFrame(app, "token-4999");
    } finally {
      app.unmount();
    }
  });

  test("elapsed ticks with frozen draft parse nothing", () => {
    const store = createStreamStore();
    store.setDraft("held **draft** text");
    const renderHost = (secs: number) => (
      <LiveTailHost
        store={store}
        isEmpty={false}
        sessionHint={false}
        busy
        held={false}
        toolHint={null}
        toolElapsedSecs={null}
        elapsedSecs={secs}
        showThinking={false}
      />
    );
    const app = render(renderHost(10));
    try {
      const before = streamParseProbe.count;
      for (let s = 11; s <= 20; s++) {
        app.rerender(renderHost(s));
      }
      // 10 ticks, identical draft: zero reparses (MarkdownStream memo).
      expect(streamParseProbe.count).toBe(before);
    } finally {
      app.unmount();
    }
  });
});

describe("hostile: timer + input + streaming propagation matrix", () => {
  test("App-level: tokens skip App, ticks skip leaves, keys paint input once", async () => {
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
      {
        const start = Date.now();
        for (;;) {
          if (controller !== undefined) break;
          if (Date.now() - start > 8000) throw new Error("no first POST");
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      // First token also carries the thinking→streaming phase transition
      // (a legitimate App render: the status bar must switch modes).
      controller.enqueue(enc.encode(sseData({ choices: [{ delta: { content: "burst-token" } }] })));
      await waitForFrame(app, "burst-token");
      const appSteady = appRenderProbe.count;
      // At most the phase transition (+1) plus one unbatched companion
      // setState may run App; steady state afterwards must be silent.
      expect(appSteady).toBeGreaterThan(0);
      const transcriptBefore = transcriptRenderProbe.count;
      const rowsBefore = transcriptRowRenderProbe.count;
      const inputBefore = inputRenderProbe.count;
      const statusBefore = statusBarRenderProbe.count;
      // Steady-state token: no phase change, so App must not run at all.
      controller.enqueue(enc.encode(sseData({ choices: [{ delta: { content: "burst-token second-token" } }] })));
      await waitForFrame(app, "second-token");
      expect(appRenderProbe.count).toBe(appSteady);
      expect(transcriptRenderProbe.count).toBe(transcriptBefore);
      expect(transcriptRowRenderProbe.count).toBe(rowsBefore);
      expect(statusBarRenderProbe.count).toBe(statusBefore);
      // Tick: App runs once (clock), every leaf bails except the status bar.
      fakeNow += 1000;
      tickCbs[0]?.();
      await waitForFrame(app, "1s");
      expect(appRenderProbe.count).toBe(appSteady + 1);
      expect(transcriptRenderProbe.count).toBe(transcriptBefore);
      expect(transcriptRowRenderProbe.count).toBe(rowsBefore);
      expect(inputRenderProbe.count).toBe(inputBefore);
      expect(statusBarRenderProbe.count).toBe(statusBefore + 1);
      // Rapid keys while streaming: input paints once each, nothing else moves.
      for (const ch of ["x", "y", "z"]) {
        app.stdin.write(ch);
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(inputRenderProbe.count - inputBefore).toBe(3);
      expect(transcriptRenderProbe.count).toBe(transcriptBefore);
      expect(transcriptRowRenderProbe.count).toBe(rowsBefore);
      expect(statusBarRenderProbe.count).toBe(statusBefore + 1);
      expect(app.lastFrame()).toContain("burst-token");
      controller.enqueue(enc.encode(SSE_DONE));
      controller.close();
      await waitForFrame(app, "burst-token");
    } finally {
      app.unmount();
    }
  });
});

describe("hostile: terminal resize storms", () => {
  test("width sweeps refit without multiplicative renders", () => {
    // Idle bar shows provider/model/cwd (busy layout drops them by design).
    const props = { ...STATUS_BASE, busy: false as const };
    const app = render(<StatusBarHost {...props} columns={200} />);
    try {
      const before = statusBarRenderProbe.count;
      for (const w of [160, 120, 100, 80, 60, 40, 200]) {
        app.rerender(<StatusBarHost {...props} columns={w} />);
      }
      // One render per width change, never a storm multiplier.
      expect(statusBarRenderProbe.count - before).toBeLessThanOrEqual(14);
      expect(app.lastFrame()).toContain("big-pickle");
    } finally {
      app.unmount();
    }
  });

  test("side-by-side degrades to unified on narrow terminals", () => {
    // No BEFORE/AFTER pane headers by design (quiet summary line instead —
    // see diff-panes-current.test.tsx): wide asserts both panes, narrow
    // asserts the unified degrade. Wide renders at columns=100 so both
    // panes fit the 100-col test viewport (ink-testing-library).
    const wide = render(
      <SideBySideDiffView oldText={"a\nOLD\n"} newText={"a\nNEW\n"} lang={null} columns={100} />
    );
    try {
      const frame = wide.lastFrame() ?? "";
      expect(frame).toContain("OLD");
      expect(frame).toContain("NEW");
    } finally {
      wide.unmount();
    }
    const narrow = render(
      <SideBySideDiffView oldText={"a\nOLD\n"} newText={"a\nNEW\n"} lang={null} columns={40} />
    );
    try {
      const frame = narrow.lastFrame() ?? "";
      expect(frame).toContain("NEW");
      expect(frame).not.toContain("BEFORE");
    } finally {
      narrow.unmount();
    }
  });
});

describe("hostile: allocation sanity", () => {
  test("10k-turn append copies only refs and stays fast", () => {
    const turns = makeTurns(10000);
    const t0 = Date.now();
    let cur = turns;
    for (let i = 0; i < 50; i++) {
      cur = [...cur, { role: "tool", content: `⚙ bash burst-${i}` }];
    }
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(cur.length).toBe(10050);
  });
});
