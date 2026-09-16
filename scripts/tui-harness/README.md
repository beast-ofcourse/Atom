# ATOM TUI interaction harness (tmux PTY driver, zero new deps)

Real-PTY runs of the built TUI (`dist/cli.js`) for observe-fix cycles:
boot it in a pseudo-terminal, drive it like a user (typing, pickers,
palette, resizes, interrupts, errors, live model turns), capture what it
actually renders, fix what looks wrong, re-run to prove the fix.

`ink-testing-library` suites cover components in-process. This harness
covers what they cannot: the full TUI in a real terminal — layout at real
widths, streaming paint over time, interrupts, multi-turn sessions, and
the exact bytes a user sees.

## Quickstart for a new agent

```sh
# 0. Build first — the harness runs dist/, not src/.
npm run build

# 1. Run a scenario (replay steps, save frames to runs/<name>/).
bash scripts/tui-harness/run.sh scripts/tui-harness/steps/cycle1-baseline.txt runs/my-first-run

# 2. Read the frames (plain text, one per capture + size header).
ls runs/my-first-run/
cat runs/my-first-run/01-boot.txt

# 3. Compare before/after a fix.
diff -u runs/before/06-narrow.txt runs/after/06-narrow.txt
```

One full cycle takes ~1–3 minutes. A scenario that includes a live model
turn needs network (kilo free models, no key); everything else runs offline
(model list falls back to the offline placeholder, which is itself worth
observing).

## Layout

- `run.sh` — driver. Creates an isolated `ATOM_HOME` (temp dir, so the run
  never touches the real `~/.atom`), stages a launcher, boots the TUI in a
  tmux session, replays a steps file line by line, saves frames.
- `launch.sh` — legacy simple launcher (kept for manual debugging:
  `tmux new-session -d -s dbg -x 100 -y 30 "bash scripts/tui-harness/launch.sh"`).
  `run.sh` generates its own staged launcher per run instead (see quirks).
- `steps/` — replay scripts, one per scenario:
  - `cycle1-baseline.txt` — boot, slash menu, typing, palette, `/help`,
    narrow/wide/back sizes.
  - `cycle1b-pickers-errors.txt` — model picker, `/tools`, `/context`,
    thinking toggle, rapid typing, Ctrl+C exit + relaunch at sizes.
  - `cycle2-stress.txt` — live kilo-free turn, busy capture, long output,
    Escape-cancel mid-stream.
  - `cycle3-views.txt` — inspector, usage ledger, palette filter, error
    notices, 45-col idle/busy/done floors.
- `runs/` (repo root, gitignored-or-not — check before committing) —
  per-run output: `NN-<label>.txt` frames, `session.log` (full pane
  history), `meta.txt` (env, sizes, timing), plus `*-defects.md` logs.
- This `README.md` — the contract you are reading.

## Steps file format (line-based, deterministic)

- `# comment` — ignored.
- `sleep <secs>` — wait for render settle / model streaming.
- `keys <single tmux send-keys arg>` — exactly one action per line:
  `keys /model`, `keys Enter`, `keys Escape`, `keys C-p`, `keys C-c`,
  or free text: `keys hello world with spaces`.
  Key names (`Enter`, `Escape`, `C-p`, `C-o`, `C-u`) still parse as keys;
  anything else types literally, spaces included.
- `launch <cols> <rows>` — kill the session, boot a fresh TUI at that size.
  Used for narrow/wide coverage AND after an intentional exit (Ctrl+C on
  idle exits the TUI, so interrupt scenarios relaunch after it).
- `capture <label>` — save the current frame to `NN-<label>.txt`,
  prefixed with a `--- frame N label=X size=WxH ---` header.
- `resize <cols> <rows>` — DECLARED BUT NON-FUNCTIONAL on tmux-windows
  (silently ignored, warns on stderr). Always use `launch` instead.

Replay determinism rests on four pins (all handled by `run.sh`, verify
them if frames look alien): `TERM=xterm-256color`, fixed session size
(100x30 unless `launch`ed otherwise), isolated `ATOM_HOME`, and the
`MSYS_NO_PATHCONV=1` guard below.

## tmux-windows quirks (all learned the hard way, all handled)

This repo is usually driven from Git Bash on Windows, where tmux is the
`tmux-windows` port (`tmux 3.6a-win32`). It differs from POSIX tmux:

1. **No compound commands.** `new-session "cd X && node …"` kills the pane
   instantly (`create window failed: spawn failed`). Fix: boot via a
   wrapper **script file**, never an inline shell command.
2. **Spaces split paths.** The repo path contains spaces
   (`Opensource porjects`), which tmux splits even inside quotes. Fix:
   `run.sh` stages a space-free launcher at `/tmp/atom-harness-launch-*.sh`
   with the repo path baked in, and invokes that.
3. **MSYS path conversion.** Git Bash rewrites leading-slash arguments:
   `send-keys … /model` arrived as `C:/Program Files/Git/model`.
   Fix: `export MSYS_NO_PATHCONV=1` before invoking tmux.
4. **Server ignores exporter env.** The persistent tmux server does not
   inherit `run.sh`'s exports, so `ATOM_HOME`/`TERM` set in the driver
   never reach the pane (early runs silently read the developer's real
   `~/.atom`). Fix: the staged launcher carries
   `export ATOM_HOME=… TERM=… MSYS_NO_PATHCONV=1` lines itself.
   Verify isolation per run: a fresh boot must show NO session hint and
   the run's `ATOM_HOME` must stay yours to inspect.
5. **resize-pane is a no-op.** Returns 0, size unchanged. Verified empirically.
   Narrow/wide coverage goes through `launch W H` (size at creation works).
6. **Word-splitting in `keys`.** Passing send-keys args unquoted ate spaces
   and left stray quote characters in the input. Fix: one quoted arg per
   line; write free text in steps files WITHOUT surrounding quotes.

If you port this harness to Linux/macOS: 1–3 and 5 likely vanish (real
tmux), 4 and 6 stay relevant everywhere.

## The observe-fix workflow (what the 3 completed cycles did)

1. **Inspect** the implementation (`src/ui/*`, `src/App.tsx` footer zone).
2. **Run** an existing scenario, or write a new `steps/*.txt` for the
   behavior under test (one concern per scenario; keep sleeps generous —
   model turns vary).
3. **Read every frame.** Look for: wrapped/split status segments, dividers
   floating mid-screen, stale hints, missing/extra lines vs the design
   system (`src/ui/theme.ts` — pinned symbols/text must stay byte-identical).
4. **Log defects** in `runs/cycleN-defects.md`: what, which frame, before
   behavior. Distinguish TUI defects from harness artifacts (quoting,
   timing, MSYS) — half the Cycle 1 log was harness bugs.
5. **Fix minimal.** Prefer yield/drop rules (location → goal → reasoning →
   provider-prefix → xs floors) over redesign; never change pinned text
   (`you>`, `ATOM>`, `⚙ name target`, `Queued (N):`, `mode: X`, …) —
   suites pin them and *will* catch you (two Cycle 2/3 regressions proved it).
6. **Rebuild** (`npm run build` — harness runs `dist/`, easy to forget).
7. **Re-run** the same scenario into `runs/<name>-after/` and `diff` frames.
8. **Run targeted vitest suites** for every touched leaf
   (e.g. `status-bar`, `footer-cluster`, `scrollback`, `queue-steer`,
   `thinking-separation`), then `npx tsc --noEmit`.
9. **Triage any failure against HEAD**: `git stash push <files>`, run the
   failing suite, `git stash pop`. Pre-existing fails stay; new fails are
   yours. Full-suite failures under contention are often flakes — rerun
   isolated before believing them.

## What the cycles already proved (don't re-learn it)

- Cycle 1: floating `HeaderBar` removed (status bar already carries
  model/cwd); idle status reasoning-yield at ≤60 cols; harness bugs 1–6.
- Cycle 2: busy-line wrap split the `Enter queues` hint — which was also
  the root cause of the `footer-cluster` storm failure (proven by reverting
  only `status-bar.tsx`: fail → re-apply: 4x green).
- Cycle 3: `<50`-col floors (`model │ mode`, busy adds `esc stops`);
  inspector/ledger/palette-filter/error views verified; full suite triaged
  (remaining failures reproduce at HEAD: timing suites + a goal-segment
  test that renders a 154-char line where ink-testing-library wraps at 100).
- `src/web/ui/app.js` innerHTML lint findings are byte-identical to HEAD
  and out of scope — do not "fix" them inside a TUI cycle.

## Verification contract (per goal)

- `npx tsc --noEmit` clean.
- Targeted suites green: `app`, `status-bar`, `footer-cluster`,
  `core-transcript`, `markdown`, `input-area`, `palette`,
  `streaming-polish`, `kilo`, `prefs-restore`, `thinking-separation`,
  `queue-steer`, `turn-boundary-drain`.
- Full `npx vitest run` before sign-off; every failure triaged vs HEAD.
- Never commit/push without an explicit user "yes approved".
