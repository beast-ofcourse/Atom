// Phase 4 token-parity guard (plan tui-resize-theme-layout task 4.4).
//
// The phase's contract is "zero visual change": every `layout` token in the
// theme files must deep-equal the legacy literal it replaced. If a value
// drifts, this fails BEFORE any screenshot can — geometry is pinned, not
// eyeballed. Ember carries the same layout slice as classic by design
// (geometry is not a brand delta), so both themes pin to the same literal
// table.
import { describe, expect, test } from "vitest";
import { TUI_LAYOUT_RANGES, TUI_THEME_VALUES } from "../src/config.js";
import { theme } from "../src/ui/theme.js";
import { classicTheme } from "../src/ui/themes/classic.js";
import { emberTheme } from "../src/ui/themes/ember.js";
// listThemes is registry state, not the mirror — importing it here is fine
// (tests may import anything; only src/config.ts itself must not).
import { listThemes } from "../src/ui/themes/registry.js";

// The legacy literals verbatim (pre-Phase-4 values — never update this
// table silently: changing it means a deliberate visual change, which
// needs its own review and plan entry).
const LEGACY_LAYOUT = {
  breakpointXs: 50,
  breakpointSm: 80,
  breakpointMd: 120,
  breakpointLg: 160,
  widgetMaxColumns: 100,
  codeBlockVisibleMax: 60,
  longLineSkipHighlight: 500,
  diffMaxRows: 60,
  scrollbackWindow: 300,
  liveDraftReserveLines: 16,
  liveDraftMinLines: 4,
  pickerVisibleRows: 10,
  frameSpareRows: 1,
  overlayReserve: {
    composer: 4,
    picker: 1,
    inspector: 1,
    palette: 1,
    ledger: 1,
    dock: 6,
  },
};

describe("layout token parity (Phase 4 — zero visual change)", () => {
  test("classic deep-equals the legacy literal table", () => {
    expect(classicTheme.layout).toEqual(LEGACY_LAYOUT);
  });

  test("ember deep-equals the legacy literal table", () => {
    expect(emberTheme.layout).toEqual(LEGACY_LAYOUT);
  });

  test("the active singleton layout matches the registered themes", () => {
    // The singleton is the active theme for the layout helpers; if the
    // registry ever diverges from it, one of these two trips.
    expect(theme.layout).toEqual(classicTheme.layout);
    expect(theme.layout).toEqual(emberTheme.layout);
  });
});

// Mirror-parity trip wire (review Suggestion 1): config.ts mirrors the
// theme's layout-token names locally (runtime modules may never import the
// UI — architecture gate). A stale mirror silently rejects valid user
// overrides with "unknown layout token", so the KEY SETS must stay equal
// here — a token added to the theme without its config band (or renamed)
// fails before any user can hit it. Values are NOT pinned here (the band
// choice is config's domain); the SYNCED KEY SET is the contract.
describe("config mirror parity (no runtime UI import, keys cannot drift)", () => {
  const themeKeys = new Set(
    Object.entries(theme.layout).flatMap(([key, value]) =>
      typeof value === "object" && value !== null
        ? Object.keys(value).map((member) => `${key}.${member}`)
        : [key],
    ),
  );

  test("TUI_LAYOUT_RANGES covers exactly the theme's layout tokens", () => {
    expect(Object.keys(TUI_LAYOUT_RANGES).length).toBe(themeKeys.size);
    expect(Object.keys(TUI_LAYOUT_RANGES).every((key) => themeKeys.has(key))).toBe(
      true,
    );
    expect([...themeKeys].every((key) => Object.hasOwn(TUI_LAYOUT_RANGES, key))).toBe(
      true,
    );
  });

  test("TUI_THEME_VALUES matches the registry's theme name list", () => {
    expect([...TUI_THEME_VALUES].sort()).toEqual([...listThemes()].sort());
  });
});
