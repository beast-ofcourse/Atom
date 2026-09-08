# Getting Started

Fastest path from zero to chatting with an agent that can read, edit, and run your code.

## Prerequisites

- Node.js `>=18` (see `engines` in `package.json`)
- A provider key. Default provider is OpenCode Zen: get one at `https://opencode.ai/auth`
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

1. Get a key at `https://opencode.ai/auth`
2. Set it for the session (PowerShell shown; use `export` on POSIX):

```powershell
$env:OPENCODE_ZEN_API_KEY="sk-your-key"
npm start
```

3. Type `/` to see every command. Type `/provider` to paste a key once and store it instead of using env vars.

No key yet: the TUI still starts. Chatting without a key for the active provider errors inline and points at `/provider`. Nothing is posted.

## Quickstart path

```text
prerequisites
-> npm install
-> set OPENCODE_ZEN_API_KEY (or paste via /provider)
-> npm start
-> type / to list commands, ask something about your repo
```

Expected result: streaming answer with live tool activity and a status line showing provider, model, token usage, reasoning effort, and mode.

## Next steps

- [CLI and TUI](cli.md) for slash commands and keyboard control
- [Providers and Models](providers.md) to switch off Zen or use a local OpenAI-compatible server
- [Configuration](configuration.md) for all env knobs and the auth file
- [Troubleshooting](troubleshooting.md) if the first run fails
