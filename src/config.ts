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
// - reasoningEffort: default/low/medium/high/max
// - maxHistoryMessages: 10–1000 (history message budget)
// - maxHistoryChars: 10_000–2_000_000 (history char budget)
// - maxToolSteps: 5–100 (tool rounds per turn)
// - compactPct: 50–95 (auto-compact percent of verified window)

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { homeDir } from "./auth.js";
import { isProviderId, type ProviderId } from "./providers.js";
import type { ReasoningEffort } from "./zen.js";

export const ATOM_CONFIG_FILENAME = "atom.json";

// Kept local (not imported from zen.js) so config.ts has no runtime import
// of zen.js — zen.js imports loadAtomConfig for budget fallbacks, and a
// runtime cycle would be fragile. Mirrors EFFORT_OPTIONS exactly.
const EFFORT_VALUES: readonly string[] = ["default", "low", "medium", "high", "max"];

export type AtomConfig = {
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  maxHistoryMessages?: number;
  maxHistoryChars?: number;
  maxToolSteps?: number;
  compactPct?: number;
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
    } else {
      bad("reasoningEffort", `must be one of ${EFFORT_VALUES.join("/")}`);
    }
  }
  const ranged: Array<{ key: "maxHistoryMessages" | "maxHistoryChars" | "maxToolSteps" | "compactPct"; min: number; max: number }> = [
    { key: "maxHistoryMessages", min: 10, max: 1000 },
    { key: "maxHistoryChars", min: 10_000, max: 2_000_000 },
    { key: "maxToolSteps", min: 5, max: 100 },
    { key: "compactPct", min: 50, max: 95 },
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
