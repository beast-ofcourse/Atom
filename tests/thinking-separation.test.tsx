// Thinking/answer separation: the thinking block reads as one grouped unit
// (dim labeled header + quoteBar divider) in both the live tail and the
// committed transcript, structurally distinct from the answer body.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { LiveTail, LIVE_THINKING_LINES } from "../src/ui/live-tail.js";
import { renderTranscriptItem, type StaticItem } from "../src/ui/transcript.js";
import { theme } from "../src/ui/theme.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const liveBase = {
  isEmpty: false,
  sessionHint: false,
  draft: null,
  busy: true,
  elapsedSecs: 3,
  toolHint: null,
  toolElapsedSecs: null,
} as const;

describe("thinking separation", () => {
  test("live thinking block carries label + quoteBar divider, tail window intact", () => {
    const frame = stripAnsi(
      frameOf(<LiveTail {...liveBase} thinking={"line one\nline two"} showThinking />)
    );
    expect(frame).toContain(`${theme.symbol.thinking} thinking`);
    expect(frame).toContain(`${theme.symbol.quoteBar} line one`);
    expect(frame).toContain(`${theme.symbol.quoteBar} line two`);
    // Answer styling untouched: no assistant speaker label inside a
    // thinking-only live frame.
    expect(frame).not.toContain(theme.symbol.speakerAssistant);
  });

  test("live thinking tail still windows with truncation marker", () => {
    const lines = Array.from({ length: LIVE_THINKING_LINES + 5 }, (_, i) => `wline-${i}`);
    const frame = stripAnsi(
      frameOf(<LiveTail {...liveBase} thinking={lines.join("\n")} showThinking />)
    );
    expect(frame).toContain(`${theme.symbol.thinking} thinking`);
    expect(frame).toContain(theme.symbol.ellipsis);
    expect(frame).toContain(`wline-${lines.length - 1}`);
    expect(frame).not.toContain("wline-0");
  });

  test("committed thinking block carries label + quoteBar divider inside one row", () => {
    const item: StaticItem = {
      id: "turn-0",
      turn: { role: "assistant", content: "first musing\nsecond musing", thinking: true },
    };
    const frame = stripAnsi(frameOf(renderTranscriptItem(item)));
    expect(frame).toContain(`${theme.symbol.thinking} thinking`);
    expect(frame).toContain(`${theme.symbol.quoteBar} first musing`);
    expect(frame).toContain(`${theme.symbol.quoteBar} second musing`);
    expect(frame).not.toContain(theme.symbol.speakerAssistant);
  });

  test("/thinking toggle still hides the live block", () => {
    const frame = stripAnsi(
      frameOf(<LiveTail {...liveBase} thinking="hidden musing" showThinking={false} />)
    );
    expect(frame).not.toContain("hidden musing");
    expect(frame).not.toContain(`${theme.symbol.quoteBar} hidden musing`);
  });
});
