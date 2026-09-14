// Ink (React) TUI for the minimal Atom chatbot.
// Hand-rolled input + dropdowns via useInput (no extra deps).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, usePaste } from "ink";
import {
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  LoopCancelledError,
  buildSystemPrompt,
  loadAgentsPrompt,
  fetchModelsForProviderWithStatus,
  fetchModelsWithStatus,
  historyChars,
  isEffortSupported,
  messageChars,
  normalizeEffort,
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
import { TOOL_DEFINITIONS, TOOL_ONE_LINERS, APPROVAL_PREVIEW_MAX_BYTES, clearTodos, describeToolCall, executeTool, getTodos, hydrateTodosForSession, needsApproval, previewDiffForApproval, providerSecrets, setActiveTodoSession, todowriteTool, type ApprovalDiff, type TodoItem } from "./tools.js";
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
import { decideApproval, skillGrantsFor, type ApprovalVia } from "./policy.js";
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
  emptyGoalStats,
  formatGoalForCompact,
  goalClearNotice,
  goalFollowUp,
  goalPauseNotice,
  goalResumeNotice,
  goalSetNotice,
  goalStatusText,
  goalTokensForUsage,
  parseGoalCommand,
  restoreGoalFromPersist,
  serializeGoalForPersist,
  type GoalState,
  type GoalStats,
} from "./goal.js";
import { requestGoalVerdict } from "./agent/goal-evaluator.js";
import {
  readSessionTodos,
  withSessionTodos,
} from "./todos.js";
import {
  collectTurnFileDiffs,
  emptyFileDiffs,
  FILE_DIFFS_METADATA_KEY,
  mergeFileDiffs,
  readFileDiffs,
  serializeFileDiffs,
} from "./file-diffs.js";
import {
  revertSessionToCheckpoint,
  type SessionRevertResult,
} from "./session-revert.js";
import {
  COMPACT_PCT_DEFAULT,
  buildCompactedHistory,
  collectStoredTouchedFiles,
  collectTouchedFiles,
  compactBoundaryLine,
  compactPct,
  compactPreserveRecentTokens,
  compactPruneEnabled,
  compactTailTurns,
  countUserTurns,
  estimateTokensForChars,
  fitSummaryWithFilesAndGoal,
  isSizeError,
  isThrashDisabled,
  requestCompactSummary,
  splitHistoryForCompaction,
  type SplitResult,
} from "./compact.js";
import { compactAutoEnabled, shouldAutoCompactReal, shouldCompactOnSizeError, shouldPreCompactForPending } from "./overflow.js";
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
import { SHELL_PLACEHOLDER, stripShellBang } from "./ui/shell.js";
import {
  mentionTriggerIndex,
  filterMentionCandidates,
  pruneMentions,
  buildMentionPool,
  listMentionFiles,
  listMentionFilesSync,
  expandMentionsForSubmit,
  type FileMention,
} from "./ui/mentions.js";
import {
  shouldCollapsePaste,
  pasteSummaryToken,
  pasteImageToken,
  containsBinary,
  prunePastedChunks,
  expandPastedSummaries,
  extractPastedPathCandidates,
  findExistingPastedPaths,
  type PastedChunk,
} from "./ui/paste.js";
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
import {
  createSession,
  ensureActiveSession,
  forkSession,
  getActiveSession,
  getActiveSessionId,
  getSession,
  listSessions,
  renameSession,
  setActiveSession,
  updateSession,
} from "./sessions.js";
import {
  discoverExtensionEntries,
  loadExtensions,
  resolveExtensionName,
  type ExtensionRuntime,
  type ExtensionSkipReason,
} from "./extensions.js";
import { formatExtensionStatusText } from "./extension-ui.js";
import {
  getExtensionCommand,
  listExtensionCommands,
  parseExtensionCommandInput,
  runExtensionCommand,
} from "./extension-commands.js";
import { loadAtomConfig } from "./config.js";
import { mcpWarnings } from "./mcp/manager.js";
import { useTerminalSize } from "./ui/layout.js";
import {
  grantProjectTrust,
  isProjectTrusted,
  projectTrustQuestion,
} from "./project-trust.js";
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
import { applyBeforeCompact, beforeCompactInterceptors, forgetReadFingerprint, refreshReadFingerprint } from "./tools.js";

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
import { LiveTailHost } from "./ui/live-host.js";
import {
  AppShell,
  CommandPalette,
  Composer,
  Conversation,
  ErrorMessage,
  PermissionPrompt,
  QuestionPrompt,
} from "./ui/components/index.js";
import {
  InspectorPanel,
  MAX_TOOL_RECORDS,
  VIEWPORT_LINES,
  createToolRecord,
  type ToolRecord,
} from "./ui/tool-inspector.js";
import { UsageLedgerPanel } from "./ui/usage-ledger.js";
import {
  recordUsageStep,
  stepsForSession,
  type UsageStep,
  type UsageStepKind,
} from "./usage-ledger.js";
import { activityText } from "./ui/activity.js";
import {
  IDLE_TOOL_CALL,
  toolCallDisplayName,
  transitionToolCall,
  type ToolCallEvent,
  type ToolCallMachine,
} from "./ui/tool-call-state.js";
import { deriveSummary, getToolKind, parseLabel } from "./ui/tool-model.js";
import type { PaletteCategory, PaletteEntry } from "./ui/palette.js";
import { PALETTE_CATEGORY_ORDER, PALETTE_HINTS, paletteCategory } from "./ui/palette.js";
import { PickerMoreAbove, PickerMoreBelow, PickerRow, PickerShell, pickerWindow } from "./ui/pickers.js";
import { shortenCwd } from "./ui/status-bar.js";
import { StatusBarHost } from "./ui/status-host.js";
import { createStreamStore } from "./ui/stream-store.js";
import { createPaintScheduler, type PaintScheduler } from "./ui/paint-scheduler.js";
import { theme } from "./ui/theme.js";
import { TodoPanel } from "./ui/todo-panel.js";
import { applyScrollAction, type Turn } from "./ui/transcript.js";
import { AgentCore } from "./agent/core.js";
import type { CoreHooks } from "./agent/core.js";
import { useAgentAdapter } from "./ui/agent-adapter.js";
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
  // Extension trust lockdown (ticket 07, from CLI flags via cli.tsx):
  // lockdown boots with zero third-party extensions; enable/disable are
  // repeatable name patterns that win over atom.json "extensions" when set.
  extensionsLockdown?: boolean;
  enableExtensions?: string[];
  disableExtensions?: string[];
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
  { name: "/model", description: "Open the model picker (/model <text> filters, /model refresh re-probes servers)." },
  { name: "/provider", description: "Pick AI provider, paste API key once, chat." },
  {
    name: "/effort",
    description:
      "Open the reasoning-effort picker (Auto/Low/Medium/High/Max; Auto lets the model decide).",
  },
  { name: "/tools", description: "List the tools with one-line descriptions." },
  { name: "/mcp", description: "Manage MCP servers (Space toggles enable/disable, Esc closes)." },
  { name: "/skill", description: "List skills in a picker, or invoke (/skill:name, /skill <name>)." },
  { name: "/mode", description: "Print the current permission mode (Tab cycles normal → yolo → plan)." },
  { name: "/trust", description: "Toggle session trust: auto-approve write/edit/bash without full yolo (/trust again revokes)." },
  { name: "/allow", description: "Pre-approve a tool pattern this session (e.g. /allow bash:npm test*)." },
  { name: "/deny", description: "Forbid a tool pattern this session — deny wins over trust/yolo (e.g. /deny bash:rm *)." },
  { name: "/rules", description: "List session allow/deny rules (/rules clear wipes them)." },
  { name: "/clear", description: "Clear the conversation history (keeps session token totals; drops file checkpoints)." },
  { name: "/new", description: "Start a brand-new session (full fresh conversation + counters reset, previous kept for /resume)." },
  { name: "/rename", description: "Rename the current session (/rename <name>)." },
  { name: "/compact", description: "Summarize older turns into one summary (optional focus text: /compact focus…)." },
  { name: "/context", description: "Show context usage by source (system, tools, history, skills)." },
  { name: "/queue", description: "List queued follow-ups (/queue clear wipes them)." },
  { name: "/steer", description: "Steer the running turn, or send when idle (/steer <text>)." },
  { name: "/autoscroll", description: "Toggle following new output (on by default; bare toggles, on|off sets it; off freezes the view mid-turn)." },
  { name: "/goal", description: "Set (and start working, like a normal message), show, pause, resume, or clear the session goal (/goal <objective>; bare shows it; /goal pause|resume; /goal clear ends it)." },
  { name: "/thinking", description: "Show or hide model thinking in the TUI (rendering only; the turn is untouched)." },
  { name: "/resume", description: "Restore the last saved session (turns, history, settings, usage)." },
  { name: "/session", description: "Switch the active session (interactive picker, most recent first)." },
  { name: "/fork", description: "Fork this session into a new one and switch to it (/fork [n] drops the last n messages first)." },
  { name: "/revert", description: "Undo to a checkpoint — restores conversation + files (/revert [n] goes n checkpoints back)." },
  { name: "/telemetry", description: "Show the local observability summary (sessions, tokens, tools)." },
  { name: "/usage", description: "Show the per-POST usage ledger for this session (turn steps + compaction POSTs)." },
  { name: "/dashboard", description: "Write the local observability dashboard page and show its path." },
  { name: "/rewind", description: "Restore files to a session checkpoint (files only; shell side effects are never snapshotted)." },
  { name: "/reload", description: "Reload config, skills, extensions, MCP servers, and instruction files — pick up edits without restarting (conversation, session, trust, and mode kept)." },
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
// ordered sequence — permissions → context assembly → loop
// entry — so future submit-time work has exactly one home stage. The
// rollback-scope rule per stage states what a failed turn keeps vs drops.
// This descriptor is the order test's source of truth:
// tests/submit-order.test.ts pins both this order and the matching
// `SUBMIT STAGE n/3` markers inside submit().
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
    name: "loop-entry",
    rollbackScope: "post-rollbackTo: the user message, skill context, and loop entries roll back on failure",
  },
] as const;

// Shared usage strings: the exact texts the commands print, hoisted to
// module scope so the slash-menu argument hints reuse them (no second
// implementation).
export const SKILL_USAGE =
  "usage: /skill (list) · /skill:name or /skill <name> (invoke, e.g. /skill:code-review)";
export const MODEL_USAGE =
  "usage: /model [filter text] — open the picker; /model refresh re-probes local servers (Ollama, LM Studio, llama.cpp)";
export const RULE_USAGE =
  "usage: /allow <tool[:glob]> · /deny <tool[:glob]> · /rules · /rules clear (e.g. /allow bash:npm test*, /deny bash:rm *)";
export const QUEUE_USAGE =
  "usage: /queue (list) · /queue clear (wipe) · /steer <text> (steer the running turn, or send when idle)";
export const STEER_USAGE =
  "usage: /steer <text> — while busy, injects into the running turn at the next step boundary (the current action finishes first); when idle, sends as a normal turn";
export const AUTOSCROLL_USAGE =
  "usage: /autoscroll [on|off] — on (default) follows new output as it arrives; off freezes the view while a turn runs (a `↓ N new` indicator offers the jump back). Bare /autoscroll toggles between the two.";
export const THINKING_USAGE =
  "usage: /thinking — toggles model-thinking visibility in the TUI (rendering only: the live block and future rounds show or hide; already-printed blocks stay as printed; the turn, history, and telemetry are untouched).";
export const RENAME_USAGE =
  'usage: /rename <name> — rename the current session (e.g. /rename Build authentication; quotes optional: /rename "name with spaces"). Bare /rename prints this usage.';
export const FORK_USAGE =
  "usage: /fork [n] — fork this session into a new one and switch to it (optional n drops the last n messages first, snapped to a turn boundary). Bare /fork clones the full conversation.";
export const REVERT_USAGE =
  "usage: /revert [n] — undo to a checkpoint (n checkpoints back, default 0 = latest). Restores conversation + files; other sessions and forks untouched. Bare /revert undoes the last bad turn.";
export const GOAL_USAGE =
  "usage: /goal <objective> (set and start working, just like a normal message; replacing resets counters; mid-turn set replaces quietly) · /goal (show with cumulative stats) · /goal pause · /goal resume (re-arms; idle starts a turn, busy resumes at turn end) · /goal clear (ends it)";

// Pure arg parser for /rename (unit-tested): strips the command, trims,
// then strips one layer of matching outer quotes (single or double) so
// quoted names work even though the command line has no real parser.
// Unquoted multi-word names work as-is (everything after /rename is the
// name). Empty/whitespace-only input yields "" (caller prints usage).
export function parseRenameArg(raw: string): string {
  const text = raw.trim();
  const arg = text === "/rename" ? "" : text.slice("/rename".length).trim();
  if (arg.length >= 2) {
    const first = arg[0];
    const last = arg[arg.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return arg.slice(1, -1).trim();
    }
  }
  return arg;
}

export function filterSlashCommands(prefix: string): SlashCommand[] {
  const q = prefix.startsWith("/") ? prefix.slice(1) : prefix;
  // Exact match wins outright: a fully-typed command collapses the menu
  // to itself, so prefix-siblings (/mode vs /model, /skill vs /skill:name
  // rows) never read as duplicates and Enter stays deterministic. Partial
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
  // Extension slash commands (ticket 04): the same prefix/fuzzy/
  // description tiers over the live registry — a colliding name can never
  // reach here (activation rejects it), and dispatch routes builtins first
  // as backstop, so builtins are never shadowed.
  const extCmds = listExtensionCommands();
  const extNames = new Set(extCmds.map((c) => `/${c.name}`));
  extCmds.forEach((cmd, extIdx) => {
    const c = { name: `/${cmd.name}`, description: cmd.description };
    const idx = SLASH_COMMANDS.length + extIdx;
    const name = cmd.name.toLowerCase();
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
    if (cmd.description.toLowerCase().includes(q)) out.push({ c, tier: 3, score: 0, idx });
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
    category: extNames.has(c.name) ? "Extensions" : paletteCategory(c.name),
    hint: PALETTE_HINTS[c.name] ?? null,
  }));
}

// Busy-gate shared by the slash menu and the palette: /compact sets the
// pending flag for turn-end drain; /queue + /steer manage the running turn;
// /autoscroll and /thinking only flip view flags (never touch the turn);
// /goal only flips session goal state (never touches the turn);
// /rename only renames the store record + title state (the later turn-end
// persist preserves the title, so it never races the turn).
// Every other command waits idle.
export function slashRunsWhileBusy(name: string): boolean {
  return (
    name === "/compact" ||
    name === "/queue" ||
    name === "/steer" ||
    name === "/autoscroll" ||
    name === "/thinking" ||
    name === "/goal" ||
    name === "/rename"
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

// Pure filter for the /skill picker (unit-tested): case-insensitive
// substring over the skill name (a search popup narrows harder than the
// prefix-only slash menu). Empty query returns everything as-is.
export function filterSkillPicker(entries: SkillPickerEntry[], query: string): SkillPickerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

// Pure snapshot equality for the skill-menu cache (unit-tested): refreshes
// that discover nothing new must keep the previous array identity, or every
// mount//skills//clear//new refresh schedules a pointless App render.
export type SkillMenuEntry = { name: string; description: string };

export function sameSkillMenuSnapshot(a: SkillMenuEntry[], b: SkillMenuEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.name !== b[i]!.name || a[i]!.description !== b[i]!.description) return false;
  }
  return true;
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
  skills: Array<{ name: string; description: string }>,
  extensions: Array<{ name: string; description: string }> = []
): SlashMenu {
  const items: MenuItem[] = filterSlashCommands(input).map((c) => ({
    name: c.name,
    description: c.description,
  }));
  if (input.length < 2) return { items, moreSkills: 0 };
  // Extension slash commands (ticket 04): prefix tier in registration
  // order (registration order is deterministic), then fuzzy by score —
  // listed after builtins (exact dispatch routes builtins first, so an
  // extension never shadows) and before skills.
  const q = input.slice(1);
  const extPrefix: Array<{ name: string; description: string }> = [];
  const extFuzzy: { e: { name: string; description: string }; score: number }[] = [];
  for (const e of extensions) {
    const entry = `/${e.name}`;
    if (e.name.startsWith(q) || entry.startsWith(input)) {
      extPrefix.push(e);
      continue;
    }
    const score = fuzzyScore(q, e.name);
    if (score !== null) extFuzzy.push({ e, score });
  }
  extFuzzy.sort((a, b) => a.score - b.score || (a.e.name < b.e.name ? -1 : 1));
  for (const e of [...extPrefix, ...extFuzzy.map((f) => f.e)]) {
    const desc =
      e.description.length > SKILL_MENU_DESC_CHARS
        ? `${e.description.slice(0, SKILL_MENU_DESC_CHARS)}…`
        : e.description;
    items.push({ name: `/${e.name}`, description: desc });
  }
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
    case "/model":
      return MODEL_USAGE;
    case "/compact":
      return "Usage: /compact [focus text] — summarize older turns (works while busy; drains at turn end).";
    case "/rename":
      return RENAME_USAGE;
    case "/fork":
      return FORK_USAGE;
    case "/revert":
      return REVERT_USAGE;
    case "/goal":
      return GOAL_USAGE;
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

// Pure filter for the /session picker (unit-tested): fuzzy subsequence over
// the session title first, then the session id (with a penalty so title
// matches always outrank id matches). Empty query returns everything as-is
// (already most-recent-first from the store). Ranked by score; equal scores
// keep the input order via the index tiebreak (deterministic). Pure — the
// App loads the list once per open and filters in memory per keystroke, so
// hundreds/thousands of sessions stay instant (no disk reads while typing).
export type SessionPickerEntry = {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  turnCount: number;
  active: boolean;
};

export function filterSessionEntries(
  entries: SessionPickerEntry[],
  query: string
): SessionPickerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const scored: { e: SessionPickerEntry; score: number; idx: number }[] = [];
  entries.forEach((e, idx) => {
    const titleScore = fuzzyScore(q, e.title);
    const idScore = fuzzyScore(q, e.id);
    let best: number | null = titleScore;
    if (idScore !== null && (best === null || idScore + 5 < best)) {
      best = idScore + 5;
    }
    if (best !== null) scored.push({ e, score: best, idx });
  });
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  return scored.map((s) => s.e);
}

// Relative age for the picker secondary line (unit-tested). Invalid dates
// say "unknown" (never throw, never invent).
export function formatSessionAge(nowMs: number, updatedAt: string): string {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return "unknown";
  const secs = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
    `\nToken totals accumulate per session from API-reported usage only: the status line shows \`token: n/a\` until the API reports usage (never estimated, never 0-by-default); with usage it shows \`token: (P%) NK\` — NK is the cumulative session spend in K, P% is the CURRENT context load over the model's verified window (last POST input tokens incl. prefix cache, else the 4ch/token estimate; models with no verified window show a bare \`token: NK\`, never an invented percent). /clear keeps the totals; /new resets them.` +
    `\n/compact [focus text]: summarize older turns into one \`[Compacted context …]\` summary + keep the newest tail (~20000 estimated tokens, tool outputs capped at 2000 chars). Tiny history (≤1 user turn) reports \`(nothing to compact)\`. Works for unknown-window models (estimate only for the tail split).` +
    `\n/goal <objective>: pin one session goal (setting one replaces any live goal and resets its counters). Bare /goal shows it with cumulative stats (turns · requests · tokens · work). /goal pause halts the run but keeps the objective and stats; /goal resume re-arms it — idle starts a turn with the continuation text, busy resumes when the current turn ends. /goal clear ends it. The run has no turn cap: it continues turn-to-turn until paused, cleared, a complete/blocked verdict, or a thrown failure. Cancel and spent step/tool-call budgets pause (never clear). The model reports each turn via update_goal (continue with the next action, or complete/blocked with a reason); a report-less turn gets one bounded judge call when configured, otherwise continues — an unclear or failed judge pauses with the goal preserved. Three consecutive repeated tool results redirect with a replan nudge (the goal stays active). A complete with unverified code or open todos continues instead of stopping; blocked stops unconditionally (declared-unverifiable checks print openly in the verdict, never gate). /clear and /new end the goal; the live goal rides every session save with its stats intact (resume and session switches restore it; corrupt data loads as no goal). Compaction appends a Goal: line (text, state, stats, open todos) to the summary as the model's context backstop.` +
    `\nAuto-compact: after every completed turn the load is checked; on known-window models with load/window ≥ ${Math.round(COMPACT_PCT_DEFAULT * 100)}% (env ATOM_COMPACT_PCT percent, clamped 50–95, invalid→default) history auto-compacts before the next turn. Unknown-window models never auto-compact — use /compact manually.` +
    `\nThrash guard: 3 auto-compactions without the load dropping below threshold disables auto for the session with \`(auto-compact thrashing — disabled, use /compact or /clear)\`; manual /compact still works and resets the counter on success.` +
    `\n/provider: pick kilo|opencode-zen|openai|anthropic|deepseek|mistral|google-gemini|groq|xai|zai|openrouter|cerebras|openai-compatible, paste a key once (stored in ~/.atom/auth.json, env wins). Kilo is the default: its free :free models (e.g. kilo-auto/free) work with no key; a Kilo key unlocks the full catalog. Switching provider keeps session history text; system prompt stays.` +
    `\n/effort options: Auto/Low/Medium/High/Max. Auto omits the knob (the model decides); anything else sends it — reasoning_effort on OpenAI-chat providers (every provider, every model), a thinking budget on Anthropic, a thinkingLevel on Gemini (Max rides high).` +
    `\nUnsupported is server-authoritative, never preemptive: a model that truly lacks the knob fails the POST with a 400 naming it, and the turn retries once without it (warning shown, setting kept, status never invents "(unsupported)"). Effort persists across /model switches.` +
    `\n/resume: restores the last saved session (turns, history, provider/model/effort/mode, usage totals). The conversation never auto-restores — sending a message without /resume starts fresh, and the next completed turn overwrites the save. Your provider/model/effort picks DO persist across restarts automatically (saved on every completed turn and on clean exit; explicit OPENCODE_ZEN_MODEL wins over the saved model). /clear clears the live session only (the save keeps the pre-clear state until the next completed turn overwrites it). /new saves first, then starts a brand-new session (conversation + counters reset, settings kept) — so /resume right after /new restores the pre-/new conversation. Split: /clear = wipe transcript, keep counters; /new = full fresh conversation + counters reset, previous kept for /resume.` +
    `\nSession autosave: every completed turn (and clean exit, plus after each successful compaction) writes ~/.atom/session.json (0600 POSIX, may contain pasted secrets — never commit it); failed/cancelled turns never touch it; a corrupt save loads as "(saved session unreadable — starting fresh)".` +
    `\nBusy status shows the live phase plus elapsed seconds in the status line (· thinking… 4s); >3s without token/tool/phase activity adds a dim waiting… hint (status-bar only, never saved). ` +
    `Reasoning streams in its own dim block above the answer draft while busy (transient — never committed); Esc stops a running response (same rollback as Ctrl+C).` +
    `\n/rewind: every write/edit auto-snapshots prior bytes (silent, no prompt, no config); /rewind lists the session checkpoints and restores exact bytes (hash-verified, never a model rewrite) — files only, files + conversation, or conversation only. Shell side effects (bash) are explicitly out of scope: commands are never snapshotted and cannot be undone.` +
    `\n/reload: re-read config (atom.json), skills, extensions, MCP servers, and instruction files (AGENTS.md) without restarting — edited values, added/changed/removed entries, and reconnected servers take effect on subsequent turns. Preserves the conversation, session identity, token totals, trust grants (project + session), and permission mode; extension trust is never re-prompted and lockdown still loads nothing. Broken entries surface as inline warnings instead of crashing; a total extension-reload failure restores the previous extensions with a ` +
    "`Reload failed: …` notice." +
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
// surface. P% tracks CURRENT context load (last POST input tokens incl.
// cache, else 4ch/token estimate); NK tracks cumulative session spend.

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
  // Tool-call one-liner for the modal, computed once in approve() alongside
  // the preview (describeToolCall may resolve symlinks — approval display
  // must never touch the filesystem itself, so render reads this).
  description: string;
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

// Render-count probe for propagation audits: incremented on every App body
// execution (hostile-perf suite asserts token paints and ticks stay out of
// here — only real state transitions may run the orchestrator).
export const appRenderProbe = { count: 0 };

export function App({ apiKey, endpoint, initialModel, initialModels, initialProvider, restorePrefs, authHome, skillDirs, configDirs, extensionsLockdown, enableExtensions, disableExtensions, now, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn, localDiscovery }: AppProps) {
  appRenderProbe.count += 1;
  const { exit } = useApp();
  // Saved preferences (provider/model/effort + resolved key/endpoint), loaded
  // once when restorePrefs is on (prod). Explicit props always win; without
  // prefs the CLI defaults apply. Null in tests (flag off) and on any
  // missing/corrupt/unusable save — startup then behaves exactly as before.
  const [prefs] = useState(() => (restorePrefs ? loadPrefs(authHome, endpoint) : null));
  // atom.json (project + global, per-key merge): first-run defaults sitting
  // between saved prefs and compiled defaults —
  // env/props > save > project > global > default.
  const [atomConfigLoad, setAtomConfigLoad] = useState(() =>
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
  // Shell mode (06 parity, G2): ! at offset 0 enters SHELL when normal and input active.
  const [shellActive, setShellActive] = useState(false);
  const shellActiveRef = useRef(false);
  function setShellActiveBoth(next: boolean) {
    shellActiveRef.current = next;
    setShellActive(next);
  }
  // File mentions (05 parity, G1): pure helpers, live pool, picker state.
  const [mentionPool, setMentionPool] = useState<string[]>(() => {
    try {
      return buildMentionPool(listMentionFilesSync(process.cwd()));
    } catch {
      return [];
    }
  });
  const mentionPoolRef = useRef<string[]>(mentionPool);
  const [mentionVisible, setMentionVisible] = useState(false);
  const mentionVisibleRef = useRef(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const mentionQueryRef = useRef("");
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);
  const mentionCandidatesRef = useRef<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionIndexRef = useRef(0);
  const [mentionTriggerStart, setMentionTriggerStart] = useState<number | null>(null);
  const mentionTriggerStartRef = useRef<number | null>(null);
  const mentionsRef = useRef<FileMention[]>([]);
  const mentionPoolReadyRef = useRef(false);
  // Paste hardening (07 parity, G3): collapsed chunks + path hits never persist.
  const pastedChunksRef = useRef<PastedChunk[]>([]);
  const pastedImageCountRef = useRef(0);
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
  // /skill picker (opencode-style searchable popup): type-to-filter over the
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
  // /session picker (interactive switcher): snapshot state loaded ONCE per
  // open (listSessions reads each record a single time), filtered in memory
  // per keystroke. ↑/↓ + Enter switches, Esc cancels with the live session
  // untouched. Same keyboard/window pattern as the /skill picker.
  const [selectingSession, setSelectingSession] = useState(false);
  const [sessionItems, setSessionItems] = useState<SessionPickerEntry[]>([]);
  const [sessionIndex, setSessionIndex] = useState(0);
  const sessionIndexRef = useRef(0);
  const [sessionFilter, setSessionFilter] = useState("");
  const sessionFilterRef = useRef("");
  function setSessionIndexBoth(next: number) {
    sessionIndexRef.current = next;
    setSessionIndex(next);
  }
  function setSessionFilterBoth(next: string) {
    sessionFilterRef.current = next;
    setSessionFilter(next);
  }
  // /mcp server popup (opencode-style): snapshot-on-open status list, ↑/↓
  // moves, Space toggles enable/disable in place (persisted to the project
  // atom.json + manager reconnect), Esc closes with nothing pending. No
  // typing filter — server lists are short and rows update live on toggle.
  type McpPopupEntry = { name: string; enabled: boolean; detail: string };
  const [selectingMcp, setSelectingMcp] = useState(false);
  const [mcpItems, setMcpItems] = useState<McpPopupEntry[]>([]);
  const [mcpIndex, setMcpIndex] = useState(0);
  const mcpIndexRef = useRef(0);
  function setMcpIndexBoth(next: number) {
    mcpIndexRef.current = next;
    setMcpIndex(next);
  }
  // Reasoning-effort picker (/effort): same pattern as the /model picker
  // (↑/↓ + Enter, Esc cancels). Saved effort restores with restorePrefs,
  // else the atom.json default, else Auto. normalizeEffort keeps pre-auto
  // "default" values (old saves/configs) working.
  const [selectingEffort, setSelectingEffort] = useState(false);
  const [effortIndex, setEffortIndex] = useState(0);
  const effortIndexRef = useRef(0);
  const [effort, setEffort] = useState<ReasoningEffort>(
    normalizeEffort(prefs?.effort ?? atomConfig.reasoningEffort ?? "auto")
  );
  const effortRef = useRef<ReasoningEffort>(
    normalizeEffort(prefs?.effort ?? atomConfig.reasoningEffort ?? "auto")
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
  // Usage ledger (realtime-token-usage 05): per-POST usage rows for the
  // session — one row per completed model POST (turn steps + compaction
  // POSTs), in-memory only like the inspector log (prompts may carry pasted
  // secrets; totals persist via the session save, per-POST rows do not).
  // Entries carry their session id so a switch/fork shows a fresh ledger
  // while old rows stay isolated (never mixed across sessions).
  const usageStepsRef = useRef<UsageStep[]>([]);
  const [usageLedgerOpen, setUsageLedgerOpen] = useState(false);
  const usageLedgerOpenRef = useRef(false);
  function setUsageLedgerOpenBoth(next: boolean) {
    usageLedgerOpenRef.current = next;
    setUsageLedgerOpen(next);
  }
  const [usageLedgerIndex, setUsageLedgerIndex] = useState(0);
  const usageLedgerIndexRef = useRef(0);
  function setUsageLedgerIndexBoth(next: number) {
    usageLedgerIndexRef.current = next;
    setUsageLedgerIndex(next);
  }
  function recordLedgerStep(kind: UsageStepKind, usage: UsageStep["usage"]): void {
    try {
      usageStepsRef.current = recordUsageStep(usageStepsRef.current, {
        kind,
        sessionId: activeSessionIdRef.current ?? "",
        model: modelRef.current,
        usage,
      });
    } catch {
      // observer errors never break turns
    }
  }
  function openUsageLedger(): void {
    const rows = stepsForSession(usageStepsRef.current, activeSessionIdRef.current ?? "");
    setUsageLedgerIndexBoth(Math.max(0, rows.length - 1));
    setUsageLedgerOpenBoth(true);
  }
  function closeUsageLedger(): void {
    setUsageLedgerOpenBoth(false);
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
  // shown): committed thinking turns + the live thinking block show while
  // on. Never touches the turn, history, or telemetry — purely paint.
  const [showThinking, setShowThinking] = useState(true);
  const showThinkingRef = useRef(true);
  function setShowThinkingBoth(next: boolean) {
    showThinkingRef.current = next;
    setShowThinking(next);
  }
  // /autoscroll (session-only, default on). On follows new output as it
  // arrives; off freezes the view at the first busy append (the `↓ N new`
  // indicator offers the jump back). Bare /autoscroll toggles.
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);
  function setAutoScrollBoth(next: boolean) {
    autoScrollRef.current = next;
    setAutoScroll(next);
  }
  // Session goal (ticket 01, in-memory only): at most one active goal per
  // session. Ordinary chat messages never touch it — only /goal does.
  const [goal, setGoal] = useState<GoalState>(null);
  const goalRef = useRef<GoalState>(null);
  function setGoalBoth(next: GoalState) {
    goalRef.current = next;
    setGoal(next);
  }
  // Goal stat patch (ticket 02): accumulates into the LIVE goal's counters,
  // preserving objective/active. Drops when no goal exists (e.g. cleared
  // mid-turn — the slice belongs to no goal anymore). Never throws.
  function patchGoalStats(patch: (s: GoalStats) => GoalStats): void {
    try {
      const g = goalRef.current;
      if (!g) return;
      setGoalBoth({ ...g, stats: patch(g.stats ?? emptyGoalStats()) });
    } catch {
      // accounting never breaks the turn
    }
  }
  // Goal-resume staged while busy (ticket 07): `/goal resume` mid-turn
  // re-arms the flag for turn-end pickup (see runGoalCommand) — the running
  // loop usually consumes the re-arm live at its next continuation check,
  // but a resume that raced the loop's final check (or a failed turn, which
  // never continues) leaves the goal active with no continuation. The
  // turn-boundary drain consumes this flag exactly once (see
  // drainTurnBoundary stage 5). Never set when idle (idle resume submits
  // directly); cleared on every turn end even when it kicks nothing.
  const goalResumePendingRef = useRef(false);
  // Usage accumulator (session totals + goal slice, real reports only): the
  // turn's onUsage below and the goal-judge runner share it so judge spend
  // bills exactly like model spend. Every reporting POST accumulates
  // (tool-round POSTs and successful retries each count once — each was
  // billed; failed attempts report nothing, so nothing is deduped).
  // usageTotals drives NK only, never P%.
  // updateLoad pins the load metric (P% source) to main-context POSTs: the
  // judge's summary-sized request must not move it (same rule as the
  // compaction summary POST — load tracks the main context).
  function accumulateUsage(u: Usage, updateLoad = true): void {
    const prev = usageRef.current ?? {};
    const next: Usage = { ...prev };
    if (u.prompt_tokens !== undefined) {
      next.prompt_tokens = (next.prompt_tokens ?? 0) + u.prompt_tokens;
      // Load metric source: last POST's reported input-side tokens
      // (prompt_tokens, cache-inclusive for exclusive-cache providers) —
      // the per-POST value, NOT the accumulated total.
      if (updateLoad) lastPromptTokensRef.current = u.prompt_tokens;
      // A real main-loop report just arrived: the load is exact again, so
      // the estimate latch clears (reset paths set it; summary/judge POSTs
      // never touch it — same rule as the latch above).
      if (updateLoad) setLoadEstimatedBoth(false);
      // Overflow-trigger source: the full last report (total, else parts).
      // Stashed only for main-loop POSTs — summary/judge spend must not
      // move the trigger (same rule as the load latch above).
      if (updateLoad) lastUsageRef.current = u;
      // Fix 02 — mid-turn P% tick: the load estimate must move on every
      // reporting POST, not only at turn end. Update contextLoad from the
      // fresh lastPromptTokens + current history so the footer ticks live.
      if (updateLoad && u.prompt_tokens !== undefined) {
        try {
          const load = contextManager().usage(historyRef.current, lastPromptTokensRef.current).loadTokens;
          setContextLoadBoth(load);
        } catch {
          // ignore
        }
      }
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
    // Goal token slice (ticket 02): every reporting POST also accrues
    // to the live goal's spend — real reports only, and the session
    // totals above are untouched.
    try {
      if (goalRef.current) {
        const slice = goalTokensForUsage(u);
        if (slice > 0) patchGoalStats((s) => ({ ...s, tokens: s.tokens + slice }));
      }
    } catch {
      // accounting never breaks the turn
    }
  }
  // Loop-owned pause (ticket 02): cancel and spent budgets pause with a
  // visible notice — the objective and stats survive, so /goal resume
  // continues where the run stopped. No-op when absent/already paused
  // (pause fires exactly once per run).
  function pauseGoalWithNotice(notice: string): void {
    const g = goalRef.current;
    if (!g || !g.active) return;
    setGoalBoth({ ...g, active: false });
    pushInfo(notice);
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
  // mount, /skill, /clear, and /new — never per keystroke (disk I/O stays
  // out of the typing path). Empty until the first refresh lands.
  const [skillMenu, setSkillMenu] = useState<Array<{ name: string; description: string }>>([]);
  async function refreshSkillMenu(): Promise<void> {
    try {
      const found = await skillRegistry.refresh();
      const { skills } = resolveSkills(found.skills);
      const next: SkillMenuEntry[] = skills
        .filter((s) => s.userInvocable)
        .map((s) => ({ name: s.name, description: s.description }));
      // Install only on change: the mount refresh routinely rediscovers the
      // identical set mid-turn, and a fresh array identity would schedule a
      // full App render for zero new information.
      setSkillMenu((prev) => (sameSkillMenuSnapshot(prev, next) ? prev : next));
    } catch {
      // menu keeps its previous snapshot (a hiccup must never break input)
    }
  }
  // /reload (tickets 02-04): re-read every live source without restarting —
  // atom.json, skills, extensions (orderly teardown + startup cutover), MCP
  // servers (reconnect), and instruction files (AGENTS.md overlay) — while
  // conversation, session identity, token totals, trust grants, and
  // permission mode stay untouched.
  async function runReloadCommand(): Promise<void> {
    try {
      const nextCfg = loadAtomConfig(configDirs?.projectDir, configDirs?.homeDir ?? authHome);
      setAtomConfigLoad(nextCfg);
      const found = await skillRegistry.refresh();
      const { skills } = resolveSkills(found.skills);
      const next: SkillMenuEntry[] = skills
        .filter((s) => s.userInvocable)
        .map((s) => ({ name: s.name, description: s.description }));
      setSkillMenu((prev) => (sameSkillMenuSnapshot(prev, next) ? prev : next));
      // Extensions (ticket 03): orderly teardown (shutdown emit with reason
      // reload, then unload freeing every global registration) BEFORE the
      // fresh load, so re-registered commands/tools/hooks commit cleanly —
      // loading first would fail alone on duplicate names still held by the
      // old runtime. Captured pre-reload APIs go stale at unload (loud on
      // use, never acting on the new session). Trust and enable/disable
      // filters reuse the cached/boot values — no re-prompt, no silent
      // escalation, lockdown still loads nothing. A total load failure
      // restores the previous entries best-effort so a live runtime remains.
      let extPart = "extensions: unchanged";
      let extErrors = 0;
      const prevRuntime = extRuntimeRef.current;
      const prevPaths = prevRuntime ? prevRuntime.loaded.map((e) => e.path) : [];
      const reloadCwd = storeCwd();
      const cfgExt = nextCfg.config.extensions;
      const extOpts = {
        home: authHome,
        cwd: reloadCwd,
        builtinSlashCommands: SLASH_COMMANDS.map((c) => c.name),
        projectTrusted: isProjectTrusted(reloadCwd, authHome),
        lockdown: extensionsLockdown === true,
        enabledPatterns:
          enableExtensions !== undefined && enableExtensions.length > 0
            ? enableExtensions
            : (cfgExt?.enabled ?? []),
        disabledPatterns:
          disableExtensions !== undefined && disableExtensions.length > 0
            ? disableExtensions
            : (cfgExt?.disabled ?? []),
        interactive: true,
      };
      let extRuntime: ExtensionRuntime | null = null;
      let extFailed: string | null = null;
      if (prevRuntime) {
        try {
          await prevRuntime.emit("session_shutdown", { reason: "reload" });
        } catch {
          // emit never rejects by contract; defensive only.
        }
        try {
          extUnsubRef.current?.();
        } catch {
          // unsubscribe never throws; defensive only.
        }
        extUnsubRef.current = null;
        try {
          prevRuntime.unload();
        } catch {
          // unload never throws by contract; defensive only.
        }
      }
      try {
        extRuntime = await loadExtensions(extOpts);
      } catch (e) {
        extFailed = e instanceof Error ? e.message : String(e);
        // Total failure: best-effort restore of the previous entries so a
        // live runtime remains (the torn-down lineage stays stale by design).
        try {
          extRuntime = await loadExtensions(
            prevPaths.length > 0 ? { ...extOpts, entryPaths: prevPaths } : extOpts
          );
        } catch {
          extRuntime = null;
        }
      }
      if (extRuntime) {
        extRuntimeRef.current = extRuntime;
        try {
          extUnsubRef.current = extRuntime.subscribeUI(() => {
            bumpExtUI((v) => v + 1);
          });
        } catch {
          extUnsubRef.current = null;
        }
        extRuntime.setSessionId(activeSessionIdRef.current);
        try {
          await extRuntime.emit("session_start", { reason: "reload" });
        } catch {
          // emit never rejects by contract; defensive only.
        }
        extErrors = extRuntime.errors.length;
        const skippedNote = extRuntime.skipped.length > 0 ? `, ${extRuntime.skipped.length} skipped` : "";
        extPart =
          `extensions: ${extRuntime.loaded.length} loaded, ${extRuntime.errors.length} failed${skippedNote}` +
          (extFailed !== null ? ` (reload failed: ${extFailed}; previous extensions restored)` : "");
        for (const e of extRuntime.errors) pushInfo(`extension warning: ${e.path}: ${e.error}`);
      } else {
        extPart = `extensions: reload failed (${extFailed ?? "unknown error"}; previous runtime torn down)`;
      }
      // MCP servers (ticket 04): reconnect from the re-read config; an
      // unreachable server becomes a failed status (warning), never a crash
      // or a lost session.
      let mcpPart = "mcp: unchanged";
      try {
        const { mcpManager } = await import("./mcp/manager.js");
        await mcpManager.refresh(configDirs?.projectDir ?? reloadCwd);
        const status = mcpManager.status();
        const names = Object.keys(status);
        let connected = 0;
        let disabled = 0;
        let failed = 0;
        let needsAuth = 0;
        for (const n of names) {
          const s = status[n];
          if (!s) continue;
          if (s.status === "connected") connected += 1;
          else if (s.status === "disabled") disabled += 1;
          else if (s.status === "needs_auth") needsAuth += 1;
          else if (s.status === "failed") failed += 1;
        }
        const toolCount = mcpManager.names().length;
        mcpPart =
          `mcp: ${names.length} server(s) ` +
          `(${connected} connected, ${disabled} disabled, ${needsAuth} need-auth, ${failed} failed; ${toolCount} tools)`;
        for (const [n, s] of Object.entries(status)) {
          if (s && s.status === "failed") pushInfo(`mcp warning: server "${n}" failed: ${s.error}`);
          else if (s && s.status === "needs_auth") pushInfo(`mcp warning: server "${n}" needs authentication`);
        }
        for (const w of mcpManager.warnings()) pushInfo(`mcp warning: ${w}`);
      } catch (e) {
        mcpPart = `mcp: refresh failed (${e instanceof Error ? e.message : String(e)})`;
      }
      // Instruction files (ticket 04): re-read the AGENTS.md overlay for
      // subsequent turns; existing history is left untouched apart from the
      // pinned system line (rebuilt with a fresh env block, never stacked).
      let instrPart = "instructions: none";
      try {
        const freshSystem = buildSystemPrompt();
        setSystemPrompt(freshSystem);
        const first = historyRef.current[0];
        if (first?.role === "system") {
          historyRef.current[0] = { role: "system", content: withEnvBlock(freshSystem) };
        }
        const overlay = loadAgentsPrompt();
        instrPart =
          overlay !== null ? `instructions: 1 file (${overlay.length} chars)` : "instructions: none";
      } catch {
        instrPart = "instructions: refresh failed";
      }
      const cfgSrc =
        nextCfg.sources.project && nextCfg.sources.global
          ? "project + global"
          : nextCfg.sources.project
            ? "project"
            : nextCfg.sources.global
              ? "global"
              : "none";
      const cfgKeys = Object.keys(nextCfg.config).length;
      const cfgPart = `config: ${cfgSrc}${cfgKeys > 0 ? `, ${cfgKeys} key${cfgKeys === 1 ? "" : "s"}` : ", defaults"}`;
      const st = found.stats;
      const skillPart = `skills: ${found.skills.length} total (${st.reused} reused, ${st.reloaded} reloaded, ${st.added} added, ${st.removed} removed)`;
      const warnParts: string[] = [];
      if (nextCfg.warnings.length > 0) warnParts.push(`${nextCfg.warnings.length} config warning(s)`);
      if (found.warnings.length > 0) warnParts.push(`${found.warnings.length} skill warning(s)`);
      if (extErrors > 0) warnParts.push(`${extErrors} extension warning(s)`);
      const warnSuffix = warnParts.length > 0 ? ` — ${warnParts.join(", ")}` : "";
      pushInfo(`Reloaded ${cfgPart}; ${skillPart}; ${extPart}; ${mcpPart}; ${instrPart}${warnSuffix} — conversation kept.`);
      for (const w of nextCfg.warnings) pushInfo(`config warning: ${w}`);
      for (const w of found.warnings) pushInfo(`skill warning: ${w}`);
    } catch (e) {
      pushInfo(`Reload failed: ${e instanceof Error ? e.message : String(e)}`);
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
  // Approval provenance slot (display-only, ticket 04): the verdict's via
  // token for the in-flight approval-gated call, held for the matching
  // onToolActivity commit. Same single-slot discipline as pendingDiffRef —
  // the scheduler never parallel-batches conflicting writes, and every
  // execution commits exactly one activity entry in call order. Lifetime ⊆
  // one turn: set in approve(), consumed-or-cleared by the matching
  // activity (same name-match predicate as the diff slot), and cleared on
  // deny/cancel/turn boundaries so a stale token can never attribute to a
  // later call. Read-only tools never consult approval, so they never set
  // this (their audit lines stay exactly as before).
  const pendingViaRef = useRef<{ name: string; via: ApprovalVia } | null>(null);
  // Consume-once pairing for the approve-time captures above (transcript
  // diff + approval provenance). Shared by the legacy onToolActivity commit
  // and the core path (via getHooks below): `match` selects this execution's
  // slots, consume-or-clear runs on every matching activity (success or
  // failure) so a stale capture can never leak onto a later call. Returns
  // the pair; the CALLER decides what attaches (legacy and core both attach
  // the via on success and error alike, and the diff on success only —
  // failures keep the ↳ line only).
  // Full-file BEFORE→AFTER is preferred (aligned panes with context); when
  // either side is unavailable (unreadable file, oversize), falls back to
  // the arg-block preview pair. Past 1MB a side nothing attaches (the diff
  // engine would only render its skip notice anyway).
  function consumePendingSlots(match: (slotName: string) => boolean): {
    diff: ApprovalDiff | null;
    approvalVia: ApprovalVia | null;
  } {
    let approvalVia: ApprovalVia | null = null;
    let diff: ApprovalDiff | null = null;
    const viaSlot = pendingViaRef.current;
    if (viaSlot !== null && match(viaSlot.name)) {
      pendingViaRef.current = null;
      approvalVia = viaSlot.via;
    }
    const slot = pendingDiffRef.current;
    if (slot !== null && match(slot.name)) {
      pendingDiffRef.current = null;
      let afterFull: string | null = null;
      if (slot.name === "write") {
        afterFull = slot.afterArg;
      } else if (slot.path !== null) {
        afterFull = readFileForDiff(path.resolve(process.cwd(), slot.path));
      }
      const beforeFull = slot.beforeFull;
      const oversize =
        (beforeFull !== null && beforeFull.length > APPROVAL_PREVIEW_MAX_BYTES) ||
        (afterFull !== null && afterFull.length > APPROVAL_PREVIEW_MAX_BYTES) ||
        (slot.diff !== null &&
          ((slot.diff.oldText !== null && slot.diff.oldText.length > APPROVAL_PREVIEW_MAX_BYTES) ||
            slot.diff.newText.length > APPROVAL_PREVIEW_MAX_BYTES));
      if (!oversize && beforeFull !== null && afterFull !== null) {
        diff = {
          oldText: beforeFull,
          newText: afterFull,
          lang: slot.diff?.lang ?? null,
          path: slot.path,
        };
      } else if (!oversize && slot.diff !== null) {
        diff = slot.diff;
      }
    }
    return { diff, approvalVia };
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
  // Extension UI surface (ticket 10): the version bump re-renders on every
  // runtime UI mutation (segment/widget/notice/dialog); the dialog owns its
  // own select/custom state mirroring the question modal above.
  const [, bumpExtUI] = useState(0);
  const [extDlgSel, setExtDlgSel] = useState(0);
  const extDlgSelRef = useRef(0);
  const [extDlgCustom, setExtDlgCustom] = useState("");
  const extDlgCustomRef = useRef("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Per-turn cancellation (Ctrl+C mid-loop): abort stops after the current
  // tool finishes — no new POSTs, no new executions — then the turn rolls
  // back and a dim `(cancelled)` line renders.
  const turnCancelRef = useRef<AbortController | null>(null);
  // Live tool-call lifecycle (see ui/tool-call-state): the machine in
  // toolCallRef is the single source for "is a tool running / since when".
  // toolHint state mirrors its display name (render trigger) through the
  // single writer applyToolCall below — never written directly. Duration is
  // display-only (TUI timing, never execution logic); parallel batches share
  // it (last start wins — approximate, display-only).
  const toolCallRef = useRef<ToolCallMachine>(IDLE_TOOL_CALL);
  // Structured tool identity (ticket 02 sink consumer): FIFO of started
  // tools in commit order ({toolCallId, name, startedAt}). The loop's
  // onToolStarted fires before each commit and onToolFinished right after
  // the matching onToolActivity, so the queue head at activity time IS the
  // committing call's stable identity — no label parsing. Lifetime ⊆ one
  // turn like toolCallRef/pendingDiffRef: cleared at turn start and in the
  // turn-end finally so a cancelled/vetoed start can never leak sideways.
  const toolIdentityQueueRef = useRef<
    Array<{ toolCallId: string; name: string; startedAt: number }>
  >([]);
  // Latest streamed answer text (display bookkeeping only): if the turn
  // FAILS after streaming (rate limits, dead network), the catch path
  // commits this as a marked partial turn so the output never vanishes.
  // History still rolls back (the model never sees it); the transcript
  // keeps what the user already read. Cleared at every turn start.
  const lastPartialRef = useRef("");
  // Streamed answer text already placed in the transcript this turn.
  // Multi-POST turns stream inter-tool chatter the loop keeps only in
  // history — without this the commit (final `reply` only) drops what the
  // user already read, and an empty final reply commits a blank turn that
  // reads as vanished output. Drained at tool commits and turn end; reset
  // at every turn start alongside lastPartialRef.
  const committedStreamRef = useRef("");
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
  // Current context load driving status P% (last POST input tokens incl.
  // cache when available, else the 4ch/token estimate). Null until the first turn
  // completes. NK stays cumulative; P must NOT use the cumulative total.
  const [contextLoad, setContextLoad] = useState<number | null>(null);
  const contextLoadRef = useRef<number | null>(null);
  // Estimate latch (ticket 07 closes the ticket-06 follow-up): true when the
  // load behind P% is the chars/token heuristic rather than provider-reported
  // input tokens (post-compaction / /clear / resume / switch resets, or a
  // provider that never reports prompt_tokens). False once a main-loop POST
  // reports prompt_tokens; null when there is no load to qualify. Passed to
  // the status bar's `loadEstimated` prop — the bar's own heuristic covers
  // only the never-reported case, this latch covers the reset paths.
  const [loadEstimated, setLoadEstimated] = useState<boolean | null>(null);
  const loadEstimatedRef = useRef<boolean | null>(null);
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
  // Last POST's reported input-side tokens (prompt_tokens, normalized at
  // parse time to include exclusive cache counters) — the load metric source.
  // Summary-request usage never touches this — only main-loop POSTs do.
  const lastPromptTokensRef = useRef<number | undefined>(undefined);
  // Last main-loop POST's full reported usage (the real-total source for the
  // overflow trigger below). Summary/judge POSTs never touch this — only
  // main-loop POSTs do (same rule as lastPromptTokensRef). Reset everywhere
  // the load latch resets: the old report no longer measures this context.
  const lastUsageRef = useRef<Usage | undefined>(undefined);
  // Thrash guard: consecutive auto-compactions without the load dropping
  // below threshold. At 3, auto disables for the session (manual still
  // works and resets the counter on success).
  const autoStreakRef = useRef(0);
  // Per-turn file-diff watermark (ticket 06): index into historyRef.current
  // up to which committed tool_calls have been collected into the session's
  // metadata.filediffs record. Replacements (compact/switch/resume/new/
  // clear) swap the array, so the read site guards a stale watermark into
  // a rescan — merge dedupes, so records are never lost, only re-scanned.
  const fileDiffsWatermarkRef = useRef(0);
  const [autoDisabled, setAutoDisabled] = useState(false);
  const autoDisabledRef = useRef(false);
  // /compact typed while busy: focus text ("" = no focus) runs at turn end,
  // never mid-turn. Null = none pending.
  const pendingCompactRef = useRef<string | null>(null);
  // Startup hint: a save file exists from a previous session. Rendered once
  // as a dim line while the transcript is empty; the conversation itself
  // never auto-restores (only provider/model/effort do, via restorePrefs).
  const [sessionHint] = useState(() => sessionExists(authHome));
  // Active session display title (rename feedback + failure messages).
  // Initialized from the store record when one already exists (sync disk
  // read, no write — creation stays in the mount effect); thereafter the
  // store is the source of truth and every sync point below refreshes it.
  // Deliberately NOT in the status bar: the sole info bar has a fixed width
  // budget and a ~30-char title wraps `mode: X` onto its own line. Session
  // identity surfaces instead in the /session picker rows, the rename
  // confirmation, and the switch/new notices.
  const [sessionTitle, setSessionTitle] = useState(() => {
    try {
      return getActiveSession(authHome)?.title ?? "";
    } catch {
      return "";
    }
  });
  const sessionTitleRef = useRef(sessionTitle);
  // Reasoning label from response metadata (via onReasoning). The status
  // line shows the session effort when non-Auto; when effort is Auto it
  // shows this label, falling back to `auto`.
  const [reasoning, setReasoning] = useState<string | null>(null);
  // Live streaming state: the growing assistant text (onToken) and the
  // thinking channel (onThinking) live in a per-mount StreamStore, NOT in App
  // useState. Token paints (up to ~15/sec) notify only the subscribed
  // LiveTailHost — App's body and every other leaf skip them entirely.
  // `phase`/`phaseDetail`/`toolHint` stay in App state: they change at most a
  // few times per turn (low frequency, and StatusBar legitimately needs them).
  const [streamStore] = useState(() => createStreamStore());
  // Centralized streaming paint scheduler (render-stability): ONE trailing
  // timer for the answer draft + thinking lanes. onToken/onThinking push
  // every partial (activity/stall tracking stays per-token); paints coalesce
  // to one per DRAFT_THROTTLE_MS window, delivered in a single store update
  // so both lanes land in the same React render. Flushed on done/turn-end
  // and on tool transitions, errors, and cancellation (no stale trailing
  // paint may outlive the state it depicts).
  const paintSchedulerRef = useRef<PaintScheduler | null>(null);
  function paintScheduler(): PaintScheduler {
    let ps = paintSchedulerRef.current;
    if (!ps) {
      ps = createPaintScheduler({
        intervalMs: DRAFT_THROTTLE_MS,
        now,
        setTimeoutFn,
        clearTimeoutFn,
        onFlush: (lanes) => {
          // Paint path only: the commit carries the byte-exact full text.
          // One store update notifies LiveTailHost alone — never App.
          streamStore.set(lanes);
        },
      });
      paintSchedulerRef.current = ps;
    }
    return ps;
  }
  function flushDraft() {
    try {
      paintScheduler().flush();
    } catch {
      // ignore (draft stays as-is; the commit carries the full text)
    }
  }
  // Thinking channel (onThinking): reasoning text streamed apart from the
  // answer, rendered in its own dim block below. The live value is transient
  // like the draft — cleared on every turn boundary below — but each completed
  // round commits to the transcript via commitThinking (stays in the TUI,
  // never the model history) instead of being replaced and lost.
  const thinkingRef = useRef<string | null>(null);
  // Move the accumulated round thinking into the transcript as a quiet
  // annotation turn (no-op when empty). Called when a new POST starts and at
  // turn end, so every round's reasoning stays visible; the /thinking toggle
  // only controls rendering, never this record.
  function commitThinking(): void {
    const text = thinkingRef.current;
    thinkingRef.current = null;
    try {
      // Drop any trailing paint: the commit carries the full text, and a
      // late flush must never resurrect stale reasoning after the clear.
      paintScheduler().cancel("thinking");
    } catch {
      // ignore (the store clear below still wins)
    }
    streamStore.setThinking(null);
    if (typeof text === "string" && text.length > 0) {
      appendTurns({ role: "assistant", content: text, thinking: true });
    }
    // Inter-round gap guard: reset hasHadOutput so the thinking-gap
    // spinner shows during the transition to the next round. Without
    // this, hasHadOutput (set true by the previous round) suppresses
    // the spinner and the live zone goes blank between rounds.
    setHasHadOutputBoth(false);
  }
  function clearThinking(): void {
    thinkingRef.current = null;
    try {
      paintScheduler().cancel("thinking");
    } catch {
      // ignore (the store clear below still wins)
    }
    streamStore.setThinking(null);
  }
  // Take streamed answer text not yet in the transcript (null when none or
  // already committed). Marks the take so later drains never duplicate it.
  function takeUncommittedStream(): Turn | null {
    const text = lastPartialRef.current;
    if (typeof text !== "string" || text.trim().length === 0) return null;
    if (text === committedStreamRef.current) return null;
    committedStreamRef.current = text;
    return { role: "assistant", content: text };
  }
  const [phase, setPhase] = useState<Phase | "idle">("idle");
  const [phaseDetail, setPhaseDetail] = useState("");
  const [toolHint, setToolHint] = useState<string | null>(null);
  // Synchronous mirrors for the hot loop callbacks: zen fires
  // onPhase("streaming") on EVERY content chunk, so the handler must not
  // issue same-value setStates per token (React re-invokes the component
  // before bailing out — 15 App-body executions/sec for nothing).
  // setPhaseBoth is the only writer; equal values skip setState entirely.
  const phaseRef = useRef<Phase | "idle">("idle");
  const phaseDetailRef = useRef("");
  function setPhaseBoth(next: Phase | "idle", detail: string) {
    if (phaseRef.current !== next) {
      phaseRef.current = next;
      setPhase(next);
    }
    if (phaseDetailRef.current !== detail) {
      phaseDetailRef.current = detail;
      setPhaseDetail(detail);
    }
  }
  // Single writer for the live tool-call lifecycle (see ui/tool-call-state):
  // every announced/started/finished/cleared event flows through the machine
  // and toolHint mirrors its display name — one render trigger, no second
  // source. Same-value transitions skip setState entirely (hot-path safe:
  // deltas + per-chunk phases must not re-render App).
  function applyToolCall(event: ToolCallEvent): void {
    const prev = toolCallDisplayName(toolCallRef.current);
    toolCallRef.current = transitionToolCall(toolCallRef.current, event, clockNow());
    const name = toolCallDisplayName(toolCallRef.current);
    if (name !== prev) setToolHint(name);
  }
  // Production paint path uses paintScheduler() above (single trailing
  // timer for both lanes). createDraftThrottler further below is retained
  // for its unit tests and as the documented single-lane primitive.
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
  // calls (mount + picker-open + /model refresh), so servers are never probed twice.
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
    return `${name} is unreachable at ${r.baseURL} — start the server, then run /model refresh.`;
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
  // Suppresses the "Thinking… · Xs" gap spinner after any output has
  // appeared in the turn — without this the gap reappears between the
  // final answer commit (draft cleared) and the busy teardown, and a
  // stalled busy (e.g. compaction or a slow provider) can show the gap
  // for 61s even though the answer is already done (visual bug).
  const [hasHadOutput, setHasHadOutput] = useState(false);
  const hasHadOutputRef = useRef(false);
  function setHasHadOutputBoth(next: boolean) {
    if (hasHadOutputRef.current !== next) {
      hasHadOutputRef.current = next;
      setHasHadOutput(next);
    }
  }
  // Mirror for the per-token stall reset (same same-value-setState hazard
  // as phase above — noteTurnActivity runs on every chunk).
  const stalledRef = useRef(false);
  function setStalledBoth(next: boolean) {
    if (stalledRef.current !== next) {
      stalledRef.current = next;
      setStalled(next);
    }
  }
  const turnStartRef = useRef(0);
  const lastActivityRef = useRef(0);
  const turnTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Startup snapshot of the system prompt (default + repo AGENTS.md),
  // re-read by /reload for subsequent turns (history itself is untouched).
  const [systemPrompt, setSystemPrompt] = useState(buildSystemPrompt);
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
  // pinned to history[0] (the system prompt), NEVER
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

  // --- Core → Event Stream → TUI Adapter (separation audit) ---
  // Live frontend hooks for core turns (see CoreHooks in agent/core): the
  // approval modal, the ask_question modal, the plan-gated executor, the
  // goal machinery, and the approve-time capture consumer. Mirrored every
  // render into the ref; the stable getHooks accessor above hands the latest
  // set to the core at turn start. Without these the core path is headless
  // (gated calls denied, questions erroring) — with them it is the same
  // App the legacy loop drives, only reached through semantic events.
  const coreHooksRef = useRef<CoreHooks | null>(null);
  coreHooksRef.current = {
    approve: (name, args) => approve(name, args),
    askUser: (question, options, allowCustom) => askUser(question, options, allowCustom),
    execute: (name, args) => guardedExecute(name, args),
    goal: {
      getGoal: () => goalRef.current,
      pauseGoal: (notice: string) => {
        pauseGoalWithNotice(notice);
      },
      onGoalRequest: () => {
        patchGoalStats((s) => ({ ...s, requests: s.requests + 1 }));
      },
      onGoalTurn: () => {
        patchGoalStats((s) => ({ ...s, turns: s.turns + 1 }));
      },
    },
    goalJudge: ({ goal: objective, turns: judgeTurns }) => {
      return requestGoalVerdict({
        provider: providerRef.current,
        apiKey: keyForProvider(providerRef.current),
        model: modelRef.current,
        systemContent: systemPrompt,
        goal: objective,
        turns: judgeTurns,
        baseURL: chatBaseURL(providerRef.current),
        endpointOverride: activeEndpoint,
        signal: turnCancelRef.current?.signal ?? null,
        onUsage: (u) => {
          accumulateUsage(u, false);
        },
      });
    },
    consumeCommitExtras: (name) => {
      const extras = consumePendingSlots((slotName) => slotName === name);
      return { diff: extras.diff, approvalVia: extras.approvalVia };
    },
  };
  // The TUI must not orchestrate the agent; it only renders semantic events.
  // `AgentCore` owns history, permissions, tools, retries, and emits
  // `AgentEvent`s (agent.started, thinking.*, message.*, tool.*, etc.).
  // `useAgentAdapter` transforms those events into the `Turn` model that
  // `Conversation`/`LiveTail` already render. No `src/tools` or
  // `runAgenticLoopForProvider` call lives in the render path below — the
  // adapter is the single translation layer. This keeps `src/agent/*` free
  // of `ink` and lets WebUI/API reuse the same core via the same stream.
  const agentCore = useMemo(() => new AgentCore({
    provider: providerRef.current,
    model: modelRef.current,
    effort: "auto",
    mode: mode as "normal" | "yolo" | "plan",
    history: historyRef.current,
    cwd: process.cwd(),
    // Stable accessor: the core reads hooks once per turn, so a turn sees
    // one consistent frontend. The closures below re-create per render but
    // read live refs (mode/trust/rules/keys), and approve/askUser/guarded*
    // are hoisted declarations — always the current modal machinery.
    getHooks: () => coreHooksRef.current ?? {},
  }), []); // created once; opts patched via effect below
  const adapter = useAgentAdapter(agentCore, turns);
  // Keep core's view of history/model/mode in sync with TUI controls.
  // Core owns the history array; the adapter's turns are the UI projection.
  // This effect is the *only* place where TUI state flows into core — the
  // opposite direction is always via events, never direct mutation.
  useEffect(() => {
    agentCore.updateOpts({ provider: providerRef.current, model: modelRef.current, mode: mode as "normal" | "yolo" | "plan" });
    agentCore.setHistory([...historyRef.current]);
  }, [provider, model, mode, historyRef.current.length]);

  // Fix 02 — core path mid-turn tick: each per-POST usage.reported ticks
  // the same NK/P% accumulators the legacy loop's onUsage uses, so the
  // footer updates between tool rounds on the core path too.
  useEffect(() => {
    const unsub = agentCore.onEvent((e) => {
      if (e.type === "usage.reported") {
        accumulateUsage(e.usage);
        recordLedgerStep("turn", e.usage);
      }
    });
    return unsub;
  }, [agentCore]);

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
  // zero fetches; refreshed on /skill, /clear, /new below).
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
    // Guarded: runs on every token/thinking/phase event, but only a
    // true→false transition may schedule a render.
    setStalledBoth(false);
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
    setStalledBoth(false);
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
          // Guarded: the stalled flag flips false→true once per silence
          // window, not on every tick within it.
          if (!stalledRef.current) setStalledBoth(true);
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
      // Extension host teardown: subscribers observe the shutdown, then the
      // runtime is dropped. Best-effort and synchronous from React's side
      // (emit records its own errors, never rejects).
      // Extension UI teardown (ticket 10): remove every contribution with
      // zero residue first, then let subscribers observe the shutdown —
      // anything a shutdown handler re-registers lands in a dropped
      // runtime (ref nulled below) and never paints.
      try {
        extRuntimeRef.current?.disposeUI();
      } catch {
        // ignore
      }
      try {
        void extRuntimeRef.current?.emit("session_shutdown", { reason: "quit" });
      } catch {
        // ignore
      }
      extRuntimeRef.current = null;
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
        paintSchedulerRef.current?.cancel();
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
    // Mentions/paste re-anchor: drop attachments whose token vanished.
    if (mentionsRef.current.length > 0) {
      const pruned = pruneMentions(next, mentionsRef.current);
      if (pruned.length !== mentionsRef.current.length) mentionsRef.current = pruned;
    }
    if (pastedChunksRef.current.length > 0) {
      const pruned = prunePastedChunks(next, pastedChunksRef.current);
      if (pruned.length !== pastedChunksRef.current.length) pastedChunksRef.current = pruned;
    }
    // Update mention picker after every edit.
    updateMentionPicker(next, clamped);
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
  // Mention/paste/shell helpers — keep refs in sync with state.
  function setMentionVisibleBoth(next: boolean) {
    mentionVisibleRef.current = next;
    setMentionVisible(next);
  }
  function setMentionQueryBoth(next: string) {
    mentionQueryRef.current = next;
    setMentionQuery(next);
  }
  function setMentionCandidatesBoth(next: string[]) {
    mentionCandidatesRef.current = next;
    setMentionCandidates(next);
  }
  function setMentionIndexBoth(next: number) {
    mentionIndexRef.current = next;
    setMentionIndex(next);
  }
  function setMentionTriggerStartBoth(next: number | null) {
    mentionTriggerStartRef.current = next;
    setMentionTriggerStart(next);
  }
  function setMentionPoolBoth(next: string[]) {
    mentionPoolRef.current = next;
    setMentionPool(next);
  }
  // Fetch mention pool once on mount (and on cwd change via manual refresh if needed).
  useEffect(() => {
    let cancelled = false;
    void listMentionFiles(process.cwd()).then((files) => {
      if (cancelled) return;
      const pool = buildMentionPool(files);
      setMentionPoolBoth(pool);
      mentionPoolReadyRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);
  function updateMentionPicker(nextInput: string, nextCursor: number) {
    const trigger = mentionTriggerIndex(nextInput, nextCursor);
    if (!trigger) {
      if (mentionVisibleRef.current) {
        setMentionVisibleBoth(false);
        setMentionQueryBoth("");
        setMentionCandidatesBoth([]);
        setMentionIndexBoth(0);
        setMentionTriggerStartBoth(null);
      }
      return;
    }
    const query = trigger.query;
    let pool = mentionPoolRef.current;
    if (pool.length === 0) {
      try {
        const syncFiles = listMentionFilesSync(process.cwd());
        const syncPool = buildMentionPool(syncFiles);
        if (syncPool.length > 0) {
          pool = syncPool;
          setMentionPoolBoth(syncPool);
          mentionPoolReadyRef.current = true;
        }
      } catch {}
    }
    const candidates = filterMentionCandidates(pool, query, 20);
    setMentionTriggerStartBoth(trigger.start);
    setMentionQueryBoth(query);
    setMentionCandidatesBoth(candidates);
    setMentionVisibleBoth(candidates.length > 0 || query === "" );
    // Keep highlight within bounds, reset to 0 on query change.
    if (mentionQueryRef.current !== query) setMentionIndexBoth(0);
    else if (mentionIndexRef.current >= candidates.length) setMentionIndexBoth(0);
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

  function setExtDlgSelBoth(next: number) {
    extDlgSelRef.current = next;
    setExtDlgSel(next);
  }

  function setExtDlgCustomBoth(next: string) {
    extDlgCustomRef.current = next;
    setExtDlgCustom(next);
  }

  function setEffortBoth(next: ReasoningEffort) {
    // Central normalization point: every restore path (saved prefs, session
    // switch, picker) funnels through here, so a legacy "default" can never
    // linger in live state.
    const canonical = normalizeEffort(next);
    effortRef.current = canonical;
    setEffort(canonical);
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
    setSelectingSession(false);
    setSelectingMcp(false);
    setSessionFilterBoth("");
    setSelectingEffort(false);
    setSelectingProvider(false);
    setKeyPromptBoth(null);
    setBaseURLPromptBoth(null);
    setSelectingRewind(false);
    setSelectingRewindScope(false);
    pendingRewindRef.current = null;
  }

  // /skill picker (opencode-style searchable popup): opens on the fresh
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
  // /session picker open: snapshot the store list ONCE (most-recent-first
  // from listSessions) with the active record marked, then filter in memory
  // per keystroke (no disk reads while typing). Idle-only (callers gate on
  // busy like every picker — a mid-turn switch would race the loop's own
  // history writes). Empty store degrades to a notice (unreachable while
  // the mount bootstrap holds, but never a blank popup).
  function openSessionPicker(initialFilter: string): void {
    setInputBoth("");
    closeAllPickers();
    let records;
    try {
      records = listSessions(authHome);
    } catch {
      pushInfo("(could not list sessions — store unreadable)");
      return;
    }
    if (records.length === 0) {
      pushInfo("(no sessions yet — your current conversation is saved automatically)");
      return;
    }
    let activeId: string | null = null;
    try {
      activeId = getActiveSessionId(authHome);
    } catch {
      activeId = null;
    }
    setSessionItems(
      records.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        turnCount: s.turns.length,
        active: s.id === activeId,
      }))
    );
    setSessionFilterBoth(initialFilter);
    setSessionIndexBoth(0);
    setSelectingSession(true);
  }
  // /mcp popup open: snapshot configured servers + live status ONCE (idle
  // only — a mid-turn toggle would race the loop's in-flight tool catalog).
  // Empty config degrades to a notice, never a blank popup.
  function describeMcpPopupEntry(
    name: string,
    enabled: boolean,
    status: { status: string; tools?: number; error?: string } | undefined
  ): McpPopupEntry {
    if (!status) return { name, enabled, detail: "not initialized" };
    if (status.status === "connected") return { name, enabled: true, detail: `connected · ${status.tools ?? 0} tools` };
    if (status.status === "disabled") return { name, enabled: false, detail: "disabled" };
    if (status.status === "needs_auth") return { name, enabled, detail: "needs authentication" };
    if (status.status === "failed") return { name, enabled, detail: `failed · ${status.error ?? "unknown"}` };
    return { name, enabled, detail: status.status };
  }
  function openMcpPicker(): void {
    setInputBoth("");
    closeAllPickers();
    if (busyRef.current) {
      pushInfo("MCP servers load when idle — wait for the turn to finish.");
      return;
    }
    void (async () => {
      try {
        const [{ mcpManager }, { loadAtomConfig }] = await Promise.all([
          import("./mcp/manager.js"),
          import("./config.js"),
        ]);
        await mcpManager.ensureReady(process.cwd());
        const configured = loadAtomConfig().config.mcp ?? {};
        const names = Object.keys(configured);
        if (names.length === 0) {
          pushInfo('(no MCP servers configured — add one to atom.json under "mcp")');
          return;
        }
        const status = mcpManager.status();
        setMcpItems(
          names.map((name) =>
            describeMcpPopupEntry(name, configured[name]?.enabled !== false, status[name])
          )
        );
        setMcpIndexBoth(0);
        setSelectingMcp(true);
      } catch {
        pushInfo("(could not load MCP servers)");
      }
    })();
  }
  // Space-toggle handler: optimistic row flip, then the persisted toggle +
  // reconnect; the list re-syncs from the manager so the paint never lies.
  // Failures surface as info lines with the row left as the manager reports.
  function toggleMcpEntry(name: string): void {
    const current = mcpItems.find((e) => e.name === name);
    if (!current) return;
    const next = !current.enabled;
    setMcpItems(mcpItems.map((e) => (e.name === name ? { ...e, enabled: next, detail: "reconnecting…" } : e)));
    void (async () => {
      try {
        const [{ mcpSetServerEnabled, mcpManager }, { loadAtomConfig }] = await Promise.all([
          import("./mcp/manager.js"),
          import("./config.js"),
        ]);
        await mcpSetServerEnabled(name, next, process.cwd());
        const configured = loadAtomConfig().config.mcp ?? {};
        const status = mcpManager.status();
        setMcpItems(
          Object.keys(configured).map((n) =>
            describeMcpPopupEntry(n, configured[n]?.enabled !== false, status[n])
          )
        );
      } catch {
        pushInfo(`(could not toggle MCP server "${name}")`);
      }
    })();
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
    // Provider switch resets the load latch: the last reported input tokens
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

  function setSessionTitleBoth(next: string) {
    sessionTitleRef.current = next;
    setSessionTitle(next);
  }

  function setContextLoadBoth(next: number | null) {
    contextLoadRef.current = next;
    setContextLoad(next);
  }

  function setLoadEstimatedBoth(next: boolean | null) {
    loadEstimatedRef.current = next;
    setLoadEstimated(next);
  }

  function setAutoDisabledBoth(next: boolean) {
    autoDisabledRef.current = next;
    setAutoDisabled(next);
  }

  // Recompute contextLoad after a committed turn (or compaction): last
  // POST input tokens (incl. cache) when available, else the 4ch/token estimate.
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

  // Load-reset contract (hold-last-known): the reported input tokens survive
  // silent POSTs — estimates never override a fresher report — and reset ONLY
  // here: compaction, /clear, resume, and model/provider switch. After a reset
  // the chars/4 estimate applies until the next report arrives.
  function resetContextLoadToEstimate(): void {
    lastPromptTokensRef.current = undefined;
    lastUsageRef.current = undefined;
    // The estimate applies until the next report arrives: the latch marks
    // P% estimated so the bar reads `(~P%)`, never an exact fact.
    setLoadEstimatedBoth(true);
    if (!usageRef.current) {
      setContextLoadBoth(null);
    } else {
      setContextLoadBoth(estimateTokensForChars(historyChars(historyRef.current)));
    }
  }

  function pushInfo(content: string) {
    appendTurns({ role: "tool", content });
  }

  // Extension slash-command execution (ticket 04): handlers run outside
  // the model turn loop — no history writes, no telemetry turn, no busy
  // flag. say() posts transcript turns only (pushInfo), so a throwing
  // handler surfaces one clean error line and leaves the model session
  // untouched. The context is bound to the runtime generation at launch:
  // a session replacement mid-command makes further ctx use throw into
  // the same clean-error path.
  async function runExtensionCommandFromApp(name: string, args: string): Promise<void> {
    if (extCommandRunningRef.current) {
      pushInfo("(an extension command is already running — wait for its prompt)");
      return;
    }
    extCommandRunningRef.current = true;
    try {
      const runtime = extRuntimeRef.current;
      const gen = runtime?.generation ?? 0;
      const result = await runExtensionCommand(name, args, {
        cwd: storeCwd(),
        askUser,
        getSession: () => ({
          id: activeSessionIdRef.current,
          title: sessionTitleRef.current,
          turnCount: turnsRef.current.length,
        }),
        say: (message) => {
          pushInfo(message);
        },
        checkStale: () => {
          if (runtime && runtime.generation !== gen) {
            throw new Error("extension context is stale after a session replacement — rerun the command for fresh state");
          }
        },
      });
      if (!result.ok) pushInfo(result.error);
    } finally {
      extCommandRunningRef.current = false;
    }
  }

  // The session's ContextManager: window-derived budgets for the active
  // model plus measured tool schemas. Built fresh per call
  // (pure math, no I/O beyond compactPct) so it always sees
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
    // Window-derived allowance is informational only: history is never
    // truncated, compaction is the only pressure valve.
    const allowanceLine =
      b.historyChars !== undefined && b.windowTokens !== undefined
        ? `allowance: ~${(b.historyChars / 1000).toFixed(0)}K chars of history fit the ${(b.windowTokens / 1000).toFixed(0)}K verified window`
        : `allowance: no verified window — history uncapped, use /compact manually`;
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
    // MCP name-collision warnings from the latest refresh (collected, never
    // console — see McpManager.warnings). Live read: refreshes land after
    // this snapshot, so /context always shows the current set.
    const mcpWarns = mcpWarnings();
    const mcpLine =
      mcpWarns.length > 0 ? `mcp warnings:\n${mcpWarns.map((w) => `- ${w}`).join("\n")}` : "";
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
      (mcpLine ? `${mcpLine}\n` : "") +
      `${cacheLine}\n` +
      // Effective compaction settings (issue 01): auto switch, tail
      // budget, turn-count cap, and prune flag — the knobs that
      // control compaction behavior for this session.
      (() => {
        const auto = compactAutoEnabled();
        const tailTok = compactPreserveRecentTokens();
        const tailTurns = compactTailTurns();
        const prune = compactPruneEnabled();
        const parts = [`auto: ${auto ? "on" : "off"}`];
        parts.push(`tail budget: ${tailTok !== undefined ? formatKEst(tailTok * 4) : "default (25% of model window, 2K–15K)"}`);
        parts.push(`tail turns cap: ${tailTurns !== undefined ? tailTurns : "none"}`);
        parts.push(`prune old tool outputs: ${prune ? "on" : "off"}`);
        return `compaction: ${parts.join(", ")}`;
      })() +
      `\n` +
      `${loadLine}\n` +
      `${allowanceLine}`
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
  //
  // Multi-session mirror (src/sessions.ts): every conversation auto-belongs
  // to a durable session record (~/.atom/sessions/<id>.json + active
  // pointer). persistSession() also mirrors the same committed snapshot
  // into the active record via persistStoreSession() below, so completed
  // turns, clean exits, and successful compactions bump updatedAt there too.
  // Failures/cancels never reach here (same rollback rule as legacy).
  // Active id lives in a ref only — never a session list in runtime state.
  const activeSessionIdRef = useRef<string | null>(null);
  // Extension host (ticket: extension system 01): the loaded runtime lives
  // in a ref so session replacements can invalidate it without re-render.
  // Null until the mount-time load completes (or when nothing is installed).
  const extRuntimeRef = useRef<ExtensionRuntime | null>(null);
  // UI-subscription handle for the live runtime: released before every
  // cutover (/reload) so the dead lineage stops re-rendering the host.
  const extUnsubRef = useRef<(() => void) | null>(null);
  // An extension slash command in flight owns the question modal while
  // prompting (single slot shared with ask_question): submit routes new
  // model turns and nested extension commands aside with a notice until
  // this clears, so resolvers can never clobber each other.
  const extCommandRunningRef = useRef(false);
  /**
   * Session-replacement boundary for extensions: previously handed-out API
   * objects go stale (loud on use), then session_start fires for the new
   * lineage. This is the sanctioned post-replacement continuation — work
   * that must continue after a replacement runs in session_start handlers
   * via their fresh API, never via a captured pre-replacement handle (which
   * throws). Never throws; a missing runtime is a no-op. Callers bind the
   * new session id via runtime.setSessionId BEFORE calling, so start
   * handlers observe the new session's extension state.
   */
  function replaceExtensionContext(reason: string): void {
    const runtime = extRuntimeRef.current;
    if (!runtime) return;
    try {
      runtime.invalidate(
        `extension context is stale after session ${reason} — use the fresh API passed to your session_start handler`
      );
    } catch {
      // invalidate never throws by contract; defensive only.
    }
    void runtime.emit("session_start", { reason });
  }
  function storeCwd(): string {
    try {
      return process.cwd();
    } catch {
      return "";
    }
  }
  // Ensure exactly one active persistent session exists (fresh mount creates
  // one with the current provider/model/effort/mode + cwd). Never throws,
  // never blocks render — disk errors leave the ref null and the next
  // persist retries.
  function ensureStoreSession(): string | null {
    try {
      const existing = activeSessionIdRef.current;
      // The record may vanish under a running process (external delete,
      // corrupted file): a stale cached id must re-ensure instead of
      // persisting into the void (every later turn would silently skip).
      if (existing) {
        try {
          if (getSession(existing, authHome)) {
            try {
              setActiveTodoSession(existing);
            } catch {
              // ignore
            }
            return existing;
          }
        } catch {
          // fall through to re-ensure below
        }
      }
      const s = ensureActiveSession(
        {
          cwd: storeCwd(),
          provider: providerRef.current,
          model: modelRef.current,
          effort: effortRef.current,
          mode: modeRef.current,
        },
        authHome
      );
      activeSessionIdRef.current = s.id;
      // Fix 1 — keep the live todo list scoped to the active session so a
      // switch cannot leak the previous plan (the disk record is durable,
      // but the in-memory list must track the active id).
      try {
        setActiveTodoSession(s.id);
      } catch {
        // ignore
      }
      // The store owns the title (a /rename from an earlier mount must show
      // after restart); sync the display state on every ensure.
      setSessionTitleBoth(s.title);
      return s.id;
    } catch {
      return null;
    }
  }
  // Mirror the committed snapshot into the active multi-session record
  // (single updateSession so updatedAt bumps on every committed turn).
  // Disk errors ignored, like the legacy save above.
  function persistStoreSession(): void {
    try {
      const id = ensureStoreSession();
      if (!id) return;
      // The live checklist rides every store persist (same call as every
      // completed turn — no new save cadence). Other metadata keys pass
      // through untouched; only metadata.todos is set (never filediffs).
      let diskMetadata: unknown;
      try {
        diskMetadata = getSession(id, authHome)?.metadata;
      } catch {
        diskMetadata = undefined;
      }
      // Per-turn file diffs (ticket 06): collect the tool_calls committed
      // since the last persist and merge them into the session-scoped
      // metadata.filediffs record. This site runs on completed turns only
      // (failed/cancelled turns roll back and never persist), so failed
      // work is never recorded. Delta-only scan; a stale watermark after
      // an array replacement degrades to a rescan, and merge dedupes.
      const liveHistory = historyRef.current;
      const diffsStart =
        fileDiffsWatermarkRef.current <= liveHistory.length
          ? fileDiffsWatermarkRef.current
          : 0;
      const diskRecord =
        typeof diskMetadata === "object" && diskMetadata !== null && !Array.isArray(diskMetadata)
          ? (diskMetadata as Record<string, unknown>)
          : undefined;
      const mergedDiffs = mergeFileDiffs(
        readFileDiffs(diskRecord?.[FILE_DIFFS_METADATA_KEY]),
        collectTurnFileDiffs(liveHistory.slice(diffsStart))
      );
      fileDiffsWatermarkRef.current = liveHistory.length;
      updateSession(
        id,
        {
          history: historyRef.current,
          turns: turnsRef.current.map((t) => {
            const { diff: _dropped, approvalVia: _viaDropped, summary: _summaryDropped, ...rest } = t;
            return rest;
          }),
          usageTotals: usageRef.current,
          // Piggyback: the live goal rides every store persist (same call
          // as every completed turn — no new save cadence). Switching away
          // snapshots this session's goal into its own record first, so a
          // switch back restores it and sessions never leak goals.
          goal: serializeGoalForPersist(goalRef.current),
          metadata: {
            ...withSessionTodos(diskMetadata, getTodos()),
            [FILE_DIFFS_METADATA_KEY]: serializeFileDiffs(mergedDiffs),
          },
          provider: providerRef.current,
          model: modelRef.current,
          effort: effortRef.current,
          mode: modeRef.current,
          cwd: storeCwd(),
        },
        authHome
      );
    } catch {
      // ignore disk errors (in-memory session still applies)
    }
  }
  // Fix 1 — per-session todos: bind the in-memory list to the active
  // session. Do NOT auto-hydrate stale checklist on fresh mount — the live
  // transcript is empty (system-only) and showing old todos is confusing
  // (user sees random Todos on start). Checklist reappears on explicit
  // /resume or session switch, which hydrate via todowriteTool.
  useEffect(() => {
    try {
      const active = getActiveSession(authHome);
      if (active) {
        setActiveTodoSession(active.id);
      } else {
        const id = ensureStoreSession();
        if (id) {
          setActiveTodoSession(id);
        }
      }
    } catch {
      // empty checklist fallback
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // One boot notice for the extension host (ticket 07): the existing
  // loaded/failed line, plus one line per skip reason so declined/untrusted/
  // locked-down/disabled extensions stay visible with how to enable them.
  // Silent when nothing loaded, failed, or skipped.
  function announceExtensionRuntime(runtime: ExtensionRuntime): void {
    if (runtime.loaded.length > 0 || runtime.errors.length > 0) {
      const names = runtime.loaded.map((e) => e.name).join(", ");
      const problems = runtime.errors.map((e) => `${e.path}: ${e.error}`).join("; ");
      pushInfo(
        `(extensions: ${runtime.loaded.length} loaded${names ? ` (${names})` : ""}` +
          `${problems ? `; ${runtime.errors.length} failed: ${problems}` : ""})`
      );
    }
    const byReason = new Map<ExtensionSkipReason, string[]>();
    for (const s of runtime.skipped) {
      const list = byReason.get(s.reason);
      if (list) list.push(s.name);
      else byReason.set(s.reason, [s.name]);
    }
    const whyFor = (reason: ExtensionSkipReason): string => {
      switch (reason) {
        case "lockdown":
          return "lockdown is on (--no-extensions)";
        case "untrusted-project":
          return "the project is not trusted";
        case "disabled":
          return "they match a disable pattern";
        case "not-enabled":
          return "they match no enable pattern";
      }
    };
    const hintFor = (reason: ExtensionSkipReason): string => {
      switch (reason) {
        case "lockdown":
          return "start without --no-extensions to load them";
        case "untrusted-project":
          return "trust the project when asked on next startup to load them";
        case "disabled":
          return 'remove the --disable-extension / atom.json "extensions.disabled" pattern to load them';
        case "not-enabled":
          return 'match them with --enable-extension / atom.json "extensions.enabled" to load them';
      }
    };
    for (const [reason, names] of byReason) {
      const unique = [...new Set(names)];
      pushInfo(
        `(extensions: ${unique.length} skipped (${unique.join(", ")}) — ${whyFor(reason)}; ${hintFor(reason)})`
      );
    }
  }
  // Mount bootstrap: claim/create the active session before any turn can
  // persist, so every normal conversation belongs to a durable session.
  // Startup never auto-restores conversation state (fresh + legacy hint,
  // matching current UX) — this only ensures the record exists.
  useEffect(() => {
    ensureStoreSession();
    // Extension host boot (best-effort, never blocks render): trust-gated
    // (ticket 07). Global-scope extensions are user-owned (implicitly
    // trusted, like the user's own config); project-scope + explicit-path
    // extensions never execute until the project is trusted — the user is
    // asked once via the question modal (declining, or Esc, leaves them fully
    // inert with a visible notice; the grant persists per project dir, so a
    // decline simply asks again next boot). Lockdown (--no-extensions) skips
    // the prompt and boots with zero third-party extensions. A loaded runtime
    // still records per-extension errors — loadExtensions never throws here.
    void (async () => {
      const cwd = storeCwd();
      const cfgExtensions = atomConfig.extensions;
      // CLI patterns win over atom.json when set (same CLI-over-config
      // layering as every other value); the project/global config merge
      // already applied inside loadAtomConfig.
      const enabled =
        enableExtensions !== undefined && enableExtensions.length > 0
          ? enableExtensions
          : (cfgExtensions?.enabled ?? []);
      const disabled =
        disableExtensions !== undefined && disableExtensions.length > 0
          ? disableExtensions
          : (cfgExtensions?.disabled ?? []);
      const lockdown = extensionsLockdown === true;
      const finish = async (trusted: boolean): Promise<void> => {
        const runtime = await loadExtensions({
          home: authHome,
          cwd,
          builtinSlashCommands: SLASH_COMMANDS.map((c) => c.name),
          projectTrusted: trusted,
          lockdown,
          enabledPatterns: enabled,
          disabledPatterns: disabled,
          // The TUI fulfills extension dialogs (ticket 10); headless modes
          // never load extensions, so they stay inert by construction.
          interactive: true,
        });
        extRuntimeRef.current = runtime;
        // Live UI surface: every segment/widget/notice/dialog mutation
        // re-renders (segments update across turns with no other trigger).
        try {
          extUnsubRef.current = runtime.subscribeUI(() => {
            bumpExtUI((v) => v + 1);
          });
        } catch {
          extUnsubRef.current = null;
        }
        // Bind the store session BEFORE the startup emit, so session_start
        // handlers observe the reloaded session's extension state (ticket 05:
        // per-session state restores on reload through the record metadata).
        runtime.setSessionId(activeSessionIdRef.current);
        announceExtensionRuntime(runtime);
        return runtime.emit("session_start", { reason: "startup" });
      };
      if (!lockdown) {
        const gated = discoverExtensionEntries({ home: authHome, cwd }).filter(
          (e) => e.scope !== "global"
        );
        if (gated.length > 0 && !isProjectTrusted(cwd, authHome)) {
          const names = [...new Set(gated.map((e) => resolveExtensionName(e.path)))];
          let answer: string;
          try {
            answer = await askUser(projectTrustQuestion(names), ["Trust and load", "Keep disabled"]);
          } catch {
            answer = "Keep disabled"; // Esc declines: inert + visible, asked again next boot
          }
          const trusted = answer === "Trust and load";
          if (trusted) grantProjectTrust(cwd, authHome);
          await finish(trusted);
          return;
        }
      }
      await finish(isProjectTrusted(cwd, authHome));
    })().catch(() => {
      // loadExtensions never rejects by contract; defensive only.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function persistSession() {
    try {
      saveSession(
        {
          provider: providerRef.current,
          model: modelRef.current,
          effort: effortRef.current,
          mode: modeRef.current,
          usageTotals: usageRef.current,
          // Piggyback: the live goal rides the legacy save too, so /resume
          // and restarts bring it back with its cumulative stats intact.
          goal: goalRef.current,
          history: historyRef.current,
          turns: turnsRef.current.map((t) => {
            const { diff: _dropped, approvalVia: _viaDropped, summary: _summaryDropped, ...rest } = t;
            return rest;
          }),
        },
        authHome
      );
    } catch {
      // ignore disk errors (in-memory session still applies)
    }
    persistStoreSession();
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
  // A non-reducing auto outcome (load still at/above threshold, or an
  // extension veto that changed nothing) counts toward the guard via
  // bumpAutoStreak, so a standing veto disables auto with the standard
  // notice instead of re-firing (and re-notifying) after every turn.
  function bumpAutoStreak(): void {
    autoStreakRef.current += 1;
    if (isThrashDisabled(autoStreakRef.current)) {
      setAutoDisabledBoth(true);
      appendTurns({
        role: "tool",
        content: "(auto-compact thrashing — disabled, use /compact or /clear)",
      });
    }
  }
  async function doCompact(focusText: string, isAuto: boolean): Promise<boolean> {
    if (countUserTurns(historyRef.current) <= 1) {
      if (!isAuto) pushInfo("(nothing to compact)");
      return false;
    }
    const split: SplitResult = splitHistoryForCompaction(
      historyRef.current,
      compactPreserveRecentTokens() ?? undefined,
      modelRef.current,
      compactTailTurns()
    );
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
      // Extension gate (ticket 09): consulted BEFORE the builtin summary
      // POST with the reason and the pending head/tail split as read-only
      // deep copies — a mutating hook cannot corrupt the split below, and a
      // cancelled attempt returns before EVERY write (history, snapshots,
      // totals, ledger stay byte-identical). Zero-cost when no hooks are
      // registered: the snapshot is a single spread and no await runs, so
      // hook-free auto-compact keeps its timing (the zen.ts context-hook
      // precedent). Fail-open: a throwing hook records a visible error and
      // compaction falls back to the builtin summary, never half-compacted.
      let customSummary: string | null = null;
      const compactHooks = beforeCompactInterceptors();
      if (compactHooks.length > 0) {
        const verdict = await applyBeforeCompact(compactHooks, {
          reason: isAuto ? "auto" : "manual",
          focusText,
          head: split.head,
          tail: split.tail,
          olderTurnCount: split.olderTurnCount,
        });
        if (verdict.cancelled) {
          pushInfo(
            verdict.cancelReason
              ? `(compaction cancelled: ${verdict.cancelReason})`
              : "(compaction cancelled by an extension)"
          );
          // A vetoed auto-compaction changes nothing, so the load that
          // triggered it is still above threshold — count it toward the
          // thrash guard (manual cancels are deliberate one-shots, untouched).
          if (isAuto) bumpAutoStreak();
          return false;
        }
        if (verdict.errors.length > 0) {
          pushInfo(
            `(extension compact hook failed — using builtin summary: ${verdict.errors.join("; ")})`
          );
        }
        if (verdict.summary !== null) customSummary = verdict.summary;
      }
      // Single injection point: a custom summary replaces the builtin text
      // here and flows through the SAME post-processing below (goal block +
      // touched-files append/fit, boundary marker, atomic swap, save,
      // snapshot clearing) exactly like builtin output — never a parallel
      // pipeline.
      // Usage ledger (05): the compaction POST gets exactly one row —
      // reported usage when the summary POST carries it, else an explicit
      // not-reported row. Captured here; recorded after the swap below.
      // A hook-supplied custom summary means no POST ran, so no row.
      let compactSummaryUsage: Usage | undefined;
      const summary =
        customSummary ??
        (await requestCompactSummary({
          provider: providerRef.current,
          apiKey: submitKey,
          model: modelRef.current,
          systemContent,
          head: split.head,
          focusText,
          // Ticket 08: the live goal objective (active or paused) hints the
          // summarizer to preserve goal-relevant content; undefined keeps
          // the legacy instruction byte-identical. goalRef survives the
          // swap below untouched, so post-compact turns read the same live
          // goal through the loop's getGoal seam.
          goalObjective: goalRef.current?.objective,
          baseURL,
          endpointOverride: activeEndpoint,
          onUsage: (u) => {
            compactSummaryUsage = u;
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
        }));
      // Atomic swap: build the new history first, then replace. The head's
      // touched files (collected from the committed tool_calls the loop
      // already recorded — no new tracking) plus the canonical `Goal:` block
      // (live text, state, cumulative stats, open checklist — the model's
      // context backstop; record restore stays the resume path) ride inside
      // the summary within budget, so compacted and resumed sessions continue
      // the same goal without re-exploring; over-budget lists shrink instead
      // of failing compaction (model text + goal block are never cut).
      const goalBlock = formatGoalForCompact(
        goalRef.current,
        getTodos().map((t) => ({ content: t.content, status: t.status }))
      );
      // Ticket 06: the session-scoped accumulated record (files from earlier
      // turns and prior compactions) merges with this head's touches, so
      // Relevant Files names exactly what the session touched — not just
      // the head being summarized now. Disk is the source of truth; a
      // failed read falls back to the head alone (compaction never fails
      // for a files feed).
      let recordedDiffs = emptyFileDiffs();
      try {
        const compactId = ensureStoreSession();
        if (compactId) {
          recordedDiffs = readFileDiffs(
            getSession(compactId, authHome)?.metadata?.[FILE_DIFFS_METADATA_KEY]
          );
        }
      } catch {
        // ignore — head touches alone still summarize
      }
      const fitted = fitSummaryWithFilesAndGoal(
        summary,
        mergeFileDiffs(recordedDiffs, collectTouchedFiles(split.head)),
        goalBlock
      );
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
      // Usage ledger (05): the compaction summary POST is a ledger row of
      // its own, visually distinct from turn steps. Only when a real POST
      // ran (a hook-supplied custom summary performs none).
      if (customSummary === null) {
        recordLedgerStep("compaction", compactSummaryUsage ?? null);
      }
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
      // pre-compact context (and its cache counters), so the estimate latch
      // resets onto the new history (marks P% `(~P%)` until next report).
      resetContextLoadToEstimate();
      if (isAuto) {
        const pct = compactPct();
        const window = contextWindowFor(modelRef.current);
        const newLoad = contextLoadRef.current ?? 0;
        if (window !== undefined && newLoad / window < pct) {
          autoStreakRef.current = 0;
        } else {
          bumpAutoStreak();
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

  // After a completed main turn: refresh load, reset the streak when the
  // real-usage overflow trigger is quiet, else auto-compact (known-window
  // models with a reported real total at/above the usable limit only,
  // unless thrash-disabled). Called while still busy, before the next turn.
  async function maybeAutoCompact(): Promise<void> {
    const load = refreshContextLoad();
    if (load === null) {
      autoStreakRef.current = 0;
      return;
    }
    // Unknown window or no real usage reported → no auto trigger (never
    // invent a window, never estimate); below the usable limit → streak
    // resets. shouldAutoCompactReal is false for all three, so re-check
    // the window for the reset.
    if (!shouldAutoCompactReal(modelRef.current, lastUsageRef.current)) {
      // Distinguish unknown-window (streak untouched — irrelevant) from
      // below-limit (streak resets).
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
    // Ticket 07: the saved goal restores verbatim (text, flag, cumulative
    // stats — never reset) and mirrors into the store record below, so the
    // resumed session continues the goal on its next turn. Corrupt/absent
    // goal data restores as no-goal without touching the conversation.
    setGoalBoth(restoreGoalFromPersist(s.goal));
    // Replacement: wrap the restored array (see the init comment).
    historyRef.current = trackHistory([...s.history]);
    // Task 6: refresh the pinned env block on the restored system line
    // (strips the saved block, appends a fresh one) — keeps the restored
    // AGENTS overlay, never touches user content.
    refreshSystemEnv();
    // Restored load is the estimate (no prompt_tokens survived the save);
    // thrash state restarts fresh on resume.
    resetContextLoadToEstimate();
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
    // Restored history is used whole: no caps, no trimming. A resumed
    // session knows what was touched without re-exploring the tree.
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
    // Mirror the restored legacy state into the active multi-session record
    // (create+activate when none exists). Startup itself never auto-restores
    // the store — only this explicit /resume does.
    persistStoreSession();
    // Same record stays active across a legacy resume — re-bind it so start
    // handlers observe the restored session's extension state (ticket 05).
    extRuntimeRef.current?.setSessionId(activeSessionIdRef.current);
    replaceExtensionContext("resume");
  }

  // /session switch: make the picked record the live conversation. Exactly
  // one history replacement (never merge, never duplicate): the target's
  // history/turns REPLACE the live arrays wholesale, following the doResume
  // precedent (endpoint recompute, env-block refresh, budget trim, lineage
  // drop, Static remount, title sync). Differences from /resume:
  // - the outgoing live state snapshots into the OLD record first, but only
  //   when it holds turns (a fresh mount's system-only live state is NOT the
  //   old record's content — persisting it would wipe that record);
  // - re-picking the current session is a no-op (reloading from disk would
  //   drop unpersisted live turns);
  // - updatedAt is NOT bumped (switching is navigation, not a mutation —
  //   listings keep true recency order);
  // - a missing/unreadable target errors WITHOUT touching the live session.
  // The legacy session.json follows the switch (same persistSession path as
  // every completed turn) so /resume stays coherent with the live view.
  async function switchToSession(id: string): Promise<void> {
    let target = null;
    try {
      target = getSession(id, authHome);
    } catch {
      target = null;
    }
    if (!target) {
      pushInfo("(session no longer available — staying on the current session)");
      return;
    }
    const currentId = activeSessionIdRef.current;
    if (currentId !== null && currentId === target.id) {
      pushInfo(`(already on "${target.title}")`);
      return;
    }
    // Cancellable gate FIRST (ticket 05): before_switch handlers run before
    // ANY snapshot/persist/mutate step (outgoing persist, active-pointer
    // write, ref swaps, legacy save), so a cancelled switch is a pure no-op
    // — the live session is byte-identical to before the call. Everything
    // below this point mutates, so nothing above it may.
    const gateRuntime = extRuntimeRef.current;
    if (gateRuntime) {
      let verdict: { cancelled: boolean; reason?: string };
      try {
        verdict = await gateRuntime.requestSwitch({ fromSessionId: currentId, toSessionId: target.id, reason: "switch" });
      } catch {
        // requestSwitch never rejects by contract; defensive only.
        verdict = { cancelled: false };
      }
      if (verdict.cancelled) {
        pushInfo(
          verdict.reason
            ? `(session switch cancelled: ${verdict.reason})`
            : "(session switch cancelled by an extension — staying on the current session)"
        );
        return;
      }
    }
    // Snapshot the outgoing conversation into its own record first (same
    // rule as /new's pre-reset save). Guarded: only when the live state
    // actually holds turns of the outgoing record.
    if (currentId !== null && currentId !== target.id && turnsRef.current.length > 0) {
      persistStoreSession();
    }
    try {
      setActiveSession(target.id, authHome);
    } catch {
      // setActiveSession never throws by contract; defensive only.
    }
    activeSessionIdRef.current = target.id;
    setProviderBoth(target.provider);
    const baseURL = chatBaseURL(target.provider);
    if (target.provider === "openai-compatible") {
      setActiveEndpoint(openaiCompatibleChatEndpoint(baseURL));
    } else if (target.provider === "opencode-zen") {
      setActiveEndpoint(endpoint);
    } else {
      setActiveEndpoint(chatEndpointFor(target.provider, baseURL));
    }
    setModelBoth(target.model);
    setEffortBoth(target.effort);
    setModeBoth(target.mode);
    setUsageBoth(target.usageTotals);
    // Ticket 07: the target's goal replaces the live one wholesale (never
    // merged) — a session without a saved goal lands on no-goal, so one
    // session's goal can never leak into another. The outgoing goal was
    // snapshotted into its own record above, so switching back restores it.
    setGoalBoth(restoreGoalFromPersist(target.goal));
    // Replacement: the target's arrays replace the live ones wholesale (a
    // fresh-created record carries empty history — fall back to a fresh
    // system line so the system-first invariant always holds).
    historyRef.current =
      target.history.length > 0
        ? trackHistory([...target.history])
        : trackHistory([{ role: "system", content: withEnvBlock(systemPrompt) }]);
    if (target.history.length > 0) {
      refreshSystemEnv();
    }
    // Switched sessions measure a different context: the estimate applies
    // until the next report (same latch as resume above).
    resetContextLoadToEstimate();
    autoStreakRef.current = 0;
    setAutoDisabledBoth(false);
    pendingCompactRef.current = null;
    const pendingNotices: Turn[] = [];
    // New lineage (see src/rollback.ts): checkpoint marks index the old
    // history — drop them, loudly when non-empty. Disk files untouched.
    const switchDrops = clearSnapshots();
    if (switchDrops > 0) {
      pendingNotices.push({
        role: "tool",
        content: `(/session — discarded ${switchDrops} live file checkpoint(s); undos do not cross a session switch)`,
      });
    }
    // Todo restore (mirrors the goal restore above): the target's checklist
    // replaces the live one wholesale (never merged) — one session's plan
    // can never leak into another. The outgoing list was snapshotted into
    // its own record by persistStoreSession above, so switching back
    // restores it. Absent/corrupt data lands on an empty list. Restored
    // through todowriteTool so the live invariants still hold; the record
    // always replays cleanly because it was valid when saved.
    // Fix 1 — scope the in-memory list to the target session before
    // clearing/replaying, so a missed clear cannot bleed across sessions.
    try {
      setActiveTodoSession(target.id);
    } catch {
      // ignore
    }
    clearTodos();
    const restoredTodos = readSessionTodos(target.metadata);
    if (restoredTodos.length > 0) {
      await todowriteTool({ todos: restoredTodos });
    }
    setTodoSnap(getTodos());
    // The target's history/turns REPLACE the live arrays wholesale — used
    // whole, never trimmed.
    for (const section of collectStoredTouchedFiles(historyRef.current)) {
      pendingNotices.push({ role: "tool", content: section });
    }
    // Same Static remount as /clear, /resume, and /new: the replaced list
    // must not reuse the old buffer.
    setScrollEndBoth(null);
    setClearGen((g) => g + 1);
    setTurnsBoth([
      ...target.turns,
      {
        role: "tool",
        content: `(switched to session "${target.title}" — ${target.turns.length} turns)`,
      },
      ...pendingNotices,
    ]);
    setSessionTitleBoth(target.title);
    telemetry.recordEvent("info", `session switched to ${target.id} (${target.turns.length} turns)`);
    persistTelemetry();
    // Legacy single-file save follows the switch so /resume restores what
    // the live view shows (same path/format as every completed turn).
    // Bind the new record BEFORE the boundary emit, so session_start
    // handlers observe the new session's extension state (ticket 05).
    extRuntimeRef.current?.setSessionId(target.id);
    persistSession();
    replaceExtensionContext("switch");
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
  // /rename for the CURRENT session only (never creates one: renameSession
  // touches exactly the active record). Bare /rename prints usage — ATOM has
  // no generic text-prompt overlay (key/baseURL prompts are
  // provider-specific), so an interactive flow would be a new UI system.
  // Empty/whitespace-only names are rejected safely (previous name kept).
  // On failure the previous name is preserved (title state only changes on
  // success); history/turns are never part of the write.
  function runRenameCommand(raw: string): void {
    const name = parseRenameArg(raw);
    if (!name) {
      pushInfo(RENAME_USAGE);
      return;
    }
    let id: string | null = null;
    try {
      id = ensureStoreSession();
    } catch {
      id = null;
    }
    if (!id) {
      pushInfo("(rename failed — session store unavailable; name unchanged)");
      return;
    }
    let renamed = null;
    try {
      renamed = renameSession(id, name, authHome);
    } catch {
      renamed = null;
    }
    if (!renamed) {
      const current = sessionTitleRef.current || "untitled";
      pushInfo(`(rename failed — still "${current}")`);
      return;
    }
    setSessionTitleBoth(renamed.title);
    pushInfo(`(renamed session to "${renamed.title}")`);
  }
  // /fork [n]: clone the active session into a brand-new session and switch
  // to it ("try another approach from here"). Bare forks at the tip; /fork
  // <n> keeps all but the last n messages (forkSession snaps the cut to a
  // turn boundary, so assistant/tool pairing never splits). Idle-only: the
  // wholesale live-array swap would race a running turn.
  async function runForkCommand(raw: string): Promise<void> {
    const arg = raw.trim() === "/fork" ? "" : raw.trim().slice("/fork".length).trim();
    let drop = 0;
    if (arg !== "") {
      if (!/^\d+$/.test(arg)) {
        pushInfo(FORK_USAGE);
        return;
      }
      drop = Number(arg);
    }
    let id: string | null = null;
    try {
      id = ensureStoreSession();
    } catch {
      id = null;
    }
    if (!id) {
      pushInfo("(fork failed — session store unavailable; staying put)");
      return;
    }
    // Snapshot live state first so unpersisted turns ride into the fork;
    // forkSession only reads the disk record.
    persistStoreSession();
    const keep = drop === 0 ? undefined : Math.max(0, historyRef.current.length - drop);
    let forked = null;
    try {
      forked = forkSession(id, keep, authHome);
    } catch {
      forked = null;
    }
    if (!forked) {
      pushInfo("(fork failed — source session unreadable; staying put)");
      return;
    }
    await switchToSession(forked.id);
    pushInfo(`(forked into "${forked.title}")`);
  }
  // /revert [n]: undo to a checkpoint via revertSessionToCheckpoint —
  // restores the session's conversation AND files, then swaps the live
  // arrays wholesale (switch precedent). Bare reverts to the latest
  // checkpoint; /revert <n> goes n checkpoints back. Idle-only: the swap
  // would race a running turn. Checkpoints are live-lineage (in-memory,
  // dropped by compact/switch like /rewind's) — nothing older is offered.
  async function runRevertCommand(raw: string): Promise<void> {
    const arg = raw.trim() === "/revert" ? "" : raw.trim().slice("/revert".length).trim();
    let back = 0;
    if (arg !== "") {
      if (!/^\d+$/.test(arg)) {
        pushInfo(REVERT_USAGE);
        return;
      }
      back = Number(arg);
    }
    const cps = listCheckpoints();
    if (cps.length === 0) {
      pushInfo("(no snapshots recorded — every write/edit auto-snapshots; nothing to revert)");
      return;
    }
    if (back >= cps.length) {
      pushInfo(`(only ${cps.length} checkpoint(s) — nothing was changed)`);
      return;
    }
    const cp = cps[cps.length - 1 - back]!;
    let id: string | null = null;
    try {
      id = ensureStoreSession();
    } catch {
      id = null;
    }
    if (!id) {
      pushInfo("(revert failed — session store unavailable; nothing was changed)");
      return;
    }
    // Snapshot live state first: the revert reads the disk record, so
    // unpersisted turns must land there before the cut.
    persistStoreSession();
    let result: SessionRevertResult;
    try {
      result = await revertSessionToCheckpoint(id, cp.id, authHome);
    } catch {
      result = { ok: false, error: "revert failed unexpectedly — session left exactly as it was" };
    }
    if (!result.ok) {
      pushInfo(`(${result.error})`);
      return;
    }
    // Wholesale live swap: the persisted record is truth (goal/todos live
    // on unchanged — the revert only rewrote history+turns).
    historyRef.current = trackHistory(
      result.session.history.length > 0
        ? [...result.session.history]
        : [{ role: "system", content: withEnvBlock(systemPrompt) }]
    );
    setTurnsBoth(result.session.turns);
    // Restored bytes invalidate stale-read fingerprints (runRewind
    // precedent): forget them so later edits re-capture instead of
    // false-refusing.
    for (const f of cp.files) {
      try {
        forgetReadFingerprint(f.abs);
      } catch {
        // ignore — fingerprint refresh never breaks a revert
      }
    }
    // Same remount + load refresh as /clear and /resume: the cut tail
    // leaves the test frame, and the old load no longer measures this
    // context.
    setScrollEndBoth(null);
    setClearGen((g) => g + 1);
    refreshContextLoad();
    lastPromptTokensRef.current = undefined;
    lastUsageRef.current = undefined;
    // The cut tail leaves the test frame: the refreshed load above was built
    // on the pre-cut report, so the estimate latch marks it until next turn.
    setLoadEstimatedBoth(true);
    pushInfo(result.message);
    persistSession();
  }
  // /autoscroll [on|off]: follow switch for the scrollback viewport. View-
  // only state — safe while busy (never touches the turn, like /queue).
  // Bare toggles off ⇄ on; on jumps to the latest; off freezes a following
  // view at its current end (mid-turn appends then accumulate below).
  function runAutoScrollCommand(raw: string): void {
    const arg = raw.trim() === "/autoscroll" ? "" : raw.trim().slice("/autoscroll".length).trim().toLowerCase();
    // Bare command toggles; explicit on|off sets directly.
    const effective = arg === "" ? (autoScrollRef.current ? "off" : "on") : arg;
    if (effective === "on") {
      if (autoScrollRef.current) {
        pushInfo("(autoscroll already on)");
        return;
      }
      setAutoScrollBoth(true);
      setScrollEndBoth(null);
      pushInfo("(autoscroll on — following the latest)");
      return;
    }
    if (effective === "off") {
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
  // /goal [<objective>|pause|resume|clear]: session goal state.
  // View/state-only — safe while busy (never touches the turn, like
  // /autoscroll). Bare shows the active goal (text, state, cumulative
  // stats) or the none-hint; `/goal <objective>` sets with fresh stats (a
  // second set replaces with a notice); `/goal pause` flips the active flag
  // (pausing mid-turn stops continuation at the next turn end — the loop
  // reads the flag live — while todos, evidence, and history stay intact);
  // `/goal resume` re-arms the flag AND starts a continuation turn through
  // the normal submit path when idle (cumulative stats carry over — nothing
  // resets), or says so loudly without injecting a turn when busy (the
  // running turn's next turn end picks the live flag up on its own);
  // `/goal clear` ends it (harmless notice when absent). Every mutation
  // persists through the normal save path immediately (no new cadence).
  function runGoalCommand(raw: string): void {
    const cmd = parseGoalCommand(raw);
    if (cmd.kind === "status") {
      pushInfo(goalStatusText(goalRef.current));
      return;
    }
    if (cmd.kind === "clear") {
      pushInfo(goalClearNotice(goalRef.current));
      if (!goalRef.current) return;
      setGoalBoth(null);
      persistSession();
      return;
    }
    if (cmd.kind === "pause") {
      const g = goalRef.current;
      pushInfo(goalPauseNotice(g));
      if (!g || !g.active) return;
      setGoalBoth({ ...g, active: false });
      persistSession();
      return;
    }
    if (cmd.kind === "resume") {
      const g = goalRef.current;
      pushInfo(goalResumeNotice(g));
      if (!g || g.active) return;
      setGoalBoth({ ...g, active: true });
      persistSession();
      if (busyRef.current) {
        // Re-arm for turn-end pickup: the running loop reads the live flag
        // (usually consuming this immediately), and the turn-boundary drain
        // kicks one continuation turn when the ended turn left it stranded
        // (see drainTurnBoundary stage 5). Staged only on a real re-arm —
        // absent/already-active goals return above with no flag.
        goalResumePendingRef.current = true;
        pushInfo("(goal resumes when the current turn ends — no new turn started while busy)");
        return;
      }
      void submit(goalFollowUp(g.objective));
      return;
    }
    pushInfo(goalSetNotice(cmd.objective, goalRef.current));
    setGoalBoth({ objective: cmd.objective, active: true, stats: emptyGoalStats() });
    persistSession();
    if (busyRef.current) {
      // Mid-turn set replaces the live goal quietly (pre-existing
      // behavior): the running loop reads the live goal at its
      // continuation checks. No turn is ever injected while busy.
      pushInfo("(goal set — the running turn picks it up; nothing new started while busy)");
      return;
    }
    // A goal is just like a normal message: setting it starts a turn with
    // the objective as the user message, so the live-goal loop engages
    // (resume already kicks this way; set was the quiet outlier).
    void submit(cmd.objective);
  }

  // runModelsCommand (the `/model refresh` backend): reports the last
  // snapshot (kicking a first probe when discovery never ran) on a bare
  // call; `refresh` re-probes all three runtimes first. Results merge into
  // the models cache, so the /model picker serves them with no extra
  // fetches — one dim summary line, never transcript spam.
  // Unified /model picker open: unfiltered with the highlight on the
  // current model, or pre-filtered when the command carried text
  // (/model <text>). Active provider's section first, so same-provider
  // rises stay index-stable when other keyed providers add sections below.
  // Late lifecycle: if discovery never ran (slow/no startup probe),
  // kick it now so local sections fill in behind the open picker.
  function openModelPicker(initialFilter: string): void {
    if (localSnapRef.current.version === 0) kickLocalDiscovery();
    setModelFilterBoth(initialFilter);
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
  }

  async function runModelsCommand(arg: string): Promise<void> {
    const a = arg.trim().toLowerCase();
    if (a !== "" && a !== "refresh") {
      pushInfo("usage: /model [filter|refresh] — pick a model, or probe local model servers (Ollama, LM Studio, llama.cpp).");
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
        // Store mirror: LAZY, matching legacy — /clear wipes the live
        // transcript only and writes nothing to the store here; the cleared
        // (empty) conversation persists on the next completed turn via
        // persistSession()/persistStoreSession().
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
        streamStore.setDraft(null);
        lastPartialRef.current = "";
        committedStreamRef.current = "";
        clearThinking();
        applyToolCall({ kind: "cleared" });
        setPhaseBoth("idle", "");
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
        // /clear wipes the conversation, so the active goal ends here with
        // a visible notice (same lazy persist as the transcript above: the
        // cleared state — goal included — persists on the next completed
        // turn, and the save keeps the pre-clear state until then).
        const clearedGoal = goalRef.current;
        setGoalBoth(null);
        if (clearedGoal) {
          pushInfo(`(goal cleared — "${clearedGoal.objective}" — /clear wipes the conversation)`);
        }
        // autoDisabled stays for the session (thrash guard is session-wide).
        lastPromptTokensRef.current = undefined;
        lastUsageRef.current = undefined;
        setContextLoadBoth(null);
        // No load left to qualify: the latch clears with it.
        setLoadEstimatedBoth(null);
        autoStreakRef.current = 0;
        pendingCompactRef.current = null;
        // /clear wipes the conversation, so the checklist must go too
        // (otherwise stale Todos appear on the next fresh start).
        clearTodos();
        setTodoSnap([]);
        try {
          const id = activeSessionIdRef.current;
          if (id) {
            const sess = getSession(id, authHome);
            if (sess) updateSession(id, { metadata: withSessionTodos(sess.metadata, []) }, authHome);
          }
        } catch {}
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
        // persistSession() also mirrors the pre-/new conversation into the
        // OLD active store record before the reset below.
        persistSession();
        // Fresh store record for the new conversation (settings carried over,
        // empty history/turns/usage; default title = formatSessionTitle(now)
        // via createSession). Explicit setActiveSession: createSession only
        // claims the pointer when none is set.
        try {
          const created = createSession(
            {
              cwd: storeCwd(),
              provider: providerRef.current,
              model: modelRef.current,
              effort: effortRef.current,
              mode: modeRef.current,
            },
            authHome
          );
          setActiveSession(created.id, authHome);
          activeSessionIdRef.current = created.id;
          setSessionTitleBoth(created.title);
          try {
            setActiveTodoSession(created.id);
          } catch {
            // ignore
          }
          // Bind the new record BEFORE the boundary emit (ticket 05).
          extRuntimeRef.current?.setSessionId(created.id);
        } catch {
          // ignore disk errors (in-memory reset below still applies)
        }
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
        // /new replaces the conversation lineage, so the active goal ends
        // here with a visible notice — a fresh conversation must not inherit
        // an auto-continuing goal. The pre-/new goal stays in the OLD record
        // (persisted above), so /resume still brings it back with its stats.
        const droppedGoal = goalRef.current;
        setGoalBoth(null);
        if (droppedGoal) {
          pushInfo(`(goal cleared — "${droppedGoal.objective}" — /new starts a fresh conversation with no goal)`);
        }
        // Fresh list: a held view has nothing to hold onto — re-follow.
        setScrollEndBoth(null);
        setClearGen((g) => g + 1);
        setError(null);
        streamStore.setDraft(null);
        lastPartialRef.current = "";
        committedStreamRef.current = "";
        clearThinking();
        applyToolCall({ kind: "cleared" });
        setPhaseBoth("idle", "");
        // /new-vs-/clear split: /clear wipes the transcript but KEEPS usage
        // totals; /new resets the counters too (fresh conversation). Session
        // SETTINGS (effort/mode/provider/model) are kept — only the
        // conversation + counters reset.
        setUsageBoth(null);
        lastPromptTokensRef.current = undefined;
        lastUsageRef.current = undefined;
        setContextLoadBoth(null);
        // Fresh conversation with no usage and no load: nothing to qualify.
        setLoadEstimatedBoth(null);
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
        replaceExtensionContext("new");
        return;
      case "/compact":
        // Bare /compact with no focus text (slash-menu path). Free-text
        // "/compact focus…" is handled in submit (prefix match) so focus
        // text survives; both funnel to the same busy/pending logic below.
        void runCompactCommand("");
        return;
      case "/model": {
        openModelPicker("");
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
      case "/skill":
        // Unified skill command: bare opens the picker (what /skills did).
        openSkillPicker();
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
      case "/goal":
        runGoalCommand("/goal");
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
      case "/session":
        openSessionPicker("");
        return;
      case "/mcp":
        openMcpPicker();
        return;
      case "/fork":
        // Bare exact match (slash-menu Enter on the highlighted name):
        // full-conversation fork — the typed-args form is preserved by the
        // menu branch and the submit prefix route below.
        void runForkCommand("/fork");
        return;
      case "/revert":
        // Bare exact match: revert to the latest checkpoint — the typed
        // form is preserved by the menu branch and the submit prefix
        // route below.
        void runRevertCommand("/revert");
        return;
      case "/rename":
        // Bare exact match (slash-menu Enter on the highlighted name):
        // usage — the typed-args form is preserved by the menu branch and
        // the submit prefix route above.
        runRenameCommand("/rename");
        return;
      case "/telemetry":
        pushInfo(telemetrySummaryText());
        return;
      case "/usage":
        openUsageLedger();
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
      case "/reload":
        void runReloadCommand();
        return;
      default:
        // Extension slash commands (ticket 04, bare form from the menu or
        // palette): typed-args forms route through submit/menu above with
        // args intact, so only the bare exact name lands here.
        {
          const target = parseExtensionCommandInput(cmd);
          if (target && target.args === "" && getExtensionCommand(target.name)) {
            void runExtensionCommandFromApp(target.name, "");
            return;
          }
          return;
        }
    }
  }

  // approve hook for runAgenticLoop: one verdict per call (deny refuses as a
  // standard "no" — pre-execution, model-visible denial result, audit line
  // via the untouched onToolActivity path — and wins over everything below,
  // including plan mode); plan mode never prompts — its mutations flow to
  // the execute gate, which refuses with a replan note (allow/yolo/trust/
  // always/skill grants cannot punch through); then allow, yolo, session
  // trust (/trust or [t]), and always-allowed tools run without prompting;
  // otherwise an Ink y/a/t/n prompt resolves the promise.
  // The verdict (decision + provenance + preview) is computed ONCE here via
  // decideApproval: the modal renders verdict.preview and the stashed
  // description (never recomputing either — no filesystem reads in render),
  // and execution consumes the recorded via without re-deciding. The only
  // other mode consultation is the execute gate below (guardedExecute),
  // which enforces plan-mode at execution time — it consults no rules and
  // prompts nothing, so approval still decides exactly once.
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
    // One verdict for this call (deny → plan → allow → yolo → trust →
    // always → skill grants → prompt, owned by the policy layer). The
    // modal description is computed here too (same single pass — the label
    // may resolve symlinks, so render must not recompute it).
    const verdict = decideApproval(
      name,
      args,
      {
        mode: modeRef.current,
        trustAll: trustAllRef.current,
        rules: rulesRef.current,
        alwaysAllowed: alwaysAllowedRef.current,
        skillGrants: skillGrantsRef.current,
        approvalGated: needsApproval(name),
      },
      stagedDiff
    );
    // Provenance for the transcript: approval-gated calls record their via
    // for the matching activity commit (deny clears immediately below —
    // its ↳ line already names the denial — and prompt-denials clear in
    // resolveApproval, so only executed calls ever render it).
    if (needsApproval(name)) pendingViaRef.current = { name, via: verdict.via };
    if (verdict.decision === "deny") {
      pendingDiffRef.current = null;
      pendingViaRef.current = null;
      return "no";
    }
    if (verdict.decision === "allow") return "once";
    const description = describeToolCall(name, args);
    const signal = turnCancelRef.current?.signal ?? null;
    if (signal?.aborted) {
      pendingDiffRef.current = null;
      pendingViaRef.current = null;
      throw new LoopCancelledError();
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      approvalResolveRef.current = { resolve, reject };
      setApproveIndexBoth(0);
      setPendingApproval({ name, args, diff: verdict.preview, description });
      if (signal) {
        const onAbort = () => {
          const h = approvalResolveRef.current;
          approvalResolveRef.current = null;
          setPendingApproval(null);
          pendingDiffRef.current = null;
          pendingViaRef.current = null;
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
    if (decision === "no") {
      pendingDiffRef.current = null;
      pendingViaRef.current = null;
    }
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

  // Turn-boundary drain (ticket 07): the ONE explicitly ordered routine for
  // everything pending at a turn boundary. Called once per turn from
  // submit()'s turn-end finally (the single turn boundary — the compact
  // drains are extracted from submit's success path (try) and failure path
  // (catch) here); submit-time handlers only STAGE pending state (glue that
  // stays at those call sites, documented where it stages: /compact-while-
  // busy sets pendingCompactRef, busy follow-ups enqueue, busy /steer sets
  // steerRef, busy /goal resume re-arms plus stages goalResumePendingRef).
  //
  // Effective order (verified against the pre-ticket code + tests — every
  // stage keeps today's semantics; do not reorder):
  //   1. compact — manual /compact first (pending flag; a /compact arriving
  //      mid-compaction re-arms the flag → nested second drain on clean
  //      turns), else auto-compact on clean turns only. Failed/cancelled
  //      turns drain a pending manual only (single, guarded); auto never
  //      fires there (load is meaningless for a rolled-back turn — just
  //      refresh it). Runs while still busy, so a /compact now re-arms the
  //      pending flag instead of running a concurrent compaction.
  //   2. turn teardown (pinned here, not a drain stage: the goal work-time
  //      accrual must follow compaction — both old paths ran compact-then-
  //      accrue — and the busy reset plus modal/slot cleanup must precede
  //      any chained submit so the next turn starts clean).
  //   3. steer — a steer stranded by a failed/cancelled turn rejoins the
  //      queue FRONT (all outcomes; never dropped, never run inline).
  //   4. queue — the next queued follow-up auto-sends on non-cancelled turns
  //      only (cancelled turns keep the queue visible but never auto-send;
  //      failed turns auto-send like clean ones — the gate is the
  //      cancellation latch, same `!turnCancelledRef` as before). The
  //      chained submit re-enters submit() → a clean turn → this drain
  //      again at its end.
  //   5. goal-resume — a staged busy-resume whose goal is still active with
  //      no turn just chained starts exactly one continuation turn (covers
  //      failed turns, which never continue inside the loop, and resumes
  //      that raced the loop's final continuation check). A chained queue
  //      turn consumes the stage instead (its loop reads the live flag — no
  //      second turn starts); cancelled turns never kick (the loop paused
  //      the goal, and the queue stays put for the user).
  // Re-entrancy: chained submits re-enter this routine per turn; every flag
  // is consumed (nulled) before the await that acts on it, so a nested
  // drain can never double-run a stage.
  async function drainTurnBoundary(
    outcome: "clean" | "failed" | "cancelled",
    goalWorkStartMs: number | null,
    goalWorkObjective: string | null
  ): Promise<void> {
    // STAGE 1 — compact (verbatim from the old try/catch drains).
    if (outcome === "clean") {
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
    } else {
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
    }
    // STAGE 2 — turn teardown (verbatim from the old finally, position
    // pinned: accrual after compaction, busy reset before any chained turn).
    // Goal work time (ticket 02): this submit's wall clock accrues once,
    // for every outcome (success, failure, and cancel all did work), when
    // the same goal is still live. A mid-turn replacement keeps its own
    // stats — we accrue only while the objective still matches.
    try {
      if (
        goalWorkStartMs !== null &&
        goalRef.current !== null &&
        goalRef.current.objective === goalWorkObjective
      ) {
        const workedMs = Math.max(0, Date.now() - goalWorkStartMs);
        patchGoalStats((s) => ({ ...s, workMs: s.workMs + workedMs }));
      }
    } catch {
      // accounting never breaks turn teardown
    }
    turnCancelRef.current = null;
    approvalResolveRef.current = null;
    setPendingApproval(null);
    // Safety net: the slot is normally consumed by onToolActivity or
    // cleared on deny/cancel — never let it cross a turn boundary.
    // Same for the structured-identity queue (cancelled/vetoed starts)
    // and the provenance slot (same lifetime as the diff slot).
    pendingDiffRef.current = null;
    pendingViaRef.current = null;
    toolIdentityQueueRef.current = [];
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
      paintSchedulerRef.current?.cancel();
    } catch {
      // ignore
    }
    streamStore.setDraft(null);
    clearThinking();
    // Turn teardown proves no tool is running (finished, failed, or
    // cancelled): the machine goes idle, dropping the live line.
    applyToolCall({ kind: "cleared" });
    clearTurnTimer();
    setStalledBoth(false);
    setElapsedSecs(0);
    setPhaseBoth("idle", "");
    // STAGE 3 — steer (verbatim from the old finally): a steer stranded
    // by a failed/cancelled turn rejoins the queue front — the thought is
    // preserved, the user decides when it runs.
    const stranded = steerRef.current;
    if (stranded) {
      steerRef.current = null;
      setSteerPending(null);
      setQueueBoth([stranded, ...queueRef.current]);
    }
    // STAGE 4 — queue (verbatim from the old finally): a clean turn
    // auto-sends the next queued follow-up (chaining while the queue is
    // non-empty); a cancelled turn keeps its queue visible but never
    // auto-sends. Runs after the busy reset above so the chained submit
    // enters a clean turn.
    if (!turnCancelledRef.current && queueRef.current.length > 0) {
      const next = queueRef.current[0]!;
      setQueueBoth(queueRef.current.slice(1));
      void submit(next);
    }
    // STAGE 5 — goal-resume: consume the staged busy-resume (always —
    // even when it kicks nothing, so the flag never leaks across turns),
    // then kick exactly one continuation turn when the ended turn left the
    // goal active without chaining (failed turns and raced resumes — the
    // running loop consumes live re-arms itself, and a chained queue turn
    // above already carries the live goal). Cancelled turns never kick.
    const resumeStaged = goalResumePendingRef.current;
    goalResumePendingRef.current = false;
    if (
      resumeStaged &&
      outcome !== "cancelled" &&
      !busyRef.current &&
      goalRef.current !== null &&
      goalRef.current.active === true
    ) {
      void submit(goalFollowUp(goalRef.current.objective));
    }
  }

  // Submit-time pipeline (ticket 02 — stage order is SUBMIT_PIPELINE_STAGES
  // above; each `SUBMIT STAGE n/3` marker below names its stage plus its
  // rollback-scope rule). Local "/" routing precedes the pipeline: exact
  // slash commands, /allow-/deny-/rules, and skill invocations never enter
  // it (no turn, no history, nothing to roll back).
  async function submit(value: string) {
    const text = value.trim();
    // Snapshot attachments BEFORE clearing input: setInputBoth("") re-anchors
    // (prune) and would wipe mentions/chunks before expansion.
    const pendingMentions = [...mentionsRef.current];
    const pendingChunks = [...pastedChunksRef.current];
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
    // /rename with optional name: prefix match ("/rename" or "/rename ...").
    // Instant local store op — safe while busy (the turn-end persist never
    // carries a title, so it cannot clobber the rename).
    if (text === "/rename" || text.startsWith("/rename ")) {
      runRenameCommand(text);
      return;
    }
    // SUBMIT STAGE 1/3 — permissions (rollback scope: pre-turn, appends
    // nothing). Busy guard + API-key check: rejections return before any
    // history mutation, so there is nothing to roll back.
    if (!text) return;
    // Expand paste summaries and @ mentions for the model payload (07,05).
    // Keep display text as typed (tokens visible), but LLM history gets full
    // content. Paste chunks are pruned first so deleted summaries drop.
    let expandedForModel = text;
    try {
      const liveChunks = prunePastedChunks(expandedForModel, pendingChunks);
      expandedForModel = expandPastedSummaries(expandedForModel, liveChunks);
    } catch {}
    try {
      const liveMentions = pruneMentions(expandedForModel, pendingMentions);
      // expandMentionsForSubmit reads files async; do not block slash commands but await for normal chat.
      if (liveMentions.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        expandedForModel = await expandMentionsForSubmit(expandedForModel, liveMentions, process.cwd());
      }
    } catch {}
    const submitTextForModel = expandedForModel;
    // ShellActive already handled via its own Enter path above; if somehow
    // submit is called while shellActive (e.g. /queue), strip bang.
    const finalTextForHistory = shellActiveRef.current ? stripShellBang(submitTextForModel) : submitTextForModel;
    // An extension command in flight owns the question modal (single slot
    // shared with ask_question): plain follow-ups and nested extension
    // commands wait with a notice; view/state slash commands still run
    // (they never touch the modal or the turn).
    if (extCommandRunningRef.current) {
      const nested = parseExtensionCommandInput(text);
      if ((nested && getExtensionCommand(nested.name)) || !text.startsWith("/")) {
        pushInfo("(an extension command is already running — wait for its prompt)");
        return;
      }
    }
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
      // /autoscroll, /thinking, and /goal are view/state-only (never touch
      // the turn), so they run while busy like /queue + /steer (see
      // slashRunsWhileBusy).
      if (text === "/autoscroll" || text.startsWith("/autoscroll ")) {
        runAutoScrollCommand(text);
        return;
      }
      if (text === "/goal" || text.startsWith("/goal ")) {
        runGoalCommand(text);
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
    // /queue family — SLASH_NAMES only holds the exact command. /goal takes
    // free-text args (/goal <objective>, /goal clear) the same way.
    // /thinking is bare-toggle-only; anything appended prints its usage.
    if (text === "/autoscroll" || text.startsWith("/autoscroll ")) {
      runAutoScrollCommand(text);
      return;
    }
    if (text === "/goal" || text.startsWith("/goal ")) {
      runGoalCommand(text);
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
    // /model takes an optional filter or subcommand: bare opens the picker,
    // `/model refresh` re-probes local servers (and the Kilo catalog when
    // Kilo is active), `/model <text>` opens the picker pre-filtered.
    // SLASH_NAMES only holds the exact command.
    if (text === "/model" || text.startsWith("/model ")) {
      const arg = text === "/model" ? "" : text.slice("/model ".length).trim();
      if (arg.toLowerCase() === "refresh") {
        void runModelsCommand("refresh");
        return;
      }
      openModelPicker(arg);
      return;
    }
    // Retired: /models merged into /model (see above). Explicit branch so
    // the input explains instead of hitting skill lookup — the name stays
    // reserved against extension shadowing.
    if (text === "/models" || text.startsWith("/models ")) {
      pushInfo("(merged — use /model to pick, /model refresh to re-probe local servers)");
      return;
    }
    // /session takes an optional initial filter ("/session auth" opens the
    // picker pre-filtered) — SLASH_NAMES only holds the exact command.
    if (text === "/session" || text.startsWith("/session ")) {
      const initial = text === "/session" ? "" : text.slice("/session".length).trim();
      openSessionPicker(initial);
      return;
    }
    // Bare /mcp opens the server popup (no args — Space toggles inside).
    if (text === "/mcp" || text.startsWith("/mcp ")) {
      openMcpPicker();
      return;
    }
    // /fork takes an optional drop count ("/fork 5" drops the last 5
    // messages first) — SLASH_NAMES only holds the exact command. Idle-only
    // like /session: the live-array swap would race a running turn, and the
    // busy guard above already drops other "/" input while busy.
    if (text === "/fork" || text.startsWith("/fork ")) {
      await runForkCommand(text);
      return;
    }
    // /revert takes an optional checkpoint index ("/revert 1" goes one
    // checkpoint back) — SLASH_NAMES only holds the exact command.
    // Idle-only like /fork: the live-array swap would race a running turn.
    if (text === "/revert" || text.startsWith("/revert ")) {
      await runRevertCommand(text);
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
    // Namespaced skill invocation: `/skill:name` (bare `/skill` opens the
    // picker via the registry path above; `/skill <name>` below invokes).
    // Resolves through the same registry as the legacy `/name` form and
    // the slash menu.
    if (text === "/skill" || text === "/skill:") {
      pushInfo(SKILL_USAGE);
      return;
    }
    // Space form for the unified command: `/skill deploy` invokes exactly
    // like `/skill:deploy`.
    const spacedSkill = /^\/skill\s+([A-Za-z0-9_-]+)\s*$/.exec(text)?.[1];
    if (spacedSkill !== undefined) {
      void invokeSkillByName(spacedSkill);
      return;
    }
    // Retired: /skills merged into /skill (bare opens the picker).
    // Explicit branch so the input explains instead of hitting skill
    // lookup — the name stays reserved against extension shadowing.
    if (text === "/skills" || text.startsWith("/skills ")) {
      pushInfo("(merged — /skill lists and picks, /skill:name invokes)");
      return;
    }
    const namespaced = /^\/skill:([A-Za-z0-9_-]+)$/.exec(text)?.[1];
    if (namespaced !== undefined) {
      void invokeSkillByName(namespaced);
      return;
    }
    // Extension slash commands (ticket 04): "/name args" runs extension
    // code outside the model turn loop (no history, no telemetry turn —
    // say() posts transcript turns only). Builtins and /skill: keep
    // precedence above, so an extension never shadows them; the legacy
    // /name skill form below yields to extensions deterministically.
    const extTarget = parseExtensionCommandInput(text);
    if (extTarget && getExtensionCommand(extTarget.name)) {
      void runExtensionCommandFromApp(extTarget.name, extTarget.args);
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
    streamStore.setDraft(null);
    clearThinking();
    // Fresh turn, fresh latch: the queue drain at the end auto-sends only
    // when this turn was NOT cancelled (see the turn-end finally).
    turnCancelledRef.current = false;
    // NOTE: skill grants are NOT cleared here — a manually armed skill
    // (loaded while idle) must survive into the turn it was armed for.
    // Expiry happens in the turn-end finally below, plus /clear + /new.
    try {
      paintScheduler().reset();
    } catch {
      // ignore (first token still paints; at worst one window late)
    }
    // Fresh turn: the machine goes idle, so no stale running line from a
    // previous turn can leak into this one. Same for the structured-identity
    // queue (a cancelled turn's unconsumed starts must never attribute to
    // this turn).
    applyToolCall({ kind: "cleared" });
    setPhaseBoth("thinking", "");
    // Phase 5: start the elapsed/stall timer (status-bar only, never the
    // transcript). Cleared in finally below and on unmount.
    startTurnTimer();
    // Fresh turn, no output yet: arms the thinking-gap guard below (the gap
    // spinner must never reappear after the first token/thinking/tool).
    setHasHadOutputBoth(false);
    toolIdentityQueueRef.current = [];
    // Same for the transcript-diff slot: a previous turn's unconsumed
    // preview (cancelled mid-execution) must never attach to this turn.
    // Same for the provenance slot (same lifetime, same reason).
    pendingDiffRef.current = null;
    pendingViaRef.current = null;
    lastPartialRef.current = "";
    committedStreamRef.current = "";
    refreshGitInfo();
    // SUBMIT STAGE 2/3 — context-assembly (rollback scope: pre-rollbackTo,
    // survives failure). Refresh the pinned env block ONCE per turn (not per
    // POST — the loop reuses history[0] for all its POSTs, so this is the
    // only git call for the turn). Before rollbackTo so the refresh
    // survives a failed-turn rollback (it is not part of the user turn).
    // History is uncapped: the full conversation rides every turn.
    refreshSystemEnv();
    // SUBMIT STAGE 3/3 — loop-entry (rollback scope: post-rollbackTo, rolls
    // back on failure). Turn boundary: on POST failure (HTTP/network/empty/
    // truncated) the whole user turn (user message plus any partial
    // assistant/tool loop entries) is removed, so the next request starts
    // clean — same guarantee as the old single-pop. The streaming draft
    // lives outside `turns` until commit, so rollback just clears it (see
    // catch). Cancellation (LoopCancelledError) shares the same splice
    // contract.
    const rollbackTo = historyRef.current.length;
    // Turn-boundary outcome glue (ticket 07): the try end marks clean, the
    // catch marks failed/cancelled — the turn-end finally passes it to the
    // single drain routine (see drainTurnBoundary). Dead default is the most
    // conservative ("cancelled" never auto-sends); every path below
    // overwrites it before the finally reads it.
    let turnOutcome: "clean" | "failed" | "cancelled" = "cancelled";
    // Goal work time (ticket 02): wall clock for this submit accrues to the
    // live goal in the turn finally (all outcomes — success, failure, and
    // cancel all did work). Pinned to the starting objective so a mid-turn
    // replacement keeps its own stats.
    const goalWorkStartMs = goalRef.current ? Date.now() : null;
    const goalWorkObjective = goalRef.current?.objective ?? null;
    // Local observability: open this turn's trace (no-op when disabled).
    // Provider/model switches surface here per turn; session-level switches
    // are derived from the same updates (see setSessionMeta).
    telemetry.setSessionMeta({ provider: providerRef.current, model: modelRef.current });
    // Goal snapshot for the trace (ticket 09): the live goal as this turn
    // opens it (objective, flag, cumulative counters so far). Absent reads
    // as no-goal; the recorder caps and copies it, never aliasing live state.
    const turnGoal = goalRef.current
      ? {
          objective: goalRef.current.objective,
          active: goalRef.current.active === true,
          ...(goalRef.current.stats
            ? {
                turns: goalRef.current.stats.turns,
                requests: goalRef.current.stats.requests,
                tokens: goalRef.current.stats.tokens,
                workMs: goalRef.current.stats.workMs,
              }
            : {}),
        }
      : undefined;
    const telemetryTurnId = telemetry.startTurn(text, {
      provider: providerRef.current,
      model: modelRef.current,
      effort: effortRef.current,
      mode: modeRef.current,
      ...(turnGoal ? { goal: turnGoal } : {}),
    });
    const telemetrySink: LoopTelemetrySink = {
      onModelCall: (info) => {
        telemetry.recordModelCall(telemetryTurnId, info);
        // Usage ledger (05): one row per completed model POST. Failed POSTs
        // roll back with the turn and stay out of the history.
        if (info.finishReason === "final" || info.finishReason === "tool_calls") {
          recordLedgerStep("turn", info.usageReported ? (info.usage ?? null) : null);
        }
      },
      onToolCall: (info) => telemetry.recordToolCall(telemetryTurnId, info),
    };
    const controller = new AbortController();
    turnCancelRef.current = controller;
    // --- Core delegation (separation audit) ---
    // Normal chat messages *can* go through the frontend-agnostic AgentCore,
    // which emits semantic events (agent.started, thinking.*, message.*,
    // tool.*, agent.completed/error). The TUI State Adapter
    // (`useAgentAdapter`) translates those events to the `Turn` model
    // `Conversation` renders. This path keeps `runAgenticLoop`/`executeTool`
    // out of the TUI. Slash commands, compact, etc. stay here (UI chrome).
    // For now the core path is opt-in for real runs (not for tests that
    // inject `initialModels` and mock `fetch` and assert on the legacy
    // `turns` shape). Tests keep the legacy path byte-identical.
    const isNormalChat = !text.startsWith("/") && text.length > 0;
    const useCorePath = isNormalChat && typeof agentCore !== "undefined" && !initialModels;
    if (useCorePath) {
      // Core-path turn boundary: the legacy loop below ends in the single
      // turn-boundary drain (busy teardown, timer clear, phase reset, queue
      // chaining — see drainTurnBoundary), but this block used to `return` /
      // `throw` before reaching it. App `busy` then stayed true forever with
      // an empty live zone: the stuck `◐ Thinking… · Ns` spinner plus a
      // `thinking…` status line after the answer was already done. Drain here
      // instead so both paths share the one teardown. The error is swallowed
      // like the legacy catch below (every submit call site is fire-and-
      // forget `void submit(...)` — rethrowing is an unhandled rejection).
      // User echo (transcript parity with the legacy push below): the adapter
      // projects core events onto its own turns and uiTurns reads the adapter
      // once non-empty — without committing the echo here AND seeding the
      // adapter with it, the user's message (and, via the switch, every prior
      // turn) vanishes from the TUI. Core-path assistant/tool turns rejoin
      // App `turns` via the adopt effect below. (historyRef is deliberately
      // untouched here: core owns its history copy; merging it back is
      // separate work — see the sync effect above.)
      // Display echo stays as typed (tokens visible), model payload is expanded.
      appendTurns({ role: "user", content: text });
      historyRef.current.push({ role: "user", content: finalTextForHistory });
      // Early session ensure: the session record must exist on disk BEFORE
      // the turn runs so that a Ctrl+C / crash still leaves a pickable
      // session in /session. Without this, ensureStoreSession() only runs
      // on completed turns (inside persistSession), so the first cancelled
      // turn leaves no record at all.
      ensureStoreSession();
      adapter.reset([...turnsRef.current]);
      try {
        await agentCore.send(finalTextForHistory, { signal: controller.signal });
        turnOutcome = "clean";
      } catch (e) {
        const cancelled =
          e instanceof LoopCancelledError ||
          (e instanceof Error && e.name === "LoopCancelledError") ||
          controller.signal.aborted;
        turnOutcome = cancelled ? "cancelled" : "failed";
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
        }
      } finally {
        turnCancelRef.current = null;
      }
      await drainTurnBoundary(turnOutcome, goalWorkStartMs, goalWorkObjective);
      return;
    }

    historyRef.current.push({ role: "user", content: finalTextForHistory });
    appendTurns({ role: "user", content: text });
    // Early session ensure: the session record must exist on disk BEFORE
    // the turn runs so that a Ctrl+C / crash still leaves a pickable
    // session in /session. Without this, ensureStoreSession() only runs
    // on completed turns (inside persistSession), so the first cancelled
    // turn leaves no record at all.
    ensureStoreSession();
    // Pre-guard (issue 02): estimate the pending context size after the
    // user message is pushed but BEFORE the first POST. When the estimate
    // reaches the model's usable limit, compact first so the doomed POST
    // never fires — recovery after a 413 is the fallback, not the plan.
    // auto=false suppresses the pre-guard (same semantics as overflow
    // recovery: the user chose to disable auto-compaction).
    try {
      const pendingTokens = estimateTokensForChars(historyChars(historyRef.current));
      if (shouldPreCompactForPending(modelRef.current, pendingTokens)) {
        await doCompact("", true);
      }
    } catch {
      // Pre-guard failure must never block the turn — fall through to
      // the normal POST path (the 413 recovery handles it).
    }
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
        // Goal auto-continue (ticket 02): the loop reads the live goal
        // through getGoal (never imports App state), pauses with a notice
        // via pauseGoal, and reports slice counters. Turns/requests land
        // here; tokens accrue in onUsage below; work time in the finally.
        goal: {
          getGoal: () => goalRef.current,
          pauseGoal: (notice: string) => {
            pauseGoalWithNotice(notice);
          },
          onGoalRequest: () => {
            patchGoalStats((s) => ({ ...s, requests: s.requests + 1 }));
          },
          onGoalTurn: () => {
            patchGoalStats((s) => ({ ...s, turns: s.turns + 1 }));
          },
        },
        // Evaluator fallback (ticket 04): report-less goal turns get one
        // bounded, read-only judge call (same provider/model, tools disabled,
        // 256-token cap — see src/agent/goal-evaluator.ts). Built from live
        // refs at call time so a mid-run provider/model/key switch applies;
        // judge spend accumulates exactly like model spend. Transport
        // failures throw (the loop pauses on them, never crashes); an
        // unclear verdict resolves null (the loop pauses with a notice).
        goalJudge: async ({ goal: objective, turns }) => {
          return requestGoalVerdict({
            provider: providerRef.current,
            apiKey: keyForProvider(providerRef.current),
            model: modelRef.current,
            systemContent: systemPrompt,
            goal: objective,
            turns,
            baseURL: chatBaseURL(providerRef.current),
            endpointOverride: activeEndpoint,
            signal: controller.signal,
            onUsage: (u) => {
              accumulateUsage(u, false);
              recordLedgerStep("turn", u);
            },
          });
        },
        // Local observability sink: the loop reports completed model/tool
        // calls (iterations, durations, usage) into the open turn trace.
        telemetry: telemetrySink,
        // Structured tool identity (ticket 02 sink consumer): every tool
        // start/finish arrives here with its stable toolCallId + name, in
        // commit order. onToolActivity below consumes the queue head (the
        // start fired before the commit); onToolFinished reconciles by id
        // for paths whose activity never fired. Guarded: observer errors
        // degrade to the label-matching fallback, never break the turn.
        turnEvents: {
          onToolStarted: (info) => {
            try {
              toolIdentityQueueRef.current.push({
                toolCallId: info.toolCallId,
                name: info.name,
                startedAt: clockNow(),
              });
            } catch {
              // ignore (that call falls back to the phase-timing channel)
            }
          },
          onToolFinished: (info) => {
            try {
              const q = toolIdentityQueueRef.current;
              const at = q.findIndex((e) => e.toolCallId === info.toolCallId);
              if (at >= 0) q.splice(at, 1);
            } catch {
              // ignore (queue hygiene only; the activity already consumed)
            }
          },
        },
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
            paintScheduler().push("draft", partial);
          } catch {
            // Never lose tokens: paint now rather than drop the partial.
            streamStore.setDraft(partial);
          }
          lastPartialRef.current = partial;
          setHasHadOutputBoth(true);
          noteTurnActivity();
        },
        onThinking: (partial) => {
          thinkingRef.current = partial;
          try {
            paintScheduler().push("thinking", partial);
          } catch {
            // Never lose reasoning: paint now rather than drop the partial.
            streamStore.setThinking(partial);
          }
          setHasHadOutputBoth(true);
          noteTurnActivity();
        },
        onPhase: (p, detail) => {
          // Change-guarded (zen emits "streaming" per content chunk):
          // steady-state tokens issue zero setStates here.
          setPhaseBoth(p, detail ?? "");
          noteTurnActivity();
          if (p === "thinking") {
            // New POST: the previous round's thinking (if any) commits to
            // the transcript so it stays in the TUI instead of being
            // replaced and lost; the fresh round streams into the live block.
            commitThinking();
            // A new POST proves no tool is running: the finished tool's line
            // must not survive into the model's next round (stale running
            // line beside fresh thinking). The machine goes idle.
            applyToolCall({ kind: "cleared" });
          } else if (p === "tool" && detail) {
            // Execution started: deterministic started transition (idempotent
            // — a duplicate start never rewinds the duration clock).
            applyToolCall({ kind: "started", name: detail });
            // A running tool is output for the gap guard (the live zone shows
            // the tool line, never the thinking gap — including the beat
            // after the tool commits while teardown still runs).
            setHasHadOutputBoth(true);
            // Paint any coalesced stream text NOW so the tool transition
            // never shows a stale draft for up to a window behind.
            flushDraft();
          } else if (p === "retry") {
            // Same ordering as tool start: pending paint lands before the
            // retry line commits, so the transcript never reorders.
            flushDraft();
            const msg = detail ? `${theme.symbol.retryMark} retrying… ${detail}` : `${theme.symbol.retryMark} retrying…`;
            appendTurns({ role: "tool", content: msg });
            // Local observability: transport retries attach to the model call
            // they precede (the recorder buffers them until it completes).
            telemetry.recordRetry(telemetryTurnId, detail ?? "");
          } else if (p === "done") {
            applyToolCall({ kind: "cleared" });
            flushDraft();
          }
        },
        onToolDelta: (name) => {
          // Name revealed mid-stream (arguments still arriving): announced
          // transition — the line shows early, the duration clock keeps the
          // announce time until execution restarts it (machine rule).
          applyToolCall({ kind: "announced", name });
          // Tool calls can start mid-stream: paint the pending draft now so
          // the running line and the latest text arrive in the same frame.
          flushDraft();
        },
        onUsage: (u) => {
          // Local observability: per-turn usage accumulates inside the
          // recorder when the loop reports the completed model call (same
          // payload) — recording it here too would count every POST twice.
          // Cumulative session spend from REAL reports only: every reporting
          // POST accumulates (tool-round POSTs and successful retries each
          // count once — each was billed; failed attempts report nothing, so
          // nothing is deduped). usageTotals drives NK only, never P%.
          accumulateUsage(u);
        },
        onReasoning: (label) => {
          setReasoning(label);
        },
        onWarning: (msg) => {
          appendTurns({ role: "tool", content: `${theme.symbol.warningMark} ${msg}` });
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
          // A committed tool line is output for the gap guard (same reason
          // as the tool-started phase above).
          setHasHadOutputBoth(true);
          // Structured identity first (ticket 02 sink): the queue head is
          // this commit's stable identity (toolCallId + name, commit order)
          // — never parsed out of the label. Null head = identity-less call
          // (old paths, tests driving the callback directly) → the legacy
          // label-matching fallback for that call only, so no line is ever
          // dropped. The label text itself stays byte-identical either way.
          const identity =
            toolIdentityQueueRef.current.length > 0
              ? toolIdentityQueueRef.current.shift()!
              : null;
          // Display-only duration: wall time since the tool started. On the
          // sink path the start comes from the structured identity (never
          // the phase-timing side channel); the fallback reads the machine
          // (announce time, else execution start). Attached as Turn.ms for
          // the `· Ns` suffix.
          const machineState = toolCallRef.current;
          const phaseStarted = machineState.status === "idle" ? null : machineState.startedAt;
          const ms =
            identity !== null
              ? Math.max(0, clockNow() - identity.startedAt)
              : phaseStarted !== null
                ? Math.max(0, clockNow() - phaseStarted)
                : 0;
          // Finished transition: deterministic completed/failed — but only
          // when nothing else is outstanding. Parallel batches fire all
          // phases upfront, so a non-final commit must not clear the line
          // while siblings still execute (the queue head was just shifted
          // above: empty means this was the last outstanding call).
          if (toolIdentityQueueRef.current.length === 0) {
            applyToolCall({ kind: "finished" });
          }
          const items: Turn[] = [];
          // Inter-tool chatter streamed before this result would otherwise
          // vanish (the turn commit carries the final reply only). Pin it
          // above the tool line in commit order — and drop the painted draft
          // lane with it, so the same text never renders twice (committed
          // transcript + live draft) while the next POST is in flight. The
          // next POST's tokens repaint fresh; a trailing paint can no longer
          // resurrect the pinned text (cancelled here).
          const pendingStream = takeUncommittedStream();
          if (pendingStream !== null) {
            items.push(pendingStream);
            try {
              paintScheduler().cancel("draft");
            } catch {
              // ignore (the store clear below still wins)
            }
            streamStore.setDraft(null);
          }
          items.push({ role: "tool", content: label, ms });
          // Committed identity for the display attachments below (summary,
          // diff, provenance): the structured sink name on the sink path,
          // parsed out of the label only for identity-less fallback calls.
          // parseLabel never throws, so no guard needed.
          const commitName = identity !== null ? identity.name : parseLabel(label).name;
          const slotMatch = (slotName: string): boolean =>
            identity !== null
              ? commitName === slotName
              : label === `${theme.symbol.toolMark} ${slotName}` ||
                label.startsWith(`${theme.symbol.toolMark} ${slotName} `);
          // Committed result summary (display-only): what the call did, in
          // one line (`50 lines`, `3 results`) — derived here from the full
          // result the transcript never retains. ToolCall's presenters render
          // it under the audit line; the inspector keeps the full text.
          items[0]!.summary = deriveSummary(
            getToolKind(commitName),
            commitName,
            parseLabel(label).target,
            result,
            isError
          );
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
          // The membership test reads the structured tool name on the sink
          // path; the label-prefix match survives only for identity-less
          // fallback calls.
          const isTodo =
            identity !== null
              ? identity.name === "todo_get" ||
                identity.name === "todowrite" ||
                identity.name === "todo_update"
              : label === `${theme.symbol.toolMark} todo_get` ||
                label.startsWith(`${theme.symbol.toolMark} todowrite `) ||
                label.startsWith(`${theme.symbol.toolMark} todo_update `);
          if (isTodo) setTodoSnap(getTodos());
          if (isError) {
            // Errors commit immediately: paint any coalesced stream text
            // first so the failure line never overtakes the text it follows.
            flushDraft();
            const firstLine = result.split("\n", 1)[0] ?? result;
            items.push({ role: "tool", content: `  ${theme.symbol.detailMark} ${firstLine}`, error: true });
          } else if (isTodo) {
            items.push({ role: "tool", content: result });
          }
          // Committed approve-time captures (transcript diff + `· via`
          // provenance) for this exact execution: consume-or-clear on every
          // matching activity (success or failure) via the shared helper, so
          // a stale capture can never leak onto a later call. The via renders
          // on success and error alike (a denial names its provenance too);
          // the diff renders on success only (failures keep the ↳ line).
          const extras = consumePendingSlots(slotMatch);
          if (extras.approvalVia !== null) items[0]!.approvalVia = extras.approvalVia;
          if (!isError && extras.diff !== null) items[0]!.diff = extras.diff;
          appendTurns(...items);
          noteTurnActivity();
        },
        signal: controller.signal,
      });
      // Turn-end flush: any trailing throttled partial paints before the
      // commit replaces the draft (byte-exact via `reply` regardless). The
      // final round's thinking commits first (chronological: reasoning, then
      // the answer it produced).
      flushDraft();
      commitThinking();
      // The loop returns the FINAL post's text only: inter-tool chatter was
      // pinned above at each tool commit, so commit just the remainder — an
      // empty final reply falls back to uncommitted stream text, and a turn
      // with nothing streamed commits nothing (never a blank vanishing turn).
      if (reply.trim().length > 0) {
        if (reply !== committedStreamRef.current) {
          committedStreamRef.current = reply;
          appendTurns({ role: "assistant", content: reply });
        }
      } else {
        const pendingReply = takeUncommittedStream();
        if (pendingReply !== null) appendTurns(pendingReply);
      }
      // The turn committed to history (final text, denial-as-result, or
      // stop-notice) — persist the kill-safe save. Rolled-back turns (catch
      // below) never reach here, so a failure can't clobber the last good save.
      persistSession();
      // Local observability: close the turn trace with the loop's own outcome
      // labels (completed / blocked / unverified / budget-exceeded) and flush.
      telemetry.endTurn(telemetryTurnId, classifyTurnOutcome(reply), reply);
      persistTelemetry();
      // Success path reached turn end — the compact drain plus everything
      // after it runs in the single turn-boundary drain (see the finally).
      turnOutcome = "clean";
    } catch (err) {
      const cancelled =
        err instanceof LoopCancelledError ||
        (err instanceof Error && err.name === "LoopCancelledError") ||
        controller.signal.aborted;
      historyRef.current.splice(rollbackTo); // don't keep the failed/cancelled turn
      turnCancelledRef.current = cancelled;
      // The failure path reached turn end — compact drain plus the rest runs
      // in the single turn-boundary drain (see the finally).
      turnOutcome = cancelled ? "cancelled" : "failed";
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
        // Clear live draft so the cancelled turn doesn't leave a stale
        // preview in the live zone until drainTurnBoundary runs.
        flushDraft();
        streamStore.setDraft(null);
      } else {
        // Failed (not cancelled): the streamed answer so far is committed
        // as a marked partial turn BEFORE the error. Without this, a rate
        // limit or dead network after 30s of streaming wipes everything the
        // user already read. History stays rolled back (model never sees
        // it); only the display transcript keeps the partial.
        // Fix 01: takeUncommittedStream returns null when the text was
        // already pinned at a preceding tool commit (committedStreamRef
        // equals lastPartial). In that case the partial is already visible
        // as an assistant turn, but the "(request failed… preserved)"
        // marker is still required — fall back to lastPartialRef directly
        // and avoid duplicate content when already committed.
        let pendingPartial = takeUncommittedStream();
        const rawPartial = lastPartialRef.current;
        lastPartialRef.current = "";
        if (pendingPartial !== null) {
          appendTurns({
            role: "assistant",
            content: `${pendingPartial.content}\n\n(request failed before completing — partial output preserved)`,
          });
        } else if (typeof rawPartial === "string" && rawPartial.trim().length > 0) {
          // Already pinned (e.g. "half answer here" before first tool) — just
          // add the marker as a follow-on assistant turn so the user sees
          // the failure scope without duplicating the already-visible text.
          // If committedStreamRef already equals rawPartial, the text is
          // visible above the tool line; only the marker is needed.
          if (rawPartial !== committedStreamRef.current) {
            appendTurns({
              role: "assistant",
              content: `${rawPartial}\n\n(request failed before completing — partial output preserved)`,
            });
            committedStreamRef.current = rawPartial;
          } else {
            appendTurns({
              role: "assistant",
              content: `(request failed before completing — partial output preserved)`,
            });
          }
        }
        // Clear the live draft so the committed partial in the transcript
        // doesn't duplicate with a stale draft in the live zone. The
        // partial is now in the transcript; the live zone should be empty
        // until drainTurnBoundary finishes teardown.
        flushDraft();
        streamStore.setDraft(null);
        // Size-error overflow recovery (ticket 02): a 413/context-overflow
        // compacts with overflow semantics through the single doCompact
        // funnel instead of idling on the error. doCompact reports inline
        // and returns false when there is nothing to compact (e.g. a lone
        // first turn) — fall back to the plain error then, so genuine
        // bad-request 400s and tiny histories still surface verbatim.
        // The gate respects auto=false (error idles, no compaction).
        let recovered = false;
        try {
          if (shouldCompactOnSizeError(isSizeError(err))) {
            recovered = await doCompact("", true);
          }
        } catch {
          recovered = false;
        }
        if (!recovered) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      // (Compact drain for this path lives in the single turn-boundary
      // drain below — no inline drain logic remains here.)
    } finally {
      // The single turn-boundary drain (ticket 07): compact → steer →
      // queue → goal-resume, in that order (see drainTurnBoundary). The
      // outcome glue above selects the clean vs failed/cancelled compact
      // variant; everything else (teardown position, steer-to-front,
      // cancel-keeps-queue) is owned by the routine.
      await drainTurnBoundary(turnOutcome, goalWorkStartMs, goalWorkObjective);
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
    // 2a. Extension dialog (ticket 10): same keys as the question modal —
    // arrows + Enter picks, typing + Enter submits custom text (allowCustom
    // only), Esc cancels with a clean error. Owns the keyboard while open
    // (like every modal above): resolvers can never clobber each other, and
    // a dialog stranded by a session switch is already rejected by
    // invalidate, so resolve/cancel here always hits the live request.
    const extDlg = extRuntimeRef.current?.getPendingDialog() ?? null;
    if (extDlg) {
      const len = Math.max(extDlg.options.length, 1);
      if (key.upArrow) {
        setExtDlgSelBoth((extDlgSelRef.current - 1 + len) % len);
      } else if (key.downArrow) {
        setExtDlgSelBoth((extDlgSelRef.current + 1) % len);
      } else if (key.escape) {
        extRuntimeRef.current?.cancelPendingDialog(`extension "${extDlg.owner}" dialog was cancelled by user`);
        setExtDlgSelBoth(0);
        setExtDlgCustomBoth("");
      } else if (key.return || key.tab) {
        if (extDlg.allowCustom && extDlgCustomRef.current.trim().length > 0) {
          if (extRuntimeRef.current?.resolvePendingDialog(extDlgCustomRef.current) === true) {
            setExtDlgSelBoth(0);
            setExtDlgCustomBoth("");
          }
        } else {
          const picked = extDlg.options[extDlgSelRef.current];
          if (picked !== undefined && extRuntimeRef.current?.resolvePendingDialog(picked) === true) {
            setExtDlgSelBoth(0);
            setExtDlgCustomBoth("");
          }
        }
      } else if (key.backspace || key.delete) {
        if (extDlg.allowCustom) {
          setExtDlgCustomBoth(extDlgCustomRef.current.slice(0, -1));
        }
      } else if (ch && !key.ctrl && !key.meta && !key.tab) {
        if (extDlg.allowCustom) {
          setExtDlgCustomBoth(extDlgCustomRef.current + ch);
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
            // Effort needs no re-gating: it is assumed for every model and
            // only a server 400 can veto it (the POST retries without it).
          } else {
            // Cross-provider pick: switch with the resolved key (env wins,
            // else stored — remote sections only render for keyed providers;
            // local sections need no key) and keep the picked model; the
            // live refresh lands in the background via the standard switch
            // path. Effort carries over untouched — it is valid on every
            // provider kind.
            const switchedKey = keyForProvider(picked.providerId);
            if (switchedKey || !providerNeedsKey(picked.providerId)) {
              const pickedProvider = picked.providerId;
              const pickedModel = picked.model;
              void (async () => {
                await switchProviderWithKey(pickedProvider, switchedKey, pickedModel);
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
    // 3a2. Session picker (interactive switcher, same pattern as /skill:
    // type to filter, ↑/↓ + Enter switches, Esc cancels with the live
    // session completely unchanged). The list is the open-time snapshot —
    // filtering never touches disk. Enter on an empty filtered list only
    // prints a widen hint (no switch, no state change).
    if (selectingSession) {
      // Rebuilt per keypress from the same render's state the paint uses, so
      // highlight/filter/paint never disagree mid-tick.
      const entries = filterSessionEntries(sessionItems, sessionFilterRef.current);
      if (key.upArrow) {
        if (entries.length > 0) {
          setSessionIndexBoth(
            (sessionIndexRef.current - 1 + entries.length) % entries.length
          );
        }
      } else if (key.downArrow) {
        if (entries.length > 0) {
          setSessionIndexBoth((sessionIndexRef.current + 1) % entries.length);
        }
      } else if (key.escape) {
        setSessionFilterBoth("");
        setSelectingSession(false);
      } else if (key.return) {
        const picked = entries[sessionIndexRef.current];
        setSessionFilterBoth("");
        setSelectingSession(false);
        if (picked) {
          exitHistoryBrowse();
          void switchToSession(picked.id);
        } else {
          pushInfo("(no sessions match — backspace to widen the filter.)");
        }
      } else if (key.backspace || key.delete) {
        setSessionFilterBoth(sessionFilterRef.current.slice(0, -1));
        setSessionIndexBoth(0);
      } else if (ch && !key.ctrl && !key.meta && !key.tab) {
        setSessionFilterBoth(sessionFilterRef.current + ch);
        setSessionIndexBoth(0);
      }
      return;
    }
    // 3a3. MCP server popup (/mcp, opencode-style): ↑/↓ moves, Space toggles
    // enable/disable in place (persisted + reconnected via toggleMcpEntry),
    // Esc closes with nothing pending. No typing filter — other keys are
    // ignored so a stray keypress can never corrupt the snapshot.
    if (selectingMcp) {
      if (key.upArrow) {
        if (mcpItems.length > 0) {
          setMcpIndexBoth((mcpIndexRef.current - 1 + mcpItems.length) % mcpItems.length);
        }
      } else if (key.downArrow) {
        if (mcpItems.length > 0) {
          setMcpIndexBoth((mcpIndexRef.current + 1) % mcpItems.length);
        }
      } else if (key.escape) {
        setSelectingMcp(false);
      } else if (ch === " ") {
        const picked = mcpItems[mcpIndexRef.current];
        if (picked) toggleMcpEntry(picked.name);
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
          // No support warning: every model on every provider accepts the
          // knob; only a server 400 vetoes it (retried without, warned).
          setEffortBoth(picked);
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
        ? buildSlashMenu(cur, skillMenu, listExtensionCommands())
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
        // /compact, /queue, /steer, /autoscroll, and /goal run while busy
        // (see slashRunsWhileBusy); every other entry still waits idle.
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
            pick.name === "/goal" &&
            (inputRef.current === "/goal" || inputRef.current.startsWith("/goal "))
          ) {
            // Preserve the typed objective (e.g. "/goal Ship v2"); a bare
            // highlighted name falls through to status.
            const raw = inputRef.current;
            setInputBoth("");
            runGoalCommand(raw);
          } else if (
            (pick.name === "/allow" || pick.name === "/deny" || pick.name === "/rules") &&
            inputRef.current.startsWith(pick.name)
          ) {
            // Preserve the typed rule args (e.g. "/allow bash:npm test*");
            // a bare highlighted name falls through to usage/list.
            const raw = inputRef.current;
            setInputBoth("");
            runRulesCommand(raw);
          } else if (
            pick.name === "/rename" &&
            (inputRef.current === "/rename" || inputRef.current.startsWith("/rename "))
          ) {
            // Preserve the typed name (e.g. '/rename "Build auth"'); a bare
            // highlighted name falls through to usage.
            const raw = inputRef.current;
            setInputBoth("");
            runRenameCommand(raw);
          } else if (
            pick.name === "/fork" &&
            (inputRef.current === "/fork" || inputRef.current.startsWith("/fork "))
          ) {
            // Preserve the typed drop count (e.g. "/fork 5"); a bare
            // highlighted name forks at the tip.
            const raw = inputRef.current;
            setInputBoth("");
            void runForkCommand(raw);
          } else if (
            pick.name === "/revert" &&
            (inputRef.current === "/revert" || inputRef.current.startsWith("/revert "))
          ) {
            // Preserve the typed checkpoint index (e.g. "/revert 1"); a
            // bare highlighted name reverts to the latest checkpoint.
            const raw = inputRef.current;
            setInputBoth("");
            void runRevertCommand(raw);
          } else if (
            !pick.skill &&
            getExtensionCommand(pick.name.slice(1)) &&
            (inputRef.current === pick.name || inputRef.current.startsWith(`${pick.name} `))
          ) {
            // Extension slash command (ticket 04): preserve the typed args
            // like /rename — a bare highlighted name runs with empty args.
            // Builtins keep precedence (an extension name can never equal a
            // builtin — activation rejects the collision).
            const raw = inputRef.current;
            setInputBoth("");
            const target = parseExtensionCommandInput(raw);
            if (target) void runExtensionCommandFromApp(target.name, target.args);
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
    // Ctrl+O opens the inspector (even while busy — read-only) and, when
    // already open, expands/collapses the selected tool output so "Ctrl+O
    // to expand" works. Esc still closes. Inspector keys never reach the
    // input, and input keys never reach the inspector. Handles both Ink-
    // normalized "o" with ctrl and raw \x0F for robustness.
    {
      const lower = (ch ?? "").toLowerCase();
      const isCtrlO = (key.ctrl && lower === "o") || ch === "\x0F" || ch === "\x0f" || ch === "\u000F";
      if (isCtrlO) {
        if (inspectingRef.current) {
          setInspectExpandedBoth(!inspectExpandedRef.current);
          setInspectScrollBoth(0);
          return;
        }
        if (
          !pendingApproval && !pendingQuestion && !extDialogOpen &&
          !selecting && !selectingSkills && !selectingProvider && !selectingSession && !selectingMcp &&
          !keyPrompt && !baseURLPrompt && !selectingEffort &&
          !selectingRewind && !selectingRewindScope && !usageLedgerOpenRef.current && !paletteOpenRef.current
        ) {
          openInspector();
        }
        return;
      }
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
    // 4c2. Usage ledger (realtime-token-usage 05, read-only like the
    // inspector): Esc closes, arrows/PgUp/PgDn move. Owns the keyboard
    // while open — input keys never reach the composer behind it.
    if (usageLedgerOpenRef.current) {
      const rows = stepsForSession(usageStepsRef.current, activeSessionIdRef.current ?? "");
      const lastRow = Math.max(0, rows.length - 1);
      if (key.escape) {
        closeUsageLedger();
      } else if (key.upArrow) {
        if (usageLedgerIndexRef.current > 0) {
          setUsageLedgerIndexBoth(usageLedgerIndexRef.current - 1);
        }
      } else if (key.downArrow) {
        if (usageLedgerIndexRef.current < lastRow) {
          setUsageLedgerIndexBoth(usageLedgerIndexRef.current + 1);
        }
      } else if (key.pageUp) {
        setUsageLedgerIndexBoth(Math.max(0, usageLedgerIndexRef.current - 5));
      } else if (key.pageDown) {
        setUsageLedgerIndexBoth(Math.min(lastRow, usageLedgerIndexRef.current + 5));
      }
      return;
    }
    // 4d. Command palette (Ctrl+P toggles; Ctrl+K stays kill-to-end).
    // Opens over idle or busy turns alike (no modal/picker/inspector may be
    // open); Enter runs through the shared busy-gate, so only
    // compact/queue/steer fire while busy.
    if (key.ctrl && (ch === "p" || ch === "P")) {
      if (
        !pendingApproval && !pendingQuestion && !extDialogOpen &&
        !selecting && !selectingSkills && !selectingSession && !selectingMcp && !selectingProvider &&
        !keyPrompt && !baseURLPrompt && !selectingEffort &&
        !selectingRewind && !selectingRewindScope && !inspecting && !usageLedgerOpen
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
    // 4e. @ mentions picker (05 parity, G1): when visible it owns Up/Down/Enter/Esc.
    if (mentionVisibleRef.current) {
      const cands = mentionCandidatesRef.current;
      const hi = mentionIndexRef.current;
      if (key.upArrow) {
        if (cands.length > 0) setMentionIndexBoth((hi - 1 + cands.length) % cands.length);
        return;
      }
      if (key.downArrow) {
        if (cands.length > 0) setMentionIndexBoth((hi + 1) % cands.length);
        return;
      }
      if (key.escape) {
        setMentionVisibleBoth(false);
        setMentionQueryBoth("");
        setMentionCandidatesBoth([]);
        setMentionIndexBoth(0);
        setMentionTriggerStartBoth(null);
        return;
      }
      if (key.return) {
        const picked = cands[hi];
        if (!picked) {
          setMentionVisibleBoth(false);
          return;
        }
        const start = mentionTriggerStartRef.current ?? 0;
        const before = inputRef.current.slice(0, start);
        const after = inputRef.current.slice(cursorRef.current);
        // Directory expand: highlight is dir, query not yet that dir/ => insert without space, keep picker.
        const isDir = picked.endsWith("/");
        const alreadyExpanded = inputRef.current.slice(start, cursorRef.current) === `@${picked}`;
        if (isDir && !alreadyExpanded) {
          const nextInput = `${before}@${picked}${after}`;
          const nextCursor = before.length + 1 + picked.length;
          setInputAndCursor(nextInput, nextCursor);
          // Keep picker open filtered to that prefix.
          const pool = mentionPoolRef.current;
          const filtered = filterMentionCandidates(pool, picked, 20);
          setMentionCandidatesBoth(filtered);
          setMentionQueryBoth(picked);
          setMentionIndexBoth(0);
          // trigger start stays same
          return;
        }
        // File or confirmed dir: insert token + space, attach, close picker.
        const token = `@${picked}`;
        const nextInput = `${before}${token} ${after}`;
        const nextCursor = before.length + token.length + 1;
        // Attach file mention
        const pathForAttach = picked.endsWith("/") ? picked.slice(0, -1) : picked;
        const mention: FileMention = { path: pathForAttach, token };
        // Deduplicate same token
        if (!mentionsRef.current.some((m) => m.token === token)) mentionsRef.current.push(mention);
        setInputAndCursor(nextInput, nextCursor);
        setMentionVisibleBoth(false);
        setMentionQueryBoth("");
        setMentionCandidatesBoth([]);
        setMentionIndexBoth(0);
        setMentionTriggerStartBoth(null);
        return;
      }
      if (key.backspace || key.delete) {
        // Let plain backspace run, but picker will re-filter via updateMentionPicker in setInputAndCursor.
        // Fall through to plain handling for deletion.
      } else if (ch && !key.ctrl && !key.meta && !key.tab) {
        // Typing continues to filter via setInputAndCursor; fall through.
      } else {
        // Other keys (left/right etc.) fall through to plain handling which updates cursor and picker.
      }
      // For typing/backspace/cursor moves, fall through to plain input handling which will call setInputAndCursor and re-filter.
      // But for navigation/enter/esc we already returned.
    }
    // 4f. Shell mode (06 parity, G2): when active it owns Esc and Backspace at 0 and Enter.
    if (shellActiveRef.current) {
      if (key.escape) {
        setShellActiveBoth(false);
        setInputBoth("");
        return;
      }
      if (key.backspace && cursorRef.current === 0 && inputRef.current.length === 0) {
        setShellActiveBoth(false);
        return;
      }
      if (key.return) {
        const text = inputRef.current;
        const cmd = stripShellBang(`!${text}`) || text; // text already without !, but handle both
        const trimmed = cmd.trim();
        if (!trimmed) {
          setShellActiveBoth(false);
          setInputBoth("");
          return;
        }
        // Submit shell command directly (not LLM).
        setShellActiveBoth(false);
        setInputBoth("");
        // Fire-and-forget bash execution; render audit line + output.
        void (async () => {
          const cmdToRun = trimmed;
          appendTurns({ role: "user", content: `$ ${cmdToRun}` });
          try {
            const result = await guardedExecute("bash", { command: cmdToRun });
            const label = `${theme.symbol.toolMark} bash ${cmdToRun}`;
            const summary = deriveSummary(getToolKind("bash"), "bash", cmdToRun, result, false);
            appendTurns({ role: "tool", content: label, summary } as Turn);
            // Also show output as tool detail if present
            if (result && result.trim()) appendTurns({ role: "tool", content: result });
          } catch (e) {
            appendTurns({ role: "tool", content: `  ${theme.symbol.detailMark} ${String(e)}`, error: true } as Turn);
          }
        })();
        return;
      }
      // Otherwise fall through to plain input handling for typing/backspace etc., but shell stays active.
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
      // Shell active already handled above; plain Esc clears input and dismisses mention/paste.
      if (mentionVisibleRef.current) setMentionVisibleBoth(false);
      setInputBoth("");
      pastedChunksRef.current = [];
      mentionsRef.current = [];
    } else if (ch && !key.ctrl && !key.meta && !key.tab) {
      // Shell trigger: ! at offset 0 when normal and input empty and no picker/busy.
      if (
        ch === "!" &&
        !shellActiveRef.current &&
        inputRef.current.length === 0 &&
        cursorRef.current === 0 &&
        modeRef.current === "normal" &&
        !busyRef.current &&
        !mentionVisibleRef.current
      ) {
        setShellActiveBoth(true);
        return;
      }
      insertAtCursor(ch);
    }
  });

  // Extension UI surface reads (ticket 10): fresh copies per render,
  // repainted via the bumpExtUI subscription at boot. Unknown widget
  // placements never reach here (the host validates fail-closed). Declared
  // before the paste/memo guards below (render-execution order matters).
  const extRuntime = extRuntimeRef.current;
  const extSegments = extRuntime?.getStatusSegments().map((s) => s.text) ?? [];
  const extWidgets = extRuntime?.getWidgets().filter((w) => w.placement === "panel") ?? [];
  const extPendingDialog = extRuntime?.getPendingDialog() ?? null;
  const extDialogOpen = extPendingDialog !== null;
  const extStatusText = formatExtensionStatusText(extSegments);
  const extDialogId = extPendingDialog?.id ?? null;

  // Extension notices: drain the runtime queue into the transcript as
  // `(owner) message` info lines. Runs every render; drain-then-clear is
  // idempotent, so re-renders post nothing twice.
  useEffect(() => {
    const runtime = extRuntimeRef.current;
    if (!runtime) return;
    const notes = runtime.drainNotifications();
    for (const n of notes) pushInfo(`(${n.owner}) ${n.message}`);
  });
  // A new dialog starts with a fresh selection (a session switch that
  // rejects the old request also drops the modal — see invalidate).
  useEffect(() => {
    setExtDlgSelBoth(0);
    setExtDlgCustomBoth("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extDialogId]);

  // Bracketed paste (07 paste hardening, G3): collapse, filepath attach, image, shell !-trigger.
  // Pasted text including newlines inserts at cursor verbatim and NEVER submits.
  // When plain input is focused (idle or busy queue-draft) it owns the channel.
  usePaste(
    (raw) => {
      const text = normalizePaste(raw);
      if (!text) return;
      const isActive =
        !pendingApproval &&
        !pendingQuestion &&
        !extDialogOpen &&
        !selecting &&
        !selectingSkills &&
        !selectingSession &&
        !selectingMcp &&
        !selectingProvider &&
        !keyPrompt &&
        !baseURLPrompt &&
        !selectingEffort &&
        !selectingRewind &&
        !selectingRewindScope &&
        !inspecting &&
        !usageLedgerOpenRef.current;
      if (!isActive) {
        insertAtCursor(text);
        return;
      }
      // Shell paste !-trigger (06): bracketed "!echo hi" at offset 0 enters SHELL.
      const cur = inputRef.current;
      const at = Math.max(0, Math.min(cursorRef.current, cur.length));
      if (
        text.startsWith("!") &&
        at === 0 &&
        cur.length === 0 &&
        !shellActiveRef.current &&
        modeRef.current === "normal"
      ) {
        setShellActiveBoth(true);
        const stripped = stripShellBang(text);
        // Insert remainder after stripping ! (may be multiline — paste already normalized)
        if (stripped) {
          // For pasted shell, insert without collapsing (shell commands short)
          insertAtCursor(stripped);
        }
        return;
      }
      // Binary (contains \0) => [Image N] (never garbage)
      if (containsBinary(text)) {
        const n = pastedImageCountRef.current + 1;
        pastedImageCountRef.current = n;
        const token = pasteImageToken(n);
        const chunk: PastedChunk = { token, full: text };
        pastedChunksRef.current.push(chunk);
        insertAtCursor(token);
        return;
      }
      // Filepath attach: check if pasted text is an existing file path.
      // Async stat is needed — fire and handle insertion async, but keep paste
      // non-submitting: we optimistically insert path or token, file content rides payload.
      const candidates = extractPastedPathCandidates(text);
      if (candidates.length > 0) {
        void findExistingPastedPaths(candidates, process.cwd()).then(async (hits) => {
          if (hits.length > 0) {
            const hit = hits[0]!;
            if (hit.isImage) {
              const n = pastedImageCountRef.current + 1;
              pastedImageCountRef.current = n;
              const token = pasteImageToken(n);
              // For image file path, draft shows [Image N], payload will carry token + file block.
              // Store full as token plus file reference so payload check finds both.
              const fileBlock = `\n\n<file path="${hit.rel}">[Image]</file>`;
              const chunk: PastedChunk = { token, full: `${token}${fileBlock}` };
              pastedChunksRef.current.push(chunk);
              insertAtCursor(token);
            } else {
              // Text file: check if it's actually text and not too large, then attach.
              // Draft shows rel path, not content; payload expands to path + <file> block.
              try {
                const st = await fs.promises.stat(hit.abs);
                if (st.isDirectory()) {
                  // Directory pasted: show rel path, payload will list entries via expand? simple file block.
                  const tokenDir = hit.rel;
                  const chunk: PastedChunk = { token: tokenDir, full: `${tokenDir}\n\n<file path="${hit.rel}">(directory)</file>` };
                  pastedChunksRef.current.push(chunk);
                  insertAtCursor(tokenDir);
                } else {
                  const rawBuf = await fs.promises.readFile(hit.abs);
                  if (rawBuf.includes(0)) {
                    // Binary file pasted as path => treat as image
                    const n = pastedImageCountRef.current + 1;
                    pastedImageCountRef.current = n;
                    const token = pasteImageToken(n);
                    const chunk: PastedChunk = { token, full: `${token}\n\n<file path="${hit.rel}">[binary]</file>` };
                    pastedChunksRef.current.push(chunk);
                    insertAtCursor(token);
                  } else {
                    const content = rawBuf.toString("utf8");
                    const tokenFile = hit.rel;
                    const fileBlock = `\n\n<file path="${hit.rel}">\n${content}\n</file>`;
                    const chunk: PastedChunk = { token: tokenFile, full: `${tokenFile}${fileBlock}` };
                    pastedChunksRef.current.push(chunk);
                    insertAtCursor(tokenFile);
                  }
                }
              } catch {
                // Stat/read failed => fallback to verbatim or collapse
                if (shouldCollapsePaste(text)) {
                  const liveTokens = pastedChunksRef.current.map((c) => c.token);
                  const token = pasteSummaryToken(text, liveTokens);
                  const chunk: PastedChunk = { token, full: text };
                  pastedChunksRef.current.push(chunk);
                  insertAtCursor(token);
                } else {
                  insertAtCursor(text);
                }
              }
            }
            return;
          }
          // No file hit => check collapse
          if (shouldCollapsePaste(text)) {
            const liveTokens = pastedChunksRef.current.map((c) => c.token);
            const token = pasteSummaryToken(text, liveTokens);
            const chunk: PastedChunk = { token, full: text };
            pastedChunksRef.current.push(chunk);
            insertAtCursor(token);
          } else {
            insertAtCursor(text);
          }
        });
        return;
      }
      // No file hit => collapse or verbatim
      if (shouldCollapsePaste(text)) {
        const liveTokens = pastedChunksRef.current.map((c) => c.token);
        const token = pasteSummaryToken(text, liveTokens);
        const chunk: PastedChunk = { token, full: text };
        pastedChunksRef.current.push(chunk);
        insertAtCursor(token);
      } else {
        insertAtCursor(text);
      }
    },
    {
      isActive:
        !pendingApproval &&
        !pendingQuestion &&
        !extDialogOpen &&
        !selecting &&
        !selectingSkills &&
        !selectingSession &&
        !selectingMcp &&
        !selectingProvider &&
        !keyPrompt &&
        !baseURLPrompt &&
        !selectingEffort &&
        !selectingRewind &&
        !selectingRewindScope &&
        !inspecting &&
        !usageLedgerOpen,
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
  // Memoized on every gate input: without this the fuzzy matcher rebuilds
  // on each 1s tick and tool append even though the menu only depends on
  // input + overlay state.
  const slashMenu: SlashMenu = useMemo(
    () =>
      !selecting &&
      !selectingSkills &&
      !selectingEffort &&
      !selectingProvider &&
      !keyPrompt &&
      !baseURLPrompt &&
      !pendingApproval &&
      !pendingQuestion &&
      !extDialogOpen &&
      !selectingRewind &&
      !selectingRewindScope &&
      !slashDismissed &&
      input.startsWith("/") &&
      !input.includes("\n")
        ? buildSlashMenu(input, skillMenu)
        : { items: [], moreSkills: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      selecting,
      selectingSkills,
      selectingEffort,
      selectingProvider,
      keyPrompt,
      baseURLPrompt,
      pendingApproval,
      pendingQuestion,
      extDialogOpen,
      selectingRewind,
      selectingRewindScope,
      slashDismissed,
      input,
      skillMenu,
    ]
  );
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
  // rows no matter how many providers list. Memoized: the registry walk
  // (all providers + fallbacks) must not rerun on ticks/appends while open.
  // Deps cover every read inside buildModelEntries: selecting gate, provider
  // mirror, live models, auth store (key presence), and the local snapshot
  // (loopback baseURLs feed the cache keys); cache-ref writes always land
  // alongside one of these setStates, so the memo can never go stale.
  const { modelEntriesAll, modelEntries } = useMemo(() => {
    const all = selecting ? buildModelEntries() : [];
    return {
      modelEntriesAll: all,
      modelEntries: selecting ? filterModelEntries(all, modelFilter) : [],
    };
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selecting, provider, models, auth, localSnap, modelFilter]);
  const modelHi =
    modelEntries.length === 0 ? 0 : Math.max(0, Math.min(selIndex, modelEntries.length - 1));
  const modelWin = pickerWindow(modelEntries.length, modelHi);
  const modelTitle =
    `Atom — Select model (${modelEntries.length}` +
    (modelFilter ? ` of ${modelEntriesAll.length}, filter: "${modelFilter}"` : "") +
    `) — type to filter, up/down + Enter, Esc cancels:`;

  // /skill picker derived for render (mirrors the useInput computation
  // above): names only, filtered, clamped highlight, visible window. The
  // title keeps the `Skills (` prefix the registry header always had.
  // Memoized for the same tick/append reason as the model picker above.
  const { skillEntriesAll, skillEntries } = useMemo(() => {
    const all = selectingSkills ? skillPickerItems : [];
    return {
      skillEntriesAll: all,
      skillEntries: selectingSkills ? filterSkillPicker(all, skillFilter) : [],
    };
  }, [selectingSkills, skillPickerItems, skillFilter]);
  const skillHi =
    skillEntries.length === 0 ? 0 : Math.max(0, Math.min(skillIndex, skillEntries.length - 1));
  const skillWin = pickerWindow(skillEntries.length, skillHi);
  const skillTitle =
    `Skills (${skillEntries.length}` +
    (skillFilter ? ` of ${skillEntriesAll.length}, filter: "${skillFilter}"` : "") +
    `) — type to filter, up/down + Enter, Esc cancels:`;

  // /session picker derived for render (mirrors the useInput computation
  // above): open-time snapshot, filtered in memory, clamped highlight,
  // visible window. Memoized for the same tick/append reason as the pickers
  // above. nowMs via Date.now (render-time age labels, never persisted).
  const { sessionEntriesAll, sessionEntries } = useMemo(() => {
    const all = selectingSession ? sessionItems : [];
    return {
      sessionEntriesAll: all,
      sessionEntries: selectingSession ? filterSessionEntries(all, sessionFilter) : [],
    };
  }, [selectingSession, sessionItems, sessionFilter]);
  const sessionHi =
    sessionEntries.length === 0 ? 0 : Math.max(0, Math.min(sessionIndex, sessionEntries.length - 1));
  const sessionWin = pickerWindow(sessionEntries.length, sessionHi);
  const sessionPickerTitle =
    `Sessions (${sessionEntries.length}` +
    (sessionFilter ? ` of ${sessionEntriesAll.length}, filter: "${sessionFilter}"` : "") +
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
  // Approval description: the tool-call one-liner for the modal, stashed on
  // the pending approval by approve() itself — render never recomputes it
  // (describeToolCall may resolve symlinks, so rebuilding it here would put
  // filesystem reads back into the 1s busy-tick render path).
  const approvalDescription = pendingApproval?.description ?? "";
  // (The cursor clamp lives inside the memoized InputBox now, next to its
  // only use — App body no longer reads cursor state for paint.)

  // Status-line reasoning segment wired to the effort session state: a
  // non-Auto effort always shows the effort (the knob is sent for every
  // model on every provider kind); Auto shows response metadata or "auto".
  // "(unsupported)" survives only as a safety net for an unknown provider —
  // support is otherwise assumed, with the server as the authority (a 400
  // naming the knob retries the POST without it and warns).
  const effortSupportedNow =
    effort === "auto" || isEffortSupported(model, provider);
  const reasoningDisplay =
    effort !== "auto"
      ? effortSupportedNow
        ? effort
        : `${effort} (unsupported)`
      : (reasoning ?? "auto");

  // Display-only live tool elapsed: wall-clock now ≈ turn start + elapsed
  // ticks (the 1s busy tick re-renders, so this stays fresh). Null when no
  // tool is running — the running line then paints with no duration. Reads
  // the machine ref (synchronous, never a lagging state snapshot).
  const toolCallLive = toolCallRef.current;
  const toolCallStartedAt = toolCallLive.status === "idle" ? null : toolCallLive.startedAt;
  const toolElapsedSecs =
    busy && toolCallStartedAt !== null
      ? elapsedSecsSince(toolCallStartedAt, turnStartRef.current + elapsedSecs * 1000)
      : null;

  // Memoized goal slice for the status bar (render-stability): the inline
  // literal used to defeat StatusBarHost's memo on every App render
  // (keystrokes, 1s ticks) whenever a goal was active — a new object
  // identity per render meant the whole status subtree reconciled for
  // nothing. Identity now tracks the goal, not the render.
  const goalStatus = useMemo(
    () => (goal ? { objective: goal.objective, active: goal.active === true } : null),
    [goal]
  );

  // Adapter-driven UI state (single-source transcript, ticket 03):
  // Core and legacy commits flow through one commit path (App `turns`).
  // The adapter projects core `AgentEvent`s; the single truth is `turns`
  // — no `adapter.turns.length>0 ? adapter : turns` flip and no adopt-back.
  const uiTurns = turns;
  const uiToolHint = adapter.toolHint ?? toolHint;
  const uiThinking = adapter.thinking ?? null;
  const uiDraft = adapter.draft ?? null;

  // Mirror adapter live streams to the existing StreamStore so LiveTailHost
  // (which subscribes to the store for render-stability) sees core-path
  // thinking/draft without a second subscription. Legacy path writes the
  // store directly via paintScheduler; this effect only fires for the core
  // path and is a no-op for legacy turns (adapter stays null).
  useEffect(() => {
    streamStore.setThinking(uiThinking);
    if (uiThinking !== null) setHasHadOutputBoth(true);
  }, [uiThinking]);
  useEffect(() => {
    streamStore.setDraft(uiDraft);
    if (uiDraft !== null) setHasHadOutputBoth(true);
  }, [uiDraft]);
  // Core-path tool activity arrives via the adapter (App's toolHint stays
  // null there): it counts as output for the gap guard too.
  useEffect(() => {
    if (uiToolHint !== null) setHasHadOutputBoth(true);
  }, [uiToolHint]);

  // Transcript single-truth (core path, ticket 03): core events already
  // project via the adapter; the single commit path is App `turns`.
  // Forward-only adopt: when core grows, mirror into `turns` so
  // Conversation/persist see it. No adopt-back — wholesale replacements
  // (/clear, /new, /resume, switch, rewind) own the transcript via
  // setTurns + adapter.reset, never via length-guarded back-sync.
  const adapterAdoptedLenRef = useRef(0);
  useEffect(() => {
    if (adapter.turns.length > adapterAdoptedLenRef.current) {
      adapterAdoptedLenRef.current = adapter.turns.length;
      turnsRef.current = [...adapter.turns];
      setTurns(turnsRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter.turns]);

  // Live terminal width for the memoized Composer/InputBox: threaded as a
  // prop so resizes repaint the input (memo only reacts to props — a width
  // read inside InputBox alone would go stale until the next keystroke).
  // Stable across ticks/keystrokes, so the one-paint-per-keystroke guarantee
  // is untouched.
  let termColumns = 80;
  try {
    termColumns = useTerminalSize().columns;
  } catch {
    termColumns = 80;
  }

  return (
    <AppShell
      conversation={
        <>
          <Conversation turns={uiTurns} clearGen={clearGen} end={scrollEnd} held={scrollEnd !== null} showThinking={showThinking} />
        </>
      }
      liveZone={
        <>
          <LiveTailHost
            store={streamStore}
            isEmpty={uiTurns.length === 0}
            sessionHint={sessionHint}
            emptySessionTitle={uiTurns.length === 0 ? sessionTitle : null}
            busy={busy || adapter.busy}
            held={scrollEnd !== null}
            toolHint={uiToolHint}
            toolElapsedSecs={toolElapsedSecs}
            elapsedSecs={elapsedSecs}
            showThinking={showThinking}
            hasHadOutput={hasHadOutput}
            columns={termColumns}
          />
        </>
      }
      overlayZone={
        <>
          {error ? <ErrorMessage message={error} /> : null}
          {pendingApproval ? (
            <PermissionPrompt
              toolName={pendingApproval.name}
              description={approvalDescription}
              selected={approveIndex}
              diff={pendingApproval.diff ?? null}
            />
          ) : null}
          {pendingQuestion ? (
            <QuestionPrompt
              question={pendingQuestion.question}
              options={pendingQuestion.options}
              allowCustom={pendingQuestion.allowCustom}
              askCustom={askCustom}
              askSelIndex={askSelIndex}
            />
          ) : null}
          {/* Extension dialog (ticket 10): the shared question prompt, owner-tagged.
              Renders only when no builtin modal owns the keyboard (input routing
              above gives builtins priority); a second request is rejected by the
              runtime's single-flight guard, so dialogs never stack. */}
          {extPendingDialog && !pendingApproval && !pendingQuestion ? (
            <QuestionPrompt
              key={`ext-dialog-${extPendingDialog.id}`}
              question={`[${extPendingDialog.owner}] ${extPendingDialog.question}`}
              options={extPendingDialog.options}
              allowCustom={extPendingDialog.allowCustom}
              askCustom={extDlgCustom}
              askSelIndex={extDlgSel}
            />
          ) : null}
          {/* The input box's top border is the single separator between the
              transcript and the interactive zone — no extra divider lines. */}
          {/* live session checklist (hidden when empty) */}
          <TodoPanel items={todoSnap} />
          {/* Extension widgets (ticket 10, placement "panel"): bordered panels
              above the input zone, in first-set order. Unload drops each id via
              its unregister; session teardown clears them all (disposeUI). */}
          {extWidgets.map((w) => (
            <Box
              key={`${w.owner}-${w.id}`}
              flexDirection="column"
              borderStyle={theme.border.style}
              borderColor={theme.border.panel}
              paddingX={theme.spacing.pickerPadX}
            >
              <Text bold>
                [{w.owner}] {w.title}
              </Text>
              <Text>{w.text}</Text>
            </Box>
          ))}
        </>
      }
      footerZone={
        <>
          {/* Footer cluster (ticket 05): the input zone (composer or its
              picker/palette/inspector replacement), the slash autocomplete menu,
              and the status line render as ONE bottom-anchored column that never
              splits — streaming drafts, tool bursts, and resizes paint above it
              (Static scrollback + LiveTailHost), never through it. flexShrink=0
              keeps a short terminal from squeezing the interactive zone. */}
      {paletteOpen ? (
        <CommandPalette
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
      ) : usageLedgerOpen ? (
        <UsageLedgerPanel
          steps={stepsForSession(usageStepsRef.current, activeSessionIdRef.current ?? "")}
          index={usageLedgerIndex}
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
              // ANTI-FLICKER: key is provider+model identity WITHOUT the list
              // index. The window slides as you filter/arrow, so an index in
              // the key remounts every visible row per keystroke (unmount +
              // mount) instead of updating highlight/text in place.
              <React.Fragment key={`${e.providerId}-${e.model}`}>
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
              // ANTI-FLICKER: stable name key (no list index) — filtering must
              // update rows in place, never remount the window per keystroke.
              <PickerRow key={e.name} highlighted={i === skillHi}>
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
      ) : selectingSession ? (
        <PickerShell title={sessionPickerTitle}>
          <PickerMoreAbove count={sessionWin.start} />
          {sessionEntries.slice(sessionWin.start, sessionWin.end).map((e, k) => {
            const i = sessionWin.start + k;
            const age = formatSessionAge(Date.now(), e.updatedAt);
            return (
              <PickerRow key={`${e.id}-${i}`} highlighted={i === sessionHi}>
                {e.title}
                {e.active ? " (current)" : ""}
                <Text dimColor>
                  {" "}· {e.turnCount} turn{e.turnCount === 1 ? "" : "s"} · {age}
                </Text>
              </PickerRow>
            );
          })}
          <PickerMoreBelow count={sessionEntries.length - sessionWin.end} />
          {sessionEntries.length === 0 ? (
            <Text dimColor>
              {sessionEntriesAll.length === 0
                ? "No sessions yet — your current conversation is saved automatically."
                : "No sessions match — backspace to widen the filter."}
            </Text>
          ) : null}
        </PickerShell>
      ) : selectingMcp ? (
        <PickerShell title="Atom — MCP servers (up/down moves, Space toggles, Esc closes):">
          {mcpItems.map((e, i) => (
            <PickerRow key={e.name} highlighted={i === mcpIndex}>
              {e.enabled ? "[x]" : "[ ]"} {e.name}
              <Text dimColor> — {e.detail}</Text>
            </PickerRow>
          ))}
          {mcpItems.length === 0 ? (
            <Text dimColor>No MCP servers configured — add one to atom.json under "mcp".</Text>
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
              {o === "auto" ? "Auto" : o === "max" ? "Max" : o[0]?.toUpperCase() + o.slice(1)}
              {o === effort ? " (current)" : ""}
            </PickerRow>
          ))}
          <Text dimColor>Auto lets the model decide; Low→Max raise reasoning depth on every model.</Text>
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
        // Composer: the boxed input surface + queue/steer indicators.
        // Pickers and modals replace it (never stack with it), each carrying
        // their own semantic border color.
        <Composer input={input} cursor={cursor} busy={busy} queue={queue} steerPending={steerPending} columns={termColumns} shellActive={shellActive} placeholder={shellActive ? SHELL_PLACEHOLDER : undefined} />
      )}
      {mentionVisible && !inspecting && !usageLedgerOpen && !paletteOpen ? (
        <PickerShell
          title={`Files (${mentionCandidates.length} — @${mentionQuery}:`}
          borderColor={theme.border.menu}
        >
          {(() => {
            const win = pickerWindow(mentionCandidates.length, mentionIndex);
            return (
              <>
                <PickerMoreAbove count={win.start} />
                {mentionCandidates.slice(win.start, win.end).map((p, k) => {
                  const i = win.start + k;
                  return (
                    <PickerRow key={p} highlighted={i === mentionIndex}>
                      {p}
                    </PickerRow>
                  );
                })}
                <PickerMoreBelow count={mentionCandidates.length - win.end} />
              </>
            );
          })()}
        </PickerShell>
      ) : null}
      {slashVisible && !inspecting && !usageLedgerOpen && !paletteOpen ? (
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
      <StatusBarHost
        provider={provider}
        model={model}
        usageTotals={usageTotals}
        contextLoad={contextLoad}
        loadEstimated={loadEstimated}
        reasoningDisplay={reasoningDisplay}
        mode={shellActive ? "SHELL" : mode}
        trustAll={trustAll}
        // Single busy source for both consumers (live zone uses the same
        // `busy || adapter.busy` above): the bar must never disagree with the
        // live zone about whether a turn is running. Legacy turns keep the
        // adapter idle, so this is a no-op there.
        busy={busy || adapter.busy}
        activity={toolHint ? activityText(toolHint) : null}
        phaseLabel={phaseLabel}
        elapsedSecs={elapsedSecs}
        stalled={stalled}
        approvalPending={pendingApproval !== null}
        cwd={shortenCwd(process.cwd(), os.homedir())}
        branch={gitInfo?.branch ?? null}
        extensionStatus={extStatusText}
        goal={goalStatus}
      />
        </>
      }
    />
  );
}
