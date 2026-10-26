// Process-level session save net: the last line of defense for sessions the
// turn-boundary cadence cannot cover.
//
// App persists at every completed turn and on explicit exits (/exit, idle
// Ctrl+C). That cadence loses everything after the last completed turn when
// the process dies some other way: an unhandled crash, taskkill, a closed
// terminal window (SIGHUP/SIGBREAK), or a dangling in-flight turn. This
// module closes those windows:
//
// - App registers a saver closure (its persistSession, guarded to skip
//   mid-turn so a dangling assistant tool_calls state can never hit disk —
//   the submit-time persist already wrote the valid pre-turn snapshot).
// - installProcessSessionSave() hooks `exit` (fires on uncaught fatal
//   exceptions and unhandled rejections too — both crash paths run it) plus
//   SIGINT/SIGTERM/SIGHUP/SIGBREAK, which bypass `exit` when they terminate
//   the process directly (window close, taskkill, external signal).
//
// Everything here is synchronous-only: the `exit` event forbids async work,
// and both store writers (src/session.ts, src/sessions.ts) are
// writeFileSync + renameSync — safe on the exit path.
//
// kill -9 / power loss are unsignaled by design: the atomic writes plus the
// per-turn cadence bound the loss to everything after the last save point.

let saver: (() => void) | null = null;
let lastSaveAt = 0;

// Double-save latch: App persists explicitly on /exit and idle Ctrl+C, then
// the `exit` hook fires — one disk write per exit, not two.
const SAVE_LATCH_MS = 50;

/** Register the App-owned save closure. Last registration wins; null clears. */
export function registerSessionExitSaver(save: (() => void) | null): void {
  saver = save;
}

/** Run the registered saver once (no-op when none is registered). Never throws. */
export function saveSessionOnExit(): void {
  if (saver === null) return;
  const now = Date.now();
  if (now - lastSaveAt < SAVE_LATCH_MS) return;
  lastSaveAt = now;
  try {
    saver();
  } catch {
    // The exit path never throws — a failed save must not crash the shutdown.
  }
}

let installed = false;

const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

/**
 * Install the process-level hooks (TUI boot only; idempotent). Signal
 * handlers save then exit(0) — a handled signal never reaches the default
 * terminator, so the explicit exit is what ends the process.
 */
export function installProcessSessionSave(): void {
  if (installed) return;
  installed = true;
  process.on("exit", () => saveSessionOnExit());
  for (const signal of EXIT_SIGNALS) {
    try {
      process.on(signal, () => {
        saveSessionOnExit();
        process.exit(0);
      });
    } catch {
      // Some runtimes restrict signal handlers; the `exit` hook still covers
      // the crash paths.
    }
  }
}
