// Paint scheduler tests: the centralized streaming coalescer — one trailing
// timer for all lanes, latest-wins delivery in a single flush, deterministic
// flush/cancel/reset. Manual clock throughout: no real timers, no flakes.
import { describe, expect, test } from "vitest";
import {
  createPaintScheduler,
  PAINT_INTERVAL_MS,
  type PaintFlush,
} from "../src/ui/paint-scheduler.js";

function makeManualClock() {
  let nowMs = 1_000_000;
  const timers = new Map<number, { at: number; cb: () => void }>();
  let nextId = 1;
  const setTimeoutFn = ((cb: () => void, ms: number) => {
    const id = nextId++;
    timers.set(id, { at: nowMs + Math.max(0, ms), cb });
    return id as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => {
    timers.delete(id as number);
  }) as unknown as typeof clearTimeout;
  function advance(ms: number) {
    const end = nowMs + ms;
    for (;;) {
      let fire: number | null = null;
      for (const [id, t] of timers) {
        if (t.at <= end && (fire === null || timers.get(fire)!.at > t.at)) fire = id;
      }
      if (fire === null) break;
      const t = timers.get(fire)!;
      timers.delete(fire);
      nowMs = t.at;
      t.cb();
    }
    nowMs = end;
  }
  return { now: () => nowMs, setTimeoutFn, clearTimeoutFn, advance, pending: () => timers.size };
}

function makeScheduler(clock: ReturnType<typeof makeManualClock>, intervalMs = PAINT_INTERVAL_MS) {
  const flushed: PaintFlush[] = [];
  const ps = createPaintScheduler({
    intervalMs,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onFlush: (lanes) => flushed.push(lanes),
  });
  return { ps, flushed };
}

describe("paint scheduler", () => {
  test("interval matches one production display frame", () => {
    // ceil(1000/30) — the Ink frame budget (maxFps 30): paints land on
    // render quanta, so the scheduler owns cadence and Ink only coalesces.
    expect(PAINT_INTERVAL_MS).toBe(34);
  });

  test("cadence is one paint per window at any arrival density", () => {
    // Regression for the retired hot/cold rule: identical input painted at
    // different cadences run to run (a hot push inside an armed cold window
    // rode the stale cold timer). One window => bounded paints for a 200 ms
    // storm no matter how the tokens are spaced.
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    let text = "";
    for (let i = 0; i < 200; i++) {
      text += `t${i} `;
      ps.push("draft", text);
      clock.advance(1);
    }
    expect(flushed.length).toBeLessThanOrEqual(Math.ceil(200 / PAINT_INTERVAL_MS) + 1);
    clock.advance(PAINT_INTERVAL_MS);
    expect(flushed.at(-1)).toEqual({ draft: text });
  });

  test("extreme burst coalesces to leading + one trailer; both lanes in one flush", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    let draft = "";
    let thinking = "";
    // 500 interleaved pushes, as fast as the loop can emit them.
    for (let i = 0; i < 250; i++) {
      draft += `tok${i} `;
      thinking += `muse${i} `;
      ps.push("draft", draft);
      ps.push("thinking", thinking);
    }
    // Leading edge painted the very first push immediately; everything else
    // coalesced behind exactly ONE trailing timer.
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual({ draft: "tok0 " });
    expect(ps.pendingTimers()).toBe(1);
    expect(ps.getPending("draft")).toBe(draft);
    expect(ps.getPending("thinking")).toBe(thinking);
    clock.advance(PAINT_INTERVAL_MS);
    // The trailer carries the LATEST of both lanes in a SINGLE flush —
    // one store update, one React render, never two fighting frames.
    expect(flushed).toHaveLength(2);
    expect(flushed[1]).toEqual({ draft, thinking });
    expect(ps.pendingTimers()).toBe(0);
  });

  test("slow stream paints immediately (no added latency)", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    ps.push("draft", "a");
    expect(flushed).toEqual([{ draft: "a" }]);
    clock.advance(PAINT_INTERVAL_MS * 3);
    ps.push("draft", "ab");
    expect(flushed).toEqual([{ draft: "a" }, { draft: "ab" }]);
    expect(ps.pendingTimers()).toBe(0);
  });

  test("bursty stream: latest-wins, one trailer per window, byte-exact convergence", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    let full = "";
    ps.push("draft", "start");
    clock.advance(PAINT_INTERVAL_MS / 2);
    for (let i = 0; i < 100; i++) {
      full += `w${i}-`;
      ps.push("draft", `start${full}`);
    }
    clock.advance(PAINT_INTERVAL_MS);
    const last = flushed.at(-1)!;
    expect(last).toEqual({ draft: `start${full}` });
    // The burst spans a fraction of a window: leading + one trailer —
    // never per-token, regardless of how the pushes land inside it.
    expect(flushed.filter((f) => f.draft !== undefined).length).toBeLessThanOrEqual(4);
  });

  test("one window for dense and sparse streams (no hot/cold flip)", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    ps.push("draft", "a"); // leading: immediate
    expect(flushed).toHaveLength(1);
    // 10 ms later, still inside the window: coalesced behind one trailer.
    clock.advance(10);
    ps.push("draft", "ab");
    expect(flushed).toHaveLength(1);
    expect(ps.pendingTimers()).toBe(1);
    clock.advance(PAINT_INTERVAL_MS);
    expect(flushed).toHaveLength(2);
    expect(flushed[1]).toEqual({ draft: "ab" });
    // Silence does not change the window: the next push is outside it and
    // leads immediately (same rule, no decayed second regime).
    clock.advance(PAINT_INTERVAL_MS * 10);
    ps.push("draft", "abc");
    expect(flushed).toHaveLength(3);
    expect(flushed[2]).toEqual({ draft: "abc" });
    expect(ps.pendingTimers()).toBe(0);
  });

  test("sparse stream paints on arrival (gaps outpace the window)", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    ps.push("draft", "a"); // leading: immediate
    expect(flushed).toHaveLength(1);
    // 50 ms gaps exceed the 34 ms window: every push lands at once —
    // no timer, no added latency, never a per-token spray inside a gap.
    for (let i = 0; i < 4; i++) {
      clock.advance(50);
      ps.push("draft", `a${i}`);
    }
    clock.advance(PAINT_INTERVAL_MS);
    const last = flushed.at(-1)!;
    expect(last).toEqual({ draft: "a3" });
    expect(flushed).toHaveLength(5);
    expect(ps.pendingTimers()).toBe(0);
  });

  test("token flood in one tick still coalesces (≤ 2 flushes)", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    let text = "";
    for (let i = 0; i < 500; i++) {
      text += "x";
      ps.push("draft", text);
    }
    expect(flushed.length).toBeLessThanOrEqual(2);
    clock.advance(PAINT_INTERVAL_MS);
    expect(flushed.at(-1)).toEqual({ draft: text });
  });

  test("flush() delivers pending lanes deterministically, exactly once", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    ps.push("draft", "a");
    ps.push("draft", "ab");
    ps.push("thinking", "hmm");
    ps.flush(); // tool-start / error / done path: paint NOW
    expect(flushed.at(-1)).toEqual({ draft: "ab", thinking: "hmm" });
    expect(ps.pendingTimers()).toBe(0);
    clock.advance(10_000);
    // The trailer never fires twice — completion paints exactly once.
    expect(flushed).toHaveLength(2);
  });

  test("flush() is a no-op when idle (important events stay cheap)", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    ps.flush();
    expect(flushed).toHaveLength(0);
    expect(ps.pendingTimers()).toBe(0);
  });

  test("cancel(lane) drops one lane; the other still paints", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    ps.push("draft", "a");
    ps.push("draft", "ab");
    ps.push("thinking", "hmm");
    ps.cancel("thinking");
    expect(ps.getPending("thinking")).toBeNull();
    expect(ps.getPending("draft")).toBe("ab");
    clock.advance(PAINT_INTERVAL_MS);
    expect(flushed.at(-1)).toEqual({ draft: "ab" });
  });

  test("cancel() drops everything; no trailing paint resurrects text", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    ps.push("draft", "a");
    ps.push("draft", "ab");
    ps.push("thinking", "hmm");
    ps.cancel(); // rollback path: nothing may paint after the clear
    expect(ps.pendingTimers()).toBe(0);
    clock.advance(10_000);
    expect(flushed).toHaveLength(1); // leading paint only
  });

  test("reset() re-arms immediate paint (turn start)", () => {
    const clock = makeManualClock();
    const { ps, flushed } = makeScheduler(clock);
    ps.push("draft", "a");
    ps.push("draft", "ab");
    ps.reset();
    ps.push("draft", "b");
    expect(flushed.at(-1)).toEqual({ draft: "b" });
    expect(ps.pendingTimers()).toBe(0);
  });

  test("single scheduler instance serves both lanes (no dual timers)", () => {
    const clock = makeManualClock();
    const { ps } = makeScheduler(clock);
    // Interleaved lane pushes inside one window share the timer.
    ps.push("draft", "d1");
    ps.push("thinking", "t1");
    ps.push("draft", "d2");
    ps.push("thinking", "t2");
    expect(ps.pendingTimers()).toBeLessThanOrEqual(1);
  });
});

describe("scheduler + store atomicity", () => {
  test("one flush means one store notification (no fighting renders)", async () => {
    const { createStreamStore } = await import("../src/ui/stream-store.js");
    const clock = makeManualClock();
    const store = createStreamStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    const ps = createPaintScheduler({
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onFlush: (lanes) => store.set(lanes),
    });
    // Both lanes pending inside one window…
    ps.push("draft", "d0"); // leading: immediate single-lane paint
    ps.push("draft", "d1");
    ps.push("thinking", "t1");
    const before = notifications;
    clock.advance(PAINT_INTERVAL_MS);
    // …land in exactly ONE notification carrying both values.
    expect(notifications).toBe(before + 1);
    expect(store.getDraft()).toBe("d1");
    expect(store.getThinking()).toBe("t1");
  });
});
