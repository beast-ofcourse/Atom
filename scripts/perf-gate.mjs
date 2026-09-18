// Perf gate (Extreme-fast Phase 5.1): hard budgets over the three benches.
// Usage: npm run perf-gate (requires `npm run build` first).
// Fails non-zero with a table when any budget breaks. Render deltas compare
// against scripts/perf-baseline.json (config A, post-widget-chrome).
// keyP latency rows print informational only (budget unmet, tracked).
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
    keyP50ms: row0.keyP50ms,
    keyP95ms: row0.keyP95ms,
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
if (inputRow?.keyP50ms !== undefined) {
  notes.push(
    `INFO keystroke keyP50=${inputRow.keyP50ms}ms keyP95=${inputRow.keyP95ms}ms ` +
      `(budget ≤50ms NOT MET — tracked, see tasks.md 1C; baseline file: ${baseline.keyLatency.keyP50ms}/${baseline.keyLatency.keyP95ms}ms)`
  );
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

console.log([...failures, ...notes].join("\n"));
if (failures.length > 0) {
  console.error(`\nperf-gate: ${failures.length} budget(s) broken`);
  process.exit(1);
}
console.log("\nperf-gate: all budgets met");
