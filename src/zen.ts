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
  needsApproval,
  validateAskQuestionArgs,
} from "./tools.js";

export { MAX_TOOL_STEPS };

export const DEFAULT_ENDPOINT =
  "https://opencode.ai/zen/v1/chat/completions";
export const MODELS_URL_DEFAULT = "https://opencode.ai/zen/v1/models";
export const DEFAULT_MODEL = "big-pickle";
export const SYSTEM_PROMPT = "You are a minimal helpful chatbot.";
export const AGENTS_CHAR_CAP = 12 * 1024;

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
// `reasoning` is present only when the response carried reasoning metadata
// (this client never sends a reasoning-effort parameter).
export type ChatResult = {
  content: string | null;
  tool_calls?: ToolCall[];
  usage?: Usage;
  reasoning?: string;
};

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

export type StreamCallbacks = {
  onToken?: (partialText: string) => void;
  onPhase?: (phase: Phase, detail?: string) => void;
  // Fired as soon as a streamed tool_call delta reveals its function name,
  // i.e. before the full call has arrived and execution starts.
  onToolDelta?: (name: string, index: number) => void;
  // Fired for nameless partial tool calls dropped at [DONE].
  onWarning?: (message: string) => void;
  // Injectable delay for retry backoff (defaults to setTimeout). Tests
  // inject an instant recorder so the suite never sleeps.
  sleep?: (ms: number) => Promise<void>;
};

export type AgenticOpts = StreamCallbacks & {
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

// Permission modes owned by the App session (header always shows the mode).
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
export async function fetchModels(
  endpoint: string,
  apiKey: string
): Promise<string[]> {
  try {
    const res = await fetch(modelsUrl(endpoint), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [...FALLBACK_MODELS];
    const data: unknown = await res.json();
    const entries: unknown = Array.isArray(data)
      ? data
      : (data as { data?: unknown })?.data;
    if (!Array.isArray(entries) || entries.length === 0) {
      return [...FALLBACK_MODELS];
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
    return picked.length > 0 ? picked : [...FALLBACK_MODELS];
  } catch {
    return [...FALLBACK_MODELS];
  }
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
// default auto applies). Sends {..., stream:true} and parses the SSE event
// stream (see readSSEMessage). When the response has no SSE body (plain
// {ok, json()} mocks and other non-streaming payloads) it falls back to
// the original single-JSON parse, unchanged. Returns the raw assistant
// message: either final content or tool_calls the caller must execute,
// plus `usage`/`reasoning` only when the response actually carried them
// (usage: top-level `usage` on JSON or SSE final chunks; reasoning: message/
// delta reasoning metadata — this client never sends a reasoning parameter).
// Throws on HTTP error, empty reply, or a truncated stream.
// - Network throws and HTTP 429/500/502/503/504 are retried up to 2 times
//   (3 attempts) with 1s->2s backoff, honoring Retry-After capped at 30s.
//   Each retry emits onPhase("retry", detail). Other 4xx fail fast with
//   the existing `Zen HTTP {status}` message.
// - Callers must roll back the user turn on failure (see App submit).
// Legacy `function_call` shape is intentionally ignored.
export async function chatCompletion(
  endpoint: string,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  opts?: StreamCallbacks
): Promise<ChatResult> {
  const sleep = opts?.sleep ?? defaultSleep;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      try {
        opts?.onPhase?.("thinking");
      } catch {
        // ignore observer errors
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages: history, tools: TOOL_DEFINITIONS, stream: true }),
      });
      if (!res.ok) {
        const errText = await safeErrorText(res);
        const err = new Error(`Zen HTTP ${res.status}: ${errText.slice(0, 300)}`);
        if (!RETRYABLE_STATUS.has(res.status)) throw err;
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, res);
          try {
            opts?.onPhase?.("retry", `attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (HTTP ${res.status})`);
          } catch {
            // ignore
          }
          await sleep(delay);
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
      // HTTP failures already handled above (retry or fail-fast): rethrow
      // without treating them as retryable network errors.
      if (e instanceof Error && e.message.startsWith("Zen HTTP")) throw e;
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

// Agentic loop for one user turn: send → while the response carries
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
  const execute = opts?.execute ?? executeTool;
  const maxSteps = opts?.maxSteps ?? MAX_TOOL_STEPS;
  for (let step = 0; ; step++) {
    const msg = await chatCompletion(endpoint, apiKey, model, history, {
      onToken: opts?.onToken,
      onPhase: opts?.onPhase,
      onToolDelta: opts?.onToolDelta,
      onWarning: opts?.onWarning,
      sleep: opts?.sleep,
    });
    // Surface per-POST usage/reasoning to the caller (session totals live
    // in the App). Observer errors never break the loop.
    if (msg.usage !== undefined) {
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
        const result = `Error: invalid JSON arguments for tool ${name}`;
        history.push({ role: "tool", tool_call_id: call?.id ?? "", content: result });
        opts?.onToolActivity?.(describeToolCall(name, {}), result, true);
        continue;
      }
      const result = await runOneTool(call, parsed, opts, execute);
      const isError = typeof result === "string" && result.startsWith("Error");
      history.push({ role: "tool", tool_call_id: call?.id ?? "", content: result });
      opts?.onToolActivity?.(describeToolCall(name, parsed), result, isError);
    }
  }
}

// Execute one parsed tool call through the permission + ask_question gates.
// Everything returns a result string fed back to the model — never throws:
// - ask_question never needs approval; without an askUser hook it resolves
//   to "Error: ask_question has no UI hook".
// - write/edit/bash consult the approve hook when one is provided; a "no"
//   resolves to "Error: denied by user: <tool>". Without a hook every tool
//   executes immediately (read-only tools always auto-execute).
async function runOneTool(
  call: ToolCall,
  parsed: Record<string, unknown>,
  opts: AgenticOpts | undefined,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
): Promise<string> {
  const name = call?.function?.name ?? "(unknown)";
  if (name === "ask_question") {
    return runAskQuestion(parsed, opts?.askUser);
  }
  if (opts?.approve && needsApproval(name)) {
    let decision: ApprovalDecision;
    try {
      decision = await opts.approve(name, parsed);
    } catch {
      decision = "no";
    }
    if (decision === "no") {
      return `Error: denied by user: ${name}`;
    }
    // "once" runs this call; "always" runs it too (the caller caches the
    // always-allowed set session-wide so later calls skip the prompt).
  }
  return execute(name, parsed);
}

async function runAskQuestion(
  parsed: Record<string, unknown>,
  askUser: AgenticOpts["askUser"]
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
  const extra = loadAgentsPrompt(cwd);
  return extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT;
}
