// Brand-dock Phase 1 item 1.5 — layout caps live in theme tokens.
//
// Pins the tokenized budgets byte-identical to the legacy magic numbers
// (no visual change): input inset 6, status default width 100, xs floor 50,
// goal objective budget 32, busy goal cap 48. Fit/drop behavior is frozen —
// these tests pin the wiring, tests/footer-baseline.test.tsx pins pixels.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { theme } from "../src/ui/theme.js";
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
