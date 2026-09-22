// TurnEvents sink: ONE ordered observer stream beside the existing
// agentic-loop callbacks (see AgenticOpts in ./types.js).
//
// Why it exists: tool identity today travels as display-label strings parsed
// downstream (see describeToolCall in ../tools.js) — this sink carries the
// stable identity instead (toolCallId + tool name), in commit order, so a
// future consumer (transcript/TUI, ticket 02) never parses labels.
//
// Contract:
// - Additive only: the loop invokes every existing callback exactly as
//   before, then reports the same fact to the sink. Callbacks stay
//   byte-identical; the sink is observer-only.
// - Never throws: every emission is guarded — a throwing sink method degrades
//   to a skip, never breaks the turn (same rule as telemetry).
// - Ordered: tool-started precedes its tool-finished; phase events mirror the
//   onPhase callback order; token/thinking mirror onToken/onThinking.
// - Identities are stable strings (toolCallId, tool name, Phase values) —
//   never display-label text.
import type { Phase } from "./types.js";

// Position of the call within its step's tool_calls block (0-based). Stable
// for the turn; lets a consumer re-pair started/finished without parsing.
export type ToolStartedInfo = {
  toolCallId: string;
  name: string;
  index: number;
};

export type ToolFinishedInfo = {
  toolCallId: string;
  name: string;
  isError: boolean;
};

// One ordered observer sink beside the AgenticOpts callbacks. Every method is
// optional; absent means that fact is not observed. Each method mirrors one
// existing callback fact:
// - onToken mirrors onToken (accumulated text, same value; `step` tags the
//   loop step that produced it — same contract as StreamCallbacks).
// - onThinking mirrors onThinking (accumulated thinking, same value; same
//   step tag).
// - onPhase mirrors onPhase (same phase + detail).
// - onToolStarted mirrors onPhase("tool", name), plus the stable toolCallId.
// - onToolFinished mirrors onToolActivity, keyed by toolCallId + name instead
//   of the display label (the result string stays on the callback — the sink
//   carries identity, not payloads).
export type TurnEventsSink = {
  onToken?: (text: string, step?: number) => void;
  onThinking?: (thinking: string, step?: number) => void;
  onPhase?: (phase: Phase, detail?: string) => void;
  onToolStarted?: (info: ToolStartedInfo) => void;
  onToolFinished?: (info: ToolFinishedInfo) => void;
};

// Guarded emission: runs emit against the sink, swallowing observer errors so
// a throwing sink can never break the turn. No-op when the sink is absent.
export function emitTurnEvent(
  sink: TurnEventsSink | undefined,
  emit: (sink: TurnEventsSink) => void
): void {
  if (!sink) return;
  try {
    emit(sink);
  } catch {
    // observer errors never break the loop
  }
}
