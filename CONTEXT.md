# CONTEXT.md — ATOM ubiquitous language

Glossary only. No implementation, no specs.

## Core

- **subagent**: an isolated worker that does one task in its own context window and returns only a summary. It never sees the parent conversation.
- **agent definition**: the file a subagent is built from — Markdown with YAML frontmatter (`name` and `description` required), body is the worker's system prompt.
- **project agent**: a definition in `.claude/agents/`, scoped to one codebase, checked into version control.
- **user agent**: a definition in `~/.claude/agents/`, available in every project.
- **built-in agent**: a subagent ATOM ships: `explore` (read-only research), `plan` (read-only research for planning), `general-purpose` (research plus action).
- **delegation**: the parent handing a task plus a brief to a subagent through the `delegate` tool.
- **spawn**: starting a running instance from a definition. Spawns are one-shot: a follow-up is a fresh spawn, never a continuation.
- **depth**: nesting layers below the main conversation. v1 depth is 1 — a child cannot spawn.
- **summary**: the child's final text. The only thing that ever returns to the parent.
- **brief**: the task message the parent writes when delegating. The child works from the brief, not from parent history.
- **thoroughness**: how hard an `explore` worker looks — `quick`, `medium`, or `very thorough`.
- **partial**: a summary marked as cut short by the child's turn limit. The parent decides whether to re-spawn narrower, never assumes completeness.

## Hard distinctions

- A **skill** injects instructions into *your* context. A **subagent** gets *its own* context and returns a summary. Same file shape, opposite direction.
- A **spawn** is not a **session**: it has no persistence, no ID, nothing resumable.
- **Depth** counts layers below the main conversation, not total agents running.
