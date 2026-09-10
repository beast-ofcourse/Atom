# Configuration

All knobs, files, and prompt layering in one place. Env vars win over stored keys. Nothing here requires code changes.

## Environment variables

Template lives in `.env.example`. Never commit a real key.

| Variable | Purpose | Default |
|---|---|---|
| `KILO_API_KEY` | Kilo key (optional — free models work anonymously). Wins over stored Kilo key | none (Kilo free models still chat; `/provider` shows the key as optional) |
| `OPENCODE_ZEN_API_KEY` | Zen key. Wins over stored zen key | none (TUI still starts, chat errors inline with a `/provider` pointer) |
| `OPENCODE_ZEN_MODEL` | Zen model id | `deepseek-v4-pro` |
| `OPENCODE_ZEN_ENDPOINT` | Zen endpoint override | `https://opencode.ai/zen/v1/chat/completions` |
| `OPENCODE_AGENTS_PATH` | Override for the AGENTS.md appended to the system prompt | `<cwd>/AGENTS.md` |
| `OPENAI_API_KEY` | OpenAI key (env wins over stored) | none |
| `ANTHROPIC_API_KEY` | Anthropic key | none |
| `DEEPSEEK_API_KEY` | DeepSeek key | none |
| `MISTRAL_API_KEY` | Mistral key | none |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini key (either accepted, first non-empty wins) | none |
| `ATOM_COMPACT_PCT` | Auto-compact percent, clamped 50-95 | `83` (about 83% of verified window) |
| `ATOM_MAX_TOOL_STEPS` | Tool rounds per turn, clamped 5-100 | `30` |
| `ATOM_HOME` | Override home for `~/.atom/` files (auth, session) | OS homedir |
| `ATOM_TELEMETRY` | Local observability recording (`0`/`false`/`no`/`off` disables; `1`/`true`/`yes`/`on` forces on) | on (wins over `atom.json`) |
| `ATOM_TELEMETRY_PORT` | Pinned port for the observability webUI (`atom --serve`; `--port` wins over this) | ephemeral (OS-assigned, printed on start) |

`openai-compatible` uses stored key plus baseURL only. No env vars.

## atom.json config file

Template lives in `atom.example.json`. Two levels, merged per key (project wins over global):

- Project: `<cwd>/atom.json`
- Global: `~/.atom/atom.json` (`ATOM_HOME` overrides home)

Precedence overall: env vars > saved session picks (`/model`, `/provider`, `/effort`) > project `atom.json` > global `atom.json` > compiled defaults. So `atom.json` sets first-run and project defaults; a later explicit pick (saved each turn and on exit) still wins across restarts; env always wins.

| Key | Purpose | Range / values |
|---|---|---|
| `provider` | First-run default provider (needs its key, except keyless Kilo/local) | known provider id |
| `model` | Default model id | non-empty string |
| `reasoningEffort` | Default reasoning effort | `default`/`low`/`medium`/`high`/`max` |
| `maxHistoryMessages` | History message-count safety ceiling | 10-1000 (default 100) |
| `maxHistoryChars` | History char safety ceiling (caps the derived budget, never the primary limit) | 10_000-2_000_000 (default 200_000) |
| `maxToolSteps` | Tool rounds per turn | 5-100 (default 30) |
| `compactPct` | Auto-compact percent of verified window | 50-95 (default 83) |
| `network` | Webfetch SSRF policy: which network zones the model may retrieve | object with boolean `allowPublic` (default true), `allowLocalhost` (default true), `allowPrivate` (default false), `allowLinkLocal` (default false) |
| `telemetry` | Local observability recording (see [Observability](observability.md)) | `{enabled?: boolean}` (default on; `ATOM_TELEMETRY=0` wins) |

Missing files are normal and silent. Unknown keys are ignored; invalid values fall back per key with warnings surfaced in `/context`. Reads are fresh per call, so edits apply without restart. Never commit keys here (there are no key fields — keys stay in env/`auth.json`).

Example: open the LAN but keep cloud metadata closed:

```json
{ "network": { "allowPrivate": true } }
```

## Context budget (`src/context-manager.ts`)

The `ContextManager` is the single place answering: how much context is available, how much is used, should we compact, what gets sent. History allowance derives from the model's verified window:

```text
available history = window − system prompt − tool definitions
                    − output reserve (4096 tok) − safety margin (5%)
```

- Known-window models (256K, 1M, …) use their real windows — no fixed 200K-char assumption.
- Accounting is incremental: the `ContextLedger` (`trackHistory` in `src/context-manager.ts`) keeps exact running counters (messages, chars, est. tokens, system/tool chars, per-role counts) across pushes, splices, and replacements — per-step reads are O(1) instead of rescanning history. `verifyLedger` diffs counters against an independent scan (tests enforce it; exact provider-reported usage stays separate in the token totals).
- See `/context` for the live per-source breakdown and [Compaction](compaction.md) for the trigger mechanics.

## Auth file

`~/.atom/auth.json` (`ATOM_HOME` overrides home):

```json
{
  "version": 1,
  "providers": {
    "<id>": { "apiKey": "...", "baseURL?": "..." }
  }
}
```

`0600` on POSIX, best-effort on Windows. Missing or corrupt loads as empty auth. Save via `/provider` paste flow; resolution is env-first per provider. See [Providers](providers.md).

## Session file

`~/.atom/session.json`, version 1, atomic temp-plus-rename saves, `0600` POSIX. See [Sessions](sessions.md).

## AGENTS.md and system prompt

Final system prompt is two layers (`src/system.ts`, `src/zen.ts`):

```text
<base one-liner from src/system.ts> + "\n\n" + <repo AGENTS.md>
```

- Base identity: long-horizon coding agent loop (explore, plan with todowrite for 3 or more steps, implement, verify with tests and typecheck, report with evidence)
- Repo overlay: `AGENTS.md` in cwd, or `OPENCODE_AGENTS_PATH` override. Capped at 12KB
- To change bot identity, edit the one-liner. To add project instructions, edit `AGENTS.md`

ATOM loads the project `AGENTS.md` at startup so it knows tools, rules, and permission model. This repo own instructions live in `AGENTS.md` at the root.

## Context windows

Curated map in `src/context-windows.ts`. Drives the footer percent and auto-compact threshold. Never invented for unlisted models. See [Compaction](compaction.md).
