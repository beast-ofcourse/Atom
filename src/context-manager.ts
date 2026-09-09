// ContextManager — the single place that answers, for one model:
//   - How much context is available?      (budget())
//   - How much is currently used?         (usage())
//   - Should we compact?                  (needsCompaction())
//   - What messages should be sent?       (trimForSend())
//
// Budget derivation (no fixed-200K assumption): the history allowance comes
// from the model's ACTUAL verified context window:
//
//   available history = window − system prompt − tool definitions
//                       − expected output reserve − safety margin
//
// measured in tokens via the shared 4ch/token estimator. A model with a 1M
// window therefore gets ~1M of usable history instead of ~50K tokens.
//
// Hard safety ceiling (configurable, never primary): env ATOM_MAX_HISTORY_*
// and atom.json maxHistory* still resolve through historyCharSource /
// historyMessageSource. The ceiling only ever CAPS the derived budget — with
// nothing configured it never binds for known-window models. Models with NO
// verified window keep the legacy 200K-char / 100-message behavior exactly
// (a window is never invented; auto-compact stays off for them).
//
// Layering: this module owns measurement + budget math. It imports
// context-windows (metadata) and config (file fallback) at runtime, and
// zen.js types ONLY (no runtime cycle — zen.ts imports this module for its
// loop trim). The agent loop, compaction mechanics, and providers are
// untouched: truncateHistory/shouldAutoCompact/compactPct keep working via
// re-exports from their original modules.
//
// Prompt-caching foundation (NOT implemented): all inputs here are explicit
// values (system/tools/history split, measured sizes, stable options), so a
// future cache layer can key stable prefixes (system + tools) without
// re-architecting call sites. No cache state lives here yet by design.

import { contextWindowFor } from "./context-windows.js";
import { loadAtomConfig } from "./config.js";
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
// ride on every POST). History chars = the sum over all messages.
export function messageChars(m: ChatMessage): number {
  let n = 0;
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") {
    n += content.length;
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

// ---- Safety-ceiling sources (env > atom.json > compiled default) ----

export const MAX_HISTORY_MESSAGES = 100;
export const MAX_HISTORY_CHARS = 200_000;

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(n), min), max);
}

function envInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

export type BudgetSource = { value: number; explicit: boolean };

// Message-count ceiling source. `explicit` tells whether a human configured
// it (env or file) as opposed to the compiled default.
export function historyMessageSource(): BudgetSource {
  const env = envInt(process.env.ATOM_MAX_HISTORY_MESSAGES);
  if (env !== undefined) return { value: clampInt(env, 10, 1000), explicit: true };
  const file = loadAtomConfig().config.maxHistoryMessages;
  if (file !== undefined) return { value: file, explicit: true };
  return { value: MAX_HISTORY_MESSAGES, explicit: false };
}

// Char-count safety ceiling source. Same explicit contract.
export function historyCharSource(): BudgetSource {
  const env = envInt(process.env.ATOM_MAX_HISTORY_CHARS);
  if (env !== undefined) return { value: clampInt(env, 10_000, 2_000_000), explicit: true };
  const file = loadAtomConfig().config.maxHistoryChars;
  if (file !== undefined) return { value: file, explicit: true };
  return { value: MAX_HISTORY_CHARS, explicit: false };
}

// Legacy accessors (env → file → default). Kept for the loop's legacy path
// and existing callers; the manager uses the sources above so it can tell
// configured ceilings apart from defaults.
export function historyMessageBudget(): number {
  return historyMessageSource().value;
}

export function historyCharBudget(): number {
  return historyCharSource().value;
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

// ---- Trim core (turn-boundary history surgery, pairing-safe) ----

export type TruncateReserve = { messages?: number; chars?: number };
export type TruncateResult = { droppedTurns: number; droppedMessages: number };

export type HistoryCaps = { maxMessages: number; maxChars: number };

export type TrimOptions = {
  notify?: (message: string) => void;
  reserve?: TruncateReserve;
  // Open todo texts pinning their turns (the caller reads them live — the
  // manager never touches todo state).
  todoNeedles?: string[];
};

// Searchable text for todo matching: message content plus the assistant's
// tool_calls payload (todowrite CALLS carry the list, tool RESULTS echo it).
// Tool call ids are NOT searched — they are pairing keys, not goal text, so
// a todo that reads like an id can never false-pin a turn.
function todoHaystack(m: ChatMessage): string {
  let hay = "";
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") hay += content;
  if (m.role === "assistant" && m.tool_calls !== undefined) {
    try {
      hay += JSON.stringify(m.tool_calls);
    } catch {
      // unstringifiable payload pins nothing
    }
  }
  return hay;
}

function turnMentionsTodo(
  history: ChatMessage[],
  start: number,
  end: number,
  needles: string[]
): boolean {
  for (let i = start; i < end; i++) {
    const hay = todoHaystack(history[i]!);
    if (hay.length === 0) continue;
    for (const n of needles) {
      if (n.length > 0 && hay.includes(n)) return true;
    }
  }
  return false;
}

// Drop oldest user-turns until history fits BOTH caps (message count AND
// total chars, each plus the caller's `reserve` headroom for a message it is
// about to push). A user turn = the `user` message plus all following
// messages up to (excluding) the next `user` message, so assistant
// tool_calls always stay paired with their tool results across all three
// wire formats. NEVER drops history[0] (system prompt), the first user turn
// (the task prompt — the goal a long run must never forget), any turn that
// still quotes a CURRENT open todo, or the latest turn (the one being
// sent/built). Budget-aware edge: when the pinned content alone (first turn
// + todo turns + latest) already exceeds a cap, there is nothing left to
// drop — stop and still send (same never-drop-the-live-turn principle).
// Mutates `history` in place via splice (so caller indices captured after
// this call stay valid) and, when at least one turn dropped, fires ONE
// `notify` (the caller surfaces it dim in the TUI); silence otherwise.
// Returns what was dropped.
export function truncateHistoryWithCaps(
  history: ChatMessage[],
  caps: HistoryCaps,
  opts?: TrimOptions
): TruncateResult {
  const result: TruncateResult = { droppedTurns: 0, droppedMessages: 0 };
  if (history.length <= 1) return result;
  const maxMessages = caps.maxMessages;
  const maxChars = caps.maxChars;
  const reserve = opts?.reserve;
  const needles = opts?.todoNeedles ?? [];
  const roomMessages =
    reserve?.messages !== undefined && Number.isFinite(reserve.messages)
      ? Math.max(0, Math.floor(reserve.messages))
      : 0;
  const roomChars =
    reserve?.chars !== undefined && Number.isFinite(reserve.chars)
      ? Math.max(0, reserve.chars)
      : 0;
  for (;;) {
    const over =
      history.length + roomMessages > maxMessages ||
      historyChars(history) + roomChars > maxChars;
    if (!over) break;
    // Turn boundaries over history[1..]: each turn starts at a `user`
    // message (the oldest slice starts at 1 even when it isn't one, matching
    // the pre-pin drop unit). Whole-turn drops keep assistant/tool pairing.
    const starts: number[] = [1];
    for (let i = 2; i < history.length; i++) {
      if (history[i]?.role === "user") starts.push(i);
    }
    // Oldest NON-pinned, non-latest turn goes first: the first turn (task
    // prompt) and any turn still quoting a current open todo stay, and the
    // latest turn is never dropped. No candidate means pinned content alone
    // is over budget — stop and send it as-is (see edge above).
    let drop = -1;
    for (let t = 0; t < starts.length; t++) {
      if (t === starts.length - 1) continue; // latest turn
      if (t === 0) continue; // task prompt
      const end = t + 1 < starts.length ? starts[t + 1]! : history.length;
      if (needles.length > 0 && turnMentionsTodo(history, starts[t]!, end, needles)) continue;
      drop = t;
      break;
    }
    if (drop === -1) break;
    const end = drop + 1 < starts.length ? starts[drop + 1]! : history.length;
    const removed = history.splice(starts[drop]!, end - starts[drop]!);
    result.droppedTurns += 1;
    result.droppedMessages += removed.length;
  }
  if (result.droppedTurns > 0) {
    try {
      opts?.notify?.(`(history truncated: dropped ${result.droppedTurns} oldest turn(s))`);
    } catch {
      // observer errors never break the loop
    }
  }
  return result;
}

// ---- Budget derivation ----

// Expected completion/output reserve: one full summary-sized generation must
// always fit alongside history (mirrors the compaction output cap).
export const OUTPUT_RESERVE_TOKENS = 4096;

// Safety headroom below the raw window: the trim cap never plans to use the
// last 5% (auto-compact at ~83% fires long before this matters — the margin
// is the last defense, not the trigger).
export const SAFETY_MARGIN_PCT = 0.05;

// Default safety ceiling when nothing is configured AND no window is known
// (the legacy 200K-char budget, preserved byte-for-byte as fallback).
export const HARD_CEILING_FLOOR_CHARS = 200_000;

export type ContextBudget = {
  // Verified model window, or undefined when unknown (never invented).
  windowTokens: number | undefined;
  // Measured participants, all in tokens.
  systemTokens: number;
  toolsTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  // Window-derived history allowance (undefined when the window is unknown).
  historyTokens: number | undefined;
  historyChars: number | undefined;
  // Configured safety ceiling + whether a human set it.
  hardCeilingChars: number;
  hardCeilingExplicit: boolean;
  hardCeilingMessages: number;
  // The numbers trim enforces.
  effectiveMaxChars: number;
  effectiveMaxMessages: number;
};

export type ContextUsage = {
  historyChars: number;
  historyMessages: number;
  userTurns: number;
  // Last POST's reported prompt_tokens when available, else the estimate.
  loadTokens: number;
  // Load over the verified window, or undefined when unknown.
  loadPct: number | undefined;
};

export type ContextManagerOptions = {
  model: string;
  // Measured JSON size of the tool schemas actually sent on the wire.
  // Optional (defaults 0) for usage-only callers that never trim.
  toolsChars?: number;
  outputReserveTokens?: number;
  safetyMarginPct?: number;
  // Explicit ceiling overrides (resolved sources apply by default).
  hardCeilingChars?: number;
  hardCeilingExplicit?: boolean;
  hardCeilingMessages?: number;
  compactPct?: number;
};

export type ContextManager = {
  readonly model: string;
  /** Available context, derived from the window (or the ceiling fallback). */
  budget(history: ChatMessage[]): ContextBudget;
  /** Currently used context for this history + load source. */
  usage(history: ChatMessage[], lastPromptTokens?: number): ContextUsage;
  /** Compaction trigger: pct-of-verified-window (false when unknown). */
  needsCompaction(loadTokens: number): boolean;
  /** Trim history in place to the derived caps (pairing-safe, see core). */
  trimForSend(
    history: ChatMessage[],
    notify?: (message: string) => void,
    reserve?: TruncateReserve,
    todoNeedles?: string[]
  ): TruncateResult;
};

export function createContextManager(opts: ContextManagerOptions): ContextManager {
  const model = opts.model;
  const toolsChars = opts.toolsChars ?? 0;
  const reserveTokens = opts.outputReserveTokens ?? OUTPUT_RESERVE_TOKENS;
  const marginPct = opts.safetyMarginPct ?? SAFETY_MARGIN_PCT;
  const pct = opts.compactPct ?? compactPct();

  function ceilingChars(): { value: number; explicit: boolean } {
    if (opts.hardCeilingChars !== undefined) {
      return { value: opts.hardCeilingChars, explicit: opts.hardCeilingExplicit ?? true };
    }
    return historyCharSource();
  }

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
    const ceil = ceilingChars();
    const ceilMsgs =
      opts.hardCeilingMessages ?? historyMessageSource().value;
    // The ceiling only ever CAPS: with nothing configured the derived budget
    // rules (large windows stay usable); an explicit ceiling still binds as
    // the safety net it is. Unknown windows fall back to the legacy floor.
    const effectiveMaxChars =
      historyCharsCap !== undefined
        ? ceil.explicit
          ? Math.min(historyCharsCap, ceil.value)
          : historyCharsCap
        : ceil.explicit
          ? ceil.value
          : HARD_CEILING_FLOOR_CHARS;
    return {
      windowTokens: window,
      systemTokens,
      toolsTokens,
      outputReserveTokens: reserveTokens,
      safetyMarginTokens: margin,
      historyTokens,
      historyChars: historyCharsCap,
      hardCeilingChars: ceil.value,
      hardCeilingExplicit: ceil.explicit,
      hardCeilingMessages: ceilMsgs,
      effectiveMaxChars,
      effectiveMaxMessages: ceilMsgs,
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

  function trimForSend(
    history: ChatMessage[],
    notify?: (message: string) => void,
    reserve?: TruncateReserve,
    todoNeedles: string[] = []
  ): TruncateResult {
    const b = budget(history);
    return truncateHistoryWithCaps(
      history,
      { maxMessages: b.effectiveMaxMessages, maxChars: b.effectiveMaxChars },
      { notify, reserve, todoNeedles }
    );
  }

  return { model, budget, usage, needsCompaction, trimForSend };
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
