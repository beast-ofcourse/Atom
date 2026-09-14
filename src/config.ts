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

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { homeDir } from "./auth.js";
import { parseMcpServerEntry, type McpServerConfig } from "./mcp/config.js";
import { isProviderId, type ProviderId } from "./providers.js";
import { parseNetworkPolicy, type NetworkPolicy } from "./policy.js";
import type { ReasoningEffort } from "./zen.js";

export const ATOM_CONFIG_FILENAME = "atom.json";

// Kept local (not imported from zen.js) so config.ts has no runtime import
// of zen.js — zen.js imports loadAtomConfig for budget fallbacks, and a
// runtime cycle would be fragile. Mirrors EFFORT_OPTIONS exactly.
const EFFORT_VALUES: readonly string[] = ["auto", "low", "medium", "high", "max"];
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
  // opt out (ATOM_TELEMETRY=0 wins over this). See documentation/observability.md.
  telemetry?: { enabled?: boolean };
  // Per-extension enable/disable patterns (extension names, `*`/`?` globs).
  extensions?: { enabled?: string[]; disabled?: string[] };
  // MCP servers (tickets 01/02): name -> server entry (local stdio command
  // or remote HTTP URL). Parsed per entry; invalid entries are dropped with
  // a warning, loading never throws.
  mcp?: Record<string, McpServerConfig>;
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Parse one level's file. Returns null when absent/unreadable/invalid
// (silent — a missing config is the normal case); otherwise the validated
// subset plus per-key warnings.
function parseLevel(
  filePath: string,
  label: string
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
  const ranged: Array<{ key: "maxToolSteps" | "compactPct" | "compactReserve"; min: number; max: number }> = [
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
      warnings.push(`${label} atom.json: "${key}" clamped to ${clamped} (range ${min}–${max})`);
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
        warnings.push(`${label} atom.json: "compactPreserveRecentTokens" clamped to ${clamped} (range ${min}–${max})`);
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
  const network = data["network"];
  if (network !== undefined) {
    const parsed = parseNetworkPolicy(network);
    config.network = parsed.policy;
    for (const w of parsed.warnings) warnings.push(`${label} atom.json: ${w}`);
  }
  const telemetry = data["telemetry"];
  if (telemetry !== undefined) {
    if (!isRecord(telemetry)) {
      warnings.push(`${label} atom.json: ignoring invalid "telemetry" (must be an object)`);
    } else {
      const enabled = (telemetry as Record<string, unknown>)["enabled"];
      if (enabled === undefined) {
        // `{}` is valid: all-telemetry keys are optional, nothing to set.
      } else if (typeof enabled === "boolean") {
        config.telemetry = { enabled };
      } else {
        warnings.push(`${label} atom.json: ignoring invalid "telemetry.enabled" (must be a boolean)`);
      }
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
    if (!isRecord(mcp)) {
      warnings.push(`${label} atom.json: ignoring invalid "mcp" (must be an object)`);
    } else {
      const servers: Record<string, McpServerConfig> = {};
      for (const [name, entry] of Object.entries(mcp)) {
        if (name.length === 0) {
          warnings.push(`${label} atom.json: ignoring invalid "mcp" entry (empty server name)`);
          continue;
        }
        const parsed = parseMcpServerEntry(entry, (msg) =>
          warnings.push(`${label} atom.json: "mcp.${name}" ${msg}`)
        );
        if (typeof parsed === "string") {
          warnings.push(`${label} atom.json: ignoring invalid "mcp.${name}" (${parsed})`);
          continue;
        }
        servers[name] = parsed;
      }
      if (Object.keys(servers).length > 0) config.mcp = servers;
    }
  }
  // Per-extension patterns (ticket 07): validated arrays of non-empty
  // strings; a non-array key is ignored wholesale, bad entries are dropped
  // with a warning (never throw, like every other key here).
  const extensions = data["extensions"];
  if (extensions !== undefined) {
    if (!isRecord(extensions)) {
      warnings.push(`${label} atom.json: ignoring invalid "extensions" (must be an object)`);
    } else {
      const parsed: { enabled?: string[]; disabled?: string[] } = {};
      for (const key of ["enabled", "disabled"] as const) {
        const v = (extensions as Record<string, unknown>)[key];
        if (v === undefined) continue;
        if (!Array.isArray(v)) {
          warnings.push(`${label} atom.json: ignoring invalid "extensions.${key}" (must be an array of patterns)`);
          continue;
        }
        const kept = v.filter((e): e is string => typeof e === "string" && e.length > 0);
        if (kept.length !== v.length) {
          warnings.push(
            `${label} atom.json: "extensions.${key}" dropped ${v.length - kept.length} empty/non-string pattern(s)`
          );
        }
        parsed[key] = kept;
      }
      if (parsed.enabled !== undefined || parsed.disabled !== undefined) {
        config.extensions = parsed;
      }
    }
  }
  return { config, warnings, present: true };
}

export function loadAtomConfig(projectDir?: string, homeDir?: string): ConfigLoad {
  const project = parseLevel(projectConfigPath(projectDir), "project");
  const global = parseLevel(globalConfigPath(homeDir), "global");
  return {
    config: { ...global.config, ...project.config },
    warnings: [...global.warnings, ...project.warnings],
    sources: { project: project.present, global: global.present },
  };
}
