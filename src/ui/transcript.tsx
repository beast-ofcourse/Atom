// Transcript leaves: the committed <Static> scrollback, its item renderer,
// and the startup banner. Prop-driven + memoized (see comments) so App state
// churn never repaints them. Turn is the display-transcript entry shape.
// All paint comes from ui/theme tokens — no literal colors or glyphs here.
import React from "react";
import { Box, Static, Text } from "ink";
import type { DiffPreview } from "./diff.js";
import { theme } from "./theme.js";
import { ThinkingBlock } from "./components/ThinkingBlock.js";
import { ToolCall } from "./components/ToolCall.js";
import { MarkdownBody } from "./components/Markdown.js";
import { useTerminalSize } from "./layout.js";

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
  // Display-only: compact result summary for a committed tool call (one
  // line, never raw output — e.g. `50 lines`, `3 results`). Attached by
  // onToolActivity (legacy path) or the agent adapter (core path) from the
  // result at commit time, consumed by ToolCall's per-kind presenters.
  // Absent/null = label-only turn. Stripped on persist like diff/approvalVia.
  summary?: string | null;
  // Display-only: approval provenance for an approval-gated call (the
  // verdict's via token from decideApproval — deny/yolo/trust/allow-rule/
  // always/skill-grant/plan-passthrough/prompt — attached by onToolActivity
  // from the approve-time verdict, never by the loop, never persisted).
  // Renders as a dim `· via <token>` suffix on the audit line, keeping the
  // `⚙ name target` label text itself byte-identical. Absent/null = no
  // provenance (read-only tools never consult approval).
  approvalVia?: string | null;
  // Display-only: a committed model-thinking block (one assistant round's
  // reasoning, moved here when the next round starts so it stays in the TUI
  // instead of being replaced). Never enters model history — purely the
  // visible record. Hidden unless the /thinking toggle is on.
  thinking?: boolean;
};

// Commit frontier model: the committed transcript prints to terminal
// scrollback ONCE via <Static> and is never rewritten (this is what keeps
// a full-page transcript from flashing on every keystroke — Ink takes a
// clearTerminal + full-reprint path for fullscreen dynamic frames).
//
// Model: E = committed end index (null = follow: commit everything). Any
// E < len is manual mode — new turns accumulate below the frontier and a
// `↓ N new` indicator offers the jump back. Printed output can never
// retract, so E below the committed count holds back future commits only;
// deep history lives in terminal scrollback. Banner shows on fresh mounts.
// List replacement (/clear, /resume, /new, /rewind) bumps clearGen, which
// resets the Static buffer via the identity below.
export const SCROLLBACK_WINDOW = 300;
export const SCROLL_PAGE_ITEMS = 10;

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
      // Freeze the commit frontier instead of no-op-ing, so PgUp always
      // engages the held view (new output stops printing below; the live
      // tail stops growing; the terminal stops yanking). Values below the
      // already-committed count hold back future commits only — printed
      // output lives in terminal scrollback and can never retract.
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
  // Committed thinking blocks read as one grouped unit (never confused
  // with answers) — canonical ThinkingBlock (same visual language as live).
  if (t.thinking === true) {
    return (
      <Box key={i} flexDirection="column">
        <ThinkingBlock content={t.content} variant="committed" />
      </Box>
    );
  }
  // Conversation hierarchy (frameless — speaker labels + dimming + one
  // blank line between turns, never boxes):
  //   user      bold cyan `you>` identity on the first line; explicit
  //             newlines hang-indent to the label width so pasted
  //             multi-line prompts keep one readable block. Single Text
  //             node keeps the content verbatim (wrapping is Ink's job).
  //   assistant bold magenta `ATOM>` header row, then the structured
  //             markdown body below — the header never shares a line with
  //             body text, so long-form answers always start at a
  //             predictable edge.
  //   tool      dense annotation lines (no turn gap) — see ToolCall.
  if (t.role === "user") {
    const label = theme.symbol.speakerUser;
    const pad = " ".repeat(label.length + 1);
    const lines = t.content.split("\n");
    return (
      <Box key={i} flexDirection="column" marginBottom={theme.spacing.turnGap}>
        {lines.map((ln, k) => (
          <Text key={k} wrap="wrap" color={theme.color.user}>
            {k === 0 ? (
              <>
                <Text color={theme.color.user} bold>
                  {label}{" "}
                </Text>
                {ln}
              </>
            ) : (
              <>
                {pad}
                {ln}
              </>
            )}
          </Text>
        ))}
      </Box>
    );
  }
  if (t.role === "tool") {
    return <ToolCall key={i} turn={t} label={item.label} />;
  }
  return (
    <Box key={i} flexDirection="column" marginBottom={theme.spacing.turnGap}>
      <Text wrap="wrap">
        <Text color={theme.color.assistant} bold>
          {theme.symbol.speakerAssistant}
        </Text>
      </Text>
      <MarkdownBody text={t.content} />
    </Box>
  );
}

// Render-count probe for the timer-isolation test: incremented on every
// TranscriptView render (a 1s timer tick must leave it unchanged).
export const transcriptRenderProbe = { count: 0 };

// Render-count probe for row isolation: incremented per mounted row paint
// (appending one turn must paint exactly one new row, never the window).
export const transcriptRowRenderProbe = { count: 0 };

type TranscriptRowProps = {
  item: StaticItem;
  render: (item: StaticItem) => React.ReactNode;
};

// Committed turns are immutable once appended (diffs attach pre-commit in
// onToolActivity, never post-append), and keys stay global (`turn-${idx}`),
// so a row whose item identity is unchanged can skip rendering entirely.
// Custom compare: the body array is rebuilt per TranscriptView render with
// fresh wrappers around the SAME turn refs — shallow compare would always
// miss, hence id + turn/label identity. An unstable render fn falls back to
// today's behavior (re-render) rather than going stale.
function transcriptRowEqual(a: TranscriptRowProps, b: TranscriptRowProps): boolean {
  return (
    a.render === b.render &&
    a.item.id === b.item.id &&
    a.item.turn === b.item.turn &&
    a.item.label === b.item.label
  );
}

const TranscriptRow = React.memo(function TranscriptRow({ item, render }: TranscriptRowProps) {
  transcriptRowRenderProbe.count += 1;
  return <React.Fragment>{render(item)}</React.Fragment>;
}, transcriptRowEqual);

export type TranscriptViewProps = {
  turns: Turn[];
  clearGen: number;
  renderItem?: (item: StaticItem) => React.ReactNode;
  // Committed frontier (null/undefined = follow: commit everything).
  // Committed turns print to terminal scrollback ONCE via <Static> and are
  // never rewritten — once the transcript exceeds the viewport, Ink would
  // otherwise clearTerminal + reprint the whole page on every keystroke,
  // tick, and token (measured 8.3KB + clear per single-line change vs
  // ~40 bytes with Static). Values below the committed count hold back NEW
  // output only (PgUp / /autoscroll off freeze the frontier; End resumes
  // by committing the backlog). Printed output can never retract, so deep
  // history lives in terminal scrollback (Shift+PgUp / mouse).
  end?: number | null;
  // Held view (user froze the frontier): the live tail stops growing, so
  // the terminal stops yanking mid-stream. Shows a static resume hint when
  // there is no pending count yet.
  held?: boolean;
  // Thinking visibility is forward-only: hidden thinking turns are skipped
  // permanently at commit time (Static items are append-only — already
  // printed rows can neither hide nor reshuffle), so the toggle covers the
  // live block plus future rounds, never past commits. Defaults to true
  // (legacy always-show); App passes its toggle.
  showThinking?: boolean;
};

// Monotonic static admission: convert record turns [from, to) into Static
// items, pairing adjacent [audit label, error detail] within the batch and
// permanently skipping hidden thinking turns. ALWAYS returns next ===
// clamped `to` (even when everything skips) so the frontier only moves
// forward — shrinking or reordering same-identity items would misalign
// Ink's append-only Static buffer and duplicate terminal scrollback.
// List replacements (/clear, /resume, /rewind) bump clearGen instead, which
// resets the buffer via the Static identity below.
export function admitStaticBatch(
  turns: Turn[],
  from: number,
  to: number,
  showThinking: boolean
): { items: StaticItem[]; next: number } {
  const end = Math.max(from, Math.min(to, turns.length));
  const items: StaticItem[] = [];
  let idx = from;
  while (idx < end) {
    const turn = turns[idx]!;
    if (turn.thinking === true && !showThinking) {
      idx += 1;
      continue;
    }
    const next = idx + 1 < end ? turns[idx + 1] : undefined;
    if (isAuditLabel(turn) && next !== undefined && next.role === "tool" && next.error === true) {
      items.push({ id: `turn-${idx}`, turn: next, label: turn });
      idx += 2;
      continue;
    }
    items.push({ id: `turn-${idx}`, turn });
    idx += 1;
  }
  return { items, next: end };
}

export const TranscriptView = React.memo(function TranscriptView({
  turns,
  clearGen,
  renderItem,
  end,
  held,
  showThinking = true,
}: TranscriptViewProps) {
  transcriptRenderProbe.count += 1;
  const render = renderItem ?? renderTranscriptItem;
  const frontier = end ?? turns.length;
  // Committed static state: full reset on clearGen (list replacements bump
  // it — replacements must never reuse the buffer), suffix-only advance
  // otherwise (setState-during-render derived-state pattern; the extra pass
  // runs only when genuinely new items commit, never on ticks/keystrokes).
  const [committed, setCommitted] = React.useState(() => {
    const base: StaticItem[] = clearGen === 0 ? [{ id: "banner" }] : [];
    const batch = admitStaticBatch(turns, 0, frontier, showThinking);
    return { gen: clearGen, items: [...base, ...batch.items], next: batch.next };
  });
  if (committed.gen !== clearGen) {
    const base: StaticItem[] = clearGen === 0 ? [{ id: "banner" }] : [];
    const batch = admitStaticBatch(turns, 0, end ?? turns.length, showThinking);
    setCommitted({ gen: clearGen, items: [...base, ...batch.items], next: batch.next });
  } else {
    const batch = admitStaticBatch(turns, committed.next, frontier, showThinking);
    if (batch.items.length > 0 || batch.next !== committed.next) {
      setCommitted({
        gen: clearGen,
        items: [...committed.items, ...batch.items],
        next: batch.next,
      });
    }
  }
  // Backlog below the committed frontier (frozen appends, not yet printed).
  const pending = turns.length - committed.next;
  return (
    <>
      <Static key={clearGen} items={committed.items}>
        {(item: StaticItem) => <TranscriptRow key={item.id} item={item} render={render} />}
      </Static>
      {pending > 0 ? (
        <Text dimColor>
          ↓ {pending} new — End for latest
        </Text>
      ) : held ? (
        <Text dimColor>
          {theme.symbol.moreAbove} held — End to follow
        </Text>
      ) : null}
    </>
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
  let columns = 80;
  try {
    columns = useTerminalSize().columns;
  } catch {
    columns = 80;
  }
  // Very narrow: banner would wrap and break its box-drawing, so hide it.
  // The status bar remains the sole chrome on xs.
  if (columns < 50) return null;
  return (
    <Box flexDirection="column" marginBottom={theme.spacing.turnGap}>
      {ATOM_ART.map((line, i) => (
        <Text key={i} color={theme.color.user} bold wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}
