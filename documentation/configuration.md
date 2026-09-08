# Configuration

All knobs, files, and prompt layering in one place. Env vars win over stored keys. Nothing here requires code changes.

## Environment variables

Template lives in `.env.example`. Never commit a real key.

| Variable | Purpose | Default |
|---|---|---|
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

`openai-compatible` uses stored key plus baseURL only. No env vars.

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
