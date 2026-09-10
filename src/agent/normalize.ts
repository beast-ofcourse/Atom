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
    try {
      const json = JSON.stringify(result);
      text = typeof json === "string" ? json : String(result);
    } catch {
      try {
        text = String(result);
      } catch {
        return "Error: tool returned an unreadable result";
      }
    }
  }
  if (text.length > TOOL_RESULT_CAP_CHARS) {
    return (
      text.slice(0, TOOL_RESULT_CAP_CHARS) +
      `\n[truncated: tool result exceeded ${TOOL_RESULT_CAP_CHARS} chars]`
    );
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
  const content =
    typeof contentRaw === "string"
      ? contentRaw
      : contentRaw === null || contentRaw === undefined
        ? null
        : (() => {
            try {
              return JSON.stringify(contentRaw);
            } catch {
              return String(contentRaw);
            }
          })();
  const callsRaw = m["calls"] ?? m["tool_calls"];
  if (callsRaw === undefined) {
    const result: ChatResult = { content };
    if (m["usage"] !== undefined) (result as Record<string, unknown>)["usage"] = m["usage"];
    if (m["reasoning"] !== undefined) (result as Record<string, unknown>)["reasoning"] = m["reasoning"];
    return { result: result as ChatResult, warnings };
  }
  if (!Array.isArray(callsRaw)) {
    warnings.push("model tool_calls was not an array — ignored");
    return { result: { content, tool_calls: undefined }, warnings };
  }
  const calls: ToolCall[] = [];
  for (let i = 0; i < callsRaw.length; i++) {
    const entry = callsRaw[i] as Record<string, unknown> | null | undefined;
    if (typeof entry !== "object" || entry === null) {
      warnings.push(`dropped malformed tool call at index ${i} (not an object)`);
      continue;
    }
    const fn = entry["function"] as Record<string, unknown> | undefined;
    const name = fn?.["name"];
    if (typeof name !== "string" || name.length === 0) {
      const id = typeof entry["id"] === "string" ? (entry["id"] as string) : `#${i}`;
      warnings.push(`dropped tool call ${id} with no function name`);
      continue;
    }
    const id = typeof entry["id"] === "string" && (entry["id"] as string).length > 0
      ? (entry["id"] as string)
      : `call-${i}`;
    const argsRaw = fn?.["arguments"];
    let args: string;
    if (typeof argsRaw === "string") args = argsRaw;
    else if (argsRaw === undefined || argsRaw === null) args = "{}";
    else {
      try {
        args = JSON.stringify(argsRaw) ?? "{}";
      } catch {
        warnings.push(`dropped tool call ${id} with unstringifiable arguments`);
        continue;
      }
    }
    const call: ToolCall = { id, function: { name, arguments: args } };
    if (typeof entry["type"] === "string") call.type = entry["type"] as string;
    calls.push(call);
  }
  const out: ChatResult = { content, tool_calls: calls.length > 0 ? calls : undefined };
  if (m["usage"] !== undefined) (out as Record<string, unknown>)["usage"] = m["usage"];
  if (m["reasoning"] !== undefined) (out as Record<string, unknown>)["reasoning"] = m["reasoning"];
  return { result: out, warnings };
}
