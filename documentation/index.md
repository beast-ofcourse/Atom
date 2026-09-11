# ATOM Documentation

Minimal AI coding agent for your terminal. Agentic loop, 13 local tools, streaming Ink TUI, 8 remote providers plus 3 local runtimes behind one UI (Kilo Gateway default, key-optional).

This index is the entry point. The README stays focused on evaluate, install, and first run. Everything deeper lives here.

## Start here

- [Getting Started](getting-started.md) - install, key-optional first run, quickstart path
- [CLI and TUI](cli.md) - slash commands, keyboard, status line, autocomplete
- [Goals](goals.md) - pinning a session goal that runs turn-to-turn until done, stuck, paused, or cleared

## Core concepts

- [Tools](tools.md) - the 13 local executors, caps, approval classes, background tasks
- [Providers and Models](providers.md) - 8 remote providers + 3 local runtimes, endpoints, key resolution, model pickers
- [Permissions and Modes](permissions.md) - normal/yolo/plan, trust, allow/deny rules
- [Skills](skills.md) - discovery, frontmatter contract, precedence, auto-invoke
- [Extensions](extensions.md) - zero-to-running guide plus the working sample gallery

## Sessions and context

- [Sessions](sessions.md) - persistence file, resume, clear, rewind
- [Compaction and Token Display](compaction.md) - auto-compact threshold, manual compact, footer format
- [Observability](observability.md) - local telemetry, /telemetry, dashboard drill-down
- [Configuration](configuration.md) - env vars, auth file, AGENTS.md layering

## Build and fix

- [Development](development.md) - scripts, project structure, tests, build output
- [Architecture](architecture.md) - module map, dependency directions, boundary rules
- [Troubleshooting](troubleshooting.md) - common failures and what to check first

## Agent docs (existing)

Project conventions the agent itself loads at runtime:

- [AGENTS.md](../AGENTS.md) - agent instructions loaded into the system prompt
- [Issue tracker](agents/issue-tracker.md) - local markdown issues under `.scratch/`
- [Triage labels](agents/triage-labels.md) - canonical triage roles
- [Domain docs](agents/domain.md) - CONTEXT.md plus ADR conventions
