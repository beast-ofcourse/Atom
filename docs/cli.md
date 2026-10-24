# CLI and TUI

ATOM is an Ink (React) TUI. Entry is `src/cli.tsx`, rendered by `src/App.tsx`. There is no persistent header, only the launch-time banner. The status line is the sole info bar.

## Launch

```bash
npm start        # run the TUI from source (needs a TTY)
atom             # run the installed binary (runs dist/cli.js)
atom --help      # usage, env vars, commands, providers (exits, no TUI)
atom --dashboard # write ~/.atom/telemetry/dashboard.html and exit (no TUI)
atom --serve [--port <n>]  # serve the live observability webUI on loopback (no TUI, Ctrl+C stops)
atom --web [--port <n>]    # serve the local agentic Web UI on loopback (no TUI, Ctrl+C stops)
atom --mcp-list            # print MCP server states and exit (no TUI)
atom --mcp-auth <server>   # browser OAuth for one MCP server, then exit (no TUI)
atom --mcp-logout <server> # drop stored MCP credentials for one server, then exit
atom --no-extensions        # boot with zero third-party extensions (alias: --lockdown)
```

`--help` (or `-h`) prints usage and exits. `--dashboard` and `--serve` handle local observability without starting the TUI (see [Observability](observability.md)). `--web` starts the agentic Web UI over the same runtime as the TUI (loopback-only; JSON API at `/api/health`, `/api/providers`, `/api/sessions`). `--mcp-list`, `--mcp-auth`, and `--mcp-logout` manage MCP servers without starting the TUI (see [MCP Servers](mcp.md)). Extension flags (`--no-extensions` / `--lockdown`, repeatable `--enable-extension <glob>` / `--disable-extension <glob>`) control third-party extension loading and win over `atom.json` (see [Extensions](extensions.md) and [Configuration](configuration.md)). Any other invocation starts the TUI, even without a key.

## Slash commands

Type `/` to autocomplete as you type. Full registry (`src/App.tsx`):

| Command | What it does |
|---|---|
| `/model [filter\|refresh]` | Unified model picker: active provider first, then other keyed providers plus the always-visible keyless Kilo list (free models badged `(free)`, `free` filters them). Cross-provider pick switches provider. `refresh` re-probes local servers (or the Kilo gateway catalog while Kilo is active); plain text pre-filters the picker |
| `/provider` | Provider plus key picker; validates and stores in `~/.atom/auth.json` (Kilo key optional — empty Enter continues anonymously) |
  | `/new` | Start a brand-new session (conversation plus counters reset, previous kept for `/resume`) |
  | `/rename <name>` | Rename the current session (id and history untouched; quotes optional) |
| `/plan`, `/yolo` | Retired as typed commands — `Tab` is the only mode switcher (normal → yolo → plan → normal); typing them explains this instead of switching |
| `/effort` | Reasoning-effort picker (`Auto`/`Low`/`Medium`/`High`/`Max`; sent for every model on every provider — `reasoning_effort` on OpenAI-chat, thinking budget on Anthropic, thinking level on Gemini; `Auto` omits it) |
| `/tools` | List tools with one-line descriptions |
| `/mcp` | MCP server popup: status list, `Space` toggles enable/disable, `Esc` closes (see [MCP Servers](mcp.md)) |
| `/skill [name]` | Skill picker (list, filter, invoke); `/skill:name` invokes directly (skills also complete in the `/` menu) |
| `/context` | Show context usage by source (system, tools, history, skills, config, prefix-cache) |
| `/queue` | List queued follow-ups (`/queue clear` wipes; cap 10, in-memory only) |
| `/steer` | Steer the running turn, or send when idle (`/steer <text>`) |
| `/autoscroll` | Toggle following new output (on by default; bare toggles, `on|off` sets it; off freezes the view mid-turn) |
| `/mode` | Print the current permission mode |
| `/trust` | Toggle session trust: auto-approve write/edit/bash without full yolo. Again revokes |
| `/allow <tool[:glob]>` | Pre-approve a tool pattern this session |
| `/deny <tool[:glob]>` | Forbid a tool pattern this session. Deny wins over trust/yolo |
| `/rules` | List session allow/deny rules. `/rules clear` wipes them |
| `/clear` | Clear conversation history (keeps session token totals) |
| `/compact [focus]` | Summarize older turns into one summary. Optional focus text |
| `/goal <objective>` | Pin one session goal (bare shows it; `pause` / `resume` / `clear` manage it; model tools mirror the slash — see [Goals](goals.md)) |
  | `/resume` | Restore the last saved session (turns, history, settings, usage) |
  | `/session [filter]` | Switch the active session (interactive most-recent-first picker with fuzzy filter; `Enter` switches, `Esc` cancels) |
| `/telemetry` | Show the local observability summary (sessions, tokens, tools) |
| `/usage` | Show the per-POST usage ledger for this session (turn steps + compaction POSTs; `↑`/`↓` move, `Esc` closes) |
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

Format when idle: provider/model │ token │ cwd[` : `branch] │ reasoning │ mode (`+trust` when session trust is on, hidden in plan mode) │ goal (only while a goal is live: `goal: <objective> [active|paused]`, truncated to fit — it yields first under width pressure and never displaces other segments). While busy: live activity │ elapsed │ token │ reasoning │ mode │ goal (same goal segment when live) │ `esc stops` (+`waiting…` / `waiting approval` flags).

Token segment (`src/context-windows.ts`):

- `token: n/a`: no usage reported yet. Never estimated
- `token: (P%) NK`: known context window. NK is cumulative session spend in K (`round(total/1024)`). P% is current context load over the verified window (last POST input tokens including prefix-cache reads, else the 4 chars/token estimate)
- `token: NK`: model has no verified window. Bare total only
- `token: 0K` / `token: (0%) 0K`: zero usage, with/without a known window

## Reasoning and streaming

Tokens, tool activity, and phase status render live. Reasoning streams in its own dim block above the answer draft (transient). Tool calls execute locally and results feed back into the loop with no step cap by default (optional cap via `ATOM_MAX_TOOL_STEPS`, clamped 5-100).

See [Sessions](sessions.md), [Compaction](compaction.md), and [Permissions](permissions.md) for the systems behind these commands.
