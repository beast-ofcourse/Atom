// Single source for todo vocabulary + shape validation (fix 12).
// `src/tools/todo.ts` and `src/todos.ts` both import from here so one
// change never rots the other. Value import is safe (no cycles) — the
// type-only `TodoItem` lives here too, re-exported by both modules for
// backwards compat (existing `from "./tools/todo.js"` and `from "../todos.js"`
// imports keep working).

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";
export type TodoItem = {
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
  activeForm?: string;
};

export const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
export const TODO_PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);

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
    if (typeof value["content"] !== "string" || (value["content"] as string).length === 0) return null;
    const status = value["status"];
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return null;
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
      if ((value["activeForm"] as string).length > 0) clean.activeForm = value["activeForm"] as string;
    }
    return clean;
  } catch {
    return null;
  }
}

export function isRecordObject(v: unknown): v is Record<string, unknown> {
  return isRecord(v);
}
