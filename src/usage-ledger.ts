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
import type { ProviderId } from "./providers.js";
import type { TokenUsage } from "./telemetry.js";

export type UsageStepKind = "turn" | "compaction";

export type UsageStep = {
  seq: number;
  kind: UsageStepKind;
  sessionId: string;
  model: string;
  /** Attribution for subscription aggregates; absent on legacy/unattributed rows. */
  provider?: ProviderId;
  /** Local OS user who ran the step (per-user attribution); absent on legacy rows. */
  user?: string;
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
  provider?: ProviderId;
  user?: string;
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
    if (typeof input.provider === "string" && input.provider.length > 0) {
      next.provider = input.provider;
    }
    if (typeof input.user === "string" && input.user.length > 0) {
      next.user = input.user;
    }
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

// --- subscription usage (Task 3.1): per-provider, per-period aggregates ---

// One provider's totals for one billing period ("2026-10"). costUsd is
// present only when at least one row actually reported a cost — there is no
// pricing table in the app, so an absent cost means "unknown", never $0.
// limit is the provider-reported tier limit passed in by the caller (the
// subscription status endpoint), never a synthesized number.
export type SubscriptionUsage = {
  provider: ProviderId;
  period: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  limit?: number;
};

// Steps record ISO timestamps; the period is the leading YYYY-MM.
const PERIOD_PREFIX = /^\d{4}-\d{2}/;

type GroupAccumulator = {
  usage: SubscriptionUsage;
  costUsd: number;
  costReported: boolean;
};

function accumulateStep(groups: Map<string, GroupAccumulator>, step: UsageStep): void {
  if (!step.provider || !step.usage) return; // unattributed or not-reported rows contribute nothing
  const match = PERIOD_PREFIX.exec(step.at);
  if (!match) return;
  const period = match[0];
  const key = `${step.provider}:${period}`;
  let group = groups.get(key);
  if (!group) {
    group = {
      usage: {
        provider: step.provider,
        period,
        inputTokens: 0,
        outputTokens: 0,
      },
      costUsd: 0,
      costReported: false,
    };
    groups.set(key, group);
  }
  const prompt = step.usage.prompt_tokens;
  if (typeof prompt === "number" && Number.isFinite(prompt)) {
    group.usage.inputTokens += prompt;
  }
  const completion = step.usage.completion_tokens;
  if (typeof completion === "number" && Number.isFinite(completion)) {
    group.usage.outputTokens += completion;
  }
  if (
    typeof step.costUsd === "number" &&
    Number.isFinite(step.costUsd) &&
    step.costUsd >= 0
  ) {
    group.costUsd += step.costUsd;
    group.costReported = true;
  }
}

/**
 * Aggregate recorded steps into per-provider, per-period subscription
 * totals. Rows without a provider or without reported usage are skipped
 * (never synthesized into zero rows). `limits` attaches a caller-known tier
 * limit per provider; nothing is invented when absent. Never throws.
 */
export function aggregateSubscriptionUsage(
  steps: UsageStep[],
  limits?: Partial<Record<ProviderId, number>>
): SubscriptionUsage[] {
  try {
    if (!Array.isArray(steps)) return [];
    const groups = new Map<string, GroupAccumulator>();
    for (const step of steps) accumulateStep(groups, step);
    const out: SubscriptionUsage[] = [];
    for (const group of groups.values()) {
      const usage = group.usage;
      if (group.costReported) usage.costUsd = group.costUsd;
      const limit = limits?.[usage.provider];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
        usage.limit = limit;
      }
      out.push(usage);
    }
    // Deterministic display order: provider alphabetically, newest period first.
    return out.sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || b.period.localeCompare(a.period)
    );
  } catch {
    return [];
  }
}

// One aggregate row: "openai 2026-10 · in 1234 · out 567 · $0.4200 · limit 500"
// (cost and limit parts appear only when known).
export function formatSubscriptionUsage(usage: SubscriptionUsage): string {
  const parts = [
    `${usage.provider} ${usage.period}`,
    `in ${usage.inputTokens}`,
    `out ${usage.outputTokens}`,
  ];
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (usage.limit !== undefined) parts.push(`limit ${usage.limit}`);
  return parts.join(" · ");
}
