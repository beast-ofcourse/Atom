// Agent runtime types: the shared vocabulary of the agentic loop (messages,
// tool calls, results, options, modes). Types only — zero runtime code, so
// any module may import them with no dependency cost and no cycle risk.
// Moved verbatim from src/zen.ts; zen.ts re-exports the stable surface so
// existing importers keep working untouched.
import type { LoopTelemetrySink } from "../telemetry.js";

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
// This client sends `reasoning_effort` only when the session effort is
// non-Default AND the model is in REASONING_EFFORT_SUPPORTED_MODELS.
export type ChatResult = {
  content: string | null;
  tool_calls?: ToolCall[];
  usage?: Usage;
  reasoning?: string;
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
// reasoningEffortParam). "default"/undefined omits the param.
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

export type AgenticOpts = StreamCallbacks &
  EffortOpts & {
  execute?: (name: string, args: Record<string, unknown>) => Promise<string>;
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
  askUser?: (question: string, options: string[], allowCustom?: boolean) => Promise<string>;
  onToolActivity?: (label: string, result: string, isError: boolean) => void;
  maxSteps?: number;
  // Steering seam (message injection without interruption): the loop calls
  // this once per step at the top, after the cancel check and before the
  // budget trim. The App's implementation drains one pending steer message
  // into history + transcript when present, no-op otherwise. Optional and
  // observer-safe (throwing would break the turn, so the App never throws).
  drainSteer?: () => void;
  // Context for window-aware trimming: when the caller knows the model (and
  // the measured tool-schema size), the loop trims via a ContextManager
  // (caps derived from the real window) instead of the legacy fixed caps.
  // Absent → legacy truncateHistory, byte-identical (keeps the loop
  // unit-testable without model metadata).
  context?: { model: string; toolsChars: number };
  // Local observability sink (see src/telemetry.ts): the loop reports one
  // completed-model-call event per chatFn invocation and one completed-tool
  // event per execution (each parallel-batch member timed individually).
  // Observer-only and optional — absent means no reporting and no behavior
  // change. Every hook call is guarded inside the loop, so a throwing sink
  // can never break the turn.
  telemetry?: LoopTelemetrySink;
};

// One approval answer from the approve hook.
export type ApprovalDecision = "once" | "always" | "no";

// Permission modes owned by the App session (status line always shows the mode).
// "plan" is the read-only plan mode (ticket 04): App blocks write/edit/bash
// pre-execution via its approve/execute hooks — the loop core treats it like
// any other mode. Type-only change; no loop/guard/truncation logic touched.
export type PermissionMode = "normal" | "yolo" | "plan";

// Reasoning effort levels (session state in the App, default "default").
// Wire values are exactly default/low/medium/high/max. "default" never
// sends a param (see reasoningEffortParam in zen.ts).
export type ReasoningEffort = "default" | "low" | "medium" | "high" | "max";
