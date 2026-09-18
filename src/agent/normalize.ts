// Tool-result + model-response normalization for the agentic loop.
// Pure functions, no I/O, never throw — every path returns a usable value.
//
// Why this exists: executors return strings today, but custom `execute`
// hooks (tests, App guardedExecute, future providers) can return anything,
// and model-produced tool_calls can carry non-string arguments, missing ids,
// or unknown shapes. Without normalization one bad value either crashes the
// commit path or injects unbounded text into history (the latest turn is
// never trimmed, so an oversized result bypasses the history budget and
// blows latency/cost for every later POST in the turn).
//
// Contract:
// - normalizeToolResult: string in → string out (capped); non-string →
//   JSON/string coercion, never throws, never empty-handed.
// - normalizeChatResult: unknown model message → validated ChatResult +
//   warnings (dropped malformed calls are reported via onWarning by the
//   caller, never silently executed).
// - toolSignature: stable name+args key for repetition detection and caching
//   (recursive key-sorted JSON, so key order never aliases).
import type { ChatResult, ToolCall } from "./types.js";
import { truncateHead } from "../tools/shared.js";

// Safety net for custom executors (built-in tools already cap: read 64KB
// head + truncation note + overflow pointer ≈ 66KB, bash 8KB, webfetch 64KB
// + notes). The cap sits at 128KB so legitimate built-in outputs (overflow
// pointers included) pass through byte-identical; only oversized custom
// results truncate.
export const TOOL_RESULT_CAP_CHARS = 128 * 1024;

export function normalizeToolResult(result: unknown): string {
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else if (result === null || result === undefined) {
    return "Error: tool returned no result";
  } else {
    // Pre-cap: avoid stringifying huge objects toward OOM. Estimate via a
    // bounded probe; fall back to a short tag when clearly oversized.
    try {
      const probe = JSON.stringify(result);
      if (typeof probe !== "string") {
        text = String(result);
      } else if (probe.length > TOOL_RESULT_CAP_CHARS * 4) {
        text = `unstringifiable:oversized-${typeof result}`;
      } else {
        text = probe;
      }
    } catch {
      try {
        text = String(result);
      } catch {
        return "Error: tool returned an unreadable result";
      }
    }
  }
  if (text.length > TOOL_RESULT_CAP_CHARS) {
    const t = truncateHead(
      text,
      TOOL_RESULT_CAP_CHARS,
      `\n[truncated: tool result exceeded ${TOOL_RESULT_CAP_CHARS} chars]`
    );
    return t.head + t.note;
  }
  return text;
}

// Recursively key-sorted JSON for stable signatures. Falls back to a short
// type tag when unstringifiable (never throws, never aliases objects with
// strings: prefixes the tag).
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortKeys(value)) ?? "undefined";
  } catch {
    return `unstringifiable:${typeof value}`;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// Stable repetition/cache key: `name` + canonical args. Parsed args come
// from JSON.parse (insertion-ordered), so sorting closes the alias where
// `{"a":1,"b":2}` and `{"b":2,"a":1}` would otherwise count as different.
export function toolSignature(name: string, parsed: Record<string, unknown>): string {
  return `${name} ${stableStringify(parsed ?? {})}`;
}

export type NormalizedChat = { result: ChatResult; warnings: string[] };

// Defensive validation of one assistant message. Never throws: malformed
// tool_calls entries are dropped with a warning (the caller surfaces them
// via onWarning so the transcript shows what the model attempted); a fully
// unusable message becomes empty final text (the loop's turn-end gates then
// decide, exactly as if the model sent empty content).
export function normalizeChatResult(raw: unknown): NormalizedChat {
  const warnings: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { result: { content: null }, warnings: ["model returned a non-object message"] };
  }
  const m = raw as Record<string, unknown>;
  const contentRaw = m["content"];
  // Cap assistant content before it enters history (tool-result cap does not
  // cover this path). Oversized content routes through the same head-truncate.
  const ASSISTANT_CONTENT_CAP_CHARS = TOOL_RESULT_CAP_CHARS;
  const capAssistantText = (text: string): string => {
    if (text.length <= ASSISTANT_CONTENT_CAP_CHARS) return text;
    const t = truncateHead(
      text,
      ASSISTANT_CONTENT_CAP_CHARS,
      `\n[truncated: assistant content exceeded ${ASSISTANT_CONTENT_CAP_CHARS} chars]`
    );
    return t.head + t.note;
  };
  const content =
    typeof contentRaw === "string"
      ? capAssistantText(contentRaw)
      : contentRaw === null || contentRaw === undefined
        ? null
        : (() => {
            try {
              const json = JSON.stringify(contentRaw);
              if (typeof json !== "string") return String(contentRaw);
              return capAssistantText(json);
            } catch {
              return capAssistantText(String(contentRaw));
            }
          })();
  const callsRaw = m["calls"] ?? m["tool_calls"];
  if (callsRaw === undefined) {
    const result: ChatResult = { content };
    if (m["usage"] !== undefined) (result as Record<string, unknown>)["usage"] = m["usage"];
    if (m["reasoning"] !== undefined) (result as Record<string, unknown>)["reasoning"] = m["reasoning"];
    // Length-truncation flag survives normalization (no calls or not — the
    // loop decides; truncated-without-calls behaves as before).
    if (m["truncated"] === true) result.truncated = true;
    return { result: result as ChatResult, warnings };
  }
  if (!Array.isArray(callsRaw)) {
    warnings.push("model tool_calls was not an array — ignored");
    return { result: { content, tool_calls: undefined }, warnings };
  }
  // Bounded warnings: adversarial tool_calls arrays cannot spam onWarning.
  const MAX_NORMALIZE_WARNINGS = 50;
  const pushWarning = (text: string): void => {
    if (warnings.length < MAX_NORMALIZE_WARNINGS) warnings.push(text);
  };
  const MAX_TOOL_CALLS_PER_MESSAGE = 100;
  const calls: ToolCall[] = [];
  const totalCalls = callsRaw.length;
  const seenIds = new Set<string>();
  for (let i = 0; i < callsRaw.length && calls.length < MAX_TOOL_CALLS_PER_MESSAGE; i++) {
    const entry = callsRaw[i] as Record<string, unknown> | null | undefined;
    if (typeof entry !== "object" || entry === null) {
      pushWarning(`dropped malformed tool call at index ${i} (not an object)`);
      continue;
    }
    const fn = entry["function"] as Record<string, unknown> | undefined;
    const name = fn?.["name"];
    if (typeof name !== "string" || name.length === 0) {
      const id = typeof entry["id"] === "string" ? (entry["id"] as string) : `#${i}`;
      pushWarning(`dropped tool call ${id} with no function name`);
      continue;
    }
    // Namespaced fallback ids: never collide with model-sent ids like call-0.
    // Model-sent ids are preserved when unique; collisions get disambiguated.
    const rawId = entry["id"];
    let id: string;
    if (typeof rawId === "string" && rawId.length > 0 && !seenIds.has(rawId)) {
      id = rawId;
    } else if (typeof rawId === "string" && rawId.length > 0) {
      id = `local-fallback-${i}-${rawId}`;
    } else {
      id = `local-fallback-${i}`;
    }
    seenIds.add(id);
    const argsRaw = fn?.["arguments"];
    let args: string;
    if (typeof argsRaw === "string") args = argsRaw;
    else if (argsRaw === undefined || argsRaw === null) args = "{}";
    else {
      try {
        args = JSON.stringify(argsRaw) ?? "{}";
      } catch {
        pushWarning(`dropped tool call ${id} with unstringifiable arguments`);
        continue;
      }
    }
    const call: ToolCall = { id, function: { name, arguments: args } };
    if (typeof entry["type"] === "string") call.type = entry["type"] as string;
    calls.push(call);
  }
  if (totalCalls > calls.length && totalCalls > MAX_TOOL_CALLS_PER_MESSAGE) {
    pushWarning(
      `truncated tool_calls: kept ${calls.length} of ${totalCalls} (cap ${MAX_TOOL_CALLS_PER_MESSAGE})`
    );
  }
  const out: ChatResult = { content, tool_calls: calls.length > 0 ? calls : undefined };
  if (m["usage"] !== undefined) (out as Record<string, unknown>)["usage"] = m["usage"];
  if (m["reasoning"] !== undefined) (out as Record<string, unknown>)["reasoning"] = m["reasoning"];
  if (m["truncated"] === true) out.truncated = true;
  return { result: out, warnings };
}
