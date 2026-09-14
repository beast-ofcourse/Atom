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
  allToolDefinitions,
  chatToolDefinitions,
  describeToolCall,
  executeTool,
  getExtensionPromptHints,
  getTodos,
  invalidCall,
  needsApproval,
  toolNames,
  validateAskQuestionArgs,
  validateToolArgs,
} from "./tools.js";
import {
  chatEndpointFor,
  getProvider,
  isLocalProviderId,
  modelsUrlForProvider,
  providerLabel,
  type ProviderId,
} from "./providers.js";
import { discoverLocalProvider } from "./local-discovery.js";
import {
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_VERSION,
  anthropicHeaders,
  anthropicThinkingFor,
  buildAnthropicBody,
  buildGeminiBody,
  geminiChatUrl,
  geminiGenerateUrl,
  geminiHeaders,
  geminiThinkingLevelFor,
  isEffortRejection,
  parseAnthropicJson,
  parseAnthropicModelsList,
  parseGeminiJson,
  parseGeminiModelsList,
  parseOpenAIModelsList,
  readAnthropicSSEMessage,
  readGeminiSSEMessage,
  buildResponsesBody,
  isResponsesEffortRejection,
  isStallError,
  parseResponsesObject,
  readResponsesSSEMessage,
  readWithStall,
  sseHeaderTimeoutMs,
  sseStallTimeoutMs,
  zenHeaders,
  zenRequestId,
} from "./adapters.js";
export { isStallError, readWithStall, sseHeaderTimeoutMs, sseStallTimeoutMs, ZEN_CLIENT_UA, zenHeaders, zenRequestId, zenSessionId } from "./adapters.js";
import { loadAtomConfig } from "./config.js";
import {
  KILO_FALLBACK_MODELS,
  fetchKiloModelsWithStatus,
  normalizeKiloChatError,
} from "./kilo.js";
import { splitSystemHead } from "./prompt-cache.js";
import { SYSTEM_PROMPT } from "./system.js";
// Provider hooks (ticket 08): extension context/pre-request/post-response
// hooks fire per POST in the three transports below (openai-chat,
// anthropic-messages, gemini-generate), so every provider kind is covered
// through the chatCompletionForProvider dispatcher. All apply/notify helpers
// never throw (fail-open), so hooks can never break the turn.
import {
  afterResponseObservers,
  applyBeforeRequest,
  applyContextTransform,
  beforeRequestInterceptors,
  contextTransformers,
  notifyAfterResponse,
  snapshotResponseHeaders,
} from "./tools/provider-hooks.js";
// Type-only: the loop reports telemetry through the caller-provided sink but
// keeps zero runtime dependency on the telemetry module (the App owns the
// recorder; see src/telemetry.ts).
import type {
  LoopTelemetrySink,
  SinkModelCallInfo,
  SinkToolCallInfo,
} from "./telemetry.js";

export { MAX_TOOL_STEPS };
// Re-exported so existing `SYSTEM_PROMPT` imports keep working; the
// owner-editable source of truth lives in src/system.ts.
export { SYSTEM_PROMPT };

export const DEFAULT_ENDPOINT =
  "https://opencode.ai/zen/v1/chat/completions";
export const MODELS_URL_DEFAULT = "https://opencode.ai/zen/v1/models";
// Task 5 default: strongest tool-reliable chat/completions default available,
// verified against the live /models list + https://opencode.ai/docs/zen on
// 2026-09-08 (endpoint chat/completions, Tool Calls support, not deprecated,
// verified 1M context window). Free models (big-pickle etc.) stay in
// FALLBACK_MODELS, selectable via /model.
export const DEFAULT_MODEL = "deepseek-v4-pro";
export const AGENTS_CHAR_CAP = 12 * 1024;

// ---- Conversation history: uncapped ----
// Long sessions ride on compaction, not truncation: the shared loop core
// sends the full history on every POST (uniform across providers) and
// auto-compact at ~83% of the verified window is the only pressure valve.
// There are no message/char caps and no trim step.

export { toolStepBudget } from "./agent/loop.js";
// Reasoning effort (session state in the App, default "auto").
// Wire values are low/medium/high/max. "auto" never sends a param: it lets
// the model decide. The top setting is `Max`, sent on the wire as `max`.
// Support is assumed for every model on every provider kind — the server is
// authoritative: a model that truly lacks the knob fails the POST with a
// 400 naming the effort param, and the transports below retry once without
// it (see isEffortRejection in adapters.ts). Nothing is preemptively gated
// by model name, so "(unsupported)" only ever reflects an actual rejection.
export const EFFORT_OPTIONS: ReasoningEffort[] = [
  "auto",
  "low",
  "medium",
  "high",
  "max",
];

// Canonicalize a stored/picked effort value. "default" is the pre-auto name
// for the same level (old saves, old atom.json) and maps to "auto"; unknown
// values fall back to "auto" instead of stranding the session.
export function normalizeEffort(value: unknown): ReasoningEffort {
  if (value === "default" || value === "auto") return "auto";
  if (value === "low" || value === "medium" || value === "high" || value === "max") {
    return value;
  }
  return "auto";
}

// Effort support is provider-wide, never per-model: every known provider
// kind has a wire mapping (reasoning_effort on openai-chat, thinking on
// anthropic-messages, thinkingLevel on gemini-generate). Returns false only
// for an empty model or an unknown provider id — the actual per-model truth
// comes from the server at POST time (see above).
export function isEffortSupported(model: string, provider?: string): boolean {
  if (!model) return false;
  if (provider === undefined) return true;
  return getProvider(provider) !== undefined;
}

// Wire value for the POST body, or undefined when the param must be
// omitted (Auto, or an unknown effort string). The `model` argument is
// accepted for backward compatibility and intentionally ignored: support is
// assumed for every model, with server rejection as the only veto.
export function reasoningEffortParam(
  effort: string | undefined,
  _model?: string
): string | undefined {
  const normalized = normalizeEffort(effort);
  if (normalized === "auto") return undefined;
  return normalized;
}

// Wire value for the Responses `reasoning.effort` knob, or undefined when
// the param must be omitted (Auto, or an unknown effort string). Max maps
// to high — the deepest widely-supported level (same precedent as the
// Gemini thinkingLevel mapping in adapters.ts).
export function responsesEffortParam(effort: string | undefined): string | undefined {
  const normalized = normalizeEffort(effort);
  if (normalized === "auto") return undefined;
  if (normalized === "max") return "high";
  return normalized;
}

export type { AgenticOpts, ApprovalDecision, ChatMessage, ChatResult, EffortOpts, GoalToolOpts, LoopStats, PermissionMode, Phase, ReasoningEffort, Role, StreamCallbacks, SummaryOpts, ToolCall, ToolResultHook, ToolResultHookDecision, ToolResultHookInput, Usage } from "./agent/types.js";
export type { ToolFinishedInfo, ToolStartedInfo, TurnEventsSink } from "./agent/turn-events.js";
import type { AgenticOpts, ApprovalDecision, ChatMessage, ChatResult, EffortOpts, GoalToolOpts, LoopStats, PermissionMode, Phase, ReasoningEffort, Role, StreamCallbacks, SummaryOpts, ToolCall, Usage } from "./agent/types.js";
import {
  historyHasMedia,
  isImageRejection,
  lowerOpenAIContent,
  type MediaOpts,
} from "./media.js";
export type { MediaOpts } from "./media.js";
// Message measurement and context math live in the ContextManager module
// (single source for context math); zen.ts imports what it needs and
// re-exports the stable surface so existing importers keep working untouched.
import { createContextManager } from "./context-manager.js";
export {
  CHARS_PER_TOKEN,
  createContextManager,
  estimateTokensForChars,
  historyChars,
  messageChars,
  type ContextBudget,
  type ContextManager,
  type ContextManagerOptions,
  type ContextUsage,
} from "./context-manager.js";

export { openTodoNeedles } from "./agent/gates.js";
function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

// First finite count among the alias keys, in order. An alias present with
// a non-numeric value must not block the rest — a `??` chain would
// short-circuit on the first non-nullish operand and drop the payload.
function firstCount(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = finiteCount(o[key]);
    if (v !== undefined) return v;
  }
  return undefined;
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
  // Anthropic / Gemini / generic aliases: input_tokens -> prompt, output_tokens -> completion
  if (out.prompt_tokens === undefined) {
    const altPrompt = firstCount(
      o,
      "input_tokens",
      "inputTokens",
      "promptTokens",
      "promptTokenCount",
      "inputTokenCount"
    );
    if (altPrompt !== undefined) out.prompt_tokens = altPrompt;
  }
  if (out.completion_tokens === undefined) {
    const altComp = firstCount(
      o,
      "output_tokens",
      "outputTokens",
      "completionTokens",
      "candidatesTokenCount",
      "outputTokenCount"
    );
    if (altComp !== undefined) out.completion_tokens = altComp;
  }
  if (out.total_tokens === undefined) {
    const altTotal = firstCount(o, "totalTokens", "totalTokenCount");
    if (altTotal !== undefined) out.total_tokens = altTotal;
  }
  // Provider-reported prefix-cache counters (present-only, like everything
  // else here): OpenAI prompt_tokens_details.cached_tokens (+cache_write
  // when sent), DeepSeek prompt_cache_hit_tokens, Anthropic cache_read/_creation,
  // Gemini cachedContentTokenCount (official docs shapes).
  const details = o["prompt_tokens_details"];
  if (typeof details === "object" && details !== null) {
    const d = details as Record<string, unknown>;
    const cached = finiteCount(d["cached_tokens"]);
    if (cached !== undefined) out.cacheReadTokens = cached;
    const written = finiteCount(d["cache_write_tokens"]);
    if (written !== undefined) out.cacheWriteTokens = written;
  }
  const hit = finiteCount(o["prompt_cache_hit_tokens"]);
  if (hit !== undefined) out.cacheReadTokens = hit;
  if (out.cacheReadTokens === undefined) {
    // First-wins across provider aliases (Anthropic before Gemini): a
    // payload carrying both shapes keeps the first counter instead of
    // silently flipping to whichever alias is checked last.
    const anthRead = finiteCount(o["cache_read_input_tokens"]);
    if (anthRead !== undefined) {
      out.cacheReadTokens = anthRead;
    } else {
      const geminiCached = finiteCount(o["cachedContentTokenCount"]);
      if (geminiCached !== undefined) out.cacheReadTokens = geminiCached;
    }
  }
  if (out.cacheWriteTokens === undefined) {
    const anthWrite = finiteCount(o["cache_creation_input_tokens"]);
    if (anthWrite !== undefined) out.cacheWriteTokens = anthWrite;
  }
  // Recompute total when prompt+completion known but total missing (Anthropic/Gemini split)
  if (
    out.total_tokens === undefined &&
    out.prompt_tokens !== undefined &&
    out.completion_tokens !== undefined
  ) {
    out.total_tokens = out.prompt_tokens + out.completion_tokens;
  }
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

import { isCancelError, LoopCancelledError, throwIfCancelled } from "./agent/loop.js";
export { isCancelError, LoopCancelledError } from "./agent/loop.js";
// Ten retries (eleven total attempts): provider rate limits (429 with
// Retry-After) and weak-network throws both ride this policy. Cancellation
// never retries. Delays grow exponentially under a 30s cap, so a fully dead
// endpoint costs ~3.5min worst case before the turn fails loudly.
// 524/529 added for opencode parity (Cloudflare / overloaded gateways).
export const MAX_RETRIES = 10;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 524, 529]);
const RETRY_AFTER_CAP_MS = 30_000;

// Per-model-call deadline (opencode options.timeout parity): bounds a single
// chat POST including streaming. Env ATOM_MODEL_TIMEOUT_MS, default 300s
// (matches opencode header/chunk defaults), max-clamped to 10min. Caller
// combines with the user-cancel signal per attempt via AbortSignal.any.
export const DEFAULT_MODEL_TIMEOUT_MS = 300_000;
export const MAX_MODEL_TIMEOUT_MS = 600_000;

export function modelTimeoutMs(): number {
  const raw = process.env.ATOM_MODEL_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), MAX_MODEL_TIMEOUT_MS);
  }
  return DEFAULT_MODEL_TIMEOUT_MS;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff 1s → 2s → 4s …, honoring Retry-After (seconds or
// HTTP date) capped at 30s. `attempt` is the 0-based index of the failure
// just seen (0 => first failure => 1s).
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
  return Math.min(1000 * 2 ** attempt, RETRY_AFTER_CAP_MS);
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

// Curated Zen models, verified from https://opencode.ai/docs/zen + the live
// /models list. Used when the live list cannot be fetched or cannot confirm
// compatibility (network/auth/429/shape issues). Covers both wire families:
// chat/completions (default transport) and responses-family (muse-spark-*,
// served from /responses — see isZenResponsesModel); the live filter below
// accepts ids from either set, the dispatcher routes by family.
export const FALLBACK_MODELS: string[] = [
  "big-pickle",
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "deepseek-v4-flash-free",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3",
  "muse-spark-1.2",
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

// Responses-family model prefixes: these ids are served from Zen's
// /responses endpoint (OpenAI Responses API shape), not /chat/completions.
// Verified from the endpoint column at https://opencode.ai/docs/zen.
const ZEN_RESPONSES_MODEL_PREFIXES: readonly string[] = ["muse-spark-"];

/** True when a Zen model id must ride the Responses transport. */
export function isZenResponsesModel(model: string): boolean {
  return ZEN_RESPONSES_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

export const RESPONSES_ENDPOINT_DEFAULT = "https://opencode.ai/zen/v1/responses";

// Derive the /responses endpoint from a chat/completions endpoint (mirrors
// modelsUrl above); falls back to the default when the shape is unknown.
export function responsesEndpointFor(chatEndpoint: string): string {
  const suffix = "/chat/completions";
  if (chatEndpoint.endsWith(suffix)) {
    return chatEndpoint.slice(0, -suffix.length) + "/responses";
  }
  if (chatEndpoint.endsWith("/responses")) return chatEndpoint;
  return RESPONSES_ENDPOINT_DEFAULT;
}

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
// are already in the curated set, so the dropdown can never offer a
// Messages/Gemini-family model ATOM cannot serve. Responses-family ids
// (muse-spark-*) ARE servable via the Responses transport, so curated
// responses ids list alongside chat ids here; the dispatcher routes by
// family (see isZenResponsesModel).
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
      // Zen client identity: free `*-free` models are gated upstream on
      // official-client headers (UA + `x-opencode-session`, else 429/400).
      // Anonymous-safe: zenHeaders omits Authorization when no key instead
      // of sending `Bearer `.
      headers: zenHeaders(apiKey),
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
// - A response flagged `finish_reason: "length"` (output limit cut the
//   response off, so tool arguments are incomplete) does NOT throw: it
//   returns normally with `truncated: true` so the loop can fail each carried
//   tool call inline and continue the turn. Transport failures (aborted
//   connections, stalls, empty replies) keep throwing.
// - A stream silent longer than the stall budget (env ATOM_STALL_TIMEOUT_MS,
//   default 60s; the clock resets on every received chunk) throws a
//   Truncated-stream stall error — permanent, never retried, same contract
//   as a dead connection (verified live: free-tier routers can stall a
//   200-OK stream mid-generation for minutes).
// - Queue comments (`: ...`) and keep-alives carry bytes but no model output:
//   only `data:` payload lines refresh the data-silence clock, so minutes of
//   `: KILO PROCESSING` while queued fail fast instead of hanging the turn
//   (same budget, same permanent contract).
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
  // Output-limit flag (see contract above): set when any streamed choice
  // reports `finish_reason: "length"`. Returned on the result — never thrown.
  let lengthTruncated = false;
  // Accumulated thinking text (see onThinking): kept apart from fullText so
  // reasoning never leaks into the answer, history, or tool arguments.
  let fullThinking = "";
  // Data-silence tracking (see throwIfDataStalled): timestamp of the last
  // `data:` payload line. Queue comments (`: KILO PROCESSING`) and keep-alive
  // comments carry bytes but no model output — they advance the raw stream
  // but must NOT extend the stall budget (live-proven: minutes of comments
  // while a free-tier request sits queued).
  let lastDataAt = Date.now();

  // Fail fast when the stream flows (or idles) with no model output: same
  // Truncated contract as a dead connection (stalls are retryable upstream —
  // one retry after data, backoff for header stalls), same env knobs as the
  // per-read byte race. Header phase (no data yet) uses the generous header
  // budget; established streams use the tighter chunk budget. Checked
  // after each drained chunk — legitimately slow generations keep emitting
  // `data:` lines, so only true silence trips it.
  function throwIfDataStalled(): void {
    const budget = sawData || rawText.length > 0 ? sseStallTimeoutMs() : sseHeaderTimeoutMs();
    if (Date.now() - lastDataAt > budget) {
      throw new Error(
        `Truncated stream from model (stall: no output for ${budget}ms — queued or stalled upstream; resend to retry).`
      );
    }
  }

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
    lastDataAt = Date.now();
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
    const choice = (evt as { choices?: Array<{ delta?: unknown; message?: unknown; finish_reason?: unknown }> })
      ?.choices?.[0];
    // Output-limit marker rides on the choice, beside the delta — any chunk
    // reporting it means the tool arguments below are incomplete.
    if (choice?.finish_reason === "length") lengthTruncated = true;
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
            chunk = await readWithStall(() => reader.read());
          } catch (e) {
            if (isStallError(e)) throw e;
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
          throwIfDataStalled();
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
      const it = (body as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await readWithStall(() => it.next());
          if (step.done) break;
          const v = step.value;
          const text = typeof v === "string" ? v : decoder.decode(v as Uint8Array, { stream: true });
          rawText += text;
          buffer += text;
          drainBuffer();
          throwIfDataStalled();
          if (sawDone) break;
        }
      } finally {
        try {
          await it.return?.();
        } catch {
          // ignore — the stream is over either way
        }
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
  // (The data-silence bound applies only once real SSE traffic exists, so
  // whole-body JSON payloads are never false-tripped by it.)
  if (sawData) throwIfDataStalled();
  if (!sawData) {
    const candidate = rawText.trim();
    if (candidate.length > 0) {
      try {
        const data = JSON.parse(candidate) as {
          usage?: unknown;
          choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: unknown }>;
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
          if (data?.choices?.[0]?.finish_reason === "length") result.truncated = true;
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
  if (lengthTruncated) result.truncated = true;
  if (streamUsage !== undefined) result.usage = streamUsage;
  if (streamReasoning !== undefined) result.reasoning = streamReasoning;
  return result;
}

// Streaming chat POST with tools attached (tool_choice omitted, so the
// default auto applies). Sends {..., stream:true} plus `reasoning_effort`
// whenever opts.reasoningEffort is non-Auto (see reasoningEffortParam) —
// for every model, on every provider routed through this transport.
// A 400 naming the knob means the model truly lacks it: warn once via
// onWarning and retry without it. Parses the SSE event stream (see
// readSSEMessage).
// When the response has no SSE body (plain {ok, json()} mocks and other
// non-streaming payloads) it falls back to the original single-JSON parse,
// unchanged. Returns the raw assistant message: either final content or
// tool_calls the caller must execute, plus `usage`/`reasoning` only when
// the response actually carried them (usage: top-level `usage` on JSON or
// SSE final chunks; reasoning: message/delta reasoning metadata).
// Throws on HTTP error, empty reply, or a truncated stream (aborted
// connection / stall / missing [DONE]). A response flagged
// `finish_reason: "length"` instead returns normally with `truncated: true`
// (the loop fails its tool calls inline and continues).
// - Network throws and HTTP 429/500/502/503/504 are retried up to
//   MAX_RETRIES (10) with 1s→2s→4s… backoff, honoring Retry-After capped
//   at 30s.
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
  // providerId (ticket 08): hook attribution for the shared openai-chat
  // transport — the dispatcher passes its provider id, direct zen callers
  // omit it and default to "opencode-zen". Optional, wire-compatible.
  opts?: StreamCallbacks & EffortOpts & SummaryOpts & MediaOpts & { providerId?: string } & GoalToolOpts,
  errorLabel: string = "Zen"
): Promise<ChatResult> {
  const sleep = opts?.sleep ?? defaultSleep;
  const signal = opts?.signal ?? null;
  const hookProvider = opts?.providerId ?? "opencode-zen";
  // Context hooks (ticket 08) run once per call — not per retry — over a
  // per-POST copy; the loop transcript array is never mutated. Fail-open:
  // a throwing handler degrades to the untransformed messages. Zero-cost
  // when no hooks are registered: the apply path is skipped entirely (no
  // extra awaits per POST), so hook-free turns keep byte-identical timing.
  const contextHooks = contextTransformers();
  const outgoingHistory =
    contextHooks.length > 0 ? await applyContextTransform(contextHooks, history) : history;
  let lastError: unknown = null;
  // Server-authoritative unsupported: when a 400 names the effort knob, the
  // flag below drops it and the loop retries without it (once per call).
  let effortDropped = false;
  // Same contract for vision input (see src/media.ts): a 400 naming image
  // input retries once with descriptors stripped to prose markers.
  let mediaStripped = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Per-attempt model deadline: bounds the whole POST+stream (opencode
    // options.timeout parity). User cancel still wins; deadline aborts map
    // to retryable stall errors below, never to LoopCancelledError.
    const deadlineMs = modelTimeoutMs();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const attemptController = new AbortController();
    try {
      throwIfCancelled(signal);
      try {
        opts?.onPhase?.("thinking");
      } catch {
        // ignore observer errors
      }
      const effortParam = effortDropped
        ? undefined
        : reasoningEffortParam(opts?.reasoningEffort, model);
      const summaryOpts = opts as SummaryOpts | undefined;
      const mediaMode =
        (opts as MediaOpts | undefined)?.stripMedia === true || mediaStripped
          ? "strip"
          : "send";
      // Stable-prefix split (prompt-cache architecture): history[0]'s env
      // tail becomes its own system message so the stable head + tools stay
      // byte-identical across POSTs for implicit prefix caching. Consecutive
      // system messages concatenate on every OpenAI-protocol server, so this
      // is content-neutral. No env tail (tests, old saves) → history passes
      // through untouched, byte-identical to before.
      // Media lowering runs after the split: histories without descriptors
      // lower byte-identically (lowerOpenAIContent returns the string as-is).
      const messages: unknown[] = splitSystemHead(outgoingHistory).map((m) => {
        const c = (m as { content?: unknown }).content;
        if (typeof c !== "string") return m;
        const lowered = lowerOpenAIContent(m.role, c, mediaMode);
        // Identity means untouched (no descriptors): keep the original ref
        // so media-free payloads stay byte-identical. Anything else
        // (stripped string or parts array) replaces the content.
        return lowered === c ? m : { ...m, content: lowered };
      });
      const payload: Record<string, unknown> = {
        model,
        messages,
        stream: true,
      };
      // Compaction path only: tools disabled means NO `tools` key at all
      // (asserted in tests); the normal loop always sends the schema —
      // builtins plus extension-registered custom tools, so the model can
      // discover and call them exactly like builtins. update_goal rides
      // along only for live goal turns (includeUpdateGoal, set per POST by
      // the runAgenticLoop* entry points) — otherwise the model cannot
      // misuse what it cannot see.
      if (!summaryOpts?.disableTools) {
        payload["tools"] =
          (opts as GoalToolOpts | undefined)?.includeUpdateGoal === false
            ? chatToolDefinitions(false)
            : allToolDefinitions();
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
      // Base headers per provider: Zen sends the official-client identity
      // (`User-Agent: opencode/*` + `x-opencode-session`/`x-opencode-request`)
      // so free `*-free` models get quota instead of 429 FreeUsageLimitError
      // or 400 MissingSessionID. Session is stable per process, request is
      // fresh per POST attempt. Other openai-chat providers keep the legacy
      // shape byte-identical. Anonymous-safe everywhere: no key omits
      // Authorization (never `Bearer `). Pre-request hooks below can still
      // override/delete any key (string sets, null/undefined deletes).
      const baseHeaders: Record<string, string> =
        hookProvider === "opencode-zen"
          ? zenHeaders(apiKey, { requestId: zenRequestId() })
          : {
              "Content-Type": "application/json",
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            };
      // Pre-request hooks (ticket 08) run per POST attempt: payload
      // replacement must be a record (else ignored — downstream JSON/fetch
      // handling is never bypassed); header merge honors deletions.
      // Zero-cost when unregistered (see context hooks above).
      const preHooks = beforeRequestInterceptors();
      const outgoing =
        preHooks.length > 0
          ? await applyBeforeRequest(preHooks, {
              provider: hookProvider,
              model,
              url: endpoint,
              payload,
              headers: { ...baseHeaders },
            })
          : {
              payload,
              headers: { ...baseHeaders },
            };
      // Forward user cancel into the per-attempt controller, then arm the
      // model deadline on the same controller.
      if (signal) {
        if (signal.aborted) throw new LoopCancelledError();
        signal.addEventListener("abort", () => {
          try {
            attemptController.abort();
          } catch {
            // ignore
          }
        }, { once: true });
      }
      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          attemptController.abort();
        } catch {
          // ignore
        }
      }, deadlineMs);
      try {
        (timeoutId as unknown as { unref?: () => void }).unref?.();
      } catch {
        // ignore — environments without unref proceed regardless
      }
      const res = await fetch(endpoint, {
        method: "POST",
        // Anonymous-capable providers (Kilo free models) omit Authorization
        // when no key is configured — never an empty `Bearer `. Keyed
        // providers always pass a key (gated by providerNeedsKey), so their
        // behavior is unchanged.
        headers: outgoing.headers,
        body: JSON.stringify(outgoing.payload),
        signal: attemptController.signal,
      });
      // Post-response observers (ticket 08): every resolved POST (ok and
      // HTTP-error alike), fail-open — never break the turn. Zero-cost when
      // unregistered (the header snapshot is only built for live observers).
      const postHooks = afterResponseObservers();
      if (postHooks.length > 0) {
        await notifyAfterResponse(postHooks, {
          provider: hookProvider,
          model,
          url: endpoint,
          status: res.status,
          ok: res.ok,
          headers: snapshotResponseHeaders(res),
        });
      }
      if (!res.ok) {
        const errText = await safeErrorText(res);
        // The server is the authority on vision support: a 400 naming
        // image input means this model/deployment takes no images — warn,
        // strip descriptors to markers, and retry without them (once per
        // call). Checked before effort so a joint rejection still strips.
        if (
          res.status === 400 &&
          !mediaStripped &&
          (opts as MediaOpts | undefined)?.stripMedia !== true &&
          historyHasMedia(outgoingHistory) &&
          isImageRejection(errText)
        ) {
          mediaStripped = true;
          try {
            opts?.onWarning?.(
              `image input is not supported by ${model} — continuing without images`
            );
          } catch {
            // ignore observer errors
          }
          throwIfCancelled(signal);
          if (timeoutId) clearTimeout(timeoutId);
          continue;
        }
        // The server is the authority on effort support: a 400 naming the
        // knob means this model/deployment has no such control — warn,
        // drop the knob, and retry without it (setting kept). Any other
        // 400 keeps failing loudly below.
        if (
          res.status === 400 &&
          effortParam !== undefined &&
          !effortDropped &&
          isEffortRejection(errText)
        ) {
          effortDropped = true;
          try {
            opts?.onWarning?.(
              `reasoning effort "${effortParam}" is not supported by ${model} — continuing without it`
            );
          } catch {
            // ignore observer errors
          }
          throwIfCancelled(signal);
          if (timeoutId) clearTimeout(timeoutId);
          continue;
        }
        const err = new Error(`${errorLabel} HTTP ${res.status}: ${errText.slice(0, 300)}`);
        if (!RETRYABLE_STATUS.has(res.status)) {
          if (timeoutId) clearTimeout(timeoutId);
          throw err;
        }
        if (attempt < MAX_RETRIES) {
          throwIfCancelled(signal);
          const delay = getRetryDelay(attempt, res);
          try {
            opts?.onPhase?.("retry", `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (HTTP ${res.status})`);
          } catch {
            // ignore
          }
          if (timeoutId) clearTimeout(timeoutId);
          await sleep(delay);
          throwIfCancelled(signal);
          lastError = err;
          continue;
        }
        if (timeoutId) clearTimeout(timeoutId);
        throw err;
      }
      if (!hasStreamBody(res)) {
        const data = (await (res as unknown as { json: () => Promise<unknown> }).json()) as {
          usage?: unknown;
          choices?: Array<{
            message?: { content?: string | null; tool_calls?: ToolCall[] };
            finish_reason?: unknown;
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
        if (data?.choices?.[0]?.finish_reason === "length") result.truncated = true;
        const usage = parseUsage(data?.usage);
        if (usage !== undefined) result.usage = usage;
        const reasoning = parseReasoningLabel(msg);
        if (reasoning !== undefined) result.reasoning = reasoning;
        if (timeoutId) clearTimeout(timeoutId);
        return result;
      }
      try {
        const streamed = await readSSEMessage(res, { ...opts, signal: attemptController.signal });
        if (timeoutId) clearTimeout(timeoutId);
        return streamed;
      } catch (streamErr) {
        if (timeoutId) clearTimeout(timeoutId);
        throw streamErr;
      }
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);
      // User cancel wins over deadline: only the user's own signal maps to
      // LoopCancelledError. A deadline abort surfaces as a retryable stall.
      if (signal?.aborted) throw new LoopCancelledError();
      if (timedOut && !(e instanceof Error && e.message.startsWith(`${errorLabel} HTTP`))) {
        const deadlineErr = new Error(
          `Truncated stream from model (stall: no output for ${deadlineMs}ms — model deadline; resend to retry).`
        );
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, undefined);
          try {
            opts?.onPhase?.(
              "retry",
              `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (model deadline ${deadlineMs}ms)`
            );
          } catch {
            // ignore
          }
          try {
            await sleep(delay);
          } catch {
            // a failing sleep must not mask the original error
          }
          lastError = deadlineErr;
          throwIfCancelled(signal);
          continue;
        }
        throw deadlineErr;
      }
      // Cancellations (Ctrl+C / AbortSignal) are final: never retry, never
      // reframe — propagate so the caller can roll back + show (cancelled).
      if (isCancelError(e)) throw new LoopCancelledError();
      // HTTP failures already handled above (retry or fail-fast): rethrow
      // without treating them as retryable network errors.
      if (e instanceof Error && e.message.startsWith(`${errorLabel} HTTP`)) throw e;
      // Empty replies are permanent: never retry, surface immediately.
      if (e instanceof Error && e.message.startsWith("Empty reply")) {
        throw e;
      }
      // Truncated streams: stall timeouts ride the normal network backoff
      // (opencode parity — SSE read timed out is retryable); non-stall
      // aborts (missing [DONE]) are permanent — the streamed partial, if
      // any, is preserved on display and the turn rolls back.
      if (e instanceof Error && e.message.startsWith("Truncated stream")) {
        if (!isStallError(e)) throw e;
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, undefined);
          try {
            opts?.onPhase?.(
              "retry",
              `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (${e.message.slice(0, 120)})`
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
          throwIfCancelled(signal);
          continue;
        }
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

// Responses-family chat POST with tools attached (tool_choice omitted, so
// the default auto applies). Sends {model, instructions?, input, stream:true}
// plus `reasoning: {effort}` whenever opts.reasoningEffort is non-Auto (see
// responsesEffortParam) — for every responses model on opencode-zen.
// A 400 naming the knob means the model truly lacks it: warn once via
// onWarning and retry without it. Parses the Responses SSE event stream
// (see readResponsesSSEMessage in adapters.ts).
// Retry/rollback/hook/error-label contract mirrors chatCompletion exactly:
// network throws and HTTP 429/500/502/503/504 retry up to MAX_RETRIES with
// the same backoff; other 4xx fail fast as `{errorLabel} HTTP {status}`;
// empty replies and truncated streams (no response.completed) throw
// permanently; status "incomplete" returns with `truncated: true`.
// Callers must roll back the user turn on failure (see App submit).
export async function chatCompletionResponses(
  endpoint: string,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  // providerId (ticket 08): hook attribution for the responses transport —
  // the dispatcher passes its provider id, direct callers omit it and
  // default to "opencode-zen". Optional, wire-compatible.
  opts?: StreamCallbacks & EffortOpts & SummaryOpts & MediaOpts & { providerId?: string } & GoalToolOpts,
  errorLabel: string = "Zen"
): Promise<ChatResult> {
  const sleep = opts?.sleep ?? defaultSleep;
  const signal = opts?.signal ?? null;
  const hookProvider = opts?.providerId ?? "opencode-zen";
  const contextHooks = contextTransformers();
  const outgoingHistory =
    contextHooks.length > 0 ? await applyContextTransform(contextHooks, history) : history;
  let lastError: unknown = null;
  // Server-authoritative unsupported: when a 400 names the reasoning knob,
  // the flag below drops it and the loop retries without it (once per call).
  let effortDropped = false;
  // Same contract for vision input: a 400 naming image input retries once
  // with descriptors stripped to prose markers.
  let mediaStripped = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      throwIfCancelled(signal);
      try {
        opts?.onPhase?.("thinking");
      } catch {
        // ignore observer errors
      }
      const effortParam = effortDropped
        ? undefined
        : responsesEffortParam(opts?.reasoningEffort);
      const summaryOpts = opts as SummaryOpts | undefined;
      const mediaMode =
        (opts as MediaOpts | undefined)?.stripMedia === true || mediaStripped
          ? "strip"
          : "send";
      const converted = buildResponsesBody(outgoingHistory, model, {
        // Compaction path only: tools disabled means NO `tools` key at all;
        // the normal loop always sends the schema so the model can discover
        // and call tools exactly like builtins. update_goal rides along only
        // for live goal turns (includeUpdateGoal); otherwise hidden.
        includeTools: summaryOpts?.disableTools === true ? false : undefined,
        includeUpdateGoal:
          (opts as GoalToolOpts | undefined)?.includeUpdateGoal,
        stripMedia: mediaMode === "strip" ? true : undefined,
      });
      // mediaMode is recomputed per attempt, so the strip retry below
      // rebuilds the body in strip mode on its next pass through the loop.
      const payload: Record<string, unknown> = {
        model: converted.model,
        ...(converted.instructions !== undefined
          ? { instructions: converted.instructions }
          : {}),
        input: converted.input,
        stream: true,
      };
      if (converted.tools !== undefined) payload["tools"] = converted.tools;
      // Compaction path only: cap output (responses kind uses
      // max_output_tokens, same name as the cap option).
      if (
        typeof summaryOpts?.maxOutputTokens === "number" &&
        Number.isFinite(summaryOpts.maxOutputTokens) &&
        summaryOpts.maxOutputTokens > 0
      ) {
        payload["max_output_tokens"] = Math.floor(summaryOpts.maxOutputTokens);
      }
      if (effortParam !== undefined) payload["reasoning"] = { effort: effortParam };
      const preHooks = beforeRequestInterceptors();
      const outgoing =
        preHooks.length > 0
          ? await applyBeforeRequest(preHooks, {
              provider: hookProvider,
              model,
              url: endpoint,
              payload,
              headers: { ...zenHeaders(apiKey, { requestId: zenRequestId() }) },
            })
          : {
              payload,
              headers: { ...zenHeaders(apiKey, { requestId: zenRequestId() }) },
            };
      const res = await fetch(endpoint, {
        method: "POST",
        // Anonymous-capable: zenHeaders omits Authorization when no key —
        // never an empty `Bearer `.
        headers: outgoing.headers,
        body: JSON.stringify(outgoing.payload),
        ...(signal ? { signal } : {}),
      });
      const postHooks = afterResponseObservers();
      if (postHooks.length > 0) {
        await notifyAfterResponse(postHooks, {
          provider: hookProvider,
          model,
          url: endpoint,
          status: res.status,
          ok: res.ok,
          headers: snapshotResponseHeaders(res),
        });
      }
      if (!res.ok) {
        const errText = await safeErrorText(res);
        if (
          res.status === 400 &&
          !mediaStripped &&
          (opts as MediaOpts | undefined)?.stripMedia !== true &&
          historyHasMedia(outgoingHistory) &&
          isImageRejection(errText)
        ) {
          mediaStripped = true;
          try {
            opts?.onWarning?.(
              `image input is not supported by ${model} — continuing without images`
            );
          } catch {
            // ignore observer errors
          }
          throwIfCancelled(signal);
          continue;
        }
        if (
          res.status === 400 &&
          effortParam !== undefined &&
          !effortDropped &&
          isResponsesEffortRejection(errText)
        ) {
          effortDropped = true;
          try {
            opts?.onWarning?.(
              `reasoning effort "${effortParam}" is not supported by ${model} — continuing without it`
            );
          } catch {
            // ignore observer errors
          }
          throwIfCancelled(signal);
          continue;
        }
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
        // Non-streaming responses object (no chat `choices` shape here —
        // parseResponsesObject reads the Responses `output` array).
        const data: unknown = await (res as unknown as { json: () => Promise<unknown> }).json();
        return parseResponsesObject(data);
      }
      return await readResponsesSSEMessage(res, opts);
    } catch (e) {
      if (isCancelError(e) || signal?.aborted) throw new LoopCancelledError();
      if (e instanceof Error && e.message.startsWith(`${errorLabel} HTTP`)) throw e;
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
// tool_calls (uncapped by default; explicit opts.maxSteps still caps), append
// the assistant message, execute each tool locally, append {role:'tool'}
// results, resend.
// Streaming: each POST streams SSE tokens (onToken gets the growing text,
// onPhase reports thinking|streaming|tool|retry|done, onToolDelta fires when
// a tool name first appears mid-stream). A model that returns no tool_calls
// ends the loop (graceful fallback for models without tool support). Tool
// errors are results the model sees — NOTHING is rolled back here; only a
// POST failure (HTTP/network/empty/stalled-stream) throws (and the caller rolls
// back the user turn, as before; the caller preserves any streamed partial
// on display). A length-truncated response (`finish_reason: "length"`) does
// not throw: the loop fails each carried tool call inline with a repair
// error and continues to the next model round.
// Per-POST goal-tool visibility: update_goal rides the schema only while a
// live goal turn is engaged (guarded — a throwing accessor reads as no
// goal, exactly like the loop's readLiveGoal). Evaluated per POST so a goal
// set, paused, or cleared mid-turn reshapes the very next schema; callers
// without a goal hook (compaction, web, tests) read as no-goal and send the
// legacy full surface only when they leave includeUpdateGoal undefined.
function isGoalTurnLive(opts?: AgenticOpts): boolean {
  try {
    return opts?.goal?.getGoal?.()?.active === true;
  } catch {
    return false;
  }
}

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
        includeUpdateGoal: isGoalTurnLive(opts),
      }),
    history,
    opts
  );
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
  // Three layers: src/system.ts base one-liner + repo AGENTS.md overlay +
  // extension prompt hints (ticket 06). The hints ride the existing assembly
  // — no parallel prompt pipeline: when none are registered the result is
  // byte-identical to the two-layer form.
  const extra = loadAgentsPrompt(cwd);
  const base = extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT;
  const hints = getExtensionPromptHints();
  if (hints.length === 0) return base;
  return `${base}\n\n## Extension hints\n${hints.map((h) => `- ${h}`).join("\n")}`;
}

// ---- Multi-provider dispatch (adapter boundary per POST) ----
// Internal history stays OpenAI-shaped; translation happens here per POST.
// openai-chat kind reuses chatCompletion with the provider's error label
// (zen "Zen" stays byte-identical).
// Effort mapping per kind: reasoning_effort on openai-chat (every
// provider), thinking budgets on anthropic-messages, thinkingLevel on
// gemini-generate. Auto omits the knob everywhere.

export type ProviderChatOpts = StreamCallbacks &
  EffortOpts &
  SummaryOpts &
  GoalToolOpts &
  MediaOpts & {
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
  opts?: StreamCallbacks & EffortOpts & SummaryOpts & GoalToolOpts & MediaOpts
): Promise<ChatResult> {
  const sleep = opts?.sleep ?? defaultSleep;
  const signal = opts?.signal ?? null;
  // Ticket 08: same per-POST hook contract as the openai-chat path above
  // (context once per call, pre/post per attempt, all fail-open, zero-cost
  // when unregistered).
  const anthropicContextHooks = contextTransformers();
  const outgoingHistory =
    anthropicContextHooks.length > 0
      ? await applyContextTransform(anthropicContextHooks, history)
      : history;
  let lastError: unknown = null;
  // Same server-authoritative unsupported contract as the openai-chat path:
  // a 400 naming the thinking knob drops it for the rest of the call.
  let anthropicEffortDropped = false;
  // Vision fallback (see src/media.ts): a 400 naming image input retries
  // once with descriptors stripped to markers.
  let anthropicMediaStripped = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      throwIfCancelled(signal);
      try {
        opts?.onPhase?.("thinking");
      } catch {
        // ignore
      }
      const summaryOpts = opts as SummaryOpts | undefined;
      const base = buildAnthropicBody(outgoingHistory, model, {
        includeTools: !summaryOpts?.disableTools,
        includeUpdateGoal: (opts as GoalToolOpts | undefined)?.includeUpdateGoal !== false,
        stripMedia:
          (opts as MediaOpts | undefined)?.stripMedia === true || anthropicMediaStripped,
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
      // /effort maps to the native thinking budget (Auto omits it; a cap too
      // small for the 1024 minimum omits it too — see anthropicThinkingFor).
      const anthropicEffort = anthropicEffortDropped
        ? undefined
        : reasoningEffortParam(opts?.reasoningEffort, model);
      const anthropicBudget =
        anthropicEffort !== undefined
          ? anthropicThinkingFor(
              anthropicEffort,
              typeof body["max_tokens"] === "number"
                ? body["max_tokens"]
                : ANTHROPIC_MAX_TOKENS
            )
          : undefined;
      if (anthropicBudget !== undefined) {
        body["thinking"] = { type: "enabled", budget_tokens: anthropicBudget };
      }
      const anthropicPreHooks = beforeRequestInterceptors();
      const outgoing =
        anthropicPreHooks.length > 0
          ? await applyBeforeRequest(anthropicPreHooks, {
              provider: "anthropic",
              model,
              url: "https://api.anthropic.com/v1/messages",
              payload: body,
              headers: anthropicHeaders(apiKey),
            })
          : { payload: body, headers: anthropicHeaders(apiKey) };
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: outgoing.headers,
        body: JSON.stringify(outgoing.payload),
        ...(signal ? { signal } : {}),
      });
      const anthropicPostHooks = afterResponseObservers();
      if (anthropicPostHooks.length > 0) {
        await notifyAfterResponse(anthropicPostHooks, {
          provider: "anthropic",
          model,
          url: "https://api.anthropic.com/v1/messages",
          status: res.status,
          ok: res.ok,
          headers: snapshotResponseHeaders(res),
        });
      }
      if (!res.ok) {
        const errText = await safeErrorText(res);
        // Vision fallback (see src/media.ts): a 400 naming image input
        // retries once with descriptors stripped to markers.
        if (
          res.status === 400 &&
          !anthropicMediaStripped &&
          (opts as MediaOpts | undefined)?.stripMedia !== true &&
          historyHasMedia(outgoingHistory) &&
          isImageRejection(errText)
        ) {
          anthropicMediaStripped = true;
          try {
            opts?.onWarning?.(
              `image input is not supported by ${model} — continuing without images`
            );
          } catch {
            // ignore observer errors
          }
          throwIfCancelled(signal);
          continue;
        }
        if (
          res.status === 400 &&
          anthropicBudget !== undefined &&
          !anthropicEffortDropped &&
          isEffortRejection(errText)
        ) {
          anthropicEffortDropped = true;
          try {
            opts?.onWarning?.(
              `reasoning effort "${anthropicEffort}" is not supported by ${model} — continuing without it`
            );
          } catch {
            // ignore observer errors
          }
          throwIfCancelled(signal);
          continue;
        }
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
  opts?: StreamCallbacks & EffortOpts & SummaryOpts & GoalToolOpts & MediaOpts
): Promise<ChatResult> {
  const sleep = opts?.sleep ?? defaultSleep;
  const signal = opts?.signal ?? null;
  // Ticket 08: same per-POST hook contract as the openai-chat path above
  // (context once per call, pre/post per attempt, all fail-open, zero-cost
  // when unregistered).
  const geminiContextHooks = contextTransformers();
  const outgoingHistory =
    geminiContextHooks.length > 0
      ? await applyContextTransform(geminiContextHooks, history)
      : history;
  let lastError: unknown = null;
  // Same server-authoritative unsupported contract as the other paths: a
  // 400 naming the thinking knob drops it for the rest of the call.
  let geminiEffortDropped: boolean = false;
  // Vision fallback (see src/media.ts): a 400 naming image input retries
  // once with descriptors stripped to markers.
  let geminiMediaStripped: boolean = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      throwIfCancelled(signal);
      try {
        opts?.onPhase?.("thinking");
      } catch {
        // ignore
      }
      const summaryOpts = opts as SummaryOpts | undefined;
      const body = buildGeminiBody(outgoingHistory, model, {
        includeTools: !summaryOpts?.disableTools,
        includeUpdateGoal: (opts as GoalToolOpts | undefined)?.includeUpdateGoal !== false,
        ...(typeof summaryOpts?.maxOutputTokens === "number" &&
        Number.isFinite(summaryOpts.maxOutputTokens) &&
        summaryOpts.maxOutputTokens > 0
          ? { maxOutputTokens: Math.floor(summaryOpts.maxOutputTokens) }
          : {}),
        stripMedia:
          (opts as MediaOpts | undefined)?.stripMedia === true || geminiMediaStripped,
      });
      // /effort maps to the native thinkingLevel (Auto omits it; Max rides
      // high, the deepest level the API offers). Merged into
      // generationConfig so a compaction maxOutputTokens cap survives.
      const geminiEffort = geminiEffortDropped
        ? undefined
        : reasoningEffortParam(opts?.reasoningEffort, model);
      const geminiLevel =
        geminiEffort !== undefined ? geminiThinkingLevelFor(geminiEffort) : undefined;
      if (geminiLevel !== undefined) {
        const gc =
          typeof body.generationConfig === "object" && body.generationConfig !== null
            ? { ...(body.generationConfig as Record<string, unknown>) }
            : {};
        body.generationConfig = {
          ...gc,
          thinkingConfig: { thinkingLevel: geminiLevel },
        };
      }
      const geminiPreHooks = beforeRequestInterceptors();
      const outgoing =
        geminiPreHooks.length > 0
          ? await applyBeforeRequest(geminiPreHooks, {
              provider: "google-gemini",
              model,
              url: geminiChatUrl(model),
              payload: body as unknown as Record<string, unknown>,
              headers: geminiHeaders(apiKey),
            })
          : { payload: body as unknown as Record<string, unknown>, headers: geminiHeaders(apiKey) };
      const res = await fetch(geminiChatUrl(model), {
        method: "POST",
        headers: outgoing.headers,
        body: JSON.stringify(outgoing.payload),
        ...(signal ? { signal } : {}),
      });
      const geminiPostHooks = afterResponseObservers();
      if (geminiPostHooks.length > 0) {
        await notifyAfterResponse(geminiPostHooks, {
          provider: "google-gemini",
          model,
          url: geminiChatUrl(model),
          status: res.status,
          ok: res.ok,
          headers: snapshotResponseHeaders(res),
        });
      }
      if (!res.ok) {
        const errText = await safeErrorText(res);
        // Vision fallback (see src/media.ts): a 400 naming image input
        // retries once with descriptors stripped to markers.
        if (
          res.status === 400 &&
          !geminiMediaStripped &&
          (opts as MediaOpts | undefined)?.stripMedia !== true &&
          historyHasMedia(outgoingHistory) &&
          isImageRejection(errText)
        ) {
          geminiMediaStripped = true;
          try {
            opts?.onWarning?.(
              `image input is not supported by ${model} — continuing without images`
            );
          } catch {
            // ignore observer errors
          }
          throwIfCancelled(signal);
          continue;
        }
        if (
          res.status === 400 &&
          geminiLevel !== undefined &&
          !geminiEffortDropped &&
          isEffortRejection(errText)
        ) {
          geminiEffortDropped = true;
          try {
            opts?.onWarning?.(
              `reasoning effort "${geminiEffort}" is not supported by ${model} — continuing without it`
            );
          } catch {
            // ignore observer errors
          }
          throwIfCancelled(signal);
          continue;
        }
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
            headers: outgoing.headers,
            body: JSON.stringify(outgoing.payload),
            ...(signal ? { signal } : {}),
          });
          if (geminiPostHooks.length > 0) {
            await notifyAfterResponse(geminiPostHooks, {
              provider: "google-gemini",
              model,
              url: geminiGenerateUrl(model),
              status: res2.status,
              ok: res2.ok,
              headers: snapshotResponseHeaders(res2),
            });
          }
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
// error label; anthropic/gemini go through their adapters; Zen
// responses-family models (muse-spark-*) ride chatCompletionResponses.
// Effort rides every kind: reasoning_effort on openai-chat (all providers,
// all models), reasoning.effort on responses, thinking budgets on
// anthropic-messages, thinkingLevel on gemini-generate. Auto omits the knob
// everywhere; a model that truly lacks it 400s and the transports above
// retry once without it.
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
  // Effort passes through for every openai-chat provider (zen, OpenAI,
  // DeepSeek, Mistral, Kilo, openai-compatible, local runtimes): the shared
  // transport sends reasoning_effort when non-Auto and falls back without it
  // on a server rejection. Anthropic/Gemini kinds receive opts directly
  // above and map effort to their native thinking knobs.
  const effortOpts: EffortOpts =
    opts?.reasoningEffort !== undefined
      ? { reasoningEffort: opts.reasoningEffort }
      : {};
  const chatOpts = {
    onToken: opts?.onToken,
    onPhase: opts?.onPhase,
    onToolDelta: opts?.onToolDelta,
    onWarning: opts?.onWarning,
    onThinking: opts?.onThinking,
    sleep: opts?.sleep,
    signal: opts?.signal,
    // Ticket 08: provider-hook attribution for the shared openai-chat
    // transport (otherwise every kind would report "opencode-zen").
    providerId: provider,
    ...effortOpts,
    // Compaction path only (undefined for the normal loop → tools sent).
    ...(opts?.disableTools !== undefined ? { disableTools: opts.disableTools } : {}),
    // Goal-tool visibility (undefined for compaction/summary callers →
    // legacy full surface; the loop entry points always set it per POST).
    ...(opts?.includeUpdateGoal !== undefined
      ? { includeUpdateGoal: opts.includeUpdateGoal }
      : {}),
    ...(opts?.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
    // Media strip (compaction/summarization callers set it; the normal
    // loop leaves it undefined → images expand natively).
    ...(opts?.stripMedia !== undefined ? { stripMedia: opts.stripMedia } : {}),
  };
  // Kilo rides the shared OpenAI-chat path (streaming, tool reconstruction,
  // retry, effort with server-rejection fallback) with its registry
  // endpoint + label; HTTP failures are reframed into concise actionable
  // Kilo errors (see src/kilo.ts).
  if (provider === "kilo") {
    try {
      return await chatCompletion(endpoint, apiKey, model, history, chatOpts, providerLabel(provider));
    } catch (e) {
      throw normalizeKiloChatError(e, apiKey);
    }
  }
  // Zen responses-family (muse-spark-*, free contributor tiers included):
  // same chatOpts surface (effort/tools/compaction/media/hooks), Responses
  // wire shape + /responses endpoint. Only opencode-zen serves this family;
  // every other provider keeps the chat path below byte-identical.
  if (provider === "opencode-zen" && isZenResponsesModel(model)) {
    return chatCompletionResponses(
      responsesEndpointFor(endpoint),
      apiKey,
      model,
      history,
      chatOpts,
      providerLabel(provider)
    );
  }
  return chatCompletion(
    endpoint,
    apiKey,
    model,
    history,
    chatOpts,
    providerLabel(provider)
  );
}

// Turn-continuation seam (ticket 03): the ad-hoc turn-end guards used to
// live as two inline blocks where the loop commits final text. They are now
// entries in ONE continuation chain evaluated before final-text commit —
// today's behavior is preserved exactly, and future gates get a home
// instead of a parallel system.
//
// Attachment point for future gates (e.g. P5-3 hooks): add a TurnEndGate
// function to TURN_END_GATES, in evaluation order. A gate sees the model's
// final-text attempt plus a read-only TurnEndContext and returns:
// - { action: "pass" } → the next gate runs (no history change);
// - { action: "continue", assistantText, followUp } → the attempt is
//   recorded and a user follow-up re-enters the loop (assistant/tool
//   pairing stays valid: only assistant(text) + user messages are added);
// - { action: "end", finalText } → the turn ends with this text committed.
// The first non-pass gate wins; when every gate passes, the attempt commits
// unchanged. Gates must never throw across the seam: input validation and
// state reads stay inside each gate, and observer callbacks stay at the
// single commit point in runLoopWithChat below.
export type { TurnEndContext, TurnEndDecision, TurnEndGate } from "./agent/gates.js";
export type { OpenTodo, StopContext, StopDecision, StopGoal, StopJudge } from "./agent/gates.js";
export {
  decideTurnEnd,
  decideTurnEndAfterGates,
  evaluateTurnEnd,
  isCodePath,
  MAX_TODO_ROUNDS,
  MAX_VERIFY_ROUNDS,
  todoCompletionGate,
  TURN_END_GATES,
  verificationGate,
} from "./agent/gates.js";
// Parallel independent tool calls: batch PLANNING lives in src/scheduler.ts
// (effect metadata + conflict rules, no per-tool branches); this module only
// plans via planToolBatches below and executes (serial singletons in program
// order, disjoint batches concurrently, results committed in call order).
//
// Parallel-safe = batchable reads plus disjoint-file writes (see TOOL_EFFECTS
// and canonicalFileKey in scheduler.ts). Approvals for batched writes resolve
// serially in call order before any member executes. Excluded on purpose:
// - bash mutates/spawns with an unbounded footprint (it can touch anything,
//   so no footprint check could clear it) — always a singleton;
// - ask_question blocks on a UI modal (parallel prompts make no sense);
// - todowrite/todo_update share module-global todo state (read-modify-write
//   races); todo_get is pure but sub-millisecond, so batching it buys
//   nothing and it stays serial too.
import { planBatches, type PlannedToolCall } from "./scheduler.js";
export type { PlannedToolCall } from "./scheduler.js";

// Partition one assistant message's tool_calls into commit batches —
// effect-aware (see planBatches), preserving program order and the commit
// contract the turn-continuation seam defines (one transcript entry per
// call, in order). Kept under this name/signature for callers and tests.
export function planToolBatches(calls: ToolCall[]): PlannedToolCall<ToolCall>[][] {
  return planBatches(calls);
}

import { runLoopWithChat } from "./agent/loop.js";
export { runLoopWithChat } from "./agent/loop.js";
export {
  DEFAULT_MAX_TOTAL_TOOL_CALLS,
  DEFAULT_TOOL_TIMEOUT_MS,
  executeWithTimeout,
  emptyResponseFollowUp,
  isEmptyReplyError,
  MAX_EMPTY_ROUNDS,
  resolveMaxTotalToolCalls,
  resolveToolTimeoutMs,
} from "./agent/loop.js";
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
        includeUpdateGoal: isGoalTurnLive(opts),
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
    // Local runtimes: probe the loopback server (short timeout, never
    // throws) instead of a keyed /models fetch. Chat itself still flows
    // through the normal openai-chat path below.
    if (isLocalProviderId(provider)) {
      const res = await discoverLocalProvider(provider, { baseURL });
      return { models: res.models.map((m) => m.id), ok: res.ok };
    }
    if (provider === "kilo") {
      // Dynamic catalog via the Kilo gateway (anonymous when apiKey is "",
      // authenticated otherwise). TTL-cached inside src/kilo.ts; failures
      // return the offline placeholder uncached, exactly like other kinds.
      const res = await fetchKiloModelsWithStatus(apiKey);
      if (!res.ok) return { models: [...KILO_FALLBACK_MODELS], ok: false };
      return { models: res.models, ok: true };
    }
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
