# Changelog

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
