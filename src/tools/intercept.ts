// Tool-call interception store (ticket 03): extension pre/post hooks over
// every loop-executed tool call (builtins and custom tools alike).
//
// Dependency-free like custom.ts (no imports) so the extension host, the
// registry barrel, and the agentic loop can all share it with no cycle:
// extensions register here, the loop applies here, nobody imports the other.
//
// Semantics:
// - Before handlers run in registration order and see each call pre-
//   validation and pre-approval. Each may return { args } to rewrite the
//   arguments (later handlers see the rewrite) or { block: reason } / a
//   reason string / { block: true } to veto the execution. The first block
//   wins: later handlers never run for a blocked call, approval is skipped
//   entirely, and the reason commits as a normal model-visible result.
// - A throwing (or rejecting) before handler fails CLOSED: the call is
//   blocked with a handler-failed reason and the turn continues. Unknown
//   behavior never executes blindly.
// - After handlers run in registration order inside the commit funnel, so
//   they observe every committed result (executions, blocks, denials,
//   validation errors). Each may return a string or { content } to patch
//   what the model sees. A throwing after handler fails OPEN to the
//   original result — a patch must never break the turn or the
//   tool_call_id re-pairing/commit order around it.

export type BeforeToolCallInput = {
  /** Tool name as the model called it (always a known tool; unknown names never reach hooks). */
  name: string;
  /** Current arguments (cumulative rewrites applied); treat as read-only, return { args } to rewrite. */
  args: Record<string, unknown>;
};

export type BeforeToolCallDecision = {
  /** Replacement arguments (must be a record; anything else is ignored). */
  args?: Record<string, unknown>;
  /**
   * Block the call: a non-empty string is the model-visible reason,
   * `true` blocks with a default reason. Absent/false/null → no block.
   */
  block?: string | boolean | null;
};

export type BeforeToolCallResult =
  | BeforeToolCallDecision
  | string
  | null
  | undefined
  | void;

export type BeforeToolCallHandler = (
  input: BeforeToolCallInput
) => BeforeToolCallResult | Promise<BeforeToolCallResult>;

export type AfterToolCallInput = {
  name: string;
  /** Arguments the tool ran with (post-rewrite); read-only. */
  args: Record<string, unknown>;
  /** Result string about to commit (execution output, block notice, denial, validation error). */
  result: string;
  isError: boolean;
};

export type AfterToolCallDecision = {
  /** Replacement result content; non-strings are ignored. */
  content?: string;
};

export type AfterToolCallResult =
  | AfterToolCallDecision
  | string
  | null
  | undefined
  | void;

export type AfterToolCallHandler = (
  input: AfterToolCallInput
) => AfterToolCallResult | Promise<AfterToolCallResult>;

export type InterceptRecord<H> = {
  /** Extension name that registered the handler (audit trail for block notices). */
  owner: string;
  handler: H;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

const beforeHandlers: Array<InterceptRecord<BeforeToolCallHandler>> = [];
const afterHandlers: Array<InterceptRecord<AfterToolCallHandler>> = [];

/** Register a pre-execution interceptor. Returns an unregister function. */
export function registerBeforeToolCall(
  handler: BeforeToolCallHandler,
  owner = "(unknown)"
): () => void {
  if (typeof handler !== "function") {
    throw new Error("before-tool-call handler must be a function");
  }
  const record: InterceptRecord<BeforeToolCallHandler> = { owner, handler };
  beforeHandlers.push(record);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const idx = beforeHandlers.indexOf(record);
    if (idx >= 0) beforeHandlers.splice(idx, 1);
  };
}

/** Register a post-execution result patcher. Returns an unregister function. */
export function registerAfterToolCall(
  handler: AfterToolCallHandler,
  owner = "(unknown)"
): () => void {
  if (typeof handler !== "function") {
    throw new Error("after-tool-call handler must be a function");
  }
  const record: InterceptRecord<AfterToolCallHandler> = { owner, handler };
  afterHandlers.push(record);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const idx = afterHandlers.indexOf(record);
    if (idx >= 0) afterHandlers.splice(idx, 1);
  };
}

/** Snapshot of live before handlers in registration order (deterministic composition). */
export function beforeToolInterceptors(): Array<InterceptRecord<BeforeToolCallHandler>> {
  return [...beforeHandlers];
}

/** Snapshot of live after handlers in registration order. */
export function afterToolInterceptors(): Array<InterceptRecord<AfterToolCallHandler>> {
  return [...afterHandlers];
}

/** Test seam: drop every interceptor. */
export function clearToolInterceptors(): void {
  beforeHandlers.length = 0;
  afterHandlers.length = 0;
}

/** Model-visible result for a blocked call (an `Error:` result, committed normally — the turn continues). */
export function blockedToolResult(name: string, owner: string, reason: string): string {
  const trimmed = reason.trim();
  const by = owner.length > 0 ? `extension "${owner}"` : "extension";
  return trimmed.length > 0
    ? `Error: blocked by ${by}: ${trimmed}`
    : `Error: blocked by ${by}: tool "${name}" was blocked`;
}

export type BeforeOutcome = {
  /** Arguments to validate/approve/execute (cumulative rewrites). */
  args: Record<string, unknown>;
  /** Non-null when the call is blocked: the model-visible result to commit without executing. */
  blocked: string | null;
};

// Apply before handlers sequentially in registration order. Never throws:
// a throwing handler fails closed to a blocked outcome carrying the cause.
export async function applyBeforeInterceptors(
  handlers: ReadonlyArray<InterceptRecord<BeforeToolCallHandler>>,
  name: string,
  args: Record<string, unknown>
): Promise<BeforeOutcome> {
  let current = args;
  for (const record of handlers) {
    let decision: BeforeToolCallResult;
    try {
      decision = await record.handler({ name, args: current });
    } catch (e) {
      return {
        args: current,
        blocked: blockedToolResult(name, record.owner, `handler failed: ${errorText(e)}`),
      };
    }
    if (typeof decision === "string") {
      // Convenience form: a returned string is a block reason.
      return { args: current, blocked: blockedToolResult(name, record.owner, decision) };
    }
    if (!isRecord(decision)) continue;
    const next = decision as BeforeToolCallDecision;
    if (isRecord(next["args"])) current = next["args"] as Record<string, unknown>;
    const block = next["block"];
    if (block === true) {
      return { args: current, blocked: blockedToolResult(name, record.owner, "") };
    }
    if (typeof block === "string" && block.trim().length > 0) {
      return { args: current, blocked: blockedToolResult(name, record.owner, block) };
    }
  }
  return { args: current, blocked: null };
}

export type AfterOutcome = {
  content: string;
  isError: boolean;
};

// Apply after handlers sequentially; each sees the previous patch. Never
// throws: a throwing handler fails open to the content so far.
export async function applyAfterInterceptors(
  handlers: ReadonlyArray<InterceptRecord<AfterToolCallHandler>>,
  input: AfterToolCallInput
): Promise<AfterOutcome> {
  let content = input.result;
  const isError = input.isError;
  for (const record of handlers) {
    let decision: AfterToolCallResult;
    try {
      decision = await record.handler({ name: input.name, args: input.args, result: content, isError });
    } catch {
      continue;
    }
    if (typeof decision === "string") {
      content = decision;
      continue;
    }
    if (!isRecord(decision)) continue;
    const patch = (decision as AfterToolCallDecision)["content"];
    if (typeof patch === "string") content = patch;
  }
  return { content, isError };
}
