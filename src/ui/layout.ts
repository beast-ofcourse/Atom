// Layout constraints: single source for terminal dimensions and responsive breakpoints.
// - Use as `useTerminalSize()` instead of calling `useStdout()` in many leaves:
//   one subscription, one re-render on resize, not N.
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
// via this module, but each still reads `useStdout` locally to keep the
// subscription isolated per leaf (React's `useSyncExternalStore` granularity).
// The helper below is the per-leaf throttled reader; the global is just for
// App's top-level constraint.
export function useTerminalSize(): TerminalSize {
  let cols: number | undefined;
  let rows: number | undefined;
  try {
    const stdout = useStdout()?.stdout;
    cols = stdout?.columns;
    rows = stdout?.rows;
  } catch {
    cols = undefined;
    rows = undefined;
  }
  const size = useMemo<TerminalSize>(() => ({
    columns: typeof cols === "number" && Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : FALLBACK_SIZE.columns,
    rows: typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : FALLBACK_SIZE.rows,
  }), [cols, rows]);
  return size;
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

// For long single-line code (e.g., minified, data URI) over `limit` chars,
// skip syntax tokenization (regex on 10k chars is wasteful) and render plain.
export const LONG_LINE_SKIP_HIGHLIGHT = 500;

// For huge fenced blocks, render only a window; the inspector/diff logic
// still holds the full text, so nothing is lost.
export const CODE_BLOCK_VISIBLE_MAX = 60;
