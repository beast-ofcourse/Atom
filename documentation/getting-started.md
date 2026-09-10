# Getting Started

Fastest path from zero to chatting with an agent that can read, edit, and run your code.

## Prerequisites

- Node.js `>=18` (see `engines` in `package.json`)
- No API key required to start: the default provider is Kilo Gateway, whose free models work anonymously
- A TTY for `npm start` (the TUI needs an interactive terminal)

## Install

Global install gives you the `atom` binary:

```bash
npm i -g atom-agent
atom
```

Or run from source:

```bash
npm install
```

## First run

1. Just start it — no key needed:

```powershell
npm start
```

2. ATOM selects Kilo automatically, discovers its live model catalog, and starts on the free routing model (`kilo-auto/free`) when no Kilo key is configured. Open `/model` to see the discovered models (free ones carry a `(free)` badge) and pick one.
3. Type `/` to see every command. Type `/provider` to paste a Kilo key once (optional — unlocks the full catalog) or to switch to another provider.

No key at all: the TUI still starts, and Kilo's free models chat immediately. Providers that need a key error inline and point at `/provider` instead of posting. Nothing is posted without a usable route.

To use a keyed provider instead (e.g. OpenCode Zen), get a key at `https://opencode.ai/auth` and set it for the session (PowerShell shown; use `export` on POSIX):

```powershell
$env:OPENCODE_ZEN_API_KEY="sk-your-key"
npm start
```

## Quickstart path

```text
prerequisites
-> npm install
-> npm start (Kilo free model, no key)
-> /model to pick a discovered model, ask something about your repo
-> optional: KILO_API_KEY (or paste via /provider) for the full Kilo catalog
```

Expected result: streaming answer with live tool activity and a status line showing provider, model, token usage, reasoning effort, and mode.

## Next steps

- [CLI and TUI](cli.md) for slash commands and keyboard control
- [Providers and Models](providers.md) to switch off Kilo, add a Kilo key, or use a local OpenAI-compatible server
- [Configuration](configuration.md) for all env knobs and the auth file
- [Troubleshooting](troubleshooting.md) if the first run fails
