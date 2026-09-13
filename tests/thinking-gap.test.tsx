// Thinking-gap regression: the `◐ Thinking… · Ns` live-zone line must only
// appear in the submit→first-output window — never after output exists, and
// never stuck after the turn ends (the core-path early return used to skip
// the turn-boundary drain, leaving App `busy` true with an empty live zone:
// a `Thinking… · 61s` spinner plus a `thinking…` status line on a finished
// answer).
//
// Layer 1 (this file): the LiveTail gap guard (`hasHadOutput`) hides the gap
// line once any output appeared, while leaving real content untouched.
// Layer 2 (structural, in src/App.tsx): the core path now awaits
// drainTurnBoundary before returning, so App busy/timer/phase always clear.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { LiveTail } from "../src/ui/live-tail.js";
import { reduceAgentEvent, type AdapterState } from "../src/ui/agent-adapter.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

const BASE = {
  isEmpty: false,
  sessionHint: false,
  draft: null,
  thinking: null,
  busy: true,
  held: false,
  toolHint: null,
  toolElapsedSecs: null,
  elapsedSecs: 61,
  showThinking: true,
} as const;

describe("LiveTail thinking-gap guard", () => {
  test("busy with no output yet shows the Thinking gap line (legacy behavior)", () => {
    const frame = frameOf(<LiveTail {...BASE} />);
    expect(frame).toContain("Thinking");
    expect(frame).toContain("61s");
  });

  test("gap line hides once output appeared this turn (hasHadOutput)", () => {
    const frame = frameOf(<LiveTail {...BASE} hasHadOutput />);
    expect(frame).not.toContain("Thinking");
  });

  test("omitted prop keeps legacy behavior (existing call sites unchanged)", () => {
    const frame = frameOf(
      <LiveTail
        isEmpty={false}
        sessionHint={false}
        draft={null}
        thinking={null}
        busy
        toolHint={null}
        toolElapsedSecs={null}
        elapsedSecs={3}
      />
    );
    expect(frame).toContain("Thinking");
  });

  test("guard never hides real content: draft still renders", () => {
    const frame = frameOf(<LiveTail {...BASE} draft="hello back" hasHadOutput />);
    expect(frame).toContain("hello back");
    expect(frame).not.toContain("61s");
  });

  test("idle renders nothing live regardless of the guard", () => {
    const frame = frameOf(<LiveTail {...BASE} busy={false} hasHadOutput />);
    expect(frame).not.toContain("Thinking");
  });
});

const ADAPTER_BASE: AdapterState = {
  turns: [],
  thinking: null,
  draft: null,
  toolHint: null,
  toolElapsedSecs: null,
  busy: true,
  error: null,
  records: [],
};

describe("adapter busy contract (App drain agreement)", () => {
  test("agent.completed clears adapter busy (App drain clears App busy)", () => {
    const next = reduceAgentEvent(ADAPTER_BASE, {
      type: "agent.completed",
      result: "done",
      at: new Date().toISOString(),
    });
    expect(next.busy).toBe(false);
    expect(next.draft).toBe(null);
    expect(next.thinking).toBe(null);
    expect(next.toolHint).toBe(null);
  });

  test("agent.error clears adapter busy", () => {
    const next = reduceAgentEvent(ADAPTER_BASE, {
      type: "agent.error",
      error: "boom",
      at: new Date().toISOString(),
    });
    expect(next.busy).toBe(false);
  });

  test("tool.completed keeps the loop label and attaches a summary", () => {
    const next = reduceAgentEvent(ADAPTER_BASE, {
      type: "tool.completed",
      toolCallId: "t1",
      name: "read",
      kind: "file",
      label: "⚙ read src/App.tsx [offset=5086, limit=50]",
      result: "5086: line one\n5087: line two\n",
      durationMs: 12,
      at: new Date().toISOString(),
    });
    expect(next.turns).toHaveLength(1);
    expect(next.turns[0]?.content).toBe("⚙ read src/App.tsx [offset=5086, limit=50]");
    expect(next.turns[0]?.summary).toBe("2 lines");
    expect(next.toolHint).toBe(null);
    expect(next.records).toHaveLength(1);
  });

  test("tool.failed keeps the loop label and pairs the detail line", () => {
    const next = reduceAgentEvent(ADAPTER_BASE, {
      type: "tool.failed",
      toolCallId: "t2",
      name: "grep",
      kind: "search",
      label: "⚙ grep foo src",
      error: "Error: ripgrep blew up\nsecond line",
      durationMs: 7,
      at: new Date().toISOString(),
    });
    expect(next.turns).toHaveLength(2);
    expect(next.turns[0]?.content).toBe("⚙ grep foo src");
    expect(next.turns[1]?.content).toContain("ripgrep blew up");
    expect(next.turns[1]?.error).toBe(true);
  });
});
