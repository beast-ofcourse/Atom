// Tool-call running-state machine: deterministic lifecycle of the live
// "running" line (pending -> running -> completed | failed | cancelled).
// Pure transition table — no React, no timers, no network.
import { describe, expect, test } from "vitest";
import {
  IDLE_TOOL_CALL,
  toolCallDisplayName,
  transitionToolCall,
  type ToolCallMachine,
} from "../src/ui/tool-call-state.js";

function run(events: Array<{ kind: "announced"; name: string } | { kind: "started"; name: string } | { kind: "finished" } | { kind: "cleared" }>): ToolCallMachine {
  let s: ToolCallMachine = IDLE_TOOL_CALL;
  let t = 1000;
  for (const e of events) {
    t += 10;
    s = transitionToolCall(s, e, t);
  }
  return s;
}

describe("tool-call running-state machine", () => {
  test("idle -> announced -> pending (line shows early, duration falls back to announce time)", () => {
    const s = run([{ kind: "announced", name: "re" }]);
    expect(s).toEqual({ status: "pending", name: "re", startedAt: 1010 });
    expect(toolCallDisplayName(s)).toBe("re");
    expect(toolCallDisplayName(IDLE_TOOL_CALL)).toBeNull();
  });

  test("name fragments update the pending text without moving the clock", () => {
    const s = run([
      { kind: "announced", name: "re" },
      { kind: "announced", name: "read" },
    ]);
    expect(s).toEqual({ status: "pending", name: "read", startedAt: 1010 });
  });

  test("pending -> started -> running (duration restarts at execution)", () => {
    const s = run([
      { kind: "announced", name: "read" },
      { kind: "started", name: "read" },
    ]);
    expect(s.status).toBe("running");
    expect((s as { startedAt: number }).startedAt).toBe(1020);
  });

  test("delta-less transports start straight from idle", () => {
    const s = run([{ kind: "started", name: "bash" }]);
    expect(s).toEqual({ status: "running", name: "bash", startedAt: 1010 });
  });

  test("duplicate started never rewinds the duration clock", () => {
    const s = run([
      { kind: "started", name: "read" },
      { kind: "started", name: "read" },
    ]);
    expect(s).toEqual({ status: "running", name: "read", startedAt: 1010 });
  });

  test("running ignores further announced fragments", () => {
    const s = run([
      { kind: "started", name: "read" },
      { kind: "announced", name: "read" },
    ]);
    expect(s).toEqual({ status: "running", name: "read", startedAt: 1010 });
  });

  test("finished returns to idle (completed and failed share the terminal edge)", () => {
    expect(run([{ kind: "started", name: "read" }, { kind: "finished" }])).toEqual(
      IDLE_TOOL_CALL
    );
    expect(run([{ kind: "announced", name: "read" }, { kind: "finished" }])).toEqual(
      IDLE_TOOL_CALL
    );
  });

  test("cleared returns to idle from any state (next POST, turn end, cancel)", () => {
    expect(run([{ kind: "started", name: "read" }, { kind: "cleared" }])).toEqual(
      IDLE_TOOL_CALL
    );
    expect(run([{ kind: "announced", name: "read" }, { kind: "cleared" }])).toEqual(
      IDLE_TOOL_CALL
    );
    expect(run([{ kind: "cleared" }])).toEqual(IDLE_TOOL_CALL);
  });

  test("finished while idle is a no-op (stray commit never fabricates state)", () => {
    const s = run([{ kind: "finished" }]);
    expect(s).toEqual(IDLE_TOOL_CALL);
  });

  test("a new call starts cleanly after a finish (no stale name leaks sideways)", () => {
    const s = run([
      { kind: "started", name: "read" },
      { kind: "finished" },
      { kind: "announced", name: "bash" },
    ]);
    expect(s).toEqual({ status: "pending", name: "bash", startedAt: 1030 });
  });
});
