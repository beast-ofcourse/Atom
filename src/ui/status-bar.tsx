// Status bar leaf: the sole info bar, state-prioritized and quiet.
// - idle: provider/model │ token │ cwd[:branch] │ reasoning │ mode.
//   Labels are positional (no `provider:` prefixes); mode/trust show always
//   (pinned), cwd shortens, branch only for git repos.
// - busy: activity │ elapsed │ token │ reasoning │ mode │ esc-hint (+waiting/approval flags).
//   Provider/model/cwd drop while working — the activity, the
//   clock, context pressure, effort, and the pinned mode are what matter mid-turn.
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
};

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
}: StatusBarProps) {
  statusBarRenderProbe.count += 1;
  const bar = theme.symbol.bar;
  if (!busy) {
    const token = formatTokenSegment(usageTotals, model, contextLoad);
    const trust = trustAll && mode !== "plan" ? "+trust" : "";
    // Measure-first layout: the location (cwd + branch) flexes so the whole
    // line always fits `columns`. Fixed segments never shrink (wrapping
    // would split `mode: X` needles across lines); the location yields in
    // order: branch → cwd tail → the whole segment.
    const tail = `reasoning: ${reasoningDisplay} ${bar} mode: ${mode}${trust}`;
    const baseLen = `${provider}/${model} ${bar} ${token} ${bar}  ${bar} ${tail}`.length;
    const avail = columns - baseLen;
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
    return (
      <Box marginTop={theme.spacing.statusMarginTop}>
        <Text dimColor>
          {provider}/{model} {bar} {token}
          {loc ? (
            <>
              {" "}{bar} {loc}
            </>
          ) : null}{" "}
          {bar} reasoning: {reasoningDisplay} {bar} mode: {mode}
          {/* +trust is latent in plan mode (trust cannot auto-approve while
              read-only), so it is hidden there to avoid implying approval. */}
          {trust ? "+trust" : null}
        </Text>
      </Box>
    );
  }
  // Busy layout prioritizes activity + clock + interrupt hint; the mode
  // stays pinned (it used to vanish while working), and the reasoning
  // effort stays visible (it used to vanish while working). The activity text
  // shrinks to fit so `esc stops` never wraps away.
  const busyTrust = trustAll && mode !== "plan" ? "+trust" : "";
  const busyFixed = ` ${bar} ${elapsedSecs}s ${bar} ${formatTokenSegment(usageTotals, model, contextLoad)} ${bar} reasoning: ${reasoningDisplay} ${bar} mode: ${mode}${busyTrust} ${bar} esc stops`;
  const busyAvail = columns - busyFixed.length - 2;
  const activityText = shrinkTo(activity ?? phaseLabel, Math.max(0, busyAvail));
  return (
    <Box marginTop={theme.spacing.statusMarginTop}>
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
