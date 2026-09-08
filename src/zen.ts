// Minimal OpenCode Zen provider logic (carried over from chat.mjs).
// Scope: chat/completions-family models ONLY (DeepSeek, Kimi, GLM, MiniMax,
// Big Pickle, free chat models). Responses-family (/responses: GPT/Grok/Muse
// Spark), Messages-family (/messages: Claude/Qwen), and Gemini paths use
// different Zen request shapes and are out of scope.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  MAX_TOOL_STEPS,
  TOOL_DEFINITIONS,
  describeToolCall,
  executeTool,
  invalidCall,
  needsApproval,
  toolNames,
  validateAskQuestionArgs,
  validateToolArgs,
} from "./tools.js";
import {
  chatEndpointFor,
  getProvider,
  modelsUrlForProvider,
  providerLabel,
  type ProviderId,
} from "./providers.js";
import {
  ANTHROPIC_VERSION,
  anthropicHeaders,
  buildAnthropicBody,
  buildGeminiBody,
  geminiChatUrl,
  geminiGenerateUrl,
  geminiHeaders,
  parseAnthropicJson,
  parseAnthropicModelsList,
  parseGeminiJson,
  parseGeminiModelsList,
  parseOpenAIModelsList,
  readAnthropicSSEMessage,
  readGeminiSSEMessage,
} from "./adapters.js";
import { SYSTEM_PROMPT } from "./system.js";

export { MAX_TOOL_STEPS };
// Re-exported so existing `SYSTEM_PROMPT` imports keep working; the
// owner-editable source of truth lives in src/system.ts.
export { SYSTEM_PROMPT };

export const DEFAULT_ENDPOINT =
  "https://opencode.ai/zen/v1/chat/completions";
export const MODELS_URL_DEFAULT = "https://opencode.ai/zen/v1/models";
export const DEFAULT_MODEL = "big-pickle";
export const AGENTS_CHAR_CAP = 12 * 1024;

// ---- Conversation-history budget (deterministic, no extra model calls) ----
// Long sessions can't bloat context, cost, and latency: the shared loop core
// trims history to BOTH caps before every POST (uniform across providers).
// Optional env overrides (invalid/unset → defaults):
// - ATOM_MAX_HISTORY_MESSAGES, clamped to 10–1000 (default 100)
// - ATOM_MAX_HISTORY_CHARS, clamped to 10_000–2_000_000 (default 200_000)
export const MAX_HISTORY_MESSAGES = 100;
export const MAX_HISTORY_CHARS = 200_000;

function clampEnvInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

// Message-count cap for history (env override clamped 10–1000).
export function historyMessageBudget(): number {
  return clampEnvInt(process.env.ATOM_MAX_HISTORY_MESSAGES, 10, 1000, MAX_HISTORY_MESSAGES);
}

// Total-chars cap for history (env override clamped 10_000–2_000_000).
export function historyCharBudget(): number {
  return clampEnvInt(process.env.ATOM_MAX_HISTORY_CHARS, 10_000, 2_000_000, MAX_HISTORY_CHARS);
}

// Reasoning effort (session state in the App, default "default").
// Wire values are exactly default/low/medium/high/max. "default" never
// sends a param. NOTE: the user asked for `xhigh`, but the only VERIFIED
// valid values (OpenCode Zen docs/changelog: Thinking Effort
// Default/Max/High/Medium/Low, sent as `reasoning_effort`) use `Max`, so
// the top setting is `Max`, sent on the wire as `max`.
export type ReasoningEffort = "default" | "low" | "medium" | "high" | "max";
export const EFFORT_OPTIONS: ReasoningEffort[] = [
  "default",
  "low",
  "medium",
  "high",
  "max",
];

// Verified-support set for `reasoning_effort`: the chat/completions-family
// models Zen documents Thinking Effort for. Any other model omits the
// param (setting kept, warning shown, status shows "(unsupported)").
export const REASONING_EFFORT_SUPPORTED_MODELS: ReadonlySet<string> = new Set([
  "kimi-k2.5",
  "kimi-k2.6",
  "glm-5.1",
  "glm-5.2",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]);

export function isEffortSupported(model: string): boolean {
  return REASONING_EFFORT_SUPPORTED_MODELS.has(model);
}

// Wire value for the POST body, or undefined when the param must be
// omitted (Default, unsupported model, or unknown effort string).
export function reasoningEffortParam(
  effort: string | undefined,
  model: string
): string | undefined {
  if (!effort || effort === "default") return undefined;
  if (!isEffortSupported(model)) return undefined;
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") {
    return effort;
  }
  return undefined;
}

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
export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
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
  let total = 0;
  for (const m of history) total += messageChars(m);
  return total;
}

export type TruncateReserve = { messages?: number; chars?: number };
export type TruncateResult = { droppedTurns: number; droppedMessages: number };

// Drop oldest user-turns until history fits BOTH budget caps (message count
// AND total chars, each plus the caller's `reserve` headroom for a message
// it is about to push). A user turn = the `user` message plus all following
// messages up to (excluding) the next `user` message, so assistant
// tool_calls always stay paired with their tool results across all three
// wire formats. NEVER drops history[0] (system prompt) and NEVER drops the
// latest turn (the one being sent/built), even if it alone exceeds a cap —
// an over-budget turn is still sent. Mutates `history` in place via splice
// (so caller indices captured after this call stay valid) and, when at
// least one turn dropped, fires ONE `notify` (the caller surfaces it dim in
// the TUI); silence otherwise. Returns what was dropped.
export function truncateHistory(
  history: ChatMessage[],
  notify?: (message: string) => void,
  reserve?: TruncateReserve
): TruncateResult {
  const result: TruncateResult = { droppedTurns: 0, droppedMessages: 0 };
  if (history.length <= 1) return result;
  const maxMessages = historyMessageBudget();
  const maxChars = historyCharBudget();
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
    // Oldest droppable turn starts at 1 (never 0/system) and ends at the
    // next `user` message. When no later `user` exists, only the latest
    // turn remains — stop, it is never dropped.
    let end = history.length;
    for (let i = 2; i < history.length; i++) {
      if (history[i]?.role === "user") {
        end = i;
        break;
      }
    }
    if (end >= history.length) break;
    const removed = history.splice(1, end - 1);
    result.droppedTurns += 1;
    result.droppedMessages += removed.length;
  }
  if (result.droppedTurns > 0) {
    try {
      notify?.(`(history truncated: dropped ${result.droppedTurns} oldest turn(s))`);
    } catch {
      // observer errors never break the loop
    }
  }
  return result;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

// Extract only the token counts the API actually reported. Returns
// undefined when the payload carries no usable usage numbers.
export function parseUsage(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const out: Usage = {};
  const prompt = finiteCount(o["prompt_tokens"]);
  if (prompt !== undefined) out.prompt_tokens = prompt;
  const completion = finiteCount(o["completion_tokens"]);
  if (completion !== undefined) out.completion_tokens = completion;
  const total = finiteCount(o["total_tokens"]);
  if (total !== undefined) out.total_tokens = total;
  return out.prompt_tokens !== undefined ||
    out.completion_tokens !== undefined ||
    out.total_tokens !== undefined
    ? out
    : undefined;
}

// Extract a one-short-segment reasoning label from response metadata the
// API actually sent (e.g. a reasoning-effort value). A non-empty
// reasoning_content blob (DeepSeek-style thinking text) is reported as the
// label "present" rather than inlined. Returns undefined when the payload
// carries no reasoning metadata.
export function parseReasoningLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return undefined;
    return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  for (const key of ["reasoning_effort", "reasoningEffort", "effort"]) {
    const hit = parseReasoningLabel(o[key]);
    if (hit !== undefined) return hit;
  }
  if (o["reasoning"] !== undefined) {
    const hit = parseReasoningLabel(o["reasoning"]);
    if (hit !== undefined) return hit;
  }
  const content = o["reasoning_content"];
  if (typeof content === "string" && content.trim().length > 0) return "present";
  return undefined;
}

// Live execution phases surfaced to the TUI via onPhase. `detail` carries
// the tool name for "tool" and a retry summary (attempt/delay/status) for
// "retry"; it is empty for the other phases.
export type Phase = "thinking" | "streaming" | "tool" | "retry" | "done";

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

function throwIfCancelled(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new LoopCancelledError();
}

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
};

// One approval answer from the approve hook.
export type ApprovalDecision = "once" | "always" | "no";

// Permission modes owned by the App session (status line always shows the mode).
export type PermissionMode = "normal" | "yolo";

export const MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_AFTER_CAP_MS = 30_000;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff 1s -> 2s, honoring Retry-After (seconds or HTTP date)
// capped at 30s. `attempt` is the 0-based index of the failure just seen
// (0 => first failure => 1s).
export function getRetryDelay(attempt: number, res?: Response): number {
  try {
    const raw = (res as unknown as { headers?: { get?: (k: string) => string | null } })
      ?.headers?.get?.("Retry-After");
    if (typeof raw === "string" && raw.trim().length > 0) {
      const s = raw.trim();
      const secs = Number(s);
      if (Number.isFinite(secs) && !Number.isNaN(secs) && secs >= 0) {
        return Math.min(Math.max(secs * 1000, 0), RETRY_AFTER_CAP_MS);
      }
      const when = Date.parse(s);
      if (!Number.isNaN(when)) {
        const diff = when - Date.now();
        if (diff > 0) return Math.min(diff, RETRY_AFTER_CAP_MS);
        return 0;
      }
    }
  } catch {
    // fall through to backoff
  }
  return attempt === 0 ? 1000 : 2000;
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    const t = await (res as unknown as { text?: () => Promise<string> }).text?.();
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

function hasStreamBody(res: Response): boolean {
  try {
    return (res as unknown as { body?: unknown }).body != null;
  } catch {
    return false;
  }
}

// Curated chat/completions-compatible models, verified from
// https://opencode.ai/docs/zen. Used when the live model list cannot be
// fetched or cannot confirm compatibility (network/auth/429/shape issues).
export const FALLBACK_MODELS: string[] = [
  "big-pickle",
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
  "glm-5.1",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
];

export function endpointConfig(): {
  endpoint: string;
  apiKey: string;
  model: string;
} {
  return {
    endpoint: process.env.OPENCODE_ZEN_ENDPOINT ?? DEFAULT_ENDPOINT,
    apiKey: process.env.OPENCODE_ZEN_API_KEY ?? "",
    model: process.env.OPENCODE_ZEN_MODEL ?? DEFAULT_MODEL,
  };
}

// Derive the models URL from a (possibly custom) chat/completions endpoint.
export function modelsUrl(endpoint: string): string {
  const suffix = "/chat/completions";
  if (endpoint.endsWith(suffix)) {
    return endpoint.slice(0, -suffix.length) + "/models";
  }
  return MODELS_URL_DEFAULT;
}

// An entry is chat/completions-compatible when its metadata says so.
// Returns null when the entry carries no usable compatibility metadata.
function compatibilityHint(entry: unknown): boolean | null {
  if (typeof entry === "string") return null;
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const hint = ["family", "type", "api", "endpoint", "path"]
    .map((k) => e[k])
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (!hint) return null;
  if (hint.includes("chat") || hint.includes("completions")) return true;
  if (hint.includes("responses") || hint.includes("messages")) return false;
  return null;
}

function entryId(entry: unknown): string | null {
  if (typeof entry === "string") return entry || null;
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const id = e["id"] ?? e["name"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

// Try the live model list; ANY failure falls back to FALLBACK_MODELS.
// When entries carry no compatibility metadata we only trust live ids that
// are already in the curated compatible set, so the dropdown can never
// offer a Responses/Messages/Gemini-family model.
// WithStatus variant reports whether the live list was used (ok:true) or
// the curated fallback was returned (ok:false) so callers can cache only
// successful lists. fetchModels stays byte-identical (returns models only).
export type ModelsFetchStatus = { models: string[]; ok: boolean };

export async function fetchModelsWithStatus(
  endpoint: string,
  apiKey: string
): Promise<ModelsFetchStatus> {
  try {
    const res = await fetch(modelsUrl(endpoint), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { models: [...FALLBACK_MODELS], ok: false };
    const data: unknown = await res.json();
    const entries: unknown = Array.isArray(data)
      ? data
      : (data as { data?: unknown })?.data;
    if (!Array.isArray(entries) || entries.length === 0) {
      return { models: [...FALLBACK_MODELS], ok: false };
    }
    const known = new Set(FALLBACK_MODELS);
    const picked: string[] = [];
    for (const entry of entries) {
      const id = entryId(entry);
      if (!id) continue;
      const hint = compatibilityHint(entry);
      if (hint === false) continue; // known-incompatible family
      if (hint === true) {
        picked.push(id);
      } else if (known.has(id)) {
        picked.push(id); // live-confirmed, curated-compatible
      }
    }
    if (picked.length > 0) return { models: picked, ok: true };
    return { models: [...FALLBACK_MODELS], ok: false };
  } catch {
    return { models: [...FALLBACK_MODELS], ok: false };
  }
}

export async function fetchModels(
  endpoint: string,
  apiKey: string
): Promise<string[]> {
  const r = await fetchModelsWithStatus(endpoint, apiKey);
  return r.models;
}

// Parse one SSE event stream from a chat-completions response body.
// Contract (OpenAI-compatible streaming):
// - The byte stream is split into lines across chunk boundaries (partials
//   are buffered until "\n").
// - Lines starting with ":" are comments and ignored; blank lines ignored;
//   only "data:" lines carry payloads.
// - "data: [DONE]" ends the stream; anything after it is ignored.
// - Other "data:" payloads are JSON; malformed JSON lines are skipped
//   (never crash). Each event contributes choices[0].delta (message also
//   accepted for tolerance): delta.content strings accumulate into full
//   text (emitted via onToken), delta.tool_calls accumulate by `index`
//   (id from the first non-empty value, name/arguments concatenated).
// - Tool deltas revealing a name fire onToolDelta + onPhase("tool", name)
//   immediately, before execution.
// - Slots with an id but no name at [DONE] are dropped with an onWarning
//   message and never returned (keeps assistant/tool pairing valid).
// - A stream that ends without [DONE] throws a truncation error.
// - A stream with zero "data:" lines is treated as a non-SSE JSON payload
//   (tolerance for bodies that are really single-shot JSON) and parsed as
//   choices[0].message like the non-streaming fallback.
export async function readSSEMessage(
  res: Response,
  opts?: StreamCallbacks
): Promise<ChatResult> {
  const body = (res as unknown as { body?: unknown }).body as
    | {
        getReader?: () => { read(): Promise<{ done: boolean; value?: unknown }>; cancel?: () => Promise<void> | void; releaseLock?: () => void };
        [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
      }
    | null
    | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  let rawText = "";
  let fullText = "";
  let sawData = false;
  let sawDone = false;
  let streamingAnnounced = false;
  type Partial = { id: string; name: string; args: string; type?: string };
  const partials: Partial[] = [];
  // Usage reported by the stream (typically a final chunk with empty
  // choices and a top-level `usage` object). Last value seen per key wins:
  // one stream carries one POST's usage. `streamReasoning` is the first
  // reasoning label seen in any delta.
  let streamUsage: Usage | undefined;
  let streamReasoning: string | undefined;
  // Accumulated thinking text (see onThinking): kept apart from fullText so
  // reasoning never leaks into the answer, history, or tool arguments.
  let fullThinking = "";

  function announceStreaming(): void {
    if (!streamingAnnounced) {
      streamingAnnounced = true;
      try {
        opts?.onPhase?.("streaming");
      } catch {
        // observer errors never break the stream
      }
    }
  }

  function processLine(rawLine: string): void {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) return;
    if (line.startsWith(":")) return; // SSE comment / keep-alive
    if (!line.startsWith("data:")) return; // event:/id:/retry: ignored
    sawData = true;
    let payload = line.slice("data:".length);
    if (payload.startsWith(" ")) payload = payload.slice(1);
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    if (payload.length === 0) return;
    let evt: unknown;
    try {
      evt = JSON.parse(payload);
    } catch {
      return; // malformed JSON data line: skip, never crash
    }
    // Usage rides on its own (often final) chunk with empty choices, so it
    // is read from the event top level before the delta handling below.
    const usageHit = parseUsage((evt as { usage?: unknown })?.usage);
    if (usageHit !== undefined) {
      streamUsage = { ...streamUsage, ...usageHit };
    }
    const choice = (evt as { choices?: Array<{ delta?: unknown; message?: unknown }> })
      ?.choices?.[0];
    const delta = (choice?.delta ?? choice?.message) as
      | { content?: unknown; tool_calls?: unknown }
      | null
      | undefined;
    if (typeof delta !== "object" || delta === null) return;
    if (streamReasoning === undefined) {
      const hit = parseReasoningLabel(delta);
      if (hit !== undefined) streamReasoning = hit;
    }
    const content = (delta as { content?: unknown }).content;
    if (typeof content === "string" && content.length > 0) {
      fullText += content;
      announceStreaming();
      try {
        opts?.onPhase?.("streaming");
      } catch {
        // ignore observer errors
      }
      try {
        opts?.onToken?.(fullText);
      } catch {
        // ignore observer errors
      }
    }
    // Thinking deltas ride alongside (often before) content deltas.
    // `reasoning_content` (DeepSeek-style) wins; a plain-string
    // `reasoning` field is the fallback some gateways use. Object-shaped
    // `reasoning` metadata is NOT text — only the label reader touches it.
    const thinkingFrag =
      (delta as { reasoning_content?: unknown }).reasoning_content;
    if (typeof thinkingFrag === "string" && thinkingFrag.length > 0) {
      fullThinking += thinkingFrag;
      try {
        opts?.onThinking?.(fullThinking);
      } catch {
        // ignore observer errors
      }
    } else {
      const altFrag = (delta as { reasoning?: unknown }).reasoning;
      if (typeof altFrag === "string" && altFrag.length > 0) {
        fullThinking += altFrag;
        try {
          opts?.onThinking?.(fullThinking);
        } catch {
          // ignore observer errors
        }
      }
    }
    const tcs = (delta as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(tcs)) {
      announceStreaming();
      for (const tc of tcs as Array<{
        index?: unknown;
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>) {
        const idx = typeof tc?.index === "number" && tc.index >= 0 ? tc.index : 0;
        while (partials.length <= idx) partials.push({ id: "", name: "", args: "" });
        const slot = partials[idx]!;
        if (typeof tc?.id === "string" && tc.id.length > 0 && slot.id.length === 0) {
          slot.id = tc.id;
        }
        if (typeof tc?.type === "string" && !slot.type) slot.type = tc.type;
        const fn = tc?.function ?? {};
        const nameFrag = typeof fn?.name === "string" ? fn.name : "";
        if (nameFrag.length > 0) slot.name += nameFrag;
        if (typeof fn?.arguments === "string" && fn.arguments.length > 0) slot.args += fn.arguments;
        // Live hint: every delta that contributes a name fragment re-emits
        // the accumulated name, so the TUI hint grows "re" -> "read" live.
        if (nameFrag.length > 0 && slot.name.length > 0) {
          try {
            opts?.onToolDelta?.(slot.name, idx);
          } catch {
            // ignore
          }
          try {
            opts?.onPhase?.("tool", slot.name);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  function drainBuffer(): void {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      processLine(line);
      if (sawDone) return;
    }
  }

  if (body == null) {
    throw new Error("Empty reply from model (unexpected payload).");
  }
  try {
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      try {
        for (;;) {
          let chunk: { done: boolean; value?: unknown };
          try {
            chunk = await reader.read();
          } catch (e) {
            throw new Error(
              `Truncated stream from model (connection aborted: ${e instanceof Error ? e.message : String(e)}).`
            );
          }
          if (chunk.done) break;
          const v = chunk.value;
          const text = typeof v === "string" ? v : decoder.decode(v as Uint8Array, { stream: true });
          rawText += text;
          buffer += text;
          drainBuffer();
          if (sawDone) {
            try {
              await reader.cancel?.();
            } catch {
              // ignore
            }
            break;
          }
        }
        if (!sawDone && buffer.length > 0) {
          processLine(buffer);
          buffer = "";
        }
      } finally {
        try {
          reader.releaseLock?.();
        } catch {
          // ignore
        }
      }
    } else if (typeof body[Symbol.asyncIterator] === "function") {
      for await (const v of body as unknown as AsyncIterable<unknown>) {
        const text = typeof v === "string" ? v : decoder.decode(v as Uint8Array, { stream: true });
        rawText += text;
        buffer += text;
        drainBuffer();
        if (sawDone) break;
      }
      if (!sawDone && buffer.length > 0) {
        processLine(buffer);
        buffer = "";
      }
    } else {
      // Unknown body shape: fall back to whole-text read when available.
      const textFn = (res as unknown as { text?: () => Promise<string> }).text;
      if (typeof textFn === "function") {
        const txt = await textFn.call(res);
        rawText = String(txt ?? "");
        buffer = rawText;
        drainBuffer();
        if (buffer.length > 0) {
          processLine(buffer);
          buffer = "";
        }
      } else {
        throw new Error("Empty reply from model (unexpected payload).");
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Truncated stream")) throw e;
    if (e instanceof Error && e.message.startsWith("Empty reply")) throw e;
    throw new Error(
      `Truncated stream from model (connection aborted: ${e instanceof Error ? e.message : String(e)}).`
    );
  }

  // Tolerance: a body with no SSE data lines is really single-shot JSON.
  if (!sawData) {
    const candidate = rawText.trim();
    if (candidate.length > 0) {
      try {
        const data = JSON.parse(candidate) as {
          usage?: unknown;
          choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
        };
        const msg = data?.choices?.[0]?.message;
        if (msg !== undefined) {
          const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
          const content = msg?.content ?? null;
          if (calls.length === 0 && (content == null || content.trim() === "")) {
            throw new Error("Empty reply from model (unexpected payload).");
          }
          const result: ChatResult = {
            content,
            tool_calls: calls.length > 0 ? calls : undefined,
          };
          const usage = parseUsage(data?.usage);
          if (usage !== undefined) result.usage = usage;
          const reasoning = parseReasoningLabel(msg);
          if (reasoning !== undefined) result.reasoning = reasoning;
          return result;
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Empty reply")) throw e;
        // not JSON either -> fall through to truncation error below
      }
    }
    throw new Error("Truncated stream from model (connection aborted before [DONE]).");
  }

  if (!sawDone) {
    throw new Error("Truncated stream from model (connection aborted before [DONE]).");
  }

  const calls: ToolCall[] = [];
  for (let i = 0; i < partials.length; i++) {
    const p = partials[i]!;
    if (!p.name) {
      if (p.id) {
        try {
          opts?.onWarning?.(`dropped tool call ${p.id} with no function name`);
        } catch {
          // ignore
        }
      }
      continue;
    }
    calls.push({
      id: p.id || `stream-${i}`,
      ...(p.type ? { type: p.type } : { type: "function" }),
      function: { name: p.name, arguments: p.args },
    });
  }
  if (calls.length === 0 && fullText.trim() === "") {
    throw new Error("Empty reply from model (unexpected payload).");
  }
  const result: ChatResult = {
    content: fullText.length > 0 ? fullText : null,
    tool_calls: calls.length > 0 ? calls : undefined,
  };
  if (streamUsage !== undefined) result.usage = streamUsage;
  if (streamReasoning !== undefined) result.reasoning = streamReasoning;
  return result;
}

// Streaming chat POST with tools attached (tool_choice omitted, so the
// default auto applies). Sends {..., stream:true} plus `reasoning_effort`
// ONLY when opts.reasoningEffort is non-Default AND the model is in
// REASONING_EFFORT_SUPPORTED_MODELS (see reasoningEffortParam); otherwise
// the param is omitted. Parses the SSE event stream (see readSSEMessage).
// When the response has no SSE body (plain {ok, json()} mocks and other
// non-streaming payloads) it falls back to the original single-JSON parse,
// unchanged. Returns the raw assistant message: either final content or
// tool_calls the caller must execute, plus `usage`/`reasoning` only when
// the response actually carried them (usage: top-level `usage` on JSON or
// SSE final chunks; reasoning: message/delta reasoning metadata).
// Throws on HTTP error, empty reply, or a truncated stream.
// - Network throws and HTTP 429/500/502/503/504 are retried up to 2 times
//   (3 attempts) with 1s->2s backoff, honoring Retry-After capped at 30s.
//   Each retry emits onPhase("retry", detail). Other 4xx fail fast with
//   the existing `Zen HTTP {status}` message.
// - Callers must roll back the user turn on failure (see App submit).
// `errorLabel` prefixes HTTP errors (`{label} HTTP {status}`, default "Zen");
// the dispatcher passes providerLabel(provider) for non-zen openai-chat
// providers so users see e.g. `OpenAI HTTP 401` instead of `Zen HTTP 401`.
// Legacy `function_call` shape is intentionally ignored.
export async function chatCompletion(
  endpoint: string,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  opts?: StreamCallbacks & EffortOpts & SummaryOpts,
  errorLabel: string = "Zen"
): Promise<ChatResult> {
  const sleep = opts?.sleep ?? defaultSleep;
  const signal = opts?.signal ?? null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      throwIfCancelled(signal);
      try {
        opts?.onPhase?.("thinking");
      } catch {
        // ignore observer errors
      }
      const effortParam = reasoningEffortParam(opts?.reasoningEffort, model);
      const summaryOpts = opts as SummaryOpts | undefined;
      const payload: Record<string, unknown> = {
        model,
        messages: history,
        stream: true,
      };
      // Compaction path only: tools disabled means NO `tools` key at all
      // (asserted in tests); the normal loop always sends the schema.
      if (!summaryOpts?.disableTools) {
        payload["tools"] = TOOL_DEFINITIONS;
      }
      // Compaction path only: cap output (openai-chat kind uses max_tokens).
      if (
        typeof summaryOpts?.maxOutputTokens === "number" &&
        Number.isFinite(summaryOpts.maxOutputTokens) &&
        summaryOpts.maxOutputTokens > 0
      ) {
        payload["max_tokens"] = Math.floor(summaryOpts.maxOutputTokens);
      }
      if (effortParam !== undefined) payload["reasoning_effort"] = effortParam;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const errText = await safeErrorText(res);
        const err = new Error(`${errorLabel} HTTP ${res.status}: ${errText.slice(0, 300)}`);
        if (!RETRYABLE_STATUS.has(res.status)) throw err;
        if (attempt < MAX_RETRIES) {
          throwIfCancelled(signal);
          const delay = getRetryDelay(attempt, res);
          try {
            opts?.onPhase?.("retry", `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (HTTP ${res.status})`);
          } catch {
            // ignore
          }
          await sleep(delay);
          throwIfCancelled(signal);
          lastError = err;
          continue;
        }
        throw err;
      }
      if (!hasStreamBody(res)) {
        const data = (await (res as unknown as { json: () => Promise<unknown> }).json()) as {
          usage?: unknown;
          choices?: Array<{
            message?: { content?: string | null; tool_calls?: ToolCall[] };
          }>;
        };
        const msg = data?.choices?.[0]?.message;
        const calls = Array.isArray(msg?.tool_calls) ? msg!.tool_calls! : [];
        const content = msg?.content ?? null;
        if (calls.length === 0 && (content == null || content.trim() === "")) {
          throw new Error("Empty reply from model (unexpected payload).");
        }
        // Non-streaming bodies carry thinking whole, if at all — same
        // channel rules as the SSE path (strings only, never the answer).
        const wholeThinking =
          (msg as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        if (typeof wholeThinking === "string" && wholeThinking.length > 0) {
          try {
            opts?.onThinking?.(wholeThinking);
          } catch {
            // ignore observer errors
          }
        } else {
          const wholeAlt = (msg as { reasoning?: unknown } | undefined)?.reasoning;
          if (typeof wholeAlt === "string" && wholeAlt.length > 0) {
            try {
              opts?.onThinking?.(wholeAlt);
            } catch {
              // ignore observer errors
            }
          }
        }
        const result: ChatResult = {
          content,
          tool_calls: calls.length > 0 ? calls : undefined,
        };
        const usage = parseUsage(data?.usage);
        if (usage !== undefined) result.usage = usage;
        const reasoning = parseReasoningLabel(msg);
        if (reasoning !== undefined) result.reasoning = reasoning;
        return result;
      }
      return await readSSEMessage(res, opts);
    } catch (e) {
      // Cancellations (Ctrl+C / AbortSignal) are final: never retry, never
      // reframe — propagate so the caller can roll back + show (cancelled).
      if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
      // HTTP failures already handled above (retry or fail-fast): rethrow
      // without treating them as retryable network errors.
      if (e instanceof Error && e.message.startsWith(`${errorLabel} HTTP`)) throw e;
      // Parsing/validation failures (empty reply, truncation) are permanent:
      // never retry, surface immediately so the caller can roll back.
      if (
        e instanceof Error &&
        (e.message.startsWith("Empty reply") || e.message.startsWith("Truncated stream"))
      ) {
        throw e;
      }
      // Anything else is a network-level throw: retry when attempts remain.
      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt, undefined);
        try {
          opts?.onPhase?.(
            "retry",
            `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (${e instanceof Error ? e.message : String(e)})`
          );
        } catch {
          // ignore
        }
        try {
          await sleep(delay);
        } catch {
          // a failing sleep must not mask the original error
        }
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Agentic loop for one user turn: thin wrapper over the shared runLoopWithChat
// core below (single loop implementation). Send → while the response carries
// tool_calls (max MAX_TOOL_STEPS tool rounds), append the assistant message,
// execute each tool locally, append {role:'tool'} results, resend.
// Streaming: each POST streams SSE tokens (onToken gets the growing text,
// onPhase reports thinking|streaming|tool|retry|done, onToolDelta fires when
// a tool name first appears mid-stream). A model that returns no tool_calls
// ends the loop (graceful fallback for models without tool support). Tool
// errors are results the model sees — NOTHING is rolled back here; only a
// POST failure (HTTP/network/empty/truncated) throws (and the caller rolls
// back the user turn, as before, including any streaming draft).
export async function runAgenticLoop(
  endpoint: string,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  opts?: AgenticOpts
): Promise<string> {
  return runLoopWithChat(
    (h, o) =>
      chatCompletion(endpoint, apiKey, model, h, {
        onToken: o?.onToken,
        onPhase: o?.onPhase,
        onToolDelta: o?.onToolDelta,
        onWarning: o?.onWarning,
        onThinking: o?.onThinking,
        sleep: o?.sleep,
        reasoningEffort: o?.reasoningEffort,
        signal: o?.signal,
      }),
    history,
    opts
  );
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
  try {
    return await execute(name, parsed);
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

// AGENTS.md loading: <cwd>/AGENTS.md (or $OPENCODE_AGENTS_PATH when set)
// is appended to the system prompt at startup, capped at 12KB.
export function agentsFilePath(cwd: string = process.cwd()): string {
  return process.env.OPENCODE_AGENTS_PATH ?? path.join(cwd, "AGENTS.md");
}

export function loadAgentsPrompt(cwd: string = process.cwd()): string | null {
  try {
    const p = agentsFilePath(cwd);
    if (!existsSync(p)) return null;
    let text = readFileSync(p, "utf8");
    if (text.length > AGENTS_CHAR_CAP) {
      text = text.slice(0, AGENTS_CHAR_CAP) + "\n[truncated: AGENTS.md exceeded 12KB]";
    }
    return text;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(cwd: string = process.cwd()): string {
  // Two layers: src/system.ts base one-liner + repo AGENTS.md overlay.
  // Owner knobs: edit the one-liner in src/system.ts for the base identity;
  // add repo instructions to AGENTS.md for the overlay.
  const extra = loadAgentsPrompt(cwd);
  return extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT;
}

// ---- Multi-provider dispatch (adapter boundary per POST) ----
// Internal history stays OpenAI-shaped; translation happens here per POST.
// openai-chat kind reuses chatCompletion with the provider's error label
// (zen "Zen" stays byte-identical).
// reasoning_effort gating UNCHANGED: zen-supported set only, others never.

export type ProviderChatOpts = StreamCallbacks &
  EffortOpts &
  SummaryOpts & {
    baseURL?: string;
    // Zen endpoint override (respects OPENCODE_ZEN_ENDPOINT); when absent
    // the registry default is used.
    endpointOverride?: string;
  };

function providerHttpError(provider: ProviderId, status: number, text: string): Error {
  return new Error(`${providerLabel(provider)} HTTP ${status}: ${text.slice(0, 300)}`);
}

export async function chatCompletionAnthropic(
  apiKey: string,
  model: string,
  history: ChatMessage[],
  opts?: StreamCallbacks & EffortOpts & SummaryOpts
): Promise<ChatResult> {
  const sleep = opts?.sleep ?? defaultSleep;
  const signal = opts?.signal ?? null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      throwIfCancelled(signal);
      try {
        opts?.onPhase?.("thinking");
      } catch {
        // ignore
      }
      const summaryOpts = opts as SummaryOpts | undefined;
      const base = buildAnthropicBody(history, model, {
        includeTools: !summaryOpts?.disableTools,
      });
      const body: Record<string, unknown> = { ...base, stream: true };
      // Compaction cap (anthropic kind uses max_tokens; default is already
      // 4096, but the summary path sets it explicitly for the assertion).
      if (
        typeof summaryOpts?.maxOutputTokens === "number" &&
        Number.isFinite(summaryOpts.maxOutputTokens) &&
        summaryOpts.maxOutputTokens > 0
      ) {
        body["max_tokens"] = Math.floor(summaryOpts.maxOutputTokens);
      }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders(apiKey),
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const errText = await safeErrorText(res);
        const err = providerHttpError("anthropic", res.status, errText);
        if (!RETRYABLE_STATUS.has(res.status)) throw err;
        if (attempt < MAX_RETRIES) {
          throwIfCancelled(signal);
          const delay = getRetryDelay(attempt, res);
          try {
            opts?.onPhase?.("retry", `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (HTTP ${res.status})`);
          } catch {
            // ignore
          }
          await sleep(delay);
          throwIfCancelled(signal);
          lastError = err;
          continue;
        }
        throw err;
      }
      if (!hasStreamBody(res)) {
        const data = (await (res as unknown as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
        return parseAnthropicJson(data);
      }
      return await readAnthropicSSEMessage(res, opts);
    } catch (e) {
      if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
      if (e instanceof Error && e.message.startsWith("Anthropic HTTP")) throw e;
      if (
        e instanceof Error &&
        (e.message.startsWith("Empty reply") || e.message.startsWith("Truncated stream"))
      ) {
        throw e;
      }
      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt, undefined);
        try {
          opts?.onPhase?.(
            "retry",
            `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (${e instanceof Error ? e.message : String(e)})`
          );
        } catch {
          // ignore
        }
        try {
          await sleep(delay);
        } catch {
          // ignore
        }
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function chatCompletionGemini(
  apiKey: string,
  model: string,
  history: ChatMessage[],
  opts?: StreamCallbacks & EffortOpts & SummaryOpts
): Promise<ChatResult> {
  const sleep = opts?.sleep ?? defaultSleep;
  const signal = opts?.signal ?? null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      throwIfCancelled(signal);
      try {
        opts?.onPhase?.("thinking");
      } catch {
        // ignore
      }
      const summaryOpts = opts as SummaryOpts | undefined;
      const body = buildGeminiBody(history, model, {
        includeTools: !summaryOpts?.disableTools,
        ...(typeof summaryOpts?.maxOutputTokens === "number" &&
        Number.isFinite(summaryOpts.maxOutputTokens) &&
        summaryOpts.maxOutputTokens > 0
          ? { maxOutputTokens: Math.floor(summaryOpts.maxOutputTokens) }
          : {}),
      });
      const res = await fetch(geminiChatUrl(model), {
        method: "POST",
        headers: geminiHeaders(apiKey),
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const errText = await safeErrorText(res);
        const err = providerHttpError("google-gemini", res.status, errText);
        if (!RETRYABLE_STATUS.has(res.status)) throw err;
        if (attempt < MAX_RETRIES) {
          throwIfCancelled(signal);
          const delay = getRetryDelay(attempt, res);
          try {
            opts?.onPhase?.("retry", `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (HTTP ${res.status})`);
          } catch {
            // ignore
          }
          await sleep(delay);
          throwIfCancelled(signal);
          lastError = err;
          continue;
        }
        throw err;
      }
      if (!hasStreamBody(res)) {
        // Non-streaming :generateContent fallback tolerance (same shape):
        // a plain JSON body parses like single-shot JSON.
        const data = (await (res as unknown as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
        try {
          return parseGeminiJson(data);
        } catch {
          // Try the non-streaming endpoint once before giving up.
          throwIfCancelled(signal);
          const res2 = await fetch(geminiGenerateUrl(model), {
            method: "POST",
            headers: geminiHeaders(apiKey),
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
          });
          if (!res2.ok) {
            const errText2 = await safeErrorText(res2);
            throw providerHttpError("google-gemini", res2.status, errText2);
          }
          const data2 = (await (res2 as unknown as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
          return parseGeminiJson(data2);
        }
      }
      return await readGeminiSSEMessage(res, opts);
    } catch (e) {
      if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
      if (e instanceof Error && e.message.startsWith("Gemini HTTP")) throw e;
      // providerHttpError for gemini uses label "Google Gemini", not "Gemini":
      // rethrow those without retry-as-network (they were already handled).
      if (e instanceof Error && /HTTP \d+:/.test(e.message)) {
        const m = /HTTP (\d+):/.exec(e.message);
        if (m && !RETRYABLE_STATUS.has(Number(m[1]))) throw e;
        // retryable HTTP already handled above; fall through only for network
      }
      if (
        e instanceof Error &&
        (e.message.startsWith("Empty reply") || e.message.startsWith("Truncated stream"))
      ) {
        throw e;
      }
      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt, undefined);
        try {
          opts?.onPhase?.(
            "retry",
            `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (${e instanceof Error ? e.message : String(e)})`
          );
        } catch {
          // ignore
        }
        try {
          await sleep(delay);
        } catch {
          // ignore
        }
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Provider dispatcher: openai-chat reuses chatCompletion with the provider's
// error label; anthropic/gemini go through their adapters. reasoning_effort is only
// ever attached for opencode-zen (via reasoningEffortParam); all other
// providers never receive the param.
export async function chatCompletionForProvider(
  provider: ProviderId,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  opts?: ProviderChatOpts
): Promise<ChatResult> {
  const def = getProvider(provider);
  if (!def) throw new Error(`unknown provider: ${provider}`);
  if (def.kind === "anthropic-messages") {
    return chatCompletionAnthropic(apiKey, model, history, opts);
  }
  if (def.kind === "gemini-generate") {
    return chatCompletionGemini(apiKey, model, history, opts);
  }
  // openai-chat kind: zen keeps byte-identical behavior (errorLabel "Zen",
  // endpoint override honors OPENCODE_ZEN_ENDPOINT); others use the registry
  // endpoint with their provider label (e.g. "OpenAI", "DeepSeek").
  const endpoint =
    provider === "opencode-zen"
      ? (opts?.endpointOverride ?? chatEndpointFor(provider, opts?.baseURL))
      : chatEndpointFor(provider, opts?.baseURL);
  const effortOpts: EffortOpts =
    provider === "opencode-zen" ? { reasoningEffort: opts?.reasoningEffort } : {};
  return chatCompletion(
    endpoint,
    apiKey,
    model,
    history,
    {
      onToken: opts?.onToken,
      onPhase: opts?.onPhase,
      onToolDelta: opts?.onToolDelta,
      onWarning: opts?.onWarning,
      onThinking: opts?.onThinking,
      sleep: opts?.sleep,
      signal: opts?.signal,
      ...effortOpts,
      // Compaction path only (undefined for the normal loop → tools sent).
      ...(opts?.disableTools !== undefined ? { disableTools: opts.disableTools } : {}),
      ...(opts?.maxOutputTokens !== undefined
        ? { maxOutputTokens: opts.maxOutputTokens }
        : {}),
    },
    providerLabel(provider)
  );
}

// Shared agentic-loop core: the SINGLE loop implementation backing both
// runAgenticLoop and runAgenticLoopForProvider (same tool/rollback contract).
// Sequencing: tool_calls in one assistant message execute strictly in order;
// a failure in one call NEVER skips the remaining calls in the block; each
// result pairs with its tool_call_id in order. Malformed calls (bad JSON,
// unknown name, failed validation) yield their error result inline and the
// block continues. Validation/unknown/denial/cancel are never retried —
// only transient transport failures retry (inside chatCompletion).
export async function runLoopWithChat(
  chatFn: (history: ChatMessage[], opts?: AgenticOpts) => Promise<ChatResult>,
  history: ChatMessage[],
  opts?: AgenticOpts
): Promise<string> {
  const execute = opts?.execute ?? executeTool;
  const maxSteps = opts?.maxSteps ?? MAX_TOOL_STEPS;
  const signal = opts?.signal ?? null;
  // At most one truncation notice per turn; silence when nothing dropped.
  let truncationNoticed = false;
  for (let step = 0; ; step++) {
    throwIfCancelled(signal);
    // History budget (uniform for all providers — every POST flows through
    // here): trim oldest user-turns first before each send.
    const trimmed = truncateHistory(
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
    if (trimmed.droppedTurns > 0) truncationNoticed = true;
    let msg: ChatResult;
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
      if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
      throw e;
    }
    throwIfCancelled(signal);
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
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const finalText = msg.content ?? "";
      history.push({ role: "assistant", content: finalText });
      try {
        opts?.onPhase?.("done");
      } catch {
        // ignore
      }
      return finalText;
    }
    if (step >= maxSteps) {
      const base = msg.content ?? "";
      const notice = `${base}${base ? "\n" : ""}(stopped: too many tool steps)`;
      history.push({ role: "assistant", content: notice });
      try {
        opts?.onPhase?.("done");
      } catch {
        // ignore
      }
      return notice;
    }
    history.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      // No new executions after a cancel: the current tool (if any) already
      // finished; stop before starting the next one.
      throwIfCancelled(signal);
      const name = call?.function?.name ?? "(unknown)";
      try {
        opts?.onPhase?.("tool", name);
      } catch {
        // ignore
      }
      let parsed: Record<string, unknown>;
      try {
        const raw = call?.function?.arguments ?? "{}";
        const v: unknown = JSON.parse(typeof raw === "string" ? raw : "{}");
        parsed = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
      } catch {
        parsed = {};
        const result = `Error: invalid call: invalid JSON arguments for tool "${name}" (arguments must be valid JSON). Fix the arguments and retry.`;
        history.push({ role: "tool", tool_call_id: call?.id ?? "", content: result });
        try {
          opts?.onToolActivity?.(describeToolCall(name, {}), result, true);
        } catch {
          // ignore observer errors
        }
        continue;
      }
      let result: string;
      try {
        result = await runOneTool(call, parsed, opts, execute);
      } catch (e) {
        if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
        throw e;
      }
      const isError = typeof result === "string" && result.startsWith("Error");
      history.push({ role: "tool", tool_call_id: call?.id ?? "", content: result });
      try {
        opts?.onToolActivity?.(describeToolCall(name, parsed), result, isError);
      } catch {
        // ignore observer errors
      }
    }
  }
}

export async function runAgenticLoopForProvider(
  provider: ProviderId,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  opts?: AgenticOpts & { baseURL?: string; endpointOverride?: string }
): Promise<string> {
  return runLoopWithChat(
    (h, o) =>
      chatCompletionForProvider(provider, apiKey, model, h, {
        onToken: o?.onToken,
        onPhase: o?.onPhase,
        onToolDelta: o?.onToolDelta,
        onWarning: o?.onWarning,
        onThinking: o?.onThinking,
        sleep: o?.sleep,
        signal: o?.signal,
        reasoningEffort: o?.reasoningEffort,
        baseURL: opts?.baseURL,
        endpointOverride: opts?.endpointOverride,
      }),
    history,
    opts
  );
}

// Per-provider model list: live list per kind with curated fallback on ANY
// failure. Zen keeps today's compatibility rule (see fetchModels); other
// providers accept every listed id.
// WithStatus variant reports ok:true only when the live list was used, so
// callers cache successes and keep failures uncached. fetchModelsForProvider
// stays byte-identical (returns models only).
function hasOpenAILiveIds(data: unknown): boolean {
  try {
    const entries: unknown = Array.isArray(data)
      ? data
      : (data as { data?: unknown })?.data;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
      if (entryId(entry)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function hasGeminiLiveIds(data: unknown): boolean {
  try {
    const o = data as { models?: unknown };
    const entries: unknown = Array.isArray(o?.models) ? o.models : null;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
      let id = entryId(entry);
      if (id && id.startsWith("models/")) id = id.slice("models/".length);
      if (id) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function fetchModelsForProviderWithStatus(
  provider: ProviderId,
  apiKey: string,
  baseURL?: string,
  zenEndpointOverride?: string
): Promise<ModelsFetchStatus> {
  const def = getProvider(provider);
  if (!def) return { models: [], ok: false };
  const fallback = [...def.fallbackModels];
  try {
    if (provider === "opencode-zen") {
      // Byte-identical rule: reuse fetchModels (compatibility-filtered).
      const endpoint = zenEndpointOverride ?? chatEndpointFor(provider, baseURL);
      return await fetchModelsWithStatus(endpoint, apiKey);
    }
    if (def.kind === "anthropic-messages") {
      const res = await fetch(modelsUrlForProvider(provider), {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
      });
      if (!res.ok) return { models: fallback, ok: false };
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { models: fallback, ok: false };
      }
      const models = parseAnthropicModelsList(data, fallback);
      if (!hasOpenAILiveIds(data)) return { models: fallback, ok: false };
      return { models, ok: true };
    }
    if (def.kind === "gemini-generate") {
      const res = await fetch(modelsUrlForProvider(provider), {
        headers: geminiHeaders(apiKey),
      });
      if (!res.ok) return { models: fallback, ok: false };
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { models: fallback, ok: false };
      }
      const models = parseGeminiModelsList(data, fallback);
      if (!hasGeminiLiveIds(data)) return { models: fallback, ok: false };
      return { models, ok: true };
    }
    // openai-chat (non-zen): accept all listed ids.
    const res = await fetch(modelsUrlForProvider(provider, baseURL), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { models: fallback, ok: false };
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { models: fallback, ok: false };
    }
    const models = parseOpenAIModelsList(data, fallback);
    if (!hasOpenAILiveIds(data)) return { models: fallback, ok: false };
    return { models, ok: true };
  } catch {
    return { models: fallback, ok: false };
  }
}

export async function fetchModelsForProvider(
  provider: ProviderId,
  apiKey: string,
  baseURL?: string,
  zenEndpointOverride?: string
): Promise<string[]> {
  const r = await fetchModelsForProviderWithStatus(
    provider,
    apiKey,
    baseURL,
    zenEndpointOverride
  );
  return r.models;
}
