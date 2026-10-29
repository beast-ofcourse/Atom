// atom.json — ATOM's config file (Claude-Code-settings/opencode.json-style
// durable configuration layer).
//
// Two levels, per-key merge (project wins over global):
// - project: <cwd>/atom.json
// - global:  ~/.atom/atom.json (ATOM_HOME overrides home, like auth.json)
//
// Precedence overall: env vars > saved session prefs (/model, /provider,
// /effort picks) > project atom.json > global atom.json > compiled defaults.
// So atom.json sets first-run/project defaults; a later explicit pick (saved)
// still wins across restarts; env always wins.
//
// Everything is optional and validated: unknown keys are ignored
// (forward-compatible), invalid values fall back per-key with a warning
// string (surfaced in /context) — loading never throws, missing files are
// normal and silent. Reads are fresh per call (edits apply without restart,
// like skills); files are tiny JSON.
//
// Keys:
// - provider: ProviderId for first-run default (needs its key, else zen)
// - model: default model id (non-empty string)
// - reasoningEffort: auto/low/medium/high/max ("default" is accepted as a
//   deprecated alias for "auto")
// - maxToolSteps: 5–100 (tool rounds per turn)
// - compactPct: 50–95 (auto-compact percent of verified window)
// - compactAuto: boolean (real-usage auto-compact master switch, default on;
//   false disables AUTO-compaction only — manual /compact always works)
// - compactReserve: reserved output buffer in tokens for the usable-limit
//   calculation (usable = verified window − reserve; clamped 4096–100000,
//   mirroring src/overflow.ts OVERFLOW_RESERVE_MIN/MAX — kept literal here
//   so config.ts has no runtime import of overflow.ts, which itself reads
//   config at runtime)
// - telemetry: {enabled?: boolean} (local observability recording, default on)
// - extensions: {enabled?: string[], disabled?: string[]} (per-extension
//   enable/disable patterns over the extension name, `*`/`?` globs; disabled
//   wins over enabled, non-empty enabled is an allowlist — see extensions.ts
//   precedence. CLI --enable/--disable-extension wins over this when set.)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { homeDir } from "./auth.js";
import { parseMcpServerEntry, type McpServerConfig } from "./mcp/config.js";
import { isProviderId, type ProviderId } from "./providers.js";
import { parseNetworkPolicy, type NetworkPolicy } from "./policy.js";
import type { ReasoningEffort } from "./zen.js";
// Type-only: erased at runtime, so importing the registry (which loads both
// theme objects) never costs anything and never cycles. Runtime import of
// ui/theme.js is NOT allowed here (architecture gate: runtime modules never
// import the UI) — layout token names are locally mirrored below, same
// precedent as TUI_THEME_VALUES.
import type { ThemeName } from "./ui/themes/registry.js";

export const ATOM_CONFIG_FILENAME = "atom.json";

// Kept local (not imported from zen.js) so config.ts has no runtime import
// of zen.js — zen.js imports loadAtomConfig for budget fallbacks, and a
// runtime cycle would be fragile. Mirrors EFFORT_OPTIONS exactly.
const EFFORT_VALUES: readonly string[] = [
  "auto",
  "low",
  "medium",
  "high",
  "max",
];
// Pre-auto name for the same level (old atom.json files keep working).
const LEGACY_EFFORT_VALUES: Readonly<Record<string, ReasoningEffort>> = {
  default: "auto",
};

export type AtomConfig = {
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  maxToolSteps?: number;
  compactPct?: number;
  compactAuto?: boolean;
  compactReserve?: number;
  compactTailTurns?: number;
  compactPreserveRecentTokens?: number;
  compactPrune?: boolean;
  // Webfetch SSRF policy: which network zones the model may retrieve.
  // Defaults allow public + localhost only (see defaultNetworkPolicy).
  network?: NetworkPolicy;
  // Local observability: recording is on by default (local-only, truncated +
  // secret-scrubbed traces under ~/.atom/telemetry/). Set enabled:false to
  // opt out (ATOM_TELEMETRY=0 wins over this). See docs/observability.md.
  telemetry?: { enabled?: boolean };
  // Per-extension enable/disable patterns (extension names, `*`/`?` globs).
  extensions?: { enabled?: string[]; disabled?: string[] };
  // MCP servers (tickets 01/02): name -> server entry (local stdio command
  // or remote HTTP URL). Parsed per entry; invalid entries are dropped with
  // a warning, loading never throws.
  mcp?: Record<string, McpServerConfig>;
  // Autoscroll speed: lines per page for PgUp/PgDn. 1-1000, default 10.
  // Does not affect Home/End (instant edge jumps) or autoscroll re-follow
  // (End key, /autoscroll on while held — instant snap-to-bottom preserved).
  scrollSpeed?: number;
  // Terminal UI customization (Phase 5): theme name + a small set of widget
  // knobs, all validated — unknown keys warn and drop, numbers clamp to
  // per-token ranges, colors must be `#rrggbb` or "terminal". `density` and
  // `backgroundMode` are validated and documented but their rendering lands
  // with the background phase (plan tui-resize-theme-layout Phase 6).
  tui?: TuiConfig;
};

// The `tui` block: user customization of the terminal UI through one
// validated surface. `theme` picks the registry theme (also written by
// /theme — see setGlobalTuiTheme); `layout` overrides individual layout
// token numbers (keys validated against the theme's `layout` namespace).
// `density`/`backgroundMode`/`background`/`foreground` are parsed now and
// become visible when the background phase ships.
export type TuiConfig = {
  theme?: ThemeName;
  density?: "compact" | "cozy" | "comfortable";
  background?: string;
  foreground?: string;
  backgroundMode?: "tint" | "terminal";
  layout?: Record<string, number>;
};

export type ConfigLoad = {
  config: AtomConfig;
  warnings: string[];
  sources: { project: boolean; global: boolean };
};

export function projectConfigPath(projectDir?: string): string {
  return path.join(projectDir ?? process.cwd(), ATOM_CONFIG_FILENAME);
}

export function globalConfigPath(home?: string): string {
  return path.join(home ?? homeDir(), ".atom", ATOM_CONFIG_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// Parse one level's file. Returns null when absent/unreadable/invalid
// (silent — a missing config is the normal case); otherwise the validated
// subset plus per-key warnings.
function parseLevel(
  filePath: string,
  label: string,
): { config: AtomConfig; warnings: string[]; present: boolean } {
  const empty = { config: {}, warnings: [], present: false };
  let raw: string;
  try {
    if (!existsSync(filePath)) return empty;
    raw = readFileSync(filePath, "utf8");
  } catch {
    return empty;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      config: {},
      warnings: [`${label} atom.json is not valid JSON — ignored`],
      present: true,
    };
  }
  if (!isRecord(data)) {
    return {
      config: {},
      warnings: [`${label} atom.json must be a JSON object — ignored`],
      present: true,
    };
  }
  const config: AtomConfig = {};
  const warnings: string[] = [];
  const bad = (key: string, why: string) =>
    warnings.push(`${label} atom.json: ignoring invalid "${key}" (${why})`);
  const provider = data["provider"];
  if (provider !== undefined) {
    if (typeof provider === "string" && isProviderId(provider)) {
      config.provider = provider;
    } else {
      bad("provider", "must be a known provider id");
    }
  }
  const model = data["model"];
  if (model !== undefined) {
    if (typeof model === "string" && model.length > 0) {
      config.model = model;
    } else {
      bad("model", "must be a non-empty string");
    }
  }
  const effort = data["reasoningEffort"];
  if (effort !== undefined) {
    if (typeof effort === "string" && EFFORT_VALUES.includes(effort)) {
      config.reasoningEffort = effort as ReasoningEffort;
    } else if (typeof effort === "string" && effort in LEGACY_EFFORT_VALUES) {
      config.reasoningEffort = LEGACY_EFFORT_VALUES[effort]!;
    } else {
      bad("reasoningEffort", `must be one of ${EFFORT_VALUES.join("/")}`);
    }
  }
  const ranged: Array<{
    key: "maxToolSteps" | "compactPct" | "compactReserve";
    min: number;
    max: number;
  }> = [
    { key: "maxToolSteps", min: 5, max: 100 },
    { key: "compactPct", min: 50, max: 95 },
    // Reserve buffer bounds mirror overflow.ts (literals, not imports — see
    // the header note on the import direction).
    { key: "compactReserve", min: 4096, max: 100000 },
  ];
  for (const { key, min, max } of ranged) {
    const v = data[key];
    if (v === undefined) continue;
    const n = asFiniteNumber(v);
    if (n === undefined) {
      bad(key, "must be a number");
      continue;
    }
    // Clamp like the env-var readers (same bounds, same forgiveness), but
    // say so — a clamped value is usually a typo worth surfacing.
    const clamped = Math.min(Math.max(Math.floor(n), min), max);
    if (clamped !== n) {
      warnings.push(
        `${label} atom.json: "${key}" clamped to ${clamped} (range ${min}–${max})`,
      );
    }
    config[key] = clamped;
  }
  const compactAuto = data["compactAuto"];
  if (compactAuto !== undefined) {
    if (typeof compactAuto === "boolean") {
      config.compactAuto = compactAuto;
    } else {
      bad("compactAuto", "must be a boolean");
    }
  }
  const compactTailTurns = data["compactTailTurns"];
  if (compactTailTurns !== undefined) {
    const n = asFiniteNumber(compactTailTurns);
    if (n === undefined || !Number.isInteger(n) || n < 0) {
      bad("compactTailTurns", "must be an integer >= 0");
    } else {
      config.compactTailTurns = Math.floor(n);
    }
  }
  const compactPreserveRecentTokens = data["compactPreserveRecentTokens"];
  if (compactPreserveRecentTokens !== undefined) {
    const n = asFiniteNumber(compactPreserveRecentTokens);
    if (n === undefined) {
      bad("compactPreserveRecentTokens", "must be a number");
    } else {
      const min = 2000;
      const max = 50000;
      const clamped = Math.min(Math.max(Math.floor(n), min), max);
      if (clamped !== n) {
        warnings.push(
          `${label} atom.json: "compactPreserveRecentTokens" clamped to ${clamped} (range ${min}–${max})`,
        );
      }
      config.compactPreserveRecentTokens = clamped;
    }
  }
  const compactPrune = data["compactPrune"];
  if (compactPrune !== undefined) {
    if (typeof compactPrune === "boolean") {
      config.compactPrune = compactPrune;
    } else {
      bad("compactPrune", "must be a boolean");
    }
  }
  const scrollSpeed = data["scrollSpeed"];
  if (scrollSpeed !== undefined) {
    const n = asFiniteNumber(scrollSpeed);
    if (n === undefined || !Number.isInteger(n)) {
      bad("scrollSpeed", "must be an integer");
    } else {
      const clamped = Math.min(Math.max(Math.floor(n), 1), 1000);
      if (clamped !== n) {
        warnings.push(
          `${label} atom.json: "scrollSpeed" clamped to ${clamped} (range 1–1000)`,
        );
      }
      config.scrollSpeed = clamped;
    }
  }
  // TUI customization (Phase 5): one validated block; unknown inner keys and
  // values fall back per-key with a warning like every other key here.
  // Top-level per-key merge means a project `tui` block replaces the global
  // one wholesale (documented in docs/configuration.md).
  const tui = data["tui"];
  if (tui !== undefined) {
    const parsed = parseTui(tui, bad, (msg) =>
      warnings.push(`${label} atom.json: ${msg}`),
    );
    if (parsed !== undefined) config.tui = parsed;
  }
  const network = data["network"];
  if (network !== undefined) {
    const parsed = parseNetworkPolicy(network);
    config.network = parsed.policy;
    for (const w of parsed.warnings) warnings.push(`${label} atom.json: ${w}`);
  }
  const telemetry = data["telemetry"];
  if (telemetry !== undefined) {
    if (isRecord(telemetry)) {
      const enabled = (telemetry as Record<string, unknown>)["enabled"];
      if (enabled === undefined) {
        // `{}` is valid: all-telemetry keys are optional, nothing to set.
      } else if (typeof enabled === "boolean") {
        config.telemetry = { enabled };
      } else {
        warnings.push(
          `${label} atom.json: ignoring invalid "telemetry.enabled" (must be a boolean)`,
        );
      }
    } else {
      warnings.push(
        `${label} atom.json: ignoring invalid "telemetry" (must be an object)`,
      );
    }
  }
  // MCP servers (tickets 01/02): a record of server name -> entry. Each
  // entry is validated independently: invalid entries are ignored with a
  // warning, loading never throws. Local entries need a non-empty command
  // argv; remote entries need an http(s) URL. `enabled` defaults to true and
  // `timeout` (ms) defaults to MCP_DEFAULT_TIMEOUT_MS — an invalid
  // enabled/timeout falls back with a warning instead of dropping the entry.
  const mcp = data["mcp"];
  if (mcp !== undefined) {
    if (isRecord(mcp)) {
      const servers: Record<string, McpServerConfig> = {};
      for (const [name, entry] of Object.entries(mcp)) {
        if (name.length === 0) {
          warnings.push(
            `${label} atom.json: ignoring invalid "mcp" entry (empty server name)`,
          );
          continue;
        }
        const parsed = parseMcpServerEntry(entry, (msg) =>
          warnings.push(`${label} atom.json: "mcp.${name}" ${msg}`),
        );
        if (typeof parsed === "string") {
          warnings.push(
            `${label} atom.json: ignoring invalid "mcp.${name}" (${parsed})`,
          );
          continue;
        }
        servers[name] = parsed;
      }
      if (Object.keys(servers).length > 0) config.mcp = servers;
    } else {
      warnings.push(
        `${label} atom.json: ignoring invalid "mcp" (must be an object)`,
      );
    }
  }
  // Per-extension patterns (ticket 07): validated arrays of non-empty
  // strings; a non-array key is ignored wholesale, bad entries are dropped
  // with a warning (never throw, like every other key here).
  const extensions = data["extensions"];
  if (extensions !== undefined) {
    if (isRecord(extensions)) {
      const parsed: { enabled?: string[]; disabled?: string[] } = {};
      for (const key of ["enabled", "disabled"] as const) {
        const v = (extensions as Record<string, unknown>)[key];
        if (v === undefined) continue;
        if (!Array.isArray(v)) {
          warnings.push(
            `${label} atom.json: ignoring invalid "extensions.${key}" (must be an array of patterns)`,
          );
          continue;
        }
        const kept = v.filter(
          (e): e is string => typeof e === "string" && e.length > 0,
        );
        if (kept.length !== v.length) {
          warnings.push(
            `${label} atom.json: "extensions.${key}" dropped ${v.length - kept.length} empty/non-string pattern(s)`,
          );
        }
        parsed[key] = kept;
      }
      if (parsed.enabled !== undefined || parsed.disabled !== undefined) {
        config.extensions = parsed;
      }
    } else {
      warnings.push(
        `${label} atom.json: ignoring invalid "extensions" (must be an object)`,
      );
    }
  }
  return { config, warnings, present: true };
}

export function loadAtomConfig(
  projectDir?: string,
  homeDir?: string,
): ConfigLoad {
  const project = parseLevel(projectConfigPath(projectDir), "project");
  const global = parseLevel(globalConfigPath(homeDir), "global");
  return {
    config: { ...global.config, ...project.config },
    warnings: [...global.warnings, ...project.warnings],
    sources: { project: project.present, global: global.present },
  };
}

// ── tui block (Phase 5) ──────────────────────────────────────────────────

// theme names, mirrored locally from the registry's listThemes() (same
// local-mirror precedent as EFFORT_VALUES above keeps config.ts free of a
// runtime dependency on the UI layer's registry — the mirror-parity guard
// in tests/layout-tokens.test.ts is the trip wire against drift).
// Exported for that guard only, never imported at runtime by ui code.
export const TUI_THEME_VALUES: readonly string[] = ["ember", "classic"];

// Layout token clamp bands for `tui.layout`: a user token is clamped into
// its band so a typo neither explodes a frame nor silently
// snaps a meaningful override (the same forgiveness the ranged keys above
// use). Keys mirror the theme's
// `layout` namespace locally (no runtime UI import — see the header note);
// the mirror-parity guard in tests/layout-tokens.test.ts is the trip
// wire between mirror and theme. Exported for that guard only.
export const TUI_LAYOUT_RANGES: Readonly<Record<string, { min: number; max: number }>> = {
  breakpointXs: { min: 20, max: 300 },
  breakpointSm: { min: 30, max: 400 },
  breakpointMd: { min: 40, max: 600 },
  breakpointLg: { min: 50, max: 800 },
  widgetMaxColumns: { min: 40, max: 400 },
  codeBlockVisibleMax: { min: 5, max: 2000 },
  longLineSkipHighlight: { min: 10, max: 1000000 },
  diffMaxRows: { min: 1, max: 2000 },
  scrollbackWindow: { min: 0, max: 10000 },
  liveDraftReserveLines: { min: 0, max: 200 },
  liveDraftMinLines: { min: 1, max: 50 },
  pickerVisibleRows: { min: 1, max: 50 },
  frameSpareRows: { min: 0, max: 10 },
  "overlayReserve.composer": { min: 0, max: 20 },
  "overlayReserve.picker": { min: 0, max: 20 },
  "overlayReserve.inspector": { min: 0, max: 20 },
  "overlayReserve.palette": { min: 0, max: 20 },
  "overlayReserve.ledger": { min: 0, max: 20 },
  "overlayReserve.dock": { min: 0, max: 20 },
};

// A `#rrggbb` hex color, or the literal "terminal" (inherit the terminal's
// own colors — the default).
const TUI_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function parseTui(
  value: unknown,
  bad: (key: string, why: string) => void,
  warn: (msg: string) => void,
): TuiConfig | undefined {
  if (!isRecord(value)) {
    bad("tui", "must be an object");
    return undefined;
  }
  const tui: TuiConfig = {};
  const themeName = value["theme"];
  if (themeName !== undefined) {
    if (typeof themeName === "string" && TUI_THEME_VALUES.includes(themeName)) {
      tui.theme = themeName as ThemeName;
    } else {
      bad("tui.theme", `must be one of ${TUI_THEME_VALUES.join("/")}`);
    }
  }
  const density = value["density"];
  if (density !== undefined) {
    if (
      typeof density === "string" &&
      ["compact", "cozy", "comfortable"].includes(density)
    ) {
      tui.density = density as TuiConfig["density"];
    } else {
      bad("tui.density", 'must be one of "compact"/"cozy"/"comfortable"');
    }
  }
  for (const colorKey of ["background", "foreground"] as const) {
    const color = value[colorKey];
    if (color === undefined) continue;
    if (
      (typeof color === "string" && TUI_COLOR_PATTERN.test(color)) ||
      color === "terminal"
    ) {
      tui[colorKey] = color;
    } else {
      bad(
        `tui.${colorKey}`,
        'must be a "#rrggbb" hex color or the literal "terminal"',
      );
    }
  }
  const backgroundMode = value["backgroundMode"];
  if (backgroundMode !== undefined) {
    if (backgroundMode === "tint" || backgroundMode === "terminal") {
      tui.backgroundMode = backgroundMode;
    } else {
      bad("tui.backgroundMode", 'must be one of "tint"/"terminal"');
    }
  }
  const layout = value["layout"];
  if (layout !== undefined) {
    if (isRecord(layout)) {
      const tokens: Record<string, number> = {};
      for (const [key, v] of Object.entries(layout)) {
        if (!Object.hasOwn(TUI_LAYOUT_RANGES, key)) {
          bad(`tui.layout.${key}`, "unknown layout token — dropped");
          continue;
        }
        const n = asFiniteNumber(v);
        if (n === undefined) {
          bad(`tui.layout.${key}`, "must be a number");
          continue;
        }
        // Same forgiveness as the top-level ranged keys: clamp, floor, and
        // say so.
        const { min, max } = TUI_LAYOUT_RANGES[key]!;
        const clamped = Math.min(Math.max(Math.floor(n), min), max);
        if (clamped !== n) {
          warn(`"tui.layout.${key}" clamped to ${clamped} (range ${min}–${max})`);
        }
        tokens[key] = clamped;
      }
      if (Object.keys(tokens).length > 0) tui.layout = tokens;
    } else {
      bad("tui.layout", "must be an object of token names to numbers");
    }
  }
  // An entirely-invalid tui block stays out of the config (the defaults win,
  // same per-key semantics as every other key).
  if (
    tui.theme === undefined &&
    tui.density === undefined &&
    tui.background === undefined &&
    tui.foreground === undefined &&
    tui.backgroundMode === undefined &&
    tui.layout === undefined
  ) {
    return undefined;
  }
  return tui;
}

// Persist a theme pick to the GLOBAL atom.json (`tui.theme`) — /theme's
// durable write. Project-level `tui.theme` still wins over global (see the
// precedence notes in docs/configuration.md), so a repo-configured theme
// masks the pick; that is the documented order, never a write to the repo.
// Never destroys an existing config: an unreadable file aborts with the
// reason, leaving the pick live for the session only.
export function setGlobalTuiTheme(
  name: ThemeName,
  home?: string,
): { ok: true } | { ok: false; reason: string } {
  const target = globalConfigPath(home);
  let data: Record<string, unknown> = {};
  // An existing config is always read back and only ever amended: a file we
  // cannot parse aborts the write (never overwritten — the pick stays live
  // for the session only).
  if (existsSync(target)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
      if (!isRecord(parsed)) {
        return { ok: false, reason: "global atom.json is not a JSON object" };
      }
      data = parsed;
    } catch {
      return { ok: false, reason: "global atom.json is not valid JSON" };
    }
  }
  const prevTui = isRecord(data["tui"]) ? data["tui"] : {};
  const next = { ...data, tui: { ...prevTui, theme: name } };
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    return { ok: false, reason: "could not write the config file" };
  }
  return { ok: true };
}
