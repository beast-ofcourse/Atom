// Resize-throttle regression: a rapid width drag must settle on the LAST
// width, never freeze on a stale one. The previous implementation cleared
// its pending timer on every intermediate resize but never rescheduled
// (stuck "scheduled" flag), pinning diff panes to a stale width permanently
// after any quick drag.
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

const mockStdout = vi.hoisted(() => ({ columns: 100, rows: 30 }));

vi.mock("ink", async (importOriginal) => {
  const mod = await importOriginal<typeof import("ink")>();
  return {
    ...mod,
    useStdout: () => ({ stdout: mockStdout }),
  };
});

import { useThrottledTerminalSize } from "../src/ui/layout.js";

function Probe({ delay }: { delay: number }) {
  const size = useThrottledTerminalSize(delay);
  return <Text>cols:{size.columns}</Text>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("useThrottledTerminalSize", () => {
  test("rapid drag settles on the last width, then keeps tracking", async () => {
    mockStdout.columns = 100;
    const app = render(<Probe delay={30} />);
    try {
      expect(app.lastFrame()).toContain("cols:100");
      // Resize storm: three widths inside one throttle window.
      mockStdout.columns = 90;
      app.rerender(<Probe delay={30} />);
      mockStdout.columns = 80;
      app.rerender(<Probe delay={30} />);
      mockStdout.columns = 70;
      app.rerender(<Probe delay={30} />);
      await sleep(150);
      expect(app.lastFrame()).toContain("cols:70");
      // Still live afterwards — a later resize is picked up, not frozen.
      mockStdout.columns = 60;
      app.rerender(<Probe delay={30} />);
      await sleep(150);
      expect(app.lastFrame()).toContain("cols:60");
    } finally {
      app.unmount();
    }
  });
});
