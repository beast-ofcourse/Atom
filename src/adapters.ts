// Adapter boundary for non-OpenAI kinds (anthropic-messages,
// gemini-generate). OpenAI-chat kind reuses zen.ts verbatim.
// Pure translation + SSE parsing; no zen runtime imports (type-only)
// so zen.ts can import this module without a runtime cycle.
//
// Normalized output matches zen ChatResult:
//   {content, tool_calls:[{id,function:{name,arguments}}], usage?}
// so runAgenticLoop/retry/rollback/status code is untouched.

import { TOOL_DEFINITIONS } from "./tools.js";
import {
  getProvider,
  modelsUrlForProvider,
  type ProviderId,
} from "./providers.js";
import type {
  ChatMessage,
  ChatResult,
  StreamCallbacks,
  ToolCall,
  Usage,
} from "./zen.js";

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_MAX_TOKENS = 4096;

type OpenAIToolDef = {
  type: string;
  function: { name: string; description: string; parameters: unknown };
};

function toolDefs(): OpenAIToolDef[] {
  return TOOL_DEFINITIONS as unknown as OpenAIToolDef[];
}

function parseArgsObject(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

import { ephemeralBreakpoint, assemblePrefix } from "./prompt-cache.js";

// ---- Anthropic request ----

export type AnthropicSystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: string };
};

export type AnthropicRequest = {
  model: string;
  max_tokens: number;
  // String form (legacy: no env tail to split — tests, old saves) or blocks
  // (stable head carries the cache breakpoint, dynamic env tail follows).
  system?: string | AnthropicSystemBlock[];
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: unknown;
    cache_control?: { type: string };
  }>;
  tool_choice?: { type: "auto" };
};

export function buildAnthropicBody(
  history: ChatMessage[],
  model: string,
  opts?: { includeTools?: boolean }
): AnthropicRequest {
  const systems: string[] = [];
  const messages: AnthropicRequest["messages"] = [];
  // Group consecutive tool messages into one user message with
  // multiple tool_result blocks (Anthropic convention).
  let pendingToolResults: Array<{
    type: "tool_result";
    tool_use_id: string;
    content: string;
  }> = [];
  function flushTools(): void {
    if (pendingToolResults.length === 0) return;
    messages.push({ role: "user", content: [...pendingToolResults] });
    pendingToolResults = [];
  }
  for (const m of history) {
    if (m.role === "system") {
      systems.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content,
      });
      continue;
    }
    flushTools();
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else {
      // assistant: text + tool_use blocks
      const am = m as {
        role: "assistant";
        content?: string | null;
        tool_calls?: ToolCall[];
      };
      const blocks: Array<Record<string, unknown>> = [];
      if (typeof am.content === "string" && am.content.length > 0) {
        blocks.push({ type: "text", text: am.content });
      }
      for (const tc of am.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: parseArgsObject(tc.function.arguments),
        });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      messages.push({ role: "assistant", content: blocks });
    }
  }
  flushTools();
  const includeTools = opts?.includeTools !== false;
  const body: AnthropicRequest = {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    messages,
  };
  // Compaction path (includeTools:false) omits `tools` + `tool_choice`
  // entirely — asserted in tests as "no `tools` key".
  if (includeTools) {
    const defs: NonNullable<AnthropicRequest["tools"]> = toolDefs().map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
    // Stable-prefix boundary (prompt-cache architecture): the env tail below
    // decides. With a split, the stable block + full tools array are
    // breakpointed (system head, then last tool — the two long-lived cache
    // entries); without one, the legacy string shape is preserved exactly.
    const joined = systems.join("\n\n");
    const prefix = systems.length > 0 ? assemblePrefix({ systemContent: joined }) : null;
    const dynamicTail = prefix?.dynamicSystem ?? null;
    const stableHead = prefix && dynamicTail !== null ? prefix.stableSystem : "";
    if (prefix !== null && dynamicTail !== null && stableHead.trim().length > 0) {
      body.system = [
        { type: "text", text: stableHead, cache_control: ephemeralBreakpoint() },
        { type: "text", text: dynamicTail },
      ];
      if (defs.length > 0) {
        defs[defs.length - 1]!.cache_control = ephemeralBreakpoint();
      }
    } else if (systems.length > 0) {
      body.system = joined;
    }
    body.tools = defs;
    body.tool_choice = { type: "auto" };
  } else if (systems.length > 0) {
    body.system = systems.join("\n\n");
  }
  return body;
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

// ---- Gemini request ----

// Gemini FunctionDeclaration parameters reject JSON-Schema keywords outside
// its subset — notably `additionalProperties` (HTTP 400: Unknown name
// "additionalProperties" at tools[...].function_declarations[...].parameters).
// TOOL_DEFINITIONS are OpenAI-canonical (every schema carries
// `additionalProperties: false`), so the GEMINI adapter strips the rejected
// keys here, recursively, at conversion time. Anthropic input_schema and
// OpenAI parameters accept them — those paths stay byte-identical, and the
// canonical schemas are never mutated.
const GEMINI_STRIPPED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
]);

function stripGeminiSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripGeminiSchemaKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (GEMINI_STRIPPED_SCHEMA_KEYS.has(k)) continue;
      out[k] = stripGeminiSchemaKeys(v);
    }
    return out;
  }
  return value;
}

export function geminiChatUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export function geminiGenerateUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

export function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

export type GeminiRequest = {
  system_instruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: "user" | "model"; parts: unknown[] }>;
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>;
  }>;
  generationConfig?: { maxOutputTokens?: number };
};

export function buildGeminiBody(
  history: ChatMessage[],
  _model: string,
  opts?: { includeTools?: boolean; maxOutputTokens?: number }
): GeminiRequest {
  const systems: string[] = [];
  for (const m of history) {
    if (m.role === "system") systems.push(m.content);
  }
  // tool_call_id -> function name (tool messages carry only the id).
  const nameById = new Map<string, string>();
  for (const m of history) {
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        if (tc.id) nameById.set(tc.id, tc.function.name);
      }
    }
  }
  const contents: GeminiRequest["contents"] = [];
  let pendingResponses: Array<Record<string, unknown>> = [];
  function flushResponses(): void {
    if (pendingResponses.length === 0) return;
    contents.push({ role: "user", parts: pendingResponses });
    pendingResponses = [];
  }
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      pendingResponses.push({
        functionResponse: {
          name: nameById.get(m.tool_call_id) ?? "unknown",
          response: { result: m.content },
        },
      });
      continue;
    }
    flushResponses();
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else {
      const am = m as {
        role: "assistant";
        content?: string | null;
        tool_calls?: ToolCall[];
      };
      const parts: unknown[] = [];
      if (typeof am.content === "string" && am.content.length > 0) {
        parts.push({ text: am.content });
      }
      for (const tc of am.tool_calls ?? []) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: parseArgsObject(tc.function.arguments),
          },
        });
      }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "model", parts });
    }
  }
  flushResponses();
  const includeTools = opts?.includeTools !== false;
  const body: GeminiRequest = {
    contents,
  };
  // Compaction path (includeTools:false) omits `tools` entirely — asserted
  // in tests as "no `tools` key".
  if (includeTools) {
    body.tools = [
      {
        functionDeclarations: toolDefs().map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: stripGeminiSchemaKeys(t.function.parameters),
        })),
      },
    ];
  }
  // Compaction cap (gemini kind uses generationConfig.maxOutputTokens).
  if (
    typeof opts?.maxOutputTokens === "number" &&
    Number.isFinite(opts.maxOutputTokens) &&
    opts.maxOutputTokens > 0
  ) {
    body.generationConfig = { maxOutputTokens: Math.floor(opts.maxOutputTokens) };
  }
  if (systems.length > 0) {
    // Stable-prefix split (prompt-cache architecture): a trailing env block
    // becomes its own part so the stable head stays byte-identical across
    // POSTs for implicit prefix caching. No env tail → the legacy single
    // part, byte-identical to before.
    const joined = systems.join("\n\n");
    const prefix = assemblePrefix({ systemContent: joined });
    body.system_instruction =
      prefix.dynamicSystem !== null && prefix.stableSystem.trim().length > 0
        ? { parts: [{ text: prefix.stableSystem }, { text: prefix.dynamicSystem }] }
        : { parts: [{ text: joined }] };
  }
  return body;
}

// ---- Shared SSE line buffering (mirrors zen.readSSEMessage contract) ----

type SSEBody =
  | {
      getReader?: () => {
        read(): Promise<{ done: boolean; value?: unknown }>;
        cancel?: () => Promise<void> | void;
        releaseLock?: () => void;
      };
      [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    }
  | null
  | undefined;

// ---- SSE stall timeout (live-proven: a 200-OK stream can stop emitting
// bytes mid-generation — e.g. free-tier routers stalling on tool-heavy
// requests — and hang the turn until the socket dies minutes later) ----
//
// Every `reader.read()` / iterator step races this clock; silence longer
// than the budget fails the turn LOUDLY with a permanent Truncated-stream
// error (same contract as a dead connection: the caller rolls back, the App
// keeps the streamed partial, the user resends). The clock resets on every
// received chunk — slow models are fine, dead sockets are not.
//
// Budget: env ATOM_STALL_TIMEOUT_MS when a finite value > 0 (max-clamped to
// 5min; an explicitly tiny value is the operator's choice, and lets tests
// use millisecond budgets), else the 60s default. The hung read is left to
// settle — callers cancel/release the reader on the way out as before.
export const DEFAULT_SSE_STALL_TIMEOUT_MS = 60_000;
export const MAX_SSE_STALL_TIMEOUT_MS = 300_000;

export function sseStallTimeoutMs(): number {
  const raw = process.env.ATOM_STALL_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), MAX_SSE_STALL_TIMEOUT_MS);
  }
  return DEFAULT_SSE_STALL_TIMEOUT_MS;
}

export function isStallError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("Truncated stream from model (stall:");
}

export async function readWithStall<T>(read: () => Promise<T>, ms?: number): Promise<T> {
  const limit =
    typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : sseStallTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const pending = read();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Truncated stream from model (stall: no bytes for ${limit}ms before [DONE]).`));
      }, limit);
      // An unref'd timer must never hold the process open for a settled read.
      try {
        (timer as unknown as { unref?: () => void }).unref?.();
      } catch {
        // ignore — environments without unref (browsers) proceed regardless
      }
    });
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectSSEText(res: Response): Promise<{
  rawText: string;
  events: Array<{ event: string; data: string }>;
}> {
  const body = (res as unknown as { body?: unknown }).body as SSEBody;
  const decoder = new TextDecoder();
  let rawText = "";
  if (body == null) return { rawText, events: [] };
  try {
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      try {
        for (;;) {
          let chunk: { done: boolean; value?: unknown };
          try {
            chunk = await readWithStall(() => reader.read());
          } catch (e) {
            if (isStallError(e)) {
              // Free the dead socket on the way out, then surface the stall
              // unchanged (permanent Truncated contract — never retried).
              try {
                await reader.cancel?.();
              } catch {
                // ignore cancel errors
              }
              throw e;
            }
            throw new Error(
              `Truncated stream from model (connection aborted: ${e instanceof Error ? e.message : String(e)}).`
            );
          }
          if (chunk.done) break;
          const v = chunk.value;
          rawText +=
            typeof v === "string"
              ? v
              : decoder.decode(v as Uint8Array, { stream: true });
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
          rawText +=
            typeof v === "string"
              ? v
              : decoder.decode(v as Uint8Array, { stream: true });
        }
      } finally {
        try {
          await it.return?.();
        } catch {
          // ignore — the stream is over either way
        }
      }
    } else {
      const textFn = (res as unknown as { text?: () => Promise<string> }).text;
      if (typeof textFn === "function") {
        rawText = String((await textFn.call(res)) ?? "");
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Truncated stream")) throw e;
    throw new Error(
      `Truncated stream from model (connection aborted: ${e instanceof Error ? e.message : String(e)}).`
    );
  }
  // Split into SSE events: "event:" sets the type for following "data:".
  const events: Array<{ event: string; data: string }> = [];
  let curEvent = "message";
  for (const rawLine of rawText.split("\n")) {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) {
      curEvent = "message";
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      curEvent = line.slice("event:".length).trim() || "message";
      continue;
    }
    if (!line.startsWith("data:")) continue; // id:/retry: ignored
    let payload = line.slice("data:".length);
    if (payload.startsWith(" ")) payload = payload.slice(1);
    events.push({ event: curEvent, data: payload });
    // blank line resets below; consecutive data lines keep last event
  }
  return { rawText, events };
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function openAIUsage(
  prompt?: unknown,
  completion?: unknown,
  cache?: { read?: unknown; write?: unknown }
): Usage | undefined {
  const out: Usage = {};
  const p = finiteCount(prompt);
  if (p !== undefined) out.prompt_tokens = p;
  const c = finiteCount(completion);
  if (c !== undefined) out.completion_tokens = c;
  if (p !== undefined && c !== undefined) out.total_tokens = p + c;
  // Provider-reported cache counters ride alongside (Anthropic
  // cache_read/_creation, Gemini cachedContentTokenCount) — present-only.
  const read = finiteCount(cache?.read);
  if (read !== undefined) out.cacheReadTokens = read;
  const write = finiteCount(cache?.write);
  if (write !== undefined) out.cacheWriteTokens = write;
  return out.prompt_tokens !== undefined ||
    out.completion_tokens !== undefined ||
    out.total_tokens !== undefined
    ? out
    : undefined;
}

// Merge one POST's incrementally-reported usage: last value seen per key wins
// (one stream carries one POST's usage). `total` is authoritative when the
// provider sends one (Gemini totalTokenCount — kept verbatim, never
// recomputed over). Otherwise, when `recomputeTotal` is set (Anthropic never
// sends a total), total_tokens is recomputed from prompt+completion whenever
// both are known, so a split report (message_start input + message_delta
// output) never leaves the first chunk's stale total behind. A merge that
// still carries no usable count returns undefined (never an empty object).
function mergeUsage(
  base: Usage | undefined,
  partial: Usage | undefined,
  opts?: { total?: number | undefined; recomputeTotal?: boolean }
): Usage | undefined {
  if (partial === undefined && opts?.total === undefined) return base;
  const merged: Usage = { ...base, ...partial };
  if (opts?.total !== undefined) {
    merged.total_tokens = opts.total;
  } else if (
    (merged.total_tokens === undefined || opts?.recomputeTotal === true) &&
    merged.prompt_tokens !== undefined &&
    merged.completion_tokens !== undefined
  ) {
    merged.total_tokens = merged.prompt_tokens + merged.completion_tokens;
  }
  return merged.prompt_tokens !== undefined ||
    merged.completion_tokens !== undefined ||
    merged.total_tokens !== undefined
    ? merged
    : undefined;
}

// ---- Anthropic SSE + JSON ----

export async function readAnthropicSSEMessage(
  res: Response,
  opts?: StreamCallbacks
): Promise<ChatResult> {
  const { rawText, events } = await collectSSEText(res);
  type Block =
    | { kind: "text"; text: string }
    | { kind: "tool"; id: string; name: string; json: string };
  const blocks: Block[] = [];
  let usage: Usage | undefined;
  let stopReason: string | undefined;
  let sawData = false;
  let sawStop = false;
  let streamingAnnounced = false;
  function announce(): void {
    if (!streamingAnnounced) {
      streamingAnnounced = true;
      try {
        opts?.onPhase?.("streaming");
      } catch {
        // ignore
      }
    }
  }
  function blockAt(index: number): Block {
    while (blocks.length <= index) blocks.push({ kind: "text", text: "" });
    return blocks[index]!;
  }
  for (const { data } of events) {
    if (data === "[DONE]") {
      sawStop = true;
      continue;
    }
    if (!data) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(data);
    } catch {
      continue; // malformed JSON data line: skip, never crash
    }
    sawData = true;
    const o = evt as Record<string, unknown>;
    const type = o["type"];
    if (type === "message_start") {
      const msg = o["message"] as Record<string, unknown> | undefined;
      const u = msg?.["usage"] as Record<string, unknown> | undefined;
      if (u) {
        const hit = openAIUsage(u["input_tokens"], u["output_tokens"], {
          read: u["cache_read_input_tokens"],
          write: u["cache_creation_input_tokens"],
        });
        const merged = mergeUsage(usage, hit, { recomputeTotal: true });
        if (merged !== undefined) usage = merged;
      }
      continue;
    }
    if (type === "content_block_start") {
      const index = typeof o["index"] === "number" ? o["index"] : 0;
      const cb = o["content_block"] as Record<string, unknown> | undefined;
      const btype = cb?.["type"];
      if (btype === "tool_use") {
        const name = typeof cb?.["name"] === "string" ? (cb["name"] as string) : "";
        const id = typeof cb?.["id"] === "string" ? (cb["id"] as string) : "";
        blocks[index] = { kind: "tool", id, name, json: "" };
        announce();
        if (name) {
          try {
            opts?.onToolDelta?.(name, index);
          } catch {
            // ignore
          }
          try {
            opts?.onPhase?.("tool", name);
          } catch {
            // ignore
          }
        }
      } else {
        blocks[index] = { kind: "text", text: "" };
      }
      continue;
    }
    if (type === "content_block_delta") {
      const index = typeof o["index"] === "number" ? o["index"] : 0;
      const delta = o["delta"] as Record<string, unknown> | undefined;
      const dtype = delta?.["type"];
      const slot = blockAt(index);
      if (dtype === "text_delta" && typeof delta?.["text"] === "string") {
        const frag = delta["text"] as string;
        announce();
        if (slot.kind === "text") slot.text += frag;
        else blocks[index] = { kind: "text", text: frag };
        try {
          opts?.onPhase?.("streaming");
        } catch {
          // ignore
        }
        try {
          opts?.onToken?.(fullText(blocks));
        } catch {
          // ignore
        }
      } else if (
        dtype === "input_json_delta" &&
        typeof delta?.["partial_json"] === "string"
      ) {
        const frag = delta["partial_json"] as string;
        announce();
        if (slot.kind === "tool") slot.json += frag;
        // input_json fragments do not emit onToken (not user text)
      }
      continue;
    }
    if (type === "message_delta") {
      const delta = o["delta"] as Record<string, unknown> | undefined;
      if (typeof delta?.["stop_reason"] === "string") {
        stopReason = delta["stop_reason"] as string;
      }
      const u = o["usage"] as Record<string, unknown> | undefined;
      // Tolerance: some streams put the counts at the top level of
      // message_delta instead of under `usage` (nested `usage` wins).
      const inputSrc =
        u?.["input_tokens"] !== undefined ? u["input_tokens"] : o["input_tokens"];
      const outputSrc =
        u?.["output_tokens"] !== undefined ? u["output_tokens"] : o["output_tokens"];
      if (u !== undefined || o["input_tokens"] !== undefined || o["output_tokens"] !== undefined) {
        const hit = openAIUsage(inputSrc, outputSrc, {
          read: u?.["cache_read_input_tokens"] ?? o["cache_read_input_tokens"],
          write: u?.["cache_creation_input_tokens"] ?? o["cache_creation_input_tokens"],
        });
        const merged = mergeUsage(usage, hit, { recomputeTotal: true });
        if (merged !== undefined) usage = merged;
      }
      // Some streams put output_tokens at top level of message_delta
      if (stopReason !== undefined) sawStop = true;
      continue;
    }
    if (type === "message_stop") {
      sawStop = true;
      continue;
    }
    // Tolerance: non-streaming JSON body delivered as single SSE data line
    // (e.g. {content:[...], stop_reason, usage}).
    if (Array.isArray(o["content"]) && o["stop_reason"] !== undefined) {
      return parseAnthropicJson(o);
    }
  }
  // Tolerance: body with no SSE data lines is really single-shot JSON.
  if (!sawData) {
    const candidate = rawText.trim();
    if (candidate.length > 0) {
      try {
        const data = JSON.parse(candidate) as Record<string, unknown>;
        if (Array.isArray(data["content"])) return parseAnthropicJson(data);
      } catch {
        // fall through to truncation error
      }
    }
    throw new Error(
      "Truncated stream from model (connection aborted before [DONE])."
    );
  }
  if (!sawStop) {
    throw new Error(
      "Truncated stream from model (connection aborted before [DONE])."
    );
  }
  void stopReason;
  return buildAnthropicResult(blocks, usage, opts);
}

function fullText(blocks: Array<{ kind: string; text?: string }>): string {
  return blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

function buildAnthropicResult(
  blocks: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; id: string; name: string; json: string }
  >,
  usage: Usage | undefined,
  opts?: StreamCallbacks
): ChatResult {
  const text = fullText(blocks);
  const calls: ToolCall[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== "tool") return;
    if (!b.name) {
      if (b.id) {
        try {
          opts?.onWarning?.(`dropped tool call ${b.id} with no function name`);
        } catch {
          // ignore
        }
      }
      return;
    }
    calls.push({
      id: b.id || `anthropic-${i}`,
      type: "function",
      function: { name: b.name, arguments: b.json || "{}" },
    });
  });
  if (calls.length === 0 && text.trim() === "") {
    throw new Error("Empty reply from model (unexpected payload).");
  }
  const result: ChatResult = {
    content: text.length > 0 ? text : null,
    tool_calls: calls.length > 0 ? calls : undefined,
  };
  if (usage !== undefined) result.usage = usage;
  return result;
}

// Non-streaming Anthropic JSON:
// {content:[{type:"text",text},{type:"tool_use",id,name,input}], usage:{input_tokens,output_tokens}}
export function parseAnthropicJson(data: unknown): ChatResult {
  const o = data as Record<string, unknown>;
  const content = o["content"];
  let text = "";
  const calls: ToolCall[] = [];
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const b = content[i] as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        text += b["text"] as string;
      } else if (b["type"] === "tool_use") {
        const name = typeof b["name"] === "string" ? (b["name"] as string) : "";
        if (!name) continue; // nameless-drop parity
        const id = typeof b["id"] === "string" ? (b["id"] as string) : `anthropic-${i}`;
        let args = "{}";
        try {
          args = JSON.stringify(b["input"] ?? {});
        } catch {
          args = "{}";
        }
        calls.push({ id, type: "function", function: { name, arguments: args } });
      }
    }
  }
  if (calls.length === 0 && text.trim() === "") {
    throw new Error("Empty reply from model (unexpected payload).");
  }
  const result: ChatResult = {
    content: text.length > 0 ? text : null,
    tool_calls: calls.length > 0 ? calls : undefined,
  };
  const u = o["usage"] as Record<string, unknown> | undefined;
  if (u) {
    const hit = openAIUsage(u["input_tokens"], u["output_tokens"], {
      read: u["cache_read_input_tokens"],
      write: u["cache_creation_input_tokens"],
    });
    if (hit) result.usage = hit;
  }
  return result;
}

// ---- Gemini SSE + JSON ----

export async function readGeminiSSEMessage(
  res: Response,
  opts?: StreamCallbacks
): Promise<ChatResult> {
  const { rawText, events } = await collectSSEText(res);
  let text = "";
  const calls: Array<{ name: string; argsJson: string; index: number }> = [];
  let usage: Usage | undefined;
  let sawData = false;
  let sawDone = false;
  // functionCall accumulation: consecutive chunks for the same call merge
  // their args objects; a new name starts a new slot.
  function pushFunctionCall(name: string, args: unknown): void {
    let argsJson = "{}";
    try {
      argsJson = JSON.stringify(args ?? {});
    } catch {
      argsJson = "{}";
    }
    const last = calls[calls.length - 1];
    if (last && last.name === name && last.argsJson === "{}" && argsJson !== "{}") {
      last.argsJson = argsJson;
      return;
    }
    // Merge object fragments for a repeated name (tolerance for split args).
    if (last && last.name === name) {
      try {
        const a = JSON.parse(last.argsJson) as Record<string, unknown>;
        const b =
          typeof args === "object" && args !== null
            ? (args as Record<string, unknown>)
            : {};
        last.argsJson = JSON.stringify({ ...a, ...b });
        return;
      } catch {
        // fall through to new slot
      }
    }
    calls.push({ name, argsJson, index: calls.length });
    try {
      opts?.onToolDelta?.(name, calls.length - 1);
    } catch {
      // ignore
    }
    try {
      opts?.onPhase?.("tool", name);
    } catch {
      // ignore
    }
  }
  for (const { data } of events) {
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    if (!data) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    sawData = true;
    const o = evt as Record<string, unknown>;
    const candidates = o["candidates"];
    if (Array.isArray(candidates)) {
      for (const c of candidates as Array<Record<string, unknown>>) {
        const content = c["content"] as Record<string, unknown> | undefined;
        const parts = content?.["parts"];
        if (!Array.isArray(parts)) continue;
        for (const p of parts as Array<Record<string, unknown>>) {
          if (typeof p["text"] === "string" && (p["text"] as string).length > 0) {
            text += p["text"] as string;
            try {
              opts?.onPhase?.("streaming");
            } catch {
              // ignore
            }
            try {
              opts?.onToken?.(text);
            } catch {
              // ignore
            }
          }
          const fc = p["functionCall"] as
            | { name?: unknown; args?: unknown }
            | undefined;
          if (fc && typeof fc["name"] === "string" && (fc["name"] as string)) {
            pushFunctionCall(fc["name"] as string, fc["args"]);
          }
        }
      }
    }
    const um = o["usageMetadata"] as Record<string, unknown> | undefined;
    if (um) {
      const hit = openAIUsage(um["promptTokenCount"], um["candidatesTokenCount"], {
        read: um["cachedContentTokenCount"],
      });
      const total = finiteCount(um["totalTokenCount"]);
      const merged = mergeUsage(usage, hit, { total });
      if (merged !== undefined) usage = merged;
    }
  }
  // Tolerance: no SSE data lines -> single-shot :generateContent JSON.
  if (!sawData) {
    const candidate = rawText.trim();
    if (candidate.length > 0) {
      try {
        const data = JSON.parse(candidate) as Record<string, unknown>;
        if (Array.isArray(data["candidates"])) return parseGeminiJson(data);
      } catch {
        // fall through
      }
    }
    throw new Error(
      "Truncated stream from model (connection aborted before [DONE])."
    );
  }
  // Gemini SSE streams do not always send [DONE]; a stream that produced
  // data and ended cleanly is accepted. An empty stream is truncated.
  void sawDone;
  const tool_calls: ToolCall[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    if (!c.name) continue; // nameless-drop parity
    tool_calls.push({
      id: `gemini-${i}`,
      type: "function",
      function: { name: c.name, arguments: c.argsJson },
    });
  }
  if (tool_calls.length === 0 && text.trim() === "") {
    throw new Error("Empty reply from model (unexpected payload).");
  }
  const result: ChatResult = {
    content: text.length > 0 ? text : null,
    tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
  };
  if (usage !== undefined) result.usage = usage;
  return result;
}

// Non-streaming :generateContent JSON:
// {candidates:[{content:{parts:[{text},{functionCall:{name,args}}]}}], usageMetadata}
export function parseGeminiJson(data: unknown): ChatResult {
  const o = data as Record<string, unknown>;
  let text = "";
  const calls: ToolCall[] = [];
  const candidates = o["candidates"];
  if (Array.isArray(candidates)) {
    for (const c of candidates as Array<Record<string, unknown>>) {
      const content = c["content"] as Record<string, unknown> | undefined;
      const parts = content?.["parts"];
      if (!Array.isArray(parts)) continue;
      for (const p of parts as Array<Record<string, unknown>>) {
        if (typeof p["text"] === "string") text += p["text"] as string;
        const fc = p["functionCall"] as
          | { name?: unknown; args?: unknown }
          | undefined;
        if (fc && typeof fc["name"] === "string" && (fc["name"] as string)) {
          let argsJson = "{}";
          try {
            argsJson = JSON.stringify(fc["args"] ?? {});
          } catch {
            argsJson = "{}";
          }
          calls.push({
            id: `gemini-${calls.length}`,
            type: "function",
            function: { name: fc["name"] as string, arguments: argsJson },
          });
        }
      }
    }
  }
  if (calls.length === 0 && text.trim() === "") {
    throw new Error("Empty reply from model (unexpected payload).");
  }
  const result: ChatResult = {
    content: text.length > 0 ? text : null,
    tool_calls: calls.length > 0 ? calls : undefined,
  };
  const um = o["usageMetadata"] as Record<string, unknown> | undefined;
  if (um) {
    const hit = openAIUsage(um["promptTokenCount"], um["candidatesTokenCount"], {
      read: um["cachedContentTokenCount"],
    });
    const total = finiteCount(um["totalTokenCount"]);
    const merged = mergeUsage(undefined, hit, { total });
    if (merged !== undefined) result.usage = merged;
  }
  return result;
}

// ---- Models-list parsing per kind (pure; ANY failure -> fallback) ----

function entryId(entry: unknown): string | null {
  if (typeof entry === "string") return entry || null;
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const id = e["id"] ?? e["name"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

// OpenAI-kind for NON-zen providers: accept every listed id.
export function parseOpenAIModelsList(data: unknown, fallback: string[]): string[] {
  try {
    const entries: unknown = Array.isArray(data)
      ? data
      : (data as { data?: unknown })?.data;
    if (!Array.isArray(entries) || entries.length === 0) return [...fallback];
    const picked: string[] = [];
    for (const entry of entries) {
      const id = entryId(entry);
      if (id) picked.push(id);
    }
    return picked.length > 0 ? picked : [...fallback];
  } catch {
    return [...fallback];
  }
}

export function parseAnthropicModelsList(
  data: unknown,
  fallback: string[]
): string[] {
  try {
    const entries: unknown = Array.isArray(data)
      ? data
      : (data as { data?: unknown })?.data;
    if (!Array.isArray(entries) || entries.length === 0) return [...fallback];
    const picked: string[] = [];
    for (const entry of entries) {
      const id = entryId(entry);
      if (id) picked.push(id);
    }
    return picked.length > 0 ? picked : [...fallback];
  } catch {
    return [...fallback];
  }
}

export function parseGeminiModelsList(
  data: unknown,
  fallback: string[]
): string[] {
  try {
    const o = data as { models?: unknown };
    const entries: unknown = Array.isArray(o?.models) ? o.models : null;
    if (!Array.isArray(entries) || entries.length === 0) return [...fallback];
    const picked: string[] = [];
    for (const entry of entries) {
      let id = entryId(entry);
      if (id && id.startsWith("models/")) id = id.slice("models/".length);
      if (id) picked.push(id);
    }
    return picked.length > 0 ? picked : [...fallback];
  } catch {
    return [...fallback];
  }
}

// ---- Key validation (cheap GET per kind; mocked in tests, never live) ----

export async function validateProviderKey(
  id: ProviderId,
  apiKey: string,
  storedBaseURL?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey) return { ok: false, error: "missing API key" };
  const def = getProvider(id);
  if (!def) return { ok: false, error: `unknown provider: ${id}` };
  try {
    if (id === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Anthropic HTTP ${res.status}` };
    }
    if (id === "google-gemini") {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { headers: { "x-goog-api-key": apiKey } }
      );
      if (res.ok) return { ok: true };
      return { ok: false, error: `Gemini HTTP ${res.status}` };
    }
    // OpenAI-kind: GET {base}/models with Bearer.
    const url = modelsUrlForProvider(id, storedBaseURL);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    const res = await fetch(url, { headers });
    if (res.ok) return { ok: true };
    const label =
      id === "opencode-zen"
        ? "Zen"
        : (def.name ?? String(id));
    return { ok: false, error: `${label} HTTP ${res.status}` };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
