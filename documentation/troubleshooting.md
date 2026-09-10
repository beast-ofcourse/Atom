# Troubleshooting

What to check first, in order. No guessing: verify with the command or file cited.

## No key / auth errors

Symptom: chat errors inline with a `/provider` pointer, or provider HTTP 401.

1. Check env wins over stored: `KILO_API_KEY` (optional — Kilo free models work without it), `OPENCODE_ZEN_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). Kilo failures print short messages: anonymous 429 means the free-model limit (`Kilo: anonymous free-model rate limit reached.`), 401 means a bad Kilo key, 404 means the model left the catalog (pick another via `/model`)
2. Run `/provider`, repaste the key. Validated before storage in `~/.atom/auth.json` (`0600` POSIX)
3. Keys display masked (last4 only). If you see `(no key)`, nothing resolved for that provider
4. `openai-compatible` is stored-only. Confirm both stored key and stored baseURL (must be http/https)

Never print full keys, never commit them, never put them in fixtures.

## Model list fails

`/model` falls back to the offline list when the live `/models` call fails (Kilo falls back to the `kilo-auto/free` routing placeholder). That is expected offline. Check endpoint override (`OPENCODE_ZEN_ENDPOINT`), network, and key validity before assuming a bug. While Kilo is active, `/models refresh` re-fetches the gateway catalog.

`reasoning_effort` is sent only for opencode-zen supported models. Elsewhere it is stored but never sent.

## Tool approval confusion

- `/mode` prints the current mode. `Tab` cycles normal → yolo → plan → normal (`/yolo` and `/plan` are retired as typed commands)
- `/trust` toggles session trust (`+trust` in status). Again revokes
- `/rules` lists allow/deny rules. Deny wins over trust, yolo, always, and skill grants
- A denial returns the standard denial result. Do not retry the same call; replan
- `read` before `edit`: `edit` refuses with a stale-read error when the file changed since the last read. Read again, then edit

See [Permissions](permissions.md) and [Tools](tools.md).

## Session and compact issues

- `/resume` reports missing or corrupt: `~/.atom/session.json` is absent or malformed. Caller starts fresh with a one-line notice. Only completed turns save, so a failed turn never clobbers the last good save
- Compact failures suggest `/clear`. Overflow retries once after dropping the oldest half of user-turns. Thrash guard disables auto-compact after 3 auto-compactions without the load dropping below threshold
- `token: n/a` means no usage reported yet. Not an error
- Bare `token: NK` means the model has no verified window in `src/context-windows.ts`. Not an error

See [Sessions](sessions.md) and [Compaction](compaction.md).

## Web tools blocked

- `websearch` may return `Error: websearch blocked by DuckDuckGo bot protection (HTTP 403; best-effort search — retry later)`. Retry later; the endpoint is best-effort
- `webfetch` upgrades http to https (noted), allows only http/https, caps downloads at about 1MB and output at about 64KB. Large pages spill to an overflow file with a `read` pointer

## TUI does not start

- `npm start` needs a TTY. Run in an interactive terminal, not a piped script
- Check Node `>=18` and a clean `npm install`
- `atom --help` should print usage without starting the TUI. If that fails, check `npm run build` and `npm run typecheck` output first

## Reporting a bug

Include: command run, provider and model from the status line, token segment text, approval mode, full error string (shortest decisive line, not a dump), and what `npm test` plus `npm run typecheck` report.
