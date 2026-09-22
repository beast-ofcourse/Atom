# 1.5.7 — npm packaging & release notes

## Version: 1.5.7

### npm packaging & release prep

- Version bumped to 1.5.7 in `package.json` and `package-lock.json`
- Changelog restructured — prior Unreleased features promoted to 1.5.7
- Build verified; `prepublishOnly` script (`npm run build`) ready
- Test pass status: run `npm test` before final approval
- **🛑 HELD — not published.** Awaiting explicit approval before npm publish and GitHub release

### Ask tool (opencode parity)

- **Batch questions** (`src/tools/registry.ts`): `ask_question` takes an
  optional `questions[1-5]` batch alongside the single-question shorthand
  (mutually exclusive, validated); the executor loops `askUser` sequentially
  with `{index, total}` progress — single returns `{"answer"}`, batch
  returns `{"answers"}`, Esc names the cancelled item
- **One-by-one queue** (`src/App.tsx`): FIFO `askQueueRef` + head ref, `Q i/N`
  header in `QuestionBox`, Esc cancels current only, Ctrl+C drains all;
  web runtime and extension `askUser` carry the progress meta

### Todo panel polish

- **Live checklist rewrite** (`src/ui/todo-panel.tsx`): `Todo — done/total`
  header with in-progress count, theme glyphs (green check / yellow wrench /
  dim circle), hanging-indent rows, shared caps with ellipsis overflow, dead
  collapse state removed; hidden while the inspector owns the footer
- **No triple dump** (`src/App.tsx`): `todowrite`/`todo_update` commit the
  audit line + counts summary only — the full list lives in the panel and
  the Ctrl+O inspector; `todo_get` keeps its explicit echo

### Tool widgets (opencode parity)

- **Bordered widget per call** (`src/ui/components/ToolCall.tsx`): round
  frame colored by status (green/red/yellow/gray; `ask_question` in magenta),
  shared one-line summary, ≤6-line output preview with more-lines footer,
  diffs/errors inside the frame; audit `⚙` line byte-identical; chatter
  stays frameless. Dead per-kind presenters removed
- **Live twin wired** (`src/ui/live-tail.tsx`): the running tool mounts the
  same framed `LiveToolCall` with the `◉ Reading path` verb tail, settling
  into the committed card without a visual jump

### Sequenced thinking/preview lanes

- **Ordered blocks** (`src/ui/stream-store.ts`, `src/App.tsx`): the store
  tracks the active lane and the live zone renders only it; lane switches
  freeze the outgoing lane first, so the transcript alternates thinking,
  preview, thinking, preview in arrival order. Pins are suffix-only within
  a POST generation (fresh POST pins whole); live lanes paint segments,
  never cumulative duplicates
- **Cancel freeze** (`src/App.tsx`): Esc/failed turns commit streamed
  reasoning above the `(cancelled)` line instead of vanishing it
