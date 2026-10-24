# Sessions

Kill-safe persistence. A killed, crashed, or failed session keeps the last good save.

## File and shape

Path: `~/.atom/session.json` (`ATOM_HOME` overrides home). `0600` on POSIX, best-effort on Windows. Lives outside the repo, never commit it.

Shape (`src/session.ts`):

```text
{version:1, savedAt, provider, model, effort, mode, usageTotals, history, turns, goal?}
```

- `history`: full API history including system plus tool pairs
- `turns`: display transcript
- `goal`: live session goal snapshot (`{objective, active, stats}`) when one is pinned; restored verbatim by `/resume` and session switches (see [Goals](goals.md)). Corrupt or absent goal data loads as no goal
- Writes are atomic (temp file plus rename) to survive kills mid-write
- Loads never throw: missing file is `missing`, anything malformed is `corrupt`. Caller shows a one-line notice and starts fresh

Privacy: the file can contain pasted secrets if typed as chat. Never print its contents.

## Save policy

Every completed turn and clean exit writes the file. Failed or cancelled turns roll back and never touch the file, so a bad turn cannot corrupt the last good save. Disk errors propagate to the caller, which ignores them; the in-memory session still applies.

## Rollback semantics (three scopes, not a transaction)

ATOM is a coding agent, not a database. Cancelling or failing a turn rolls the conversation back while the world it touched stays as it is. The contract lives in `src/rollback.ts` and is covered by `tests/rollback.test.ts`:

| Scope | Mode | Meaning |
|---|---|---|
| Conversation | Automatic | History/turns splice back to the turn start on cancel or POST failure; to a checkpoint mark on `/rewind` conversation scopes; to empty on `/clear`. Rolled-back turns never reach `session.json`. Tool *error results* are model-visible results and are never rolled back — only whole-turn cancel/failure |
| Filesystem | Explicit only | The sole filesystem rollback is an explicit `/rewind` restore (byte-exact, hash-verified — see below). Cancel and failure never revert disk. The cancelled-turn line says so outright: `(cancelled) conversation rolled back; files and processes were NOT reverted` |
| Process | Never | Foreground `bash` runs to completion (cancel stops the turn *after* the current tool finishes, never mid-exec). Background tasks are detached and survive cancel; nothing is ever killed. Shell side effects are not snapshotted and cannot be undone |

No global transactional shell execution exists by design — shell commands are outside every rollback scope.

Lineage rule: file checkpoints are bound to the history lineage they were captured in. `/clear`, `/new`, `/resume`, and compaction replace the history array and therefore discard all checkpoints (with a one-line notice when non-empty). Disk files are unaffected — only the undo evidence goes. Checkpoints are also never persisted: they are in-memory and do not survive a restart, so `/resume` in a fresh process starts with an empty picker.

Snapshot lifecycle notes:

- Creation: `write`/`edit` capture prior bytes *before* mutating, silently, with no prompt or config. Validation rejections (bad path, stale read, no match) return before capturing, so refused calls leave no checkpoint. A capture failure never fails the mutation it precedes — unless safety policy explicitly requires otherwise, which no current policy does.
- Restore: `restoreCheckpointFiles` verifies the snapshot hash *before* writing and re-verifies after; any failure is a loud `Error:` string and leaves the live file untouched. Restores refresh (or forget, on deletion) the stale-read fingerprint so the next `edit` does not false-refuse.
- Cleanup: at most 50 checkpoints (oldest evicted first); large-file temp copies are removed on eviction and on lineage drops; crash-leftover temp copies older than 24h are pruned on every new spill. In-memory buffers are bounded by the checkpoint cap.

## Commands

| Command | Effect |
|---|---|
| `/resume` | Restore the last saved session: turns, history, settings, usage, plus the live goal (text, state, cumulative stats) when one was saved. Re-surfaces the `Touched files:` lists stored in compacted summaries (same stored format), so the continued session knows what was touched without re-exploring the tree |
| `/clear` | Clear conversation history and end the live goal with a notice. Keeps session token totals |
| `/new` | Start a brand-new session (conversation plus counters reset, previous kept for `/resume`; the checklist restarts too; the live goal ends) |
| `/rename <name>` | Rename the current session only (id, `createdAt`, and history untouched; quotes optional: `/rename "name with spaces"`; bare `/rename` prints usage) |
| `/session [filter]` | Interactive session switcher: most-recent-first picker with fuzzy filter, `(current)` marker, turn counts, and relative ages. `Enter` switches, `Esc` cancels with the live session untouched |
| `/rewind` | Restore files to a session checkpoint. Files only; shell side effects are never snapshotted |

## Multiple persistent sessions (`src/sessions.ts`)

Every conversation automatically belongs to a durable session. One JSON record per session under `~/.atom/sessions/<id>.json` (`ATOM_HOME` overrides home), plus a plaintext `active` pointer holding the active session id. Same atomic-write and permission posture as `session.json` (temp file plus rename, `0600` POSIX best-effort); loads never throw (missing or malformed files read as absent and are skipped in listings). Provider/model-agnostic: the store never imports LLM clients.

Record shape:

```text
{id, title, createdAt, updatedAt, cwd, provider, model, effort, mode,
 usageTotals, history, turns, goal?, metadata}
```

- `id`: stable `ses_` identifier, never derived from the display name
- `title`: mutable display name. Fresh sessions default to the exact local creation date and time (`September 9, 2026 20:41:32`); `createdAt` stays a separate machine-readable ISO timestamp either way
- `updatedAt`: bumps on every meaningful mutation (completed turn, compaction, rename, settings/history write). Switching sessions is navigation, not a mutation, and never bumps it
- `history`/`turns`: the full conversation state, so reopening a session restores it exactly. No transient UI state is stored (scroll, cursor, pickers, queue never persist)

Session API (`createSession`, `getSession`, `listSessions`, `updateSession`, `renameSession`, `deleteSession`, `loadSession`, `saveSession`, `setActiveSession`, `getActiveSession`, plus `touchSession` and `ensureActiveSession`): listings sort most-recently-updated first, renames reject empty names without touching the record, and explicit ids that collide fall back to a fresh id instead of overwriting.

Switch semantics (see `switchToSession` in `src/App.tsx`): the outgoing live turns snapshot into their own record first (skipped when the live view holds no turns, so a fresh mount can never wipe a record); the target's history/turns then *replace* the live arrays wholesale — never merged, never duplicated — with provider/model/effort/mode, usage, title, and the legacy `session.json` mirror following the switch. In-memory lineage drops (file checkpoints, like `/resume` and `/new`) and the per-conversation TODO checklist resets (same as `/new`); scoped allow/deny rules, trust, and always-approvals are user settings and survive the switch, also like `/new`. A missing or unreadable target errors without touching the live session, and re-picking the current session is a no-op (reloading from disk would drop unpersisted live turns).

Restart behavior: records and the active pointer survive; the conversation itself never auto-restores (same philosophy as `/resume`) — pick the session in `/session` to continue exactly where it left off.

## Model memory across restarts

Your `/model`, `/provider`, and `/effort` picks persist automatically: every completed turn and clean exit saves them, and the next launch restores provider, model, and effort (plus the resolved key/endpoint) with a fresh conversation. The transcript itself only ever restores via an explicit `/resume`. Explicit config wins: `OPENCODE_ZEN_MODEL` beats the saved model when set. A saved provider whose key no longer resolves (revoked env/stored key) falls back to the Kilo default instead of stranding startup — except a saved Kilo session, which restores keyless on anonymous free models. A plain restart starts fresh otherwise (normal mode, empty counters); `/resume` additionally restores the saved mode and usage totals. Committed write/edit diff previews are display-only and stripped on save, so resumed transcripts are label-only.

`/rewind` details:

- Every `write`/`edit` takes a silent pre-mutation snapshot (`src/snapshots.ts`, executed in `src/tools/filesystem.ts`)
- Restore writes bytes behind the executors and refreshes (or forgets, on deletion) the stale-read fingerprint, so the next `edit` does not false-refuse
- Scope is file bytes only. Commands already run, packages installed, or external state changed by `bash` are not undone

## Token totals

`/clear` and compaction keep cumulative spend. The footer `NK` total keeps growing after compaction; the `P%` load tracks current context only. See [Compaction](compaction.md).
