// Phase 1.2 — registry deep-equals legacy singleton (no visual change).
import { describe, expect, test } from "vitest";
import { theme } from "../src/ui/theme.js";
import { getTheme, listThemes } from "../src/ui/themes/registry.js";

describe("theme registry (Phase 1.2)", () => {
  test('getTheme("classic") deep-equals legacy theme', () => {
    expect(getTheme("classic")).toEqual(theme);
  });

  test('getTheme("ember") carries the Phase 5 deltas (differs from legacy by design)', () => {
    const ember = getTheme("ember");
    expect(ember.color.composerFocus).toBe("#F5A524");
    expect(ember.symbol.speakerAssistant).toBe("ATOM›");
    expect(ember.dock.borderStyle).toBe("single");
    expect(ember).not.toEqual(theme);
  });

  test("listThemes() exposes ember + classic", () => {
    expect(listThemes()).toEqual(["ember", "classic"]);
  });
});
