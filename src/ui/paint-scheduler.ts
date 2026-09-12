// Centralized streaming paint scheduler: ONE trailing timer for every live
// lane (answer draft + thinking).
//
// EVENT FREQUENCY != RENDER FREQUENCY: tokens may arrive hundreds per
// second, but terminal paints coalesce to at most one per interval, always
// carrying the latest pending text per lane, delivered in a SINGLE onFlush
// call so draft + thinking land in the same React render instead of
// fighting across two frames.
//
// Rules it enforces:
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

export type PaintLane = "draft" | "thinking";

// Only lanes with pending text are present (absent = unchanged). The
// consumer applies the whole object in one state update — one render.
export type PaintFlush = { draft?: string; thinking?: string };

export type PaintSchedulerOptions = {
  intervalMs?: number;
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
  const nowFn = opts.now ?? Date.now;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const onFlush = opts.onFlush;
  const pending = new Map<PaintLane, string>();
  let lastFlush = Number.NEGATIVE_INFINITY;
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
      if (t - lastFlush >= intervalMs) {
        emit(t);
        return;
      }
      if (timer !== null) return; // trailing paint already scheduled
      const wait = intervalMs - (t - lastFlush);
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
    },
    getPending(lane: PaintLane) {
      return pending.get(lane) ?? null;
    },
    pendingTimers() {
      return timer === null ? 0 : 1;
    },
  };
}
