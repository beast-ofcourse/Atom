// Phase 1 item 1.3 — ThemeProvider + useTheme() inject the theme object.
// No visual change: default context deep-equals the legacy singleton, and
// no existing `import { theme }` consumer is migrated here.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { theme } from "../src/ui/theme.js";
import type { Theme } from "../src/ui/theme.js";
import { ThemeProvider, useTheme } from "../src/ui/theme-provider.js";

function PaintProbe() {
  const t = useTheme();
  return <Text color={t.color.success}>success:{String(t.color.success)}</Text>;
}

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

const altTheme = {
  ...theme,
  color: { ...theme.color, success: "red" },
} as unknown as Theme;

describe("ThemeProvider + useTheme (Phase 1.3)", () => {
  test("default hook value deep-equals the legacy singleton", () => {
    let seen: Theme | null = null;
    function Capture() {
      seen = useTheme();
      return null;
    }
    frameOf(<Capture />);
    expect(seen).toEqual(theme);
  });

  test("provider injects a different theme object into the subtree", () => {
    let seen: Theme | null = null;
    function Capture() {
      seen = useTheme();
      return null;
    }
    frameOf(
      <ThemeProvider theme={altTheme}>
        <Capture />
      </ThemeProvider>
    );
    expect(seen).toEqual(altTheme);
    expect(seen).not.toEqual(theme);
  });

  test("subtree renders different paint under the alt theme vs default", () => {
    const def = frameOf(<PaintProbe />);
    const alt = frameOf(
      <ThemeProvider theme={altTheme}>
        <PaintProbe />
      </ThemeProvider>
    );
    expect(def).toContain("success:green");
    expect(alt).toContain("success:red");
    expect(alt).not.toBe(def);
  });
});
