// Normalized ToolCall model: the TUI's single source for tool presentation.
//
// Execution (src/tools/*, src/zen.ts) knows how to RUN a tool; the TUI
// only needs to SHOW it. This module is the boundary: App's onToolActivity
// (and the live tool-call-state machine) feed raw label/result/ms into the
// helpers here, which produce a `ToolCallModel` that every presenter
// consumes. No UI component imports `src/tools` or process execution details;
// no executor imports `src/ui` — the model is the contract.
//
// Lifecycle (prompt states): queued → running → success | failed | cancelled
// (denied is a calm variant of failed that renders with ⊘, not ✕). Per-kind
// families (terminal/file/search/web/todo/vision/generic) share the same
// header shape; specialized presenters only differ in their summary line.
import { theme } from "./theme.js";
import type { DiffPreview } from "./diff.js";
import type { Turn } from "./transcript.js";

export type ToolKind = "terminal" | "file" | "search" | "web" | "todo" | "vision" | "generic";
export type ToolStatus = "queued" | "running" | "success" | "failed" | "cancelled" | "denied";

export type ToolCallModel = {
  id?: string | number;
  kind: ToolKind;
  name: string;
  target: string;
  status: ToolStatus;
  durationMs?: number;
  summary: string | null;
  resultPreview: string | null;
  diff?: DiffPreview | null;
  approvalVia?: string | null;
  rawLabel: string;
  isError?: boolean;
};

// Map builtin tool names to presentation families. Custom/MCP names fall
// through to "generic" — the shell still renders them, just without a
// family-specific summary. Keep this list in sync with TOOL_DEFINITIONS
// (single source) but do NOT import that module: the UI must not depend on
// execution's registry.
export function getToolKind(name: string): ToolKind {
  const n = name.trim().toLowerCase();
  if (n === "bash" || n === "bash_output") return "terminal";
  if (n === "read" || n === "write" || n === "edit") return "file";
  if (n === "grep" || n === "glob") return "search";
  if (n === "webfetch" || n === "websearch") return "web";
  if (n === "todowrite" || n === "todo_get" || n === "todo_update") return "todo";
  // Vision is read with image mime, but name is still "read" — treat as file.
  // RAG/vision custom tools will surface as generic with their name.
  return "generic";
}

export function kindLabel(kind: ToolKind): string {
  switch (kind) {
    case "terminal": return theme.symbol.kindTerminal;
    case "file": return theme.symbol.kindFile;
    case "search": return theme.symbol.kindSearch;
    case "web": return theme.symbol.kindWeb;
    case "todo": return theme.symbol.kindTodo;
    case "vision": return theme.symbol.kindVision;
    case "generic": return theme.symbol.kindGeneric;
  }
}

export function parseLabel(label: string): { name: string; target: string } {
  const mark = `${theme.symbol.toolMark} `;
  const stripped = label.startsWith(mark) ? label.slice(mark.length) : label.trim();
  const space = stripped.indexOf(" ");
  if (space === -1) return { name: stripped, target: "" };
  return { name: stripped.slice(0, space), target: stripped.slice(space + 1).trim() };
}

export function statusGlyph(status: ToolStatus): string {
  switch (status) {
    case "queued": return theme.symbol.toolQueued;
    case "running": return theme.symbol.toolRunning;
    case "success": return theme.symbol.toolSuccess;
    case "failed": return theme.symbol.toolFailed;
    case "cancelled": return theme.symbol.toolCancelled;
    case "denied": return theme.symbol.toolDenied;
  }
}

export function statusColor(status: ToolStatus): string | undefined {
  switch (status) {
    case "queued": return undefined; // dim
    case "running": return theme.color.warning;
    case "success": return theme.color.success;
    case "failed": return theme.color.error;
    case "cancelled": return theme.color.warning;
    case "denied": return theme.color.warning;
  }
}

// Widget frame color per lifecycle status (single source for the committed
// ToolCall box + the live tail box + the inspector rows). Reads the
// phase-0 `border.tool` tokens — never literals.
export function borderColorFor(status: ToolStatus): string {
  switch (status) {
    case "success": return theme.border.tool.ok;
    case "failed": return theme.border.tool.fail;
    case "denied":
    case "cancelled": return theme.border.tool.denied;
    case "running": return theme.border.tool.running;
    case "queued": return theme.border.tool.queued;
  }
}

// Inline output preview budget: the widget shows at most this many result
// lines; the full text lives in the Ctrl+O inspector (committed <Static>
// rows freeze, so in-place expand can never happen in scrollback).
export const TOOL_PREVIEW_LINES = 6;
export const TOOL_PREVIEW_CHARS = 600;

export function statusText(status: ToolStatus): string {
  switch (status) {
    case "queued": return "queued";
    case "running": return "running";
    case "success": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "denied": return "denied";
  }
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms === null || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

// Compact summary per family. The conversation never dumps raw output;
// this is the one line that *does* appear under the header. The full
// result lives in the inspector (Ctrl+O).
function summarizeTerminal(name: string, target: string, result: string | null, isError?: boolean): string | null {
  if (!result) return target || null;
  if (isError) {
    const first = result.split("\n", 1)[0] ?? "";
    return first.length > 80 ? `${first.slice(0, 77)}…` : first;
  }
  // Try to surface test-like counts: "143 passed", "2 failed", "3 skipped"
  const passed = result.match(/(\d+)\s+passed/i);
  const failed = result.match(/(\d+)\s+failed/i);
  if (passed || failed) {
    const parts: string[] = [];
    if (passed) parts.push(`${passed[1]} passed`);
    if (failed) parts.push(`${failed[1]} failed`);
    return parts.join(` ${theme.symbol.separator} `) || target || null;
  }
  // Fallback: first non-empty line of output, truncated
  const first = result.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = first.trim();
  if (!trimmed) return target || null;
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}

function summarizeFile(name: string, target: string, result: string | null, isError?: boolean): string | null {
  if (isError && result) {
    const first = result.split("\n", 1)[0] ?? "";
    return first.length > 100 ? `${first.slice(0, 97)}…` : first;
  }
  // Proof the call worked without dumping content: a committed read shows
  // how much came back (`50 lines`); the diff (when present) renders
  // separately and the full text lives in the Ctrl+O inspector.
  if (result) {
    const lines = result.split("\n").filter((l) => l.trim().length > 0).length;
    if (lines > 0) return `${lines} line${lines === 1 ? "" : "s"}`;
  }
  return target || null;
}

function summarizeSearch(name: string, target: string, result: string | null): string | null {
  if (!result) return target || null;
  const lines = result.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return target || null;
  // grep with count/files_with_matches
  if (name === "grep" && /^\d+$/.test(lines[0]!.trim())) return `${lines[0]!.trim()} matches`;
  return `${lines.length} result${lines.length === 1 ? "" : "s"}`;
}

function summarizeWeb(name: string, target: string, result: string | null): string | null {
  if (!result) return target || null;
  const lines = result.split("\n").filter((l) => l.trim().length > 0);
  return `${lines.length} lines`;
}

function summarizeTodo(target: string, result: string | null): string | null {
  if (!result) return target || null;
  // todowrite echoes full list; count by status bracket to avoid double-counting symbol+word (○ + pending = 2 per todo)
  const pending = (result.match(/\[pending\]/gi) || []).length;
  const inProgress = (result.match(/\[in_progress\]/gi) || []).length;
  const done = (result.match(/\[completed\]/gi) || []).length;
  const total = pending + inProgress + done;
  if (total === 0) return target || null;
  const parts: string[] = [];
  if (done) parts.push(`${done} done`);
  if (inProgress) parts.push(`${inProgress} in-progress`);
  if (pending) parts.push(`${pending} pending`);
  return parts.join(` ${theme.symbol.separator} `);
}

function summarizeAsk(target: string, result: string | null): string | null {
  if (!result) return target || null;
  try {
    const parsed = JSON.parse(result) as { answer?: unknown; answers?: unknown };
    if (typeof parsed.answer === "string" && parsed.answer.length > 0) {
      const a = parsed.answer.length > 80 ? `${parsed.answer.slice(0, 77)}…` : parsed.answer;
      return a;
    }
    if (Array.isArray(parsed.answers)) {
      const list = (parsed.answers as unknown[]).filter((x): x is string => typeof x === "string");
      if (list.length === 0) return target || null;
      const joined = list.join(` ${theme.symbol.separator} `);
      return joined.length > 100 ? `${joined.slice(0, 97)}…` : joined;
    }
  } catch {
    // Not JSON — fall through to target.
  }
  return target || null;
}

export function deriveSummary(kind: ToolKind, name: string, target: string, result: string | null, isError?: boolean): string | null {
  if (name === "ask_question") return summarizeAsk(target, result);
  switch (kind) {
    case "terminal": return summarizeTerminal(name, target, result, isError);
    case "file": return summarizeFile(name, target, result, isError);
    case "search": return summarizeSearch(name, target, result);
    case "web": return summarizeWeb(name, target, result);
    case "todo": return summarizeTodo(target, result);
    case "vision": return target || null;
    case "generic": return target || (result ? result.split("\n", 1)[0] ?? null : null);
  }
}

// Build a model from a committed transcript Turn (plus optional paired label
// and diff). Pure — no fs, no execution imports. This is what the TUI
// consumes; execution only produced the label/result.
export function modelFromTurn(turn: Turn, label?: Turn | null, result?: string | null): ToolCallModel {
  const rawLabel = label ? label.content : turn.content;
  const { name, target } = parseLabel(rawLabel);
  const kind = getToolKind(name);
  // Status: cancelled check first (legacy "(cancelled)" line), then denied,
  // then error flag, then success. `turn` is the error detail when paired;
  // otherwise the success/audit line itself carries the error flag.
  const content = turn.content;
  const isCancelled = content.startsWith("(cancelled)") || (result ? result.startsWith("(cancelled)") : false);
  let status: ToolStatus;
  if (isCancelled) status = "cancelled";
  else if (turn.error) {
    const detail = result ?? turn.content;
    if (/denied by user/i.test(detail) || /denied by user/i.test(`${rawLabel} ${detail}`)) status = "denied";
    else status = "failed";
  } else {
    // Warnings, retries, todo echoes are not errors — treat as success header
    // with appropriate dim handling downstream; the classifier will handle
    // error cards separately.
    status = "success";
  }
  const durationMs = label?.ms ?? turn.ms;
  const approvalVia = label?.approvalVia ?? turn.approvalVia ?? null;
  const diff = label?.diff ?? turn.diff ?? null;
  // Result preview for summary: prefer explicit result arg, else empty.
  // A precomputed display summary on the turn (attached at commit time by
  // onToolActivity / the agent adapter) wins — it was derived from the full
  // result, which the transcript never retains.
  const preview = result ?? null;
  const summary = turn.summary ?? deriveSummary(kind, name, target, preview, turn.error);
  return {
    kind,
    name,
    target,
    status,
    durationMs,
    summary,
    resultPreview: preview ? preview.slice(0, TOOL_PREVIEW_CHARS) : null,
    diff: diff ?? null,
    approvalVia,
    rawLabel,
    isError: !!turn.error,
  };
}

// Live model for the spinner/progress line (queued/running). The hint may
// be a bare name ("read") or a full label ("⚙ read src/zen.ts").
export function modelForLive(hint: string | null, elapsedMs: number | null, status: "queued" | "running" = "running"): ToolCallModel | null {
  if (!hint) return null;
  let name = hint.trim();
  let target = "";
  if (hint.startsWith(`${theme.symbol.toolMark} `)) {
    const parsed = parseLabel(hint);
    name = parsed.name;
    target = parsed.target;
  } else if (hint.includes(" ")) {
    // "read src/zen.ts" without glyph — split
    const sp = hint.indexOf(" ");
    name = hint.slice(0, sp);
    target = hint.slice(sp + 1).trim();
  }
  const kind = getToolKind(name);
  return {
    kind,
    name,
    target,
    status,
    durationMs: elapsedMs ?? undefined,
    summary: target || null,
    resultPreview: null,
    rawLabel: hint,
  };
}
