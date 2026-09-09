# Observability

Local-only agent telemetry plus a drill-down dashboard. No accounts, no remote servers, no uploads — traces stay on your machine under `~/.atom/telemetry/`.

## Quickstart

- Use the agent normally. Every completed, failed, or cancelled turn appends its trace to the current session file.
- `/telemetry` — one-line summary: this session plus stored totals (sessions, turns, model/tool calls, success rate, reported tokens, retries).
- `/dashboard` — writes `~/.atom/telemetry/dashboard.html` and prints the path. Open it in a browser.
- `atom --dashboard` — same page without starting the TUI (script it, e.g. after a run).
- `atom --serve [--port <n>]` — live webUI on loopback: the same dashboard re-rendered per request (auto-refreshes) plus a read-only JSON API. Ctrl+C stops. Nothing is written over HTTP.

## What is traced

One session file per App mount (`~/.atom/telemetry/sessions/<sessionId>.json`, `0600` POSIX, atomic temp-plus-rename writes on turn boundaries):

- **Session** — id, start/end timestamps, project, provider/model.
- **Turn** — one user message plus its full loop: input/reply previews, provider/model/effort/mode, outcome (`completed`, `blocked`, `unverified`, `budget-exceeded`, `failed`, `cancelled`), duration, accumulated token usage.
- **Iteration** — one loop tool-round step (displayed 1-based): its model call plus the tool calls that call requested, with a timeline bar.
- **Model call** — one chat POST: latency, finish reason (`final`, `tool_calls`, `error`), reasoning label when the response carried one, per-call token usage **only when the provider sent a `usage` payload**, and transport retries (attempt, delay, HTTP status).
- **Tool call** — one execution: tool name, measured dispatch→result duration, success/failure with kind (`unknown-tool`, `invalid-args`, `denied`, `tool-error`, `cancelled`, `transport-error`), scrubbed + truncated args/result previews with full sizes, parallel-batch position.
- **Session events** — `/clear`, `/new`, `/resume`, compactions, provider/model switches.
- **Subagents** — delegated workers. ATOM v1 runs a single-agent loop (depth 1), so this is normally empty and the dashboard says so; the schema is ready for a future delegate tool.

The dashboard adds aggregates (totals, per-tool tables, success rate, average latencies), SVG charts (tool calls by tool, tokens per session, outcomes, durations), text/provider/outcome filters, and per-turn timelines.

## WebUI (live local server)

`atom --serve` starts a read-only HTTP server (`node:http` builtin, no new dependencies) over the same store:

- `GET /` — the dashboard, re-rendered per request with a 5s auto-refresh pill, so new flushed turns appear without regenerating a file.
- `GET /api/health` — liveness plus session/turn counts.
- `GET /api/aggregates` — the same totals the page shows, as JSON.
- `GET /api/sessions` — per-session summaries; `GET /api/sessions/:id` — one full stored session (404 when unknown).

Rules that keep it safe and honest:

- **Loopback-only** (`127.0.0.1`). The server never binds a LAN interface unless explicitly asked, and the JSON API carries the same scrubbed previews as the page — never keys.
- **Read-only**: only GET is served (anything else is 405); no request body is read; nothing is ever written. Every request re-reads the store, so the view is always current.
- **Ephemeral port by default** (printed on start, e.g. `http://127.0.0.1:52314/`). Pin one with `atom --serve --port 3487` or `ATOM_TELEMETRY_PORT=3487` when bookmarkable matters; a taken port fails fast with a hint.
- Same n/a discipline as the static page — the JSON carries reported values plus `usageReported`-style flags, never zero-filled estimates.

## Honesty rules (read before quoting numbers)

- **n/a means not measured or not reported — never zero.** Hover any n/a for the exact reason.
- **Tokens are API-reported only.** A model call without a `usage` payload contributes nothing; sessions without payloads are excluded from token charts (not plotted as zero). The footer `token: n/a` and this page agree by construction.
- **Cost is always n/a.** No provider API reports cost, and there is deliberately no pricing table — tokens are never multiplied by invented prices.
- **Tools show no token counts.** Tools don't consume model tokens; usage lives on model calls and turn/session aggregates.
- **Tool duration spans dispatch→result**, including any approval-prompt wait in normal mode (yolo/plan-mode calls measure execution only). The dashboard footnotes this wherever durations appear.
- **Retries** are transport retries inside one model call (HTTP 429/5xx or network, up to 2) and attach to the call they precede.

## Privacy

- Previews are truncated (input/reply 500 chars, args/results 2000 chars) with full byte sizes shown, so truncation is never silent.
- Known provider secrets (live env values) are scrubbed to `[redacted]` before anything is stored. API keys are never stored. Full prompts, full file contents, and full tool results are never persisted.
- Telemetry files live outside the repo (`~/.atom/`, never committed). The dashboard is a static file with no external requests — it works over `file://` with the network off.
- Opt out entirely: `ATOM_TELEMETRY=0` (env wins) or `"telemetry": {"enabled": false}` in `atom.json`. When off, every recorder method is a no-op and nothing is written. Corrupt session files are counted and skipped, never crash the page.

## Performance

Recording is in-memory pushes plus `Date.now()` reads — no I/O in the turn hot path. The only disk write is one small atomic JSON file per turn boundary (typically a few KB; previews are capped). Retention prunes on flush (default: newest 200 sessions, 90 days).

## Files and code

- Recorder + store + aggregates: `src/telemetry.ts` (never throws; disabled mode is a no-op).
- Loop hooks: optional `telemetry` sink in `AgenticOpts` (`src/zen.ts`) — guarded, zero behavior change when absent.
- Dashboard renderer + writer: `src/telemetry-dashboard.ts` (pure builder; self-contained HTML, no dependencies).
- Wiring: `submit()` in `src/App.tsx` opens/closes turn traces; `/telemetry` and `/dashboard` commands; `--dashboard` / `--serve` CLI flags in `src/cli.tsx`.
- Live server: `src/telemetry-server.ts` (loopback-only, read-only GET, per-request store re-read; same builder + honesty rules as the static page).
- Tests: `tests/telemetry.test.ts` (recorder, store, aggregates, dashboard escaping, loop sink, config knob, TUI end-to-end) and `tests/telemetry-server.test.ts` (port parsing, routes, live re-read, close).
