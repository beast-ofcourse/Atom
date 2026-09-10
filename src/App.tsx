// Ink (React) TUI for the minimal Atom chatbot.
// Hand-rolled input + dropdowns via useInput (no extra deps).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, usePaste, useStdout } from "ink";
import {
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  LoopCancelledError,
  REASONING_EFFORT_SUPPORTED_MODELS,
  buildSystemPrompt,
  fetchModelsForProviderWithStatus,
  fetchModelsWithStatus,
  historyChars,
  isEffortSupported,
  messageChars,
  openTodoNeedles,
  runAgenticLoopForProvider,
  type ApprovalDecision,
  type ChatMessage,
  type PermissionMode,
  type Phase,
  type ReasoningEffort,
  type Usage,
} from "./zen.js";
import {
  createContextManager,
  trackHistory,
  type ContextManager,
} from "./context-manager.js";
import {
  assemblePrefix,
  providerCacheSupport,
} from "./prompt-cache.js";
import { TOOL_DEFINITIONS, TOOL_ONE_LINERS, APPROVAL_PREVIEW_MAX_BYTES, clearTodos, describeToolCall, executeTool, getTodos, needsApproval, previewDiffForApproval, providerSecrets, type ApprovalDiff, type TodoItem } from "./tools.js";
import {
  classifyTurnOutcome,
  createTelemetryRecorder,
  loadTelemetrySessions,
  resolveTelemetryEnabled,
  summarizeTelemetry,
  telemetryDir,
  type LoopTelemetrySink,
  type TelemetryRecorder,
} from "./telemetry.js";
import { buildDashboardHtml, writeTelemetryDashboard } from "./telemetry-dashboard.js";
import {
  formatRules,
  parseRuleInput,
  type PermissionRule,
} from "./permissions.js";
import { decidePolicy, skillGrantsFor } from "./policy.js";
import {
  capSkillBodyForAuto,
  createSkillRegistry,
  loadSkillBody,
  matchSkills,
  resolveSkills,
  type SkillInfo,
} from "./skills.js";
import { contextWindowFor, formatTokenSegment } from "./context-windows.js";
import {
  COMPACT_PCT_DEFAULT,
  buildCompactedHistory,
  collectStoredTouchedFiles,
  collectTouchedFiles,
  compactBoundaryLine,
  compactPct,
  countUserTurns,
  estimateTokensForChars,
  fitSummaryWithFiles,
  isThrashDisabled,
  requestCompactSummary,
  splitHistoryForCompaction,
  type SplitResult,
} from "./compact.js";
import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  chatEndpointFor,
  getProvider,
  isLocalProviderId,
  isProviderId,
  localBaseURLFor,
  maskKey,
  openaiCompatibleChatEndpoint,
  providerNeedsKey,
  validateBaseURL,
  type LocalProviderId,
  type ProviderId,
} from "./providers.js";
import {
  createLocalDiscovery,
  emptyLocalSnapshot,
  summarizeLocalSnapshot,
  type LocalDiscovery,
  type LocalSnapshot,
} from "./local-discovery.js";
import {
  getStoredBaseURL,
  loadAuth,
  resolveApiKey,
  saveAuth,
  setStoredKey,
  type AuthFile,
} from "./auth.js";
import { validateProviderKey } from "./adapters.js";
import {
  clearKiloModelsCache,
  isFreeKiloModel,
  preferFreeKiloModel,
} from "./kilo.js";
import { getGitInfo, withEnvBlock, type GitInfo } from "./env-block.js";
import {
  loadPrefs,
  loadSession,
  saveSession,
  sessionExists,
} from "./session.js";
import { loadAtomConfig } from "./config.js";
import { cancelledTurnLine } from "./rollback.js";
import {
  clearSnapshots,
  conversationCutIndex,
  getCheckpoint,
  listCheckpoints,
  registerHistoryProbe,
  restoreCheckpointFiles,
  type Checkpoint,
} from "./snapshots.js";
import { forgetReadFingerprint, refreshReadFingerprint } from "./tools.js";

import { InputBox } from "./ui/input.js";
import {
  historyNewerIndex,
  historyOlderIndex,
  killToLineEnd,
  killToLineStart,
  killWordBefore,
  lineColOf,
  moveVertically,
  normalizePaste,
  offsetOfLines,
  pushInputHistory as pushInputHistoryList,
  splitInputLines,
} from "./ui/input-model.js";
import { LiveTail } from "./ui/live-tail.js";
import {
  InspectorPanel,
  MAX_TOOL_RECORDS,
  VIEWPORT_LINES,
  createToolRecord,
  type ToolRecord,
} from "./ui/tool-inspector.js";
import { activityText } from "./ui/activity.js";
import { ApprovalBox, QuestionBox } from "./ui/modals.js";
import { PalettePanel } from "./ui/palette.js";
import type { PaletteCategory, PaletteEntry } from "./ui/palette.js";
import { PALETTE_CATEGORY_ORDER, PALETTE_HINTS, paletteCategory } from "./ui/palette.js";
import { PickerMoreAbove, PickerMoreBelow, PickerRow, PickerShell, pickerWindow } from "./ui/pickers.js";
import { StatusBar, shortenCwd } from "./ui/status-bar.js";
import { theme } from "./ui/theme.js";
import { TodoPanel } from "./ui/todo-panel.js";
import { TranscriptView, applyScrollAction, type Turn } from "./ui/transcript.js";
export type AppProps = {
  apiKey: string;
  endpoint: string;
  // Optional: when absent (prod without OPENCODE_ZEN_MODEL) the saved
  // provider/model/effort restore via restorePrefs, else DEFAULT_MODEL.
  // Tests pass explicit values for determinism.
  initialModel?: string;
  // Provided by tests to skip the live model fetch; otherwise the app tries
  // the live list on mount (curated fallback on any failure).
  initialModels?: string[];
  initialProvider?: ProviderId;
  // Local-discovery override (tests inject a fake with canned results;
  // prod uses the loopback probers). Also skips discovery when
  // initialModels is set, keeping suites hermetic.
  localDiscovery?: LocalDiscovery;
  // Claude-Code-style model memory: restore saved provider/model/effort
  // (+resolved key/endpoint) at startup WITHOUT restoring the conversation
  // (still an explicit /resume). Prod (cli.tsx) passes this; tests leave it
  // off so suites stay deterministic regardless of the real ~/.atom. Explicit
  // initialModel/initialProvider props always win over the save.
  restorePrefs?: boolean;
  // Home dir override for ~/.atom/auth.json (tests use a temp dir via
  // ATOM_HOME/HOME env or this prop).
  authHome?: string;
  // Skill directory overrides (tests point these at temp dirs so the suite
  // never reads the real ~/.claude/skills). Defaults: cwd + os.homedir().
  skillDirs?: { projectDir?: string; homeDir?: string };
  // atom.json lookup overrides (tests point these at temp dirs so the suite
  // never reads the real ./atom.json or ~/.atom/atom.json).
  // Defaults: cwd + ATOM_HOME/home (authHome when given).
  configDirs?: { projectDir?: string; homeDir?: string };
  // Observability timer indirection (Phase 5): fake clock + timers for
  // tests. Defaults to Date.now + global setInterval/clearInterval.
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  // Draft-throttle clock indirection (Task B smoothness): trailing-window
  // timers for coalesced streaming paints. Defaults to global timers.
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

export type SlashCommand = { name: string; description: string };

// Single registry for the "/" autocomplete menu and the exact-command path.
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/model", description: "Open the model picker." },
  { name: "/models", description: "Refresh local model discovery (Ollama, LM Studio, llama.cpp)." },
  { name: "/provider", description: "Pick AI provider, paste API key once, chat." },
  {
    name: "/effort",
    description:
      "Open the reasoning-effort picker (Default/Low/Medium/High/Max; top is Max, sent as max).",
  },
  { name: "/tools", description: "List the tools with one-line descriptions." },
  { name: "/skills", description: "List installed skills (project + global)." },
  { name: "/skill", description: "Invoke a skill by name (/skill:name; /skills lists)." },
  { name: "/mode", description: "Print the current permission mode (Tab cycles normal → yolo → plan)." },
  { name: "/trust", description: "Toggle session trust: auto-approve write/edit/bash without full yolo (/trust again revokes)." },
  { name: "/allow", description: "Pre-approve a tool pattern this session (e.g. /allow bash:npm test*)." },
  { name: "/deny", description: "Forbid a tool pattern this session — deny wins over trust/yolo (e.g. /deny bash:rm *)." },
  { name: "/rules", description: "List session allow/deny rules (/rules clear wipes them)." },
  { name: "/clear", description: "Clear the conversation history (keeps session token totals; drops file checkpoints)." },
  { name: "/new", description: "Start a brand-new session (full fresh conversation + counters reset, previous kept for /resume)." },
  { name: "/compact", description: "Summarize older turns into one summary (optional focus text: /compact focus…)." },
  { name: "/context", description: "Show context usage by source (system, tools, history, skills)." },
  { name: "/queue", description: "List queued follow-ups (/queue clear wipes them)." },
  { name: "/steer", description: "Steer the running turn, or send when idle (/steer <text>)." },
  { name: "/autoscroll", description: "Follow new output as it arrives (/autoscroll on|off; off freezes the view mid-turn)." },
  { name: "/thinking", description: "Show or hide model thinking in the TUI (rendering only; the turn is untouched)." },
  { name: "/resume", description: "Restore the last saved session (turns, history, settings, usage)." },
  { name: "/telemetry", description: "Show the local observability summary (sessions, tokens, tools)." },
  { name: "/dashboard", description: "Write the local observability dashboard page and show its path." },
  { name: "/rewind", description: "Restore files to a session checkpoint (files only; shell side effects are never snapshotted)." },
  { name: "/help", description: "List commands with one-liners." },
  { name: "/exit", description: "Exit Atom." },
  { name: "/quit", description: "Exit Atom." },
];

const SLASH_NAMES = new Set(SLASH_COMMANDS.map((c) => c.name));

// /rewind restore scope (ticket 01): files only, files + conversation, or
// conversation only. Files-only is the default highlight (safest).
export const REWIND_SCOPES = ["files only", "files + conversation", "conversation only"] as const;
export type RewindScope = (typeof REWIND_SCOPES)[number];

// Submit-time pipeline order (ticket 02): submit() below reads as one
// ordered sequence — permissions → context assembly → budget check → loop
// entry — so future submit-time work has exactly one home stage. The
// rollback-scope rule per stage states what a failed turn keeps vs drops.
// This descriptor is the order test's source of truth:
// tests/submit-order.test.ts pins both this order and the matching
// `SUBMIT STAGE n/4` markers inside submit().
export const SUBMIT_PIPELINE_STAGES = [
  {
    name: "permissions",
    rollbackScope: "pre-turn: rejections append nothing, so history is untouched",
  },
  {
    name: "context-assembly",
    rollbackScope: "pre-rollbackTo: the env-block refresh survives a failed turn (it is not part of the user turn)",
  },
  {
    name: "budget-check",
    rollbackScope: "pre-rollbackTo: the budget trim survives a failed turn (rollback indices are captured after it)",
  },
  {
    name: "loop-entry",
    rollbackScope: "post-rollbackTo: the user message, skill context, and loop entries roll back on failure",
  },
] as const;

// Shared usage strings: the exact texts the commands print, hoisted to
// module scope so the slash-menu argument hints reuse them (no second
// implementation).
export const SKILL_USAGE =
  "usage: /skill:<name> — invoke a skill directly (list with /skills, e.g. /skill:code-review)";
export const RULE_USAGE =
  "usage: /allow <tool[:glob]> · /deny <tool[:glob]> · /rules · /rules clear (e.g. /allow bash:npm test*, /deny bash:rm *)";
export const QUEUE_USAGE =
  "usage: /queue (list) · /queue clear (wipe) · /steer <text> (steer the running turn, or send when idle)";
export const STEER_USAGE =
  "usage: /steer <text> — while busy, injects into the running turn at the next step boundary (the current action finishes first); when idle, sends as a normal turn";
export const AUTOSCROLL_USAGE =
  "usage: /autoscroll [on|off] — on (default) follows new output as it arrives; off freezes the view while a turn runs (a `↓ N new` indicator offers the jump back). Bare /autoscroll prints the current state.";
export const THINKING_USAGE =
  "usage: /thinking — toggles model-thinking visibility in the TUI (rendering only: shows or hides the committed thinking blocks; the turn, history, and telemetry are untouched).";

export function filterSlashCommands(prefix: string): SlashCommand[] {
  const q = prefix.startsWith("/") ? prefix.slice(1) : prefix;
  // Exact match wins outright: a fully-typed command collapses the menu
  // to itself, so prefix-siblings (/skill vs /skills, /model vs /models)
  // never read as duplicates and Enter stays deterministic. Partial
  // input keeps the prefix-then-fuzzy tiers below untouched.
  const full = `/${q}`;
  const exact = SLASH_COMMANDS.find((c) => c.name === full);
  if (exact) return [exact];
  const pre: SlashCommand[] = [];
  const fuzzy: { c: SlashCommand; s: number }[] = [];
  for (const c of SLASH_COMMANDS) {
    const name = c.name.slice(1);
    if (name.startsWith(q)) {
      pre.push(c);
      continue;
    }
    const s = fuzzyScore(q, name);
    if (s !== null) fuzzy.push({ c, s });
  }
  // Prefix tier keeps registry order (stable, muscle memory); fuzzy tier
  // ranks by score, ties by name.
  fuzzy.sort((a, b) => a.s - b.s || (a.c.name < b.c.name ? -1 : 1));
  return [...pre, ...fuzzy.map((f) => f.c)];
}

// Command palette model (Ctrl+P): one searchable index over the SAME
// SLASH_COMMANDS registry the menu and runner use — no second command
// implementation. Filtering reuses fuzzyScore (prefix tier stable, fuzzy
// scored, description substring); display types live in ui/palette.

export function paletteEntries(query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  type Scored = { c: SlashCommand; tier: number; score: number; idx: number };
  const out: Scored[] = [];
  SLASH_COMMANDS.forEach((c, idx) => {
    const name = c.name.slice(1).toLowerCase();
    if (!q) {
      out.push({ c, tier: 0, score: 0, idx });
      return;
    }
    if (name.startsWith(q)) {
      out.push({ c, tier: 1, score: 0, idx });
      return;
    }
    const s = fuzzyScore(q, name);
    if (s !== null) {
      out.push({ c, tier: 2, score: s, idx });
      return;
    }
    if (c.description.toLowerCase().includes(q)) out.push({ c, tier: 3, score: 0, idx });
  });
  const catOrder = (n: string) => PALETTE_CATEGORY_ORDER.indexOf(paletteCategory(n));
  out.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.tier === 0
        ? catOrder(a.c.name) - catOrder(b.c.name) || a.idx - b.idx
        : a.score - b.score || a.idx - b.idx)
  );
  return out.map(({ c }) => ({
    name: c.name,
    description: c.description,
    category: paletteCategory(c.name),
    hint: PALETTE_HINTS[c.name] ?? null,
  }));
}

// Busy-gate shared by the slash menu and the palette: /compact sets the
// pending flag for turn-end drain; /queue + /steer manage the running turn;
// /autoscroll and /thinking only flip view flags (never touch the turn).
// Every other command waits idle.
export function slashRunsWhileBusy(name: string): boolean {
  return (
    name === "/compact" ||
    name === "/queue" ||
    name === "/steer" ||
    name === "/autoscroll" ||
    name === "/thinking"
  );
}

// Fuzzy subsequence match with gap/start/word-boundary scoring (lower is
// better; null = no match). Pure — shared by the command filter, the skill
// tier, and the palette, so there is exactly one matcher.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi]!, ti);
    if (found === -1) return null;
    score += last === -1 ? found : found - last - 1;
    if (found === 0 || /[-_/:]/.test(t[found - 1]!)) score -= 2;
    if (found === last + 1) score -= 1;
    last = found;
    ti = found + 1;
  }
  return score;
}

// Slash-menu item: a built-in command, or a skill surfaced as the namespaced
// `/skill:name` command (Claude-Code-style explicit invocation). `skill`
// carries the bare skill name for skill entries; commands leave it unset.
// Skill rows show the name only (no description — the menu stays scannable).
export type MenuItem = { name: string; description: string; skill?: string };

// Max skill rows in the menu: the command list always renders whole, skills
// narrow as you type — the menu can never take over the screen.
export const SLASH_MENU_SKILL_CAP = 8;

export type SkillPickerEntry = { name: string; userInvocable: boolean; source: string };

export type SlashMenu = { items: MenuItem[]; moreSkills: number };

// Pure filter for the /skills picker (unit-tested): case-insensitive
// substring over the skill name (a search popup narrows harder than the
// prefix-only slash menu). Empty query returns everything as-is.
export function filterSkillPicker(entries: SkillPickerEntry[], query: string): SkillPickerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

// Pure menu builder (unit-tested): matching commands first (prefix tier in
// stable order, then fuzzy by score), then matching skills as `/skill:name`
// entries (prefix tier stable, then fuzzy). Skills join only once the query
// is non-trivial (input length ≥ 2 — a bare `/` lists commands only), and
// match by skill-name prefix, full `/skill:name` prefix, or fuzzy on the
// name. Skill rows carry a truncated description for discovery. Pure — the
// App feeds it the cached registry snapshot.
export const SKILL_MENU_DESC_CHARS = 60;

export function buildSlashMenu(
  input: string,
  skills: Array<{ name: string; description: string }>
): SlashMenu {
  const items: MenuItem[] = filterSlashCommands(input).map((c) => ({
    name: c.name,
    description: c.description,
  }));
  if (input.length < 2) return { items, moreSkills: 0 };
  const q = input.slice(1);
  const skillQ = q.startsWith("skill:") ? q.slice("skill:".length) : q;
  const pushSkill = (s: { name: string; description: string }, shown: { n: number }, more: { n: number }) => {
    const entry = `/skill:${s.name}`;
    const desc =
      s.description.length > SKILL_MENU_DESC_CHARS
        ? `${s.description.slice(0, SKILL_MENU_DESC_CHARS)}…`
        : s.description;
    if (shown.n < SLASH_MENU_SKILL_CAP) {
      items.push({ name: entry, description: desc, skill: s.name });
      shown.n += 1;
    } else {
      more.n += 1;
    }
  };
  const shown = { n: 0 };
  const more = { n: 0 };
  const fuzzy: { s: { name: string; description: string }; score: number }[] = [];
  for (const s of skills) {
    const entry = `/skill:${s.name}`;
    if (s.name.startsWith(skillQ) || entry.startsWith(input)) continue;
    const score = fuzzyScore(skillQ, s.name);
    if (score !== null) fuzzy.push({ s, score });
  }
  for (const s of skills) {
    const entry = `/skill:${s.name}`;
    if (!s.name.startsWith(skillQ) && !entry.startsWith(input)) continue;
    pushSkill(s, shown, more);
  }
  fuzzy.sort((a, b) => a.score - b.score || (a.s.name < b.s.name ? -1 : 1));
  for (const f of fuzzy) pushSkill(f.s, shown, more);
  return { items, moreSkills: more.n };
}

// Argument hints for commands that take them, reusing the exact usage
// strings the commands themselves print (no second implementation).
export function commandUsage(name: string): string | null {
  switch (name) {
    case "/allow":
    case "/deny":
    case "/rules":
      return RULE_USAGE;
    case "/queue":
      return QUEUE_USAGE;
    case "/steer":
      return STEER_USAGE;
    case "/skill":
      return SKILL_USAGE;
    case "/compact":
      return "Usage: /compact [focus text] — summarize older turns (works while busy; drains at turn end).";
    default:
      return null;
  }
}

// Phase 5 observability + latency polish (surgical, three items only):
// - TURN_TICK_MS: elapsed-time resolution while busy (1s).
// - TURN_STALL_AFTER_MS: silence threshold for the dim `waiting…` hint (>3s
//   with no token/tool/phase activity, status-bar only, never transcript).
export const TURN_TICK_MS = 1000;
export const TURN_STALL_AFTER_MS = 3000;

// Phase 5 models-list session cache key: provider id (+baseURL for
// openai-compatible, whose list depends on the custom endpoint, and for
// local runtimes, whose list depends on the loopback server probed).
export function modelsCacheKey(providerId: ProviderId, baseURL?: string): string {
  if (providerId === "openai-compatible" || isLocalProviderId(providerId)) {
    return `${providerId}|${baseURL ?? ""}`;
  }
  return providerId;
}

// Pure helpers for the elapsed/stall indicator (injectable now for tests).
export function elapsedSecsSince(startMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startMs) / 1000));
}

export function isStalledSince(lastActivityMs: number, nowMs: number): boolean {
  return nowMs - lastActivityMs > TURN_STALL_AFTER_MS;
}

// Unified /model picker entries (pure, local-only — opening the picker never
// fetches). The active provider's current list (live, cached, fallback, or
// test-injected) comes first; every OTHER provider with a resolved key (env
// wins, else stored) contributes its cached live list when warm, else its
// curated fallback list — so models from keyed providers are visible without
// switching first. openai-compatible joins only with both a key and a stored
// baseURL (a key alone cannot POST anywhere). Local runtimes need no key:
// they join on their discovered (cached) list, and contribute nothing until
// discovery reports models (their fallbacks are empty by design). Kilo needs
// no key either (anonymous free models), so its list is always visible.
// Local entries carry `local: true` so the render can group Local vs Remote;
// free Kilo models carry `free: true` for the "(free)" badge.
export type ModelPickerEntry = { providerId: ProviderId; model: string; local?: boolean; free?: boolean };

export function modelPickerEntries(opts: {
  activeProvider: ProviderId;
  activeModels: string[];
  cached: (providerId: ProviderId, baseURL: string) => string[] | undefined;
  keyFor: (providerId: ProviderId) => string;
  baseURLFor: (providerId: ProviderId) => string;
}): ModelPickerEntry[] {
  const out: ModelPickerEntry[] = [];
  const activeLocal = isLocalProviderId(opts.activeProvider);
  for (const m of opts.activeModels) {
    out.push({
      providerId: opts.activeProvider,
      model: m,
      ...(activeLocal ? { local: true } : {}),
      ...(opts.activeProvider === "kilo" && isFreeKiloModel(m) ? { free: true } : {}),
    } as ModelPickerEntry);
  }
  for (const p of PROVIDERS) {
    if (p.id === opts.activeProvider) continue;
    if (!opts.keyFor(p.id) && providerNeedsKey(p.id)) continue;
    if (p.id === "openai-compatible" && !opts.baseURLFor(p.id)) continue;
    const list = opts.cached(p.id, opts.baseURLFor(p.id)) ?? p.fallbackModels;
    for (const m of list) {
      out.push({
        providerId: p.id,
        model: m,
        ...(isLocalProviderId(p.id) ? { local: true } : {}),
        ...(p.id === "kilo" && isFreeKiloModel(m) ? { free: true } : {}),
      } as ModelPickerEntry);
    }
  }
  return out;
}

// Case-insensitive substring filter over the model id (the provider id is
// included so "openai" narrows to that section; "free" matches free Kilo
// models). Empty query returns the list as-is.
export function filterModelEntries(entries: ModelPickerEntry[], query: string): ModelPickerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.model.toLowerCase().includes(q) ||
      e.providerId.toLowerCase().includes(q) ||
      (e.free === true && "free".includes(q))
  );
}

// Visible window for the picker: at most MODEL_PICKER_VISIBLE rows, scrolled
// so the highlight stays visible (centered while scrolling, pinned at both
// ends). Single implementation in ui/pickers (shared by every windowed
// popup); re-exported here so existing import sites keep working.
export { MODEL_PICKER_VISIBLE, pickerWindow } from "./ui/pickers.js";

// Follow-up queue cap: Enter while busy queues instead of submitting, and
// the turn-end drain auto-sends while non-empty. Bounded so a held-down key
// can never flood the session; /queue manages, /queue clear wipes.
export const QUEUE_CAP = 10;

// Task B smoothness (a): streaming-draft throttle. Token bursts (many
// onToken calls per frame) would otherwise re-render the whole tree per
// token; paints coalesce to at most one per trailing window, with
// flush-on-done so the exact full text always lands. Injectable now/clock
// for tests.
export const DRAFT_THROTTLE_MS = 64;

export type DraftThrottlerOptions = {
  intervalMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onFlush: (text: string) => void;
};

export type DraftThrottler = {
  /** Latest partial wins; paints at most once per trailing window. */
  push: (text: string) => void;
  /** Paint the latest pending text now (no-op when nothing is pending). */
  flush: () => void;
  /** Drop pending text and any scheduled paint (turn end / unmount). */
  cancel: () => void;
  /** cancel() + re-arm so the next push paints immediately (turn start). */
  reset: () => void;
  getPending: () => string | null;
};

export function createDraftThrottler(opts: DraftThrottlerOptions): DraftThrottler {
  const intervalMs = opts.intervalMs ?? DRAFT_THROTTLE_MS;
  const nowFn = opts.now ?? Date.now;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const onFlush = opts.onFlush;
  let pending: string | null = null;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function safeNow(): number {
    try {
      return nowFn();
    } catch {
      return Date.now();
    }
  }

  function clearTimer() {
    if (timer !== null) {
      try {
        clearT(timer);
      } catch {
        // ignore clock errors (a stray trailing paint is harmless)
      }
      timer = null;
    }
  }

  // Immediate paint path (also the never-lose-tokens fallback).
  function emit(text: string, at: number) {
    clearTimer();
    pending = null;
    lastFlush = at;
    onFlush(text);
  }

  return {
    push(text: string) {
      pending = text;
      const t = safeNow();
      if (t - lastFlush >= intervalMs) {
        emit(text, t);
        return;
      }
      if (timer !== null) return; // trailing paint already scheduled
      const wait = intervalMs - (t - lastFlush);
      try {
        timer = setT(() => {
          timer = null;
          const latest = pending;
          if (latest === null) return;
          emit(latest, safeNow());
        }, Math.max(0, wait));
      } catch {
        // No timer available: paint now rather than lose the token.
        emit(text, safeNow());
      }
    },
    flush() {
      if (pending === null) {
        clearTimer();
        return;
      }
      emit(pending, safeNow());
    },
    cancel() {
      clearTimer();
      pending = null;
    },
    reset() {
      clearTimer();
      pending = null;
      lastFlush = Number.NEGATIVE_INFINITY;
    },
    getPending() {
      return pending;
    },
  };
}

function toolsListText(): string {
  const lines = Object.entries(TOOL_ONE_LINERS).map(([n, d]) => `${n} — ${d}`);
  return `Tools (${lines.length}):\n${lines.join("\n")}`;
}

// Live thinking block: reasoning streams in full, exactly as it arrives —
// the output stays as-is no matter how long it runs (no tail window, no
// truncation). The full text is never stored anywhere else — thinking stays
// transient like the answer draft (cleared on every turn boundary, never
// committed to the transcript or model history).

export function helpListText(): string {
  const lines = SLASH_COMMANDS.map((c) => `${c.name} — ${c.description}`);
  return (
    `Commands:\n${lines.join("\n")}` +
    `\nTab is the only mode switcher: normal → yolo → plan → normal (in the / command menu, Tab runs the highlighted command instead). Yolo runs tools without asking; plan is read-only.` +
    `\nPlan mode is the read-only mode for risky work: explore with read/grep/glob/webfetch/websearch/todos/ask_question (all run free) while write/edit/bash are blocked pre-execution with a replan note (never a prompt, never silent — the ⚙ audit line still renders). Scoped /deny rules still win in plan mode; /allow, /trust, yolo, [a]lways, and skill grants cannot punch through it (/trust while in plan stays read-only with a notice — Tab out first). Exiting plan is the human approval: Tab from plan mode returns to normal (never yolo) and the todowrite checklist recorded while planning carries into implementation.` +
    `\n/trust toggles the session trust tier: with trust on, write/edit/bash auto-approve (one approval covers the whole task) without global yolo. Default off, normal mode stays the default; in-memory only, never saved. Every auto-approved call still renders its ⚙ line. The approval prompt also offers [t]rust-all mid-run; [n]/Esc still denies one call, Ctrl+C (or Esc while busy) still cancels the whole turn.` +
    `\n/allow <tool[:glob]> pre-approves matching write/edit/bash calls this session (no prompt; e.g. /allow bash:npm test*, /allow write:src/**; bare /allow bash matches any args). /deny <tool[:glob]> refuses matching calls before execution — the model sees the standard denial result and replans. Deny wins over /trust, yolo, [a]lways, and skill grants. Every auto-approved call still renders its ⚙ line. Rules are in-memory only (like /trust, never saved); /rules lists them, /rules clear wipes them.` +
    `\nToken totals accumulate per session from API-reported usage only: the status line shows \`token: n/a\` until the API reports usage (never estimated, never 0-by-default); with usage it shows \`token: (P%) NK\` — NK is the cumulative session spend in K, P% is the CURRENT context load over the model's verified window (last POST prompt_tokens, else the 4ch/token estimate; models with no verified window show a bare \`token: NK\`, never an invented percent). /clear keeps the totals; /new resets them.` +
    `\n/compact [focus text]: summarize older turns into one \`[Compacted context …]\` summary + keep the newest tail (~8000 estimated tokens, tool outputs capped at 2000 chars). Tiny history (≤1 user turn) reports \`(nothing to compact)\`. Works for unknown-window models (estimate only for the tail split).` +
    `\nAuto-compact: after every completed turn the load is checked; on known-window models with load/window ≥ ${Math.round(COMPACT_PCT_DEFAULT * 100)}% (env ATOM_COMPACT_PCT percent, clamped 50–95, invalid→default) history auto-compacts before the next turn. Unknown-window models never auto-compact — use /compact manually.` +
    `\nThrash guard: 3 auto-compactions without the load dropping below threshold disables auto for the session with \`(auto-compact thrashing — disabled, use /compact or /clear)\`; manual /compact still works and resets the counter on success.` +
    `\n/provider: pick kilo|opencode-zen|openai|anthropic|deepseek|mistral|google-gemini|openai-compatible, paste a key once (stored in ~/.atom/auth.json, env wins). Kilo is the default: its free :free models (e.g. kilo-auto/free) work with no key; a Kilo key unlocks the full catalog. Switching provider keeps session history text; system prompt stays.` +
    `\n/effort options: Default/Low/Medium/High/Max (wire: default/low/medium/high/max; Default omits reasoning_effort).` +
    `\nNote: xhigh was requested but only Max is verified, so the top setting is Max, sent as max.` +
    `\nGating: reasoning_effort is sent ONLY when effort != Default AND the model is one of ${[...REASONING_EFFORT_SUPPORTED_MODELS].join(", ")} AND the provider is opencode-zen; otherwise omitted (setting kept, warning shown, status shows (unsupported)). Effort persists across /model switches.` +
    `\n/resume: restores the last saved session (turns, history, provider/model/effort/mode, usage totals). The conversation never auto-restores — sending a message without /resume starts fresh, and the next completed turn overwrites the save. Your provider/model/effort picks DO persist across restarts automatically (saved on every completed turn and on clean exit; explicit OPENCODE_ZEN_MODEL wins over the saved model). /clear clears the live session only (the save keeps the pre-clear state until the next completed turn overwrites it). /new saves first, then starts a brand-new session (conversation + counters reset, settings kept) — so /resume right after /new restores the pre-/new conversation. Split: /clear = wipe transcript, keep counters; /new = full fresh conversation + counters reset, previous kept for /resume.` +
    `\nSession autosave: every completed turn (and clean exit, plus after each successful compaction) writes ~/.atom/session.json (0600 POSIX, may contain pasted secrets — never commit it); failed/cancelled turns never touch it; a corrupt save loads as "(saved session unreadable — starting fresh)".` +
    `\nBusy status shows the live phase plus elapsed seconds in the status line (· thinking… 4s); >3s without token/tool/phase activity adds a dim waiting… hint (status-bar only, never saved). ` +
    `Reasoning streams in its own dim block above the answer draft while busy (transient — never committed); Esc stops a running response (same rollback as Ctrl+C).` +
    `\n/rewind: every write/edit auto-snapshots prior bytes (silent, no prompt, no config); /rewind lists the session checkpoints and restores exact bytes (hash-verified, never a model rewrite) — files only, files + conversation, or conversation only. Shell side effects (bash) are explicitly out of scope: commands are never snapshotted and cannot be undone.` +
    `\nQueue + steer (follow-ups without losing flow): Enter while busy queues the message (visible Queued line, auto-sent when the turn ends cleanly — never after a cancel); /queue lists, /queue clear wipes (cap ${QUEUE_CAP}, in-memory only). /steer <text> injects into the RUNNING turn at the next step boundary (the current action finishes first — nothing is aborted); when idle it just sends. A steer stranded by a failed/cancelled turn rejoins the queue front instead of vanishing.` +
    `\nInput: Ctrl+J inserts a newline (Enter always sends, even multiline); ↑/↓ recalls past prompts across lines (in-memory only, never saved); paste lands verbatim via bracketed paste and never submits; Ctrl+A/E line ends, Ctrl+K/U/W kills; Ctrl+P opens the searchable command palette.` +
    `\nCtrl+O opens the tool-output inspector (browse past tool calls with full output, durations, and error detail: ↑/↓ selects, Enter expands/collapses, PgUp/PgDn scrolls, Esc closes). Read-only — safe in plan mode.` +
    `\nObservability (local-only, on by default): every turn is traced — iterations, model calls (API-reported tokens only), tool calls (measured durations, ok/fail per tool), retries, and outcomes — into ~/.atom/telemetry/sessions/ (one small JSON file per session, 0600 POSIX, truncated + secret-scrubbed previews, never full prompts/results). /telemetry prints the summary; /dashboard writes the drill-down page (session → turn → iteration → model/tool call → result, with aggregates, charts, filters, timelines) to ~/.atom/telemetry/dashboard.html — open it in a browser, nothing is uploaded. Off via ATOM_TELEMETRY=0 or "telemetry": {"enabled": false} in atom.json. n/a means not reported (never estimated); cost is always n/a until a provider reports it; tool durations span dispatch→result (including any approval-prompt wait in normal mode).`
  );
}

// Session token totals, accumulated ONLY from usage payloads the API
// actually reported. Null until the first usage payload arrives (rendered
// as `token: n/a` — never 0, which would imply measurement). The segment
// itself lives in ./context-windows.js (single source for the exact
// `token: (P%) NK` format); StatusBar (./ui/status-bar.js) is its only
// surface. P% tracks CURRENT context load (last prompt_tokens, else
// 4ch/token estimate); NK tracks cumulative session spend.

function formatKEst(chars: number): string {
  return `~${(estimateTokensForChars(chars) / 1000).toFixed(1)}K`;
}

export type PendingApproval = {
  name: string;
  args: Record<string, unknown>;
  // Unified-diff preview for the modal (write/edit only, null/absent =
  // description-only). Computed once in approve() — never in render —
  // so the 1s busy tick can't re-hit the disk.
  diff?: ApprovalDiff | null;
};

export type PendingQuestion = {
  question: string;
  options: string[];
  allowCustom: boolean;
};

// Error screen for a missing key (never print the key itself).
export function MissingKey() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text color={theme.color.error} bold>
        Missing OPENCODE_ZEN_API_KEY.
      </Text>
      <Text>Copy .env.example -&gt; set your key from https://opencode.ai/auth</Text>
      <Text>Or run the TUI and use /provider to paste a key (stored in ~/.atom/auth.json).</Text>
      <Text dimColor>Then run `npm start` again.</Text>
    </Box>
  );
}

export type ProviderKeyPrompt = {
  providerId: ProviderId;
  draft: string;
  error: string | null;
  existingMasked: string | null;
  consoleURL: string;
  validating: boolean;
};

export type ProviderBaseURLPrompt = {
  providerId: ProviderId;
  draft: string;
  error: string | null;
};

// Measured once: TOOL_DEFINITIONS never changes at runtime, so the schema
// size is a constant (avoids re-serializing ~15KB on every manager build).
const TOOLS_SCHEMA_CHARS = JSON.stringify(TOOL_DEFINITIONS).length;

export function App({ apiKey, endpoint, initialModel, initialModels, initialProvider, restorePrefs, authHome, skillDirs, configDirs, now, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn, localDiscovery }: AppProps) {
  const { exit } = useApp();
  // Measured terminal width for the status bar's fit-or-drop branch logic.
  // Unknown (piped output) falls back to the bar's own default.
  let termColumns: number | undefined;
  try {
    termColumns = useStdout()?.stdout?.columns;
  } catch {
    termColumns = undefined;
  }
  // Saved preferences (provider/model/effort + resolved key/endpoint), loaded
  // once when restorePrefs is on (prod). Explicit props always win; without
  // prefs the CLI defaults apply. Null in tests (flag off) and on any
  // missing/corrupt/unusable save — startup then behaves exactly as before.
  const [prefs] = useState(() => (restorePrefs ? loadPrefs(authHome, endpoint) : null));
  // atom.json (project + global, per-key merge): first-run defaults sitting
  // between saved prefs and compiled defaults —
  // env/props > save > project > global > default.
  const [atomConfigLoad] = useState(() =>
    loadAtomConfig(configDirs?.projectDir, configDirs?.homeDir ?? authHome)
  );
  const atomConfig = atomConfigLoad.config;
  const resolvedInitialProvider =
    initialProvider && isProviderId(initialProvider)
      ? initialProvider
      : (prefs?.provider ?? atomConfig.provider ?? DEFAULT_PROVIDER);
  // Fresh-install bootstrap: Kilo (the default) starts on its free routing
  // model until discovery + the user's pick say otherwise — no paid
  // credentials required. Other providers keep the compiled default.
  const resolvedInitialModel =
    initialModel ??
    prefs?.model ??
    atomConfig.model ??
    (resolvedInitialProvider === "kilo"
      ? (getProvider("kilo")?.defaultModel ?? DEFAULT_MODEL)
      : DEFAULT_MODEL);
  const [model, setModel] = useState(resolvedInitialModel);
  const modelRef = useRef(resolvedInitialModel);
  const [models, setModels] = useState<string[]>(
    initialModels ?? [...FALLBACK_MODELS]
  );
  // Active provider (explicit prop wins, then saved prefs, then zen default).
  const [provider, setProvider] = useState<ProviderId>(resolvedInitialProvider);
  const providerRef = useRef<ProviderId>(resolvedInitialProvider);
  // Auth store (env wins at resolve time; file holds pasted keys).
  const [auth, setAuth] = useState<AuthFile>(() => loadAuth(authHome));
  const authRef = useRef<AuthFile>(auth);
  // Resolved keys/endpoints per active provider. apiKey/endpoint props seed
  // the zen defaults (tests pass test-key; prod passes env-resolved values);
  // with restorePrefs the saved key/endpoint seed a restored provider instead.
  const [activeApiKey, setActiveApiKey] = useState(prefs?.apiKey ?? apiKey);
  const activeApiKeyRef = useRef(prefs?.apiKey ?? apiKey);
  // Owner of the seeded/active key: the apiKey/endpoint props seed the zen
  // defaults (tests pass test-key; prod passes env-resolved values), while
  // restorePrefs seeds the saved provider's key instead. The fallback below
  // must never hand one provider's seed to another (e.g. the zen seed to an
  // anonymous Kilo session) — it applies only to its owner.
  const activeKeyProviderRef = useRef<ProviderId>(prefs?.provider ?? "opencode-zen");
  const [activeEndpoint, setActiveEndpoint] = useState(prefs?.endpoint ?? endpoint);
  // Permission mode (normal default, Tab cycles normal → yolo → plan). The footer
  // status line always shows it (plus +trust when the session trust tier is
  // on); modeRef mirrors it for async loop callbacks.
  const [mode, setMode] = useState<PermissionMode>("normal");
  const modeRef = useRef<PermissionMode>("normal");
  // Tools the user approved with "always" this session (never re-prompt).
  const alwaysAllowedRef = useRef<Set<string>>(new Set());
  // Turn-scoped skill grants (ticket 06): tools pre-approved by an invoked
  // skill's `allowed-tools` for exactly one turn — the turn the skill was
  // armed for (manual arming happens while idle, auto arming at submit).
  // Cleared in the turn-end finally (any outcome) and on /clear + /new,
  // mirroring Claude's grant-clears-on-next-message rule. In-memory only,
  // never persisted.
  const skillGrantsRef = useRef<Set<string>>(new Set());
  // Session trust tier (Task 4): per-session opt-in that auto-approves every
  // approval tool (write/edit/bash) at once, without global yolo. Set via
  // /trust or the [t] key in the approval prompt; revoked via /trust again.
  // A separate flag (not folded into alwaysAllowedRef) so revoking restores
  // per-tool prompting without disturbing individual [a] grants. In-memory
  // only, like alwaysAllowedRef — never persisted, default off.
  const [trustAll, setTrustAll] = useState(false);
  const trustAllRef = useRef(false);
  // Scoped allow/deny rules (ticket 03): user-added `tool[:glob]` patterns
  // consulted in approve() before prompting — allow runs without asking, deny
  // refuses (deny wins over yolo/trust/always/skill grants). Session-scoped,
  // in-memory only like trustAllRef — never persisted, default empty (no
  // rules → today's prompt flow byte-identical). Survives /clear + /new like
  // other session settings; turn-scoped skill grants stay separate.
  const rulesRef = useRef<PermissionRule[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  // Live snapshot of the session checklist for <TodoPanel>: refreshed from
  // getTodos() after every todowrite/todo_update call (see onToolActivity).
  // /new resets it alongside the transcript (fresh conversation); /clear
  // keeps it (same session continues).
  const [todoSnap, setTodoSnap] = useState<TodoItem[]>([]);
  // Synchronous mirror of `turns`: submit callbacks queue many functional
  // updates, but the session save needs the committed value synchronously,
  // so every append/replace goes through appendTurns/setTurnsBoth below.
  const turnsRef = useRef<Turn[]>([]);
  const [input, setInput] = useState("");
  // Mirror of `input` updated synchronously: keypresses arriving in the same
  // tick share one render closure, so the ref (not state) is the source of
  // truth when Enter is handled.
  const inputRef = useRef("");
  // Task B (1): cursor offset (chars from start, 0..length) with the same
  // synchronous ref mirror (cursor edits must compose within one tick).
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  // Submitted-prompt history (↑/↓ recall): in-memory only, never persisted
  // (prompts may carry pasted secrets). histIndex null = editing fresh;
  // otherwise an index into inputHist. histStash preserves the unsent draft
  // while browsing (Down past newest restores it).
  const inputHistRef = useRef<string[]>([]);
  const histIndexRef = useRef<number | null>(null);
  const histStashRef = useRef("");
  function pushInputHistory(text: string) {
    inputHistRef.current = pushInputHistoryList(inputHistRef.current, text);
    histIndexRef.current = null;
    histStashRef.current = "";
  }
  function browseHistoryInput(dir: -1 | 1) {
    const hist = inputHistRef.current;
    if (hist.length === 0) return;
    const cur = histIndexRef.current;
    if (cur === null) {
      if (dir === 1) return; // already at the newest (fresh draft)
      histStashRef.current = inputRef.current;
      const idx = historyOlderIndex(hist, null) ?? hist.length - 1;
      histIndexRef.current = idx;
      setInputBoth(hist[idx]!);
      return;
    }
    const next = dir === -1 ? historyOlderIndex(hist, cur) : historyNewerIndex(hist, cur);
    if (next === null) {
      histIndexRef.current = null;
      const stash = histStashRef.current;
      histStashRef.current = "";
      setInputBoth(stash);
      return;
    }
    histIndexRef.current = next;
    setInputBoth(hist[next]!);
  }
  // ↑/↓ in plain input: move between lines when multiline, else browse
  // submitted-prompt history (recall at the first/last line edge).
  function moveOrRecall(dir: -1 | 1) {
    const t = inputRef.current;
    if (t.includes("\n")) {
      const r = moveVertically(t, cursorRef.current, dir);
      if (!r.edge) {
        setCursorBoth(r.offset);
        return;
      }
    }
    browseHistoryInput(dir);
  }
  const [selecting, setSelecting] = useState(false);
  const [selIndex, setSelIndex] = useState(0);
  // Same synchronous mirror for the dropdown highlight.
  const selIndexRef = useRef(0);
  // /model picker type-to-filter (unified cross-provider list): the query
  // narrows entries live; highlight resets to the top on every keystroke.
  // Cleared on open and on close (Esc/Enter) so every open starts unfiltered.
  const [modelFilter, setModelFilter] = useState("");
  const modelFilterRef = useRef("");
  function setModelFilterBoth(next: string) {
    modelFilterRef.current = next;
    setModelFilter(next);
  }
  // /skills picker (opencode-style searchable popup): type-to-filter over the
  // resolved registry, ↑/↓ + Enter to load, Esc cancels, windowed like the
  // model picker so any library size stays navigable. Snapshot state (the
  // registry always renders — names only, never descriptions).
  const [selectingSkills, setSelectingSkills] = useState(false);
  const [skillPickerItems, setSkillPickerItems] = useState<
    Array<{ name: string; userInvocable: boolean; source: string }>
  >([]);
  const [skillIndex, setSkillIndex] = useState(0);
  const skillIndexRef = useRef(0);
  const [skillFilter, setSkillFilter] = useState("");
  const skillFilterRef = useRef("");
  function setSkillIndexBoth(next: number) {
    skillIndexRef.current = next;
    setSkillIndex(next);
  }
  function setSkillFilterBoth(next: string) {
    skillFilterRef.current = next;
    setSkillFilter(next);
  }
  // Reasoning-effort picker (/effort): same pattern as the /model picker
  // (↑/↓ + Enter, Esc cancels). Saved effort restores with restorePrefs,
  // else the atom.json default, else Default.
  const [selectingEffort, setSelectingEffort] = useState(false);
  const [effortIndex, setEffortIndex] = useState(0);
  const effortIndexRef = useRef(0);
  const [effort, setEffort] = useState<ReasoningEffort>(
    prefs?.effort ?? atomConfig.reasoningEffort ?? "default"
  );
  const effortRef = useRef<ReasoningEffort>(
    prefs?.effort ?? atomConfig.reasoningEffort ?? "default"
  );
  // /provider picker + key/baseURL prompts (same keyboard pattern).
  const [selectingProvider, setSelectingProvider] = useState(false);
  const [providerIndex, setProviderIndex] = useState(0);
  const providerIndexRef = useRef(0);
  const [keyPrompt, setKeyPrompt] = useState<ProviderKeyPrompt | null>(null);
  const keyPromptRef = useRef<ProviderKeyPrompt | null>(null);
  const [baseURLPrompt, setBaseURLPrompt] = useState<ProviderBaseURLPrompt | null>(null);
  const baseURLPromptRef = useRef<ProviderBaseURLPrompt | null>(null);
  // /rewind pickers (ticket 01): checkpoint list, then restore scope. Same
  // keyboard pattern as the /model picker (↑/↓ + Enter, Esc cancels).
  // pendingRewindRef holds the picked checkpoint id between the two steps.
  const [selectingRewind, setSelectingRewind] = useState(false);
  const [rewindIndex, setRewindIndex] = useState(0);
  const rewindIndexRef = useRef(0);
  const [selectingRewindScope, setSelectingRewindScope] = useState(false);
  const [rewindScopeIndex, setRewindScopeIndex] = useState(0);
  const rewindScopeIndexRef = useRef(0);
  const pendingRewindRef = useRef<string | null>(null);
  // Generation bumped on /clear to remount the turns <Static> (Ink resets
  // its static buffer when the Static identity changes, so old turns leave
  // the test frame while staying in real-terminal scrollback).
  const [clearGen, setClearGen] = useState(0);
  // "/" slash menu: highlight mirror + dismissed flag (Esc hides the menu
  // back to plain input until the next keystroke).
  const [slashIndex, setSlashIndex] = useState(0);
  const slashIndexRef = useRef(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashDismissedRef = useRef(false);
  // Follow-up queue (Claude-Code-style): Enter while busy appends instead of
  // submitting; the turn-end drain auto-sends while non-empty and the turn
  // wasn't cancelled. In-memory only, never persisted (like rules). Rendered
  // as one dim line above the input so a queued thought is never lost.
  const [queue, setQueue] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  function setQueueBoth(next: string[]) {
    queueRef.current = next;
    setQueue(next);
  }
  // Steer (inject into the ACTIVE turn, Claude-Code-style): /steer text while
  // busy sits here until the loop's next step boundary drains it into history
  // + transcript (see drainSteer below). Null when idle or nothing pending;
  // rendered as one dim line while set.
  const [steerPending, setSteerPending] = useState<string | null>(null);
  const steerRef = useRef<string | null>(null);
  function setSteerPendingBoth(next: string | null) {
    steerRef.current = next;
    setSteerPending(next);
  }
  // Cancellation latch for the queue drain: a cancelled turn keeps its queue
  // visible but never auto-sends (the user decides what runs next). Reset at
  // every submit, set in the cancel path.
  const turnCancelledRef = useRef(false);
  // Tool-output inspector (display-only): retained results for the browse +
  // expand panel (Ctrl+O). Records are appended in onToolActivity from the
  // existing payloads — execution, ordering, and turn content are untouched.
  const toolLogRef = useRef<ToolRecord[]>([]);
  const toolSeqRef = useRef(0);
  const [inspecting, setInspecting] = useState(false);
  const inspectingRef = useRef(false);
  function setInspectingBoth(next: boolean) {
    inspectingRef.current = next;
    setInspecting(next);
  }
  const [inspectIndex, setInspectIndex] = useState(0);
  const inspectIndexRef = useRef(0);
  function setInspectIndexBoth(next: number) {
    inspectIndexRef.current = next;
    setInspectIndex(next);
  }
  const [inspectExpanded, setInspectExpanded] = useState(false);
  const inspectExpandedRef = useRef(false);
  function setInspectExpandedBoth(next: boolean) {
    inspectExpandedRef.current = next;
    setInspectExpanded(next);
  }
  const [inspectScroll, setInspectScroll] = useState(0);
  const inspectScrollRef = useRef(0);
  function setInspectScrollBoth(next: number) {
    inspectScrollRef.current = next;
    setInspectScroll(next);
  }
  function openInspector(): void {
    if (toolLogRef.current.length === 0) {
      pushInfo("(no tool calls yet — run something first, then Ctrl+O to inspect)");
      return;
    }
    setInspectIndexBoth(0);
    setInspectExpandedBoth(false);
    setInspectScrollBoth(0);
    setInspectingBoth(true);
  }
  function closeInspector(): void {
    setInspectingBoth(false);
  }
  // Command palette (Ctrl+P): unified searchable commands. Own filter +
  // highlight (the main input stays untouched behind it); Enter runs
  // through runSlashCommand with the shared busy-gate.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenRef = useRef(false);
  function setPaletteOpenBoth(next: boolean) {
    paletteOpenRef.current = next;
    setPaletteOpen(next);
  }
  const [paletteFilter, setPaletteFilter] = useState("");
  const paletteFilterRef = useRef("");
  function setPaletteFilterBoth(next: string) {
    paletteFilterRef.current = next;
    setPaletteFilter(next);
  }
  const [paletteIndex, setPaletteIndex] = useState(0);
  const paletteIndexRef = useRef(0);
  function setPaletteIndexBoth(next: number) {
    paletteIndexRef.current = next;
    setPaletteIndex(next);
  }
  function openPalette(): void {
    setPaletteFilterBoth("");
    setPaletteIndexBoth(0);
    setPaletteOpenBoth(true);
  }
  function closePalette(): void {
    setPaletteOpenBoth(false);
  }
  // Transcript scrollback viewport (null = follow the bottom; a number =
  // viewed end index = held/manual mode). New turns extend a following view
  // automatically and accumulate below a held one (the `↓ N new` indicator
  // offers the jump back). Held also freezes the live tail's growing
  // draft/thinking blocks to one static line (see LiveTail `held`), so a
  // streaming turn stops yanking the terminal while the user reads back.
  // List replacement (/clear, /resume, /new) and rewind-truncate re-follow
  // explicitly. The inspector never touches this (position preserved while
  // inspecting).
  const [scrollEnd, setScrollEnd] = useState<number | null>(null);
  const scrollEndRef = useRef<number | null>(null);
  function setScrollEndBoth(next: number | null) {
    scrollEndRef.current = next;
    setScrollEnd(next);
  }
  // Thinking visibility (the /thinking toggle, rendering-only, default
  // hidden): committed thinking turns + the live thinking block show only
  // while on. Never touches the turn, history, or telemetry — purely paint.
  const [showThinking, setShowThinking] = useState(false);
  const showThinkingRef = useRef(false);
  function setShowThinkingBoth(next: boolean) {
    showThinkingRef.current = next;
    setShowThinking(next);
  }
  // /autoscroll (session-only, default on). On = today's behavior: a
  // following view extends with every appended turn. Off = appends during a
  // busy turn freeze a following view at its current end instead of yanking
  // it (the `↓ N new` indicator offers the jump back; End resumes). Idle
  // appends always follow — freezing only matters while output streams.
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);
  function setAutoScrollBoth(next: boolean) {
    autoScrollRef.current = next;
    setAutoScroll(next);
  }
  // Skill registry (cached metadata): one instance per App, scoped to the
  // same dirs the suite injects via skillDirs. Every discovery path below
  // reads through it — refresh() revalidates by stat (mtime+size) and only
  // re-reads added/modified entries, so per-message cost drops from ~1MB of
  // SKILL.md reads to a directory listing plus stats. Bodies stay lazy
  // (activateSkill → loadSkillBody, on demand only).
  const [skillRegistry] = useState(() =>
    createSkillRegistry({ projectDir: skillDirs?.projectDir, homeDir: skillDirs?.homeDir })
  );
  // Skill entries for the slash menu (namespaced `/skill:name` commands):
  // a snapshot of user-invocable skills (name + description), refreshed on
  // mount, /skills, /clear, and /new — never per keystroke (disk I/O stays
  // out of the typing path). Empty until the first refresh lands.
  const [skillMenu, setSkillMenu] = useState<Array<{ name: string; description: string }>>([]);
  async function refreshSkillMenu(): Promise<void> {
    try {
      const found = await skillRegistry.refresh();
      const { skills } = resolveSkills(found.skills);
      setSkillMenu(
        skills
          .filter((s) => s.userInvocable)
          .map((s) => ({ name: s.name, description: s.description }))
      );
    } catch {
      // menu keeps its previous snapshot (a hiccup must never break input)
    }
  }
  // Pending transcript diff (display-only): the approve-time write/edit
  // preview plus full-file BEFORE/AFTER capture, held for the matching
  // onToolActivity commit. Single slot is exact — the scheduler never
  // parallel-batches writes (writes conflict globally; parallel members
  // never prompt), and every execution commits exactly one activity entry
  // in call order. Lifetime ⊆ one turn: set in approve(),
  // consumed-or-cleared by the matching activity, and cleared on
  // deny/cancel/turn boundaries so a stale preview can never attach to
  // a later call.
  // - write: BEFORE reuses the preview's pre-read; AFTER is the new
  //   content arg (exactly what the tool writes) — zero extra reads.
  // - edit: BEFORE is a best-effort full-file read here (pre-execution);
  //   AFTER is read at commit time. Two reads, each once, never in render.
  const pendingDiffRef = useRef<{
    name: string;
    path: string | null;
    beforeFull: string | null;
    afterArg: string | null;
    diff: ApprovalDiff | null;
  } | null>(null);
  // Best-effort full-file read for diff capture: null on missing dir,
  // oversize, or any I/O failure. Never throws — capture degrades to the
  // arg-block preview pair instead of breaking approval.
  function readFileForDiff(absPath: string): string | null {
    try {
      const st = fs.statSync(absPath);
      if (!st.isFile() || st.size > APPROVAL_PREVIEW_MAX_BYTES) return null;
      return fs.readFileSync(absPath, "utf8");
    } catch {
      return null;
    }
  }
  // Tool approval prompt (normal mode, write/edit/bash): the loop waits on
  // the resolver until the user presses y/a/n. Ctrl+C aborts the whole turn
  // (LoopCancelledError) instead of denying one call.
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const approvalResolveRef = useRef<{
    resolve: (d: ApprovalDecision) => void;
    reject: (err: Error) => void;
  } | null>(null);
  // Approval highlight (0..3 = once/always/trust-all/deny): arrows + Enter
  // select, y/a/t/n shortcut (unchanged). Display-only; reset on every open.
  const [approveIndex, setApproveIndex] = useState(0);
  const approveIndexRef = useRef(0);
  function setApproveIndexBoth(next: number) {
    approveIndexRef.current = next;
    setApproveIndex(next);
  }
  // ask_question modal: the loop waits until the user picks, types a custom
  // answer (allowCustom), cancels with Esc (question-cancel result), or
  // cancels the whole turn with Ctrl+C (LoopCancelledError).
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const askResolveRef = useRef<{
    resolve: (answer: string) => void;
    reject: (err: Error) => void;
  } | null>(null);
  const [askSelIndex, setAskSelIndex] = useState(0);
  const askSelIndexRef = useRef(0);
  const [askCustom, setAskCustom] = useState("");
  const askCustomRef = useRef("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Per-turn cancellation (Ctrl+C mid-loop): abort stops after the current
  // tool finishes — no new POSTs, no new executions — then the turn rolls
  // back and a dim `(cancelled)` line renders.
  const turnCancelRef = useRef<AbortController | null>(null);
  // Display-only tool clock (TUI timing, never execution logic): wall-ms
  // when the current tool call started, via the injectable `now` clock.
  // Consumed by onToolActivity into Turn.ms and by the live running line;
  // parallel batches share it (last start wins — approximate, display-only).
  const toolStartRef = useRef<number | null>(null);
  // Latest streamed answer text (display bookkeeping only): if the turn
  // FAILS after streaming (rate limits, dead network), the catch path
  // commits this as a marked partial turn so the output never vanishes.
  // History still rolls back (the model never sees it); the transcript
  // keeps what the user already read. Cleared at every turn start.
  const lastPartialRef = useRef("");
  const [error, setError] = useState<string | null>(null);
  // Local observability recorder (src/telemetry.ts): one telemetry session
  // per App mount. Best-effort and never throwing; off via ATOM_TELEMETRY=0
  // or atom.json telemetry.enabled=false. The loop reports into it through a
  // per-turn sink (see submit); one small file per session lands under
  // ~/.atom/telemetry/sessions/ on turn boundaries.
  const [telemetry] = useState<TelemetryRecorder>(() =>
    createTelemetryRecorder({
      home: authHome,
      enabled: resolveTelemetryEnabled(process.env, atomConfig.telemetry?.enabled),
      provider: resolvedInitialProvider,
      model: resolvedInitialModel,
      secrets: providerSecrets,
    })
  );
  // Session token totals from real API usage payloads only (null = none
  // reported yet -> `token: n/a`). Survives /clear by design (see /help).
  const [usageTotals, setUsageTotals] = useState<Usage | null>(null);
  // Synchronous mirror of `usageTotals` (same save-time reason as turnsRef).
  const usageRef = useRef<Usage | null>(null);
  // Current context load driving status P% (last POST prompt_tokens when
  // available, else the 4ch/token estimate). Null until the first turn
  // completes. NK stays cumulative; P must NOT use the cumulative total.
  const [contextLoad, setContextLoad] = useState<number | null>(null);
  const contextLoadRef = useRef<number | null>(null);
  // Git identity for the status bar (branch only, no status porcelain):
  // refreshed at turn boundaries (a turn's bash may switch branches), read
  // from render. Null outside git repos — the bar then shows cwd alone.
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  function refreshGitInfo() {
    try {
      setGitInfo(getGitInfo(process.cwd()));
    } catch {
      setGitInfo(null);
    }
  }
  // Last POST's reported prompt_tokens (load metric source). Summary-request
  // usage never touches this — only main-loop POSTs do.
  const lastPromptTokensRef = useRef<number | undefined>(undefined);
  // Thrash guard: consecutive auto-compactions without the load dropping
  // below threshold. At 3, auto disables for the session (manual still
  // works and resets the counter on success).
  const autoStreakRef = useRef(0);
  const [autoDisabled, setAutoDisabled] = useState(false);
  const autoDisabledRef = useRef(false);
  // /compact typed while busy: focus text ("" = no focus) runs at turn end,
  // never mid-turn. Null = none pending.
  const pendingCompactRef = useRef<string | null>(null);
  // Startup hint: a save file exists from a previous session. Rendered once
  // as a dim line while the transcript is empty; the conversation itself
  // never auto-restores (only provider/model/effort do, via restorePrefs).
  const [sessionHint] = useState(() => sessionExists(authHome));
  // Reasoning label from response metadata (via onReasoning). The status
  // line shows the session effort when non-Default (plus " (unsupported)"
  // when the model is outside the verified-support set); when effort is
  // Default it shows this label, falling back to `default`.
  const [reasoning, setReasoning] = useState<string | null>(null);
  // Live streaming state: `draft` is the growing assistant text (onToken),
  // `phase`/`phaseDetail` track the observe→act→inspect→adjust loop
  // (thinking|streaming|tool|retry|done), and `toolHint` shows a streamed
  // tool name before its execution line lands.
  const [draft, setDraft] = useState<string | null>(null);
  // Thinking channel (onThinking): reasoning text streamed apart from the
  // answer, rendered in its own dim block below. The live value is transient
  // like `draft` — cleared on every turn boundary below — but each completed
  // round commits to the transcript via commitThinking (stays in the TUI,
  // never the model history) instead of being replaced and lost.
  const [thinking, setThinking] = useState<string | null>(null);
  const thinkingRef = useRef<string | null>(null);
  // Move the accumulated round thinking into the transcript as a quiet
  // annotation turn (no-op when empty). Called when a new POST starts and at
  // turn end, so every round's reasoning stays visible; the /thinking toggle
  // only controls rendering, never this record.
  function commitThinking(): void {
    const text = thinkingRef.current;
    thinkingRef.current = null;
    setThinking(null);
    if (typeof text === "string" && text.length > 0) {
      appendTurns({ role: "assistant", content: text, thinking: true });
    }
  }
  function clearThinking(): void {
    thinkingRef.current = null;
    setThinking(null);
  }
  const [phase, setPhase] = useState<Phase | "idle">("idle");
  const [phaseDetail, setPhaseDetail] = useState("");
  const [toolHint, setToolHint] = useState<string | null>(null);
  // Task B smoothness (a): throttled streaming draft. onToken pushes every
  // partial (activity/stall tracking stays per-token); paints coalesce to one
  // per DRAFT_THROTTLE_MS trailing window, flushed on done/turn-end.
  const draftThrottleRef = useRef<DraftThrottler | null>(null);
  function draftThrottler(): DraftThrottler {
    let th = draftThrottleRef.current;
    if (!th) {
      th = createDraftThrottler({
        now,
        setTimeoutFn,
        clearTimeoutFn,
        onFlush: (text) => {
          setDraft(text);
        },
      });
      draftThrottleRef.current = th;
    }
    return th;
  }
  function flushDraft() {
    try {
      draftThrottler().flush();
    } catch {
      // ignore (draft stays as-is; the commit carries the full text)
    }
  }
  // Phase 5: models-list session cache (successful live lists only, keyed
  // by modelsCacheKey). Failures fall back uncached, exactly as before.
  const modelsCacheRef = useRef<Map<string, string[]>>(new Map());
  // Local model discovery (Ollama / LM Studio / llama.cpp): one instance
  // per App (injectable for tests), probed in the background on mount.
  // Results land in the session models cache above, so the /model picker
  // serves them through the standard entries path — no parallel registry.
  const localDiscoveryRef = useRef<LocalDiscovery>(localDiscovery ?? createLocalDiscovery());
  const [localSnap, setLocalSnap] = useState<LocalSnapshot>(() => localDiscoveryRef.current.snapshot());
  const localSnapRef = useRef<LocalSnapshot>(localSnap);
  function setLocalSnapBoth(next: LocalSnapshot) {
    localSnapRef.current = next;
    setLocalSnap(next);
  }
  // Fold a discovery snapshot into the models cache: reachable providers
  // contribute their model ids (keyed with their loopback baseURL);
  // unreachable providers are evicted so stale entries vanish on refresh.
  function applyLocalSnapshot(snap: LocalSnapshot): void {
    for (const id of ["ollama", "lmstudio", "llamacpp"] as const) {
      const r = snap.results[id];
      const key = modelsCacheKey(id, r.baseURL);
      if (r.ok) {
        modelsCacheRef.current.set(key, r.models.map((m) => m.id));
      } else {
        modelsCacheRef.current.delete(key);
      }
    }
    setLocalSnapBoth(snap);
  }
  // Non-blocking refresh kick: shared in-flight promise dedupes overlapping
  // calls (mount + picker-open + /models), so servers are never probed twice.
  function kickLocalDiscovery(): void {
    if (initialModels) return;
    // Suites stay hermetic regardless of loopback servers on the dev
    // machine: under Vitest only an explicitly injected fake may probe.
    if (!localDiscovery && process.env.VITEST) return;
    void localDiscoveryRef.current.refresh().then(
      (snap) => {
        applyLocalSnapshot(snap);
      },
      () => {
        // Discovery never rejects (per-provider isolation), but a defensive
        // catch keeps an unexpected throw from surfacing unhandled.
      }
    );
  }
  // Clear error when the active local server is known-unreachable: the
  // server disappeared after discovery (or was never reachable). Returns
  // the notice, or null when local routing is fine.
  function localUnreachableNotice(id: ProviderId): string | null {
    if (!isLocalProviderId(id)) return null;
    const r = localSnapRef.current.results[id];
    if (r.ok) return null;
    const name = getProvider(id)?.name ?? id;
    return `${name} is unreachable at ${r.baseURL} — start the server, then run /models refresh.`;
  }
  // Loopback baseURL for chat/submit paths (env override wins, else the
  // probed snapshot base, else the compiled default).
  function localBaseURL(id: LocalProviderId): string {
    const snapBase = localSnapRef.current.results[id]?.baseURL;
    return localBaseURLFor(id, snapBase);
  }
  function chatBaseURL(id: ProviderId): string {
    return isLocalProviderId(id)
      ? localBaseURL(id)
      : getStoredBaseURL(authRef.current, id);
  }
  // Phase 5: elapsed + stall indicator (status-bar only, never transcript).
  // `elapsedSecs` ticks at 1s resolution while busy; `stalled` turns true
  // when no token/tool/phase activity arrives for >3s mid-turn and clears
  // on the next activity.
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [stalled, setStalled] = useState(false);
  const turnStartRef = useRef(0);
  const lastActivityRef = useRef(0);
  const turnTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Startup snapshot of the system prompt (default + repo AGENTS.md),
  // computed once — never re-read on re-render.
  const [systemPrompt] = useState(buildSystemPrompt);
  // Full API history (includes the system prompt); `turns` is the display
  // subset. Failed user turns are popped (rollback) — but only when the
  // HTTP POST itself fails; tool errors are results the model sees and
  // are never rolled back.
  // Tracked from birth: every later push/splice/index-assign flows through
  // the ContextLedger traps, so per-step accounting stays O(1). Replacements
  // below re-wrap via trackHistory (never assign a raw array here).
  const historyRef = useRef<ChatMessage[]>(
    trackHistory([{ role: "system", content: withEnvBlock(systemPrompt) }])
  );
  // Task 6 per-turn env block (cwd, git branch/status, node, timestamp):
  // pinned to history[0] (the only slot truncateHistory never drops), NEVER
  // to user content. Refreshed once per turn in submit() + after doResume, so
  // the loop's many POSTs reuse one block (no per-POST shell-outs).
  // Failure-silent via withEnvBlock (missing git → block shrinks).
  function refreshSystemEnv(): void {
    const first = historyRef.current[0];
    if (first?.role !== "system") return;
    const content = (first as { content?: unknown }).content;
    if (typeof content !== "string") return;
    historyRef.current[0] = { role: "system", content: withEnvBlock(content) };
  }

  // Live model list once on mount (skipped in tests via initialModels).
  // Per-provider: live list per kind with curated fallback on ANY failure.
  // Phase 5: successful lists are cached per provider (+baseURL for
  // openai-compatible); failures fall back uncached, exactly as before.
  useEffect(() => {
    if (initialModels) return;
    let cancelled = false;
    if (providerRef.current === "opencode-zen" && providerRef.current === DEFAULT_PROVIDER) {
      const cacheKey = modelsCacheKey(providerRef.current);
      const cached = modelsCacheRef.current.get(cacheKey);
      if (cached) {
        setModels([...cached]);
        return () => {
          cancelled = true;
        };
      }
      void fetchModelsWithStatus(endpoint, apiKey).then(({ models: list, ok }) => {
        if (cancelled) return;
        if (ok) modelsCacheRef.current.set(cacheKey, [...list]);
        setModels(list);
      });
    } else {
      const p = providerRef.current;
      // Local runtimes resolve loopback baseURLs here too, so the mount
      // fetch and the discovery refresh share one cache key per server.
      const baseURL = chatBaseURL(p);
      const cacheKey = modelsCacheKey(p, baseURL);
      const cached = modelsCacheRef.current.get(cacheKey);
      if (cached) {
        setModels([...cached]);
        return () => {
          cancelled = true;
        };
      }
      // Owner-gated seed: an anonymous Kilo mount must not inherit the
      // zen-seeded prop key (see keyForProvider).
      const k = keyForProvider(p);
      void fetchModelsForProviderWithStatus(p, k, baseURL, endpoint).then(({ models: list, ok }) => {
        if (cancelled) return;
        if (ok) modelsCacheRef.current.set(cacheKey, [...list]);
        setModels(list);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [endpoint, apiKey, initialModels]);

  // Slash-menu skill snapshot once on mount (local disk reads only —
  // zero fetches; refreshed on /skills, /clear, /new below).
  useEffect(() => {
    void refreshSkillMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Local model discovery once on mount (background, non-blocking: the
  // probes race with first paint and merge into the models cache when they
  // land — the /model picker then serves local entries with zero extra
  // fetches. Skipped in tests via initialModels, like the live list above).
  useEffect(() => {
    kickLocalDiscovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 5: turn timer helpers (injectable now/timers for tests). The
  // interval handle is always cleared on turn end and on unmount.
  // clockNow shares the injectable `now` (display timestamps only).
  function clockNow(): number {
    try {
      return (now ?? Date.now)();
    } catch {
      return Date.now();
    }
  }
  function clearTurnTimer() {
    const h = turnTimerRef.current;
    if (h !== null) {
      try {
        (clearIntervalFn ?? clearInterval)(h);
      } catch {
        // ignore
      }
      turnTimerRef.current = null;
    }
  }

  function noteTurnActivity() {
    try {
      lastActivityRef.current = (now ?? Date.now)();
    } catch {
      // ignore clock errors (stall hint just won't trigger)
    }
    setStalled(false);
  }

  function startTurnTimer() {
    clearTurnTimer();
    let start: number;
    try {
      start = (now ?? Date.now)();
    } catch {
      start = Date.now();
    }
    turnStartRef.current = start;
    lastActivityRef.current = start;
    setElapsedSecs(0);
    setStalled(false);
    try {
      turnTimerRef.current = (setIntervalFn ?? setInterval)(() => {
        let t: number;
        try {
          t = (now ?? Date.now)();
        } catch {
          return;
        }
        setElapsedSecs(elapsedSecsSince(turnStartRef.current, t));
        if (isStalledSince(lastActivityRef.current, t)) {
          setStalled(true);
        }
      }, TURN_TICK_MS);
    } catch {
      turnTimerRef.current = null;
    }
  }

  // No leaked handles: clear the turn timer on unmount + abort a pending
  // turn so its first POST can never leak into the next mount's fetch
  // (submit's context-assembly/loop-entry stages run async skill discovery
  // before the first POST — see SUBMIT_PIPELINE_STAGES — so unmount can land
  // in that gap; runLoopWithChat checks the signal before the first POST).
  useEffect(() => {
    return () => {
      // Local observability: close the session trace on unmount (covers
      // every exit path — /exit, Ctrl+C idle, test teardown) and flush.
      // Best-effort, never throws; idempotent with closeTelemetry callers.
      try {
        telemetry.endSession();
      } catch {
        // ignore
      }
      persistTelemetry();
      try {
        turnCancelRef.current?.abort();
      } catch {
        // ignore
      }
      const h = turnTimerRef.current;
      if (h !== null) {
        try {
          (clearIntervalFn ?? clearInterval)(h);
        } catch {
          // ignore
        }
        turnTimerRef.current = null;
      }
      try {
        draftThrottleRef.current?.cancel();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticket 01 (/rewind): feed the live conversation lengths to the snapshot
  // capture hook, so each checkpoint knows which turn it belongs to. The
  // refs (not state) are the source of truth mid-turn.
  useEffect(() => {
    registerHistoryProbe(() => ({
      history: historyRef.current.length,
      turns: turnsRef.current.length,
    }));
    return () => registerHistoryProbe(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setInputAndCursor(next: string, cursorPos: number) {
    const prev = inputRef.current;
    inputRef.current = next;
    setInput(next);
    const clamped = Math.max(0, Math.min(cursorPos, next.length));
    cursorRef.current = clamped;
    setCursor(clamped);
    // Slash-prefixed edits restart menu filtering from the top and re-open
    // the menu; plain-text edits skip the two menu setStates entirely so a
    // keystroke is always input+cursor only (one batched render).
    if (next.startsWith("/") || prev.startsWith("/")) {
      slashIndexRef.current = 0;
      setSlashIndex(0);
      slashDismissedRef.current = false;
      setSlashDismissed(false);
    }
  }

  function setInputBoth(next: string) {
    // Append-style callers (and clear/Esc/submit reset): cursor to end.
    setInputAndCursor(next, next.length);
  }

  function setCursorBoth(next: number) {
    const clamped = Math.max(0, Math.min(next, inputRef.current.length));
    cursorRef.current = clamped;
    setCursor(clamped);
  }

  // Cursor-aware edits (plain input + slash menu): typing inserts AT the
  // cursor, backspace deletes BEFORE it, Delete removes AT it. Every edit
  // abandons history browse (typing starts a fresh draft; the stash keeps
  // the pre-browse text for Down-past-newest, which re-stashes on re-entry).
  function exitHistoryBrowse() {
    histIndexRef.current = null;
  }
  function insertAtCursor(text: string) {
    if (!text) return;
    exitHistoryBrowse();
    const cur = inputRef.current;
    const at = Math.max(0, Math.min(cursorRef.current, cur.length));
    setInputAndCursor(cur.slice(0, at) + text + cur.slice(at), at + text.length);
  }

  function backspaceAtCursor() {
    const cur = inputRef.current;
    const at = Math.max(0, Math.min(cursorRef.current, cur.length));
    if (at <= 0) return;
    exitHistoryBrowse();
    setInputAndCursor(cur.slice(0, at - 1) + cur.slice(at), at - 1);
  }

  function deleteAtCursor() {
    const cur = inputRef.current;
    const at = Math.max(0, Math.min(cursorRef.current, cur.length));
    if (at >= cur.length) return;
    exitHistoryBrowse();
    setInputAndCursor(cur.slice(0, at) + cur.slice(at + 1), at);
  }

  function setSelIndexBoth(next: number) {
    selIndexRef.current = next;
    setSelIndex(next);
  }

  function setSlashIndexBoth(next: number) {
    slashIndexRef.current = next;
    setSlashIndex(next);
  }

  function setSlashDismissedBoth(next: boolean) {
    slashDismissedRef.current = next;
    setSlashDismissed(next);
  }

  function setModeBoth(next: PermissionMode) {
    modeRef.current = next;
    setMode(next);
  }

  function setTrustAllBoth(next: boolean) {
    trustAllRef.current = next;
    setTrustAll(next);
  }

  function setAskSelIndexBoth(next: number) {
    askSelIndexRef.current = next;
    setAskSelIndex(next);
  }

  function setAskCustomBoth(next: string) {
    askCustomRef.current = next;
    setAskCustom(next);
  }

  function setEffortBoth(next: ReasoningEffort) {
    effortRef.current = next;
    setEffort(next);
  }

  function setEffortIndexBoth(next: number) {
    effortIndexRef.current = next;
    setEffortIndex(next);
  }

  function setProviderBoth(next: ProviderId) {
    providerRef.current = next;
    setProvider(next);
  }

  function setModelBoth(next: string) {
    modelRef.current = next;
    setModel(next);
  }

  function setAuthBoth(next: AuthFile) {
    authRef.current = next;
    setAuth(next);
  }

  function setActiveKeyBoth(next: string, owner?: ProviderId) {
    activeApiKeyRef.current = next;
    setActiveApiKey(next);
    if (owner !== undefined) activeKeyProviderRef.current = owner;
  }

  function setProviderIndexBoth(next: number) {
    providerIndexRef.current = next;
    setProviderIndex(next);
  }

  function setKeyPromptBoth(next: ProviderKeyPrompt | null) {
    keyPromptRef.current = next;
    setKeyPrompt(next);
  }

  function setBaseURLPromptBoth(next: ProviderBaseURLPrompt | null) {
    baseURLPromptRef.current = next;
    setBaseURLPrompt(next);
  }

  function setRewindIndexBoth(next: number) {
    rewindIndexRef.current = next;
    setRewindIndex(next);
  }

  function setRewindScopeIndexBoth(next: number) {
    rewindScopeIndexRef.current = next;
    setRewindScopeIndex(next);
  }

  // Resolved key for picker markers: env wins, else stored; the active
  // provider falls back to the seeded prop key (tests/prod initial).
  function keyForProvider(id: ProviderId): string {
    const resolved = resolveApiKey(id, authRef.current);
    if (resolved) return resolved;
    // Seeded-key fallback, owner-gated (see activeKeyProviderRef): the
    // startup seed belongs to exactly one provider and must never leak
    // into another's requests (notably anonymous Kilo sessions).
    if (
      id === providerRef.current &&
      id === activeKeyProviderRef.current &&
      activeApiKeyRef.current
    ) {
      return activeApiKeyRef.current;
    }
    return "";
  }

  function closeAllPickers(): void {
    setSelecting(false);
    setModelFilterBoth("");
    setSelectingSkills(false);
    setSkillFilterBoth("");
    setSelectingEffort(false);
    setSelectingProvider(false);
    setKeyPromptBoth(null);
    setBaseURLPromptBoth(null);
    setSelectingRewind(false);
    setSelectingRewindScope(false);
    pendingRewindRef.current = null;
  }

  // /skills picker (opencode-style searchable popup): opens on the fresh
  // registry (names only), filters as you type, loads on Enter. Local disk
  // reads only — zero fetches. Idle-only (history injection mid-turn would
  // break the loop's assistant/tool pairing).
  function openSkillPicker(): void {
    setInputBoth("");
    closeAllPickers();
    setSkillFilterBoth("");
    setSkillIndexBoth(0);
    void skillRegistry.refresh().then(
      (found) => {
        if (busyRef.current) {
          pushInfo("Skills load when idle — wait for the turn to finish.");
          return;
        }
        const { skills } = resolveSkills(found.skills);
        setSkillPickerItems(
          skills.map((s) => ({ name: s.name, userInvocable: s.userInvocable, source: s.source }))
        );
        setSelectingSkills(true);
        void refreshSkillMenu();
      },
      () => {
        // Discovery never throws by contract, but a rejection must never
        // become an unhandled rejection (Node kills the process) — surface it.
        pushInfo("(skill discovery failed — no skills listed)");
      }
    );
  }
  // Unified /model entries for this render: active provider's current list
  // first, then every other keyed provider's cached-or-fallback list (pure,
  // local-only — see modelPickerEntries). Called from the /model open path,
  // the picker input branch, and the picker render: all three run on the
  // same render's state, so open/highlight/filter/paint always agree.
  function buildModelEntries(): ModelPickerEntry[] {
    return modelPickerEntries({
      activeProvider: providerRef.current,
      activeModels: models,
      cached: (id, baseURL) => modelsCacheRef.current.get(modelsCacheKey(id, baseURL)),
      keyFor: (id) => keyForProvider(id),
      // Local runtimes resolve loopback baseURLs (env/defaults), so cache
      // reads hit the same keys discovery writes.
      baseURLFor: (id) => chatBaseURL(id),
    });
  }

  function openProviderPicker(): void {
    setSelecting(false);
    setSelectingEffort(false);
    setKeyPromptBoth(null);
    setBaseURLPromptBoth(null);
    const idx = Math.max(
      0,
      PROVIDERS.findIndex((p) => p.id === providerRef.current)
    );
    setProviderIndexBoth(idx);
    setSelectingProvider(true);
  }

  function openKeyPrompt(providerId: ProviderId): void {
    const def = getProvider(providerId)!;
    const existing = keyForProvider(providerId);
    setSelectingProvider(false);
    setSelecting(false);
    setSelectingEffort(false);
    setBaseURLPromptBoth(null);
    setKeyPromptBoth({
      providerId,
      draft: "",
      error: null,
      existingMasked: existing ? maskKey(existing) : null,
      consoleURL: def.consoleURL,
      validating: false,
    });
  }

  function openBaseURLPrompt(providerId: ProviderId): void {
    setSelectingProvider(false);
    setSelecting(false);
    setSelectingEffort(false);
    setKeyPromptBoth(null);
    const prev = getStoredBaseURL(authRef.current, providerId);
    setBaseURLPromptBoth({ providerId, draft: prev, error: null });
  }

  // Switch provider after a validated key (or Esc-keeps existing):
  // reuse the cached live list when available (zero fetches), else fetch
  // the live list and cache successes; failures fall back uncached.
  // /model always reflects the switched-to provider instantly from cache
  // when available. Keep current model if valid else provider default —
  // unless preserveModel names an explicit pick (cross-provider /model
  // selection), which wins unconditionally so the user's pick sticks even
  // before the background live refresh lands.
  async function switchProviderWithKey(
    pickedId: ProviderId,
    apiKeyValue: string,
    preserveModel?: string
  ): Promise<void> {
    const def = getProvider(pickedId)!;
    const baseURL = chatBaseURL(pickedId);
    const cacheKey = modelsCacheKey(pickedId, baseURL);
    const cached = modelsCacheRef.current.get(cacheKey);
    let list: string[];
    if (cached) {
      list = [...cached];
    } else {
      try {
        const res = await fetchModelsForProviderWithStatus(pickedId, apiKeyValue, baseURL, endpoint);
        list = res.models;
        if (res.ok) modelsCacheRef.current.set(cacheKey, [...list]);
      } catch {
        list = [...def.fallbackModels];
      }
    }
    setModels(list);
    const nextModel = preserveModel ?? (list.includes(modelRef.current)
      ? modelRef.current
      : def.defaultModel);
    setModelBoth(nextModel);
    setProviderBoth(pickedId);
    // Provider switch resets the load latch: the last reported prompt_tokens
    // belonged to the old provider/model tokenizer, so the estimate applies
    // until the new provider reports (usageTotals spend is untouched).
    resetContextLoadToEstimate();
    setActiveKeyBoth(apiKeyValue, pickedId);
    if (pickedId === "openai-compatible") {
      setActiveEndpoint(openaiCompatibleChatEndpoint(baseURL));
    } else if (pickedId === "opencode-zen") {
      setActiveEndpoint(endpoint);
    } else {
      setActiveEndpoint(chatEndpointFor(pickedId, baseURL));
    }
    pushInfo(`provider: ${pickedId} · model: ${nextModel}`);
  }

  // Ref-synced turn writers: keep turnsRef current so persistSession can
  // snapshot synchronously right after a commit.
  function setTurnsBoth(next: Turn[]) {
    turnsRef.current = next;
    setTurns(next);
  }

  function appendTurns(...items: Turn[]) {
    // Autoscroll off + busy + following: freeze the view at its current end
    // BEFORE appending, so streaming output accumulates below instead of
    // yanking the viewport (smooth-scroll hold). Idle appends and already-
    // held views pass through untouched.
    if (!autoScrollRef.current && busyRef.current && scrollEndRef.current === null) {
      setScrollEndBoth(turnsRef.current.length);
    }
    const next = [...turnsRef.current, ...items];
    turnsRef.current = next;
    setTurns(next);
  }

  function setUsageBoth(next: Usage | null) {
    usageRef.current = next;
    setUsageTotals(next);
  }

  function setContextLoadBoth(next: number | null) {
    contextLoadRef.current = next;
    setContextLoad(next);
  }

  function setAutoDisabledBoth(next: boolean) {
    autoDisabledRef.current = next;
    setAutoDisabled(next);
  }

  // Recompute contextLoad after a committed turn (or compaction): last
  // POST prompt_tokens when available, else the 4ch/token estimate.
  function refreshContextLoad(): number | null {
    // No usage yet → no load (status keeps `token: n/a`).
    if (!usageRef.current) {
      setContextLoadBoth(null);
      return null;
    }
    const load = contextManager().usage(
      historyRef.current,
      lastPromptTokensRef.current
    ).loadTokens;
    setContextLoadBoth(load);
    return load;
  }

  // Load-reset contract (hold-last-known): the reported prompt_tokens survive
  // silent POSTs — estimates never override a fresher report — and reset ONLY
  // here: compaction, /clear, resume, and model/provider switch. After a reset
  // the chars/4 estimate applies until the next report arrives.
  function resetContextLoadToEstimate(): void {
    lastPromptTokensRef.current = undefined;
    if (!usageRef.current) {
      setContextLoadBoth(null);
    } else {
      setContextLoadBoth(estimateTokensForChars(historyChars(historyRef.current)));
    }
  }

  function pushInfo(content: string) {
    appendTurns({ role: "tool", content });
  }

  // The session's ContextManager: window-derived budgets for the active
  // model, measured tool schemas, configured ceilings. Built fresh per call
  // (pure math, no I/O beyond the resolved ceiling sources) so it always sees
  // the current model; history is measured live on every use. The schema size
  // is memoized once — TOOL_DEFINITIONS never changes at runtime, so every
  // turn must not re-serialize 15KB to ask.
  function contextManager(): ContextManager {
    return createContextManager({
      model: modelRef.current,
      toolsChars: TOOLS_SCHEMA_CHARS,
    });
  }

  // /context (Claude-Code-style visibility): where the tokens are going, by
  // source — system prompt, tool schemas, history, skill injections — plus
  // the budget and compaction posture. All estimates use the 4ch/token
  // heuristic (honest `token: n/a` accounting is untouched); all reads are
  // local, so the command costs zero fetches.
  function buildContextText(): string {
    const hist = historyRef.current;
    const first = hist[0];
    const sysChars =
      first && typeof (first as { content?: unknown }).content === "string"
        ? messageChars(first)
        : 0;
    const toolsChars = TOOLS_SCHEMA_CHARS;
    const mgr = contextManager();
    const u = mgr.usage(hist, lastPromptTokensRef.current);
    const b = mgr.budget(hist);
    const skillLoads = hist.filter(
      (m) =>
        m?.role === "user" &&
        typeof (m as { content?: unknown }).content === "string" &&
        ((m as { content?: unknown }).content as string).includes('[skill "')
    ).length;
    const loadLine =
      u.loadPct !== undefined && b.windowTokens !== undefined
        ? `load: ${formatKEst(u.historyChars)} (${u.loadPct}% of ${(b.windowTokens / 1000).toFixed(0)}K verified window)`
        : `load: ${formatKEst(u.historyChars)} (no verified window — auto-compact off, use /compact manually)`;
    const cfg = atomConfigLoad;
    const cfgSources =
      cfg.sources.project && cfg.sources.global
        ? "project + global"
        : cfg.sources.project
          ? "project"
          : cfg.sources.global
            ? "global"
            : "none";
    const cfgKeys = Object.keys(atomConfig).length;
    const cfgLine =
      `config: atom.json (${cfgSources}${cfgKeys > 0 ? `, ${cfgKeys} key${cfgKeys === 1 ? "" : "s"}` : ", defaults"})` +
      (cfg.warnings.length > 0 ? `\nconfig warnings:\n${cfg.warnings.map((w) => `- ${w}`).join("\n")}` : "");
    // Prefix-cache instrumentation (estimates + reported-only hits — a
    // provider that reports nothing shows "(not reported)", never zeros).
    // stableTokens are tokens; formatKEst takes chars, hence the ×4 round-trip.
    const caps = providerCacheSupport(providerRef.current);
    const prefix =
      first && typeof (first as { content?: unknown }).content === "string"
        ? assemblePrefix({
            systemContent: (first as { content: string }).content,
            toolsJson: JSON.stringify(TOOL_DEFINITIONS),
          })
        : null;
    const totals = usageRef.current;
    const cacheHits =
      totals?.cacheReadTokens !== undefined || totals?.cacheWriteTokens !== undefined
        ? `read ${formatKEst((totals?.cacheReadTokens ?? 0) * 4)} / written ${formatKEst((totals?.cacheWriteTokens ?? 0) * 4)}`
        : "not reported by provider";
    const cacheLine =
      prefix !== null
        ? `cache: ${formatKEst(prefix.stableTokens * 4)} stable/cacheable (fp ${prefix.fingerprint.slice(0, 12)}) + ${formatKEst(prefix.dynamicSystem !== null ? prefix.dynamicSystem.length : 0)} dynamic env · ${caps.explicitBreakpoints ? "explicit breakpoints" : caps.implicitPrefix ? "implicit prefix" : "no caching assumed"} · hits: ${cacheHits}`
        : `cache: (no system message) · hits: ${cacheHits}`;
    return (
      `Context (model ${modelRef.current}):\n` +
      `system: ${formatKEst(sysChars)} (base + AGENTS overlay + env block)\n` +
      `tools: ${TOOL_DEFINITIONS.length} defs, ${formatKEst(toolsChars)}\n` +
      `history: ${u.historyMessages} messages / ${u.userTurns} user turns, ${formatKEst(u.historyChars)}\n` +
      `skill injections live in history: ${skillLoads}\n` +
      `${cfgLine}\n` +
      `${cacheLine}\n` +
      `${loadLine} · budget: ${b.effectiveMaxMessages} msgs / ${(b.effectiveMaxChars / 1000).toFixed(0)}K chars`
    );
  }

  // Load a resolved skill into the session (tickets 03/06) with
  // progressive-disclosure tiers (Claude-Code-style):
  // - manual (explicit user invocation): full body + inlined references enter
  //   model history as one marked message (the user asked for the whole skill).
  // - auto (description match): Tier 2 only — body without inlined references
  //   (the model reads references/<…> via read when needed), capped at
  //   AUTO_SKILL_BODY_CAP so a trigger can never flood the window.
  // Both paths print ONE transcript line (never the body — the TUI stays
  // calm no matter how large the skill is); `allowed-tools` become
  // turn-scoped grants per the skill-grant trust policy (global skills arm,
  // project skills never do — see skillGrantsFor). Never throws:
  // loadSkillBody degrades to empty text, surfaced plainly.
  async function activateSkill(info: SkillInfo, opts?: { auto?: boolean }): Promise<void> {
    const auto = opts?.auto === true;
    const loaded = await loadSkillBody(info, auto ? { inlineRefs: false } : undefined);
    if (loaded.text.trim().length === 0) {
      pushInfo(`Skill "${info.name}" has an empty body — nothing loaded.`);
      return;
    }
    const { grants, blocked } = skillGrantsFor(info.source, loaded.info.allowedTools);
    for (const t of grants) skillGrantsRef.current.add(t);
    const contextText = auto ? capSkillBodyForAuto(loaded.text, info.dir) : loaded.text;
    historyRef.current.push({
      role: "user",
      content: `[skill "${info.name}" loaded — follow these instructions]\n${contextText}`,
    });
    const grantNote =
      grants.length > 0
        ? ` (tools pre-approved this turn: ${grants.join(", ")})`
        : blocked.length > 0
          ? ` (project skill: ${blocked.join(", ")} still needs approval)`
          : "";
    pushInfo(`${info.name} loaded${grantNote}`);
  }

  // Manual skill invocation (ticket 03; `/skill-name` legacy form and the
  // namespaced `/skill:name` form both land here with the bare name).
  // Idle-only: injecting history mid-turn would break the loop's
  // assistant/tool pairing. Unknown names get a helpful error (not a model
  // message); model-only skills refuse with a pointer instead of loading.
  async function invokeSkillByName(name: string): Promise<void> {
    if (busyRef.current) {
      pushInfo("Skills load when idle — wait for the turn to finish.");
      return;
    }
    const found = await skillRegistry.refresh();
    const { skills } = resolveSkills(found.skills);
    const info = skills.find((s) => s.name === name);
    if (!info) {
      const available = skills.filter((s) => s.userInvocable).map((s) => `/skill:${s.name}`);
      pushInfo(
        available.length > 0
          ? `Unknown skill "/skill:${name}". Available: ${available.join(", ")}`
          : `Unknown skill "/skill:${name}" (no skills installed).`
      );
      return;
    }
    if (!info.userInvocable) {
      pushInfo(`Skill "${name}" is model-invoked only (user-invocable: false).`);
      return;
    }
    await activateSkill(info);
  }

  // Snapshot the committed session (historyRef + turnsRef + settings refs)
  // to ~/.atom/session.json. Disk errors are ignored (in-memory session
  // still applies). Called only for committed state: completed turns and
  // clean exit — never for rolled-back (failed/cancelled) turns. The
  // committed diff previews (Turn.diff) are display-only and never saved:
  // they can hold whole file contents (bloat) and would render stale
  // after later edits, so /resume restores label-only turns.
  function persistSession() {
    try {
      saveSession(
        {
          provider: providerRef.current,
          model: modelRef.current,
          effort: effortRef.current,
          mode: modeRef.current,
          usageTotals: usageRef.current,
          history: historyRef.current,
          turns: turnsRef.current.map((t) => {
            const { diff: _dropped, ...rest } = t;
            return rest;
          }),
        },
        authHome
      );
    } catch {
      // ignore disk errors (in-memory session still applies)
    }
  }

  // Local observability persistence: flush the current telemetry session
  // file (atomic, best-effort). Called on turn boundaries and session events —
  // never in the hot path, never throwing.
  function persistTelemetry() {
    try {
      telemetry.flush();
    } catch {
      // ignore disk errors (telemetry never breaks the session)
    }
  }

  function closeTelemetry() {
    try {
      telemetry.endSession();
    } catch {
      // ignore
    }
    persistTelemetry();
  }

  // One-line /telemetry summary: current-session progress plus stored totals.
  // Token figures are API-reported only; unavailable values say n/a with the
  // reason (never zero, never estimated).
  function telemetrySummaryText(): string {
    try {
      if (!telemetry.isEnabled()) {
        return "(telemetry off — ATOM_TELEMETRY=0 or atom.json telemetry.enabled=false; no traces recorded)";
      }
      const snap = telemetry.getSnapshot();
      const { sessions } = loadTelemetrySessions(authHome);
      const agg = summarizeTelemetry(sessions);
      const tokens = agg.usageReported
        ? [
            agg.usage.prompt_tokens !== undefined ? `in ${agg.usage.prompt_tokens}` : null,
            agg.usage.completion_tokens !== undefined ? `out ${agg.usage.completion_tokens}` : null,
            agg.usage.total_tokens !== undefined ? `total ${agg.usage.total_tokens}` : null,
          ]
            .filter((p): p is string => p !== null)
            .join(" · ") || "reported (empty)"
        : "n/a (no usage reported yet)";
      const rate =
        agg.toolSuccessRate !== null ? `${(agg.toolSuccessRate * 100).toFixed(1)}%` : "n/a (no tool calls)";
      return (
        `Telemetry: on · this session ${snap.sessionId} (${snap.turns.length} turn(s)) · ` +
        `store ${telemetryDir(authHome)} (${agg.sessions} session(s), ${agg.turns} turn(s), ` +
        `${agg.modelCalls} model call(s), ${agg.toolCalls} tool call(s), success ${rate}, tokens ${tokens}, ` +
        `${agg.retries} retries) · /dashboard writes the full drill-down page.`
      );
    } catch {
      return "(telemetry unavailable)";
    }
  }

  // Compaction routine (atomic): split head/tail, summarize head with
  // tools disabled + 4096 cap, then swap history := [system, summary, tail].
  // On success: boundary line, totals kept, load refreshed, save. On
  // failure: old history untouched + inline error (oversize retry-once
  // already handled inside requestCompactSummary, which appends /clear).
  // isAuto drives the thrash guard; manual resets the counter on success.
  async function doCompact(focusText: string, isAuto: boolean): Promise<boolean> {
    if (countUserTurns(historyRef.current) <= 1) {
      if (!isAuto) pushInfo("(nothing to compact)");
      return false;
    }
    const split: SplitResult = splitHistoryForCompaction(historyRef.current);
    if (split.olderTurnCount <= 0 || split.head.length === 0) {
      if (!isAuto) pushInfo("(nothing to compact)");
      return false;
    }
    const systemMsg = historyRef.current[0]!;
    const systemContent =
      typeof systemMsg.content === "string" ? systemMsg.content : systemPrompt;
    // Owner-gated (see keyForProvider): never borrow another provider's
    // seed key — anonymous Kilo sessions POST keyless.
    const submitKey = keyForProvider(providerRef.current);
    // Local runtimes need no key; a known-unreachable server fails fast
    // with a clear notice instead of a bare connection error mid-turn.
    const compactLocalNotice = localUnreachableNotice(providerRef.current);
    if (compactLocalNotice) {
      pushInfo(compactLocalNotice);
      return false;
    }
    if (!submitKey && providerNeedsKey(providerRef.current)) {
      pushInfo(
        `Missing API key for ${providerRef.current} — run /provider to paste one (stored in ~/.atom/auth.json).`
      );
      return false;
    }
    const baseURL = chatBaseURL(providerRef.current);
    try {
      const summary = await requestCompactSummary({
        provider: providerRef.current,
        apiKey: submitKey,
        model: modelRef.current,
        systemContent,
        head: split.head,
        focusText,
        baseURL,
        endpointOverride: activeEndpoint,
        onUsage: (u) => {
          // Totals keep accumulating (real summary spend); load source
          // untouched (summary prompt reflects head size, not new context).
          const prev = usageRef.current ?? {};
          const next: Usage = { ...prev };
          if (u.prompt_tokens !== undefined) {
            next.prompt_tokens = (next.prompt_tokens ?? 0) + u.prompt_tokens;
          }
          if (u.completion_tokens !== undefined) {
            next.completion_tokens = (next.completion_tokens ?? 0) + u.completion_tokens;
          }
          if (u.total_tokens !== undefined) {
            next.total_tokens = (next.total_tokens ?? 0) + u.total_tokens;
          }
          if (u.cacheReadTokens !== undefined) {
            next.cacheReadTokens = (next.cacheReadTokens ?? 0) + u.cacheReadTokens;
          }
          if (u.cacheWriteTokens !== undefined) {
            next.cacheWriteTokens = (next.cacheWriteTokens ?? 0) + u.cacheWriteTokens;
          }
          // Only accumulate when the summary actually reported usage;
          // an empty onUsage keeps totals byte-identical.
          if (
            u.prompt_tokens !== undefined ||
            u.completion_tokens !== undefined ||
            u.total_tokens !== undefined ||
            u.cacheReadTokens !== undefined ||
            u.cacheWriteTokens !== undefined
          ) {
            setUsageBoth(next);
          }
          // Local observability: compaction spend is session-level (it
          // summarizes many turns and often lands after its turn ended), so
          // it is kept separate from per-turn usage. No-op when empty.
          telemetry.recordCompactionUsage(u, isAuto ? "auto" : "manual");
        },
      });
      // Atomic swap: build the new history first, then replace. The head's
      // touched files (collected from the committed tool_calls the loop
      // already recorded — no new tracking) ride inside the summary within
      // budget, so resumed sessions know what was touched; over-budget lists
      // shrink instead of failing compaction.
      const fitted = fitSummaryWithFiles(summary, collectTouchedFiles(split.head));
      const next = buildCompactedHistory(
        systemMsg,
        fitted.text,
        split.tail,
        split.olderTurnCount
      );
      // Replacement: re-wrap so the ledger restarts from the compacted array
      // (the old ledger is discarded with the old array).
      historyRef.current = trackHistory(next);
      appendTurns({ role: "tool", content: compactBoundaryLine(split.olderTurnCount) });
      // New lineage (see src/rollback.ts): the atomic swap invalidates
      // checkpoint marks — drop them, loudly when non-empty. The summary
      // keeps the story; stale marks must never truncate the new tail.
      const compactDrops = clearSnapshots();
      if (compactDrops > 0) {
        pushInfo(
          `(/compact — discarded ${compactDrops} file checkpoint(s); undos do not cross a compaction)`
        );
      }
      // P% must drop immediately: the old lastPromptTokens reflects the
      // pre-compact context, so clear it and use the new-history estimate.
      lastPromptTokensRef.current = undefined;
      const newLoad = estimateTokensForChars(historyChars(historyRef.current));
      setContextLoadBoth(newLoad);
      if (isAuto) {
        const pct = compactPct();
        const window = contextWindowFor(modelRef.current);
        if (window !== undefined && newLoad / window < pct) {
          autoStreakRef.current = 0;
        } else {
          autoStreakRef.current += 1;
          if (isThrashDisabled(autoStreakRef.current)) {
            setAutoDisabledBoth(true);
            appendTurns({
              role: "tool",
              content: "(auto-compact thrashing — disabled, use /compact or /clear)",
            });
          }
        }
      } else {
        autoStreakRef.current = 0;
      }
      persistSession();
      return true;
    } catch (err) {
      // No partial swap: historyRef untouched. Inline error only.
      const msg = err instanceof Error ? err.message : String(err);
      pushInfo(`compact failed: ${msg}`);
      return false;
    }
  }

  // After a completed main turn: refresh load, reset the streak when below
  // threshold, else auto-compact (known-window models only, unless
  // thrash-disabled). Called while still busy, before the next turn.
  async function maybeAutoCompact(): Promise<void> {
    const load = refreshContextLoad();
    if (load === null) {
      autoStreakRef.current = 0;
      return;
    }
    // Unknown window → no auto trigger (never invent a window); below
    // threshold → streak resets. The manager owns the pct math, so a false
    // there means either case — re-check the window for the reset.
    if (!contextManager().needsCompaction(load)) {
      // Distinguish unknown-window (streak untouched — irrelevant) from
      // below-threshold (streak resets). shouldAutoCompact is false for
      // both, so re-check the window for the reset.
      if (contextWindowFor(modelRef.current) !== undefined) {
        autoStreakRef.current = 0;
      }
      return;
    }
    if (autoDisabledRef.current) return;
    await doCompact("", true);
  }

  // /resume: restore turns + history + settings + usage from the save file.
  // Missing -> "(no saved session)"; corrupt -> unreadable notice, fresh.
  // Oversized saves run the normal truncation path after restore so the
  // budget caps hold; pairing stays valid (saved intact, turns never split).
  function doResume() {
    const result = loadSession(authHome);
    if (result.status === "missing") {
      pushInfo("(no saved session)");
      return;
    }
    if (result.status === "corrupt") {
      pushInfo("(saved session unreadable — starting fresh)");
      return;
    }
    const s = result.session;
    setProviderBoth(s.provider);
    const baseURL = chatBaseURL(s.provider);
    if (s.provider === "openai-compatible") {
      setActiveEndpoint(openaiCompatibleChatEndpoint(baseURL));
    } else if (s.provider === "opencode-zen") {
      setActiveEndpoint(endpoint);
    } else {
      setActiveEndpoint(chatEndpointFor(s.provider, baseURL));
    }
    setModelBoth(s.model);
    setEffortBoth(s.effort);
    setModeBoth(s.mode);
    setUsageBoth(s.usageTotals);
    // Replacement: wrap the restored array (see the init comment).
    historyRef.current = trackHistory([...s.history]);
    // Task 6: refresh the pinned env block on the restored system line
    // (strips the saved block, appends a fresh one) — keeps the restored
    // AGENTS overlay, never touches user content.
    refreshSystemEnv();
    // Restored load is the estimate (no prompt_tokens survived the save);
    // thrash state restarts fresh on resume.
    lastPromptTokensRef.current = undefined;
    if (!usageRef.current) {
      setContextLoadBoth(null);
    } else {
      setContextLoadBoth(estimateTokensForChars(historyChars(historyRef.current)));
    }
    autoStreakRef.current = 0;
    setAutoDisabledBoth(false);
    pendingCompactRef.current = null;
    const pendingNotices: Turn[] = [];
    // New lineage (see src/rollback.ts): the restored history replaces the
    // live array, so live checkpoint marks are stale — drop them. Disk files
    // are untouched; only undo evidence goes.
    const resumedDrops = clearSnapshots();
    if (resumedDrops > 0) {
      pendingNotices.push({
        role: "tool",
        content: `(/resume — discarded ${resumedDrops} live file checkpoint(s); undos do not cross a resume)`,
      });
    }
    // Same window-derived caps as the live path (the restored model is
    // already in modelRef above).
    contextManager().trimForSend(
      historyRef.current,
      (msg) => {
        pendingNotices.push({ role: "tool", content: `⚠ ${msg}` });
      },
      undefined,
      openTodoNeedles()
    );
    // Surface the touched-file lists stored in compacted summaries, verbatim
    // in the stored format — a resumed session knows what was touched
    // without re-exploring the tree.
    for (const section of collectStoredTouchedFiles(historyRef.current)) {
      pendingNotices.push({ role: "tool", content: section });
    }
    // Remount the turns <Static> (same mechanism as /clear and /new): Ink's
    // Static only renders newly appended indices, so restoring a transcript
    // over a non-empty rendered buffer (e.g. the /new boundary line) would
    // misalign and hide the first restored turn(s). Restored list replaces
    // the live one, so a held view re-follows (see /clear).
    setScrollEndBoth(null);
    setClearGen((g) => g + 1);
    setTurnsBoth([
      ...s.turns,
      {
        role: "tool",
        content: `(resumed session from ${s.savedAt}: ${s.turns.length} turns)`,
      },
      ...pendingNotices,
    ]);
    telemetry.recordEvent("resume", `restored session saved at ${s.savedAt} (${s.turns.length} turns)`);
    persistTelemetry();
  }

  // /rewind conversation scope (ticket 01): truncate history + transcript to
  // the checkpoint's turn. The cut drops the whole containing turn (submit's
  // splice(rollbackTo) rollback semantics via conversationCutIndex), so
  // assistant/tool pairing can never split. The <Static> remount + load
  // refresh follow the /resume precedent. Files are untouched here.
  function rewindConversationTo(cp: Checkpoint): string {
    const cut = conversationCutIndex(
      historyRef.current.map((m) => ({
        role: m.role,
        hasToolCalls: m.role === "assistant" && (m as { tool_calls?: unknown }).tool_calls !== undefined,
      })),
      cp.historyLength
    );
    const droppedMessages = historyRef.current.length - cut;
    if (cut < historyRef.current.length) {
      historyRef.current.splice(cut);
    }
    const turnsCut = conversationCutIndex(
      turnsRef.current.map((t) => ({ role: t.role })),
      cp.turnsLength,
      0
    );
    if (turnsCut < turnsRef.current.length) {
      setTurnsBoth(turnsRef.current.slice(0, turnsCut));
      // Truncation can strand a held end past the new bottom — re-follow.
      setScrollEndBoth(null);
    }
    if (droppedMessages <= 0) {
      return `(already at checkpoint #${cp.seq} — conversation untouched)`;
    }
    // Same remount as /clear and /resume: the rewound tail leaves the test
    // frame while staying in real-terminal scrollback.
    setClearGen((g) => g + 1);
    refreshContextLoad();
    return `(rewound conversation to checkpoint #${cp.seq} — dropped ${droppedMessages} message(s))`;
  }

  // /rewind execution: files-only restores bytes (transcript keeps flowing);
  // conversation-only truncates (files untouched); both does files first so
  // the two info lines read in cause order. Restore also refreshes the
  // stale-read fingerprints (see tools.ts) so later edits don't false-refuse.
  async function runRewind(id: string, scope: RewindScope): Promise<void> {
    const cp = getCheckpoint(id);
    if (!cp) {
      pushInfo("(checkpoint no longer available)");
      return;
    }
    if (scope === "conversation only") {
      pushInfo(rewindConversationTo(cp));
      return;
    }
    const filesMsg = await restoreCheckpointFiles(id, (abs, text) => {
      if (text === null) forgetReadFingerprint(abs);
      else refreshReadFingerprint(abs, text);
    });
    if (scope === "files + conversation") {
      // Truncate BEFORE pushing: rewindConversationTo slices the transcript
      // to the checkpoint turn, which would drop a files line pushed first.
      const convMsg = rewindConversationTo(cp);
      pushInfo(filesMsg);
      pushInfo(convMsg);
      return;
    }
    pushInfo(filesMsg);
  }

  function warnEffortUnsupported(modelName: string) {
    pushInfo(
      `reasoning effort is not known to be supported by ${modelName} — setting kept, not sent`
    );
  }

  // Manual /compact entry: busy → set pending flag, run at turn end (drain
  // boundary, never mid-turn); idle → run now under the busy guard so a
  // concurrent submit cannot interleave. Works for unknown-window models.
  async function runCompactCommand(focusText: string): Promise<void> {
    if (busyRef.current) {
      pendingCompactRef.current = focusText;
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await doCompact(focusText, false);
    } finally {
      pendingCompactRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }

  // Scoped rules surface (ticket 03): /allow + /deny add one `tool[:glob]`
  // rule, /rules lists, /rules clear wipes. Idle-only (callers gate on busy,
  // like every slash command except /compact). Rules gate write/edit/bash —
  // the approval tools — so a rule naming a read-only tool is accepted but
  // noted as inert (those calls never consult approve()).
  function runRulesCommand(raw: string): void {
    const text = raw.trim();
    const space = text.indexOf(" ");
    const head = space === -1 ? text : text.slice(0, space);
    const arg = space === -1 ? "" : text.slice(space + 1).trim();
    if (head === "/rules") {
      if (arg === "") {
        pushInfo(formatRules(rulesRef.current));
        return;
      }
      if (arg === "clear") {
        rulesRef.current = [];
        pushInfo("(rules cleared)");
        return;
      }
      pushInfo(RULE_USAGE);
      return;
    }
    if (head !== "/allow" && head !== "/deny") return;
    if (arg === "") {
      pushInfo(RULE_USAGE);
      return;
    }
    const kind = head === "/allow" ? "allow" : "deny";
    const parsed = parseRuleInput(arg, kind);
    if (!parsed) {
      pushInfo(`invalid rule ${JSON.stringify(arg)} — ${RULE_USAGE}`);
      return;
    }
    rulesRef.current = [...rulesRef.current, parsed];
    const gatedNote = needsApproval(parsed.tool)
      ? ""
      : ` (note: ${parsed.tool} is read-only and auto-runs — rules gate write/edit/bash)`;
    pushInfo(
      `${kind === "allow" ? "allowed" : "denied"}: ${parsed.pattern} (${rulesRef.current.length} rule(s))${gatedNote}`
    );
  }

  // Queue + steer surface (Claude-Code-style follow-ups): /queue lists,
  // /queue clear wipes, /steer <text> steers the running turn (or sends when
  // idle). Idle-only except /steer-with-text and /queue reads, which also run
  // while busy — that is their entire purpose. Callers gate on busy like
  // every slash command except /compact (submit's busy branch routes here).
  function runQueueCommand(raw: string): void {
    const text = raw.trim();
    if (text === "/queue") {
      if (queueRef.current.length === 0 && !steerRef.current) {
        pushInfo("(queue empty — type + Enter while busy to queue a follow-up)");
        return;
      }
      const lines = queueRef.current.map((q, i) => `${i + 1}. ${q}`);
      if (steerRef.current) lines.unshift(`(steering now: ${steerRef.current})`);
      pushInfo(`Queued (${queueRef.current.length}):\n${lines.join("\n")}`);
      return;
    }
    if (text === "/queue clear") {
      setQueueBoth([]);
      pushInfo("(queue cleared)");
      return;
    }
    if (text === "/steer") {
      pushInfo(STEER_USAGE);
      return;
    }
    if (text.startsWith("/steer ")) {
      const msg = text.slice("/steer".length).trim();
      if (!msg) {
        pushInfo(STEER_USAGE);
        return;
      }
      if (!busyRef.current) {
        // Idle: steering is just sending (same pipeline as typed input).
        void submit(msg);
        return;
      }
      // Busy: steer the active turn — drained at the next loop step boundary
      // (see drainSteer). A second steer while one is pending queues behind
      // it instead of clobbering it.
      if (steerRef.current) {
        if (queueRef.current.length >= QUEUE_CAP) {
          pushInfo(`(queue full — ${QUEUE_CAP} pending; /queue lists, /queue clear wipes)`);
          return;
        }
        setQueueBoth([...queueRef.current, msg]);
        pushInfo(`(steer pending — queued behind it (${queueRef.current.length}))`);
        return;
      }
      setSteerPendingBoth(msg);
      return;
    }
    pushInfo(QUEUE_USAGE);
  }

  // /thinking: rendering-only visibility toggle for model thinking (both
  // the committed transcript blocks and the live thinking block). Pure
  // paint — safe while busy (never touches the turn, like /autoscroll).
  // Bare toggles; anything appended prints usage (there are no arguments).
  function runThinkingCommand(raw: string): void {
    if (raw.trim() !== "/thinking") {
      pushInfo(THINKING_USAGE);
      return;
    }
    const next = !showThinkingRef.current;
    setShowThinkingBoth(next);
    pushInfo(
      next
        ? "(thinking shown — model reasoning stays visible in the transcript)"
        : "(thinking hidden — reasoning still runs, it just isn't rendered)"
    );
  }
  // /autoscroll [on|off]: follow switch for the scrollback viewport. View-
  // only state — safe while busy (never touches the turn, like /queue).
  // Bare prints the state; on jumps to the latest; off freezes a following
  // view at its current end (mid-turn appends then accumulate below).
  function runAutoScrollCommand(raw: string): void {
    const arg = raw.trim() === "/autoscroll" ? "" : raw.trim().slice("/autoscroll".length).trim().toLowerCase();
    if (arg === "") {
      pushInfo(
        autoScrollRef.current
          ? "(autoscroll on — following new output as it arrives)"
          : "(autoscroll off — the view freezes while a turn runs; End follows the latest)"
      );
      return;
    }
    if (arg === "on") {
      if (autoScrollRef.current) {
        pushInfo("(autoscroll already on)");
        return;
      }
      setAutoScrollBoth(true);
      setScrollEndBoth(null);
      pushInfo("(autoscroll on — following the latest)");
      return;
    }
    if (arg === "off") {
      if (!autoScrollRef.current) {
        pushInfo("(autoscroll already off)");
        return;
      }
      // Confirm FIRST while still following (visible), then flip the switch:
      // flipping first would freeze this very confirm below the viewport
      // (appendTurns freezes busy appends once off). Already-held views stay
      // held; the next busy append freezes a following view via appendTurns.
      pushInfo("(autoscroll off — the view freezes while a turn runs; End follows the latest)");
      setAutoScrollBoth(false);
      return;
    }
    pushInfo(AUTOSCROLL_USAGE);
  }

  // /models: local-discovery status + refresh. Bare `/models` reports the
  // last snapshot (kicking a first probe when discovery never ran);
  // `/models refresh` re-probes all three runtimes, then reports. Results
  // merge into the models cache, so the /model picker serves them with no
  // extra fetches — one dim summary line, never transcript spam.
  async function runModelsCommand(arg: string): Promise<void> {
    const a = arg.trim().toLowerCase();
    if (a !== "" && a !== "refresh") {
      pushInfo("usage: /models [refresh] — probe local model servers (Ollama, LM Studio, llama.cpp).");
      return;
    }
    // Manual Kilo refresh: clear the gateway catalog cache and re-fetch.
    // The current model sticks when still listed; otherwise the fresh
    // catalog's preferred free model wins (never a hardcoded id).
    if (providerRef.current === "kilo" && a === "refresh") {
      pushInfo("(refreshing Kilo model catalog…)");
      clearKiloModelsCache();
      try {
        const res = await fetchModelsForProviderWithStatus("kilo", keyForProvider("kilo"), "", endpoint);
        if (res.ok) modelsCacheRef.current.set(modelsCacheKey("kilo"), [...res.models]);
        setModels(res.models);
        if (!res.models.includes(modelRef.current)) {
          setModelBoth(preferFreeKiloModel(res.models, modelRef.current));
        }
        pushInfo(
          `Kilo models refreshed: ${res.models.length} available${res.ok ? "" : " (offline list)"}.`
        );
      } catch {
        pushInfo("Kilo models refresh failed — keeping the current list.");
      }
      return;
    }
    if (localSnapRef.current.version === 0 || a === "refresh") {
      pushInfo("(probing local model servers…)");
      try {
        const snap = await localDiscoveryRef.current.refresh();
        applyLocalSnapshot(snap);
      } catch {
        // Discovery never rejects (per-provider isolation); defensive only.
      }
    }
    pushInfo(summarizeLocalSnapshot(localSnapRef.current));
  }

  function runSlashCommand(cmd: string) {
    setInputBoth("");
    switch (cmd) {
      case "/exit":
      case "/quit":
        persistSession();
        exit();
        return;
      case "/clear":
        // Task 6: same base as mount (no AGENTS.md re-read, as before) plus a
        // fresh env block. Fresh array → fresh ledger via trackHistory.
        historyRef.current = trackHistory([
          { role: "system", content: withEnvBlock(systemPrompt) },
        ]);
        setTurnsBoth([]);
        // List replacement re-follows a held view (the frozen end no longer
        // exists — render clamping would follow the window but leave a
        // stale held indicator).
        setScrollEndBoth(null);
        setClearGen((g) => g + 1);
        setError(null);
        setDraft(null);
        clearThinking();
        setToolHint(null);
        setPhase("idle");
        setPhaseDetail("");
        // /clear drops the transcript: load resets (no context), streak
        // resets, pending compact drains, and turn-scoped skill grants go
        // with it (no invisible auto-approvals survive a wiped transcript).
        // usageTotals + effort intentionally
        // kept: token totals and effort are per-session (see /help).
        // autoDisabled stays for the session (thrash guard is session-wide).
        skillGrantsRef.current = new Set();
        // Lineage rule (see src/rollback.ts): the fresh history invalidates
        // checkpoint marks, so /rewind undos never cross a cleared
        // conversation. Silent when there was nothing to drop.
        const clearedDrops = clearSnapshots();
        if (clearedDrops > 0) {
          pushInfo(
            `(/clear — discarded ${clearedDrops} file checkpoint(s); undos do not cross a cleared conversation)`
          );
        }
        // autoDisabled stays for the session (thrash guard is session-wide).
        lastPromptTokensRef.current = undefined;
        setContextLoadBoth(null);
        autoStreakRef.current = 0;
        pendingCompactRef.current = null;
        telemetry.recordEvent("clear", "conversation cleared (token totals kept)");
        persistTelemetry();
        void refreshSkillMenu();
        return;
      case "/new":
        // Claude-Code semantics: end the current conversation and start
        // fresh in the same process while the old one stays restorable via
        // /resume. Save FIRST (the pre-/new conversation is what /resume
        // restores — same path/format as every completed turn, no new
        // schema). No sessions/ archive step: session.ts only has
        // session.json, so no archiving is invented here.
        persistSession();
        // Fresh system re-read (system.ts base + current AGENTS.md overlay)
        // plus a fresh Task 6 env block. Fresh array → fresh ledger.
        historyRef.current = trackHistory([
          { role: "system", content: withEnvBlock(buildSystemPrompt()) },
        ]);
        setTurnsBoth([
          {
            role: "tool",
            content: "(new session started — previous conversation kept, /resume to restore it)",
          },
        ]);
        // Fresh list: a held view has nothing to hold onto — re-follow.
        setScrollEndBoth(null);
        setClearGen((g) => g + 1);
        setError(null);
        setDraft(null);
        clearThinking();
        setToolHint(null);
        setPhase("idle");
        setPhaseDetail("");
        // /new-vs-/clear split: /clear wipes the transcript but KEEPS usage
        // totals; /new resets the counters too (fresh conversation). Session
        // SETTINGS (effort/mode/provider/model) are kept — only the
        // conversation + counters reset.
        setUsageBoth(null);
        lastPromptTokensRef.current = undefined;
        setContextLoadBoth(null);
        // Fresh conversation: the session checklist restarts too.
        clearTodos();
        setTodoSnap([]);
        skillGrantsRef.current = new Set();
        // New lineage (see src/rollback.ts): yesterday's checkpoint marks
        // cannot index the fresh history — drop them, loudly when non-empty.
        const newDrops = clearSnapshots();
        if (newDrops > 0) {
          pushInfo(
            `(/new — discarded ${newDrops} file checkpoint(s); undos do not cross sessions)`
          );
        }
        // Compaction state restarts fresh (unlike /clear, where the thrash
        // guard stays disabled for the session).
        autoStreakRef.current = 0;
        setAutoDisabledBoth(false);
        pendingCompactRef.current = null;
        telemetry.recordEvent("new", "fresh conversation started (previous kept for /resume)");
        persistTelemetry();
        void refreshSkillMenu();
        return;
      case "/compact":
        // Bare /compact with no focus text (slash-menu path). Free-text
        // "/compact focus…" is handled in submit (prefix match) so focus
        // text survives; both funnel to the same busy/pending logic below.
        void runCompactCommand("");
        return;
      case "/model": {
        // Unified picker opens unfiltered with the highlight on the current
        // model (active provider's section first, so same-provider rises
        // stay index-stable when other keyed providers add sections below).
        // Late lifecycle: if discovery never ran (slow/no startup probe),
        // kick it now so local sections fill in behind the open picker.
        if (localSnapRef.current.version === 0) kickLocalDiscovery();
        setModelFilterBoth("");
        const entries = buildModelEntries();
        const at = entries.findIndex(
          (e) => e.providerId === providerRef.current && e.model === modelRef.current
        );
        setSelIndexBoth(Math.max(0, at));
        setSelecting(true);
        setSelectingEffort(false);
        setSelectingProvider(false);
        setKeyPromptBoth(null);
        setBaseURLPromptBoth(null);
        return;
      }
      case "/provider":
        openProviderPicker();
        return;
      case "/effort":
        setEffortIndexBoth(Math.max(0, EFFORT_OPTIONS.indexOf(effortRef.current)));
        setSelectingEffort(true);
        setSelecting(false);
        setSelectingProvider(false);
        setKeyPromptBoth(null);
        setBaseURLPromptBoth(null);
        return;
      case "/tools":
        pushInfo(toolsListText());
        return;
      case "/skills":
        // Searchable picker (names only, type to filter, Enter loads).
        // Local reads only — zero fetches, like the model picker.
        openSkillPicker();
        return;
      case "/skill":
        pushInfo(SKILL_USAGE);
        return;
      case "/context":
        pushInfo(buildContextText());
        return;
      case "/queue":
        runQueueCommand("/queue");
        return;
      case "/steer":
        runQueueCommand("/steer");
        return;
      case "/thinking":
        runThinkingCommand("/thinking");
        return;
      case "/autoscroll":
        runAutoScrollCommand("/autoscroll");
        return;
      case "/mode":
        if (modeRef.current === "plan") {
          pushInfo("mode: plan (read-only — write/edit/bash blocked with a replan note; Tab to approve + exit)");
          return;
        }
        pushInfo(
          trustAllRef.current
            ? `mode: ${modeRef.current}+trust (write/edit/bash auto-approved; /trust revokes)`
            : `mode: ${modeRef.current}`
        );
        return;
      case "/trust": {
        // Plan is a deliberate safety mode: trust must not punch through it.
        // The flag is left untouched so exiting plan restores prior behavior.
        if (modeRef.current === "plan") {
          pushInfo("(plan mode is read-only — Tab out of plan before /trust; trust unchanged)");
          return;
        }
        const next = !trustAllRef.current;
        setTrustAllBoth(next);
        pushInfo(
          next
            ? "trust: on — write/edit/bash auto-approved this session (/trust again revokes; audit lines still render)"
            : "trust: off — write/edit/bash ask again"
        );
        return;
      }
      case "/yolo":
      case "/plan": {
        // Retired: Tab is the only mode switcher (it cycles
        // normal → yolo → plan → normal). Kept as explicit cases so typing
        // them explains instead of falling through to skill lookup.
        pushInfo("(retired — Tab cycles the permission mode: normal → yolo → plan → normal)");
        return;
      }
      case "/help":
        pushInfo(helpListText());
        return;
      case "/allow":
      case "/deny":
      case "/rules":
        // Bare exact match (slash-menu Enter on a partial prefix lands here):
        // usage for the add commands, the list for /rules.
        runRulesCommand(cmd);
        return;
      case "/resume":
        doResume();
        return;
      case "/telemetry":
        pushInfo(telemetrySummaryText());
        return;
      case "/dashboard": {
        const out = writeTelemetryDashboard(authHome);
        pushInfo(
          out
            ? `(observability dashboard written to ${out} — open it in a browser. Local file, nothing uploaded.)`
            : "(dashboard failed to write — telemetry store unavailable)"
        );
        return;
      }
      case "/rewind": {
        // Idle-only like every slash command except /compact (submit's busy
        // guard already routes here only when idle): restoring mid-turn would
        // race the loop's own history writes.
        const cps = listCheckpoints();
        if (cps.length === 0) {
          pushInfo("(no checkpoints yet — every write/edit snapshots automatically)");
          return;
        }
        pendingRewindRef.current = null;
        setRewindIndexBoth(cps.length - 1);
        setSelectingRewind(true);
        setSelecting(false);
        setSelectingEffort(false);
        setSelectingProvider(false);
        setKeyPromptBoth(null);
        setBaseURLPromptBoth(null);
        return;
      }
      default:
        return;
    }
  }

  // approve hook for runAgenticLoop: scoped rules first (deny refuses as a
  // standard "no" — pre-execution, model-visible denial result, audit line
  // via the untouched onToolActivity path — and wins over everything below,
  // including plan mode); plan mode second (mutations flow to the execute
  // gate, which refuses with a replan note — never a prompt here, so
  // allow/yolo/trust/always/skill grants cannot punch through); then allow,
  // yolo, session trust (/trust or [t]), and always-allowed tools run without
  // prompting; otherwise an Ink y/a/t/n prompt resolves the promise.
  // The promise also rejects with LoopCancelledError when the turn is
  // cancelled (Ctrl+C aborts the controller), so a cancel unblocks the loop
  // as a whole-turn cancel — never as a one-call denial.
  async function approve(name: string, args: Record<string, unknown>): Promise<ApprovalDecision> {
    if (turnCancelRef.current?.signal.aborted) throw new LoopCancelledError();
    // Stage the transcript-diff preview for write/edit (all outcomes):
    // the modal below reuses it, and onToolActivity consumes it when the
    // matching execution commits. Deny/cancel paths clear it (execution
    // never happens, so nothing must linger for a later call). Full-file
    // BEFORE is captured here (pre-execution); AFTER resolves at commit
    // (write content arg, or a post-execution disk read for edit).
    const stagedDiff = name === "write" || name === "edit" ? previewDiffForApproval(name, args) : null;
    if (name === "write" || name === "edit") {
      const toolPath = typeof args["path"] === "string" ? (args["path"] as string) : null;
      const beforeFull =
        name === "write"
          ? (stagedDiff?.oldText ?? null) // preview already pre-read it: no second read
          : toolPath !== null
            ? readFileForDiff(path.resolve(process.cwd(), toolPath))
            : null;
      const afterArg =
        name === "write" && typeof args["content"] === "string"
          ? (args["content"] as string)
          : null;
      pendingDiffRef.current = { name, path: toolPath, beforeFull, afterArg, diff: stagedDiff };
    }
    // Policy layer owns the decision order (deny → plan → allow → yolo →
    // trust → always → skill grants → prompt); this function owns cancel
    // handling and the interactive prompt plumbing around it.
    const outcome = decidePolicy(name, args, {
      mode: modeRef.current,
      trustAll: trustAllRef.current,
      rules: rulesRef.current,
      alwaysAllowed: alwaysAllowedRef.current,
      skillGrants: skillGrantsRef.current,
      approvalGated: needsApproval(name),
    });
    if (outcome.kind === "deny") {
      pendingDiffRef.current = null;
      return "no";
    }
    if (outcome.kind === "allow") return "once";
    const signal = turnCancelRef.current?.signal ?? null;
    if (signal?.aborted) {
      pendingDiffRef.current = null;
      throw new LoopCancelledError();
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      approvalResolveRef.current = { resolve, reject };
      setApproveIndexBoth(0);
      setPendingApproval({ name, args, diff: stagedDiff });
      if (signal) {
        const onAbort = () => {
          const h = approvalResolveRef.current;
          approvalResolveRef.current = null;
          setPendingApproval(null);
          pendingDiffRef.current = null;
          h?.reject(new LoopCancelledError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function resolveApproval(decision: ApprovalDecision) {
    if (decision === "always" && pendingApproval) {
      alwaysAllowedRef.current.add(pendingApproval.name);
    }
    if (decision === "no") pendingDiffRef.current = null;
    const h = approvalResolveRef.current;
    approvalResolveRef.current = null;
    setPendingApproval(null);
    h?.resolve(decision);
  }

  // Trust-all from the approval prompt ([t]): approve this call and every
  // later write/edit/bash this session. Resolves as "once" (ApprovalDecision
  // is untouched — no zen.ts change); later calls skip the prompt via the
  // trustAllRef short-circuit in approve() above.
  function resolveTrustAll() {
    setTrustAllBoth(true);
    const h = approvalResolveRef.current;
    approvalResolveRef.current = null;
    setPendingApproval(null);
    h?.resolve("once");
  }

  // Plan-mode execute gate (ticket 04): the approve() plan branch above routes
  // write/edit/bash here with "once"; this refuses them pre-execution with a
  // replan-friendly result — never a prompt (approve never asked), never
  // silent (the ⚙ audit line + ↳ error line still render via the untouched
  // onToolActivity path). Starts with "Error:" so the loop's bookkeeping
  // treats it as unexecuted (no verification-gate arming, like denials).
  // Everything else delegates to the real executor untouched.
  function guardedExecute(name: string, args: Record<string, unknown>): Promise<string> {
    if (modeRef.current === "plan" && needsApproval(name)) {
      return Promise.resolve(
        `Error: plan mode is read-only — ${name} blocked (no writes while planning). ` +
          `Explore with read/grep/glob/web tools, record the plan with todowrite, then Tab out of plan mode to implement.`
      );
    }
    return executeTool(name, args);
  }

  // askUser hook for runAgenticLoop: modal select, resolved by the useInput
  // handler below (pick / custom text / Esc-cancel rejection). Ctrl+C aborts
  // the turn controller and rejects with LoopCancelledError (whole-turn
  // cancel), distinct from the Esc question-cancel result.
  async function askUser(
    question: string,
    options: string[],
    allowCustom?: boolean
  ): Promise<string> {
    const signal = turnCancelRef.current?.signal ?? null;
    if (signal?.aborted) throw new LoopCancelledError();
    return new Promise<string>((resolve, reject) => {
      askResolveRef.current = { resolve, reject };
      setAskSelIndexBoth(0);
      setAskCustomBoth("");
      setPendingQuestion({ question, options, allowCustom: allowCustom === true });
      if (signal) {
        const onAbort = () => {
          const h = askResolveRef.current;
          askResolveRef.current = null;
          setPendingQuestion(null);
          setAskCustomBoth("");
          h?.reject(new LoopCancelledError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function resolveAsk(answer: string) {
    const h = askResolveRef.current;
    askResolveRef.current = null;
    setPendingQuestion(null);
    setAskCustomBoth("");
    h?.resolve(answer);
  }

  function cancelAsk() {
    const h = askResolveRef.current;
    askResolveRef.current = null;
    setPendingQuestion(null);
    setAskCustomBoth("");
    h?.reject(new Error("question cancelled by user"));
  }

  // Submit-time pipeline (ticket 02 — stage order is SUBMIT_PIPELINE_STAGES
  // above; each `SUBMIT STAGE n/4` marker below names its stage plus its
  // rollback-scope rule). Local "/" routing precedes the pipeline: exact
  // slash commands, /allow-/deny-/rules, and skill invocations never enter
  // it (no turn, no history, nothing to roll back).
  async function submit(value: string) {
    const text = value.trim();
    setInputBoth("");
    // /compact with optional focus text: prefix match ("/compact" or
    // "/compact focus…"). Busy → pending flag, run at turn end (drain
    // boundary, never mid-turn); idle → run now. This precedes the busy
    // guard so the pending flag can be set mid-turn.
    if (text === "/compact" || text.startsWith("/compact ")) {
      const focus = text === "/compact" ? "" : text.slice("/compact".length).trim();
      if (busyRef.current) {
        pendingCompactRef.current = focus;
        return;
      }
      await runCompactCommand(focus);
      return;
    }
    // SUBMIT STAGE 1/4 — permissions (rollback scope: pre-turn, appends
    // nothing). Busy guard + API-key check: rejections return before any
    // history mutation, so there is nothing to roll back.
    if (!text) return;
    // Busy: plain follow-ups queue instead of submitting (Claude-Code-style —
    // the thought is never lost); /queue + /steer manage and inject. Other
    // "/" input still needs idle (pickers/modals would race the turn), so it
    // drops silently exactly as before.
    if (busyRef.current) {
      if (
        text === "/queue" || text.startsWith("/queue ") ||
        text === "/steer" || text.startsWith("/steer ")
      ) {
        runQueueCommand(text);
        return;
      }
      // /autoscroll and /thinking are view-only state (never touch the
      // turn), so they run while busy like /queue + /steer (see
      // slashRunsWhileBusy).
      if (text === "/autoscroll" || text.startsWith("/autoscroll ")) {
        runAutoScrollCommand(text);
        return;
      }
      if (text === "/thinking" || text.startsWith("/thinking ")) {
        runThinkingCommand(text);
        return;
      }
      if (text.startsWith("/")) return;
      if (queueRef.current.length >= QUEUE_CAP) {
        pushInfo(`(queue full — ${QUEUE_CAP} pending; /queue lists, /queue clear wipes)`);
        return;
      }
      setQueueBoth([...queueRef.current, text]);
      return;
    }
    // Queue + steer routing (idle): exact or free-text forms, mirroring the
    // /allow pattern above — SLASH_NAMES only holds exact commands.
    if (
      text === "/queue" || text.startsWith("/queue ") ||
      text === "/steer" || text.startsWith("/steer ")
    ) {
      runQueueCommand(text);
      return;
    }
    // /autoscroll takes an optional subcommand (/autoscroll on|off), like the
    // /queue family — SLASH_NAMES only holds the exact command. /thinking
    // is bare-toggle-only; anything appended prints its usage.
    if (text === "/autoscroll" || text.startsWith("/autoscroll ")) {
      runAutoScrollCommand(text);
      return;
    }
    if (text === "/thinking" || text.startsWith("/thinking ")) {
      runThinkingCommand(text);
      return;
    }
    // Scoped rules (ticket 03): exact or free-text forms (/allow bash:x,
    // /rules clear) route with args intact — SLASH_NAMES only holds exact
    // commands, and the skill fallback below must not swallow these.
    if (
      text === "/allow" || text.startsWith("/allow ") ||
      text === "/deny" || text.startsWith("/deny ") ||
      text === "/rules" || text.startsWith("/rules ")
    ) {
      runRulesCommand(text);
      return;
    }
    // /models takes an optional subcommand (/models refresh), like the
    // /allow family — SLASH_NAMES only holds exact commands.
    if (text === "/models" || text.startsWith("/models ")) {
      const arg = text === "/models" ? "" : text.slice("/models ".length);
      void runModelsCommand(arg);
      return;
    }
    // Exact full-command + Enter runs it. A single-token "/name" not in
    // SLASH_NAMES resolves through the skill registry (ticket 03, legacy
    // form — the namespaced `/skill:name` below is canonical); anything
    // else starting with "/" still falls through as a model message.
    if (SLASH_NAMES.has(text)) {
      runSlashCommand(text);
      return;
    }
    // Retired commands explain instead of falling through to skill lookup.
    if (text === "/yolo" || text === "/plan") {
      runSlashCommand(text);
      return;
    }
    // Namespaced skill invocation: `/skill:name` (bare `/skill` shows usage
    // via the registry path above). Resolves through the same registry as
    // the legacy `/name` form and the slash menu.
    if (text === "/skill" || text === "/skill:") {
      pushInfo(SKILL_USAGE);
      return;
    }
    const namespaced = /^\/skill:([A-Za-z0-9_-]+)$/.exec(text)?.[1];
    if (namespaced !== undefined) {
      void invokeSkillByName(namespaced);
      return;
    }
    const skillName = /^\/([A-Za-z0-9_-]+)$/.exec(text)?.[1];
    if (skillName !== undefined) {
      void invokeSkillByName(skillName);
      return;
    }
    // Missing key: guide to /provider instead of POSTing (local runtimes
    // and Kilo need no key — Kilo serves anonymous free models; a
    // known-unreachable server fails fast with a clear error instead of a
    // bare connection error mid-turn). Owner-gated (see keyForProvider).
    const submitKey = keyForProvider(providerRef.current);
    const submitLocalNotice = localUnreachableNotice(providerRef.current);
    if (submitLocalNotice) {
      setError(submitLocalNotice);
      return;
    }
    if (!submitKey && providerNeedsKey(providerRef.current)) {
      setError(
        `Missing API key for ${providerRef.current} — run /provider to paste one (stored in ~/.atom/auth.json).`
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setDraft(null);
    clearThinking();
    // Fresh turn, fresh latch: the queue drain at the end auto-sends only
    // when this turn was NOT cancelled (see the turn-end finally).
    turnCancelledRef.current = false;
    // NOTE: skill grants are NOT cleared here — a manually armed skill
    // (loaded while idle) must survive into the turn it was armed for.
    // Expiry happens in the turn-end finally below, plus /clear + /new.
    try {
      draftThrottler().reset();
    } catch {
      // ignore (first token still paints; at worst one window late)
    }
    setToolHint(null);
    setPhase("thinking");
    setPhaseDetail("");
    // Phase 5: start the elapsed/stall timer (status-bar only, never the
    // transcript). Cleared in finally below and on unmount.
    startTurnTimer();
    // Display-only tool clock: no tool is running at turn start, so any
    // stale timestamp from a previous turn must not leak into this one.
    toolStartRef.current = null;
    // Same for the transcript-diff slot: a previous turn's unconsumed
    // preview (cancelled mid-execution) must never attach to this turn.
    pendingDiffRef.current = null;
    lastPartialRef.current = "";
    refreshGitInfo();
    // SUBMIT STAGE 2/4 — context-assembly (rollback scope: pre-rollbackTo,
    // survives failure). Refresh the pinned env block ONCE per turn (not per
    // POST — the loop reuses history[0] for all its POSTs, so this is the
    // only git call for the turn). Before the budget check so truncation
    // accounts for the fresh block size; before rollbackTo so the refresh
    // survives a failed-turn rollback (it is not part of the user turn).
    refreshSystemEnv();
    // SUBMIT STAGE 3/4 — budget-check (rollback scope: pre-rollbackTo,
    // survives failure). History budget at turn start, BEFORE the push +
    // rollbackTo capture below (so the existing splice-rollback indices stay
    // valid): drop oldest user-turns first, reserving room for the incoming user message
    // so the loop core's own budget check stays a no-op on entry - exactly
    // one dim notice per truncating turn. /clear drops the notice with the
    // transcript (usage totals still survive). Caps come from the session
    // ContextManager (window-derived), with the same live todo pinning.
    contextManager().trimForSend(
      historyRef.current,
      (msg) => {
        appendTurns({ role: "tool", content: `? ${msg}` });
      },
      { messages: 1, chars: text.length },
      openTodoNeedles()
    );
    // SUBMIT STAGE 4/4 — loop-entry (rollback scope: post-rollbackTo, rolls
    // back on failure). Turn boundary: on POST failure (HTTP/network/empty/
    // truncated) the whole user turn (user message plus any partial
    // assistant/tool loop entries) is removed, so the next request starts
    // clean — same guarantee as the old single-pop. The streaming draft
    // lives outside `turns` until commit, so rollback just clears it (see
    // catch). Cancellation (LoopCancelledError) shares the same splice
    // contract.
    const rollbackTo = historyRef.current.length;
    // Local observability: open this turn's trace (no-op when disabled).
    // Provider/model switches surface here per turn; session-level switches
    // are derived from the same updates (see setSessionMeta).
    telemetry.setSessionMeta({ provider: providerRef.current, model: modelRef.current });
    const telemetryTurnId = telemetry.startTurn(text, {
      provider: providerRef.current,
      model: modelRef.current,
      effort: effortRef.current,
      mode: modeRef.current,
    });
    const telemetrySink: LoopTelemetrySink = {
      onModelCall: (info) => telemetry.recordModelCall(telemetryTurnId, info),
      onToolCall: (info) => telemetry.recordToolCall(telemetryTurnId, info),
    };
    const controller = new AbortController();
    turnCancelRef.current = controller;
    historyRef.current.push({ role: "user", content: text });
    appendTurns({ role: "user", content: text });
    // Skill auto-invoke (ticket 04, progressive disclosure): deterministic
    // whole-word match over a fresh registry with a high bar (3 distinct
    // word hits, at most 1 skill per turn), inside the rollback scope so a
    // failed turn removes skill context too. Slash invocations skip it
    // (manual path owns those). Auto loads Tier 2 only (body, no inlined
    // references, 12KB cap — see activateSkill), so a trigger can never flood
    // the window. Discovery/loading never throw; the guard only protects
    // submit itself.
    if (!text.startsWith("/")) {
      try {
        // Registry refresh: stat-level revalidation (cheap), then the pure
        // deterministic match over metadata — no LLM, no body reads.
        const found = await skillRegistry.refresh();
        for (const info of matchSkills(text, resolveSkills(found.skills).skills, {
          max: 1,
          minHits: 3,
          wholeWords: true,
        })) {
          await activateSkill(info, { auto: true });
        }
      } catch {
        // ignore (a skill hiccup must never break submit)
      }
    }
    try {
      const baseURL = chatBaseURL(providerRef.current);
      const reply = await runAgenticLoopForProvider(
        providerRef.current,
        submitKey,
        modelRef.current,
        historyRef.current,
        {
        approve,
        askUser,
        // Local observability sink: the loop reports completed model/tool
        // calls (iterations, durations, usage) into the open turn trace.
        telemetry: telemetrySink,
        // Loop-harness rollup: per-turn LoopStats (cache hits, guard hits,
        // bottleneck, context growth) attach to the same open turn trace.
        // Fires once per turn — including failed/cancelled turns, whose
        // endTurn below still records the outcome alongside these stats.
        onLoopStats: (s) => telemetry.recordLoopStats(telemetryTurnId, s),
        // Plan-mode read-only gate (ticket 04): mutations are refused here
        // with a replan note; every other tool delegates to executeTool.
        execute: guardedExecute,
        reasoningEffort: effortRef.current,
        baseURL,
        endpointOverride: activeEndpoint,
        onToken: (partial) => {
          try {
            draftThrottler().push(partial);
          } catch {
            setDraft(partial);
          }
          lastPartialRef.current = partial;
          noteTurnActivity();
        },
        onThinking: (partial) => {
          thinkingRef.current = partial;
          setThinking(partial);
          noteTurnActivity();
        },
        onPhase: (p, detail) => {
          setPhase(p);
          setPhaseDetail(detail ?? "");
          noteTurnActivity();
          if (p === "thinking") {
            // New POST: the previous round's thinking (if any) commits to
            // the transcript so it stays in the TUI instead of being
            // replaced and lost; the fresh round streams into the live block.
            commitThinking();
          } else if (p === "tool" && detail) {
            setToolHint(detail);
            toolStartRef.current = clockNow();
          } else if (p === "retry") {
            const msg = detail ? `↻ retrying… ${detail}` : "↻ retrying…";
            appendTurns({ role: "tool", content: msg });
            // Local observability: transport retries attach to the model call
            // they precede (the recorder buffers them until it completes).
            telemetry.recordRetry(telemetryTurnId, detail ?? "");
          } else if (p === "done") {
            setToolHint(null);
            flushDraft();
          }
        },
        onToolDelta: (name) => {
          setToolHint(name);
          toolStartRef.current = clockNow();
        },
        onUsage: (u) => {
          // Local observability: per-turn usage accumulates inside the
          // recorder when the loop reports the completed model call (same
          // payload) — recording it here too would count every POST twice.
          // Cumulative session spend from REAL reports only: every reporting
          // POST accumulates (tool-round POSTs and successful retries each
          // count once — each was billed; failed attempts report nothing, so
          // nothing is deduped). usageTotals drives NK only, never P%.
          const prev = usageRef.current ?? {};
          const next: Usage = { ...prev };
          if (u.prompt_tokens !== undefined) {
            next.prompt_tokens = (next.prompt_tokens ?? 0) + u.prompt_tokens;
            // Load metric source: last POST's reported prompt_tokens (the
            // per-POST value, NOT the accumulated total).
            lastPromptTokensRef.current = u.prompt_tokens;
          }
          if (u.completion_tokens !== undefined) {
            next.completion_tokens = (next.completion_tokens ?? 0) + u.completion_tokens;
          }
          if (u.total_tokens !== undefined) {
            next.total_tokens = (next.total_tokens ?? 0) + u.total_tokens;
          }
          // Prefix-cache counters accumulate like spend (real reports only;
          // absent fields mean "not reported", never zero).
          if (u.cacheReadTokens !== undefined) {
            next.cacheReadTokens = (next.cacheReadTokens ?? 0) + u.cacheReadTokens;
          }
          if (u.cacheWriteTokens !== undefined) {
            next.cacheWriteTokens = (next.cacheWriteTokens ?? 0) + u.cacheWriteTokens;
          }
          setUsageBoth(next);
        },
        onReasoning: (label) => {
          setReasoning(label);
        },
        onWarning: (msg) => {
          appendTurns({ role: "tool", content: `⚠ ${msg}` });
        },
        // Steering seam: drains one pending /steer message into history +
        // transcript at each loop step boundary (see drainSteer in zen.ts).
        // The message joins the turn's fate — a failed turn rolls it back
        // with everything else (same splice contract as the user turn).
        drainSteer: () => {
          const s = steerRef.current;
          if (!s) return;
          steerRef.current = null;
          setSteerPending(null);
          historyRef.current.push({ role: "user", content: s });
          appendTurns({ role: "user", content: s });
        },
        onToolActivity: (label, result, isError) => {
          // Display-only duration: wall time since the tool started (see
          // toolStartRef). Attached as Turn.ms for the `· Ns` suffix; the
          // label text itself stays byte-identical to the loop's audit line.
          const started = toolStartRef.current;
          toolStartRef.current = null;
          const ms = started !== null ? Math.max(0, clockNow() - started) : 0;
          const items: Turn[] = [{ role: "tool", content: label, ms }];
          // Inspector retention (display-only): keep the full result for
          // later browsing. Capped count; stored text char-capped inside
          // the record with an explicit truncation flag.
          toolLogRef.current.push(createToolRecord(toolSeqRef.current++, label, result, isError, ms));
          if (toolLogRef.current.length > MAX_TOOL_RECORDS) {
            toolLogRef.current.splice(0, toolLogRef.current.length - MAX_TOOL_RECORDS);
          }
          // Todo tools are session state, not side effects: their results
          // are short checklists, so successful ones join the transcript
          // (history fidelity — what did the list look like when?) and
          // refresh the live <TodoPanel> snapshot below the transcript.
          const isTodo =
            label === "⚙ todo_get" ||
            label.startsWith("⚙ todowrite ") ||
            label.startsWith("⚙ todo_update ");
          if (isTodo) setTodoSnap(getTodos());
          if (isError) {
            const firstLine = result.split("\n", 1)[0] ?? result;
            items.push({ role: "tool", content: `  ↳ ${firstLine}`, error: true });
          } else if (isTodo) {
            items.push({ role: "tool", content: result });
          }
          // Committed transcript diff: the approve-time capture for this
          // exact execution rides on the label turn. Consume-or-clear on
          // every matching activity (success or failure) so a stale
          // capture can never leak onto a later call; render only on
          // success with a real payload (failures keep the ↳ line only).
          // Full-file BEFORE→AFTER is preferred (aligned panes with
          // context); when either side is unavailable (unreadable file,
          // oversize), fall back to the arg-block preview pair.
          const slot = pendingDiffRef.current;
          if (
            slot !== null &&
            (label === `⚙ ${slot.name}` || label.startsWith(`⚙ ${slot.name} `))
          ) {
            pendingDiffRef.current = null;
            if (!isError) {
              let afterFull: string | null = null;
              if (slot.name === "write") {
                afterFull = slot.afterArg;
              } else if (slot.path !== null) {
                afterFull = readFileForDiff(path.resolve(process.cwd(), slot.path));
              }
              const beforeFull = slot.beforeFull;
              if (beforeFull !== null && afterFull !== null) {
                items[0]!.diff = {
                  oldText: beforeFull,
                  newText: afterFull,
                  lang: slot.diff?.lang ?? null,
                  path: slot.path,
                };
              } else if (slot.diff !== null) {
                items[0]!.diff = slot.diff;
              }
            }
          }
          appendTurns(...items);
          noteTurnActivity();
        },
        signal: controller.signal,
        // Window-aware trim caps for this model's real window (the loop
        // falls back to legacy caps without it — see AgenticOpts.context).
        context: {
          model: modelRef.current,
          toolsChars: TOOLS_SCHEMA_CHARS,
        },
      });
      // Turn-end flush: any trailing throttled partial paints before the
      // commit replaces the draft (byte-exact via `reply` regardless). The
      // final round's thinking commits first (chronological: reasoning, then
      // the answer it produced).
      flushDraft();
      commitThinking();
      appendTurns({ role: "assistant", content: reply });
      // The turn committed to history (final text, denial-as-result, or
      // stop-notice) — persist the kill-safe save. Rolled-back turns (catch
      // below) never reach here, so a failure can't clobber the last good save.
      persistSession();
      // Local observability: close the turn trace with the loop's own outcome
      // labels (completed / blocked / unverified / budget-exceeded) and flush.
      telemetry.endTurn(telemetryTurnId, classifyTurnOutcome(reply), reply);
      persistTelemetry();
      // Drain boundary (still busy, never mid-turn): pending manual /compact
      // first (it resets the thrash counter), else auto-compact when the
      // load is over threshold. Compaction persists via the normal save path.
      if (pendingCompactRef.current !== null) {
        const focus = pendingCompactRef.current;
        pendingCompactRef.current = null;
        await doCompact(focus, false);
        // A /compact that arrived during the compaction above drains now.
        if (pendingCompactRef.current !== null) {
          const focus2 = pendingCompactRef.current;
          pendingCompactRef.current = null;
          await doCompact(focus2, false);
        }
      } else {
        await maybeAutoCompact();
        if (pendingCompactRef.current !== null) {
          const focus = pendingCompactRef.current;
          pendingCompactRef.current = null;
          await doCompact(focus, false);
        }
      }
    } catch (err) {
      const cancelled =
        err instanceof LoopCancelledError ||
        (err instanceof Error && err.name === "LoopCancelledError") ||
        controller.signal.aborted;
      historyRef.current.splice(rollbackTo); // don't keep the failed/cancelled turn
      turnCancelledRef.current = cancelled;
      // The turn never happened: drop live thinking with it (a failed turn
      // commits nothing — same scope as the history rollback above).
      clearThinking();
      // Local observability: failed/cancelled turns still record what was
      // attempted (model/tool calls so far) with their outcome, then flush.
      // Like the save above, the telemetry file only ever gains completed
      // turn traces plus these explicit failure markers — never partial
      // transcript state.
      telemetry.endTurn(
        telemetryTurnId,
        cancelled ? "cancelled" : "failed",
        err instanceof Error ? err.message : String(err)
      );
      persistTelemetry();
      if (cancelled) {
        // One dim line (tool role renders dim); not an error.
        // Rolled back above: no save, the last good save stays intact.
        // The line states the rollback scope outright (see src/rollback.ts):
        // conversation only — disk and processes were NOT reverted.
        appendTurns({ role: "tool", content: cancelledTurnLine() });
      } else {
        // Failed (not cancelled): the streamed answer so far is committed
        // as a marked partial turn BEFORE the error. Without this, a rate
        // limit or dead network after 30s of streaming wipes everything the
        // user already read. History stays rolled back (model never sees
        // it); only the display transcript keeps the partial.
        const partial = lastPartialRef.current.trim();
        lastPartialRef.current = "";
        if (partial) {
          appendTurns({
            role: "assistant",
            content: `${partial}\n\n(request failed before completing — partial output preserved)`,
          });
        }
        setError(err instanceof Error ? err.message : String(err));
      }
      // Turn-end drain even after failure/rollback: pending manual still
      // runs (it applies to the surviving history); auto never fires here
      // (load is meaningless for a rolled-back turn — just refresh it).
      if (pendingCompactRef.current !== null) {
        const focus = pendingCompactRef.current;
        pendingCompactRef.current = null;
        try {
          await doCompact(focus, false);
        } catch {
          // doCompact never throws (it reports inline), but stay safe.
        }
      } else {
        refreshContextLoad();
      }
    } finally {
      turnCancelRef.current = null;
      approvalResolveRef.current = null;
      setPendingApproval(null);
      // Safety net: the slot is normally consumed by onToolActivity or
      // cleared on deny/cancel — never let it cross a turn boundary.
      pendingDiffRef.current = null;
      askResolveRef.current = null;
      setPendingQuestion(null);
      setAskCustomBoth("");
      // Turn-scoped skill grants expire here: armed-while-idle and auto
      // skills cover exactly the turn that just ended (success, failure,
      // or cancel) — the next user message starts clean (ticket 06).
      skillGrantsRef.current = new Set();
      busyRef.current = false;
      setBusy(false);
      refreshGitInfo();
      try {
        draftThrottleRef.current?.cancel();
      } catch {
        // ignore
      }
      setDraft(null);
      clearThinking();
      setToolHint(null);
      clearTurnTimer();
      setStalled(false);
      setElapsedSecs(0);
      setPhase("idle");
      setPhaseDetail("");
      // Queue drain (Claude-Code-style): a clean turn auto-sends the next
      // queued follow-up (chaining while the queue is non-empty); a cancelled
      // turn keeps its queue visible but never auto-sends. A steer stranded
      // by a failed/cancelled turn rejoins the queue front — the thought is
      // preserved, the user decides when it runs. Runs after busy resets
      // above so the chained submit enters a clean turn.
      const stranded = steerRef.current;
      if (stranded) {
        steerRef.current = null;
        setSteerPending(null);
        setQueueBoth([stranded, ...queueRef.current]);
      }
      if (!turnCancelledRef.current && queueRef.current.length > 0) {
        const next = queueRef.current[0]!;
        setQueueBoth(queueRef.current.slice(1));
        void submit(next);
      }
    }
  }

  function cancelTurn() {
    // Interrupt safety: stop after the current tool finishes (the loop
    // checks the signal before each new POST/execution), roll the partial
    // turn back, show `(cancelled)`, and clear busy/draft/modals.
    try {
      turnCancelRef.current?.abort();
    } catch {
      // ignore
    }
  }

  useInput((ch, key) => {
    // Raw Ctrl+C / Ctrl+D bytes (ink-testing-library sends "\x03"/"\x04").
    const rawCancel = ch === "\u0003" || ch === "\u0004";
    const ctrlCancel =
      (key.ctrl && (ch === "c" || ch === "d" || ch === "C" || ch === "D")) || rawCancel;
    if (ctrlCancel) {
      // Inspector open (idle): Ctrl+C closes it — never exits the app from
      // inside the inspector.
      if (inspectingRef.current) {
        closeInspector();
        return;
      }
      // Mid-turn: cancel the whole turn (works during POST wait, tool
      // execution, and the approval/question modals). Idle: exit as before.
      if (turnCancelRef.current || busyRef.current) {
        cancelTurn();
        return;
      }
      persistSession();
      exit();
      return;
    }
    if (key.ctrl && (ch === "c" || ch === "d")) {
      persistSession();
      exit();
      return;
    }
    // 1. Tool approval prompt (normal mode): arrows + Enter select
    // (highlight starts at allow-once), y = once, a = always this
    // session, t = trust all write/edit/bash this session, n/Esc = deny
    // (denial feeds back into the loop as a result).
    // Ctrl+C (handled above) cancels the whole turn instead.
    if (pendingApproval) {
      if (key.upArrow) {
        setApproveIndexBoth((approveIndexRef.current + 3) % 4);
        return;
      }
      if (key.downArrow) {
        setApproveIndexBoth((approveIndexRef.current + 1) % 4);
        return;
      }
      if (key.return) {
        const i = approveIndexRef.current;
        if (i === 1) resolveApproval("always");
        else if (i === 2) resolveTrustAll();
        else if (i === 3) resolveApproval("no");
        else resolveApproval("once");
        return;
      }
      const k = (ch ?? "").toLowerCase();
      if (k === "y") resolveApproval("once");
      else if (k === "a") resolveApproval("always");
      else if (k === "t") resolveTrustAll();
      else if (k === "n" || key.escape) resolveApproval("no");
      return;
    }
    // 2. ask_question modal: arrows + Enter picks, typing + Enter submits
    // custom text (allowCustom only), Esc cancels.
    if (pendingQuestion) {
      const len = Math.max(pendingQuestion.options.length, 1);
      if (key.upArrow) {
        setAskSelIndexBoth((askSelIndexRef.current - 1 + len) % len);
      } else if (key.downArrow) {
        setAskSelIndexBoth((askSelIndexRef.current + 1) % len);
      } else if (key.escape) {
        cancelAsk();
      } else if (key.return || key.tab) {
        if (pendingQuestion.allowCustom && askCustomRef.current.trim().length > 0) {
          resolveAsk(askCustomRef.current);
        } else {
          const picked = pendingQuestion.options[askSelIndexRef.current];
          if (picked !== undefined) resolveAsk(picked);
        }
      } else if (key.backspace || key.delete) {
        if (pendingQuestion.allowCustom) {
          setAskCustomBoth(askCustomRef.current.slice(0, -1));
        }
      } else if (ch && !key.ctrl && !key.meta && !key.tab) {
        if (pendingQuestion.allowCustom) {
          setAskCustomBoth(askCustomRef.current + ch);
        }
      }
      return;
    }
    // 2b. Provider key prompt (masked • per char, paste works, Esc safe).
    const kp = keyPromptRef.current;
    if (kp && keyPrompt) {
      if (key.escape) {
        // Existing key: Esc keeps + switches. No existing: Esc back to picker.
        if (kp.existingMasked) {
          const keep = keyForProvider(kp.providerId);
          setKeyPromptBoth(null);
          if (keep) {
            void switchProviderWithKey(kp.providerId, keep);
          } else {
            openProviderPicker();
          }
        } else {
          openProviderPicker();
        }
        return;
      }
      if (key.return) {
        const draft = kp.draft;
        if (kp.validating || busy) return;
        // Kilo keys are optional: empty Enter continues anonymously on
        // free models (Esc also works — see above).
        if (!draft) {
          if (kp.providerId === "kilo") {
            const keep = keyForProvider(kp.providerId);
            setKeyPromptBoth(null);
            void switchProviderWithKey(kp.providerId, keep);
            return;
          }
          return;
        }
        const baseURL = getStoredBaseURL(authRef.current, kp.providerId);
        setKeyPromptBoth({ ...kp, validating: true, error: null });
        void validateProviderKey(kp.providerId, draft, baseURL).then((res) => {
          const cur = keyPromptRef.current;
          if (!cur || cur.providerId !== kp.providerId) return;
          if (res.ok) {
            const next = setStoredKey(authRef.current, kp.providerId, draft);
            setAuthBoth(next);
            try {
              saveAuth(next, authHome);
            } catch {
              // ignore disk errors (in-memory switch still applies)
            }
            setKeyPromptBoth(null);
            void switchProviderWithKey(kp.providerId, draft);
          } else {
            // Failure: inline error, stay put for retry (Esc/back safe).
            setKeyPromptBoth({
              ...cur,
              validating: false,
              error: res.error ?? "validation failed",
            });
          }
        });
        return;
      }
      if (key.backspace || key.delete) {
        if (!kp.validating) {
          setKeyPromptBoth({ ...kp, draft: kp.draft.slice(0, -1), error: null });
        }
        return;
      }
      if (ch && !key.ctrl && !key.meta && !key.tab && !kp.validating) {
        setKeyPromptBoth({ ...kp, draft: kp.draft + ch, error: null });
        return;
      }
      return;
    }
    // 2c. Provider baseURL prompt (openai-compatible, plain text, http(s)).
    const bp = baseURLPromptRef.current;
    if (bp && baseURLPrompt) {
      if (key.escape) {
        openProviderPicker();
        return;
      }
      if (key.return) {
        const draft = bp.draft.trim();
        const invalid = validateBaseURL(draft);
        if (invalid) {
          setBaseURLPromptBoth({ ...bp, error: invalid });
          return;
        }
        const prev = authRef.current.providers[bp.providerId];
        const next = setStoredKey(
          authRef.current,
          bp.providerId,
          prev?.apiKey ?? "",
          draft
        );
        setAuthBoth(next);
        try {
          saveAuth(next, authHome);
        } catch {
          // ignore
        }
        setBaseURLPromptBoth(null);
        // BaseURL saved: if a key is on file, switch; else prompt the key.
        const existing = keyForProvider(bp.providerId);
        if (existing) {
          void switchProviderWithKey(bp.providerId, existing);
        } else {
          openKeyPrompt(bp.providerId);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setBaseURLPromptBoth({ ...bp, draft: bp.draft.slice(0, -1), error: null });
        return;
      }
      if (ch && !key.ctrl && !key.meta && !key.tab) {
        setBaseURLPromptBoth({ ...bp, draft: bp.draft + ch, error: null });
        return;
      }
      return;
    }
    // 2d. Provider picker (✓ key / — no key markers, ↑/↓ + Enter, Esc).
    if (selectingProvider) {
      if (key.upArrow) {
        setProviderIndexBoth(
          (providerIndexRef.current - 1 + PROVIDERS.length) % PROVIDERS.length
        );
      } else if (key.downArrow) {
        setProviderIndexBoth((providerIndexRef.current + 1) % PROVIDERS.length);
      } else if (key.escape) {
        setSelectingProvider(false);
      } else if (key.return) {
        const picked = PROVIDERS[providerIndexRef.current % PROVIDERS.length];
        if (!picked) {
          setSelectingProvider(false);
        } else if (
          picked.id === "openai-compatible" &&
          !getStoredBaseURL(authRef.current, picked.id)
        ) {
          openBaseURLPrompt(picked.id);
        } else if (picked.id === "kilo" && !keyForProvider(picked.id)) {
          // Kilo without a key: offer the optional key prompt — anonymous
          // free models stay one (empty) Enter away inside it.
          openKeyPrompt(picked.id);
        } else if (!providerNeedsKey(picked.id)) {
          // Local runtime (or keyed Kilo): no key to paste — switch
          // straight in (standard switch path refreshes its model list
          // in the background).
          setSelectingProvider(false);
          void switchProviderWithKey(picked.id, keyForProvider(picked.id));
        } else {
          // No key -> paste prompt; key on file -> replace prompt
          // (masked hint; typing replaces, Esc keeps + switches).
          openKeyPrompt(picked.id);
        }
      }
      return;
    }
    // 3. Model picker (unified cross-provider list, type-to-filter, windowed;
    // opening it replaces/closes the slash menu; Esc returns to plain input,
    // never to the slash menu).
    if (selecting) {
      // Rebuilt per keypress from the same render's state the paint uses, so
      // highlight/filter/paint never disagree mid-tick.
      const entries = filterModelEntries(buildModelEntries(), modelFilterRef.current);
      if (key.upArrow) {
        if (entries.length > 0) {
          setSelIndexBoth(
            (selIndexRef.current - 1 + entries.length) % entries.length
          );
        }
      } else if (key.downArrow) {
        if (entries.length > 0) {
          setSelIndexBoth((selIndexRef.current + 1) % entries.length);
        }
      } else if (key.escape) {
        setModelFilterBoth("");
        setSelecting(false);
      } else if (key.return) {
        const picked = entries[selIndexRef.current];
        setModelFilterBoth("");
        if (picked) {
          if (picked.providerId === providerRef.current) {
            setModelBoth(picked.model);
            // Model switch resets the load latch (different tokenizer: the old
            // reported prompt_tokens no longer measures this context); the
            // estimate applies until the new model reports.
            resetContextLoadToEstimate();
            // Re-gate effort on every /model switch: setting persists, but a
            // non-Default effort on an unsupported model warns (kept, not sent).
            if (effortRef.current !== "default" && !isEffortSupported(picked.model)) {
              warnEffortUnsupported(picked.model);
            }
          } else {
            // Cross-provider pick: switch with the resolved key (env wins,
            // else stored — remote sections only render for keyed providers;
            // local sections need no key) and keep the picked model; the
            // live refresh lands in the background via the standard switch
            // path. reasoning_effort is zen-only, so a non-Default effort
            // warns (kept, not sent).
            const switchedKey = keyForProvider(picked.providerId);
            if (switchedKey || !providerNeedsKey(picked.providerId)) {
              const pickedProvider = picked.providerId;
              const pickedModel = picked.model;
              void (async () => {
                await switchProviderWithKey(pickedProvider, switchedKey, pickedModel);
                if (effortRef.current !== "default") {
                  warnEffortUnsupported(pickedModel);
                }
              })();
            }
          }
        }
        setSelecting(false);
      } else if (key.backspace || key.delete) {
        setModelFilterBoth(modelFilterRef.current.slice(0, -1));
        setSelIndexBoth(0);
      } else if (ch && !key.ctrl && !key.meta && !key.tab) {
        setModelFilterBoth(modelFilterRef.current + ch);
        setSelIndexBoth(0);
      }
      return;
    }
    // 3a. Skills picker (searchable popup, same pattern as /model, but
    // selection STAGES for confirm: type to filter, ↑/↓ + Enter/Tab puts
    // `/skill:name` into the input (nothing is sent), Esc cancels.
    // Backspace edits the filter.
    if (selectingSkills) {
      // Rebuilt per keypress from the same render's state the paint uses, so
      // highlight/filter/paint never disagree mid-tick.
      const entries = filterSkillPicker(skillPickerItems, skillFilterRef.current);
      if (key.upArrow) {
        if (entries.length > 0) {
          setSkillIndexBoth(
            (skillIndexRef.current - 1 + entries.length) % entries.length
          );
        }
      } else if (key.downArrow) {
        if (entries.length > 0) {
          setSkillIndexBoth((skillIndexRef.current + 1) % entries.length);
        }
      } else if (key.escape) {
        setSkillFilterBoth("");
        setSelectingSkills(false);
      } else if (key.return || key.tab) {
        const picked = entries[skillIndexRef.current];
        const name = picked?.name;
        setSkillFilterBoth("");
        setSelectingSkills(false);
        // Stage for confirm, never auto-send: the exact command lands in the
        // input and a second Enter runs it through the normal submit path
        // (exact `/skill:name` executes). Model-only entries refuse there,
        // same as a typed /skill:name.
        if (name) {
          exitHistoryBrowse();
          setInputBoth(`/skill:${name}`);
        }
      } else if (key.backspace || key.delete) {
        setSkillFilterBoth(skillFilterRef.current.slice(0, -1));
        setSkillIndexBoth(0);
      } else if (ch && !key.ctrl && !key.meta && !key.tab) {
        setSkillFilterBoth(skillFilterRef.current + ch);
        setSkillIndexBoth(0);
      }
      return;
    }
    // 3b. Effort picker (/effort): same keyboard pattern as the /model
    // picker (↑/↓ + Enter, Esc cancels).
    if (selectingEffort) {
      if (key.upArrow) {
        setEffortIndexBoth(
          (effortIndexRef.current - 1 + EFFORT_OPTIONS.length) % EFFORT_OPTIONS.length
        );
      } else if (key.downArrow) {
        setEffortIndexBoth(
          (effortIndexRef.current + 1) % EFFORT_OPTIONS.length
        );
      } else if (key.escape) {
        setSelectingEffort(false);
      } else if (key.return) {
        const picked = EFFORT_OPTIONS[effortIndexRef.current];
        if (picked) {
          setEffortBoth(picked);
          if (picked !== "default" && !isEffortSupported(modelRef.current)) {
            warnEffortUnsupported(modelRef.current);
          }
        }
        setSelectingEffort(false);
      }
      return;
    }
    // 3c. /rewind pickers (ticket 01): checkpoint list, then restore scope
    // (↑/↓ + Enter, Esc cancels each step). The scope step runs the restore.
    if (selectingRewind) {
      const cps = listCheckpoints();
      if (cps.length === 0) {
        setSelectingRewind(false);
      } else if (key.upArrow) {
        setRewindIndexBoth(
          (rewindIndexRef.current - 1 + cps.length) % cps.length
        );
      } else if (key.downArrow) {
        setRewindIndexBoth((rewindIndexRef.current + 1) % cps.length);
      } else if (key.escape) {
        setSelectingRewind(false);
      } else if (key.return) {
        const picked = cps[rewindIndexRef.current % cps.length];
        setSelectingRewind(false);
        if (picked) {
          pendingRewindRef.current = picked.id;
          setRewindScopeIndexBoth(0);
          setSelectingRewindScope(true);
        }
      }
      return;
    }
    if (selectingRewindScope) {
      if (key.upArrow) {
        setRewindScopeIndexBoth(
          (rewindScopeIndexRef.current - 1 + REWIND_SCOPES.length) % REWIND_SCOPES.length
        );
      } else if (key.downArrow) {
        setRewindScopeIndexBoth(
          (rewindScopeIndexRef.current + 1) % REWIND_SCOPES.length
        );
      } else if (key.escape) {
        setSelectingRewindScope(false);
        pendingRewindRef.current = null;
      } else if (key.return) {
        const id = pendingRewindRef.current;
        const scope = REWIND_SCOPES[rewindScopeIndexRef.current % REWIND_SCOPES.length];
        setSelectingRewindScope(false);
        pendingRewindRef.current = null;
        if (id && scope) {
          void runRewind(id, scope);
        }
      }
      return;
    }
    // 4. "/" slash menu (filter-as-you-type): commands first, then matching
    // skills as namespaced `/skill:name` entries. ↑/↓ + Enter/Tab runs the
    // highlighted entry, Esc dismisses back to plain input. Single-line only:
    // a newline anywhere means free text (slash commands never span lines).
    const cur = inputRef.current;
    const menu =
      !slashDismissedRef.current && cur.startsWith("/") && !cur.includes("\n")
        ? buildSlashMenu(cur, skillMenu)
        : { items: [], moreSkills: 0 };
    const matches = menu.items;
    if (matches.length > 0) {
      if (key.leftArrow) {
        setCursorBoth(cursorRef.current - 1);
      } else if (key.rightArrow) {
        setCursorBoth(cursorRef.current + 1);
      } else if (key.home) {
        setCursorBoth(0);
      } else if (key.end) {
        setCursorBoth(inputRef.current.length);
      } else if (key.upArrow) {
        setSlashIndexBoth(
          (slashIndexRef.current - 1 + matches.length) % matches.length
        );
      } else if (key.downArrow) {
        setSlashIndexBoth((slashIndexRef.current + 1) % matches.length);
      } else if (key.escape) {
        setSlashDismissedBoth(true);
      } else if (key.return || key.tab) {
        const pick = matches[slashIndexRef.current % matches.length];
        // /compact, /queue, /steer, and /autoscroll run while busy (see
        // slashRunsWhileBusy); every other entry still waits idle.
        if (pick && (slashRunsWhileBusy(pick.name) || !busyRef.current)) {
          if (pick.skill) {
            // Skill entries stage for confirm (opencode-style): Enter/Tab
            // completes `/skill:name` into the input — nothing is sent.
            // A second Enter on the exact text runs it; a fully typed
            // `/skill:name` or legacy `/name` runs immediately (unambiguous).
            const staged = `/skill:${pick.skill}`;
            const typed = inputRef.current.trim();
            if (typed === staged || typed === `/${pick.skill}`) {
              setInputBoth("");
              void invokeSkillByName(pick.skill);
            } else {
              setInputBoth(staged);
            }
          } else if (pick.name === "/compact" && inputRef.current.startsWith("/compact ")) {
            // Preserve free-text focus when the menu is open on a prefix.
            const focus = inputRef.current.slice("/compact".length).trim();
            setInputBoth("");
            void runCompactCommand(focus);
          } else if (
            pick.name === "/autoscroll" &&
            (inputRef.current === "/autoscroll" || inputRef.current.startsWith("/autoscroll "))
          ) {
            // Preserve the on/off arg when the menu is open on a prefix
            // (bare highlighted name alone would drop it).
            const raw = inputRef.current;
            setInputBoth("");
            runAutoScrollCommand(raw);
          } else if (
            (pick.name === "/allow" || pick.name === "/deny" || pick.name === "/rules") &&
            inputRef.current.startsWith(pick.name)
          ) {
            // Preserve the typed rule args (e.g. "/allow bash:npm test*");
            // a bare highlighted name falls through to usage/list.
            const raw = inputRef.current;
            setInputBoth("");
            runRulesCommand(raw);
          } else {
            runSlashCommand(pick.name);
          }
        }
      } else if (key.backspace || key.delete) {
        if (key.delete && !key.backspace) {
          deleteAtCursor();
        } else {
          backspaceAtCursor();
        }
      } else if (ch && !key.ctrl && !key.meta && !key.tab) {
        insertAtCursor(ch);
      }
      return;
    }
    // 4b. Esc stops a running response (opencode-style session_interrupt):
    // busy with every modal/menu/picker above dismissed → cancel the whole
    // turn, exactly like Ctrl+C (rollback + dim `(cancelled)`). The input
    // line is kept, not cleared, so a typed follow-up survives.
    if (key.escape && (turnCancelRef.current || busyRef.current)) {
      cancelTurn();
      return;
    }
    // 4c. Tool-output inspector (read-only: safe in any mode incl. plan).
    // Ctrl+O toggles when fully idle (no turn, modal, or picker open);
    // arrows/Enter/Esc drive it while open. Inspector keys never reach the
    // input, and input keys never reach the inspector.
    if (key.ctrl && (ch === "o" || ch === "O")) {
      if (
        !busyRef.current && !turnCancelRef.current &&
        !pendingApproval && !pendingQuestion &&
        !selecting && !selectingSkills && !selectingProvider &&
        !keyPrompt && !baseURLPrompt && !selectingEffort &&
        !selectingRewind && !selectingRewindScope
      ) {
        if (inspectingRef.current) closeInspector();
        else openInspector();
      }
      return;
    }
    if (inspectingRef.current) {
      const last = Math.max(0, toolLogRef.current.length - 1);
      if (key.escape) {
        if (inspectExpandedRef.current) {
          setInspectExpandedBoth(false);
          setInspectScrollBoth(0);
        } else {
          closeInspector();
        }
      } else if (key.return) {
        setInspectExpandedBoth(!inspectExpandedRef.current);
        setInspectScrollBoth(0);
      } else if (key.upArrow) {
        if (inspectExpandedRef.current) {
          setInspectScrollBoth(Math.max(0, inspectScrollRef.current - 1));
        } else if (inspectIndexRef.current > 0) {
          setInspectIndexBoth(inspectIndexRef.current - 1);
        }
      } else if (key.downArrow) {
        if (inspectExpandedRef.current) {
          setInspectScrollBoth(inspectScrollRef.current + 1);
        } else if (inspectIndexRef.current < last) {
          setInspectIndexBoth(inspectIndexRef.current + 1);
        }
      } else if (key.pageUp) {
        if (inspectExpandedRef.current) {
          setInspectScrollBoth(Math.max(0, inspectScrollRef.current - VIEWPORT_LINES));
        } else {
          setInspectIndexBoth(Math.max(0, inspectIndexRef.current - 5));
        }
      } else if (key.pageDown) {
        if (inspectExpandedRef.current) {
          setInspectScrollBoth(inspectScrollRef.current + VIEWPORT_LINES);
        } else {
          setInspectIndexBoth(Math.min(last, inspectIndexRef.current + 5));
        }
      }
      return;
    }
    // 4d. Command palette (Ctrl+P toggles; Ctrl+K stays kill-to-end).
    // Opens over idle or busy turns alike (no modal/picker/inspector may be
    // open); Enter runs through the shared busy-gate, so only
    // compact/queue/steer fire while busy.
    if (key.ctrl && (ch === "p" || ch === "P")) {
      if (
        !pendingApproval && !pendingQuestion &&
        !selecting && !selectingSkills && !selectingProvider &&
        !keyPrompt && !baseURLPrompt && !selectingEffort &&
        !selectingRewind && !selectingRewindScope && !inspecting
      ) {
        if (paletteOpenRef.current) closePalette();
        else openPalette();
      }
      return;
    }
    if (paletteOpenRef.current) {
      const entries = paletteEntries(paletteFilterRef.current);
      if (key.escape) {
        closePalette();
      } else if (key.return) {
        const pick = entries[paletteIndexRef.current];
        if (pick && (slashRunsWhileBusy(pick.name) || !busyRef.current)) {
          const name = pick.name;
          closePalette();
          runSlashCommand(name);
        }
      } else if (key.upArrow) {
        if (entries.length > 0) {
          setPaletteIndexBoth(
            (paletteIndexRef.current - 1 + entries.length) % entries.length
          );
        }
      } else if (key.downArrow) {
        if (entries.length > 0) {
          setPaletteIndexBoth((paletteIndexRef.current + 1) % entries.length);
        }
      } else if (key.backspace) {
        setPaletteFilterBoth(paletteFilterRef.current.slice(0, -1));
        setPaletteIndexBoth(0);
      } else if (ch && !key.ctrl && !key.meta && !key.tab && ch !== "\n") {
        setPaletteFilterBoth(paletteFilterRef.current + ch);
        setPaletteIndexBoth(0);
      }
      return;
    }
    // 5. Plain input (multiline-aware). Tab toggles normal<->yolo here;
    // when the "/" slash menu is open (section 4 above) Tab instead runs the
    // highlighted command and never reaches this branch. Enter ALWAYS sends
    // (even multiline); Ctrl+J (ch "\n") inserts a newline. ↑/↓ move between
    // lines, falling through to history recall at the first/last line.
    if (key.leftArrow) {
      setCursorBoth(cursorRef.current - 1);
    } else if (key.rightArrow) {
      setCursorBoth(cursorRef.current + 1);
    } else if (key.pageUp) {
      // Transcript scrollback (idle and busy alike): PgUp holds the view —
      // the window freezes and the growing draft/thinking blocks collapse
      // to one static line, so the terminal stops yanking mid-turn and
      // scrollback stays readable. End (or PgDn at the bottom) follows
      // again; /clear, /resume, /new, and rewind-truncate re-follow too.
      setScrollEndBoth(
        applyScrollAction(scrollEndRef.current, turnsRef.current.length, { kind: "pageUp" })
      );
    } else if (key.pageDown) {
      setScrollEndBoth(
        applyScrollAction(scrollEndRef.current, turnsRef.current.length, { kind: "pageDown" })
      );
    } else if (key.home && inputRef.current.length === 0) {
      setScrollEndBoth(
        applyScrollAction(scrollEndRef.current, turnsRef.current.length, { kind: "home" })
      );
    } else if (key.end && inputRef.current.length === 0) {
      setScrollEndBoth(
        applyScrollAction(scrollEndRef.current, turnsRef.current.length, { kind: "end" })
      );
    } else if (key.home || (key.ctrl && (ch === "a" || ch === "A"))) {
      const t = inputRef.current;
      const { line } = lineColOf(t, cursorRef.current);
      setCursorBoth(offsetOfLines(splitInputLines(t), line, 0));
    } else if (key.end || (key.ctrl && (ch === "e" || ch === "E"))) {
      const t = inputRef.current;
      const lines = splitInputLines(t);
      const { line } = lineColOf(t, cursorRef.current);
      setCursorBoth(offsetOfLines(lines, line, lines[line]!.length));
    } else if (key.upArrow) {
      moveOrRecall(-1);
    } else if (key.downArrow) {
      moveOrRecall(1);
    } else if (ch === "\n" || (key.ctrl && (ch === "j" || ch === "J"))) {
      insertAtCursor("\n");
    } else if (key.ctrl && (ch === "k" || ch === "K")) {
      const r = killToLineEnd(inputRef.current, cursorRef.current);
      exitHistoryBrowse();
      setInputAndCursor(r.text, r.offset);
    } else if (key.ctrl && (ch === "u" || ch === "U")) {
      const r = killToLineStart(inputRef.current, cursorRef.current);
      exitHistoryBrowse();
      setInputAndCursor(r.text, r.offset);
    } else if (key.ctrl && (ch === "w" || ch === "W")) {
      const r = killWordBefore(inputRef.current, cursorRef.current);
      exitHistoryBrowse();
      setInputAndCursor(r.text, r.offset);
    } else if (key.return) {
      pushInputHistory(inputRef.current);
      void submit(inputRef.current);
    } else if (key.tab) {
      // Tab is the only mode switcher: normal → yolo → plan → normal.
      // normal→yolo stays silent (the status line shows it); plan
      // transitions announce, since entering arms read-only mode and
      // exiting approves the recorded todowrite plan into implementation
      // (always landing in normal, never yolo — the checklist survives).
      const cur = modeRef.current;
      if (cur === "normal") {
        setModeBoth("yolo");
      } else if (cur === "yolo") {
        setModeBoth("plan");
        pushInfo(
          "plan mode: on — explore freely (read/grep/glob/web/todos/ask run free; write/edit/bash are blocked with a replan note). Record the plan with todowrite, then Tab to approve + exit into implementation."
        );
      } else {
        setModeBoth("normal");
        const planned = getTodos().length;
        pushInfo(
          planned > 0
            ? `(plan approved — ${planned} task(s) carry into implementation under normal permissions)`
            : "(plan mode off — no plan recorded)"
        );
      }
    } else if (key.delete && !key.backspace) {
      deleteAtCursor();
    } else if (key.backspace) {
      backspaceAtCursor();
    } else if (key.escape) {
      setInputBoth("");
    } else if (ch && !key.ctrl && !key.meta && !key.tab) {
      insertAtCursor(ch);
    }
  });

  // Bracketed paste (Ink enables `\x1b[?2004h` while active): pasted text —
  // including newlines — inserts at the cursor verbatim and NEVER submits,
  // so multiline pastes can't fire mid-paste. Separate channel from
  // useInput above. Active exactly when plain input is focused (idle or
  // busy queue-draft; never inside a modal, picker, or the inspector).
  usePaste(
    (text) => {
      insertAtCursor(normalizePaste(text));
    },
    {
      isActive:
        !pendingApproval &&
        !pendingQuestion &&
        !selecting &&
        !selectingSkills &&
        !selectingProvider &&
        !keyPrompt &&
        !baseURLPrompt &&
        !selectingEffort &&
        !selectingRewind &&
        !selectingRewindScope &&
        !inspecting,
    }
  );

  const phaseLabel =
    phase === "thinking" || phase === "idle"
      ? `thinking${theme.symbol.ellipsis}`
      : phase === "streaming"
        ? `streaming${theme.symbol.ellipsis}`
        : phase === "tool"
          ? phaseDetail
            ? `calling ${phaseDetail}${theme.symbol.ellipsis}`
            : `tool${theme.symbol.ellipsis}`
          : phase === "retry"
            ? phaseDetail
              ? `retrying${theme.symbol.ellipsis} ${phaseDetail}`
              : `retrying${theme.symbol.ellipsis}`
            : phase === "done"
              ? "done"
              : `thinking${theme.symbol.ellipsis}`;

  // Slash menu derived for render (mirrors the useInput computation above):
  // commands first, then matching skills as `/skill:name` entries.
  const slashMenu =
    !selecting &&
    !selectingSkills &&
    !selectingEffort &&
    !selectingProvider &&
    !keyPrompt &&
    !baseURLPrompt &&
    !pendingApproval &&
    !pendingQuestion &&
    !selectingRewind &&
    !selectingRewindScope &&
    !slashDismissed &&
    input.startsWith("/") &&
    !input.includes("\n")
      ? buildSlashMenu(input, skillMenu)
      : { items: [], moreSkills: 0 };
  const filteredSlash = slashMenu.items;
  const slashVisible = filteredSlash.length > 0;
  const slashHi =
    filteredSlash.length > 0 ? slashIndex % filteredSlash.length : 0;
  const slashHighlight =
    filteredSlash.length > 0 ? filteredSlash[slashHi]?.name : undefined;
  const slashWin = pickerWindow(filteredSlash.length, slashHi);
  const slashHasSkills = filteredSlash.some((c) => c.skill !== undefined);
  // Argument hint for the highlighted command (reused usage strings only).
  const slashUsage =
    filteredSlash.length > 0 && filteredSlash[slashHi]?.skill === undefined
      ? commandUsage(filteredSlash[slashHi]!.name)
      : null;

  // Unified /model picker derived for render (mirrors the useInput
  // computation above): full entries, filtered entries, clamped highlight,
  // and the visible window — the frame never grows past MODEL_PICKER_VISIBLE
  // rows no matter how many models providers list.
  const modelEntriesAll = selecting ? buildModelEntries() : [];
  const modelEntries = selecting ? filterModelEntries(modelEntriesAll, modelFilter) : [];
  const modelHi =
    modelEntries.length === 0 ? 0 : Math.max(0, Math.min(selIndex, modelEntries.length - 1));
  const modelWin = pickerWindow(modelEntries.length, modelHi);
  const modelTitle =
    `Atom — Select model (${modelEntries.length}` +
    (modelFilter ? ` of ${modelEntriesAll.length}, filter: "${modelFilter}"` : "") +
    `) — type to filter, up/down + Enter, Esc cancels:`;

  // /skills picker derived for render (mirrors the useInput computation
  // above): names only, filtered, clamped highlight, visible window. The
  // title keeps the `Skills (` prefix the registry header always had.
  const skillEntriesAll = selectingSkills ? skillPickerItems : [];
  const skillEntries = selectingSkills ? filterSkillPicker(skillEntriesAll, skillFilter) : [];
  const skillHi =
    skillEntries.length === 0 ? 0 : Math.max(0, Math.min(skillIndex, skillEntries.length - 1));
  const skillWin = pickerWindow(skillEntries.length, skillHi);
  const skillTitle =
    `Skills (${skillEntries.length}` +
    (skillFilter ? ` of ${skillEntriesAll.length}, filter: "${skillFilter}"` : "") +
    `) — type to filter, up/down + Enter, Esc cancels:`;

  // Memoized render derivations (flicker fix): these rebuild arrays on every
  // App render (token paints, keystrokes, 1s ticks), which defeats the memo
  // on the leaf panels below. Memoized, the leaves skip everything but real
  // changes. Checkpoint listing reads the snapshot dir — never per frame.
  const paletteEntriesMemo = useMemo(
    () => (paletteOpen ? paletteEntries(paletteFilter) : []),
    [paletteOpen, paletteFilter]
  );
  const checkpointListMemo = useMemo(
    () => (selectingRewind ? listCheckpoints() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectingRewind]
  );
  // (The cursor clamp lives inside the memoized InputBox now, next to its
  // only use — App body no longer reads cursor state for paint.)

  // Status-line reasoning segment wired to the effort session state:
  // non-Default shows the effort (plus " (unsupported)" when the model is
  // outside the verified-support set OR the provider is not opencode-zen);
  // Default shows response metadata or "default" as before.
  // reasoning_effort is sent ONLY for opencode-zen + supported model.
  const effortSupportedNow =
    effort === "default" ||
    (provider === "opencode-zen" && isEffortSupported(model));
  const reasoningDisplay =
    effort !== "default"
      ? effortSupportedNow
        ? effort
        : `${effort} (unsupported)`
      : (reasoning ?? "default");

  // Display-only live tool elapsed: wall-clock now ≈ turn start + elapsed
  // ticks (the 1s busy tick re-renders, so this stays fresh). Null when no
  // tool is running — the running line then paints with no duration.
  const toolElapsedSecs =
    busy && toolHint && toolStartRef.current !== null
      ? elapsedSecsSince(toolStartRef.current, turnStartRef.current + elapsedSecs * 1000)
      : null;

  return (
    <Box flexDirection="column">
      {/* Committed scrollback: banner art (once) + history/tool/warning lines.
          There is no persistent header block: the footer status line below is
          the sole info bar. TranscriptView is memoized so the 1s elapsed
          timer tick never re-renders the Static subtree. */}
      <TranscriptView turns={turns} clearGen={clearGen} end={scrollEnd} held={scrollEnd !== null} showThinking={showThinking} />
      {/* Live tail: empty hint + streaming draft + tool hint stay dynamic.
          Held view (scrolled up) freezes the growing draft/thinking blocks
          to one static line so the terminal stops yanking mid-turn. */}
      <LiveTail
        isEmpty={turns.length === 0}
        sessionHint={sessionHint}
        draft={draft}
        thinking={thinking}
        busy={busy}
        held={scrollEnd !== null}
        toolHint={toolHint}
        toolElapsedSecs={toolElapsedSecs}
        elapsedSecs={elapsedSecs}
        showThinking={showThinking}
      />
      {error ? <Text color={theme.color.error}>error&gt; {error}</Text> : null}
      {pendingApproval ? (
        <ApprovalBox
          toolName={pendingApproval.name}
          description={describeToolCall(pendingApproval.name, pendingApproval.args)}
          selected={approveIndex}
          diff={pendingApproval.diff ?? null}
        />
      ) : null}
      {pendingQuestion ? (
        <QuestionBox
          question={pendingQuestion.question}
          options={pendingQuestion.options}
          allowCustom={pendingQuestion.allowCustom}
          askCustom={askCustom}
          askSelIndex={askSelIndex}
        />
      ) : null}
      {/* The input box's top border is the single separator between the
          transcript and the interactive zone — no extra divider lines. */}
      {/* live session checklist (hidden when empty) */}
      <TodoPanel items={todoSnap} />
      {/* Follow-up queue + steer indicators (one dim line each, hidden when
          empty): the queued thought is never lost, and a pending steer shows
          until the running turn drains it at the next step boundary. */}
      {steerPending ? <Text dimColor>Steering: {steerPending}</Text> : null}
      {queue.length > 0 ? (
        <Text dimColor>
          Queued ({queue.length}): {queue[0]}
          {queue.length > 1 ? ` +${queue.length - 1} more (/queue)` : ""}
        </Text>
      ) : null}
      {paletteOpen ? (
        <PalettePanel
          entries={paletteEntriesMemo}
          index={paletteIndex}
          filter={paletteFilter}
        />
      ) : inspecting ? (
        <InspectorPanel
          records={toolLogRef.current}
          index={inspectIndex}
          expanded={inspectExpanded}
          scroll={inspectScroll}
        />
      ) : selecting ? (
        <PickerShell title={modelTitle}>
          <PickerMoreAbove count={modelWin.start} />
          {modelEntries.slice(modelWin.start, modelWin.end).map((e, k) => {
            const i = modelWin.start + k;
            const entryLocal = e.local === true;
            const prevLocal = i === 0 ? null : modelEntries[i - 1]?.local === true;
            const showGroup = i === 0 || prevLocal !== entryLocal;
            const showHeader =
              showGroup || modelEntries[i - 1]?.providerId !== e.providerId;
            const def = getProvider(e.providerId);
            return (
              <React.Fragment key={`${e.providerId}-${e.model}-${i}`}>
                {showGroup ? (
                  <Text dimColor>
                    {theme.symbol.descSeparator} {entryLocal ? "Local" : "Remote"}
                  </Text>
                ) : null}
                {showHeader ? (
                  <Text dimColor>
                    {theme.symbol.descSeparator} {def?.name ?? e.providerId}
                    {entryLocal && isLocalProviderId(e.providerId)
                      ? ` ${theme.symbol.separator} ${localBaseURLFor(e.providerId)}`
                      : null}
                    {e.providerId === provider ? " (current)" : ""}
                  </Text>
                ) : null}
                <PickerRow highlighted={i === modelHi}>
                  {e.model}
                  {e.free === true ? <Text dimColor> (free)</Text> : null}
                  {e.providerId === provider && e.model === model ? " (current)" : ""}
                </PickerRow>
              </React.Fragment>
            );
          })}
          <PickerMoreBelow count={modelEntries.length - modelWin.end} />
          {modelEntries.length === 0 ? (
            <Text dimColor>No models match — backspace to widen the filter.</Text>
          ) : null}
        </PickerShell>
      ) : selectingSkills ? (
        <PickerShell title={skillTitle}>
          <PickerMoreAbove count={skillWin.start} />
          {skillEntries.slice(skillWin.start, skillWin.end).map((e, k) => {
            const i = skillWin.start + k;
            return (
              <PickerRow key={`${e.name}-${i}`} highlighted={i === skillHi}>
                /skill:{e.name}
                {!e.userInvocable ? <Text dimColor> [auto-only]</Text> : null}
              </PickerRow>
            );
          })}
          <PickerMoreBelow count={skillEntries.length - skillWin.end} />
          {skillEntries.length === 0 ? (
            <Text dimColor>
              {skillEntriesAll.length === 0
                ? "No skills installed — add SKILL.md skills under .claude/skills/, .agents/skills/, or the ~/. counterparts."
                : "No skills match — backspace to widen the filter."}
            </Text>
          ) : null}
        </PickerShell>
      ) : selectingProvider ? (
        <PickerShell title="Atom — Select provider (up/down + Enter, Esc cancels):">
          {PROVIDERS.map((p, i) => {
            const has = keyForProvider(p.id).length > 0;
            const keyMark = isLocalProviderId(p.id)
              ? `local ${theme.symbol.descSeparator} no key needed`
              : has
                ? `${theme.symbol.keyPresent} key`
                : p.id === "kilo"
                  ? `${theme.symbol.descSeparator} key optional — free models need none`
                  : `${theme.symbol.descSeparator} no key`;
            return (
              <PickerRow key={p.id} highlighted={i === providerIndex}>
                {p.name} ({p.id}) {keyMark}
                {p.id === provider ? " (current)" : ""}
              </PickerRow>
            );
          })}
        </PickerShell>
      ) : keyPrompt ? (
        <Box
          flexDirection="column"
          borderStyle={theme.border.style}
          borderColor={theme.border.picker}
          paddingX={theme.spacing.pickerPadX}
        >
          <Text bold>
            Atom — API key for {keyPrompt.providerId} (paste + Enter, Esc cancels):
          </Text>
          {keyPrompt.consoleURL ? (
            <Text dimColor>Get a key: {keyPrompt.consoleURL}</Text>
          ) : null}
          {keyPrompt.existingMasked ? (
            <Text dimColor>
              key on file ({keyPrompt.existingMasked}) — type a new key to replace, Esc keeps + switches
            </Text>
          ) : (
            <Text dimColor>No key on file — paste once, validated then stored in ~/.atom/auth.json</Text>
          )}
          {keyPrompt.providerId === "kilo" ? (
            <Text dimColor>
              Optional: free models work without a key — empty Enter continues anonymously
            </Text>
          ) : null}
          <Text>
            key: {theme.symbol.keyMask.repeat(keyPrompt.draft.length)}
            <Text color={theme.color.mutedPaint}>{theme.symbol.cursorBlock}</Text>
          </Text>
          {keyPrompt.validating ? <Text dimColor>validating{theme.symbol.ellipsis}</Text> : null}
          {keyPrompt.error ? <Text color={theme.color.error}>{keyPrompt.error}</Text> : null}
        </Box>
      ) : baseURLPrompt ? (
        <Box
          flexDirection="column"
          borderStyle={theme.border.style}
          borderColor={theme.border.picker}
          paddingX={theme.spacing.pickerPadX}
        >
          <Text bold>
            Atom — baseURL for openai-compatible (http(s) URL + Enter, Esc cancels):
          </Text>
          <Text>
            baseURL: {baseURLPrompt.draft}
            <Text color={theme.color.mutedPaint}>{theme.symbol.cursorBlock}</Text>
          </Text>
          {baseURLPrompt.error ? <Text color={theme.color.error}>{baseURLPrompt.error}</Text> : null}
        </Box>
      ) : selectingEffort ? (
        <PickerShell title="Atom — Select reasoning effort (up/down + Enter, Esc cancels):">
          {EFFORT_OPTIONS.map((o, i) => (
            <PickerRow key={`${o}-${i}`} highlighted={i === effortIndex}>
              {o === "default" ? "Default" : o === "max" ? "Max" : o[0]?.toUpperCase() + o.slice(1)}
              {o === effort ? " (current)" : ""}
            </PickerRow>
          ))}
          <Text dimColor>Top is Max (sent as max); xhigh is not a verified value.</Text>
        </PickerShell>
      ) : selectingRewind ? (
        <PickerShell title="Atom — Rewind to checkpoint (up/down + Enter, Esc cancels):">
          {checkpointListMemo.map((c, i) => (
            <PickerRow key={c.id} highlighted={i === rewindIndex}>
              #{c.seq} {theme.symbol.separator} {c.label} {theme.symbol.separator} {c.files.length} file(s)
            </PickerRow>
          ))}
          <Text dimColor>Restores exact bytes (hash-verified). Shell side effects (bash) are never snapshotted and cannot be undone.</Text>
        </PickerShell>
      ) : selectingRewindScope ? (
        <PickerShell title="Atom — Rewind scope (up/down + Enter, Esc cancels):">
          {REWIND_SCOPES.map((s, i) => (
            <PickerRow key={s} highlighted={i === rewindScopeIndex}>
              {s}
            </PickerRow>
          ))}
          <Text dimColor>Shell side effects (bash) are explicitly out of scope and cannot be undone.</Text>
        </PickerShell>
      ) : (
        // The input is the one boxed, prominent surface (see the memoized
        // InputBox above): a quiet gray frame sets it apart from the
        // transcript above and the status line below. Pickers and modals
        // replace it (never stack with it), each carrying their own semantic
        // border color.
        <InputBox input={input} cursor={cursor} />
      )}
      {slashVisible && !inspecting && !paletteOpen ? (
        <PickerShell
          title={
            slashHasSkills
              ? `Atom commands + skills (${theme.symbol.moreAbove}/${theme.symbol.moreBelow} + Enter/Tab to run, Esc dismisses):`
              : `Atom commands (${theme.symbol.moreAbove}/${theme.symbol.moreBelow} + Enter/Tab to run, Esc dismisses):`
          }
          borderColor={theme.border.menu}
        >
          <PickerMoreAbove count={slashWin.start} />
          {filteredSlash.slice(slashWin.start, slashWin.end).map((c) => (
            <PickerRow
              key={c.name}
              highlighted={c.name === slashHighlight}
              highlightColor={theme.color.menuSelection}
            >
              {c.name}
              {c.description ? ` ${theme.symbol.descSeparator} ${c.description}` : ""}
            </PickerRow>
          ))}
          <PickerMoreBelow count={filteredSlash.length - slashWin.end} />
          {slashUsage ? <Text dimColor>{slashUsage}</Text> : null}
          {slashMenu.moreSkills > 0 ? (
            <Text dimColor>
              {theme.symbol.ellipsis}and {slashMenu.moreSkills} more skill{slashMenu.moreSkills === 1 ? "" : "s"} — keep
              typing to narrow
            </Text>
          ) : null}
        </PickerShell>
      ) : null}
      {/* sole info bar: provider · model · token · reasoning · mode (+ live phase/elapsed/waiting while busy).
          One inline paragraph (nested Texts) so narrow terminals wrap at word
          boundaries instead of splitting styled segments across lines. */}
      <StatusBar
        provider={provider}
        model={model}
        usageTotals={usageTotals}
        contextLoad={contextLoad}
        reasoningDisplay={reasoningDisplay}
        mode={mode}
        trustAll={trustAll}
        busy={busy}
        activity={toolHint ? activityText(toolHint) : null}
        phaseLabel={phaseLabel}
        elapsedSecs={elapsedSecs}
        stalled={stalled}
        approvalPending={pendingApproval !== null}
        cwd={shortenCwd(process.cwd(), os.homedir())}
        branch={gitInfo?.branch ?? null}
        columns={termColumns}
      />
    </Box>
  );
}
