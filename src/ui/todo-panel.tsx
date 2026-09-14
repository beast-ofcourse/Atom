// Live sidebar checklist — opencode parity.
// Mounted below the transcript in the live zone (NOT in <Static>), fed by
// a snapshot refreshed after every todowrite/todo_update.
// Matches opencode `packages/tui/src/feature-plugins/sidebar/todo.tsx`:
//   - Title `Todo` (bold) with collapse chevron when >2
//   - Hidden when all completed (`some(status !== "completed")`) — matches opencode `show` memo
//   - Each row `[✓]/[•]/[ ]` + content, `in_progress` in warning (yellow), others muted
//   - Frameless inline, in flow between transcript and input
// Render-count probe for flicker tests: same-props churn must skip.
import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../tools.js";
import { TODO_TUI_MAX_VISIBLE, TODO_TUI_OVERFLOW_THRESHOLD } from "../todo-shared.js";
import { theme } from "./theme.js";

export const todoPanelRenderProbe = { count: 0 };

function todoMark(status: TodoItem["status"]): string {
  if (status === "completed") return "[✓]";
  if (status === "in_progress") return "[•]";
  return "[ ]";
}

export const TodoPanel = React.memo(function TodoPanel({ items }: { items: TodoItem[] }) {
  todoPanelRenderProbe.count += 1;
  if (items.length === 0) return null;
  // opencode: hidden when all completed
  const hasOpen = items.some((t) => t.status !== "completed");
  if (!hasOpen) return null;
  // opencode collapsible when >2 (▼/▶ toggle). Ink has no mouse, so keep open by default
  // but show chevron hint matching opencode sidebar.
  const canCollapse = items.length > 2;
  const [open, setOpen] = React.useState(true);
  // Fix 10 — TUI cap is shared with compact tail
  const visible =
    items.length > TODO_TUI_OVERFLOW_THRESHOLD
      ? items.slice(0, TODO_TUI_MAX_VISIBLE)
      : items;
  const overflow = items.length - visible.length;
  const showList = !canCollapse || open;
  return (
    <Box flexDirection="column" marginTop={theme.spacing.turnGap}>
      <Box flexDirection="row" gap={1}>
        {canCollapse ? (
          <Text color={theme.color.warning} bold>
            {open ? "▼" : "▶"}
          </Text>
        ) : null}
        <Text bold wrap="truncate">
          Todo
        </Text>
      </Box>
      {showList
        ? visible.map((t, i) => {
            const mark = todoMark(t.status);
            const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
            const isInProgress = t.status === "in_progress";
            return (
              <Text
                key={`${i}-${t.content}`}
                color={isInProgress ? theme.color.warning : undefined}
                dimColor={!isInProgress}
                wrap="wrap"
              >
                {mark} {label}
              </Text>
            );
          })
        : null}
      {showList && overflow > 0 ? <Text dimColor wrap="truncate">… {overflow} more</Text> : null}
      {canCollapse && !open ? <Text dimColor>… {items.length} tasks (collapsed)</Text> : null}
    </Box>
  );
});

// Back-compat alias: the component is still the same live inline todos,
// historic import name "TodoPanel" stays, new name "TodosInline" is preferred
// for the opencode-style inline contract.
export const TodosInline = TodoPanel;
