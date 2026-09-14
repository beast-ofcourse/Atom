// Issue 03: structured tool-result — kinds travel, prose never decides.
// Pins kinds, not wording: rewording any human-facing message must not
// change classification when the kind travels explicitly.
import { describe, expect, test } from "vitest";
import {
  classifyExecutorText,
  isErrorKind,
  kindFromDecision,
  structurePipelineResult,
  type ToolResultKind,
} from "../src/agent/tool-result.js";
import { classifyToolResult } from "../src/telemetry.js";
import { ErrorStreakTracker } from "../src/agent/loop-guard.js";

describe("tool-result kinds", () => {
  test("ok is the only non-error kind", () => {
    expect(isErrorKind("ok")).toBe(false);
    for (const k of ["denied", "invalid-args", "unknown-tool", "failed", "timed-out"] as ToolResultKind[]) {
      expect(isErrorKind(k)).toBe(true);
    }
  });

  test("single classification point maps legacy executor strings", () => {
    expect(classifyExecutorText("all good")).toBe("ok");
    expect(classifyExecutorText("")).toBe("ok");
    expect(classifyExecutorText('Error: unknown tool "nope"')).toBe("unknown-tool");
    expect(classifyExecutorText("Error: invalid call: bad args")).toBe("invalid-args");
    expect(classifyExecutorText("Error: invalid JSON arguments")).toBe("invalid-args");
    expect(classifyExecutorText("Error: denied by user: bash")).toBe("denied");
    expect(classifyExecutorText('Error: blocked by extension "x": nope')).toBe("denied");
    expect(classifyExecutorText("Error: read timed out after 1000ms")).toBe("timed-out");
    expect(classifyExecutorText("Error: something failed")).toBe("failed");
  });

  test("pipeline decisions map without reading wording", () => {
    expect(kindFromDecision("unknown-tool", "anything")).toBe("unknown-tool");
    expect(kindFromDecision("invalid-args", "anything")).toBe("invalid-args");
    expect(kindFromDecision("invalid-json", "anything")).toBe("invalid-args");
    expect(kindFromDecision("repetition-guard", "anything")).toBe("invalid-args");
    expect(kindFromDecision("denied", "anything")).toBe("denied");
    expect(kindFromDecision("blocked", "anything")).toBe("denied");
    expect(kindFromDecision("truncated", "anything")).toBe("failed");
    expect(kindFromDecision("executed", "ok text")).toBe("ok");
    expect(kindFromDecision("executed", "Error: boom")).toBe("failed");
    expect(kindFromDecision("executed", "Error: read timed out after 5ms")).toBe("timed-out");
  });

  test("structurePipelineResult carries kind with text", () => {
    const s = structurePipelineResult("denied", "Error: denied by user: bash");
    expect(s).toEqual({ text: "Error: denied by user: bash", kind: "denied" });
  });
});

describe("kind-not-prose: rewording breaks no classification", () => {
  test("telemetry reads kind when present, ignoring reworded text", () => {
    // Same kind, totally different wording → same classification.
    expect(classifyToolResult("totally reworded denial text", { kind: "denied" })).toEqual({
      success: false,
      errorKind: "denied",
    });
    expect(classifyToolResult("totally reworded success", { kind: "ok" })).toEqual({ success: true });
    expect(classifyToolResult("totally reworded timeout", { kind: "timed-out" })).toEqual({
      success: false,
      errorKind: "timed-out",
    });
    expect(classifyToolResult("totally reworded failure", { kind: "failed" })).toEqual({
      success: false,
      errorKind: "tool-error",
    });
    expect(classifyToolResult("totally reworded bad args", { kind: "invalid-args" })).toEqual({
      success: false,
      errorKind: "invalid-args",
    });
    expect(classifyToolResult("totally reworded unknown", { kind: "unknown-tool" })).toEqual({
      success: false,
      errorKind: "unknown-tool",
    });
  });

  test("gates read kind via noteKind (error streak holds on kinds, not words)", () => {
    const t = new ErrorStreakTracker(2);
    t.noteKind("ok");
    expect(t.current).toBe(0);
    t.noteKind("failed");
    t.noteKind("timed-out");
    expect(t.current).toBe(2);
    // Reworded text is irrelevant — the kind drove the streak.
    t.noteKind("ok");
    expect(t.current).toBe(0);
  });
});
