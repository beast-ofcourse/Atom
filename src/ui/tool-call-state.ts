// Tool-call running state: the single deterministic state machine behind
// the live "running" line (LiveTail Progress + status-bar activity).
//
// Why a machine: the running indication used to be two independent writers
// (onToolDelta during argument streaming, onPhase("tool") at execution
// start) sharing a bare `string | null` hint plus a timestamp ref. Every
// transition below is total and order-explicit, so the lifecycle is:
//
//   idle --announced--> pending --started--> running --finished--> idle
//   idle --started--> running              (delta-less transports)
//   pending --finished--> idle             (denied/failed before execution)
//   any --cleared--> idle                  (next POST, turn end, cancel)
//
// - announced: transport revealed the tool name mid-stream (arguments still
//   arriving). The line shows early so streaming feels alive; the announce
//   time doubles as the duration fallback (same as the old toolStartRef,
//   which deltas also stamped) until execution restarts the clock.
// - started: execution began. Duration measures from here (display-only).
//   Restarts are idempotent: a duplicate started keeps the original
//   startedAt so duration never rewinds.
// - finished: the loop committed the result (success or failure — both are
//   terminal; the transcript owns them now).
// - cleared: anything that proves no tool is running (a new model POST, turn
//   teardown, cancellation).
//
// Pure + total: unknown/duplicate events are no-ops, never throws. The App
// holds one machine in a ref (state) and mirrors the name into `toolHint`
// state (render trigger) through a single writer — no second source.
export type ToolCallStatus = "idle" | "pending" | "running";

export type ToolCallMachine =
  | { status: "idle" }
  | { status: "pending"; name: string; startedAt: number }
  | { status: "running"; name: string; startedAt: number };

export type ToolCallEvent =
  | { kind: "announced"; name: string }
  | { kind: "started"; name: string }
  | { kind: "finished" }
  | { kind: "cleared" };

export const IDLE_TOOL_CALL: ToolCallMachine = { status: "idle" };

export function transitionToolCall(
  state: ToolCallMachine,
  event: ToolCallEvent,
  now: number
): ToolCallMachine {
  switch (event.kind) {
    case "announced": {
      if (state.status === "running") return state;
      if (state.status === "pending") {
        // Name fragments stream in ("re" -> "read"): track the latest text,
        // keep the original announce time.
        if (state.name === event.name) return state;
        return { status: "pending", name: event.name, startedAt: state.startedAt };
      }
      return { status: "pending", name: event.name, startedAt: now };
    }
    case "started": {
      if (state.status === "running") {
        // Duplicate start (delta + phase for the same call): never rewind
        // the clock — duration measures from first execution start.
        if (state.name === event.name) return state;
        return { status: "running", name: event.name, startedAt: state.startedAt };
      }
      return { status: "running", name: event.name, startedAt: now };
    }
    case "finished":
    case "cleared": {
      if (state.status === "idle") return state;
      return { status: "idle" };
    }
  }
}

/** Render name for the live line, or null when no tool is active. */
export function toolCallDisplayName(state: ToolCallMachine): string | null {
  return state.status === "idle" ? null : state.name;
}
