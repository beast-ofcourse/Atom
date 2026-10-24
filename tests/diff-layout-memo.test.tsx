// Cost guard: a busy tick must not re-wrap the diff.
//
// The diff body is the expensive part of a transcript paint (word run layout,
// syntax spans, character-by-character wrapping). Both views memoize the work
// on their inputs, so a parent re-render at the same width and content — what
// every streaming tick of an unrelated turn produces — must not re-run it.
//
// Measured, not asserted structurally: `wrapLine` is replaced with a counting
// delegate, so a regression that drops the memo or changes the key fails here.
// Component tests only: no App harness, no network.
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { wrapLine } from "../src/ui/diff-layout.js";
import { DiffView } from "../src/ui/diff-view.js";
import { SideBySideDiffView } from "../src/ui/side-by-side.js";

vi.mock("../src/ui/diff-layout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/diff-layout.js")>();
  return { ...actual, wrapLine: vi.fn(actual.wrapLine) };
});

const wrapped = vi.mocked(wrapLine);

const OLD = ["alpha", "beta", "gamma", "delta"].join("\n");
const NEW = ["alpha", "BETA CHANGED", "gamma", "delta"].join("\n");

describe("diff wrapping is memoized", () => {
  test("an unrelated repaint does not re-wrap the unified diff", () => {
    wrapped.mockClear();
    const view = render(<DiffView oldText={OLD} newText={NEW} columns={60} />);
    try {
      const first = wrapped.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      for (let i = 0; i < 10; i += 1) {
        // Same props: this is the streaming-tick shape (React.memo + useMemo
        // both hit, so no row is laid out again).
        view.rerender(<DiffView oldText={OLD} newText={NEW} columns={60} />);
      }
      expect(wrapped.mock.calls.length).toBe(first);

      // A real change does re-wrap.
      view.rerender(<DiffView oldText={OLD} newText={`${NEW}\nepsilon`} columns={60} />);
      expect(wrapped.mock.calls.length).toBeGreaterThan(first);
    } finally {
      view.unmount();
    }
  });

  test("a width change re-wraps (the layout is width-dependent)", () => {
    wrapped.mockClear();
    const view = render(<DiffView oldText={OLD} newText={NEW} columns={60} />);
    try {
      const first = wrapped.mock.calls.length;
      view.rerender(<DiffView oldText={OLD} newText={NEW} columns={40} />);
      expect(wrapped.mock.calls.length).toBeGreaterThan(first);
    } finally {
      view.unmount();
    }
  });

  test("an unrelated repaint does not re-wrap the side-by-side panes", () => {
    wrapped.mockClear();
    // Above SBS_NARROW_COLUMNS, so the panes (not the unified fallback) wrap.
    const view = render(<SideBySideDiffView oldText={OLD} newText={NEW} lang={null} columns={160} />);
    try {
      const first = wrapped.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      for (let i = 0; i < 10; i += 1) {
        view.rerender(<SideBySideDiffView oldText={OLD} newText={NEW} lang={null} columns={160} />);
      }
      expect(wrapped.mock.calls.length).toBe(first);
    } finally {
      view.unmount();
    }
  });
});
