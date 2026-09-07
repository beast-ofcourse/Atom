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
- ⚡ **Streaming** — tokens, tool activity, and phase status render live
- 🧰 **9 tools** — `read`, `write`, `edit`, `grep`, `glob`, `bash`,
  `websearch`, `webfetch`, `ask_question` (asks *you* things interactively)
- 🛡️ **Normal / YOLO modes** — `Tab` toggles. Normal auto-runs reads but
  asks before writes/shell (`y` once · `a` always · `n` deny);
  YOLO never asks
- ⌨️ **Slash commands** — `/model` (interactive model picker), `/effort`
  (reasoning-effort picker), `/tools`, `/help`, `/mode`, `/yolo`, `/clear`,
  `/exit` — plus `/`-autocomplete as you type
- 📊 **Status line** — provider · model · session token usage · reasoning ·
  mode, updated live (usage comes only from real API payloads — `n/a`
  until reported, never estimated)
- 📖 **AGENTS.md-aware** — Atom loads your project's `AGENTS.md` into its
  system prompt, so it knows your tools, rules, and sandbox limits
- 🔒 **Sandboxed by default** — file tools stay inside the working
  directory; everything is capped and truncated

## Tools

| Tool | What it does | Permission (normal mode) |
|---|---|---|
| `read` | Read files / list directories | auto |
| `grep` / `glob` | Search contents / find files | auto |
| `websearch` | Keyless web search (discovery) | auto |
| `webfetch` | Fetch pages as markdown/text/html (retrieval) | auto |
| `write` / `edit` | Create / exact-match-patch files | asks |
| `bash` | Shell commands (cwd, timeout, truncated) | asks |
| `ask_question` | Interactive picker for clarifications | n/a (is interaction) |

## Models & provider

Atom talks to OpenCode Zen's OpenAI-compatible `chat/completions` endpoint
(default model `big-pickle`; switch anytime with `/model`). Only
`chat/completions`-family models are supported (DeepSeek, Kimi, GLM,
MiniMax, Big Pickle, free chat models) — other Zen families use different
APIs. `/effort` sends `reasoning_effort` (Default/Low/Medium/High/Max) and
only for models known to accept it; elsewhere the setting is kept but not
sent. Some Zen free models are rate-limited — if you see `429
FreeUsageLimitError`, retry later or use a paid-model key.

## Develop

```bash
npm start        # run the TUI (needs a TTY)
npm test         # vitest suite (fully mocked — never hits live APIs)
npm run typecheck
```

Env knobs: `OPENCODE_ZEN_API_KEY` (required), `OPENCODE_ZEN_MODEL`,
`OPENCODE_ZEN_ENDPOINT`, `OPENCODE_AGENTS_PATH`.

```
.
├── src/
│   ├── cli.tsx    # entry: --help, missing-key screen
│   ├── App.tsx    # Ink TUI: transcript, pickers, modes, status line
│   ├── zen.ts     # Zen provider: streaming SSE, retries, agentic loop
│   └── tools.ts   # 9 local tool executors + function schemas
├── tests/         # 79 tests, all network-mocked
├── AGENTS.md      # the agent's own instructions (loaded at startup)
└── .env.example   # env template (never commit a real key)
```
