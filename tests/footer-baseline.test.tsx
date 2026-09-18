// Phase 0 item 0.1 — footer baseline snapshots (brand-dock-plan §4).
//
// Pins current footer pixels (Composer + StatusBar assembly, the App footer
// order) via committed ink-testing-library snapshots at widths 40/80/120/200
// across states idle + busy + approval-pending + xs-floor. Any unintended
// pixel change in later phases fails loudly against these.
//
// Patterns studied first:
// - tests/stream-sequence.test.tsx: mountApp/submitLine/waitForFrame helpers.
// - tests/status.test.tsx: baseProps + waitForFrame needle discipline.
// - Width: neither file sets width (full <App> reads the live terminal).
//   Width here goes through the explicit `columns` prop, borrowed from
//   tests/footer-cluster.test.tsx ClusterFrame (StatusBarHost columns) plus
//   Composer/InputBox columns threading. No useStdout mock, no App mount —
//   full-App width is not controllable, so the assembly is pinned directly.
// Invented for this file (repo has zero committed snapshots today):
// - 4x4 state/width matrix rendered through one FooterBaselineFrame with
//   toMatchSnapshot() (first __snapshots__ artifact in repo).
// - xs-floor state carries location + live goal so the floor drop (model +
//   mode only below 50 cols) is visible against the idle state diff.
// Do NOT change any src/ file — render-only.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { Composer } from "../src/ui/components/Composer.js";
import { StatusBarHost } from "../src/ui/status-host.js";

const WIDTHS = [40, 80, 120, 200] as const;
const STATES = ["idle", "busy", "approval-pending", "xs-floor"] as const;
type FooterState = (typeof STATES)[number];

function FooterBaselineFrame({ state, columns }: { state: FooterState; columns: number }) {
  const busy = state === "busy" || state === "approval-pending";
  const approvalPending = state === "approval-pending";
  const input = busy ? "half-typed thought" : state === "xs-floor" ? "x" : "draft idle text";
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Composer input={input} cursor={input.length} busy={busy} columns={columns} />
      <StatusBarHost
        provider="opencode-zen"
        model="big-pickle"
        usageTotals={null}
        contextLoad={null}
        reasoningDisplay="default"
        mode="normal"
        trustAll={false}
        busy={busy}
        activity={busy ? "Reading src/footer.ts" : null}
        phaseLabel="thinking…"
        elapsedSecs={busy ? 8 : 0}
        stalled={false}
        approvalPending={approvalPending}
        cwd={state === "xs-floor" ? "/home/user/projects/some/very/deep/nesting" : "~/proj"}
        branch={state === "xs-floor" ? "feature/ember-dock" : "main"}
        goal={
          state === "xs-floor"
            ? { objective: "ship ember dock footer without pixel drift", active: true }
            : null
        }
        columns={columns}
      />
    </Box>
  );
}

function frameOf(state: FooterState, columns: number): string {
  const app = render(<FooterBaselineFrame state={state} columns={columns} />);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("footer baseline (Phase 0.1)", () => {
  for (const state of STATES) {
    for (const columns of WIDTHS) {
      test(`${state} @ ${columns} cols`, () => {
        const frame = frameOf(state, columns);
        // Ink test harness wraps long lines at its own width, so multi-word
        // needles assert against the flattened frame (production width math
        // still lives in the `columns` prop). Snapshots keep the raw frame.
        const flat = frame.replace(/\s+/g, " ");
        expect(frame.length).toBeGreaterThan(0);
        expect(flat).toContain("big-pickle");
        expect(flat).toContain("mode: normal");
        if (state === "busy") expect(flat).toContain("esc stops");
        if (state === "approval-pending") {
          expect(flat).toContain("esc stops");
          expect(flat).toContain("waiting approval");
        }
        if (state === "xs-floor" && columns < 50) {
          // Starvation floor: location and goal drop, model + mode pin.
          expect(flat).not.toContain("ember-dock");
          expect(flat).not.toContain("goal:");
        }
        expect(frame).toMatchSnapshot();
      });
    }
  }
});
