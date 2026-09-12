// Durable multi-session store for ATOM.
//
// One JSON file per session under ~/.atom/sessions/<id>.json (ATOM_HOME
// override honored via auth.ts's atomDir) plus a plaintext pointer file
// ~/.atom/sessions/active holding the active session id.
//
// This module never touches the legacy single-file save owned by
// src/session.ts (~/.atom/session.json) — that file stays exactly as-is.
//
// Conventions (mirroring session.ts / auth.ts):
// - Writes are atomic (temp file + rename, mkdir -p) so a kill mid-write
//   can never leave a half-written record; no .tmp leftovers on failure.
// - 0600 POSIX perms, best-effort on Windows (never throws for chmod).
// - Loads never throw: missing -> null, malformed -> null, and listings
//   silently skip corrupt files.
// - provider/model/effort/mode are opaque carried fields. The literal
//   defaults below are documented here on purpose — this module must NOT
//   depend on DEFAULT_PROVIDER from zen.js (avoid coupling) and must NEVER
//   import LLM clients.
// - No transient UI state (scroll, cursor, picker, queue) is stored.
//
// Import budget: value imports are node:fs, node:path, node:crypto,
// ./auth.js, and ./goal.js (goal persistence-shape helpers only —
// serialize/restore/validate; goal.js itself is React-free and imports no
// session module, so the runtime DAG stays acyclic) plus type-only imports
// from ./zen.js / ./providers.js / ./goal.js (erased at compile).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { atomDir } from "./auth.js";
import {
  restoreGoalFromPersist,
  serializeGoalForPersist,
  type PersistedGoal,
} from "./goal.js";
import type { ProviderId } from "./providers.js";
import type {
  ChatMessage,
  PermissionMode,
  ReasoningEffort,
  ToolCall,
  Usage,
} from "./zen.js";

// Literal defaults for new sessions (opaque carried fields — see header).
export const SESSION_DEFAULT_PROVIDER: ProviderId = "opencode-zen";
export const SESSION_DEFAULT_MODEL = "";
export const SESSION_DEFAULT_EFFORT: ReasoningEffort = "auto";
export const SESSION_DEFAULT_MODE: PermissionMode = "normal";

// "default" is the pre-auto name for the same level: old records map to
// "auto" on load/create instead of carrying a dead value. Local one-liner
// (not imported from zen.js) to honor this module's import budget above.
function canonicalSessionEffort(value: unknown): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "max") {
    return value;
  }
  return "auto";
}

// Display transcript entry (same shape as session.ts's SessionTurn; defined
// locally so this module never imports App — no cycle).
export type SessionTurn = {
  role: "user" | "assistant" | "tool";
  content: string;
  error?: boolean;
  thinking?: boolean;
};

export type Session = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
  mode: PermissionMode;
  usageTotals: Usage | null;
  // Live session goal at the last persist (ticket 07), or null. Old records
  // without the key read as no-goal; a trashed goal never fails the record.
  goal: PersistedGoal | null;
  history: ChatMessage[];
  turns: SessionTurn[];
  metadata: Record<string, unknown>;
};

export type CreateSessionOpts = {
  id?: string;
  title?: string;
  cwd?: string;
  provider?: ProviderId;
  model?: string;
  effort?: ReasoningEffort;
  mode?: PermissionMode;
  usageTotals?: Usage | null;
  goal?: PersistedGoal | null;
  history?: ChatMessage[];
  turns?: SessionTurn[];
  metadata?: Record<string, unknown>;
  now?: Date | number | string;
};

// id/createdAt are immutable: accepted in the type so callers can pass a
// full record through, but always ignored on write.
export type UpdateSessionPatch = Partial<
  Omit<Session, "id" | "createdAt">
> & {
  id?: string;
  createdAt?: string;
};

export const SESSIONS_DIRNAME = "sessions";
export const ACTIVE_FILENAME = "active";

export function sessionsDir(home?: string): string {
  return path.join(atomDir(home), SESSIONS_DIRNAME);
}

export function sessionFilePath(id: string, home?: string): string {
  return path.join(sessionsDir(home), `${id}.json`);
}

export function activeFilePath(home?: string): string {
  return path.join(sessionsDir(home), ACTIVE_FILENAME);
}

const MONTHS: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Default display title: local date+time like "September 9, 2026 20:41:32"
// (long English month, unpadded day, 24h zero-padded HH:MM:SS local time).
// createdAt stays a separate ISO string on the record.
export function formatSessionTitle(date: Date = new Date()): string {
  const d =
    date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function newSessionId(): string {
  return `ses_${randomUUID().replace(/-/g, "")}`;
}

function toISODate(now?: Date | number | string): string {
  if (now === undefined) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidDateString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

// Atomic write: temp file + rename, 0600 POSIX best-effort. Cleans up the
// temp file when the write/rename fails so no .tmp leftovers remain. Disk
// errors propagate to the caller.
function writeFileAtomic(finalPath: string, content: string): void {
  mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, content, "utf8");
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // best-effort on Windows; ignore
    }
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // cleanup best-effort; report the original failure
    }
    throw err;
  }
}

function validateUsageTotals(value: unknown): Usage | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const out: Usage = {};
  for (const key of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const v = value[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = Math.floor(v);
    }
  }
  return out;
}

function validateToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["id"])) return false;
  const fn = value["function"];
  if (!isRecord(fn)) return false;
  if (typeof fn["name"] !== "string" || fn["name"].length === 0) return false;
  if (typeof fn["arguments"] !== "string") return false;
  if (value["type"] !== undefined && typeof value["type"] !== "string") {
    return false;
  }
  return true;
}

function validateChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  const role = value["role"];
  if (role === "system" || role === "user") {
    return typeof value["content"] === "string";
  }
  if (role === "assistant") {
    const content = value["content"];
    if (
      content !== undefined &&
      content !== null &&
      typeof content !== "string"
    ) {
      return false;
    }
    const calls = value["tool_calls"];
    if (calls !== undefined) {
      if (!Array.isArray(calls) || calls.length === 0) return false;
      for (const c of calls) {
        if (!validateToolCall(c)) return false;
      }
    }
    return true;
  }
  if (role === "tool") {
    return (
      isNonEmptyString(value["tool_call_id"]) &&
      typeof value["content"] === "string"
    );
  }
  return false;
}

function validateTurn(value: unknown): value is SessionTurn {
  if (!isRecord(value)) return false;
  const role = value["role"];
  if (role !== "user" && role !== "assistant" && role !== "tool") return false;
  if (typeof value["content"] !== "string") return false;
  if (value["error"] !== undefined && typeof value["error"] !== "boolean") {
    return false;
  }
  if (
    value["thinking"] !== undefined &&
    typeof value["thinking"] !== "boolean"
  ) {
    return false;
  }
  return true;
}

// Strict-enough read validation: bad shape -> null (caller treats the file
// as missing/corrupt, never throws). Unknown extra keys are ignored.
// provider/model/effort/mode stay opaque (typeof string only — any id,
// including "", round-trips) so this store never couples to LLM clients.
function validateSessionRecord(data: unknown): Session | null {
  if (!isRecord(data)) return null;
  if (!isNonEmptyString(data["id"])) return null;
  if (typeof data["title"] !== "string" || data["title"].trim().length === 0) {
    return null;
  }
  if (!isValidDateString(data["createdAt"])) return null;
  if (!isValidDateString(data["updatedAt"])) return null;
  if (typeof data["cwd"] !== "string") return null;
  if (typeof data["provider"] !== "string") return null;
  if (typeof data["model"] !== "string") return null;
  if (typeof data["effort"] !== "string") return null;
  if (typeof data["mode"] !== "string") return null;
  const history = data["history"];
  if (!Array.isArray(history)) return null;
  for (const m of history) {
    if (!validateChatMessage(m)) return null;
  }
  const turns = data["turns"];
  if (!Array.isArray(turns)) return null;
  for (const t of turns) {
    if (!validateTurn(t)) return null;
  }
  const metadata = data["metadata"];
  return {
    id: data["id"],
    title: data["title"],
    createdAt: data["createdAt"],
    updatedAt: data["updatedAt"],
    cwd: data["cwd"],
    provider: data["provider"] as ProviderId,
    model: data["model"],
    effort: canonicalSessionEffort(data["effort"]),
    mode: data["mode"] as PermissionMode,
    usageTotals: validateUsageTotals(data["usageTotals"]),
    // Tolerant: a missing or trashed goal reads as no-goal (null) — the
    // record still loads, so one corrupt field can never strand a session.
    // Re-serialized so the loaded record always carries concrete stats.
    goal: serializeGoalForPersist(restoreGoalFromPersist(data["goal"])),
    history: history as ChatMessage[],
    turns: turns as SessionTurn[],
    metadata: isRecord(metadata) ? { ...metadata } : {},
  };
}

function readSessionFile(filePath: string): Session | null {
  let raw: string;
  try {
    if (!existsSync(filePath)) return null;
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateSessionRecord(data);
}

function persistSession(session: Session, home?: string): void {
  writeFileAtomic(
    sessionFilePath(session.id, home),
    JSON.stringify(session, null, 2) + "\n"
  );
}

export function createSession(
  opts: CreateSessionOpts = {},
  home?: string
): Session {
  const at = toISODate(opts.now);
  let id =
    typeof opts.id === "string" && opts.id.length > 0 ? opts.id : newSessionId();
  // Never silently overwrite: an explicit id that already exists (caller
  // retry / collision) falls back to a fresh id, so ids stay unique. The
  // check-then-write races only across processes (last-writer-wins, the
  // documented store posture); each write itself stays atomic.
  if (id === opts.id && opts.id) {
    let exists = false;
    try {
      exists = existsSync(sessionFilePath(id, home));
    } catch {
      exists = false;
    }
    if (exists) id = newSessionId();
  }
  const rawTitle = typeof opts.title === "string" ? opts.title.trim() : "";
  const session: Session = {
    id,
    title: rawTitle.length > 0 ? rawTitle : formatSessionTitle(new Date(at)),
    createdAt: at,
    updatedAt: at,
    cwd: typeof opts.cwd === "string" ? opts.cwd : safeCwd(),
    provider: opts.provider ?? SESSION_DEFAULT_PROVIDER,
    model: opts.model ?? SESSION_DEFAULT_MODEL,
    effort: canonicalSessionEffort(opts.effort ?? SESSION_DEFAULT_EFFORT),
    mode: opts.mode ?? SESSION_DEFAULT_MODE,
    usageTotals:
      opts.usageTotals === undefined || opts.usageTotals === null
        ? null
        : validateUsageTotals(opts.usageTotals),
    // Fresh sessions start with no goal unless the caller restores one
    // (tolerantly validated — corrupt input reads as no-goal, never throws).
    goal: serializeGoalForPersist(restoreGoalFromPersist(opts.goal ?? null)),
    history: (opts.history ?? []).map((m) => ({ ...m })),
    turns: (opts.turns ?? []).map((t) => ({ ...t })),
    metadata: isRecord(opts.metadata) ? { ...opts.metadata } : {},
  };
  persistSession(session, home);
  // First session wins the active pointer; later creates leave it alone.
  if (getActiveSessionId(home) === null) {
    setActiveSession(session.id, home);
  }
  return session;
}

export function getSession(id: string, home?: string): Session | null {
  if (typeof id !== "string" || id.length === 0) return null;
  return readSessionFile(sessionFilePath(id, home));
}

// Alias-safe full-record read.
export function loadSession(id: string, home?: string): Session | null {
  return getSession(id, home);
}

// Turn-boundary cut for forks (ticket 07): the /rewind precedent's rule
// (conversationCutIndex in snapshots.ts) — drop the whole turn containing
// the mark so assistant/tool_call pairing can never split. Duplicated
// locally (not imported) to honor this module's import budget (node:fs,
// node:path, node:crypto, ./auth.js, ./goal.js only).
function forkCutIndex(
  messages: { role: string; hasToolCalls?: boolean }[],
  mark: number,
  keepFirst: number
): number {
  const len = messages.length;
  const floor = Math.max(0, Math.floor(keepFirst));
  if (len <= floor) return len;
  const m = Math.max(
    floor,
    Math.min(Number.isFinite(mark) ? Math.floor(mark) : len, len)
  );
  let turnStart = -1;
  for (let i = m - 1; i >= floor; i--) {
    if (messages[i]?.role === "user") {
      turnStart = i;
      break;
    }
  }
  if (turnStart === -1) return floor;
  for (let i = turnStart; i < m; i++) {
    const msg = messages[i];
    if (
      msg !== undefined &&
      msg.role === "assistant" &&
      msg.hasToolCalls !== true
    ) {
      return m;
    }
  }
  return turnStart;
}

// JSON deep copy for forked payloads (history/turns/metadata): the fork's
// file is independent on disk either way, but a deep copy also keeps the
// two in-memory records from aliasing nested objects. Falls back to the
// original reference when the value is not JSON-serializable (records are
// JSON-file shaped, so this path is defensive only).
function deepCopyJson<T>(value: T): T {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return value;
    return JSON.parse(text) as T;
  } catch {
    return value;
  }
}

// Fork a session at a message (ticket 07): "try another approach from here".
// Reads the source record and persists a brand-new session (fresh stable id
// from the same scheme as createSession, createdAt/updatedAt = now) holding
// the source's history up to atMessageIndex and nothing after, cut at a turn
// boundary via forkCutIndex. atMessageIndex counts history messages to keep
// (checkpoint-length semantics, like cp.historyLength in the rewind path);
// omitted/NaN/Infinity forks at the tip, out-of-range values clamp.
// The display transcript (turns) is sliced at the analogous boundary (the
// system prompt at history[0] has no turns counterpart, hence the offset).
// goal + metadata (todos/filediffs/extension keys) ride over opaquely so the
// branch continues with full context; usageTotals resets to null so the new
// branch accrues its own spend. provider/model/effort/mode/cwd are carried.
// The source file is only read, never written; the active pointer is never
// touched. Returns null when the source id is missing/unknown. Disk errors
// from the fork write propagate to the caller.
export function forkSession(
  sourceId: string,
  atMessageIndex?: number,
  home?: string
): Session | null {
  if (typeof sourceId !== "string" || sourceId.length === 0) return null;
  const source = getSession(sourceId, home);
  if (!source) return null;
  const mark =
    atMessageIndex === undefined ? source.history.length : atMessageIndex;
  const historyCut = forkCutIndex(
    source.history.map((m) => ({
      role: m.role,
      hasToolCalls:
        m.role === "assistant" &&
        (m as { tool_calls?: unknown }).tool_calls !== undefined,
    })),
    mark,
    1
  );
  const systemOffset = source.history[0]?.role === "system" ? 1 : 0;
  const turnsMark = Math.max(
    0,
    Math.min(historyCut - systemOffset, source.turns.length)
  );
  const turnsCut = forkCutIndex(
    source.turns.map((t) => ({
      role: t.role,
      hasToolCalls:
        (t as { tool_calls?: unknown }).tool_calls !== undefined,
    })),
    turnsMark,
    0
  );
  const at = new Date().toISOString();
  const forked: Session = {
    id: newSessionId(),
    title: `${source.title} (fork)`,
    createdAt: at,
    updatedAt: at,
    cwd: source.cwd,
    provider: source.provider,
    model: source.model,
    effort: source.effort,
    mode: source.mode,
    usageTotals: null,
    // Opaque carry-over (tolerantly validated — a trashed goal reads as
    // no-goal, never throws), same posture as createSession.
    goal: serializeGoalForPersist(restoreGoalFromPersist(source.goal)),
    history: deepCopyJson(source.history.slice(0, historyCut)),
    turns: deepCopyJson(source.turns.slice(0, turnsCut)),
    metadata: deepCopyJson({ ...source.metadata }),
  };
  persistSession(forked, home);
  return forked;
}

export function listSessions(home?: string): Session[] {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir(home));
  } catch {
    return [];
  }
  const out: Session[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const session = readSessionFile(path.join(sessionsDir(home), entry));
    if (session) out.push(session);
  }
  out.sort((a, b) => {
    const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (updated !== 0) return updated;
    const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (created !== 0) return created;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

export function updateSession(
  id: string,
  patch: UpdateSessionPatch,
  home?: string
): Session | null {
  const current = getSession(id, home);
  if (!current || !isRecord(patch)) return null;
  const { id: _droppedId, createdAt: _droppedCreatedAt, ...rest } = patch;
  void _droppedId;
  void _droppedCreatedAt;
  const candidate: Record<string, unknown> = {
    ...current,
    ...rest,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt:
      typeof rest["updatedAt"] === "string" &&
      isValidDateString(rest["updatedAt"])
        ? rest["updatedAt"]
        : new Date().toISOString(),
  };
  if (typeof candidate["title"] === "string") {
    candidate["title"] = candidate["title"].trim();
  }
  if (Array.isArray(candidate["history"])) {
    candidate["history"] = (candidate["history"] as ChatMessage[]).map((m) =>
      isRecord(m) ? { ...m } : m
    );
  }
  if (Array.isArray(candidate["turns"])) {
    candidate["turns"] = (candidate["turns"] as SessionTurn[]).map((t) =>
      isRecord(t) ? { ...t } : t
    );
  }
  if (
    candidate["metadata"] !== undefined &&
    !isRecord(candidate["metadata"])
  ) {
    return null;
  }
  const valid = validateSessionRecord(candidate);
  if (!valid) return null;
  persistSession(valid, home);
  return valid;
}

export function renameSession(
  id: string,
  title: string,
  home?: string
): Session | null {
  if (typeof title !== "string" || title.trim().length === 0) return null;
  const current = getSession(id, home);
  if (!current) return null;
  const next: Session = {
    ...current,
    title: title.trim(),
    updatedAt: new Date().toISOString(),
  };
  persistSession(next, home);
  return next;
}

export function deleteSession(id: string, home?: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  const filePath = sessionFilePath(id, home);
  try {
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
  } catch {
    return false;
  }
  // Clear the active pointer only when it pointed at the deleted session.
  try {
    if (getActiveSessionId(home) === id) setActiveSession(null, home);
  } catch {
    // never throws; active cleanup is best-effort
  }
  return true;
}

// Full-record overwrite. The stored id/createdAt win when a record already
// exists on disk — id/createdAt can never be mutated through save.
// updatedAt always bumps to now.
export function saveSession(session: Session, home?: string): Session {
  if (!session || !isNonEmptyString(session.id)) {
    throw new Error("saveSession: session.id must be a non-empty string");
  }
  const disk = getSession(session.id, home);
  const candidate: Record<string, unknown> = {
    ...session,
    id: disk ? disk.id : session.id,
    createdAt: disk ? disk.createdAt : session.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const valid = validateSessionRecord(candidate);
  if (!valid) {
    throw new Error("saveSession: session record failed validation");
  }
  persistSession(valid, home);
  return valid;
}

// Bump updatedAt to now (runtime message/assistant/tool mutations). The
// caller mutates content via updateSession/saveSession; touch only refreshes
// the recency marker so listings sort correctly.
export function touchSession(id: string, home?: string): Session | null {
  const current = getSession(id, home);
  if (!current) return null;
  const next: Session = { ...current, updatedAt: new Date().toISOString() };
  persistSession(next, home);
  return next;
}

// null clears the pointer. Unknown ids are ignored (active unchanged).
// Never throws.
export function setActiveSession(id: string | null, home?: string): void {
  try {
    const activePath = activeFilePath(home);
    if (id === null) {
      try {
        if (existsSync(activePath)) unlinkSync(activePath);
      } catch {
        // best-effort clear; ignore
      }
      return;
    }
    if (typeof id !== "string" || id.length === 0) return;
    if (!getSession(id, home)) return;
    writeFileAtomic(activePath, id);
  } catch {
    // never throws; ignore
  }
}

export function getActiveSessionId(home?: string): string | null {
  try {
    const activePath = activeFilePath(home);
    if (!existsSync(activePath)) return null;
    const raw = readFileSync(activePath, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function getActiveSession(home?: string): Session | null {
  const id = getActiveSessionId(home);
  if (!id) return null;
  return getSession(id, home);
}

// Return the active session when it still exists on disk, else create (and
// activate, when nothing is set) a new one from opts.
export function ensureActiveSession(
  opts: CreateSessionOpts = {},
  home?: string
): Session {
  const active = getActiveSession(home);
  if (active) return active;
  const created = createSession(opts, home);
  // createSession only claims the pointer when none is set; a dangling
  // pointer must be re-pointed at the replacement session.
  setActiveSession(created.id, home);
  return created;
}
