#!/usr/bin/env bash
# TUI PTY harness driver. Usage: run.sh <steps-file> <out-dir>
# Launches dist/cli.js in tmux, replays steps, saves frames.
set -u
STEPS="$1"
OUT="$2"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="atom-harness-$$"

mkdir -p "$OUT"
export ATOM_HOME
ATOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/atom-harness-home-XXXXXX")"
export TERM=xterm-256color
# MSYS2/Git-Bash path conversion would rewrite leading-slash keystrokes
# (e.g. `/model` -> `C:/Program Files/Git/model`) in send-keys args.
export MSYS_NO_PATHCONV=1

tmux start-server >/dev/null 2>&1
tmux kill-session -t "$SESSION" >/dev/null 2>&1
HARNESS_ROOT="$(cd "$(dirname "$0")" && pwd)"
# tmux-windows splits unquoted paths on spaces (repo path has spaces) and
# cannot spawn compound commands: stage a space-free launcher instead.
# The tmux server does NOT inherit this shell's exports (it was started
# earlier and persists), so the pane env must be written into the staged
# launcher itself — otherwise the TUI reads the real ~/.atom (leak) and an
# uncontrolled TERM. Verified: staged-launcher env reaches the pane.
LAUNCHER="/tmp/atom-harness-launch-$$.sh"
printf '%s\n' '#!/usr/bin/env bash' "export ATOM_HOME=\"$ATOM_HOME\" TERM=xterm-256color MSYS_NO_PATHCONV=1" "cd \"$ROOT\" || exit 99" 'node dist/cli.js' 'echo "CLI_EXIT=$?"' 'sleep 30' > "$LAUNCHER"
# tmux-windows cannot spawn compound commands: launch via wrapper script.
tmux new-session -d -s "$SESSION" -x 100 -y 30 "bash $LAUNCHER"
sleep 4

{
  echo "root=$ROOT"
  echo "steps=$STEPS"
  echo "atom_home=$ATOM_HOME"
  echo "term=$TERM start_size=100x30"
  date -u +"started=%Y-%m-%dT%H:%M:%SZ"
} > "$OUT/meta.txt"

N=0
capture() {
  N=$((N + 1))
  local label="$1"
  local file
  file=$(printf "%s/%02d-%s.txt" "$OUT" "$N" "$label")
  {
    echo "--- frame $N label=$label size=$(tmux display-message -t "$SESSION" -p '#{pane_width}x#{pane_height}') ---"
    tmux capture-pane -t "$SESSION" -p
  } > "$file"
  echo "captured $file"
}

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ""|"#"*) continue ;;
    sleep*)
      set -- $line
      sleep "$2"
      ;;
    keys*)
      args="${line#keys }"
      # One action per line, sent as a single arg: key names (Enter,
      # Escape, C-p) still parse; free text (spaces incl.) stays intact.
      tmux send-keys -t "$SESSION" "$args"
      ;;
    resize*)
      # tmux-windows resize-pane is a no-op (returns 0, size unchanged).
      # Use `launch` (fresh session at a size) for narrow/wide coverage.
      set -- $line
      echo "resize unsupported on this tmux build — use launch <cols> <rows> instead" >&2
      ;;
    capture*)
      set -- $line
      capture "$2"
      ;;
    launch*)
      # relaunch TUI after an exit (e.g. post-interrupt): launch <cols> <rows>
      set -- $line
      tmux kill-session -t "$SESSION" >/dev/null 2>&1
      tmux new-session -d -s "$SESSION" -x "${2:-100}" -y "${3:-30}" "bash $LAUNCHER"
      sleep 4
      ;;
    *) echo "unknown step: $line" ;;
  esac
done < "$STEPS"

tmux capture-pane -t "$SESSION" -p -S - > "$OUT/session.log" 2>/dev/null
tmux kill-session -t "$SESSION" >/dev/null 2>&1
rm -f "$LAUNCHER"
date -u +"ended=%Y-%m-%dT%H:%M:%SZ" >> "$OUT/meta.txt"
echo "done: $OUT (home $ATOM_HOME kept for inspection)"
