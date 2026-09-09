// Transcript leaves: the committed <Static> scrollback, its item renderer,
// and the startup banner. Prop-driven + memoized (see comments) so App state
// churn never repaints them. Turn is the display-transcript entry shape.
import React from "react";
import { Box, Static, Text } from "ink";

export type Turn = {
  role: "user" | "assistant" | "tool";
  content: string;
  error?: boolean;
};

// Task B smoothness (b): the 1s elapsed timer lives in App state, so every
// tick re-renders App. The committed transcript (<Static>) must NOT pay for
// that: TranscriptView memoizes on (turns, clearGen) identity, so a tick (or
// any other App state change) with an unchanged transcript skips the whole
// Static subtree. Static usage is unchanged (no virtualization).
export type StaticItem = { id: string; turn?: Turn };

export function renderTranscriptItem(item: StaticItem) {
  if (!item.turn) return <StartupBanner key={item.id} />;
  const t = item.turn;
  const i = item.id;
  // Conversation turns (user/assistant) breathe: one blank line after each,
  // so the eye lands on the next turn. Tool/status lines stay dense — they
  // read as lightweight annotations woven between turns, not blocks.
  if (t.role === "user") {
    return (
      <Box key={i} flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="cyan" bold>
            you&gt;{" "}
          </Text>
          {t.content}
        </Text>
      </Box>
    );
  }
  if (t.role === "tool") {
    return (
      <Text key={i} color={t.error ? "red" : undefined} dimColor={!t.error}>
        {t.content}
      </Text>
    );
  }
  return (
    <Box key={i} flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="magenta" bold>
          ATOM&gt;{" "}
        </Text>
        {t.content}
      </Text>
    </Box>
  );
}

// Render-count probe for the timer-isolation test: incremented on every
// TranscriptView render (a 1s timer tick must leave it unchanged).
export const transcriptRenderProbe = { count: 0 };

export type TranscriptViewProps = {
  turns: Turn[];
  clearGen: number;
  renderItem?: (item: StaticItem) => React.ReactNode;
};

export const TranscriptView = React.memo(function TranscriptView({
  turns,
  clearGen,
  renderItem,
}: TranscriptViewProps) {
  transcriptRenderProbe.count += 1;
  const render = renderItem ?? renderTranscriptItem;
  const items: StaticItem[] =
    clearGen === 0
      ? [{ id: "banner" }, ...turns.map((turn, idx) => ({ id: `turn-${idx}`, turn }))]
      : [...turns.map((turn, idx) => ({ id: `turn-${idx}`, turn }))];
  return (
    <Static key={`transcript-${clearGen}`} items={items}>
      {(item: StaticItem) => render(item)}
    </Static>
  );
});


// Startup banner: the ATOM block-letter art, rendered once at launch inside
// <Static> (scrollback, so it scrolls away naturally). FIGlet "ANSI Shadow"
// ATOM (Unicode box-drawing — needs a monospace font with box-drawing
// support, which Windows Terminal / ConHost / most terminals have). The art
// is the whole banner: the footer status line is the sole info bar, so no
// hint lines live here.
export const ATOM_ART: string[] = [
  " █████╗ ████████╗ ██████╗ ███╗   ███╗",
  "██╔══██╗╚══██╔══╝██╔═══██╗████╗ ████║",
  "███████║   ██║   ██║   ██║██╔████╔██║",
  "██╔══██║   ██║   ██║   ██║██║╚██╔╝██║",
  "██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║",
  "╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝",
];

export function StartupBanner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {ATOM_ART.map((line, i) => (
        <Text key={i} color="cyan" bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}

