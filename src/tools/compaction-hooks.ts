// Before-compaction hooks (ticket 09): extension interception over automatic
// and manual compaction (cancel or custom summary).
//
// Dependency-free like intercept.ts and provider-hooks.ts (type-only imports)
// so the extension host, the compaction caller (App.tsx), and the tests can
// all share it with no cycle: extensions register here, doCompact applies
// here, nobody imports the other.
//
// Semantics (fail-open vs fail-closed):
// - Cancel (fail CLOSED on explicit veto, fail OPEN on throws): handlers run
//   in registration order BEFORE any snapshot/persist/mutate step with the
//   reason and the pending head/tail split. Only an explicit cancel vetoes —
//   true (default reason naming the extension), a non-empty string (that
//   reason), or { cancel: true | "reason" }. Everything else
//   (void/null/false/{cancel:false}/foreign shapes) allows. The first cancel
//   wins: later handlers never run. A throwing handler is recorded and fails
//   OPEN (degrades to the builtin summary with a visible error) — a buggy
//   extension must never hold compaction hostage or half-compact a session
//   (same rationale as the before_switch fail-open gate).
// - Custom summary (fail OPEN): a handler may return { summary: "text" } to
//   replace the builtin summarizer output. The text must be a non-empty
//   string after trimming — anything else is ignored. The first valid
//   summary wins: later handlers never run. The winning text enters the SAME
//   post-processing as builtin output (touched-files append/fit, boundary
//   marker, atomic swap, save, snapshot clearing) at the single injection
//   point in doCompact — never a parallel pipeline. A bare string return is
//   a cancel reason (the before_switch convention), never a summary, so the
//   two decisions can never be confused.
// - Read-only split: handlers observe deep copies (per-handler fresh clones
//   of a pristine snapshot), never the live split arrays — an in-place
//   mutation by a handler must not corrupt planning (the provider-hooks
//   deep-copy precedent). The apply entry point never mutates its inputs.
//
// Coverage: doCompact in App.tsx is the single compaction funnel (manual
// /compact via runCompactCommand, pending drains, and auto via
// maybeAutoCompact all route through it), so one gate covers every reason —
// auto, manual, and the overflow domain the type reserves for future callers.

import type { ChatMessage } from "../agent/types.js";

/** Why compaction was triggered. Current callers emit auto/manual; overflow reserves the size-recovery domain. */
export type BeforeCompactReason = "auto" | "manual" | "overflow";

export type BeforeCompactInfo = {
  /** Trigger: auto (threshold), manual (/compact), overflow (size recovery). */
  reason: BeforeCompactReason;
  /** Manual /compact focus text ("" when none or auto). */
  focusText: string;
  /** Messages about to be summarized (deep copy per handler — treat as read-only). */
  head: ChatMessage[];
  /** Newest turns retained verbatim (deep copy per handler — treat as read-only). */
  tail: ChatMessage[];
  /** User turns in head (drives the boundary marker downstream). */
  olderTurnCount: number;
};

export type BeforeCompactDecision =
  | void
  | undefined
  | null
  | boolean
  | string
  | { cancel?: boolean | string; summary?: unknown };

export type BeforeCompactHandler = (
  info: BeforeCompactInfo
) => BeforeCompactDecision | Promise<BeforeCompactDecision>;

export type BeforeCompactRecord = {
  /** Extension name that registered the handler (audit trail for cancel notices). */
  owner: string;
  handler: BeforeCompactHandler;
};

export type BeforeCompactOutcome = {
  /** True when a handler explicitly cancelled (later handlers never ran). */
  cancelled: boolean;
  /** Cancel reason when cancelled (default names the extension). */
  cancelReason: string | null;
  /** Owner of the cancelling handler (null when not cancelled). */
  cancelOwner: string | null;
  /** First valid custom summary (null when none supplied). */
  summary: string | null;
  /** Owner of the summary handler (null when builtin applies). */
  summaryOwner: string | null;
  /** Per-handler throw messages in order (fail-open: caller falls back to builtin with a visible error). */
  errors: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  try {
    return structuredClone(messages);
  } catch {
    try {
      return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
    } catch {
      return messages.map((m) => ({ ...m }) as ChatMessage);
    }
  }
}

// Cancel interpretation (single rule, mirrors the before_switch gate): only
// an explicit veto cancels — true (default reason), a string (that reason,
// empty falls back to the default), or { cancel: true | "reason" }.
// Everything else (void/null/false/{cancel:false}/foreign shapes) allows.
function cancelReasonOf(decision: BeforeCompactDecision, owner: string): string | null {
  if (decision === true) return `extension "${owner}" cancelled compaction`;
  if (typeof decision === "string") {
    return decision.length > 0 ? decision : `extension "${owner}" cancelled compaction`;
  }
  if (isRecord(decision)) {
    const cancel = (decision as { cancel?: unknown }).cancel;
    if (cancel === true) return `extension "${owner}" cancelled compaction`;
    if (typeof cancel === "string") {
      return cancel.length > 0 ? cancel : `extension "${owner}" cancelled compaction`;
    }
  }
  return null;
}

// Custom-summary interpretation (single rule): only { summary } with a
// non-empty-after-trim string supplies — void/null/false/bare strings (a
// bare string is a cancel reason above, never a summary)/foreign shapes pass
// through to the builtin summarizer.
function summaryOf(decision: BeforeCompactDecision): string | null {
  if (!isRecord(decision)) return null;
  const summary = (decision as { summary?: unknown }).summary;
  if (typeof summary !== "string" || summary.trim().length === 0) return null;
  return summary;
}

const beforeCompactHandlers: Array<BeforeCompactRecord> = [];

/** Register a before-compaction hook. Returns an unregister function. */
export function registerBeforeCompact(
  handler: BeforeCompactHandler,
  owner = "(unknown)"
): () => void {
  if (typeof handler !== "function") {
    throw new Error("before-compact handler must be a function");
  }
  const record: BeforeCompactRecord = { owner, handler };
  beforeCompactHandlers.push(record);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const idx = beforeCompactHandlers.indexOf(record);
    if (idx >= 0) beforeCompactHandlers.splice(idx, 1);
  };
}

/** Snapshot of live before-compaction handlers in registration order (deterministic composition). */
export function beforeCompactInterceptors(): Array<BeforeCompactRecord> {
  return [...beforeCompactHandlers];
}

/** Test seam: drop every compaction hook. */
export function clearCompactionHooks(): void {
  beforeCompactHandlers.length = 0;
}

// Apply before-compaction handlers sequentially in registration order. Never
// throws and never mutates its inputs: each handler receives fresh deep
// copies of a pristine snapshot, a throwing handler is recorded fail-open
// (its veto/summary dropped, the chain continues), and the first explicit
// cancel — or the first valid custom summary — wins with later handlers
// never running (the before_switch first-wins precedent).
export async function applyBeforeCompact(
  handlers: ReadonlyArray<BeforeCompactRecord>,
  info: BeforeCompactInfo
): Promise<BeforeCompactOutcome> {
  const out: BeforeCompactOutcome = {
    cancelled: false,
    cancelReason: null,
    cancelOwner: null,
    summary: null,
    summaryOwner: null,
    errors: [],
  };
  // Pristine snapshot first (never the caller's live arrays): per-handler
  // clones below mean a mutating hook corrupts neither planning nor the
  // next handler's view.
  const pristineHead = cloneMessages(info.head);
  const pristineTail = cloneMessages(info.tail);
  for (const record of handlers) {
    let decision: BeforeCompactDecision;
    try {
      decision = await record.handler({
        reason: info.reason,
        focusText: info.focusText,
        head: cloneMessages(pristineHead),
        tail: cloneMessages(pristineTail),
        olderTurnCount: info.olderTurnCount,
      });
    } catch (e) {
      out.errors.push(`${record.owner}: ${errorText(e)}`);
      continue;
    }
    const reason = cancelReasonOf(decision, record.owner);
    if (reason !== null) {
      out.cancelled = true;
      out.cancelReason = reason;
      out.cancelOwner = record.owner;
      return out;
    }
    const summary = summaryOf(decision);
    if (summary !== null) {
      out.summary = summary;
      out.summaryOwner = record.owner;
      return out;
    }
  }
  return out;
}
