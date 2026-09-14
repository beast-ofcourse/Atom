// Structured tool-result module (issue 03): every tool outcome carries its
// kind alongside its text, classified once at a single point. The loop,
// telemetry, and gate modules decide from the kind — never by parsing
// message wording.
//
// Kinds: ok | denied | invalid-args | unknown-tool | failed | timed-out
//  - ok: execution succeeded (or an intercepted tool resolved cleanly).
//  - denied: user denied ("no") or an extension pre-hook blocked the call.
//    Both are policy refusals — nothing executed.
//  - invalid-args: model mistake — bad JSON, failed validation, or the
//    repetition-guard guidance. Never executed.
//  - unknown-tool: name not in the registry. Never executed.
//  - failed: executed but errored, or a truncated response (nothing valid
//    to run). Includes generic `Error:` executor failures and blocked
//    fallthroughs that predate this module.
//  - timed-out: the outer timeout fired (or an executor reports a timeout).
//
// Dependency-free (no imports) so pipeline, loop, telemetry, and gates can
// all share it with no cycle risk (see tests/architecture.test.ts).
export type ToolResultKind =
  | "ok"
  | "denied"
  | "invalid-args"
  | "unknown-tool"
  | "failed"
  | "timed-out";

export type StructuredToolResult = {
  /** Human-facing text (unchanged — rewording never changes the kind). */
  text: string;
  /** Machine kind decided once at the classification point. */
  kind: ToolResultKind;
};

export function isErrorKind(kind: ToolResultKind): boolean {
  return kind !== "ok";
}

// The SINGLE prose-sniffing point in the codebase for legacy executor
// strings. Everything else reads `kind`. Executors still return plain
// strings today, so this fallback classifies them once; pipeline decisions
// (unknown/blocked/invalid/denied) bypass it via kindFromDecision below.
export function classifyExecutorText(text: unknown): ToolResultKind {
  if (typeof text !== "string" || !text.startsWith("Error")) return "ok";
  if (/timed out/i.test(text)) return "timed-out";
  if (/unknown tool/i.test(text)) return "unknown-tool";
  if (/invalid call|invalid JSON/i.test(text)) return "invalid-args";
  if (/denied by user|blocked by/i.test(text)) return "denied";
  return "failed";
}

// Map a pipeline terminal decision to its kind. Executed/ask-question/
// goal-report decisions resolve from text (the executor or the intercepted
// runner produced it); all others are decided without reading any wording.
export function kindFromDecision(
  decision:
    | "unknown-tool"
    | "blocked"
    | "invalid-args"
    | "invalid-json"
    | "repetition-guard"
    | "truncated"
    | "ask-question"
    | "goal-report"
    | "denied"
    | "executed",
  text?: string
): ToolResultKind {
  switch (decision) {
    case "unknown-tool":
      return "unknown-tool";
    case "invalid-args":
    case "invalid-json":
    case "repetition-guard":
      return "invalid-args";
    case "denied":
    case "blocked":
      return "denied";
    case "truncated":
      return "failed";
    case "ask-question":
    case "goal-report":
    case "executed":
      return classifyExecutorText(text ?? "");
  }
}

export function structurePipelineResult(
  decision: Parameters<typeof kindFromDecision>[0],
  text: string
): StructuredToolResult {
  return { text, kind: kindFromDecision(decision, text) };
}
