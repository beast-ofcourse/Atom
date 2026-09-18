// ATOM Core — frontend-agnostic orchestration that emits semantic events.
import { LoopCancelledError } from "./loop.js";
import { createEventEmitter, nextTurnId, toolKindFor, type AgentEventEmitter } from "./events.js";
import type { AgenticOpts, ChatMessage, Usage } from "./types.js";
import { buildSystemPrompt, runAgenticLoopForProvider } from "../zen.js";
import { withEnvBlock } from "../env-block.js";
import { describeToolCall, executeTool, needsApproval } from "../tools.js";
import { decidePolicy } from "../policy.js";
import type { ProviderId } from "../providers.js";
import { loadAuth, resolveApiKey, getStoredBaseURL } from "../auth.js";

export type CommitExtras = {
  diff?: import("../ui/diff.js").DiffPreview | null;
  approvalVia?: string | null;
};

// Frontend hooks for a core turn. The core owns orchestration (retry,
// history, tool routing); the TUI owns user interaction — these hooks are
// the seam. Absent hooks fall back to headless behavior (deny gated calls,
// error on ask_question) so direct core use in tests stays deterministic.
export type CoreHooks = {
  approve?: AgenticOpts["approve"];
  askUser?: AgenticOpts["askUser"];
  execute?: AgenticOpts["execute"];
  goal?: AgenticOpts["goal"];
  goalJudge?: AgenticOpts["goalJudge"];
  // Pull interface for approve-time captures (transcript diff + approval
  // provenance) staged by the approve hook. Called once per committed call,
  // in commit order — the hook consumes its slot so nothing leaks sideways.
  consumeCommitExtras?: (name: string) => CommitExtras;
};

export type CoreOpts = {
  provider: ProviderId;
  model: string;
  effort: string;
  mode: "normal" | "yolo" | "plan";
  apiKey?: string;
  baseURL?: string;
  cwd?: string;
  history?: ChatMessage[];
  // Stable accessor for live frontend hooks (the TUI's closures re-create
  // per render — a captured object would go stale; the accessor is read at
  // turn start). Absent = headless fallback behavior above.
  getHooks?: () => CoreHooks;
};

export type SendOpts = { signal?: AbortSignal };

export class AgentCore {
  private history: ChatMessage[];
  private opts: CoreOpts;
  private emitter: AgentEventEmitter;
  private busy = false;
  private controller: AbortController | null = null;

  constructor(opts: CoreOpts) {
    this.opts = { cwd: opts.cwd ?? process.cwd(), ...opts };
    const cwd = this.opts.cwd!;
    if (opts.history && opts.history.length > 0) {
      this.history = [...opts.history];
    } else {
      this.history = [{ role: "system", content: withEnvBlock(buildSystemPrompt(cwd)) }];
    }
    this.emitter = createEventEmitter();
  }

  onEvent(listener: (e: import("./events.js").AgentEvent) => void): () => void {
    return this.emitter.on(listener);
  }

  getHistory(): ChatMessage[] { return [...this.history]; }
  isBusy(): boolean { return this.busy; }
  cancel(): void { this.controller?.abort(); }

  async send(input: string, sendOpts?: SendOpts): Promise<string> {
    if (this.busy) throw new Error("agent is busy");
    const text = input.trim();
    if (!text) throw new Error("empty input");
    const turnId = nextTurnId();
    this.busy = true;
    this.emitter.emitPartial({ type: "agent.started", turnId, input: text });
    const rollbackTo = this.history.length;
    this.history.push({ role: "user", content: text });
    const controller = new AbortController();
    this.controller = controller;
    const signal = sendOpts?.signal ?? controller.signal;
    // Single token/thinking observer (1C): the loop invokes the callback
    // then the turnEvents sink back-to-back with the same text, so
    // registering both would either double-emit (independent accumulators)
    // or depend on call order (shared accumulator). Exactly one observer is
    // registered — the callbacks below — and the sink token/thinking slots
    // stay unset. Deltas are therefore order-independent by construction.
    let thinkingAccum = "";
    let thinkingStarted = false;
    let messageAccum = "";
    let messageStarted = false;
    // Live hooks are read once per turn (never per event) so a turn sees one
    // consistent frontend even if the TUI re-renders mid-turn.
    const hooks = this.opts.getHooks?.() ?? {};
    // Commit-order queue of started tools ({toolCallId, name, startedAt}).
    // The loop's onToolStarted fires before each commit and onToolFinished
    // right after the matching onToolActivity, so the queue head at activity
    // time IS the committing call — the same discipline as the legacy TUI
    // (see App's toolIdentityQueueRef). Lifetime ⊆ one send().
    const pending: Array<{ toolCallId: string; name: string; startedAt: number }> = [];
    const shiftCommit = (): { toolCallId: string; name: string; startedAt: number } | null =>
      pending.length > 0 ? pending.shift()! : null;
    const apiKey = this.opts.apiKey ?? resolveApiKey(this.opts.provider, loadAuth());
    const baseURL = this.opts.baseURL ?? getStoredBaseURL(loadAuth(), this.opts.provider);
    try {
      const result = await runAgenticLoopForProvider(
        this.opts.provider,
        apiKey,
        this.opts.model,
        this.history,
        {
          signal,
          reasoningEffort: this.opts.effort,
          baseURL,
          onThinking: (thinking) => {
            const delta = thinking.slice(thinkingAccum.length);
            if (!thinkingStarted) { thinkingStarted = true; this.emitter.emitPartial({ type: "agent.thinking.started" }); }
            thinkingAccum = thinking;
            if (delta) this.emitter.emitPartial({ type: "agent.thinking.delta", delta, accumulated: thinking });
          },
          onToken: (partial) => {
            const delta = partial.slice(messageAccum.length);
            if (!messageStarted) { messageStarted = true; this.emitter.emitPartial({ type: "message.started" }); }
            messageAccum = partial;
            if (delta) this.emitter.emitPartial({ type: "message.delta", delta, accumulated: partial });
          },
          onPhase: () => {},
          onToolDelta: () => {},
          approve: hooks.approve ?? (async (name, args) => {
            if (this.opts.mode === "plan" && needsApproval(name)) return "no";
            const verdict = decidePolicy(name, args, {
              mode: this.opts.mode,
              trustAll: false,
              rules: [],
              alwaysAllowed: new Set(),
              skillGrants: new Set(),
              approvalGated: needsApproval(name),
            });
            if (verdict.kind === "deny") return "no";
            if (verdict.kind === "allow") return "once";
            return "no";
          }),
          askUser: hooks.askUser,
          goal: hooks.goal,
          goalJudge: hooks.goalJudge,
          execute: hooks.execute ?? ((name, args) => executeTool(name, args, this.opts.cwd)),
          turnEvents: {
            // No onToken/onThinking here by design (see the accumulator note
            // above): the loop's fused emitter would invoke them back-to-back
            // with the callbacks carrying the same text. The callbacks are
            // the single token/thinking observer.
            onPhase: () => {},
            onToolStarted: (info) => {
              const kind = toolKindFor(info.name);
              pending.push({ toolCallId: info.toolCallId, name: info.name, startedAt: Date.now() });
              this.emitter.emitPartial({ type: "tool.started", toolCallId: info.toolCallId, name: info.name, kind, args: {} });
            },
            onToolFinished: (info) => {
              // Queue hygiene only: the commit itself emits exactly once via
              // onToolActivity below (it carries the label + result; this
              // sink carries identity only). Emitting here too would double
              // every tool turn in the transcript.
              const at = pending.findIndex((e) => e.toolCallId === info.toolCallId);
              if (at >= 0) pending.splice(at, 1);
            },
          },
          onToolActivity: (label, result, isError) => {
            const m = label.match(/^⚙\s+(\S+)/);
            const parsedName = m ? m[1]! : "tool";
            // The queue head is this commit (commit order); a headless commit
            // (denied before start, tests driving the callback) falls back to
            // the label identity with zero duration — never dropped.
            const commit = shiftCommit();
            const name = commit?.name ?? parsedName;
            const kind = toolKindFor(name);
            const durationMs = commit ? Math.max(0, Date.now() - commit.startedAt) : 0;
            // Approve-time captures staged for this exact execution ride the
            // commit (transcript diff + `· via` provenance). The hook consumes
            // its slot; absent hooks mean headless mode (no captures).
            let extras: CommitExtras = {};
            try {
              extras = hooks.consumeCommitExtras?.(name) ?? {};
            } catch {
              extras = {};
            }
            if (isError) {
              this.emitter.emitPartial({ type: "tool.failed", toolCallId: commit?.toolCallId ?? `label:${label}`, name, kind, label, error: result, durationMs, diff: null, approvalVia: extras.approvalVia ?? null });
            } else {
              this.emitter.emitPartial({ type: "tool.completed", toolCallId: commit?.toolCallId ?? `label:${label}`, name, kind, label, result: result.slice(0, 4000), durationMs, diff: extras.diff ?? null, approvalVia: extras.approvalVia ?? null });
            }
          },
          onUsage: (u: import("./types.js").Usage) => {
            this.emitter.emitPartial({ type: "usage.reported", usage: u });
          },
        }
      );
      if (thinkingStarted) this.emitter.emitPartial({ type: "agent.thinking.completed", thinking: thinkingAccum });
      if (messageStarted) {
        this.emitter.emitPartial({ type: "message.completed", message: messageAccum || result });
      } else if (result.length > 0) {
        // No phantom triples for empty results: synthesize only when there
        // is actual content to deliver.
        this.emitter.emitPartial({ type: "message.started" });
        this.emitter.emitPartial({ type: "message.delta", delta: result, accumulated: result });
        this.emitter.emitPartial({ type: "message.completed", message: result });
      }
      this.history.push({ role: "assistant", content: result });
      this.emitter.emitPartial({ type: "agent.completed", result, at: new Date().toISOString() });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof LoopCancelledError || (e instanceof Error && e.name === "LoopCancelledError") || signal.aborted) {
        this.history.splice(rollbackTo);
        this.emitter.emitPartial({ type: "agent.cancelled", reason: msg });
      } else {
        this.history.splice(rollbackTo);
        if (thinkingAccum) this.emitter.emitPartial({ type: "agent.thinking.completed", thinking: thinkingAccum });
        if (messageAccum) this.emitter.emitPartial({ type: "message.completed", message: messageAccum });
        this.emitter.emitPartial({ type: "agent.error", error: msg });
      }
      throw e;
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  setHistory(next: ChatMessage[]): void { this.history = [...next]; }
  updateOpts(patch: Partial<CoreOpts>): void { this.opts = { ...this.opts, ...patch }; }
}


