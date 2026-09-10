// Session checklist state + todowrite/todo_get/todo_update. Module-global
// list (session-scoped, ephemeral); invariants refuse as invalid calls.
import { err, invalidCall } from "./shared.js";
// ---- Session todo list (Claude-Code TodoWrite / opencode todowrite parity) ----

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";
export type TodoItem = {
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
  activeForm?: string;
};
export type TodowriteArgs = { todos: TodoItem[] };

export const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
export const TODO_PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);

// Session-scoped, ephemeral (resets with the process — same lifetime as
// read fingerprints and background tasks). todowrite replaces the whole
// list per call (Claude Code / opencode); todo_get reads it back;
// todo_update patches one item by index (check/uncheck without rewrite).
let todoItems: TodoItem[] = [];

// Copy for UI/tests (the executor's echoed rendering is the model path).
export function getTodos(): TodoItem[] {
  return todoItems.map((t) => ({ ...t }));
}

// Reset for /new (a fresh conversation in the same process starts with a
// fresh checklist; /clear keeps it — the session continues).
export function clearTodos(): void {
  todoItems = [];
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
    for (const prev of todoItems) {
      if (prev.status !== "completed") continue;
      const reopened = next.find((t) => t.content === prev.content && t.status !== "completed");
      if (reopened) {
        return invalidCall(
          `task "${prev.content}" is already completed — a rewrite cannot reopen it. ` +
            `To reopen it explicitly, call todo_update on its index with a new status`
        );
      }
    }
    const prevCount = todoItems.length;
    todoItems = next;
    if (next.length === 0) {
      return prevCount === 0 ? "Todo list is empty." : `Todo list cleared (${prevCount} item(s) removed).`;
    }
    if (next.every((t) => t.status === "completed")) {
      todoItems = [];
      return `All ${next.length} task(s) completed — todo list cleared.\n${renderTodos(next)}`;
    }
    return (
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.\n" +
      renderTodos(next)
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
    if (rawIndex < 1 || rawIndex > todoItems.length) {
      return invalidCall(
        `todo_update index ${rawIndex} out of range (list has ${todoItems.length} item(s); call todo_get to refresh)`
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
    const next: TodoItem = { ...(todoItems[rawIndex - 1] as TodoItem) };
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
        const other = todoItems.findIndex(
          (t, i) => i !== rawIndex - 1 && t.status === "in_progress"
        );
        if (other !== -1) {
          return invalidCall(
            `only one task may be in_progress at a time (item ${other + 1} "${
              (todoItems[other] as TodoItem).content
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
    todoItems[rawIndex - 1] = next;
    if (todoItems.length > 0 && todoItems.every((t) => t.status === "completed")) {
      const snapshot = renderTodos(todoItems);
      const done = todoItems.length;
      todoItems = [];
      return `All ${done} task(s) completed — todo list cleared.\n${snapshot}`;
    }
    return `Todo ${rawIndex} updated.\n${renderTodos(todoItems)}`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

