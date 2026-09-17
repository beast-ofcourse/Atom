// Extreme-fast Phase 0.4: perf probe gates. Same-value churn must paint
// nothing; one appended turn paints exactly one row; streaming markdown
// bails on identical text. Loop-protocol pins (audit line, slow suffix)
// ride along so perf work can never silently change them.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  TranscriptView,
  transcriptRenderProbe,
  transcriptRowRenderProbe,
  type Turn,
} from "../src/ui/transcript.js";
import { MarkdownStream, streamParseProbe } from "../src/ui/markdown.js";
import {
  parseMarkdown,
  parseMarkdownStreamIncremental,
  streamFullParseProbe,
} from "../src/ui/markdown.js";
import { TOOL_SLOW_MS, ToolLine } from "../src/ui/markdown.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("extreme perf probes", () => {
  test("same-props transcript rerender paints nothing", () => {
    const turns: Turn[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ];
    const app = render(<TranscriptView turns={turns} clearGen={0} />);
    try {
      const base = transcriptRenderProbe.count;
      const rowBase = transcriptRowRenderProbe.count;
      app.rerender(<TranscriptView turns={turns} clearGen={0} />);
      expect(transcriptRenderProbe.count).toBe(base);
      expect(transcriptRowRenderProbe.count).toBe(rowBase);
    } finally {
      app.unmount();
    }
  });

  test("appending one turn paints exactly one new row", () => {
    const turns: Turn[] = [{ role: "user", content: "q" }];
    const app = render(<TranscriptView turns={turns} clearGen={0} />);
    try {
      const rowBase = transcriptRowRenderProbe.count;
      app.rerender(<TranscriptView turns={[...turns, { role: "assistant", content: "a" }]} clearGen={0} />);
      expect(transcriptRowRenderProbe.count - rowBase).toBe(1);
    } finally {
      app.unmount();
    }
  });

  test("identical draft text bails out of parse", () => {
    const app = render(<MarkdownStream text="hello **world**" />);
    try {
      const base = streamParseProbe.count;
      app.rerender(<MarkdownStream text="hello **world**" />);
      expect(streamParseProbe.count).toBe(base);
      app.rerender(<MarkdownStream text="hello **world!!**" />);
      expect(streamParseProbe.count).toBe(base + 1);
    } finally {
      app.unmount();
    }
  });

  test("loop-protocol paint pins hold", () => {
    expect(frameOf(<ToolLine content="⚙ read src/a.ts" ms={12} />)).toContain("⚙ read src/a.ts");
    expect(frameOf(<ToolLine content="⚙ bash t" ms={TOOL_SLOW_MS} />)).toContain("· 2s");
    expect(frameOf(<ToolLine content="⚙ read src/a.ts" ms={12} />)).not.toContain("·");
  });

  test("incremental streaming parse converges with full parse", () => {
    const doc = "# Title\n\nFirst para with **bold**.\n\n- a\n- b\n\n```ts\ncode()\n```\n\nTail para here.";
    expect(parseMarkdownStreamIncremental(doc)).toEqual(parseMarkdown(doc));
    // Open fence spanning the split falls back to full parse, same result.
    const open = "# T\n\n```ts\nunclosed code here\nmore code";
    expect(parseMarkdownStreamIncremental(open)).toEqual(parseMarkdown(open));
  });

  test("append-only stream bounds big parses, tails stay cheap", () => {
    const base = streamFullParseProbe.count;
    let text = "Para one flowing in.";
    const paras = ["Para two arrives.", "Para three with **bold**.", "Para four ends it."];
    for (const p of paras) {
      for (let i = 1; i <= p.length; i++) {
        parseMarkdownStreamIncremental(`${text}\n\n${p.slice(0, i)}`);
      }
      text = `${text}\n\n${p}`;
    }
    // One big parse per new paragraph head (+ initial), never per keystroke.
    expect(streamFullParseProbe.count - base).toBeLessThanOrEqual(paras.length + 2);
  });
});
