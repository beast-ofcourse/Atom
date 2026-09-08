# Development

Setup, scripts, structure, and verification for contributors. Commands below come from `package.json` scripts.

## Setup

```bash
npm install
npm start        # run the TUI from source (needs a TTY)
```

Build output goes to `dist/` (`atom` runs `dist/cli.js`). `dist/` is gitignored and shipped in the tarball.

## Scripts

```bash
npm start        # tsx src/cli.tsx
npm test         # vitest run (fully mocked, never hits live APIs)
npm run typecheck  # tsc --noEmit
npm run build    # tsc -p tsconfig.build.json (src -> dist)
```

Tests use `"test-key"` placeholders. Never paste a real key into fixtures, logs, or commits.

## Project structure

```text
.
├── src/
│   ├── cli.tsx    # entry: --help, always starts TUI (missing key guides to /provider)
│   ├── App.tsx    # Ink TUI: transcript, pickers (/model /provider /effort), modes, status line
│   ├── context-windows.ts # curated per-model context windows + `token: (P%) NK` format
│   ├── compact.ts # context compaction: load/trigger math, split, summary POST (tools off, 4096 cap)
│   ├── zen.ts     # provider dispatch: streaming SSE, retries, agentic loop (zen path unchanged)
│   ├── providers.ts # 7-provider registry (kind/endpoint/env/default + fallback models)
│   ├── auth.ts    # ~/.atom/auth.json store (env wins, 0600 POSIX)
│   ├── adapters.ts # anthropic/gemini translation + SSE + models-list parsing + key validation
│   └── tools.ts   # 13 local tool executors + function schemas
├── dist/          # `npm run build` output (`atom` runs dist/cli.js; gitignored, shipped in the tarball)
├── tests/         # fully mocked (never live APIs; keys use "test-key")
├── AGENTS.md      # the agent's own instructions (loaded at startup)
├── tsconfig.build.json # build-only config (src -> dist)
└── .env.example   # env template (never commit a real key)
```

Full source adds: `env-block.ts`, `permissions.ts`, `session.ts`, `skills.ts`, `snapshots.ts`, `system.ts`. Tests live in `tests/` (35 files at time of writing, including `app`, `agent`, `loop-core`, `permissions`, `skills`, `compact`, `session`, `adapters`, `providers`, `tools` suites).

## Verification standard

Done means tests and typecheck pass, or the blocker is named with evidence. Minimum for a change:

```bash
npm test
npm run typecheck
```

Add or update tests for behavior changes. A fix without a test that would have caught it is incomplete. Keep blast radius small: match existing patterns, remove dead code and debug leftovers, handle errors and edge cases explicitly.

## Agent workflow in this repo

The repo `AGENTS.md` defines the loop the agent follows: read before edit, 30 tool rounds per turn by default, todowrite list for 3 or more steps with exactly one `in_progress`, verify every change with the suite. Issues live as local markdown under `.scratch/` (see [Issue tracker](agents/issue-tracker.md)).
