// Per-step usage ledger (realtime-token-usage 05): one row per model POST.
//
// Rows cover ordinary turn steps plus compaction POSTs, kept visually
// distinct by kind. A POST that reported no usage keeps an explicit
// not-reported row (usage null) — never a zero row, never synthesized.
// Cost: there is no pricing table in the app (telemetry never synthesizes
// cost), so rows carry no cost figure until 04 lands; the optional costUsd
// slot exists for that ticket and renders only when defined.
//
// Pure + testable: recording is append-only with a cap; formatting lives
// in the UI panel (src/ui/usage-ledger.tsx). No React, no Ink here.
import type { TokenUsage } from "./telemetry.js";

export type UsageStepKind = "turn" | "compaction";

export type UsageStep = {
  seq: number;
  kind: UsageStepKind;
  sessionId: string;
  model: string;
  usage: TokenUsage | null;
  costUsd?: number;
  at: string;
};

// Session row cap: the dialog windows anyway; the cap only bounds memory
// for very long sessions. Oldest-first eviction.
export const MAX_USAGE_STEPS = 300;

export type RecordUsageStepInput = {
  kind: UsageStepKind;
  sessionId: string;
  model: string;
  usage?: TokenUsage | null;
  costUsd?: number;
  at?: string;
};

// Append one step, assigning the next seq. Never throws; invalid input is
// ignored (returns the array unchanged) so observer errors never break turns.
export function recordUsageStep(steps: UsageStep[], input: RecordUsageStepInput): UsageStep[] {
  try {
    if (!Array.isArray(steps)) return steps;
    if (!input || typeof input !== "object") return steps;
    if (input.kind !== "turn" && input.kind !== "compaction") return steps;
    if (typeof input.sessionId !== "string" || typeof input.model !== "string") return steps;
    const seq =
      steps.length === 0 ? 1 : (steps[steps.length - 1]?.seq ?? 0) + 1;
    const next: UsageStep = {
      seq,
      kind: input.kind,
      sessionId: input.sessionId,
      model: input.model,
      usage: input.usage ?? null,
      at: typeof input.at === "string" ? input.at : new Date().toISOString(),
    };
    if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0) {
      next.costUsd = input.costUsd;
    }
    const out = [...steps, next];
    return out.length > MAX_USAGE_STEPS ? out.slice(out.length - MAX_USAGE_STEPS) : out;
  } catch {
    return steps;
  }
}

// Rows for one session, oldest first. Never throws.
export function stepsForSession(steps: UsageStep[], sessionId: string): UsageStep[] {
  try {
    if (!Array.isArray(steps)) return [];
    return steps.filter((s) => s?.sessionId === sessionId);
  } catch {
    return [];
  }
}

// One-line token breakdown, or null when nothing was reported (the panel
// renders the explicit not-reported row instead of a zero row).
export function formatStepUsage(usage: TokenUsage | null | undefined): string | null {
  try {
    if (!usage || typeof usage !== "object") return null;
    const parts: string[] = [];
    if (typeof usage.prompt_tokens === "number") parts.push(`in ${usage.prompt_tokens}`);
    if (typeof usage.completion_tokens === "number") parts.push(`out ${usage.completion_tokens}`);
    if (typeof usage.total_tokens === "number") parts.push(`total ${usage.total_tokens}`);
    const cache: string[] = [];
    if (typeof usage.cacheReadTokens === "number") cache.push(`read ${usage.cacheReadTokens}`);
    if (typeof usage.cacheWriteTokens === "number") cache.push(`write ${usage.cacheWriteTokens}`);
    if (cache.length > 0) parts.push(`cache ${cache.join("/")}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  } catch {
    return null;
  }
}
