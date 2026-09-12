# ATOM

> A fast, transparent AI coding agent for your terminal.

[![npm version](https://img.shields.io/npm/v/atom-agent.svg)](https://www.npmjs.com/package/atom-agent)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-blue.svg)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/atom-agent.svg)](LICENSE)

```text
 █████╗ ████████╗ ██████╗ ███╗   ███╗
██╔══██╗╚══██╔══╝██╔═══██╗████╗ ████║
███████║   ██║   ██║   ██║██╔████╔██║
██╔══██║   ██║   ██║   ██║██║╚██╔╝██║
██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║
╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝
```

ATOM is a terminal-native coding agent built with [Ink](https://github.com/vadimdemedes/ink) and React. It combines a multi-step agent loop with local file, shell, and web tools, persistent sessions, permission controls, and local observability.

Instead of returning a static answer, ATOM can inspect your repository, plan a task, edit files, run commands, inspect the results, and adjust its approach. The terminal interface keeps tool activity, approvals, and progress visible while you stay in control.

Kilo Gateway is the default provider. Eligible free models can be used without an API key, and you can switch providers or configure a key at any time.

## Highlights

- **Agentic execution** — an observe, plan, act, inspect, and adjust loop with optional task checklists.
- **Terminal-first interface** — streaming output, keyboard controls, slash commands, and a compact status line.
- **Local tools** — file operations, search, shell commands, background processes, and web retrieval.
- **Flexible providers** — Kilo Gateway, major hosted model providers, OpenAI-compatible servers, and local runtimes.
- **Permission modes** — normal, YOLO, and plan modes, plus session-scoped allow and deny rules.
- **Persistent work** — named sessions, resume and rewind support, and goals that continue across turns.
- **Local observability** — traces, summaries, and a self-contained dashboard stored on your machine.
- **Extensible** — skills and extensions can add workflows, tools, and custom behavior.

## Requirements

- Node.js 18 or newer
- A terminal with TTY support for the interactive interface

## Quickstart

### Install the package

```bash
npm install -g atom-agent
atom
```

The global installation provides the `atom` command.

### Run from source

```bash
npm install
npm start
```

`npm start` launches the interactive TUI and requires a TTY.

### First run

1. Start ATOM with `atom` or `npm start`.
2. Ask a question about your current repository.
3. Type `/` at any time to view the available commands.
4. Use `/model` to choose a model and `/provider` to configure a provider key.

No key is required to try the default Kilo free-model route. Free-model availability and limits are controlled by Kilo and may change. Add `KILO_API_KEY` or use `/provider` when you need broader access.

### Update

```bash
npm ls -g atom-agent
npm install -g atom-agent@latest
```

If npm continues to use an older cached installation, clear the npm cache and install again:

```bash
npm cache clean --force
npm install -g atom-agent@latest
```

Source installations can be updated with `git pull` followed by `npm install`.

## How ATOM works

ATOM follows a long-running agent loop:

```text
observe → plan → act → inspect → adjust
```

For larger tasks, it can maintain a session checklist with at most one active item. After making code changes, it can run a verification command before reporting the task complete. Tool results are returned to the model, so the next step can respond to the actual state of the repository.

The interface streams tokens, tool activity, phase changes, approvals, and elapsed time. Reasoning output is kept separate from the answer draft so the final response remains easy to follow.

## Permission modes

| Mode | Behavior |
|---|---|
| **Normal** | Read-only tools run automatically. `write`, `edit`, and `bash` requests require approval. |
| **YOLO** | Tools run without approval prompts. Use only when you are comfortable with automatic local changes and commands. |
| **Plan** | Read-only exploration is allowed; writes, edits, and shell commands are blocked so you can review a proposed approach. |

Press `Tab` to cycle through Normal, YOLO, and Plan. `/trust` provides a session-scoped trust level without switching to YOLO. `/allow` and `/deny` create more precise session rules, and deny rules always take precedence.

## Core capabilities

### Built-in tools

ATOM includes 13 built-in tools:

| Tool | Purpose | Normal mode |
|---|---|---|
| `read` | Read text or supported images, and list directories | Automatic |
| `write` / `edit` | Create, overwrite, or patch files | Approval |
| `grep` / `glob` | Search file contents or locate files | Automatic |
| `bash` | Run a shell command, including background tasks | Approval |
| `bash_output` | Poll a background shell task | Automatic |
| `websearch` / `webfetch` | Discover and retrieve web content | Automatic, subject to network policy |
| `ask_question` | Ask the user an interactive clarification question | User interaction |
| `todowrite` / `todo_get` / `todo_update` | Manage the session task checklist and TUI panel | Automatic |

Extensions can register additional tools. Custom tools are validated before execution and require approval by default unless explicitly configured otherwise.

### Sessions and goals

Sessions preserve conversation history, usage information, preferences, and the active goal. Use `/session` to switch sessions, `/resume` to restore the most recent saved session, and `/rewind` to restore files from a session checkpoint.

A pinned goal can keep the agent working across turns until it is completed, blocked, paused, or cleared:

```text
/goal <objective>
/goal pause
/goal resume
/goal clear
```

### Context and project instructions

ATOM automatically compacts long conversations to stay within the model's context window. Manual compaction is available through `/compact`. When present, the project's `AGENTS.md` is loaded into the system prompt so the agent can follow repository-specific instructions and conventions.

### Providers and models

ATOM supports a unified model picker across:

- Kilo Gateway (default; free models available anonymously where eligible)
- OpenCode Zen
- OpenAI
- Anthropic
- DeepSeek
- Mistral
- Google Gemini
- OpenAI-compatible servers
- Local Ollama, LM Studio, and llama.cpp runtimes

Provider keys can be supplied through environment variables or the `/provider` command. Stored keys live in `~/.atom/auth.json`; environment variables take precedence. Keys are masked in the interface and are not printed in logs.

Use `/model` to select a model, `/provider` to switch or configure a provider, and `/effort` to adjust reasoning effort. See [Providers and Models](documentation/providers.md) for endpoints, key resolution, local runtimes, and model-selection behavior.

## Useful commands

| Command | Description |
|---|---|
| `/model` | Select a model from the unified picker |
| `/provider` | Select a provider and configure its key |
| `/effort` | Set reasoning effort |
| `/mode` | Show the current permission mode |
| `/trust` | Toggle session trust |
| `/allow` / `/deny` | Add a scoped session rule |
| `/tools` | List available tools |
| `/skills` / `/skill:name` | List or invoke a skill |
| `/goal` | Create or manage a long-running goal |
| `/session` / `/resume` | Switch or restore a session |
| `/compact` | Compact older conversation context |
| `/telemetry` / `/dashboard` | View local usage traces and generate a report |
| `/rewind` | Restore files from a session checkpoint |
| `/help` | Show the command reference |

Type `/` to use command autocomplete. The complete command and keyboard reference is in [CLI and TUI](documentation/cli.md).

## Observability

ATOM records local traces for completed, failed, and cancelled turns. The data is stored under `~/.atom/telemetry/`; it is not sent to a remote service.

```bash
atom --dashboard   # write a static dashboard and exit
atom --serve       # serve the live observability dashboard on loopback
atom --web         # start the local agentic Web UI
```

The dashboard includes session and turn summaries, model and tool-call metrics, outcomes, durations, filters, and timelines. Telemetry can be disabled with `ATOM_TELEMETRY=0` or through the `telemetry` setting in `atom.json`.

See [Observability](documentation/observability.md) for details about the stored data, dashboard, privacy rules, and local server.

## Documentation

The README is an overview. Detailed guides live in [`documentation/`](documentation/index.md):

- [Getting Started](documentation/getting-started.md) — installation, first run, and key setup
- [CLI and TUI](documentation/cli.md) — commands, keyboard controls, and status line
- [Tools](documentation/tools.md) — tool reference, limits, scheduling, and safety behavior
- [Permissions and Modes](documentation/permissions.md) — approval modes and scoped rules
- [Providers and Models](documentation/providers.md) — provider endpoints and model selection
- [Sessions](documentation/sessions.md) — persistence, resume, rewind, and session management
- [Goals](documentation/goals.md) — long-running objectives and goal controls
- [Skills](documentation/skills.md) and [Extensions](documentation/extensions.md)
- [Configuration](documentation/configuration.md) — environment variables and `atom.json`
- [Observability](documentation/observability.md) — local traces and dashboards
- [Development](documentation/development.md) — contributor setup and verification
- [Troubleshooting](documentation/troubleshooting.md) — common setup and runtime issues

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/beast-ofcourse/Atom.git
cd Atom
npm install
```

Common development commands:

```bash
npm start           # launch the TUI from source
npm test            # run the Vitest suite
npm run typecheck   # run TypeScript checks
npm run build       # emit the distributable files in dist/
```

`dist/` is generated output and is not committed. The package build is run automatically before publishing. Tests are mocked and do not call live provider APIs; use placeholder keys only in fixtures and examples.

See [Development](documentation/development.md) and [Architecture](documentation/architecture.md) before making substantial changes.

## Project layout

```text
src/
├── cli.tsx         # entry: --help/--dashboard/--serve/--web, extension flags
├── App.tsx         # Ink TUI root (transcript, pickers, modes, status line)
├── agent/          # shared loop core, gates, types, goal evaluator
├── tools/          # per-tool executors plus registry (names, validation, dispatch)
├── tools.ts        # pure barrel re-exporting tools/* (stable import path)
├── ui/             # transcript, diff stack, panels, pickers, status line
├── web/            # local agentic Web UI runtime (served by atom --web)
├── providers.ts    # 8 remote providers + 3 local runtimes (kilo default)
├── telemetry.ts    # local trace recording (+ dashboard/server siblings)
└── sessions.ts     # durable multi-session store (+ session.json compat)
tests/              # unit and interface tests (mocked, never live APIs)
documentation/      # user and contributor guides
scripts/            # build and maintenance utilities
```

See [Development](documentation/development.md) and [Architecture](documentation/architecture.md) for the full module map and boundary rules.

## Security and privacy

ATOM is designed to execute real local actions. File tools have no path sandbox, and shell commands run with the permissions of the current user. Treat repository contents, tool output, and untrusted extensions as untrusted input. Never commit or expose API keys, credentials, or sensitive files.

Normal mode prompts before writes, edits, and shell commands. YOLO mode intentionally bypasses those prompts. Scoped `/deny` rules provide an additional safeguard and take precedence over trust and YOLO. Network retrieval is governed by the configured network policy; private and link-local destinations are blocked by default.

API keys are stored outside the repository in `~/.atom/auth.json`. Telemetry is local by default and can be disabled entirely.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Contributions are welcome. Please open an [issue](https://github.com/beast-ofcourse/Atom/issues) for bugs or proposals, and include the relevant test or typecheck results with pull requests.
