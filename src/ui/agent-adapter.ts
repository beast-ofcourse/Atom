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
import {
  applyStepDelta,
  commitLiveBlockTurns,
  commitStepBlocks,
  completeToolBlock,
  consumeDoneToolBlocks,
  startToolBlock,
  type StepBlock,
} from "./step-blocks.js";
import { theme } from "./theme.js";
import { createPaintScheduler, type PaintSchedulerOptions } from "./paint-scheduler.js";

export type AdapterState = {
  turns: Turn[];
  thinking: string | null;
  draft: string | null;
  // Step-ordered live blocks: per-step thinking/text/tool segments filed by
  // the loop-step tag on each delta event. Committed to transcript turns by
  // the completed/failed handlers (same block-to-turn mapping as App, via
  // commitLiveBlockTurns), so the live list never duplicates the transcript.
  // Cleared whenever the live zone clears.
  stepBlocks: StepBlock[];
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
      return { ...state, busy: true, error: null, toolHint: null, thinking: null, draft: null, stepBlocks: [] };
    }
    case "agent.thinking.started": {
      return { ...state, thinking: "" };
    }
    case "agent.thinking.delta": {
      // Step-tagged live block: the delta lands in its own step's thinking
      // segment; the single lane above still carries the latest text for
      // the legacy live zone. Untagged events read as step 0 inside
      // applyStepDelta.
      return {
        ...state,
        thinking: event.accumulated,
        stepBlocks: applyStepDelta(state.stepBlocks, { step: event.step, lane: "thinking", text: event.accumulated }),
      };
    }
    case "agent.thinking.completed": {
      // Move completed thinking to transcript turns so it survives in
      // scrollback (same as App's `commitThinking`). Finished thinking
      // blocks commit as own turns in list order; the cumulative is fallback
      // only when no block carries the text. Also clear live.
      const { finished, rest } = commitStepBlocks(state.stepBlocks, "thinking");
      const thinkingTurns: Turn[] = finished.map((b) => ({
        role: "assistant" as const,
        content: b.text,
        thinking: true as const,
      }));
      if (thinkingTurns.length === 0 && event.thinking.trim()) {
        thinkingTurns.push({ role: "assistant" as const, content: event.thinking, thinking: true });
      }
      return { ...state, turns: [...state.turns, ...thinkingTurns], thinking: null, stepBlocks: rest };
    }
    case "message.started": {
      return { ...state, draft: "" };
    }
    case "message.delta": {
      return {
        ...state,
        draft: event.accumulated,
        stepBlocks: applyStepDelta(state.stepBlocks, { step: event.step, lane: "text", text: event.accumulated }),
      };
    }
    case "message.completed": {
      // Assistant message completed — move the draft to transcript turns.
      // Finished text blocks commit as own turns in list order (same as
      // App's turn-end commit); the single-turn shape is fallback only when
      // no block carries the text. The core already pushed to history; we
      // push to turns here.
      const { finished, rest } = commitStepBlocks(state.stepBlocks, "text");
      const blockTurns: Turn[] = finished.map((b) => ({ role: "assistant" as const, content: b.text }));
      if (blockTurns.length > 0) {
        return { ...state, turns: [...state.turns, ...blockTurns], draft: null, stepBlocks: rest };
      }
      const content = event.message.trim() ? event.message : state.draft ?? "";
      if (!content.trim()) return { ...state, draft: null };
      const nextTurns = [...state.turns, { role: "assistant" as const, content }];
      return { ...state, turns: nextTurns, draft: null };
    }
    case "tool.started": {
      // Live hint: `⚙ name target` — same as before, but derived from event.
      // The call also joins the ordered live list as a running block (same
      // lifecycle as App's onToolStarted), so the live zone shows one row.
      const target = event.args && typeof event.args["path"] === "string" ? (event.args["path"] as string)
        : typeof event.args["command"] === "string" ? (event.args["command"] as string)
        : typeof event.args["pattern"] === "string" ? (event.args["pattern"] as string)
        : typeof event.args["query"] === "string" ? (event.args["query"] as string)
        : "";
      const label = `${theme.symbol.toolMark} ${event.name}${target ? ` ${target}` : ""}`;
      return {
        ...state,
        toolHint: label,
        toolElapsedSecs: 0,
        stepBlocks: startToolBlock(state.stepBlocks, { step: 0, hint: label }),
      };
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
      // Same lifecycle as App's onToolActivity: the running block flips to
      // done, inter-tool chatter commits above the tool line, and the done
      // block leaves the live list once its transcript turn lands — never a
      // running row after the audit line, never a double paint.
      const flipped = completeToolBlock(state.stepBlocks, {
        label,
        durationMs: event.durationMs,
        summary,
        errorLine: null,
      });
      const stream = commitLiveBlockTurns(flipped);
      const nextTurns = [
        ...state.turns,
        ...stream.turns,
        { role: "tool" as const, content: label, ms: event.durationMs, summary, diff: event.diff ?? null, approvalVia: event.approvalVia ?? null },
      ];
      return {
        ...state,
        turns: nextTurns,
        records: [...state.records, rec].slice(-50),
        toolHint: null,
        toolElapsedSecs: null,
        stepBlocks: consumeDoneToolBlocks(stream.rest),
      };
    }
    case "tool.failed": {
      const label = event.label ?? `${theme.symbol.toolMark} ${event.name}`;
      const rec = createToolRecord(Date.now(), label, event.error, true, event.durationMs);
      const errorLine = event.error.split("\n", 1)[0] ?? event.error;
      const flipped = completeToolBlock(state.stepBlocks, {
        label,
        durationMs: event.durationMs,
        summary: null,
        errorLine,
      });
      const stream = commitLiveBlockTurns(flipped);
      const nextTurns = [
        ...state.turns,
        ...stream.turns,
        { role: "tool" as const, content: label, ms: event.durationMs, approvalVia: event.approvalVia ?? null },
        { role: "tool" as const, content: `  ${theme.symbol.detailMark} ${errorLine}`, error: true as const },
      ];
      return {
        ...state,
        turns: nextTurns,
        records: [...state.records, rec].slice(-50),
        toolHint: null,
        toolElapsedSecs: null,
        stepBlocks: consumeDoneToolBlocks(stream.rest),
      };
    }
    case "agent.error": {
      return { ...state, busy: false, error: event.error, draft: null, thinking: null, toolHint: null, stepBlocks: [] };
    }
    case "agent.completed": {
      // `message.completed` already pushed the assistant turn; just clear busy.
      return { ...state, busy: false, toolHint: null, toolElapsedSecs: null, thinking: null, draft: null, stepBlocks: [] };
    }
    case "agent.cancelled": {
      const nextTurns = [...state.turns, { role: "tool" as const, content: "(cancelled) conversation rolled back" }];
      return { ...state, turns: nextTurns, busy: false, draft: null, thinking: null, toolHint: null, stepBlocks: [] };
    }
    default:
      return state;
  }
}

// Delta coalescing gate between AgentCore and React state.
//
// Core emits ONE event per SSE chunk (`message.delta` /
// `agent.thinking.delta`) — at 200 tok/s that is 200 reducer applications
// per second, each queuing an App-body render (the mirror effect in App
// writes every adapter update to the stream store). That per-token render
// storm is the streaming jitter. The gate coalesces delta bursts with the
// SAME paint scheduler the TUI already uses for the legacy path (one Ink
// frame window, leading-immediate + trailing-latest-wins), so React state
// updates land on frame quanta at most once per frame per lane.
//
// Latest-wins per lane is provably safe here: delta events carry the full
// cumulative text (`accumulated`), so any dropped intermediate delta is
// strictly superseded by the next one in the same lane. Full delta EVENTS
// (not text) are stored so the loop's `step` tag rides along and
// multi-step interleaving keeps filing blocks into the right step.
//
// Any non-delta event (started / completed / tool.* / error / cancelled)
// folds the pending deltas and the event into ONE ordered setState
// (pending first, then the event — reducer order preserved), then cancels
// the scheduler. A trailing timer can therefore never fire after a
// completed/cancelled event and resurrect cleared text.
//
// `apply` receives a reducer fold — the same shape as React's
// `setState(fn)` — so the hook wires it through unchanged.
export type AgentEventSink = {
  handle: (event: AgentEvent) => void;
  dispose: () => void;
};

export function createAgentEventSink(
  apply: (fold: (prev: AdapterState) => AdapterState) => void,
  schedulerOpts?: Partial<PaintSchedulerOptions<AgentEvent>>,
): AgentEventSink {
  let disposed = false;
  const scheduler = createPaintScheduler<AgentEvent>({
    ...schedulerOpts,
    onFlush: (lanes) => {
      // One flush = one state update. Fold thinking before draft: the two
      // lanes write disjoint state (thinking vs draft fields, separate
      // step-block lanes), so order between them is cosmetic — this keeps
      // it deterministic regardless of map iteration.
      apply((prev) => {
        let next = prev;
        if (lanes.thinking !== undefined) next = reduceAgentEvent(next, lanes.thinking);
        if (lanes.draft !== undefined) next = reduceAgentEvent(next, lanes.draft);
        return next;
      });
    },
  });
  return {
    handle(event) {
      if (disposed) return;
      if (event.type === "message.delta") {
        scheduler.push("draft", event);
        return;
      }
      if (event.type === "agent.thinking.delta") {
        scheduler.push("thinking", event);
        return;
      }
      // Non-delta: fold pending deltas + this event into ONE update, then
      // reset so the trailing timer is gone (no resurrection, and the next
      // stream paints immediately again).
      // Pending lanes are captured BEFORE apply: React defers setState(fn)
      // updaters until render, so a read inside the reducer would run after
      // the reset() below and see null — silently dropping the last ≤34 ms
      // of stream text. Captured locals keep the fold order regardless of
      // when React executes the updater.
      const pendingThinking = scheduler.getPending("thinking");
      const pendingDraft = scheduler.getPending("draft");
      apply((prev) => {
        let next = prev;
        if (pendingThinking !== null) next = reduceAgentEvent(next, pendingThinking);
        if (pendingDraft !== null) next = reduceAgentEvent(next, pendingDraft);
        return reduceAgentEvent(next, event);
      });
      scheduler.reset();
    },
    dispose() {
      disposed = true;
      scheduler.reset();
    },
  };
}

// React hook: subscribes an AgentCore and drives UI state via the reducer.
// No business logic, no tool execution, no retry — just event → state.
export function useAgentAdapter(agent: AgentCore | null, initialTurns: Turn[] = []): AdapterState & { reset: (turns: Turn[]) => void } {
  const [state, setState] = useState<AdapterState>(() => ({
    turns: initialTurns,
    thinking: null,
    draft: null,
    stepBlocks: [],
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
    // Deltas coalesce through the frame-batched sink (one state update per
    // paint window, not per token); every other event folds pending deltas
    // and itself into a single update. See createAgentEventSink.
    const sink = createAgentEventSink((fold) => setState(fold));
    const unsub = agent.onEvent(sink.handle);
    return () => {
      unsub();
      // Drop pending deltas + any trailing timer so an unmount can never
      // flush stale text into the next agent's state.
      sink.dispose();
    };
  }, [agent]);

  // Keep elapsed tick for live tool (1s busy tick) — derived, not business.
  // The tick is still owned by App's `TURN_TICK_MS` interval; the adapter
  // just exposes `toolElapsedSecs` that App updates via `setElapsed`.
  // For now, the adapter holds it as null; App's interval drives it.

  const reset = (turns: Turn[]) => setState((prev) => ({ ...prev, turns, thinking: null, draft: null, stepBlocks: [], toolHint: null, busy: false, error: null }));

  return { ...state, reset };
}
