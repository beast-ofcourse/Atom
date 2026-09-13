// Extension host (tickets 01-07): discovery, loading, lifecycle, trust gate.
//
// An extension is a local .ts/.js file exporting a factory function that
// receives an ExtensionAPI and registers subscriptions. Loading is
// same-process dynamic import via jiti (TypeScript-capable, no sandbox):
// extension code runs with full user privileges, exactly like app code.
// Trust posture (ticket 07): global-scope extensions are user-owned and
// implicitly trusted (like the user's own config); project-scope + explicit
// paths never execute until the project is trusted (LoadOptions.projectTrusted,
// driven by the App's one-time trust prompt + the project-trust store) or
// are skipped by the lockdown / enable-disable filters. Skipped extensions
// are never imported — their factories never run — and are reported on
// runtime.skipped so the host can show what was left inert and why.
//
// Generations (stale-use rule): every session replacement (switch, /new,
// /resume) invalidates the runtime, bumping a generation counter. API
// objects captured before the bump throw on any further use; event handlers
// always receive a fresh, current-generation API. This makes
// use-after-replacement a loud error instead of a silent wrong-session bug.
//
// This module never throws out of loadExtensions: per-extension failures are
// recorded on the runtime. It never touches React, the TUI, or LLM clients.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti";
import { atomDir } from "./auth.js";
import {
  TOOL_DEFINITIONS,
  registerExtensionTool,
  registerExtensionToolOverride,
  validateExtensionToolDef,
  type ExtensionToolDefinition,
  type ExtensionToolOverrideDefinition,
} from "./tools/registry.js";
import {
  registerExtensionPromptHint,
  validateExtensionPromptHint,
  validateExtensionToolOverrideDef,
} from "./tools/overrides.js";
import {
  registerAfterToolCall,
  registerBeforeToolCall,
  type AfterToolCallHandler,
  type BeforeToolCallHandler,
} from "./tools/intercept.js";
import {
  registerAfterResponse,
  registerBeforeRequest,
  registerContextTransform,
  type AfterResponseHandler,
  type BeforeRequestHandler,
  type ContextTransformHandler,
} from "./tools/provider-hooks.js";
import {
  registerBeforeCompact,
  type BeforeCompactHandler,
} from "./tools/compaction-hooks.js";
import {
  registerExtensionCommand as registerCommandInStore,
  validateExtensionCommandDef,
  type ExtensionCommandDefinition,
} from "./extension-commands.js";
import {
  validateDialogDef,
  validateNotifyMessage,
  validateStatusSegment,
  validateWidgetDef,
  type ExtensionDialogDef,
  type ExtensionWidgetDef,
  type ExtensionWidgetPlacement,
  type ValidatedWidgetDef,
} from "./extension-ui.js";
import {
  getSession as readSessionRecord,
  updateSession as writeSessionRecord,
} from "./sessions.js";
import { matchGlob } from "./permissions.js";

export const EXTENSIONS_DIRNAME = "extensions";

// Staged extension notices are drained into the transcript on render. Cap the
// queue drop-oldest so a chatty extension cannot grow memory between drains.
export const EXT_NOTICE_CAP = 100;

// Extra extension paths from the environment (path.delimiter-separated).
// Explicit configuration; honored alongside the two discovered scopes.
export const EXTENSIONS_ENV = "ATOM_EXTENSIONS";

export type ExtensionEventName = "session_start" | "session_shutdown";

export type ExtensionEventInfo = {
  /** Startup, session switch, /new, /resume, reload, quit — open string for future reasons. */
  reason: string;
};

export type ExtensionEventHandler = (
  api: ExtensionAPI,
  info: ExtensionEventInfo
) => void | Promise<void>;

// Session switch gate (ticket 05): a cancellable check that runs BEFORE any
// snapshot/persist/mutate step, so a cancelled switch leaves the live
// session completely untouched. Only an explicit cancel decision vetoes —
// void/undefined/null/false/{cancel:false} allow, a throwing handler is
// recorded and fails OPEN (a buggy extension must never hold navigation
// hostage). Cancel shapes: true (default reason naming the extension), a
// non-empty string (that reason), or { cancel: true | "reason" }.
export type BeforeSwitchInfo = {
  /** Active session id before the switch (null when the store holds none). */
  fromSessionId: string | null;
  /** Target session id the host is about to make live. */
  toSessionId: string;
  /** Always "switch" today — open string for future gated transitions. */
  reason: string;
};

export type BeforeSwitchDecision =
  | void
  | undefined
  | null
  | boolean
  | string
  | { cancel?: boolean | string };

export type BeforeSwitchHandler = (
  api: ExtensionAPI,
  info: BeforeSwitchInfo
) => BeforeSwitchDecision | Promise<BeforeSwitchDecision>;

export type BeforeSwitchResult =
  | { cancelled: false }
  | { cancelled: true; reason: string };

/** Minimal v1 capability surface. Later tickets extend this interface. */
export type ExtensionAPI = {
  /** Extension name (directory/file stem fallback, see resolveExtensionName). */
  readonly name: string;
  /**
   * Subscribe to a lifecycle event. Throws when called on a stale (pre-
   * replacement) API object. Returns an unsubscribe function.
   */
  on(event: ExtensionEventName, handler: ExtensionEventHandler): () => void;
  /**
   * Register a brand-new model-callable tool (name, JSON parameters schema,
   * execute). The tool behaves like a builtin from the model's perspective:
   * it appears in the tool definitions, validates args inline, and dispatches
   * through the shared loop. It always executes serially (no scheduler
   * metadata) and requires approval by default unless the definition opts
   * out with requireApproval:false. Throws on invalid shapes, builtin-name
   * collisions, duplicate names, and when called on a stale (pre-
   * replacement) API object. Returns an unregister function.
   */
  registerTool(def: ExtensionToolDefinition): () => void;
  /**
   * Shadow a builtin tool by name with an audited, reversible override
   * (name, execute with ctx.passthrough). The shadowing is never silent:
   * the builtin's model-visible definition, activity label, and /tools
   * one-liner all carry an override marker naming this extension, and
   * removing the registration restores the pristine builtin with no
   * residue. The override receives every call and decides per call — deny
   * a subset with a reason (throw, or return an `Error:` result) or pass
   * the rest through via ctx.passthrough (the default); deny-by-default
   * shadowing is forbidden (the builtin stays reachable through
   * passthrough). Builtin arg validation runs before the override and
   * re-runs inside passthrough. Throws on invalid shapes, non-builtin
   * names, duplicate overrides, and when called on a stale (pre-
   * replacement) API object. Returns an unregister function.
   */
  overrideTool(def: ExtensionToolOverrideDefinition): () => void;
  /**
   * Contribute a short model-facing guidance string (e.g. how to use the
   * extension's tools) to the model's system context. Hints append under an
   * "Extension hints" section of the assembled system prompt in registration
   * order — the existing prompt assembly, never a parallel pipeline. Throws
   * on empty/oversize hints and when called on a stale (pre-replacement)
   * API object. Returns an unregister function.
   */
  addPromptHint(hint: string): () => void;
  /**
   * Register a real slash command (`/name args`) that appears in the
   * command palette and the "/" menu and runs extension code outside the
   * model turn loop. The handler receives a generation-bound context
   * (prompt the user, read a session snapshot, post messages); a throwing
   * handler surfaces as a clean transcript error and leaves the model
   * session untouched. Names are bare lowercase [a-z0-9_-] in the
   * definition; builtins always win — a colliding name fails activation
   * loudly (nothing commits) so a builtin can never be shadowed. Throws
   * on invalid shapes, builtin collisions, duplicate names, and when
   * called on a stale (pre-replacement) API object. Returns unregister.
   */
  registerCommand(def: ExtensionCommandDefinition): () => void;
  /**
   * Observe every tool call before execution (builtins and custom tools
   * alike, no custom tools required). Handlers run in registration order,
   * pre-validation and pre-approval: each may return `{ args }` to rewrite
   * the arguments (later handlers see the rewrite; rewrites re-validate
   * before execution) or `{ block: reason }` (a plain string return, or
   * `{ block: true }`) to veto the call — the reason commits as a normal
   * model-visible result and approval is skipped entirely (first block
   * wins). A throwing handler fails closed: the call is blocked and the
   * turn continues. Throws when called on a stale (pre-replacement) API
   * object. Returns an unregister function.
   */
  onBeforeToolCall(handler: BeforeToolCallHandler): () => void;
  /**
   * Observe every committed tool result (executions, blocks, denials,
   * validation errors). Handlers run in registration order inside the
   * commit funnel and may return a string or `{ content }` to patch what
   * the model sees; tool_call_id re-pairing and commit order are
   * untouched. A throwing handler degrades to the unpatched result.
   * Throws when called on a stale (pre-replacement) API object. Returns
   * an unregister function.
   */
  onAfterToolCall(handler: AfterToolCallHandler): () => void;
  /**
   * Veto a pending session switch (ticket 05). Handlers run in registration
   * order with a fresh generation-bound API; the first explicit cancel wins
   * and later handlers never run. A throwing handler is recorded and fails
   * open (the switch proceeds). Throws when called on a stale
   * (pre-replacement) API object. Returns an unregister function.
   */
  onBeforeSwitch(handler: BeforeSwitchHandler): () => void;
  /**
   * Transform the outgoing conversation context before it is sent (ticket
   * 08). Handlers run in registration order per POST over every provider
   * kind (OpenAI-shape, Anthropic, Gemini); each sees the previous
   * handler's output and may return a replacement message array
   * (void/null/undefined passes through). A throwing handler — or a
   * malformed return — degrades to the untransformed value (fail open),
   * never a broken request. The loop transcript is untouched: only the
   * per-POST copy is transformed. Throws when called on a stale
   * (pre-replacement) API object. Returns an unregister function.
   */
  onTransformContext(handler: ContextTransformHandler): () => void;
  /**
   * Inspect or replace the outgoing provider payload and headers (ticket
   * 08). Handlers run in registration order per POST over every provider
   * kind; each sees the previous handler's output and may return
   * `{ payload }` to replace the body wholesale (must be a record —
   * anything else is ignored so the downstream JSON/fetch handling is
   * never bypassed) and/or `{ headers }` for per-key mutation (a string
   * sets/overwrites, null/undefined DELETES the key, anything else is
   * ignored). A throwing handler is skipped fail-open (its change dropped,
   * the chain continues) so one buggy hook never fails the turn. Throws
   * when called on a stale (pre-replacement) API object. Returns unregister.
   */
  onBeforeRequest(handler: BeforeRequestHandler): () => void;
  /**
   * Observe the provider's response without breaking the turn (ticket 08).
   * Handlers run in registration order per resolved POST over every
   * provider kind with a `{ provider, model, url, status, ok, headers }`
   * snapshot (ok and HTTP-error alike; network throws never fire). Purely
   * observe-only: return values are ignored and a throwing handler is
   * dropped fail-open. Throws when called on a stale (pre-replacement)
   * API object. Returns an unregister function.
   */
  onAfterResponse(handler: AfterResponseHandler): () => void;
  /**
   * Observe or veto a pending compaction (ticket 09). Handlers run in
   * registration order BEFORE any snapshot/persist/mutate step with the
   * reason (auto, manual, overflow) and the pending head/tail split as
   * read-only deep copies — a mutating hook cannot corrupt planning. Each
   * may return { cancel: true | "reason" } (or true / a reason string, the
   * before_switch convention) to veto — the first cancel wins and later
   * handlers never run, leaving history, snapshots, totals, and ledger
   * byte-identical — or { summary: "text" } to replace the builtin
   * summarizer output (the first valid summary wins; the text flows through
   * the normal compacted-history path exactly like builtin output). A
   * throwing handler degrades to default builtin compaction with a visible
   * error, never a half-compacted session. Throws when called on a stale
   * (pre-replacement) API object. Returns an unregister function.
   */
  onBeforeCompact(handler: BeforeCompactHandler): () => void;
  /**
   * Read this extension's per-session state for the current session (ticket
   * 05): the namespaced slot under the sessions store record's metadata
   * field, so it persists across resume and reload with the session itself.
   * Returns undefined when nothing was stored (or when no session is bound).
   * The returned value is a fresh read — mutating it persists nothing; call
   * setSessionState. Throws when called on a stale (pre-replacement) API
   * object. State writes bump the record's updatedAt (they are mutations).
   */
  getSessionState(): unknown;
  /**
   * Persist this extension's per-session state into the current session's
   * store record (ticket 05; durable via the sessions store metadata field,
   * never in-memory-only). The value must be JSON-serializable; undefined
   * clears the slot. Throws on unserializable values, when no session is
   * bound, when the record is gone, and when called on a stale
   * (pre-replacement) API object.
   */
  setSessionState(value: unknown): void;
  /**
   * Query the ticket-07 project-trust state for this load (true when the
   * project is trusted or the extension is global-scope, false when project
   * / explicit extensions are running inert). Use it to degrade gracefully
   * (e.g. skip project-file reads, register read-only commands) instead of
   * assuming trust. Throws when called on a stale (pre-replacement) API
   * object, like every other method.
   */
  isProjectTrusted(): boolean;
  /**
   * Contribute this extension's status-bar segment (ticket 10): one text
   * slot per extension (upsert by owner name), rendered in the bar's fixed
   * extension budget and updated live by calling again across turns (each
   * call returns its own unregister; any of them removes the slot, so the
   * latest handle is the one to keep). Empty/oversize text throws
   * fail-closed. Throws when called on a stale (pre-replacement) API
   * object. Returns an unregister function (zero residue on unload).
   */
  setStatusSegment(text: string): () => void;
  /**
   * Contribute a panel widget (ticket 10): a titled text block keyed by
   * owner + id (default "main"), rendered by the App in the configured
   * placement. Calling again with the same id updates the widget in place
   * (each call returns its own unregister; any of them removes that id).
   * Bad shapes and unknown placements throw fail-closed. Throws when
   * called on a stale (pre-replacement) API object. Returns unregister.
   */
  setWidget(def: ExtensionWidgetDef): () => void;
  /**
   * Post a transient transcript notice (ticket 10): `(name) message`, one
   * info line the App drains into the conversation. Fire-and-forget (sync,
   * returns void) — it never blocks, headless or not — and vanishes on
   * drain or session teardown, so there is nothing to leak. Throws on
   * empty/oversize messages and when called on a stale (pre-replacement)
   * API object.
   */
  notify(message: string): void;
  /**
   * Ask the user a question in a modal dialog (ticket 10), resolved with
   * the picked option or custom text. Single-flight per runtime: a second
   * request while one is pending rejects immediately (never queues, never
   * hangs). Rejects immediately in non-interactive mode (nothing is shown)
   * and when called during activation (prompt from a command or event
   * handler instead). A session replacement while pending rejects with the
   * stale error — the dialog never hangs and never acts on the wrong
   * session. Throws synchronously when called on a stale API object.
   */
  promptUser(question: string, options?: string[], allowCustom?: boolean): Promise<string>;
};

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export type LoadedExtension = {
  /** Absolute path of the loaded entry file. */
  path: string;
  name: string;
};

export type ExtensionLoadError = {
  /** Absolute path (or attempted path) of the failed entry. */
  path: string;
  error: string;
};

// Why an extension was left inert without executing (never imported, factory
// never ran). The host surfaces these so a declined/untrusted/locked-down
// project stays visible, with how to enable.
export type ExtensionSkipReason =
  | "untrusted-project"
  | "lockdown"
  | "disabled"
  | "not-enabled";

export type ExtensionSkipped = {
  /** Absolute path of the skipped entry. */
  path: string;
  name: string;
  reason: ExtensionSkipReason;
};

// Ticket-10 UI surface records (copies cross the runtime boundary —
// callers can never alias live store state, the deep-copy rule from the
// interception/provider precedents).
export type ExtensionStatusSegment = {
  /** Extension name that owns the slot (one slot per extension). */
  owner: string;
  /** Current raw text (the bar truncates per its fixed budget at render). */
  text: string;
};

export type ExtensionWidgetRecord = {
  /** Extension name that owns the widget. */
  owner: string;
  /** Widget id within the extension (default "main"). */
  id: string;
  placement: ExtensionWidgetPlacement;
  title: string;
  text: string;
};

export type ExtensionNotice = {
  /** Extension name that posted the notice. */
  owner: string;
  message: string;
};

export type ExtensionPendingDialog = {
  id: number;
  owner: string;
  question: string;
  options: string[];
  allowCustom: boolean;
};

export type ExtensionRuntime = {
  loaded: LoadedExtension[];
  errors: ExtensionLoadError[];
  /** Entries left inert without executing (never imported), with the reason. */
  skipped: ExtensionSkipped[];
  /** One extension status slot (owner + current text), in first-set order. */
  getStatusSegments(): ExtensionStatusSegment[];
  /** Live panel widgets (owner + id + placement + content), in first-set order. */
  getWidgets(): ExtensionWidgetRecord[];
  /** Staged transcript notices, oldest first; drains (clears) the queue. */
  drainNotifications(): ExtensionNotice[];
  /** The currently open extension dialog, if any (a copy — mutating it changes nothing). */
  getPendingDialog(): ExtensionPendingDialog | null;
  /** Re-render subscription for the host (every UI mutation emits). Returns an unsubscribe function. */
  subscribeUI(listener: () => void): () => void;
  /**
   * Fulfill the pending dialog with the user's answer (host-side). Returns
   * false when no dialog is pending or the answer is empty (the dialog
   * stays open); otherwise resolves the extension's promise and returns
   * true. Never throws.
   */
  resolvePendingDialog(answer: string): boolean;
  /**
   * Dismiss the pending dialog with a clean error (host-side, e.g. Esc).
   * Returns false when no dialog is pending. Never throws.
   */
  cancelPendingDialog(reason?: string): boolean;
  /**
   * Session-teardown cleanup (ticket 10): removes every UI contribution
   * (segments, widgets, undrained notices) with zero residue and rejects
   * a pending dialog with a teardown error. The host calls this on
   * unmount/shutdown; registrations and event handlers are untouched.
   * Never throws.
   */
  disposeUI(): void;
  /**
   * Release everything this runtime committed (reload support): every
   * global registration (tools, overrides, commands, hints, interceptors,
   * provider and compaction hooks, switch gates) is unregistered
   * best-effort, handed-out APIs go stale (same rule as invalidate), and
   * the runtime-local UI surface clears. Per-session extension state is
   * untouched — it rides the session record and survives reloads by
   * design. After unload the same entry paths load cleanly again.
   * Never throws.
   */
  unload(): void;
  /** Emit a lifecycle event to handlers in registration order; per-handler failures are recorded, never thrown. */
  emit(event: ExtensionEventName, info: ExtensionEventInfo): Promise<void>;
  /**
   * Invalidate all previously handed-out API objects (session replacement).
   * After this, any use of a captured API throws Error(message).
   */
  invalidate(message: string): void;
  /** Current generation (bumped by every invalidate). */
  generation: number;
  /**
   * Bind the session that get/setSessionState scope to (ticket 05). The
   * host sets this on every session boundary (startup/new/resume/switch)
   * before emitting session_start, so start handlers observe the NEW
   * session's state. Null unbinds (reads yield undefined, writes throw).
   * Never throws.
   */
  setSessionId(id: string | null): void;
  /**
   * Run before_switch handlers in registration order with fresh
   * generation-bound APIs (ticket 05). First explicit cancel wins (later
   * handlers never run); throwing handlers are recorded and fail open.
   * Never rejects — handler failures are recorded, never thrown.
   */
  requestSwitch(info: BeforeSwitchInfo): Promise<BeforeSwitchResult>;
};

type HandlerRecord = {
  extensionPath: string;
  handler: ExtensionEventHandler;
};

type BeforeSwitchRecord = {
  extensionPath: string;
  handler: BeforeSwitchHandler;
};

// Per-session extension state lives namespaced here: record metadata
// `{ ..., extensions: { [extName]: state } }` in the sessions store — the
// existing durable per-session record, so state survives resume and reload
// with the session itself and no parallel store is ever introduced.
const EXT_STATE_KEY = "extensions";

function assertJsonSerializable(value: unknown, what: string): void {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    throw new Error(`${what} must be JSON-serializable: ${errorText(e)}`);
  }
  if (text === undefined) {
    throw new Error(`${what} must be JSON-serializable (functions and undefined do not persist)`);
  }
}

// Cancel interpretation (single rule for requestSwitch): only an explicit
// veto cancels — true (default reason), a string (that reason, empty falls
// back to the default), or { cancel: true | "reason" }. Everything else
// (void/null/false/{cancel:false}/foreign shapes) allows.
function cancelReasonOf(decision: BeforeSwitchDecision, extName: string): string | null {
  if (decision === true) return `extension "${extName}" cancelled the session switch`;
  if (typeof decision === "string") {
    return decision.length > 0
      ? decision
      : `extension "${extName}" cancelled the session switch`;
  }
  if (isRecord(decision)) {
    const cancel = (decision as { cancel?: unknown }).cancel;
    if (cancel === true) return `extension "${extName}" cancelled the session switch`;
    if (typeof cancel === "string") {
      return cancel.length > 0
        ? cancel
        : `extension "${extName}" cancelled the session switch`;
    }
  }
  return null;
}

// Fresh parse per call (the store re-reads the file), so callers can never
// alias persisted state — but mutating the result still persists nothing.
function readExtensionState(home: string | undefined, sessionId: string | null, extName: string): unknown {
  if (sessionId === null) return undefined;
  const record = readSessionRecord(sessionId, home);
  if (!record) return undefined;
  const metadata = record.metadata;
  if (!isRecord(metadata)) return undefined;
  const bag = metadata[EXT_STATE_KEY];
  if (!isRecord(bag)) return undefined;
  return (bag as Record<string, unknown>)[extName];
}

function writeExtensionState(
  home: string | undefined,
  sessionId: string | null,
  extName: string,
  value: unknown
): void {
  if (sessionId === null) {
    throw new Error(`extension "${extName}": no active session to persist state into`);
  }
  // undefined clears the slot; anything else must survive a JSON round-trip
  // (the store persists via JSON.stringify, which would throw there — fail
  // here instead, loudly and before touching the record).
  if (value !== undefined) assertJsonSerializable(value, `extension "${extName}" session state`);
  const record = readSessionRecord(sessionId, home);
  if (!record) {
    throw new Error(`extension "${extName}": session "${sessionId}" is unavailable`);
  }
  const metadata: Record<string, unknown> = isRecord(record.metadata) ? { ...record.metadata } : {};
  const rawBag = metadata[EXT_STATE_KEY];
  const bag: Record<string, unknown> = isRecord(rawBag) ? { ...(rawBag as Record<string, unknown>) } : {};
  if (value === undefined) {
    delete bag[extName];
  } else {
    bag[extName] = value;
  }
  if (Object.keys(bag).length === 0) {
    delete metadata[EXT_STATE_KEY];
  } else {
    metadata[EXT_STATE_KEY] = bag;
  }
  const updated = writeSessionRecord(sessionId, { metadata }, home);
  if (!updated) {
    throw new Error(`extension "${extName}": could not persist session state`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function globalExtensionsDir(home?: string): string {
  return path.join(atomDir(home), EXTENSIONS_DIRNAME);
}

export function projectExtensionsDir(cwd?: string): string {
  const base = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  return path.join(base, ".atom", EXTENSIONS_DIRNAME);
}

const ENTRY_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);
const INDEX_BASENAMES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

function isEntryFile(name: string): boolean {
  return ENTRY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Manifest field for extension-package subdirectories (mirrors the Pi `pi` field convention). */
function readAtomManifest(dir: string): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const atom = data["atom"];
  if (!isRecord(atom)) return null;
  const extensions = atom["extensions"];
  if (!Array.isArray(extensions)) return null;
  const out: string[] = [];
  for (const e of extensions) {
    if (typeof e === "string" && e.length > 0) {
      out.push(path.resolve(dir, e));
    }
  }
  return out;
}

/** Resolve one discovered path to loadable entry files (no recursion beyond one level). */
function resolveEntries(entryPath: string): string[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(entryPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return isEntryFile(path.basename(entryPath)) ? [entryPath] : [];
  }
  if (!stat.isDirectory()) return [];
  const manifest = readAtomManifest(entryPath);
  if (manifest) return manifest;
  for (const base of INDEX_BASENAMES) {
    const candidate = path.join(entryPath, base);
    try {
      if (statSync(candidate).isFile()) return [candidate];
    } catch {
      // try next basename
    }
  }
  return [];
}

function discoverInDir(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of [...names].sort()) {
    if (name.startsWith(".")) continue;
    out.push(...resolveEntries(path.join(dir, name)));
  }
  return out;
}

export type DiscoverOptions = {
  home?: string;
  cwd?: string;
  /** Explicit extra paths (files or directories); highest precedence, listed last. */
  extraPaths?: string[];
};

// Install scope (ticket 07 trust boundary): global-scope extensions live
// under the user's own ~/.atom (user-owned, implicitly trusted); project
// scope is the repo's .atom dir (untrusted until the project is trusted);
// explicit covers ATOM_EXTENSIONS env + extraPaths + any other directly
// named path (also gated — an explicit path is no trust backdoor).
export type ExtensionScope = "project" | "global" | "explicit";

export type DiscoveredExtension = {
  path: string;
  scope: ExtensionScope;
};

/**
 * Ordered, deduplicated entries with scope labels: project scope, global
 * scope, then explicit paths (env ATOM_EXTENSIONS + extraPaths). Missing
 * scopes are silently skipped — never throws.
 */
export function discoverExtensionEntries(opts: DiscoverOptions = {}): DiscoveredExtension[] {
  const seen = new Set<string>();
  const out: DiscoveredExtension[] = [];
  const push = (p: string, scope: ExtensionScope): void => {
    const abs = path.resolve(p);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push({ path: abs, scope });
    }
  };
  for (const p of discoverInDir(projectExtensionsDir(opts.cwd))) push(p, "project");
  for (const p of discoverInDir(globalExtensionsDir(opts.home))) push(p, "global");
  const envRaw = process.env[EXTENSIONS_ENV];
  if (typeof envRaw === "string" && envRaw.length > 0) {
    for (const p of envRaw.split(path.delimiter)) {
      const trimmed = p.trim();
      if (trimmed.length === 0) continue;
      for (const e of resolveEntries(path.resolve(trimmed))) push(e, "explicit");
    }
  }
  for (const p of opts.extraPaths ?? []) {
    for (const e of resolveEntries(path.resolve(p))) push(e, "explicit");
  }
  return out;
}

/**
 * Ordered, deduplicated entry files: project scope, global scope, then
 * explicit paths (env ATOM_EXTENSIONS + extraPaths). Missing scopes are
 * silently skipped — never throws.
 */
export function discoverExtensionPaths(opts: DiscoverOptions = {}): string[] {
  return discoverExtensionEntries(opts).map((e) => e.path);
}

// Scope for a pre-resolved entry file (the LoadOptions.entryPaths seam):
// under the project dir → project, under the global dir → global,
// anywhere else → explicit (gated like project scope).
export function classifyExtensionScope(entryPath: string, opts: DiscoverOptions = {}): ExtensionScope {
  const abs = path.resolve(entryPath);
  const proj = path.resolve(projectExtensionsDir(opts.cwd));
  if (abs === proj || abs.startsWith(proj + path.sep)) return "project";
  const glob = path.resolve(globalExtensionsDir(opts.home));
  if (abs === glob || abs.startsWith(glob + path.sep)) return "global";
  return "explicit";
}

// CLI flags for the trust lockdown + per-extension filters (pure, so cli.tsx
// stays a thin caller and unit tests never import the TUI entry point).
// Repeatable value flags take `--flag value` or `--flag=value`; comma-
// separated values split (whitespace-trimmed, empties dropped).
export type ExtensionFlags = {
  lockdown: boolean;
  enable: string[];
  disable: string[];
};

export function parseExtensionFlags(argv: readonly string[]): ExtensionFlags {
  const out: ExtensionFlags = { lockdown: false, enable: [], disable: [] };
  const takeValue = (args: readonly string[], i: number, name: string): { value?: string; next: number } => {
    const a = args[i]!;
    const eqPrefix = `${name}=`;
    if (a.startsWith(eqPrefix)) return { value: a.slice(eqPrefix.length), next: i };
    if (a === name) {
      const next = args[i + 1];
      // Same convention as cli.tsx --port: a following `-flag` is another
      // flag, not this flag's value.
      if (typeof next === "string" && !next.startsWith("-")) return { value: next, next: i + 1 };
    }
    return { next: i };
  };
  const pushList = (raw: string | undefined, target: string[]): void => {
    if (raw === undefined) return;
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) target.push(trimmed);
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-extensions" || a === "--lockdown") {
      out.lockdown = true;
      continue;
    }
    if (a === "--enable-extension" || a.startsWith("--enable-extension=")) {
      const r = takeValue(argv, i, "--enable-extension");
      i = r.next;
      pushList(r.value, out.enable);
      continue;
    }
    if (a === "--disable-extension" || a.startsWith("--disable-extension=")) {
      const r = takeValue(argv, i, "--disable-extension");
      i = r.next;
      pushList(r.value, out.disable);
      continue;
    }
  }
  return out;
}

export function resolveExtensionName(entryPath: string): string {
  const base = path.basename(entryPath);
  const stem = base.replace(/\.(ts|js|mjs|cjs)$/i, "");
  if (stem.toLowerCase() !== "index") return stem;
  const parent = path.basename(path.dirname(entryPath));
  return parent.length > 0 ? parent : stem;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

export type LoadOptions = DiscoverOptions & {
  /** Pre-resolved entry files (skips discovery when provided). */
  entryPaths?: string[];
  /**
   * Whether the project is trusted (ticket 07). Project-scope + explicit
   * entries never execute while false (recorded on runtime.skipped as
   * untrusted-project); global-scope entries always load. Defaults to true:
   * pre-resolved/direct callers are caller-authorized (the 01-06 suites load
   * tmpdir files this way) — the App host ALWAYS passes the explicit
   * project-trust value, so production is never accidentally trusted.
   */
  projectTrusted?: boolean;
  /**
   * Lockdown: boot with zero third-party extensions (no backdoor — covers
   * project, global, AND explicitly-passed entry paths; everything lands on
   * runtime.skipped as lockdown). Builtins are untouched (they are not
   * extensions). CLI --no-extensions / --lockdown; defaults to false.
   */
  lockdown?: boolean;
  /**
   * Per-extension enable/disable patterns over the extension name
   * (case-sensitive `*`/`?` globs, the permissions.ts dialect via matchGlob).
   * Deterministic precedence, highest first: lockdown > untrusted-project >
   * disabledPatterns > enabledPatterns > load. Disabled wins over enabled;
   * a non-empty enabled list is an allowlist (non-matching entries skip as
   * not-enabled). The host merges CLI over atom.json (CLI wins when set).
   */
  enabledPatterns?: string[];
  disabledPatterns?: string[];
  /**
   * Builtin slash names ("/new", ...) extension commands must not shadow.
   * A collision fails that extension's activation loudly (nothing commits)
   * so a builtin is never shadowed — deterministic, no renamed form to
   * discover. App passes SLASH_COMMANDS; absent means no check (dispatch
   * still routes builtins first as backstop).
   */
  builtinSlashCommands?: readonly string[];
  /**
   * Session the runtime's get/setSessionState scope to (ticket 05). The
   * host re-binds via runtime.setSessionId on every boundary; defaults to
   * null (unbound). The same home doubles as the sessions store base
   * (sessions live under atomDir(home), mirroring globalExtensionsDir).
   */
  sessionId?: string | null;
  /**
   * Whether a live TUI is fulfilling extension dialogs (ticket 10). The
   * App host always passes true; headless paths (--dashboard/--serve never
   * load extensions at all) and the default false make promptUser reject
   * immediately instead of hanging with no modal to answer it. Status,
   * widgets, and notices record either way (they never block).
   */
  interactive?: boolean;
};

// Module evaluation is deliberately NOT shared across loadExtensions calls:
// jiti keeps a runtime module cache per instance, so a singleton would
// serve stale code when an extension file changes between loads. Each load
// mints one fresh importer (shared by that load's entries only), making
// re-loading after an edit evaluate the current file contents.

function resolveFactory(mod: unknown): ExtensionFactory | null {
  if (typeof mod === "function") return mod as ExtensionFactory;
  if (isRecord(mod)) {
    const def = (mod as { default?: unknown }).default;
    if (typeof def === "function") return def as ExtensionFactory;
  }
  return null;
}

/**
 * Load every discovered extension. Never throws: each failure is recorded
 * in runtime.errors with its path, and loading continues with the rest.
 */
export async function loadExtensions(opts: LoadOptions = {}): Promise<ExtensionRuntime> {
  // Ticket-07 gate inputs (precedence: lockdown > untrusted-project >
  // disabledPatterns > enabledPatterns > load; disabled wins over enabled).
  // projectTrusted defaults true for direct programmatic callers (tests,
  // tooling); the App always passes the explicit boot trust value, so
  // production project scope stays gated.
  const lockdown = opts.lockdown === true;
  const trusted = opts.projectTrusted !== false;
  const enabled = opts.enabledPatterns ?? [];
  const disabled = opts.disabledPatterns ?? [];
  // Scoped entries: discovery already labels scope; pre-resolved entryPaths
  // are classified by location (project dir → project, global dir → global,
  // anywhere else → explicit). Entry order is preserved either way.
  const scoped: DiscoveredExtension[] =
    opts.entryPaths !== undefined
      ? opts.entryPaths.map((p) => ({ path: path.resolve(p), scope: classifyExtensionScope(p, opts) }))
      : discoverExtensionEntries(opts);
  // The gate: skipped entries are never imported (factory never runs — fully
  // inert), only recorded with the reason so the host stays visible.
  const skipped: ExtensionSkipped[] = [];
  const entryPaths: string[] = [];
  for (const e of scoped) {
    const name = resolveExtensionName(e.path);
    if (lockdown) {
      skipped.push({ path: e.path, name, reason: "lockdown" });
      continue;
    }
    // Global-scope extensions are user-owned (implicitly trusted, like the
    // user's own config); the gate applies to project-scope + explicit paths.
    if (e.scope !== "global" && !trusted) {
      skipped.push({ path: e.path, name, reason: "untrusted-project" });
      continue;
    }
    if (disabled.some((pattern) => matchGlob(pattern, name))) {
      skipped.push({ path: e.path, name, reason: "disabled" });
      continue;
    }
    if (enabled.length > 0 && !enabled.some((pattern) => matchGlob(pattern, name))) {
      skipped.push({ path: e.path, name, reason: "not-enabled" });
      continue;
    }
    entryPaths.push(e.path);
  }
  const handlers = new Map<ExtensionEventName, HandlerRecord[]>();
  // Cancellable switch gate (ticket 05): runtime-local like event handlers
  // (never a global store — a replaced runtime must not leak vetoes).
  const beforeSwitchHandlers: BeforeSwitchRecord[] = [];
  const loaded: LoadedExtension[] = [];
  const errors: ExtensionLoadError[] = [];
  // Reload support: every global registration a successful activation
  // commits (tools, overrides, commands, hints, interceptors, provider
  // and compaction hooks, switch gates) lands here via its unregister
  // closure, so unload() below can release the whole runtime with zero
  // residue and the same entries load cleanly again.
  const committedUndos: Array<() => void> = [];
  let generation = 0;
  let staleMessage: string | null = null;
  // Session scoping for get/setSessionState (ticket 05): the store base is
  // the load home; the host re-binds the id on every session boundary.
  const sessionHome = opts.home;
  let currentSessionId: string | null =
    typeof opts.sessionId === "string" && opts.sessionId.length > 0 ? opts.sessionId : null;

  // Ticket-10 UI surface: runtime-local like beforeSwitchHandlers (a
  // replaced runtime never leaks segments into another lineage, and
  // parallel runtimes in tests never observe each other). Segments and
  // widgets persist across session replacement keyed by owner — the fresh
  // session_start API updates the same slots — and clear only on unload
  // (unregister) or teardown (disposeUI). Only the pending dialog is
  // transient: invalidate rejects it so it never hangs across a switch.
  const interactive = opts.interactive === true;
  const statusSegments = new Map<string, string>();
  const widgets = new Map<string, ExtensionWidgetRecord>();
  const notifications: ExtensionNotice[] = [];
  type PendingDialogState = {
    id: number;
    owner: string;
    question: string;
    options: string[];
    allowCustom: boolean;
    generation: number;
    resolve: (answer: string) => void;
    reject: (err: Error) => void;
  };
  let pendingDialog: PendingDialogState | null = null;
  let dialogSeq = 0;
  const uiListeners = new Set<() => void>();
  const emitUI = (): void => {
    for (const fn of [...uiListeners]) {
      try {
        fn();
      } catch {
        // Listener errors never break the host (same best-effort rule as emit).
      }
    }
  };
  const widgetKey = (owner: string, id: string): string => `${owner}∅${id}`;

  const addBeforeSwitchHandler = (extensionPath: string, handler: BeforeSwitchHandler): (() => void) => {
    const record: BeforeSwitchRecord = { extensionPath, handler };
    beforeSwitchHandlers.push(record);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const idx = beforeSwitchHandlers.indexOf(record);
      if (idx >= 0) beforeSwitchHandlers.splice(idx, 1);
    };
  };

  // Builtin slash names (slash-prefixed) extension commands must not
  // shadow — checked after shape validation whenever a command registers.
  const builtinSlash = new Set(
    (opts.builtinSlashCommands ?? []).map((n) => (n.startsWith("/") ? n : `/${n}`))
  );
  const assertCommandNameFree = (def: ExtensionCommandDefinition): void => {
    if (builtinSlash.has(`/${def.name}`)) {
      throw new Error(`extension command "/${def.name}" collides with a builtin command (builtins always win)`);
    }
  };

  const makeApi = (name: string, extensionPath: string): ExtensionAPI => {
    // Generation captured at creation: any use after a later invalidate
    // throws, while APIs minted fresh at emit time stay live.
    const apiGeneration = generation;
    const staleCheck = (): void => {
      if (apiGeneration !== generation) {
        throw new Error(staleMessage ?? "extension context is stale after a session replacement");
      }
    };
    return {
      name,
      on: (event, handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": handler for "${event}" must be a function`);
        }
        let list = handlers.get(event);
        if (!list) {
          list = [];
          handlers.set(event, list);
        }
        const record: HandlerRecord = { extensionPath, handler };
        list.push(record);
        return () => {
          const current = handlers.get(event);
          if (!current) return;
          const idx = current.indexOf(record);
          if (idx >= 0) current.splice(idx, 1);
        };
      },
      registerTool: (def) => {
        staleCheck();
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerExtensionTool(def);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      overrideTool: (def) => {
        staleCheck();
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerExtensionToolOverride(def, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      addPromptHint: (hint) => {
        staleCheck();
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerExtensionPromptHint(hint, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      registerCommand: (def) => {
        staleCheck();
        validateExtensionCommandDef(def);
        assertCommandNameFree(def);
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerCommandInStore(def, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      onBeforeToolCall: (handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": before-tool-call handler must be a function`);
        }
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerBeforeToolCall(handler, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      onAfterToolCall: (handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": after-tool-call handler must be a function`);
        }
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerAfterToolCall(handler, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      onBeforeSwitch: (handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": before-switch handler must be a function`);
        }
        const apiGenerationAtCall = apiGeneration;
        const unregister = addBeforeSwitchHandler(extensionPath, handler);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      onTransformContext: (handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": context-transform handler must be a function`);
        }
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerContextTransform(handler, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      onBeforeRequest: (handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": before-request handler must be a function`);
        }
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerBeforeRequest(handler, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      onAfterResponse: (handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": after-response handler must be a function`);
        }
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerAfterResponse(handler, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      onBeforeCompact: (handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": before-compact handler must be a function`);
        }
        const apiGenerationAtCall = apiGeneration;
        const unregister = registerBeforeCompact(handler, name);
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          unregister();
        };
      },
      getSessionState: () => {
        staleCheck();
        return readExtensionState(sessionHome, currentSessionId, name);
      },
      setSessionState: (value) => {
        staleCheck();
        writeExtensionState(sessionHome, currentSessionId, name, value);
      },
      isProjectTrusted: () => {
        staleCheck();
        return trusted;
      },
      setStatusSegment: (text) => {
        staleCheck();
        // Eager shape check: a bad segment fails loudly (fail-closed), the
        // slot upserts by owner so calling again updates live across turns
        // (each call returns its own unregister; any of them removes the
        // whole slot, so the latest handle is the one to keep).
        const clean = validateStatusSegment(name, text);
        const apiGenerationAtCall = apiGeneration;
        statusSegments.set(name, clean);
        emitUI();
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          statusSegments.delete(name);
          emitUI();
        };
      },
      setWidget: (def) => {
        staleCheck();
        // Eager shape + placement check: a bad widget fails loudly
        // (fail-closed); same-id calls upsert in place for live updates.
        const clean = validateWidgetDef(name, def);
        const apiGenerationAtCall = apiGeneration;
        const key = widgetKey(name, clean.id);
        widgets.set(key, { owner: name, ...clean });
        emitUI();
        let live = true;
        return () => {
          if (apiGenerationAtCall !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!live) return;
          live = false;
          widgets.delete(key);
          emitUI();
        };
      },
      notify: (message) => {
        staleCheck();
        // Transient by design: staged for the host to drain into the
        // transcript, dropped on teardown — nothing to unregister.
        // Bounded (drop-oldest past EXT_NOTICE_CAP) so a chatty extension
        // cannot grow memory between render drains.
        notifications.push({ owner: name, message: validateNotifyMessage(name, message) });
        if (notifications.length > EXT_NOTICE_CAP) {
          notifications.splice(0, notifications.length - EXT_NOTICE_CAP);
        }
        emitUI();
      },
      promptUser: (question, options, allowCustom) => {
        staleCheck();
        const clean = validateDialogDef(name, { question, options, allowCustom });
        if (!interactive) {
          return Promise.reject(
            new Error(`extension "${name}": dialogs are unavailable in non-interactive mode (no prompt was shown)`)
          );
        }
        if (pendingDialog) {
          return Promise.reject(
            new Error("(an extension dialog is already open — wait for it to resolve)")
          );
        }
        const apiGenerationAtCall = apiGeneration;
        const id = (dialogSeq += 1);
        return new Promise<string>((resolve, reject) => {
          pendingDialog = {
            id,
            owner: name,
            question: clean.question,
            options: clean.options,
            allowCustom: clean.allowCustom,
            generation: apiGenerationAtCall,
            resolve: (answer: string) => {
              if (pendingDialog?.id !== id) return;
              pendingDialog = null;
              emitUI();
              resolve(answer);
            },
            reject: (err: Error) => {
              if (pendingDialog?.id !== id) return;
              pendingDialog = null;
              emitUI();
              reject(err);
            },
          };
          emitUI();
        });
      },
    };
  };

  // Shared stale-lineage step for invalidate() and unload(): the
  // generation bump makes every previously handed-out API throw, staged
  // notices are dropped so they never print into a newer lineage, and a
  // pending dialog rejects instead of hanging across the boundary.
  const doInvalidate = (message: string): void => {
    staleMessage = message;
    generation += 1;
    // Staged notices belong to the dead lineage: drop them here, or the
    // next render drain would print pre-switch notices into the NEW
    // session's transcript (stale async content behind a newer commit).
    // Fresh session_start handlers re-notify via their new API.
    // (Mirrors disposeUI below, which drops them on teardown.)
    notifications.length = 0;
    // A dialog awaiting input across a session switch resolves safely:
    // reject with the stale message (never hangs, never fulfills into
    // the wrong session). Visible segments/widgets persist keyed by
    // owner — the fresh session_start API updates the same slots.
    const cur = pendingDialog;
    if (cur) cur.reject(new Error(message));
  };
  const runtime: ExtensionRuntime = {
    loaded,
    errors,
    skipped,
    get generation() {
      return generation;
    },
    invalidate(message: string): void {
      doInvalidate(message);
    },
    async emit(event, info): Promise<void> {
      const list = handlers.get(event) ?? [];
      for (const record of [...list]) {
        const api = makeApi(resolveExtensionName(record.extensionPath), record.extensionPath);
        try {
          await record.handler(api, info);
        } catch (e) {
          errors.push({ path: record.extensionPath, error: `${event} handler failed: ${errorText(e)}` });
        }
      }
    },
    setSessionId(id: string | null): void {
      currentSessionId = typeof id === "string" && id.length > 0 ? id : null;
    },
    // Ticket-10 host reads (all copies — callers can never alias live
    // store state) and host-side dialog settlement. Never throw except
    // subscribeUI's shape check (the on() convention).
    getStatusSegments(): ExtensionStatusSegment[] {
      return [...statusSegments].map(([owner, text]) => ({ owner, text }));
    },
    getWidgets(): ExtensionWidgetRecord[] {
      return [...widgets.values()].map((w) => ({ ...w }));
    },
    drainNotifications(): ExtensionNotice[] {
      const out = notifications.map((n) => ({ ...n }));
      notifications.length = 0;
      return out;
    },
    getPendingDialog(): ExtensionPendingDialog | null {
      if (!pendingDialog) return null;
      return {
        id: pendingDialog.id,
        owner: pendingDialog.owner,
        question: pendingDialog.question,
        options: [...pendingDialog.options],
        allowCustom: pendingDialog.allowCustom,
      };
    },
    subscribeUI(listener: () => void): () => void {
      if (typeof listener !== "function") {
        throw new Error("extension UI listener must be a function");
      }
      uiListeners.add(listener);
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        uiListeners.delete(listener);
      };
    },
    resolvePendingDialog(answer: string): boolean {
      const cur = pendingDialog;
      if (!cur) return false;
      if (typeof answer !== "string" || answer.length === 0) return false;
      cur.resolve(answer);
      return true;
    },
    cancelPendingDialog(reason?: string): boolean {
      const cur = pendingDialog;
      if (!cur) return false;
      cur.reject(
        new Error(
          typeof reason === "string" && reason.length > 0
            ? reason
            : `extension "${cur.owner}" dialog was cancelled`
        )
      );
      return true;
    },
    disposeUI(): void {
      statusSegments.clear();
      widgets.clear();
      notifications.length = 0;
      const cur = pendingDialog;
      if (cur) {
        cur.reject(new Error(`extension "${cur.owner}" dialog was cancelled (session teardown)`));
      } else {
        emitUI();
      }
    },
    unload(): void {
      // The old lineage goes stale first (same rule as invalidate: captured
      // APIs throw instead of acting on a replaced runtime), then every
      // committed global registration is released best-effort and the
      // runtime-local UI surface clears. Session state is untouched.
      doInvalidate("extension runtime unloaded (reload)");
      for (const undo of committedUndos.splice(0)) {
        try {
          undo();
        } catch {
          // release is best-effort; the load report carries real failures
        }
      }
      statusSegments.clear();
      widgets.clear();
      emitUI();
    },
    // The sanctioned pre-replacement gate: the host awaits this BEFORE any
    // snapshot/persist/mutate step. Handlers observe fresh APIs; the first
    // explicit cancel wins (later handlers never run); throws fail open.
    // The sanctioned post-replacement continuation is the fresh API passed
    // to session_start handlers by emit — captured pre-replacement handles
    // throw via the generation check above (reused, never reimplemented).
    async requestSwitch(info): Promise<BeforeSwitchResult> {
      for (const record of [...beforeSwitchHandlers]) {
        const extName = resolveExtensionName(record.extensionPath);
        const api = makeApi(extName, record.extensionPath);
        let decision: BeforeSwitchDecision;
        try {
          decision = await record.handler(api, info);
        } catch (e) {
          errors.push({ path: record.extensionPath, error: `before_switch handler failed: ${errorText(e)}` });
          continue;
        }
        const reason = cancelReasonOf(decision, extName);
        if (reason !== null) return { cancelled: true, reason };
      }
      return { cancelled: false };
    },
  };

  // Reload-safe evaluation: Node's ESM loader caches by URL and
  // jiti's per-instance cache would otherwise serve stale code after an
  // edit. Read the current source and evaluate it in an isolated module
  // cache that lives only for this load, so a second load sees the new
  // file contents. forceTranspile bypasses the native .js fast-path that
  // would still hit Node's require cache.
  const importer = createJiti(import.meta.url);
  const evalCache = Object.create(null) as unknown as import("jiti").ModuleCache;
  for (const entryPath of entryPaths) {
    const name = resolveExtensionName(entryPath);
    let mod: unknown;
    try {
      const source = readFileSync(entryPath, "utf8");
      mod = await importer.evalModule(source, {
        filename: entryPath,
        ext: path.extname(entryPath),
        cache: evalCache,
        async: true,
        forceTranspile: true,
      });
    } catch (e) {
      errors.push({ path: entryPath, error: `import failed: ${errorText(e)}` });
      continue;
    }
    const factory = resolveFactory(mod);
    if (!factory) {
      errors.push({ path: entryPath, error: "does not export a factory function (default export must be a function)" });
      continue;
    }
    // A factory that throws during activation fails alone: activation runs
    // before commit, so nothing from this extension is ever registered.
    const pendingHandlers: Array<{ event: ExtensionEventName; handler: ExtensionEventHandler }> = [];
    // Staged tool registrations (same atomicity as handlers): validated
    // eagerly so a bad shape fails activation loudly, committed only after
    // the factory succeeds, rolled back when a later commit step throws.
    type PendingTool = { def: ExtensionToolDefinition; committedUnregister: (() => void) | null };
    const pendingTools: PendingTool[] = [];
    // Staged tool overrides (ticket 06; same atomicity as tools): validated
    // eagerly so a bad shape or non-builtin name fails activation loudly,
    // committed only after the factory succeeds, rolled back when a later
    // commit step throws (alongside the tools committed earlier).
    type PendingOverride = { def: ExtensionToolOverrideDefinition; committedUnregister: (() => void) | null };
    const pendingOverrides: PendingOverride[] = [];
    // Staged prompt hints (ticket 06; same atomicity as interceptors):
    // validated eagerly, committed after the factory succeeds — hint
    // registration cannot fail, so a tool/override/command failure still
    // rolls back to zero without extra handling.
    type PendingHint = { hint: string; committedUnregister: (() => void) | null };
    const pendingHints: PendingHint[] = [];
    // Staged slash commands (same atomicity as tools): validated eagerly so
    // a bad shape or builtin collision fails activation loudly, committed
    // only after the factory succeeds, rolled back when a later commit step
    // throws (including the tools committed earlier in the same round).
    type PendingCommand = { def: ExtensionCommandDefinition; committedUnregister: (() => void) | null };
    const pendingCommands: PendingCommand[] = [];
    // Staged interceptors (same atomicity as handlers and tools): a factory
    // that throws during activation leaves no hook behind. Committed after
    // the tool round below — interceptor registration cannot fail, so a
    // tool-commit failure still rolls back to zero without extra handling.
    type PendingIntercept<H> = { handler: H; committedUnregister: (() => void) | null };
    const pendingBefore: Array<PendingIntercept<BeforeToolCallHandler>> = [];
    const pendingAfter: Array<PendingIntercept<AfterToolCallHandler>> = [];
    // Staged switch gate (same atomicity as interceptors): validated eagerly
    // so a non-function fails activation loudly, committed only after the
    // factory succeeds — a throwing factory leaves no veto behind.
    const pendingSwitch: Array<PendingIntercept<BeforeSwitchHandler>> = [];
    // Staged provider hooks (ticket 08; same atomicity as interceptors): a
    // factory that throws during activation leaves no provider hook behind.
    // Committed after the tool/command rounds below — hook registration
    // cannot fail, so a tool-commit failure still rolls back to zero.
    const pendingProviderContext: Array<PendingIntercept<ContextTransformHandler>> = [];
    const pendingProviderPre: Array<PendingIntercept<BeforeRequestHandler>> = [];
    const pendingProviderPost: Array<PendingIntercept<AfterResponseHandler>> = [];
    // Staged compaction hooks (ticket 09; same atomicity as provider hooks):
    // a factory that throws during activation leaves no compaction hook
    // behind. Committed with the rounds below — hook registration cannot
    // fail, so a tool/command failure still rolls back to zero.
    const pendingCompact: Array<PendingIntercept<BeforeCompactHandler>> = [];
    // Staged UI surface (ticket 10; same atomicity as hints): validated
    // eagerly so a bad shape fails activation loudly, committed only after
    // the factory succeeds — a throwing factory leaves zero UI residue.
    // (Boxed: the slot is assigned only inside unregister closures, and a
    // plain `let` would flow-narrow to its null initializer at commit.)
    const stagedStatusBox: { current: { text: string; committed: boolean } | null } = { current: null };
    type PendingWidget = { def: ValidatedWidgetDef; committed: boolean };
    const pendingWidgets: PendingWidget[] = [];
    const pendingNotices: string[] = [];
      const activationGeneration = generation;
    const activationApi: ExtensionAPI = {
      name,
      on: (event, handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": handler for "${event}" must be a function`);
        }
        pendingHandlers.push({ event, handler });
        return () => {
          const idx = pendingHandlers.findIndex((p) => p.event === event && p.handler === handler);
          if (idx >= 0) pendingHandlers.splice(idx, 1);
        };
      },
      registerTool: (def) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        // Eager shape check: a malformed definition fails this extension's
        // activation before anything is committed (cross-extension name
        // races still surface at commit below, failing alone there too).
        validateExtensionToolDef(def);
        if (pendingTools.some((p) => p.def.name === (def as { name?: unknown }).name)) {
          throw new Error(`extension "${name}": tool "${(def as { name?: unknown }).name}" is already registered`);
        }
        const entry: PendingTool = { def, committedUnregister: null };
        pendingTools.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingTools.indexOf(entry);
            if (idx >= 0) pendingTools.splice(idx, 1);
          }
        };
      },
      overrideTool: (def) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        // Eager shape + builtin checks: a malformed definition or a
        // non-builtin name fails this extension's activation before anything
        // is committed (cross-extension override races still surface at
        // commit below, failing alone there too).
        validateExtensionToolOverrideDef(def);
        if (!TOOL_DEFINITIONS.some((t) => t.function.name === (def as { name?: unknown }).name)) {
          throw new Error(`extension tool override "${(def as { name?: unknown }).name}" is not a builtin tool (only builtins can be overridden)`);
        }
        if (pendingOverrides.some((p) => p.def.name === (def as { name?: unknown }).name)) {
          throw new Error(`extension "${name}": tool override "${(def as { name?: unknown }).name}" is already registered`);
        }
        const entry: PendingOverride = { def, committedUnregister: null };
        pendingOverrides.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingOverrides.indexOf(entry);
            if (idx >= 0) pendingOverrides.splice(idx, 1);
          }
        };
      },
      addPromptHint: (hint) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        // Eager shape check: an empty/oversize hint fails this extension's
        // activation before anything is committed.
        validateExtensionPromptHint(hint);
        const entry: PendingHint = { hint, committedUnregister: null };
        pendingHints.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingHints.indexOf(entry);
            if (idx >= 0) pendingHints.splice(idx, 1);
          }
        };
      },
      registerCommand: (def) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        // Eager shape + builtin checks: a malformed or colliding definition
        // fails this extension's activation before anything is committed
        // (cross-extension name races still surface at commit below).
        validateExtensionCommandDef(def);
        assertCommandNameFree(def);
        if (pendingCommands.some((p) => p.def.name === def.name)) {
          throw new Error(`extension "${name}": command "/${def.name}" is already registered`);
        }
        const entry: PendingCommand = { def, committedUnregister: null };
        pendingCommands.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingCommands.indexOf(entry);
            if (idx >= 0) pendingCommands.splice(idx, 1);
          }
        };
      },
      onBeforeToolCall: (handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": before-tool-call handler must be a function`);
        }
        const entry: PendingIntercept<BeforeToolCallHandler> = { handler, committedUnregister: null };
        pendingBefore.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingBefore.indexOf(entry);
            if (idx >= 0) pendingBefore.splice(idx, 1);
          }
        };
      },
      onAfterToolCall: (handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": after-tool-call handler must be a function`);
        }
        const entry: PendingIntercept<AfterToolCallHandler> = { handler, committedUnregister: null };
        pendingAfter.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingAfter.indexOf(entry);
            if (idx >= 0) pendingAfter.splice(idx, 1);
          }
        };
      },
      onTransformContext: (handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": context-transform handler must be a function`);
        }
        const entry: PendingIntercept<ContextTransformHandler> = { handler, committedUnregister: null };
        pendingProviderContext.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingProviderContext.indexOf(entry);
            if (idx >= 0) pendingProviderContext.splice(idx, 1);
          }
        };
      },
      onBeforeRequest: (handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": before-request handler must be a function`);
        }
        const entry: PendingIntercept<BeforeRequestHandler> = { handler, committedUnregister: null };
        pendingProviderPre.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingProviderPre.indexOf(entry);
            if (idx >= 0) pendingProviderPre.splice(idx, 1);
          }
        };
      },
      onAfterResponse: (handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": after-response handler must be a function`);
        }
        const entry: PendingIntercept<AfterResponseHandler> = { handler, committedUnregister: null };
        pendingProviderPost.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingProviderPost.indexOf(entry);
            if (idx >= 0) pendingProviderPost.splice(idx, 1);
          }
        };
      },
      onBeforeCompact: (handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": before-compact handler must be a function`);
        }
        const entry: PendingIntercept<BeforeCompactHandler> = { handler, committedUnregister: null };
        pendingCompact.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingCompact.indexOf(entry);
            if (idx >= 0) pendingCompact.splice(idx, 1);
          }
        };
      },
      onBeforeSwitch: (handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": before-switch handler must be a function`);
        }
        const entry: PendingIntercept<BeforeSwitchHandler> = { handler, committedUnregister: null };
        pendingSwitch.push(entry);
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committedUnregister) {
            const undo = entry.committedUnregister;
            entry.committedUnregister = null;
            undo();
          } else {
            const idx = pendingSwitch.indexOf(entry);
            if (idx >= 0) pendingSwitch.splice(idx, 1);
          }
        };
      },
      getSessionState: () => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        return readExtensionState(sessionHome, currentSessionId, name);
      },
      setSessionState: (value) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        writeExtensionState(sessionHome, currentSessionId, name, value);
      },
      isProjectTrusted: () => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        return trusted;
      },
      setStatusSegment: (text) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        // Eager shape check + single-slot staging: a later set overwrites
        // the earlier (live-update upsert), a throw rolls back to null.
        const entry = { text: validateStatusSegment(name, text), committed: false };
        stagedStatusBox.current = entry;
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (entry.committed) {
            statusSegments.delete(name);
            emitUI();
          } else if (stagedStatusBox.current === entry) {
            stagedStatusBox.current = null;
          }
        };
      },
      setWidget: (def) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        // Eager shape + placement check: same-id sets upsert the pending
        // entry (live-update staging), a throw drops the whole list.
        const clean = validateWidgetDef(name, def);
        const key = widgetKey(name, clean.id);
        let entry = pendingWidgets.find((p) => widgetKey(name, p.def.id) === key);
        if (!entry) {
          entry = { def: clean, committed: false };
          pendingWidgets.push(entry);
        } else {
          entry.def = clean;
        }
        const staged: PendingWidget = entry;
        let alive = true;
        return () => {
          if (activationGeneration !== generation) {
            throw new Error(staleMessage ?? "extension context is stale after a session replacement");
          }
          if (!alive) return;
          alive = false;
          if (staged.committed) {
            widgets.delete(key);
            emitUI();
          } else {
            const idx = pendingWidgets.indexOf(staged);
            if (idx >= 0) pendingWidgets.splice(idx, 1);
          }
        };
      },
      notify: (message) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        // Eager shape check: staged with the other UI, committed only on
        // success — a throwing factory posts nothing.
        pendingNotices.push(validateNotifyMessage(name, message));
      },
      promptUser: () => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        // Activation runs before the host assigns the runtime, so no modal
        // could ever fulfill this — reject instead of hanging forever.
        return Promise.reject(
          new Error(`extension "${name}": dialogs cannot open during activation — prompt from a command or event handler instead (nothing was shown)`)
        );
      },
    };
    try {
      await factory(activationApi);
    } catch (e) {
      errors.push({ path: entryPath, error: `activation failed: ${errorText(e)}` });
      continue;
    }
    // Commit: activation succeeded, registrations go live atomically. A
    // duplicate/builtin-colliding tool name fails this extension alone:
    // tools committed earlier in this round roll back and handlers never
    // go live.
    const committedToolUndos: Array<() => void> = [];
    try {
      for (const t of pendingTools) {
        const undo = registerExtensionTool(t.def);
        t.committedUnregister = undo;
        committedToolUndos.push(undo);
      }
    } catch (e) {
      for (const undo of committedToolUndos) {
        try {
          undo();
        } catch {
          // rollback is best-effort; the error entry below carries the cause
        }
      }
      for (const t of pendingTools) t.committedUnregister = null;
      errors.push({ path: entryPath, error: `tool registration failed: ${errorText(e)}` });
      continue;
    }
    // Override commit (same atomic round): a duplicate override (a
    // cross-extension race — same-extension duplicates fail eagerly above)
    // fails this extension alone: overrides committed earlier in this round
    // roll back ALONGSIDE the tools above, and later rounds never go live.
    const committedOverrideUndos: Array<() => void> = [];
    try {
      for (const o of pendingOverrides) {
        const undo = registerExtensionToolOverride(o.def, name);
        o.committedUnregister = undo;
        committedOverrideUndos.push(undo);
      }
    } catch (e) {
      for (const undo of [...committedOverrideUndos, ...committedToolUndos]) {
        try {
          undo();
        } catch {
          // rollback is best-effort; the error entry below carries the cause
        }
      }
      for (const t of pendingTools) t.committedUnregister = null;
      for (const o of pendingOverrides) o.committedUnregister = null;
      errors.push({ path: entryPath, error: `tool override registration failed: ${errorText(e)}` });
      continue;
    }
    // Command commit (same atomic round): a duplicate/colliding name fails
    // this extension alone — commands committed earlier in this round roll
    // back ALONGSIDE the tools and overrides above, and handlers/interceptors
    // never go live, so a failed activation always leaves zero registrations
    // behind.
    const committedCommandUndos: Array<() => void> = [];
    try {
      for (const c of pendingCommands) {
        const undo = registerCommandInStore(c.def, name);
        c.committedUnregister = undo;
        committedCommandUndos.push(undo);
      }
    } catch (e) {
      for (const undo of [...committedCommandUndos, ...committedOverrideUndos, ...committedToolUndos]) {
        try {
          undo();
        } catch {
          // rollback is best-effort; the error entry below carries the cause
        }
      }
      for (const t of pendingTools) t.committedUnregister = null;
      for (const o of pendingOverrides) o.committedUnregister = null;
      for (const c of pendingCommands) c.committedUnregister = null;
      errors.push({ path: entryPath, error: `command registration failed: ${errorText(e)}` });
      continue;
    }
    // Hint commit (same atomic round): validated eagerly, cannot fail — a
    // tool/override/command failure above skips this entirely via continue,
    // so a failed activation never leaves a hint behind either.
    for (const h of pendingHints) {
      h.committedUnregister = registerExtensionPromptHint(h.hint, name);
    }
    // UI-surface commit (same atomic round): validated eagerly, cannot
    // fail — a tool/override/command failure above skips this entirely via
    // continue, so a failed activation never leaves a segment, widget, or
    // notice behind either.
    const stagedStatus = stagedStatusBox.current;
    if (stagedStatus) {
      stagedStatus.committed = true;
      statusSegments.set(name, stagedStatus.text);
    }
    for (const w of pendingWidgets) {
      w.committed = true;
      widgets.set(widgetKey(name, w.def.id), { owner: name, ...w.def });
    }
    for (const message of pendingNotices) {
      notifications.push({ owner: name, message });
      if (notifications.length > EXT_NOTICE_CAP) {
        notifications.splice(0, notifications.length - EXT_NOTICE_CAP);
      }
    }
    if (stagedStatus || pendingWidgets.length > 0 || pendingNotices.length > 0) emitUI();
    for (const e of pendingBefore) {
      e.committedUnregister = registerBeforeToolCall(e.handler, name);
    }
    for (const e of pendingAfter) {
      e.committedUnregister = registerAfterToolCall(e.handler, name);
    }
    // Provider-hook commit (same atomic round): runtime-global like the
    // interceptors above, cannot fail — a tool/command failure skips this
    // entirely via continue, so a failed activation never leaves a provider
    // hook behind either.
    for (const e of pendingProviderContext) {
      e.committedUnregister = registerContextTransform(e.handler, name);
    }
    for (const e of pendingProviderPre) {
      e.committedUnregister = registerBeforeRequest(e.handler, name);
    }
    for (const e of pendingProviderPost) {
      e.committedUnregister = registerAfterResponse(e.handler, name);
    }
    // Compaction-hook commit (same atomic round): runtime-global like the
    // provider hooks above, cannot fail — a tool/command failure skips this
    // entirely via continue, so a failed activation never leaves a
    // compaction hook behind either.
    for (const e of pendingCompact) {
      e.committedUnregister = registerBeforeCompact(e.handler, name);
    }
    // Switch-gate commit (same atomic round): runtime-local, cannot fail —
    // a tool/command failure above skips this entirely via continue, so a
    // failed activation never leaves a veto behind either.
    for (const e of pendingSwitch) {
      e.committedUnregister = addBeforeSwitchHandler(entryPath, e.handler);
    }
    // Reload support: the full round above succeeded (any failure took a
    // continue above after rolling back its own rounds), so every
    // committed registration is now owned by the runtime — collect the
    // unregister closures for unload(). Nothing collected here is ever
    // double-released.
    for (const staged of [
      ...pendingTools,
      ...pendingOverrides,
      ...pendingCommands,
      ...pendingHints,
      ...pendingBefore,
      ...pendingAfter,
      ...pendingProviderContext,
      ...pendingProviderPre,
      ...pendingProviderPost,
      ...pendingCompact,
      ...pendingSwitch,
    ]) {
      if (staged.committedUnregister) committedUndos.push(staged.committedUnregister);
    }
    for (const p of pendingHandlers) {
      let list = handlers.get(p.event);
      if (!list) {
        list = [];
        handlers.set(p.event, list);
      }
      list.push({ extensionPath: entryPath, handler: p.handler });
    }
    loaded.push({ path: entryPath, name });
  }
  return runtime;
}
