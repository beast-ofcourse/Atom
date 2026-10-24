# Architecture

ATOM is a flat-modules codebase with a few directories where a real seam
exists. The rule is responsibility + dependency direction, never line counts:
coherent single-file modules stay single files.

## Module map

```text
cli.tsx -> App.tsx (App) -> everything (UI root, the only React owner)
                              |
ui/{transcript,input,todo-panel}  (prop-driven memo leaves, no App import)
ui/{pickers,modals,status-bar,live-tail,palette}  (presentational shells; status-bar
    formats via context-windows, approval text arrives pre-formatted)
ui/theme  (design tokens: every color/glyph/separator/border/spacing value;
    components reference tokens, never literals)
ui/markdown  (zero-dep markdown for assistant turns: headings/lists/code/
    links/quotes; bounded parse cache; MarkdownStream auto-closes transient
    markers mid-stream and converges to the committed shape; tool lines stay
    full-fidelity — ToolLine renders call/warning/denied/retry/cancel states
    from shape, suffixing `· Ns` on slow calls from display-only Turn.ms)
ui/errors  (typed error cards for tool turns: tool/denial/network/model/
    cancelled/config/internal; adjacent [audit label, error detail] pairs
    merge in TranscriptView; full diagnostics stay in the inspector store)
ui/transcript  (static scrollback: committed turns print once via <Static>
    and are never rewritten — a full-page transcript no longer flashes on
    every keystroke (Ink clearTerminal path); commit frontier follows by
    default, PgUp//autoscroll-off freezes new commits with a `↓ N new`
    indicator, End resumes the backlog; banner once per Static identity;
    /thinking toggle is forward-only for committed blocks; global turn keys
    keep rows stable)
ui/tool-inspector  (Ctrl+O browse + expand panel for retained tool results:
    capped store, windowed list, viewport-scrolled output with explicit
    truncation; transcript untouched — expansion lives in the
    dynamic zone)
ui/activity  (working-state model: thinking-gap + verb-mapped tool lines;
    liveness from ticking elapsed seconds, never animated spinners)
ui/modals  (approval/question dialogs: arrows+Enter select, y/a/t/n pinned;
    command preview split from the audit prefix; policy untouched)
ui/diff, ui/highlight, ui/diff-view, ui/side-by-side  (zero-dep diff stack:
    unified engine + line-scoped syntax tokenizer + unified view +
    side-by-side BEFORE/AFTER view with narrow-terminal fallback; approved
    write/edit results commit their diff on the audit turn, stripped on save)
ui/diff-panel  (session-changes review: file list grouped by path with
    per-file side-by-side detail; same renderer as the transcript)
ui/input + input-model  (multiline box with line/col cursor, Ctrl+J newline,
    bracketed paste via usePaste, readline kills, in-memory prompt history;
    Enter always sends; slash menu stays single-line)
slash matching  (App-owned: exact input collapses to one command;
    otherwise prefix tier stable + fuzzy tier scored, one
    matcher for commands and skills; skill rows carry truncated
    descriptions; usage footer reuses the commands' own usage strings)
                              |
agent/loop  ->  agent/gates  ->  tools/* (getTodos)
    |    \--->  agent/types (types only)
    |    \--->  scheduler -> tools (validators)
    |    \--->  config, context-manager, tools (executors)
    v
zen.ts (transports, dispatch, prefs, prompt assembly)
    ├── re-exports agent/* + context-manager surface (compat)
    └── imports agent/loop (one direction only)
                              |
tools.ts (pure barrel)
    ├── tools/registry (names, validation, dispatch, schemas)
    ├── tools/filesystem (read/write/edit + snapshots + fingerprints)
    ├── tools/search (grep/glob)   tools/shell (bash/tasks)
    ├── tools/web (fetch/search)   tools/todo (checklist state)
    └── tools/shared, tools/overflow, tools/fingerprints (kernel)
                              |
context-manager.ts, compact.ts, prompt-cache.ts, env-block.ts, context-windows.ts   (context systems: flat files, one seam each)
session.ts + snapshots.ts   (persistence + pre-mutation snapshots)
policy.ts + permissions.ts + rollback.ts   (policy decisions, rule matching, turn rollback)
skills.ts — registry, loader, matcher (intentionally one file:
        discovery and parsing must stay byte-identical)
providers.ts, adapters.ts, kilo.ts   (provider types, wire adapters, Kilo gateway)
```

## Dependency rules (enforced by tests/architecture.test.ts)

- The runtime import graph is acyclic (type-only imports don't count —
  they erase at compile).
- `react`/`ink` live only in `cli.tsx`, `App.tsx`, `ui/*`. No runtime
  module imports the UI; tools, providers, context-manager, policy,
  scheduler, and everything under `agent/` are UI-free.
- `policy.ts` depends only on `permissions.ts` at runtime (plus types):
  it stays usable by future subagents with no fs/net/UI baggage.
- Inside `tools/`, executors never import the registry — the registry
  owns names/validation/dispatch and sits above them.
- Inside `agent/`, loop/gates/types never import `zen` at runtime —
  `zen.ts` re-exports them for compatibility, never the reverse.
- The scheduler reasons from `TOOL_EFFECTS` metadata, not per-tool
  branches; missing metadata fails safe to serial.

## What was deliberately NOT split

- `skills.ts`: registry + loader + matcher share one parser that must
  stay byte-identical across paths (says so in its header).
- `App.tsx` beyond the `ui/` leaves: the rest is hooks-entangled
  session state — splitting it further would be prop-drilling, not
  boundaries. Pure helpers already live at module scope and are
  directly unit-tested (slash menu, pickers, filters).
- `zen.ts` transports: one dispatch + per-kind wire functions belong
  together; the loop, gates, and types now live in `agent/`.
- Flat coherent modules (`config`, `session`, `snapshots`, `compact`,
  `prompt-cache`, `env-block`, `auth`, `system`): renaming them into
  directories would be motion without meaning.

## Verification

`tests/architecture.test.ts` scans the real source on every run, so
drift fails loudly with the exact file + edge. Behavior is pinned by
the full suite: every extraction above kept all
importer paths working (barrels + re-exports), and the suite is the
proof — no behavior change was made or needed.
