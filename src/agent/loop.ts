// Shared agentic-loop core: the SINGLE loop implementation backing both
// runAgenticLoop and runAgenticLoopForProvider (same tool/rollback contract).
// Moved verbatim from src/zen.ts; zen.ts re-exports runLoopWithChat so
// existing importers keep working untouched.
//
// Sequencing: each assistant message's tool_calls block is partitioned by
// planBatches — a batch of parallel-safe calls runs concurrently and its
// results commit in call order (re-paired by index, one transcript entry per
// call); everything else executes strictly serially in program order. A
// failure in one call NEVER skips the remaining commits of its block when
// the results are values; malformed calls yield their error result inline.
// A length-truncated response (`truncated: true`: the output limit cut tool
// arguments off) executes nothing — each carried call commits a
// repair-oriented error result and the turn continues to the next model
// round, bounded by the step/total-call budgets. A thrown execution error
// (or cancel) aborts the turn exactly as the old serial loop did — the
// caller rolls the partial turn back, so assistant/tool pairing stays valid.
//
// Dependency direction: agent/loop -> {tools, tools/read-cache,
// scheduler, config, context-manager, agent/gates, agent/loop-guard,
// agent/normalize, agent/types} and NOT zen (transports stay in
// zen.ts; runAgenticLoopForProvider wraps this loop from there).
import { loadAtomConfig } from "../config.js";
import { historyChars } from "../context-manager.js";
import { planBatches } from "../scheduler.js";
import type {
  LoopTelemetrySink,
  SinkModelCallInfo,
  SinkToolCallInfo,
} from "../telemetry.js";
import {
  describeToolCall,
  executeTool,
  invalidCall,
  needsApproval,
  toolNames,
  validateAskQuestionArgs,
  validateToolArgs,
} from "../tools.js";
import {
  afterToolInterceptors,
  applyAfterInterceptors,
  applyBeforeInterceptors,
  beforeToolInterceptors,
  blockedToolResult,
  type BeforeOutcome,
} from "../tools/intercept.js";
import { getReadCacheStats } from "../tools/read-cache.js";
import {
  emptyGoalProgress,
  GOAL_STALL_REPEATS,
  goalFollowUp,
  goalPausedNotice,
  goalReportAck,
  goalReportOutsideError,
  goalReportRejectedNotice,
  goalStallNudge,
  goalStallReached,
  goalVerdictNotice,
  noteGoalProgress,
  recentTurnsForJudge,
  resetGoalStall,
  sameGoalDisposition,
  updateGoalDisposition,
  validateUpdateGoalArgs,
  type GoalDisposition,
} from "../goal.js";
import {
  bashExitCode,
  evaluateTurnEnd,
  isCodePath,
  isVerificationCommand,
  todoCompletionGate,
  verificationGate,
} from "./gates.js";
import {
  errorStreakFollowUp,
  ErrorStreakTracker,
  repetitionFollowUp,
  RepetitionGuard,
  repetitionStopNotice,
} from "./loop-guard.js";
import { normalizeChatResult, normalizeToolResult, toolSignature } from "./normalize.js";
import type { AgenticOpts, ApprovalDecision, ChatMessage, ChatResult, LoopStats, ToolCall, ToolResultHook } from "./types.js";

// Whole-turn cancellation: thrown when the user cancels (Ctrl+C) mid-loop.
// The App catches it, rolls the partial turn back (same splice contract as
// POST failure), renders one dim `(cancelled)` line, and returns to a clean
// input state. Never retried, never a tool result.
export class LoopCancelledError extends Error {
  constructor() {
    super("(cancelled)");
    this.name = "LoopCancelledError";
  }
}

export function isCancelError(e: unknown): boolean {
  if (e instanceof LoopCancelledError) return true;
  if (e instanceof Error && e.name === "LoopCancelledError") return true;
  // fetch abort surfaces as DOMException AbortError (or Error with that name
  // in mocks). Treat any AbortError as a cancellation, never a retry.
  if (e instanceof Error && e.name === "AbortError") return true;
  if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") {
    return true;
  }
  return false;
}

export function throwIfCancelled(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new LoopCancelledError();
}
// Tool-round budget for one agentic turn (env → atom.json → unlimited).
// No default cap: the turn runs until the model ends it, a gate stops it,
// or the user cancels. An explicit `opts.maxSteps` (or env/file value) still
// caps the turn (tests inject it).
export function toolStepBudget(): number {
  const raw = process.env.ATOM_MAX_TOOL_STEPS;
  if (raw !== undefined) {
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      const n = Number(text);
      if (Number.isFinite(n)) return Math.min(Math.max(Math.floor(n), 5), 100);
    }
  }
  return loadAtomConfig().config.maxToolSteps ?? Number.POSITIVE_INFINITY;
}
// Empty-response recovery (live-proven on free-tier gateways: a 200-OK
// stream can carry only queue comments and reasoning with zero answer text
// and zero tool calls, which the transport reports as an `Empty reply`
// error). A failed POST normally aborts the turn — EXCEPT this one: ending
// the turn on model silence with no fallback makes flaky backends fatal, so
// the loop spends a bounded number of extra POSTs asking the model to repair
// (same assistant+user follow-up shape as the turn-end gates, so pairing
// stays valid). When the budget is spent the original error throws, exactly
// as before — the caller rolls back and the user sees it.
export const MAX_EMPTY_ROUNDS = 2;

export function isEmptyReplyError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("Empty reply");
}

export function emptyResponseFollowUp(attempt: number): string {
  return (
    `(empty response: attempt ${attempt} returned no text and no tool calls — ` +
    `the turn cannot end on silence. Continue with tool calls toward the goal, ` +
    `or answer in text. If there is genuinely nothing to do, end by saying so explicitly.)`
  );
}

// Per-tool outer timeout (ms): undefined → default 60s (enabled); explicit
// <=0/NaN → disabled (direct await, zero overhead). Clamped 1s–120s when
// enabled so a stuck executor can never hang the turn past the bash ceiling.
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export function resolveToolTimeoutMs(raw: number | undefined): number | null {
  if (raw === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TOOL_TIMEOUT_MS;
  if (raw <= 0) return null;
  return Math.min(Math.max(Math.floor(raw), 1000), 120_000);
}

// Total tool-call budget per turn (no default cap; explicit opts value only,
// min 1). Previously defaulted to 200 as a parallel-batch explosion guard.
// Deprecated alias kept for import compatibility; the loop no longer uses it.
export const DEFAULT_MAX_TOTAL_TOOL_CALLS = Number.POSITIVE_INFINITY;
export function resolveMaxTotalToolCalls(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(raw));
}

// Race one execution against the outer timeout. Timeout resolves to an
// `Error:` result (the model adapts); the underlying promise is left to
// settle — executors own their own cleanup.
//
// Cancellation is DELIBERATELY not raced here: the pinned contract is that
// an in-flight tool runs to completion and its result IS recorded, with the
// cancel stopping the turn before the next batch/POST (see the
// throwIfCancelled checks between batches and before each POST). Racing
// abort against the execution would drop the in-flight result and break
// assistant/tool pairing guarantees the tests pin. A hung tool + cancel
// therefore waits for the timeout (≤60s), commits the timeout error, then
// the next boundary check throws LoopCancelledError.
export async function executeWithTimeout(
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  name: string,
  parsed: Record<string, unknown>,
  timeoutMs: number | null,
  signal?: AbortSignal | null
): Promise<string> {
  // No new executions after a cancel: refuse to start when already aborted.
  if (signal?.aborted) throw new LoopCancelledError();
  if (timeoutMs === null) {
    return execute(name, parsed);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const execP = execute(name, parsed);
    const timeoutP = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`timeout after ${timeoutMs}ms`);
        (err as Error & { code?: string }).code = "ToolTimeout";
        reject(err);
      }, timeoutMs);
    });
    try {
      return await Promise.race([execP, timeoutP]);
    } catch (e) {
      if (isCancelError(e)) throw e;
      if ((e as Error & { code?: string })?.code === "ToolTimeout" || (e as Error)?.message?.startsWith("timeout after ")) {
        return `Error: ${name} timed out after ${timeoutMs}ms — retry with a narrower scope or smaller input.`;
      }
      throw e;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// Permission-gate resolution shared by the serial path and the parallel
// pre-pass: returns the hook's decision, or null when no approval applies
// (no hook, or a tool that never needs it). A "no" (or a throwing hook)
// denies without executing; cancellation always propagates.
async function resolveApproval(
  name: string,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined
): Promise<ApprovalDecision | null> {
  if (!opts?.approve || !needsApproval(name)) return null;
  try {
    const decision = await opts.approve(name, parsed);
    // Abort that lands as a resolved denial still cancels the whole turn.
    throwIfCancelled(opts?.signal);
    return decision;
  } catch (e) {
    // Whole-turn cancellation must propagate (Ctrl+C cancels the turn,
    // not just deny one call). Anything else is a denial.
    if (isCancelError(e) || opts?.signal?.aborted) throw new LoopCancelledError();
    return "no";
  }
}
// Extension tool-call interception (ticket 03): global pre/post hooks
// registered via ExtensionAPI.onBeforeToolCall/onAfterToolCall. Both
// helpers snapshot the live handler list and never throw — a throwing
// before handler fails closed (blocked outcome), a throwing after handler
// fails open (original content). Cancellation checks stay where they are;
// hooks are in-process policy, not executions, so they run even when the
// signal is armed and the existing boundaries still stop the turn.
async function runBeforeIntercept(
  name: string,
  parsed: Record<string, unknown>
): Promise<BeforeOutcome> {
  try {
    return await applyBeforeInterceptors(beforeToolInterceptors(), name, parsed);
  } catch {
    return { args: parsed, blocked: blockedToolResult(name, "(unknown)", "interception failed") };
  }
}

async function runAfterIntercept(
  name: string,
  parsed: Record<string, unknown>,
  result: string,
  isError: boolean
): Promise<{ content: string; isError: boolean }> {
  try {
    return await applyAfterInterceptors(afterToolInterceptors(), { name, args: parsed, result, isError });
  } catch {
    return { content: result, isError };
  }
}
// Execute one parsed tool call through interception + validation +
// permission + ask_question gates. Model mistakes (unknown name, invalid
// args) return repairs-oriented results WITHOUT executing; cancellations
// propagate as LoopCancelledError (never a result, never retried).
// Everything else returns the result string plus the effective (post-
// rewrite) args the commit funnel must use for gates, labels, and pairing:
// - Hook-vs-approval ordering: pre-hooks run BEFORE validation and
//   approval. The hook sees the call pre-approval and may rewrite args
//   before the approval prompt shows them; a block short-circuits approval
//   entirely (no prompt for a call that never runs). Rewrites always
//   re-validate before execution, so a hook can never smuggle unvalidated
//   args into an executor.
// - Unknown names never reach hooks (model mistake — nothing would run).
//   update_goal is the one exemption (ticket 03): a loop-intercepted tool
//   like ask_question, resolved without an executor via onUpdateGoal.
// - ask_question never needs approval; without an askUser hook it resolves
//   to "Error: ask_question has no UI hook".
// - update_goal never needs approval either; without the per-turn recorder
//   (only runLoopWithChat supplies it) it resolves to the outside-turn error.
// - write/edit/bash consult the approve hook when one is provided (or a
//   pre-resolved batch decision); a "no" resolves to
//   "Error: denied by user: <tool>" (final, no retry/rollback). Without a
//   hook every tool executes immediately.
async function runOneTool(
  call: ToolCall,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  preDecision?: ApprovalDecision | null,
  onUpdateGoal?: (parsed: Record<string, unknown>) => string
): Promise<{ result: string; args: Record<string, unknown> }> {
  const name = call?.function?.name ?? "(unknown)";
  // update_goal bypasses the unknown-name gate (ticket 03): a
  // loop-intercepted tool like ask_question — the registry owns builtins
  // only, so the loop exempts it by name here; runOneToolWithArgs below
  // validates it and resolves it without an executor (never needs approval).
  if (name !== "update_goal" && !toolNames().includes(name)) {
    return { result: `Error: unknown tool "${name}". Available: ${toolNames().join(", ")}`, args: parsed };
  }
  const pre = await runBeforeIntercept(name, parsed);
  if (pre.blocked !== null) {
    return { result: pre.blocked, args: pre.args };
  }
  return runOneToolWithArgs(call, pre.args, opts, execute, preDecision, onUpdateGoal);
}

// Inner execution after pre-interception: validate (rewritten) args, then
// permission + ask_question/update_goal gates, then the executor. Shared by
// the serial path (via runOneTool) and the parallel batch (via the pre-pass
// below, which resolves pre-hooks serially so prompts never run concurrently).
async function runOneToolWithArgs(
  call: ToolCall,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  preDecision?: ApprovalDecision | null,
  onUpdateGoal?: (parsed: Record<string, unknown>) => string
): Promise<{ result: string; args: Record<string, unknown> }> {
  const name = call?.function?.name ?? "(unknown)";
  // Argument validation BEFORE approval/execution: model mistake, never runs.
  // Pre-hook rewrites arrive here already applied, so they re-validate on
  // exactly what would execute — invalid rewrites never reach an executor.
  const detail = validateToolArgs(name, parsed);
  if (detail) {
    return { result: invalidCall(detail), args: parsed };
  }
  if (name === "ask_question") {
    throwIfCancelled(opts?.signal);
    // If the signal aborts during the modal, runAskQuestion rejects with
    // LoopCancelledError (no result). If it resolves just as the signal
    // aborts, return the result — the loop records it, then stops before
    // the next POST (no new POSTs, pairing stays valid until rollback).
    return { result: await runAskQuestion(parsed, opts?.askUser, opts?.signal), args: parsed };
  }
  if (name === "update_goal") {
    throwIfCancelled(opts?.signal);
    // Goal-disposition report (ticket 03): ask_question-shaped — validated,
    // never needs approval, resolved without an executor (the per-turn slot
    // recorder owns the record; execute never sees this name, so plan-mode
    // and approval policy are untouched). Without the recorder (never from
    // runLoopWithChat — both call sites thread it) the call is outside any
    // goal turn by construction.
    if (!onUpdateGoal) return { result: goalReportOutsideError(), args: parsed };
    return { result: onUpdateGoal(parsed), args: parsed };
  }
  const decision = preDecision ?? (await resolveApproval(name, parsed, opts));
  if (decision === "no") {
    return { result: `Error: denied by user: ${name}`, args: parsed };
  }
  // "once"/"always" run this call (the caller caches the always-allowed set
  // session-wide so later calls skip the prompt).
  // No new executions after a cancel: stop after the current tool finishes.
  // The current tool (if already running) is awaited to completion and its
  // result IS recorded — the loop then stops before the next tool/POST, so
  // assistant/tool pairing stays valid until the caller rolls back.
  throwIfCancelled(opts?.signal);
  const timeoutMs = resolveToolTimeoutMs(opts?.toolTimeoutMs);
  const doNormalize = opts?.normalizeResults !== false;
  try {
    const raw = await executeWithTimeout(execute, name, parsed, timeoutMs, opts?.signal);
    if (doNormalize) return { result: normalizeToolResult(raw), args: parsed };
    return { result: typeof raw === "string" ? raw : normalizeToolResult(raw), args: parsed };
  } catch (e) {
    if (isCancelError(e) || opts?.signal?.aborted) throw new LoopCancelledError();
    throw e;
  }
}

// After-tool-call result hook (issue 06): the single rewrite seam between
// execution and commit. Absent hook (or null/undefined/void/non-object
// return) → the original result, byte-identical. A string return replaces
// content (error flag kept); an object may replace content, override
// isError, or veto the commit. Hook failures degrade to the original — the
// turn never breaks. Telemetry keeps the pre-hook execution result; only the
// committed history/transcript/activity sees the rewrite.
async function applyToolResultHook(
  hook: ToolResultHook | undefined,
  name: string,
  parsed: Record<string, unknown>,
  result: string,
  isError: boolean
): Promise<{ content: string; isError: boolean; veto: boolean }> {
  if (!hook) return { content: result, isError, veto: false };
  try {
    const decision = await hook({ name, args: parsed, result, isError });
    if (decision === null || decision === undefined) return { content: result, isError, veto: false };
    if (typeof decision === "string") return { content: decision, isError, veto: false };
    if (typeof decision === "object") {
      if (decision.veto === true) return { content: result, isError, veto: true };
      const content = typeof decision.content === "string" ? decision.content : result;
      const nextIsError = typeof decision.isError === "boolean" ? decision.isError : isError;
      return { content, isError: nextIsError, veto: false };
    }
    return { content: result, isError, veto: false };
  } catch {
    return { content: result, isError, veto: false };
  }
}

async function runAskQuestion(
  parsed: Record<string, unknown>,
  askUser: AgenticOpts["askUser"],
  signal?: AbortSignal | null
): Promise<string> {
  const invalid = validateAskQuestionArgs(parsed);
  if (invalid) return invalid;
  if (!askUser) return "Error: ask_question has no UI hook";
  const q = parsed as unknown as { question: string; options: string[]; allowCustom?: unknown };
  const allowCustom = q.allowCustom === true;
  try {
    const answer = await askUser(q.question, q.options, allowCustom);
    if (typeof answer === "string" && answer.startsWith("Error:")) return answer;
    return JSON.stringify({ answer });
  } catch (e) {
    // Whole-turn cancellation (Ctrl+C) propagates — it is NOT the Esc
    // question-cancel result below.
    if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
    const msg = e instanceof Error ? e.message : String(e);
    if (/cancel/i.test(msg)) return "Error: question cancelled by user";
    return `Error: ${msg}`;
  }
}
// Shared agentic-loop core: the SINGLE loop implementation backing both
// runAgenticLoop and runAgenticLoopForProvider (same tool/rollback contract).
// Sequencing: each assistant message's tool_calls block is partitioned by
// planBatches — a batch of parallel-safe calls runs concurrently and its
// results commit in call order (re-paired by index, one transcript entry per
// call); everything else executes strictly serially in program order. A
// failure in one call NEVER skips the remaining commits of its block when
// the results are values (each result pairs with its tool_call_id in
// order); malformed calls (bad JSON, unknown name, failed validation) yield
// their error result inline and the block continues. Validation/unknown/
// denial/cancel are never retried — only transient transport failures retry
// (inside chatCompletion). A thrown execution error (or cancel) aborts the
// turn exactly as the old serial loop did — the caller rolls the partial
// turn back, so assistant/tool pairing stays valid.
export async function runLoopWithChat(
  chatFn: (history: ChatMessage[], opts?: AgenticOpts) => Promise<ChatResult>,
  history: ChatMessage[],
  opts?: AgenticOpts
): Promise<string> {
  const execute = opts?.execute ?? executeTool;
  const maxSteps = opts?.maxSteps ?? toolStepBudget();
  const signal = opts?.signal ?? null;
  // Local observability sink (see src/telemetry.ts): optional, observer-only.
  // Every hook call below is guarded, so telemetry can never break the turn;
  // absent → a few Date.now() reads per call, negligible and identical.
  const telemetry = opts?.telemetry;
  const telemetryIso = (ms: number): string => {
    try {
      return new Date(ms).toISOString();
    } catch {
      return new Date().toISOString();
    }
  };
  const telemetryArgsJson = (value: unknown): string => {
    try {
      const s = JSON.stringify(value ?? {});
      return typeof s === "string" ? s : "{}";
    } catch {
      return "{}";
    }
  };
  const reportModelCall = (info: SinkModelCallInfo): void => {
    try {
      telemetry?.onModelCall?.(info);
    } catch {
      // observer errors never break the loop
    }
  };
  const reportToolCall = (info: SinkToolCallInfo): void => {
    try {
      telemetry?.onToolCall?.(info);
    } catch {
      // observer errors never break the loop
    }
  };
  // Explicit verification state (no transcript parsing — the gate reads
  // these, never model prose):
  // - filesWritten: any write/edit executed (legacy compat signal).
  // - needsVerification: a CODE-path write/edit is still awaiting a passing
  //   check (docs/configs never arm it — no false positives).
  // - unverifiedPaths: which code paths (insertion order, unique) for messages.
  // - verifiedAfterWrite: an exit-0 verification command ran (clears the rest).
  // Only evidence AFTER the last write counts, so each new write resets.
  let filesWritten = false;
  let verifiedAfterWrite = false;
  let needsVerification = false;
  let unverifiedPaths: string[] = [];
  // Verification-gate nag cycles spent (bounds the continue loop via
  // MAX_VERIFY_ROUNDS — a model that never verifies still terminates).
  let verifyRounds = 0;
  // Todo-guard cycles spent (bounds guard continues via MAX_TODO_ROUNDS —
  // a model that never resolves open todos still terminates).
  let todoRounds = 0;
  // Goal engagement (ticket 02): set the first time a completed POST
  // observes a live goal. A goal cleared mid-run still counts its final
  // turn (the work happened); a run that never saw a goal counts nothing.
  let goalEngaged = false;
  // Disposition slot (ticket 03): the model-reported outcome for the CURRENT
  // goal turn, recorded by update_goal calls and consumed at the next turn
  // end BEFORE the auto-continue decision. Reset per run and on every
  // consumption — a report never leaks into the following turn.
  let pendingDisposition: GoalDisposition | null = null;
  // Read the live goal without ever throwing (a failing accessor ends the
  // turn normally — the goal simply does not continue).
  const readLiveGoal = (): { objective: string; active: boolean } | null => {
    try {
      return opts?.goal?.getGoal?.() ?? null;
    } catch {
      return null;
    }
  };
  // Pause-with-preservation via the App-owned callback (state flip plus a
  // visible notice; the goal text and stats survive). Never throws.
  const pauseLiveGoal = (objective: string, reason: string): void => {
    try {
      opts?.goal?.pauseGoal(goalPausedNotice(objective, reason));
    } catch {
      // observer errors never break the loop
    }
  };
  // Verdict pause (ticket 03): terminal dispositions pause with their own
  // verdict wording — no goalPausedNotice wrap, the verdict IS the notice
  // (it already names the objective and carries the reason). Never throws.
  const pauseLiveGoalWithNotice = (notice: string): void => {
    try {
      opts?.goal?.pauseGoal(notice);
    } catch {
      // observer errors never break the loop
    }
  };
  // Record one update_goal report into the per-turn slot (ticket 03), in
  // order: bad args are a model mistake (invalid-call error, nothing
  // recorded); with no live active goal the call is outside any goal turn
  // (structured error, zero state change); after a terminal report anything
  // further is rejected with a notice (first report sticks); the same value
  // twice is idempotent; otherwise the report replaces any pending
  // non-terminal one (last wins). Pure parts live in goal.ts; this closure
  // only owns the slot read/write. Never throws — results are strings.
  const recordGoalReport = (parsed: Record<string, unknown>): string => {
    const detail = validateUpdateGoalArgs(parsed);
    if (detail) return invalidCall(detail);
    const live = readLiveGoal();
    if (live === null || !live.active) return goalReportOutsideError();
    const next = updateGoalDisposition(parsed);
    if (pendingDisposition !== null && pendingDisposition.status !== "continue") {
      return goalReportRejectedNotice(pendingDisposition);
    }
    if (pendingDisposition !== null && sameGoalDisposition(pendingDisposition, next)) {
      return goalReportAck(next);
    }
    pendingDisposition = next;
    return goalReportAck(next);
  };
  // Take the pending report and clear the slot (ticket 03 consumption reads
  // through here so the declared return type drives the turn-end checks —
  // the captured slot's direct-flow narrowing would otherwise collapse the
  // read to null). A report never leaks into the following turn.
  const takeDisposition = (): GoalDisposition | null => {
    const current: GoalDisposition | null = pendingDisposition;
    pendingDisposition = null;
    return current;
  };
  // Novelty progress (ticket 05): per-run memory of committed-result
  // fingerprints plus the consecutive-non-novel streak. Recorded in the
  // commit funnel below; read at goal turn end for the stall redirect.
  // Loop-local is sufficient: a whole goal run normally lives inside one
  // runLoopWithChat call (continuations `continue` the loop; only
  // terminal/cancel/budget/failure return).
  const goalProgress = emptyGoalProgress();
  // One goal turn taken (guarded — accounting never breaks the turn).
  const noteGoalTurn = (): void => {
    try {
      opts?.goal?.onGoalTurn?.();
    } catch {
      // observer errors never break the loop
    }
  };
  // ---- Hardened-loop state (additive; explicit caps still honored —
  // see AgenticOpts docs) ----
  const maxTotalToolCalls = resolveMaxTotalToolCalls(opts?.maxTotalToolCalls);
  const repGuard = new RepetitionGuard({ maxRepeatedCalls: opts?.maxRepeatedCalls });
  const errStreak = new ErrorStreakTracker(opts?.maxConsecutiveErrors);
  const turnStartMs = Date.now();
  let startChars = 0;
  try {
    startChars = historyChars(history);
  } catch {
    startChars = 0;
  }
  let cacheHitsStart = 0;
  try {
    cacheHitsStart = getReadCacheStats().hits;
  } catch {
    cacheHitsStart = 0;
  }
  let modelCalls = 0;
  let toolCalls = 0;
  let failures = 0;
  // Empty-response repairs spent (bounded by MAX_EMPTY_ROUNDS — a model
  // that only answers silence still terminates).
  let emptyRounds = 0;
  let bottleneck: { name: string; durationMs: number } | null = null;
  const noteBottleneck = (name: string, durationMs: number): void => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if (!bottleneck || durationMs > bottleneck.durationMs) {
      bottleneck = { name, durationMs: Math.floor(durationMs) };
    }
  };
  const finishStats = (): void => {
    try {
      let endChars = startChars;
      try {
        endChars = historyChars(history);
      } catch {
        endChars = startChars;
      }
      let cacheHits = 0;
      try {
        cacheHits = Math.max(0, getReadCacheStats().hits - cacheHitsStart);
      } catch {
        cacheHits = 0;
      }
      const stats: LoopStats = {
        steps: modelCalls,
        modelCalls,
        toolCalls,
        failures,
        repetitionHits: repGuard.hitCount,
        cacheHits,
        durationMs: Math.max(0, Date.now() - turnStartMs),
        bottleneck,
        contextGrowthChars: endChars - startChars,
      };
      opts?.onLoopStats?.(stats);
    } catch {
      // observer errors never break the turn
    }
  };
  try {
  for (let step = 0; ; step++) {
    throwIfCancelled(signal);
    // Steering seam: drain one pending steer message (if any) at this safe
    // point — previous tool batches are fully committed, so assistant/tool
    // pairing can never split. No-op without the hook.
    try {
      opts?.drainSteer?.();
    } catch {
      // observer errors never break the loop
    }
    let msg: ChatResult;
    const modelStart = Date.now();
    try {
      msg = await chatFn(history, {
        onToken: opts?.onToken,
        onPhase: opts?.onPhase,
        onToolDelta: opts?.onToolDelta,
        onWarning: opts?.onWarning,
        onThinking: opts?.onThinking,
        sleep: opts?.sleep,
        reasoningEffort: opts?.reasoningEffort,
        signal,
      });
    } catch (e) {
      // A failed POST still records its model call (with the error) so the
      // trace shows what was attempted — the caller still rolls back.
      const modelEnd = Date.now();
      reportModelCall({
        step,
        startedAt: telemetryIso(modelStart),
        endedAt: telemetryIso(modelEnd),
        durationMs: Math.max(0, modelEnd - modelStart),
        usageReported: false,
        toolCallCount: 0,
        finishReason: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
      // Empty-response recovery: a silent POST spends repair budget instead
      // of aborting the turn (see MAX_EMPTY_ROUNDS). Cancellation above still
      // wins; every other failure throws exactly as before.
      if (isEmptyReplyError(e) && emptyRounds < MAX_EMPTY_ROUNDS) {
        emptyRounds += 1;
        failures += 1;
        history.push({ role: "assistant", content: "" });
        history.push({ role: "user", content: emptyResponseFollowUp(emptyRounds) });
        continue;
      }
      throw e;
    }
    throwIfCancelled(signal);
    // Defensive normalization (malformed custom chatFn responses never crash
    // the commit path): dropped calls surface via onWarning, pairing stays
    // valid because only validated calls reach the batch planner.
    try {
      const norm = normalizeChatResult(msg);
      if (norm.warnings.length > 0) {
        for (const w of norm.warnings) {
          try {
            opts?.onWarning?.(w);
          } catch {
            // ignore observer errors
          }
        }
      }
      msg = norm.result;
    } catch {
      // normalization never breaks the turn; the raw message stands
    }
    modelCalls += 1;
    // Goal slice (ticket 02): one completed POST while a goal is live.
    // Engages the run for turn accounting below; guarded, never breaks it.
    try {
      if (opts?.goal?.getGoal?.()?.active === true) {
        goalEngaged = true;
        opts.goal.onGoalRequest?.();
      }
    } catch {
      // observer errors never break the loop
    }
    if (msg.usage !== undefined) {
      // Spend accounting: EVERY POST that reports usage forwards it, and the
      // caller accumulates each report as billed spend — tool-round POSTs,
      // summary POSTs, and successful retries each count once. Attempts that
      // fail (HTTP/network/truncation) report no usage, so there is nothing
      // to dedupe: each attempt that reached the provider and reported counts
      // exactly once. Usage is never synthesized or estimated here.
      try {
        opts?.onUsage?.(msg.usage);
      } catch {
        // ignore
      }
    }
    if (msg.reasoning !== undefined) {
      try {
        opts?.onReasoning?.(msg.reasoning);
      } catch {
        // ignore
      }
    }
    {
      // Completed model call: usage is forwarded only when the response
      // actually carried it (usageReported) — never synthesized here.
      const modelEnd = Date.now();
      const callsCount = (msg.tool_calls ?? []).length;
      reportModelCall({
        step,
        startedAt: telemetryIso(modelStart),
        endedAt: telemetryIso(modelEnd),
        durationMs: Math.max(0, modelEnd - modelStart),
        usage: msg.usage,
        usageReported: msg.usage !== undefined,
        reasoningLabel: msg.reasoning,
        toolCallCount: callsCount,
        finishReason: callsCount === 0 ? "final" : "tool_calls",
      });
    }
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // Turn-continuation seam (ticket 03): the todo guard and verification
      // gate run as entries in TURN_END_GATES — one chain, one commit point.
      // Behavior is byte-identical to the two inline blocks this replaced.
      const outcome = evaluateTurnEnd(msg.content ?? "", {
        step,
        maxSteps,
        filesWritten,
        verifiedAfterWrite,
        needsVerification,
        unverifiedPaths: [...unverifiedPaths],
        verifyRounds,
        todoRounds,
      });
      if (outcome.kind === "continue") {
        // Guard continues are bounded per turn so a model that never
        // verifies or never resolves todos still terminates.
        if (outcome.via === "verification") verifyRounds += 1;
        else if (outcome.via === "todoCompletionGate") todoRounds += 1;
        history.push({ role: "assistant", content: outcome.assistantText });
        history.push({ role: "user", content: outcome.followUp });
        continue;
      }
      // Disposition protocol (ticket 03): consume this turn's update_goal
      // report BEFORE the auto-continue decision. Terminal dispositions stop
      // the run with a verdict — `blocked` unconditionally (even with
      // unaddressed tool errors), `complete` only through the honesty gate
      // below (unverified code or open todos continue instead) — pausing
      // the goal with the verdict as its notice (never clearing, like every
      // other loop-driven goal ending). A `continue` report's next action
      // becomes the follow-up below (generic text when absent); no report —
      // or a goal gone mid-turn — flows into the existing path untouched.
      // The slot clears on every consumption, so a report never leaks into
      // the following turn; guard `continue`s above never reach here, so a
      // report filed mid-turn survives them until a real turn end.
      const dispositionGoal = readLiveGoal();
      let disposition: GoalDisposition | null = takeDisposition();
      let goalNextAction: string | null = null;
      // Evaluator fallback (ticket 04): a report-less turn with a live goal
      // gets exactly ONE bounded judge call before continuing — but only when
      // a runner is configured. Without one the turn continues exactly as
      // before (existing tests pin this). A clear verdict flows through the
      // SAME terminal/continue handling below as a model report (a `complete`
      // still passes the honesty gate below — one code path for both); a judge error
      // or an unclear verdict pauses (preserves) instead of looping. The
      // judge reads history only — this path pushes nothing, so the judge
      // performs no state mutations.
      if (
        disposition === null &&
        dispositionGoal !== null &&
        dispositionGoal.active &&
        opts?.goalJudge
      ) {
        // Cancel wins before the extra POST: never judge into a lost turn.
        throwIfCancelled(signal);
        let verdict: GoalDisposition | null = null;
        let judgeError: string | null = null;
        try {
          verdict = await opts.goalJudge({
            goal: dispositionGoal.objective,
            turns: recentTurnsForJudge(history),
          });
        } catch (e) {
          // Whole-turn cancellation still propagates (it pauses via the outer
          // catch, like every other cancel) — anything else pauses here.
          if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
          const msg = e instanceof Error ? e.message : String(e);
          judgeError = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
        }
        // The goal may have cleared/paused mid-judge (slash runs while busy):
        // then the verdict is dropped and the turn ends normally — never
        // pause or continue a goal that is gone.
        const liveAfterJudge = readLiveGoal();
        if (liveAfterJudge === null || !liveAfterJudge.active) {
          if (goalEngaged) noteGoalTurn();
          history.push({ role: "assistant", content: outcome.finalText });
          try {
            opts?.onPhase?.("done");
          } catch {
            // ignore
          }
          return outcome.finalText;
        }
        if (judgeError !== null || verdict === null) {
          // Pause-with-preservation (never clear): the goal, todos, and
          // history stay for /goal resume. The turn was still taken.
          pauseLiveGoal(
            liveAfterJudge.objective,
            judgeError !== null ? `(judge failed: ${judgeError})` : `(judge unclear — no clear verdict)`
          );
          noteGoalTurn();
          history.push({ role: "assistant", content: outcome.finalText });
          try {
            opts?.onPhase?.("done");
          } catch {
            // ignore
          }
          return outcome.finalText;
        }
        disposition = verdict;
      }
      if (
        disposition !== null &&
        disposition.status !== "continue" &&
        dispositionGoal !== null &&
        dispositionGoal.active
      ) {
        // Cancel wins even mid-verdict: never stop cleanly into a lost turn.
        throwIfCancelled(signal);
        // Honest completion gate (ticket 06): a `complete` only lands on
        // genuinely finished work. With unverified code pending or todos
        // still open the goal continues instead of stopping, naming the
        // files/items through the gates' own follow-up voice (todos first,
        // matching TURN_END_GATES order). `blocked` skips this entirely and
        // stops unconditionally below. Evaluator verdicts share this path —
        // they arrive in the same `disposition` slot, so one code path gates
        // both. Guard `continue`s above never reach here, so a false
        // `complete` filed mid-turn is still caught when its turn ends.
        if (disposition.status === "complete") {
          // Voice-only probe: budgets/rounds zeroed so the builders return
          // their `continue` follow-up whenever their state is dirty — the
          // live budget owns spinning protection in the branch below, and the
          // pinned gates above own the per-turn nag bounds.
          const honestCtx = {
            step: 0,
            maxSteps: Number.POSITIVE_INFINITY,
            filesWritten,
            verifiedAfterWrite,
            needsVerification,
            unverifiedPaths: [...unverifiedPaths],
            verifyRounds: 0,
            todoRounds: 0,
          };
          const todoProbe = todoCompletionGate(outcome.finalText, honestCtx);
          const verifyProbe = verificationGate(outcome.finalText, honestCtx);
          const honestBlock =
            todoProbe.action === "continue"
              ? todoProbe
              : verifyProbe.action === "continue"
                ? verifyProbe
                : null;
          if (honestBlock !== null) {
            // Spent budget cannot start another turn: pause (preserve) with
            // the budget notice instead of completing dirty or spinning.
            if (step >= maxSteps || toolCalls >= maxTotalToolCalls) {
              pauseLiveGoal(dispositionGoal.objective, "(budget spent)");
              noteGoalTurn();
              history.push({ role: "assistant", content: outcome.finalText });
              try {
                opts?.onPhase?.("done");
              } catch {
                // ignore
              }
              return outcome.finalText;
            }
            // A guard-style continue: not a turn end, so no goal-turn
            // accounting — and the false report is already consumed, so the
            // next turn must file fresh evidence.
            history.push({ role: "assistant", content: honestBlock.assistantText });
            history.push({ role: "user", content: honestBlock.followUp });
            continue;
          }
        }
        const verdict =
          disposition.status === "complete"
            ? goalVerdictNotice(
                dispositionGoal.objective,
                "complete",
                disposition.reason,
                disposition.unverified
              )
            : goalVerdictNotice(dispositionGoal.objective, disposition.status, disposition.reason);
        pauseLiveGoalWithNotice(verdict);
        noteGoalTurn();
        const base = outcome.finalText;
        const final = base ? `${base}\n${verdict}` : verdict;
        history.push({ role: "assistant", content: final });
        try {
          opts?.onPhase?.("done");
        } catch {
          // ignore
        }
        return final;
      }
      if (
        disposition !== null &&
        disposition.status === "continue" &&
        disposition.next !== undefined &&
        dispositionGoal !== null &&
        dispositionGoal.active
      ) {
        goalNextAction = disposition.next;
      }
      // Error-streak recovery (additive, after the pinned gates): ending on
      // sustained unaddressed `Error:` results is almost always premature.
      // Single errors still end normally (the model may be reporting a
      // blocker); a streak holds final text for one fix-forward attempt,
      // bounded to 2 holds per turn.
      if (errStreak.shouldHoldFinal(2)) {
        const streak = errStreak.current;
        history.push({ role: "assistant", content: outcome.finalText });
        history.push({ role: "user", content: errorStreakFollowUp(streak) });
        continue;
      }
      // Goal auto-continue (tickets 02–03): with a live goal a would-be turn
      // end starts the next turn through the same assistant+user follow-up
      // seam the guards use above — the ONLY continuation message, so the
      // transcript shows each turn normally with no synthetic user input
      // beyond this mechanism. Unconditional (no turn cap): the run ends
      // only via pause (cancel/spent budget), clear, a terminal disposition,
      // or a thrown failure. A `continue` report's next action becomes the
      // follow-up text (generic follow-up when absent or unreported).
      // Runs after the error-streak hold so sustained tool failures still
      // get their fix-forward guidance first (a hold is not a turn end, so
      // it counts no goal turn — and a consumed `continue` report is dropped
      // with it, so the fix-forward guidance wins that round).
      const liveGoal = readLiveGoal();
      if (liveGoal !== null && liveGoal.active) {
        goalEngaged = true;
        // Cancel wins even mid-continuation: never start another turn lost.
        throwIfCancelled(signal);
        // A spent budget can never make progress — pause (preserve) with a
        // notice instead of POSTing forever. The turn was still taken.
        if (step >= maxSteps || toolCalls >= maxTotalToolCalls) {
          pauseLiveGoal(liveGoal.objective, "(budget spent)");
          noteGoalTurn();
          history.push({ role: "assistant", content: outcome.finalText });
          try {
            opts?.onPhase?.("done");
          } catch {
            // ignore
          }
          return outcome.finalText;
        }
        noteGoalTurn();
        history.push({ role: "assistant", content: outcome.finalText });
        // Stall redirect (ticket 05): a run of exact repeats gets the replan
        // nudge as its follow-up instead of the generic continuation — same
        // assistant+user commit shape as the other gates, so the redirect is
        // visible in the transcript. The epoch resets; the goal is never
        // paused, cleared, or ended here (existing budgets still bound a run
        // that keeps stalling, so recurring nudges cannot spin forever).
        if (goalStallReached(goalProgress)) {
          resetGoalStall(goalProgress);
          history.push({ role: "user", content: goalStallNudge(liveGoal.objective, GOAL_STALL_REPEATS) });
        } else {
          history.push({ role: "user", content: goalNextAction ?? goalFollowUp(liveGoal.objective) });
        }
        continue;
      }
      // Final turn of a run that engaged a goal before it cleared: the work
      // happened, so it still counts (no continuation — the goal is gone).
      if (goalEngaged) noteGoalTurn();
      history.push({ role: "assistant", content: outcome.finalText });
      try {
        opts?.onPhase?.("done");
      } catch {
        // ignore
      }
      return outcome.finalText;
    }
    if (step >= maxSteps) {
      const base = msg.content ?? "";
      const notice = `${base}${base ? "\n" : ""}(stopped: too many tool steps) (limit is ${maxSteps}; raise with ATOM_MAX_TOOL_STEPS=<n>)`;
      // Spent budget during a goal run pauses (preserves) it with a notice
      // instead of silently dropping it — the stop text stays the reply and
      // the pause notice lands as its own line via the callback.
      const overGoal = readLiveGoal();
      if (overGoal !== null && overGoal.active) {
        goalEngaged = true;
        pauseLiveGoal(overGoal.objective, "(step budget spent)");
        noteGoalTurn();
      } else if (goalEngaged) {
        noteGoalTurn();
      }
      history.push({ role: "assistant", content: notice });
      try {
        opts?.onPhase?.("done");
      } catch {
        // ignore
      }
      return notice;
    }
    // Total tool-call budget (explicit `opts.maxTotalToolCalls` only;
    // uncapped by default): counts every tool_call the model emits and stops
    // the turn when the explicit budget is exceeded.
    if (toolCalls + calls.length > maxTotalToolCalls) {
      const base = msg.content ?? "";
      const notice = `${base}${base ? "\n" : ""}(stopped: too many tool calls) (limit is ${maxTotalToolCalls} per turn)`;
      // Same pause-with-preservation contract as the step-budget stop above.
      const overGoal = readLiveGoal();
      if (overGoal !== null && overGoal.active) {
        goalEngaged = true;
        pauseLiveGoal(overGoal.objective, "(tool-call budget spent)");
        noteGoalTurn();
      } else if (goalEngaged) {
        noteGoalTurn();
      }
      history.push({ role: "assistant", content: notice });
      try {
        opts?.onPhase?.("done");
      } catch {
        // ignore
      }
      return notice;
    }
    history.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    // Commit helper shared by the serial and parallel paths: Task 7
    // bookkeeping + one ordered transcript entry per call. Only successful
    // executions count — denials, validation errors, and unknown tools (all
    // `Error:` results) never ran, so they neither arm nor clear the gate.
    const commitToolResult = async (
      name: string,
      parsed: Record<string, unknown>,
      call: ToolCall,
      result: string,
      durationMs?: number
    ): Promise<boolean> => {
      const baseIsError = typeof result === "string" && result.startsWith("Error");
      // Extension post-hooks observe the raw commit candidate first (every
      // committed result: executions, blocks, denials, validation errors);
      // the caller's onToolResult hook runs last on the patched version.
      // Patches apply per call in commit order, so tool_call_id re-pairing
      // and ordering are untouched; throwing patchers fail open above.
      const after = await runAfterIntercept(name, parsed, result, baseIsError);
      const hooked = await applyToolResultHook(opts?.onToolResult, name, parsed, after.content, after.isError);
      // Veto: skip the commit entirely — no counters, no gates, no history,
      // no activity. The turn continues; pairing risk is the hook author's.
      if (hooked.veto) return false;
      const finalResult = hooked.content;
      const isError = hooked.isError;
      toolCalls += 1;
      if (isError) failures += 1;
      errStreak.noteResult(isError);
      // Novelty progress (ticket 05): successful commits fingerprint into the
      // per-run seen-set (Error results are owned by the error-streak
      // machinery and never count). Guarded — accounting never breaks the turn.
      try {
        noteGoalProgress(goalProgress, name, parsed, finalResult, isError);
      } catch {
        // observer errors never break the loop
      }
      if (typeof durationMs === "number") noteBottleneck(name, durationMs);
      if (!isError && (name === "write" || name === "edit")) {
        filesWritten = true;
        verifiedAfterWrite = false;
        const p = typeof parsed["path"] === "string" ? (parsed["path"] as string) : "";
        if (isCodePath(p)) {
          needsVerification = true;
          if (p.length > 0 && !unverifiedPaths.includes(p)) unverifiedPaths.push(p);
        }
      } else if (!isError && name === "bash") {
        const command = parsed["command"];
        if (typeof command === "string" && isVerificationCommand(command) && filesWritten) {
          const exit = bashExitCode(finalResult);
          if (exit === null || exit === 0) {
            // Passing check (or a legacy runner that reports no envelope):
            // clears everything the gate tracks.
            verifiedAfterWrite = true;
            needsVerification = false;
            unverifiedPaths = [];
          } else {
            // A FAILED check is evidence of failure, not of verification:
            // the gate stays armed so the model fixes forward instead of
            // finishing on red output.
            verifiedAfterWrite = false;
          }
        }
      }
      history.push({ role: "tool", tool_call_id: call?.id ?? "", content: finalResult });
      try {
        opts?.onToolActivity?.(describeToolCall(name, parsed), finalResult, isError);
      } catch {
        // ignore observer errors
      }
      return true;
    };
    // Length-truncated response (the output limit cut the tool arguments
    // off): NOTHING executes — every carried call commits a repair-oriented
    // error result and the turn continues to the next model round. The
    // results are `Error:` strings, so failure/error-streak accounting flows
    // through commitToolResult exactly like any other tool error, and the
    // step/total-call budgets above keep bounding runaway retries.
    // Truncated-without-calls never reaches here (handled by the turn-end
    // gates above, exactly as before).
    if (msg.truncated === true) {
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        const name = call?.function?.name ?? "(unknown)";
        const result =
          `Error: truncated response: the output limit cut off the arguments for tool "${name}" — ` +
          `nothing was executed. Re-issue the call with complete arguments ` +
          `(narrow the scope or split into smaller calls if it keeps truncating).`;
        const toolAt = Date.now();
        reportToolCall({
          step,
          toolCallId: call?.id ?? "",
          name,
          startedAt: telemetryIso(toolAt),
          endedAt: telemetryIso(toolAt),
          durationMs: 0,
          argsJson: telemetryArgsJson(call?.function?.arguments ?? "{}"),
          result,
          batchIndex: i,
          batchSize: calls.length,
        });
        // Truncated arguments are often not valid JSON (cut mid-string) —
        // fall back to {} for bookkeeping (an error result never arms the
        // verification gate, so this only shapes the activity label).
        let parsed: Record<string, unknown>;
        try {
          const raw = call?.function?.arguments ?? "{}";
          const v: unknown = JSON.parse(typeof raw === "string" ? raw : "{}");
          parsed = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
        } catch {
          parsed = {};
        }
        await commitToolResult(name, parsed, call, result);
      }
      continue;
    }
    for (const batch of planBatches(calls)) {
      // No new executions after a cancel: the current tool (if any) already
      // finished; stop before starting the next batch.
      throwIfCancelled(signal);
      if (batch.length === 1) {
        // Serial path: byte-identical to the pre-05 loop body.
        const call = batch[0]!.call;
        const name = call?.function?.name ?? "(unknown)";
        try {
          opts?.onPhase?.("tool", name);
        } catch {
          // ignore
        }
        const toolStart = Date.now();
        let parsed: Record<string, unknown>;
        try {
          const raw = call?.function?.arguments ?? "{}";
          const v: unknown = JSON.parse(typeof raw === "string" ? raw : "{}");
          parsed = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
        } catch {
          parsed = {};
          const result = `Error: invalid call: invalid JSON arguments for tool "${name}" (arguments must be valid JSON). Fix the arguments and retry.`;
          // Invalid JSON never executes — route through the commit funnel so
          // the result hook still sees every committed result. Bookkeeping
          // (counters, error streak, bottleneck, history, activity) is
          // identical to the inline block this replaced; only the committed
          // content may differ when a hook rewrites it.
          repGuard.note(toolSignature(name, parsed), name);
          const toolEnd = Date.now();
          reportToolCall({
            step,
            toolCallId: call?.id ?? "",
            name,
            startedAt: telemetryIso(toolStart),
            endedAt: telemetryIso(toolEnd),
            durationMs: Math.max(0, toolEnd - toolStart),
            argsJson: telemetryArgsJson(call?.function?.arguments ?? "{}"),
            result,
            batchIndex: 0,
            batchSize: 1,
          });
          await commitToolResult(name, parsed, call, result, Math.max(0, toolEnd - toolStart));
          continue;
        }
        let result: string;
        // Effective (post-rewrite) args: what validated, approved, and ran —
        // telemetry and the commit below must see these, not the originals.
        let effectiveArgs: Record<string, unknown> = parsed;
        // Repetition guard (opt-in via maxRepeatedCalls; unset = track-only):
        // a repeated signature skips execution and yields a guidance error;
        // exhausted nudges stop hard.
        const repSig = toolSignature(name, parsed);
        const repNote = repGuard.note(repSig, name);
        if (repNote.intervened) {
          const toolEndRep = Date.now();
          if (repGuard.consumeNudge()) {
            const guarded = `Error: invalid call: ${repetitionFollowUp(repSig, repNote.consecutive)} Fix the approach and retry.`;
            reportToolCall({
              step,
              toolCallId: call?.id ?? "",
              name,
              startedAt: telemetryIso(toolStart),
              endedAt: telemetryIso(toolEndRep),
              durationMs: 0,
              argsJson: telemetryArgsJson(parsed),
              result: guarded,
              batchIndex: 0,
              batchSize: 1,
            });
            await commitToolResult(name, parsed, call, guarded, 0);
            continue;
          }
          const guarded = `Error: invalid call: ${repetitionFollowUp(repSig, repNote.consecutive)} Fix the approach and retry.`;
          reportToolCall({
            step,
            toolCallId: call?.id ?? "",
            name,
            startedAt: telemetryIso(toolStart),
            endedAt: telemetryIso(toolEndRep),
            durationMs: 0,
            argsJson: telemetryArgsJson(parsed),
            result: guarded,
            batchIndex: 0,
            batchSize: 1,
          });
          await commitToolResult(name, parsed, call, guarded, 0);
          const stopBase = msg.content ?? "";
          const stopNotice = `${stopBase}${stopBase ? "\n" : ""}${repetitionStopNotice(repSig, repNote.consecutive)}`;
          history.push({ role: "assistant", content: stopNotice });
          try {
            opts?.onPhase?.("done");
          } catch {
            // ignore
          }
          return stopNotice;
        }
        try {
          const one = await runOneTool(call, parsed, opts, execute, undefined, recordGoalReport);
          result = one.result;
          effectiveArgs = one.args;
        } catch (e) {
          // A cancelled/throwing tool still records its attempt (with the
          // cause) so the trace shows what was in flight — then the turn
          // aborts exactly as before.
          const toolEnd = Date.now();
          const cancelled = isCancelError(e) || signal?.aborted;
          if (!cancelled) {
            failures += 1;
            noteBottleneck(name, Math.max(0, toolEnd - toolStart));
          }
          reportToolCall({
            step,
            toolCallId: call?.id ?? "",
            name,
            startedAt: telemetryIso(toolStart),
            endedAt: telemetryIso(toolEnd),
            durationMs: Math.max(0, toolEnd - toolStart),
            argsJson: telemetryArgsJson(parsed),
            result: e instanceof Error ? e.message : String(e),
            cancelled: cancelled ? true : undefined,
            threw: cancelled ? undefined : true,
            batchIndex: 0,
            batchSize: 1,
          });
          if (cancelled) throw new LoopCancelledError();
          throw e;
        }
        {
          const toolEnd = Date.now();
          reportToolCall({
            step,
            toolCallId: call?.id ?? "",
            name,
            startedAt: telemetryIso(toolStart),
            endedAt: telemetryIso(toolEnd),
            durationMs: Math.max(0, toolEnd - toolStart),
            argsJson: telemetryArgsJson(effectiveArgs),
            result,
            batchIndex: 0,
            batchSize: 1,
          });
        }
        await commitToolResult(name, effectiveArgs, call, result, Math.max(0, Date.now() - toolStart));
        continue;
      }
      // Parallel batch: every member is pre-validated parallel-safe (see
      // planToolBatches). Approval-gated members (parallel writes) resolve
      // their decisions serially in call order first, so prompts never run
      // concurrently; denied members yield inline errors without executing.
      // Phases fire upfront in call order; results commit in call order, so
      // each call still shows separately and tool_call_ids re-pair by index.
      // A throw (cancel or execution error) aborts the turn exactly like the
      // serial path — the caller rolls the partial turn back.
      for (const member of batch) {
        try {
          opts?.onPhase?.("tool", member.call?.function?.name ?? "(unknown)");
        } catch {
          // ignore
        }
      }
      let results: string[];
      const memberDurations: number[] = new Array(batch.length).fill(0);
      // Repetition pre-notes (synchronous, in call order — deterministic):
      // intervened members skip execution with a guidance error; exhausted
      // nudges arm a hard stop after this batch commits (pairing stays valid).
      const repNotes = batch.map((member) =>
        repGuard.note(
          toolSignature(member.call?.function?.name ?? "(unknown)", member.parsed),
          member.call?.function?.name ?? "(unknown)"
        )
      );
      let repHardStop: { sig: string; consecutive: number } | null = null;
      for (let i = 0; i < batch.length; i++) {
        const note = repNotes[i]!;
        if (note.intervened && !repGuard.consumeNudge() && !repHardStop) {
          repHardStop = { sig: note.signature, consecutive: note.consecutive };
        }
      }
      // Serial approval pre-pass (in call order, skipping repetition-guarded
      // members exactly as the serial path would): extension pre-hooks run
      // here first — rewrites reach the approval prompt, and a block skips
      // approval entirely (see the hook-vs-approval note on runOneTool).
      // Prompts still resolve before any member executes, so concurrent
      // writes never prompt at once. Cancel between prompts aborts the
      // batch with nothing executed.
      type MemberPlan = {
        /** Post-rewrite args: what validates, approves, executes, and commits. */
        args: Record<string, unknown>;
        /** Non-null when a pre-hook blocked: commit this, execute nothing. */
        blocked: string | null;
        /** Non-null when rewritten args fail validation: inline error, never runs. */
        invalid: string | null;
      };
      const memberPlans = new Map<number, MemberPlan>();
      const preDecisions = new Map<number, ApprovalDecision>();
      for (let i = 0; i < batch.length; i++) {
        throwIfCancelled(signal);
        if (repNotes[i]!.intervened) continue;
        const member = batch[i]!;
        const memberName = member.call?.function?.name ?? "(unknown)";
        if (!toolNames().includes(memberName)) {
          memberPlans.set(i, { args: member.parsed, blocked: null, invalid: null });
          continue;
        }
        const pre = await runBeforeIntercept(memberName, member.parsed);
        if (pre.blocked !== null) {
          memberPlans.set(i, { args: pre.args, blocked: pre.blocked, invalid: null });
          continue;
        }
        const invalid = validateToolArgs(memberName, pre.args);
        if (invalid) {
          memberPlans.set(i, { args: pre.args, blocked: null, invalid });
          continue;
        }
        memberPlans.set(i, { args: pre.args, blocked: null, invalid: null });
        const decision = await resolveApproval(memberName, pre.args, opts);
        if (decision !== null) preDecisions.set(i, decision);
      }
      try {
        // Each member is timed individually (concurrent wall-clock per call,
        // not the whole batch attributed to each) and reported in call order
        // below. A throw still aborts the turn exactly like the serial path.
        results = await Promise.all(
          batch.map(async (member, index) => {
            const memberStart = Date.now();
            const note = repNotes[index]!;
            const memberName = member.call?.function?.name ?? "(unknown)";
            if (note.intervened) {
              const guarded = `Error: invalid call: ${repetitionFollowUp(note.signature, note.consecutive)} Fix the approach and retry.`;
              const memberEnd = Date.now();
              memberDurations[index] = 0;
              reportToolCall({
                step,
                toolCallId: member.call?.id ?? "",
                name: memberName,
                startedAt: telemetryIso(memberStart),
                endedAt: telemetryIso(memberEnd),
                durationMs: 0,
                argsJson: telemetryArgsJson(member.parsed),
                result: guarded,
                batchIndex: index,
                batchSize: batch.length,
              });
              return guarded;
            }
            try {
              // Pre-resolved members (blocked/invalid) never reach the
              // executor: their inline results commit in call order below.
              const plan = memberPlans.get(index);
              if (plan?.blocked !== null && plan?.blocked !== undefined) {
                const blocked = plan!.blocked as string;
                const memberEnd = Date.now();
                memberDurations[index] = Math.max(0, memberEnd - memberStart);
                reportToolCall({
                  step,
                  toolCallId: member.call?.id ?? "",
                  name: member.call?.function?.name ?? "(unknown)",
                  startedAt: telemetryIso(memberStart),
                  endedAt: telemetryIso(memberEnd),
                  durationMs: Math.max(0, memberEnd - memberStart),
                  argsJson: telemetryArgsJson(plan!.args),
                  result: blocked,
                  batchIndex: index,
                  batchSize: batch.length,
                });
                return blocked;
              }
              if (plan?.invalid) {
                const bad = invalidCall(plan.invalid);
                const memberEnd = Date.now();
                memberDurations[index] = Math.max(0, memberEnd - memberStart);
                reportToolCall({
                  step,
                  toolCallId: member.call?.id ?? "",
                  name: member.call?.function?.name ?? "(unknown)",
                  startedAt: telemetryIso(memberStart),
                  endedAt: telemetryIso(memberEnd),
                  durationMs: Math.max(0, memberEnd - memberStart),
                  argsJson: telemetryArgsJson(plan!.args),
                  result: bad,
                  batchIndex: index,
                  batchSize: batch.length,
                });
                return bad;
              }
              const r = await runOneToolWithArgs(member.call, plan?.args ?? member.parsed, opts, execute, preDecisions.get(index) ?? null, recordGoalReport);
              const memberEnd = Date.now();
              memberDurations[index] = Math.max(0, memberEnd - memberStart);
              reportToolCall({
                step,
                toolCallId: member.call?.id ?? "",
                name: member.call?.function?.name ?? "(unknown)",
                startedAt: telemetryIso(memberStart),
                endedAt: telemetryIso(memberEnd),
                durationMs: Math.max(0, memberEnd - memberStart),
                argsJson: telemetryArgsJson(plan?.args ?? member.parsed),
                result: r.result,
                batchIndex: index,
                batchSize: batch.length,
              });
              return r.result;
            } catch (e) {
              const memberEnd = Date.now();
              const cancelled = isCancelError(e) || signal?.aborted;
              if (!cancelled) {
                failures += 1;
                noteBottleneck(member.call?.function?.name ?? "(unknown)", Math.max(0, memberEnd - memberStart));
              }
              reportToolCall({
                step,
                toolCallId: member.call?.id ?? "",
                name: member.call?.function?.name ?? "(unknown)",
                startedAt: telemetryIso(memberStart),
                endedAt: telemetryIso(memberEnd),
                durationMs: Math.max(0, memberEnd - memberStart),
                argsJson: telemetryArgsJson(member.parsed),
                result: e instanceof Error ? e.message : String(e),
                cancelled: cancelled ? true : undefined,
                threw: cancelled ? undefined : true,
                batchIndex: index,
                batchSize: batch.length,
              });
              throw e;
            }
          })
        );
      } catch (e) {
        if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
        throw e;
      }
      for (let i = 0; i < batch.length; i++) {
        const member = batch[i]!;
        await commitToolResult(
          member.call?.function?.name ?? "(unknown)",
          memberPlans.get(i)?.args ?? member.parsed,
          member.call,
          results[i]!,
          memberDurations[i]
        );
      }
      if (repHardStop) {
        const stopBase = msg.content ?? "";
        const stopNotice = `${stopBase}${stopBase ? "\n" : ""}${repetitionStopNotice(repHardStop.sig, repHardStop.consecutive)}`;
        history.push({ role: "assistant", content: stopNotice });
        try {
          opts?.onPhase?.("done");
        } catch {
          // ignore
        }
        return stopNotice;
      }
    }
  }
  } catch (e) {
    // Cancel during a live goal pauses (preserves) it with a notice — never
    // clears — so a later /goal resume can continue. Failed POSTs skip this
    // entirely: the caller rolls back per the existing splice contract and
    // the goal stays active and carries on.
    if (isCancelError(e) || signal?.aborted) {
      const cancelledGoal = readLiveGoal();
      if (cancelledGoal !== null && cancelledGoal.active) {
        pauseLiveGoal(cancelledGoal.objective, "(cancelled)");
      }
    }
    throw e;
  } finally {
    finishStats();
  }
}
