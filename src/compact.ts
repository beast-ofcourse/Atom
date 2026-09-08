// Context compaction (Claude-Code/opencode-style) for the Ink chatbot.
// AUTO-COMPACT at ~83% of the model's verified context window plus manual
// `/compact [focus]` (see App.tsx slash registry).
//
// Mechanics mirrored from research (verified this session):
// - Claude Code: auto-compact = ONE extra request (same system prompt +
//   tools + history, summarization instruction appended); history replaced
//   by the summary; manual `/compact [focus]`; thrashing guard.
// - opencode V2: preflight estimate = JSON-serialized request size at
//   4 chars/token; summary via session model with TOOLS DISABLED, ≤4096
//   output tokens, structured template; newest tail retained (~8000 tokens,
//   tool outputs capped 2000 chars); overflow-recovery retry once.
//
// This module is pure + testable (mocked fetch only in tests, never live).
// The App owns session refs (load/streak/disabled/pending) and the atomic
// swap + save; this module owns math, splitting, instruction, and the
// summary POST (tools disabled, 4096 cap).

import { contextWindowFor } from "./context-windows.js";
import {
  historyChars,
  messageChars,
  chatCompletionForProvider,
  type ChatMessage,
} from "./zen.js";
import type { ProviderId } from "./providers.js";

// ---- Constants ----
export const COMPACT_PCT_DEFAULT = 0.83;
export const COMPACT_KEEP_TOKENS = 8000;
export const COMPACT_SUMMARY_MAX_TOKENS = 4096;
export const COMPACT_TOOL_OUTPUT_CAP = 2000;
// opencode's 4ch/token heuristic (V2 preflight estimate): chars/4 floors to
// estimated tokens. Used for load fallback + tail split only, never for the
// `token: n/a` honesty rule or the NK cumulative spend.
export const COMPACT_CHARS_PER_TOKEN = 4;
export const COMPACT_THRASH_LIMIT = 3;

// ---- Threshold ----
function clampPctPercent(n: number): number {
  return Math.min(Math.max(n, 50), 95) / 100;
}

// Auto-compact threshold as a fraction (default 0.83). Env ATOM_COMPACT_PCT
// is a percent (e.g. "83"), clamped 50–95; invalid/unset → default.
export function compactPct(): number {
  const raw = process.env.ATOM_COMPACT_PCT;
  if (raw === undefined) return COMPACT_PCT_DEFAULT;
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return COMPACT_PCT_DEFAULT;
  const n = Number(text);
  if (!Number.isFinite(n)) return COMPACT_PCT_DEFAULT;
  return clampPctPercent(n);
}

// ---- Load metric ----
export function estimateTokensForChars(chars: number): number {
  // opencode's 4ch/token heuristic.
  const c = Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0;
  return Math.floor(c / COMPACT_CHARS_PER_TOKEN);
}

// Load = last POST's reported prompt_tokens when available, else the
// 4ch/token estimate of the sent history chars.
export function computeContextLoad(
  lastPromptTokens: number | undefined,
  sentHistoryChars: number
): number {
  if (
    typeof lastPromptTokens === "number" &&
    Number.isFinite(lastPromptTokens) &&
    lastPromptTokens >= 0
  ) {
    return Math.floor(lastPromptTokens);
  }
  return estimateTokensForChars(sentHistoryChars);
}

export function shouldAutoCompact(
  load: number,
  model: string,
  pctOverride?: number
): boolean {
  const window = contextWindowFor(model);
  if (window === undefined) return false; // never invent a window
  const pct =
    typeof pctOverride === "number" && Number.isFinite(pctOverride)
      ? pctOverride
      : compactPct();
  return load / window >= pct;
}

// ---- Turn helpers ----
export function countUserTurns(history: ChatMessage[]): number {
  let n = 0;
  for (const m of history) {
    if (m?.role === "user") n += 1;
  }
  return n;
}

function turnStarts(history: ChatMessage[]): number[] {
  const starts: number[] = [];
  for (let i = 1; i < history.length; i++) {
    if (history[i]?.role === "user") starts.push(i);
  }
  return starts;
}

function turnEnd(history: ChatMessage[], startIdx: number, starts: number[]): number {
  const pos = starts.indexOf(startIdx);
  if (pos < 0) return history.length;
  return pos + 1 < starts.length ? starts[pos + 1]! : history.length;
}

function turnChars(history: ChatMessage[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) n += messageChars(history[i]!);
  return n;
}

export function capToolOutputsInTail(tail: ChatMessage[]): ChatMessage[] {
  return tail.map((m) => {
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > COMPACT_TOOL_OUTPUT_CAP) {
      return {
        ...m,
        content:
          m.content.slice(0, COMPACT_TOOL_OUTPUT_CAP) +
          "\n[truncated: tool output exceeded 2000 chars]",
      };
    }
    return { ...m } as ChatMessage;
  });
}

export type SplitResult = {
  head: ChatMessage[];
  tail: ChatMessage[];
  olderTurnCount: number;
};

// Split history (after system) into head + retained newest tail of whole
// user-turns up to KEEP_TOKENS estimated tokens (chars/4). Tool outputs in
// the tail are capped at 2000 chars each. Never drops history[0]; always
// keeps at least the newest turn; when everything fits but there is more
// than one turn, keeps only the newest turn in the tail so manual /compact
// still has an older turn to summarize.
export function splitHistoryForCompaction(
  history: ChatMessage[],
  keepTokens: number = COMPACT_KEEP_TOKENS
): SplitResult {
  if (history.length <= 1) return { head: [], tail: [], olderTurnCount: 0 };
  const starts = turnStarts(history);
  if (starts.length === 0) return { head: [], tail: [], olderTurnCount: 0 };
  let totalChars = 0;
  let tailStart: number = starts[starts.length - 1]!;
  for (let s = starts.length - 1; s >= 0; s--) {
    const start = starts[s]!;
    const end = turnEnd(history, start, starts);
    totalChars += turnChars(history, start, end);
    const est = estimateTokensForChars(totalChars);
    if (est <= keepTokens) {
      tailStart = start;
    } else {
      break;
    }
  }
  // Everything fits but >1 turn: keep only the newest turn in the tail so
  // manual /compact still has an older turn to summarize (auto never
  // reaches here — its load would be far below threshold when everything
  // fits in 8000 tokens).
  if (tailStart === starts[0] && starts.length > 1) {
    tailStart = starts[starts.length - 1]!;
  }
  const head = history.slice(1, tailStart);
  const rawTail = history.slice(tailStart);
  const tail = capToolOutputsInTail(rawTail);
  let olderTurnCount = 0;
  for (const m of head) if (m?.role === "user") olderTurnCount += 1;
  return { head, tail, olderTurnCount };
}

// ---- Instruction template ----
export function buildCompactionInstruction(focusText?: string): string {
  const focus =
    typeof focusText === "string" && focusText.trim().length > 0
      ? `\nFocus for this summary: ${focusText.trim()}\n`
      : "";
  return (
    `Summarize the conversation so far for context compaction. Be concise but preserve all information needed to continue the work without re-reading the full history.` +
    `${focus}\n` +
    `Structure your summary with these headings (omit a section only when it has no content):\n` +
    `## Objective\n` +
    `## Requirements\n` +
    `## Decisions\n` +
    `## Completed work\n` +
    `## Active work\n` +
    `## Blockers\n` +
    `## Next moves\n` +
    `## Relevant files\n` +
    `Rules: no tools are available for this request — answer with the summary text only, no tool calls, no preamble beyond the headings.`
  );
}

export function buildSummaryMessages(
  systemContent: string,
  head: ChatMessage[],
  focusText?: string
): ChatMessage[] {
  return [
    { role: "system", content: systemContent },
    ...head.map((m) => ({ ...m }) as ChatMessage),
    { role: "user", content: buildCompactionInstruction(focusText) },
  ];
}

export function buildCompactedHistory(
  systemMessage: ChatMessage,
  summaryText: string,
  tail: ChatMessage[],
  olderTurnCount: number,
  nowISO?: string
): ChatMessage[] {
  const iso = nowISO ?? new Date().toISOString();
  const summaryUser: ChatMessage = {
    role: "user",
    content: `[Compacted context ${iso}: summary of ${olderTurnCount} older turns]\n${summaryText}`,
  };
  return [
    { ...systemMessage } as ChatMessage,
    summaryUser,
    ...tail.map((m) => ({ ...m }) as ChatMessage),
  ];
}

export function compactBoundaryLine(olderTurnCount: number): string {
  return `(context compacted: ${olderTurnCount} turns → summary)`;
}

// ---- Thrash guard ----
export function isThrashDisabled(streak: number): boolean {
  return streak >= COMPACT_THRASH_LIMIT;
}

// ---- Size-error detection + head truncation for the once-retry ----
export function isSizeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/HTTP\s+(400|413)\b/.test(msg)) return true;
  return /context|too long|maximum|too many|overflow|too large|token[^.]{0,40}limit|length|exceed/i.test(
    msg
  );
}

// Truncate head to budget ONCE: drop the oldest half of its user-turns,
// preserving assistant/tool pairing (turn boundaries).
export function truncateHeadForRetry(head: ChatMessage[]): ChatMessage[] {
  if (head.length <= 1) return [...head];
  const starts: number[] = [];
  for (let i = 0; i < head.length; i++) {
    if (head[i]?.role === "user") starts.push(i);
  }
  if (starts.length <= 1) {
    // No turn structure: keep the newest half of messages.
    return head.slice(Math.ceil(head.length / 2));
  }
  const keepTurns = Math.max(1, Math.ceil(starts.length / 2));
  const keepFrom = starts[starts.length - keepTurns]!;
  return head.slice(keepFrom);
}

export type CompactSummaryRequest = {
  provider: ProviderId;
  apiKey: string;
  model: string;
  systemContent: string;
  head: ChatMessage[];
  focusText?: string;
  baseURL?: string;
  endpointOverride?: string;
  signal?: AbortSignal | null;
  onUsage?: (usage: import("./zen.js").Usage) => void;
};

// Summary POST: SAME provider/model via the existing chat path but TOOLS
// DISABLED (no `tools` key in the POST body) and output capped at 4096
// (max_tokens/maxOutputTokens per kind — see zen.ts/adapters.ts). Returns
// the summary text. On size-overflow it truncates head to budget ONCE and
// retries once, then gives up with a `/clear` suggestion; other failures
// throw immediately with history untouched (caller must not swap).
export async function requestCompactSummary(
  req: CompactSummaryRequest
): Promise<string> {
  const attempt = async (head: ChatMessage[]): Promise<string> => {
    const messages = buildSummaryMessages(req.systemContent, head, req.focusText);
    const res = await chatCompletionForProvider(
      req.provider,
      req.apiKey,
      req.model,
      messages,
      {
        baseURL: req.baseURL,
        endpointOverride: req.endpointOverride,
        disableTools: true,
        maxOutputTokens: COMPACT_SUMMARY_MAX_TOKENS,
        ...(req.signal ? { signal: req.signal } : {}),
      }
    );
    // Totals keep accumulating: forward real summary usage when present.
    // The caller must NOT feed this into lastPromptTokens (load tracks the
    // main context, not the head-sized summary request).
    if (res.usage !== undefined) {
      try {
        req.onUsage?.(res.usage);
      } catch {
        // observer errors never break compaction
      }
    }
    const text = (res.content ?? "").trim();
    if (!text) throw new Error("Empty reply from model (unexpected payload).");
    return text;
  };
  try {
    return await attempt(req.head);
  } catch (e) {
    if (!isSizeError(e)) throw e;
    // Overflow/fails-from-size: truncate head to budget ONCE and retry once.
    if (req.head.length <= 1) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)} (compact failed — use /clear)`
      );
    }
    const truncated = truncateHeadForRetry(req.head);
    try {
      return await attempt(truncated);
    } catch (e2) {
      throw new Error(
        `${e2 instanceof Error ? e2.message : String(e2)} (compact failed — use /clear)`
      );
    }
  }
}

// Re-export for callers that need the post-turn history size.
export { historyChars };
