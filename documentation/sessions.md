# Sessions

Kill-safe persistence. A killed, crashed, or failed session keeps the last good save.

## File and shape

Path: `~/.atom/session.json` (`ATOM_HOME` overrides home). `0600` on POSIX, best-effort on Windows. Lives outside the repo, never commit it.

Shape (`src/session.ts`):

```text
{version:1, savedAt, provider, model, effort, mode, usageTotals, history, turns}
```

- `history`: full API history including system plus tool pairs
- `turns`: display transcript
- Writes are atomic (temp file plus rename) to survive kills mid-write
- Loads never throw: missing file is `missing`, anything malformed is `corrupt`. Caller shows a one-line notice and starts fresh

Privacy: the file can contain pasted secrets if typed as chat. Never print its contents.

## Save policy

Every completed turn and clean exit writes the file. Failed or cancelled turns roll back and never touch the file, so a bad turn cannot corrupt the last good save. Disk errors propagate to the caller, which ignores them; the in-memory session still applies.

## Commands

| Command | Effect |
|---|---|
| `/resume` | Restore the last saved session: turns, history, settings, usage |
| `/clear` | Clear conversation history. Keeps session token totals |
| `/rewind` | Restore files to a session checkpoint. Files only; shell side effects are never snapshotted |

`/rewind` details:

- Every `write`/`edit` takes a silent pre-mutation snapshot (`src/snapshots.ts`, `src/tools.ts`)
- Restore writes bytes behind the executors and refreshes (or forgets, on deletion) the stale-read fingerprint, so the next `edit` does not false-refuse
- Scope is file bytes only. Commands already run, packages installed, or external state changed by `bash` are not undone

## Token totals

`/clear` and compaction keep cumulative spend. The footer `NK` total keeps growing after compaction; the `P%` load tracks current context only. See [Compaction](compaction.md).
