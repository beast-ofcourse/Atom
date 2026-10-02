#!/usr/bin/env bash
# Test web UI and dashboard modes: --dashboard, --serve, --web.
# Usage: test-web-modes.sh
# Exit: 0 = all pass, 1 = one or more failures.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export MSYS_NO_PATHCONV=1

TOTAL=0
PASSED=0
FAILED=0
FAILED_TESTS=()

# --- Test 1: --dashboard ---
TOTAL=$((TOTAL + 1))
echo "=== Test: --dashboard ==="
ATOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/atom-web-test-XXXXXX")"
DASHBOARD_OUTPUT=$(cd "$ROOT" && ATOM_HOME="$ATOM_HOME" node dist/cli.js --dashboard 2>&1)
DASHBOARD_EXIT=$?
if [ $DASHBOARD_EXIT -eq 0 ]; then
  DASHBOARD_FILE=$(echo "$DASHBOARD_OUTPUT" | grep -oP '(?<=written to )[^ ]+')
  if [ -n "$DASHBOARD_FILE" ] && [ -f "$DASHBOARD_FILE" ]; then
    echo "  PASS: dashboard written to $DASHBOARD_FILE"
    PASSED=$((PASSED + 1))
  else
    echo "  FAIL: dashboard file not found in output: $DASHBOARD_OUTPUT"
    FAILED=$((FAILED + 1))
    FAILED_TESTS+=("dashboard")
  fi
else
  echo "  FAIL: --dashboard exited $DASHBOARD_EXIT: $DASHBOARD_OUTPUT"
  FAILED=$((FAILED + 1))
  FAILED_TESTS+=("dashboard")
fi
rm -rf "$ATOM_HOME"

# --- Test 2: --serve ---
TOTAL=$((TOTAL + 1))
echo "=== Test: --serve ==="
ATOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/atom-web-test-XXXXXX")"
cd "$ROOT"
ATOM_HOME="$ATOM_HOME" node dist/cli.js --serve --port 19300 &
SERVE_PID=$!
sleep 3
if curl -sf http://127.0.0.1:19300/api/health >/dev/null 2>&1; then
  echo "  PASS: serve health endpoint responding"
  PASSED=$((PASSED + 1))
else
  echo "  FAIL: serve health endpoint not responding"
  FAILED=$((FAILED + 1))
  FAILED_TESTS+=("serve")
fi
kill $SERVE_PID 2>/dev/null
wait $SERVE_PID 2>/dev/null
rm -rf "$ATOM_HOME"

# --- Test 3: --web ---
TOTAL=$((TOTAL + 1))
echo "=== Test: --web ==="
ATOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/atom-web-test-XXXXXX")"
ATOM_HOME="$ATOM_HOME" node dist/cli.js --web --port 19301 &
WEB_PID=$!
sleep 3
if curl -sf http://127.0.0.1:19301/api/health >/dev/null 2>&1; then
  echo "  PASS: web health endpoint responding"
  PASSED=$((PASSED + 1))
else
  echo "  FAIL: web health endpoint not responding"
  FAILED=$((FAILED + 1))
  FAILED_TESTS+=("web")
fi
kill $WEB_PID 2>/dev/null
wait $WEB_PID 2>/dev/null
rm -rf "$ATOM_HOME"

# --- Summary ---
echo ""
echo "=== Web Modes Summary ==="
echo "Total: $TOTAL  Passed: $PASSED  Failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo "Failed tests: ${FAILED_TESTS[*]}"
  exit 1
fi
echo "All web mode tests passed."
exit 0
