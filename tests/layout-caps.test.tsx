// Brand-dock Phase 1 item 1.5 — layout caps live in theme tokens.
//
// Pins the tokenized budgets byte-identical to the legacy magic numbers
// (no visual change): input inset 6, status default width 100, xs floor 50,
// goal objective budget 32, busy goal cap 48. Fit/drop behavior is frozen —
// these tests pin the wiring, tests/footer-baseline.test.tsx pins pixels.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { theme } from "../src/ui/theme.js";
import {
  FRAME_SPARE_ROWS,
  LIVE_DRAFT_MIN_LINES,
  RESERVED_FOOTER_ROWS,
  frameMaxHeight,
  liveDraftMaxLines,
  middleZoneBudget,
  overlayRows,
} from "../src/ui/layout.js";
import { AppShell } from "../src/ui/components/AppShell.js";
import {
  GOAL_STATUS_OBJECTIVE_CHARS,
  StatusBar,
  fitGoalSegment,
  formatGoalSegment,
  truncateGoalObjective,
} from "../src/ui/status-bar.js";
import { InputBox } from "../src/ui/input.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

const base = {
  provider: "opencode-zen",
  model: "big-pickle",
  usageTotals: null,
  contextLoad: null,
  reasoningDisplay: "default",
  mode: "normal",
  trustAll: false,
  phaseLabel: "thinking…",
  elapsedSecs: 0,
  stalled: false,
  approvalPending: false,
};

describe("layout caps (Phase 1.5)", () => {
  test("input inset token pins legacy 6", () => {
    expect(theme.spacing.inputInset).toBe(6);
  });

  test("status width tokens pin legacy 100/50 budgets", () => {
    expect(theme.spacing.statusDefaultColumns).toBe(100);
    expect(theme.spacing.statusXsColumns).toBe(50);
  });

  test("goal caps pin legacy 32/48 budgets", () => {
    expect(theme.spacing.statusGoalObjectiveChars).toBe(32);
    expect(theme.spacing.statusBusyGoalChars).toBe(48);
  });

  test("GOAL_STATUS_OBJECTIVE_CHARS reads the token (compat export)", () => {
    expect(GOAL_STATUS_OBJECTIVE_CHARS).toBe(
      theme.spacing.statusGoalObjectiveChars,
    );
  });

  test("default truncate/format budgets equal the token", () => {
    const long = "x".repeat(100);
    expect(truncateGoalObjective(long)).toBe(
      truncateGoalObjective(long, theme.spacing.statusGoalObjectiveChars),
    );
    expect(formatGoalSegment({ objective: long, active: true })).toBe(
      formatGoalSegment(
        { objective: long, active: true },
        theme.spacing.statusGoalObjectiveChars,
      ),
    );
    expect(formatGoalSegment({ objective: long, active: true })).toContain("…");
  });

  test("status bar default width equals the token (no columns prop)", () => {
    const implicit = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" />,
    );
    const explicit = frameOf(
      <StatusBar
        {...base}
        busy={false}
        activity={null}
        cwd="~/proj"
        branch="main"
        columns={theme.spacing.statusDefaultColumns}
      />,
    );
    expect(implicit).toBe(explicit);
  });

  test("xs floor boundary follows the token (fit/drop frozen)", () => {
    const xs = theme.spacing.statusXsColumns;
    const below = frameOf(
      <StatusBar
        {...base}
        busy={false}
        activity={null}
        cwd="~/proj"
        branch="main"
        columns={xs - 1}
      />,
    );
    expect(below).toContain("mode: normal");
    expect(below).not.toContain("~/proj");
    const at = frameOf(
      <StatusBar
        {...base}
        busy={false}
        activity={null}
        cwd="~/proj"
        branch="main"
        columns={xs}
      />,
    );
    expect(at).toContain("mode: normal");
  });

  test("busy goal cap follows the token (guest drops whole, never displaces)", () => {
    const seg = fitGoalSegment(
      { objective: "x".repeat(100), active: true },
      theme.spacing.statusBusyGoalChars,
    );
    expect(seg).not.toBeNull();
    expect(seg!.length).toBeLessThanOrEqual(theme.spacing.statusBusyGoalChars);
  });

  test("input renders through the inset token at narrow width", () => {
    const frame = frameOf(
      <InputBox input="hello" cursor={5} columns={theme.spacing.inputInset + 20} />,
    );
    expect(frame).toContain("hello");
  });
});

// ── Phase 1 (frame containment, plan D2/D3) ──────────────────────────────
// The frame must stay strictly shorter than the viewport: any frame height
// >= rows arms Ink's win32 full-terminal clear (ESC[3J wipes scrollback).
// The spike pins the Yoga layout the containment relies on; the helper pins
// freeze the arithmetic; the footer-present guard is the phase's risk item
// (clipping must never swallow the composer).
describe("frame containment (Phase 1)", () => {
  // 200 rows of overlay content at a 24-row terminal.
  const longBody = Array.from(
    { length: 200 },
    (_, i) => `overlay-row-${i}`,
  ).join("\n");

  test("spike: Yoga clips the middle and keeps the footer under a fixed-height root", () => {
    // The exact shape AppShell builds when capped: fixed root height, middle
    // grow+shrink+clip, footer shrink=0 outside. Pinned so a Yoga surprise
    // surfaces here, not in production.
    const app = render(
      <Box flexDirection="column" height={23}>
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
        >
          <Text>{longBody}</Text>
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Text>composer-last-line</Text>
        </Box>
      </Box>,
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame.split("\n").length).toBe(23);
    expect(frame).toContain("composer-last-line");
    // Clip drops the tail (rows past the budget), never the head.
    expect(frame).toContain("overlay-row-0");
    expect(frame).not.toContain("overlay-row-199");
  });

  test("spike: a frame under the cap keeps its natural height — capped and uncapped render identically", () => {
    const body = (
      <AppShell
        conversation={<Text>head-row</Text>}
        liveZone={<Text>live-row</Text>}
        overlayZone={<Text>overlay-row</Text>}
        footerZone={<Box><Text>composer-last-line</Text></Box>}
      />
    );
    const uncapped = render(body);
    const uncappedFrame = uncapped.lastFrame() ?? "";
    uncapped.unmount();
    const capped = render(
      <AppShell
        conversation={<Text>head-row</Text>}
        liveZone={<Text>live-row</Text>}
        overlayZone={<Text>overlay-row</Text>}
        footerZone={<Box><Text>composer-last-line</Text></Box>}
        maxHeight={frameMaxHeight(24)}
      />,
    );
    const cappedFrame = capped.lastFrame() ?? "";
    capped.unmount();
    // maxHeight caps overflow only: content that fits paints the same rows.
    expect(cappedFrame).toBe(uncappedFrame);
  });

  test("helpers pin the D2/D3 arithmetic", () => {
    expect(FRAME_SPARE_ROWS).toBe(1);
    expect(frameMaxHeight(24)).toBe(23);
    expect(frameMaxHeight(2)).toBe(1);
    expect(frameMaxHeight(0)).toBe(1);
    // Middle budget: frame cap minus the idle footer (composer + status).
    expect(middleZoneBudget(24, RESERVED_FOOTER_ROWS.composer)).toBe(19);
    expect(middleZoneBudget(24, 0)).toBe(23);
    // Overlay caps: frame cap minus the mode's footer reserve.
    expect(overlayRows(24, RESERVED_FOOTER_ROWS.picker)).toBe(22);
    expect(overlayRows(24, RESERVED_FOOTER_ROWS.composer)).toBe(19);
    expect(overlayRows(10, RESERVED_FOOTER_ROWS.dock)).toBe(3);
  });

  test("RESERVED_FOOTER_ROWS pin what each mode renders below the middle", () => {
    // Idle/legacy footer: composer frame (3) + status bar (1).
    expect(RESERVED_FOOTER_ROWS.composer).toBe(4);
    // Composer-replacing leaves leave only the status bar.
    expect(RESERVED_FOOTER_ROWS.picker).toBe(1);
    expect(RESERVED_FOOTER_ROWS.inspector).toBe(1);
    expect(RESERVED_FOOTER_ROWS.palette).toBe(1);
    expect(RESERVED_FOOTER_ROWS.ledger).toBe(1);
    // Dock: border 2 + gap 1 + input 1 + divider 1 + pills 1.
    expect(RESERVED_FOOTER_ROWS.dock).toBe(6);
  });

  test("draft budget keeps rows-16 at typical rows (spare absorbed by the reserve)", () => {
    // The D2 spare row must come out of the reserve arithmetic, never the
    // user's draft: these equal the legacy max(4, rows - 16) exactly.
    expect(liveDraftMaxLines(24)).toBe(8);
    expect(liveDraftMaxLines(30)).toBe(14);
    expect(liveDraftMaxLines(40)).toBe(24);
    expect(liveDraftMaxLines(10)).toBe(LIVE_DRAFT_MIN_LINES);
  });

  test("footer-present guard: 200-row overlay at rows=24 keeps the composer's last line", () => {
    const app = render(
      <AppShell
        conversation={<Text>{longBody}</Text>}
        liveZone={null}
        overlayZone={null}
        footerZone={<Box><Text>composer-last-line</Text></Box>}
        maxHeight={frameMaxHeight(24)}
      />,
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame.split("\n").length).toBeLessThanOrEqual(23);
    expect(frame).toContain("composer-last-line");
  });
});
