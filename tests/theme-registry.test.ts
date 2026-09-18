// Phase 1.2 — registry deep-equals legacy singleton (no visual change).
import { describe, expect, test } from "vitest";
import { theme } from "../src/ui/theme.js";
import { getTheme, listThemes } from "../src/ui/themes/registry.js";

describe("theme registry (Phase 1.2)", () => {
  test('getTheme("classic") deep-equals legacy theme', () => {
    expect(getTheme("classic")).toEqual(theme);
  });

  test('getTheme("ember") deep-equals legacy theme (deltas land in Phase 5)', () => {
    expect(getTheme("ember")).toEqual(theme);
  });

  test("listThemes() exposes ember + classic", () => {
    expect(listThemes()).toEqual(["ember", "classic"]);
  });
});
