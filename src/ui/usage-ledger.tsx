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
import { formatStepUsage, type UsageStep } from "../usage-ledger.js";

export const USAGE_LEDGER_WINDOW = 15;

export type UsageLedgerPanelProps = {
  steps: UsageStep[];
  index: number;
};

export function UsageLedgerPanel({ steps, index }: UsageLedgerPanelProps) {
  if (steps.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">Usage ledger {theme.symbol.descSeparator} per-POST tokens, oldest first (Esc closes):</Text>
        <Text dimColor wrap="wrap">(no model calls yet — rows appear here as POSTs report, one per call)</Text>
      </Box>
    );
  }
  const sel = Math.max(0, Math.min(index, steps.length - 1));
  const win = windowedList(steps, sel, USAGE_LEDGER_WINDOW);
  return (
    <Box flexDirection="column">
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
            {s.model} {theme.symbol.descSeparator}{" "}
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
      <Text dimColor wrap="truncate">
        {theme.symbol.moreAbove}/{theme.symbol.moreBelow} move · Esc closes
      </Text>
    </Box>
  );
}
