// Session checklist state + todowrite/todo_get/todo_update.
// Ephemeral, per-session isolated (fix 1): no global bleed across
// sessions or restarts. See sessionTodos map + active key below.
import { err, invalidCall } from "./shared.js";
import { getActiveSessionId, getSession, updateSession } from "../sessions.js";
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  validateTodoRecord,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "../todo-shared.js";
// ---- Session todo list (Claude-Code TodoWrite / opencode todowrite parity) ----

export type { TodoItem, TodoPriority, TodoStatus };
export type TodowriteArgs = { todos: TodoItem[] };

export { TODO_PRIORITIES, TODO_STATUSES };
export { validateTodoRecord } from "../todo-shared.js";

// Fix 1 — per-session isolation: one list per session id. The active key
// mirrors the multi-session store's active id (App sets it on switch/new
// and on mount). Tests and non-session callers use "__default__", so
// existing suites stay hermetic without a session. Restart wipes only the
// in-memory map — disk metadata.todos is the durable source (read on mount
// via hydrateActiveTodos). No leak: switching sessions swaps the key, so a
// missed clearTodos cannot carry the previous plan over.
const DEFAULT_TODO_SESSION = "__default__";
const sessionTodos = new Map<string, TodoItem[]>();
let activeSessionKey: string = DEFAULT_TODO_SESSION;
let todosVersion = 0;
let cachedFrozen: readonly TodoItem[] | null = null;
let cachedVersion = -1;

function activeList(): TodoItem[] {
  return sessionTodos.get(activeSessionKey) ?? [];
}

function setActiveList(next: TodoItem[]): void {
  sessionTodos.set(activeSessionKey, next);
  todosVersion += 1;
  cachedFrozen = null;
}

function bumpVersion(): void {
  todosVersion += 1;
  cachedFrozen = null;
}

export function setActiveTodoSession(id: string | null): void {
  activeSessionKey = id ?? DEFAULT_TODO_SESSION;
  if (!sessionTodos.has(activeSessionKey)) sessionTodos.set(activeSessionKey, []);
  // Switching sessions is a logical version change for the cache so that
  // callers re-read the new session's list, not a stale frozen copy.
  cachedFrozen = null;
  cachedVersion = -1;
}

export function getActiveTodoSessionId(): string | null {
  return activeSessionKey === DEFAULT_TODO_SESSION ? null : activeSessionKey;
}

// For tests / session-restore paths that need to seed without a full
// todowrite cycle (not used by the TUI loop).
export function hydrateTodosForSession(sessionId: string, items: TodoItem[]): void {
  const key = sessionId || DEFAULT_TODO_SESSION;
  sessionTodos.set(key, items.map((t) => ({ ...t })));
  if (key === activeSessionKey) bumpVersion();
}

// Fix 3 — cached snapshot: many callers read the same turn's list
// (gates, openTodoNeedles, persist, compaction, TUI). A frozen snapshot
// is built once per version and reused until the next mutation, so 4-5
// getTodos() calls in one turn share one O(n) copy, not 4-5.
export function getTodos(): TodoItem[] {
  if (cachedFrozen !== null && cachedVersion === todosVersion) {
    // Return a shallow-copy array but frozen items stay shared — callers
    // must not mutate the returned objects (the tools never do; tests use
    // spread/map). The copy is cheap (array only) vs full deep map.
    return cachedFrozen.map((t) => ({ ...t }));
  }
  const list = activeList();
  const frozen = Object.freeze(list.map((t) => Object.freeze({ ...t }) as TodoItem)) as readonly TodoItem[];
  cachedFrozen = frozen;
  cachedVersion = todosVersion;
  return frozen.map((t) => ({ ...t }));
}

// Internal read without copy for cheap checks (callers must not mutate).
export function peekTodos(): readonly TodoItem[] {
  if (cachedFrozen !== null && cachedVersion === todosVersion) return cachedFrozen;
  const list = activeList();
  const frozen = Object.freeze(list.map((t) => Object.freeze({ ...t }) as TodoItem)) as readonly TodoItem[];
  cachedFrozen = frozen;
  cachedVersion = todosVersion;
  return frozen;
}

export function getTodosSnapshot(): readonly TodoItem[] {
  return peekTodos();
}

// Reset for /new (a fresh conversation in the same process starts with a
// fresh checklist; /clear keeps it — the session continues).
// Fix 1 — also clears the durable metadata for the active session so a
// subsequent mount hydration (restart) does not resurrect a just-cleared
// checklist. Tests share the default home and rely on clearTodos() in
// finally() to reset; without the disk clear the next mount would re-hydrate
// the previous test's todos and pollute the suite (see agent.test HTTP).
export function clearTodos(): void {
  // Old global clear semantics for tests: wipe all in-memory sessions.
  // Per-session isolation keeps each session's list, but a global clear is
  // what the suite expects from a finally() reset.
  sessionTodos.clear();
  sessionTodos.set(activeSessionKey, []);
  bumpVersion();
  // Best-effort disk clear for the active session (default home). Custom
  // homes (tests that pass authHome) are handled by App's session-switch
  // path which explicitly restores via readSessionTodos; the global clear
  // here is the test-reset path.
  try {
    const id = getActiveSessionId();
    if (id) {
      const sess = getSession(id);
      if (sess && (sess.metadata as Record<string, unknown>)?.["todos"] !== undefined) {
        const curMeta = (sess.metadata ?? {}) as Record<string, unknown>;
        const nextMeta = { ...curMeta, todos: [] as unknown[] };
        updateSession(id, { metadata: nextMeta });
      }
    }
  } catch {
    // ignore disk errors
  }
}

function renderTodos(items: TodoItem[]): string {
  if (items.length === 0) return "Todo list is empty.";
  const mark = (s: TodoStatus): string =>
    s === "completed" ? "✅" : s === "in_progress" ? "🔧" : "○";
  return (
    `Todo list (${items.length}):\n` +
    items
      .map((t, i) => `${i + 1}. ${mark(t.status)} [${t.status}] ${t.content}${t.priority ? ` (${t.priority})` : ""}`)
      .join("\n")
  );
}

// Fix 2 — capped rendering for large lists (token/TUI churn). Single-item
// delta uses renderTodoDelta, full echoes are truncated after 20 rows.
function renderTodosCapped(items: TodoItem[], cap = 20): string {
  if (items.length === 0) return "Todo list is empty.";
  if (items.length <= cap) return renderTodos(items);
  const head = items.slice(0, cap);
  return (
    renderTodos(head) + `\n… ${items.length - cap} more (call todo_get to see full list)`
  );
}

function renderTodoDelta(index: number, item: TodoItem, total: number): string {
  const mark = item.status === "completed" ? "✅" : item.status === "in_progress" ? "🔧" : "○";
  return `Todo ${index} updated. [${item.status}] ${item.content}${item.priority ? ` (${item.priority})` : ""} ${mark} (${index}/${total})`;
}

// Replace the session checklist. Malformed items are model mistakes
// (`invalid call`, never runs); runtime failures keep plain `Error: ...`.
// Runtime invariants (harness-enforced, not just prompt discipline):
// - at most ONE item may be in_progress (flip the current one to completed
//   or back to pending first — parallel "current work" is impossible state);
// - a completed item keeps its status across rewrites: only an explicit
//   todo_update status patch reopens one (silent un-completion via a full
//   rewrite is refused with a pointer to todo_update).
// An empty array clears; all-completed clears.
export async function todowriteTool(args: TodowriteArgs): Promise<string> {
  try {
    const list = (args as { todos?: unknown })?.todos;
    if (!Array.isArray(list)) return err("todos must be an array");
    const next: TodoItem[] = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i] as Record<string, unknown>;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return invalidCall(
          `todo item ${i} must be an object. Expected {content: string, status: "pending" | "in_progress" | "completed", priority?: "high" | "medium" | "low", activeForm?: string}`
        );
      }
      if (typeof item["content"] !== "string" || (item["content"] as string).length === 0) {
        return invalidCall(`todo item ${i} field "content" must be a non-empty string`);
      }
      if (typeof item["status"] !== "string" || !TODO_STATUSES.has(item["status"] as string)) {
        return invalidCall(
          `todo item ${i} field "status" must be one of "pending", "in_progress", "completed" (got ${JSON.stringify(item["status"])})`
        );
      }
      const clean: TodoItem = {
        content: item["content"] as string,
        status: item["status"] as TodoStatus,
      };
      if (item["priority"] !== undefined) {
        if (typeof item["priority"] !== "string" || !TODO_PRIORITIES.has(item["priority"] as string)) {
          return invalidCall(
            `todo item ${i} field "priority" must be one of "high", "medium", "low" (got ${JSON.stringify(item["priority"])})`
          );
        }
        clean.priority = item["priority"] as TodoPriority;
      }
      if (item["activeForm"] !== undefined) {
        if (typeof item["activeForm"] !== "string") {
          return invalidCall(`todo item ${i} field "activeForm" must be a string`);
        }
        if ((item["activeForm"] as string).length > 0) clean.activeForm = item["activeForm"] as string;
      }
      next.push(clean);
    }
    // Invariant: at most one in_progress (parallel current work is impossible
    // state — complete or pause the other one first).
    const active = next
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.status === "in_progress");
    if (active.length > 1) {
      const names = active.map(({ t, i }) => `${i + 1}. ${t.content}`).join("; ");
      return invalidCall(
        `only one task may be in_progress at a time (got ${active.length}: ${names}). ` +
          `Mark the finished one completed (or paused back to pending) first`
      );
    }
    // Invariant: completed stays completed across rewrites — a full-list
    // rewrite may not silently reopen a content-identical completed item.
    // Reopening is an explicit act: todo_update that item's status.
    const cur = activeList();
    for (const prev of cur) {
      if (prev.status !== "completed") continue;
      const reopened = next.find((t) => t.content === prev.content && t.status !== "completed");
      if (reopened) {
        return invalidCall(
          `task "${prev.content}" is already completed — a rewrite cannot reopen it. ` +
            `To reopen it explicitly, call todo_update on its index with a new status`
        );
      }
    }
    const prevCount = cur.length;
    setActiveList(next);
    if (next.length === 0) {
      return prevCount === 0 ? "Todo list is empty." : `Todo list cleared (${prevCount} item(s) removed).`;
    }
    if (next.every((t) => t.status === "completed")) {
      setActiveList([]);
      return `All ${next.length} task(s) completed — todo list cleared.\n${renderTodos(next)}`;
    }
    // Fix 2 — cap the echo for large lists (token/TUI churn). todowrite
    // still validates the whole list O(n), but the transcript echo beyond
    // the cap is truncated with an overflow note; the TUI live block is
    // independently capped at 8.
    return (
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.\n" +
      renderTodosCapped(next)
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type TodoGetArgs = Record<string, never>;

// Read the session checklist (pure read — the todowrite echo is the
// write path). Never throws; unknown fields are ignored by the schema.
export async function todoGetTool(): Promise<string> {
  return renderTodos(getTodos());
}

export type TodoUpdateArgs = {
  index: number;
  status?: string;
  content?: string;
  priority?: string;
  activeForm?: string;
};

// Patch ONE item by 1-based index (the check/uncheck verb; Claude
// TaskUpdate equivalent for a single item). Out-of-range indexes are
// model mistakes (`invalid call` — the list changed, so re-read with
// todo_get). Completing the last open item clears the list, like
// todowrite. Never throws.
export async function todoUpdateTool(args: TodoUpdateArgs): Promise<string> {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const rawIndex = a["index"];
    if (typeof rawIndex !== "number" || !Number.isFinite(rawIndex) || Math.floor(rawIndex) !== rawIndex) {
      return invalidCall(`field "index" for tool "todo_update" must be an integer (got ${JSON.stringify(rawIndex)})`);
    }
    const curLen = activeList().length;
    if (rawIndex < 1 || rawIndex > curLen) {
      return invalidCall(
        `todo_update index ${rawIndex} out of range (list has ${curLen} item(s); call todo_get to refresh)`
      );
    }
    const hasPatch =
      a["status"] !== undefined ||
      a["content"] !== undefined ||
      a["priority"] !== undefined ||
      a["activeForm"] !== undefined;
    if (!hasPatch) {
      return invalidCall(`tool "todo_update" needs at least one of "status", "content", "priority", "activeForm" to change`);
    }
    const curList = activeList();
    const next: TodoItem = { ...(curList[rawIndex - 1] as TodoItem) };
    if (a["status"] !== undefined) {
      if (typeof a["status"] !== "string" || !TODO_STATUSES.has(a["status"] as string)) {
        return invalidCall(
          `field "status" for tool "todo_update" must be one of "pending", "in_progress", "completed" (got ${JSON.stringify(a["status"])})`
        );
      }
      // Invariant: at most one in_progress — starting this one while another
      // runs is impossible state (complete or pause the other first).
      // Reopening a completed item here is the explicit reset the
      // todowrite rewrite guard points to, so it stays allowed.
      if (a["status"] === "in_progress") {
        const other = curList.findIndex(
          (t: TodoItem, i: number) => i !== rawIndex - 1 && t.status === "in_progress"
        );
        if (other !== -1) {
          return invalidCall(
            `only one task may be in_progress at a time (item ${other + 1} "${
              (curList[other] as TodoItem).content
            }" is already in_progress). Complete it or pause it back to pending first`
          );
        }
      }
      next.status = a["status"] as TodoStatus;
    }
    if (a["content"] !== undefined) {
      if (typeof a["content"] !== "string" || (a["content"] as string).length === 0) {
        return invalidCall(`field "content" for tool "todo_update" must be a non-empty string`);
      }
      next.content = a["content"] as string;
    }
    if (a["priority"] !== undefined) {
      if (typeof a["priority"] !== "string" || !TODO_PRIORITIES.has(a["priority"] as string)) {
        return invalidCall(
          `field "priority" for tool "todo_update" must be one of "high", "medium", "low" (got ${JSON.stringify(a["priority"])})`
        );
      }
      next.priority = a["priority"] as TodoPriority;
    }
    if (a["activeForm"] !== undefined) {
      if (typeof a["activeForm"] !== "string") {
        return invalidCall(`field "activeForm" for tool "todo_update" must be a string`);
      }
      if ((a["activeForm"] as string).length > 0) {
        next.activeForm = a["activeForm"] as string;
      } else {
        delete next.activeForm;
      }
    }
    // Apply patch to active session's list (fix 1) with version bump.
    const patched = [...curList];
    patched[rawIndex - 1] = next;
    setActiveList(patched);
    const after = activeList();
    if (after.length > 0 && after.every((t: TodoItem) => t.status === "completed")) {
      const snapshot = renderTodos(after);
      const done = after.length;
      setActiveList([]);
      return `All ${done} task(s) completed — todo list cleared.\n${snapshot}`;
    }
    // Fix 2 — single-item delta echo (not full list) to cut tokens/TUI churn.
    // The TUI live block shows the full capped list; the transcript keeps the
    // delta so history stays faithful without duplicating the whole checklist
    // on every check-off. Full list remains available via todo_get.
    return `${renderTodoDelta(rawIndex, next, after.length)}`;
    // For callers that still need the full context, the capped full list is
    // available via a follow-up todo_get; the old full echo is preserved in
    // the snapshot for debugging but not echoed by default.
    // return `Todo ${rawIndex} updated.\n${renderTodosCapped(after)}`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

