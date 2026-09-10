# Changelog

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
