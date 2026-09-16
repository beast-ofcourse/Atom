// Single source for todo vocabulary + shape validation (fix 12).
// `src/tools/todo.ts` and `src/todos.ts` both import from here so one
// change never rots the other. Value import is safe (no cycles) — the
// type-only `TodoItem` lives here too, re-exported by both modules for
// backwards compat (existing tools/todo and todos import sites keep
// working unchanged).

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";
export type TodoItem = {
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
  activeForm?: string;
};

export const TODO_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
]);
export const TODO_PRIORITIES: ReadonlySet<string> = new Set([
  "high",
  "medium",
  "low",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTodoStatus(v: unknown): v is TodoStatus {
  return typeof v === "string" && TODO_STATUSES.has(v);
}

export function isTodoPriority(v: unknown): v is TodoPriority {
  return typeof v === "string" && TODO_PRIORITIES.has(v);
}

// Shared shape validator (fix 12): non-empty content, known status,
// known priority when present, string activeForm when present.
// Unknown extra keys are ignored. Returns a clean deep copy, or null.
export function validateTodoRecord(value: unknown): TodoItem | null {
  try {
    if (!isRecord(value)) return null;
    if (
      typeof value["content"] !== "string" ||
      (value["content"] as string).length === 0
    )
      return null;
    const status = value["status"];
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed"
    )
      return null;
    const clean: TodoItem = {
      content: value["content"] as string,
      status: status as TodoStatus,
    };
    if (value["priority"] !== undefined) {
      const p = value["priority"];
      if (p !== "high" && p !== "medium" && p !== "low") return null;
      clean.priority = p as TodoPriority;
    }
    if (value["activeForm"] !== undefined) {
      if (typeof value["activeForm"] !== "string") return null;
      if ((value["activeForm"] as string).length > 0)
        clean.activeForm = value["activeForm"] as string;
    }
    return clean;
  } catch {
    return null;
  }
}

export function isRecordObject(v: unknown): v is Record<string, unknown> {
  return isRecord(v);
}

// Fix 10 — single display caps so TUI, transcript echo, disk and
// compaction tail never drift. All are derived from the live Map
// (`peekTodos`/`getTodos` in `src/tools/todo.ts`); disk via
// `withSessionTodos` and compaction via `formatGoalForCompact` read that
// same Map, and the transcript echo is log-only (delta, not a second
// source). Caps are shared so the visible list and the model tail agree.
export const TODO_TUI_MAX_VISIBLE = 8;
export const TODO_TUI_OVERFLOW_THRESHOLD = 12;
export const TODO_COMPACT_MAX = 10;
export const TODO_COMPACT_CHARS = 120;
export const TODO_ECHO_CAP = 20;

// Field-level detail for a rejected todowrite item (todo-refactor 02):
// the single source for the harness guidance the store returns via
// invalidCall. Messages are byte-identical to the former inline branch.
// Returns null when the record is valid.
export function todoRecordDetail(value: unknown, index: number): string | null {
  if (validateTodoRecord(value) !== null) return null;
  const expected = `{content: string, status: "pending" | "in_progress" | "completed", priority?: "high" | "medium" | "low", activeForm?: string}`;
  const raw = value as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `todo item ${index} must be an object. Expected ${expected}`;
  }
  if (
    typeof raw["content"] !== "string" ||
    (raw["content"] as string).length === 0
  ) {
    return `todo item ${index} field "content" must be a non-empty string`;
  }
  if (
    typeof raw["status"] !== "string" ||
    !TODO_STATUSES.has(raw["status"] as string)
  ) {
    return (
      `todo item ${index} field "status" must be one of "pending", "in_progress", "completed" ` +
      `(got ${JSON.stringify(raw["status"])})`
    );
  }
  if (
    raw["priority"] !== undefined &&
    !TODO_PRIORITIES.has(raw["priority"] as string)
  ) {
    return (
      `todo item ${index} field "priority" must be one of "high", "medium", "low" ` +
      `(got ${JSON.stringify(raw["priority"])})`
    );
  }
  if (
    raw["activeForm"] !== undefined &&
    typeof raw["activeForm"] !== "string"
  ) {
    return `todo item ${index} field "activeForm" must be a string`;
  }
  return `todo item ${index} is invalid: ${JSON.stringify(raw)}`;
}

// One-line activity label for a todo tool call (todo-refactor 02): the
// single source for the TUI `⚙` line. The registry and the web mirror
// share this shape — the web mirror keeps a local copy (it ships as
// static browser JS with no access to this module) and must stay in sync.
export function describeTodoCall(
  name: string,
  args: Record<string, unknown>,
): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === "todowrite") {
    const items = Array.isArray(a["todos"])
      ? (a["todos"] as unknown[]).length
      : 0;
    return `⚙ todowrite ${items} task(s)`.trim();
  }
  if (name === "todo_get") return "⚙ todo_get";
  if (name === "todo_update") {
    const idx = typeof a["index"] === "number" ? ` #${String(a["index"])}` : "";
    const st =
      typeof a["status"] === "string" ? ` → ${String(a["status"])}` : "";
    return `⚙ todo_update${idx}${st}`.trim();
  }
  return null;
}
