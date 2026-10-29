// Layout constraints: single source for terminal dimensions and responsive breakpoints.
// - Use as `useTerminalSize()` instead of reading `useStdout().columns`:
//   the hook owns the resize subscription, so a resize re-renders only the
//   leaves that actually measure (a bare `useStdout()` read never reacts).
// - Throttled: resize storms (user drags window) coalesce to at most one
//   layout pass per frame, avoiding multiplicative renders of diff/markdown.
// - Breakpoints drive graceful degrade: xs (<50), sm (50-80), md (80-120),
//   lg (120-160), xl (>160). Very narrow hides banners, collapses side-by-side,
//   simplifies tables; very wide expands table caps and code indent.
// - All helpers are pure and cheap (no regex, no allocation) so callers can
//   invoke per render without memo cost.
// Phase 4 (plan tui-resize-theme-layout): geometry tokens live in the theme
// (theme.ts `layout` namespace) — the single source of visual truth. The
// singleton is the ACTIVE theme here (a compile-time read, not a hook): its
// layout slice stays classic-identical for every registered theme, so the
// helpers below keep returning the same numbers they returned before.
import { useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { theme } from "./theme.js";

export type TerminalSize = { columns: number; rows: number };

export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl";

export function breakpointFor(columns: number): Breakpoint {
  if (columns < theme.layout.breakpointXs) return "xs";
  if (columns < theme.layout.breakpointSm) return "sm";
  if (columns < theme.layout.breakpointMd) return "md";
  if (columns < theme.layout.breakpointLg) return "lg";
  return "xl";
}

// Shared fallback matches ink-testing-library default and 80x24 classic.
export const FALLBACK_SIZE: TerminalSize = { columns: 80, rows: 24 };

// One global size hook: AppShell + StatusBarHost + SideBySide etc. share it
// via this module, and each call subscribes to the stdout `resize` event
// itself, so one leaf's subscription never re-renders another.
//
// Why the subscription is mandatory: `useStdout()` is a bare context read —
// it does NOT re-render on resize — and Ink's own resize handler
// (`resized` in ink/build/ink.js) only recalculates yoga layout and re-renders
// the *existing* React tree. It never schedules a React update. Reading
// `stdout.columns` without subscribing therefore pins every width-derived
// surface (status-bar fit-or-drop, input frame, diff panes, table columns,
// wrapping) to the pre-resize width: Ink re-lays-out stale-width content at
// the NEW geometry, which is the "TUI distorts on resize" symptom, and it
// stays wrong until some unrelated state change happens to re-render.
// Ink ships `useWindowSize()` for this; we read the stream once and subscribe
// here so the same measured size also feeds the throttled variant below.
// A terminal axis: finite, positive, floored, else the shared fallback.
// Primitives (not a size object) so the hook can compare without allocating.
function readAxis(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

// The stdout stand-in shapes this hook tolerates: a real TTY stream (has
// `on`/`off`) and the plain objects tests/docs pass in place of one.
type TerminalStdout = {
  columns?: number;
  rows?: number;
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
};

export function useTerminalSize(): TerminalSize {
  let stdout: TerminalStdout | undefined;
  try {
    stdout = useStdout()?.stdout;
  } catch {
    stdout = undefined;
  }

  // The resize subscription below is what makes this hook reactive at all:
  // Ink's own resize handler re-lays-out the existing tree without scheduling
  // a React update, so without subscribing an idle app keeps pre-resize
  // widths until some unrelated state change re-renders it. This state is both
  // the trigger and the last settled size, so an event that does not change
  // the dimensions bails out and costs no render.
  const [settled, setSettled] = useState<TerminalSize>(() => ({
    columns: readAxis(stdout?.columns, FALLBACK_SIZE.columns),
    rows: readAxis(stdout?.rows, FALLBACK_SIZE.rows),
  }));

  useEffect(() => {
    // Plain-object stdout stand-ins have no emitter: subscribing there is
    // meaningless, so stay inert instead of throwing.
    if (typeof stdout?.on !== "function" || typeof stdout.off !== "function") {
      return;
    }
    const onResize = () => {
      const columns = readAxis(stdout.columns, FALLBACK_SIZE.columns);
      const rows = readAxis(stdout.rows, FALLBACK_SIZE.rows);
      setSettled((prev) =>
        prev.columns === columns && prev.rows === rows ? prev : { columns, rows }
      );
    };
    stdout.on("resize", onResize);
    // The terminal may have changed size between render and this effect (mount
    // under a live terminal, or a resize that beat the listener): settle once.
    onResize();
    return () => {
      stdout.off?.("resize", onResize);
    };
  }, [stdout]);

  // Also measured live on every render, so a re-render for any other reason
  // (keystroke, token, tick) still settles on the current size — the
  // subscription only covers the idle case. Memoized on the numeric pair so
  // memoized consumers and effect deps see a new identity only on a real
  // change (the object is allocated inside the memo, never per render).
  const columns = readAxis(stdout?.columns, FALLBACK_SIZE.columns);
  const rows = readAxis(stdout?.rows, FALLBACK_SIZE.rows);
  return useMemo(
    () =>
      columns === settled.columns && rows === settled.rows
        ? settled
        : { columns, rows },
    [columns, rows, settled]
  );
}

// Throttled size for expensive leaves (diff/markdown). Coalesces rapid
// `columns` changes (resize drag) to a single update `delayMs` after the
// LAST change (trailing edge): every new raw size clears the pending timer
// and schedules a fresh one, so the value always settles and can never
// freeze mid-drag (a cleared timer with a stuck "scheduled" flag would pin
// panes to a stale width permanently).
export function useThrottledTerminalSize(delayMs = 64): TerminalSize {
  const raw = useTerminalSize();
  const [throttled, setThrottled] = useState<TerminalSize>(raw);

  useEffect(() => {
    const id = setTimeout(() => {
      setThrottled((prev) =>
        prev.columns === raw.columns && prev.rows === raw.rows ? prev : raw
      );
    }, delayMs);
    return () => clearTimeout(id);
  }, [raw, delayMs]);

  // Keep throttled in sync when raw shrinks drastically (xs) – immediate
  // degrade avoids a frame of horizontal explosion.
  if (raw.columns < 50 && throttled.columns >= 50) return raw;
  if (raw.columns >= 50 && throttled.columns < 50) return raw;
  return throttled;
}

// ── Resize settle signal (plan Phase 2, paint arbitration) ───────────────

// How long the terminal size must stay unchanged before a resize counts as
// "settled" (trailing edge). Short enough that a drag feels live, long
// enough to swallow the burst of resize events a window drag emits.
export const RESIZE_SETTLE_MS = 120;

// Settled-state signal for PAINT ARBITRATION ONLY: lets a caller suspend a
// paint path on every raw size change (rising edge) and resume it once the
// size has stopped changing for `settleMs` (trailing edge) — exactly one
// paint per settled resize, none carrying pre-resize geometry. Layout is
// NOT served from here: `useTerminalSize`/`useThrottledTerminalSize` stay
// the authoritative geometry source (throttle-free signals would repaint
// expensive leaves per event during a drag).
export type ResizeEpoch = {
  /** No size change for `settleMs` (trailing edge of the last change). */
  settled: boolean;
  /** Latest raw size, same read pattern as useTerminalSize. */
  size: TerminalSize;
  /** Bumps on every raw size CHANGE (unchanged-dimension events bail out). */
  epoch: number;
};

export function useResizeEpoch(settleMs = RESIZE_SETTLE_MS): ResizeEpoch {
  let stdout: TerminalStdout | undefined;
  try {
    stdout = useStdout()?.stdout;
  } catch {
    stdout = undefined;
  }

  const [epoch, setEpoch] = useState<{
    settled: boolean;
    size: TerminalSize;
    epoch: number;
  }>(() => ({
    settled: true,
    epoch: 0,
    size: {
      columns: readAxis(stdout?.columns, FALLBACK_SIZE.columns),
      rows: readAxis(stdout?.rows, FALLBACK_SIZE.rows),
    },
  }));

  // Latest raw size for the unchanged-dimension bailout below (mirrors the
  // settled-state comparison useTerminalSize does, kept in a ref so the
  // emitter callback stays a pure read/compare without setState side
  // effects).
  const latestRef = useRef(epoch.size);

  useEffect(() => {
    // Plain-object stdout stand-ins have no emitter: stay inert (same rule
    // as useTerminalSize), so the signal is simply "always settled" there.
    if (typeof stdout?.on !== "function" || typeof stdout.off !== "function") {
      return;
    }
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      const size = {
        columns: readAxis(stdout.columns, FALLBACK_SIZE.columns),
        rows: readAxis(stdout.rows, FALLBACK_SIZE.rows),
      };
      // Same bailout as useTerminalSize: an event that does not change the
      // dimensions neither bumps the epoch nor re-arms the settle timer.
      if (
        latestRef.current.columns === size.columns &&
        latestRef.current.rows === size.rows
      ) {
        return;
      }
      latestRef.current = size;
      if (settleTimer !== null) clearTimeout(settleTimer);
      // Trailing-edge only: every raw change clears the previous settle
      // and schedules a fresh one, so "settled" means truly stopped.
      settleTimer = setTimeout(() => {
        settleTimer = null;
        setEpoch((prev) => (prev.settled ? prev : { ...prev, settled: true }));
      }, settleMs);
      // Rising edge: same dispatch as the settle flip, so a caller's
      // suspend (epoch bump) and resume (settled flip) effects see a
      // consistent pair — a bump never renders as "settled".
      setEpoch((prev) => ({
        settled: false,
        epoch: prev.epoch + 1,
        size,
      }));
    };
    stdout.on("resize", onResize);
    // The terminal may have changed size between render and this effect
    // (mount under a live terminal): settle once (unchanged size = no-op).
    onResize();
    return () => {
      stdout.off?.("resize", onResize);
      if (settleTimer !== null) clearTimeout(settleTimer);
    };
  }, [stdout, settleMs]);

  return epoch;
}

export function isNarrow(columns: number): boolean {
  return columns < 70;
}

export function isVeryNarrow(columns: number): boolean {
  return columns < theme.layout.breakpointXs;
}

export function isVeryWide(columns: number): boolean {
  return columns >= theme.layout.breakpointLg;
}

// Clamp a desired width to the terminal, reserving `reserve` columns for
// padding/borders so content never touches the edge and never wraps the
// chrome.
export function clampWidth(desired: number, columns: number, reserve = 4): number {
  return Math.max(10, Math.min(desired, Math.max(10, columns - reserve)));
}

// Shared widget width: framed surfaces (question modal, tool widget, todo
// panel when framed) never exceed 100 cols and never touch the edge.
// Single source so QuestionBox / ToolCall / TodoPanel / Inspector agree.
// Children of a framed surface inherit that narrower budget through the
// frame itself (Ink wraps/clips them to the Box), so a child never sizes
// from the terminal: a terminal-wide row inside a 100-col frame is the
// "diff cut off inside its block" symptom.
export function widgetWidth(columns: number): number {
  return clampWidth(
    Math.min(columns - 2, theme.layout.widgetMaxColumns),
    columns,
  );
}

// For long single-line code (e.g., minified, data URI) over `limit` chars,
// skip syntax tokenization (regex on 10k chars is wasteful) and render plain.
export const LONG_LINE_SKIP_HIGHLIGHT = theme.layout.longLineSkipHighlight;

// For huge fenced blocks, render only a window; the inspector/diff logic
// still holds the full text, so nothing is lost.
export const CODE_BLOCK_VISIBLE_MAX = theme.layout.codeBlockVisibleMax;

// ── Frame containment (plan tui-resize-theme-layout D2/D3) ──────────────
// Ink's win32 path (`shouldClearTerminalForFrame`) clears the terminal —
// `clearTerminal` contains ESC[3J, which wipes scrollback — whenever the
// previous or next frame height is >= the viewport rows. Containment keeps
// every frame strictly shorter than the viewport so that branch can never
// arm from height alone.

// D2: the frame stays one row short of the viewport (`isFullscreen` false is
// the only lever that disables Ink's win32 clear branch without patching Ink).
export const FRAME_SPARE_ROWS = theme.layout.frameSpareRows;

// Hard cap for the whole interactive frame: never the full viewport height.
export function frameMaxHeight(rows: number): number {
  return Math.max(1, rows - FRAME_SPARE_ROWS);
}

// Shared containment arithmetic: the frame cap minus the rows that must stay
// visible below the region being budgeted (never negative; a 1-row terminal
// still gets a 1-row budget so something always paints).
function frameRowsAfterReserve(rows: number, reservedRows: number): number {
  return Math.max(1, frameMaxHeight(rows) - Math.max(0, reservedRows));
}

// Rows the clipped middle zone (conversation + live + overlay) may occupy:
// the frame cap minus the footer cluster's rows.
export function middleZoneBudget(rows: number, footerRows: number): number {
  return frameRowsAfterReserve(rows, footerRows);
}

// Rows an overlay leaf (inspector, palette, picker, ledger…) may occupy: the
// frame cap minus the footer rows that render below/around it in that mode.
export function overlayRows(rows: number, reservedFooterRows: number): number {
  return frameRowsAfterReserve(rows, reservedFooterRows);
}

// Footer rows each interactive mode renders BELOW the clipped middle zone,
// worst case, borders included — derived from the actual render branches:
// - composer (idle/legacy footer): composer frame (top border + line + bottom
//   border = 3) + status bar (1).
// - picker / inspector / palette / ledger (composer-replacing footer leaves):
//   only the status bar renders beside them; the leaf's own chrome is its
//   own budget (its cap is `overlayRows(rows, this)`).
// - dock (ATOM_DOCK=1): border 2 + statusMarginTop 1 + frameless input 1 +
//   divider 1 + pills row 1 (no actions registered today).
export const RESERVED_FOOTER_ROWS = theme.layout.overlayReserve;

// Live-draft height budget: rows the interactive frame needs for everything
// that surrounds the streaming draft, so a long answer can never make the
// frame taller than the viewport. Over-tall frames are the win32 clear
// trigger (Ink repaints a fullscreen frame by clearing the terminal), so
// this budget is what keeps streaming flicker-free. Breakdown: footer
// (composer box + status bar) 4, live-zone margin 1, speaker header 1,
// live thinking block (label + LIVE_THINKING_LINES tail) 9, running tool
// row 1.
export const LIVE_DRAFT_RESERVE_LINES = theme.layout.liveDraftReserveLines;
// Never window the draft away entirely in a very short terminal: always
// keep a readable tail.
export const LIVE_DRAFT_MIN_LINES = theme.layout.liveDraftMinLines;

// Draft budget for a terminal of `rows` rows (single source for App).
//
// Phase 1 reconciliation (plan D2): the old arithmetic `draft = rows - 16`
// plus the 16-row reserve summed to exactly `rows` — a draft-max frame was
// fullscreen by construction, which is what armed Ink's win32 clear. The
// frame cap is now `rows - 1`, and the spare row is absorbed by the RESERVE
// arithmetic, never by the draft: the live-zone chrome inside the middle
// gets `reserve - footer - spare`, so the draft budget stays exactly
// `max(4, rows - 16)` for every terminal (rows 24 → 8, 30 → 14, 40 → 24).
// Only a worst-case double-load (thinking tail + max draft) exceeds the
// middle budget, and then AppShell's clip drops one draft row at the bottom
// of the middle zone — a one-row clip, never a scrollback wipe.
export function liveDraftMaxLines(rows: number): number {
  const liveChromeRows =
    LIVE_DRAFT_RESERVE_LINES -
    RESERVED_FOOTER_ROWS.composer -
    FRAME_SPARE_ROWS;
  return Math.max(
    LIVE_DRAFT_MIN_LINES,
    middleZoneBudget(rows, RESERVED_FOOTER_ROWS.composer) - liveChromeRows
  );
}

// Rows a logical line occupies after Ink wraps it at `columns`. An estimate:
// markdown prefixes (list markers, quote bars) can add a row or two, which
// the reserve above absorbs.
function wrappedRows(line: string, columns: number): number {
  return Math.max(1, Math.ceil(line.length / columns));
}

function cutTailAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  // Drop the half-word the slice cut through (and any leading space) so the
  // window starts on a whole word; whitespace payloads (tables, code) lose
  // at most that one space. Falls back to the raw tail when nothing usable
  // remains (a payload with no space at all, or a lone trailing space).
  const wordStart = tail.indexOf(" ");
  const trimmed = wordStart >= 0 ? tail.slice(wordStart + 1) : tail;
  return trimmed.length > 0 ? trimmed : tail;
}

// Tail window for the live streaming draft: the last `maxLines` display
// rows of `text` wrapped at `columns`, cut at a line boundary (word
// boundary for a single over-wide line). Returns `text` itself when it
// already fits, so memoized consumers see an identical reference and skip
// the re-parse. The dropped head is not a loss: the turn's commit paints
// the full text into the transcript right after the stream ends.
export function tailDisplayWindow(text: string, columns: number, maxLines: number): string {
  const cols = Math.max(1, Math.floor(columns));
  const budget = Math.max(1, Math.floor(maxLines));
  const lines = text.split("\n");
  let used = 0;
  let start = lines.length;
  while (start > 0) {
    const rows = wrappedRows(lines[start - 1], cols);
    if (used + rows > budget) break;
    used += rows;
    start -= 1;
  }
  if (start === 0) return text;
  if (start === lines.length) {
    // One line wider than the whole budget (a paragraph that never wraps
    // logically): keep its tail so the window always shows something.
    return cutTailAtWordBoundary(lines[lines.length - 1], cols * budget);
  }
  return lines.slice(start).join("\n");
}
