// Phase 1.2 — theme registry (no visual change).
import type { Theme } from "../theme.js";
import { classicTheme } from "./classic.js";
import { emberTheme } from "./ember.js";

export type ThemeName = "ember" | "classic";

const themes: Record<ThemeName, Theme> = {
  ember: emberTheme,
  classic: classicTheme,
};

export function listThemes(): ThemeName[] {
  return ["ember", "classic"];
}

export function getTheme(name: ThemeName): Theme {
  return themes[name];
}
