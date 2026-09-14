// WebUI session runtime: the headless bridge between the browser and the
// existing ATOM agentic loop. The WebUI is ONLY another frontend for the same
// runtime — this module reuses it instead of duplicating it:
//
// - Turns run through runAgenticLoopForProvider (the same shared
//   runLoopWithChat core the TUI uses), with the same per-turn contract:
//   history[0] carries withEnvBlock(buildSystemPrompt(cwd)), refreshed once
//   per turn; failed/cancelled turns splice history back to the turn start
//   (see src/rollback.ts) and never persist; completed turns persist via the
//   sessions store (see src/sessions.ts).
// - Permissions mirror App.approve exactly: decidePolicy over
//   {mode, trustAll:false, rules:[], alwaysAllowed, skillGrants:∅,
//   approvalGated:needsApproval(name)} — deny refuses, plan-passthrough flows
//   to the execute gate, prompt blocks on the browser's POSTed decision.
// - Plan mode reuses the exact replan-note string from App.guardedExecute.
// - Cancellation uses AbortController → LoopCancelledError, same as Ctrl+C.
// - ask_question resolves through the browser (question_request event +
//   POSTed answer); without a waiting browser it degrades exactly as the
//   loop's no-hook path does (never hangs, never throws).
//
// Deliberately OUT of v1 scope (TUI-only surfaces, not loop features):
// skill auto-invoke, compaction, telemetry traces, goal auto-continue hooks
// (no opts.goal → the loop runs its byte-identical no-goal path; update_goal
// resolves to the standard outside-turn error, exactly as in the TUI with no
// goal set), follow-up queue/steer (concurrent send is a 409), extension
// lifecycle commands. The goal/tool hooks stay available for later prompts.

import { LoopCancelledError } from "../agent/loop.js";
import { loadAuth, getStoredBaseURL, resolveApiKey } from "../auth.js";
import { withEnvBlock } from "../env-block.js";
import { decidePolicy } from "../policy.js";
import {
  getProvider,
  isProviderId,
  PROVIDERS,
  providerNeedsKey,
  type ProviderId,
} from "../providers.js";
import { cancelledTurnLine } from "../rollback.js";
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  type Session,
  type SessionTurn,
} from "../sessions.js";
import { getTodos } from "../tools.js";
import { withSessionTodos } from "../todos.js";
import {
  allToolDefinitions,
  describeToolCall,
  executeTool,
  needsApproval,
  previewDiffForApproval,
  previewLangFromPath,
} from "../tools.js";
import {
  computeDiff,
  computeSideBySide,
  type DiffHunk,
  type SBSRow,
} from "../diff-engine.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  buildSystemPrompt,
  normalizeEffort,
  runAgenticLoopForProvider,
  type ApprovalDecision,
  type ChatMessage,
  type PermissionMode,
  type ReasoningEffort,
  type Usage,
} from "../zen.js";
import { createWebEvent, eventsAfter, type WebEvent, type WebEventKind } from "./events.js";

// Exact replan refusal from App.guardedExecute (ticket 04): the WebUI must
// refuse plan-mode mutations with the same model-visible text, so behavior
// never drifts between frontends.
export function planModeRefusal(name: string): string {
  return (
    `Error: plan mode is read-only — ${name} blocked (no writes while planning). ` +
    `Explore with read/grep/glob/web tools, record the plan with todowrite, then Tab out of plan mode to implement.`
  );
}

// Cap for result text inside tool_result events: SSE frames stay small and
// the DOM never renders megabytes per call. Capped payloads carry
// truncated:true plus the full length, so the UI can say so honestly.
export const EVENT_RESULT_CAP = 4000;

export function truncateEventText(text: string, cap: number = EVENT_RESULT_CAP): {
  text: string;
  truncated: boolean;
  chars: number;
} {
  if (text.length <= cap) return { text, truncated: false, chars: text.length };
  return { text: text.slice(0, cap), truncated: true, chars: text.length };
}

export type WebListener = (event: WebEvent) => void;

// File-change evidence for write/edit calls, captured the TUI's way:
// pre-execution state in approve() (the approval preview already pre-read
// it — no second read), post-execution state at commit. Display reads only:
// the WebUI never executes a tool to satisfy the UI (no bash, no model
// calls — plain fs reads of the file the turn just touched).
export type FileOp = "created" | "modified";

// Cap for diff-side text in file_diff events (cut at a newline so no fake
// partial last line). 32KB keeps SSE frames and the DOM small; the full
// lengths ride along so the UI states the truncation honestly.
export const FILE_DIFF_CAP = 32768;
export const FILE_DIFF_ROWS_CAP = 400;

export function classifyWriteOp(oldText: string | null): FileOp {
  return oldText === null ? "created" : "modified";
}

export function cutAtNewline(text: string, cap: number = FILE_DIFF_CAP): {
  text: string;
  truncated: boolean;
  chars: number;
} {
  if (text.length <= cap) return { text, truncated: false, chars: text.length };
  const cut = text.lastIndexOf("\n", cap);
  const end = cut > cap / 2 ? cut : cap;
  return { text: text.slice(0, end), truncated: true, chars: text.length };
}

// Capped disk read for diff evidence (same fail-null contract as App's
// readFileForDiff, smaller cap — display evidence, not approval preview).
function readCappedForDiff(absPath: string): string | null {
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size > FILE_DIFF_CAP) return null;
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

type PendingFileOp = {
  name: string;
  path: string;
  op: FileOp;
  oldFull: string | null;
  newFull: string | null; // write: known pre-execution (the content arg)
};

export type SendMessageOpts = {
  provider?: ProviderId;
  model?: string;
  effort?: ReasoningEffort;
  mode?: PermissionMode;
};

// In-memory overlay per session: the persisted record (history/turns/
// settings in sessions.ts) plus live turn state. Bounded event log (cap
// below) doubles as the reconnect replay buffer.
const EVENT_LOG_CAP = 1000;

export type PendingApproval = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description: string;
  diff: unknown;
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
};

export type PendingQuestion = {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
};

type RuntimeState = {
  history: ChatMessage[];
  turns: SessionTurn[];
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
  mode: PermissionMode;
  usageTotals: Usage | null;
  busy: boolean;
  controller: AbortController | null;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  alwaysAllowed: Set<string>;
  listeners: Set<WebListener>;
  eventLog: WebEvent[];
  seq: number;
  // Pre-execution file evidence, one entry per approve()d write/edit in
  // call order (same FIFO discipline as the loop's commit funnel, which the
  // onToolResult consumer below relies on to re-pair evidence with results).
  fileOps: PendingFileOp[];
  // Latest streamed answer text (display-only, like the TUI draft): a failed
  // turn commits it as a marked partial row so already-read output survives.
  lastPartial: string;
};

let approvalIdCounter = 0;
let questionIdCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accumulateUsage(prev: Usage | null, u: Usage): Usage {
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
  if (u.cacheReadTokens !== undefined) {
    next.cacheReadTokens = (next.cacheReadTokens ?? 0) + u.cacheReadTokens;
  }
  if (u.cacheWriteTokens !== undefined) {
    next.cacheWriteTokens = (next.cacheWriteTokens ?? 0) + u.cacheWriteTokens;
  }
  return next;
}

export class WebRuntime {
  private readonly home: string | undefined;
  private readonly states = new Map<string, RuntimeState>();

  constructor(home?: string) {
    this.home = home;
  }

  // ---- session records (persisted store, same as the TUI) ----

  listSessions(): Session[] {
    return listSessions(this.home);
  }

  getSessionRecord(id: string): Session | null {
    return getSession(id, this.home);
  }

  // Live view for the item route and SSE clients: persisted identity
  // (title/dates) plus the in-memory turn state (history/turns/settings/
  // busy/pending). A fresh client renders this, then streams events — it
  // never misses the running turn's user echo or a cancelled-turn line that
  // (by rollback contract) never reaches the store.
  getLiveSession(id: string): (Session & { busy: boolean } & {
    pendingApproval: Omit<PendingApproval, "resolve" | "reject"> | null;
    pendingQuestion: Omit<PendingQuestion, "resolve" | "reject"> | null;
  }) | null {
    const record = getSession(id, this.home);
    if (!record) return null;
    const state = this.stateFor(record);
    return {
      ...record,
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      mode: state.mode,
      usageTotals: state.usageTotals ? { ...state.usageTotals } : null,
      history: state.history.map((m) => ({ ...m })),
      turns: state.turns.map((t) => ({ ...t })),
      busy: state.busy,
      pendingApproval: this.getPendingApproval(id),
      pendingQuestion: this.getPendingQuestion(id),
    };
  }

  createWebSession(opts?: {
    title?: string;
    provider?: ProviderId;
    model?: string;
    effort?: ReasoningEffort;
    mode?: PermissionMode;
  }): Session {
    const provider = opts?.provider && isProviderId(opts.provider) ? opts.provider : "opencode-zen";
    const cwd = process.cwd();
    const history: ChatMessage[] = [
      { role: "system", content: withEnvBlock(buildSystemPrompt(cwd)) },
    ];
    const session = createSession(
      {
        title: opts?.title,
        cwd,
        provider,
        model: opts?.model ?? getProvider(provider)?.defaultModel ?? "",
        effort: normalizeEffort(opts?.effort ?? "auto"),
        mode: opts?.mode ?? "normal",
        history,
        turns: [],
      },
      this.home
    );
    this.stateFor(session);
    return session;
  }

  updateWebSession(
    id: string,
    patch: { provider?: ProviderId; model?: string; effort?: ReasoningEffort; mode?: PermissionMode; title?: string }
  ): Session | null {
    const current = getSession(id, this.home);
    if (!current) return null;
    const next = updateSession(
      id,
      {
        ...(patch.provider && isProviderId(patch.provider) ? { provider: patch.provider } : {}),
        ...(typeof patch.model === "string" ? { model: patch.model } : {}),
        ...(patch.effort !== undefined ? { effort: normalizeEffort(patch.effort) } : {}),
        ...(patch.mode === "normal" || patch.mode === "yolo" || patch.mode === "plan"
          ? { mode: patch.mode }
          : {}),
        ...(typeof patch.title === "string" && patch.title.trim().length > 0
          ? { title: patch.title.trim() }
          : {}),
      },
      this.home
    );
    if (next) {
      const state = this.states.get(id);
      if (state && !state.busy) this.syncStateFromRecord(state, next);
    }
    return next;
  }

  // ---- realtime fan-out ----

  subscribe(id: string, listener: WebListener, lastEventId?: number): () => void {
    const record = getSession(id, this.home);
    if (!record) throw new Error(`session not found: ${id}`);
    const state = this.stateFor(record);
    // Reconnect replay: events after the client's last seen id, oldest first.
    for (const evt of eventsAfter(state.eventLog, lastEventId)) {
      try {
        listener(evt);
      } catch {
        // a throwing listener must not break subscribe
      }
    }
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  // ---- turns ----

  isBusy(id: string): boolean {
    return this.states.get(id)?.busy ?? false;
  }

  getPendingApproval(id: string): Omit<PendingApproval, "resolve" | "reject"> | null {
    const p = this.states.get(id)?.pendingApproval ?? null;
    if (!p) return null;
    return { id: p.id, name: p.name, args: p.args, description: p.description, diff: p.diff };
  }

  getPendingQuestion(id: string): Omit<PendingQuestion, "resolve" | "reject"> | null {
    const p = this.states.get(id)?.pendingQuestion ?? null;
    if (!p) return null;
    return { id: p.id, question: p.question, options: p.options, allowCustom: p.allowCustom };
  }

  resolveApproval(id: string, approvalId: string, decision: ApprovalDecision): boolean {
    const state = this.states.get(id);
    const pending = state?.pendingApproval ?? null;
    if (!state || !pending || pending.id !== approvalId) return false;
    if (decision === "always") state.alwaysAllowed.add(pending.name);
    state.pendingApproval = null;
    this.emit(state, "approval_resolved", { id: approvalId, decision });
    pending.resolve(decision);
    return true;
  }

  answerQuestion(id: string, questionId: string, answer: string): boolean {
    const state = this.states.get(id);
    const pending = state?.pendingQuestion ?? null;
    if (!state || !pending || pending.id !== questionId) return false;
    if (typeof answer !== "string" || answer.length === 0) return false;
    state.pendingQuestion = null;
    this.emit(state, "question_resolved", { id: questionId });
    pending.resolve(answer);
    return true;
  }

  cancelTurn(id: string): boolean {
    const state = this.states.get(id);
    if (!state || !state.busy || !state.controller) return false;
    state.controller.abort();
    return true;
  }

  // Synchronous start-gate: validates the turn and applies any settings
  // overrides, throwing on anything that prevents the turn from starting
  // (unknown session, empty text, busy, missing key/model). The HTTP layer
  // calls this inside try/catch BEFORE the fire-and-forget sendMessage —
  // an async function never throws synchronously, so awaiting sendMessage
  // would hold the request for the whole turn while `void` would swallow
  // start-failures as 202s. Single-threaded and await-free, so the gate +
  // send pair below is atomic (no interleaving turn can sneak in).
  validateTurnStart(id: string, content: string, opts?: SendMessageOpts): void {
    const record = getSession(id, this.home);
    if (!record) throw new Error(`session not found: ${id}`);
    const text = content.trim();
    if (!text) throw new Error("message must be a non-empty string");
    const state = this.stateFor(record);
    if (state.busy) throw new Error("session is busy (another turn is running)");
    if (state.pendingApproval || state.pendingQuestion) {
      throw new Error("session is waiting on an approval or question");
    }

    // Per-message settings overrides apply to the session record first (same
    // persistence as the TUI's /model + /provider + /effort picks).
    if (opts?.provider || opts?.model !== undefined || opts?.effort !== undefined || opts?.mode) {
      const updated = this.updateWebSession(id, {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
      });
      if (!updated) throw new Error(`session not found: ${id}`);
    }

    const auth = loadAuth(this.home);
    const apiKey = resolveApiKey(state.provider, auth);
    if (!apiKey && providerNeedsKey(state.provider)) {
      throw new Error(
        `missing API key for provider "${state.provider}" — set ${getProvider(state.provider)?.envVars.join(" or ") ?? "its env var"} or paste one via the TUI /provider command`
      );
    }
    if (!state.model) throw new Error(`no model selected for provider "${state.provider}"`);
  }

  // Fire-and-forget (like App.submit): the returned promise settles when the
  // turn ends, but callers normally don't await it — progress arrives as
  // events. Rejects only when the turn cannot start (unknown session, busy,
  // missing key); in-turn failures surface as error/cancelled events, never
  // as rejections, so one HTTP request maps to one turn lifecycle.
  async sendMessage(id: string, content: string, opts?: SendMessageOpts): Promise<void> {
    this.validateTurnStart(id, content, opts);
    const record = getSession(id, this.home);
    if (!record) throw new Error(`session not found: ${id}`);
    const text = content.trim();
    const state = this.stateFor(record);

    const auth = loadAuth(this.home);
    const provider = state.provider;
    const model = state.model;
    const apiKey = resolveApiKey(provider, auth);
    const baseURL = getStoredBaseURL(auth, provider);

    // SUBMIT STAGE 2/3 — context assembly (pre-rollback scope): refresh the
    // pinned env block once per turn; it survives a failed-turn rollback.
    const first = state.history[0];
    if (first?.role === "system" && typeof (first as { content?: unknown }).content === "string") {
      state.history[0] = {
        role: "system",
        content: withEnvBlock((first as { content: string }).content),
      };
    }
    // SUBMIT STAGE 3/3 — loop entry (post-rollback scope): everything from
    // here rolls back on failure/cancel.
    const rollbackTo = state.history.length;
    const turnsRollbackTo = state.turns.length;
    state.busy = true;
    const controller = new AbortController();
    state.controller = controller;
    state.lastPartial = "";
    state.history.push({ role: "user", content: text });
    this.pushTurn(state, { role: "user", content: text });

    try {
      const reply = await runAgenticLoopForProvider(provider, apiKey, model, state.history, {
        approve: (name, args) => this.approve(state, name, args),
        askUser: (question, options, allowCustom) =>
          this.askBrowser(state, question, options, allowCustom === true),
        execute: (name, args) => this.guardedExecute(state, name, args),
        reasoningEffort: state.effort,
        baseURL,
        signal: controller.signal,
        // Token/thinking/phase/tool-identity stream through the turnEvents
        // sink ONLY (the loop invokes callbacks AND sink for those facts, so
        // setting both would double-emit). Callbacks below cover the facts
        // with no sink kind: tool deltas, warnings, usage, reasoning labels,
        // and committed tool activity.
        onToolDelta: (name, index) => this.emit(state, "tool_delta", { name, index }),
        onWarning: (message) => {
          this.pushTurn(state, { role: "tool", content: `⚠ ${message}` });
          this.emit(state, "warning", { message });
        },
        onUsage: (u) => {
          state.usageTotals = accumulateUsage(state.usageTotals, u);
          this.emit(state, "usage", { usage: { ...u } });
        },
        onReasoning: (reasoning) => this.emit(state, "reasoning", { reasoning }),
        onToolActivity: (label, result, isError) => {
          this.pushTurn(state, { role: "tool", content: label, ...(isError ? { error: true } : {}) });
          this.emit(state, "tool_activity", { label, result, isError });
        },
        // Commit seam: real name + effective args + result for EVERY
        // committed call (read-only tools included — they never consult
        // approve). Observer-only: returning undefined keeps the committed
        // result byte-identical. Result text is capped (see
        // truncateEventText); the full length rides along honestly.
        onToolResult: (input) => {
          const capped = truncateEventText(input.result);
          this.emit(state, "tool_result", {
            name: input.name,
            args: { ...input.args },
            result: capped.text,
            isError: input.isError,
            truncated: capped.truncated,
            resultChars: capped.chars,
          });
          this.emitFileDiff(state, input.name, input.args, input.isError);
          return undefined;
        },
        turnEvents: {
          onToken: (t) => {
            state.lastPartial = t;
            this.emit(state, "token", { text: t });
          },
          onThinking: (t) => this.emit(state, "thinking", { text: t }),
          onPhase: (phase, detail) => this.emit(state, "phase", { phase, detail: detail ?? "" }),
          onToolStarted: (info) =>
            this.emit(state, "tool_started", {
              toolCallId: info.toolCallId,
              name: info.name,
              index: info.index,
            }),
          onToolFinished: (info) =>
            this.emit(state, "tool_finished", {
              toolCallId: info.toolCallId,
              name: info.name,
              isError: info.isError,
            }),
        },
      });
      this.pushTurn(state, { role: "assistant", content: reply });
      this.emit(state, "done", { reply });
      this.persist(state, id);
    } catch (err) {
      const cancelled =
        err instanceof LoopCancelledError ||
        (err instanceof Error && err.name === "LoopCancelledError") ||
        controller.signal.aborted;
      // Rollback: the turn never happened (same splice contract as the TUI).
      state.history.splice(rollbackTo);
      state.turns.splice(turnsRollbackTo);
      if (cancelled) {
        this.pushTurn(state, { role: "tool", content: cancelledTurnLine() });
        this.emit(state, "cancelled", { notice: cancelledTurnLine() });
      } else {
        // Failed (not cancelled): the streamed answer so far commits as a
        // marked partial row BEFORE the error, so already-read output
        // survives. History stays rolled back (the model never sees it) —
        // same contract as the TUI.
        const partial = state.lastPartial.trim();
        if (partial) {
          this.pushTurn(state, {
            role: "assistant",
            content: `${partial}\n\n(request failed before completing — partial output preserved)`,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        this.emit(state, "error", { message });
      }
      // Rolled-back turns never persist — the last good save stays intact.
    } finally {
      state.busy = false;
      state.controller = null;
      state.pendingApproval = null;
      state.pendingQuestion = null;
      state.lastPartial = "";
      state.fileOps = [];
    }
  }

  // ---- catalogs (no secrets cross these) ----

  listProviders(): Array<{
    id: ProviderId;
    name: string;
    defaultModel: string;
    fallbackModels: string[];
    needsKey: boolean;
    hasKey: boolean;
    notes: string;
  }> {
    const auth = loadAuth(this.home);
    return PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      defaultModel: p.defaultModel,
      fallbackModels: [...p.fallbackModels],
      needsKey: providerNeedsKey(p.id),
      hasKey: resolveApiKey(p.id, auth).length > 0,
      notes: p.notes,
    }));
  }

  listTools(): Array<{ name: string; description: string; needsApproval: boolean }> {
    return allToolDefinitions().map((t) => ({
      name: t.function.name,
      description: t.function.description,
      needsApproval: needsApproval(t.function.name),
    }));
  }

  // ---- internals ----

  private stateFor(record: Session): RuntimeState {
    let state = this.states.get(record.id);
    if (!state) {
      state = {
        history: record.history.map((m) => ({ ...m })),
        turns: record.turns.map((t) => ({ ...t })),
        provider: record.provider,
        model: record.model,
        effort: record.effort,
        mode: record.mode,
        usageTotals: record.usageTotals ? { ...record.usageTotals } : null,
        busy: false,
        controller: null,
        pendingApproval: null,
        pendingQuestion: null,
        alwaysAllowed: new Set<string>(),
        listeners: new Set<WebListener>(),
        eventLog: [],
        seq: 0,
        lastPartial: "",
        fileOps: [],
      };
      this.states.set(record.id, state);
    }
    return state;
  }

  private syncStateFromRecord(state: RuntimeState, record: Session): void {
    state.history = record.history.map((m) => ({ ...m }));
    state.turns = record.turns.map((t) => ({ ...t }));
    state.provider = record.provider;
    state.model = record.model;
    state.effort = record.effort;
    state.mode = record.mode;
    state.usageTotals = record.usageTotals ? { ...record.usageTotals } : null;
  }

  private emit(state: RuntimeState, kind: WebEventKind, data?: Record<string, unknown>): WebEvent {
    state.seq += 1;
    const event = createWebEvent(state.seq, kind, data);
    state.eventLog.push(event);
    if (state.eventLog.length > EVENT_LOG_CAP) {
      state.eventLog.splice(0, state.eventLog.length - EVENT_LOG_CAP);
    }
    for (const listener of [...state.listeners]) {
      try {
        listener(event);
      } catch {
        // a throwing listener must not break the turn or other clients
      }
    }
    return event;
  }

  private pushTurn(state: RuntimeState, turn: SessionTurn): void {
    state.turns.push(turn);
    this.emit(state, "message", { ...turn });
  }

  // Commit-time file diffs: consumes one queued pre-execution entry per
  // write/edit commit (FIFO by name — the loop commits in call order) and
  // emits a file_diff with pre-computed unified hunks + side-by-side rows
  // from the shared engine (src/ui/diff.ts, same as the TUI preview).
  // Failed calls consume without emitting (nothing changed on disk).
  // edit AFTER bytes come from a post-commit display read (capped); write
  // AFTER bytes are the committed content arg. Display reads only — the
  // WebUI never executes a tool to satisfy the UI.
  private emitFileDiff(
    state: RuntimeState,
    name: string,
    args: Record<string, unknown>,
    isError: boolean
  ): void {
    if (name !== "write" && name !== "edit") return;
    let slot = -1;
    for (let i = 0; i < state.fileOps.length; i++) {
      if (state.fileOps[i]!.name === name) {
        slot = i;
        break;
      }
    }
    if (slot === -1) return;
    const evidence = state.fileOps.splice(slot, 1)[0]!;
    if (isError) return;
    const toolPath = typeof args["path"] === "string" ? (args["path"] as string) : evidence.path;
    let newFull: string | null = evidence.newFull;
    if (name === "edit") {
      try {
        newFull = readCappedForDiff(path.resolve(process.cwd(), toolPath));
      } catch {
        newFull = null;
      }
    }
    if (evidence.oldFull === null && newFull === null) return;
    const oldCut = evidence.oldFull === null ? null : cutAtNewline(evidence.oldFull);
    const newCut = newFull === null ? null : cutAtNewline(newFull);
    const oldText = oldCut === null ? null : oldCut.text;
    const newText = newCut === null ? "" : newCut.text;
    let hunks: DiffHunk[] = [];
    let rows: SBSRow[] = [];
    let adds = 0;
    let dels = 0;
    let rowsTruncated = false;
    try {
      const diff = computeDiff(oldText, newText);
      if (!diff.skipped) {
        hunks = diff.hunks;
        adds = diff.adds;
        dels = diff.dels;
      }
      const sbs = computeSideBySide(oldText, newText);
      if (sbs.kind === "diff") {
        adds = sbs.adds;
        dels = sbs.dels;
        rows = sbs.rows.slice(0, FILE_DIFF_ROWS_CAP);
        rowsTruncated = sbs.rows.length > rows.length;
      }
    } catch {
      return;
    }
    this.emit(state, "file_diff", {
      path: toolPath,
      op: evidence.op,
      lang: previewLangFromPath(toolPath),
      adds,
      dels,
      isNewFile: oldText === null,
      hunks,
      rows,
      rowsTruncated,
      truncated: (oldCut?.truncated ?? false) || (newCut?.truncated ?? false),
      oldChars: evidence.oldFull === null ? 0 : evidence.oldFull.length,
      newChars: newFull === null ? 0 : newFull.length,
    });
  }

  private persist(state: RuntimeState, id: string): void {
    let diskMetadata: unknown;
    try {
      diskMetadata = getSession(id, this.home)?.metadata;
    } catch {
      diskMetadata = undefined;
    }
    const updated = updateSession(
      id,
      {
        provider: state.provider,
        model: state.model,
        effort: state.effort,
        mode: state.mode,
        usageTotals: state.usageTotals,
        history: state.history.map((m) => ({ ...m })),
        turns: state.turns.map((t) => ({ ...t })),
        metadata: withSessionTodos(diskMetadata, getTodos()),
      },
      this.home
    );
    if (updated) this.syncStateFromRecord(state, updated);
  }

  private async approve(
    state: RuntimeState,
    name: string,
    args: Record<string, unknown>
  ): Promise<ApprovalDecision> {
    if (state.controller?.signal.aborted) throw new LoopCancelledError();
    // Pre-execution file evidence for write/edit (all outcomes, including
    // deny: the commit seam below consumes one queue entry per committed
    // call, so every queued entry pairs exactly once). The approval preview
    // already pre-read the write BEFORE bytes — reused, never re-read.
    const stagedDiff = name === "write" || name === "edit" ? previewDiffForApproval(name, args) : null;
    if ((name === "write" || name === "edit") && typeof args["path"] === "string") {
      const toolPath = args["path"] as string;
      if (name === "write") {
        state.fileOps.push({
          name,
          path: toolPath,
          op: classifyWriteOp(stagedDiff?.oldText ?? null),
          oldFull: stagedDiff?.oldText ?? null,
          newFull: typeof args["content"] === "string" ? (args["content"] as string) : null,
        });
      } else {
        let oldFull: string | null = null;
        try {
          oldFull = readCappedForDiff(path.resolve(process.cwd(), toolPath));
        } catch {
          oldFull = null;
        }
        state.fileOps.push({ name, path: toolPath, op: "modified", oldFull, newFull: null });
      }
    }
    const verdict = decidePolicy(name, args, {
      mode: state.mode,
      trustAll: false,
      rules: [],
      alwaysAllowed: state.alwaysAllowed,
      skillGrants: new Set<string>(),
      approvalGated: needsApproval(name),
    });
    if (verdict.kind === "deny") {
      this.emit(state, "approval_resolved", { name, decision: "no", via: "deny" });
      this.emit(state, "tool_call", {
        name,
        args: { ...args },
        description: describeToolCall(name, args),
        decision: "no",
        via: "deny",
      });
      return "no";
    }
    if (verdict.kind === "allow") {
      this.emit(state, "tool_call", {
        name,
        args: { ...args },
        description: describeToolCall(name, args),
        decision: "once",
        via: verdict.via,
      });
      return "once";
    }
    // Prompt: block the turn on the browser. Cancel wins the race (same as
    // the TUI's abort listener on the approval promise).
    const description = describeToolCall(name, args);
    const diff = stagedDiff;
    approvalIdCounter += 1;
    const approvalId = `apr_${approvalIdCounter}`;
    const signal = state.controller?.signal ?? null;
    if (signal?.aborted) throw new LoopCancelledError();
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const pending: PendingApproval = {
        id: approvalId,
        name,
        args: { ...args },
        description,
        diff,
        // The browser's decision lands here (via resolveApproval): record
        // the tool_call with it, so the timeline shows user-resolved calls
        // exactly like automatic ones (provenance via "prompt").
        resolve: (decision) => {
          this.emit(state, "tool_call", {
            name,
            args: { ...args },
            description,
            decision,
            via: "prompt",
          });
          resolve(decision);
        },
        reject,
      };
      state.pendingApproval = pending;
      this.emit(state, "approval_request", {
        id: approvalId,
        name,
        args: { ...args },
        description,
        diff,
      });
      if (signal) {
        const onAbort = () => {
          if (state.pendingApproval === pending) state.pendingApproval = null;
          reject(new LoopCancelledError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private guardedExecute(state: RuntimeState, name: string, args: Record<string, unknown>): Promise<string> {
    if (state.mode === "plan" && needsApproval(name)) {
      return Promise.resolve(planModeRefusal(name));
    }
    // Session cwd is process.cwd() at creation (see createWebSession), same
    // value the TUI executes under.
    return executeTool(name, args, process.cwd());
  }

  private askBrowser(
    state: RuntimeState,
    question: string,
    options: string[],
    allowCustom: boolean
  ): Promise<string> {
    const signal = state.controller?.signal ?? null;
    if (signal?.aborted) throw new LoopCancelledError();
    questionIdCounter += 1;
    const questionId = `q_${questionIdCounter}`;
    return new Promise<string>((resolve, reject) => {
      const pending: PendingQuestion = {
        id: questionId,
        question,
        options: [...options],
        allowCustom,
        resolve,
        reject,
      };
      state.pendingQuestion = pending;
      this.emit(state, "question_request", {
        id: questionId,
        question,
        options: [...options],
        allowCustom,
      });
      if (signal) {
        const onAbort = () => {
          if (state.pendingQuestion === pending) state.pendingQuestion = null;
          reject(new LoopCancelledError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

// Body validation for the HTTP layer (pure, unit-tested through the server
// tests): returns the error string for a 400, or null when the body is fine.
export function validateSendBody(body: unknown): string | null {
  if (!isRecord(body)) return "body must be a JSON object";
  if (typeof body["content"] !== "string" || (body["content"] as string).trim().length === 0) {
    return 'body.content must be a non-empty string';
  }
  const provider = body["provider"];
  if (provider !== undefined && (typeof provider !== "string" || !isProviderId(provider))) {
    return "body.provider must be a known provider id";
  }
  const mode = body["mode"];
  if (mode !== undefined && mode !== "normal" && mode !== "yolo" && mode !== "plan") {
    return "body.mode must be one of normal|yolo|plan";
  }
  const effort = body["effort"];
  if (
    effort !== undefined &&
    effort !== "auto" &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "max"
  ) {
    return "body.effort must be one of auto|low|medium|high|max";
  }
  if (body["model"] !== undefined && typeof body["model"] !== "string") {
    return "body.model must be a string";
  }
  return null;
}
