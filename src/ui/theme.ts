// ATOM TUI design tokens: the single source of visual truth.
//
// Every color, glyph, separator, border, and spacing value in the interface
// lives here. Components reference these tokens — never string literals —
// so the whole TUI can be re-skinned by editing this file alone, and later
// polish chunks change values here instead of hunting call sites.
//
// Density rules (terminal space is scarce):
// - No decorative boxes: only the input, pickers, and modals are framed.
// - The transcript is frameless text; hierarchy comes from speaker labels,
//   dimming, and one blank line between turns — never extra chrome.
// - `muted` is implemented as Ink `dimColor` (terminal-dimmed default fg),
//   NOT as gray paint: it adapts to light/dark terminals. Literal gray
//   (`color.mutedPaint`) is reserved for block glyphs (cursors) that need a
//   fixed shade to read as a shape.
//
// Identities (ATOM's own, not borrowed):
// - Speaker labels: `you>` (cyan) vs `ATOM>` (magenta).
// - Selection marker: `❯` + highlight color; unselected rows indent two
//   spaces so lists align without bullets.
// - Live activity: `◌` (tool running), `💭` (thinking), `▍`/`█` (cursors).
// - Status segments join with `·`; name/description rows join with `—`.
export const theme = {
  color: {
    // Base surfaces: inherit the terminal (no paint) — the TUI never sets a
    // background, so light and dark terminals both work.
    background: undefined as string | undefined,
    foreground: undefined as string | undefined,
    // Primary reading text: terminal default, emphasized with bold (titles,
    // speaker labels), never with a hue.
    primary: undefined as string | undefined,
    // Secondary/muted text: Ink dimColor mechanism (see note above).
    // `mutedPaint` is the fixed gray reserved for cursor glyphs.
    mutedPaint: "gray",
    // Interactive selection (picker rows, approval highlight).
    selection: "green",
    menuSelection: "cyan",
    questionSelection: "magenta",
    // Speaker identities.
    user: "cyan",
    assistant: "magenta",
    inputPrompt: "cyan",
    // Live activity (busy phase segment in the status bar).
    activity: "yellow",
    // Tool transcript lines: dim default text; red only on failure.
    tool: undefined as string | undefined,
    toolError: "red",
    // Outcomes + permission surfaces.
    success: "green",
    warning: "yellow",
    error: "red",
    permission: "yellow",
    // Reserved for the streaming-markdown chunk: code frames + links + headings.
    code: "green",
    link: "cyan",
    heading: undefined as string | undefined, // bold, no hue
    // Diff-body syntax colors (ui/highlight): Monokai-ish hues that read
    // on dark and light terminals. Comments stay dim (no hue — same rule
    // as muted text); plain code inherits the line paint.
    synKeyword: "magenta",
    synString: "yellow",
    synNumber: "cyan",
  },
  border: {
    style: "round" as const,
    input: "gray",
    picker: "green",
    menu: "cyan",
    panel: "cyan",
    approval: "yellow",
    question: "magenta",
  },
  spacing: {
    // Unselected picker rows indent to align with `❯ ` selected rows.
    rowIndent: "  ",
    // Code-block body indent (no boxes around code — indentation only).
    codeIndent: "  ",
    pickerPadX: 1,
    // Breathing room: one blank line after each committed turn; the live
    // tail floats with vertical margin; the status bar sits one line below.
    turnGap: 1,
    liveTailMarginY: 1,
    statusMarginTop: 1,
  },
  symbol: {
    select: "❯",
    bullet: "•",
    quoteBar: "│",
    moreAbove: "↑",
    moreBelow: "↓",
    separator: "·",
    descSeparator: "—",
    // Status-bar segment divider (structural, quiet). Inline joins elsewhere
    // keep `·`.
    bar: "│",
    // Expanded-view divider unit (repeated for the rule line — a divider,
    // never a frame).
    rule: "─",
    ellipsis: "…",
    running: "◌",
    thinking: "💭",
    // Working-state glyphs: open circle = unsettled (thinking), filled
    // circle = engaged (tool executing). Stable by design — liveness reads
    // from ticking elapsed seconds, not animation (see ui/activity).
    workThinking: "◐",
    workTool: "◉",
    // Attention marker for permission + warning surfaces (mirrors the
    // loop's `⚠ ` warning prefix).
    warningMark: "⚠",
    // The loop's tool-audit marker: committed call rows keep `⚙ name target`
    // byte-identical (tests + help pin the text); ToolLine keys its slow-run
    // suffix off this same marker.
    toolMark: "⚙",
    cursorBar: "▍",
    cursorBlock: "█",
    inputPrompt: "›",
    keyMask: "•",
    keyPresent: "✓",
    taskDone: "✅",
    taskActive: "🔧",
    // Pending means "not started yet" — an open circle (never ❌, which
    // reads as failed/denied). Matches the circle language of the
    // working-state glyphs (◌ unsettled / ◉ engaged).
    taskPending: "○",
    speakerUser: "you>",
    speakerAssistant: "ATOM>",
  },
} as const;

export type Theme = typeof theme;
