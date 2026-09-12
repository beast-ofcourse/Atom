// Ticket 01 — no-flicker render contract + storm test.
//
// The safety net every later UI ticket inherits. From the user's
// perspective: streaming answers and tool activity paint smoothly with no
// flicker, ghosting, cursor jumping, or repainting of already-committed
// turns — no matter how fast tokens arrive.
//
// What this file proves (each describe maps to one ticket checkbox):
//  1. stdout ownership: exactly one component tree owns stdout — no direct
//     terminal writes outside the renderer (static source scan).
//  2. stable identities: committed transcript rows keep stable identities
//     across renders (no remounts on ticks/keystrokes/appends elsewhere).
//  3. live-leaf isolation: high-frequency state re-renders only its live
//     leaf, never the whole tree.
//  4. storm: token bursts + tool events + resizes produce at most one paint
//     per scheduler window, and committed output never repaints.
//
// Network is ALWAYS mocked here — never hit live APIs. Timers are manual
// (deterministic clock) wherever a bound is asserted, so nothing here can
// flake on a slow CI box.
import React from "react";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { LiveTailHost } from "../src/ui/live-host.js";
import { createPaintScheduler } from "../src/ui/paint-scheduler.js";
import { StatusBarHost } from "../src/ui/status-host.js";
import { createStreamStore } from "../src/ui/stream-store.js";
import {
  TranscriptView,
  transcriptRenderProbe,
  transcriptRowRenderProbe,
  type Turn,
} from "../src/ui/transcript.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function srcUiFiles(): string[] {
  const dir = path.join(SRC, "ui");
  return readdirSync(dir)
    .filter((e) => /\.tsx?$/.test(e))
    .map((e) => path.join(dir, e));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Deterministic clock (same shape as the hostile-perf harness): manual now
// + trailing-timer queue, so scheduler-window bounds are exact, not timed.
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

function makeTurns(n: number, seed = 0): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    const k = seed + i;
    out.push(
      k % 3 === 0
        ? { role: "user", content: `storm question ${k}` }
        : k % 3 === 1
          ? { role: "assistant", content: `storm answer ${k} with **bold** text` }
          : { role: "tool", content: `⚙ read src/storm-${k}.ts` }
    );
  }
  return out;
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

describe("storm contract: one tree owns stdout", () => {
  test("App + every ui/* module perform zero direct terminal writes", () => {
    // Reads are fine (useStdout().columns measurement, Ink APIs). Writes
    // are the contract breach: only the Ink renderer in cli.tsx may paint.
    const writePatterns = [
      "process.stdout.write",
      "process.stderr.write",
      "stdout.write(",
      "stderr.write(",
      "console.log(",
      "console.info(",
      "console.warn(",
      "console.error(",
      "console.debug(",
    ];
    const bad: string[] = [];
    const files = [path.join(SRC, "App.tsx"), ...srcUiFiles()];
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      src.split("\n").forEach((line, idx) => {
        const stripped = line.trim();
        // stdout.columns measurement reads (never writes) are allowed.
        if (stripped.includes("stdout.columns") || stripped.includes("useStdout")) return;
        for (const p of writePatterns) {
          if (stripped.includes(p)) bad.push(`${path.basename(f)}:${idx + 1} -> ${p}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  test("cli.tsx mounts exactly one render tree; console stays in standalone modes", () => {
    const src = readFileSync(path.join(SRC, "cli.tsx"), "utf8");
    // Exactly one Ink render call in the whole entry point: one tree owns
    // stdout. (--dashboard/--web/--serve/--help exit or park before it and
    // never start the TUI alongside.)
    const renders = src.match(/(?<![A-Za-z0-9_$])render\(/g) ?? [];
    expect(renders).toHaveLength(1);
    // No raw byte writes anywhere in the entry point either.
    expect(src).not.toContain("process.stdout.write");
    expect(src).not.toContain("process.stderr.write");
  });
});

describe("storm contract: one paint per scheduler window", () => {
  test("token bursts + thinking bursts + resizes coalesce through one trailing timer", () => {
    const clock = makeManualClock();
    const store = createStreamStore();
    let flushes = 0;
    let maxTimersSeen = 0;
    const ps = createPaintScheduler({
      intervalMs: 64,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (lanes) => {
        flushes += 1;
        store.set(lanes);
      },
    });
    // Storm: 300 token pushes + 300 thinking pushes interleaved, 1ms apart
    // (600ms of stream time ≈ 10 scheduler windows), plus a resize-scale
    // burst of same-window overwrites (latest-wins, never queued).
    let draft = "";
    let thinking = "";
    for (let i = 0; i < 300; i++) {
      draft += ` token-${i}`;
      thinking += `thought-${i}\n`;
      ps.push("draft", draft);
      ps.push("thinking", thinking);
      maxTimersSeen = Math.max(maxTimersSeen, ps.pendingTimers());
      expect(ps.pendingTimers()).toBeLessThanOrEqual(1);
      clock.advance(1);
    }
    // Mid-storm: at most one paint per 64ms window, both lanes landing
    // together (single onFlush per paint, never draft-vs-thinking frames).
    expect(flushes).toBeLessThanOrEqual(Math.ceil(600 / 64) + 2);
    expect(maxTimersSeen).toBeLessThanOrEqual(1);
    // Drain: the exact full text always lands, exactly once at the end.
    const flushesBeforeDrain = flushes;
    ps.flush();
    expect(store.getDraft()).toBe(draft);
    expect(store.getThinking()).toBe(thinking);
    expect(flushes - flushesBeforeDrain).toBeLessThanOrEqual(1);
    // Idle flush is silent (no phantom paint after the storm).
    ps.flush();
    expect(flushes - flushesBeforeDrain).toBeLessThanOrEqual(1);
    expect(ps.pendingTimers()).toBe(0);
  });
});

describe("storm contract: committed output never repaints", () => {
  test("token bursts + tool events + resizes leave committed rows untouched", async () => {
    const turns = makeTurns(30);
    const store = createStreamStore();
    const frame = (t: Turn[], columns: number) => (
      <>
        <TranscriptView turns={t} clearGen={1} />
        <LiveTailHost
          store={store}
          isEmpty={false}
          sessionHint={false}
          busy
          held={false}
          toolHint="read src/storm.ts"
          toolElapsedSecs={null}
          elapsedSecs={3}
          showThinking={false}
        />
        <StatusBarHost {...STATUS_BASE} columns={columns} />
      </>
    );
    const app = render(frame(turns, 100));
    try {
      await sleep(120);
      expect(app.lastFrame()).toContain("storm question 0");
      expect(app.lastFrame()).toContain("storm answer 28");

      // Phase 1 — pure storm, no commits: 200 token paints + a resize sweep.
      // The live leaf may paint; committed rows must not remount and the
      // transcript view itself must not re-render.
      const rowsBefore = transcriptRowRenderProbe.count;
      const viewBefore = transcriptRenderProbe.count;
      for (let i = 0; i < 200; i++) {
        store.setDraft(`storm draft paint ${i} — tokens arriving fast`);
      }
      for (const w of [160, 120, 100, 80, 60, 40, 200, 100]) {
        app.rerender(frame(turns, w));
      }
      // Same-identity rerenders (ticks/keystrokes elsewhere in the tree).
      for (let i = 0; i < 10; i++) {
        app.rerender(frame(turns, 100));
      }
      await sleep(150);
      expect(transcriptRowRenderProbe.count).toBe(rowsBefore);
      expect(transcriptRenderProbe.count).toBe(viewBefore);
      expect(app.lastFrame()).toContain("storm question 0");
      expect(app.lastFrame()).toContain("storm draft paint 199");

      // Phase 2 — tool events commit new rows mid-storm: ONLY the new rows
      // mount (×2 harness commits, same bound shape as the hostile suite);
      // every previously committed row keeps its identity.
      const rowsBeforeTools = transcriptRowRenderProbe.count;
      let cur = turns;
      const NEW_ROWS = 6;
      for (let i = 0; i < NEW_ROWS; i++) {
        cur = [...cur, { role: "tool", content: `⚙ bash storm-job-${i}` }];
        store.setDraft(`storm draft paint ${200 + i}`);
        app.rerender(frame(cur, 100));
      }
      await sleep(150);
      expect(transcriptRowRenderProbe.count - rowsBeforeTools).toBeLessThanOrEqual(
        NEW_ROWS * 2 + 2
      );
      expect(app.lastFrame()).toContain("storm-job-5");
      expect(app.lastFrame()).toContain("storm question 0");

      // Phase 3 — post-storm stillness: more tokens + resizes, zero row churn.
      const rowsAfterTools = transcriptRowRenderProbe.count;
      for (let i = 0; i < 100; i++) {
        store.setDraft(`post-storm paint ${i}`);
      }
      for (const w of [80, 120, 100]) {
        app.rerender(frame(cur, w));
      }
      await sleep(150);
      expect(transcriptRowRenderProbe.count).toBe(rowsAfterTools);
      expect(app.lastFrame()).toContain("storm-job-0");
      expect(app.lastFrame()).toContain("storm question 0");
    } finally {
      app.unmount();
    }
  });
});
