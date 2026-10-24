# Compaction and Token Display

Claude-Code and opencode-style context management (`src/compact.ts`, `src/context-windows.ts`, `src/context-manager.ts`). History budgets derive from the model window (see [Configuration](configuration.md)); compaction mechanics below are unchanged.

## Auto-compact

Triggers at about 83% of the model verified context window:

- Threshold fraction default `0.83`
- Env `ATOM_COMPACT_PCT` is a percent (example `"83"`), clamped 50-95. Invalid or unset falls back to default
- Load metric: last POST reported input-side tokens (prompt counts normalized to include exclusive prefix-cache counters like Anthropic's `cache_read`/`cache_creation`) when available, else the 4 chars/token estimate of sent history chars
- No verified window for the model: never auto-compacts, never invents a window

### Pre-guard (pre-request compact)

Before the first POST of each turn, the submit path estimates the pending context size (history chars → tokens via the 4ch heuristic) and checks `shouldPreCompactForPending` against the model's usable limit. When the estimate reaches the limit, compaction runs *before* the POST fires — the doomed request never fires in the first place. The gate respects `compactAuto=false` (pre-guard suppressed, same semantics as overflow recovery).

### Overflow recovery

When a POST fails with a size error (HTTP 413, context-overflow messages), `shouldCompactOnSizeError` gates recovery: if auto is on, the turn's user message is rolled back and `doCompact` runs with overflow semantics (auto=true, so the thrash guard applies). On success the session continues; on failure the error surfaces. When `compactAuto=false` the error idles with no compaction.

### Config knobs

| Knob | Env var | atom.json key | Effect |
|---|---|---|---|
| Tail token budget | `ATOM_COMPACT_PRESERVE_RECENT_TOKENS` | `compactPreserveRecentTokens` | Override the default tail budget (25% of model window, 2K–15K band). Clamped 2000–50000. When set, replaces the default `COMPACT_KEEP_TOKENS` (20000). |
| Tail turn-count cap | `ATOM_COMPACT_TAIL_TURNS` | `compactTailTurns` | Maximum user turns retained in the tail. Integer ≥ 0. When set, the tail never contains more turns than this — excess older turns move into the head for summarization. |
| Prune old tool outputs | `ATOM_COMPACT_PRUNE` | `compactPrune` | Boolean (default off). When on, bulky tool outputs in the head (outside the protected tail) collapse to `[truncated: old tool output cleared]` before the summarization POST, keeping the request small. Off by default; enable via `ATOM_COMPACT_PRUNE=1` or `"compactPrune": true` in atom.json. |

## Manual compact

```text
/compact [focus text]
```

Summarizes older turns into one summary with tools disabled and a 4096 output cap. Optional focus text narrows the summary (example `/compact focus auth flow`).

Mechanics:

- Split history (after system) into head plus retained newest tail of whole user-turns up to about 20000 estimated tokens (chars/4)
- Tool outputs in the tail capped at 2000 chars each
- Always keeps at least the newest turn. When everything fits but there is more than one turn, keeps only the newest turn in the tail so manual compact still has an older turn to summarize
- Summary instruction uses fixed headings (omit a section only when empty): Objective, Important Details, Work State (Completed, Active, Blocked), Next Move, Relevant Files
- Rules line: no tools available for the request, answer with summary text only
- Swap is atomic plus saved. The summary header includes a retained-tail marker (`retained-tail N messages`) so the next request can distinguish retained tail from post-compact turns via `filterCompactedForModel`. Size-overflow truncates head to budget once (drops oldest half of user-turns, preserves pairing) and retries once, then suggests `/clear`. Other failures throw with history untouched
- Touched files: the compacted summary records the head's read/modified paths (collected from the committed tool calls the loop already recorded — no new tracking), appended as a `Touched files:` block (`Read:` / `Modified:` lines). Over-budget lists shrink oldest-first to the summary budget instead of failing compaction; the model text is never cut. `/resume` surfaces the stored block verbatim
- Goal block: when a goal is live, compaction appends a `Goal:` line (objective, state, cumulative stats, open todos) to the summary as context for the continued run. Restore still rides the persisted session record (`goal` field, see [Sessions](sessions.md)) — the `Goal:` text keeps the objective visible in history without re-exploring the tree

Thrash guard: 3 auto-compactions without the load dropping below threshold disables auto for the session (manual `/compact` still works and resets the counter on success).

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
