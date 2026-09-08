// Ink (React) TUI for the minimal Atom chatbot.
// Hand-rolled input + dropdowns via useInput (no extra deps).
import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
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
  historyCharBudget,
  historyMessageBudget,
  isEffortSupported,
  messageChars,
  runAgenticLoopForProvider,
  truncateHistory,
  type ApprovalDecision,
  type ChatMessage,
  type PermissionMode,
  type Phase,
  type ReasoningEffort,
  type Usage,
} from "./zen.js";
import { TOOL_DEFINITIONS, TOOL_ONE_LINERS, clearTodos, describeToolCall, executeTool, getTodos, needsApproval, type TodoItem } from "./tools.js";
import {
  checkRules,
  formatRules,
  parseRuleInput,
  type PermissionRule,
} from "./permissions.js";
import {
  capSkillBodyForAuto,
  discoverSkills,
  loadSkillBody,
  matchSkills,
  resolveSkills,
  skillsListText,
  type SkillInfo,
} from "./skills.js";
import { contextWindowFor, formatTokenSegment } from "./context-windows.js";
import {
  COMPACT_PCT_DEFAULT,
  buildCompactedHistory,
  compactBoundaryLine,
  compactPct,
  computeContextLoad,
  countUserTurns,
  estimateTokensForChars,
  isThrashDisabled,
  requestCompactSummary,
  shouldAutoCompact,
  splitHistoryForCompaction,
  type SplitResult,
} from "./compact.js";
import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  chatEndpointFor,
  getProvider,
  isProviderId,
  maskKey,
  openaiCompatibleChatEndpoint,
  validateBaseURL,
  type ProviderId,
} from "./providers.js";
import {
  getStoredBaseURL,
  loadAuth,
  resolveApiKey,
  saveAuth,
  setStoredKey,
  type AuthFile,
} from "./auth.js";
import { validateProviderKey } from "./adapters.js";
import { withEnvBlock } from "./env-block.js";
import {
  loadPrefs,
  loadSession,
  saveSession,
  sessionExists,
} from "./session.js";
import { loadAtomConfig } from "./config.js";
import {
  conversationCutIndex,
  getCheckpoint,
  listCheckpoints,
  registerHistoryProbe,
  restoreCheckpointFiles,
  type Checkpoint,
} from "./snapshots.js";
import { forgetReadFingerprint, refreshReadFingerprint } from "./tools.js";

export type Turn = {
  role: "user" | "assistant" | "tool";
  content: string;
  error?: boolean;
};

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
  { name: "/provider", description: "Pick AI provider, paste API key once, chat." },
  {
    name: "/effort",
    description:
      "Open the reasoning-effort picker (Default/Low/Medium/High/Max; top is Max, sent as max).",
  },
  { name: "/tools", description: "List the 7 tools with one-line descriptions." },
  { name: "/skills", description: "List installed skills (project + global)." },
  { name: "/skill", description: "Invoke a skill by name (/skill:name; /skills lists)." },
  { name: "/mode", description: "Print the current permission mode." },
  { name: "/yolo", description: "Toggle yolo mode (tools run without asking). Tab toggles too." },
  { name: "/trust", description: "Toggle session trust: auto-approve write/edit/bash without full yolo (/trust again revokes)." },
  { name: "/plan", description: "Enter/exit read-only plan mode (explore freely; write/edit/bash blocked; exiting approves the todo plan)." },
  { name: "/allow", description: "Pre-approve a tool pattern this session (e.g. /allow bash:npm test*)." },
  { name: "/deny", description: "Forbid a tool pattern this session — deny wins over trust/yolo (e.g. /deny bash:rm *)." },
  { name: "/rules", description: "List session allow/deny rules (/rules clear wipes them)." },
  { name: "/clear", description: "Clear the conversation history (keeps session token totals)." },
  { name: "/new", description: "Start a brand-new session (full fresh conversation + counters reset, previous kept for /resume)." },
  { name: "/compact", description: "Summarize older turns into one summary (optional focus text: /compact focus…)." },
  { name: "/context", description: "Show context usage by source (system, tools, history, skills)." },
  { name: "/queue", description: "List queued follow-ups (/queue clear wipes them)." },
  { name: "/steer", description: "Steer the running turn, or send when idle (/steer <text>)." },
  { name: "/resume", description: "Restore the last saved session (turns, history, settings, usage)." },
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

export function filterSlashCommands(prefix: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
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

// Pure menu builder (unit-tested): matching commands first (stable order),
// then matching user-invocable skills as `/skill:name` entries. Skills join
// only once the query is non-trivial (input length ≥ 2 — a bare `/` lists
// commands only), and match by skill-name prefix or full `/skill:name`
// prefix. Pure — the App feeds it the cached registry snapshot.
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
  let moreSkills = 0;
  let shown = 0;
  for (const s of skills) {
    const entry = `/skill:${s.name}`;
    if (!s.name.startsWith(q) && !entry.startsWith(input)) continue;
    if (shown < SLASH_MENU_SKILL_CAP) {
      // Name only — descriptions would bloat every row; /skills (picker)
      // and /skill:name usage carry discovery instead.
      items.push({ name: entry, description: "", skill: s.name });
      shown += 1;
    } else {
      moreSkills += 1;
    }
  }
  return { items, moreSkills };
}

// Phase 5 observability + latency polish (surgical, three items only):
// - TURN_TICK_MS: elapsed-time resolution while busy (1s).
// - TURN_STALL_AFTER_MS: silence threshold for the dim `waiting…` hint (>3s
//   with no token/tool/phase activity, status-bar only, never transcript).
export const TURN_TICK_MS = 1000;
export const TURN_STALL_AFTER_MS = 3000;

// Phase 5 models-list session cache key: provider id (+baseURL for
// openai-compatible, whose list depends on the custom endpoint).
export function modelsCacheKey(providerId: ProviderId, baseURL?: string): string {
  if (providerId === "openai-compatible") return `${providerId}|${baseURL ?? ""}`;
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
// baseURL (a key alone cannot POST anywhere).
export type ModelPickerEntry = { providerId: ProviderId; model: string };

export function modelPickerEntries(opts: {
  activeProvider: ProviderId;
  activeModels: string[];
  cached: (providerId: ProviderId, baseURL: string) => string[] | undefined;
  keyFor: (providerId: ProviderId) => string;
  baseURLFor: (providerId: ProviderId) => string;
}): ModelPickerEntry[] {
  const out: ModelPickerEntry[] = [];
  for (const m of opts.activeModels) out.push({ providerId: opts.activeProvider, model: m });
  for (const p of PROVIDERS) {
    if (p.id === opts.activeProvider) continue;
    if (!opts.keyFor(p.id)) continue;
    if (p.id === "openai-compatible" && !opts.baseURLFor(p.id)) continue;
    const list = opts.cached(p.id, opts.baseURLFor(p.id)) ?? p.fallbackModels;
    for (const m of list) out.push({ providerId: p.id, model: m });
  }
  return out;
}

// Case-insensitive substring filter over the model id (the provider id is
// included so "openai" narrows to that section). Empty query returns the
// list as-is.
export function filterModelEntries(entries: ModelPickerEntry[], query: string): ModelPickerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.model.toLowerCase().includes(q) || e.providerId.toLowerCase().includes(q)
  );
}

// Visible window for the picker: at most MODEL_PICKER_VISIBLE rows, scrolled
// so the highlight stays visible (centered while scrolling, pinned at both
// ends). Pure — the frame never grows past the window no matter how many
// models a provider lists.
export const MODEL_PICKER_VISIBLE = 10;

// Follow-up queue cap: Enter while busy queues instead of submitting, and
// the turn-end drain auto-sends while non-empty. Bounded so a held-down key
// can never flood the session; /queue manages, /queue clear wipes.
export const QUEUE_CAP = 10;

export function pickerWindow(
  total: number,
  highlight: number,
  visible: number = MODEL_PICKER_VISIBLE
): { start: number; end: number } {
  if (total <= visible) return { start: 0, end: total };
  const h = Math.max(0, Math.min(highlight, total - 1));
  const start = Math.max(0, Math.min(h - Math.floor(visible / 2), total - visible));
  return { start, end: start + visible };
}

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

// Task B smoothness (b): the 1s elapsed timer lives in App state, so every
// tick re-renders App. The committed transcript (<Static>) must NOT pay for
// that: TranscriptView memoizes on (turns, clearGen) identity, so a tick (or
// any other App state change) with an unchanged transcript skips the whole
// Static subtree. Static usage is unchanged (no virtualization).
export type StaticItem = { id: string; turn?: Turn };

export function renderTranscriptItem(item: StaticItem) {
  if (!item.turn) return <StartupBanner key={item.id} />;
  const t = item.turn;
  const i = item.id;
  // Conversation turns (user/assistant) breathe: one blank line after each,
  // so the eye lands on the next turn. Tool/status lines stay dense — they
  // read as lightweight annotations woven between turns, not blocks.
  if (t.role === "user") {
    return (
      <Box key={i} flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="cyan" bold>
            you&gt;{" "}
          </Text>
          {t.content}
        </Text>
      </Box>
    );
  }
  if (t.role === "tool") {
    return (
      <Text key={i} color={t.error ? "red" : undefined} dimColor={!t.error}>
        {t.content}
      </Text>
    );
  }
  return (
    <Box key={i} flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="magenta" bold>
          ATOM&gt;{" "}
        </Text>
        {t.content}
      </Text>
    </Box>
  );
}

// Render-count probe for the timer-isolation test: incremented on every
// TranscriptView render (a 1s timer tick must leave it unchanged).
export const transcriptRenderProbe = { count: 0 };

export type TranscriptViewProps = {
  turns: Turn[];
  clearGen: number;
  renderItem?: (item: StaticItem) => React.ReactNode;
};

export const TranscriptView = React.memo(function TranscriptView({
  turns,
  clearGen,
  renderItem,
}: TranscriptViewProps) {
  transcriptRenderProbe.count += 1;
  const render = renderItem ?? renderTranscriptItem;
  const items: StaticItem[] =
    clearGen === 0
      ? [{ id: "banner" }, ...turns.map((turn, idx) => ({ id: `turn-${idx}`, turn }))]
      : [...turns.map((turn, idx) => ({ id: `turn-${idx}`, turn }))];
  return (
    <Static key={`transcript-${clearGen}`} items={items}>
      {(item: StaticItem) => render(item)}
    </Static>
  );
});

// Render-count probe for the input-smoothness test: incremented on every
// InputBox render (one keystroke must paint the input exactly once; the 1s
// busy-tick must leave it unchanged while idle input sits still).
export const inputRenderProbe = { count: 0 };

export type InputBoxProps = { input: string; cursor: number };

// The input is the one boxed, prominent surface: a quiet gray frame sets it
// apart from the transcript above and the status line below. Memoized on
// (input, cursor) so elapsed-timer ticks, token paints, and unrelated App
// state churn never repaint it — keystrokes stay at exactly one paint each,
// which is what makes navigation feel instant instead of choppy.
export const InputBox = React.memo(function InputBox({ input, cursor }: InputBoxProps) {
  inputRenderProbe.count += 1;
  // Defensive clamp: the ref is the source of truth mid-tick and always
  // stays in range, but state may lag it by one render.
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan" bold>
        ›{" "}
      </Text>
      <Text>
        {input.slice(0, safeCursor)}
        <Text color="gray">█</Text>
        {input.slice(safeCursor)}
      </Text>
    </Box>
  );
});

function toolsListText(): string {
  const lines = Object.entries(TOOL_ONE_LINERS).map(([n, d]) => `${n} — ${d}`);
  return `Tools (${lines.length}):\n${lines.join("\n")}`;
}

// Live thinking block: reasoning streams in full, exactly as it arrives —
// the output stays as-is no matter how long it runs (no tail window, no
// truncation). The full text is never stored anywhere else — thinking stays
// transient like the answer draft (cleared on every turn boundary, never
// committed to the transcript or model history).

// Live session checklist (Claude-Code-style TodoWrite panel). Mounted in
// the live area below the transcript (NOT in <Static> scrollback) and fed
// by a snapshot the loop refreshes after every todowrite/todo_update call,
// so the in-progress row — shown with its activeForm when present — always
// answers "what is the model doing right now". Returns null when empty.
export function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === "completed").length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold>
        Tasks {done}/{items.length}
      </Text>
      {items.map((t, i) => {
        const mark = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔧" : "❌";
        const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        return (
          <Text key={`${i}-${t.content}`} dimColor={t.status === "completed"}>
            {mark} {label}
            {t.priority ? ` (${t.priority})` : ""}
          </Text>
        );
      })}
    </Box>
  );
}

export function helpListText(): string {
  const lines = SLASH_COMMANDS.map((c) => `${c.name} — ${c.description}`);
  return (
    `Commands:\n${lines.join("\n")}` +
    `\nTab toggles normal/yolo mode (in the / command menu, Tab runs the highlighted command). Tab never enters or exits plan mode (a stray keypress can't drop the safety mode — use /plan).` +
    `\n/plan toggles read-only plan mode for risky work: explore with read/grep/glob/webfetch/websearch/todos/ask_question (all run free) while write/edit/bash are blocked pre-execution with a replan note (never a prompt, never silent — the ⚙ audit line still renders). Scoped /deny rules still win in plan mode; /allow, /trust, yolo, [a]lways, and skill grants cannot punch through it (/yolo and /trust while in plan stay read-only with a notice — exit with /plan first). Exiting is the human approval: /plan from plan mode returns to normal (never yolo) and the todowrite checklist recorded while planning carries into implementation.` +
    `\n/trust toggles the session trust tier: with trust on, write/edit/bash auto-approve (one approval covers the whole task) without global yolo. Default off, normal mode stays the default; in-memory only, never saved. Every auto-approved call still renders its ⚙ line. The approval prompt also offers [t]rust-all mid-run; [n]/Esc still denies one call, Ctrl+C (or Esc while busy) still cancels the whole turn.` +
    `\n/allow <tool[:glob]> pre-approves matching write/edit/bash calls this session (no prompt; e.g. /allow bash:npm test*, /allow write:src/**; bare /allow bash matches any args). /deny <tool[:glob]> refuses matching calls before execution — the model sees the standard denial result and replans. Deny wins over /trust, yolo, [a]lways, and skill grants. Every auto-approved call still renders its ⚙ line. Rules are in-memory only (like /trust, never saved); /rules lists them, /rules clear wipes them.` +
    `\nToken totals accumulate per session from API-reported usage only: the status line shows \`token: n/a\` until the API reports usage (never estimated, never 0-by-default); with usage it shows \`token: (P%) NK\` — NK is the cumulative session spend in K, P% is the CURRENT context load over the model's verified window (last POST prompt_tokens, else the 4ch/token estimate; models with no verified window show a bare \`token: NK\`, never an invented percent). /clear keeps the totals; /new resets them.` +
    `\n/compact [focus text]: summarize older turns into one \`[Compacted context …]\` summary + keep the newest tail (~8000 estimated tokens, tool outputs capped at 2000 chars). Tiny history (≤1 user turn) reports \`(nothing to compact)\`. Works for unknown-window models (estimate only for the tail split).` +
    `\nAuto-compact: after every completed turn the load is checked; on known-window models with load/window ≥ ${Math.round(COMPACT_PCT_DEFAULT * 100)}% (env ATOM_COMPACT_PCT percent, clamped 50–95, invalid→default) history auto-compacts before the next turn. Unknown-window models never auto-compact — use /compact manually.` +
    `\nThrash guard: 3 auto-compactions without the load dropping below threshold disables auto for the session with \`(auto-compact thrashing — disabled, use /compact or /clear)\`; manual /compact still works and resets the counter on success.` +
    `\n/provider: pick opencode-zen|openai|anthropic|deepseek|mistral|google-gemini|openai-compatible, paste a key once (stored in ~/.atom/auth.json, env wins). Switching provider keeps session history text; system prompt stays.` +
    `\n/effort options: Default/Low/Medium/High/Max (wire: default/low/medium/high/max; Default omits reasoning_effort).` +
    `\nNote: xhigh was requested but only Max is verified, so the top setting is Max, sent as max.` +
    `\nGating: reasoning_effort is sent ONLY when effort != Default AND the model is one of ${[...REASONING_EFFORT_SUPPORTED_MODELS].join(", ")} AND the provider is opencode-zen; otherwise omitted (setting kept, warning shown, status shows (unsupported)). Effort persists across /model switches.` +
    `\n/resume: restores the last saved session (turns, history, provider/model/effort/mode, usage totals). The conversation never auto-restores — sending a message without /resume starts fresh, and the next completed turn overwrites the save. Your provider/model/effort picks DO persist across restarts automatically (saved on every completed turn and on clean exit; explicit OPENCODE_ZEN_MODEL wins over the saved model). /clear clears the live session only (the save keeps the pre-clear state until the next completed turn overwrites it). /new saves first, then starts a brand-new session (conversation + counters reset, settings kept) — so /resume right after /new restores the pre-/new conversation. Split: /clear = wipe transcript, keep counters; /new = full fresh conversation + counters reset, previous kept for /resume.` +
    `\nSession autosave: every completed turn (and clean exit, plus after each successful compaction) writes ~/.atom/session.json (0600 POSIX, may contain pasted secrets — never commit it); failed/cancelled turns never touch it; a corrupt save loads as "(saved session unreadable — starting fresh)".` +
    `\nBusy status shows the live phase plus elapsed seconds in the status line (· thinking… 4s); >3s without token/tool/phase activity adds a dim waiting… hint (status-bar only, never saved). ` +
    `Reasoning streams in its own dim block above the answer draft while busy (transient — never committed); Esc stops a running response (same rollback as Ctrl+C).` +
    `\n/rewind: every write/edit auto-snapshots prior bytes (silent, no prompt, no config); /rewind lists the session checkpoints and restores exact bytes (hash-verified, never a model rewrite) — files only, files + conversation, or conversation only. Shell side effects (bash) are explicitly out of scope: commands are never snapshotted and cannot be undone.` +
    `\nQueue + steer (follow-ups without losing flow): Enter while busy queues the message (visible Queued line, auto-sent when the turn ends cleanly — never after a cancel); /queue lists, /queue clear wipes (cap ${QUEUE_CAP}, in-memory only). /steer <text> injects into the RUNNING turn at the next step boundary (the current action finishes first — nothing is aborted); when idle it just sends. A steer stranded by a failed/cancelled turn rejoins the queue front instead of vanishing.`
  );
}

// Session token totals, accumulated ONLY from usage payloads the API
// actually reported. Null until the first usage payload arrives (rendered
// as `token: n/a` — never 0, which would imply measurement). The segment
// itself lives in ./context-windows.js (single source for the exact
// `token: (P%) NK` format); the footer status line is its only surface.
// P% tracks CURRENT context load (last prompt_tokens, else 4ch/token
// estimate); NK tracks cumulative session spend.
function formatTokens(
  usage: Usage | null,
  model: string,
  load: number | null
): string {
  return formatTokenSegment(usage, model, load);
}

function formatKEst(chars: number): string {
  return `~${(estimateTokensForChars(chars) / 1000).toFixed(1)}K`;
}

// Startup banner: the ATOM block-letter art, rendered once at launch inside
// <Static> (scrollback, so it scrolls away naturally). FIGlet "ANSI Shadow"
// ATOM (Unicode box-drawing — needs a monospace font with box-drawing
// support, which Windows Terminal / ConHost / most terminals have). The art
// is the whole banner: the footer status line is the sole info bar, so no
// hint lines live here.
export const ATOM_ART: string[] = [
  " █████╗ ████████╗ ██████╗ ███╗   ███╗",
  "██╔══██╗╚══██╔══╝██╔═══██╗████╗ ████║",
  "███████║   ██║   ██║   ██║██╔████╔██║",
  "██╔══██║   ██║   ██║   ██║██║╚██╔╝██║",
  "██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║",
  "╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝",
];

export function StartupBanner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {ATOM_ART.map((line, i) => (
        <Text key={i} color="cyan" bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}

export type PendingApproval = {
  name: string;
  args: Record<string, unknown>;
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
      <Text color="red" bold>
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

export function App({ apiKey, endpoint, initialModel, initialModels, initialProvider, restorePrefs, authHome, skillDirs, configDirs, now, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn }: AppProps) {
  const { exit } = useApp();
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
  const resolvedInitialModel = initialModel ?? prefs?.model ?? atomConfig.model ?? DEFAULT_MODEL;
  const resolvedInitialProvider =
    initialProvider && isProviderId(initialProvider)
      ? initialProvider
      : (prefs?.provider ?? atomConfig.provider ?? DEFAULT_PROVIDER);
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
  const [activeEndpoint, setActiveEndpoint] = useState(prefs?.endpoint ?? endpoint);
  // Permission mode (normal default, yolo toggled via /yolo). The footer
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
  // Skill entries for the slash menu (namespaced `/skill:name` commands):
  // a snapshot of user-invocable skills (name + description), refreshed on
  // mount, /skills, /clear, and /new — never per keystroke (disk I/O stays
  // out of the typing path). Empty until the first refresh lands.
  const [skillMenu, setSkillMenu] = useState<Array<{ name: string; description: string }>>([]);
  async function refreshSkillMenu(): Promise<void> {
    try {
      const found = await discoverSkills({
        projectDir: skillDirs?.projectDir,
        homeDir: skillDirs?.homeDir,
      });
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
  // Tool approval prompt (normal mode, write/edit/bash): the loop waits on
  // the resolver until the user presses y/a/n. Ctrl+C aborts the whole turn
  // (LoopCancelledError) instead of denying one call.
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const approvalResolveRef = useRef<{
    resolve: (d: ApprovalDecision) => void;
    reject: (err: Error) => void;
  } | null>(null);
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
  const [error, setError] = useState<string | null>(null);
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
  // answer, rendered in its own dim block below. Transient like `draft` —
  // cleared on every turn boundary below — and never committed to the
  // transcript or the model history.
  const [thinking, setThinking] = useState<string | null>(null);
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
  const historyRef = useRef<ChatMessage[]>([
    { role: "system", content: withEnvBlock(systemPrompt) },
  ]);
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
      const baseURL = getStoredBaseURL(authRef.current, p);
      const cacheKey = modelsCacheKey(p, baseURL);
      const cached = modelsCacheRef.current.get(cacheKey);
      if (cached) {
        setModels([...cached]);
        return () => {
          cancelled = true;
        };
      }
      const k = resolveApiKey(p, authRef.current) || activeApiKeyRef.current;
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

  // Phase 5: turn timer helpers (injectable now/timers for tests). The
  // interval handle is always cleared on turn end and on unmount.
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
  // cursor, backspace deletes BEFORE it, Delete removes AT it.
  function insertAtCursor(text: string) {
    if (!text) return;
    const cur = inputRef.current;
    const at = Math.max(0, Math.min(cursorRef.current, cur.length));
    setInputAndCursor(cur.slice(0, at) + text + cur.slice(at), at + text.length);
  }

  function backspaceAtCursor() {
    const cur = inputRef.current;
    const at = Math.max(0, Math.min(cursorRef.current, cur.length));
    if (at <= 0) return;
    setInputAndCursor(cur.slice(0, at - 1) + cur.slice(at), at - 1);
  }

  function deleteAtCursor() {
    const cur = inputRef.current;
    const at = Math.max(0, Math.min(cursorRef.current, cur.length));
    if (at >= cur.length) return;
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

  function setActiveKeyBoth(next: string) {
    activeApiKeyRef.current = next;
    setActiveApiKey(next);
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
    if (id === providerRef.current && activeApiKeyRef.current) {
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
    void discoverSkills({
      projectDir: skillDirs?.projectDir,
      homeDir: skillDirs?.homeDir,
    }).then((found) => {
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
    });
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
      baseURLFor: (id) => getStoredBaseURL(authRef.current, id),
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
    const baseURL = getStoredBaseURL(authRef.current, pickedId);
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
    setActiveKeyBoth(apiKeyValue);
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
    const load = computeContextLoad(
      lastPromptTokensRef.current,
      historyChars(historyRef.current)
    );
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
    const toolsChars = JSON.stringify(TOOL_DEFINITIONS).length;
    const histChars = historyChars(hist);
    const userTurns = hist.filter((m) => m?.role === "user").length;
    const skillLoads = hist.filter(
      (m) =>
        m?.role === "user" &&
        typeof (m as { content?: unknown }).content === "string" &&
        ((m as { content?: unknown }).content as string).includes('[skill "')
    ).length;
    const load = computeContextLoad(lastPromptTokensRef.current, histChars);
    const window = contextWindowFor(modelRef.current);
    const loadLine =
      window !== undefined
        ? `load: ${formatKEst(histChars)} (${Math.round((load / window) * 100)}% of ${(window / 1000).toFixed(0)}K verified window)`
        : `load: ${formatKEst(histChars)} (no verified window — auto-compact off, use /compact manually)`;
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
    return (
      `Context (model ${modelRef.current}):\n` +
      `system: ${formatKEst(sysChars)} (base + AGENTS overlay + env block)\n` +
      `tools: ${TOOL_DEFINITIONS.length} defs, ${formatKEst(toolsChars)}\n` +
      `history: ${hist.length} messages / ${userTurns} user turns, ${formatKEst(histChars)}\n` +
      `skill injections live in history: ${skillLoads}\n` +
      `${cfgLine}\n` +
      `${loadLine} · budget: ${historyMessageBudget()} msgs / ${(historyCharBudget() / 1000).toFixed(0)}K chars`
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
  // turn-scoped grants in skillGrantsRef (unioned). Never throws:
  // loadSkillBody degrades to empty text, surfaced plainly.
  async function activateSkill(info: SkillInfo, opts?: { auto?: boolean }): Promise<void> {
    const auto = opts?.auto === true;
    const loaded = await loadSkillBody(info, auto ? { inlineRefs: false } : undefined);
    if (loaded.text.trim().length === 0) {
      pushInfo(`Skill "${info.name}" has an empty body — nothing loaded.`);
      return;
    }
    for (const t of loaded.info.allowedTools) skillGrantsRef.current.add(t);
    const contextText = auto ? capSkillBodyForAuto(loaded.text, info.dir) : loaded.text;
    historyRef.current.push({
      role: "user",
      content: `[skill "${info.name}" loaded — follow these instructions]\n${contextText}`,
    });
    const grantNote =
      loaded.info.allowedTools.length > 0
        ? ` (tools pre-approved this turn: ${loaded.info.allowedTools.join(", ")})`
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
    const found = await discoverSkills({
      projectDir: skillDirs?.projectDir,
      homeDir: skillDirs?.homeDir,
    });
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

  const SKILL_USAGE =
    "usage: /skill:<name> — invoke a skill directly (list with /skills, e.g. /skill:code-review)";

  // Snapshot the committed session (historyRef + turnsRef + settings refs)
  // to ~/.atom/session.json. Disk errors are ignored (in-memory session
  // still applies). Called only for committed state: completed turns and
  // clean exit — never for rolled-back (failed/cancelled) turns.
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
          turns: turnsRef.current,
        },
        authHome
      );
    } catch {
      // ignore disk errors (in-memory session still applies)
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
    const submitKey =
      keyForProvider(providerRef.current) || activeApiKeyRef.current;
    if (!submitKey) {
      pushInfo(
        `Missing API key for ${providerRef.current} — run /provider to paste one (stored in ~/.atom/auth.json).`
      );
      return false;
    }
    const baseURL = getStoredBaseURL(authRef.current, providerRef.current);
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
          // Only accumulate when the summary actually reported usage;
          // an empty onUsage keeps totals byte-identical.
          if (
            u.prompt_tokens !== undefined ||
            u.completion_tokens !== undefined ||
            u.total_tokens !== undefined
          ) {
            setUsageBoth(next);
          }
        },
      });
      // Atomic swap: build the new history first, then replace.
      const next = buildCompactedHistory(
        systemMsg,
        summary,
        split.tail,
        split.olderTurnCount
      );
      historyRef.current = next;
      appendTurns({ role: "tool", content: compactBoundaryLine(split.olderTurnCount) });
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
    // threshold → streak resets. shouldAutoCompact owns the pct math.
    if (!shouldAutoCompact(load, modelRef.current)) {
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
    const baseURL = getStoredBaseURL(authRef.current, s.provider);
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
    historyRef.current = [...s.history];
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
    truncateHistory(historyRef.current, (msg) => {
      pendingNotices.push({ role: "tool", content: `⚠ ${msg}` });
    });
    // Remount the turns <Static> (same mechanism as /clear and /new): Ink's
    // Static only renders newly appended indices, so restoring a transcript
    // over a non-empty rendered buffer (e.g. the /new boundary line) would
    // misalign and hide the first restored turn(s).
    setClearGen((g) => g + 1);
    setTurnsBoth([
      ...s.turns,
      {
        role: "tool",
        content: `(resumed session from ${s.savedAt}: ${s.turns.length} turns)`,
      },
      ...pendingNotices,
    ]);
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
  const RULE_USAGE =
    "usage: /allow <tool[:glob]> · /deny <tool[:glob]> · /rules · /rules clear (e.g. /allow bash:npm test*, /deny bash:rm *)";
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
  const QUEUE_USAGE =
    "usage: /queue (list) · /queue clear (wipe) · /steer <text> (steer the running turn, or send when idle)";
  const STEER_USAGE =
    "usage: /steer <text> — while busy, injects into the running turn at the next step boundary (the current action finishes first); when idle, sends as a normal turn";
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
        // fresh env block.
        historyRef.current = [{ role: "system", content: withEnvBlock(systemPrompt) }];
        setTurnsBoth([]);
        setClearGen((g) => g + 1);
        setError(null);
        setDraft(null);
        setThinking(null);
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
        // autoDisabled stays for the session (thrash guard is session-wide).
        lastPromptTokensRef.current = undefined;
        setContextLoadBoth(null);
        autoStreakRef.current = 0;
        pendingCompactRef.current = null;
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
        // plus a fresh Task 6 env block.
        historyRef.current = [{ role: "system", content: withEnvBlock(buildSystemPrompt()) }];
        setTurnsBoth([
          {
            role: "tool",
            content: "(new session started — previous conversation kept, /resume to restore it)",
          },
        ]);
        setClearGen((g) => g + 1);
        setError(null);
        setDraft(null);
        setThinking(null);
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
        // Compaction state restarts fresh (unlike /clear, where the thrash
        // guard stays disabled for the session).
        autoStreakRef.current = 0;
        setAutoDisabledBoth(false);
        pendingCompactRef.current = null;
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
      case "/mode":
        if (modeRef.current === "plan") {
          pushInfo("mode: plan (read-only — write/edit/bash blocked with a replan note; /plan to approve + exit)");
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
          pushInfo("(plan mode is read-only — exit plan with /plan before /trust; trust unchanged)");
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
      case "/yolo": {
        // Same deliberate-safety rule as /trust: yolo must not punch through
        // plan mode (and Tab below never enters/exits plan either). The user
        // exits explicitly with /plan.
        if (modeRef.current === "plan") {
          pushInfo("(plan mode is read-only — exit plan with /plan before /yolo; mode unchanged)");
          return;
        }
        const next: PermissionMode = modeRef.current === "normal" ? "yolo" : "normal";
        setModeBoth(next);
        pushInfo(`mode: ${next}`);
        return;
      }
      case "/plan": {
        if (modeRef.current === "plan") {
          // Human approval: typing /plan to exit approves the recorded plan.
          // Always lands in normal (never yolo) so implementation starts
          // under asking permissions; the session checklist recorded while
          // planning survives the switch (todowrite handoff).
          setModeBoth("normal");
          const planned = getTodos().length;
          pushInfo(
            planned > 0
              ? `(plan approved — ${planned} task(s) carry into implementation under normal permissions)`
              : "(plan mode off — no plan recorded)"
          );
          return;
        }
        setModeBoth("plan");
        pushInfo(
          "plan mode: on — explore freely (read/grep/glob/web/todos/ask run free; write/edit/bash are blocked with a replan note). Record the plan with todowrite, then /plan to approve + exit into implementation."
        );
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
    const verdict = checkRules(rulesRef.current, name, args);
    if (verdict === "deny") return "no";
    // Plan mode (ticket 04): read-only. Mutations skip the prompt entirely
    // and flow to guardedExecute, which refuses them pre-execution with a
    // replan-friendly note. Returning "once" here only routes past the prompt
    // — the gate below still blocks, so allow/yolo/trust/always/grants below
    // cannot punch through.
    if (modeRef.current === "plan" && needsApproval(name)) return "once";
    if (verdict === "allow") return "once";
    if (modeRef.current === "yolo") return "once";
    if (trustAllRef.current) return "once";
    if (alwaysAllowedRef.current.has(name)) return "once";
    if (skillGrantsRef.current.has(name)) return "once";
    const signal = turnCancelRef.current?.signal ?? null;
    if (signal?.aborted) throw new LoopCancelledError();
    return new Promise<ApprovalDecision>((resolve, reject) => {
      approvalResolveRef.current = { resolve, reject };
      setPendingApproval({ name, args });
      if (signal) {
        const onAbort = () => {
          const h = approvalResolveRef.current;
          approvalResolveRef.current = null;
          setPendingApproval(null);
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
          `Explore with read/grep/glob/web tools, record the plan with todowrite, then exit plan mode (/plan) to implement.`
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
    // Exact full-command + Enter runs it. A single-token "/name" not in
    // SLASH_NAMES resolves through the skill registry (ticket 03, legacy
    // form — the namespaced `/skill:name` below is canonical); anything
    // else starting with "/" still falls through as a model message.
    if (SLASH_NAMES.has(text)) {
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
    // Missing key: guide to /provider instead of POSTing.
    const submitKey =
      keyForProvider(providerRef.current) || activeApiKeyRef.current;
    if (!submitKey) {
      setError(
        `Missing API key for ${providerRef.current} — run /provider to paste one (stored in ~/.atom/auth.json).`
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setDraft(null);
    setThinking(null);
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
    // so the loop core's own budget check stays a no-op on entry — exactly
    // one dim notice per truncating turn. /clear drops the notice with the
    // transcript (usage totals still survive).
    truncateHistory(
      historyRef.current,
      (msg) => {
        appendTurns({ role: "tool", content: `⚠ ${msg}` });
      },
      { messages: 1, chars: text.length }
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
        const found = await discoverSkills({
          projectDir: skillDirs?.projectDir,
          homeDir: skillDirs?.homeDir,
        });
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
      const baseURL = getStoredBaseURL(authRef.current, providerRef.current);
      const reply = await runAgenticLoopForProvider(
        providerRef.current,
        submitKey,
        modelRef.current,
        historyRef.current,
        {
        approve,
        askUser,
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
          noteTurnActivity();
        },
        onThinking: (partial) => {
          setThinking(partial);
          noteTurnActivity();
        },
        onPhase: (p, detail) => {
          setPhase(p);
          setPhaseDetail(detail ?? "");
          noteTurnActivity();
          if (p === "thinking") {
            // New POST: its thinking (if any) replaces the previous round's.
            setThinking(null);
          } else if (p === "tool" && detail) {
            setToolHint(detail);
          } else if (p === "retry") {
            const msg = detail ? `↻ retrying… ${detail}` : "↻ retrying…";
            appendTurns({ role: "tool", content: msg });
          } else if (p === "done") {
            setToolHint(null);
            flushDraft();
          }
        },
        onToolDelta: (name) => {
          setToolHint(name);
        },
        onUsage: (u) => {
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
          const items: Turn[] = [{ role: "tool", content: label }];
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
          appendTurns(...items);
          noteTurnActivity();
        },
        signal: controller.signal,
      });
      // Turn-end flush: any trailing throttled partial paints before the
      // commit replaces the draft (byte-exact via `reply` regardless).
      flushDraft();
      appendTurns({ role: "assistant", content: reply });
      // The turn committed to history (final text, denial-as-result, or
      // stop-notice) — persist the kill-safe save. Rolled-back turns (catch
      // below) never reach here, so a failure can't clobber the last good save.
      persistSession();
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
      if (cancelled) {
        // One dim line (tool role renders dim); not an error.
        // Rolled back above: no save, the last good save stays intact.
        appendTurns({ role: "tool", content: "(cancelled)" });
      } else {
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
      askResolveRef.current = null;
      setPendingQuestion(null);
      setAskCustomBoth("");
      // Turn-scoped skill grants expire here: armed-while-idle and auto
      // skills cover exactly the turn that just ended (success, failure,
      // or cancel) — the next user message starts clean (ticket 06).
      skillGrantsRef.current = new Set();
      busyRef.current = false;
      setBusy(false);
      try {
        draftThrottleRef.current?.cancel();
      } catch {
        // ignore
      }
      setDraft(null);
      setThinking(null);
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
    // 1. Tool approval prompt (normal mode): y = once, a = always this
    // session, t = trust all write/edit/bash this session, n/Esc = deny
    // (denial feeds back into the loop as a result).
    // Ctrl+C (handled above) cancels the whole turn instead.
    if (pendingApproval) {
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
        if (!draft || kp.validating || busy) return;
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
            // else stored — the section only renders for keyed providers) and
            // keep the picked model; the live refresh lands in the background
            // via the standard switch path. reasoning_effort is zen-only, so
            // a non-Default effort warns (kept, not sent).
            const switchedKey = keyForProvider(picked.providerId);
            if (switchedKey) {
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
        if (name) setInputBoth(`/skill:${name}`);
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
    // highlighted entry, Esc dismisses back to plain input.
    const cur = inputRef.current;
    const menu =
      !slashDismissedRef.current && cur.startsWith("/")
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
        // /compact is allowed while busy (sets the pending flag for turn-end
        // drain); /queue + /steer are the busy-management commands (list-only
        // reads and steering — never touch the running turn's state), so the
        // menu runs them while busy too. Every other entry still waits idle.
        const busyOk =
          pick.name === "/compact" || pick.name === "/queue" || pick.name === "/steer";
        if (pick && (busyOk || !busyRef.current)) {
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
    // 5. Plain input. Tab toggles normal<->yolo here; when the "/" slash
    // menu is open (section 4 above) Tab instead runs the highlighted
    // command and never reaches this branch.
    if (key.leftArrow) {
      setCursorBoth(cursorRef.current - 1);
    } else if (key.rightArrow) {
      setCursorBoth(cursorRef.current + 1);
    } else if (key.home) {
      setCursorBoth(0);
    } else if (key.end) {
      setCursorBoth(inputRef.current.length);
    } else if (key.return) {
      void submit(inputRef.current);
    } else if (key.tab) {
      // Tab toggles normal<->yolo only (pinned by tests/status.test.tsx): it
      // never enters or exits plan mode, so a stray keypress can't drop the
      // deliberate safety mode — use /plan. Silent no-op in plan (the status
      // line already shows mode: plan).
      if (modeRef.current !== "plan") {
        const next: PermissionMode = modeRef.current === "normal" ? "yolo" : "normal";
        setModeBoth(next);
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

  const phaseLabel =
    phase === "thinking" || phase === "idle"
      ? "thinking…"
      : phase === "streaming"
        ? "streaming…"
        : phase === "tool"
          ? phaseDetail
            ? `calling ${phaseDetail}…`
            : "tool…"
          : phase === "retry"
            ? phaseDetail
              ? `retrying… ${phaseDetail}`
              : "retrying…"
            : phase === "done"
              ? "done"
              : "thinking…";

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
    input.startsWith("/")
      ? buildSlashMenu(input, skillMenu)
      : { items: [], moreSkills: 0 };
  const filteredSlash = slashMenu.items;
  const slashVisible = filteredSlash.length > 0;
  const slashHighlight =
    filteredSlash.length > 0 ? filteredSlash[slashIndex % filteredSlash.length]?.name : undefined;
  const slashHasSkills = filteredSlash.some((c) => c.skill !== undefined);

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

  return (
    <Box flexDirection="column">
      {/* Committed scrollback: banner art (once) + history/tool/warning lines.
          There is no persistent header block: the footer status line below is
          the sole info bar. TranscriptView is memoized so the 1s elapsed
          timer tick never re-renders the Static subtree. */}
      <TranscriptView turns={turns} clearGen={clearGen} />
      {/* Live tail: empty hint + streaming draft + tool hint stay dynamic */}
      <Box flexDirection="column" marginY={1}>
        {turns.length === 0 ? (
          <Text dimColor>Say hi to Atom — or type / for commands, /provider to pick a provider + key, /model to switch models.</Text>
        ) : null}
        {sessionHint && turns.length === 0 ? (
          <Text dimColor>(last session available — /resume to restore)</Text>
        ) : null}
        {draft ? (
          <Text>
            <Text color="magenta" bold>
              ATOM&gt;{" "}
            </Text>
            {draft}
            <Text color="gray">▍</Text>
          </Text>
        ) : null}
        {thinking ? (
          <Text dimColor>
            💭 {thinking}
            <Text color="gray">▍</Text>
          </Text>
        ) : null}
        {busy && toolHint ? <Text dimColor>◌ calling {toolHint}…</Text> : null}
      </Box>
      {error ? <Text color="red">error&gt; {error}</Text> : null}
      {pendingApproval ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
        >
          <Text bold>Atom permission — allow this tool?</Text>
          <Text>{describeToolCall(pendingApproval.name, pendingApproval.args)}</Text>
          <Text>
            [y]es once · [a]lways allow {pendingApproval.name} this session · [t]rust all write/edit/bash this session · [n]o (Esc = no)
          </Text>
        </Box>
      ) : null}
      {pendingQuestion ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="magenta"
          paddingX={1}
        >
          <Text bold>Atom question — {pendingQuestion.question}</Text>
          {pendingQuestion.options.map((o, i) => (
            <Text key={`${o}-${i}`} color={i === askSelIndex ? "magenta" : undefined}>
              {i === askSelIndex ? "❯ " : "  "}
              {o}
            </Text>
          ))}
          {pendingQuestion.allowCustom ? (
            <Text dimColor>
              Type a custom answer + Enter to send it
              {askCustom ? `: ${askCustom}` : ""} · ↑/↓ + Enter picks · Esc cancels
            </Text>
          ) : (
            <Text dimColor>↑/↓ + Enter to pick · Esc cancels</Text>
          )}
        </Box>
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
      {selecting ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
        >
          <Text bold>{modelTitle}</Text>
          {modelWin.start > 0 ? <Text dimColor>↑ {modelWin.start} more</Text> : null}
          {modelEntries.slice(modelWin.start, modelWin.end).map((e, k) => {
            const i = modelWin.start + k;
            const showHeader =
              i === 0 || modelEntries[i - 1]?.providerId !== e.providerId;
            const def = getProvider(e.providerId);
            return (
              <React.Fragment key={`${e.providerId}-${e.model}-${i}`}>
                {showHeader ? (
                  <Text dimColor>
                    — {def?.name ?? e.providerId}
                    {e.providerId === provider ? " (current)" : ""}
                  </Text>
                ) : null}
                <Text color={i === modelHi ? "green" : undefined}>
                  {i === modelHi ? "❯ " : "  "}
                  {e.model}
                  {e.providerId === provider && e.model === model ? " (current)" : ""}
                </Text>
              </React.Fragment>
            );
          })}
          {modelWin.end < modelEntries.length ? (
            <Text dimColor>↓ {modelEntries.length - modelWin.end} more</Text>
          ) : null}
          {modelEntries.length === 0 ? (
            <Text dimColor>No models match — backspace to widen the filter.</Text>
          ) : null}
        </Box>
      ) : selectingSkills ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
        >
          <Text bold>{skillTitle}</Text>
          {skillWin.start > 0 ? <Text dimColor>↑ {skillWin.start} more</Text> : null}
          {skillEntries.slice(skillWin.start, skillWin.end).map((e, k) => {
            const i = skillWin.start + k;
            return (
              <Text key={`${e.name}-${i}`} color={i === skillHi ? "green" : undefined}>
                {i === skillHi ? "❯ " : "  "}
                /skill:{e.name}
                {!e.userInvocable ? <Text dimColor> [auto-only]</Text> : null}
              </Text>
            );
          })}
          {skillWin.end < skillEntries.length ? (
            <Text dimColor>↓ {skillEntries.length - skillWin.end} more</Text>
          ) : null}
          {skillEntries.length === 0 ? (
            <Text dimColor>
              {skillEntriesAll.length === 0
                ? "No skills installed — add SKILL.md skills under .claude/skills/, .agents/skills/, or the ~/. counterparts."
                : "No skills match — backspace to widen the filter."}
            </Text>
          ) : null}
        </Box>
      ) : selectingProvider ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
        >
          <Text bold>Atom — Select provider (up/down + Enter, Esc cancels):</Text>
          {PROVIDERS.map((p, i) => {
            const has = keyForProvider(p.id).length > 0;
            return (
              <Text key={p.id} color={i === providerIndex ? "green" : undefined}>
                {i === providerIndex ? "❯ " : "  "}
                {p.name} ({p.id}) {has ? "✓ key" : "— no key"}
                {p.id === provider ? " (current)" : ""}
              </Text>
            );
          })}
        </Box>
      ) : keyPrompt ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
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
          <Text>
            key: {"•".repeat(keyPrompt.draft.length)}
            <Text color="gray">█</Text>
          </Text>
          {keyPrompt.validating ? <Text dimColor>validating…</Text> : null}
          {keyPrompt.error ? <Text color="red">{keyPrompt.error}</Text> : null}
        </Box>
      ) : baseURLPrompt ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
        >
          <Text bold>
            Atom — baseURL for openai-compatible (http(s) URL + Enter, Esc cancels):
          </Text>
          <Text>
            baseURL: {baseURLPrompt.draft}
            <Text color="gray">█</Text>
          </Text>
          {baseURLPrompt.error ? <Text color="red">{baseURLPrompt.error}</Text> : null}
        </Box>
      ) : selectingEffort ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
        >
          <Text bold>Atom — Select reasoning effort (up/down + Enter, Esc cancels):</Text>
          {EFFORT_OPTIONS.map((o, i) => (
            <Text key={`${o}-${i}`} color={i === effortIndex ? "green" : undefined}>
              {i === effortIndex ? "❯ " : "  "}
              {o === "default" ? "Default" : o === "max" ? "Max" : o[0]?.toUpperCase() + o.slice(1)}
              {o === effort ? " (current)" : ""}
            </Text>
          ))}
          <Text dimColor>Top is Max (sent as max); xhigh is not a verified value.</Text>
        </Box>
      ) : selectingRewind ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
        >
          <Text bold>Atom — Rewind to checkpoint (up/down + Enter, Esc cancels):</Text>
          {listCheckpoints().map((c, i) => (
            <Text key={c.id} color={i === rewindIndex ? "green" : undefined}>
              {i === rewindIndex ? "❯ " : "  "}#{c.seq} · {c.label} · {c.files.length} file(s)
            </Text>
          ))}
          <Text dimColor>Restores exact bytes (hash-verified). Shell side effects (bash) are never snapshotted and cannot be undone.</Text>
        </Box>
      ) : selectingRewindScope ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
        >
          <Text bold>Atom — Rewind scope (up/down + Enter, Esc cancels):</Text>
          {REWIND_SCOPES.map((s, i) => (
            <Text key={s} color={i === rewindScopeIndex ? "green" : undefined}>
              {i === rewindScopeIndex ? "❯ " : "  "}
              {s}
            </Text>
          ))}
          <Text dimColor>Shell side effects (bash) are explicitly out of scope and cannot be undone.</Text>
        </Box>
      ) : (
        // The input is the one boxed, prominent surface (see the memoized
        // InputBox above): a quiet gray frame sets it apart from the
        // transcript above and the status line below. Pickers and modals
        // replace it (never stack with it), each carrying their own semantic
        // border color.
        <InputBox input={input} cursor={cursor} />
      )}
      {slashVisible ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
        >
          <Text bold>
            {slashHasSkills
              ? "Atom commands + skills (↑/↓ + Enter/Tab to run, Esc dismisses):"
              : "Atom commands (↑/↓ + Enter/Tab to run, Esc dismisses):"}
          </Text>
          {filteredSlash.map((c) => (
            <Text key={c.name} color={c.name === slashHighlight ? "cyan" : undefined}>
              {c.name === slashHighlight ? "❯ " : "  "}
              {c.name}
              {c.description ? ` — ${c.description}` : ""}
            </Text>
          ))}
          {slashMenu.moreSkills > 0 ? (
            <Text dimColor>
              …and {slashMenu.moreSkills} more skill{slashMenu.moreSkills === 1 ? "" : "s"} — keep typing to narrow
            </Text>
          ) : null}
        </Box>
      ) : null}
      {/* sole info bar: provider · model · token · reasoning · mode (+ live phase/elapsed/waiting while busy).
          One inline paragraph (nested Texts) so narrow terminals wrap at word
          boundaries instead of splitting styled segments across lines. */}
      <Box marginTop={1}>
        <Text dimColor>
          provider: {provider} · model: {model} · {formatTokens(usageTotals, model, contextLoad)} · reasoning:{" "}
          {reasoningDisplay} · mode: {mode}
          {/* +trust is latent in plan mode (trust cannot auto-approve while
              read-only), so it is hidden there to avoid implying approval. */}
          {trustAll && mode !== "plan" ? "+trust" : null}
          {busy ? <Text color="yellow"> · {phaseLabel} {elapsedSecs}s · esc stops</Text> : null}
          {busy && stalled ? " · waiting…" : null}
        </Text>
      </Box>
    </Box>
  );
}
