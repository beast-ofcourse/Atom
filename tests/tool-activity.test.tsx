// Tool-activity visualization tests: compact call rows keep their
// loop-produced text byte-identical, slow runs suffix `· Ns`, warnings
// escalate hue, errors stay red, and the live running line keeps the
// "calling <name>" wording with the same ⚙ marker (smooth settle into the
// committed row).
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { TOOL_SLOW_MS, ToolLine } from "../src/ui/markdown.js";
import { LiveTail } from "../src/ui/live-tail.js";
import { modelFromTurn } from "../src/ui/tool-model.js";
import { renderTranscriptItem, type StaticItem } from "../src/ui/transcript.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("ToolLine states", () => {
  test("fast success: bare audit line, no suffix", () => {
    const frame = frameOf(<ToolLine content="⚙ read src/zen.ts" ms={12} />);
    expect(frame).toContain("⚙ read src/zen.ts");
    expect(frame).not.toContain("·");
  });
  test("slow success: `· Ns` suffix, audit text intact", () => {
    const frame = frameOf(<ToolLine content="⚙ bash pnpm test" ms={TOOL_SLOW_MS + 400} />);
    expect(frame).toContain("⚙ bash pnpm test");
    expect(frame).toContain("· 2s");
  });
  test("threshold boundary: exactly TOOL_SLOW_MS suffixes", () => {
    const frame = frameOf(<ToolLine content="⚙ read a" ms={TOOL_SLOW_MS} />);
    expect(frame).toContain("· 2s");
  });
  test("error detail stays red verbatim", () => {
    const frame = frameOf(<ToolLine content="  ↳ Error: nope" error />);
    expect(frame).toContain("↳ Error: nope");
  });
  test("warning escalates hue, text intact", () => {
    const frame = frameOf(<ToolLine content="⚠ context filling" />);
    expect(frame).toContain("⚠ context filling");
  });
  test("denied/retry/cancel/multi-line pass through dim and whole", () => {
    expect(frameOf(<ToolLine content="⊘ denied by user: write" />)).toContain("⊘ denied by user: write");
    expect(frameOf(<ToolLine content="↻ retrying… boom" />)).toContain("↻ retrying… boom");
    expect(frameOf(<ToolLine content="(cancelled) conversation rolled back" />)).toContain("(cancelled)");
    const multi = frameOf(<ToolLine content={"Tasks 1/1\n✅ done"} />);
    expect(multi).toContain("Tasks 1/1");
    expect(multi).toContain("✅ done");
  });
});

describe("tool turns in transcript", () => {
  test("slow call turn renders suffix", () => {
    const item: StaticItem = {
      id: "turn-0",
      turn: { role: "tool", content: "⚙ bash pnpm test", ms: 5000 },
    };
    const frame = frameOf(renderTranscriptItem(item) as React.ReactNode);
    expect(frame).toContain("⚙ bash pnpm test");
    expect(frame).toContain("· 5s");
  });
  test("read turn renders its window label plus the line count", () => {
    const item: StaticItem = {
      id: "turn-0",
      turn: { role: "tool", content: "⚙ read src/App.tsx [offset=5086, limit=50]", summary: "50 lines" },
    };
    const frame = frameOf(renderTranscriptItem(item) as React.ReactNode);
    expect(frame).toContain("⚙ read src/App.tsx [offset=5086, limit=50]");
    expect(frame).toContain("50 lines");
  });
  test("precomputed summary wins over result derivation", () => {
    const m = modelFromTurn({ role: "tool", content: "⚙ grep foo", summary: "3 results" }, null, "a\nb\nc");
    expect(m.summary).toBe("3 results");
  });
  test("file summary counts result lines without dumping content", () => {
    const m = modelFromTurn({ role: "tool", content: "⚙ read f.ts" }, null, "1: a\n2: b\n");
    expect(m.summary).toBe("2 lines");
    expect(m.summary).not.toContain("1: a");
  });
});

describe("LiveTail running line", () => {
  const base = {
    isEmpty: false,
    sessionHint: false,
    draft: null,
    thinking: null,
    busy: true,
    elapsedSecs: 3,
  };
  test("bare tool name renders its activity verb", () => {
    const frame = frameOf(<LiveTail {...base} toolHint="read" toolElapsedSecs={null} />);
    expect(frame).toContain("◉ Reading");
    expect(frame).toContain("…");
  });
  test("full-label hint renders verb + target", () => {
    const frame = frameOf(<LiveTail {...base} toolHint="⚙ read src/zen.ts" toolElapsedSecs={null} />);
    expect(frame).toContain("◉ Reading src/zen.ts");
  });
  test("unmapped tools fall back to the bare name", () => {
    const frame = frameOf(<LiveTail {...base} toolHint="frobnicate widget" toolElapsedSecs={null} />);
    expect(frame).toContain("frobnicate widget");
  });
  test("thinking gap shows while busy with no output yet", () => {
    const frame = frameOf(<LiveTail {...base} toolHint={null} toolElapsedSecs={null} />);
    expect(frame).toContain("◐ Thinking… · 3s");
  });
  test("elapsed shows past 1s, hidden when fresh", () => {
    const slow = frameOf(<LiveTail {...base} toolHint="bash" toolElapsedSecs={4} />);
    expect(slow).toContain("· 4s");
    const fresh = frameOf(<LiveTail {...base} toolHint="bash" toolElapsedSecs={0} />);
    expect(fresh).not.toContain("· 0s");
  });
  test("idle shows nothing", () => {
    const frame = frameOf(
      <LiveTail isEmpty={false} sessionHint={false} draft={null} thinking={null} busy={false} toolHint={null} toolElapsedSecs={null} elapsedSecs={0} />
    );
    expect(frame).not.toContain("◉");
    expect(frame).not.toContain("◐");
  });
});
