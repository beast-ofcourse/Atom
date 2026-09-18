// Status bar leaf: the sole info bar, state-prioritized and quiet (ticket 06
// information discipline).
// - idle: provider/model │ token │ cwd[:branch] │ reasoning │ mode.
//   Labels are positional (no `provider:` prefixes); mode/trust show always
//   (pinned), cwd shortens, branch only for git repos. A pending approval
//   pins a `waiting approval` decision flag (warning color) — decision demand
//   outranks location, which yields first under width pressure.
// - busy: activity │ provider/model │ elapsed │ token │ reasoning │ mode │ esc-hint (+waiting/approval flags).
//   Cwd drops while working — the activity, the model, the clock, context
//   pressure, effort, and the pinned mode are what matter mid-turn.
// - estimates: the token P% reads `(~P%)` (tilde) whenever the context load
//   is a chars-based estimate rather than provider-reported input tokens
//   (see `loadEstimated` / `isEstimatedLoad`); `token: n/a` and bare
//   `token: NK` never gain a marker. Estimates are never exact facts.
// All paint comes from ui/theme tokens. The token segment formatter lives
// in context-windows (its only surface).
import React from "react";
import { Box, Text } from "ink";
import type { Usage } from "../zen.js";
import { theme } from "./theme.js";
import {
  GOAL_STATUS_OBJECTIVE_CHARS,
  fitGoalSegment,
  formatGoalSegment,
  formatStatusTokenSegment,
  isEstimatedLoad,
  markTokenEstimate,
  shortenCwd,
  shrinkTo,
  truncateGoalObjective,
} from "./pills.js";
import type { StatusGoal } from "./pills.js";

export {
  GOAL_STATUS_OBJECTIVE_CHARS,
  fitGoalSegment,
  formatGoalSegment,
  formatStatusTokenSegment,
  isEstimatedLoad,
  markTokenEstimate,
  shortenCwd,
  shrinkTo,
  truncateGoalObjective,
};
export type { StatusGoal };

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
  // across lines, so fitting matters more than the branch. Defaults to
  // theme.spacing.statusDefaultColumns (Ink's width when stdout reports none).
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
  columns = theme.spacing.statusDefaultColumns,
  extensionStatus,
  goal,
}: StatusBarProps) {
  statusBarRenderProbe.count += 1;
  const bar = theme.symbol.bar;
  // Extension guest slot (ticket 10): pre-budgeted text renders only when
  // the full line still fits — the fixed-width contract above. The `+ 3`
  // is the ` ${bar} ` separator the segment carries with it.
  const hasExt =
    typeof extensionStatus === "string" && extensionStatus.length > 0;
  if (!busy) {
    const token = formatStatusTokenSegment(
      usageTotals,
      model,
      contextLoad,
      loadEstimated,
    );
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
    const baseLen =
      `${provider}/${model} ${bar} ${token} ${bar}  ${bar} ${tail}${approvalSeg}`
        .length;
    const showExt =
      hasExt && baseLen + (extensionStatus as string).length + 3 + 2 <= columns;
    const avail =
      columns -
      baseLen -
      (showExt ? (extensionStatus as string).length + 3 : 0);
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
    const lineSoFar =
      baseLen +
      (showExt ? (extensionStatus as string).length + 3 : 0) +
      (loc ? loc.length + 3 : 0);
    const goalSeg = fitGoalSegment(goal ?? null, columns - lineSoFar - 2);
    // Narrow yield (observed at 60 cols via PTY harness): fixed segments
    // never shrink, but once location/goal yield the line can still exceed
    // `columns` and Ink wraps `mode: X` across lines. The reasoning segment
    // yields next (lowest fixed priority) so model/token/mode stay on one
    // row. Starvation below ~50 cols uses the xs floor instead.
    const reasonSeg = ` ${bar} reasoning: ${reasoningDisplay}`;
    const fullLen = lineSoFar + (goalSeg ? goalSeg.length + 3 : 0);
    const showReason = fullLen <= columns;
    // Starvation floor (xs, below theme.spacing.statusXsColumns): fixed
    // segments alone exceed the width. Render model + mode only — token, reasoning, location, and
    // guests drop whole rather than wrap `mode: X`. Approval still pins.
    if (columns < theme.spacing.statusXsColumns) {
      return (
        <Box marginTop={theme.spacing.statusMarginTop} flexShrink={0}>
          <Text dimColor>
            <Text color={theme.color.inputPrompt} bold>
              {model}
            </Text>{" "}
            {bar}{" "}
            <Text color={theme.color.success} bold>
              mode: {mode}
            </Text>
            {trust ? "+trust" : null}
            {approvalPending ? (
              <Text color={theme.color.warning}> {bar} waiting approval</Text>
            ) : null}
          </Text>
        </Box>
      );
    }
    return (
      // flexShrink=0: footer-cluster anchoring (ticket 05) — the status line
      // is the cluster's bottom pin; segments fit-or-drop via `columns`
      // (ticket 06 discipline: decision flag outranks location, goal yields).
      <Box marginTop={theme.spacing.statusMarginTop} flexShrink={0}>
        <Text dimColor>
          <Text color={theme.color.inputPrompt} bold>
            {provider}/{model}
          </Text>
          <Text dimColor>
            {" "}
            {bar} {token}
          </Text>
          {showExt ? (
            <>
              {" "}
              {bar} {extensionStatus}
            </>
          ) : null}
          {loc ? (
            <>
              {" "}
              {bar} {loc}
            </>
          ) : null}
          {showReason ? <>{reasonSeg}</> : null} {bar}{" "}
          <Text color={theme.color.success} bold>
            mode: {mode}
          </Text>
          {/* +trust is latent in plan mode (trust cannot auto-approve while
              read-only), so it is hidden there to avoid implying approval. */}
          {trust ? "+trust" : null}
          {approvalPending ? (
            <Text color={theme.color.warning}>{approvalSeg}</Text>
          ) : null}
          {goalSeg ? (
            <>
              {" "}
              {bar} {goalSeg}
            </>
          ) : null}
        </Text>
      </Box>
    );
  }
  // Busy layout prioritizes activity + model + clock + interrupt hint;
  // the model stays visible (the user needs to know which model is working),
  // the mode stays pinned (it used to vanish while working), and the
  // reasoning effort stays visible (it used to vanish while working). The
  // activity text shrinks to fit so `esc stops` never wraps away.
  const busyTrust = trustAll && mode !== "plan" ? "+trust" : "";
  const busyToken = formatStatusTokenSegment(
    usageTotals,
    model,
    contextLoad,
    loadEstimated,
  );
  // Goal segment (ticket 09): a guest in the fixed part — capped at
  // theme.spacing.statusBusyGoalChars and rendered only when the FULL activity text still fits beside
  // it. Otherwise the goal drops whole and every existing segment renders
  // exactly as with no goal (the goal never displaces, same precedent as
  // the extension guest above). The clock, token, mode, and esc-hint
  // segments never move for it either way.
  const busyGoalSeg = fitGoalSegment(
    goal ?? null,
    theme.spacing.statusBusyGoalChars,
  );
  const busyGoalCandidate = busyGoalSeg ? ` ${bar} ${busyGoalSeg}` : "";
  const activityFull = activity ?? phaseLabel;
  // Busy width discipline (observed at 100 cols via PTY harness): the
  // activity shrinks, but fixed segments never do — with a long model,
  // token, clock, and `waiting…` even an empty activity overflows and Ink
  // wraps the tail. The reasoning segment yields first (rebuilt without it
  // when the fixed part alone exceeds `columns`); below that floor the line
  // still wraps, same as before. Guests (ext/goal) keep yielding first.
  function buildBusyParts(includeReason: boolean): {
    busyFixed: string;
    busyExtra: string;
    activityText: string;
  } {
    const busyReasonSeg = includeReason
      ? ` ${bar} reasoning: ${reasoningDisplay}`
      : "";
    const busyCore = ` ${bar} ${elapsedSecs}s ${bar} ${busyToken}${busyReasonSeg} ${bar} mode: ${mode}${busyTrust}`;
    // While a permission modal owns the keyboard, Enter answers the modal —
    // the queue hint would lie, so it drops (this also keeps the approval line
    // on one row: the modal already explains its own keys).
    const busyTail = approvalPending
      ? ` ${bar} esc stops`
      : ` ${bar} esc stops ${theme.symbol.separator} Enter queues`;
    const busyExtCandidate =
      hasExt &&
      `${busyCore}${busyGoalCandidate}${busyTail}`.length +
        (extensionStatus as string).length +
        3 +
        2 <=
        columns
        ? ` ${bar} ${extensionStatus}`
        : "";
    const withGoalFixed = `${busyCore}${busyExtCandidate}${busyGoalCandidate}${busyTail}`;
    // Room check against the unfitted activity text: when it no longer fits
    // whole with the goal aboard, the goal yields (drop whole, recompute).
    // Provider/model is now a fixed part of the busy line (always visible),
    // so the width check accounts for it via busyFixed.
    const busyGoalPart =
      busyGoalCandidate !== "" &&
      withGoalFixed.length + activityFull.length + 2 <= columns
        ? busyGoalCandidate
        : "";
    const busyNoExt = `${busyCore}${busyGoalPart}${busyTail}`;
    const showBusyExt =
      hasExt &&
      busyNoExt.length + (extensionStatus as string).length + 3 + 2 <= columns;
    const busyFixed = ` ${bar} ${provider}/${model} ${bar} ${elapsedSecs}s${showBusyExt ? ` ${bar} ${extensionStatus}` : ""} ${bar} ${busyToken}${busyReasonSeg} ${bar} mode: ${mode}${busyTrust}${busyGoalPart}${busyTail}`;
    const busyExtra = `${stalled && !approvalPending ? ` ${bar} waiting${theme.symbol.ellipsis}` : ""}${approvalPending ? ` ${bar} waiting approval` : ""}`;
    const busyAvail = columns - busyFixed.length - busyExtra.length - 2;
    const activityText = shrinkTo(activityFull, Math.max(0, busyAvail));
    return { busyFixed, busyExtra, activityText };
  }
  let busyParts = buildBusyParts(true);
  if (2 + busyParts.busyFixed.length + busyParts.busyExtra.length > columns) {
    busyParts = buildBusyParts(false);
  }
  // Starvation floor (xs, below theme.spacing.statusXsColumns): even
  // reason-less the fixed busy line
  // overflows (model + clock + hints). Render the minimum viable working
  // line — model, mode, esc hint — so nothing wraps mid-token. The guest
  // segments, clock, and queue hint drop; approval still pins.
  if (columns < theme.spacing.statusXsColumns) {
    return (
      <Box marginTop={theme.spacing.statusMarginTop} flexShrink={0}>
        <Text dimColor>
          <Text color={theme.color.inputPrompt} bold>
            {model}
          </Text>{" "}
          {bar}{" "}
          <Text color={theme.color.success} bold>
            mode: {mode}
          </Text>{" "}
          {bar} esc stops
          {approvalPending ? (
            <Text color={theme.color.warning}> {bar} waiting approval</Text>
          ) : null}
        </Text>
      </Box>
    );
  }
  const { busyFixed, activityText } = busyParts;
  return (
    // flexShrink=0: same footer-cluster pin as the idle layout above.
    <Box marginTop={theme.spacing.statusMarginTop} flexShrink={0}>
      <Text dimColor>
        <Text color={theme.color.activity}>
          {theme.symbol.workTool} {activityText}
        </Text>
        {busyFixed}
        {stalled && !approvalPending
          ? ` ${bar} waiting${theme.symbol.ellipsis}`
          : null}
        {approvalPending ? (
          <Text color={theme.color.warning}> {bar} waiting approval</Text>
        ) : null}
      </Text>
    </Box>
  );
});
