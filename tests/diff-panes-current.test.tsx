// Current diff-pane contracts (uncapped-diff era, v1.4.0+).
//
// The side-by-side view no longer prints BEFORE/AFTER pane headers: a wide
// terminal shows the DiffSummary line (`+N −M` plus range/path) above two
// aligned panes joined by a `│` separator, and narrow terminals (< 70 cols)
// fall back to the stacked unified DiffView. These tests pin that shape so
// future header/restyle work fails loudly instead of drifting silently.
//
// Split by observability: layout chrome (summary, separator, fallback) via
// the renderer, content fidelity (both panes' text) via the engine — the
// ink-testing-library frame truncates wide rows, so right-pane text is not
// frame-observable and is asserted on `computeSideBySide` rows instead.
// Component tests only: no App harness, no network.
//
// `columns` is the view's exact row budget (what a framed caller derives via
// layout.frameContentWidth), so the renderer cases pass a width the 100-col
// harness frame can actually show — an over-wide budget is simply clipped by
// the harness and would assert nothing about the separator column.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { SideBySideDiffView } from "../src/ui/side-by-side.js";
import { computeSideBySide } from "../src/ui/diff.js";

describe("side-by-side current rendering", () => {
  test("wide terminal shows summary plus panes, no BEFORE/AFTER labels", () => {
    const app = render(
      <SideBySideDiffView oldText={"OLD\n"} newText={"NEW\n"} lang={null} columns={100} />
    );
    try {
      const frame = app.lastFrame() ?? "";
      // Summary line carries the change counts.
      expect(frame).toContain("+1");
      expect(frame).toContain("−1");
      // Left pane renders with the column separator beside it.
      expect(frame).toContain("OLD");
      expect(frame).toContain("│");
      // Pane-header labels are gone (stale suites assert them; they fail).
      expect(frame).not.toContain("BEFORE");
      expect(frame).not.toContain("AFTER");
    } finally {
      app.unmount();
    }
  });

  test("engine pairs before/after text on one row (right pane fidelity)", () => {
    const sbs = computeSideBySide("OLD\n", "NEW\n");
    if (sbs.kind !== "diff") throw new Error(`expected diff, got ${sbs.kind}`);
    expect(sbs.adds).toBe(1);
    expect(sbs.dels).toBe(1);
    expect(sbs.isNewFile).toBe(false);
    const texts = sbs.rows.flatMap((r) =>
      r.kind === "context" ? [r.text] : [r.oldText ?? "", r.newText ?? ""]
    );
    expect(texts).toContain("OLD");
    expect(texts).toContain("NEW");
  });

  test("narrow terminal degrades to unified, still without BEFORE/AFTER", () => {
    const app = render(
      <SideBySideDiffView oldText={"a\nOLD\n"} newText={"a\nNEW\n"} lang={null} columns={40} />
    );
    try {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("NEW");
      expect(frame).toContain("+1");
      expect(frame).not.toContain("BEFORE");
      expect(frame).not.toContain("AFTER");
    } finally {
      app.unmount();
    }
  });

  test("new file (null old text) labels itself as new with full additions", () => {
    const app = render(
      <SideBySideDiffView oldText={null} newText={"hello"} lang={null} columns={200} />
    );
    try {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("new file");
      expect(frame).toContain("+1");
      expect(frame).toContain("−0");
    } finally {
      app.unmount();
    }
    const sbs = computeSideBySide(null, "hello");
    if (sbs.kind !== "diff") throw new Error(`expected diff, got ${sbs.kind}`);
    expect(sbs.isNewFile).toBe(true);
    const texts = sbs.rows.flatMap((r) =>
      r.kind === "context" ? [r.text] : [r.newText ?? ""]
    );
    expect(texts).toContain("hello");
  });
});
