# Compaction and Token Display

Claude-Code and opencode-style context management (`src/compact.ts`, `src/context-windows.ts`).

## Auto-compact

Triggers at about 83% of the model verified context window:

- Threshold fraction default `0.83`
- Env `ATOM_COMPACT_PCT` is a percent (example `"83"`), clamped 50-95. Invalid or unset falls back to default
- Load metric: last POST reported `prompt_tokens` when available, else the 4 chars/token estimate of sent history chars
- No verified window for the model: never auto-compacts, never invents a window

## Manual compact

```text
/compact [focus text]
```

Summarizes older turns into one summary with tools disabled and a 4096 output cap. Optional focus text narrows the summary (example `/compact focus auth flow`).

Mechanics:

- Split history (after system) into head plus retained newest tail of whole user-turns up to about 8000 estimated tokens (chars/4)
- Tool outputs in the tail capped at 2000 chars each
- Always keeps at least the newest turn. When everything fits but there is more than one turn, keeps only the newest turn in the tail so manual compact still has an older turn to summarize
- Summary instruction uses fixed headings (omit a section only when empty): Objective, Requirements, Decisions, Completed work, Active work, Blockers, Next moves, Relevant files
- Rules line: no tools available for the request, answer with summary text only
- Swap is atomic plus saved. Size-overflow truncates head to budget once (drops oldest half of user-turns, preserves pairing) and retries once, then suggests `/clear`. Other failures throw with history untouched

Thrash guard: 3 consecutive failures disable auto-compact for the session.

## Token display

Exact footer format (`formatTokenSegment`):

- `token: n/a`: no usage reported yet. Never estimated
- `token: (P%) NK`: known window. NK is `round(total/1024)` plus `K` from cumulative session spend (`total_tokens`, else `prompt_tokens` plus `completion_tokens`). P is `round(100*load/window)` from current context load, not cumulative spend
- `token: NK`: unknown window. Bare total only
- Zero usage with known window: `token: (0%) 0K`. Without one: `token: 0K`

Cumulative spend keeps growing after compaction, so it must not drive P. Load does.

## Verified windows

Curated per-model map in `src/context-windows.ts` (build-time vendor docs, comments cite sources). Missing models render without a percent. Examples from the map: DeepSeek V4 family 1M, Kimi K2.6 256K, GLM-5.2 1M, GPT-6/GPT-5.6 1.05M, Gemini 3 family about 1M. Read the file for the full table; do not assume a window for unlisted models.

Related: [Sessions](sessions.md) for persistence, [CLI](cli.md) for the footer, [Configuration](configuration.md) for `ATOM_COMPACT_PCT`.
