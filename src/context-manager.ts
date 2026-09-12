// ContextManager — the single place that answers, for one model:
//   - How much context is available?      (budget())
//   - How much is currently used?         (usage())
//   - Should we compact?                  (needsCompaction())
//
// Budget derivation (no fixed-200K assumption): the history allowance comes
// from the model's ACTUAL verified context window:
//
//   available history = window − system prompt − tool definitions
//                       − expected output reserve − safety margin
//
// measured in tokens via the shared 4ch/token estimator. A model with a 1M
// window therefore gets ~1M of usable history instead of ~50K tokens.
// Models with NO verified window report no allowance (a window is never
// invented; auto-compact stays off for them).
//
// History itself is NEVER truncated: there are no message/char caps.
// Compaction (manual /compact, auto at ~83% of the verified window) is the
// only pressure valve — Pi-style.
//
// Layering: this module owns measurement + budget math. It imports
// context-windows (metadata) and config (file fallback for compactPct) at
// runtime, and zen.js types ONLY (no runtime cycle — zen.ts imports this
// module for context math). The agent loop, compaction mechanics, and
// providers are untouched.
//
// Prompt-caching foundation (NOT implemented): all inputs here are explicit
// values (system/tools/history split, measured sizes, stable options), so a
// future cache layer can key stable prefixes (system + tools) without
// re-architecting call sites. No cache state lives here yet by design.

import { contextWindowFor } from "./context-windows.js";
import { loadAtomConfig } from "./config.js";
import { mediaWireChars } from "./media.js";
import type { ChatMessage } from "./zen.js";

// ---- Units ----

// Shared chars-per-token estimator (opencode's 4ch/token preflight
// heuristic). Floors to whole tokens; never used for billed spend, only for
// sizing decisions and display.
export const CHARS_PER_TOKEN = 4;

export function estimateTokensForChars(chars: number): number {
  const c = Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0;
  return Math.floor(c / CHARS_PER_TOKEN);
}

// Deterministic size of one message: string content counts as-is, anything
// else counts stringified; assistant tool_calls and tool ids count too (they
// ride on every POST). Media descriptor tokens (`[media:<id> <mime> <bytes>B]`,
// see src/media.ts) additionally count their deterministic base64 wire cost
// (ceil(bytes*4/3)) — history text stays small while the load stays honest.
// History chars = the sum over all messages.
export function messageChars(m: ChatMessage): number {
  let n = 0;
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") {
    n += content.length + mediaWireChars(content);
  } else if (content !== null && content !== undefined) {
    n += JSON.stringify(content).length;
  }
  if (m.role === "assistant") {
    if (m.tool_calls !== undefined) n += JSON.stringify(m.tool_calls).length;
  } else if (m.role === "tool") {
    n += m.tool_call_id.length;
  }
  return n;
}

export function historyChars(history: ChatMessage[]): number {
  const state = ledgerFor(history);
  if (state) return state.chars;
  let total = 0;
  for (const m of history) total += messageChars(m);
  return total;
}

// Load = last POST's reported input-side tokens (prompt_tokens, normalized at
// parse time to include exclusive prefix-cache counters like Anthropic's
// cache_read/_creation) when available, else the 4ch/token estimate of the
// sent history chars.
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

// ---- Compaction threshold (moved here: the manager owns "should compact") ----

export const COMPACT_PCT_DEFAULT = 0.83;

function clampPctPercent(n: number): number {
  return Math.min(Math.max(n, 50), 95) / 100;
}

// Auto-compact threshold as a fraction (default 0.83). Precedence: env
// ATOM_COMPACT_PCT percent (e.g. "83", clamped 50–95) → atom.json compactPct
// → default; invalid/unset falls through.
export function compactPct(): number {
  const raw = process.env.ATOM_COMPACT_PCT;
  if (raw !== undefined) {
    const text = raw.trim();
    if (/^\d+(\.\d+)?$/.test(text)) {
      const n = Number(text);
      if (Number.isFinite(n)) return clampPctPercent(n);
    }
  }
  const file = loadAtomConfig().config.compactPct;
  if (file !== undefined) return file / 100;
  return COMPACT_PCT_DEFAULT;
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

// ---- Budget derivation ----

// Expected completion/output reserve: one full summary-sized generation must
// always fit alongside history (mirrors the compaction output cap).
export const OUTPUT_RESERVE_TOKENS = 4096;

// Safety headroom below the raw window: the budget never plans to use the
// last 5% (auto-compact at ~83% fires long before this matters — the margin
// is informational, not a trigger).
export const SAFETY_MARGIN_PCT = 0.05;

export type ContextBudget = {
  // Verified model window, or undefined when unknown (never invented).
  windowTokens: number | undefined;
  // Measured participants, all in tokens.
  systemTokens: number;
  toolsTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  // Window-derived history allowance (undefined when the window is unknown).
  // Informational only — nothing enforces it; compaction is the valve.
  historyTokens: number | undefined;
  historyChars: number | undefined;
};

export type ContextUsage = {
  historyChars: number;
  historyMessages: number;
  userTurns: number;
  // Last POST's reported input-side tokens when available, else the estimate.
  loadTokens: number;
  // Load over the verified window, or undefined when unknown.
  loadPct: number | undefined;
};

export type ContextManagerOptions = {
  model: string;
  // Measured JSON size of the tool schemas actually sent on the wire.
  // Optional (defaults 0) for usage-only callers.
  toolsChars?: number;
  outputReserveTokens?: number;
  safetyMarginPct?: number;
  compactPct?: number;
};

export type ContextManager = {
  readonly model: string;
  /** Available context, derived from the verified window (undefined when unknown). */
  budget(history: ChatMessage[]): ContextBudget;
  /** Currently used context for this history + load source. */
  usage(history: ChatMessage[], lastPromptTokens?: number): ContextUsage;
  /** Compaction trigger: pct-of-verified-window (false when unknown). */
  needsCompaction(loadTokens: number): boolean;
};

export function createContextManager(opts: ContextManagerOptions): ContextManager {
  const model = opts.model;
  const toolsChars = opts.toolsChars ?? 0;
  const reserveTokens = opts.outputReserveTokens ?? OUTPUT_RESERVE_TOKENS;
  const marginPct = opts.safetyMarginPct ?? SAFETY_MARGIN_PCT;
  const pct = opts.compactPct ?? compactPct();

  function budget(history: ChatMessage[]): ContextBudget {
    const window = contextWindowFor(model);
    const stats = ledgerStats(history);
    const systemTokens = estimateTokensForChars(stats.systemChars);
    const toolsTokens = estimateTokensForChars(Math.max(0, Math.floor(toolsChars)));
    const margin = window !== undefined ? Math.floor(window * marginPct) : 0;
    const historyTokens =
      window !== undefined
        ? Math.max(0, window - systemTokens - toolsTokens - reserveTokens - margin)
        : undefined;
    const historyCharsCap =
      historyTokens !== undefined ? historyTokens * CHARS_PER_TOKEN : undefined;
    return {
      windowTokens: window,
      systemTokens,
      toolsTokens,
      outputReserveTokens: reserveTokens,
      safetyMarginTokens: margin,
      historyTokens,
      historyChars: historyCharsCap,
    };
  }

  function usage(history: ChatMessage[], lastPromptTokens?: number): ContextUsage {
    const s = ledgerStats(history);
    const loadTokens = computeContextLoad(lastPromptTokens, s.chars);
    const window = contextWindowFor(model);
    return {
      historyChars: s.chars,
      historyMessages: s.messages,
      userTurns: s.userMessages,
      loadTokens,
      loadPct: window !== undefined ? Math.round((100 * loadTokens) / window) : undefined,
    };
  }

  function needsCompaction(loadTokens: number): boolean {
    return shouldAutoCompact(loadTokens, model, pct);
  }

  return { model, budget, usage, needsCompaction };
}

// ---- ContextLedger: incremental history accounting ----
//
// Problem: every agent step re-scanned the whole history (chars, counts,
// JSON re-serialization per message) — O(n) per POST, growing with the run.
// The ledger keeps exact running counters instead: O(1) reads, O(k) writes
// proportional to the messages an operation actually touches.
//
// Mechanism: trackHistory() wraps a history array in a Proxy whose ONLY
// traps are set/deleteProperty/defineProperty. Every mutation — push, pop,
// shift, splice, index assignment, length truncation — decomposes into those
// traps, so all accounting funnels through one place with no call-site
// changes and no method wrapping. Reads (iteration, map, JSON, toEqual)
// pass through untouched.
//
// Correctness contract (audited, enforced by tests):
// - Messages are treated as IMMUTABLE values: callers mutate history by
//   replacing message objects, never by editing their fields in place.
//   Per-message sizes live in a WeakMap keyed by object identity, so each
//   message pays its JSON cost exactly once per lifetime.
// - Array REPLACEMENTS (clear/new/compact/resume) must go through
//   trackHistory() on the new array; the old ledger is discarded with it.
// - sort/reverse are permutations: counters are order-independent, so they
//   are exact no-ops. fill/copyWithin fall back to a full resync (correct,
//   rare — nothing in the hot path uses them).
// - verifyLedger() independently rescans and diffs (tests run it after every
//   op sequence); the ledgers themselves live in module WeakMaps keyed by
//   array identity, so every manager instance shares one truth per array.

export type RoleBucket = "system" | "user" | "assistant" | "tool" | "other";

export type LedgerSnapshot = {
  messages: number;
  chars: number;
  tokens: number;
  systemChars: number;
  toolChars: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
};

type MessageFootprint = { chars: number; role: RoleBucket };

type LedgerState = {
  proxy: ChatMessage[];
  messages: number;
  chars: number;
  systemChars: number;
  toolChars: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
};

const ledgerByRaw = new WeakMap<ChatMessage[], LedgerState>();
const ledgerByProxy = new WeakMap<ChatMessage[], LedgerState>();
const footprints = new WeakMap<object, MessageFootprint>();

function bucketOf(role: unknown): RoleBucket {
  return role === "system" || role === "user" || role === "assistant" || role === "tool"
    ? role
    : "other";
}

function footprintOf(m: unknown): MessageFootprint {
  if (typeof m !== "object" || m === null) return { chars: 0, role: "other" };
  const cached = footprints.get(m);
  if (cached) return cached;
  const fp: MessageFootprint = {
    chars: messageChars(m as ChatMessage),
    role: bucketOf((m as { role?: unknown }).role),
  };
  footprints.set(m, fp);
  return fp;
}

function addFootprint(state: LedgerState, m: unknown): void {
  if (typeof m !== "object" || m === null) return;
  const fp = footprintOf(m);
  state.chars += fp.chars;
  if (fp.role === "system") state.systemChars += fp.chars;
  else if (fp.role === "user") state.userMessages += 1;
  else if (fp.role === "assistant") state.assistantMessages += 1;
  else if (fp.role === "tool") {
    state.toolMessages += 1;
    state.toolChars += fp.chars;
  }
}

function removeFootprint(state: LedgerState, m: unknown): void {
  if (typeof m !== "object" || m === null) return;
  const fp = footprintOf(m);
  state.chars -= fp.chars;
  if (fp.role === "system") state.systemChars -= fp.chars;
  else if (fp.role === "user") state.userMessages -= 1;
  else if (fp.role === "assistant") state.assistantMessages -= 1;
  else if (fp.role === "tool") {
    state.toolMessages -= 1;
    state.toolChars -= fp.chars;
  }
}

function isArrayIndex(prop: string | symbol): boolean {
  if (typeof prop !== "string") return false;
  if (!/^(0|[1-9]\d*)$/.test(prop)) return false;
  return Number(prop) < 4294967295;
}

function toArrayLength(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 4294967295);
}

function snapshotOf(state: LedgerState): LedgerSnapshot {
  return {
    messages: state.messages,
    chars: state.chars,
    tokens: estimateTokensForChars(state.chars),
    systemChars: state.systemChars,
    toolChars: state.toolChars,
    userMessages: state.userMessages,
    assistantMessages: state.assistantMessages,
    toolMessages: state.toolMessages,
  };
}

// Wrap a history array for incremental accounting (idempotent — wrapping an
// already-tracked array returns it as-is). ALWAYS use the return value: the
// caller must drop its raw reference so every later mutation flows through
// the proxy traps.
export function trackHistory(history: ChatMessage[]): ChatMessage[] {
  if (ledgerByProxy.has(history)) return history;
  const rebound = ledgerByRaw.get(history);
  if (rebound) return rebound.proxy;
  const state: LedgerState = {
    proxy: [],
    messages: 0,
    chars: 0,
    systemChars: 0,
    toolChars: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolMessages: 0,
  };
  for (const m of history) addFootprint(state, m);
  state.messages = history.length;
  const proxy = new Proxy(history, {
    set(target, prop, value) {
      if (prop === "length") {
        const newLen = toArrayLength(value);
        const oldLen = target.length;
        if (newLen < oldLen) {
          for (let i = newLen; i < oldLen; i++) removeFootprint(state, target[i]);
        }
        const ok = Reflect.set(target, prop, value);
        state.messages = target.length;
        return ok;
      }
      if (isArrayIndex(prop)) {
        const i = Number(prop);
        if (i < target.length) removeFootprint(state, target[i]);
        addFootprint(state, value);
      }
      const ok = Reflect.set(target, prop, value);
      state.messages = target.length;
      return ok;
    },
    deleteProperty(target, prop) {
      if (isArrayIndex(prop)) {
        const i = Number(prop);
        if (i < target.length) removeFootprint(state, target[i]);
      }
      return Reflect.deleteProperty(target, prop);
    },
    defineProperty(target, prop, descriptor) {
      if (prop === "length" || isArrayIndex(prop)) {
        const had =
          typeof prop === "string" && isArrayIndex(prop) && Number(prop) < target.length
            ? target[Number(prop)]
            : undefined;
        const ok = Reflect.defineProperty(target, prop, descriptor);
        if (had !== undefined) removeFootprint(state, had);
        if ("value" in descriptor) addFootprint(state, descriptor.value);
        state.messages = target.length;
        return ok;
      }
      return Reflect.defineProperty(target, prop, descriptor);
    },
  });
  state.proxy = proxy;
  ledgerByRaw.set(history, state);
  ledgerByProxy.set(proxy, state);
  return proxy;
}

function ledgerFor(history: ChatMessage[]): LedgerState | undefined {
  return ledgerByProxy.get(history) ?? ledgerByRaw.get(history);
}

// O(1) snapshot of a TRACKED array. Untracked arrays (tests, transient
// copies) fall back to an exact full scan — always correct, just O(n).
export function ledgerStats(history: ChatMessage[]): LedgerSnapshot {
  const state = ledgerFor(history);
  if (state) return snapshotOf(state);
  return scanHistory(history);
}

// Independent O(n) reference implementation (never touches the footprint
// cache, so cache bugs cannot hide from it). Holes (deleted indices) count
// as empty: the pre-ledger messageChars crashes on them, but tracked arrays
// can hold holes after `delete`, so the reference must stay total. Tests
// diff stats() against this after every op sequence.
export function scanHistory(history: ChatMessage[]): LedgerSnapshot {
  let chars = 0;
  let systemChars = 0;
  let toolChars = 0;
  let user = 0;
  let assistant = 0;
  let tool = 0;
  for (const m of history) {
    if (m === undefined) continue;
    const c = messageChars(m);
    chars += c;
    const role = (m as { role?: unknown })?.role;
    if (role === "user") user += 1;
    else if (role === "assistant") assistant += 1;
    else if (role === "tool") {
      tool += 1;
      toolChars += c;
    } else if (role === "system") systemChars += c;
  }
  return {
    messages: history.length,
    chars,
    tokens: estimateTokensForChars(chars),
    systemChars,
    toolChars,
    userMessages: user,
    assistantMessages: assistant,
    toolMessages: tool,
  };
}

// Full independent verification: true when the incremental counters exactly
// match a fresh scan. Tests assert this; prod hot paths never pay for it.
export function verifyLedger(history: ChatMessage[]): { ok: boolean; mismatches: string[] } {
  const live = ledgerStats(history);
  const ref = scanHistory(history);
  const mismatches: string[] = [];
  (Object.keys(ref) as Array<keyof LedgerSnapshot>).forEach((k) => {
    if (live[k] !== ref[k]) mismatches.push(`${k}: ledger=${live[k]} scan=${ref[k]}`);
  });
  return { ok: mismatches.length === 0, mismatches };
}
