// Provider request/response hooks (ticket 08): extension hooks over every
// live model POST (redaction, routing, logging, header injection).
//
// Dependency-free like intercept.ts (type-only imports) so the extension
// host, the transports (zen.ts), and the tests can all share it with no
// cycle: extensions register here, the transports apply here, nobody imports
// the other.
//
// Semantics (fail-open vs fail-closed per hook):
// - Context transform (fail OPEN): handlers run in registration order over
//   the outgoing messages; each sees the previous handler's output and may
//   return a replacement array (void/null/undefined passes through). A
//   throwing handler — or a non-array / malformed-array return — degrades to
//   the untransformed value so far, never a broken request. Fail-open (not
//   fail-closed like before-tool-call) because there is no unsafe execution
//   to prevent here — only request shaping — and a buggy redactor must not
//   hold every model round hostage (same rationale as the before_switch
//   fail-open gate). Extensions needing guaranteed redaction keep handlers
//   total (try/catch inside the handler).
// - Pre-request (fail OPEN): handlers run in registration order over the
//   assembled payload + headers; each sees the previous handler's output and
//   may return { payload } to replace the body wholesale and/or { headers }
//   to set per-key values. A throwing handler is skipped (its change
//   dropped, the chain continues) so one buggy header injection never fails
//   the turn. A non-record payload replacement is ignored — the replacement
//   still flows through the downstream JSON/fetch handling, never bypassing
//   it. Header merge is per-key: a string sets/overwrites, null/undefined
//   DELETES the key, anything else is ignored (never silently stringified).
// - Post-response (fail OPEN, observe-only): handlers run in registration
//   order with a { provider, model, url, status, ok, headers } snapshot after
//   every resolved POST (ok and HTTP-error alike; network throws have no
//   response to observe and never fire). Return values are ignored; a
//   throwing handler is dropped and the turn continues untouched.
//
// Coverage: the three transports in zen.ts (openai-chat via chatCompletion,
// anthropic-messages via chatCompletionAnthropic, gemini-generate via
// chatCompletionGemini) each apply all three hooks per POST, so every
// provider kind — zen, kilo, openai, deepseek, mistral, groq, xai, zai,
// openrouter, cerebras, openai-compatible, local runtimes, anthropic,
// google-gemini — is covered through the single
// chatCompletionForProvider dispatcher (which delegates to those three).
// The loop transcript itself is never mutated: hooks transform per-POST
// copies only.

import type { ChatMessage } from "../agent/types.js";

export type ProviderHookHandler<Input, Result> = (
  input: Input
) => Result | Promise<Result>;

// ---- Outgoing context transform ----

/** Handler: receives the outgoing messages, returns a replacement array (or void/null/undefined to pass through). */
export type ContextTransformHandler = ProviderHookHandler<
  ChatMessage[],
  ChatMessage[] | null | undefined | void
>;

/** Snapshot of live context handlers in registration order. */
export type ContextTransformRecord = {
  /** Extension name that registered the handler (audit trail). */
  owner: string;
  handler: ContextTransformHandler;
};

// ---- Pre-request payload + headers ----

export type BeforeRequestInput = {
  /** Provider id as the dispatcher knows it (e.g. "opencode-zen", "anthropic", "google-gemini"). */
  provider: string;
  model: string;
  /** POST URL the transport is about to hit. */
  url: string;
  /** Assembled body (cumulative replacements applied); treat as read-only, return { payload } to replace. */
  payload: Record<string, unknown>;
  /** Outgoing headers (cumulative merges applied); treat as read-only, return { headers } to mutate. */
  headers: Record<string, string>;
};

export type BeforeRequestDecision = {
  /** Wholesale body replacement (must be a record; anything else is ignored). */
  payload?: Record<string, unknown>;
  /**
   * Per-key header mutation merged over the current headers: a string
   * sets/overwrites, null/undefined DELETES the key, anything else is
   * ignored. Deletion is explicit — absent keys are left untouched.
   */
  headers?: Record<string, string | null | undefined>;
};

export type BeforeRequestResult =
  | BeforeRequestDecision
  | null
  | undefined
  | void;

export type BeforeRequestHandler = ProviderHookHandler<BeforeRequestInput, BeforeRequestResult>;

export type BeforeRequestRecord = {
  owner: string;
  handler: BeforeRequestHandler;
};

// ---- Post-response observation ----

export type AfterResponseInput = {
  provider: string;
  model: string;
  /** POST URL that was hit. */
  url: string;
  /** HTTP status of the resolved response (ok and error alike). */
  status: number;
  /** res.ok at observation time. */
  ok: boolean;
  /** Snapshot of the response headers (lower-cased names where the Headers API provides them). */
  headers: Record<string, string>;
};

export type AfterResponseHandler = ProviderHookHandler<AfterResponseInput, unknown>;

export type AfterResponseRecord = {
  owner: string;
  handler: AfterResponseHandler;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool"]);

function isMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value)) return false;
  for (const m of value) {
    if (!isRecord(m)) return false;
    if (typeof m["role"] !== "string" || !VALID_ROLES.has(m["role"] as string)) return false;
  }
  return true;
}

const contextHandlers: Array<ContextTransformRecord> = [];
const beforeRequestHandlers: Array<BeforeRequestRecord> = [];
const afterResponseHandlers: Array<AfterResponseRecord> = [];

function registerOwned<H>(
  store: Array<{ owner: string; handler: H }>,
  handler: H,
  owner: string,
  what: string
): () => void {
  if (typeof handler !== "function") {
    throw new Error(`${what} handler must be a function`);
  }
  const record = { owner, handler };
  store.push(record as { owner: string; handler: H });
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const idx = store.indexOf(record as { owner: string; handler: H });
    if (idx >= 0) store.splice(idx, 1);
  };
}

/** Register an outgoing-context transformer. Returns an unregister function. */
export function registerContextTransform(
  handler: ContextTransformHandler,
  owner = "(unknown)"
): () => void {
  return registerOwned(contextHandlers, handler, owner, "context-transform");
}

/** Register a pre-request payload/header hook. Returns an unregister function. */
export function registerBeforeRequest(
  handler: BeforeRequestHandler,
  owner = "(unknown)"
): () => void {
  return registerOwned(beforeRequestHandlers, handler, owner, "before-request");
}

/** Register a post-response observer. Returns an unregister function. */
export function registerAfterResponse(
  handler: AfterResponseHandler,
  owner = "(unknown)"
): () => void {
  return registerOwned(afterResponseHandlers, handler, owner, "after-response");
}

/** Snapshot of live context handlers in registration order (deterministic composition). */
export function contextTransformers(): Array<ContextTransformRecord> {
  return [...contextHandlers];
}

/** Snapshot of live pre-request handlers in registration order. */
export function beforeRequestInterceptors(): Array<BeforeRequestRecord> {
  return [...beforeRequestHandlers];
}

/** Snapshot of live post-response observers in registration order. */
export function afterResponseObservers(): Array<AfterResponseRecord> {
  return [...afterResponseHandlers];
}

/** Test seam: drop every provider hook. */
export function clearProviderHooks(): void {
  contextHandlers.length = 0;
  beforeRequestHandlers.length = 0;
  afterResponseHandlers.length = 0;
}

// Apply context handlers sequentially in registration order. Never throws:
// a throwing (or malformed-returning) handler degrades to the value so far.
export async function applyContextTransform(
  handlers: ReadonlyArray<ContextTransformRecord>,
  messages: ChatMessage[]
): Promise<ChatMessage[]> {
  // The first handler receives a deep copy, never the loop's live array:
  // in-place mutation by a handler must not corrupt the transcript (the
  // zen.ts call-site contract). structuredClone covers plain chat payloads;
  // the JSON fallback covers exotic values; live is the last resort.
  let current: ChatMessage[];
  try {
    current = structuredClone(messages);
  } catch {
    try {
      current = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
    } catch {
      current = messages;
    }
  }
  for (const record of handlers) {
    let next: ChatMessage[] | null | undefined | void;
    try {
      next = await record.handler(current);
    } catch {
      continue;
    }
    if (next === undefined || next === null) continue;
    if (!isMessages(next)) continue;
    current = next;
  }
  return current;
}

export type BeforeRequestOutcome = {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
};

// Apply pre-request handlers sequentially; each sees the previous output.
// Never throws: a throwing handler is skipped, a non-record payload is
// ignored, and header values merge per-key (string sets, null/undefined
// deletes, anything else ignored).
export async function applyBeforeRequest(
  handlers: ReadonlyArray<BeforeRequestRecord>,
  input: BeforeRequestInput
): Promise<BeforeRequestOutcome> {
  let payload = input.payload;
  let headers = { ...input.headers };
  for (const record of handlers) {
    let decision: BeforeRequestResult;
    try {
      decision = await record.handler({
        provider: input.provider,
        model: input.model,
        url: input.url,
        payload,
        headers: { ...headers },
      });
    } catch {
      continue;
    }
    if (!isRecord(decision)) continue;
    const rep = (decision as BeforeRequestDecision)["payload"];
    if (rep !== undefined && isRecord(rep)) payload = rep as Record<string, unknown>;
    const hm = (decision as BeforeRequestDecision)["headers"];
    if (isRecord(hm)) {
      for (const [k, v] of Object.entries(hm as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
        else if (v === null || v === undefined) delete headers[k];
      }
    }
  }
  return { payload, headers };
}

// Notify post-response observers sequentially. Never throws and never
// rejects: observer failures are dropped, the turn continues untouched.
export async function notifyAfterResponse(
  handlers: ReadonlyArray<AfterResponseRecord>,
  input: AfterResponseInput
): Promise<void> {
  for (const record of handlers) {
    try {
      await record.handler(input);
    } catch {
      // observe-only: failures never break the turn
    }
  }
}

/**
 * Snapshot response headers into a plain record. Never throws: unknown
 * shapes (mocks with a bare .get, missing headers) yield {}.
 */
export function snapshotResponseHeaders(res: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const headers = (res as { headers?: unknown })?.headers;
    if (headers === null || headers === undefined) return out;
    const forEach = (headers as { forEach?: unknown }).forEach;
    if (typeof forEach === "function") {
      (forEach as (cb: (v: unknown, k: unknown) => void) => void).call(headers, (v, k) => {
        if (typeof k === "string" && typeof v === "string") out[k.toLowerCase()] = v;
      });
      return out;
    }
    const iter = (headers as { [Symbol.iterator]?: unknown })[Symbol.iterator];
    if (typeof iter === "function") {
      for (const entry of headers as Iterable<unknown>) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
          out[(entry[0] as string).toLowerCase()] = entry[1] as string;
        }
      }
      return out;
    }
  } catch {
    // fall through to {}
  }
  return out;
}
