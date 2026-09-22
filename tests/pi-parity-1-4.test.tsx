// Phase 1 + 4 parity pins (plans/tui-pi-parity.md): per-block thinking
// collapse (admit-level + TUI frame shrink/restore) and input-model
// grapheme cursor + paste-marker atomicity.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  THINKING_COLLAPSE_KEY_LABEL,
  TranscriptView,
  admitStaticBatch,
  collapseToggleIndex,
  renderTranscriptItem,
  type Turn,
} from "../src/ui/transcript.js";
import {
  backspaceAtomic,
  deleteForwardAtomic,
  expandPasteMarkers,
  expandRangeOverMarkers,
  graphemeIndexForVisualWidth,
  moveCursorLeftAtomic,
  moveCursorRightAtomic,
  nextGraphemeBoundary,
  offsetOfLines,
  lineColOf,
  prevGraphemeBoundary,
  pushPasteChunk,
  pasteMarkerFor,
  shouldCollapseToMarker,
  splitInputLines,
  splitLineAtGrapheme,
} from "../src/ui/input-model.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("phase 1: per-block thinking collapse", () => {
  const thinking = (content: string): Turn => ({
    role: "assistant",
    content,
    thinking: true,
  });
  test("collapsed id admits a summary item with line count", () => {
    const turns: Turn[] = [thinking("a\nb\nc")];
    const batch = admitStaticBatch(turns, 0, 1, true, new Set(["turn-0"]));
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.collapsedThinkingLines).toBe(3);
    expect(batch.items[0]!.turn).toBe(turns[0]);
    expect(batch.next).toBe(1);
  });
  test("default (no set) is byte-identical; non-thinking untouched", () => {
    const turns: Turn[] = [
      thinking("x\ny"),
      { role: "assistant", content: "answer" },
      { role: "user", content: "hi" },
    ];
    const a = admitStaticBatch(turns, 0, 3, true);
    const b = admitStaticBatch(turns, 0, 3, true, new Set());
    expect(b).toEqual(a);
    expect(a.items[1]!.collapsedThinkingLines).toBeUndefined();
    expect(a.items[2]!.collapsedThinkingLines).toBeUndefined();
    const collapsed = admitStaticBatch(turns, 0, 3, true, new Set(["turn-1"]));
    // turn-1 is not thinking: untouched, no summary marker.
    expect(collapsed.items[1]!.collapsedThinkingLines).toBeUndefined();
  });
  test("summary names the toggle key; showThinking unchanged", () => {
    const turns: Turn[] = [thinking("a\nb")];
    const batch = admitStaticBatch(turns, 0, 1, true, new Set(["turn-0"]));
    const frame = frameOf(renderTranscriptItem(batch.items[0]!));
    expect(frame).toContain("2 lines");
    expect(frame).toContain(THINKING_COLLAPSE_KEY_LABEL);
    expect(frame).not.toContain("a\nb");
    // Hidden-thinking path still skips entirely.
    const hidden = admitStaticBatch(turns, 0, 1, false, new Set(["turn-0"]));
    expect(hidden.items).toHaveLength(0);
  });
  test("toggle target is the most recent thinking block, null when none", () => {
    const turns: Turn[] = [
      thinking("t0"),
      { role: "assistant", content: "a" },
      thinking("t2"),
    ];
    expect(collapseToggleIndex(turns, null)).toBe(2);
    expect(collapseToggleIndex(turns, 2)).toBe(0);
    expect(
      collapseToggleIndex([{ role: "assistant", content: "a" }], null),
    ).toBeNull();
  });
  test("TUI: collapse shrinks the frame, expand restores", () => {
    const body = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n");
    const turns: Turn[] = [thinking(body)];
    const app = render(<TranscriptView turns={turns} clearGen={1} />);
    const full = app.lastFrame() ?? "";
    expect(full).toContain("line-9");
    app.rerender(
      <TranscriptView
        turns={turns}
        clearGen={1}
        collapsedIds={new Set(["turn-0"])}
        collapsedGen={1}
      />,
    );
    const collapsed = app.lastFrame() ?? "";
    expect(collapsed).toContain("10 lines");
    expect(collapsed).not.toContain("line-9");
    expect(collapsed.length).toBeLessThan(full.length);
    app.rerender(<TranscriptView turns={turns} clearGen={1} collapsedGen={2} />);
    const restored = app.lastFrame() ?? "";
    expect(restored).toContain("line-9");
    app.unmount();
  });
});

describe("phase 4: grapheme cursor", () => {
  test("emoji/ZWJ/CJK survive line/col round-trips", () => {
    const text = "a\u{1F600}b\n\u4E2D\u6587\n\u{1F468}\u200D\u{1F469}\u200D\u{1F467}!";
    const lines = splitInputLines(text);
    for (let off = 0; off <= text.length; off++) {
      const { line, col } = lineColOf(text, off);
      const back = offsetOfLines(lines, line, col);
      // Round-trip lands on a grapheme boundary at or before the probe.
      expect(back).toBeLessThanOrEqual(off);
      expect(lineColOf(text, back)).toEqual({ line, col });
    }
  });
  test("grapheme steps never split clusters", () => {
    const s = "a\u{1F600}b";
    expect(nextGraphemeBoundary(s, 0)).toBe(1);
    expect(nextGraphemeBoundary(s, 1)).toBe(3);
    expect(prevGraphemeBoundary(s, 3)).toBe(1);
    // Interior offset snaps down first, then steps (never slices a surrogate).
    expect(prevGraphemeBoundary(s, 2)).toBe(0);
    expect(backspaceAtomic(s, 2).text).toBe("\u{1F600}b");
    const { at } = splitLineAtGrapheme(s, 1);
    expect(at).toBe("\u{1F600}");
  });
  test("CJK width tracks visually on vertical motion", () => {
    expect(graphemeIndexForVisualWidth("\u4E2D\u6587ab", 4)).toBe(2);
    const text = "\u4E2D\u6587abcdef\nxy";
    const { line, col } = lineColOf(text, offsetOfLines(splitInputLines(text), 0, 2));
    expect(line).toBe(0);
    expect(col).toBe(2);
  });
});

describe("phase 4: paste markers", () => {
  test("threshold: 10 lines or 1000 chars", () => {
    expect(shouldCollapseToMarker("a\nb")).toBe(false);
    expect(shouldCollapseToMarker(Array(10).fill("x").join("\n"))).toBe(true);
    expect(shouldCollapseToMarker("x".repeat(1000))).toBe(false);
    expect(shouldCollapseToMarker("x".repeat(1001))).toBe(true);
  });
  test("cursor steps over the whole marker; kills take it whole", () => {
    const marker = pasteMarkerFor(1, Array(12).fill("x").join("\n"));
    const input = `see ${marker} ok`;
    const start = 4;
    expect(moveCursorRightAtomic(input, start, [marker])).toBe(start + marker.length);
    expect(moveCursorLeftAtomic(input, start + marker.length, [marker])).toBe(start);
    const bs = backspaceAtomic(input, start + marker.length, [marker]);
    expect(bs.text).toBe("see  ok");
    const del = deleteForwardAtomic(input, start, [marker]);
    expect(del.text).toBe("see  ok");
    const exp = expandRangeOverMarkers(input, start + 1, start + 2, [marker]);
    expect(exp).toEqual({ start, end: start + marker.length });
  });
  test("registry bounded at 20, oldest frozen inline; submit expands byte-exact", () => {
    let chunks = [] as { token: string; full: string }[];
    for (let i = 0; i < 21; i++) {
      chunks = pushPasteChunk(chunks, { token: `[paste #${i} +1 lines]`, full: `full-${i}` });
    }
    expect(chunks).toHaveLength(20);
    expect(chunks[0]!.token).toBe("[paste #1 +1 lines]");
    // Frozen inline: the dropped token literal stays in the draft input.
    const draft = `a [paste #0 +1 lines] b [paste #1 +1 lines]`;
    expect(expandPasteMarkers(draft, chunks)).toBe("a [paste #0 +1 lines] b full-1");
    expect(
      expandPasteMarkers("see [paste #7 +1 lines] ok", chunks),
    ).toBe("see full-7 ok");
  });
});
