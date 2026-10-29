// Centralized streaming paint scheduler: ONE trailing timer for every live
// lane (answer draft + thinking).
//
// EVENT FREQUENCY != RENDER FREQUENCY: tokens may arrive hundreds per
// second, but terminal paints coalesce to at most one per interval, always
// carrying the latest pending text per lane, delivered in a SINGLE onFlush
// call so draft + thinking land in the same React render instead of
// fighting across two frames.
//
// SINGLE CADENCE: one window for every stream, dense or sparse. The former
// hot/cold rule picked the window from arrival density at push time, but
// only while a timer was NOT already pending — a hot push inside an armed
// cold window rode the stale cold timer. Identical input therefore painted
// at different cadences run to run (measured: 25 tok/s landed on hot=0 /
// cold=200 with a 74 ms emit p50 ≈ 13 fps; same stream elsewhere emitted on
// a flat 64 ms cadence). One window removes the flip and the stale-timer
// bug together: cadence is max(arrival gap, window), so identical input
// paints identically. The window is one Ink frame (see PAINT_INTERVAL_MS),
// so paints land on render quanta instead of fighting them. Rules it
// enforces:
// - latest-wins per lane (never queue stale paints behind each other)
// - leading immediate paint after idle (no typing/stream-start latency)
// - trailing coalescing inside the window (no per-token renders)
// - deterministic flush() for turn end, tool transitions, errors, and
//   completion (the final state always paints exactly once)
// - cancel() drops pending text AND the timer, so a trailing paint can
//   never resurrect stale content after a clear/rollback
// - timer failure degrades to immediate paint (never lose content)
// - suspend()/resume() bracket a terminal ownership change (resize): while
//   suspended, pushes keep updating the pending lane (latest-wins) but no
//   paint may fire — a paint during the window-clear/re-layout window would
//   carry pre-resize geometry and flicker. Suspension may DELAY a paint but
//   never drops the latest text: resume() flushes it, and the hard
//   MAX_SUSPEND_MS floor (owned here, see below) releases it even if the
//   resize never settles. Cancellation is exempt from that promise — an
//   explicit cancel() while suspended still drops the text.
//
// One painting window = the scheduler's streaming cadence (PAINT_INTERVAL_MS
// = 34 ms): streaming paints never fire faster than ~30 fps even though Ink's
// frame cap is much higher (maxFps 200, set for keystroke latency — see
// cli.tsx). The streaming cadence is owned here; Ink only coalesces strays.
// For unit tests, now/clock are injectable like the throttler's.
export const PAINT_INTERVAL_MS = 34;

// Hard bound on how long suspend() may hold a paint back (plan Phase 2
// risk note): the settle signal that resumes the scheduler is trailing-edge,
// so a resize storm that never settles could suspend forever and stall the
// stream. The scheduler owns this floor — it already owns the only timers
// and the never-lose-content invariant — so App wiring stays effect-only.
// Measured from the FIRST suspend(); repeated suspends do not re-arm it.
export const MAX_SUSPEND_MS = 500;

export type PaintLane = "draft" | "thinking";

// Only lanes with pending payloads are present (absent = unchanged). The
// consumer applies the whole object in one state update — one render.
// Generic payload: the legacy scheduler carries plain text (T = string);
// the agent-adapter carries full delta events so step tags survive
// multi-step interleaving (see createAgentEventSink).
export type PaintFlush<T = string> = { draft?: T; thinking?: T };

export type PaintSchedulerOptions<T = string> = {
  intervalMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onFlush: (lanes: PaintFlush<T>) => void;
};

export type PaintScheduler<T = string> = {
  /** Latest-wins per lane; paints immediately when outside the window. */
  push: (lane: PaintLane, payload: T) => void;
  /** Paint all pending lanes now (no-op when nothing is pending). */
  flush: () => void;
  /** Drop pending payloads (one lane, or all) and any scheduled paint. */
  cancel: (lane?: PaintLane) => void;
  /** cancel() + re-arm so the next push paints immediately (turn start). */
  reset: () => void;
  getPending: (lane: PaintLane) => T | null;
  /** 0 or 1 — at most one trailing paint is ever scheduled. */
  pendingTimers: () => number;
  /**
   * Stop emitting for a terminal ownership change (resize). Pushes still
   * update the pending lane (latest-wins); any armed paint timer is cleared.
   * Idempotent: a second suspend() while suspended is a no-op and does not
   * re-arm the MAX_SUSPEND_MS floor. Hard-capped at MAX_SUSPEND_MS.
   */
  suspend: () => void;
  /**
   * End the suspension: flush pending lanes once, then normal cadence.
   * Idempotent: resume() while not suspended is a no-op (no spurious flush).
   */
  resume: () => void;
};

export function createPaintScheduler<T = string>(opts: PaintSchedulerOptions<T>): PaintScheduler<T> {
  const intervalMs = opts.intervalMs ?? PAINT_INTERVAL_MS;
  const nowFn = opts.now ?? Date.now;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const onFlush = opts.onFlush;
  const pending = new Map<PaintLane, T>();
  let lastFlush = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Suspension state + the MAX_SUSPEND_MS guard armed by the first
  // suspend(). Separate from `timer`: the paint timer is always cleared
  // while suspended (pendingTimers() stays 0), while the guard keeps
  // counting toward the release floor.
  let suspended = false;
  let suspendGuard: ReturnType<typeof setTimeout> | null = null;

  function releaseSuspension() {
    suspended = false;
    if (suspendGuard !== null) {
      try {
        clearT(suspendGuard);
      } catch {
        // ignore (the guard firing later is inert once suspended is false)
      }
      suspendGuard = null;
    }
  }

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
    const lanes: PaintFlush<T> = {};
    const draft = pending.get("draft");
    const thinking = pending.get("thinking");
    if (draft !== undefined) lanes.draft = draft;
    if (thinking !== undefined) lanes.thinking = thinking;
    pending.clear();
    lastFlush = at;
    onFlush(lanes);
  }

  return {
    push(lane: PaintLane, payload: T) {
      pending.set(lane, payload);
      // While suspended the lane must still absorb the push (latest-wins)
      // but no paint may fire — even the leading edge. resume() or the
      // MAX_SUSPEND_MS guard delivers it.
      if (suspended) return;
      const t = safeNow();
      // One window, always: outside it paint now (no stream-start latency),
      // inside it arm one trailing timer (no per-token renders). The wait is
      // recomputed from lastFlush, so an armed timer can never go stale —
      // whatever window the push is in, it fires on that window's edge.
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
    suspend() {
      // Idempotent: the guard armed by the FIRST suspend keeps bounding the
      // suspension, so a later suspend() must not extend the floor.
      if (suspended) return;
      suspended = true;
      // The armed paint timer must never fire while we own the terminal —
      // that is exactly the trailing paint this gate exists to stop.
      clearTimer();
      try {
        suspendGuard = setT(() => {
          suspendGuard = null;
          if (!suspended) return; // resumed normally before the floor
          // Hard floor: a resize that never settles still releases the
          // latest text instead of stalling output forever.
          suspended = false;
          emit(safeNow());
        }, MAX_SUSPEND_MS);
      } catch {
        // No timer available: an unbounded suspension could stall the
        // stream forever, so refuse to suspend (never-lose-content wins).
        suspended = false;
      }
    },
    resume() {
      if (!suspended) return; // idempotent: no spurious flush
      releaseSuspension();
      // The whole point of the gate: everything the suspension absorbed
      // paints exactly once, now, in a single flush.
      if (pending.size > 0) emit(safeNow());
    },
  };
}
