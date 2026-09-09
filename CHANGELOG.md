# Changelog

## Unreleased

(nothing yet)

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
