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
import { useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";

export type TerminalSize = { columns: number; rows: number };

export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl";

export function breakpointFor(columns: number): Breakpoint {
  if (columns < 50) return "xs";
  if (columns < 80) return "sm";
  if (columns < 120) return "md";
  if (columns < 160) return "lg";
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

export function isNarrow(columns: number): boolean {
  return columns < 70;
}

export function isVeryNarrow(columns: number): boolean {
  return columns < 50;
}

export function isVeryWide(columns: number): boolean {
  return columns >= 160;
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
export function widgetWidth(columns: number): number {
  return clampWidth(Math.min(columns - 2, 100), columns);
}

// Content box of a framed surface: `frameWidth` (the Box's own width, borders
// included) minus one cell per border side and `paddingX` per padding side.
// Children that size themselves from the terminal rather than from the layout
// — diff panes, code bodies — must budget against THIS, not `columns`: a frame
// capped by widgetWidth() is far narrower than the terminal on wide windows,
// so terminal-derived rows overflow it and get clipped at the border (the
// "diff cut off inside its block" symptom). Single source so ToolCall,
// ApprovalBox and DiffPanel agree on the inset.
export function frameContentWidth(frameWidth: number, paddingX = 1): number {
  const pad = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
  return Math.max(10, frameWidth - 2 - pad * 2);
}

// For long single-line code (e.g., minified, data URI) over `limit` chars,
// skip syntax tokenization (regex on 10k chars is wasteful) and render plain.
export const LONG_LINE_SKIP_HIGHLIGHT = 500;

// For huge fenced blocks, render only a window; the inspector/diff logic
// still holds the full text, so nothing is lost.
export const CODE_BLOCK_VISIBLE_MAX = 60;
