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
// A thrown execution error (or cancel) aborts the turn exactly as the old
// serial loop did — the caller rolls the partial turn back, so
// assistant/tool pairing stays valid.
//
// Dependency direction: agent/loop -> {tools, tools/read-cache,
// scheduler, config, context-manager, agent/gates, agent/loop-guard,
// agent/normalize, agent/types} and NOT zen (transports stay in
// zen.ts; runAgenticLoopForProvider wraps this loop from there).
import { loadAtomConfig } from "../config.js";
import {
  createContextManager,
  historyCharBudget,
  historyChars,
  historyMessageBudget,
  truncateHistoryWithCaps,
  type TruncateReserve,
  type TruncateResult,
} from "../context-manager.js";
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
  MAX_TOOL_STEPS,
  needsApproval,
  toolNames,
  validateAskQuestionArgs,
  validateToolArgs,
} from "../tools.js";
import { getReadCacheStats } from "../tools/read-cache.js";
import {
  bashExitCode,
  evaluateTurnEnd,
  isCodePath,
  isVerificationCommand,
  openTodoNeedles,
} from "./gates.js";
import {
  errorStreakFollowUp,
  ErrorStreakTracker,
  repetitionFollowUp,
  RepetitionGuard,
  repetitionStopNotice,
} from "./loop-guard.js";
import { normalizeChatResult, normalizeToolResult, toolSignature } from "./normalize.js";
import type { AgenticOpts, ApprovalDecision, ChatMessage, ChatResult, LoopStats, ToolCall } from "./types.js";

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
// Tool-round budget for one agentic turn (env → atom.json → 30).
// A real explore → implement → verify task needs 15–30 tool rounds, so the
// default is 30; an explicit `opts.maxSteps` still wins (tests inject it).
export function toolStepBudget(): number {
  const raw = process.env.ATOM_MAX_TOOL_STEPS;
  if (raw !== undefined) {
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      const n = Number(text);
      if (Number.isFinite(n)) return Math.min(Math.max(Math.floor(n), 5), 100);
    }
  }
  return loadAtomConfig().config.maxToolSteps ?? MAX_TOOL_STEPS;
}
// Legacy trim entry: byte-identical contract (legacy env/config/default caps
// + live todo pinning, same notice, same in-place splice). New code should
// use a ContextManager (derived, window-aware caps); the loop core does when
// it knows the model (see AgenticOpts.context).
export function truncateHistory(
  history: ChatMessage[],
  notify?: (message: string) => void,
  reserve?: TruncateReserve
): TruncateResult {
  return truncateHistoryWithCaps(
    history,
    { maxMessages: historyMessageBudget(), maxChars: historyCharBudget() },
    { notify, reserve, todoNeedles: openTodoNeedles() }
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

// Total tool-call budget per turn (default 200, min 1). Existing suites peak
// near 30 calls/turn, so the default only caps parallel-batch explosions.
export const DEFAULT_MAX_TOTAL_TOOL_CALLS = 200;
export function resolveMaxTotalToolCalls(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_TOTAL_TOOL_CALLS;
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
// Execute one parsed tool call through validation + permission +
// ask_question gates. Model mistakes (unknown name, invalid args) return
// repairs-oriented results WITHOUT executing; cancellations propagate as
// LoopCancelledError (never a result, never retried). Everything else
// returns a result string fed back to the model:
// - ask_question never needs approval; without an askUser hook it resolves
//   to "Error: ask_question has no UI hook".
// - write/edit/bash consult the approve hook when one is provided; a "no"
//   resolves to "Error: denied by user: <tool>" (final, no retry/rollback).
//   Without a hook every tool executes immediately.
async function runOneTool(
  call: ToolCall,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
): Promise<string> {
  const name = call?.function?.name ?? "(unknown)";
  // Unknown tool: model mistake — list actual names, never execute.
  if (!toolNames().includes(name)) {
    return `Error: unknown tool "${name}". Available: ${toolNames().join(", ")}`;
  }
  // Argument validation BEFORE approval/execution: model mistake, never runs.
  const detail = validateToolArgs(name, parsed);
  if (detail) {
    return invalidCall(detail);
  }
  if (name === "ask_question") {
    throwIfCancelled(opts?.signal);
    // If the signal aborts during the modal, runAskQuestion rejects with
    // LoopCancelledError (no result). If it resolves just as the signal
    // aborts, return the result — the loop records it, then stops before
    // the next POST (no new POSTs, pairing stays valid until rollback).
    return runAskQuestion(parsed, opts?.askUser, opts?.signal);
  }
  if (opts?.approve && needsApproval(name)) {
    let decision: ApprovalDecision;
    try {
      decision = await opts.approve(name, parsed);
    } catch (e) {
      // Whole-turn cancellation must propagate (Ctrl+C cancels the turn,
      // not just deny one call). Anything else is a denial.
      if (isCancelError(e) || opts?.signal?.aborted) throw new LoopCancelledError();
      decision = "no";
    }
    // Abort that lands as a resolved denial still cancels the whole turn.
    throwIfCancelled(opts?.signal);
    if (decision === "no") {
      return `Error: denied by user: ${name}`;
    }
    // "once" runs this call; "always" runs it too (the caller caches the
    // always-allowed set session-wide so later calls skip the prompt).
  }
  // No new executions after a cancel: stop after the current tool finishes.
  // The current tool (if already running) is awaited to completion and its
  // result IS recorded — the loop then stops before the next tool/POST, so
  // assistant/tool pairing stays valid until the caller rolls back.
  throwIfCancelled(opts?.signal);
  const timeoutMs = resolveToolTimeoutMs(opts?.toolTimeoutMs);
  const doNormalize = opts?.normalizeResults !== false;
  try {
    const raw = await executeWithTimeout(execute, name, parsed, timeoutMs, opts?.signal);
    if (doNormalize) return normalizeToolResult(raw);
    return typeof raw === "string" ? raw : normalizeToolResult(raw);
  } catch (e) {
    if (isCancelError(e) || opts?.signal?.aborted) throw new LoopCancelledError();
    throw e;
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
  // Verification-gate nag cycles spent (bounds the continue loop alongside
  // the step budget — a model that never verifies still terminates).
  let verifyRounds = 0;
  // At most one truncation notice per turn; silence when nothing dropped.
  let truncationNoticed = false;
  // Window-aware trimmer when the caller knows the model (App passes it);
  // created once per turn — ceiling sources resolve once, history is
  // re-measured every step. Absent → the legacy fixed caps below.
  const contextManager = opts?.context
    ? createContextManager({ model: opts.context.model, toolsChars: opts.context.toolsChars })
    : null;
  // ---- Hardened-loop state (additive; defaults preserve the pinned
  // maxSteps contract — see AgenticOpts docs) ----
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
  let droppedTurnsTotal = 0;
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
        truncationNotices: droppedTurnsTotal,
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
    // pairing can never split. Runs before the budget trim so truncation
    // accounts for the injected message. No-op without the hook.
    try {
      opts?.drainSteer?.();
    } catch {
      // observer errors never break the loop
    }
    // History budget (uniform for all providers — every POST flows through
    // here): trim oldest user-turns first before each send.
      const trimmed = contextManager
        ? contextManager.trimForSend(
            history,
            truncationNoticed
              ? undefined
              : (notice: string) => {
                  try {
                    opts?.onWarning?.(notice);
                  } catch {
                    // ignore observer errors
                  }
                },
            undefined,
            openTodoNeedles()
          )
        : truncateHistory(
            history,
            truncationNoticed
              ? undefined
              : (notice) => {
                  try {
                    opts?.onWarning?.(notice);
                  } catch {
                    // ignore observer errors
                  }
                }
          );
    if (trimmed.droppedTurns > 0) {
      truncationNoticed = true;
      droppedTurnsTotal += trimmed.droppedTurns;
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
      });
      if (outcome.kind === "continue") {
        // Verification-gate continues are bounded per turn (alongside the
        // step budget) so a model that never verifies still terminates.
        if (outcome.via === "verification") verifyRounds += 1;
        history.push({ role: "assistant", content: outcome.assistantText });
        history.push({ role: "user", content: outcome.followUp });
        continue;
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
      history.push({ role: "assistant", content: notice });
      try {
        opts?.onPhase?.("done");
      } catch {
        // ignore
      }
      return notice;
    }
    // Total tool-call budget (parallel-batch explosion guard): counts every
    // tool_call the model emits, mirroring the maxSteps stop contract. The
    // default (200) never binds the pinned suites (~30 calls/turn).
    if (toolCalls + calls.length > maxTotalToolCalls) {
      const base = msg.content ?? "";
      const notice = `${base}${base ? "\n" : ""}(stopped: too many tool calls) (limit is ${maxTotalToolCalls} per turn)`;
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
    const commitToolResult = (
      name: string,
      parsed: Record<string, unknown>,
      call: ToolCall,
      result: string,
      durationMs?: number
    ): void => {
      const isError = typeof result === "string" && result.startsWith("Error");
      toolCalls += 1;
      if (isError) failures += 1;
      errStreak.noteResult(isError);
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
          const exit = bashExitCode(result);
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
      history.push({ role: "tool", tool_call_id: call?.id ?? "", content: result });
      try {
        opts?.onToolActivity?.(describeToolCall(name, parsed), result, isError);
      } catch {
        // ignore observer errors
      }
    };
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
          toolCalls += 1;
          failures += 1;
          errStreak.noteResult(true);
          repGuard.note(toolSignature(name, parsed), name);
          noteBottleneck(name, Date.now() - toolStart);
          history.push({ role: "tool", tool_call_id: call?.id ?? "", content: result });
          try {
            opts?.onToolActivity?.(describeToolCall(name, {}), result, true);
          } catch {
            // ignore observer errors
          }
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
          continue;
        }
        let result: string;
        // Repetition guard (opt-in via maxRepeatedCalls; unset = track-only
        // so the pinned maxSteps contract holds): a repeated signature skips
        // execution and yields a guidance error; exhausted nudges stop hard.
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
            commitToolResult(name, parsed, call, guarded, 0);
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
          commitToolResult(name, parsed, call, guarded, 0);
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
          result = await runOneTool(call, parsed, opts, execute);
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
            argsJson: telemetryArgsJson(parsed),
            result,
            batchIndex: 0,
            batchSize: 1,
          });
        }
        commitToolResult(name, parsed, call, result, Math.max(0, Date.now() - toolStart));
        continue;
      }
      // Parallel batch: every member is pre-validated parallel-safe (see
      // planToolBatches), so runOneTool neither prompts nor blocks here.
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
              const r = await runOneTool(member.call, member.parsed, opts, execute);
              const memberEnd = Date.now();
              memberDurations[index] = Math.max(0, memberEnd - memberStart);
              reportToolCall({
                step,
                toolCallId: member.call?.id ?? "",
                name: member.call?.function?.name ?? "(unknown)",
                startedAt: telemetryIso(memberStart),
                endedAt: telemetryIso(memberEnd),
                durationMs: Math.max(0, memberEnd - memberStart),
                argsJson: telemetryArgsJson(member.parsed),
                result: r,
                batchIndex: index,
                batchSize: batch.length,
              });
              return r;
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
        commitToolResult(
          member.call?.function?.name ?? "(unknown)",
          member.parsed,
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
  } finally {
    finishStats();
  }
}
