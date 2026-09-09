// Live session checklist panel (TodoWrite mirror). Prop-driven; returns
// null when empty. Mounted below the transcript, fed by a checklist snapshot.
import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../tools.js";

// Live session checklist (Claude-Code-style TodoWrite panel). Mounted in
// the live area below the transcript (NOT in <Static> scrollback) and fed
// by a snapshot the loop refreshes after every todowrite/todo_update call,
// so the in-progress row — shown with its activeForm when present — always
// answers "what is the model doing right now". Returns null when empty.
export function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === "completed").length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold>
        Tasks {done}/{items.length}
      </Text>
      {items.map((t, i) => {
        const mark = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔧" : "❌";
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
}

