// Usage ledger panel: read-only per-POST usage history for the session.
//
// Mounted in the dynamic zone in place of the input (same pattern as the
// tool inspector). Turn steps and compaction POSTs render with distinct
// kind tags; a POST that reported nothing renders an explicit not-reported
// row, never zeros. Cost renders only when the step carries a reported
// figure (no pricing table exists yet — see src/usage-ledger.ts).
// Paint from ui/theme tokens — no literal colors or glyphs here.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { windowedList } from "./tool-inspector.js";
import {
  formatStepUsage,
  formatSubscriptionUsage,
  type SubscriptionUsage,
  type UsageStep,
} from "../usage-ledger.js";

export const USAGE_LEDGER_WINDOW = 15;

export type UsageLedgerPanelProps = {
  steps: UsageStep[];
  index: number;
  /** Cross-session per-provider totals (Task 3.1); rendered as a footer. */
  subscription?: SubscriptionUsage[];
  // Row cap (Phase 1 containment): the panel clips its own overflow instead
  // of growing the frame to the viewport — App passes
  // `overlayRows(rows, RESERVED_FOOTER_ROWS.ledger)`. Undefined keeps the
  // legacy windows byte-identically.
  maxRows?: number;
};

// Panel rows besides the windowed/subscription rows: header 1 + above/below
// indicators 2 + hint 1 + the totals block's marginTop 1.
const LEDGER_CHROME_ROWS = 5;

// Per-provider period totals footer: shown only when aggregates exist
// (a fresh session or unattributed rows render nothing here). Capped to its
// `maxRows` budget with an explicit remainder line — a long provider list
// must not grow the frame to the viewport (Phase 1 containment).
function SubscriptionTotals({
  subscription,
  maxRows,
}: {
  subscription?: SubscriptionUsage[];
  maxRows: number;
}) {
  if (!subscription || subscription.length === 0) return null;
  const visibleRows = Math.max(1, maxRows - 1);
  const visible = subscription.slice(0, visibleRows);
  const hidden = subscription.length - visible.length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold wrap="truncate">
        Subscription totals {theme.symbol.descSeparator} provider · period (all sessions)
      </Text>
      {visible.map((u) => (
        <Text key={`${u.provider}:${u.period}`} dimColor wrap="truncate">
          {formatSubscriptionUsage(u)}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor wrap="truncate">
          {theme.symbol.ellipsis} {hidden} more provider period
          {hidden === 1 ? "" : "s"}
        </Text>
      ) : null}
    </Box>
  );
}

export function UsageLedgerPanel({ steps, index, subscription, maxRows }: UsageLedgerPanelProps) {
  // Uncapped (no maxRows): the totals render in full, the window stays
  // USAGE_LEDGER_WINDOW — legacy behavior, byte-identical.
  const subCount = subscription?.length ?? 0;
  const subBudget = maxRows === undefined ? Infinity : maxRows - LEDGER_CHROME_ROWS;
  if (steps.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">Usage ledger {theme.symbol.descSeparator} per-POST tokens, oldest first (Esc closes):</Text>
        <Text dimColor wrap="wrap">(no model calls yet — rows appear here as POSTs report, one per call)</Text>
        <SubscriptionTotals subscription={subscription} maxRows={subBudget} />
      </Box>
    );
  }
  const sel = Math.max(0, Math.min(index, steps.length - 1));
  // Subscription rows take their share of the cap first (the totals block
  // must stay visible below the window), then the step window takes the
  // rest — at least one row.
  const subRows = Math.min(subCount, Math.max(0, subBudget - 1));
  const windowRows = Math.max(
    1,
    Math.min(USAGE_LEDGER_WINDOW, subBudget - subRows)
  );
  const win = windowedList(steps, sel, windowRows);
  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden">
      {/* Clip, never squeeze (Phase 1 spike): a height-capped Box shrinks
        direct flex children fractionally, overprinting rows onto each other.
        The unsquishable wrapper keeps every row at its natural height so the
        panel's overflow="hidden" clips the tail cleanly. */}
      <Box flexDirection="column" flexShrink={0}>
      <Text bold wrap="truncate">Usage ledger {theme.symbol.descSeparator} per-POST tokens, oldest first (Esc closes):</Text>
      {win.above > 0 ? (
        <Text dimColor>
          {theme.symbol.moreAbove} {win.above} more
        </Text>
      ) : null}
      {win.slice.map((s, k) => {
        const i = win.start + k;
        const hi = i === sel;
        const breakdown = formatStepUsage(s.usage);
        return (
          <Text key={s.seq} wrap="truncate" color={hi ? theme.color.selection : undefined}>
            {hi ? `${theme.symbol.select} ` : theme.spacing.rowIndent}#{s.seq}{" "}
            {s.kind === "compaction" ? "[compact]" : "[turn]"}{" "}
            {s.model}
            {s.user ? ` @${s.user}` : ""} {theme.symbol.descSeparator}{" "}
            {breakdown ?? <Text dimColor>n/a (not reported)</Text>}
            {typeof s.costUsd === "number" ? ` ${theme.symbol.descSeparator} $${s.costUsd.toFixed(4)}` : null}
          </Text>
        );
      })}
      {win.below > 0 ? (
        <Text dimColor>
          {theme.symbol.moreBelow} {win.below} more
        </Text>
      ) : null}
      <SubscriptionTotals subscription={subscription} maxRows={subBudget} />
      <Text dimColor wrap="truncate">
        {theme.symbol.moreAbove}/{theme.symbol.moreBelow} move · Esc closes
      </Text>
      </Box>
    </Box>
  );
}
