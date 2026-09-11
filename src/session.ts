// Kill-safe session persistence for the Ink chatbot.
// A killed/crashed/failed session must not lose everything: every COMPLETED
// turn (and clean exit) writes ~/.atom/session.json (ATOM_HOME override
// honored, 0600 POSIX perms like auth.json, best-effort Windows). Failed or
// cancelled turns are rolled back and NEVER touch the file, so a bad turn
// cannot corrupt or clobber the last good save.
//
// Shape: {version:1, savedAt, provider, model, effort, mode, usageTotals,
// goal (ticket 07: the live session goal plus cumulative stats, or null),
// history (full API history incl. system + tool pairs), turns (display
// transcript)}. Writes are atomic (temp file + rename) to survive kills
// mid-write. Loads never throw: missing -> "missing", anything malformed ->
// "corrupt" (caller shows a one-line notice and starts fresh). A missing or
// corrupt goal degrades to no-goal (null) WITHOUT failing the load — the
// conversation still restores.
//
// Privacy: the file can contain pasted secrets if the user typed them as
// chat. Never print its contents; never commit it (it lives under ~/.atom,
// outside the repo, so .gitignore needs no change).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { atomDir, getStoredBaseURL, loadAuth, resolveApiKey } from "./auth.js";
import {
  chatEndpointFor,
  isProviderId,
  openaiCompatibleChatEndpoint,
  type ProviderId,
} from "./providers.js";
import {
  EFFORT_OPTIONS,
  type ChatMessage,
  type PermissionMode,
  type ReasoningEffort,
  type ToolCall,
  type Usage,
} from "./zen.js";
import {
  restoreGoalFromPersist,
  serializeGoalForPersist,
  type GoalState,
  type PersistedGoal,
} from "./goal.js";

export const SESSION_VERSION = 1;
export const SESSION_FILENAME = "session.json";

// Display transcript entry (same shape as App's Turn; defined here so this
// module never imports App — no cycle).
export type SessionTurn = {
  role: "user" | "assistant" | "tool";
  content: string;
  error?: boolean;
  // Committed thinking marker (mirrors App's Turn.thinking): preserved
  // through save/resume so the visible record survives restarts. Never
  // enters model history — rendering-only, toggled by /thinking.
  thinking?: boolean;
};

export type SessionFile = {
  version: number;
  savedAt: string;
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
  mode: PermissionMode;
  usageTotals: Usage | null;
  // Live session goal at save time (ticket 07), or null. Always present on
  // new saves; old saves without the key load as no-goal.
  goal: PersistedGoal | null;
  history: ChatMessage[];
  turns: SessionTurn[];
};

export type SessionSnapshot = {
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
  mode: PermissionMode;
  usageTotals: Usage | null;
  // Optional so pre-goal snapshot literals keep compiling — absent reads as
  // no-goal at save time.
  goal?: GoalState | null;
  history: ChatMessage[];
  turns: SessionTurn[];
};

export type LoadSessionResult =
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "ok"; session: SessionFile };

export function sessionFilePath(home?: string): string {
  return path.join(atomDir(home), SESSION_FILENAME);
}

export function sessionExists(home?: string): boolean {
  try {
    return existsSync(sessionFilePath(home));
  } catch {
    return false;
  }
}

// Persisted preferences (Claude-Code-style model memory): provider, model,
// and effort survive restarts WITHOUT restoring the conversation (that stays
// an explicit /resume). The saved key and endpoint resolve with it so the
// first turn can POST immediately.
//
// Returns null when there is nothing usable: missing/corrupt save, saved
// provider without a resolvable key (env wins, else stored — a revoked key
// must never strand startup on a dead provider), or openai-compatible
// without its stored baseURL (a key alone cannot POST anywhere). Never
// throws. `zenEndpoint` honors OPENCODE_ZEN_ENDPOINT for the zen default.
export type SavedPrefs = {
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
  apiKey: string;
  endpoint: string;
};

export function loadPrefs(home: string | undefined, zenEndpoint: string): SavedPrefs | null {
  try {
    const loaded = loadSession(home);
    if (loaded.status !== "ok") return null;
    const s = loaded.session;
    const auth = loadAuth(home);
    const key = resolveApiKey(s.provider, auth);
    // Kilo serves anonymous free models, so a saved kilo session restores
    // keyless; every other keyed provider still needs a resolvable key.
    if (!key && s.provider !== "kilo") return null;
    const baseURL = getStoredBaseURL(auth, s.provider);
    if (s.provider === "openai-compatible" && !baseURL) return null;
    const endpoint =
      s.provider === "opencode-zen"
        ? zenEndpoint
        : s.provider === "openai-compatible"
          ? openaiCompatibleChatEndpoint(baseURL)
          : chatEndpointFor(s.provider, baseURL);
    return { provider: s.provider, model: s.model, effort: s.effort, apiKey: key, endpoint };
  } catch {
    return null;
  }
}

// Atomic save: write temp + rename, 0600 POSIX (best-effort Windows).
// Never throws for missing dirs (mkdir -p); disk errors propagate to the
// caller, which ignores them (in-memory session still applies).
export function saveSession(snapshot: SessionSnapshot, home?: string): void {
  const dir = atomDir(home);
  mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, SESSION_FILENAME);
  const tmpPath = path.join(dir, `${SESSION_FILENAME}.tmp.${process.pid}`);
  const payload: SessionFile = {
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    provider: snapshot.provider,
    model: snapshot.model,
    effort: snapshot.effort,
    mode: snapshot.mode,
    usageTotals: snapshot.usageTotals,
    // Piggyback: the live goal rides every completed-turn save (no new save
    // cadence — compaction and clean exit flow through here too).
    goal: serializeGoalForPersist(snapshot.goal ?? null),
    history: snapshot.history.map((m) => ({ ...m })),
    turns: snapshot.turns.map((t) => ({ ...t })),
  };
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort on Windows; ignore
  }
  renameSync(tmpPath, finalPath);
}

// Load the save file. Missing file -> "missing"; unreadable file,
// invalid JSON, or any shape violation -> "corrupt". Never throws.
export function loadSession(home?: string): LoadSessionResult {
  const p = sessionFilePath(home);
  let raw: string;
  try {
    if (!existsSync(p)) return { status: "missing" };
    raw = readFileSync(p, "utf8");
  } catch {
    return { status: "corrupt" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  const session = validateSession(data);
  return session ? { status: "ok", session } : { status: "corrupt" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
  if (value["type"] !== undefined && typeof value["type"] !== "string") return false;
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
  return true;
}

function validateSession(data: unknown): SessionFile | null {
  if (!isRecord(data)) return null;
  if (data["version"] !== SESSION_VERSION) return null;
  const savedAt = data["savedAt"];
  if (typeof savedAt !== "string" || Number.isNaN(Date.parse(savedAt))) {
    return null;
  }
  const provider = data["provider"];
  if (typeof provider !== "string" || !isProviderId(provider)) return null;
  const model = data["model"];
  if (!isNonEmptyString(model)) return null;
  // "default" is the pre-auto name for the same level: old saves map to
  // "auto" instead of failing the load.
  const rawEffort = data["effort"];
  const effort: ReasoningEffort | null =
    rawEffort === "default"
      ? "auto"
      : typeof rawEffort === "string" &&
          (EFFORT_OPTIONS as readonly string[]).includes(rawEffort)
        ? (rawEffort as ReasoningEffort)
        : null;
  if (effort === null) {
    return null;
  }
  const mode = data["mode"];
  // "plan" restores as plan (fail-closed: a saved read-only session resumes
  // read-only; ticket 04). Additive — normal/yolo saves validate as before.
  if (mode !== "normal" && mode !== "yolo" && mode !== "plan") return null;
  const history = data["history"];
  if (!Array.isArray(history) || history.length === 0) return null;
  for (const m of history) {
    if (!validateChatMessage(m)) return null;
  }
  if ((history[0] as { role?: unknown })?.role !== "system") return null;
  const turns = data["turns"];
  if (!Array.isArray(turns)) return null;
  for (const t of turns) {
    if (!validateTurn(t)) return null;
  }
  return {
    version: SESSION_VERSION,
    savedAt,
    provider,
    model,
    effort,
    mode,
    usageTotals: validateUsageTotals(data["usageTotals"]),
    // Tolerant: a trashed goal degrades to no-goal (null) without failing
    // the load — the conversation still restores. Re-serialized so the
    // loaded record always carries concrete stats.
    goal: serializeGoalForPersist(restoreGoalFromPersist(data["goal"])),
    history: history as ChatMessage[],
    turns: turns as SessionTurn[],
  };
}
