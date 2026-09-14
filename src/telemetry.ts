// Local observability telemetry for ATOM (production-quality, not a debug page).
//
// What this module is: a lightweight, privacy-conscious, persistent trace of
// what the agent actually did — sessions, turns, loop iterations, model calls
// (with API-reported token usage only), tool calls (with measured durations
// and success/error classification), retries, and turn outcomes. The local
// HTML dashboard (src/telemetry-dashboard.ts) renders these traces.
//
// What this module is NOT:
// - No estimates, ever. Every numeric field is either measured (timestamps,
//   durations, counts, API-reported token usage) or absent. Absent means
//   "not reported" — the dashboard renders it as n/a, never zero.
// - No cost synthesis. No provider API reports cost, so cost fields stay null
//   (with an explicit note) unless a future provider reports them. There is
//   deliberately no pricing table to multiply tokens by.
// - No tool-level token attribution. Tools don't consume model tokens; usage
//   is recorded per model call (the POST that reported it) and aggregated per
//   turn/session. Tool rows show tokens as n/a with that explanation.
// - No network, no exfiltration. Traces live under ~/.atom/telemetry/
//   (ATOM_HOME override honored, 0600 POSIX perms like auth.json/session.json,
//   best-effort Windows), written atomically (temp file + rename) on turn
//   boundaries — never per token. Everything here is best-effort and NEVER
//   throws: a telemetry failure must never break a turn.
//
// Privacy: stored previews are truncated (see caps below) and scrubbed of
// known provider secrets (env-provided values via the injected secrets
// provider). API keys are never stored. Full file contents, full tool results,
// and full prompts are never persisted — only short previews plus byte sizes,
// so a trace stays small and reviewable. Opt out entirely with
// ATOM_TELEMETRY=0 or `"telemetry": {"enabled": false}` in atom.json.
//
// Performance: recording is in-memory pushes plus Date.now() reads (sub-
// microsecond each, no I/O in the hot path). The only disk write is one small
// atomic JSON write per completed/failed turn plus session end — typically a
// few KB. When disabled, every method is a no-op early return.
//
// Vocabulary mapping (ATOM concepts → observability terms):
// - session  = one App mount (process lifetime). /clear and /new stay inside
//   the same telemetry session as events; the trace never rewrites history.
// - turn     = one user message plus the full agentic loop it triggered.
// - iteration = one tool-round step of the loop (the `step` index in
//   runLoopWithChat): exactly one model call followed by zero or more tool
//   calls. Displayed 1-based.
// - model call = one chatFn invocation (one chat POST, including its internal
//   transport retries — retry phase events attach to the call they precede).
// - tool call = one runOneTool execution (serial or one member of a parallel
//   batch; each member is timed individually).
// - subagent = a delegated worker (delegate tool). ATOM v1 runs a single
//   agent loop (depth 1), so this list is normally empty — the dashboard says
//   so explicitly instead of implying activity. The type and hook exist so a
//   future delegate tool wires in with one call.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { scrubSecrets } from "./policy.js";
import { atomDir } from "./auth.js";

export const TELEMETRY_VERSION = 2;
export const TELEMETRY_DIRNAME = "telemetry";
export const TELEMETRY_SESSIONS_DIRNAME = "sessions";
export const TELEMETRY_DASHBOARD_FILENAME = "dashboard.html";

// Preview caps: traces stay small and reviewable. The full text already lives
// in history/transcript for the live session; telemetry keeps a scrubbed head
// plus the full byte size so nothing is silently misrepresented.
export const TELEMETRY_INPUT_PREVIEW_CHARS = 500;
export const TELEMETRY_ARGS_PREVIEW_CHARS = 2000;
export const TELEMETRY_RESULT_PREVIEW_CHARS = 2000;
// Store retention (best-effort prune on flush): newest files win.
export const TELEMETRY_MAX_SESSION_FILES = 200;
export const TELEMETRY_MAX_SESSION_AGE_DAYS = 90;

// Token usage, structurally mirroring zen.ts Usage but standalone (this module
// must not import zen at runtime — zen imports only the sink TYPES from here,
// type-only, so the loop keeps zero runtime dependency on telemetry).
// Only API-reported values are ever set; absent = not reported, never zero.
export type TokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type TurnOutcome =
  | "completed"
  | "blocked"
  | "unverified"
  | "budget-exceeded"
  | "failed"
  | "cancelled"
  | "pending";

export type ToolErrorKind =
  | "unknown-tool"
  | "invalid-args"
  | "denied"
  | "tool-error"
  | "timed-out"
  | "cancelled"
  | "transport-error";

export type RetryTrace = {
  at: string;
  attempt: number | null;
  delayMs: number | null;
  status: number | null;
  detail: string;
};

export type ModelCallTrace = {
  id: string;
  seq: number;
  iteration: number;
  provider: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  // Present only when the response carried a usage payload (usageReported).
  usage?: TokenUsage;
  usageReported: boolean;
  reasoningLabel?: string;
  toolCallCount: number;
  finishReason: "final" | "tool_calls" | "error";
  error?: string;
  retries: RetryTrace[];
  // Total cost for this call in USD. Null until a provider reports cost —
  // never synthesized (see module header).
  costUsd: number | null;
};

export type ToolCallTrace = {
  id: string;
  seq: number;
  iteration: number;
  // Provider-assigned tool_call_id (e.g. "call_abc" or "stream-0").
  providerToolCallId: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  success: boolean;
  errorKind?: ToolErrorKind;
  argsPreview: string;
  argsTruncated: boolean;
  argsChars: number;
  resultPreview: string;
  resultTruncated: boolean;
  resultChars: number;
  batchIndex: number;
  batchSize: number;
};

export type IterationTrace = {
  step: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  modelCallId: string | null;
  toolCallIds: string[];
};

// Goal snapshot carried on a turn trace (ticket 09): the live goal as the
// turn opened it — objective verbatim (capped), the active/paused flag, and
// the cumulative counters as they stood then. Optional like every other
// enrichment: absent reads as no-goal (older sessions, non-goal turns).
// Measured or reported only — counters copy finite values, never estimates.
export type TurnGoalSummary = {
  objective: string;
  active: boolean;
  turns?: number;
  requests?: number;
  tokens?: number;
  workMs?: number;
};

export type TurnTrace = {
  id: string;
  seq: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputPreview: string;
  inputChars: number;
  inputTruncated: boolean;
  provider: string;
  model: string;
  effort: string;
  mode: string;
  outcome: TurnOutcome;
  replyPreview: string | null;
  partialReplyPreview?: string | null;
  error: string | null;
  iterations: IterationTrace[];
  modelCalls: ModelCallTrace[];
  toolCalls: ToolCallTrace[];
  // Live-goal snapshot for this turn (see TurnGoalSummary). Absent when no
  // goal was live at turn start — never a fake claim.
  goal?: TurnGoalSummary;
  // Accumulated API-reported usage for this turn's main-loop POSTs only
  // (compaction summary spend is session-level — see TelemetrySession).
  usage: TokenUsage;
  usageReported: boolean;
  retryCount: number;
  // Loop-harness summary for this turn (see LoopStats in src/agent/types.ts):
  // measured rollup reported once per turn via recordLoopStats — cache hits,
  // guard interventions, bottleneck, context growth. Absent when the turn
  // predates the hook or the loop never reported (older sessions, failed
  // POSTs before the first tool round). Present-only, never synthesized.
  loop?: TurnLoopSummary;
};

// Measured per-turn loop-harness rollup. Mirrors LoopStats
// (src/agent/types.ts) without importing it — this module must not import
// agent code at runtime (zen imports only the sink types from here,
// type-only). Every field is measured; absent turn.loop means "not reported".
export type TurnLoopSummary = {
  cacheHits: number;
  repetitionHits: number;
  failures: number;
  truncations: number;
  contextGrowthChars: number;
  loopDurationMs: number;
  bottleneckName?: string;
  bottleneckMs?: number;
  slowestModelName?: string;
  slowestModelMs?: number;
  modelTotalMs?: number;
  toolTotalMs?: number;
  dominantPhase?: "model" | "tool";
};

export type SubagentTrace = {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "completed" | "failed" | "running";
  summaryPreview: string | null;
};

export type SessionEvent = {
  at: string;
  kind: "clear" | "new" | "compact" | "resume" | "provider-switch" | "model-switch" | "info";
  detail: string;
  usage?: TokenUsage;
};

export type TelemetrySession = {
  version: number;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  atomVersion: string | null;
  project: string | null;
  provider: string;
  model: string;
  turns: TurnTrace[];
  subagents: SubagentTrace[];
  events: SessionEvent[];
  // API-reported spend from compaction summary POSTs (kept separate from
  // turn usage so the dashboard can label the source honestly).
  compactionUsage: TokenUsage;
  compactionReported: boolean;
};

// --- Loop sink (the ONLY coupling between zen.ts and this module) ---
//
// zen.ts imports these types type-only and calls the hooks synchronously at
// completion points, each guarded so observer errors never break the loop.
// No start hooks: retries observed via onPhase("retry") in the App attach to
// the next completed model call in the same turn (retries always precede the
// completion of the call they belong to — same chatFn invocation).
export type SinkModelCallInfo = {
  step: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  usage?: TokenUsage;
  usageReported: boolean;
  reasoningLabel?: string;
  toolCallCount: number;
  finishReason: "final" | "tool_calls" | "error";
  error?: string;
};

export type SinkToolCallInfo = {
  step: number;
  toolCallId: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  argsJson: string;
  result: string;
  /** Structured kind from the single classification point (issue 03).
   * When present telemetry decides from it, never by parsing `result`. */
  resultKind?: import("./agent/tool-result.js").ToolResultKind;
  // Set when the call never produced a result string: a whole-turn cancel or
  // a throwing executor (executeTool itself returns error strings, never
  // throws — only custom executors and cancels take this path).
  cancelled?: boolean;
  threw?: boolean;
  batchIndex: number;
  batchSize: number;
};

export type LoopTelemetrySink = {
  onModelCall?: (info: SinkModelCallInfo) => void;
  onToolCall?: (info: SinkToolCallInfo) => void;
};

// --- Pure helpers ---

function toIso(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

// Keep only API-reported usage fields (mirrors zen.ts parseUsage semantics:
// present-only, never synthesized). Returns undefined when nothing usable.
export function cleanUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const out: TokenUsage = {};
  const prompt = finiteCount(o["prompt_tokens"]);
  if (prompt !== undefined) out.prompt_tokens = prompt;
  const completion = finiteCount(o["completion_tokens"]);
  if (completion !== undefined) out.completion_tokens = completion;
  const total = finiteCount(o["total_tokens"]);
  if (total !== undefined) out.total_tokens = total;
  const read = finiteCount(o["cacheReadTokens"]);
  if (read !== undefined) out.cacheReadTokens = read;
  const written = finiteCount(o["cacheWriteTokens"]);
  if (written !== undefined) out.cacheWriteTokens = written;
  return out.prompt_tokens !== undefined ||
    out.completion_tokens !== undefined ||
    out.total_tokens !== undefined ||
    out.cacheReadTokens !== undefined ||
    out.cacheWriteTokens !== undefined
    ? out
    : undefined;
}

// Keep only a well-formed goal snapshot (tolerant reader/writer pair with
// the dashboard: absent or malformed reads as no-goal, never a throw).
// Returns undefined when no goal was live. The objective is capped so a
// pasted paragraph cannot bloat the trace; counters copy finite values only.
export function cleanGoalSnapshot(value: unknown): TurnGoalSummary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const objective = o["objective"];
  if (typeof objective !== "string" || objective.length === 0) return undefined;
  const snap: TurnGoalSummary = {
    objective:
      objective.length > TELEMETRY_INPUT_PREVIEW_CHARS
        ? objective.slice(0, TELEMETRY_INPUT_PREVIEW_CHARS)
        : objective,
    active: o["active"] === true,
  };
  const counter = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const turns = counter(o["turns"]);
  if (turns !== undefined) snap.turns = turns;
  const requests = counter(o["requests"]);
  if (requests !== undefined) snap.requests = requests;
  const tokens = counter(o["tokens"]);
  if (tokens !== undefined) snap.tokens = tokens;
  const workMs = counter(o["workMs"]);
  if (workMs !== undefined) snap.workMs = workMs;
  return snap;
}

export function addUsageInto(target: TokenUsage, extra: TokenUsage | undefined): boolean {
  if (!extra) return false;
  let touched = false;
  (["prompt_tokens", "completion_tokens", "total_tokens", "cacheReadTokens", "cacheWriteTokens"] as const).forEach(
    (k) => {
      const v = extra[k];
      if (v !== undefined) {
        target[k] = (target[k] ?? 0) + v;
        touched = true;
      }
    }
  );
  return touched;
}

// Classify a tool result (issue 03): when `opts.kind` is present the
// decision reads the kind — never the wording. The string fallback below
// is the legacy path for callers without a kind; its only prose-sniffing
// lives here beside the single point (tool-result.ts), and new code must
// pass `kind` instead.
export function classifyToolResult(
  result: string,
  opts?: { cancelled?: boolean; threw?: boolean; kind?: import("./agent/tool-result.js").ToolResultKind }
): { success: boolean; errorKind?: ToolErrorKind } {
  if (opts?.cancelled) return { success: false, errorKind: "cancelled" };
  if (opts?.threw) return { success: false, errorKind: "transport-error" };
  if (opts?.kind !== undefined) {
    switch (opts.kind) {
      case "ok":
        return { success: true };
      case "unknown-tool":
        return { success: false, errorKind: "unknown-tool" };
      case "invalid-args":
        return { success: false, errorKind: "invalid-args" };
      case "denied":
        return { success: false, errorKind: "denied" };
      case "timed-out":
        return { success: false, errorKind: "timed-out" };
      case "failed":
        return { success: false, errorKind: "tool-error" };
    }
  }
  if (typeof result !== "string" || !result.startsWith("Error")) {
    return { success: true };
  }
  if (result.includes("unknown tool")) return { success: false, errorKind: "unknown-tool" };
  if (result.includes("invalid call") || result.includes("invalid JSON")) {
    return { success: false, errorKind: "invalid-args" };
  }
  if (result.includes("denied by user") || result.includes("blocked by")) return { success: false, errorKind: "denied" };
  if (/timed out/i.test(result)) return { success: false, errorKind: "timed-out" };
  return { success: false, errorKind: "tool-error" };
}

// Map a turn's ending to an outcome. Cancelled/failed come from the control
// flow; the blocked/unverified/budget labels come from the loop's own
// end-of-turn notices (same strings the transcript shows).
export function classifyTurnOutcome(
  reply: string,
  opts?: { cancelled?: boolean; error?: string }
): TurnOutcome {
  if (opts?.cancelled) return "cancelled";
  if (opts?.error) return "failed";
  const text = typeof reply === "string" ? reply : "";
  if (text.includes("(stopped: too many tool steps)")) return "budget-exceeded";
  if (text.includes("(blocked:")) return "blocked";
  if (text.includes("(unverified:")) return "unverified";
  return "completed";
}

// Parse the retry detail strings chatCompletion emits via onPhase("retry"):
// `attempt 1/2 after 1000ms (HTTP 429)` or `attempt 1/2 after 1000ms (<msg>)`.
// Best-effort: unparseable details still record with null fields + raw text.
export function parseRetryDetail(detail: string): { attempt: number | null; delayMs: number | null; status: number | null } {
  const out = { attempt: null as number | null, delayMs: null as number | null, status: null as number | null };
  if (typeof detail !== "string") return out;
  const attempt = /attempt\s+(\d+)\s*\//i.exec(detail);
  if (attempt) {
    const n = Number(attempt[1]);
    if (Number.isFinite(n)) out.attempt = Math.floor(n);
  }
  const delay = /after\s+(\d+)\s*ms/i.exec(detail);
  if (delay) {
    const n = Number(delay[1]);
    if (Number.isFinite(n)) out.delayMs = Math.floor(n);
  }
  const status = /HTTP\s+(\d{3})/i.exec(detail);
  if (status) {
    const n = Number(status[1]);
    if (Number.isFinite(n)) out.status = Math.floor(n);
  }
  return out;
}

function truncatePreview(text: string, cap: number): { preview: string; truncated: boolean; chars: number } {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (s.length <= cap) return { preview: s, truncated: false, chars: s.length };
  return { preview: s.slice(0, cap), truncated: true, chars: s.length };
}

function newSessionId(): string {
  try {
    return randomUUID();
  } catch {
    return `ses-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
  }
}

function projectBasename(): string | null {
  try {
    const base = path.basename(process.cwd());
    return typeof base === "string" && base.length > 0 ? base : null;
  } catch {
    return null;
  }
}

// --- Enablement ---

// Env override: ATOM_TELEMETRY=0/false/no/off disables; =1/true/yes/on
// enables. Returns undefined when unset/unrecognized (caller falls through).
export function telemetryEnvOverride(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = env["ATOM_TELEMETRY"];
  if (raw === undefined) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return undefined;
}

// Precedence: env override > atom.json telemetry.enabled > default (on).
export function resolveTelemetryEnabled(
  env: NodeJS.ProcessEnv = process.env,
  configValue?: boolean
): boolean {
  const override = telemetryEnvOverride(env);
  if (override !== undefined) return override;
  if (typeof configValue === "boolean") return configValue;
  return true;
}

// --- File store (all best-effort, never throw) ---

export function telemetryDir(home?: string): string {
  return path.join(atomDir(home), TELEMETRY_DIRNAME);
}

export function telemetrySessionsDir(home?: string): string {
  return path.join(telemetryDir(home), TELEMETRY_SESSIONS_DIRNAME);
}

export function telemetrySessionFilePath(sessionId: string, home?: string): string {
  const safe = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "unknown";
  return path.join(telemetrySessionsDir(home), `${safe}.json`);
}

export function telemetryDashboardFilePath(home?: string): string {
  return path.join(telemetryDir(home), TELEMETRY_DASHBOARD_FILENAME);
}

// Atomic save (temp file + rename, 0600 POSIX like session.json). Returns
// false (never throws) when disabled state, bad input, or disk errors.
export function saveTelemetrySession(session: TelemetrySession, home?: string): boolean {
  try {
    if (!session || typeof session.sessionId !== "string") return false;
    const dir = telemetrySessionsDir(home);
    mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${session.sessionId}.json`);
    const tmpPath = path.join(dir, `.${session.sessionId}.tmp.${process.pid}`);
    writeFileSync(tmpPath, JSON.stringify(session, null, 2) + "\n", "utf8");
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // best-effort on Windows; ignore
    }
    renameSync(tmpPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

// Load every session file, newest-first by startedAt. Skips missing dirs,
// unreadable files, and corrupt entries (counts them, never throws).
export function loadTelemetrySessions(home?: string): { sessions: TelemetrySession[]; corrupt: number } {
  const sessions: TelemetrySession[] = [];
  let corrupt = 0;
  try {
    const dir = telemetrySessionsDir(home);
    if (!existsSync(dir)) return { sessions, corrupt };
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return { sessions, corrupt };
    }
    for (const name of entries) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        const raw = readFileSync(path.join(dir, name), "utf8");
        const data: unknown = JSON.parse(raw);
        const session = validateTelemetrySession(data);
        if (session) sessions.push(session);
        else corrupt += 1;
      } catch {
        corrupt += 1;
      }
    }
  } catch {
    // never throw across the telemetry boundary
  }
  sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return { sessions, corrupt };
}

// Retention: drop files older than maxAgeDays, then oldest beyond maxFiles.
// Best-effort, never throws. Returns files removed.
export function pruneTelemetrySessions(
  home?: string,
  maxFiles: number = TELEMETRY_MAX_SESSION_FILES,
  maxAgeDays: number = TELEMETRY_MAX_SESSION_AGE_DAYS
): number {
  let removed = 0;
  try {
    const dir = telemetrySessionsDir(home);
    if (!existsSync(dir)) return 0;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const files: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of entries) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) {
        try {
          rmSync(full, { force: true });
          removed += 1;
        } catch {
          // ignore per-file failures
        }
      } else {
        files.push({ name, mtimeMs });
      }
    }
    if (files.length > maxFiles) {
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const f of files.slice(maxFiles)) {
        try {
          rmSync(path.join(dir, f.name), { force: true });
          removed += 1;
        } catch {
          // ignore per-file failures
        }
      }
    }
  } catch {
    // never throw
  }
  return removed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Lenient validation for stored sessions: shape-check the envelope and turn
// essentials, pass through the rest (a newer writer's extra fields survive a
// round trip through an older reader only if we don't strip them — but for
// the dashboard we only need the documented shape, so unknown fields are
// dropped rather than risk rendering garbage).
function validateTelemetrySession(data: unknown): TelemetrySession | null {
  if (!isRecord(data)) return null;
  const ver = data["version"];
  if (ver !== TELEMETRY_VERSION && ver !== 1) return null;
  const sessionId = data["sessionId"];
  const startedAt = data["startedAt"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  const turns = data["turns"];
  if (!Array.isArray(turns)) return null;
  const subagents = Array.isArray(data["subagents"]) ? (data["subagents"] as SubagentTrace[]) : [];
  const events = Array.isArray(data["events"]) ? (data["events"] as SessionEvent[]) : [];
  // v1 → v2 migration: inputTruncated defaults from preview length, loop
  // gains additive phase fields only when the writer reported them.
  const migratedTurns = (turns as TurnTrace[]).map((t) => {
    const rec = t as Record<string, unknown>;
    if (typeof rec["inputTruncated"] !== "boolean") {
      const preview = typeof rec["inputPreview"] === "string" ? (rec["inputPreview"] as string) : "";
      const chars = typeof rec["inputChars"] === "number" ? (rec["inputChars"] as number) : preview.length;
      (rec as Record<string, unknown>)["inputTruncated"] = chars > preview.length;
    }
    return t;
  });
  return {
    version: TELEMETRY_VERSION,
    sessionId,
    startedAt,
    endedAt: typeof data["endedAt"] === "string" ? (data["endedAt"] as string) : null,
    atomVersion: typeof data["atomVersion"] === "string" ? (data["atomVersion"] as string) : null,
    project: typeof data["project"] === "string" ? (data["project"] as string) : null,
    provider: typeof data["provider"] === "string" ? (data["provider"] as string) : "unknown",
    model: typeof data["model"] === "string" ? (data["model"] as string) : "unknown",
    turns: migratedTurns,
    subagents,
    events,
    compactionUsage: isRecord(data["compactionUsage"]) ? (data["compactionUsage"] as TokenUsage) : {},
    compactionReported: data["compactionReported"] === true,
  };
}

// --- Aggregates (pure; measured values only, null = unavailable) ---

export type ToolAggregate = {
  name: string;
  calls: number;
  succeeded: number;
  failed: number;
  totalDurationMs: number;
  avgDurationMs: number | null;
};

export type OutcomeCounts = Record<TurnOutcome, number>;

export type TelemetryAggregates = {
  sessions: number;
  turns: number;
  modelCalls: number;
  toolCalls: number;
  succeededToolCalls: number;
  failedToolCalls: number;
  // Null when no tool calls were recorded (a rate over zero calls would be fake).
  toolSuccessRate: number | null;
  usage: TokenUsage;
  usageReported: boolean;
  compactionUsage: TokenUsage;
  compactionReported: boolean;
  retries: number;
  // Loop-harness rollups summed over turns that reported them (absent
  // turn.loop contributes zero — never presented as a rate over zero turns).
  cacheHits: number;
  repetitionHits: number;
  // Goal-engaged turns: turns whose trace carries a goal snapshot (absent
  // goal reads as no-goal, so zero renders as omitted, never as a claim).
  goalTurns: number;
  outcomes: OutcomeCounts;
  byTool: ToolAggregate[];
  avgModelLatencyMs: number | null;
  totalModelLatencyMs: number;
  avgToolDurationMs: number | null;
  totalToolDurationMs: number;
  // Null until a provider reports cost — never synthesized (see header).
  costUsd: number | null;
  costNote: string;
};

export const TELEMETRY_COST_NOTE =
  "Cost is not reported by any provider API — shown as n/a. No estimates are synthesized.";

export function emptyOutcomes(): OutcomeCounts {
  return {
    completed: 0,
    blocked: 0,
    unverified: 0,
    "budget-exceeded": 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
  };
}

export function summarizeTelemetry(sessions: TelemetrySession[]): TelemetryAggregates {
  const agg: TelemetryAggregates = {
    sessions: sessions.length,
    turns: 0,
    modelCalls: 0,
    toolCalls: 0,
    succeededToolCalls: 0,
    failedToolCalls: 0,
    toolSuccessRate: null,
    usage: {},
    usageReported: false,
    compactionUsage: {},
    compactionReported: false,
    retries: 0,
    cacheHits: 0,
    repetitionHits: 0,
    goalTurns: 0,
    outcomes: emptyOutcomes(),
    byTool: [],
    avgModelLatencyMs: null,
    totalModelLatencyMs: 0,
    avgToolDurationMs: null,
    totalToolDurationMs: 0,
    costUsd: null,
    costNote: TELEMETRY_COST_NOTE,
  };
  const byTool = new Map<string, { calls: number; succeeded: number; failed: number; totalDurationMs: number }>();
  let modelLatencyCount = 0;
  let toolDurationCount = 0;
  try {
    for (const s of sessions) {
      if (!s || !Array.isArray(s.turns)) continue;
      if (s.compactionReported) {
        if (addUsageInto(agg.compactionUsage, s.compactionUsage)) agg.compactionReported = true;
      }
      for (const t of s.turns) {
        agg.turns += 1;
        if (t.outcome in agg.outcomes) agg.outcomes[t.outcome] += 1;
        if (t.goal && typeof t.goal.objective === "string" && t.goal.objective.length > 0) {
          agg.goalTurns += 1;
        }
        if (t.usageReported) {
          if (addUsageInto(agg.usage, t.usage)) agg.usageReported = true;
        }
        agg.retries += typeof t.retryCount === "number" ? t.retryCount : 0;
        if (t.loop) {
          if (typeof t.loop.cacheHits === "number" && t.loop.cacheHits > 0) {
            agg.cacheHits += Math.floor(t.loop.cacheHits);
          }
          if (typeof t.loop.repetitionHits === "number" && t.loop.repetitionHits > 0) {
            agg.repetitionHits += Math.floor(t.loop.repetitionHits);
          }
        }
        if (Array.isArray(t.modelCalls)) {
          for (const m of t.modelCalls) {
            agg.modelCalls += 1;
            // Note: retries are totaled from turn.retryCount below (each
            // retry increments it exactly once when observed). The per-call
            // m.retries arrays are the same events attributed to their call —
            // summing both would double-count.
            if (typeof m.durationMs === "number" && Number.isFinite(m.durationMs) && m.durationMs >= 0) {
              agg.totalModelLatencyMs += m.durationMs;
              modelLatencyCount += 1;
            }
            if (typeof m.costUsd === "number" && Number.isFinite(m.costUsd) && m.costUsd >= 0) {
              agg.costUsd = (agg.costUsd ?? 0) + m.costUsd;
            }
          }
        }
        if (Array.isArray(t.toolCalls)) {
          for (const c of t.toolCalls) {
            agg.toolCalls += 1;
            if (c.success) agg.succeededToolCalls += 1;
            else agg.failedToolCalls += 1;
            if (typeof c.durationMs === "number" && Number.isFinite(c.durationMs) && c.durationMs >= 0) {
              agg.totalToolDurationMs += c.durationMs;
              toolDurationCount += 1;
            }
            const name = typeof c.name === "string" && c.name.length > 0 ? c.name : "(unknown)";
            let entry = byTool.get(name);
            if (!entry) {
              entry = { calls: 0, succeeded: 0, failed: 0, totalDurationMs: 0 };
              byTool.set(name, entry);
            }
            entry.calls += 1;
            if (c.success) entry.succeeded += 1;
            else entry.failed += 1;
            if (typeof c.durationMs === "number" && Number.isFinite(c.durationMs) && c.durationMs >= 0) {
              entry.totalDurationMs += c.durationMs;
            }
          }
        }
      }
    }
  } catch {
    // aggregates are best-effort; return what accumulated
  }
  if (agg.toolCalls > 0) agg.toolSuccessRate = agg.succeededToolCalls / agg.toolCalls;
  if (modelLatencyCount > 0) agg.avgModelLatencyMs = agg.totalModelLatencyMs / modelLatencyCount;
  if (toolDurationCount > 0) agg.avgToolDurationMs = agg.totalToolDurationMs / toolDurationCount;
  agg.byTool = [...byTool.entries()]
    .map(([name, v]) => ({
      name,
      calls: v.calls,
      succeeded: v.succeeded,
      failed: v.failed,
      totalDurationMs: v.totalDurationMs,
      avgDurationMs: v.calls > 0 ? v.totalDurationMs / v.calls : null,
    }))
    .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return agg;
}

// App version stamped onto session records (Temp-session gap: every record
// carried atomVersion:null, so traces from different builds were
// indistinguishable). Resolved once from the package manifest beside the
// source tree — dist/ mirrors src/, so ../package.json holds in both
// layouts. Cached, never throws: null when unreadable keeps today's shape.
let cachedAtomVersion: string | null | undefined;
export function resolveAtomVersion(): string | null {
  if (cachedAtomVersion !== undefined) return cachedAtomVersion;
  try {
    const here = fileURLToPath(import.meta.url);
    const raw = readFileSync(path.join(path.dirname(here), "..", "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    cachedAtomVersion = typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    cachedAtomVersion = null;
  }
  return cachedAtomVersion;
}

// Test seam: drop the cached manifest read (production never calls this).
export function resetAtomVersion(): void {
  cachedAtomVersion = undefined;
}

// --- Recorder ---

export type TelemetryRecorderOptions = {
  home?: string;
  enabled?: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  project?: string | null;
  atomVersion?: string | null;
  secrets?: () => string[];
  now?: () => number;
};

export type TurnMeta = {
  provider: string;
  model: string;
  effort: string;
  mode: string;
  // Live-goal snapshot at turn start (absent/null = no goal). Copied onto
  // the turn trace verbatim (see TurnGoalSummary); corrupt shapes are
  // dropped, never stored.
  goal?: TurnGoalSummary | null;
};

// In-memory trace for one session plus atomic turn-boundary persistence.
// Every public method is safe to call with null/undefined turn ids and never
// throws; when disabled, all record methods are no-ops.
export class TelemetryRecorder {
  readonly sessionId: string;
  private readonly home: string | undefined;
  private readonly enabled: boolean;
  private readonly secrets: () => string[];
  private readonly now: () => number;
  private session: TelemetrySession;
  private turnSeq = 0;
  private modelSeq = 0;
  private toolSeq = 0;
  // Retries observed (via onPhase) before their model call completes.
  private pendingRetries: RetryTrace[] = [];
  private openTurns = new Map<string, TurnTrace>();

  constructor(opts: TelemetryRecorderOptions = {}) {
    this.home = opts.home;
    this.enabled = opts.enabled ?? true;
    this.secrets = opts.secrets ?? (() => []);
    this.now = opts.now ?? Date.now;
    this.sessionId =
      typeof opts.sessionId === "string" && opts.sessionId.length > 0 ? opts.sessionId : newSessionId();
    const startedMs = this.safeNow();
    this.session = {
      version: TELEMETRY_VERSION,
      sessionId: this.sessionId,
      startedAt: toIso(startedMs),
      endedAt: null,
      atomVersion: opts.atomVersion !== undefined ? opts.atomVersion : resolveAtomVersion(),
      project: opts.project !== undefined ? opts.project : projectBasename(),
      provider: opts.provider ?? "unknown",
      model: opts.model ?? "unknown",
      turns: [],
      subagents: [],
      events: [],
      compactionUsage: {},
      compactionReported: false,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private safeNow(): number {
    try {
      const n = this.now();
      return typeof n === "number" && Number.isFinite(n) ? n : Date.now();
    } catch {
      return Date.now();
    }
  }

  private scrub(text: string): string {
    try {
      const secrets = this.secrets();
      if (!Array.isArray(secrets) || secrets.length === 0) return text;
      return scrubSecrets(text, secrets);
    } catch {
      return text;
    }
  }

  setSessionMeta(meta: { provider?: string; model?: string }): void {
    try {
      if (!this.enabled) return;
      if (typeof meta.provider === "string" && meta.provider.length > 0) {
        if (this.session.provider !== meta.provider) {
          this.recordEvent("provider-switch", `${this.session.provider} → ${meta.provider}`);
        }
        this.session.provider = meta.provider;
      }
      if (typeof meta.model === "string" && meta.model.length > 0) {
        if (this.session.model !== meta.model) {
          this.recordEvent("model-switch", `${this.session.model} → ${meta.model}`);
        }
        this.session.model = meta.model;
      }
    } catch {
      // never throw
    }
  }

  startTurn(input: string, meta: TurnMeta): string | null {
    try {
      if (!this.enabled) return null;
      this.turnSeq += 1;
      const id = `t${this.turnSeq}`;
      const startedMs = this.safeNow();
      const scrubbed = this.scrub(typeof input === "string" ? input : "");
      const preview = truncatePreview(scrubbed, TELEMETRY_INPUT_PREVIEW_CHARS);
      const turn: TurnTrace = {
        id,
        seq: this.turnSeq,
        startedAt: toIso(startedMs),
        endedAt: null,
        durationMs: null,
        inputPreview: preview.preview,
        inputChars: typeof input === "string" ? input.length : 0,
        inputTruncated: preview.truncated,
        provider: meta.provider,
        model: meta.model,
        effort: meta.effort,
        mode: meta.mode,
        outcome: "pending",
        replyPreview: null,
        error: null,
        iterations: [],
        modelCalls: [],
        toolCalls: [],
        usage: {},
        usageReported: false,
        retryCount: 0,
      };
      const goalSnap = cleanGoalSnapshot(meta.goal);
      if (goalSnap) turn.goal = goalSnap;
      this.session.turns.push(turn);
      this.openTurns.set(id, turn);
      this.pendingRetries = [];
      return id;
    } catch {
      return null;
    }
  }

  recordUsage(turnId: string | null, usage: unknown): void {
    try {
      if (!this.enabled || !turnId) return;
      const turn = this.openTurns.get(turnId);
      if (!turn) return;
      const clean = cleanUsage(usage);
      if (clean && addUsageInto(turn.usage, clean)) turn.usageReported = true;
    } catch {
      // never throw
    }
  }

  recordRetry(turnId: string | null, detail: string): void {
    try {
      if (!this.enabled || !turnId) return;
      const turn = this.openTurns.get(turnId);
      if (!turn) return;
      const parsed = parseRetryDetail(detail);
      const retry: RetryTrace = {
        at: toIso(this.safeNow()),
        attempt: parsed.attempt,
        delayMs: parsed.delayMs,
        status: parsed.status,
        detail: typeof detail === "string" ? detail.slice(0, 500) : String(detail ?? "").slice(0, 500),
      };
      turn.retryCount += 1;
      // Buffer until the owning model call completes: zen reports completions
      // only, and the loop runs one in-flight POST at a time, so the next
      // recordModelCall in this turn is exactly the call these retries belong
      // to. recordModelCall drains the buffer; endTurn sweeps leftovers (a
      // failed POST) onto the last call for visibility.
      this.pendingRetries.push(retry);
    } catch {
      // never throw
    }
  }

  recordModelCall(turnId: string | null, info: SinkModelCallInfo): void {
    try {
      if (!this.enabled || !turnId || !info) return;
      const turn = this.openTurns.get(turnId);
      if (!turn) return;
      this.modelSeq += 1;
      const retries = this.pendingRetries;
      this.pendingRetries = [];
      const clean = cleanUsage(info.usage);
      if (clean && addUsageInto(turn.usage, clean)) turn.usageReported = true;
      const call: ModelCallTrace = {
        id: `m${this.modelSeq}`,
        seq: this.modelSeq,
        iteration: typeof info.step === "number" ? info.step : 0,
        provider: turn.provider,
        model: turn.model,
        startedAt: typeof info.startedAt === "string" ? info.startedAt : toIso(this.safeNow()),
        endedAt: typeof info.endedAt === "string" ? info.endedAt : toIso(this.safeNow()),
        durationMs:
          typeof info.durationMs === "number" && Number.isFinite(info.durationMs) && info.durationMs >= 0
            ? Math.floor(info.durationMs)
            : 0,
        usage: clean,
        usageReported: info.usageReported === true && clean !== undefined,
        reasoningLabel:
          typeof info.reasoningLabel === "string" && info.reasoningLabel.trim().length > 2
            ? info.reasoningLabel
            : undefined,
        toolCallCount: typeof info.toolCallCount === "number" ? info.toolCallCount : 0,
        finishReason: info.finishReason === "tool_calls" || info.finishReason === "error" ? info.finishReason : "final",
        error: typeof info.error === "string" ? info.error.slice(0, 500) : undefined,
        retries,
        costUsd: null,
      };
      turn.modelCalls.push(call);
      this.upsertIteration(turn, call.iteration, call.id, null);
    } catch {
      // never throw
    }
  }

  recordToolCall(turnId: string | null, info: SinkToolCallInfo): void {
    try {
      if (!this.enabled || !turnId || !info) return;
      const turn = this.openTurns.get(turnId);
      if (!turn) return;
      this.toolSeq += 1;
      const name = typeof info.name === "string" && info.name.length > 0 ? info.name : "(unknown)";
      const rawResult = typeof info.result === "string" ? info.result : "";
      const classified = classifyToolResult(rawResult, { cancelled: info.cancelled, threw: info.threw, kind: info.resultKind });
      const args = this.scrub(typeof info.argsJson === "string" ? info.argsJson : "{}");
      const result = this.scrub(rawResult);
      const argsT = truncatePreview(args, TELEMETRY_ARGS_PREVIEW_CHARS);
      const resultT = truncatePreview(result, TELEMETRY_RESULT_PREVIEW_CHARS);
      const call: ToolCallTrace = {
        id: `c${this.toolSeq}`,
        seq: this.toolSeq,
        iteration: typeof info.step === "number" ? info.step : 0,
        providerToolCallId: typeof info.toolCallId === "string" ? info.toolCallId : "",
        name,
        startedAt: typeof info.startedAt === "string" ? info.startedAt : toIso(this.safeNow()),
        endedAt: typeof info.endedAt === "string" ? info.endedAt : toIso(this.safeNow()),
        durationMs:
          typeof info.durationMs === "number" && Number.isFinite(info.durationMs) && info.durationMs >= 0
            ? Math.floor(info.durationMs)
            : 0,
        success: classified.success,
        errorKind: classified.success ? undefined : classified.errorKind,
        argsPreview: argsT.preview,
        argsTruncated: argsT.truncated,
        argsChars: argsT.chars,
        resultPreview: resultT.preview,
        resultTruncated: resultT.truncated,
        resultChars: resultT.chars,
        batchIndex: typeof info.batchIndex === "number" ? info.batchIndex : 0,
        batchSize: typeof info.batchSize === "number" && info.batchSize > 0 ? info.batchSize : 1,
      };
      turn.toolCalls.push(call);
      this.upsertIteration(turn, call.iteration, null, call.id);
    } catch {
      // never throw
    }
  }

  // Attach the loop-harness per-turn rollup (LoopStats from the agent loop,
  // wired via AgenticOpts.onLoopStats in the App). Merges onto the open turn;
  // later reports overwrite (the loop reports once, but a retry-safe merge
  // keeps the newest). No-op when disabled, unknown turn, or bad input.
  // Never throws. Safe to call before endTurn (success path) — endTurn keeps
  // turn.loop intact; failed/cancelled turns keep it too (what was attempted).
  recordLoopStats(turnId: string | null, summary: unknown): void {
    try {
      if (!this.enabled || !turnId) return;
      const turn = this.openTurns.get(turnId);
      if (!turn) return;
      if (typeof summary !== "object" || summary === null) return;
      const s = summary as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
      const signed = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
      const loop: TurnLoopSummary = {
        cacheHits: num(s["cacheHits"]) ?? 0,
        repetitionHits: num(s["repetitionHits"]) ?? 0,
        failures: num(s["failures"]) ?? 0,
        truncations: num(s["truncationNotices"] ?? s["truncations"]) ?? 0,
        contextGrowthChars: signed(s["contextGrowthChars"]) ?? 0,
        loopDurationMs: num(s["durationMs"] ?? s["loopDurationMs"]) ?? 0,
      };
      const bottleneck = s["bottleneck"] as Record<string, unknown> | null | undefined;
      const bName = typeof bottleneck?.["name"] === "string" ? (bottleneck["name"] as string) : undefined;
      const bMs =
        num(bottleneck?.["durationMs"] ?? bottleneck?.["ms"] ?? s["bottleneckMs"]) ?? undefined;
      if (bName && bName.length > 0) {
        loop.bottleneckName = bName.slice(0, 80);
        if (bMs !== undefined) loop.bottleneckMs = bMs;
      } else if (typeof s["bottleneckName"] === "string" && (s["bottleneckName"] as string).length > 0) {
        loop.bottleneckName = (s["bottleneckName"] as string).slice(0, 80);
        if (bMs !== undefined) loop.bottleneckMs = bMs;
      }
      const slowest = s["slowestModel"] as Record<string, unknown> | null | undefined;
      const sName = typeof slowest?.["id"] === "string" ? (slowest["id"] as string) : undefined;
      const sMs = num(slowest?.["durationMs"]) ?? undefined;
      if (sName && sName.length > 0) {
        loop.slowestModelName = sName.slice(0, 80);
        if (sMs !== undefined) loop.slowestModelMs = sMs;
      }
      const modelTotal = num(s["modelTotalMs"]) ?? undefined;
      if (modelTotal !== undefined) loop.modelTotalMs = modelTotal;
      const toolTotal = num(s["toolTotalMs"]) ?? undefined;
      if (toolTotal !== undefined) loop.toolTotalMs = toolTotal;
      const dom = s["dominantPhase"];
      if (dom === "model" || dom === "tool") loop.dominantPhase = dom;
      else if (modelTotal !== undefined || toolTotal !== undefined) {
        loop.dominantPhase = (modelTotal ?? 0) >= (toolTotal ?? 0) ? "model" : "tool";
      }
      turn.loop = loop;
    } catch {
      // never throw
    }
  }

  private upsertIteration(turn: TurnTrace, step: number, modelCallId: string | null, toolCallId: string | null): void {
    try {
      let iter = turn.iterations.find((i) => i.step === step);
      if (!iter) {
        const now = toIso(this.safeNow());
        iter = { step, startedAt: now, endedAt: now, durationMs: 0, modelCallId: null, toolCallIds: [] };
        turn.iterations.push(iter);
        turn.iterations.sort((a, b) => a.step - b.step);
      }
      if (modelCallId && !iter.modelCallId) {
        iter.modelCallId = modelCallId;
        const call = turn.modelCalls.find((m) => m.id === modelCallId);
        if (call) iter.startedAt = call.startedAt;
      }
      if (toolCallId) iter.toolCallIds.push(toolCallId);
      // Iteration window spans its model call start through its latest event end.
      const ends: string[] = [];
      const model = iter.modelCallId ? turn.modelCalls.find((m) => m.id === iter.modelCallId) : null;
      if (model) ends.push(model.endedAt);
      for (const id of iter.toolCallIds) {
        const tool = turn.toolCalls.find((c) => c.id === id);
        if (tool) ends.push(tool.endedAt);
      }
      if (ends.length > 0) {
        iter.endedAt = ends.sort().pop()!;
        try {
          const ms = Date.parse(iter.endedAt) - Date.parse(iter.startedAt);
          iter.durationMs = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
        } catch {
          iter.durationMs = 0;
        }
      }
    } catch {
      // never throw
    }
  }

  // Compaction summary spend is session-level (it summarizes many turns and
  // often runs after the turn that triggered it ended). Recorded separately
  // so per-turn usage stays exactly "this turn's main-loop POSTs".
  recordCompactionUsage(usage: unknown, kind: "auto" | "manual" = "manual"): void {
    try {
      if (!this.enabled) return;
      const clean = cleanUsage(usage);
      if (clean && addUsageInto(this.session.compactionUsage, clean)) {
        this.session.compactionReported = true;
        this.recordEvent("compact", `${kind} compaction summary spend recorded`);
      }
    } catch {
      // never throw
    }
  }

  recordSubagent(sub: { name: string; status: SubagentTrace["status"]; summary?: string; startedAt?: string; endedAt?: string }): void {
    try {
      if (!this.enabled || !sub) return;
      const now = toIso(this.safeNow());
      const summary = this.scrub(typeof sub.summary === "string" ? sub.summary : "");
      const preview = truncatePreview(summary, TELEMETRY_RESULT_PREVIEW_CHARS);
      let durationMs: number | null = null;
      try {
        if (sub.startedAt && sub.endedAt) {
          const ms = Date.parse(sub.endedAt) - Date.parse(sub.startedAt);
          durationMs = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : null;
        }
      } catch {
        durationMs = null;
      }
      this.session.subagents.push({
        id: `sub-${this.session.subagents.length + 1}`,
        name: typeof sub.name === "string" && sub.name.length > 0 ? sub.name : "(unknown)",
        startedAt: sub.startedAt ?? now,
        endedAt: sub.endedAt ?? null,
        durationMs,
        status: sub.status === "failed" || sub.status === "running" ? sub.status : "completed",
        summaryPreview: preview.preview.length > 0 ? preview.preview : null,
      });
    } catch {
      // never throw
    }
  }

  recordEvent(kind: SessionEvent["kind"], detail: string, usage?: unknown): void {
    try {
      if (!this.enabled) return;
      const clean = cleanUsage(usage);
      this.session.events.push({
        at: toIso(this.safeNow()),
        kind,
        detail: typeof detail === "string" ? detail.slice(0, 500) : String(detail ?? "").slice(0, 500),
        ...(clean ? { usage: clean } : {}),
      });
    } catch {
      // never throw
    }
  }

  endTurn(turnId: string | null, outcome: TurnOutcome, replyOrError?: string): void {
    try {
      if (!this.enabled || !turnId) return;
      const turn = this.openTurns.get(turnId);
      if (!turn) return;
      const endedMs = this.safeNow();
      turn.endedAt = toIso(endedMs);
      try {
        const ms = endedMs - Date.parse(turn.startedAt);
        turn.durationMs = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
      } catch {
        turn.durationMs = 0;
      }
      turn.outcome = outcome;
      if (outcome === "failed" || outcome === "cancelled") {
        turn.error =
          typeof replyOrError === "string" && replyOrError.length > 0
            ? replyOrError.slice(0, 500)
            : outcome === "cancelled"
              ? "(cancelled)"
              : "(failed)";
        // Preserve any streamed partial for post-mortem instead of nulling
        // the reply outright; dashboard renders partial distinctly.
        if (typeof replyOrError === "string" && replyOrError.length > 0) {
          const scrubbed = this.scrub(replyOrError);
          turn.partialReplyPreview = truncatePreview(scrubbed, TELEMETRY_INPUT_PREVIEW_CHARS).preview;
        } else {
          turn.partialReplyPreview = null;
        }
        turn.replyPreview = null;
        // Timeline entry for failed turns only: cancellations are
        // user-initiated noise, and the turn record already keeps the error.
        if (outcome === "failed") {
          this.recordEvent("info", `turn ${turn.id} ${outcome}: ${(turn.error ?? "").slice(0, 200)}`);
        }
      } else {
        const scrubbed = this.scrub(typeof replyOrError === "string" ? replyOrError : "");
        turn.replyPreview = truncatePreview(scrubbed, TELEMETRY_INPUT_PREVIEW_CHARS).preview;
        turn.error = null;
      }
      // Any retries that never met their completion (failed POST) stay on the
      // turn counter; attach leftovers to the last model call for visibility.
      if (this.pendingRetries.length > 0) {
        const last = turn.modelCalls.length > 0 ? turn.modelCalls[turn.modelCalls.length - 1]! : null;
        if (last) last.retries.push(...this.pendingRetries);
        this.pendingRetries = [];
      }
      this.openTurns.delete(turnId);
    } catch {
      // never throw
    }
  }

  endSession(): void {
    try {
      if (!this.enabled) return;
      if (!this.session.endedAt) this.session.endedAt = toIso(this.safeNow());
    } catch {
      // never throw
    }
  }

  getSnapshot(): TelemetrySession {
    try {
      return JSON.parse(JSON.stringify(this.session)) as TelemetrySession;
    } catch {
      return this.session;
    }
  }

  // True when nothing worth persisting was recorded: no turns, no events, no
  // subagents, no compaction spend. An untouched mount (open + close, e.g. a
  // crashed or immediately-exited process) leaves no file behind, so the
  // store never fills with phantom empty sessions.
  isEmpty(): boolean {
    try {
      return (
        this.session.turns.length === 0 &&
        this.session.events.length === 0 &&
        this.session.subagents.length === 0 &&
        !this.session.compactionReported
      );
    } catch {
      return true;
    }
  }

  // Persist the current session atomically + prune old files. Never throws.
  // Skips empty sessions (returns false, writes nothing).
  flush(): boolean {
    try {
      if (!this.enabled) return false;
      if (this.isEmpty()) return false;
      const ok = saveTelemetrySession(this.session, this.home);
      try {
        pruneTelemetrySessions(this.home);
      } catch {
        // prune is best-effort
      }
      return ok;
    } catch {
      return false;
    }
  }
}

export function createTelemetryRecorder(opts: TelemetryRecorderOptions = {}): TelemetryRecorder {
  try {
    return new TelemetryRecorder(opts);
  } catch {
    // Constructor never throws by design; this is belt-and-braces so a
    // telemetry failure can never break startup. Return a disabled recorder.
    return new TelemetryRecorder({ ...opts, enabled: false });
  }
}
