// Centralized streaming paint scheduler: ONE trailing timer for every live
// lane (answer draft + thinking).
//
// EVENT FREQUENCY != RENDER FREQUENCY: tokens may arrive hundreds per
// second, but terminal paints coalesce to at most one per interval, always
// carrying the latest pending text per lane, delivered in a SINGLE onFlush
// call so draft + thinking land in the same React render instead of
// fighting across two frames.
//
// ADAPTIVE CADENCE (Extreme-fast 1A): the interval is hot (16 ms ≈ 60 fps)
// while tokens arrive denser than the hot window, and cold (64 ms) the
// moment arrivals go sparse. Rationale, measured: hotter cadence on sparse
// streams only splits paints without adding smoothness (paced bench:
// +30% frames, +13% bytes for zero visible win), while dense streams
// genuinely paint ~4×. So the hot rule keys on arrival density, not mere
// recency: paint faster only when tokens outpace the hot window — bytes
// grow exactly where smoothness improves, nowhere else. Leading immediate
// paint after idle is unchanged (no stream-start latency); idle cost is
// unchanged (one window, then silence). Rules it enforces:
// - latest-wins per lane (never queue stale paints behind each other)
// - leading immediate paint after idle (no typing/stream-start latency)
// - trailing coalescing inside the window (no per-token renders)
// - deterministic flush() for turn end, tool transitions, errors, and
//   completion (the final state always paints exactly once)
// - cancel() drops pending text AND the timer, so a trailing paint can
//   never resurrect stale content after a clear/rollback
// - timer failure degrades to immediate paint (never lose content)
//
// The interval is injected (App passes DRAFT_THROTTLE_MS); the default
// matches it. For unit tests, now/clock are injectable like the throttler's.
export const PAINT_INTERVAL_MS = 64;
// Hot window while tokens flow (~60 fps target, coalesced — not per-token
// renders). Single source for the adaptive scheduler + its tests.
export const PAINT_HOT_INTERVAL_MS = 16;
// Silence after which the next push is treated as a cold (idle-window) push.
// Subsumed by the density rule (any gap over the hot window is cold) — kept
// as the documented ceiling and the test pin for idle behavior.
export const PAINT_IDLE_DECAY_MS = 500;

export type PaintLane = "draft" | "thinking";

// Only lanes with pending text are present (absent = unchanged). The
// consumer applies the whole object in one state update — one render.
export type PaintFlush = { draft?: string; thinking?: string };

export type PaintSchedulerOptions = {
  intervalMs?: number;
  /** Hot window while arrivals outpace it (default PAINT_HOT_INTERVAL_MS). */
  hotIntervalMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onFlush: (lanes: PaintFlush) => void;
};

export type PaintScheduler = {
  /** Latest-wins per lane; paints immediately when outside the window. */
  push: (lane: PaintLane, text: string) => void;
  /** Paint all pending lanes now (no-op when nothing is pending). */
  flush: () => void;
  /** Drop pending text (one lane, or all) and any scheduled paint. */
  cancel: (lane?: PaintLane) => void;
  /** cancel() + re-arm so the next push paints immediately (turn start). */
  reset: () => void;
  getPending: (lane: PaintLane) => string | null;
  /** 0 or 1 — at most one trailing paint is ever scheduled. */
  pendingTimers: () => number;
};

export function createPaintScheduler(opts: PaintSchedulerOptions): PaintScheduler {
  const intervalMs = opts.intervalMs ?? PAINT_INTERVAL_MS;
  const hotIntervalMs = opts.hotIntervalMs ?? PAINT_HOT_INTERVAL_MS;
  const nowFn = opts.now ?? Date.now;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const onFlush = opts.onFlush;
  const pending = new Map<PaintLane, string>();
  let lastFlush = Number.NEGATIVE_INFINITY;
  // Last push timestamp: the hot/cold decision reads the gap since the
  // PREVIOUS push (updated at the end of push, so the first push after a
  // reset/creation is always cold — leading-paint rules still fire first).
  // Hot while arrivals outpace the hot window; anything sparser paints at
  // the idle cadence (measured: hotter-on-sparse only bloats bytes).
  let lastPush = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function safeNow(): number {
    try {
      return nowFn();
    } catch {
      return Date.now();
    }
  }

  function clearTimer() {
    if (timer !== null) {
      try {
        clearT(timer);
      } catch {
        // ignore (a stray trailing paint is harmless — flush() already ran)
      }
      timer = null;
    }
  }

  // Single paint path (also the never-lose-content fallback).
  function emit(at: number) {
    if (pending.size === 0) {
      clearTimer();
      return;
    }
    clearTimer();
    const lanes: PaintFlush = {};
    const draft = pending.get("draft");
    const thinking = pending.get("thinking");
    if (draft !== undefined) lanes.draft = draft;
    if (thinking !== undefined) lanes.thinking = thinking;
    pending.clear();
    lastFlush = at;
    onFlush(lanes);
  }

  return {
    push(lane: PaintLane, text: string) {
      pending.set(lane, text);
      const t = safeNow();
      // Hot while pushes arrive denser than the hot window, cold the moment
      // they go sparse: hot streams paint at ~60 fps, sparse streams keep
      // the cheap 64 ms window (bytes grow only where smoothness improves).
      const windowMs = t - lastPush <= hotIntervalMs ? hotIntervalMs : intervalMs;
      lastPush = t;
      if (t - lastFlush >= windowMs) {
        emit(t);
        return;
      }
      if (timer !== null) return; // trailing paint already scheduled
      const wait = windowMs - (t - lastFlush);
      try {
        timer = setT(() => {
          timer = null;
          emit(safeNow());
        }, Math.max(0, wait));
      } catch {
        // No timer available: paint now rather than lose the token.
        emit(safeNow());
      }
    },
    flush() {
      if (pending.size === 0) {
        clearTimer();
        return;
      }
      emit(safeNow());
    },
    cancel(lane?: PaintLane) {
      if (lane === undefined) {
        pending.clear();
      } else {
        pending.delete(lane);
      }
      if (pending.size === 0) clearTimer();
    },
    reset() {
      pending.clear();
      clearTimer();
      lastFlush = Number.NEGATIVE_INFINITY;
      lastPush = Number.NEGATIVE_INFINITY;
    },
    getPending(lane: PaintLane) {
      return pending.get(lane) ?? null;
    },
    pendingTimers() {
      return timer === null ? 0 : 1;
    },
  };
}
