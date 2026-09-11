# CLI and TUI

ATOM is an Ink (React) TUI. Entry is `src/cli.tsx`, rendered by `src/App.tsx`. There is no persistent header, only the launch-time banner. The status line is the sole info bar.

## Launch

```bash
npm start        # run the TUI from source (needs a TTY)
atom             # run the installed binary (runs dist/cli.js)
atom --help      # usage, env vars, commands, providers (exits, no TUI)
atom --dashboard # write ~/.atom/telemetry/dashboard.html and exit (no TUI)
atom --serve [--port <n>]  # serve the live observability webUI on loopback (no TUI, Ctrl+C stops)
```

`--help` (or `-h`) prints usage and exits. `--dashboard` and `--serve` handle local observability without starting the TUI (see [Observability](observability.md)). Any other invocation starts the TUI, even without a key.

## Slash commands

Type `/` to autocomplete as you type. Full registry (`src/App.tsx`):

| Command | What it does |
|---|---|
| `/model` | Unified model picker: active provider first, then other keyed providers plus the always-visible keyless Kilo list (free models badged `(free)`, `free` filters them). Cross-provider pick switches provider |
| `/models [refresh]` | Local discovery status; `refresh` re-probes local servers (or the Kilo gateway catalog while Kilo is active) |
| `/provider` | Provider plus key picker; validates and stores in `~/.atom/auth.json` (Kilo key optional — empty Enter continues anonymously) |
  | `/new` | Start a brand-new session (conversation plus counters reset, previous kept for `/resume`) |
  | `/rename <name>` | Rename the current session (id and history untouched; quotes optional) |
| `/plan`, `/yolo` | Retired as typed commands — `Tab` is the only mode switcher (normal → yolo → plan → normal); typing them explains this instead of switching |
| `/effort` | Reasoning-effort picker (sent only for opencode-zen supported models) |
| `/tools` | List tools with one-line descriptions |
| `/skills` | List installed skills (project plus global) |
| `/skill` | Invoke a skill by name (`/skill:name`; skills also complete in the `/` menu) |
| `/context` | Show context usage by source (system, tools, history, skills, config, prefix-cache) |
| `/queue` | List queued follow-ups (`/queue clear` wipes; cap 10, in-memory only) |
| `/steer` | Steer the running turn, or send when idle (`/steer <text>`) |
| `/autoscroll` | Toggle following new output (off by default; bare toggles, `on|off` sets it; off freezes the view mid-turn) |
| `/mode` | Print the current permission mode |
| `/trust` | Toggle session trust: auto-approve write/edit/bash without full yolo. Again revokes |
| `/allow <tool[:glob]>` | Pre-approve a tool pattern this session |
| `/deny <tool[:glob]>` | Forbid a tool pattern this session. Deny wins over trust/yolo |
| `/rules` | List session allow/deny rules. `/rules clear` wipes them |
| `/clear` | Clear conversation history (keeps session token totals) |
| `/compact [focus]` | Summarize older turns into one summary. Optional focus text |
  | `/resume` | Restore the last saved session (turns, history, settings, usage) |
  | `/session [filter]` | Switch the active session (interactive most-recent-first picker with fuzzy filter; `Enter` switches, `Esc` cancels) |
| `/telemetry` | Show the local observability summary (sessions, tokens, tools) |
| `/dashboard` | Write the local observability dashboard page and show its path |
| `/rewind` | Restore files to a session checkpoint. Files only, never shell side effects |
| `/help` | List commands with one-liners |
| `/exit`, `/quit` | Exit ATOM |

`/compact`, `/allow`, `/deny`, `/rules` accept prefix forms (`/compact focus...`, `/allow bash:npm test*`). `/rename` takes the rest of the line as the name; `/session` takes an optional initial filter.

## Keyboard

- `Tab`: cycle permission mode normal → yolo → plan → normal (in the `/` menu, Tab runs the highlighted command instead)
- `Esc`: stop a running response (footer shows `esc stops` while busy); deny a pending approval/question
- `/`: open command autocomplete (typing a full command name collapses the menu to it)
- `Ctrl+O`: open the tool-output inspector (browse past tool calls; `↑`/`↓` select, `Enter` expands, `PgUp`/`PgDn` scroll, `Esc` closes)
- `Ctrl+P`: command palette (searchable, same registry)
- `Ctrl+C`: cancel the running turn; exit when idle
- `PgUp`/`PgDn`: scroll the transcript (`End` follows latest)
- `↑`/`↓`: recall past prompts; `Ctrl+J` inserts a newline (`Enter` always sends)
- `y` once, `a` always, `t` trust all, `n` deny: answer write/shell approval prompts in normal mode

## Status line

Format when idle: provider/model │ token │ cwd[` : `branch] │ reasoning │ mode (`+trust` when session trust is on, hidden in plan mode). The location segment flexes to fit the terminal (branch drops first, then the cwd tail, then the whole segment). While busy: live activity │ elapsed │ token │ reasoning │ mode │ `esc stops` (+`waiting…` / `waiting approval` flags).

Token segment (`src/context-windows.ts`):

- `token: n/a`: no usage reported yet. Never estimated
- `token: (P%) NK`: known context window. NK is cumulative session spend in K (`round(total/1024)`). P% is current context load over the verified window (last POST input tokens including prefix-cache reads, else the 4 chars/token estimate)
- `token: NK`: model has no verified window. Bare total only
- `token: 0K` / `token: (0%) 0K`: zero usage, with/without a known window

## Reasoning and streaming

Tokens, tool activity, and phase status render live. Reasoning streams in its own dim block above the answer draft (transient). Tool calls execute locally and results feed back into the loop with no step cap by default (optional cap via `ATOM_MAX_TOOL_STEPS`, clamped 5-100).

See [Sessions](sessions.md), [Compaction](compaction.md), and [Permissions](permissions.md) for the systems behind these commands.
