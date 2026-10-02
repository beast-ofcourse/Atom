#!/usr/bin/env bash
# TUI PTY harness driver. Usage: run.sh <steps-file> <out-dir>
# Launches dist/cli.js in tmux, replays steps, saves frames.
set -u
STEPS="$1"
OUT="$2"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="atom-harness-$$"

# Detect tmux path (tmux-windows may not be in bash PATH)
TMUX="${HARNESS_TMUX:-$(command -v tmux 2>/dev/null || true)}"
if [ -z "$TMUX" ]; then
  for candidate in \
    "/c/Users/Bhavin/AppData/Local/Microsoft/WinGet/Packages/arndawg.tmux-windows_Microsoft.Winget.Source_8wekyb3d8bbwe/tmux.exe" \
    "/c/Program Files/tmux/tmux.exe" \
    "/usr/bin/tmux" \
    "/opt/homebrew/bin/tmux"; do
    if [ -x "$candidate" ]; then
      TMUX="$candidate"
      break
    fi
  done
fi
if [ -z "$TMUX" ]; then
  echo "ERROR: tmux not found. Install tmux or add it to PATH." >&2
  exit 1
fi

mkdir -p "$OUT"
export ATOM_HOME
ATOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/atom-harness-home-XXXXXX")"
export TERM=xterm-256color
export MSYS_NO_PATHCONV=1

"$TMUX" start-server >/dev/null 2>&1
"$TMUX" kill-session -t "$SESSION" >/dev/null 2>&1
HARNESS_ROOT="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="/tmp/atom-harness-launch-$$.sh"
printf '%s\n' '#!/usr/bin/env bash' "export ATOM_HOME=\"$ATOM_HOME\" TERM=xterm-256color MSYS_NO_PATHCONV=1" "cd \"$ROOT\" || exit 99" 'node dist/cli.js' 'echo "CLI_EXIT=$?"' 'sleep 30' > "$LAUNCHER"
"$TMUX" new-session -d -s "$SESSION" -x 100 -y 30 "bash $LAUNCHER"
sleep 4

echo "root=$ROOT" > "$OUT/meta.txt"
echo "steps=$STEPS" >> "$OUT/meta.txt"
echo "atom_home=$ATOM_HOME" >> "$OUT/meta.txt"
echo "term=$TERM start_size=100x30" >> "$OUT/meta.txt"
date -u +"started=%Y-%m-%dT%H:%M:%SZ" >> "$OUT/meta.txt"

N=0
capture() {
  N=$((N + 1))
  local label="$1"
  local file
  file=$(printf "%s/%02d-%s.txt" "$OUT" "$N" "$label")
  {
    echo "--- frame $N label=$label size=$("$TMUX" display-message -t "$SESSION" -p '#{pane_width}x#{pane_height}') ---"
    "$TMUX" capture-pane -t "$SESSION" -p
  } > "$file"
  echo "captured $file"
}

# --- Extended commands ---

FAILURES=0

waitFor() {
  local label="$1"
  local timeout="${2:-30}"
  local stable=0
  local last=""
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local current
    current=$("$TMUX" capture-pane -t "$SESSION" -p 2>/dev/null)
    if [ "$current" = "$last" ]; then
      stable=$((stable + 1))
      if [ "$stable" -ge 3 ]; then
        echo "waitFor: $label stable after ${elapsed}s"
        return 0
      fi
    else
      stable=0
    fi
    last="$current"
    sleep 0.5
    elapsed=$((elapsed + 1))
  done
  echo "waitFor: $label TIMEOUT after ${timeout}s" >&2
  return 1
}

screenshot() {
  local label="$1"
  local file
  file=$(printf "%s/%02d-%s.ansi.txt" "$OUT" "$((N + 1))" "$label")
  {
    echo "--- frame $((N + 1)) label=$label size=$("$TMUX" display-message -t "$SESSION" -p '#{pane_width}x#{pane_height}') ---"
    "$TMUX" capture-pane -t "$SESSION" -e -p
  } > "$file"
  N=$((N + 1))
  echo "screenshot $file"
}

assertNeedle() {
  local label="$1"
  local needle="$2"
  local output
  output=$("$TMUX" capture-pane -t "$SESSION" -p 2>/dev/null)
  if printf '%s' "$output" | grep -qF -- "$needle"; then
    echo "assert: $label PASS (found '$needle')"
  else
    echo "assert: $label FAIL (missing '$needle')" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

assertAbsent() {
  local label="$1"
  local needle="$2"
  local output
  output=$("$TMUX" capture-pane -t "$SESSION" -p 2>/dev/null)
  if printf '%s' "$output" | grep -qF -- "$needle"; then
    echo "assertNot: $label FAIL (found '$needle')" >&2
    FAILURES=$((FAILURES + 1))
  else
    echo "assertNot: $label PASS (absent '$needle')"
  fi
}

doType() {
  local text="$1"
  local i
  for ((i = 0; i < ${#text}; i++)); do
    local char="${text:$i:1}"
    "$TMUX" send-keys -t "$SESSION" -- "$char"
    sleep 0.02
  done
}

doPaste() {
  local text="$1"
  "$TMUX" set-buffer -- "$text" 2>/dev/null && "$TMUX" paste-buffer -t "$SESSION" 2>/dev/null
  if [ $? -ne 0 ]; then
    "$TMUX" send-keys -t "$SESSION" -- "$text"
  fi
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
      "$TMUX" send-keys -t "$SESSION" "$args"
      ;;
    resize*)
      set -- $line
      echo "resize unsupported on this tmux build — use launch <cols> <rows> instead" >&2
      ;;
    capture*)
      set -- $line
      capture "$2"
      ;;
    launch*)
      set -- $line
      "$TMUX" kill-session -t "$SESSION" >/dev/null 2>&1
      "$TMUX" new-session -d -s "$SESSION" -x "${2:-100}" -y "${3:-30}" "bash $LAUNCHER"
      sleep 4
      ;;
    waitFor*)
      set -- $line
      waitFor "$2" "${3:-30}"
      ;;
    screenshot*)
      set -- $line
      screenshot "$2"
      ;;
    assertNot*)
      set -- $line
      assertAbsent "$2" "$3"
      ;;
    assert*)
      set -- $line
      assertNeedle "$2" "$3"
      ;;
    type*)
      args="${line#type }"
      doType "$args"
      ;;
    paste*)
      args="${line#paste }"
      doPaste "$args"
      ;;
    *) echo "unknown step: $line" ;;
  esac
done < "$STEPS"

if [ "$FAILURES" -gt 0 ]; then
  echo "FAILED: $FAILURES assertion(s) failed" >&2
  "$TMUX" capture-pane -t "$SESSION" -p -S - > "$OUT/session.log" 2>/dev/null
  "$TMUX" kill-session -t "$SESSION" >/dev/null 2>&1
  rm -f "$LAUNCHER"
  date -u +"ended=%Y-%m-%dT%H:%M:%SZ" >> "$OUT/meta.txt"
  exit 1
fi
echo "ALL ASSERTIONS PASSED"

"$TMUX" capture-pane -t "$SESSION" -p -S - > "$OUT/session.log" 2>/dev/null
"$TMUX" kill-session -t "$SESSION" >/dev/null 2>&1
rm -f "$LAUNCHER"
date -u +"ended=%Y-%m-%dT%H:%M:%SZ" >> "$OUT/meta.txt"
echo "done: $OUT (home $ATOM_HOME kept for inspection)"
