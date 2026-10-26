// Streaming regression for the agent-adapter delta gate: at 50–200 tok/s the
// core emits one event per SSE chunk, and before the gate every delta queued
// a React state update (→ App-body render). These tests simulate variable
// token rates (bursts + slow streams) against a deterministic injected clock
// and pin the guarantees that keep the terminal smooth:
// - burst coalescing: state updates bounded by the paint window, not tokens
// - latest-wins: intermediate deltas never render, final text is exact
// - ordering: pending deltas fold BEFORE a completion/cancel event, and a
//   trailing timer can never fire afterwards (no resurrected text)
// - lane isolation: thinking + message deltas (and their step tags) land in
//   one flush, filed into the right step blocks
// - slow streams paint on arrival (leading-immediate): no added latency
import { describe, expect, test } from "vitest";
import type { AgentEvent, AgentEventWithoutAt } from "../src/agent/events.js";
import {
  createAgentEventSink,
  reduceAgentEvent,
  type AdapterState,
} from "../src/ui/agent-adapter.js";
import { PAINT_INTERVAL_MS } from "../src/ui/paint-scheduler.js";

const AT = "2026-01-01T00:00:00.000Z";

function initialState(): AdapterState {
  return {
    turns: [],
    thinking: null,
    draft: null,
    stepBlocks: [],
    toolHint: null,
    toolElapsedSecs: null,
    busy: false,
    error: null,
    records: [],
  };
}

// Deterministic clock: injectable now/setTimeout/clearTimeout so the paint
// window is exercised exactly, with no real timers.
function makeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
      for (;;) {
        let due: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= t && (due === null || timer.at < due.at)) due = { id, at: timer.at, fn: timer.fn };
        }
        if (!due) break;
        timers.delete(due.id);
        due.fn();
      }
    },
    pendingTimers: () => timers.size,
    setTimeoutFn: ((fn: () => void, ms?: number) => {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms ?? 0), fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: ((id: unknown) => {
      timers.delete(id as number);
    }) as typeof clearTimeout,
  };
}

// A sink wired to a simulated setState: applies folds eagerly and records
// every state update (one update == one potential React render).
function makeSink(clock: ReturnType<typeof makeClock>) {
  let state = initialState();
  const applied: AdapterState[] = [];
  const sink = createAgentEventSink(
    (fold) => {
      state = fold(state);
      applied.push(state);
    },
    {
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    },
  );
  return {
    sink,
    state: () => state,
    applied,
  };
}

const msgDelta = (accumulated: string, step = 0): AgentEvent => ({
  type: "message.delta",
  delta: "",
  accumulated,
  step,
  at: AT,
});
const thinkDelta = (accumulated: string, step = 0): AgentEvent => ({
  type: "agent.thinking.delta",
  delta: "",
  accumulated,
  step,
  at: AT,
});
const event = (e: AgentEventWithoutAt & { at?: string }): AgentEvent =>
  ({ ...e, at: AT }) as AgentEvent;

describe("agent adapter streaming gate", () => {
  test("200 tok/s burst: 500 deltas over 1s coalesce to a bounded number of state updates", () => {
    const clock = makeClock();
    const { sink, state, applied } = makeSink(clock);
    sink.handle(event({ type: "agent.started", turnId: "t1", input: "hi" }));
    for (let i = 0; i < 500; i += 1) {
      sink.handle(msgDelta(`tok-${i} `, 0));
      clock.advance(2); // 500 tok/s ≈ 2 ms/token
    }
    clock.advance(PAINT_INTERVAL_MS); // fire the last trailing paint
    // Bound: leading paint + one trailer per ~34 ms window ≈ 31, not 500.
    expect(applied.length).toBeLessThanOrEqual(35);
    // Final text is exact despite dropped intermediates (cumulative deltas).
    expect(state().draft).toBe(`tok-499 `);
    sink.dispose();
  });

  test("latest-wins: intermediate deltas never render", () => {
    const clock = makeClock();
    const { sink, state, applied } = makeSink(clock);
    sink.handle(event({ type: "agent.started", turnId: "t1", input: "hi" }));
    sink.handle(msgDelta("a", 0));
    sink.handle(msgDelta("ab", 0));
    sink.handle(msgDelta("abc", 0));
    clock.advance(PAINT_INTERVAL_MS);
    // "a" rode the leading paint; "ab" must never appear anywhere.
    expect(applied.some((s) => s.draft === "ab")).toBe(false);
    expect(state().draft).toBe("abc");
    sink.dispose();
  });

  test("pending deltas fold before message.completed; trailing timer never fires afterwards", () => {
    const clock = makeClock();
    const { sink, state, applied } = makeSink(clock);
    sink.handle(msgDelta("partial ", 0)); // leading paint
    sink.handle(msgDelta("partial full", 0)); // arms trailing timer
    sink.handle(event({ type: "message.completed", message: "partial full" }));
    // One fold carries pending delta + completion: turn committed, draft cleared.
    expect(state().turns.some((t) => t.role === "assistant" && t.content === "partial full")).toBe(true);
    expect(state().draft).toBe(null);
    // The armed trailing timer is cancelled: no state update may fire after
    // the completed event.
    const after = applied.length;
    clock.advance(500);
    expect(applied.length).toBe(after);
    expect(clock.pendingTimers()).toBe(0);
    sink.dispose();
  });

  test("React-lazy updater: pending lanes survive a deferred setState fold", () => {
    // React 18 defers setState(fn) updaters until render. This sink delays
    // every fold exactly like that: handle() returns (and the scheduler
    // resets) BEFORE the reducer runs. Pending lanes must be captured at
    // handle() time, not read inside the reducer — reading late silently
    // dropped the last ≤34 ms of stream text from the committed turn.
    const clock = makeClock();
    let state = initialState();
    const folds: Array<(prev: AdapterState) => AdapterState> = [];
    const sink = createAgentEventSink(
      (fold) => folds.push(fold), // deferred: no eager execution
      { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn },
    );
    sink.handle(event({ type: "agent.started", turnId: "t1", input: "hi" }));
    sink.handle(msgDelta("partial ", 0));
    sink.handle(msgDelta("partial full tail", 0)); // pending, timer armed
    sink.handle(event({ type: "message.completed", message: "partial full tail" }));
    // handle() has returned — only now does React execute the updaters.
    for (const fold of folds) state = fold(state);
    expect(
      state.turns.some((t) => t.role === "assistant" && t.content === "partial full tail"),
    ).toBe(true);
    expect(state.draft).toBe(null);
    sink.dispose();
  });

  test("agent.cancelled never resurrects cleared text via a trailing paint", () => {
    const clock = makeClock();
    const { sink, state, applied } = makeSink(clock);
    sink.handle(event({ type: "agent.started", turnId: "t1", input: "hi" }));
    sink.handle(msgDelta("doomed", 0));
    sink.handle(msgDelta("doomed text", 0)); // arms trailing timer
    sink.handle(event({ type: "agent.cancelled", reason: "user" }));
    expect(state().draft).toBe(null);
    expect(state().busy).toBe(false);
    const after = applied.length;
    clock.advance(500);
    expect(applied.length).toBe(after);
    expect(state().draft).toBe(null);
    sink.dispose();
  });

  test("interleaved lanes: thinking + message deltas land in one flush", () => {
    const clock = makeClock();
    const { sink, state, applied } = makeSink(clock);
    sink.handle(thinkDelta("thinking ", 0)); // leading: thinking lane only
    sink.handle(msgDelta("draft ", 0)); // arms trailing
    sink.handle(thinkDelta("thinking more ", 0)); // latest-wins on thinking
    sink.handle(msgDelta("draft more", 0)); // latest-wins on draft
    clock.advance(PAINT_INTERVAL_MS);
    const last = applied[applied.length - 1]!;
    expect(last.thinking).toBe("thinking more ");
    expect(last.draft).toBe("draft more");
    sink.dispose();
  });

  test("step tags survive: multi-step deltas file into their own step blocks", () => {
    const clock = makeClock();
    const { sink, state, applied } = makeSink(clock);
    sink.handle(thinkDelta("step0 thinking", 0)); // leading paint
    sink.handle(msgDelta("step1 answer", 1)); // arms trailing, step 1
    clock.advance(PAINT_INTERVAL_MS);
    const last = applied[applied.length - 1]!;
    const thinkingBlock = last.stepBlocks.find((b) => b.kind === "thinking");
    const textBlock = last.stepBlocks.find((b) => b.kind === "text");
    expect(thinkingBlock?.stepId).toBe("step-0");
    expect(thinkingBlock?.text).toBe("step0 thinking");
    expect(textBlock?.stepId).toBe("step-1");
    expect(textBlock?.text).toBe("step1 answer");
    sink.dispose();
  });

  test("slow stream (25 tok/s): every delta paints on arrival, no added latency", () => {
    const clock = makeClock();
    const { sink, state, applied } = makeSink(clock);
    sink.handle(event({ type: "agent.started", turnId: "t1", input: "hi" }));
    for (let i = 0; i < 20; i += 1) {
      sink.handle(msgDelta(`w${i} `, 0));
      clock.advance(50); // 20 tok/s — gaps exceed the paint window
      expect(clock.pendingTimers()).toBe(0); // each delta painted immediately
    }
    expect(applied.length).toBe(21); // agent.started fold + 20 leading paints
    expect(state().draft).toBe("w19 ");
    sink.dispose();
  });

  test("variable rate (bursts + gaps mixed) keeps final state exact", () => {
    const clock = makeClock();
    const { sink, state } = makeSink(clock);
    sink.handle(event({ type: "agent.started", turnId: "t1", input: "hi" }));
    let text = "";
    for (let i = 0; i < 60; i += 1) {
      text += `seg${i} `;
      sink.handle(msgDelta(text, 0));
      // Alternating: 1 ms gaps (burst) and 40 ms gaps (slow) — 40 > window.
      clock.advance(i % 2 === 0 ? 1 : 40);
    }
    clock.advance(PAINT_INTERVAL_MS);
    expect(state().draft).toBe(text);
    // Reducer purity: replaying the final state through the last delta is a
    // no-op reference check that the gate never invented state.
    expect(state().draft).toBe(reduceAgentEvent(state(), msgDelta(text, 0)).draft);
    sink.dispose();
  });
});
