// ATOM TUI design system: the single source of visual truth.
//
// Every color, glyph, separator, border, and spacing value in the interface
// lives here. Components reference these tokens — never string literals —
// so the whole TUI can be re-skinned by editing this file alone.
//
// --- Color palette (6 hues + terminal default, reused by role, never by whim)
//   default (no paint)  primary reading text, tool lines, code body
//   cyan     navigation: input prompt, links, numbers,
//              menu/panel frames, current-model accents
//   blue     user identity: you> + full user message (blue-ish, whole line)
//   magenta  agent voice + language: ATOM>, question frame/selection,
//              keywords
//   green    success + focus: selection highlight, ✓/+, code labels,
//              picker frame, task completion
//   yellow   attention + energy: activity, warnings, permission surfaces,
//              strings, trust/allowlia
//   red      failure only: errors, ✕, deletions — never decoration
//   gray     chrome only: input frame, cursors (mutedPaint), key masks
// Muted text is Ink `dimColor` (terminal-dimmed default fg), NOT gray paint:
// it adapts to light/dark terminals. Literal gray (`color.mutedPaint`) is
// reserved for block glyphs (cursors) that need a fixed shade to read as a
// shape. The TUI never sets a background — light and dark terminals both work.
//
// --- Text hierarchy (typography, not boxes — the transcript is frameless)
//   title    bold                    picker/modal/panel headers
//   speaker  bold + identity hue     you> (cyan) / ATOM> (magenta)
//   body     plain default fg        answers, code, tool targets
//   caption  dimColor                hints, footers, counts, previews
//   code     green fg (inline spans) / indented + dim label (blocks)
//   link     cyan + underline, url in dim parens
// Hierarchy comes from speaker labels, dimming, and one blank line between
// turns — never extra chrome, never giant headings.
//
// --- Spacing scale (terminal space is scarce; unit = 1 row/col)
//   rowIndent  "  "  unselected rows align with `❯ ` selected rows
//   codeIndent "  "  code-block body indent (no boxes around code)
//   pickerPadX 1     framed-surface horizontal padding (all popups alike)
//   turnGap    1     one blank line after each committed turn + todo panel
//   liveTailMarginY 1  live zone floats with vertical margin (collapses to
//                     nothing when idle — no blank lines spent on empty state)
//   statusMarginTop 1  status bar sits one line below the input
// Markdown block rhythm reuses the unit inline (`gap ? 1 : 0`).
//
// --- Borders (framed surfaces only — input, pickers/popups, modals)
// Live panels (todo checklist, tool inspector, diff review) stay frameless:
// their bold headers name the group. The transcript is frameless text.
// Third-party extension widgets keep the `panel` frame: untrusted content of
// unbounded shape needs a containment + provenance boundary.
// One style (`round`) everywhere; hue carries surface identity:
// input gray · picker green · menu cyan · panel cyan · approval yellow ·
// question magenta.
//
// --- Selection/focus (one language: `❯ ` + green, every surface)
// Row highlight is always `theme.color.selection`; borders keep surface
// identity so focus never needs a second hue. `menuSelection` and
// `questionSelection` remain as aliases for call-site readability.
//
// --- Emphasis levels (in order — never combine hue + bold for one signal)
//   1. bold            titles, speaker labels, error titles, table headers
//   2. identity hue    speaker labels, activity phase, links
//   3. dimColor        secondary info (counts, hints, context lines)
//   4. hue escalation  exactly one step (warning yellow, error red) for
//                      states that need attention — never decoration
// Liveness reads from ticking elapsed seconds, never animated glyphs:
// no animation without feedback, no spinner timers.
//
// --- Status styles
// The footer status line is the sole info bar (no persistent header).
// Segments join with `│`; idle shows provider/model │ token │ location │
// reasoning │ mode; busy swaps location for activity + clock + esc-hint.
// Decision demand (`waiting approval`, yellow) outranks location; the goal
// and extension segments are guests that drop whole under width pressure —
// builtins never shrink, wrap, or move for a guest.
//
// --- Tool styles
// Audit rows stay dim default text (`⚙ name target` byte-identical — pinned
// by tests + help); slow runs append `· Ns`; approval provenance appends
// `· via <token>` outside the label text. Results never echo on success
// (the model owns them); failures render `↳ detail` in error red.
// Collapsed one-liners read state from one glyph set: ✓ ok · ✕ failed ·
// ⊘ denied (calm-neutral, never the failure cross).
//
// --- Error styles
// Compact cards, three lines max: bold titled first line (red for tool/
// model/internal, yellow for network/denial, cyan for setup), one detail
// line (capped, first line only), one dim hint line. Full diagnostics live
// in the Ctrl+O inspector store — cards point there instead of dumping.
//
// --- Symbols (pinned by tests + help — values never change casually)
// `⚙`/`↳`/`↻`/`⚠` inside Turn *content* are loop-protocol prefixes (the
// loop commits them; ToolLine/classifyToolError read them back). Theme
// mirrors them here so UI code references tokens, never literals.
//
// --- Identities (ATOM's own, not borrowed)
// Speaker labels `you>` vs `ATOM>`; selection marker `❯`; live activity
// `◌` (tool running), `💭` (thinking, pinned), `▍`/`█` (cursors); working
// states `◐` unsettled / `◉` engaged; task states `✅`/`🔧`/`○` (content-
// protocol, mirrored here — tests pin the transcript text).
// Status segments join with `·`; name/description rows join with `—`.
export const theme = {
  color: {
    // Base surfaces: inherit the terminal (no paint) — the TUI never sets a
    // background, so light and dark terminals both work.
    background: undefined as string | undefined,
    foreground: undefined as string | undefined,
    // Primary reading text: terminal default, emphasized with bold (titles,
    // speaker labels), never with a hue.
    primary: undefined as string | undefined,
    // Secondary/muted text: Ink dimColor mechanism (see header note).
    // `mutedPaint` is the fixed gray reserved for cursor glyphs.
    mutedPaint: "gray",
    // Interactive selection — one focus language (`❯ ` + green) on every
    // surface; borders carry surface identity instead of a second hue.
    selection: "green",
    // Aliases kept for call-site readability (picker self-labels, menu rows,
    // question rows). Same value by design — see "Selection/focus" above.
    menuSelection: "green",
    questionSelection: "green",
    // Speaker identities.
    user: "#6EA8FF",
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
    // Markdown accents: code labels + links + headings (bold, no hue).
    code: "green",
    link: "cyan",
    heading: undefined as string | undefined, // bold, no hue
    // Diff-body syntax colors: Monokai-ish hues that read on dark and light
    // terminals, reusing the palette roles (magenta language, yellow energy,
    // cyan navigation). Comments stay dim (no hue — same rule as muted
    // text); plain code inherits the line paint.
    synKeyword: "magenta",
    synString: "yellow",
    synNumber: "cyan",
    // Diff changed-word highlight: high-contrast background treatment so
    // changed words pop over syntax hues (paired with diffChangedFg).
    diffAddBg: "green",
    diffDelBg: "red",
    diffChangedFg: "black",
    // Premium TUI v2 accents (additive only — every pinned value above is
    // byte-identical). Header/banner/composer/step accents reuse the same
    // 6-hue palette by role, never new hues.
    bannerA: "#6EA8FF",
    bannerB: "magenta",
    headerBranch: "green",
    composerFocus: "cyan",
    composerBusy: "yellow",
    badgeUser: "#6EA8FF",
    badgeAssistant: "magenta",
    quoteAccent: "cyan",
    ruleDim: true as boolean,
    question: "magenta",
  },
  border: {
    style: "round" as const,
    input: "gray",
    picker: "green",
    menu: "cyan",
    panel: "cyan",
    approval: "yellow",
    question: "magenta",
    tool: {
      ok: "green",
      fail: "red",
      denied: "yellow",
      running: "yellow",
      queued: "gray",
    },
  },
  // Sharp full-width bottom strip: single (square-corner) border, no
  // side margins, no width cap — the dock spans the terminal.
  dock: {
    border: "gray",
    borderStyle: "single" as const,
    padX: 1,
    divider: "─",
  },
  spacing: {
    // Unselected picker rows indent to align with `❯ ` selected rows.
    rowIndent: "  ",
    // Code-block body indent (no boxes around code — indentation only).
    codeIndent: "  ",
    pickerPadX: 1,
    widgetPadX: 1,
    // Breathing room: one blank line after each committed turn; the live
    // tail floats with vertical margin; the status bar sits one line below.
    turnGap: 1,
    liveTailMarginY: 1,
    statusMarginTop: 1,
    // Layout caps (brand-dock Phase 1 item 1.5, additive only — values pin
    // the legacy budgets byte-identical, no visual change).
    // Input frame inset: borders + padding reserved from `columns`.
    inputInset: 6,
    // Status bar default width (Ink width when stdout reports none).
    statusDefaultColumns: 100,
    // Status bar starvation floor: below this width render model + mode only.
    statusXsColumns: 50,
    // Goal segment default objective budget (idle layout).
    statusGoalObjectiveChars: 32,
    // Goal segment guest cap inside the busy fixed line.
    statusBusyGoalChars: 48,
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
    // Retry line marker (loop-protocol: the loop commits `↻ retrying…` turns;
    // UI references this token, never the literal).
    retryMark: "↻",
    // Error-detail marker (loop-protocol: the loop commits `↳ detail` turns;
    // the classifier strips it via this token, never a literal).
    detailMark: "↳",
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
    // Collapsed tool-block states (ticket 03): every collapsed one-liner
    // (inspector row, expanded header) reads its outcome glyph from here —
    // never ad-hoc literals — so success/failed/denied stay one token edit.
    // Denied is calm-neutral (its own glyph, never the failure cross); the
    // running state keeps the live `running`/`workTool` glyphs above.
    toolOk: "✓",
    toolFail: "✕",
    toolDenied: "⊘",
    // Lifecycle glyphs for the first-class ToolCall system (queued/running/
    // success/failed/cancelled). Aliased to the existing palette so the
    // whole TUI can still be re-skinned from this file alone; new names
    // exist so call-sites read as `toolQueued` etc. rather than reusing
    // task/selection tokens. Values are pinned by ToolCall tests.
    toolQueued: "○",
    toolRunning: "◉",
    toolSuccess: "✓",
    toolFailed: "✕",
    toolCancelled: "◌",
    // Per-kind labels for the ToolCall header's `[tool]` slot. Text, not
    // emoji, so every terminal renders them without font fallback. The
    // lifecycle glyph (above) already carries status; the kind label carries
    // family identity. Keep lowercase to match the prompt's `terminal` example.
    kindTerminal: "terminal",
    kindFile: "file",
    kindSearch: "search",
    kindWeb: "web",
    kindTodo: "todo",
    kindVision: "vision",
    kindGeneric: "tool",
    taskDone: "✅",
    taskActive: "🔧",
    // Pending means "not started yet" — an open circle (never ❌, which
    // reads as failed/denied). Matches the circle language of the
    // working-state glyphs (◌ unsettled / ◉ engaged).
    taskPending: "○",
    // Markdown task-list boxes (GFM `- [ ]` / `- [x]`): ballot boxes, kept
    // as theme tokens so ui/markdown never holds ad-hoc ☑/☐ literals.
    // Distinct from taskDone (✅, todo-panel protocol) — pixels unchanged.
    taskDoneBox: "☑",
    taskDoneEmpty: "☐",
    speakerUser: "you>",
    speakerAssistant: "ATOM>",
    questionStep: "Q",
  },
} as const;

// Phase 1.1 — reserved pill namespace (type-only, no runtime change;
// Ember deltas land in Phase 5). Optional + never-valued keeps the `theme`
// value untouched and deep-equal safe. `dock` ships early (brand-dock
// §2.3, Classic-equivalent paint) so Dock reads frame geometry from tokens.
export type Theme = typeof theme & {
  pill?: Record<string, never>;
};
