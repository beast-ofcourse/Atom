// Ticket 03 — collapsible tool blocks.
//
// Pins the transcript-as-story contract: every retained tool call reads as
// one compact collapsed line (state glyph, name, target, duration where
// useful); the full output expands in place through the one shared
// inspector mechanism (never a second model, never in <Static>); large
// outputs truncate with an explicit remainder; expanding/collapsing never
// repaints committed rows (ticket 01 flicker contract holds).
//
// Network is ALWAYS mocked here — never hit live APIs.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { theme } from "../src/ui/theme.js";
import {
  InspectorPanel,
  VIEWPORT_LINES,
  createToolRecord,
  toolBlockState,
  type ToolRecord,
} from "../src/ui/tool-inspector.js";
import {
  TranscriptView,
  transcriptRenderProbe,
  transcriptRowRenderProbe,
  type Turn,
} from "../src/ui/transcript.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function rec(partial: Partial<ToolRecord> & { label: string }): ToolRecord {
  return {
    id: 0,
    result: "",
    truncated: false,
    isError: false,
    ms: 0,
    lineCount: 0,
    ...partial,
  };
}

describe("toolBlockState", () => {
  test("success, failure, and denial resolve distinctly", () => {
    expect(toolBlockState(rec({ label: "⚙ read a.ts" }))).toBe("ok");
    expect(toolBlockState(rec({ label: "⚙ bash t", isError: true, result: "Error: nope" }))).toBe(
      "failed"
    );
    expect(
      toolBlockState(
        rec({ label: "⚙ write b.ts", isError: true, result: "Error: denied by user: write" })
      )
    ).toBe("denied");
  });
});

describe("collapsed one-liners: glyph, name, target, state, duration", () => {
  const records = [
    rec({ id: 1, label: "⚙ read src/a.ts", ms: 50 }),
    rec({ id: 2, label: "⚙ bash pnpm test", ms: 5200 }),
    rec({ id: 3, label: "⚙ write src/b.ts", isError: true, result: "Error: nope", ms: 30 }),
    rec({
      id: 4,
      label: "⚙ edit src/c.ts",
      isError: true,
      result: "Error: denied by user: edit",
      ms: 10,
    }),
  ];
  test("every row carries an explicit state glyph from theme tokens", () => {
    const frame = frameOf(<InspectorPanel records={records} index={0} expanded={false} scroll={0} />);
    // Glyphs render from the single token source — never ad-hoc literals.
    expect(frame).toContain(theme.symbol.toolOk);
    expect(frame).toContain(theme.symbol.toolFail);
    expect(frame).toContain(theme.symbol.toolDenied);
    // Name + target survive verbatim on every row.
    expect(frame).toContain("⚙ read src/a.ts");
    expect(frame).toContain("⚙ bash pnpm test");
    expect(frame).toContain("⚙ write src/b.ts");
    expect(frame).toContain("⚙ edit src/c.ts");
  });
  test("duration shows only where useful (slow runs)", () => {
    const frame = frameOf(<InspectorPanel records={records} index={1} expanded={false} scroll={0} />);
    expect(frame).toContain("· 5s");
    expect(frame).not.toContain("· 0s");
  });
});

describe("expanded view: full output with remainder indicators", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `detail-${i + 1}`);
  const record = rec({
    id: 7,
    label: "⚙ bash pnpm test",
    result: lines.join("\n"),
    ms: 3200,
    lineCount: 50,
  });
  test("header repeats the collapsed one-liner state, body viewports with counts", () => {
    const top = frameOf(<InspectorPanel records={[record]} index={0} expanded scroll={0} />);
    expect(top).toContain(theme.symbol.toolOk);
    expect(top).toContain("⚙ bash pnpm test");
    expect(top).toContain("· 3s");
    expect(top).toContain("detail-1");
    expect(top).toContain(`detail-${VIEWPORT_LINES}`);
    expect(top).not.toContain(`detail-${VIEWPORT_LINES + 1}`);
    const mid = frameOf(<InspectorPanel records={[record]} index={0} expanded scroll={10} />);
    expect(mid).toContain("↑ 10 more");
    expect(mid).toContain("↓ 20 more");
  });
  test("over-cap outputs truncate with an explicit remainder notice", () => {
    const big = createToolRecord(8, "⚙ read big.bin", "x".repeat(40000), false, 12);
    expect(big.truncated).toBe(true);
    const frame = frameOf(<InspectorPanel records={[big]} index={0} expanded scroll={0} />);
    expect(frame).toContain("truncated at");
  });
});

describe("expand/collapse never repaints committed rows", () => {
  test("inspector open/expand/scroll leaves the Static transcript untouched", () => {
    const turns: Turn[] = [
      { role: "user", content: "collapsible question" },
      { role: "assistant", content: "collapsible answer" },
      { role: "tool", content: "⚙ read src/kept.ts" },
    ];
    const records = [
      rec({ id: 1, label: "⚙ read src/kept.ts", result: "kept", ms: 40 }),
      rec({ id: 2, label: "⚙ bash slow", result: "slow out", ms: 9000 }),
    ];
    const frame = (expanded: boolean, index: number, scroll: number) => (
      <>
        <TranscriptView turns={turns} clearGen={1} />
        <InspectorPanel records={records} index={index} expanded={expanded} scroll={scroll} />
      </>
    );
    const app = render(frame(false, 0, 0));
    try {
      expect(app.lastFrame()).toContain("collapsible question");
      expect(app.lastFrame()).toContain("⚙ read src/kept.ts");
      const rowsBefore = transcriptRowRenderProbe.count;
      const viewBefore = transcriptRenderProbe.count;
      // The whole expand/collapse/navigate cycle, all in the dynamic zone.
      app.rerender(frame(true, 0, 0));
      app.rerender(frame(true, 1, 5));
      app.rerender(frame(false, 1, 0));
      app.rerender(frame(true, 0, 12));
      app.rerender(frame(false, 0, 0));
      expect(transcriptRowRenderProbe.count).toBe(rowsBefore);
      expect(transcriptRenderProbe.count).toBe(viewBefore);
      expect(app.lastFrame()).toContain("collapsible question");
      expect(app.lastFrame()).toContain("⚙ read src/kept.ts");
    } finally {
      app.unmount();
    }
  });
});
