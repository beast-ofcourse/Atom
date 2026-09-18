// Session goal state (tickets 01–02): one in-memory goal per session.
// The shape stays extensible (dispositions arrive in later tickets)
// but v2 carries cumulative stats plus an `active` flag (cancel and spent
// budgets pause — never clear — so `/goal resume` can continue). All
// transitions and user-facing notices are pure here so they unit-test
// without the TUI; App.tsx owns the useState+useRef session mirror.
//
// `stats` stays optional so callers holding a bare `{ objective, active }`
// (ticket-01 literals) keep typechecking — absent stats read as zeros.
import type { ChatMessage, Usage } from "./agent/types.js";
import { toolSignature } from "./agent/normalize.js";
import { TODO_COMPACT_CHARS, TODO_COMPACT_MAX } from "./todo-shared.js";

export type GoalStats = {
  /** Turn-ends reached while a goal run was engaged (continuations + 1). */
  turns: number;
  /** Completed model POSTs observed while the goal was live. */
  requests: number;
  /** Sum of API-reported token counts (never estimated). */
  tokens: number;
  /** Wall-clock ms across goal turns (all outcomes — success/fail/cancel). */
  workMs: number;
};

export type GoalState = {
  objective: string;
  active: boolean;
  stats?: GoalStats;
  /** Advisory token budget (v1: recorded + surfaced, never hard-enforced). */
  tokenBudget?: number;
} | null;

// Disposition protocol (ticket 03): at the end of each goal turn the model
// reports `continue` (with the next action), `complete` (with a reason), or
// `blocked` (with a reason) through the goal-scoped update_goal tool. The
// loop records the report in a per-turn slot and consumes it at turn end
// BEFORE the auto-continue decision: terminal dispositions stop the run with
// a verdict, `continue` (or no report — the ticket-04 evaluator fallback)
// flows into the existing auto-continue. A `complete` first passes the
// ticket-06 honesty gate (unverified code or open todos continue the turn
// instead of stopping); `blocked` stops unconditionally.
export type GoalDispositionStatus = "continue" | "complete" | "blocked";

export type GoalDisposition =
  | { status: "continue"; next?: string }
  | { status: "complete"; reason: string; unverified?: string[] }
  | { status: "blocked"; reason: string };

// Declared-unverifiable checks on a `complete` report (ticket 06): checks
// the model could not run, recorded openly in the closing verdict — never a
// gate (they do not block completion). Bounded so a report stays a short
// transcript line, never a pasted log.
export const GOAL_UNVERIFIED_MAX_ITEMS = 10;
export const GOAL_UNVERIFIED_MAX_LENGTH = 200;

// Expected update_goal shape for validation details (mirrors the registry's
// expectedShape framing — the tool definition itself lives in src/tools.ts).
const UPDATE_GOAL_EXPECTED =
  `{"status": "continue" | "complete" | "blocked", "next"?: string, "reason"?: string, "unverified"?: string[]}`;

// Arg validation for update_goal (same detail-string contract as the
// registry validators — the loop wraps it with invalidCall, so bad args are
// a model mistake that records nothing). `continue` takes an optional
// non-empty next action; `complete`/`blocked` require a non-empty reason.
// `complete` also takes an optional `unverified` list of checks the model
// could not run (non-empty strings, capped in count and length — recorded
// openly in the verdict, never a gate). Unknown fields are ignored (same
// leniency as the registry validators).
export function validateUpdateGoalArgs(args: Record<string, unknown>): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return `arguments for tool "update_goal" must be an object. Expected ${UPDATE_GOAL_EXPECTED}`;
  }
  const a = args as Record<string, unknown>;
  const status = a["status"];
  if (status !== "continue" && status !== "complete" && status !== "blocked") {
    return (
      `field "status" for tool "update_goal" must be one of "continue", "complete", "blocked" ` +
      `(got ${JSON.stringify(status) ?? String(status)}). Expected ${UPDATE_GOAL_EXPECTED}`
    );
  }
  if (status === "continue") {
    const next = a["next"];
    if (next !== undefined && (typeof next !== "string" || next.trim().length === 0)) {
      return (
        `field "next" for tool "update_goal" must be a non-empty string when present ` +
        `(got ${JSON.stringify(next) ?? String(next)}). Expected ${UPDATE_GOAL_EXPECTED}`
      );
    }
    return null;
  }
  const reason = a["reason"];
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return (
      `field "reason" for tool "update_goal" with status "${status}" must be a non-empty string. ` +
      `Expected ${UPDATE_GOAL_EXPECTED}`
    );
  }
  if (status === "complete") {
    const unverified = a["unverified"];
    if (unverified !== undefined) {
      if (!Array.isArray(unverified)) {
        return (
          `field "unverified" for tool "update_goal" must be an array of non-empty strings ` +
          `when present. Expected ${UPDATE_GOAL_EXPECTED}`
        );
      }
      if (unverified.length > GOAL_UNVERIFIED_MAX_ITEMS) {
        return (
          `field "unverified" for tool "update_goal" must hold at most ` +
          `${GOAL_UNVERIFIED_MAX_ITEMS} items (got ${unverified.length}). Expected ${UPDATE_GOAL_EXPECTED}`
        );
      }
      for (const item of unverified) {
        if (typeof item !== "string" || item.trim().length === 0) {
          return (
            `field "unverified" for tool "update_goal" must be an array of non-empty strings. ` +
            `Expected ${UPDATE_GOAL_EXPECTED}`
          );
        }
        if (item.trim().length > GOAL_UNVERIFIED_MAX_LENGTH) {
          return (
            `field "unverified" for tool "update_goal" must hold items of at most ` +
            `${GOAL_UNVERIFIED_MAX_LENGTH} characters. Expected ${UPDATE_GOAL_EXPECTED}`
          );
        }
      }
    }
  }
  return null;
}

// Build the typed disposition from validated args (call only after
// validateUpdateGoalArgs returns null — anything else is a caller bug, and
// the unknown-status fallthrough below keeps it total rather than throwing).
export function updateGoalDisposition(args: Record<string, unknown>): GoalDisposition {
  const a = args as { status: GoalDispositionStatus; next?: unknown; reason?: unknown };
  if (a.status === "continue") {
    return typeof a.next === "string" ? { status: "continue", next: a.next } : { status: "continue" };
  }
  if (a.status === "complete") {
    const reason = a.reason as string;
    // Defensive carry: validation already capped count/length, but the
    // builder stays total on unvalidated input (judge verdicts, direct
    // callers) — trim, drop empties, cap, and omit when nothing remains.
    const raw = (a as { unverified?: unknown }).unverified;
    if (Array.isArray(raw)) {
      const items = raw
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, GOAL_UNVERIFIED_MAX_ITEMS);
      if (items.length > 0) return { status: "complete", reason, unverified: items };
    }
    return { status: "complete", reason };
  }
  if (a.status === "blocked") {
    return { status: "blocked", reason: a.reason as string };
  }
  return { status: "continue" };
}

// Same-value comparison for idempotence (absent next counts as empty —
// `{continue}` and `{continue, next:""}` can never both be valid anyway).
export function sameGoalDisposition(a: GoalDisposition, b: GoalDisposition): boolean {
  if (a.status === "continue" && b.status === "continue") {
    return (a.next ?? "") === (b.next ?? "");
  }
  if (a.status === "complete" && b.status === "complete") {
    if (a.reason !== b.reason) return false;
    const au = a.unverified ?? [];
    const bu = b.unverified ?? [];
    return au.length === bu.length && au.every((s, i) => s === bu[i]);
  }
  if (a.status === "blocked" && b.status === "blocked") {
    return a.reason === b.reason;
  }
  return false;
}

// Terminal verdict (ticket 03): the run's final text AND the pause notice —
// same `(…)` voice as the stop notices, carrying the model's reason. A
// `complete` may also carry declared-unverifiable checks (ticket 06): they
// print openly as a trailing `(unverified: …)` segment — recorded, never
// gated. Total: unvalidated input degrades to the bare verdict.
export function goalVerdictNotice(
  objective: string,
  status: "complete" | "blocked",
  reason: string,
  unverified?: string[]
): string {
  const base = `(goal ${status} — "${objective}": ${reason})`;
  if (status !== "complete" || !Array.isArray(unverified)) return base;
  const items = unverified
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, GOAL_UNVERIFIED_MAX_ITEMS);
  if (items.length === 0) return base;
  return `${base} (unverified: ${items.join(", ")})`;
}

// Success ack for a recorded report (a transcript-visible receipt —
// deliberately not an Error, so it never trips failure accounting).
export function goalReportAck(disposition: GoalDisposition): string {
  switch (disposition.status) {
    case "continue":
      return disposition.next !== undefined
        ? `(goal report recorded — "continue": ${disposition.next})`
        : `(goal report recorded — "continue")`;
    case "complete":
      return `(goal report recorded — "complete": ${disposition.reason})`;
    case "blocked":
      return `(goal report recorded — "blocked": ${disposition.reason})`;
  }
}

// Post-terminal rejection (ticket 03): the first terminal report sticks —
// anything after it changes nothing and reads as a notice (not an Error,
// so failure accounting stays quiet).
export function goalReportRejectedNotice(existing: GoalDisposition): string {
  return (
    `(update_goal already reported "${existing.status}" for this turn — ` +
    `keeping the first report; further reports change nothing)`
  );
}

// Outside-goal structured error (ticket 03): with no live goal turn there is
// nothing to record into, so the call changes zero state — the Error:
// framing keeps it repairable, never silent.
export function goalReportOutsideError(): string {
  return (
    `Error: update_goal is only available during an active goal turn ` +
    `(no active goal — set one with /goal <objective>). Nothing was recorded.`
  );
}

// Outside-session error for the lifecycle tools (Phase 2): without the
// per-turn lifecycle hooks (direct executeTool calls carry none) there is no
// live session state to mutate, so the call changes zero state — same
// repairable Error: framing as the report path above.
export function goalLifecycleOutsideError(tool: string): string {
  const name = typeof tool === "string" && tool.length > 0 ? tool : "goal tool";
  return (
    `Error: ${name} is only available during a session turn ` +
    `(no live session to record into — set one with /goal <objective>). Nothing was recorded.`
  );
}

export type GoalCommand =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "set"; objective: string };

// Pure arg parser: bare `/goal` (or whitespace-only) shows status,
// `/goal clear` / `/goal pause` / `/goal resume` (case-insensitive) manage
// the goal, everything else after `/goal ` is the objective verbatim (case
// preserved — it echoes back). A literal objective of "pause"/"resume"/
// "clear" reads as the command (same pre-existing ambiguity as "clear").
export function parseGoalCommand(raw: string): GoalCommand {
  const text = raw.trim();
  const rest = text === "/goal" ? "" : text.slice("/goal".length).trim();
  if (rest === "") return { kind: "status" };
  const lowered = rest.toLowerCase();
  if (lowered === "clear") return { kind: "clear" };
  if (lowered === "pause") return { kind: "pause" };
  if (lowered === "resume") return { kind: "resume" };
  return { kind: "set", objective: rest };
}

// Zero stats for a fresh goal (a set/replace always resets the counters).
export function emptyGoalStats(): GoalStats {
  return { turns: 0, requests: 0, tokens: 0, workMs: 0 };
}

// Read view: absent stats (ticket-01 literals) count as zeros — never throw.
export function goalStatsOf(goal: GoalState): GoalStats {
  const s = goal?.stats;
  return {
    turns: s?.turns ?? 0,
    requests: s?.requests ?? 0,
    tokens: s?.tokens ?? 0,
    workMs: s?.workMs ?? 0,
  };
}

// Token slice for one reported usage payload: total_tokens when the API
// sent it, else prompt + completion. Anything unreported counts as zero —
// goal spend, like session spend, is real reports only, never estimated.
export function goalTokensForUsage(u: Usage): number {
  const total = u.total_tokens;
  if (typeof total === "number" && Number.isFinite(total)) return Math.max(0, Math.floor(total));
  const prompt = typeof u.prompt_tokens === "number" && Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : 0;
  const completion =
    typeof u.completion_tokens === "number" && Number.isFinite(u.completion_tokens)
      ? u.completion_tokens
      : 0;
  return Math.max(0, Math.floor(prompt) + Math.floor(completion));
}

// Persisted goal record (ticket 07): the session save carries the live goal
// verbatim — objective, active flag, and cumulative stats — so a restart,
// /resume, or session switch restores exactly what was running. Stats are
// always concrete here (never optional): absent stats serialize as zeros and
// restore as zeros, and resuming never resets them (restore keeps the saved
// counters; only `/goal <objective>` starts fresh ones).
export type PersistedGoal = {
  objective: string;
  active: boolean;
  stats: GoalStats;
  /** Advisory token budget (optional: old saves carry none). */
  tokenBudget?: number;
};

// Serialize the live goal for a session save: a deep copy (the save must
// never alias live state), or null when no goal is live. Total: never throws.
export function serializeGoalForPersist(goal: GoalState): PersistedGoal | null {
  try {
    if (!goal) return null;
    if (typeof goal.objective !== "string" || goal.objective.length === 0) return null;
    const s = goal.stats ?? emptyGoalStats();
    const out: PersistedGoal = {
      objective: goal.objective,
      active: goal.active === true,
      stats: {
        turns: coerceGoalCounter(s.turns),
        requests: coerceGoalCounter(s.requests),
        tokens: coerceGoalCounter(s.tokens),
        workMs: coerceGoalCounter(s.workMs),
      },
    };
    const budget = coerceGoalBudget(goal.tokenBudget);
    if (budget !== undefined) out.tokenBudget = budget;
    return out;
  } catch {
    return null;
  }
}

// Restore a saved goal: valid records come back verbatim (counters intact,
// never reset); absent or corrupt data loads as no-goal (null) — never a
// throw, at most the caller's warning. Old saves without a goal key and
// records with a trashed stats block both land here safely.
export function restoreGoalFromPersist(value: unknown): GoalState {
  try {
    if (value === null || value === undefined) return null;
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    if (typeof r["objective"] !== "string" || (r["objective"] as string).length === 0) return null;
    if (typeof r["active"] !== "boolean") return null;
    const stats = r["stats"];
    if (stats === undefined) {
      const bare: GoalState = { objective: r["objective"] as string, active: r["active"] as boolean };
      const bareBudget = coerceGoalBudget(r["tokenBudget"]);
      if (bare && bareBudget !== undefined) bare.tokenBudget = bareBudget;
      return bare;
    }
    if (typeof stats !== "object" || stats === null || Array.isArray(stats)) return null;
    const s = stats as Record<string, unknown>;
    const restored: GoalState = {
      objective: r["objective"] as string,
      active: r["active"] as boolean,
      stats: {
        turns: coerceGoalCounter(s["turns"]),
        requests: coerceGoalCounter(s["requests"]),
        tokens: coerceGoalCounter(s["tokens"]),
        workMs: coerceGoalCounter(s["workMs"]),
      },
    };
    const restoredBudget = coerceGoalBudget(r["tokenBudget"]);
    if (restored && restoredBudget !== undefined) restored.tokenBudget = restoredBudget;
    return restored;
  } catch {
    return null;
  }
}

// Advisory budget from untrusted save data: positive integers survive,
// anything else reads as absent (a trashed budget must not trash the goal —
// the objective and counters still restore).
function coerceGoalBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return Math.min(value, GOAL_TOKEN_BUDGET_MAX);
}

// One counter from untrusted save data: finite, floored, never negative —
// anything else reads as zero (a trashed counter must not trash the goal).
function coerceGoalCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

// Compact counters for status lines: raw below 1K, one-decimal K above.
export function formatGoalTokens(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0";
  const v = Math.floor(n);
  if (v < 1000) return `${v}`;
  return `${(v / 1000).toFixed(1)}K`;
}

// Wall-clock rendering for status lines: 4s / 1m23s / 2h05m. Never throws.
export function formatGoalWorkMs(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

// Stats segment for the status line (zeros when absent — a fresh goal still
// shows the shape so the counters are discoverable).
export function goalStatsText(stats?: GoalStats): string {
  const s = stats ?? emptyGoalStats();
  return (
    `turns ${s.turns} · requests ${s.requests} · ` +
    `tokens ${formatGoalTokens(s.tokens)} · work ${formatGoalWorkMs(s.workMs)}`
  );
}

// Status line: goal text plus state plus cumulative stats, or the none-hint.
export function goalStatusText(goal: GoalState): string {
  if (!goal) return "(no goal — set one with /goal <objective>)";
  return `(goal [${goal.active ? "active" : "paused"}] — ${goal.objective} — ${goalStatsText(goal.stats)})`;
}

// Set confirmation: echoes the objective; replacing an active goal says so.
export function goalSetNotice(objective: string, previous: GoalState): string {
  if (previous) return `(goal replaced — "${previous.objective}" replaced with "${objective}")`;
  return `(goal set — "${objective}")`;
}

// Clear notice: ends the active goal, or a harmless no-op when absent.
export function goalClearNotice(previous: GoalState): string {
  if (!previous) return "(no goal — nothing to clear)";
  return `(goal cleared — "${previous.objective}")`;
}

// Manual pause/resume notices: state flips live in App; these only describe.
export function goalPauseNotice(previous: GoalState): string {
  if (!previous) return "(no goal — nothing to pause)";
  if (!previous.active) return `(goal already paused — "${previous.objective}")`;
  return `(goal paused — "${previous.objective}")`;
}

export function goalResumeNotice(previous: GoalState): string {
  if (!previous) return "(no goal — set one with /goal <objective>)";
  if (previous.active) return `(goal already active — "${previous.objective}")`;
  return `(goal resumed — "${previous.objective}")`;
}

// Lifecycle tool validators (goal-tools-refactor Phase 1): same
// detail-string contract as validateUpdateGoalArgs — the registry wraps them
// with invalidCall, so bad args are a model mistake that records nothing.
// Unknown fields are ignored (same leniency as the registry validators).
const CREATE_GOAL_EXPECTED = `{"objective": string, "token_budget"?: number}`;
const PAUSE_GOAL_EXPECTED = `{"reason"?: string}`;
const RESUME_GOAL_EXPECTED = `{}`;
const CLEAR_GOAL_EXPECTED = `{"reason"?: string}`;
const GET_GOAL_EXPECTED = `{}`;

// Advisory budget bound: finite positive integers only. Fractional or
// non-positive values are caller errors (a budget must name a token count);
export const GOAL_TOKEN_BUDGET_MAX = 10_000_000;

function goalBudgetDetail(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `field "token_budget" for tool "create_goal" must be a positive integer (got ${JSON.stringify(value) ?? String(value)}). Expected ${CREATE_GOAL_EXPECTED}`;
  }
  if (!Number.isInteger(value) || value <= 0) {
    return `field "token_budget" for tool "create_goal" must be a positive integer (got ${value}). Expected ${CREATE_GOAL_EXPECTED}`;
  }
  if (value > GOAL_TOKEN_BUDGET_MAX) {
    return `field "token_budget" for tool "create_goal" must be at most ${GOAL_TOKEN_BUDGET_MAX} (got ${value}). Expected ${CREATE_GOAL_EXPECTED}`;
  }
  return null;
}

function goalReasonDetail(tool: string, expected: string, reason: unknown): string | null {
  if (reason !== undefined && (typeof reason !== "string" || reason.trim().length === 0)) {
    return (
      `field "reason" for tool "${tool}" must be a non-empty string when present ` +
      `(got ${JSON.stringify(reason) ?? String(reason)}). Expected ${expected}`
    );
  }
  return null;
}

function requireArgsObject(tool: string, expected: string, args: Record<string, unknown>): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return `arguments for tool "${tool}" must be an object. Expected ${expected}`;
  }
  return null;
}

export function validateCreateGoalArgs(args: Record<string, unknown>): string | null {
  const badObj = requireArgsObject("create_goal", CREATE_GOAL_EXPECTED, args);
  if (badObj) return badObj;
  const objective = (args as Record<string, unknown>)["objective"];
  if (typeof objective !== "string" || objective.trim().length === 0) {
    return (
      `field "objective" for tool "create_goal" must be a non-empty string ` +
      `(got ${JSON.stringify(objective) ?? String(objective)}). Expected ${CREATE_GOAL_EXPECTED}`
    );
  }
  const budget = (args as Record<string, unknown>)["token_budget"];
  if (budget !== undefined) {
    const detail = goalBudgetDetail(budget);
    if (detail) return detail;
  }
  return null;
}

export function validateGetGoalArgs(args: Record<string, unknown>): string | null {
  return requireArgsObject("get_goal", GET_GOAL_EXPECTED, args);
}

export function validatePauseGoalArgs(args: Record<string, unknown>): string | null {
  const badObj = requireArgsObject("pause_goal", PAUSE_GOAL_EXPECTED, args);
  if (badObj) return badObj;
  return goalReasonDetail("pause_goal", PAUSE_GOAL_EXPECTED, (args as Record<string, unknown>)["reason"]);
}

export function validateResumeGoalArgs(args: Record<string, unknown>): string | null {
  return requireArgsObject("resume_goal", RESUME_GOAL_EXPECTED, args);
}

export function validateClearGoalArgs(args: Record<string, unknown>): string | null {
  const badObj = requireArgsObject("clear_goal", CLEAR_GOAL_EXPECTED, args);
  if (badObj) return badObj;
  return goalReasonDetail("clear_goal", CLEAR_GOAL_EXPECTED, (args as Record<string, unknown>)["reason"]);
}

// Pure lifecycle transitions (Phase 1): shared by the slash command and the
// model tools so both initiators produce identical state. Total — never
// throw. Duplicate-create rejection and busy re-arm live at the call sites
// (loop/App), not here: the builder just builds.
export function createGoalState(objective: string, tokenBudget?: number): NonNullable<GoalState> {
  try {
    const clean = typeof objective === "string" ? objective.trim() : "";
    const state: NonNullable<GoalState> = {
      objective: clean.length > 0 ? objective : "(unknown)",
      active: true,
      stats: emptyGoalStats(),
    };
    if (typeof tokenBudget === "number" && Number.isInteger(tokenBudget) && tokenBudget > 0) {
      state.tokenBudget = Math.min(tokenBudget, GOAL_TOKEN_BUDGET_MAX);
    }
    return state;
  } catch {
    return { objective: "(unknown)", active: true, stats: emptyGoalStats() };
  }
}

export function pauseGoalState(goal: GoalState): GoalState {
  try {
    if (!goal || !goal.active) return goal;
    return { ...goal, active: false };
  } catch {
    return goal;
  }
}

export function resumeGoalState(goal: GoalState): GoalState {
  try {
    if (!goal || goal.active) return goal;
    return { ...goal, active: true };
  } catch {
    return goal;
  }
}

export function clearGoalState(): GoalState {
  return null;
}

// Create notice: echoes the objective; replacing a live goal says so; an
// advisory budget appends openly so the transcript shows the bound.
export function goalCreateNotice(
  objective: string,
  previous: GoalState,
  tokenBudget?: number,
): string {
  const budget =
    typeof tokenBudget === "number" && tokenBudget > 0
      ? ` (token budget ${formatGoalTokens(tokenBudget)} — advisory, not enforced)`
      : "";
  if (previous) {
    return `(goal replaced — "${previous.objective}" replaced with "${objective}"${budget})`;
  }
  return `(goal set — "${objective}"${budget})`;
}

// Per-POST schema visibility (goal-tools-refactor Phase 3): which goal tools
// ride one model POST. get rides whenever a goal exists (active or paused —
// a paused goal must stay inspectable, the #30630 lesson); update rides live
// turns only; create rides explicit /goal intent only (never inferred);
// pause/resume/clear ride their matching state. No-goal + no-intent hides
// everything (same trim win as the old update_goal-only rule, extended).
export type GoalToolVisibility = {
  update: boolean;
  get: boolean;
  create: boolean;
  pause: boolean;
  resume: boolean;
  clear: boolean;
};

const GOAL_TOOLS_NONE: GoalToolVisibility = {
  update: false,
  get: false,
  create: false,
  pause: false,
  resume: false,
  clear: false,
};

const GOAL_TOOLS_FULL: GoalToolVisibility = {
  update: true,
  get: true,
  create: true,
  pause: true,
  resume: true,
  clear: true,
};

// Normalize the schema knob: undefined/true keep the legacy full surface
// (compaction callers and tests that never set it stay byte-identical);
// false hides every goal tool; a struct rides as-is (copied, never aliased).
export function resolveGoalTools(
  value: boolean | GoalToolVisibility | undefined,
): GoalToolVisibility {
  if (value === undefined || value === true) return { ...GOAL_TOOLS_FULL };
  if (value === false) return { ...GOAL_TOOLS_NONE };
  try {
    return {
      update: (value as GoalToolVisibility).update === true,
      get: (value as GoalToolVisibility).get === true,
      create: (value as GoalToolVisibility).create === true,
      pause: (value as GoalToolVisibility).pause === true,
      resume: (value as GoalToolVisibility).resume === true,
      clear: (value as GoalToolVisibility).clear === true,
    };
  } catch {
    return { ...GOAL_TOOLS_NONE };
  }
}

// Derive visibility from live state + explicit intent. Total — a throwing or
// malformed snapshot reads as no-goal (same guarded direction as the loop's
// readLiveGoal). get rides mere existence so a paused run stays readable.
export function resolveGoalToolVisibility(
  goal: { objective: string; active: boolean } | null | undefined,
  createIntent: boolean,
): GoalToolVisibility {
  try {
    const intent = createIntent === true;
    const live =
      goal !== null &&
      goal !== undefined &&
      typeof (goal as { objective?: unknown }).objective === "string" &&
      ((goal as { objective?: unknown }).objective as string).length > 0;
    if (!live) {
      return { ...GOAL_TOOLS_NONE, create: intent };
    }
    const active = (goal as { active?: unknown }).active === true;
    return {
      update: active,
      get: true,
      create: intent,
      pause: active,
      resume: !active,
      clear: true,
    };
  } catch {
    return { ...GOAL_TOOLS_NONE };
  }
}

// Explicit create intent: a /goal line carrying an objective (the set
// command). Bare /goal, pause/resume/clear, and non-command text are not
// intent — create must never be inferred from ordinary task requests.
// "/goalsetting" is not a command (prefix needs a word boundary).
export function hasGoalCreateIntent(text: string): boolean {
  try {
    if (typeof text !== "string" || !text.includes("/goal")) return false;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t !== "/goal" && !t.startsWith("/goal ") && !t.startsWith("/goal\t")) continue;
      if (parseGoalCommand(t).kind === "set") return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Scan user messages for create intent (string content only — parts arrays
// never carry slash commands). Read-only over the caller's array.
export function goalCreateIntentFromHistory(
  history: Array<{ role: string; content?: unknown }>,
): boolean {
  try {
    if (!Array.isArray(history)) return false;
    for (const m of history) {
      if (!m || (m as { role?: unknown }).role !== "user") continue;
      const content = (m as { content?: unknown }).content;
      if (typeof content === "string" && hasGoalCreateIntent(content)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Read view for get_goal / bare /goal: status + objective + stats + budget.
// goalStatusText stays the compact line (byte-identical — existing pins);
// this is the fuller read used by the tool and status views.
export function goalGetText(goal: GoalState): string {
  if (!goal) return "(no goal — set one with /goal <objective>)";
  const budget =
    typeof goal.tokenBudget === "number" && goal.tokenBudget > 0
      ? ` · budget ${formatGoalTokens(goal.tokenBudget)} (advisory)`
      : "";
  return `(goal [${goal.active ? "active" : "paused"}] — ${goal.objective} — ${goalStatsText(goal.stats)}${budget})`;
}

// Auto-continue follow-up (tickets 02–03): the ONLY continuation message
// the goal seam pushes — same assistant+user commit shape as the turn-end
// guards, so assistant/tool pairing stays valid and the transcript shows
// each turn normally (no synthetic user input beyond this mechanism). It
// also carries the report protocol (the only model-visible channel for the
// goal-scoped update_goal tool — the tool-schema payload wiring arrives in
// a later ticket): the model reports each turn's outcome, and a turn with
// no report counts as `continue` until the ticket-04 evaluator lands.
export function goalFollowUp(objective: string): string {
  return (
    `(goal continues: "${objective}" — keep working toward the goal with ` +
    `tool calls, or answer in text when there is nothing left to do. ` +
    `Final text starts the next goal turn automatically; the goal runs ` +
    `until it is paused or cleared. Report the turn outcome with the ` +
    `update_goal tool (status "continue" with the next action, or ` +
    `"complete"/"blocked" with a reason); a turn with no report continues ` +
    `the goal.)`
  );
}

// Pause-with-preservation notice for cancel/budget paths: names the reason,
// keeps the objective quoted, and points at /goal resume. The goal itself
// is never cleared here — pausing only flips `active`.
export function goalPausedNotice(objective: string, reason: string): string {
  return `(goal paused — "${objective}" preserved ${reason}; resume with /goal resume)`;
}

// Judge tail (ticket 04): the evaluator sees the goal text plus the recent
// turns only — never the full history. 20 messages covers a few turns of
// tool traffic without bloating the judge POST.
export const GOAL_JUDGE_TAIL_MESSAGES = 20;

// Slice the recent transcript tail for the judge (read-only — the caller
// shares the message objects, and the judge must never mutate them).
export function recentTurnsForJudge(history: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  return history.slice(-GOAL_JUDGE_TAIL_MESSAGES);
}

// Strict-but-tolerant judge-verdict parsing (ticket 04): the judge must
// answer with one JSON verdict object; anything else (prose, empty text, a
// bad shape, failed validation) counts as unclear → null → the loop pauses
// instead of looping. Code fences are tolerated (the slice runs from the
// first `{` to the last `}`); single-object only. An empty `next` on
// `continue` reads as absent (still a clear verdict — the generic follow-up
// covers it); everything else validates exactly like update_goal args.
export function parseGoalJudgeVerdict(text: string): GoalDisposition | null {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const args = { ...(parsed as Record<string, unknown>) };
  if (
    args["status"] === "continue" &&
    typeof args["next"] === "string" &&
    args["next"].trim().length === 0
  ) {
    delete args["next"];
  }
  if (validateUpdateGoalArgs(args) !== null) return null;
  const disposition = updateGoalDisposition(args);
  // Trim payloads so a padded verdict prints clean (validation already
  // guaranteed the required fields are non-empty).
  if (disposition.status === "continue" && typeof disposition.next === "string") {
    return { status: "continue", next: disposition.next.trim() };
  }
  if (disposition.status === "complete" || disposition.status === "blocked") {
    return { status: disposition.status, reason: disposition.reason.trim() };
  }
  return disposition;
}

// Novelty progress guard (ticket 05): the goal measures real forward motion,
// not motion. Every committed tool result fingerprints to name + stable args
// + result; an exact repeat (fingerprint already seen) advances nothing,
// while genuinely new evidence bumps the novel count and resets the stall
// streak. Error results never count — the error-streak machinery owns those.
// When the streak reaches GOAL_STALL_REPEATS at a goal turn end, the loop
// pushes the replan nudge as the next follow-up and resets the epoch —
// stalling never pauses, clears, or ends the goal. Loop-local only: a whole
// goal run normally lives inside one runLoopWithChat call, so the seen-set
// never leaves the turn (a later ticket can expose it if App/telemetry ever
// needs it).

// Consecutive non-novel commits before the replan nudge fires: 3. One repeat
// is often a legit retry (truncation repair, parallel re-fetch) and two can
// be coincidence; three identical results is a loop. It also mirrors the
// other turn-end guards (MAX_VERIFY_ROUNDS / MAX_TODO_ROUNDS = 3, error-streak
// default 3), so every guard agrees on what "sustained" means.
export const GOAL_STALL_REPEATS = 3;

// Upper bound on retained fingerprints: runs are budget-bounded, but the
// default budgets are uncapped, so the set never grows without limit. Past
// the cap an unseen key still counts as novel (the safe direction — progress
// over stall) without being stored.
export const GOAL_PROGRESS_SEEN_CAP = 5000;

export type GoalProgressState = {
  /** Fingerprints of committed results already counted as progress. */
  seen: Set<string>;
  /** Commits that advanced progress (repeats never bump this). */
  novel: number;
  /** Consecutive committed results that advanced nothing. */
  stale: number;
};

// Fresh per-run progress memory (the loop owns one per runLoopWithChat call).
export function emptyGoalProgress(): GoalProgressState {
  return { seen: new Set<string>(), novel: 0, stale: 0 };
}

// FNV-1a (32-bit, non-crypto): small, dependency-free, and total — never
// throws, so accounting can never break the turn.
function goalFingerprintHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// Bounded novelty key: name + stable args (via toolSignature, so key order
// never aliases) + full result, hashed — the set keeps ~40 chars per entry,
// never result text. Total: never throws (unstringifiable args fall back
// inside toolSignature; anything else degrades to a length-only key).
export function goalProgressFingerprint(
  name: string,
  parsed: Record<string, unknown>,
  result: string
): string {
  const tool = typeof name === "string" ? name : "(unknown)";
  const body = typeof result === "string" ? result : "";
  let argsKey: string;
  try {
    argsKey = toolSignature(tool, parsed ?? {});
  } catch {
    argsKey = `${tool} {}`;
  }
  return `${tool}#${goalFingerprintHash(`${argsKey}\n${body}`)}:${body.length}`;
}

// Record one committed result: errors are ignored (owned by the error-streak
// machinery — they neither advance nor stall progress); a repeat bumps the
// streak; anything new bumps the novel count and resets the streak. Returns
// true when the commit advanced progress. Total: never throws.
export function noteGoalProgress(
  state: GoalProgressState | null | undefined,
  name: string,
  parsed: Record<string, unknown>,
  result: string,
  isError: boolean
): boolean {
  try {
    if (!state || isError) return false;
    const key = goalProgressFingerprint(name, parsed, result);
    if (state.seen.has(key)) {
      state.stale += 1;
      return false;
    }
    if (state.seen.size < GOAL_PROGRESS_SEEN_CAP) state.seen.add(key);
    state.novel += 1;
    state.stale = 0;
    return true;
  } catch {
    return false;
  }
}

// The stall redirect fires when the streak reaches the threshold (never
// earlier — a partial streak is still a working run). Total: never throws.
export function goalStallReached(state: GoalProgressState | null | undefined): boolean {
  try {
    return (state?.stale ?? 0) >= GOAL_STALL_REPEATS;
  } catch {
    return false;
  }
}

// Reset the stall epoch after the nudge fires (the seen-set stays — continued
// repeats keep reading as repeats, so a stuck run nudges again instead of
// going quiet). Total: never throws.
export function resetGoalStall(state: GoalProgressState | null | undefined): void {
  try {
    if (state) state.stale = 0;
  } catch {
    // accounting never breaks the turn
  }
}

// Replan nudge (ticket 05): the stall-epoch follow-up — same `(…)` notice
// voice as the other turn-end gates, naming the objective and the repeat
// count so the redirect is auditable in the transcript. Total: never throws.
export function goalStallNudge(objective: string, repeats: number): string {
  try {
    const goal = typeof objective === "string" && objective.length > 0 ? objective : "(unknown)";
    const count =
      typeof repeats === "number" && Number.isFinite(repeats) && repeats > 0
        ? Math.floor(repeats)
        : GOAL_STALL_REPEATS;
    return (
      `(goal stalled — "${goal}": the last ${count} tool results repeated earlier work ` +
      `with nothing new. Replan: try a different approach, file, or check instead of ` +
      `repeating the same calls. The goal stays active — keep working toward it.)`
    );
  } catch {
    return `(goal stalled — replanning needed; the goal stays active.)`;
  }
}

// Compacted-summary goal block (ticket 08): the canonical `Goal:` text that
// rides inside the compaction summary, following the `Touched files:`
// precedent — appended to the model summary within budget, surfaced verbatim
// on resume. It carries the objective verbatim (never trimmed — user text),
// the live state flag (active vs paused — a paused goal still resumes), and
// the cumulative stats (never reset by compaction), plus the open checklist
// lines (pending/in_progress only — completed work belongs in the summary
// prose the instruction already asks the summarizer to preserve). The block
// is the model's context backstop only: record restore (ticket 07) stays the
// restore path, so nothing here needs machine-parsing — it just has to read
// unambiguously. Total: never throws; no goal renders "" (caller appends
// nothing, keeping non-goal output byte-identical).

// Upper bounds for the checklist tail: the block rides with the model text
// (never shrunk by the budget fitter — only the touched-files lists shrink),
// so it stays bounded on its own. Fix 10 — caps are shared with the TUI
// (`todo-shared.ts`) so compact tail and live list never drift.
// Re-exported for backwards compat (tests import from `goal.ts`).
export const GOAL_COMPACT_TODOS_MAX = TODO_COMPACT_MAX;
export const GOAL_COMPACT_TODO_CHARS = TODO_COMPACT_CHARS;

// Structural checklist line (content + status only — goal.ts never imports
// the tools module; the caller maps its TodoItems down to this shape).
export type GoalCompactTodo = { content: string; status: string };

export function formatGoalForCompact(goal: GoalState, todos?: GoalCompactTodo[]): string {
  try {
    if (!goal) return "";
    if (typeof goal.objective !== "string" || goal.objective.length === 0) return "";
    const lines = [
      `Goal: "${goal.objective}" [${goal.active ? "active" : "paused"}] (${goalStatsText(goal.stats)})`,
    ];
    if (Array.isArray(todos)) {
      const open: string[] = [];
      for (const t of todos) {
        if (open.length >= GOAL_COMPACT_TODOS_MAX) break;
        if (!t || typeof t.content !== "string" || typeof t.status !== "string") continue;
        if (t.status === "completed") continue;
        const content = t.content.trim();
        if (content.length === 0) continue;
        const short =
          content.length > GOAL_COMPACT_TODO_CHARS
            ? `${content.slice(0, GOAL_COMPACT_TODO_CHARS)}…`
            : content;
        open.push(`[${t.status}] ${short}`);
      }
      if (open.length > 0) lines.push(`Goal todos: ${open.join("; ")}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// Append the goal block to a summary (mirrors appendTouchedFiles — empty
// renders the summary untouched).
export function appendGoalBlock(summaryText: string, goalBlock: string): string {
  if (typeof goalBlock !== "string" || goalBlock.length === 0) return summaryText;
  return `${summaryText}\n\n${goalBlock}`;
}
