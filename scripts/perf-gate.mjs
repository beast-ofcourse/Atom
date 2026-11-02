// Perf gate (Extreme-fast Phase 5.1 + Performance Gate v2 tasks 0A-0D): hard
// budgets over the render, tool, loop, footprint, boot, heap and first-token
// benches. Requires `npm run build` first.
// Usage: npm run perf-gate (requires `npm run build` first).
// Fails non-zero with a table when any budget breaks. Render deltas compare
// against scripts/perf-baseline.json (config A, post-widget-chrome).
// keyP rows are HARD budgets (enforced 2026-10-29: see gate note + 1C).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baseline = JSON.parse(readFileSync(path.join(root, "scripts", "perf-baseline.json"), "utf8"));

function run(script, args = []) {
  const out = execFileSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 570000,
    windowsHide: true,
  });
  return out;
}

function jsonLines(out) {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"))
    .map((l) => JSON.parse(l));
}

const failures = [];
const notes = [];
function check(name, actual, limit, unit = "") {
  // Loud mismatch beats silent math: a missing/undefined/null metric (a bench
  // that broke its output shape) must FAIL, not slip through coercion —
  // JS would otherwise treat null ≤ limit as true.
  if (typeof actual !== "number" || Number.isNaN(actual)) {
    failures.push(`FAIL ${name}: metric missing or non-numeric (got ${JSON.stringify(actual)})`);
    return false;
  }
  const ok = actual <= limit;
  (ok ? notes : failures).push(`${ok ? "PASS" : "FAIL"} ${name}: ${actual}${unit} (budget ≤ ${limit}${unit})`);
  return ok;
}

// ---- render gate (config A vs baseline +10%) ----
// Render benches are timing-sensitive (paint coalescing, machine load —
// the `long` scenario measured 41606 and 57825 bytes hours apart with zero
// code change). Median-of-3 per scenario absorbs the drift; budgets still
// catch systematic regressions.
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const renderRuns = [];
for (let i = 0; i < 3; i++) {
  const out = run("bench-render.mjs", ["all", "A"]);
  renderRuns.push(JSON.parse(out.slice(out.indexOf("\n["))));
}
const renderRows = [];
for (const row0 of renderRuns[0]) {
  const group = renderRuns.map((run) => run.find((r) => r.config === row0.config && r.scenario === row0.scenario));
  if (group.some((r) => r === undefined)) continue;
  renderRows.push({
    config: row0.config,
    scenario: row0.scenario,
    bytes: median(group.map((r) => r.bytes)),
    clears: median(group.map((r) => r.clears)),
    avgRenderMs: median(group.map((r) => r.avgRenderMs)),
    keyP50ms: median(group.map((r) => r.keyP50ms ?? Infinity)),
    keyP95ms: median(group.map((r) => r.keyP95ms ?? Infinity)),
  });
}
for (const [scen, base] of Object.entries(baseline.render)) {
  const row = renderRows.find((r) => r.config === "A" && r.scenario === scen);
  if (!row) {
    failures.push(`FAIL render ${scen}: scenario missing from bench output`);
    continue;
  }
  for (const metric of ["bytes", "clears", "avgRenderMs"]) {
    // clears are frame-geometry noise (±2 run-to-run on small absolutes —
    // win32 clears whenever the frame fills the viewport, see cli comment).
    // avgRenderMs sits near 2 ms absolute where ±0.5 ms machine noise dwarfs
    // a percentage, so it carries +0.75 ms slack (a true 2× render blowup
    // still fails).
    const slack = metric === "clears" ? 2 : metric === "avgRenderMs" ? 0.75 : base[metric] === 0 ? 1 : 0;
    const limit = base[metric] * 1.1 + slack;
    const actual = metric === "avgRenderMs" ? +row[metric].toFixed(2) : row[metric];
    check(`render ${scen} ${metric}`, actual, +limit.toFixed(2), metric === "avgRenderMs" ? "ms" : "");
  }
}
const inputRow = renderRows.find((r) => r.config === "A" && r.scenario === "input");
// ---- keystroke-to-paint gate (plan Phase 1, ticket 1C) ----
// Enforced since the keyP rows met target (2026-10-29): the fix was the
// per-render `git status` shell-out in App's useRef init (lazy now) plus the
// frame-cap change (maxFps 200, see cli.tsx) so a keystroke commit inside
// Ink's onRender throttle window paints on the frame edge instead of paying
// the full trailing wait. Reported as median-of-3 (same runs as the render
// gate): the echo is a timer-bound chain dominated by the 10 ms poll
// granularity, and a single window is where machine load gives a false red.
// A run group missing keyP rows medians to Infinity and fails the budget
// loudly instead of silently passing.
if (inputRow?.keyP50ms !== undefined) {
  check("keystroke paint p50", inputRow.keyP50ms, baseline.keyLatency.keyP50ms, "ms");
  check("keystroke paint p95", inputRow.keyP95ms, baseline.keyLatency.keyP95ms, "ms");
} else {
  failures.push("FAIL keystroke gate: input scenario missing keyP rows");
}

// ---- loop gate ----
for (const row of jsonLines(run("bench-loop.mjs"))) {
  if (row.case === "plan-20call") check("loop plan-20call p50", row.planMsP50, baseline.loop.planMsP50, "ms");
  else if (row.perRoundMsP50 !== undefined) {
    check(`loop ${row.case} per-round p50`, row.perRoundMsP50, baseline.loop.perRoundMsP50, "ms");
  }
}

// ---- tools gate ----
for (const row of jsonLines(run("bench-tools.mjs"))) {
  if (row.case === "read-warm") check("tools read-warm p50", row.p50ms, baseline.tools["read-warm"], "ms");
  if (row.case === "bash-overhead-ex-child") {
    check("tools bash overhead ex-child", row.p50ms, baseline.tools["bash-overhead-ex-child"], "ms");
  }
  if (row.case === "bash-output-immediate") {
    check("tools bash_output immediate p50", row.p50ms, baseline.tools["bash-output-immediate"], "ms");
  }
  if (row.case === "grep-repeat-proof" || row.case === "glob-repeat-proof") {
    const ok = row.ratio >= baseline.tools.repeatRatio;
    (ok ? notes : failures).push(
      `${ok ? "PASS" : "FAIL"} tools ${row.case} ratio: ${row.ratio}× (budget ≥ ${baseline.tools.repeatRatio}×)`
    );
  }
}

// ---- footprint gate (task 0C: static bytes, rounded up from measured, ratchet down) ----
// A missing "pack"/"dist" row (bench broke its output shape) must fail the
// gate, not silently zero the section: foundPack/foundDist track the rows.
let foundPack = false;
let foundDist = false;
for (const row of jsonLines(run("bench-footprint.mjs"))) {
  if (row.case === "pack") {
    foundPack = true;
    check("footprint pack tarball", row.tarballBytes, baseline.footprint.tarballBytes);
    check("footprint pack raw file sum", row.packFileBytes, baseline.footprint.packFileBytes);
    check("footprint pack unpacked", row.unpackedSize, baseline.footprint.unpackedBytes);
  } else if (row.case === "dist") {
    foundDist = true;
    check("footprint dist bytes", row.distBytes, baseline.footprint.distBytes);
  }
}
if (!foundPack) failures.push("FAIL footprint pack: no pack row in bench output");
if (!foundDist) failures.push("FAIL footprint dist: no dist row in bench output");

// ---- boot gate (task 0B: cold-start ms, 7 reps for machine noise) ----
// flag-exit pins p95; with 7 reps that is effectively run-max (one slow spawn
// shows up) — spikes are rare here, unlike module-import, which pins the robust
// median because its first rep pays a cold disk cache that dwarfs any budget.
for (const row of jsonLines(run("bench-boot.mjs", ["7"]))) {
  if (row.case === "flag-exit") {
    check("boot flag-exit p95", row.wallMsP95, baseline.boot.flagExitP95Ms, "ms");
  } else if (row.case === "pipe-firstframe") {
    if (row.status === "skipped") {
      notes.push(`INFO boot pipe-firstframe skipped: ${row.reason}`);
    } else {
      check("boot pipe-firstframe p50", row.wallMsMedian, baseline.boot.pipeFirstFrameP50Ms, "ms");
    }
  } else if (row.case === "module-import") {
    check("boot module-import p50", row.wallMsMedian, baseline.boot.moduleImportP50Ms, "ms");
  }
}

// ---- heap gate (task 0D: ceiling + no-superlinear-growth) ----
// The spec'd slope ratio (second-half ≤ first-half × 1.2) never holds: the
// first half typically has ~zero net drift, so the ratio is GC sawtooth phase
// noise against a near-zero denominator (measured ~4× while the heap is flat).
// Enforced instead: absolute second-half slope ≤ budget MB/turn; the ratio is
// informational. Real ceilings grow with a rebuilt baseline, never at gate time.
for (const row of jsonLines(run("bench-heap.mjs"))) {
  const finalMB = row.samples[row.samples.length - 1]?.heapMB;
  if (typeof finalMB === "number") {
    check("heap final MB", finalMB, baseline.heap.finalHeapMB, "MB");
    check("heap second-half slope", row.heapPerTurnMB.secondHalf, baseline.heap.secondHalfMBPerTurn, "MB/turn");
    const ratio = +(row.heapPerTurnMB.secondHalf / Math.max(row.heapPerTurnMB.firstHalf, 1e-9)).toFixed(2);
    notes.push(`INFO heap slope ratio second/first: ${ratio}× (non-inventable target ≤1.2× vs ~zero first-half drift — absolute slope is the owned metric)`);
  } else {
    failures.push("FAIL heap gate: bench-heap output missing usable samples row");
  }
}

// ---- first-token gate (task 0C: loop start → assembled outbound request) ----
// Network-free proxy only (stubbed fetch): prompt assembly + serialize + dispatch.
// The network half of first-token latency is provider variance — reported, never gated.
for (const row of jsonLines(run("bench-first-token.mjs"))) {
  if (row.status === "error") {
    failures.push(`FAIL first-token: ${row.reason} (completedReps=${row.completedReps})`);
  } else if (row.case === "first-token") {
    check("first-token p50", row.firstTokenMsMedian, baseline.firstToken.firstTokenP50Ms, "ms");
    check("first-token p95", row.firstTokenMsP95, baseline.firstToken.firstTokenP95Ms, "ms");
  }
}

console.log([...failures, ...notes].join("\n"));
if (failures.length > 0) {
  console.error(`\nperf-gate: ${failures.length} budget(s) broken`);
  process.exit(1);
}
console.log("\nperf-gate: all budgets met");
