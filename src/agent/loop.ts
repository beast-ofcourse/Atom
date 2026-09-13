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
import { captureSchedulerSnapshot, planBatches } from "../scheduler.js";
import type {
  LoopTelemetrySink,
  SinkModelCallInfo,
  SinkToolCallInfo,
} from "../telemetry.js";
import { describeToolCall, executeTool, getTodos, invalidCall } from "../tools.js";
import {
  applyCommitPatches,
  invalidJsonArgsResult,
  isCancelError,
  LoopCancelledError,
  parseToolArguments,
  planToolCall,
  runPlannedToolCall,
  runSerialToolPipeline,
  throwIfCancelled,
  type PipelineDecisionKind,
  type PreExecutionPlan,
  type ToolCallReceipt,
} from "./tool-pipeline.js";
import { getReadCacheStats } from "../tools/read-cache.js";
import {
  emptyGoalProgress,
  goalPausedNotice,
  goalReportAck,
  goalReportOutsideError,
  goalReportRejectedNotice,
  noteGoalProgress,
  recentTurnsForJudge,
  sameGoalDisposition,
  updateGoalDisposition,
  validateUpdateGoalArgs,
  type GoalDisposition,
} from "../goal.js";
import {
  bashExitCode,
  decideTurnEndAfterGates,
  evaluateTurnEnd,
  isCodePath,
  isVerificationCommand,
  type StopJudge,
} from "./gates.js";
import {
  ErrorStreakTracker,
  repetitionFollowUp,
  RepetitionGuard,
  repetitionStopNotice,
} from "./loop-guard.js";
import { normalizeChatResult, toolSignature } from "./normalize.js";
import type { AgenticOpts, ApprovalDecision, ChatMessage, ChatResult, LoopStats, Phase, ToolCall } from "./types.js";
import { emitTurnEvent } from "./turn-events.js";

// Compat re-exports: the cancel primitives and the tool-timeout helpers now
// live in the pipeline module (./tool-pipeline.js); loop.js re-exports them
// so existing `from "./agent/loop.js"` importers (via zen) keep working.
export {
  DEFAULT_TOOL_TIMEOUT_MS,
  executeWithTimeout,
  isCancelError,
  LoopCancelledError,
  resolveToolTimeoutMs,
  throwIfCancelled,
} from "./tool-pipeline.js";
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

// Total tool-call budget per turn (no default cap; explicit opts value only,
// min 1). Previously defaulted to 200 as a parallel-batch explosion guard.
// Deprecated alias kept for import compatibility; the loop no longer uses it.
export const DEFAULT_MAX_TOTAL_TOOL_CALLS = Number.POSITIVE_INFINITY;
export function resolveMaxTotalToolCalls(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(raw));
}

// Per-call pipeline stages (hook → validate → approve → execute →
// post-hook) live in ./tool-pipeline.js — the serial driver calls
// runSerialToolPipeline, the parallel pre-pass plans each member via
// planToolCall and members execute via runPlannedToolCall (the same
// plan/run pair, so the paths share every stage by construction).
// Execute one parsed tool call through interception + validation +
// permission + the registry-intercepted stage. Model mistakes (unknown
// name, invalid args) return repairs-oriented results WITHOUT executing;
// cancellations propagate as LoopCancelledError (never a result, never
// retried).
// Everything else returns the result string plus the effective (post-
// rewrite) args the commit funnel must use for gates, labels, and pairing:
// - Hook-vs-approval ordering: pre-hooks run BEFORE validation and
//   approval. The hook sees the call pre-approval and may rewrite args
//   before the approval prompt shows them; a block short-circuits approval
//   entirely (no prompt for a call that never runs). Rewrites always
//   re-validate before execution, so a hook can never smuggle unvalidated
//   args into an executor.
// - Unknown names never reach hooks (model mistake — nothing would run).
//   The registry roster (toolNames/isInterceptedTool) is the only name
//   authority — the loop holds no per-tool branch.
// - ask_question never needs approval; without an askUser hook it resolves
//   to "Error: ask_question has no UI hook".
// - update_goal never needs approval either; without the per-turn recorder
//   (only runLoopWithChat supplies it) it resolves to the outside-turn error.
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
  // Ordered turn-event sink (see src/agent/turn-events.ts): additive-only
  // observer beside the callbacks below. Every emission goes through
  // emitTurnEvent (guarded, never throws); absent → no reporting, and the
  // pass-through wrappers below collapse to the original callbacks.
  const sink = opts?.turnEvents;
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
  // TurnEvents phase mirror: reports the same phase + detail the loop just
  // sent to onPhase. Always called AFTER the callback block, so callback side
  // effects keep their exact order; guarded, so the sink never breaks the turn.
  const reportPhase = (phase: Phase, detail?: string): void => {
    emitTurnEvent(sink, (s) => s.onPhase?.(phase, detail));
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
  // v2 phase tracking: model time is measured alongside tool time so a 289s
  // streaming stall is never hidden behind a 94ms glob again.
  let slowestModel: { id: string; durationMs: number } | null = null;
  let modelTotalMs = 0;
  let toolTotalMs = 0;
  let truncationNotices = 0;
  const noteModel = (id: string, durationMs: number): void => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const floored = Math.floor(durationMs);
    modelTotalMs += floored;
    if (!slowestModel || floored > slowestModel.durationMs) {
      slowestModel = { id, durationMs: floored };
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
        slowestModel,
        modelTotalMs,
        toolTotalMs,
        dominantPhase: modelTotalMs >= toolTotalMs ? "model" : "tool",
        truncationNotices,
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
      // TurnEvents pass-through wrappers: each original callback runs first,
      // exactly as before (a throwing callback still propagates to chatFn),
      // then the same fact is reported to the sink (guarded, never throws).
      // onToolDelta/onWarning have no sink kinds and pass through untouched.
      // When the sink is absent the wrapper still calls the original — and a
      // field with neither callback nor sink stays undefined, so chatFn sees
      // the same shape it always did.
      const sinkToken = sink?.onToken !== undefined;
      const sinkPhase = sink?.onPhase !== undefined;
      const sinkThinking = sink?.onThinking !== undefined;
      msg = await chatFn(history, {
        onToken:
          opts?.onToken !== undefined || sinkToken
            ? (text) => {
                opts?.onToken?.(text);
                emitTurnEvent(sink, (s) => s.onToken?.(text));
              }
            : undefined,
        onPhase:
          opts?.onPhase !== undefined || sinkPhase
            ? (phase, detail) => {
                opts?.onPhase?.(phase, detail);
                emitTurnEvent(sink, (s) => s.onPhase?.(phase, detail));
              }
            : undefined,
        onToolDelta: opts?.onToolDelta,
        onWarning: opts?.onWarning,
        onThinking:
          opts?.onThinking !== undefined || sinkThinking
            ? (thinking) => {
                opts?.onThinking?.(thinking);
                emitTurnEvent(sink, (s) => s.onThinking?.(thinking));
              }
            : undefined,
        sleep: opts?.sleep,
        reasoningEffort: opts?.reasoningEffort,
        signal,
      });
    } catch (e) {
      // A failed POST still records its model call (with the error) so the
      // trace shows what was attempted — the caller still rolls back.
      const modelEnd = Date.now();
      const failedMs = Math.max(0, modelEnd - modelStart);
      noteModel(`model-step-${step}`, failedMs);
      if (typeof (e as Error)?.message === "string" && (e as Error).message.startsWith("Truncated stream")) {
        truncationNotices += 1;
      }
      failures += 1;
      reportModelCall({
        step,
        startedAt: telemetryIso(modelStart),
        endedAt: telemetryIso(modelEnd),
        durationMs: failedMs,
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
        // failures already counted once above for this failed POST.
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
      const okMs = Math.max(0, modelEnd - modelStart);
      noteModel(`model-step-${step}`, okMs);
      if (msg.truncated === true) truncationNotices += 1;
      reportModelCall({
        step,
        startedAt: telemetryIso(modelStart),
        endedAt: telemetryIso(modelEnd),
        durationMs: okMs,
        usage: msg.usage,
        usageReported: msg.usage !== undefined,
        reasoningLabel: msg.reasoning,
        toolCallCount: callsCount,
        finishReason: callsCount === 0 ? "final" : "tool_calls",
      });
    }
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // Turn-end stops (see decideTurnEnd in ./gates.js): every stop — the
      // pinned gates, judge settlement, terminal verdicts with the honesty
      // probe, the error-streak hold, goal auto-continue — decides behind
      // one chain. The pinned gates pre-check first (a guard `continue`
      // returns early without consuming the disposition slot or running the
      // judge); otherwise this block acquires the judge verdict (async I/O,
      // like the model POST) and applies the chain's decision: round
      // counting, goal-turn accounting, pause notices, transcript commits.
      // Phase-1 pre-check: the pinned gates run first, exactly as before —
      // a guard `continue` returns early WITHOUT consuming the disposition
      // slot or running the judge (a report filed mid-turn survives guard
      // continues until a real turn end). Only when the gates end does the
      // block below consume the slot, acquire the judge, and let the full
      // chain (decideTurnEnd, which re-runs this pure phase identically on
      // the way through) decide.
      const gated = evaluateTurnEnd(msg.content ?? "", {
        step,
        maxSteps,
        filesWritten,
        verifiedAfterWrite,
        needsVerification,
        unverifiedPaths: [...unverifiedPaths],
        verifyRounds,
        todoRounds,
        openTodos: getTodos(),
      });
      if (gated.kind === "continue") {
        // Guard continues are bounded per turn so a model that never
        // verifies or never resolves todos still terminates.
        if (gated.via === "verification") verifyRounds += 1;
        else if (gated.via === "todoCompletionGate") todoRounds += 1;
        history.push({ role: "assistant", content: gated.assistantText });
        history.push({ role: "user", content: gated.followUp });
        continue;
      }
      const dispositionGoal = readLiveGoal();
      let disposition: GoalDisposition | null = takeDisposition();
      // Evaluator fallback (ticket 04): a report-less turn with a live goal
      // gets exactly ONE bounded judge call before the stops decide — but
      // only when a runner is configured. Without one the stops decide
      // exactly as before (existing tests pin this). A clear verdict folds
      // into `disposition` and flows through the SAME terminal handling as
      // a model report; a judge error, an unclear verdict, or a goal gone
      // mid-judge arrives as `judge` instead. The judge reads history only
      // — this path pushes nothing, so the judge performs no state
      // mutations.
      let judge: StopJudge | null = null;
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
          // catch, like every other cancel) — anything else pauses via the
          // judge stop below.
          if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
          const raw = e instanceof Error ? e.message : String(e);
          judgeError = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
        }
        // The goal may have cleared/paused mid-judge (slash runs while busy):
        // then the verdict is dropped and the turn ends normally — never
        // pause or continue a goal that is gone.
        const liveAfterJudge = readLiveGoal();
        if (liveAfterJudge === null || !liveAfterJudge.active) {
          judge = { kind: "dropped" };
        } else if (judgeError !== null || verdict === null) {
          judge = judgeError !== null ? { kind: "failed", message: judgeError } : { kind: "unclear" };
        } else {
          disposition = verdict;
        }
      }
      const liveGoal = readLiveGoal();
      // Gates already evaluated above — remaining stops decide from the gated
      // text so the chain is evaluated exactly once and disposition/judge are
      // only consumed when the gates did not continue.
      const decision = decideTurnEndAfterGates(gated.finalText, {
        step,
        maxSteps,
        filesWritten,
        verifiedAfterWrite,
        needsVerification,
        unverifiedPaths: [...unverifiedPaths],
        verifyRounds,
        todoRounds,
        openTodos: getTodos(),
        errorStreak: errStreak,
        disposition,
        goal: liveGoal !== null && liveGoal.active ? { objective: liveGoal.objective } : null,
        toolCalls,
        maxTotalToolCalls,
        goalEngaged,
        goalProgress,
        judge,
      });
      if (decision.kind === "continue") {
        if (decision.via === "goalContinue") goalEngaged = true;
        if (decision.noteGoalTurn) noteGoalTurn();
        history.push({ role: "assistant", content: decision.assistantText });
        history.push({ role: "user", content: decision.followUp });
        continue;
      }
      if (decision.noteGoalTurn) noteGoalTurn();
      if (decision.pauseNotice !== undefined) pauseLiveGoalWithNotice(decision.pauseNotice);
      history.push({ role: "assistant", content: decision.finalText });
      try {
        opts?.onPhase?.("done");
      } catch {
        // ignore
      }
      reportPhase("done");
      return decision.finalText;
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
      reportPhase("done");
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
      reportPhase("done");
      return notice;
    }
    history.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    // Commit funnel shared by the serial and parallel paths: Task 7
    // bookkeeping + one ordered transcript entry per call. Only successful
    // executions count — denials, validation errors, and unknown tools (all
    // `Error:` results) never ran, so they neither arm nor clear the gate.
    //
    // The funnel returns the commit receipt (see ToolCallReceipt in
    // ./tool-pipeline.js): the effective args plus the final post-patch
    // result. The serial driver reports telemetry from this receipt AFTER
    // the commit, so telemetry, history, and activity all observe the same
    // values. The parallel path keeps its pre-commit telemetry reporting
    // untouched (ticket 05 owns that path) and ignores the return.
    const commitToolResult = async (
      name: string,
      parsed: Record<string, unknown>,
      call: ToolCall,
      result: string,
      durationMs?: number
    ): Promise<{ committed: boolean; result: string; isError: boolean }> => {
      const baseIsError = typeof result === "string" && result.startsWith("Error");
      // Extension post-hooks observe the raw commit candidate first (every
      // committed result: executions, blocks, denials, validation errors);
      // the caller's onToolResult hook runs last on the patched version.
      // Patches apply per call in commit order, so tool_call_id re-pairing
      // and ordering are untouched; throwing patchers fail open inside the
      // pipeline module.
      const patched = await applyCommitPatches(name, parsed, result, baseIsError, opts?.onToolResult);
      // Veto: skip the commit entirely — no counters, no gates, no history,
      // no activity. The turn continues; pairing risk is the hook author's.
      if (patched.veto) return { committed: false, result: patched.content, isError: patched.isError };
      const finalResult = patched.content;
      const isError = patched.isError;
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
      if (typeof durationMs === "number") {
        noteBottleneck(name, durationMs);
        if (Number.isFinite(durationMs) && durationMs >= 0) toolTotalMs += Math.floor(durationMs);
      }
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
      // TurnEvents: the commit funnel is the single commit-order point — every
      // committed result reports its stable identity here, right after the
      // activity callback. Vetoed results return above with neither activity
      // nor sink event, exactly matching the callbacks.
      emitTurnEvent(sink, (s) => s.onToolFinished?.({ toolCallId: call?.id ?? "", name, isError }));
      return { committed: true, result: finalResult, isError };
    };
    // Length-truncated response (the output limit cut the tool arguments
    // off): NOTHING executes — every carried call commits a repair-oriented
    // error result and the turn continues to the next model round. The
    // results are `Error:` strings, so failure/error-streak accounting flows
    // through commitToolResult exactly like any other tool error, and the
    // step/total-call budgets above keep bounding runaway retries.
    // Truncated-without-calls never reaches here (handled by the turn-end
    // gates above, exactly as before).
    // NOTE: truncationNotices is counted at the POST (success) and stream-death
    // sites above — not here — so each truncated response counts exactly once.
    if (msg.truncated === true) {
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        const name = call?.function?.name ?? "(unknown)";
        const result =
          `Error: truncated response: the output limit cut off the arguments for tool "${name}" — ` +
          `nothing was executed. Re-issue the call with complete arguments ` +
          `(narrow the scope or split into smaller calls if it keeps truncating).`;
        const toolAt = Date.now();
        // Truncated arguments are often not valid JSON (cut mid-string) —
        // fall back to {} for bookkeeping (an error result never arms the
        // verification gate, so this only shapes the activity label).
        const parsed = parseToolArguments(call?.function?.arguments) ?? {};
        // TurnEvents: truncated calls never ran, so no phase fired — report
        // the start here so every finished keeps a preceding started.
        emitTurnEvent(sink, (s) => s.onToolStarted?.({ toolCallId: call?.id ?? "", name, index: i }));
        // Commit first, then report telemetry from the receipt: one receipt
        // (effective args + final post-patch result) for telemetry, history,
        // and activity alike.
        const commit = await commitToolResult(name, parsed, call, result);
        const receipt: ToolCallReceipt = {
          toolCallId: call?.id ?? "",
          name,
          args: parsed,
          result: commit.result,
          isError: commit.isError,
          durationMs: 0,
          committed: commit.committed,
          decision: "truncated",
        };
        reportToolCall({
          step,
          toolCallId: receipt.toolCallId,
          name,
          startedAt: telemetryIso(toolAt),
          endedAt: telemetryIso(toolAt),
          durationMs: 0,
          argsJson: telemetryArgsJson(receipt.args),
          result: receipt.result,
          batchIndex: i,
          batchSize: calls.length,
        });
      }
      continue;
    }
    // Static registry snapshot (ticket 05): captured once per tool_calls
    // block at plan time and threaded through planning, so a mid-turn
    // extension registration cannot reshape an already-planned batch.
    const registrySnapshot = captureSchedulerSnapshot();
    for (const batch of planBatches(calls, registrySnapshot)) {
      // No new executions after a cancel: the current tool (if any) already
      // finished; stop before starting the next batch.
      throwIfCancelled(signal);
      if (batch.length === 1) {
        // Serial path: one call through the pipeline module
        // (hook → validate → approve → execute), committed through the
        // shared funnel, with telemetry reported from the commit receipt —
        // one receipt for telemetry, history, and activity alike.
        const call = batch[0]!.call;
        const name = call?.function?.name ?? "(unknown)";
        try {
          opts?.onPhase?.("tool", name);
        } catch {
          // ignore
        }
        // TurnEvents: phase mirror + start of this tool transition, keyed by
        // the stable tool_call_id — never the display label.
        reportPhase("tool", name);
        emitTurnEvent(sink, (s) =>
          s.onToolStarted?.({ toolCallId: call?.id ?? "", name, index: calls.indexOf(call) })
        );
        const toolStart = Date.now();
        // One serial telemetry report from a commit receipt (effective args
        // + final post-patch result). Thrown executions never commit, so
        // they keep their attempt-shaped report in the catch below.
        const reportSerialReceipt = (receipt: ToolCallReceipt, toolEndMs: number): void => {
          reportToolCall({
            step,
            toolCallId: receipt.toolCallId,
            name: receipt.name,
            startedAt: telemetryIso(toolStart),
            endedAt: telemetryIso(toolEndMs),
            durationMs: Math.max(0, toolEndMs - toolStart),
            argsJson: telemetryArgsJson(receipt.args),
            result: receipt.result,
            batchIndex: 0,
            batchSize: 1,
          });
        };
        const unparsed = parseToolArguments(call?.function?.arguments);
        if (unparsed === null) {
          // Invalid JSON never executes — route through the commit funnel so
          // the result hook still sees every committed result. Bookkeeping
          // (counters, error streak, bottleneck, history, activity) is
          // identical to the inline block this replaced; only the committed
          // content may differ when a hook rewrites it.
          const parsed: Record<string, unknown> = {};
          const result = invalidJsonArgsResult(name);
          repGuard.note(toolSignature(name, parsed), name);
          const toolEnd = Date.now();
          const commit = await commitToolResult(name, parsed, call, result, Math.max(0, toolEnd - toolStart));
          reportSerialReceipt(
            {
              toolCallId: call?.id ?? "",
              name,
              args: parsed,
              result: commit.result,
              isError: commit.isError,
              durationMs: Math.max(0, toolEnd - toolStart),
              committed: commit.committed,
              decision: "invalid-json",
            },
            toolEnd
          );
          continue;
        }
        const parsed = unparsed;
        // Repetition guard (opt-in via maxRepeatedCalls; unset = track-only):
        // a repeated signature skips execution and yields a guidance error;
        // exhausted nudges stop hard.
        const repSig = toolSignature(name, parsed);
        const repNote = repGuard.note(repSig, name);
        if (repNote.intervened) {
          const toolEndRep = Date.now();
          const hasNudge = repGuard.consumeNudge();
          const guarded = `Error: invalid call: ${repetitionFollowUp(repSig, repNote.consecutive)} Fix the approach and retry.`;
          const commit = await commitToolResult(name, parsed, call, guarded, 0);
          reportSerialReceipt(
            {
              toolCallId: call?.id ?? "",
              name,
              args: parsed,
              result: commit.result,
              isError: commit.isError,
              durationMs: 0,
              committed: commit.committed,
              decision: "repetition-guard",
            },
            toolEndRep
          );
          if (hasNudge) continue;
          const stopBase = msg.content ?? "";
          const stopNotice = `${stopBase}${stopBase ? "\n" : ""}${repetitionStopNotice(repSig, repNote.consecutive)}`;
          history.push({ role: "assistant", content: stopNotice });
          try {
            opts?.onPhase?.("done");
          } catch {
            // ignore
          }
          reportPhase("done");
          return stopNotice;
        }
        let outcome: { result: string; args: Record<string, unknown>; decision: PipelineDecisionKind };
        try {
          outcome = await runSerialToolPipeline(call, parsed, opts, execute, recordGoalReport);
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
        const toolEnd = Date.now();
        const commit = await commitToolResult(
          name,
          outcome.args,
          call,
          outcome.result,
          Math.max(0, Date.now() - toolStart)
        );
        reportSerialReceipt(
          {
            toolCallId: call?.id ?? "",
            name,
            args: outcome.args,
            result: commit.result,
            isError: commit.isError,
            durationMs: Math.max(0, toolEnd - toolStart),
            committed: commit.committed,
            decision: outcome.decision,
          },
          toolEnd
        );
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
        // TurnEvents: phase mirror + start per member, in call order, keyed
        // by the stable tool_call_id — never the display label.
        reportPhase("tool", member.call?.function?.name ?? "(unknown)");
        emitTurnEvent(sink, (s) =>
          s.onToolStarted?.({
            toolCallId: member.call?.id ?? "",
            name: member.call?.function?.name ?? "(unknown)",
            index: calls.indexOf(member.call),
          })
        );
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
      // Serial planning pre-pass (in call order, skipping repetition-guarded
      // members exactly as the serial path would): each member plans through
      // the shared planToolCall runner — unknown-name gate, pre-hooks,
      // re-validation, then the approval decision — so rewrites reach the
      // approval prompt, a block skips approval entirely, and prompts still
      // resolve before any member executes (concurrent writes never prompt
      // at once). Cancel between prompts aborts the batch with nothing
      // executed.
      const memberPlans = new Map<number, PreExecutionPlan>();
      const preDecisions = new Map<number, ApprovalDecision>();
      for (let i = 0; i < batch.length; i++) {
        throwIfCancelled(signal);
        if (repNotes[i]!.intervened) continue;
        const member = batch[i]!;
        const memberName = member.call?.function?.name ?? "(unknown)";
        const planned = await planToolCall(memberName, member.parsed, opts);
        memberPlans.set(i, planned.plan);
        if (planned.preDecision !== null) preDecisions.set(i, planned.preDecision);
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
              // Planned members run the shared runner concurrently: inline
              // results (unknown/blocked/invalid/denied) never reach the
              // executor; executions share validate → approve → execute with
              // the serial path by construction. The pre-pass guarantees a
              // plan for every non-guarded member (guarded ones return above).
              const plan = memberPlans.get(index)!;
              const outcome = await runPlannedToolCall(
                member.call,
                plan,
                preDecisions.get(index) ?? null,
                opts,
                execute,
                recordGoalReport
              );
              const memberEnd = Date.now();
              memberDurations[index] = Math.max(0, memberEnd - memberStart);
              reportToolCall({
                step,
                toolCallId: member.call?.id ?? "",
                name: member.call?.function?.name ?? "(unknown)",
                startedAt: telemetryIso(memberStart),
                endedAt: telemetryIso(memberEnd),
                durationMs: Math.max(0, memberEnd - memberStart),
                argsJson: telemetryArgsJson(outcome.args),
                result: outcome.result,
                batchIndex: index,
                batchSize: batch.length,
              });
              return outcome.result;
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
        reportPhase("done");
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
