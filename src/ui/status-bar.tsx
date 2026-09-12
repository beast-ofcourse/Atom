// Status bar leaf: the sole info bar, state-prioritized and quiet (ticket 06
// information discipline).
// - idle: provider/model │ token │ cwd[:branch] │ reasoning │ mode.
//   Labels are positional (no `provider:` prefixes); mode/trust show always
//   (pinned), cwd shortens, branch only for git repos. A pending approval
//   pins a `waiting approval` decision flag (warning color) — decision demand
//   outranks location, which yields first under width pressure.
// - busy: activity │ elapsed │ token │ reasoning │ mode │ esc-hint (+waiting/approval flags).
//   Provider/model/cwd drop while working — the activity, the
//   clock, context pressure, effort, and the pinned mode are what matter mid-turn.
// - estimates: the token P% reads `(~P%)` (tilde) whenever the context load
//   is a chars-based estimate rather than provider-reported input tokens
//   (see `loadEstimated` / `isEstimatedLoad`); `token: n/a` and bare
//   `token: NK` never gain a marker. Estimates are never exact facts.
// All paint comes from ui/theme tokens. The token segment formatter lives
// in context-windows (its only surface).
import React from "react";
import { Box, Text } from "ink";
import { formatTokenSegment } from "../context-windows.js";
import type { Usage } from "../zen.js";
import { theme } from "./theme.js";

export type StatusBarProps = {
  provider: string;
  model: string;
  usageTotals: Usage | null;
  contextLoad: number | null;
  // Load-source latch (ticket 06 estimate honesty): true when `contextLoad`
  // is the chars/token heuristic rather than provider-reported input tokens
  // (post-compaction / /clear / resume / provider-switch resets, or a
  // provider that never reports prompt_tokens). True renders the token P%
  // as `(~P%)` — never an exact fact. False forces the exact `(P%)` form.
  // Null/absent falls back to `isEstimatedLoad` below (estimated iff usage
  // exists with no reported prompt_tokens at all). Optional so existing
  // call sites keep working unchanged; a caller that tracks the report
  // latch may pass it for full accuracy on reset paths.
  loadEstimated?: boolean | null;
  reasoningDisplay: string;
  mode: string;
  trustAll: boolean;
  busy: boolean;
  // Live activity text (verb + target) when a tool runs, else the phase
  // label. Shown only while busy. Optional: absent means phaseLabel.
  activity?: string | null;
  phaseLabel: string;
  elapsedSecs: number;
  stalled: boolean;
  // The approval modal carries the decision itself; the bar only marks the
  // wait so a scrolled-off modal still reads as "waiting on you".
  approvalPending: boolean;
  // Cwd + git branch (idle only). Optional: absent means no location segment.
  cwd?: string;
  branch?: string | null;
  // Measured terminal width (columns). The branch segment drops when the
  // full line would overflow it — a wrapped bar splits `mode: X` needles
  // across lines, so fitting matters more than the branch. Defaults to 100
  // (Ink's width when stdout reports none).
  columns?: number;
  // Pre-budgeted extension status text (ticket 10: formatExtensionStatusText
  // truncates per-segment and caps the total). The bar has a fixed width
  // contract — extension segments share it as guests: they render only when
  // the FULL line still fits `columns`, otherwise they drop whole. Builtin
  // segments never shrink, wrap, or move for an extension; the extension
  // yields, never the host. Optional: absent/empty means no segment.
  extensionStatus?: string | null;
  // Live session goal (ticket 09): appended as one compact segment
  // (`goal: <objective> [active|paused]`), truncated to fit. A builtin, but
  // the lowest-priority one: under width pressure it shrinks first and drops
  // whole before any existing segment moves. Optional: absent/null means no
  // goal is live and nothing renders.
  goal?: StatusGoal | null;
};

// Goal slice for the status bar: objective plus state only (the full text +
// cumulative stats live in `/goal` output via goalStatusText in goal.ts).
// Null/absent/empty reads as no goal — the bar renders nothing.
export type StatusGoal = { objective: string; active: boolean } | null;

// Default objective budget for the goal segment: compact enough to share the
// line with the pinned model/token/mode segments at 100 columns.
export const GOAL_STATUS_OBJECTIVE_CHARS = 32;

// Truncate an objective to n chars max (`…` tail keeps the start, which
// carries the verb). n < 4 yields "" (the caller drops the segment instead).
export function truncateGoalObjective(objective: string, max = GOAL_STATUS_OBJECTIVE_CHARS): string {
  const text = typeof objective === "string" ? objective : "";
  if (text.length <= max) return text;
  if (max < 4) return "";
  return `${text.slice(0, max - 1)}…`;
}

// Full goal segment at the default budget, or null when no goal is live.
// Paused reads distinct from active (`[paused]` vs `[active]`).
export function formatGoalSegment(goal: StatusGoal, max = GOAL_STATUS_OBJECTIVE_CHARS): string | null {
  if (!goal || typeof goal.objective !== "string" || goal.objective.length === 0) return null;
  const state = goal.active === true ? "active" : "paused";
  return `goal: ${truncateGoalObjective(goal.objective, max)} [${state}]`;
}

// Fit the goal segment into `room` chars (the width left after every other
// segment): full text when it fits, a shorter truncation when it almost
// fits, null (drop the segment) when even a stub would displace the line.
// Never throws; never returns "".
export function fitGoalSegment(goal: StatusGoal, room: number): string | null {
  if (!goal || typeof goal.objective !== "string" || goal.objective.length === 0) return null;
  if (typeof room !== "number" || !Number.isFinite(room) || room <= 0) return null;
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
  override?: boolean | null
): boolean {
  if (override === true) return true;
  if (override === false) return false;
  if (!usage || typeof load !== "number" || !Number.isFinite(load)) return false;
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
  loadEstimated?: boolean | null
): string {
  const segment = formatTokenSegment(usage, model, load);
  return isEstimatedLoad(usage, load, loadEstimated) ? markTokenEstimate(segment) : segment;
}

// ~/… collapse + tail-cut: informative, never a full scroll of nesting.
// Further shrinking for tight widths goes through shrinkTo below (the bar
// measures first and only renders what fits).
export function shortenCwd(cwd: string, home: string, max = 20): string {
  const short = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
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

// Render-count probe for the flicker tests: incremented on every StatusBar
// render (same-props parent churn — token paints, keystrokes, unrelated
// ticks — must skip it; only changed props repaint).
export const statusBarRenderProbe = { count: 0 };

export const StatusBar = React.memo(function StatusBar({
  provider,
  model,
  usageTotals,
  contextLoad,
  loadEstimated,
  reasoningDisplay,
  mode,
  trustAll,
  busy,
  activity,
  phaseLabel,
  elapsedSecs,
  stalled,
  approvalPending,
  cwd,
  branch,
  columns = 100,
  extensionStatus,
  goal,
}: StatusBarProps) {
  statusBarRenderProbe.count += 1;
  const bar = theme.symbol.bar;
  // Extension guest slot (ticket 10): pre-budgeted text renders only when
  // the full line still fits — the fixed-width contract above. The `+ 3`
  // is the ` ${bar} ` separator the segment carries with it.
  const hasExt = typeof extensionStatus === "string" && extensionStatus.length > 0;
  if (!busy) {
    const token = formatStatusTokenSegment(usageTotals, model, contextLoad, loadEstimated);
    const trust = trustAll && mode !== "plan" ? "+trust" : "";
    // Waiting-approval while idle (ticket 06): the decision flag is pinned —
    // decision demand outranks location. It joins the width budget up front
    // so the location (then the goal) yields for it instead of overflowing.
    const approvalSeg = approvalPending ? ` ${bar} waiting approval` : "";
    // Measure-first layout: the location (cwd + branch) flexes so the whole
    // line always fits `columns`. Fixed segments never shrink (wrapping
    // would split `mode: X` needles across lines); the location yields in
    // order: branch → cwd tail → the whole segment.
    const tail = `reasoning: ${reasoningDisplay} ${bar} mode: ${mode}${trust}`;
    const baseLen = `${provider}/${model} ${bar} ${token} ${bar}  ${bar} ${tail}${approvalSeg}`.length;
    const showExt = hasExt && baseLen + (extensionStatus as string).length + 3 + 2 <= columns;
    const avail = columns - baseLen - (showExt ? (extensionStatus as string).length + 3 : 0);
    let loc: string | null = null;
    if (cwd) {
      const branchPart = branch ? ` : ${branch}` : "";
      if (3 + cwd.length + branchPart.length <= avail) {
        loc = `${cwd}${branchPart}`;
      } else if (3 + cwd.length <= avail) {
        loc = cwd;
      } else {
        const shrunk = shrinkTo(cwd, avail - 3);
        loc = shrunk ? shrunk : null;
      }
    }
    // Goal segment (ticket 09): lowest-priority builtin — it takes only the
    // width left after every other segment and drops whole rather than push
    // the line past `columns`. Hidden entirely with no goal.
    const lineSoFar = baseLen + (showExt ? (extensionStatus as string).length + 3 : 0) + (loc ? loc.length + 3 : 0);
    const goalSeg = fitGoalSegment(goal ?? null, columns - lineSoFar - 2);
    return (
      // flexShrink=0: footer-cluster anchoring (ticket 05) — the status line
      // is the cluster's bottom pin; segments fit-or-drop via `columns`
      // (ticket 06 discipline: decision flag outranks location, goal yields).
      <Box marginTop={theme.spacing.statusMarginTop} flexShrink={0}>
        <Text dimColor>
          {provider}/{model} {bar} {token}
          {showExt ? (
            <>
              {" "}{bar} {extensionStatus}
            </>
          ) : null}
          {loc ? (
            <>
              {" "}{bar} {loc}
            </>
          ) : null}{" "}
          {bar} reasoning: {reasoningDisplay} {bar} mode: {mode}
          {/* +trust is latent in plan mode (trust cannot auto-approve while
              read-only), so it is hidden there to avoid implying approval. */}
          {trust ? "+trust" : null}
          {approvalPending ? (
            <Text color={theme.color.warning}>{approvalSeg}</Text>
          ) : null}
          {goalSeg ? (
            <>
              {" "}{bar} {goalSeg}
            </>
          ) : null}
        </Text>
      </Box>
    );
  }
  // Busy layout prioritizes activity + clock + interrupt hint; the mode
  // stays pinned (it used to vanish while working), and the reasoning
  // effort stays visible (it used to vanish while working). The activity text
  // shrinks to fit so `esc stops` never wraps away.
  const busyTrust = trustAll && mode !== "plan" ? "+trust" : "";
  const busyToken = formatStatusTokenSegment(usageTotals, model, contextLoad, loadEstimated);
  // Goal segment (ticket 09): a guest in the fixed part — capped at 48
  // chars and rendered only when the FULL activity text still fits beside
  // it. Otherwise the goal drops whole and every existing segment renders
  // exactly as with no goal (the goal never displaces, same precedent as
  // the extension guest above). The clock, token, mode, and esc-hint
  // segments never move for it either way.
  const busyGoalSeg = fitGoalSegment(goal ?? null, 48);
  const busyGoalCandidate = busyGoalSeg ? ` ${bar} ${busyGoalSeg}` : "";
  const activityFull = activity ?? phaseLabel;
  const busyCore = ` ${bar} ${elapsedSecs}s ${bar} ${busyToken} ${bar} reasoning: ${reasoningDisplay} ${bar} mode: ${mode}${busyTrust}`;
  const busyTail = ` ${bar} esc stops`;
  const busyExtCandidate =
    hasExt && `${busyCore}${busyGoalCandidate}${busyTail}`.length + (extensionStatus as string).length + 3 + 2 <= columns
      ? ` ${bar} ${extensionStatus}`
      : "";
  const withGoalFixed = `${busyCore}${busyExtCandidate}${busyGoalCandidate}${busyTail}`;
  // Room check against the unfitted activity text: when it no longer fits
  // whole with the goal aboard, the goal yields (drop whole, recompute).
  const busyGoalPart =
    busyGoalCandidate !== "" &&
    withGoalFixed.length + activityFull.length + 2 <= columns
      ? busyGoalCandidate
      : "";
  const busyNoExt = `${busyCore}${busyGoalPart}${busyTail}`;
  const showBusyExt = hasExt && busyNoExt.length + (extensionStatus as string).length + 3 + 2 <= columns;
  const busyFixed = ` ${bar} ${elapsedSecs}s${showBusyExt ? ` ${bar} ${extensionStatus}` : ""} ${bar} ${busyToken} ${bar} reasoning: ${reasoningDisplay} ${bar} mode: ${mode}${busyTrust}${busyGoalPart} ${bar} esc stops`;
  const busyAvail = columns - busyFixed.length - 2;
  const activityText = shrinkTo(activityFull, Math.max(0, busyAvail));
  return (
    // flexShrink=0: same footer-cluster pin as the idle layout above.
    <Box marginTop={theme.spacing.statusMarginTop} flexShrink={0}>
      <Text dimColor>
        <Text color={theme.color.activity}>{theme.symbol.workTool} {activityText}</Text>
        {busyFixed}
        {stalled && !approvalPending ? ` ${bar} waiting${theme.symbol.ellipsis}` : null}
        {approvalPending ? (
          <Text color={theme.color.warning}> {bar} waiting approval</Text>
        ) : null}
      </Text>
    </Box>
  );
});
