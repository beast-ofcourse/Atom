// Controlled repaint (plan tui-resize-theme-layout Phase 3, D4/D5):
// the process's only full repaint is ours. Ink's own destructive path
// (`shouldClearTerminalForFrame` → `clearTerminal`, ink/build/ink.js:768)
// writes ESC[2J ESC[3J ESC[H — ESC[3J deletes the terminal's scrollback
// history (V1) and replays the entire accumulated static output at the
// pre-resize width (V4). Our repaint writes ESC[2J + home (viewport erase,
// scrollback untouched) and then bumps clearGen so <Static> remounts and
// re-admits the transcript from index 0 at the NEW width (V10) — the same
// primitive /clear, /resume, and /new already use.
//
// Pure module: no React, no timers. The writer carries only a reentrancy +
// interval guard so two triggers inside REPAINT_MIN_INTERVAL_MS collapse to
// one clear (a drag emits many settled resizes; each repaint reprints the
// transcript, so the cost must be bounded — D5).
import { frameMaxHeight, type TerminalSize } from "./layout.js";

// Deliberately NO ESC[3J: that code deletes scrollback history (V1) and the
// Ink path that contains it also replays stale-width static bytes (V4,
// ink.js:768). ESC[2J erases the viewport only; ESC[1;1H homes the cursor
// so the reprint starts at the top-left like Ink's clearTerminal does.
export const REPAINT_CLEAR = "\u001b[2J\u001b[1;1H";

// D5 cost gate: a full clearGen reprint admits every turn (V12 — the turn
// list is rendered whole), so a session past this count reprints only the
// tail window (repaintWindowFrom) instead of the whole transcript.
export const REPAINT_MAX_TURNS = 200;

// Minimum spacing between two full repaints. A terminal drag settles every
// 120 ms (RESIZE_SETTLE_MS), so settled width decreases can arrive in a
// burst; each repaint clears the screen and reprints the transcript, and
// two clears inside this window would visibly flicker for no information.
// Triggers inside the window collapse into the first clear.
export const REPAINT_MIN_INTERVAL_MS = 250;

// Truth table (pure — testable without rendering):
//   next.columns < prev.columns
//     → true. Width decrease: wrapping is width-only, so the reprint is
//       re-wrapped and needed (V2: Ink additionally log.clear()s here, but
//       it never reprints the transcript re-wrapped — we do).
//   next.columns > prev.columns
//     → false. Never repaint on growth (plan: "explicitly NOT on growth").
//   equal columns, frameHeight undefined
//     → false. A rows-only change re-lays-out through the settled render;
//       wrapping does not change, so there is nothing to reprint.
//   equal columns, frameHeight defined
//     → true only when frameHeight > frameMaxHeight(next.rows)
//       (⇔ frameHeight >= next.rows ⇔ Ink's win32 clear branch is armed,
//       plan V3). This is the overflow safety net for the two cap-lifting
//       residuals (provider picker, /diff panel). At exactly the cap the
//       frame is one row short of the viewport and Ink's branch is NOT
//       armed — no repaint (an armed check would repaint on ordinary
//       streaming in tall-contained states).
export function shouldRepaint(
  prev: TerminalSize,
  next: TerminalSize,
  frameHeight?: number,
): boolean {
  if (next.columns < prev.columns) return true;
  if (frameHeight === undefined) return false;
  return frameHeight > frameMaxHeight(next.rows);
}

// D5 tail window: the re-admission start index after a controlled repaint
// of a session whose turn count exceeds REPAINT_MAX_TURNS — the LAST
// REPAINT_MAX_TURNS turns re-wrap and reprint; earlier turns remain in
// terminal scrollback (one dim notice line names that). 0 = full reprint.
export function repaintWindowFrom(turnCount: number): number {
  if (turnCount <= REPAINT_MAX_TURNS) return 0;
  return turnCount - REPAINT_MAX_TURNS;
}

// The stdout surface the writer needs (a real TTY stream or the plain
// objects tests pass in). Null stdout = never writes (returns false).
type RepaintStdout = { write: (chunk: string) => unknown } | null;

export type RepaintWriter = {
  /**
   * Write REPAINT_CLEAR once per trigger. Returns true when the clear was
   * actually written, false when the trigger collapsed (inside the interval
   * window, re-entrant call, or no stdout) — a collapsed trigger must write
   * nothing at all, since a clearGen bump without a clear would print a
   * duplicate transcript over live content.
   */
  write: () => boolean;
};

export type RepaintWriterOptions = {
  stdout: RepaintStdout;
  now?: () => number;
};

export function createRepaintWriter(opts: RepaintWriterOptions): RepaintWriter {
  const now = opts.now ?? Date.now;
  let lastWrittenAt = Number.NEGATIVE_INFINITY;
  // Reentrancy guard: a write that synchronously triggers another write
  // (an stdout write callback racing the same tick) collapses instead of
  // double-clearing the screen.
  let writing = false;
  return {
    write(): boolean {
      const stdout = opts.stdout;
      if (stdout === null) return false;
      const at = now();
      if (at - lastWrittenAt < REPAINT_MIN_INTERVAL_MS) return false;
      if (writing) return false;
      writing = true;
      try {
        // One write call for the whole sequence: atomic in the byte
        // stream, so no Ink frame can interleave inside the clear.
        stdout.write(REPAINT_CLEAR);
      } finally {
        writing = false;
      }
      lastWrittenAt = at;
      return true;
    },
  };
}
