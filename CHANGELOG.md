# Changelog

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
