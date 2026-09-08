# ⚛ Atom — a minimal AI coding agent for your terminal

```
 █████╗ ████████╗ ██████╗ ███╗   ███╗
██╔══██╗╚══██╔══╝██╔═══██╗████╗ ████║
███████║   ██║   ██║   ██║██╔████╔██║
██╔══██║   ██║   ██║   ██║██║╚██╔╝██║
██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║
╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝
```

Atom is a small, fast, **agentic** terminal chatbot: it doesn't just answer —
it runs an **observe → act → inspect → adjust** loop with **9 real,
locally-executed tools** (files, shell, web), streaming output, and an
interactive Ink TUI. Powered by [OpenCode Zen](https://opencode.ai/docs/zen)
as the model provider. Zero ceremony: one key, one command, you're chatting
with an agent that can read your code, edit it, run it, and search the web.

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

That's it. Type `/` to see every command.

## What Atom can do

- 🤖 **Agentic loop** — tool calls execute locally and results feed back in,
  up to 10 steps per turn, with retries on transient failures
- ⚡ **Streaming** — tokens, tool activity, and phase status render live;
  reasoning streams in its own dim block above the answer draft
  (transient); `Esc` stops a running response (footer shows `esc stops`
  while busy)
- 🧰 **13 tools** — `read`, `write`, `edit`, `grep`, `glob`, `bash`,
  `bash_output`, `websearch`, `webfetch`, `ask_question` (asks *you* things
  interactively), `todowrite` / `todo_get` / `todo_update` (session task
  checklist with a live TUI panel)
- 🛡️ **Normal / YOLO modes** — `Tab` toggles. Normal auto-runs reads but
  asks before writes/shell (`y` once · `a` always · `n` deny);
  YOLO never asks
- ⌨️ **Slash commands** — `/model` (interactive model picker), `/provider`
  (provider + key picker, keys in `~/.atom/auth.json`), `/effort`
  (reasoning-effort picker), `/tools`, `/help`, `/mode`, `/yolo`, `/clear`,
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

## Models & provider

Atom talks to 7 providers behind one UI (opencode `/connect` mirror,
manual-key only — no OAuth). Pick with `/provider`, paste a key once
(validated, stored in `~/.atom/auth.json`, `0600` on POSIX), chat.
Switching provider keeps session history text; system prompt stays.
`/model` lists the active provider's live models (curated fallback on any
failure). `/effort` sends `reasoning_effort` only for opencode-zen
supported models; elsewhere kept but never sent.

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

```bash
npm start        # run the TUI from source (needs a TTY)
npm test         # vitest suite (fully mocked — never hits live APIs)
npm run typecheck
npm run build    # emit dist/ (the `atom` binary entry is dist/cli.js)
```

Env knobs: `OPENCODE_ZEN_API_KEY` (or stored zen key via `/provider`), `OPENCODE_ZEN_MODEL`,
`OPENCODE_ZEN_ENDPOINT`, `OPENCODE_AGENTS_PATH`, `ATOM_COMPACT_PCT` (auto-compact percent, 50–95),
plus per-provider key env vars above.
`~/.atom/auth.json` holds pasted keys (`{version:1, providers:{"<id>":{apiKey, baseURL?}}}`, `0600` POSIX).

```
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
