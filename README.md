# ⚛ Atom — a minimal AI coding agent for your terminal

[![npm version](https://img.shields.io/npm/v/atom-agent.svg)](https://www.npmjs.com/package/atom-agent)
[![license](https://img.shields.io/npm/l/atom-agent.svg)](LICENSE)

```
 █████╗ ████████╗ ██████╗ ███╗   ███╗
██╔══██╗╚══██╔══╝██╔═══██╗████╗ ████║
███████║   ██║   ██║   ██║██╔████╔██║
██╔══██║   ██║   ██║   ██║██║╚██╔╝██║
██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║
╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝
```

Atom is a small, fast, **agentic** terminal chatbot: it doesn't just answer —
it runs an **observe → act → inspect → adjust** loop with **13 real,
locally-executed tools** (files, shell, web), streaming output, and an
interactive Ink TUI. Powered by [OpenCode Zen](https://opencode.ai/docs/zen)
as the model provider. Zero ceremony: one key, one command, you're chatting
with an agent that can read your code, edit it, run it, and search the web.

## Documentation

Full docs live in [`documentation/`](documentation/index.md), same layout as opencode and claude code guides. Start here, then go deep:

- [Getting Started](documentation/getting-started.md) — install, key setup, first run
- [CLI and TUI](documentation/cli.md) — slash commands, keyboard, status line
- [Tools](documentation/tools.md) — the 13 local executors, caps, background tasks
- [Providers and Models](documentation/providers.md) — 7 providers, endpoints, key resolution
- [Permissions and Modes](documentation/permissions.md) — normal/yolo, trust, allow/deny rules
- [Skills](documentation/skills.md) — discovery, frontmatter contract, auto-invoke
- [Sessions](documentation/sessions.md) — persistence, resume, clear, rewind
- [Compaction and Token Display](documentation/compaction.md) — auto-compact, manual compact, footer format
- [Configuration](documentation/configuration.md) — env vars, auth file, AGENTS.md layering
- [Development](documentation/development.md) — scripts, structure, tests, build
- [Troubleshooting](documentation/troubleshooting.md) — auth, models, approvals, TUI fixes

## Quickstart

Install the published-style package (global install gives you the `atom`
binary):

```bash
npm i -g atom-agent
atom
```

Or run from source:

```bash
npm install
```

Get a key at [opencode.ai/auth](https://opencode.ai/auth), then:

```powershell
$env:OPENCODE_ZEN_API_KEY="sk-your-key"
npm start
```

That's it. Type `/` to see every command. Full command reference: [CLI and TUI](documentation/cli.md).

## Updating

Check your installed version, then update to the latest release:

```bash
npm ls -g atom-agent   # installed version
npm i -g atom-agent@latest
```

If the old version sticks around, clear the cache and reinstall:

```bash
npm cache clean --force
npm i -g atom-agent@latest
```

Run-from-source users just `git pull` instead. Maintainers: bump `version`
in `package.json`, add a `CHANGELOG.md` entry, commit, tag `vX.Y.Z`, push —
`prepublishOnly` rebuilds `dist/` at `npm publish` time, so never commit it.

## What Atom can do

- 🤖 **Agentic loop** — tool calls execute locally and results feed back in,
  up to 30 steps per turn (`ATOM_MAX_TOOL_STEPS`, clamped 5–100), with retries on transient failures
- ⚡ **Streaming** — tokens, tool activity, and phase status render live;
  reasoning streams in its own dim block above the answer draft
  (transient); `Esc` stops a running response (footer shows `esc stops`
  while busy)
- 🧰 **13 tools** — `read`, `write`, `edit`, `grep`, `glob`, `bash`,
  `bash_output`, `websearch`, `webfetch`, `ask_question` (asks *you* things
  interactively), `todowrite` / `todo_get` / `todo_update` (session task
  checklist with a live TUI panel)
- 🛡️ **Normal / YOLO modes** — `Tab` toggles. Normal auto-runs reads but
  asks before writes/shell (`y` once · `a` always · `t` trust all · `n` deny);
  `/trust` toggles a session trust tier (one approval covers the whole task,
  status shows `+trust`, never saved). YOLO never asks
- 🗺️ **Plan mode** — `/plan` enters a read-only mode for risky work:
  exploration (`read`/`grep`/`glob`/web/todos/`ask_question`) runs free while
  `write`/`edit`/`bash` are blocked pre-execution with a replan note (never a
  prompt). `Tab` never enters/exits plan, `/yolo`·`/trust` can't punch through
  it, `/deny` still wins. Exiting `/plan` approves the recorded todo checklist
  into implementation (lands in normal, never yolo)
- ⌨️ **Slash commands** — `/model` (interactive model picker), `/provider`
  (provider + key picker, keys in `~/.atom/auth.json`), `/effort`
   (reasoning-effort picker), `/tools`, `/help`, `/mode`, `/yolo`, `/trust`, `/plan`, `/clear`,
  `/exit` — plus `/`-autocomplete as you type
- 📊 **Status line** — provider · model · session token usage (`token:
  (P%) NK`: NK is the cumulative spend in K, P% is the current context load
  over the model's verified window — last `prompt_tokens`, else the
  4ch/token estimate; bare `token: NK` where no window is verified,
  `token: n/a` until reported — never estimated) · reasoning · mode, plus
  live phase/elapsed/waiting while busy. It is the sole info bar: there is
  no persistent header, only the launch-time banner art.
- 🗜️ **Context compaction** — auto-compacts at ~83% of the verified window
  (`ATOM_COMPACT_PCT` percent, 50–95) plus manual `/compact [focus text]`
  (structured summary, tools disabled, newest tail kept, thrash guard).
- 📖 **AGENTS.md-aware** — Atom loads your project's `AGENTS.md` into its
  system prompt, so it knows your tools, rules, and permission model
- 🔓 **No path sandbox** — file tools read/write anywhere on the computer
  (absolute paths and `..` escapes allowed, including sensitive locations
  like `~/.ssh/` — treat contents as untrusted, never exfiltrate or commit
  secrets); the permission mode is the control plane. Everything is capped
  and truncated

## Tools

Full reference: [Tools](documentation/tools.md) plus [Permissions and Modes](documentation/permissions.md).

| Tool | What it does | Permission (normal mode) |
|---|---|---|
| `read` | Read files / list directories | auto |
| `grep` / `glob` | Search contents / find files | auto |
| `websearch` | Keyless web search (discovery) | auto |
| `webfetch` | Fetch pages as markdown/text/html (retrieval) | auto |
| `write` / `edit` | Create / exact-match-patch files | asks |
| `bash` | Shell commands (cwd, timeout, truncated) | asks |
| `bash_output` | Poll a background shell task | auto |
| `todowrite` / `todo_get` / `todo_update` | Session task checklist (live panel) | auto |
| `ask_question` | Interactive picker for clarifications | n/a (is interaction) |

### Scoped permission rules

Beyond all-or-nothing trust: `/allow <tool[:glob]>` pre-approves matching
`write`/`edit`/`bash` calls for the session (no prompt — e.g. `/allow
bash:npm test*`, `/allow write:src/**`; bare `/allow bash` matches any args),
and `/deny <tool[:glob]>` refuses matching calls before execution (the model
sees the standard denial result and replans). **Deny wins over `/trust`,
yolo, `[a]lways`, and skill grants.** `/rules` lists the session rules,
`/rules clear` wipes them. Rules are in-memory only (like `/trust`, never
saved); globs use `*` (any sequence) and `?` (one char), matched against the
tool's primary string (command for `bash`, path for `write`/`edit` — the same
primary shown in the `⚙` audit line, which still renders for every
auto-approved call).

## Models & provider

Full reference: [Providers and Models](documentation/providers.md) plus [Configuration](documentation/configuration.md).

Atom talks to 7 providers behind one UI (opencode `/connect` mirror,
manual-key only — no OAuth). Pick with `/provider`, paste a key once
(validated, stored in `~/.atom/auth.json`, `0600` on POSIX), chat.
Switching provider keeps session history text; system prompt stays.
`/model` lists the active provider's live models (curated fallback on any
failure). `/effort` sends `reasoning_effort` only for opencode-zen
supported models; elsewhere kept but never sent.

### Model-choice policy

The zen default is `deepseek-v4-pro` — picked from the live `/models` list
for reliable multi-step tool use (tool calls + reasoning effort supported).
Free models (`big-pickle`, `mimo-v2.5-free`, …) stay selectable via `/model`
for quick single-turn questions. Override any time with `/model` or
`OPENCODE_ZEN_MODEL`.

| Provider | Key env (wins over stored) | Endpoint | Notes |
|---|---|---|---|
| opencode-zen | `OPENCODE_ZEN_API_KEY` | `https://opencode.ai/zen/v1/chat/completions` | OpenAI-compatible chat/completions default; key at https://opencode.ai/auth |
| openai | `OPENAI_API_KEY` | `https://api.openai.com/v1/chat/completions` | OpenAI-compatible; key at https://platform.openai.com/api-keys |
| anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` | Messages API (`x-api-key` + `anthropic-version: 2023-06-01`, `max_tokens` 4096); key at https://console.anthropic.com/settings/keys |
| deepseek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/chat/completions` | OpenAI-compatible (no `/v1` prefix); key at https://platform.deepseek.com/api_keys |
| mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1/chat/completions` | OpenAI-compatible; key at https://console.mistral.ai/api-keys |
| google-gemini | `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`) | `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` (`:generateContent` fallback) | `x-goog-api-key`; key at https://aistudio.google.com/apikey |
| openai-compatible | stored key only | stored baseURL (`/chat/completions` appended iff missing) | additionally prompts baseURL (must be http(s)); live `/models` authoritative |

Keys: never printed full (masked `…last4`), never logged, never in fixtures (tests use `"test-key"`).

## Develop

Full guide: [Development](documentation/development.md). Fixes start at [Troubleshooting](documentation/troubleshooting.md).

```bash
npm start        # run the TUI from source (needs a TTY)
npm test         # vitest suite (fully mocked — never hits live APIs)
npm run typecheck
npm run build    # emit dist/ (the `atom` binary entry is dist/cli.js)
```

Env knobs: `OPENCODE_ZEN_API_KEY` (or stored zen key via `/provider`), `OPENCODE_ZEN_MODEL`,
`OPENCODE_ZEN_ENDPOINT`, `OPENCODE_AGENTS_PATH`, `ATOM_COMPACT_PCT` (auto-compact percent, 50–95),
`ATOM_MAX_TOOL_STEPS` (tool rounds per turn, default 30, clamped 5–100),
plus per-provider key env vars above.
`~/.atom/auth.json` holds pasted keys (`{version:1, providers:{"<id>":{apiKey, baseURL?}}}`, `0600` POSIX).

```
.
├── src/
│   ├── cli.tsx    # entry: --help, always starts TUI (missing key guides to /provider)
│   ├── App.tsx    # Ink TUI: transcript, pickers, modes (/plan /trust), approvals, status line
│   ├── zen.ts     # agentic loop (budgets, todo/verification guards) + provider dispatch + SSE
│   ├── tools.ts   # 13 local tool executors + function schemas (read/write/edit/grep/glob/bash/…)
│   ├── permissions.ts # allow/deny rule matcher backing /allow /deny /rules
│   ├── snapshots.ts   # pre-mutation file snapshots backing /rewind
│   ├── skills.ts  # skill discovery backing /skills
│   ├── env-block.ts   # per-turn cwd/git/node environment block
│   ├── providers.ts # 7-provider registry (kind/endpoint/env/default + fallback models)
│   ├── auth.ts    # ~/.atom/auth.json store (env wins, 0600 POSIX)
│   ├── adapters.ts # anthropic/gemini translation + SSE + models-list parsing + key validation
│   ├── compact.ts # context compaction: load/trigger math, split, summary POST (tools off)
│   ├── session.ts # session save/resume
│   ├── context-windows.ts # curated per-model context windows + `token: (P%) NK` format
│   └── system.ts  # base system prompt (long-horizon operating contract)
├── dist/          # `npm run build` output (`atom` runs dist/cli.js; gitignored, shipped in the tarball)
├── tests/         # fully mocked (never live APIs; keys use "test-key")
├── documentation/ # user manual (getting started → troubleshooting)
├── AGENTS.md      # agent instructions overlay (loaded at startup, minimal)
├── tsconfig.build.json # build-only config (src -> dist)
└── .env.example   # env template (never commit a real key)
```

## License

MIT — see [LICENSE](LICENSE).
