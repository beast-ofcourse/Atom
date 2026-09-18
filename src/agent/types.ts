// Agent runtime types: the shared vocabulary of the agentic loop (messages,
// tool calls, results, options, modes). Types only — zero runtime code, so
// any module may import them with no dependency cost and no cycle risk.
// Moved verbatim from src/zen.ts; zen.ts re-exports the stable surface so
// existing importers keep working untouched.
import type { LoopTelemetrySink } from "../telemetry.js";
import type { GoalJudgeRunner } from "./goal-evaluator.js";
import type { TurnEventsSink } from "./turn-events.js";
import type { GoalToolVisibility } from "../goal.js";

export type Role = "system" | "user" | "assistant" | "tool";
export type ToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content?: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// Token usage as reported by the chat-completions API
// (`usage: {prompt_tokens, completion_tokens, total_tokens}`). Only values
// actually present in a response are kept — nothing is estimated.
// `cacheReadTokens` / `cacheWriteTokens` carry provider-reported prefix-cache
// counters when the API sends them (Anthropic cache_read/_creation, OpenAI
// prompt_tokens_details.cached_tokens, DeepSeek prompt_cache_hit_tokens,
// Gemini cachedContentTokenCount). Absent fields mean "not reported" —
// instrumentation must never present them as zero/miss claims.
export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

// One assistant message plus the honest metadata the API attached to it.
// `usage` is present only when the response carried a usage payload;
// `reasoning` is present only when the response carried reasoning metadata.
// `truncated` is true only when the provider flagged the response as cut off
// by the output limit (OpenAI-chat `finish_reason: "length"`): the tool calls
// it carries have incomplete arguments and must fail inline (the loop turns
// each into a repair-oriented error result and continues) instead of
// executing. Transport failures (HTTP/network/empty/stalled streams) never
// set this — they keep aborting the turn.
// This client sends `reasoning_effort` (OpenAI-chat kind, every provider)
// or the native thinking equivalent (Anthropic `thinking`, Gemini
// `thinkingConfig.thinkingLevel`) whenever the session effort is non-Auto.
// Auto/undefined omits the knob entirely. A model that truly lacks the knob
// is detected at POST time: a 400 naming the effort param retries once
// without it (see isEffortRejection in adapters.ts).
export type ChatResult = {
  content: string | null;
  tool_calls?: ToolCall[];
  usage?: Usage;
  reasoning?: string;
  truncated?: boolean;
};

export type Phase = "thinking" | "streaming" | "tool" | "retry" | "done";

export type StreamCallbacks = {
  onToken?: (partialText: string) => void;
  onPhase?: (phase: Phase, detail?: string) => void;
  // Fired as soon as a streamed tool_call delta reveals its function name,
  // i.e. before the full call has arrived and execution starts.
  onToolDelta?: (name: string, index: number) => void;
  // Thinking channel: fired with the accumulated reasoning text every time
  // a delta carries more of it (DeepSeek-style `reasoning_content`; some
  // gateways use a string `reasoning` field). NEVER mixed into the answer
  // text — the TUI renders it in a separate dim block. Models that omit
  // thinking simply never fire it.
  onThinking?: (partialThinking: string) => void;
  // Fired for nameless partial tool calls dropped at [DONE].
  onWarning?: (message: string) => void;
  // Injectable delay for retry backoff (defaults to setTimeout). Tests
  // inject an instant recorder so the suite never sleeps.
  sleep?: (ms: number) => Promise<void>;
  // Cooperative cancellation for the whole turn (Ctrl+C in the App, an
  // AbortController in tests). Checked before each POST and each tool so a
  // cancel stops after the current tool finishes: no new POSTs, no new
  // executions. Fetch POSTs also wire it to abort the in-flight request.
  signal?: AbortSignal | null;
};

// Session reasoning effort carried on every chat POST (gated per POST by
// reasoningEffortParam). "auto"/undefined omits the param ("default" is a
// legacy alias for "auto", normalized on load).
export type EffortOpts = {
  reasoningEffort?: string;
};

// Summary/compaction POST options: tools disabled (no `tools` key sent)
// and output capped (max_tokens/maxOutputTokens per kind). Used ONLY by
// the compaction path (src/compact.ts); the normal agentic loop never sets
// these, so its wire behavior is unchanged.
export type SummaryOpts = {
  disableTools?: boolean;
  maxOutputTokens?: number;
};

// Per-POST goal-tool visibility (Phase 3: per-tool struct instead of the
// old update_goal-only boolean). The runAgenticLoop* entry points derive it
// per POST from opts.goal (live state) plus /goal intent in the history.
// Undefined/true keep the legacy full surface so compaction callers and
// tests that never set it stay byte-identical; false hides every goal tool;
// the loop path always sets an explicit struct. Boolean stays accepted so
// existing direct callers keep typechecking.
export type GoalToolOpts = {
  includeUpdateGoal?: boolean | GoalToolVisibility;
};

// After-tool-call result hook (issue 06): input carries what the loop
// committed before this seam existed — tool name, parsed args (treat as
// read-only), the execution result string, and its error state.
export type ToolResultHookInput = {
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
};

// What a hook may decide: omit everything (or return null/undefined/a
// non-object) for passthrough; `content` replaces the result string;
// `isError` overrides the error flag used for failure accounting, gates,
// and activity; `veto: true` skips the commit entirely (no history push, no
// activity, no gate/counter updates for that call).
export type ToolResultHookDecision = {
  content?: string;
  isError?: boolean;
  veto?: boolean;
};

// Sync or async. A plain string return replaces content (error flag kept).
// Throwing (or rejecting) degrades to the original result — never breaks
// the turn.
export type ToolResultHook = (
  input: ToolResultHookInput
) =>
  | ToolResultHookDecision
  | string
  | null
  | undefined
  | void
  | Promise<ToolResultHookDecision | string | null | undefined | void>;

// Goal auto-continue hook (ticket 02): the loop reads the live goal through
// getGoal — it never imports App state — and reports goal-slice activity
// through the counters. All fields are observer-safe (the loop guards every
// call, so a throwing hook can never break the turn). Absent → today's
// behavior byte-identical (every existing test runs with no goal).
export type GoalSnapshot = { objective: string; active: boolean };

export type GoalHook = {
  // Live read; null (cleared) or inactive (paused) → the loop ends the
  // turn normally instead of continuing. Called per POST and per turn-end.
  getGoal: () => GoalSnapshot | null;
  // Pause with a user-visible notice: flips active, preserves the objective
  // and stats (never clears). The loop calls it on cancel and on spent
  // budgets; failed POSTs skip it so the goal stays active and carries on.
  pauseGoal: (notice: string) => void;
  // One completed model POST observed while the goal was live.
  onGoalRequest?: () => void;
  // One turn-end reached during a goal-engaged run (continuations + 1).
  onGoalTurn?: () => void;
};

export type AgenticOpts = StreamCallbacks &
  EffortOpts & {
  execute?: (name: string, args: Record<string, unknown>) => Promise<string>;
  // Goal auto-continue seam (ticket 02): live accessor plus pause/counters
  // (see GoalHook). Optional — the loop runs unchanged without it.
  goal?: GoalHook;
  // Evaluator fallback (ticket 04): the judge for report-less goal turns.
  // The loop calls it at most once per report-less turn end with the goal
  // text plus the recent transcript tail (read-only — never mutated, never
  // committed). A clear verdict flows through the model-report path;
  // null/throw pauses instead of looping. Optional — without it a
  // report-less turn continues exactly as before (existing tests pin this).
  goalJudge?: GoalJudgeRunner;
  // Fired once per chat POST that reports token usage, so the caller can
  // accumulate session totals from real API data only.
  onUsage?: (usage: Usage) => void;
  // Fired once per chat POST whose response carries reasoning metadata.
  onReasoning?: (reasoning: string) => void;
  // Permission gate for write/edit/bash in `normal` mode. The App implements
  // it with an interactive Ink prompt ([y]es once / [a]lways / [n]o) backed
  // by a session-wide always-allowed set; tests inject fakes. When absent,
  // every tool executes immediately (today's yolo behavior), which keeps the
  // loop unit-testable without UI.
  approve?: (name: string, args: Record<string, unknown>) => Promise<ApprovalDecision>;
  // Interactive ask_question handler (modal select in the App). When absent,
  // ask_question calls resolve to an error string — never throw, never hang.
  // Queue contract: the pipeline calls this sequentially (FIFO, one at a
  // time) — even parallel-emitted ask_question calls serialize — so the TUI
  // shows questions one-by-one with Q i/N progress. Batch calls loop here
  // per item in order; Esc cancels the current item only.
  askUser?: (question: string, options: string[], allowCustom?: boolean, meta?: { index: number; total: number }) => Promise<string>;
  onToolActivity?: (label: string, result: string, isError: boolean) => void;
  // After-tool-call result hook (issue 06): the sanctioned seam for
  // observing/rewriting tool results between execution and commit. The loop
  // calls it inside the commit funnel with the tool name, parsed args,
  // result string, and error state; the hook may replace content, flip the
  // error flag, or veto the commit. Absent (or returning null/undefined) →
  // byte-identical passthrough. Throwing degrades to the original result.
  // Executors are untouched — policy lives only in this seam.
  onToolResult?: ToolResultHook;
  maxSteps?: number;
  // Steering seam (message injection without interruption): the loop calls
  // this once per step at the top, after the cancel check. The App's
  // implementation drains one pending steer message into history +
  // transcript when present, no-op otherwise. Optional and observer-safe
  // (throwing would break the turn, so the App never throws).
  drainSteer?: () => void;
  // Local observability sink (see src/telemetry.ts): the loop reports one
  // completed-model-call event per chatFn invocation and one completed-tool
  // event per execution (each parallel-batch member timed individually).
  // Observer-only and optional — absent means no reporting and no behavior
  // change. Every hook call is guarded inside the loop, so a throwing sink
  // can never break the turn.
  telemetry?: LoopTelemetrySink;
  // Ordered turn-event sink (see src/agent/turn-events.ts): the loop reports
  // every turn event (streamed tokens, thinking, phase changes, tool started/
  // finished with stable toolCallId + name) here IN ADDITION to the existing
  // callbacks above, which keep working byte-identically. Observer-only and
  // optional — absent means no reporting and no behavior change. Every sink
  // call is guarded inside the loop, so a throwing sink can never break the
  // turn. Identities are stable strings, never display-label text.
  turnEvents?: TurnEventsSink;
  // Per-tool execution timeout (ms) as an outer guard around `execute`.
  // Transport POSTs keep their own retry policy; tool executors keep their
  // own timeouts (bash/webfetch). When the timeout fires first the call
  // resolves to an `Error: ... timed out ...` result (never throws), so the
  // model sees it and adapts. Cancellation still throws LoopCancelledError.
  // Undefined/NaN → default 60s (enabled); explicit <=0 disables (direct
  // await, zero overhead). Enabled values clamp 1s–120s.
  toolTimeoutMs?: number;
  // Repetition-guard threshold: max consecutive identical tool calls
  // (same name + stable-args signature) allowed before the loop intervenes
  // with a guidance follow-up (bounded, then a stop notice). Undefined =
  // track-only (repetitionHits still reported in LoopStats, no intervention).
  // Minimum 2 when set. See src/agent/loop-guard.ts.
  maxRepeatedCalls?: number;
  // Total tool-call budget per turn (across all steps/batches). Uncapped by
  // default; an explicit value stops the turn with a
  // `(stopped: too many tool calls)` notice. Minimum 1 when set.
  maxTotalToolCalls?: number;
  // Error-streak recovery: when the model attempts final text after this many
  // consecutive `Error:` tool results, the loop nudges once per streak
  // (bounded per turn) instead of ending on unaddressed failures. Default 3,
  // 0/undefined disables. Single errors still end normally (the model may be
  // reporting a blocker) — only sustained unaddressed failure continues.
  maxConsecutiveErrors?: number;
  // Result normalization (default true): coerce non-string tool results via
  // JSON, cap oversized results for history with an explicit truncation note.
  // Executors already cap (read 64KB, bash 8KB); this is the safety net for
  // custom executors. False passes results through untouched.
  normalizeResults?: boolean;
  // Loop instrumentation hook: fired once per turn with the measured summary
  // (success, stop, failure, or cancel). Guarded — throwing never breaks the
  // turn. Telemetry sinks keep receiving per-call events; this is the
  // turn-level rollup (iterations, cache hits, failures, bottlenecks).
  onLoopStats?: (stats: LoopStats) => void;
};

// One approval answer from the approve hook.
export type ApprovalDecision = "once" | "always" | "no";

// Loop-level instrumentation summary reported once per turn (see
// AgenticOpts.onLoopStats). Every field is measured, never estimated:
// steps = tool-round iterations run, modelCalls/toolCalls = completed calls,
// failures = tool results starting with "Error" plus thrown executions,
// repetitionHits = times the repetition guard fired, cacheHits = read-cache
// hits served without disk I/O, durationMs = wall time for the whole turn,
// bottleneck = the slowest single tool execution observed (null when no
// tools ran; kept for dashboard compat), slowestModel = slowest single model
// POST observed, modelTotalMs/toolTotalMs = summed time per phase,
// dominantPhase = which phase owned the turn, truncationNotices = length/
// stall truncation events observed, contextGrowthChars = history chars added
// during the turn (end - start). Absent/zero means "none observed".
export type LoopStats = {
  steps: number;
  modelCalls: number;
  toolCalls: number;
  failures: number;
  repetitionHits: number;
  cacheHits: number;
  durationMs: number;
  bottleneck: { name: string; durationMs: number } | null;
  contextGrowthChars: number;
  slowestModel?: { id: string; durationMs: number } | null;
  modelTotalMs?: number;
  toolTotalMs?: number;
  dominantPhase?: "model" | "tool";
  truncationNotices?: number;
};

// Permission modes owned by the App session (status line always shows the mode).
// "plan" is the read-only plan mode (ticket 04): App blocks write/edit/bash
// pre-execution via its approve/execute hooks — the loop core treats it like
// any other mode. Type-only change; no loop/guard/truncation logic touched.
export type PermissionMode = "normal" | "yolo" | "plan";

// Reasoning effort levels (session state in the App, default "auto").
// Wire values are low/medium/high/max. "auto" never sends a param (see
// reasoningEffortParam in zen.ts); "default" is the pre-auto name for the
// same level, accepted on load and normalized to "auto".
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "max";
