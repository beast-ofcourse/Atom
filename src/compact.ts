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
//   output tokens, structured template; newest tail retained (~20000 tokens,
//   tool outputs capped 2000 chars); overflow-recovery retry once.
//
// This module is pure + testable (mocked fetch only in tests, never live).
// The App owns session refs (load/streak/disabled/pending) and the atomic
// swap + save; this module owns math, splitting, instruction, and the
// summary POST (tools disabled, 4096 cap).

import {
  chatCompletionForProvider,
  type ChatMessage,
} from "./zen.js";
import type { ProviderId } from "./providers.js";
// Context math (estimator, load, threshold, measurement) lives in the
// ContextManager module; compact.ts imports what its splitter needs and
// re-exports the stable surface so existing importers keep working untouched.
import { estimateTokensForChars, messageChars } from "./context-manager.js";
import { truncateHead } from "./tools/shared.js";
export {
  COMPACT_PCT_DEFAULT,
  compactPct,
  computeContextLoad,
  estimateTokensForChars,
  historyChars,
  shouldAutoCompact,
} from "./context-manager.js";

// ---- Constants ----
export const COMPACT_KEEP_TOKENS = 20000;
export const COMPACT_SUMMARY_MAX_TOKENS = 4096;
export const COMPACT_TOOL_OUTPUT_CAP = 2000;
// opencode's 4ch/token heuristic (V2 preflight estimate): chars/4 floors to
// estimated tokens. Used for load fallback + tail split only, never for the
// `token: n/a` honesty rule or the NK cumulative spend.
export const COMPACT_CHARS_PER_TOKEN = 4;
export const COMPACT_THRASH_LIMIT = 3;

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
      // Line-aware cap (issue 04): the retained head never ends mid-line;
      // cap value and legacy note prefix are unchanged.
      const t = truncateHead(
        m.content,
        COMPACT_TOOL_OUTPUT_CAP,
        "\n[truncated: tool output exceeded 2000 chars]"
      );
      return {
        ...m,
        content: t.head + t.note,
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
  // fits in 20000 tokens).
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
    `## Important Details\n` +
    `## Work State\n` +
    `### Completed\n` +
    `### Active\n` +
    `### Blocked\n` +
    `## Next Move\n` +
    `## Relevant Files\n` +
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

// ---- Touched files (issue 05) ----
// The loop already records every read/write/edit as committed assistant
// tool_calls in history; compaction persists that knowledge (never re-derives
// it via new tracking) by collecting the paths out of the head being
// summarized and appending them to the summary text. Resume later surfaces
// the stored block verbatim, so a continued session knows what was touched
// without re-exploring the tree.
export type TouchedFiles = {
  read: string[];
  modified: string[];
};

function pushUniquePath(list: string[], p: string): void {
  if (p.length === 0 || list.includes(p)) return;
  list.push(p);
}

// Collect read/modified paths from committed tool_calls in head (insertion
// order, unique). Unparseable arguments are skipped — a bad payload must
// never break compaction. A path both read and written lands in modified
// only (the write implies the read).
export function collectTouchedFiles(head: ChatMessage[]): TouchedFiles {
  const read: string[] = [];
  const modified: string[] = [];
  for (const m of head) {
    if (m?.role !== "assistant") continue;
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      const fn = (c as { function?: unknown })?.function as
        | { name?: unknown; arguments?: unknown }
        | undefined;
      if (typeof fn?.name !== "string") continue;
      let p = "";
      try {
        const args =
          typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : null;
        const raw = (args as { path?: unknown } | null)?.path;
        if (typeof raw === "string") p = raw.trim();
      } catch {
        continue; // unparseable args pin nothing
      }
      if (p.length === 0) continue;
      if (fn.name === "write" || fn.name === "edit") pushUniquePath(modified, p);
      else if (fn.name === "read") pushUniquePath(read, p);
    }
  }
  // Modified implies read: keep modified entries out of the read list.
  const modifiedSet = new Set(modified);
  return { read: read.filter((p) => !modifiedSet.has(p)), modified };
}

// Canonical on-disk + on-resume format. Empty sections are omitted; both
// empty renders "" (the caller then appends nothing).
export function formatTouchedFiles(t: TouchedFiles): string {
  const lines = ["Touched files:"];
  if (t.read.length > 0) lines.push(`Read: ${t.read.join(", ")}`);
  if (t.modified.length > 0) lines.push(`Modified: ${t.modified.join(", ")}`);
  return lines.length > 1 ? lines.join("\n") : "";
}

export function appendTouchedFiles(summaryText: string, touched: TouchedFiles): string {
  const block = formatTouchedFiles(touched);
  if (!block) return summaryText;
  return `${summaryText}\n\n${block}`;
}

// ---- Size budget for the summary message ----
// The summary text itself is never cut — only the file lists shrink to fit,
// so an over-budget summary degrades gracefully instead of failing
// compaction. Budget = the summary output cap via the 4ch/token estimator.
export const COMPACT_SUMMARY_MAX_CHARS =
  COMPACT_SUMMARY_MAX_TOKENS * COMPACT_CHARS_PER_TOKEN;

// Shrink the lists until the formatted block fits maxChars. Drops the oldest
// entry from the longer list (ties: read first — modifications are the
// higher-signal list). Never throws; an empty result formats to "".
export function truncateTouchedFiles(touched: TouchedFiles, maxChars: number): TouchedFiles {
  const read = [...touched.read];
  const modified = [...touched.modified];
  while (
    (read.length > 0 || modified.length > 0) &&
    formatTouchedFiles({ read, modified }).length > maxChars
  ) {
    if (read.length >= modified.length) read.shift();
    else modified.shift();
  }
  return { read, modified };
}

export type FittedSummary = { text: string; truncated: boolean };

// Append file lists to the summary within budget: shrink the lists (never
// the model text) until summary + block fits; when nothing fits, the summary
// stands alone and compaction still succeeds.
export function fitSummaryWithFiles(
  summaryText: string,
  touched: TouchedFiles,
  maxChars: number = COMPACT_SUMMARY_MAX_CHARS
): FittedSummary {
  const before = touched.read.length + touched.modified.length;
  const block = formatTouchedFiles(touched);
  if (!block) return { text: summaryText, truncated: false };
  if (summaryText.length + 2 + block.length <= maxChars) {
    return { text: `${summaryText}\n\n${block}`, truncated: false };
  }
  const room = Math.max(0, maxChars - summaryText.length - 2);
  const shrunk = truncateTouchedFiles(touched, room);
  const shrunkBlock = formatTouchedFiles(shrunk);
  const truncated =
    shrunk.read.length + shrunk.modified.length < before;
  if (!shrunkBlock) return { text: summaryText, truncated };
  return { text: `${summaryText}\n\n${shrunkBlock}`, truncated };
}

// ---- Resume surfacing ----
// Pull the stored block(s) verbatim out of compacted summary messages — the
// same format as stored, no reformatting. lastIndexOf prefers the appended
// block (ours is always last; model prose comes first).
export function extractTouchedFilesSection(text: string): string | null {
  const idx = text.lastIndexOf("Touched files:");
  if (idx < 0) return null;
  const section = text.slice(idx).trimEnd();
  return section.length > 0 ? section : null;
}

export function collectStoredTouchedFiles(history: ChatMessage[]): string[] {
  const out: string[] = [];
  for (const m of history) {
    if (m?.role !== "user" || typeof m.content !== "string") continue;
    if (!m.content.includes("[Compacted context")) continue;
    const section = extractTouchedFilesSection(m.content);
    if (section) out.push(section);
  }
  return out;
}
