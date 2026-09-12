// WebUI event protocol: the SSE vocabulary the browser consumes.
//
// Every kind maps 1:1 to an existing ATOM callback or sink — nothing is
// invented. The runtime (./runtime.js) translates, this module only defines
// and serializes:
//
// - token / thinking  ← StreamCallbacks.onToken / onThinking (accumulated
//   text, same value the TUI renders in its live tail)
// - phase             ← StreamCallbacks.onPhase ("thinking" | "streaming" |
//   "tool" | "retry" | "done", detail carries the tool name / retry summary)
// - tool_delta        ← StreamCallbacks.onToolDelta (name revealed mid-stream)
// - tool_started /
//   tool_finished      ← TurnEventsSink.onToolStarted / onToolFinished
//   (stable toolCallId + name + index / isError — never display labels)
// - tool_call          ← the approve() gate decision (name + effective args +
//   description + decision + provenance — the only pre-execution arg source)
// - tool_activity     ← AgenticOpts.onToolActivity (label + result + isError)
// - tool_result        ← AgenticOpts.onToolResult (name + effective args +
//   result + isError for EVERY committed call, including read-only tools
//   that never consult approve; result text capped, see truncateEventText)
// - file_diff          ← write/edit commits only: op (created/modified) +
//   pre-computed unified hunks + side-by-side rows from src/ui/diff.ts
//   (the same engine the TUI approval preview uses), all text-capped.
//   ATOM has no delete tool and bash side effects are opaque by design
//   (see src/rollback.ts), so deletions never appear as file events.
// - usage             ← AgenticOpts.onUsage (API-reported tokens only)
// - reasoning         ← AgenticOpts.onReasoning (per-POST reasoning label)
// - warning           ← StreamCallbacks.onWarning
// - approval_request /
//   approval_resolved  ← the approve() gate (write/edit/bash in normal mode;
//   the turn blocks until the browser POSTs a decision)
// - question_request /
//   question_resolved  ← the askUser() hook (ask_question tool; same blocking
//   contract as approvals)
// - message           ← committed transcript turns (user/assistant/tool rows)
// - error             ← failed POST / tool-throw abort (caller rolls back)
// - done / cancelled  ← clean turn end / LoopCancelledError rollback
//
// Pure module: types + SSE serialization only. No I/O, no loop imports.

export type WebEventKind =
  | "token"
  | "thinking"
  | "phase"
  | "tool_delta"
  | "tool_started"
  | "tool_finished"
  | "tool_call"
  | "tool_activity"
  | "tool_result"
  | "file_diff"
  | "usage"
  | "reasoning"
  | "warning"
  | "approval_request"
  | "approval_resolved"
  | "question_request"
  | "question_resolved"
  | "message"
  | "error"
  | "done"
  | "cancelled";

export type WebEvent = {
  /** Monotonic per-session sequence (1-based; lets the UI detect gaps). */
  seq: number;
  /** ISO timestamp of emission. */
  at: string;
  kind: WebEventKind;
  /** Kind-specific payload (plain JSON; secrets never enter here). */
  data: Record<string, unknown>;
};

export function createWebEvent(seq: number, kind: WebEventKind, data?: Record<string, unknown>): WebEvent {
  return {
    seq,
    at: new Date().toISOString(),
    kind,
    data: data ?? {},
  };
}

// Serialize one event as an SSE frame. `id:` carries the sequence so an
// EventSource client resumes without gaps; `event:` carries the kind so the
// browser dispatches without parsing the body first.
export function formatSSE(event: WebEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

// SSE response headers shared by every event stream on the server.
export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Connection: "keep-alive",
  };
}

// Parse one SSE frame back (tests + future resumable clients). Returns null
// for heartbeats/comments or malformed frames — never throws.
export function parseSSEFrame(frame: string): WebEvent | null {
  try {
    const lines = frame.split("\n");
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!dataLine) return null;
    const parsed: unknown = JSON.parse(dataLine.slice("data:".length).trim());
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o["seq"] !== "number" || typeof o["kind"] !== "string") return null;
    return parsed as WebEvent;
  } catch {
    return null;
  }
}

// Reconnect replay: events after the client's last seen id, oldest first.
// Pure (unit-tested); the runtime and the SSE route share it.
export function eventsAfter(log: WebEvent[], lastEventId: number | undefined): WebEvent[] {
  if (typeof lastEventId !== "number" || !Number.isFinite(lastEventId)) return [];
  return log.filter((e) => e.seq > lastEventId);
}

// Heartbeat comment (keeps proxies/load-balancers from closing idle turns).
export function sseHeartbeat(): string {
  return `: ping\n\n`;
}
