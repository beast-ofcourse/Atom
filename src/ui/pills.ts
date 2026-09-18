// Pill helpers (brand-dock Phase 2 item 2.2): measure/fit/format logic
// extracted byte-for-byte from src/ui/status-bar.tsx. StatusBar imports
// from here and re-exports for compat; behavior frozen.
import { formatTokenSegment } from "../context-windows.js";
import type { Usage } from "../zen.js";
import { theme } from "./theme.js";

// Goal slice for the status bar: objective plus state only (the full text +
// cumulative stats live in `/goal` output via goalStatusText in goal.ts).
// Null/absent/empty reads as no goal — the bar renders nothing.
export type StatusGoal = { objective: string; active: boolean } | null;

// Default objective budget for the goal segment: compact enough to share the
// line with the pinned model/token/mode segments at 100 columns. Value pins
// theme.spacing.statusGoalObjectiveChars (brand-dock token) — behavior frozen.
export const GOAL_STATUS_OBJECTIVE_CHARS =
  theme.spacing.statusGoalObjectiveChars;

// Truncate an objective to n chars max (`…` tail keeps the start, which
// carries the verb). n < 4 yields "" (the caller drops the segment instead).
export function truncateGoalObjective(
  objective: string,
  max: number = GOAL_STATUS_OBJECTIVE_CHARS,
): string {
  const text = typeof objective === "string" ? objective : "";
  if (text.length <= max) return text;
  if (max < 4) return "";
  return `${text.slice(0, max - 1)}…`;
}

// Full goal segment at the default budget, or null when no goal is live.
// Paused reads distinct from active (`[paused]` vs `[active]`).
export function formatGoalSegment(
  goal: StatusGoal,
  max: number = GOAL_STATUS_OBJECTIVE_CHARS,
): string | null {
  if (
    !goal ||
    typeof goal.objective !== "string" ||
    goal.objective.length === 0
  )
    return null;
  const state = goal.active === true ? "active" : "paused";
  return `goal: ${truncateGoalObjective(goal.objective, max)} [${state}]`;
}

// Fit the goal segment into `room` chars (the width left after every other
// segment): full text when it fits, a shorter truncation when it almost
// fits, null (drop the segment) when even a stub would displace the line.
// Never throws; never returns "".
export function fitGoalSegment(goal: StatusGoal, room: number): string | null {
  if (
    !goal ||
    typeof goal.objective !== "string" ||
    goal.objective.length === 0
  )
    return null;
  if (typeof room !== "number" || !Number.isFinite(room) || room <= 0)
    return null;
  const state = goal.active === true ? "active" : "paused";
  const full = `goal: ${goal.objective} [${state}]`;
  if (full.length <= room) return full;
  // Room for at least 4 objective chars plus the fixed framing, else drop.
  const overhead = `goal:  [${state}]`.length + 1;
  const allow = Math.floor(room - overhead);
  if (allow < 4) return null;
  return `goal: ${truncateGoalObjective(goal.objective, allow)} [${state}]`;
}

// Estimate honesty (ticket 06): is the context load behind P% a heuristic
// rather than provider-reported input tokens? An explicit `override` (the
// `loadEstimated` prop, owned by the caller that tracks the report latch)
// always wins. Without one, the bar can only prove the never-reported case:
// usage exists with no finite prompt_tokens anywhere in the accumulated
// totals, so the load could only have come from the chars/token estimate.
// Stale-totals resets (compaction/clear/resume/switch keep accumulated
// prompt_tokens while the load falls back to the estimate) need the explicit
// latch — the heuristic stays exact there, documented as a known gap rather
// than guessed. Pure; never throws.
export function isEstimatedLoad(
  usage: Usage | null,
  load: number | null | undefined,
  override?: boolean | null,
): boolean {
  if (override === true) return true;
  if (override === false) return false;
  if (!usage || typeof load !== "number" || !Number.isFinite(load))
    return false;
  const reported = (usage as Usage).prompt_tokens;
  return !(typeof reported === "number" && Number.isFinite(reported));
}

// Tilde-marker for an estimated P%: `token: (17%) 44K` → `token: (~17%) 44K`.
// Single source of truth stays `formatTokenSegment` — this only inserts the
// `~` when the exact `(P%)` form is present, so `token: n/a` (nothing
// reported yet) and bare `token: NK` (no verified window, spend only) pass
// through byte-identical. Pure; never throws.
export function markTokenEstimate(segment: string): string {
  const prefix = "token: (";
  if (typeof segment === "string" && segment.startsWith(prefix)) {
    return `token: (~${segment.slice(prefix.length)}`;
  }
  return segment;
}

// Labeled token segment for the bar: exact `(P%)` for provider-reported
// loads, `(~P%)` for estimates, `n/a` / bare forms untouched. Pure.
export function formatStatusTokenSegment(
  usage: Usage | null,
  model: string,
  load?: number | null,
  loadEstimated?: boolean | null,
): string {
  const segment = formatTokenSegment(usage, model, load);
  return isEstimatedLoad(usage, load, loadEstimated)
    ? markTokenEstimate(segment)
    : segment;
}

// ~/… collapse + tail-cut: informative, never a full scroll of nesting.
// Further shrinking for tight widths goes through shrinkTo below (the bar
// measures first and only renders what fits).
export function shortenCwd(cwd: string, home: string, max = 20): string {
  const short =
    home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (short.length <= max) return short;
  return `…/${short.slice(-(max - 3))}`;
}

// Shrink text to n chars max for tight widths (`…/tail` keeps the
// meaningful end). n < 4 yields "" (caller drops the segment instead).
export function shrinkTo(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n < 4) return "";
  return `…/${s.slice(-(n - 3))}`;
}
