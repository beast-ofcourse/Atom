// Brand-dock Phase 5 item 5.1 — Ember brand deltas (plan §2), Classic untouched.
//
// Snapshot pair: Classic vs Ember brand frame (banner + dock) at 80 cols,
// rendered from each theme object so the §2 deltas read as before/after
// pixels. Token assertions pin every §2 row exactly.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { theme } from "../src/ui/theme.js";
import { classicTheme } from "../src/ui/themes/classic.js";
import { emberTheme } from "../src/ui/themes/ember.js";
import { ATOM_ART } from "../src/ui/transcript.js";
import { Dock, type Pill } from "../src/ui/components/Dock.js";

type ThemeLike = typeof theme;
type PillTable = {
  label: string;
  model: string;
  token: string;
  goalActive: string;
  goalPaused: string;
  branch: string;
  modeNormal: string;
  modeYolo: string;
  modePlan: string;
  approval: string;
  error: string;
  stalled: string;
};

function pillOf(t: ThemeLike): PillTable {
  return (t as unknown as { pill: PillTable }).pill;
}

// Same dock content both frames: geometry (§2.3) is Classic-equivalent by
// design, so the dock section pins byte-identical while banner + identity
// rows carry the Ember deltas.
const PILLS: Pill[] = [
  { key: "model", label: "model", value: "big-pickle", tone: "amber" },
  { key: "token", label: "token", value: "44K", tone: "cyan" },
  { key: "goal", label: "goal", value: "ship ember", tone: "magenta" },
  { key: "branch", label: "branch", value: "feat/ember-dock", tone: "green" },
  { key: "mode", label: "mode", value: "normal", tone: "green" },
];

function BrandFrame({ t }: { t: ThemeLike }) {
  return (
    <Box flexDirection="column">
      <Text color={t.color.bannerA} bold wrap="truncate">
        {ATOM_ART[0]}
      </Text>
      <Text color={t.color.bannerB} bold wrap="truncate">
        {ATOM_ART[1]}
      </Text>
      <Text>
        {t.symbol.speakerAssistant} focus:{t.color.composerFocus} thinking:
        {t.symbol.thinking} done:{t.symbol.taskDone} active:{t.symbol.taskActive}
      </Text>
      <Dock
        inputZone={<Text>› draft input</Text>}
        pills={PILLS}
        actions={[{ key: "help", command: "help" }]}
        state={{ busy: false, columns: 80 }}
      />
    </Box>
  );
}

function frameOf(t: ThemeLike): string {
  const app = render(<BrandFrame t={t} />);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("ember brand deltas (Phase 5.1, §2)", () => {
  test("classic frame @ 80 cols (before)", () => {
    const frame = frameOf(classicTheme);
    const flat = frame.replace(/\s+/g, " ");
    expect(frame.length).toBeGreaterThan(0);
    // Legacy paint: blue banner, ATOM> mark, emoji chrome.
    expect(flat).toContain("ATOM>");
    expect(flat).toContain("focus:cyan");
    expect(frame).toContain("💭");
    expect(frame).toContain("✅");
    expect(frame).toContain("🔧");
    // Dock geometry present (sharp full-width strip).
    expect(frame).toContain("┌");
    expect(frame).toContain("─");
    expect(frame).toContain("·");
    expect(flat).toContain("feat/ember-dock");
    expect(flat).toContain("/help");
    expect(frame).toMatchSnapshot();
  });

  test("ember frame @ 80 cols (after)", () => {
    const frame = frameOf(emberTheme);
    const flat = frame.replace(/\s+/g, " ");
    expect(frame.length).toBeGreaterThan(0);
    // Ember paint: amber banner/focus, › brand mark, font-safe glyphs.
    expect(flat).toContain("ATOM›");
    expect(flat).toContain("focus:#F5A524");
    expect(frame).toContain("◐");
    expect(frame).not.toContain("💭");
    expect(frame).not.toContain("✅");
    expect(frame).not.toContain("🔧");
    // Dock geometry unchanged (same frame, same divider, same pills).
    expect(frame).toContain("┌");
    expect(frame).toContain("─");
    expect(frame).toContain("·");
    expect(flat).toContain("feat/ember-dock");
    expect(flat).toContain("/help");
    expect(frame).toMatchSnapshot();
  });

  test("before/after frames differ exactly on the §2 deltas", () => {
    const before = frameOf(classicTheme);
    const after = frameOf(emberTheme);
    expect(after).not.toBe(before);
    expect(before).toContain("ATOM>");
    expect(after).toContain("ATOM›");
  });

  test("§2.1 palette + symbol deltas (exact)", () => {
    const e = emberTheme;
    const c = classicTheme;
    // Changed vs today (§2.1, six rows).
    expect(e.color.composerFocus).toBe("#F5A524");
    expect(e.color.bannerA).toBe("#F5A524");
    expect(e.symbol.speakerAssistant).toBe("ATOM›");
    expect(e.symbol.thinking).toBe("◐");
    expect(e.symbol.taskDone).toBe("✓");
    expect(e.symbol.taskActive).toBe("◉");
    // Classic keeps legacy values.
    expect(c.color.composerFocus).toBe("cyan");
    expect(c.color.bannerA).toBe("#6EA8FF");
    expect(c.symbol.speakerAssistant).toBe("ATOM>");
    expect(c.symbol.thinking).toBe("💭");
    expect(c.symbol.taskDone).toBe("✅");
    expect(c.symbol.taskActive).toBe("🔧");
    // Untouched neighbors (§2.1 "everything else keeps current values").
    expect(e.color.bannerB).toBe("magenta");
    expect(e.color.composerBusy).toBe("yellow");
    expect(e.color.badgeUser).toBe("#6EA8FF");
    expect(e.color.user).toBe("#6EA8FF");
    expect(e.symbol.speakerUser).toBe("you>");
    expect(e.symbol.taskPending).toBe("○");
    expect(e.symbol.workThinking).toBe("◐");
    expect(e.symbol.workTool).toBe("◉");
  });

  test("§2.2 pill color table (exact)", () => {
    expect(pillOf(emberTheme)).toEqual({
      label: "dim",
      model: "#F5A524",
      token: "cyan",
      goalActive: "magenta",
      goalPaused: "gray",
      branch: "green",
      modeNormal: "green",
      modeYolo: "yellow",
      modePlan: "yellow",
      approval: "yellow",
      error: "red",
      stalled: "yellow",
    });
    // Classic ships no pill namespace (Phase 1 deep-equal shape).
    expect(pillOf(classicTheme)).toBeUndefined();
  });

  test("§2.3 dock frame tokens (exact, sharp full-width strip)", () => {
    for (const t of [emberTheme, classicTheme] as const) {
      expect(t.dock.border).toBe("gray");
      expect(t.dock.borderStyle).toBe("single");
      expect(t.dock.padX).toBe(1);
      expect(t.dock.divider).toBe("─");
    }
  });

  test("classic still deep-equals the legacy singleton", () => {
    expect(classicTheme).toEqual(theme);
  });
});
