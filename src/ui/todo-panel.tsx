// Live session checklist panel (TodoWrite mirror). Prop-driven; returns
// null when empty. Mounted below the transcript, fed by a checklist snapshot.
// Paint from ui/theme tokens — no literal colors or glyphs here.
import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../tools.js";
import { theme } from "./theme.js";

// Live session checklist (Claude-Code-style TodoWrite panel). Mounted in
// the live area below the transcript (NOT in <Static> scrollback) and fed
// by a snapshot the loop refreshes after every todowrite/todo_update call,
// so the in-progress row — shown with its activeForm when present — always
// answers "what is the model doing right now". Frameless by restraint
// (ticket 07): the bold `Tasks n/m` header names the group, matching the
// frameless inspector/diff-panel lists — a box would spend two rows and two
// columns on chrome the header already carries. Returns null when empty.
// Render-count probe for the flicker tests: same-props parent churn must
// skip the panel (it only changes when the loop commits todo activity).
export const todoPanelRenderProbe = { count: 0 };

export const TodoPanel = React.memo(function TodoPanel({ items }: { items: TodoItem[] }) {
  todoPanelRenderProbe.count += 1;
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === "completed").length;
  return (
    <Box flexDirection="column" marginTop={theme.spacing.turnGap}>
      <Text bold>
        Tasks {done}/{items.length}
      </Text>
      {items.map((t, i) => {
        const mark =
          t.status === "completed"
            ? theme.symbol.taskDone
            : t.status === "in_progress"
              ? theme.symbol.taskActive
              : theme.symbol.taskPending;
        const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        return (
          <Text key={`${i}-${t.content}`} dimColor={t.status === "completed"}>
            {mark} {label}
            {t.priority ? ` (${t.priority})` : ""}
          </Text>
        );
      })}
    </Box>
  );
});
