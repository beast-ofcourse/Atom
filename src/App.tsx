// Ink (React) TUI for the minimal Atom chatbot.
// Hand-rolled input + dropdowns via useInput (no extra deps).
import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import {
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  LoopCancelledError,
  REASONING_EFFORT_SUPPORTED_MODELS,
  buildSystemPrompt,
  fetchModelsForProviderWithStatus,
  fetchModelsWithStatus,
  historyChars,
  isEffortSupported,
  runAgenticLoopForProvider,
  truncateHistory,
  type ApprovalDecision,
  type ChatMessage,
  type PermissionMode,
  type Phase,
  type ReasoningEffort,
  type Usage,
} from "./zen.js";
import { TOOL_ONE_LINERS, clearTodos, describeToolCall, getTodos, type TodoItem } from "./tools.js";
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
import {
  loadSession,
  saveSession,
  sessionExists,
} from "./session.js";

export type Turn = {
  role: "user" | "assistant" | "tool";
  content: string;
  error?: boolean;
};

export type AppProps = {
  apiKey: string;
  endpoint: string;
  initialModel: string;
  // Provided by tests to skip the live model fetch; otherwise the app tries
  // the live list on mount (curated fallback on any failure).
  initialModels?: string[];
  initialProvider?: ProviderId;
  // Home dir override for ~/.atom/auth.json (tests use a temp dir via
  // ATOM_HOME/HOME env or this prop).
  authHome?: string;
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
  { name: "/mode", description: "Print the current permission mode." },
  { name: "/yolo", description: "Toggle yolo mode (tools run without asking). Tab toggles too." },
  { name: "/clear", description: "Clear the conversation history (keeps session token totals)." },
  { name: "/new", description: "Start a brand-new session (full fresh conversation + counters reset, previous kept for /resume)." },
  { name: "/compact", description: "Summarize older turns into one summary (optional focus text: /compact focus…)." },
  { name: "/resume", description: "Restore the last saved session (turns, history, settings, usage)." },
  { name: "/help", description: "List commands with one-liners." },
  { name: "/exit", description: "Exit Atom." },
  { name: "/quit", description: "Exit Atom." },
];

const SLASH_NAMES = new Set(SLASH_COMMANDS.map((c) => c.name));

export function filterSlashCommands(prefix: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
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
  if (t.role === "user") {
    return (
      <Text key={i}>
        <Text color="cyan" bold>
          you&gt;{" "}
        </Text>
        {t.content}
      </Text>
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
    <Text key={i}>
      <Text color="magenta" bold>
        ATOM&gt;{" "}
      </Text>
      {t.content}
    </Text>
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

function toolsListText(): string {
  const lines = Object.entries(TOOL_ONE_LINERS).map(([n, d]) => `${n} — ${d}`);
  return `Tools (${lines.length}):\n${lines.join("\n")}`;
}

// Display window for the live thinking block: reasoning streams can run
// long, so only the frontier (tail) paints. The full text is never stored
// anywhere else — thinking stays transient, like the answer draft.
const THINKING_DISPLAY_CAP = 1200;

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

function helpListText(): string {
  const lines = SLASH_COMMANDS.map((c) => `${c.name} — ${c.description}`);
  return (
    `Commands:\n${lines.join("\n")}` +
    `\nTab toggles normal/yolo mode (in the / command menu, Tab runs the highlighted command).` +
    `\nToken totals accumulate per session from API-reported usage only: the status line shows \`token: n/a\` until the API reports usage (never estimated, never 0-by-default); with usage it shows \`token: (P%) NK\` — NK is the cumulative session spend in K, P% is the CURRENT context load over the model's verified window (last POST prompt_tokens, else the 4ch/token estimate; models with no verified window show a bare \`token: NK\`, never an invented percent). /clear keeps the totals; /new resets them.` +
    `\n/compact [focus text]: summarize older turns into one \`[Compacted context …]\` summary + keep the newest tail (~8000 estimated tokens, tool outputs capped at 2000 chars). Tiny history (≤1 user turn) reports \`(nothing to compact)\`. Works for unknown-window models (estimate only for the tail split).` +
    `\nAuto-compact: after every completed turn the load is checked; on known-window models with load/window ≥ ${Math.round(COMPACT_PCT_DEFAULT * 100)}% (env ATOM_COMPACT_PCT percent, clamped 50–95, invalid→default) history auto-compacts before the next turn. Unknown-window models never auto-compact — use /compact manually.` +
    `\nThrash guard: 3 auto-compactions without the load dropping below threshold disables auto for the session with \`(auto-compact thrashing — disabled, use /compact or /clear)\`; manual /compact still works and resets the counter on success.` +
    `\n/provider: pick opencode-zen|openai|anthropic|deepseek|mistral|google-gemini|openai-compatible, paste a key once (stored in ~/.atom/auth.json, env wins). Switching provider keeps session history text; system prompt stays.` +
    `\n/effort options: Default/Low/Medium/High/Max (wire: default/low/medium/high/max; Default omits reasoning_effort).` +
    `\nNote: xhigh was requested but only Max is verified, so the top setting is Max, sent as max.` +
    `\nGating: reasoning_effort is sent ONLY when effort != Default AND the model is one of ${[...REASONING_EFFORT_SUPPORTED_MODELS].join(", ")} AND the provider is opencode-zen; otherwise omitted (setting kept, warning shown, status shows (unsupported)). Effort persists across /model switches.` +
    `\n/resume: restores the last saved session (turns, history, provider/model/effort/mode, usage totals). Startup never auto-restores — sending a message without /resume starts fresh, and the next completed turn overwrites the save. /clear clears the live session only (the save keeps the pre-clear state until the next completed turn overwrites it). /new saves first, then starts a brand-new session (conversation + counters reset, settings kept) — so /resume right after /new restores the pre-/new conversation. Split: /clear = wipe transcript, keep counters; /new = full fresh conversation + counters reset, previous kept for /resume.` +
    `\nSession autosave: every completed turn (and clean exit, plus after each successful compaction) writes ~/.atom/session.json (0600 POSIX, may contain pasted secrets — never commit it); failed/cancelled turns never touch it; a corrupt save loads as "(saved session unreadable — starting fresh)".` +
    `\nBusy status shows the live phase plus elapsed seconds in the status line (· thinking… 4s); >3s without token/tool/phase activity adds a dim waiting… hint (status-bar only, never saved). ` +
    `Reasoning streams in its own dim block above the answer draft while busy (transient — never committed); Esc stops a running response (same rollback as Ctrl+C).`
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

export function App({ apiKey, endpoint, initialModel, initialModels, initialProvider, authHome, now, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn }: AppProps) {
  const { exit } = useApp();
  const [model, setModel] = useState(initialModel);
  const modelRef = useRef(initialModel);
  const [models, setModels] = useState<string[]>(
    initialModels ?? [...FALLBACK_MODELS]
  );
  // Active provider (default opencode-zen for backward compat).
  const [provider, setProvider] = useState<ProviderId>(
    initialProvider && isProviderId(initialProvider) ? initialProvider : DEFAULT_PROVIDER
  );
  const providerRef = useRef<ProviderId>(
    initialProvider && isProviderId(initialProvider) ? initialProvider : DEFAULT_PROVIDER
  );
  // Auth store (env wins at resolve time; file holds pasted keys).
  const [auth, setAuth] = useState<AuthFile>(() => loadAuth(authHome));
  const authRef = useRef<AuthFile>(auth);
  // Resolved keys/endpoints per active provider. apiKey/endpoint props seed
  // the zen defaults (tests pass test-key; prod passes env-resolved values).
  const [activeApiKey, setActiveApiKey] = useState(apiKey);
  const activeApiKeyRef = useRef(apiKey);
  const [activeEndpoint, setActiveEndpoint] = useState(endpoint);
  // Permission mode (normal default, yolo toggled via /yolo). The footer
  // status line always shows it; modeRef mirrors it for async loop callbacks.
  const [mode, setMode] = useState<PermissionMode>("normal");
  const modeRef = useRef<PermissionMode>("normal");
  // Tools the user approved with "always" this session (never re-prompt).
  const alwaysAllowedRef = useRef<Set<string>>(new Set());
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
  // Reasoning-effort picker (/effort): same pattern as the /model picker
  // (↑/↓ + Enter, Esc cancels). Session state, default Default.
  const [selectingEffort, setSelectingEffort] = useState(false);
  const [effortIndex, setEffortIndex] = useState(0);
  const effortIndexRef = useRef(0);
  const [effort, setEffort] = useState<ReasoningEffort>("default");
  const effortRef = useRef<ReasoningEffort>("default");
  // /provider picker + key/baseURL prompts (same keyboard pattern).
  const [selectingProvider, setSelectingProvider] = useState(false);
  const [providerIndex, setProviderIndex] = useState(0);
  const providerIndexRef = useRef(0);
  const [keyPrompt, setKeyPrompt] = useState<ProviderKeyPrompt | null>(null);
  const keyPromptRef = useRef<ProviderKeyPrompt | null>(null);
  const [baseURLPrompt, setBaseURLPrompt] = useState<ProviderBaseURLPrompt | null>(null);
  const baseURLPromptRef = useRef<ProviderBaseURLPrompt | null>(null);
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
  // as a dim line while the transcript is empty; startup never auto-restores.
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
    { role: "system", content: systemPrompt },
  ]);

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

  // No leaked handles: clear the turn timer on unmount.
  useEffect(() => {
    return () => {
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

  function setInputAndCursor(next: string, cursorPos: number) {
    inputRef.current = next;
    setInput(next);
    const clamped = Math.max(0, Math.min(cursorPos, next.length));
    cursorRef.current = clamped;
    setCursor(clamped);
    // Any edit restarts menu filtering from the top and re-opens the menu.
    slashIndexRef.current = 0;
    setSlashIndex(0);
    slashDismissedRef.current = false;
    setSlashDismissed(false);
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
    setSelectingEffort(false);
    setSelectingProvider(false);
    setKeyPromptBoth(null);
    setBaseURLPromptBoth(null);
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
  // when available. Keep current model if valid else provider default.
  async function switchProviderWithKey(
    pickedId: ProviderId,
    apiKeyValue: string
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
    const nextModel = list.includes(modelRef.current)
      ? modelRef.current
      : def.defaultModel;
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

  function runSlashCommand(cmd: string) {
    setInputBoth("");
    switch (cmd) {
      case "/exit":
      case "/quit":
        persistSession();
        exit();
        return;
      case "/clear":
        historyRef.current = [{ role: "system", content: systemPrompt }];
        setTurnsBoth([]);
        setClearGen((g) => g + 1);
        setError(null);
        setDraft(null);
        setThinking(null);
        setToolHint(null);
        setPhase("idle");
        setPhaseDetail("");
        // /clear drops the transcript: load resets (no context), streak
        // resets, pending compact drains. usageTotals + effort intentionally
        // kept: token totals and effort are per-session (see /help).
        // autoDisabled stays for the session (thrash guard is session-wide).
        lastPromptTokensRef.current = undefined;
        setContextLoadBoth(null);
        autoStreakRef.current = 0;
        pendingCompactRef.current = null;
        return;
      case "/new":
        // Claude-Code semantics: end the current conversation and start
        // fresh in the same process while the old one stays restorable via
        // /resume. Save FIRST (the pre-/new conversation is what /resume
        // restores — same path/format as every completed turn, no new
        // schema). No sessions/ archive step: session.ts only has
        // session.json, so no archiving is invented here.
        persistSession();
        // Fresh system re-read (system.ts base + current AGENTS.md overlay).
        historyRef.current = [{ role: "system", content: buildSystemPrompt() }];
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
        // Compaction state restarts fresh (unlike /clear, where the thrash
        // guard stays disabled for the session).
        autoStreakRef.current = 0;
        setAutoDisabledBoth(false);
        pendingCompactRef.current = null;
        return;
      case "/compact":
        // Bare /compact with no focus text (slash-menu path). Free-text
        // "/compact focus…" is handled in submit (prefix match) so focus
        // text survives; both funnel to the same busy/pending logic below.
        void runCompactCommand("");
        return;
      case "/model":
        setSelIndexBoth(Math.max(0, models.indexOf(model)));
        setSelecting(true);
        setSelectingEffort(false);
        setSelectingProvider(false);
        setKeyPromptBoth(null);
        setBaseURLPromptBoth(null);
        return;
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
      case "/mode":
        pushInfo(`mode: ${modeRef.current}`);
        return;
      case "/yolo": {
        const next: PermissionMode = modeRef.current === "normal" ? "yolo" : "normal";
        setModeBoth(next);
        pushInfo(`mode: ${next}`);
        return;
      }
      case "/help":
        pushInfo(helpListText());
        return;
      case "/resume":
        doResume();
        return;
      default:
        return;
    }
  }

  // approve hook for runAgenticLoop: yolo and always-allowed tools run
  // without prompting; otherwise an Ink y/a/n prompt resolves the promise.
  // The promise also rejects with LoopCancelledError when the turn is
  // cancelled (Ctrl+C aborts the controller), so a cancel unblocks the loop
  // as a whole-turn cancel — never as a one-call denial.
  async function approve(name: string, args: Record<string, unknown>): Promise<ApprovalDecision> {
    if (turnCancelRef.current?.signal.aborted) throw new LoopCancelledError();
    if (modeRef.current === "yolo") return "once";
    if (alwaysAllowedRef.current.has(name)) return "once";
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
    if (!text || busyRef.current) return;
    // Exact full-command + Enter runs it (unknown "/..." falls through as
    // a normal message to the model).
    if (SLASH_NAMES.has(text)) {
      runSlashCommand(text);
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
    // History budget at turn start, BEFORE the push + rollbackTo capture
    // below (so the existing splice-rollback indices stay valid): drop
    // oldest user-turns first, reserving room for the incoming user message
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
    // Turn boundary: on POST failure (HTTP/network/empty/truncated) the
    // whole user turn (user message plus any partial assistant/tool loop
    // entries) is removed, so the next request starts clean — same
    // guarantee as the old single-pop. The streaming draft lives outside
    // `turns` until commit, so rollback just clears it (see catch).
    // Cancellation (LoopCancelledError) shares the same splice contract.
    const rollbackTo = historyRef.current.length;
    const controller = new AbortController();
    turnCancelRef.current = controller;
    historyRef.current.push({ role: "user", content: text });
    appendTurns({ role: "user", content: text });
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
    // session, n/Esc = deny (denial feeds back into the loop as a result).
    // Ctrl+C (handled above) cancels the whole turn instead.
    if (pendingApproval) {
      const k = (ch ?? "").toLowerCase();
      if (k === "y") resolveApproval("once");
      else if (k === "a") resolveApproval("always");
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
    // 3. Model picker (opening it replaces/closes the slash menu; Esc
    // returns to plain input, never to the slash menu).
    if (selecting) {
      if (key.upArrow) {
        setSelIndexBoth(
          (selIndexRef.current - 1 + models.length) % models.length
        );
      } else if (key.downArrow) {
        setSelIndexBoth((selIndexRef.current + 1) % models.length);
      } else if (key.escape) {
        setSelecting(false);
      } else if (key.return) {
        const picked = models[selIndexRef.current];
        if (picked) {
          setModelBoth(picked);
          // Model switch resets the load latch (different tokenizer: the old
          // reported prompt_tokens no longer measures this context); the
          // estimate applies until the new model reports.
          resetContextLoadToEstimate();
          // Re-gate effort on every /model switch: setting persists, but a
          // non-Default effort on an unsupported model warns (kept, not sent).
          if (effortRef.current !== "default" && !isEffortSupported(picked)) {
            warnEffortUnsupported(picked);
          }
        }
        setSelecting(false);
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
    // 4. "/" slash menu (filter-as-you-type): ↑/↓ + Enter/Tab runs the
    // highlighted command, Esc dismisses back to plain input.
    const cur = inputRef.current;
    const matches = !slashDismissedRef.current && cur.startsWith("/")
      ? filterSlashCommands(cur)
      : [];
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
        // drain); every other command still waits for idle.
        if (pick && (pick.name === "/compact" || !busyRef.current)) {
          if (pick.name === "/compact" && inputRef.current.startsWith("/compact ")) {
            // Preserve free-text focus when the menu is open on a prefix.
            const focus = inputRef.current.slice("/compact".length).trim();
            setInputBoth("");
            void runCompactCommand(focus);
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
      const next: PermissionMode = modeRef.current === "normal" ? "yolo" : "normal";
      setModeBoth(next);
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

  // Slash menu derived for render (mirrors the useInput computation above).
  const filteredSlash =
    !selecting &&
    !selectingEffort &&
    !selectingProvider &&
    !keyPrompt &&
    !baseURLPrompt &&
    !pendingApproval &&
    !pendingQuestion &&
    !slashDismissed &&
    input.startsWith("/")
      ? filterSlashCommands(input)
      : [];
  const slashVisible = filteredSlash.length > 0;
  const slashHighlight =
    filteredSlash.length > 0 ? filteredSlash[slashIndex % filteredSlash.length]?.name : undefined;

  // Cursor block renders AT the cursor offset (defensive clamp: the ref is
  // the source of truth mid-tick and always stays in range via setCursorBoth,
  // but state may lag it by one render).
  const safeCursor = Math.max(0, Math.min(cursor, input.length));

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
            💭 {thinking.length > THINKING_DISPLAY_CAP ? "…" + thinking.slice(-THINKING_DISPLAY_CAP) : thinking}
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
            [y]es once · [a]lways allow {pendingApproval.name} this session · [n]o (Esc = no)
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
      {/* subtle divider between the transcript and the input zone */}
      <Box borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray" marginTop={1} />
      {/* live session checklist (hidden when empty) */}
      <TodoPanel items={todoSnap} />
      {selecting ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
        >
          <Text bold>Atom — Select model (up/down + Enter, Esc cancels):</Text>
          {models.map((m, i) => (
            <Text key={`${m}-${i}`} color={i === selIndex ? "green" : undefined}>
              {i === selIndex ? "❯ " : "  "}
              {m}
              {m === model ? " (current)" : ""}
            </Text>
          ))}
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
      ) : (
        <Box>
          <Text color="cyan" bold>
            ›{" "}
          </Text>
          <Text>
            {input.slice(0, safeCursor)}
            <Text color="gray">█</Text>
            {input.slice(safeCursor)}
          </Text>
        </Box>
      )}
      {slashVisible ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
        >
          <Text bold>Atom commands (↑/↓ + Enter/Tab to run, Esc dismisses):</Text>
          {filteredSlash.map((c) => (
            <Text key={c.name} color={c.name === slashHighlight ? "cyan" : undefined}>
              {c.name === slashHighlight ? "❯ " : "  "}
              {c.name} — {c.description}
            </Text>
          ))}
        </Box>
      ) : null}
      {/* sole info bar: provider · model · token · reasoning · mode (+ live phase/elapsed/waiting while busy).
          One inline paragraph (nested Texts) so narrow terminals wrap at word
          boundaries instead of splitting styled segments across lines. */}
      <Box marginTop={1}>
        <Text dimColor>
          provider: {provider} · model: {model} · {formatTokens(usageTotals, model, contextLoad)} · reasoning:{" "}
          {reasoningDisplay} · mode: {mode}
          {busy ? <Text color="yellow"> · {phaseLabel} {elapsedSecs}s · esc stops</Text> : null}
          {busy && stalled ? " · waiting…" : null}
        </Text>
      </Box>
    </Box>
  );
}
