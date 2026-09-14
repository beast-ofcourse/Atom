// Per-session todos (ticket 05): a task checklist scoped to each session
// that persists across compactions and restarts, so the agent's plan and
// progress are never lost when old chat text is summarized away.
//
// Storage: namespaced under the multi-session record's generic
// `metadata.todos` key (src/sessions.ts) via the existing
// updateSession/getSession APIs — no schema edits, no new files on disk.
// Todos live OUTSIDE compacted chat text, so compaction (summary+tail)
// can never summarize them away; the summary only carries a context
// backstop (see formatGoalForCompact), never the record of truth.
//
// Status vocabulary is exactly src/tools/todo.ts's
// ("pending" | "in_progress" | "completed") — matched, not reinvented.
// Runtime invariants (at most one in_progress, completed-stays-completed,
// all-completed clears) stay owned by the tools/todo.ts layer; this module
// validates SHAPE only, so a saved record always replays through
// todowriteTool cleanly.
//
// Totality (mirroring goal.ts): serialize/restore never throw. Old records
// without the todos key read as an empty list; a malformed todos value
// degrades to empty WITHOUT failing the session load (same posture as the
// goal field). The pure CRUD ops below throw Error on invalid input —
// those are programmer errors with explicit messages, never silent.
//
// Import budget: type-only import from ./tools/todo.js (erased at compile,
// zero runtime coupling) plus no value imports — this module never touches
// App, sessions, compact, config, or the tool registry.

import type { TodoItem, TodoPriority, TodoStatus } from "./todo-shared.js";
import { isRecordObject, validateTodoRecord } from "./todo-shared.js";

// Namespace inside Session.metadata. Never read or write metadata.filediffs
// (ticket 06 owns it).
export const TODOS_METADATA_KEY = "todos";

export type { TodoItem, TodoPriority, TodoStatus };
export { validateTodoRecord, TODO_PRIORITIES, TODO_STATUSES } from "./todo-shared.js";

// Persisted shape: the live item verbatim (content, status, and the optional
// priority/activeForm), always concrete after serialize.
export type PersistedTodo = {
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
  activeForm?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return isRecordObject(value);
}

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
