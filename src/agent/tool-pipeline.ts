// One per-call pipeline for the SERIAL tool path: every serial tool call runs
// through hook → validate → approve → execute → post-hook → commit in this
// order, speaking one decision vocabulary and emitting one receipt.
//
// Ordering (the serial driver in ./loop.js calls runSerialToolPipeline, then
// its shared commit funnel, then reports telemetry from the receipt):
//  1. unknown-name gate (registry toolNames() — the intercepted tools are
//     members, so no exemption exists).
//  2. before-hooks (fail CLOSED to blocked; rewrites flow downstream).
//  3. validation of the effective (post-rewrite) args (fail → inline error).
//  4. registry-intercepted stage (validated, never needs approval, resolved
//     without an executor via runInterceptedTool — dispatched by roster
//     lookup, never by name).
//  5. approval via the existing hook as-is (ticket 04 owns the policy).
//  6. execution with timeout + normalization (throw/cancel propagates —
//     never a receipt, never retried).
//  7. post-hooks + result hook inside the commit funnel (fail OPEN to the
//     original result; veto skips the commit).
//
// Decision vocabulary — each shape documented once, here:
// - BeforeOutcome { args, blocked }: pre-hook verdict. `blocked !== null`
//   commits without executing (first block wins, approval skipped).
// - string | null from validateToolArgs: non-null detail = invalid args,
//   committed as an `Error: invalid call: …` result, never executes.
// - ApprovalDecision | null ("once" | "always" | "no" | null): "no" (or a
//   throwing approver) denies without executing; null = no approval applies.
// - string execution result, or a THROWN error (cancel → LoopCancelledError,
//   aborts the turn; anything else aborts the turn too — never a result).
// - AfterOutcome { content, isError }: post-hook patch verdict.
// - ToolResultHookDecision | string | null | void: `content` replaces the
//   result, `isError` overrides the error flag, `veto: true` skips the
//   commit; string replaces content; anything else (or a throw) passes the
//   original through.
// - PipelineDecisionKind: the serial path's terminal label per call.
// - ToolCallReceipt: the single receipt telemetry, history, and the
//   transcript all observe (see the truth choice below).
//
// Receipt truth choice: the receipt carries the EFFECTIVE post-before-hook
// args (what validated, approved, and ran — pre-hook args never executed,
// so measuring them would bill work that never happened) and the FINAL
// post-after-hook result (what history/activity/the model see — measuring
// the pre-patch result would split "what ran" from "what was recorded").
// What the user sees is what got measured.
//
// Parallel batches keep their own pre-pass + ordered commit with pre-commit
// telemetry (ticket 05): the pre-pass plans each member via planToolCall
// above (serially, in call order) and members execute through
// runPlannedToolCall — the same plan/run pair the serial path uses. The
// batch planner, the serial approval pre-pass, and the ordered commit stay
// in ./loop.js untouched, so this module never changes parallel behavior.
//
// Dependency direction: agent/tool-pipeline -> {config, goal, tools,
// tools/intercept, agent/normalize, agent/types} and NOT agent/loop or zen
// (loop.js imports this module; the graph stays acyclic — see
// tests/architecture.test.ts).
import {
  invalidCall,
  isInterceptedTool,
  needsApproval,
  runInterceptedTool,
  toolNames,
  validateToolArgs,
} from "../tools.js";
import {
  afterToolInterceptors,
  applyAfterInterceptors,
  applyBeforeInterceptors,
  beforeToolInterceptors,
  blockedToolResult,
  type AfterOutcome,
  type BeforeOutcome,
} from "../tools/intercept.js";
import { normalizeToolResult } from "./normalize.js";
import { classifyExecutorText, isErrorKind, kindFromDecision } from "./tool-result.js";
import type {
  AgenticOpts,
  ApprovalDecision,
  ToolCall,
  ToolResultHook,
} from "./types.js";

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

// Per-tool outer timeout (ms): undefined → default 60s (enabled); explicit
// <=0/NaN → disabled (direct await, zero overhead). Floor at 1s (sub-second
// timeouts are never useful); no ceiling — the AI decides per-call.
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export function resolveToolTimeoutMs(raw: number | undefined): number | null {
  if (raw === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TOOL_TIMEOUT_MS;
  if (raw <= 0) return null;
  return Math.max(Math.floor(raw), 1000);
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
export async function resolveApproval(
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

// Serial path's terminal label per call (the one decision vocabulary for
// pipeline outcomes — a throw/cancel propagates as an exception instead,
// because nothing was committed and there is no receipt to label).
// "invalid-json", "repetition-guard", and "truncated" short-circuit in the
// serial driver before (or without) the stages below — they live in this
// union so every serial terminal label is documented exactly once, here.
export type PipelineDecisionKind =
  | "unknown-tool"
  | "blocked"
  | "invalid-args"
  | "invalid-json"
  | "repetition-guard"
  | "truncated"
  | "ask-question"
  | "goal-report"
  | "denied"
  | "executed";

export type PipelineOutcome = {
  result: string;
  /** Effective (post-before-hook) args: what validated, approved, and ran. */
  args: Record<string, unknown>;
  decision: PipelineDecisionKind;
  /** Structured kind from the single classification point (tool-result.ts) —
   * consumers read this, never the wording. */
  kind: import("./tool-result.js").ToolResultKind;
};

// The single receipt telemetry, history, and the transcript observe (see
// the truth choice at the top of this file). `committed: false` marks a
// vetoed call: no history, no activity, no sink event — telemetry still
// records the attempt (what was tried), exactly as before.
export type ToolCallReceipt = {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
  committed: boolean;
  decision: PipelineDecisionKind;
  /** Structured kind — telemetry reads this, never the wording. */
  kind: import("./tool-result.js").ToolResultKind;
};

// Shared JSON-arguments parse for the serial driver: malformed arguments
// never reach hooks or executors — the caller routes the null case through
// the commit funnel as an invalid-call error. Returns the parsed record, or
// null when the raw arguments are not a JSON object.
export function parseToolArguments(raw: string | undefined | null): Record<string, unknown> | null {
  try {
    const text = typeof raw === "string" ? raw : "{}";
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// Model-visible result for arguments that are not a JSON object (an
// `Error: invalid call: …` result, committed normally — the turn continues).
export function invalidJsonArgsResult(name: string): string {
  return (
    `Error: invalid call: invalid JSON arguments for tool "${name}" ` +
    `(arguments must be valid JSON). Fix the arguments and retry.`
  );
}

// Extension tool-call interception: global pre/post hooks registered via
// ExtensionAPI.onBeforeToolCall/onAfterToolCall. Both helpers snapshot the
// live handler list and never throw — a throwing before handler fails
// closed (blocked outcome), a throwing after handler fails open (original
// content). Cancellation checks stay where they are; hooks are in-process
// policy, not executions, so they run even when the signal is armed and the
// existing boundaries still stop the turn.
export async function runBeforeIntercept(
  name: string,
  parsed: Record<string, unknown>
): Promise<BeforeOutcome> {
  try {
    return await applyBeforeInterceptors(beforeToolInterceptors(), name, parsed);
  } catch {
    return { args: parsed, blocked: blockedToolResult(name, "(unknown)", "interception failed") };
  }
}

export async function runAfterIntercept(
  name: string,
  parsed: Record<string, unknown>,
  result: string,
  isError: boolean
): Promise<AfterOutcome> {
  try {
    return await applyAfterInterceptors(afterToolInterceptors(), { name, args: parsed, result, isError });
  } catch {
    return { content: result, isError };
  }
}

// After-tool-call result hook (issue 06): the single rewrite seam between
// execution and commit. Absent hook (or null/undefined/void/non-object
// return) → the original result, byte-identical. A string return replaces
// content (error flag kept); an object may replace content, override
// isError, or veto the commit. Hook failures degrade to the original — the
// turn never breaks. The committed receipt carries the rewrite, so
// telemetry, history, and activity all observe it.
export async function applyToolResultHook(
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

// The commit-funnel patch sequence (post-hooks, then the result hook),
// shared by the serial and parallel commits: every committed result passes
// through both, in commit order, so tool_call_id re-pairing and ordering
// are untouched. Never throws (both stages fail open — see above).
// Kind travels with the result: the hook may flip isError, in which case
// the kind is coerced to stay consistent (ok<->failed); otherwise the
// pipeline kind wins and wording is never re-parsed.
export async function applyCommitPatches(
  name: string,
  parsed: Record<string, unknown>,
  result: string,
  isError: boolean,
  hook: ToolResultHook | undefined,
  kind?: import("./tool-result.js").ToolResultKind
): Promise<{ content: string; isError: boolean; veto: boolean; kind: import("./tool-result.js").ToolResultKind }> {
  const after = await runAfterIntercept(name, parsed, result, isError);
  const hooked = await applyToolResultHook(hook, name, parsed, after.content, after.isError);
  let finalKind: import("./tool-result.js").ToolResultKind =
    kind ?? (isError ? "failed" : "ok");
  // The hook may flip isError: coerce the kind so kind stays authoritative.
  if (hooked.isError !== isErrorKind(finalKind)) {
    finalKind = hooked.isError ? "failed" : "ok";
  }
  // After-interceptors only patch content (never isError), so `after`
  // keeps the pipeline kind; the hook above is the only kind-changer.
  return { content: hooked.content, isError: hooked.isError, veto: hooked.veto, kind: finalKind };
}

// Pre-execution plan shared by the serial driver and the parallel pre-pass
// (ticket 05): the unknown-name gate, before-hooks, re-validation, and the
// approval decision resolve here — serially in call order in the parallel
// pre-pass, so prompts never run concurrently. Members then execute the plan
// concurrently through runPlannedToolCall below. One planning
// implementation, one runner: no duplicated parse/gate/hook/approve logic in
// either path.
export type PreExecutionPlan = {
  /** Effective (post-before-hook) args: what validates, approves, executes, and commits. */
  args: Record<string, unknown>;
  /** Non-null when a pre-hook blocked: commit this, execute nothing. */
  blocked: string | null;
  /** Non-null validation detail for the effective args: inline error, never runs. */
  invalid: string | null;
  /** Non-null when the name is unknown: inline error, never runs. */
  unknown: string | null;
};

// Model-visible result for an unknown tool name (an `Error: unknown tool:
// … Available: …` result, committed normally — the turn continues).
export function unknownToolResult(name: string): string {
  return `Error: unknown tool "${name}". Available: ${toolNames().join(", ")}`;
}

export async function planToolCall(
  name: string,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined
): Promise<{ plan: PreExecutionPlan; preDecision: ApprovalDecision | null }> {
  // Unknown-name gate: the registry's toolNames() is the single source — it
  // already includes the intercepted tools, so no exemption is needed.
  if (!toolNames().includes(name)) {
    return {
      plan: { args: parsed, blocked: null, invalid: null, unknown: unknownToolResult(name) },
      preDecision: null,
    };
  }
  const pre = await runBeforeIntercept(name, parsed);
  if (pre.blocked !== null) {
    return {
      plan: { args: pre.args, blocked: pre.blocked, invalid: null, unknown: null },
      preDecision: null,
    };
  }
  const invalid = validateToolArgs(name, pre.args);
  if (invalid) {
    return {
      plan: { args: pre.args, blocked: null, invalid, unknown: null },
      preDecision: null,
    };
  }
  const preDecision = await resolveApproval(name, pre.args, opts);
  return {
    plan: { args: pre.args, blocked: null, invalid: null, unknown: null },
    preDecision,
  };
}

// The ONE per-call runner: a planned call either yields its inline result
// (unknown/blocked/invalid — never executes; denial resolves inside the
// shared stages via the pre-decision) or executes through the shared
// validate → intercepted → approve-or-preDecision → execute stages. Serial
// calls plan+run inline; parallel members plan serially in the pre-pass,
// then run here concurrently.
export async function runPlannedToolCall(
  call: ToolCall,
  plan: PreExecutionPlan,
  preDecision: ApprovalDecision | null,
  opts: AgenticOpts | undefined,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  onUpdateGoal?: (parsed: Record<string, unknown>) => string
): Promise<PipelineOutcome> {
  if (plan.unknown !== null) {
    return { result: plan.unknown, args: plan.args, decision: "unknown-tool", kind: "unknown-tool" };
  }
  if (plan.blocked !== null) {
    return { result: plan.blocked, args: plan.args, decision: "blocked", kind: "denied" };
  }
  if (plan.invalid !== null) {
    return { result: invalidCall(plan.invalid), args: plan.args, decision: "invalid-args", kind: "invalid-args" };
  }
  return runStagesWithDecision(call, plan.args, opts, execute, preDecision, onUpdateGoal);
}

// Inner execution after pre-interception: the plan already validated the
// post-hook args (planToolCall is the single validation gate — see above),
// so this stage trusts plan.args and never re-validates the same object.
// Kept for import compatibility; new code prefers planToolCall +
// runPlannedToolCall.
export async function runOneToolWithArgs(
  call: ToolCall,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  preDecision?: ApprovalDecision | null,
  onUpdateGoal?: (parsed: Record<string, unknown>) => string
): Promise<{ result: string; args: Record<string, unknown>; kind: import("./tool-result.js").ToolResultKind }> {
  // Compat entry skips the planner, so it validates here exactly once —
  // the same gate the planner applies, same invalid-args outcome.
  const compatName = call?.function?.name ?? "(unknown)";
  const compatDetail = validateToolArgs(compatName, parsed);
  if (compatDetail) {
    return { result: invalidCall(compatDetail), args: parsed, kind: "invalid-args" };
  }
  const outcome = await runStagesWithDecision(call, parsed, opts, execute, preDecision, onUpdateGoal);
  return { result: outcome.result, args: outcome.args, kind: outcome.kind };
}

async function runStagesWithDecision(
  call: ToolCall,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  preDecision?: ApprovalDecision | null,
  onUpdateGoal?: (parsed: Record<string, unknown>) => string
): Promise<PipelineOutcome> {
  const name = call?.function?.name ?? "(unknown)";
  // No validation here by design: every entry (serial runSerialToolPipeline,
  // parallel pre-pass) plans via planToolCall first, which validated these
  // exact post-hook args. The old pre-execution re-validation of the same
  // object is removed (was: scheduler → plan → stages = 3 validations).
  // Intercepted tools (ask_question/update_goal): validated by the plan,
  // never need approval, resolved without an executor. Dispatched by
  // registry roster lookup — never by name — so visibility and
  // executability stay one list.
  if (isInterceptedTool(name)) {
    throwIfCancelled(opts?.signal);
    // If the signal aborts during the modal, the runner rethrows raw and the
    // mapping below raises LoopCancelledError (no result). If it resolves
    // just as the signal aborts, return the result — the loop records it,
    // then stops before the next POST (no new POSTs, pairing stays valid
    // until rollback).
    try {
      const resolved = await runInterceptedTool(name, parsed, {
        askUser: opts?.askUser,
        signal: opts?.signal,
        onUpdateGoal,
      });
      // Non-null by roster contract (isInterceptedTool just matched); the
      // fallthrough keeps this total if the roster ever drifts — the call
      // then flows into approval/execution like any other known tool.
      if (resolved !== null) {
        return { result: resolved.result, args: parsed, decision: resolved.decision, kind: kindFromDecision(resolved.decision, resolved.result) };
      }
    } catch (e) {
      if (isCancelError(e) || opts?.signal?.aborted) throw new LoopCancelledError();
      throw e;
    }
  }
  const decision = preDecision ?? (await resolveApproval(name, parsed, opts));
  if (decision === "no") {
    return { result: `Error: denied by user: ${name}`, args: parsed, decision: "denied", kind: "denied" };
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
    const text = doNormalize ? normalizeToolResult(raw) : typeof raw === "string" ? raw : normalizeToolResult(raw);
    return { result: text, args: parsed, decision: "executed", kind: classifyExecutorText(text) };
  } catch (e) {
    if (isCancelError(e) || opts?.signal?.aborted) throw new LoopCancelledError();
    throw e;
  }
}

// The ONE serial per-call pipeline: unknown-name gate → before-hooks →
// validate → approve → execute (stages 1–6 above), returning the execution
// result with the effective args and the terminal decision. Post-hooks and
// the commit run in the shared commit funnel (via applyCommitPatches), so
// the serial and parallel commits patch identically; the serial driver
// reports telemetry from the funnel's receipt, unifying all three observers.
// Hook-vs-approval ordering: pre-hooks run BEFORE validation and approval.
// The hook sees the call pre-approval and may rewrite args before the
// approval prompt shows them; a block short-circuits approval entirely (no
// prompt for a call that never runs). Rewrites always re-validate before
// execution, so a hook can never smuggle unvalidated args into an executor.
// Unknown names never reach hooks (model mistake — nothing would run).
// Registry-intercepted tools (ask_question/update_goal) pass the gate like
// any known tool: the stages below validate them and resolve them without
// an executor (never needs approval). ask_question never needs approval;
// without an askUser hook it resolves to "Error: ask_question has no UI
// hook". update_goal never needs approval either; without the per-turn
// recorder it resolves to the outside-turn error. Model mistakes (unknown
// name, invalid args) return repair-oriented results WITHOUT executing;
// cancellations propagate as LoopCancelledError (never a result, never
// retried).
export async function runSerialToolPipeline(
  call: ToolCall,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  onUpdateGoal?: (parsed: Record<string, unknown>) => string
): Promise<PipelineOutcome> {
  const name = call?.function?.name ?? "(unknown)";
  const { plan, preDecision } = await planToolCall(name, parsed, opts);
  return runPlannedToolCall(call, plan, preDecision, opts, execute, onUpdateGoal);
}
