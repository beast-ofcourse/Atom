// Phase 5 — user customization of the theme through two validated sources:
// atom.json `tui` (colors + layout-token numbers) and an optional overrides
// file (~/.atom/themes/<name>.json, keyed by the registry theme name).
//
// `resolveTheme` deep-merges an override into a registered theme WITHOUT
// mutating any of the three objects (the registry entries are shared
// process-wide — mutation would leak across mounts). Unknown keys are
// unreachable by construction: `ThemeOverride` only admits `Theme`'s own
// leaf keys at compile time, and `parseThemeFile`/`themeOverrideFromTui`
// strip unknown keys at runtime (probe coming from untrusted JSON).
//
// Precedence (documented in docs/configuration.md): atom.json tui fields
// first, then the user overrides file ON TOP (the more explicit surface
// wins), all resolved onto the registry base.
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { TuiConfig } from "../config.js";
import { theme } from "./theme.js";
import type { Theme } from "./theme.js";

// Every leaf of Theme is string | number | boolean (optionally undefined),
// and every non-leaf is a plain record namespace, so one recursive mapped
// type describes the full override surface. Leaf types are WIDENED to their
// primitive (a literal `"green"` accepts `"cyan"`): the singleton's literal
// types pin exact BASE values; an override is a replacement value of the
// same kind, so it needs the widened form.
export type WidenOverrideLeaf<T> = Exclude<T, undefined> extends string
  ? string | undefined
  : Exclude<T, undefined> extends number
    ? number | undefined
    : Exclude<T, undefined> extends boolean
      ? boolean | undefined
      : T;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown>
    ? DeepPartial<T[K]>
    : WidenOverrideLeaf<T[K]>;
};

// The override shape a user may express: any subset of the theme's namespaces.
export type ThemeOverride = DeepPartial<Theme>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Primitive-only leaf merge: a namespace is merged key-by-key (sibling keys
// of the base survive), a leaf is replaced; `undefined` never erases a base
// value (an absent override slot is "no opinion", not "clear").
function mergeValue(baseValue: unknown, overrideValue: unknown): unknown {
  if (overrideValue === undefined) return baseValue;
  if (isRecord(baseValue) && isRecord(overrideValue)) {
    const merged: Record<string, unknown> = { ...baseValue };
    for (const [key, overridePart] of Object.entries(overrideValue)) {
      if (overridePart === undefined) continue;
      merged[key] = mergeValue(baseValue[key], overridePart);
    }
    return merged;
  }
  return overrideValue;
}

// Deep merge onto a registry entry. Base stays untouched; unknown override
// keys never reach the output (the walk iterates the BASE's keys, and every
// override namespace was itself built by the validated parsers below).
export function resolveTheme(base: Theme, override: ThemeOverride): Theme {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base) as Array<keyof Theme & string>) {
    out[key] = mergeValue(base[key], (override as Record<string, unknown>)[key]);
  }
  // The only two types that can ever be unresolved here are intentional:
  // DeepPartial is exhaustive over Theme's own shape.
  return out as unknown as Theme;
}

// Merge two already-validated overrides leaf-wise (file wins over config,
// namespace by namespace). Either side may be null; identity of the winner
// matters for the caller's fast path.
export function mergeOverrides(
  lower: ThemeOverride | null,
  upper: ThemeOverride | null,
): ThemeOverride | null {
  if (lower === null) return upper;
  if (upper === null) return lower;
  const out: Record<string, unknown> = {};
  // Union of namespace keys, both sides validated against the same base.
  for (const key of new Set([
    ...Object.keys(lower as Record<string, unknown>),
    ...Object.keys(upper as Record<string, unknown>),
  ])) {
    out[key] = mergeValue(
      (lower as Record<string, unknown>)[key],
      (upper as Record<string, unknown>)[key],
    );
  }
  return out as unknown as ThemeOverride;
}

// atom.json `tui` -> ThemeOverride. Only the keys a user can express there
// are mapped; `density`/`backgroundMode` ride along in config (validated,
// documented) and get their rendering in the background phase. "terminal"
// means "no paint" (the theme default) — no override side is set, so the
// semantics cannot be accidentally true-ed by merge.
export function themeOverrideFromTui(
  tui: TuiConfig | undefined,
): ThemeOverride | null {
  if (tui === undefined) return null;
  const override: Record<string, unknown> = {};
  const color: Record<string, unknown> = {};
  if (
    tui.background !== undefined &&
    tui.background !== "terminal"
  ) {
    color["background"] = tui.background;
  }
  if (
    tui.foreground !== undefined &&
    tui.foreground !== "terminal"
  ) {
    color["foreground"] = tui.foreground;
  }
  if (Object.keys(color).length > 0) override["color"] = color;
  if (tui.layout !== undefined) {
    // The config expresses `tui.layout` FLAT (`"overlayReserve.dock": 5` —
    // one flat token map, clamped in config.ts), but the theme's `layout`
    // namespace is NESTED (`layout.overlayReserve.dock`). Expanding here
    // keeps `resolveTheme` walking only base-shaped namespaces, so merged
    // values always land in real keys — a flat dotted key would be an inert
    // extra property the resolved theme leaks (review MAJOR-1).
    const flat: Record<string, number> = {};
    const nested: Record<string, Record<string, number>> = {};
    for (const [key, value] of Object.entries(tui.layout)) {
      const dot = key.indexOf(".");
      if (dot > 0) {
        const group = key.slice(0, dot);
        (nested[group] ??= {})[key.slice(dot + 1)] = value;
      } else {
        flat[key] = value;
      }
    }
    override["layout"] = { ...flat, ...nested };
  }
  if (Object.keys(override).length === 0) return null;
  return override as unknown as ThemeOverride;
}

// One dim leaf from an untrusted overrides file: strings/numbers/booleans
// pass (Theme leaves are exactly these), anything structural is a warning.
function parseOverrideLeaf(
  namespace: string,
  key: string,
  value: unknown,
  warnings: string[],
): boolean {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    warnings.push(
      `themes override: ignoring "${namespace}.${key}" (value must be a string, number, or boolean)`,
    );
    return false;
  }
  return true;
}

// Validate one namespace of an overrides file against the registry base's
// own namespaces: unknown namespaces and unknown leaf keys are unreachable
// (warned + dropped), structural leaves recurse (border.tool, layout.overlayReserve).
function parseOverrideNamespace(
  base: Record<string, unknown>,
  file: Record<string, unknown>,
  namespace: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(file[namespace])) {
    warnings.push(
      `themes override: ignoring "${namespace}" (must be an object)`,
    );
    return undefined;
  }
  const baseNamespace = isRecord(base[namespace]) ? base[namespace] : null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file[namespace])) {
    if (baseNamespace === null || !Object.hasOwn(baseNamespace, key)) {
      warnings.push(
        `themes override: unknown key "${namespace}.${key}" — dropped`,
      );
      continue;
    }
    const baseLeaf = baseNamespace[key];
    if (isRecord(baseLeaf)) {
      if (!isRecord(value)) {
        warnings.push(
          `themes override: ignoring "${namespace}.${key}" (must be an object)`,
        );
        continue;
      }
      // One structural level deeper (the only such namespaces are
      // border.tool and layout.overlayReserve — shallow by construction).
      const inner: Record<string, unknown> = {};
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (!Object.hasOwn(baseLeaf, innerKey)) {
          warnings.push(
            `themes override: unknown key "${namespace}.${key}.${innerKey}" — dropped`,
          );
        } else if (parseOverrideLeaf(namespace, `${key}.${innerKey}`, innerValue, warnings)) {
          inner[innerKey] = innerValue;
        }
      }
      if (Object.keys(inner).length > 0) out[key] = inner;
    } else if (parseOverrideLeaf(namespace, key, value, warnings)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Parse the raw contents of an optional overrides file. The caller reads
// the bytes; this stays a pure validator: never throws, every problem is a
// warning and a per-key drop. Returns `theme` only when at least one valid
// key survived. `raw` may be a string (file text), parsed JSON, anything.
export function parseThemeFile(raw: unknown): {
  theme?: ThemeOverride;
  warnings: string[];
} {
  const warnings: string[] = [];
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return {
        warnings: ["themes override: not valid JSON — ignored"],
      };
    }
  }
  if (!isRecord(data)) {
    return {
      warnings: ["themes override: must be a JSON object — ignored"],
    };
  }
  const base = theme as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(base, key)) {
      warnings.push(`themes override: unknown key "${key}" — dropped`);
      continue;
    }
    if (isRecord(data[key])) {
      const namespace = parseOverrideNamespace(base, data, key, warnings);
      if (namespace !== undefined) out[key] = namespace;
    } else if (parseOverrideLeaf(key, "self", data[key], warnings)) {
      // Non-record top-level value: type-wise Theme is all-record namespaces
      // (color/border/dock/spacing/symbol/layout + the reserved pill), so a
      // bare scalar over a namespace name is a shape error.
      warnings.push(
        `themes override: ignoring "${key}" (must be an object)`,
      );
    }
  }
  if (Object.keys(out).length === 0) return { warnings };
  return { theme: out as unknown as ThemeOverride, warnings };
}

// Read the optional overrides file for ONE registry theme name:
// `<home>/.atom/themes/<name>.json`. Absent = silent null. Present but
// unreadable/unvalidated = warnings, null. Home override mirrors the
// config/auth readers (tests never touch a real home).
export function loadUserThemeFile(home: string | undefined, name: string): {
  override: ThemeOverride | null;
  warnings: string[];
} {
  if (home === undefined) return { override: null, warnings: [] };
  const file = path.join(home, ".atom", "themes", `${name}.json`);
  if (!existsSync(file)) return { override: null, warnings: [] };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {
      override: null,
      warnings: [`themes override: could not read ${file}`],
    };
  }
  const parsed = parseThemeFile(raw);
  return { override: parsed.theme ?? null, warnings: parsed.warnings };
}
