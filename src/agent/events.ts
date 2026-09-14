// Semantic Event Stream: the contract between ATOM Core and any frontend.
//
// Core (src/agent/*, src/zen.ts, src/tools/*) emits these events; frontends
// (Ink TUI, WebUI, API) consume them via a TUI State Adapter. No frontend
// code touches tool executors, retry loops, or history directly — the stream
// is the single source for `what happened`.
//
// Design:
// - Pure types + emitter, no Ink, no DOM, no `process.stdout`.
// - Every event is serializable plain JSON (no functions) so WebUI/API can
//   forward it over SSE/websocket without translation.
// - Ordered: `agent.started` → (thinking|message|tool)* → `agent.completed|error`
// - Stable ids: `toolCallId` (loop-generated) + `turnId` (per-user-message),
//   never display-label strings.
// - Additive: existing loop callbacks (onToken, onToolActivity, turnEvents)
//   keep working; this stream is the *normalized* view that replaces them for
//   frontends. Core maps its internal callbacks to these events in one place.
//
// Desired architecture (prompt):
//   ATOM Core → Semantic Event Stream → TUI State Adapter → Ink Components → Terminal
// The core never imports `ink`; the TUI never imports `src/tools/executeTool`
// or `src/zen:runAgenticLoopForProvider` directly.

import type { Usage } from "./types.js";

// ---------------------------------------------------------------------------
// Event definitions (prompt list + `cancelled` for completeness)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent.started"; turnId: string; input: string; at: string }
  | { type: "agent.thinking.started"; at: string }
  | { type: "agent.thinking.delta"; delta: string; accumulated: string; at: string }
  | { type: "agent.thinking.completed"; thinking: string; at: string }
  | { type: "message.started"; at: string }
  | { type: "message.delta"; delta: string; accumulated: string; at: string }
  | { type: "message.completed"; message: string; at: string }
  | { type: "tool.started"; toolCallId: string; name: string; kind: string; args: Record<string, unknown>; at: string }
  | { type: "tool.progress"; toolCallId: string; progress: string; at: string }
  | { type: "tool.completed"; toolCallId: string; name: string; kind: string; label: string; result: string; durationMs: number; diff?: import("../ui/diff.js").DiffPreview | null; approvalVia?: string | null; at: string }
  | { type: "tool.failed"; toolCallId: string; name: string; kind: string; label: string; error: string; durationMs: number; diff?: import("../ui/diff.js").DiffPreview | null; approvalVia?: string | null; at: string }
  | { type: "usage.reported"; usage: Usage; at: string }
  | { type: "agent.error"; error: string; at: string }
  | { type: "agent.completed"; result: string; usage?: Usage; at: string }
  | { type: "agent.cancelled"; reason: string; at: string };

// Strict kind helpers (exhaustiveness checked)
export type AgentEventKind = AgentEvent["type"];

// Distributive Omit for discriminated union — `Omit<Union,"at">` alone
// collapses to an intersection; this keeps the `type` discriminator.
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type AgentEventWithoutAt = DistributiveOmit<AgentEvent, "at">;

// ---------------------------------------------------------------------------
// Emitter: tiny, dependency-free, testable
// ---------------------------------------------------------------------------

export type AgentEventListener = (event: AgentEvent) => void;

export function createEventEmitter() {
  const listeners = new Set<AgentEventListener>();
  let seq = 0;
  function nowIso(): string {
    try {
      return new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  return {
    // Subscribe — returns unsubscribe. Listener never breaks emitter.
    on(listener: AgentEventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Emit one event to all listeners (guarded). `at` is auto-stamped if
    // missing so call sites may omit it for brevity.
    emit(event: AgentEvent): void {
      for (const l of [...listeners]) {
        try {
          l(event);
        } catch {
          // listener errors never break core
        }
      }
    },
    // Convenience: emit without `at` (stamped here). Also accepts
    // full `AgentEvent` with `at` already present (e.g., `agent.completed`).
    emitPartial(event: AgentEventWithoutAt | AgentEvent): void {
      const withAt = "at" in event && typeof (event as { at?: string }).at === "string"
        ? (event as AgentEvent)
        : ({ ...event, at: nowIso() } as AgentEvent);
      for (const l of [...listeners]) {
        try {
          l(withAt);
        } catch {
          // listener errors never break core
        }
      }
    },
    // For testing: count listeners
    count(): number {
      return listeners.size;
    },
  };
}

export type AgentEventEmitter = ReturnType<typeof createEventEmitter>;

// ---------------------------------------------------------------------------
// Helpers: tool kind (semantic, not execution) — keep in sync with
// src/ui/tool-model.ts but do not import UI (core must stay Ink-free).
// This is the *core's* view of kind; UI may refine it for presentation.
// ---------------------------------------------------------------------------

export function toolKindFor(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === "bash" || n === "bash_output") return "terminal";
  if (n === "read" || n === "write" || n === "edit") return "file";
  if (n === "grep" || n === "glob") return "search";
  if (n === "webfetch" || n === "websearch") return "web";
  if (n === "todowrite" || n === "todo_get" || n === "todo_update") return "todo";
  if (n === "ask_question") return "interaction";
  if (n === "update_goal") return "goal";
  return "generic";
}

// Turn id factory (monotonic, no external dep)
let turnSeq = 0;
export function nextTurnId(): string {
  turnSeq += 1;
  return `turn_${turnSeq}_${Date.now().toString(36)}`;
}
