// Live sidebar checklist — opencode parity.
// Mounted below the transcript in the live zone (NOT in <Static>), fed by
// props from the App's single store subscription (todo-refactor 05).
// Matches opencode `packages/tui/src/feature-plugins/sidebar/todo.tsx`:
//   - Bold `Todo — done/total` header (+ dim in-progress count)
//   - Hidden when empty or all completed (`some(status !== "completed")`)
//   - Glyphs + colors from ui/theme only (`✅` green / `🔧` yellow / `○` dim)
//   - Frameless inline, in flow between transcript and input
// The transcript keeps only the audit line + counts summary for
// todowrite/todo_update (App commit path); the full list lives here and in
// the Ctrl+O inspector — never duplicated in scrollback.
// Render-count probe for flicker tests: same-props churn must skip.
import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../todo-store.js";
import { TODO_TUI_MAX_VISIBLE, TODO_TUI_OVERFLOW_THRESHOLD } from "../todo-shared.js";
import { theme } from "./theme.js";
import { isVeryNarrow, useTerminalSize } from "./layout.js";

export const todoPanelRenderProbe = { count: 0 };

function todoMark(status: TodoItem["status"]): string {
  if (status === "completed") return theme.symbol.taskDone;
  if (status === "in_progress") return theme.symbol.taskActive;
  // Padded to the emoji cells so string-aligned rows stay straight.
  return `${theme.symbol.taskPending} `;
}

function markColor(status: TodoItem["status"]): string | undefined {
  if (status === "completed") return theme.color.success;
  if (status === "in_progress") return theme.color.warning;
  return undefined;
}

// Stable row identity without server ids (todo-refactor 05): content +
// status + fields composite, occurrence-suffixed for dupes. Survives
// reorder/insert where an index-prefixed key remounts every row below the
// edit; a status flip still remounts its own row (display changes anyway).
function todoRowKey(seen: Map<string, number>, t: TodoItem): string {
  const base = `${t.status}|${t.priority ?? ""}|${t.activeForm ?? ""}|${t.content}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}#${n + 1}`;
}

function TodoRow({ item }: { item: TodoItem }) {
  const label = item.status === "in_progress" && item.activeForm ? item.activeForm : item.content;
  const isCompleted = item.status === "completed";
  const isInProgress = item.status === "in_progress";
  return (
    <Box flexDirection="row">
      <Text color={markColor(item.status)} bold={isInProgress} dimColor={!isCompleted && !isInProgress}>
        {theme.spacing.rowIndent}
        {todoMark(item.status)}{" "}
      </Text>
      <Box flexGrow={1}>
        <Text
          color={isInProgress ? theme.color.warning : undefined}
          bold={isInProgress}
          dimColor={!isInProgress}
          wrap="wrap"
        >
          {label}
        </Text>
      </Box>
    </Box>
  );
}

export const TodoPanel = React.memo(function TodoPanel({ items }: { items: TodoItem[] }) {
  todoPanelRenderProbe.count += 1;
  let columns = 80;
  try {
    columns = useTerminalSize().columns;
  } catch {
    columns = 80;
  }
  const narrow = isVeryNarrow(columns);
  if (items.length === 0) return null;
  // opencode: hidden when all completed
  const done = items.filter((t) => t.status === "completed").length;
  if (done === items.length) return null;
  const inProgress = items.filter((t) => t.status === "in_progress").length;
  const visible =
    items.length > TODO_TUI_OVERFLOW_THRESHOLD
      ? items.slice(0, TODO_TUI_MAX_VISIBLE)
      : items;
  const overflow = items.length - visible.length;
  const seen = new Map<string, number>();
  return (
    <Box flexDirection="column" marginTop={theme.spacing.turnGap}>
      <Box flexDirection="row" gap={1}>
        <Text bold wrap="truncate">
          Todo
        </Text>
        <Text dimColor wrap="truncate">
          {theme.symbol.descSeparator} {done}/{items.length}
          {!narrow && inProgress > 0 ? ` ${theme.symbol.separator} ${inProgress} in-progress` : ""}
        </Text>
      </Box>
      {visible.map((t) => (
        <TodoRow key={todoRowKey(seen, t)} item={t} />
      ))}
      {overflow > 0 ? (
        <Text dimColor wrap="truncate">
          {theme.spacing.rowIndent}
          {theme.symbol.ellipsis} {overflow} more
        </Text>
      ) : null}
    </Box>
  );
});

// Back-compat alias: the component is still the same live inline todos,
// historic import name "TodoPanel" stays, new name "TodosInline" is preferred
// for the opencode-style inline contract.
export const TodosInline = TodoPanel;
