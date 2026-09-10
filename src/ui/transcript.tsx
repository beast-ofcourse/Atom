// Transcript leaves: the committed <Static> scrollback, its item renderer,
// and the startup banner. Prop-driven + memoized (see comments) so App state
// churn never repaints them. Turn is the display-transcript entry shape.
// All paint comes from ui/theme tokens — no literal colors or glyphs here.
import React from "react";
import { Box, Text } from "ink";
import { SideBySideDiffView, TRANSCRIPT_DIFF_MAX_LINES } from "./side-by-side.js";
import type { DiffPreview } from "./diff.js";
import { ErrorCard, classifyToolError } from "./errors.js";
import { MarkdownText, ToolLine } from "./markdown.js";
import { theme } from "./theme.js";

export type Turn = {
  role: "user" | "assistant" | "tool";
  content: string;
  error?: boolean;
  // Display-only: slow-tool duration in ms, attached by the TUI's loop
  // callback (never by the loop itself). The renderer suffixes `· Ns` on
  // calls at/over TOOL_SLOW_MS; absent/zero means "fast or unknown".
  ms?: number;
  // Display-only: committed unified diff for a successful write/edit
  // (attached by onToolActivity from the approve-time preview — never by
  // the loop, never persisted; see persistSession's strip). Renders under
  // the audit line via DiffView. Absent/null = label-only turn.
  diff?: DiffPreview | null;
  // Display-only: a committed model-thinking block (one assistant round's
  // reasoning, moved here when the next round starts so it stays in the TUI
  // instead of being replaced). Never enters model history — purely the
  // visible record. Hidden unless the /thinking toggle is on.
  thinking?: boolean;
};

// Scrollback viewport: the committed transcript renders as a windowed
// slice of turns in a live Box (NOT <Static> — Static is append-only with
// no scroll API, so PgUp/Home/follow modes are impossible on it).
//
// Model: E = viewed end index (items visible: (E-WIN, E]). E === turns.length
// means follow mode — new turns extend the view automatically. Any E < len
// is manual mode: the view freezes while new turns accumulate below, and a
// `↓ N new` indicator offers the jump back. Clamping makes list replacement
// (/clear, /resume, /new) re-follow for free (E > len collapses to len).
// Banner shows only when the window touches the top.
export const SCROLLBACK_WINDOW = 300;
export const SCROLL_PAGE_ITEMS = 10;

export type Viewport = { start: number; end: number; pending: number; follow: boolean };

export function resolveViewport(
  len: number,
  end: number | null | undefined,
  win: number = SCROLLBACK_WINDOW
): Viewport {
  const e = Math.max(0, Math.min(end ?? len, len));
  const follow = e >= len;
  return { start: Math.max(0, e - win), end: e, pending: len - e, follow };
}

// Scroll actions for the App key handler (pure — unit-tested here, wired
// thinly in App). All take the CURRENT list length (it grows mid-session).
export type ScrollAction =
  | { kind: "pageUp" }
  | { kind: "pageDown" }
  | { kind: "home" }
  | { kind: "end" };

export function applyScrollAction(
  end: number | null | undefined,
  len: number,
  action: ScrollAction
): number | null {
  const e = end ?? len;
  switch (action.kind) {
    case "pageUp":
      // Short sessions (everything fits the window) have no window to move:
      // freeze at the bottom instead of no-op-ing, so PgUp always engages
      // the held view (live output stops growing; the terminal stops
      // yanking). Long sessions move the window up a page, as before.
      if (len <= SCROLLBACK_WINDOW) return len;
      return Math.max(Math.min(len, SCROLLBACK_WINDOW), e - SCROLL_PAGE_ITEMS);
    case "pageDown": {
      const next = Math.min(len, e + SCROLL_PAGE_ITEMS);
      return next >= len ? null : next;
    }
    case "home":
      return Math.min(len, SCROLLBACK_WINDOW);
    case "end":
      return null;
  }
}
// Static items: one turn each, except adjacent [audit label, error detail]
// pairs, which merge into a single error card (the label names the tool the
// detail alone cannot). `turn` is always set (the detail for pairs), so
// custom renderItem functions keep working; `label` is present only on pairs.
export type StaticItem = { id: string; turn?: Turn; label?: Turn };

function isAuditLabel(t: Turn): boolean {
  return t.role === "tool" && !t.error && t.content.startsWith(`${theme.symbol.toolMark} `);
}

export function renderTranscriptItem(item: StaticItem) {
  if (!item.turn) return <StartupBanner key={item.id} />;
  const t = item.turn;
  const i = item.id;
  // Committed thinking blocks read as quiet annotations (never confused
  // with answers): dim label plus the raw reasoning text, verbatim.
  if (t.thinking === true) {
    return (
      <Box key={i} flexDirection="column">
        <Text dimColor>
          {theme.symbol.thinking} thinking
        </Text>
        <Text dimColor>{t.content}</Text>
      </Box>
    );
  }
  // Conversation turns (user/assistant) breathe: one blank line after each,
  // so the eye lands on the next turn. Tool/status lines stay dense — they
  // read as lightweight annotations woven between turns, not blocks.
  if (t.role === "user") {
    return (
      <Box key={i} flexDirection="column" marginBottom={theme.spacing.turnGap}>
        <Text>
          <Text color={theme.color.user} bold>
            {theme.symbol.speakerUser}{" "}
          </Text>
          {t.content}
        </Text>
      </Box>
    );
  }
  if (t.role === "tool") {
    const classified = classifyToolError(t, item.label ?? null);
    if (classified) {
      // Paired cards keep the verbatim audit line above the card (pinned
      // `⚙ name target` text for tests/scanning) and name the failure in
      // the card title. Lone details render the card alone. A successful
      // write/edit label swallowed by pairing (success line immediately
      // followed by an error line) keeps its committed diff above the card.
      const labelDiff = item.label?.diff;
      return (
        <React.Fragment key={i}>
          {item.label ? <ToolLine content={item.label.content} ms={item.label.ms} /> : null}
          {labelDiff && !item.label?.error ? (
            <SideBySideDiffView
              oldText={labelDiff.oldText}
              newText={labelDiff.newText}
              lang={labelDiff.lang}
              maxRows={TRANSCRIPT_DIFF_MAX_LINES}
            />
          ) : null}
          <ErrorCard classified={classified} />
        </React.Fragment>
      );
    }
    return (
      <React.Fragment key={i}>
        <ToolLine content={t.content} error={t.error} ms={t.ms} />
        {t.diff && !t.error ? (
          <SideBySideDiffView
            oldText={t.diff.oldText}
            newText={t.diff.newText}
            lang={t.diff.lang}
            maxRows={TRANSCRIPT_DIFF_MAX_LINES}
          />
        ) : null}
      </React.Fragment>
    );
  }
  return (
    <Box key={i} flexDirection="column" marginBottom={theme.spacing.turnGap}>
      <Text>
        <Text color={theme.color.assistant} bold>
          {theme.symbol.speakerAssistant}{" "}
        </Text>
      </Text>
      <MarkdownText text={t.content} />
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
  // Viewed end index (null/undefined = follow the bottom). Window size for
  // tests; production uses SCROLLBACK_WINDOW.
  end?: number | null;
  windowSize?: number;
  // Held view (user scrolled up): the window is frozen and the live tail
  // stops growing, so the terminal stops yanking mid-stream. Shows a static
  // resume hint when there is no pending count yet.
  held?: boolean;
  // Thinking visibility (the /thinking toggle, rendering-only): false hides
  // committed thinking turns in place (indices/keys stay global, so scroll
  // position never shifts and pairing is unaffected — thinking turns never
  // pair). Defaults to true (legacy always-show); App passes its toggle.
  showThinking?: boolean;
};

export const TranscriptView = React.memo(function TranscriptView({
  turns,
  clearGen,
  renderItem,
  end,
  windowSize,
  held,
  showThinking = true,
}: TranscriptViewProps) {
  transcriptRenderProbe.count += 1;
  const render = renderItem ?? renderTranscriptItem;
  const win = windowSize ?? SCROLLBACK_WINDOW;
  const vp = resolveViewport(turns.length, end, win);
  // Pairing ([audit label, error detail] → one card) runs over the VISIBLE
  // slice only — pairing is positional, and off-window turns never mount.
  // Keys stay global (`turn-${idx}`) so scrolling never remounts rows.
  // Hidden thinking turns are skipped in place (same index stability).
  const body: StaticItem[] = [];
  for (let idx = vp.start; idx < vp.end; idx++) {
    const turn = turns[idx]!;
    if (turn.thinking === true && !showThinking) continue;
    const next = idx + 1 < vp.end ? turns[idx + 1] : undefined;
    if (isAuditLabel(turn) && next !== undefined && next.role === "tool" && next.error === true) {
      body.push({ id: `turn-${idx}`, turn: next, label: turn });
      idx += 1;
      continue;
    }
    body.push({ id: `turn-${idx}`, turn });
  }
  const items: StaticItem[] =
    clearGen === 0 && vp.start === 0 ? [{ id: "banner" }, ...body] : body;
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <React.Fragment key={item.id}>{render(item)}</React.Fragment>
      ))}
      {vp.pending > 0 ? (
        <Text dimColor>
          ↓ {vp.pending} new — End for latest
        </Text>
      ) : held ? (
        <Text dimColor>
          {theme.symbol.moreAbove} held — End to follow
        </Text>
      ) : null}
    </Box>
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
    <Box flexDirection="column" marginBottom={theme.spacing.turnGap}>
      {ATOM_ART.map((line, i) => (
        <Text key={i} color={theme.color.user} bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}
