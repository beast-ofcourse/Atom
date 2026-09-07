// Ink (React) TUI for the minimal Atom chatbot.
// Hand-rolled input + dropdowns via useInput (no extra deps).
import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import {
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  REASONING_EFFORT_SUPPORTED_MODELS,
  buildSystemPrompt,
  fetchModels,
  isEffortSupported,
  runAgenticLoop,
  type ApprovalDecision,
  type ChatMessage,
  type PermissionMode,
  type Phase,
  type ReasoningEffort,
  type Usage,
} from "./zen.js";
import { TOOL_ONE_LINERS, describeToolCall } from "./tools.js";

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
};

export type SlashCommand = { name: string; description: string };

// Single registry for the "/" autocomplete menu and the exact-command path.
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/model", description: "Open the model picker." },
  {
    name: "/effort",
    description:
      "Open the reasoning-effort picker (Default/Low/Medium/High/Max; top is Max, sent as max).",
  },
  { name: "/tools", description: "List the 7 tools with one-line descriptions." },
  { name: "/mode", description: "Print the current permission mode." },
  { name: "/yolo", description: "Toggle yolo mode (tools run without asking). Tab toggles too." },
  { name: "/clear", description: "Clear the conversation history (keeps session token totals)." },
  { name: "/help", description: "List commands with one-liners." },
  { name: "/exit", description: "Exit Atom." },
  { name: "/quit", description: "Exit Atom." },
];

const SLASH_NAMES = new Set(SLASH_COMMANDS.map((c) => c.name));

export function filterSlashCommands(prefix: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

function toolsListText(): string {
  const lines = Object.entries(TOOL_ONE_LINERS).map(([n, d]) => `${n} — ${d}`);
  return `Tools (${lines.length}):\n${lines.join("\n")}`;
}

function helpListText(): string {
  const lines = SLASH_COMMANDS.map((c) => `${c.name} — ${c.description}`);
  return (
    `Commands:\n${lines.join("\n")}` +
    `\nTab toggles normal/yolo mode (in the / command menu, Tab runs the highlighted command).` +
    `\nToken totals accumulate per session from API-reported usage only; tokens show n/a until the API reports usage, and /clear keeps the totals.` +
    `\n/effort options: Default/Low/Medium/High/Max (wire: default/low/medium/high/max; Default omits reasoning_effort).` +
    `\nNote: xhigh was requested but only Max is verified, so the top setting is Max, sent as max.` +
    `\nGating: reasoning_effort is sent ONLY when effort != Default AND the model is one of ${[...REASONING_EFFORT_SUPPORTED_MODELS].join(", ")}; otherwise omitted (setting kept, warning shown, status shows (unsupported)). Effort persists across /model switches.`
  );
}

// Session token totals, accumulated ONLY from usage payloads the API
// actually reported. Null until the first usage payload arrives (rendered
// as `tokens: n/a` — never 0, which would imply measurement).
function formatTokens(usage: Usage | null): string {
  if (!usage) return "tokens: n/a";
  const parts: string[] = [];
  if (usage.prompt_tokens !== undefined) parts.push(`in ${usage.prompt_tokens}`);
  if (usage.completion_tokens !== undefined) parts.push(`out ${usage.completion_tokens}`);
  if (usage.total_tokens !== undefined) parts.push(`total ${usage.total_tokens}`);
  return parts.length > 0 ? `tokens: ${parts.join(" / ")}` : "tokens: n/a";
}

// Startup banner: rendered once at launch inside <Static> (scrollback, so
// it scrolls away naturally). FIGlet "ANSI Shadow" ATOM (Unicode
// box-drawing — needs a monospace font with box-drawing support, which
// Windows Terminal / ConHost / most terminals have).
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
      <Text dimColor>Atom · minimal Zen chatbot — chat/completions models only.</Text>
      <Text dimColor>
        Tab toggles mode · / commands · /model switch · /effort reasoning
      </Text>
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
      <Text dimColor>Then run `npm start` again.</Text>
    </Box>
  );
}

export function App({ apiKey, endpoint, initialModel, initialModels }: AppProps) {
  const { exit } = useApp();
  const [model, setModel] = useState(initialModel);
  const [models, setModels] = useState<string[]>(
    initialModels ?? [...FALLBACK_MODELS]
  );
  // Permission mode (normal default, yolo toggled via /yolo). The header
  // always shows it; modeRef mirrors it for async loop callbacks.
  const [mode, setMode] = useState<PermissionMode>("normal");
  const modeRef = useRef<PermissionMode>("normal");
  // Tools the user approved with "always" this session (never re-prompt).
  const alwaysAllowedRef = useRef<Set<string>>(new Set());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  // Mirror of `input` updated synchronously: keypresses arriving in the same
  // tick share one render closure, so the ref (not state) is the source of
  // truth when Enter is handled.
  const inputRef = useRef("");
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
  // the resolver until the user presses y/a/n.
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const approvalResolveRef = useRef<((d: ApprovalDecision) => void) | null>(null);
  // ask_question modal: the loop waits until the user picks, types a custom
  // answer (allowCustom), or cancels with Esc.
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
  const [error, setError] = useState<string | null>(null);
  // Session token totals from real API usage payloads only (null = none
  // reported yet -> `tokens: n/a`). Survives /clear by design (see /help).
  const [usageTotals, setUsageTotals] = useState<Usage | null>(null);
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
  const [phase, setPhase] = useState<Phase | "idle">("idle");
  const [phaseDetail, setPhaseDetail] = useState("");
  const [toolHint, setToolHint] = useState<string | null>(null);
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
  useEffect(() => {
    if (initialModels) return;
    let cancelled = false;
    void fetchModels(endpoint, apiKey).then((list) => {
      if (!cancelled) setModels(list);
    });
    return () => {
      cancelled = true;
    };
  }, [endpoint, apiKey, initialModels]);

  function setInputBoth(next: string) {
    inputRef.current = next;
    setInput(next);
    // Any edit restarts menu filtering from the top and re-opens the menu.
    slashIndexRef.current = 0;
    setSlashIndex(0);
    slashDismissedRef.current = false;
    setSlashDismissed(false);
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

  function pushInfo(content: string) {
    setTurns((prev) => [...prev, { role: "tool", content }]);
  }

  function warnEffortUnsupported(modelName: string) {
    pushInfo(
      `reasoning effort is not known to be supported by ${modelName} — setting kept, not sent`
    );
  }

  function runSlashCommand(cmd: string) {
    setInputBoth("");
    switch (cmd) {
      case "/exit":
      case "/quit":
        exit();
        return;
      case "/clear":
        historyRef.current = [{ role: "system", content: systemPrompt }];
        setTurns([]);
        setClearGen((g) => g + 1);
        setError(null);
        setDraft(null);
        setToolHint(null);
        setPhase("idle");
        setPhaseDetail("");
        // usageTotals + effort intentionally kept: token totals and effort
        // are per-session and survive /clear (documented in /help).
        return;
      case "/model":
        setSelIndexBoth(Math.max(0, models.indexOf(model)));
        setSelecting(true);
        setSelectingEffort(false);
        return;
      case "/effort":
        setEffortIndexBoth(Math.max(0, EFFORT_OPTIONS.indexOf(effortRef.current)));
        setSelectingEffort(true);
        setSelecting(false);
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
      default:
        return;
    }
  }

  // approve hook for runAgenticLoop: yolo and always-allowed tools run
  // without prompting; otherwise an Ink y/a/n prompt resolves the promise.
  async function approve(name: string, args: Record<string, unknown>): Promise<ApprovalDecision> {
    if (modeRef.current === "yolo") return "once";
    if (alwaysAllowedRef.current.has(name)) return "once";
    return new Promise<ApprovalDecision>((resolve) => {
      approvalResolveRef.current = resolve;
      setPendingApproval({ name, args });
    });
  }

  function resolveApproval(decision: ApprovalDecision) {
    if (decision === "always" && pendingApproval) {
      alwaysAllowedRef.current.add(pendingApproval.name);
    }
    const resolve = approvalResolveRef.current;
    approvalResolveRef.current = null;
    setPendingApproval(null);
    resolve?.(decision);
  }

  // askUser hook for runAgenticLoop: modal select, resolved by the useInput
  // handler below (pick / custom text / Esc-cancel rejection).
  async function askUser(
    question: string,
    options: string[],
    allowCustom?: boolean
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      askResolveRef.current = { resolve, reject };
      setAskSelIndexBoth(0);
      setAskCustomBoth("");
      setPendingQuestion({ question, options, allowCustom: allowCustom === true });
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
    if (!text || busy) return;
    // Exact full-command + Enter runs it (unknown "/..." falls through as
    // a normal message to the model).
    if (SLASH_NAMES.has(text)) {
      runSlashCommand(text);
      return;
    }
    setBusy(true);
    setError(null);
    setDraft(null);
    setToolHint(null);
    setPhase("thinking");
    setPhaseDetail("");
    // Turn boundary: on POST failure (HTTP/network/empty/truncated) the
    // whole user turn (user message plus any partial assistant/tool loop
    // entries) is removed, so the next request starts clean — same
    // guarantee as the old single-pop. The streaming draft lives outside
    // `turns` until commit, so rollback just clears it (see catch).
    const rollbackTo = historyRef.current.length;
    historyRef.current.push({ role: "user", content: text });
    setTurns((prev) => [...prev, { role: "user", content: text }]);
    try {
      const reply = await runAgenticLoop(endpoint, apiKey, model, historyRef.current, {
        approve,
        askUser,
        reasoningEffort: effortRef.current,
        onToken: (partial) => {
          setDraft(partial);
        },
        onPhase: (p, detail) => {
          setPhase(p);
          setPhaseDetail(detail ?? "");
          if (p === "tool" && detail) {
            setToolHint(detail);
          } else if (p === "retry") {
            const msg = detail ? `↻ retrying… ${detail}` : "↻ retrying…";
            setTurns((prev) => [...prev, { role: "tool", content: msg }]);
          } else if (p === "done") {
            setToolHint(null);
          }
        },
        onToolDelta: (name) => {
          setToolHint(name);
        },
        onUsage: (u) => {
          setUsageTotals((prev) => {
            const next: Usage = { ...(prev ?? {}) };
            if (u.prompt_tokens !== undefined) {
              next.prompt_tokens = (next.prompt_tokens ?? 0) + u.prompt_tokens;
            }
            if (u.completion_tokens !== undefined) {
              next.completion_tokens = (next.completion_tokens ?? 0) + u.completion_tokens;
            }
            if (u.total_tokens !== undefined) {
              next.total_tokens = (next.total_tokens ?? 0) + u.total_tokens;
            }
            return next;
          });
        },
        onReasoning: (label) => {
          setReasoning(label);
        },
        onWarning: (msg) => {
          setTurns((prev) => [...prev, { role: "tool", content: `⚠ ${msg}` }]);
        },
        onToolActivity: (label, result, isError) => {
          setTurns((prev) => {
            const next: Turn[] = [...prev, { role: "tool", content: label }];
            if (isError) {
              const firstLine = result.split("\n", 1)[0] ?? result;
              next.push({ role: "tool", content: `  ↳ ${firstLine}`, error: true });
            }
            return next;
          });
        },
      });
      setTurns((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (err) {
      historyRef.current.splice(rollbackTo); // don't keep the failed user turn
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setDraft(null);
      setToolHint(null);
      setPhase("idle");
      setPhaseDetail("");
    }
  }

  useInput((ch, key) => {
    if (key.ctrl && (ch === "c" || ch === "d")) {
      exit();
      return;
    }
    // 1. Tool approval prompt (normal mode): y = once, a = always this
    // session, n/Esc = deny (denial feeds back into the loop as a result).
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
          setModel(picked);
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
          if (picked !== "default" && !isEffortSupported(model)) {
            warnEffortUnsupported(model);
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
      if (key.upArrow) {
        setSlashIndexBoth(
          (slashIndexRef.current - 1 + matches.length) % matches.length
        );
      } else if (key.downArrow) {
        setSlashIndexBoth((slashIndexRef.current + 1) % matches.length);
      } else if (key.escape) {
        setSlashDismissedBoth(true);
      } else if (key.return || key.tab) {
        if (!busy) {
          const pick = matches[slashIndexRef.current % matches.length];
          if (pick) runSlashCommand(pick.name);
        }
      } else if (key.backspace || key.delete) {
        setInputBoth(cur.slice(0, -1));
      } else if (ch && !key.ctrl && !key.meta && !key.tab) {
        setInputBoth(cur + ch);
      }
      return;
    }
    // 5. Plain input. Tab toggles normal<->yolo here; when the "/" slash
    // menu is open (section 4 above) Tab instead runs the highlighted
    // command and never reaches this branch.
    if (key.return) {
      void submit(inputRef.current);
    } else if (key.tab) {
      const next: PermissionMode = modeRef.current === "normal" ? "yolo" : "normal";
      setModeBoth(next);
    } else if (key.backspace || key.delete) {
      setInputBoth(inputRef.current.slice(0, -1));
    } else if (key.escape) {
      setInputBoth("");
    } else if (ch && !key.ctrl && !key.meta && !key.tab) {
      setInputBoth(inputRef.current + ch);
    }
  });

  if (!apiKey) return <MissingKey />;

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
    !pendingApproval &&
    !pendingQuestion &&
    !slashDismissed &&
    input.startsWith("/")
      ? filterSlashCommands(input)
      : [];
  const slashVisible = filteredSlash.length > 0;
  const slashHighlight =
    filteredSlash.length > 0 ? filteredSlash[slashIndex % filteredSlash.length]?.name : undefined;

  // Status-line reasoning segment wired to the effort session state:
  // non-Default shows the effort (plus " (unsupported)" when the model is
  // outside the verified-support set); Default shows response metadata or
  // "default" as before.
  const effortSupportedNow = effort === "default" || isEffortSupported(model);
  const reasoningDisplay =
    effort !== "default"
      ? effortSupportedNow
        ? effort
        : `${effort} (unsupported)`
      : (reasoning ?? "default");

  // Single <Static> scrollback (Ink keeps only ONE Static node — the last
  // one wins — so banner + committed turns share it). Banner is item 0 on
  // first mount only (clearGen 0); after /clear the Static remounts without
  // the banner so it is never duplicated — it stays once in scrollback.
  type StaticItem = { id: string; turn?: Turn };
  const staticItems: StaticItem[] =
    clearGen === 0
      ? [{ id: "banner" }, ...turns.map((turn, idx) => ({ id: `turn-${idx}`, turn }))]
      : [...turns.map((turn, idx) => ({ id: `turn-${idx}`, turn }))];

  function renderStaticItem(item: StaticItem) {
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
          bot&gt;{" "}
        </Text>
        {t.content}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {/* header / status bar (dynamic: stays in the live viewport below the Static scrollback) */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>Atom</Text>
        <Text> · model: </Text>
        <Text color="green">{model}</Text>
        <Text> · mode: </Text>
        <Text color={mode === "yolo" ? "yellow" : "green"}>{mode}</Text>
        {busy ? <Text color="yellow"> · {phaseLabel}</Text> : null}
      </Box>
      <Text dimColor>
        Commands: /model /effort /tools /mode /yolo /clear /help /exit — type / for the
        command menu, Tab toggles normal/yolo. Chat/completions models only
        (DeepSeek/Kimi/GLM/MiniMax/Big Pickle/free chat models).
      </Text>
      {/* Committed scrollback: banner (once) + history/tool/warning lines */}
      <Static key={`transcript-${clearGen}`} items={staticItems}>
        {(item) => renderStaticItem(item)}
      </Static>
      {/* Live tail: empty hint + streaming draft + tool hint stay dynamic */}
      <Box flexDirection="column" marginY={1}>
        {turns.length === 0 ? (
          <Text dimColor>Say hi to Atom — or type / for commands, /model to switch models, /effort for reasoning.</Text>
        ) : null}
        {draft ? (
          <Text>
            <Text color="magenta" bold>
              bot&gt;{" "}
            </Text>
            {draft}
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
            {input}
            <Text color="gray">█</Text>
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
      {/* persistent status line: provider · model · tokens · reasoning · mode */}
      <Box marginTop={1}>
        <Text dimColor>
          provider: opencode-zen · model: {model} · {formatTokens(usageTotals)} · reasoning:{" "}
          {reasoningDisplay} · mode: {mode}
        </Text>
      </Box>
    </Box>
  );
}
