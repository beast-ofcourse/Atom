#!/usr/bin/env bash
# Regression runner: executes all step files and diffs frames against baselines.
# Usage: regress.sh [baseline-dir]
#   baseline-dir: known-good frames (default: runs/baseline)
# Exit: 0 = all pass, 1 = one or more failures.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS_ROOT="$(cd "$(dirname "$0")" && pwd)"
BASELINE="${1:-$ROOT/runs/baseline}"
export MSYS_NO_PATHCONV=1

if [ ! -d "$BASELINE" ]; then
  echo "Baseline directory not found: $BASELINE" >&2
  echo "Run a known-good pass first, then copy runs/<name> to runs/baseline/" >&2
  exit 1
fi

STEPS_DIR="$HARNESS_ROOT/steps"
RESULTS_DIR="$ROOT/runs/regress-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

TOTAL=0
PASSED=0
FAILED=0
FAILED_SCENARIOS=()

run_scenario() {
  local step_file="$1"
  local name
  name="$(basename "$step_file" .txt)"
  local out_dir="$RESULTS_DIR/$name"
  local baseline_dir="$BASELINE/$name"

  TOTAL=$((TOTAL + 1))
  echo "=== Running $name ==="

  if [ ! -d "$baseline_dir" ]; then
    echo "  SKIP: no baseline for $name"
    return
  fi

  bash "$HARNESS_ROOT/run.sh" "$step_file" "$out_dir" 2>&1
  local run_exit=$?

  if [ $run_exit -ne 0 ]; then
    echo "  FAIL: run.sh exited non-zero (assertions failed or error)"
    FAILED=$((FAILED + 1))
    FAILED_SCENARIOS+=("$name")
    return
  fi

  # Diff each frame against baseline
  local scenario_pass=true
  for baseline_frame in "$baseline_dir"/*.txt; do
    [ -f "$baseline_frame" ] || continue
    local frame_name
    frame_name="$(basename "$baseline_frame")"
    local result_frame="$out_dir/$frame_name"
    if [ ! -f "$result_frame" ]; then
      echo "  FAIL: missing frame $frame_name"
      scenario_pass=false
      continue
    fi
    if ! diff -q "$baseline_frame" "$result_frame" >/dev/null 2>&1; then
      echo "  FAIL: frame $frame_name differs"
      diff -u "$baseline_frame" "$result_frame" | head -30
      scenario_pass=false
    fi
  done

  if $scenario_pass; then
    echo "  PASS"
    PASSED=$((PASSED + 1))
  else
    echo "  FAIL: frame differences detected"
    FAILED=$((FAILED + 1))
    FAILED_SCENARIOS+=("$name")
  fi
}

# Run all step files
for step_file in "$STEPS_DIR"/*.txt; do
  [ -f "$step_file" ] || continue
  run_scenario "$step_file"
done

echo ""
echo "=== Regression Summary ==="
echo "Total: $TOTAL  Passed: $PASSED  Failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo "Failed scenarios: ${FAILED_SCENARIOS[*]}"
  echo "Results: $RESULTS_DIR"
  exit 1
fi
echo "All scenarios passed."
echo "Results: $RESULTS_DIR"
exit 0
