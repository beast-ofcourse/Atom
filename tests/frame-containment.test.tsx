// Guard: the rendered frame must be contained within the terminal viewport.
//
// Any tall surface (inspector, palette, long picker, error stack) can make the
// next frame >= the terminal row count — the sole height condition that arms
// Ink's win32 full-terminal clear on win32 (plans/tui-resize-theme-layout.md
// V3, V11). Phase 1 (frame containment) guarantees frameHeight <= rows - 1 by
// giving AppShell a height-capped root with a clipped middle slot.
//
// Rendered with ink-testing-library: `lastFrame()` yields the complete logical
// frame, so its line count is the frame height. `stdout.rows` is no-op'd there,
// so the cap must come from the app passing `maxHeight` — this test pins that
// an explicit cap clips even a 200-row body while keeping the footer visible.
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import { AppShell } from "../src/ui/components/AppShell.js";

// 200 rows of overlay content at a 24-row terminal — today this paints the
// whole 200 rows (arm trigger), after Phase 1 it must clip to the cap.
const LONG_BODY = Array.from({ length: 200 }, (_, i) => `overlay-row-${i}`).join("\n");

function frameLines(frame: string): number {
  return frame.split("\n").length;
}

describe("frame containment", () => {
  test("a 200-row overlay inside a 24-row terminal clips to maxHeight", () => {
    const app = render(
      <AppShell
        conversation={<Text>{LONG_BODY}</Text>}
        liveZone={null}
        overlayZone={null}
        footerZone={
          <Box>
            <Text>composer-last-line</Text>
          </Box>
        }
        maxHeight={23}
      />
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    // Contained: strictly inside the 24-row viewport (one spare row keeps
    // Ink's isFullscreen false, so the win32 clear branch stays off — plan D2).
    expect(frameLines(frame)).toBeLessThanOrEqual(23);
    // The clipped middle must never swallow the footer: the composer survives.
    expect(frame).toContain("composer-last-line");
  });

  test("the tall overlay rows are truncated, not squeezed — head rows dropped", () => {
    const app = render(
      <AppShell
        conversation={<Text>{LONG_BODY}</Text>}
        liveZone={null}
        overlayZone={null}
        footerZone={null}
        maxHeight={23}
      />
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    // overflow="hidden" clips the tail, so early rows show and row 199 does not.
    expect(frame).toContain("overlay-row-0");
    expect(frame).not.toContain("overlay-row-199");
  });
});
