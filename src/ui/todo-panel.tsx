// Live inline checklist (opencode-style). Prop-driven; null when empty.
// Mounted below the transcript in the live zone (NOT in <Static>), fed by
// a snapshot refreshed after every todowrite/todo_update. Renders as an
// inline TUI block — "# Todos" + bracket checkboxes — not a bordered panel.
// Matches opencode's transcript todos:
//
//   # Todos
//   [✓] done thing
//   [✓] verified thing
//   [•] current thing
//   [ ] later thing
//
// Frameless, always in the flow between transcript and input. The snapshot
// itself is the only source of truth; the panel never synthesizes state.
// Render-count probe for flicker tests: same-props churn must skip.
import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../tools.js";
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
  // Cap visible rows on small terminals (80x24): show at most 8, overflow
  // indicator keeps the live zone from pushing input off-screen.
  const visible = items.length > 12 ? items.slice(0, 8) : items;
  const overflow = items.length - visible.length;
  return (
    <Box flexDirection="column" marginTop={theme.spacing.turnGap}>
      <Text bold wrap="truncate">
        # Todos
      </Text>
      {visible.map((t, i) => {
        const mark = todoMark(t.status);
        const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        return (
          <Text key={`${i}-${t.content}`} dimColor={t.status === "completed"} wrap="wrap">
            {mark} {label}
          </Text>
        );
      })}
      {overflow > 0 ? <Text dimColor wrap="truncate">… {overflow} more</Text> : null}
    </Box>
  );
});

// Back-compat alias: the component is still the same live inline todos,
// historic import name "TodoPanel" stays, new name "TodosInline" is preferred
// for the opencode-style inline contract.
export const TodosInline = TodoPanel;
