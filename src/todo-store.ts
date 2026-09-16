// Single todo store (todo-refactor 01): the ONLY owner of session
// checklist state, executors, pure CRUD, and persistence helpers.
// `src/tools/todo.ts` and `src/todos.ts` are re-export shims over this
// module (expand step — old import paths keep working untouched).
//
// Moved verbatim from those two modules; only relative import paths
// changed. Behavior, messages, and invariants are byte-identical.
import { err, invalidCall } from "./tools/shared.js";
import { getActiveSessionId, getSession, updateSession } from "./sessions.js";
import {
  TODO_ECHO_CAP,
  TODO_PRIORITIES,
  TODO_STATUSES,
  todoRecordDetail,
  validateTodoRecord,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "./todo-shared.js";

// ---- Session checklist state (Claude-Code TodoWrite / opencode todowrite parity) ----

export type { TodoItem, TodoPriority, TodoStatus };
export type TodowriteArgs = { todos: TodoItem[] };

export { TODO_PRIORITIES, TODO_STATUSES };
export { validateTodoRecord } from "./todo-shared.js";

// Per-session isolation (fix 1): one list per session id. The active key
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

// Cached snapshot (fix 3): many callers read the same turn's list
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
// Also clears the durable metadata for the active session so a
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

// Capped rendering for large lists (fix 2 + 10, token/TUI churn).
// Single-item delta uses renderTodoDelta, full echoes are truncated after
// TODO_ECHO_CAP rows so transcript, TUI and compact tail share the same cap.
function renderTodosCapped(items: TodoItem[], cap = TODO_ECHO_CAP): string {
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
// Runtime invariants (fix 8 — parallel in_progress is now allowed):
// - multiple `in_progress` items are allowed — parallel work no longer
//   requires completing/pausing the current item first;
// - a completed item keeps its status across rewrites: only an explicit
//   todo_update status patch reopens one (silent un-completion via a full
//   rewrite is refused with a pointer to todo_update).
// An empty array clears; all-completed clears.
export async function todowriteTool(args: TodowriteArgs): Promise<string> {
  try {
    const list = (args as { todos?: unknown })?.todos;
    if (!Array.isArray(list)) return err("todos must be an array");
    // Single validator: shape checks live in `todo-shared.ts`
    // so the store and its shims share the same vocabulary
    // and rules. No second copy of the field checks here.
    const next: TodoItem[] = [];
    for (let i = 0; i < list.length; i++) {
      const clean = validateTodoRecord(list[i]);
      if (!clean) {
        // Field-level guidance from the single shared source
        // (todo-shared.todoRecordDetail) — same invalidCall framing.
        return invalidCall(todoRecordDetail(list[i], i) ?? `todo item ${i} is invalid`);
      }
      next.push(clean);
    }
    // Parallel in_progress is allowed (fix 8): the old single-active
    // invariant is removed so a todowrite can set multiple tasks to
    // `in_progress` for parallel workflows. No validation here.
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
    // Cap the echo for large lists (fix 2, token/TUI churn). todowrite
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
      // Parallel in_progress is allowed (fix 8): no single-active guard
      // here. Reopening a completed item via todo_update remains the
      // explicit reset the todowrite guard points to, so it stays allowed.
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
    // Apply patch to active session's list with version bump.
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
    // Single-item delta echo (fix 2, not full list) to cut tokens/TUI churn.
    // The TUI live block shows the full capped list; the transcript keeps the
    // delta so history stays faithful without duplicating the whole checklist
    // on every check-off. Full list remains available via todo_get.
    return `${renderTodoDelta(rawIndex, next, after.length)}`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ---- Pure CRUD (moved verbatim from src/todos.ts) ----

// Namespace inside Session.metadata. Never read or write metadata.filediffs.
export const TODOS_METADATA_KEY = "todos";

// Persisted shape: the live item verbatim (content, status, and the optional
// priority/activeForm), always concrete after serialize.
export type PersistedTodo = {
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
  activeForm?: string;
};

function cleanTodoList(list: TodoItem[]): TodoItem[] {
  return list.map((t) => ({ ...t }));
}

function checkedIndex(length: number, index: number, verb: string): number {
  if (
    typeof index !== "number" ||
    !Number.isFinite(index) ||
    Math.floor(index) !== index
  ) {
    throw new Error(`${verb}: index must be an integer (got ${String(index)})`);
  }
  if (index < 1 || index > length) {
    throw new Error(
      `${verb}: index ${index} out of range (list has ${length} item(s))`
    );
  }
  return index - 1;
}

// Append one item (1-based position = end). Throws Error on a malformed item.
export function createTodo(list: TodoItem[], item: unknown): TodoItem[] {
  const clean = validateTodoRecord(item);
  if (!clean) {
    throw new Error(
      `createTodo: item must be {content: non-empty string, status: "pending" | "in_progress" | "completed", priority?: "high" | "medium" | "low", activeForm?: string}`
    );
  }
  return [...cleanTodoList(list), clean];
}

export type TodoPatch = {
  content?: unknown;
  status?: unknown;
  priority?: unknown;
  activeForm?: unknown;
};

// Patch ONE item by 1-based index (status transitions flow through here —
// completeTodo below is the named common case). Unknown patch keys are
// ignored; an empty patch is a no-op copy. Throws Error on a bad index or
// an invalid patched value.
export function updateTodo(
  list: TodoItem[],
  index: number,
  patch: TodoPatch
): TodoItem[] {
  const at = checkedIndex(list.length, index, "updateTodo");
  const p: Record<string, unknown> = isRecord(patch) ? { ...patch } : {};
  const next: TodoItem = { ...(list[at] as TodoItem) };
  if (p["status"] !== undefined) {
    const status = p["status"];
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed"
    ) {
      throw new Error(
        `updateTodo: status must be one of "pending", "in_progress", "completed" (got ${JSON.stringify(status) ?? String(status)})`
      );
    }
    next.status = status;
  }
  if (p["content"] !== undefined) {
    if (typeof p["content"] !== "string" || p["content"].length === 0) {
      throw new Error(`updateTodo: content must be a non-empty string`);
    }
    next.content = p["content"];
  }
  if (p["priority"] !== undefined) {
    const priority = p["priority"];
    if (priority !== "high" && priority !== "medium" && priority !== "low") {
      throw new Error(
        `updateTodo: priority must be one of "high", "medium", "low" (got ${JSON.stringify(priority) ?? String(priority)})`
      );
    }
    next.priority = priority;
  }
  if (p["activeForm"] !== undefined) {
    if (typeof p["activeForm"] !== "string") {
      throw new Error(`updateTodo: activeForm must be a string`);
    }
    if (p["activeForm"].length > 0) {
      next.activeForm = p["activeForm"];
    } else {
      delete next.activeForm;
    }
  }
  const out = cleanTodoList(list);
  out[at] = next;
  return out;
}

// Mark one item completed by 1-based index. Throws Error on a bad index.
export function completeTodo(list: TodoItem[], index: number): TodoItem[] {
  return updateTodo(list, index, { status: "completed" });
}

// Move the item at 1-based `from` to 1-based `to` (order = array order).
// Throws Error on a bad index.
export function reorderTodo(
  list: TodoItem[],
  from: number,
  to: number
): TodoItem[] {
  const fromAt = checkedIndex(list.length, from, "reorderTodo");
  const toAt = checkedIndex(list.length, to, "reorderTodo");
  if (fromAt === toAt) return cleanTodoList(list);
  const out = cleanTodoList(list);
  const [moved] = out.splice(fromAt, 1);
  out.splice(toAt, 0, moved as TodoItem);
  return out;
}

// Serialize the live list for a session save: a deep copy (the save must
// never alias live state). Total: never throws; unserializable input reads
// as an empty list.
export function serializeTodosForPersist(list: unknown): PersistedTodo[] {
  try {
    if (!Array.isArray(list)) return [];
    const out: PersistedTodo[] = [];
    for (const item of list) {
      const clean = validateTodoRecord(item);
      if (!clean) return [];
      const persisted: PersistedTodo = {
        content: clean.content,
        status: clean.status,
      };
      if (clean.priority !== undefined) persisted.priority = clean.priority;
      if (clean.activeForm !== undefined) persisted.activeForm = clean.activeForm;
      out.push(persisted);
    }
    return out;
  } catch {
    return [];
  }
}

// Restore a saved list: valid items come back verbatim (states intact, order
// intact); a missing key, a non-array, or ANY malformed item degrades to an
// empty list — never a throw, never a partial list (a half-restored plan is
// worse than a visibly empty one). Old records without the todos key land
// here safely.
export function restoreTodosFromPersist(value: unknown): TodoItem[] {
  try {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) return [];
    const out: TodoItem[] = [];
    for (const item of value) {
      const clean = validateTodoRecord(item);
      if (!clean) return [];
      out.push(clean);
    }
    return out;
  } catch {
    return [];
  }
}

// Read the checklist out of a session record's metadata (the switch-restore
// path): absent or corrupt reads as []. Never throws.
export function readSessionTodos(metadata: unknown): TodoItem[] {
  try {
    if (!isRecord(metadata)) return [];
    return restoreTodosFromPersist(metadata[TODOS_METADATA_KEY]);
  } catch {
    return [];
  }
}

// Stamp the checklist into a metadata object for an updateSession patch (the
// per-turn persist path): every other key (extension state, filediffs, …)
// passes through untouched — only metadata.todos is set. Never throws.
export function withSessionTodos(
  metadata: unknown,
  list: unknown
): Record<string, unknown> {
  try {
    const base: Record<string, unknown> = isRecord(metadata)
      ? { ...metadata }
      : {};
    base[TODOS_METADATA_KEY] = serializeTodosForPersist(list);
    return base;
  } catch {
    return { [TODOS_METADATA_KEY]: [] as PersistedTodo[] };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
