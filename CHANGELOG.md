# Changelog

## 1.5.6 — 2026-09-18

### Goal tools (Codex parity)

- **Six-tool surface** (`src/tools/registry.ts`, `src/goal.ts`): `get_goal`
  reads state, `create_goal` sets it on explicit `/goal` intent only (never
  inferred; duplicates keep the first), `update_goal` stays the turn-report
  channel, `pause_goal` / `resume_goal` / `clear_goal` mirror the slash arms
  with identical state effects and transcript notices; advisory
  `token_budget` recorded and surfaced, never enforced
- **Per-POST gating** (`src/zen.ts`, `src/adapters.ts`, `src/agent/types.ts`):
  `get` + `update` ride live-goal turns, `create` rides `/goal` intent,
  lifecycle tools ride matching goal state; hidden tools cannot be misused
- **Loop + App wiring** (`src/agent/loop.ts`, `src/agent/tool-pipeline.ts`,
  `src/App.tsx`): model-initiated lifecycle delegates to session-owned
  hooks; slash arms and both hook sites share the `goal.ts` pure
  transitions via one builder; prompt, `/goal` help, and CLI help carry the
  contract

### Tool/startup performance

- **Single-handle reads** (`src/tools/filesystem.ts`): one open + fstat +
  positioned reads; incremental line windows; read cache 100 → 500
- **Search caches** (`src/tools/search.ts`, `src/tools/dir-cache.ts`):
  result cache keyed on mtime + mutation generation, inflight listing
  sharing, 4 KB binary probe, literal fast path, measured ripgrep threshold
  1000 → 1500
- **Shell + startup** (`src/tools/shell.ts`, `src/cli.tsx`,
  `src/extensions.ts`): read-only commands skip the listing clear, adaptive
  `bash_output` poll, batched background appends, zero-static-import CLI
  with lazy TUI branch, cached extension scope scans
- **Perf gates** (`scripts/perf-gate.mjs`, `scripts/bench-heap.mjs`,
  `scripts/perf-baseline.json`): render/loop/tools budgets plus heap-flatness
  bench and memory-ceiling pins

## Unreleased

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

## 1.5.5 — 2026-09-17

### Agent internals

- **Single todo store** (`src/todo-store.ts`): session checklist state,
  executors, CRUD, and persistence now live in one module;
  `src/tools/todo.ts` and `src/todos.ts` are re-export shims (old import
  paths keep working, behavior byte-identical); per-session isolation via
  `setActiveTodoSession`
- **Formatter normalization** (TUI, `zen.ts`, registry): biome autofix
  reflow, no semantic change

## 1.5.4 — 2026-09-16

### TUI polish (PTY observe-fix cycles)

- **Startup banner** (`src/ui/transcript.tsx`): gradient art + one-line
  `/help` / `Ctrl+P` hint row; assistant turns get a short `───` rule under
  the `ATOM>` label so long answers start at a predictable edge
- **Status bar width discipline** (`src/ui/status-bar.tsx`): the reasoning
  segment yields when the line would overflow (idle and busy), and a
  starvation floor under 50 columns renders `model │ mode` (+ `esc stops`
  while busy) instead of wrapping mid-token — verified live at 45–100 cols
- **Composer + code blocks** (`src/ui/input.tsx`, `src/ui/components/CodeBlock.tsx`,
  `ThinkingBlock.tsx`): focus/busy border accents, language headers with
  rules, accented thinking headers (pinned text byte-identical)
- **Footer storm fix** (`src/ui/status-bar.tsx`): the busy-line wrap used to
  split the `esc stops · Enter queues` hint, failing the footer-cluster storm
  test — now green with causal proof (revert-only-status-bar reproduces it)
- **TUI theme tokens** (`src/ui/theme.ts`): additive-only accents
  (`bannerA/B`, `composerFocus/Busy`, `quoteAccent`); every pinned value
  byte-identical, full re-skin still lives in this file alone

### Default model

- **Kilo free default** (`src/zen.ts`): `DEFAULT_MODEL` is now
  `kilo-auto/free` (was `deepseek-v4-pro`), matching `DEFAULT_PROVIDER`
  (kilo) — fresh installs work with no key; `OPENCODE_ZEN_MODEL` still wins
  when set; paid models stay one `/model` away

### TUI interaction harness

- **tmux PTY driver** (`scripts/tui-harness/`): scripted launch / keys /
  captures with isolated `ATOM_HOME`, deterministic replay, and six
  documented tmux-windows quirks — the full observe → fix → re-verify loop
  behind this release, reusable by the next agent

### Hygiene

- **SAFETY comments** (`src/zen.ts`, `src/tools/registry.ts`): every
  `as unknown as T` cast now states its invariant; dead imports pruned
  (no behavior change)

## 1.5.3 — 2026-09-14

### Compaction parity (issues 01–05)

- **Pre-guard** (`src/App.tsx`): before the first POST of each turn, the submit path estimates pending context size and runs `shouldPreCompactForPending` — when the estimate reaches the model's usable limit, compaction fires *before* the doomed request, avoiding the 413 → recovery → retry round-trip entirely
- **Config knobs wired** (`src/compact.ts`, `src/App.tsx`): `compactPreserveRecentTokens` (env `ATOM_COMPACT_PRESERVE_RECENT_TOKENS` / atom.json `compactPreserveRecentTokens`, clamped 2K–50K) overrides the tail token budget; `compactTailTurns` (env `ATOM_COMPACT_TAIL_TURNS` / atom.json `compactTailTurns`, integer ≥ 0) caps the number of user turns retained in the tail — both knobs parsed/tested previously but consumed nowhere, now threaded into `splitHistoryForCompaction` and `doCompact`
- **Prune gate** (`src/compact.ts`): `compactPruneEnabled()` (env `ATOM_COMPACT_PRUNE` / atom.json `compactPrune`, default off) now gates the `pruneOldToolOutputs` call in `requestCompactSummary` — when off, large tool outputs pass through unpruned; when on, they collapse to `[truncated: old tool output cleared]` before the summarization POST
- **`/context` effective settings** (`src/App.tsx`): `buildContextText` now shows a `compaction:` line with auto on/off, tail budget, tail turns cap, and prune flag so the user can verify the active knobs at a glance
- **Overflow recovery documented** (`documentation/compaction.md`): pre-guard, overflow recovery (HTTP 413 → compact → continue), and retained-tail marker (`retained-tail N messages`) are now documented alongside the existing manual/auto compact mechanics

### Bash timeout

- **Uncapped AI-decided timeout** (`src/agent/tool-pipeline.ts`): removed the artificial 120 s ceiling in `resolveToolTimeoutMs` — the AI now decides per-call with only a 1 s floor (sub-second timeouts are never useful). The tool schema already advertised "uncapped"; the implementation now matches

### Status bar

- **Model name visible during busy state** (`src/ui/status-bar.tsx`): the busy layout now shows `provider/model` after the activity text instead of dropping it — the user needs to know which model is working mid-turn. Layout: `⚙ activity │ provider/model │ Ns │ token │ reasoning │ mode │ esc stops`

### Thinking / draft rendering

- **Inter-round gap guard** (`src/App.tsx`): `commitThinking()` now resets `hasHadOutput` so the thinking-gap spinner shows during the transition between rounds instead of the live zone going blank
- **Error/cancel draft cleanup** (`src/App.tsx`): both the error and cancel paths now `flushDraft()` + `streamStore.setDraft(null)` immediately after committing/clearing the partial, preventing stale draft from duplicating with the committed partial in the transcript
- **Thinking quote-bar alignment** (`src/ui/components/ThinkingBlock.tsx`): added `wrapWithPrefix` that pre-wraps each line at the terminal width (word-boundary aware) and prefixes every segment with `│` — Ink's native `wrap="wrap"` lost the prefix on continuation lines, creating visible misalignment. The `columns` prop flows `App → LiveTailHost → LiveTail → ThinkingBlock`

### Usage ledger

- **`/usage` command** (`src/usage-ledger.ts`, `src/ui/usage-ledger.tsx`): per-POST usage rows for the session (turn steps + compaction POSTs), in-memory only (prompts may carry pasted secrets). Opens a scrollable panel with ↑/↓/PgUp/PgDn navigation; rows carry session id so switches/forks isolate correctly

### Sessions

- **Early session ensure** (`src/App.tsx`): `ensureStoreSession()` is now called at the start of `submit()` (both core and legacy paths), right after the user message is pushed to history — the session record exists on disk *before* the turn runs, so a Ctrl+C or crash still leaves a pickable session in `/session`

### Docs

- `documentation/compaction.md`: pre-guard, overflow recovery, config knobs table, retained-tail marker
- `documentation/configuration.md`: three new env vars (`ATOM_COMPACT_PRESERVE_RECENT_TOKENS`, `ATOM_COMPACT_TAIL_TURNS`, `ATOM_COMPACT_PRUNE`, `ATOM_COMPACT_AUTO`) and three new atom.json keys (`compactTailTurns`, `compactPreserveRecentTokens`, `compactPrune`)
- `documentation/cli.md`: `/usage` command added to the slash registry

---

## 1.5.2 — 2026-09-13

- MCP Servers (`src/mcp/*`, `src/cli.tsx`, `src/App.tsx`, `src/config.ts`, `documentation/mcp.md`): full Model Context Protocol surface — local stdio and remote HTTP transports, discovery via `atom.json` `mcp` map (project + global per-key merge), concurrent connect with `tools/list` catalog (`<server>_<tool>` sanitized names, first-wins collisions surfaced in `/context` as `mcp warnings:`), `notifications/tools/list_changed` live re-list and exited-process eviction, synthetic cross-server resource/prompt tools (`list_mcp_resources`, `read_mcp_resource`, `list_mcp_prompts`, `get_mcp_prompt`), OAuth browser flow with discovery/registration/PKCE and `~/.atom/mcp-auth.json` persistence (`atom --mcp-auth` / `--mcp-logout` / `--mcp-list`), inline arg validation and never-throw `execute`, 64KB truncation + overflow spills, `/mcp` popup (`Space` toggle persists to `atom.json` without leaking secrets, `Esc` closes). CLI `atom --mcp-list` / `--mcp-auth <server>` / `--mcp-logout <server>` are TUI-free. Suites in `tests/mcp.test.ts`
- New providers (`src/providers.ts`, `src/auth.ts`, `src/adapters.ts`, `documentation/providers.md`, `documentation/configuration.md`, `.env.example`, `README.md`): Groq (`GROQ_API_KEY`), xAI (`XAI_API_KEY`), Z.ai (`ZAI_API_KEY`), OpenRouter (`OPENROUTER_API_KEY`), Cerebras (`CEREBRAS_API_KEY`) — all OpenAI-compatible `chat/completions` with `reasoning_effort` mapping (`Auto` omits it), per-provider endpoints, fallback models (e.g. `llama-3.3-70b-versatile`, `grok-4.6`, `glm-5.3`, `anthropic/claude-sonnet-4.6`, `gpt-oss-120b`), idle-key masking and `ATOM_HOME`-aware persistence; total 13 remotes + 3 local runtimes
- `/reload` hardens to every source (`src/App.tsx`, `src/extensions.ts`, `src/instructions.ts`, `src/cli.tsx`, `tests/reload-*.test.tsx`): extensions observe an orderly `session_shutdown` → `unload` → `loadExtensions` → `session_start` cutover around `reason: reload` (pre-reload handles go stale with a loud error, disabled/lockdown/trust filters are reused with no re-prompt, one broken extension is an inline warning, total failure keeps the previous runtime live), MCP servers reconnect (unreachable becomes a warning), edited `AGENTS.md` overlays apply to subsequent turns (history untouched apart from the pinned system line with a fresh env block), and the summary line now covers all sources (`config: …; skills: …; extensions: …; mcp: …; instructions: … — conversation kept.`). Help (`/help` and `atom --help`) documents preserves and sources
- Unified stop-policy and core decomposition (`src/agent/gates.ts`, `src/agent/loop.ts`, `src/tools/registry.ts`, `src/permissions.ts`, `src/tools/provider-hooks.ts`, `src/diff-engine.ts`, `src/instructions.ts`): single ownership for completion policy, shared agent loop core and instruction-discovery pipeline extracted with parity suites (`tests/stop-policy.test.ts`, `tests/instructions.test.ts`, `tests/turn-seam.test.ts`)
- TUI and theme polish (`src/ui/*`, `src/App.tsx`, `src/web/runtime.ts`, tests): memoized status/input/palette derivations with throttle, live-tail and transcript rendering refinements, provider/model footer clustering, and docs coverage for `--mcp-*` and `mcp` config in `documentation/cli.md` + `configuration.md` + `index.md` + `troubleshooting.md`

## 1.5.1 — 2026-09-12

- OpenCode Zen free tiers all usable (`src/adapters.ts`, `src/zen.ts`,
  `src/providers.ts`): every request now carries the official-client
  identity (`User-Agent: opencode/*` plus `x-opencode-session` /
  `x-opencode-request`), clearing the upstream `429 FreeUsageLimitError`
  and `400 MissingSessionID` gates for anonymous and keyed calls alike.
  Suites in `tests/zen-headers.test.ts`
- New Responses-family transport (`src/adapters.ts`,
  `src/zen.ts`): `muse-spark-1.2` / `muse-spark-1.3` (including the free
  contributor tiers) ride Zen's `/responses` endpoint with full
  retry/hook/compaction/media parity — tool calls, streaming tokens,
  reasoning-effort mapping, and `incomplete` → `truncated` handling.
  Routing is automatic by model family; every other provider is
  byte-identical. Suites in `tests/zen-responses.test.ts`
- Picker lists all eight free Zen models (`FALLBACK_MODELS` in
  `src/zen.ts`, `fallbackModels` in `src/providers.ts`): `big-pickle`,
  `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`,
  `nemotron-3.5-lightning-free`, `deepseek-v4-flash-free`,
  `muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free`
- Loop/telemetry phase timing (`src/agent/loop.ts`,
  `src/agent/types.ts`, `src/telemetry.ts`): per-turn model vs tool
  totals, slowest model call, and truncation notices surfaced through
  `LoopStats`; telemetry schema v2 with v1 back-compat, failed-turn
  partial replies preserved for post-mortem. Accuracy fixes: each failed
  POST and each truncation counts exactly once; timeline events fire for
  failed turns only
- Housekeeping: downloaded third-party skills (`.agents/skills/`,
  `skills-lock.json`) are now gitignored

## 1.5.0 — 2026-09-12

- Local agentic Web UI (`src/web/server.ts`, `src/web/runtime.ts`,
  `src/web/events.ts`, `src/web/ui/`): `atom --web [--port <n>]` serves a
  loopback-only agentic frontend over the same runtime as the TUI, with a
  read-only JSON API (`/api/health`, `/api/providers`, `/api/sessions`).
  The web runtime shares the pure diff engine (`src/ui/diff.ts`) with the
  TUI so both surfaces compute identical hunks/rows; suites in
  `tests/web-server.test.ts`, `tests/web-runtime.test.ts`,
  `tests/web-events.test.ts`, `tests/web-slash.test.ts`. The build copies
  the client assets into `dist/web/ui/` (`scripts/copy-web-ui.mjs`, wired
  into `npm run build`), so the published tarball serves them with no
  extra step
- Shared loop core (`src/agent/tool-pipeline.ts`,
  `src/agent/turn-events.ts`): tool dispatch and turn-event fan-out
  extracted from the loop with parity coverage
  (`tests/tool-pipeline.test.ts`, `tests/parallel-pipeline-parity.test.ts`,
  `tests/loop-turn-events.test.ts`, `tests/turn-events-consume.test.ts`)
- New focused modules with suites: media/vision accounting (`src/media.ts`),
  overflow spills (`src/overflow.ts`), session revert (`src/session-revert.ts`),
  file diffs (`src/file-diffs.ts`), session todos (`src/todos.ts`), and the
  paint scheduler (`src/ui/paint-scheduler.ts`)
- Docs audit: fixed `documentation/` agent links, documented `--web` and the
  extension flags in `cli.md`, corrected the `maxToolSteps` default
  (uncapped; the shipped example sets `30`), added `compactAuto` /
  `compactReserve` keys, corrected `update_goal` payload visibility, and
  refreshed the project layout in `README.md` / `development.md`
- Current-behavior suites pinning post-1.4.0 contracts
  (`tests/diff-panes-current.test.tsx`,
  `tests/ui-boundary-current.test.ts`,
  `tests/turn-diff-current.test.tsx`, `tests/turn-error-current.test.tsx`,
  `tests/session-new-current.test.tsx`,
  `tests/session-switch-todo-current.test.tsx`). Known stale: pre-web
  assertions in `tests/architecture.test.ts` (blanket `ui/*` ban),
  `tests/hostile-perf.test.tsx`, `tests/turn-events-consume.test.tsx`
  (`BEFORE`/`AFTER` labels), `tests/session.test.tsx` (retired system
  wording), `tests/session-lifecycle.test.tsx` (retired notice text), and
  `tests/turn-failure.test.tsx` (retired marker) — slated for retirement
  in a follow-up; the new suites are the current contracts

## 1.4.0 — 2026-09-11

- Uncapped TUI diffs (`src/ui/diff.ts`, `src/ui/side-by-side.tsx`,
  `src/ui/diff-view.tsx`, `src/ui/transcript.tsx`, `src/ui/modals.tsx`,
  `src/ui/diff-panel.tsx`): the diff engine no longer truncates at 400
  changed lines — `computeDiff` and `computeSideBySide` return the full
  hunk/row list with `truncated: false`, and the transcript, approval
  preview, and `/diff` panel render it whole (no more `… N more rows` or
  `(diff truncated at 400 changed lines)` trailers). A 500-line write now
  shows its complete before/after instead of a capped head. Smoothness is
  preserved by the existing per-mount memoization (`SideBySideInner`,
  `DiffViewInner`, `LineBody`, `TranscriptRow`), append-once `<Static>`
  commits, and the engine's linear-time fallbacks (Myers prefix/suffix past
  1000 lines, flat word runs past 200 tokens/line). Safety caps stay
  enforced: binary detect and the 1MB file skip. `MAX_CHANGED_LINES`,
  `TRANSCRIPT_DIFF_MAX_LINES`, `APPROVAL_DIFF_MAX_LINES`, and
  `DIFF_PANEL_MAX_LINES` are retained as compatibility exports (the row
  caps now read `Infinity`); `maxRows`/`maxLines` remain as opt-in windows
  for callers that want a collapsed tail. Known tradeoff: large approvals
  grow the permission modal, pushing the `y/a/t/n` options further down —
  the file on disk was and remains the whole truth

## 1.3.0 — 2026-09-11

- Session goals (`src/goal.ts`, `src/App.tsx`, `src/agent/loop.ts`,
  `src/agent/goal-evaluator.ts`): `/goal <objective>` pins one session
  objective that runs turn-to-turn with no turn cap until paused, cleared,
  or a `complete`/`blocked` verdict. Bare `/goal` shows text, state, and
  cumulative stats (turns · requests · tokens · work); `pause` halts with
  everything kept; `resume` re-arms (idle starts a continuation turn, busy
  resumes at turn end); `clear` ends it. Cancel and spent step/tool-call
  budgets pause, never clear; `/clear` and `/new` end the goal. The model
  reports each turn via the goal-scoped `update_goal` tool
  (`continue`/`complete`/`blocked`); report-less turns get one bounded
  judge call when configured, else continue; unclear/failed judges pause
  with the goal preserved. Three repeated tool results redirect with a
  replan nudge (goal stays active). `complete` with unverified code or open
  todos continues instead of stopping; `blocked` stops unconditionally
  (declared-unverifiable checks print in the verdict, never gate). The live
  goal rides every session save with stats intact (restore on `/resume` and
  session switches; corrupt data loads as no goal); compaction appends a
  `Goal:` line (text, state, stats, open todos) to the summary
- Goal surface: status line shows `goal: <objective> [active|paused]`
  (lowest-priority segment, hidden with no goal; `src/ui/status-bar.tsx`,
  wired in `src/App.tsx`); turn telemetry traces carry the goal snapshot
  with dashboard fragments and a Goal-turns card rendered only when goal
  turns exist (`src/telemetry.ts`, `src/telemetry-dashboard.ts`); `/help`
  lists `/goal` with subcommand descriptions; user docs in
  `documentation/goals.md` (linked from `cli.md`, `index.md`,
  `observability.md`), glossary entries in `CONTEXT.md`. Known limits: the
  `update_goal` schema is not in the chat-payload tools list (the model
  discovers it via continuation prose); multi-turn behavior against live
  models is unproven (mocked suites only)

- History caps removed (Pi parity): the 100-message / 200K-char ceilings are
  gone — no `MAX_HISTORY_*` constants, no `ATOM_MAX_HISTORY_*` env vars, no
  `maxHistory*` config keys (present keys are ignored as unknown), no trim
  step in the loop, submit, resume, or session-switch paths. Full history
  rides every POST; auto-compact at ~83% of the verified window plus manual
  `/compact` is the only pressure valve. `LoopStats.truncationNotices` and
  the 4-stage submit pipeline's budget-check stage are removed with them
- Real context accounting (`src/adapters.ts`): Anthropic `input_tokens`
  excludes `cache_read`/`cache_creation`, which previously made P%, NK, and
  the 83% auto-compact trigger blind to cached context. Exclusive cache
  counters are now folded into `prompt_tokens` at parse time (detail fields
  stay provider-faithful), so load, spend, and compaction all see true
  input-side tokens. OpenAI/Gemini paths already include cache — untouched,
  with a regression test pinning no double-counting
- Compaction retention raised (`src/compact.ts`): verbatim newest tail
  8000 → 20000 estimated tokens (Pi parity); summary template restructured
  to Objective / Important Details / Work State (Completed, Active,
  Blocked) / Next Move / Relevant Files
- Parallel-by-default reads (`src/scheduler.ts`): the conservative
  same-tool+same-target overlap rule is gone — pure reads batch
  unconditionally (same file, same task polls included). Same-file
  read/write order, `bash` isolation, todo exclusivity, prompts, and
  ordered commits are unchanged
- Extension host (`src/extensions.ts`, `src/extension-commands.ts`,
  `src/extension-ui.ts`, `src/project-trust.ts`, `src/tools/custom.ts`,
  `src/tools/intercept.ts`, `src/tools/overrides.ts`,
  `src/tools/provider-hooks.ts`, `src/tools/compaction-hooks.ts`):
  project plus global extension scopes with trust-gated project execution,
  enable/disable patterns, `--no-extensions` lockdown, model-callable custom
  tools, pre/post tool interception, audited builtin overrides, slash
  commands, session lifecycle events, provider request/response hooks,
  compaction hooks, and status/widget/dialog UI. Guide plus three working
  samples in `documentation/extensions.md` and `examples/extensions/`.
  Known limits: non-UI registrations are runtime-global (no per-extension
  unload); `session_start` covers startup/resume/switch/new; `overflow`
  compaction reason is reserved for future callers; staged notices cap at
  100 drop-oldest
- `/effort` now applies on every provider (reasoning effort for
  OpenAI-chat kinds, thinking budgets for Anthropic, thinking levels for
  Gemini; `Auto` omits the knob) — previously zen-only
- `reasoningEffort: default` renamed to `auto` (`default` still accepted as
  an alias); `atom.example.json` gains an `extensions` example

## 1.2.0 — 2026-09-10

- Durable multi-session store (`src/sessions.ts`): one JSON record per
  session under `~/.atom/sessions/<id>.json` plus a plaintext `active`
  pointer. Records carry stable `ses_` ids (never derived from the display
  name), mutable titles defaulting to the exact local creation date and
  time, separate machine-readable `createdAt`, `updatedAt` on every
  meaningful mutation, `cwd`, provider/model/effort/mode, usage, full
  history/turns, and metadata. Atomic temp-plus-rename writes (`0600`
  POSIX), loads that never throw, most-recent-first listings, no transient
  UI state, no LLM provider coupling
- `/rename <name>` (current session only; quotes optional; bare prints
  usage): id, `createdAt`, and history untouched, persisted immediately,
  failures keep the previous name
- `/session [filter]` interactive switcher: most-recent-first picker with
  in-memory fuzzy filter (title first, id fallback), turn counts, relative
  ages, `(current)` marker, windowing for large lists. Selecting replaces
  the live conversation wholesale (no merge, no duplication) with
  provider/model/settings restored; the outgoing turns snapshot first,
  checkpoints and the TODO checklist reset like `/new`, and a missing
  target errors without touching the live session. `Esc` cancels cleanly
- Runtime integration (`src/App.tsx`): every conversation auto-belongs to
  the active session; completed turns, exits, and compactions mirror into
  the record; `/new` snapshots then swaps records; the legacy
  `session.json` save follows switches so `/resume` stays coherent.
  Session identity surfaces in the picker, confirmations, and the
  empty-state line (the status bar keeps its fixed width budget)
- Suite: `session-store` (26), `sessions-runtime` (5), `rename` (8),
  `session-picker` (11), `session-lifecycle` (4) — see
  `documentation/sessions.md`

## 1.1.0 — 2026-09-10

- Agentic loop hardening (`src/agent/loop.ts`, `types.ts`, `loop-guard.ts`,
  `normalize.ts`; `src/zen.ts`, `adapters.ts`): tool-result and
  model-response normalization, per-tool execution timeouts, total tool-call
  budget per turn, error-streak recovery (holds final text for a fix-forward
  attempt instead of ending on unaddressed failures), opt-in repetition guard
  with background-poll exclusions, and a per-turn `LoopStats` rollup
  (iterations, calls, failures, cache hits, guard hits, bottleneck, context
  growth) reported via `AgenticOpts.onLoopStats`, even on failed turns.
  SSE stall guard (`ATOM_STALL_TIMEOUT_MS`, default 60s) in every streaming
  reader: a silent 200-OK stream fails fast on the permanent Truncated
  contract instead of hanging the turn
- LoopStats into observability (`src/telemetry.ts`,
  `telemetry-dashboard.ts`, `src/App.tsx`): `recordLoopStats` attaches the
  harness rollup to the open turn trace, aggregates total cache/guard hits,
  dashboard renders per-turn loop fragments plus overview cards
- Search speed (`src/tools/search.ts`, `dir-cache.ts`, `read-cache.ts`,
  `filesystem.ts`, `shell.ts`): `git ls-files` enumeration (tracked plus
  untracked-non-ignored, `node_modules`/`.git` still excluded), single-pass
  grep (half the file reads), 32-wide bounded-parallel scan with identical
  output order, mtime-checked listing cache with exact invalidation on
  write/edit/bash (`ATOM_FAST_LIST=0` forces the legacy walker), and a
  stat-validated read cache. Measured 3–7x on content search; batching nudge
  added to the system prompt
- TUI flow (`src/App.tsx`, `ui/transcript.tsx`, `live-tail.tsx`,
  `status-bar.tsx`, `todo-panel.tsx`, `modals.tsx`, `palette.tsx`):
  `/autoscroll on|off` (freezes a following view mid-turn instead of yanking
  it), `/thinking` toggle with per-round model reasoning persisted to the
  transcript (rendering-only; never model history), memoized status bar,
  todo panel, approval/question modals, and palette plus memoized
  palette/checkpoint derivations (timer-tick and picker-nav flicker fix)

## 1.0.0 — 2026-09-09

- Kilo Gateway is the default provider (`src/kilo.ts` + registry entry in
  `src/providers.ts`): OpenAI-compatible `POST /chat/completions` on the
  shared streaming/tool-call path, live `GET /models` catalog (5-minute
  TTL, `/models refresh` while Kilo is active), `:free` detection with
  `(free)` picker badges, anonymous free-model use (no auth header sent),
  optional `KILO_API_KEY` via `/provider`, short actionable errors
  (`Kilo: anonymous free-model rate limit reached.`, `Kilo: API key is
  invalid.`, `Kilo: model is unavailable.`, `Kilo: gateway temporarily
  unavailable.`). Fresh installs start on `kilo-auto/free` with no key;
  saved Kilo sessions restore keyless. All other providers unchanged
  (existing zen-path suites pinned via `initialProvider="opencode-zen"`)
- Observability: local per-turn telemetry (iterations, model calls with
  API-reported tokens only, per-tool durations and ok/fail, retries,
  outcomes) under `~/.atom/telemetry/` plus a self-contained drill-down
  dashboard (`/dashboard`, `atom --dashboard`) and `/telemetry` summary.
  Local-only, truncated + secret-scrubbed, off via `ATOM_TELEMETRY=0` or
  `telemetry.enabled=false`. Unavailable values render as n/a (never
  estimated); cost stays n/a until a provider reports it
- Observability webUI: `atom --serve [--port <n>]` serves the live dashboard
  (auto-refreshing) plus a read-only JSON API (`/api/health`,
  `/api/aggregates`, `/api/sessions`) on loopback only. No new dependencies;
  the static `--dashboard` file output is unchanged
- Security hardening: explicit Policy layer (`src/policy.ts` — approval
  order, skill-grant trust, network zones, secret scrubbing); project-local
  skills never silently arm shell/filesystem grants; webfetch SSRF gate
  (configurable `atom.json` network zones, per-hop redirect checks);
  shell-output secret redaction; symlink targets in activity lines
- Rollback semantics: explicit conversation (automatic) vs filesystem
  (explicit `/rewind` only) vs process (never) contract (`src/rollback.ts`);
  cancel line states no-revert truth; checkpoints drop on history lineage
  resets; hash pre-verified restores; stale snapshot-temp pruning
- Scheduler: effect metadata per tool (`src/scheduler.ts`) driving parallel
  read batches; writes/spawns stay serial, order/cancel/approval preserved
- Prompt cleanup: tool descriptions trimmed of runtime-guaranteed prose
  (~17% smaller system prompt); harness contract in one system line
- Code organization: `agent/` (loop, gates, types), `tools/` (9 modules),
  `ui/` (transcript, input, todo-panel) extracted with compat re-exports;
  boundary rules enforced by `tests/architecture.test.ts`
- TUI scrolling: PgUp/Home hold the view mid-turn (frozen window plus a
  static live-tail line, so streaming stops yanking the terminal);
  End/PgDn re-follows; `/clear`, `/resume`, `/new`, rewind-truncate reset
- Modes: `/plan` and `/yolo` retired — Tab is the only switcher
  (normal → yolo → plan → normal); busy status line keeps the mode segment
- Input cursor renders in inverse video (no letter shifting); pending
  todos use ○ (never ❌); observability dashboard redesigned (hero, sticky
  section nav, refined dark system, responsive)

## 0.3.0 — 2026-09-08

- Agentic loop: 30-step budget (`ATOM_MAX_TOOL_STEPS`), todo-completion
  guard, verification gate, goal pinning against truncation
- Permissions: normal/yolo modes, session trust (`/trust`), scoped
  allow/deny rules (`/allow`, `/deny`, `/rules`), read-only plan mode
  (`/plan`)
- Safety: automatic file snapshots with `/rewind` (files / conversation /
  both), stale-read guard on edits
- Context: history budgets, auto/manual compaction, per-turn environment
  block, session save/resume
- Providers: 7 adapters (opencode-zen, openai, anthropic, deepseek, mistral,
  google-gemini, openai-compatible); default model `deepseek-v4-pro`
- Tools: 13 local executors incl. background bash, web search/fetch,
  session todo list with live TUI panel
- Docs: full user manual in `documentation/`, minimal `AGENTS.md`
  project instructions

## 0.2.0

- Agentic harness parity: tools, todos, Esc-stop, thinking UI, packaging

## 0.1.0

- Early experiment: agentic TUI chatbot on OpenCode Zen
