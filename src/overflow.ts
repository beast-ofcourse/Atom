// Real-usage overflow trigger (ticket 02) — the auto-compaction decision
// based on the provider's REAL reported token usage against each model's
// usable limit (verified window minus a reserved output buffer), instead of
// a fixed percentage estimate.
//
// Formula: usable = verified window − reserved; overflow when the last
// POST's real total tokens (total_tokens, else prompt + completion + cache
// read + cache write) >= usable.
//
// Honesty rules (same as the footer segment in context-windows.ts):
// - Models with NO verified window never auto-fire (usable is undefined —
//   a window is never invented, a percentage never fabricated).
// - No real usage reported yet → no fire (nothing estimated).
// - auto=false disables auto-compaction only; manual /compact is untouched
//   (it never consults this module).
//
// This module is pure + testable: config/env reads go through the same
// precedence as compactPct (env > atom.json > default). It imports
// context-windows (metadata) and config (file fallback) at runtime only,
// plus the Usage TYPE (erased at compile — no zen.js runtime cycle).
// Compaction MECHANICS (summary, tail split, swap) stay in compact.ts,
// owned by later tickets — this module only decides WHEN auto fires.

import { loadAtomConfig } from "./config.js";
import { contextWindowFor } from "./context-windows.js";
import type { Usage } from "./zen.js";

// ---- Reserved output buffer ----

// Default buffer kept free for the next generation (~20k tokens: one
// summary-sized compaction output plus headroom for the reply that follows).
export const OVERFLOW_RESERVE_DEFAULT = 20_000;
// The buffer always fits at least one full summary-sized generation
// (mirrors COMPACT_SUMMARY_MAX_TOKENS in compact.ts) — a smaller buffer
// could not even emit the compaction summary it is reserving for.
export const OVERFLOW_RESERVE_MIN = 4096;
// Upper bound keeps the usable limit positive on the smallest verified
// window (200K); per-model, the reserve is additionally capped at
// window−1 so usable never drops below 1 token.
export const OVERFLOW_RESERVE_MAX = 100_000;

function clampReserve(n: number): number {
  const floored = Math.floor(n);
  if (!Number.isFinite(floored)) return OVERFLOW_RESERVE_DEFAULT;
  return Math.min(Math.max(floored, OVERFLOW_RESERVE_MIN), OVERFLOW_RESERVE_MAX);
}

// Reserved output buffer in tokens. Precedence: env ATOM_COMPACT_RESERVE
// (tokens, e.g. "20000", clamped to [MIN, MAX]) → atom.json compactReserve
// → default; invalid/unset falls through.
export function compactReserveTokens(): number {
  const raw = process.env.ATOM_COMPACT_RESERVE;
  if (raw !== undefined) {
    const text = raw.trim();
    if (/^\d+(\.\d+)?$/.test(text)) {
      const n = Number(text);
      if (Number.isFinite(n)) return clampReserve(n);
    }
  }
  const file = loadAtomConfig().config.compactReserve;
  if (file !== undefined) return clampReserve(file);
  return OVERFLOW_RESERVE_DEFAULT;
}

// Auto-compaction master switch. Precedence: env ATOM_COMPACT_AUTO
// (1/true/yes/on → on; 0/false/no/off → off) → atom.json compactAuto → on.
// False disables AUTO-compaction only; manual /compact never reads this.
export function compactAutoEnabled(): boolean {
  const raw = process.env.ATOM_COMPACT_AUTO;
  if (raw !== undefined) {
    const text = raw.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(text)) return true;
    if (["0", "false", "no", "n", "off"].includes(text)) return false;
  }
  const file = loadAtomConfig().config.compactAuto;
  if (file !== undefined) return file;
  return true;
}

// ---- Real total tokens ----

// The last POST's real reported total: total_tokens when the provider sent
// it, else the sum of the reported parts (prompt + completion + separately-
// reported cache read/write — prompt_tokens is already cache-inclusive for
// exclusive-cache providers, so providers that report cache separately need
// the extra terms to count cached context). Undefined when nothing usable
// was reported (absent fields mean "not reported", never zero).
export function realTotalTokens(usage: Usage | null | undefined): number | undefined {
  if (!usage) return undefined;
  const t = usage.total_tokens;
  if (typeof t === "number" && Number.isFinite(t)) return Math.max(0, Math.floor(t));
  let seen = false;
  let sum = 0;
  const parts = [usage.prompt_tokens, usage.completion_tokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  for (const v of parts) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      seen = true;
      sum += Math.floor(v);
    }
  }
  return seen ? sum : undefined;
}

// ---- Usable limit + decision ----

// Usable limit for a model: verified window minus the reserved buffer, or
// undefined when the model has no verified window (never invented). The
// reserve is capped per-model at window−1 so usable stays >= 1.
export function usableLimitFor(model: string, reserveOverride?: number): number | undefined {
  const window = contextWindowFor(model);
  if (window === undefined) return undefined;
  const reserve =
    typeof reserveOverride === "number" && Number.isFinite(reserveOverride)
      ? clampReserve(reserveOverride)
      : compactReserveTokens();
  return Math.max(1, window - Math.min(reserve, window - 1));
}

// Honest percent of the verified window consumed by the last POST's real
// total, or undefined when the window is unknown or nothing was reported
// (never fabricated — same rule as formatTokenSegment's bare `token: NK`).
export function realUsagePct(
  usage: Usage | null | undefined,
  model: string
): number | undefined {
  const window = contextWindowFor(model);
  if (window === undefined) return undefined;
  const total = realTotalTokens(usage);
  if (total === undefined) return undefined;
  return Math.round((100 * total) / window);
}

export type OverflowOpts = {
  // Defaults to compactAutoEnabled() (env/file). False disables auto-fire.
  auto?: boolean;
  // Defaults to compactReserveTokens() (env/file).
  reserve?: number;
};

// Auto-compact trigger: true only when auto is on, the model has a verified
// window, real usage was reported, and real total >= usable limit.
export function shouldAutoCompactReal(
  model: string,
  usage: Usage | null | undefined,
  opts?: OverflowOpts
): boolean {
  const auto = opts?.auto ?? compactAutoEnabled();
  if (!auto) return false;
  const usable = usableLimitFor(model, opts?.reserve);
  if (usable === undefined) return false;
  const total = realTotalTokens(usage);
  if (total === undefined) return false;
  return total >= usable;
}

export function shouldPreCompactForPending(
  model: string,
  pending: number,
  opts?: OverflowOpts
): boolean {
  if (typeof pending !== "number" || !Number.isFinite(pending) || pending < 0) return false;
  const auto = opts?.auto ?? compactAutoEnabled();
  if (!auto) return false;
  const usable = usableLimitFor(model, opts?.reserve);
  if (usable === undefined) return false;
  return pending >= usable;
}

export function shouldCompactOnSizeError(
  isSizeError: boolean,
  opts?: OverflowOpts
): boolean {
  if (!isSizeError) return false;
  const auto = opts?.auto ?? compactAutoEnabled();
  if (!auto) return false;
  return true;
}
