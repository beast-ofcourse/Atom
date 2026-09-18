// Brand dock Phase 2 item 2.1 — dock frame snapshots.
//
// Pins Dock pixels (frame + divider + pill row + action row) via
// committed ink-testing-library snapshots at widths 40/80/120/200
// with static pills (every tone) and static actions. Do NOT wire
// into App — render-only.
//
// Width goes through the explicit `state.columns` prop (same pattern
// as tests/footer-baseline.test.tsx): full-width sharp strip, no side
// margins, no cap; divider fills columns - 4. Ink test
// harness wraps long lines at its own width, so multi-word needles
// assert against the flattened frame; snapshots keep the raw frame.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Dock, type ActionChip, type Pill } from "../src/ui/components/Dock.js";

const WIDTHS = [40, 80, 120, 200] as const;

const PILLS: Pill[] = [
    { key: "model", label: "model", value: "big-pickle", tone: "cyan" },
    { key: "mode", label: "mode", value: "normal", tone: "green" },
    { key: "branch", label: "branch", value: "feat/ember-dock", tone: "magenta" },
    { key: "token", label: "token", value: "44K", tone: "yellow" },
    { key: "warn", label: "warn", value: "waiting", tone: "amber" },
    { key: "err", label: "err", value: "none", tone: "red" },
    { key: "muted", label: "muted", value: "quiet", tone: "dim" },
    { key: "chrome", label: "chrome", value: "frame", tone: "gray" },
];

const ACTIONS: ActionChip[] = [
    { key: "help", command: "help" },
    { key: "clear", command: "clear" },
];

function frameOf(columns: number): string {
    const app = render(
        <Dock
            inputZone={<Text>› draft input</Text>}
            pills={PILLS}
            actions={ACTIONS}
            state={{ busy: false, columns }}
        />,
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    return frame;
}

describe("dock frame (Phase 2.1)", () => {
    for (const columns of WIDTHS) {
        test(`dock @ ${columns} cols`, () => {
            const frame = frameOf(columns);
            const flat = frame.replace(/\s+/g, " ");
            expect(frame.length).toBeGreaterThan(0);
            // Sharp full-width gray frame present.
            expect(frame).toContain("┌");
            // Input zone on top.
            expect(flat).toContain("draft input");
            // Dim divider unit present.
            expect(frame).toContain("─");
            // Pill row: labels + values, joined by ·.
            expect(flat).toContain("model");
            expect(flat).toContain("big-pickle");
            expect(flat).toContain("feat/ember-dock");
            expect(frame).toContain("·");
            // Action row: amber / prefix + dim command.
            expect(flat).toContain("/help");
            expect(flat).toContain("/clear");
            expect(frame).toMatchSnapshot();
        });
    }
});
