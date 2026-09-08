# Tools

13 local tool executors (`src/tools.ts`). Node builtins plus global fetch only. Every executor returns a string and never throws across the tool boundary: failures come back as `Error: ...` strings so the model can react.

Source of truth for names and shapes is `TOOL_DEFINITIONS` in `src/tools.ts`. The validator and loop build their `Available: ...` lists from it.

## The 13 tools

| Tool | What it does | Permission in normal mode |
|---|---|---|
| `read` | Read files, list directories. Args: `path`, optional 1-based `offset`/`limit` | auto |
| `write` | Create or overwrite files (creates parent dirs). Silent pre-mutation snapshot for rewind | asks |
| `edit` | Exact-match patch. Fails on no match, on multiple matches without `replaceAll`, on stale read | asks |
| `grep` | Line-regex search under `dir`. `include` glob, `outputMode`: `content`, `files_with_matches`, `count` | auto |
| `glob` | List paths matching pattern under `dir`, newest-first | auto |
| `bash` | Shell command. JSON result with `exitCode`, `stdout`, `stderr`. Optional `runInBackground` | asks |
| `bash_output` | Poll a background shell task by `taskId` | auto |
| `webfetch` | Fetch a page as `markdown`, `text`, or `html`. http upgrades to https | auto |
| `websearch` | Keyless discovery via DuckDuckGo HTML endpoint. `query`, optional `numResults`, `site` | auto |
| `ask_question` | Interactive picker for clarifications. Needs `question` plus at least 2 `options` | n/a (is interaction) |
| `todowrite` | Replace the session task checklist | auto |
| `todo_get` | Read the session task checklist | auto |
| `todo_update` | Update one checklist item by index | auto |

Read-only set: `read`, `grep`, `glob`, `webfetch`, `websearch`, `bash_output`, `todowrite`, `todo_get`, `todo_update`. Approval set: `write`, `edit`, `bash`. `ask_question` never needs approval because it is user interaction.

## Caps and truncation

| Path | Cap | Behavior |
|---|---|---|
| `read` output | ~64KB | Head plus truncation note. Full text spills to `<tmpdir>/atom-overflow/` with a `read` pointer |
| `bash` stdout/stderr | ~8KB each | Each stream capped independently, JSON flags `stdoutTruncated`/`stderrTruncated`, overflow pointer on spill |
| `bash_output` streams | ~8KB each | Same spill behavior for background stdout/stderr |
| `webfetch` download | ~1MB | Noted as `[truncated: download exceeded ~1MB]` |
| `webfetch` output | ~64KB | Same overflow-file pointer as `read` |
| `grep` content | 100 matches | Lines over 200 chars shortened with an ellipsis. `file:line: text` shape |
| `grep` files/count | 100 files | `files_with_matches` is newest-first with a `Found N file(s)` header. `count` adds per-file `file:count` plus totals covering every match |
| `glob` | 200 matches | Newest-first by mtime, recency as relevance proxy |
| `websearch` | default 8, max 20 | Numbered title plus url plus snippet blocks, or `No results.` Query capped at 500 chars |
| `bash` timeout | default 60000ms, max 120000ms | `timedOut` flag in the JSON result |
| `bash_output` wait | default 5000ms, max 60000ms | Polls about every 100ms until exit or wait expiry |
| Background tasks | 20 records | Oldest evicted first, temp files pruned best-effort |
| Agentic loop | 30 steps default | `ATOM_MAX_TOOL_STEPS`, clamped 5-100 |

Count-cap notes (`grep`/`glob` over-cap) and prompt-assembly caps (skills, compact, AGENTS.md, history) do not spill: re-query to narrow.

## Path handling

No path sandbox. Relative paths resolve against cwd. Absolute paths and `..` escapes are allowed anywhere on the machine, including sensitive locations like `~/.ssh/`. Treat those contents as untrusted. Never exfiltrate or commit secrets. The permission mode is the control plane. See [Permissions](permissions.md).

Only empty/non-string paths and null bytes are rejected.

## Safety guards

- Read-tracking: `read` records a sha1 per resolved file. `edit` refuses with a stale-read error when the file changed since the last read. `write`/`edit` refresh the record. Files never read this session have no record.
- Pre-mutation snapshots: `write`/`edit` capture prior bytes for `/rewind`. See [Sessions](sessions.md).
- Validation: malformed args return `Error: invalid call: ... Fix the arguments and retry.` The tool never ran. Runtime failures return plain `Error: ...`.
- Binary skip: `grep` skips unreadable files and files containing null bytes.

## Background shell

`bash` with `runInBackground: true` returns immediately with `{backgroundTaskId, status: "running", hint}`. Poll with `bash_output` (`taskId`, optional `timeoutMs`). Result JSON carries `taskId`, `running`, `exitCode` (null while running), `stdout`, `stderr`, `timedOut`.

Windows note: background spawns attached (detached children drop output on Windows). POSIX uses detached process groups. Observable contract is the same: immediate return, independent run, output to temp files under the OS temp dir.
