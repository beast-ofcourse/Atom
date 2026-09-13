// TUI State Adapter: transforms Core's Semantic Event Stream into Ink UI state.
//
// Core → Event Stream → Adapter → Ink Components → Terminal
//
// This is the ONLY place where Ink/React state (`Turn`, `ToolCallModel`,
// `streamStore`, `toolCallMachine`) is derived from agent events. No
// component calls `runAgenticLoop` or `executeTool` directly; no business
// logic (retry, permission, tool routing) lives here — the adapter just
// maps `AgentEvent` to the shape `TranscriptView`, `LiveTail`, `ToolCall`
// already expect.
//
// The adapter is deliberately thin: it mirrors the event order into the
// existing `Turn` model so the conversation stays the primary surface and
// the diff/inspector/tool panels keep working without a rewrite.
// Future frontends (WebUI, API) reuse the same `AgentEvent` stream with a
// different adapter; core stays Ink-free.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "../agent/events.js";
import type { AgentCore } from "../agent/core.js";
import type { Turn } from "./transcript.js";
import { createToolRecord, type ToolRecord } from "./tool-inspector.js";
import { deriveSummary, getToolKind, parseLabel } from "./tool-model.js";
import { theme } from "./theme.js";

export type AdapterState = {
  turns: Turn[];
  thinking: string | null;
  draft: string | null;
  toolHint: string | null;
  toolElapsedSecs: number | null;
  busy: boolean;
  error: string | null;
  records: ToolRecord[];
};

// Pure reducer: one event → next adapter state. No I/O, no history, no
// tool execution — just UI shape. Exported for unit testing.
export function reduceAgentEvent(state: AdapterState, event: AgentEvent): AdapterState {
  switch (event.type) {
    case "agent.started": {
      // User echo is already in `turns` via App's submit; adapter just marks busy.
      return { ...state, busy: true, error: null, toolHint: null, thinking: null, draft: null };
    }
    case "agent.thinking.started": {
      return { ...state, thinking: "" };
    }
    case "agent.thinking.delta": {
      return { ...state, thinking: event.accumulated };
    }
    case "agent.thinking.completed": {
      // Move completed thinking to transcript as a `thinking:true` turn so it
      // survives in scrollback (same as App's `commitThinking`). Also clear live.
      const nextTurns = [...state.turns, { role: "assistant" as const, content: event.thinking, thinking: true }];
      return { ...state, turns: nextTurns, thinking: null };
    }
    case "message.started": {
      return { ...state, draft: "" };
    }
    case "message.delta": {
      return { ...state, draft: event.accumulated };
    }
    case "message.completed": {
      // Assistant message completed — move draft to transcript.
      // The core already pushed to history; we push to turns here.
      const content = event.message.trim() ? event.message : state.draft ?? "";
      if (!content.trim()) return { ...state, draft: null };
      const nextTurns = [...state.turns, { role: "assistant" as const, content }];
      return { ...state, turns: nextTurns, draft: null };
    }
    case "tool.started": {
      // Live hint: `⚙ name target` — same as before, but derived from event
      const target = event.args && typeof event.args["path"] === "string" ? (event.args["path"] as string)
        : typeof event.args["command"] === "string" ? (event.args["command"] as string).slice(0, 80)
        : typeof event.args["pattern"] === "string" ? (event.args["pattern"] as string)
        : typeof event.args["query"] === "string" ? (event.args["query"] as string)
        : "";
      const label = `${theme.symbol.toolMark} ${event.name}${target ? ` ${target}` : ""}`;
      return { ...state, toolHint: label, toolElapsedSecs: 0 };
    }
    case "tool.progress": {
      return { ...state, toolHint: event.progress };
    }
    case "tool.completed": {
      // The loop-produced audit label rides the event (offsets, dirs, and
      // all) — the adapter never rebuilds what the loop already formatted.
      // The args-built fallback covers only headless/synthetic events.
      const label = event.label ?? `${theme.symbol.toolMark} ${event.name}`;
      const target = parseLabel(label).target;
      const summary = deriveSummary(getToolKind(event.name), event.name, target, event.result, false);
      // Records for inspector (capped elsewhere)
      const rec = createToolRecord(Date.now(), label, event.result, false, event.durationMs);
      const nextTurns = [...state.turns, { role: "tool" as const, content: label, ms: event.durationMs, summary, diff: event.diff ?? null, approvalVia: event.approvalVia ?? null }];
      return { ...state, turns: nextTurns, records: [...state.records, rec].slice(-50), toolHint: null, toolElapsedSecs: null };
    }
    case "tool.failed": {
      const label = event.label ?? `${theme.symbol.toolMark} ${event.name}`;
      const rec = createToolRecord(Date.now(), label, event.error, true, event.durationMs);
      const nextTurns = [
        ...state.turns,
        { role: "tool" as const, content: label, ms: event.durationMs, approvalVia: event.approvalVia ?? null },
        { role: "tool" as const, content: `  ${theme.symbol.detailMark} ${event.error.split("\n", 1)[0]}`, error: true as const },
      ];
      return { ...state, turns: nextTurns, records: [...state.records, rec].slice(-50), toolHint: null, toolElapsedSecs: null };
    }
    case "agent.error": {
      return { ...state, busy: false, error: event.error, draft: null, thinking: null, toolHint: null };
    }
    case "agent.completed": {
      // `message.completed` already pushed the assistant turn; just clear busy.
      return { ...state, busy: false, toolHint: null, toolElapsedSecs: null, thinking: null, draft: null };
    }
    case "agent.cancelled": {
      const nextTurns = [...state.turns, { role: "tool" as const, content: "(cancelled) conversation rolled back" }];
      return { ...state, turns: nextTurns, busy: false, draft: null, thinking: null, toolHint: null };
    }
    default:
      return state;
  }
}

// React hook: subscribes an AgentCore and drives UI state via the reducer.
// No business logic, no tool execution, no retry — just event → state.
export function useAgentAdapter(agent: AgentCore | null, initialTurns: Turn[] = []): AdapterState & { reset: (turns: Turn[]) => void } {
  const [state, setState] = useState<AdapterState>(() => ({
    turns: initialTurns,
    thinking: null,
    draft: null,
    toolHint: null,
    toolElapsedSecs: null,
    busy: false,
    error: null,
    records: [],
  }));
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!agent) return;
    const unsub = agent.onEvent((event) => {
      // Coalesce thinking/message deltas via the same throttle the TUI
      // already uses (streamStore) is not needed here — the adapter just
      // sets state, and React batches. For `delta` bursts we could throttle,
      // but the existing `createDraftThrottler` in App already coalesces
      // before emitting, so this stays cheap.
      setState((prev) => reduceAgentEvent(prev, event));
    });
    return unsub;
  }, [agent]);

  // Keep elapsed tick for live tool (1s busy tick) — derived, not business.
  // The tick is still owned by App's `TURN_TICK_MS` interval; the adapter
  // just exposes `toolElapsedSecs` that App updates via `setElapsed`.
  // For now, the adapter holds it as null; App's interval drives it.

  const reset = (turns: Turn[]) => setState((prev) => ({ ...prev, turns, thinking: null, draft: null, toolHint: null, busy: false, error: null }));

  return { ...state, reset };
}
