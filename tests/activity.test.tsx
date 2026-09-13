// Working-state tests: activity verbs, hint parsing, the thinking-gap
// line, and the approval-wait status segment. States render from data
// only — no timers, no animation frames.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  activityText,
  activityVerb,
  parseActivityHint,
} from "../src/ui/activity.js";
import { LiveTail } from "../src/ui/live-tail.js";
import { StatusBar } from "../src/ui/status-bar.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("activity model", () => {
  test("every known tool has a verb", () => {
    for (const name of [
      "read", "write", "edit", "grep", "glob", "bash", "bash_output",
      "webfetch", "websearch", "todowrite", "todo_update", "todo_get", "ask_question",
    ]) {
      expect(activityVerb(name), name).toBeTruthy();
    }
  });
  test("hint parsing handles bare names and full labels", () => {
    expect(parseActivityHint("read")).toEqual({ name: "read", target: "" });
    expect(parseActivityHint("⚙ read src/zen.ts")).toEqual({ name: "read", target: "src/zen.ts" });
    expect(parseActivityHint("⚙ bash pnpm test")).toEqual({ name: "bash", target: "pnpm test" });
  });
  test("activity text prefers verbs, falls back to bare names", () => {
    expect(activityText("read")).toBe("Reading");
    expect(activityText("⚙ grep pattern")).toBe("Searching pattern");
    expect(activityText("⚙ bash pnpm test")).toBe("Running pnpm test");
    expect(activityText("frobnicate widget")).toBe("frobnicate widget");
    expect(activityText("frobnicate")).toBe("frobnicate");
  });
});

describe("thinking-gap line", () => {
  const idle = {
    isEmpty: false,
    sessionHint: false,
    draft: null,
    thinking: null,
    toolHint: null,
    toolElapsedSecs: null,
  };
  test("shows only when busy with zero output yet", () => {
    const gap = frameOf(<LiveTail {...idle} busy elapsedSecs={7} />);
    expect(gap).toContain("◐ Thinking… · 7s");
    // Any live output suppresses it — no competing lines.
    expect(frameOf(<LiveTail {...idle} busy elapsedSecs={7} draft="hi" />)).not.toContain("◐");
    expect(frameOf(<LiveTail {...idle} busy elapsedSecs={7} thinking="hmm" />)).not.toContain("◐");
    expect(frameOf(<LiveTail {...idle} busy elapsedSecs={7} toolHint="read" />)).not.toContain("◐");
    expect(frameOf(<LiveTail {...idle} busy={false} elapsedSecs={0} />)).not.toContain("◐");
  });
});

describe("approval-wait segment", () => {
  const base = {
    provider: "opencode-zen",
    model: "big-pickle",
    usageTotals: null,
    contextLoad: null,
    reasoningDisplay: "default",
    mode: "normal",
    trustAll: false,
    busy: true,
    phaseLabel: "tool…",
    elapsedSecs: 4,
    stalled: false,
  };
  test("marks the wait without duplicating the modal", () => {
    const frame = frameOf(<StatusBar {...base} columns={130} approvalPending />);
    expect(frame).toContain("waiting approval");
  });
  test("absent otherwise — even when stalled", () => {
    const frame = frameOf(<StatusBar {...base} approvalPending={false} stalled />);
    expect(frame).not.toContain("waiting approval");
    expect(frame).toContain("waiting…");
  });
});
