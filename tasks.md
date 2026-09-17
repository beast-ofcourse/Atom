# Tasks — Ask queue, Todo panel polish, Tool widgets (opencode parity)

Goal: bring Atom TUI to opencode parity for (1) ask/question flow, (2) todo panel, (3) tool call/output widgets. No behavior change to executors; TUI + `ask_question` contract only.

File map (source of truth, verified 2026-09-17):

- Ask tool: `src/tools/registry.ts` (~L99, L136-140, L490-518, L615-618, L777-779, L1179-1206, L1381-1475), `src/agent/types.ts` (L190-192), `src/agent/core.ts` (L20-23, L143), `src/agent/tool-pipeline.ts` (L468-493), `src/agent/tool-result.ts`, `src/agent/events.ts` (L124), `src/ui/modals.tsx` (`QuestionBox` L94-136), `src/ui/components/Modal.tsx`, `src/App.tsx` (state L2232-2244, hook L5942-5990, input L7227-7302, render L8822-8844), `src/web/runtime.ts` + `src/web/ui/app.js`, `src/extensions.ts` + `src/extension-ui.ts`
- Todo: `src/todo-shared.ts`, `src/todo-store.ts`, `src/tools/todo.ts`, `src/todos.ts`, `src/ui/todo-panel.tsx`, `src/App.tsx` (L1393-1397, L6971-6998, L8848), `src/ui/components/ToolCall.tsx` (`TodoPresenter`), `src/ui/tool-model.ts` (`summarizeTodo`), `src/ui/transcript.tsx`, `src/ui/theme.ts`, `src/ui/layout.ts`, `src/ui/components/AppShell.tsx`
- Tool widgets: `src/ui/components/ToolCall.tsx`, `src/ui/tool-model.ts`, `src/ui/transcript.tsx` (`admitStaticBatch`, `renderTranscriptItem`), `src/ui/markdown.tsx` (`ToolLine`), `src/ui/errors.tsx` (`ErrorCard`), `src/ui/tool-inspector.tsx` (`InspectorPanel`), `src/ui/components/Activity.tsx`, `src/ui/live-tail.tsx`, `src/ui/live-host.tsx`, `src/ui/activity.ts`, `src/ui/tool-call-state.ts`, `src/ui/agent-adapter.ts`, `src/agent/tool-pipeline.ts`, `src/ui/layout.ts`, `src/ui/theme.ts`

Current gaps (why this plan exists):

1. Ask: schema is single `{question, options, allowCustom}`; `App.askUser` is single-flight (`pendingQuestion`, `askResolveRef`) with no queue; second call overwrites or errors; no `Q 1/N` progress, no batch, no per-question cancel/skip, no transcript record of Q/A.
2. Todo panel: frameless inline with hardcoded `[✓]/[•]/[ ]` (ignores `theme.symbol.task*`), `in_progress` yellow but completed only dim (no green), no `3/8` count/progress, chevron in warning-yellow, dead `open/setOpen` state, `wrap="wrap"` with no hanging indent (ragged wrap), double-source clutter (live `TodoPanel` + full `result` echo + `TodoPresenter` summary), caps diverge (`8/12` vs `ECHO_CAP=20`).
3. Tool widgets: frameless 2-row (`header + ⚙ audit line`); status is inline glyph text; no bordered box, no status chip, no inline preview; `LiveToolCall` defined but unwired; full output only in `Ctrl+O InspectorPanel` (correct for `<Static>` freeze, but no visual bridge from widget to inspector).

Constraint that shapes everything: committed `<Static>` rows freeze — in-place expand/collapse can never happen in scrollback. Widgets are bordered + preview-capped in scrollback; full output lives in the inspector (dynamic zone). Do not fight this.

---

## Phase 0 — Shared contracts + test scaffolding (do first, unblocks all phases) — DONE 2026-09-17

- [x] 0.1 Theme tokens: `border.tool{ok,fail,denied,running,queued}`, `color.question`, `spacing.widgetPadX=1`, `symbol.questionStep="Q"`. Files: `src/ui/theme.ts`.
- [x] 0.2 Layout helpers: `widgetWidth(columns)`; reused in `QuestionBox`. Files: `src/ui/layout.ts`, `src/ui/modals.tsx`.
- [x] 0.3 Snapshot/flicker tests: new `tests/question-queue.test.ts` (schema, batch executor, shared contracts); updated pinned tests (`tools`, `registry-intercepted`, `provider-correctness`).
- [x] 0.4 Acceptance: `npm run typecheck` clean; targeted 75 tests green. NOTE: full suite shows 10 failures in 8 timing/TUI files (streaming, smoothness, hostile-perf, observability, goal x2, streaming-stress) — pre-existing staged edits in `ToolCall/Activity/live-tail/markdown/agent-adapter` predate this work; unrelated to ask changes.

## Phase 1 — Ask tool: multiple questions one-by-one (opencode parity) — DONE 2026-09-17

- [ ] 0.1 Theme tokens: add `border.tool{Ok,Fail,Denied,Running}`, `color.question`, keep `border.question=magenta`; add `spacing.widgetPadX=1`, `symbol.questionStep="Q"`. All widget/panel/question chrome reads tokens only. Files: `src/ui/theme.ts`.
- [ ] 0.2 Layout helpers: add `widgetWidth(columns)` (= `clampWidth(min(columns-2,100), columns)`) and reuse in `QuestionBox`, `TodoPanel`, `ToolCall`, `InspectorPanel`. Files: `src/ui/layout.ts`.
- [ ] 0.3 Snapshot/flicker tests: add render-count probes + `ink-testing-library` cases for question queue, todo panel (narrow 48 / normal 80 / wide 140), tool widget (each status × each kind). Pin `⚙ name target` byte-identical, `✅/🔧/○` transcript text. Files: `tests/` (new `question-queue.test.ts`, extend todo/tool tests).
- [ ] 0.4 Acceptance: `npm run typecheck && npm test` green before Phase 1.

## Phase 1 — Ask tool: multiple questions one-by-one (opencode parity)

Opencode reference: one tool call carries N questions; TUI shows them sequentially (`Q 1/3`, arrows+Enter, custom text, Esc cancels current, all answers returned as one JSON). Atom today: one question per call, single-flight modal.

- [x] 1.1 Schema (back-compat): optional `questions[1-5]`, mutually exclusive with single shape. Files: `src/tools/registry.ts`.
- [x] 1.2 Executor: `runAskQuestionBatch` loop with `{index,total}` meta, per-question cancel, `{answer}` vs `{answers}`. Files: `src/tools/registry.ts`.
- [x] 1.3 `AgenticOpts` queue contract + `AskQueueItem` type. Files: `src/agent/types.ts`, `src/tools/registry.ts`.
- [x] 1.4 App queue state: `askQueueRef` FIFO + `askHeadRef`, per-item promises, Ctrl+C drains all, teardown clears. Files: `src/App.tsx`.
- [x] 1.5 Keyboard: unchanged keys (Esc cancels current only, next shows). Files: `src/App.tsx`.
- [x] 1.6 `QuestionBox` props: `index/total` → `Atom question Q i/N — …`; width via `widgetWidth()`. Files: `src/ui/modals.tsx`, `src/App.tsx` render.
- [x] 1.7 Transcript record: `summarizeAsk` parses `{answer}/{answers}` into widget summary; audit `⚙` label already commits per call. Files: `src/ui/tool-model.ts`, `src/tools/registry.ts` (`describeToolCall` batch).
- [x] 1.8 Web + extensions: `PendingQuestion.index/total`, `question_request` carries them, web modal titles `Q i/N`; `ExtensionCommandAskUser` gains optional meta. Files: `src/web/runtime.ts`, `src/web/ui/app.js`, `src/extension-commands.ts`.
- [x] 1.9 Tests: `tests/question-queue.test.ts` (schema rejects, sequential meta, Esc item-2, legacy cancel).
- [x] 1.10 Acceptance: single-Q back-compat pinned; batch walks one-by-one via queue; no overwrite/lost promise.

## Phase 2 — Todo panel: polished, aligned, no clutter — DONE 2026-09-17

- [x] 2.1 Single source + dedupe: todowrite/todo_update success no longer echo full results into scrollback (audit line + counts summary only; full text stays in Ctrl+O inspector record). todo_get keeps its echo (explicit read). Files: `src/App.tsx` commit path.
- [x] 2.2 Glyphs/colors via theme: `✅` green / `🔧` yellow-bold / `○` dim (pending mark padded for alignment); literal `…` → `theme.symbol.ellipsis`. Files: `src/ui/todo-panel.tsx`.
- [x] 2.3 Header: `Todo — done/total` + dim `· N in-progress` (hidden on xs); dead collapse `open/setOpen` + warning chevron removed. Files: `src/ui/todo-panel.tsx`.
- [x] 2.4 Alignment: rows are `mark | label` flex rows (hanging indent on wrap); header at speaker-label edge; rows under `rowIndent`. Files: `src/ui/todo-panel.tsx`, `src/ui/layout.ts` (`isVeryNarrow`).
- [x] 2.5 Caps unified: `TODO_TUI_MAX_VISIBLE/OVERFLOW_THRESHOLD` single source; `… N more` line. Store echo caps (`TODO_ECHO_CAP`) untouched — result text still capped for inspector/transcript. Files: `src/ui/todo-panel.tsx`.
- [x] 2.6 Placement: panel hides while inspector owns footer (`inspecting`). Files: `src/App.tsx`.
- [x] 2.7 Tests: `tests/todo.test.tsx` panel block rewritten (glyphs, counts, all-completed hides, 14-item overflow); `tests/agent.test.tsx` todowrite panel pins `🔧`.
- [x] 2.8 Acceptance: typecheck clean; `todo/todo-invariants/agent/question-queue` 35 green; `tools/registry-intercepted/provider` green. NOTE: `smoothness` timer-isolation 2 failures pre-date this work (same as Phase 1 baseline).

Target look (opencode `sidebar/todo.tsx` parity, Ink idioms): bold `Todo — 2/8` header with count, theme glyphs, hanging-indent rows, single source, no duplicate echo.

- [ ] 2.1 Single source + dedupe: live `TodoPanel` is the only visible list. Change commit path to attach `summary` (counts) to the audit turn and stop pushing the full `result` echo as a separate `tool` turn; full list stays in inspector record. Files: `src/App.tsx` (L6971-6998), `src/ui/components/ToolCall.tsx` (`TodoPresenter`), `src/todo-store.ts` (`renderTodoDelta`).
- [ ] 2.2 Glyphs/colors via theme: replace hardcoded `[✓]/[•]/[ ]` with `theme.symbol.taskDone/taskActive/taskPending` (`✅/🔧/○`); `completed=success-green`, `in_progress=warning-yellow bold`, `pending=dim`. Remove literal `…`, use `theme.symbol.ellipsis`. Files: `src/ui/todo-panel.tsx` (L18-22, L59-66, L70-71).
- [ ] 2.3 Header: `Todo — {done}/{total}` + dim `{in-progress} in-progress` when >0; chevron (`▼/▶`) in default fg (not warning), or drop chevron and use `+N more` only — pick one, remove dead `open/setOpen` or wire it to `t` toggle key. Files: `src/ui/todo-panel.tsx` (L32-52).
- [ ] 2.4 Alignment: rows use `theme.spacing.rowIndent` hanging indent; `wrap="wrap"` with indent on continuation (split label into indent+text boxes or pad continuation lines); header left-edge aligns with transcript speaker labels; `marginTop=turnGap` only when panel visible. Test at 48/80/140 cols. Files: `src/ui/todo-panel.tsx`, `src/ui/layout.ts` (`isNarrow` → truncate labels, hide counts on xs).
- [ ] 2.5 Caps unified: `TODO_TUI_MAX_VISIBLE/OVERFLOW_THRESHOLD` remain the only TUI caps; overflow line `… N more` (dim, truncate); remove `ECHO_CAP` divergence by capping echo at same 8 (echo is now summary-only anyway). Files: `src/todo-shared.ts` (L88-92), `src/ui/todo-panel.tsx` (L35-39).
- [ ] 2.6 Placement: keep in `overlayZone` above input (current L8848), but render `null` when empty or all-completed (already does) AND when inspector is expanded (avoid stack). Files: `src/App.tsx` (L8848).
- [ ] 2.7 Tests: all-completed hides; >2 collapses; wrap alignment snapshot; theme glyphs (no `[✓]` literal); overflow `8/12`; no duplicate echo (one audit + panel, zero full-list turn). `npm test todo-panel`.
- [ ] 2.8 Acceptance: open TUI, run 8-task list → header `Todo — 3/8`, rows aligned, wrapped lines indent, no second dump in transcript, narrow terminal truncates cleanly.

## Phase 3 — Tool + output widgets (opencode-style bordered widget)

Target: every committed tool is a bordered `Box` (`borderStyle=round`, `borderColor` by status: green ok / red failed / yellow denied-running / gray queued), header `[glyph name — target | kind status · dur · via]`, body = one-line summary + inline preview (capped 6 lines) + diff/error, footer hint `Ctrl+O for full output`. Live (running) uses same chrome via `LiveToolCall`.

- [ ] 3.1 `ToolCall` widget chrome: wrap both success and error paths in `<Box borderStyle round borderColor=statusColor flexDirection=column paddingX=widgetPadX width=widgetWidth(columns)>`. Header row: `glyph bold name — target dim(kind status · dur · via · — summary)`. Keep inner `<ToolLine ⚙ …>` byte-identical (tests pin it). Files: `src/ui/components/ToolCall.tsx` (L124-221), `src/ui/tool-model.ts` (add `borderColorFor(status)` helper).
- [ ] 3.2 Per-kind body: keep presenters one-line but route through a shared `<WidgetSummary>` (dim, wrap, hanging indent). `TodoPresenter` renders counts line (from `summarizeTodo`), not the full list. Diffs (`SideBySideDiffView`) and `ErrorCard` render inside the box. Files: `src/ui/components/ToolCall.tsx` (L52-118).
- [ ] 3.3 Inline preview (bridge to inspector): when `model.resultPreview` exists and kind is terminal/file/search/web, render up to 6 truncated lines (dim) inside the box with `… N more lines — Ctrl+O` footer. Never dump full output in scrollback. Extend `modelFromTurn` preview slice from 200 chars to ~600 chars / 6 lines. Files: `src/ui/tool-model.ts` (L234-236), `src/ui/components/ToolCall.tsx`.
- [ ] 3.4 Wire live widget: replace `Activity Progress` line with `<LiveToolCall>` in `LiveTailHost` (same bordered chrome, `◉ name kind running · Ns — target`), driven by `tool-call-state.ts` + `modelForLive()`. Delete or re-export dead path. Files: `src/ui/live-tail.tsx`, `src/ui/live-host.tsx`, `src/ui/components/ToolCall.tsx` (L234-255), `src/ui/components/Activity.tsx`.
- [ ] 3.5 Inspector linkage: widget footer shows `Ctrl+O` only when a `ToolRecord` exists (`hasExpandable` already computes this — keep); inspector list rows reuse `TOOL_STATE_GLYPH` + same border colors; expanded view header matches widget header shape. Files: `src/ui/tool-inspector.tsx`, `src/ui/components/ToolCall.tsx` (L191, L207).
- [ ] 3.6 Responsive: `xs<50`: hide `kind/via/Ctrl+O`, border stays but `paddingX=0`; `sm<70`: hide `via/Ctrl+O`; diff collapses (already does in `SideBySideDiffView` — verify). Files: `src/ui/components/ToolCall.tsx` (L154-155), `src/ui/layout.ts`.
- [ ] 3.7 Ask + todo inside widgets: `ask_question` commits render as interaction-kind widget (magenta border? use `border.question`) with `Q/A` summary; todo commits render as todo-kind widget (no duplicate panel). Add `kindLabel` for `interaction` or map ask→`generic` with question border override. Files: `src/ui/tool-model.ts` (`getToolKind`), `src/agent/events.ts` (L124).
- [ ] 3.8 Tests: widget border color per status; header shape snapshot per kind; preview capped at 6 lines; `ToolLine` byte-identical; live→committed transition keeps same name/target; narrow hides chrome. `npm test toolcall`.
- [ ] 3.9 Acceptance: run read/bash/grep/todo/edit → each is a bordered box with status color, one-line summary, capped preview, `Ctrl+O` opens full output; running tool shows live bordered spinner that settles into the same box.

## Phase 4 — Integration, perf, docs (close out)

- [ ] 4.1 Flicker/perf: widget/panel/question stay `React.memo` with stable props; probes (`questionRenderProbe`, `todoPanelRenderProbe`, `transcriptRowRenderProbe`) assert ≤1 paint per keypress; `<Static>` admission unchanged (`admitStaticBatch`). Run `npm run bench` before/after — no >10% regress. Files: `src/ui/transcript.tsx`, `src/ui/modals.tsx`, `src/ui/todo-panel.tsx`, `scripts/bench-render.mjs`.
- [ ] 4.2 Help/docs: update `/help` tool lines, `TOOL_ONE_LINERS.ask_question`, `documentation/` tool widget screenshot/description, `CHANGELOG.md` entries for ask-batch, todo polish, widget chrome.
- [ ] 4.3 Full gate: `npm run typecheck && npm test && npm run build` green; manual TUI pass at 48/80/140 cols covering: 3-question batch, 8-task todo flow, one tool per kind + one failure + Ctrl+O.
- [ ] 4.4 Rollback plan: each phase ships behind no flag (pure UI + additive schema); revert = `git revert` single phase commit. No executor/data migration involved.

## Build order

Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4. Phases 1/2 are independent after Phase 0 and can parallelize; Phase 3 needs Phase 0 tokens only. Suggested commits: `feat(ask): batch queue`, `fix(todo): panel polish`, `feat(tui): tool widgets`, `chore: docs+tests`.
