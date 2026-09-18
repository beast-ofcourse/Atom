// Tools micro-bench (Extreme-fast Phase 0.3): executor throughput on a
// hermetic tmp tree — no network, no TUI. Usage: node scripts/bench-tools.mjs
// Prints one JSON row per case: {script, case, runs, p50ms, p95ms, extra?}.
// Requires `npm run build` first (imports dist/).
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const RUNS = 20;
const { executeTool } = await import("../dist/tools.js");
const { clearReadCache, getReadCacheStats, resetReadCacheStats } =
  await import("../dist/tools/read-cache.js");
const { clearDirListingCache } = await import("../dist/tools/dir-cache.js");
const {
  clearSearchResultCache,
  resetSearchResultCacheStats,
  getSearchResultCacheStats,
} = await import("../dist/tools/search.js");
const { getRipgrepStats, resetRipgrepStats } =
  await import("../dist/tools/ripgrep.js");

const dir = mkdtempSync(path.join(tmpdir(), "atom-bench-tools-"));
for (let i = 0; i < 30; i += 1) {
  writeFileSync(
    path.join(dir, `f${i}.txt`),
    `line one ${i}\nline two ${i}\nneedle-${i}\n`,
    "utf8",
  );
}
mkdirSync(path.join(dir, "sub"), { recursive: true });
writeFileSync(path.join(dir, "sub", "g.ts"), "export const g = 1;\n", "utf8");

async function timeIt(name, fn, extraFn) {
  const walls = [];
  for (let r = 0; r < RUNS; r += 1) {
    const t0 = performance.now();
    await fn(r);
    walls.push(performance.now() - t0);
  }
  walls.sort((a, b) => a - b);
  // extraFn runs AFTER timing (stats reflect the measured runs, not the
  // pre-run state — the old eager-eval form always printed zeros).
  console.log(
    JSON.stringify({
      script: "bench-tools",
      case: name,
      runs: RUNS,
      p50ms: +walls[10].toFixed(3),
      p95ms: +walls[18].toFixed(3),
      ...((typeof extraFn === "function" ? extraFn() : extraFn) ?? {}),
    }),
  );
  return walls;
}

await timeIt("read-cold", async () => {
  clearReadCache();
  await executeTool("read", { path: "f3.txt" }, dir);
});
resetReadCacheStats();
await timeIt(
  "read-warm",
  async () => {
    await executeTool("read", { path: "f3.txt" }, dir);
  },
  () => ({ cache: getReadCacheStats() }),
);
await timeIt("glob-cold", async () => {
  await executeTool("glob", { pattern: "*.txt" }, dir);
});
await timeIt("glob-warm", async () => {
  await executeTool("glob", { pattern: "*.txt" }, dir);
});
await timeIt("grep-content", async () => {
  await executeTool("grep", { pattern: "needle", dir: "." }, dir);
});
await timeIt("grep-files", async () => {
  await executeTool(
    "grep",
    { pattern: "needle", outputMode: "files_with_matches" },
    dir,
  );
});
await timeIt("grep-count", async () => {
  await executeTool("grep", { pattern: "needle", outputMode: "count" }, dir);
});
// Cache proof (Extreme-fast 3B.8 acceptance): first identical search after a
// full clear vs the immediate repeat — the repeat must be ≥5× faster.
// Reports firstMs/repeatMs/ratio alongside the usual p50 (repeats).
clearDirListingCache();
clearSearchResultCache();
resetSearchResultCacheStats();
{
  const t0 = performance.now();
  await executeTool(
    "grep",
    { pattern: "needle", outputMode: "files_with_matches" },
    dir,
  );
  const firstMs = performance.now() - t0;
  const t1 = performance.now();
  await executeTool(
    "grep",
    { pattern: "needle", outputMode: "files_with_matches" },
    dir,
  );
  const repeatMs = performance.now() - t1;
  console.log(
    JSON.stringify({
      script: "bench-tools",
      case: "grep-repeat-proof",
      runs: 1,
      p50ms: +repeatMs.toFixed(3),
      p95ms: +repeatMs.toFixed(3),
      firstMs: +firstMs.toFixed(3),
      ratio: +(firstMs / Math.max(repeatMs, 0.001)).toFixed(1),
      resultCache: getSearchResultCacheStats(),
    }),
  );
}
clearDirListingCache();
clearSearchResultCache();
resetSearchResultCacheStats();
{
  const t0 = performance.now();
  await executeTool("glob", { pattern: "*.txt" }, dir);
  const firstMs = performance.now() - t0;
  const t1 = performance.now();
  await executeTool("glob", { pattern: "*.txt" }, dir);
  const repeatMs = performance.now() - t1;
  console.log(
    JSON.stringify({
      script: "bench-tools",
      case: "glob-repeat-proof",
      runs: 1,
      p50ms: +repeatMs.toFixed(3),
      p95ms: +repeatMs.toFixed(3),
      firstMs: +firstMs.toFixed(3),
      ratio: +(firstMs / Math.max(repeatMs, 0.001)).toFixed(1),
      resultCache: getSearchResultCacheStats(),
    }),
  );
}
// Ripgrep routing visibility (Extreme-fast 3B.6): uses/fallbacks surface
// immediately so an rg regression (missing binary, bad exit) shows here.
console.log(
  JSON.stringify({
    script: "bench-tools",
    case: "ripgrep-stats",
    rg: getRipgrepStats(),
  }),
);
await timeIt("bash-noop", async () => {
  await executeTool("bash", { command: "echo bench-probe" }, dir);
});
// Overhead excluding child runtime (Extreme-fast 3C.5 acceptance: ≤10 ms):
// raw exec median vs bashTool median on the same command AND the same spawn
// options — the delta is the framework tax (validation, secrets scan,
// scrub, truncation, envelope). Measured 2026-09-18: `windowsHide: true`
// alone costs ~+20 ms of OS spawn time on Windows (17→37 ms); removing it
// would flash a console window per call (visible behavior change), so the
// comparison uses identical options and the ~0 ms delta is the real number.
{
  const { exec } = await import("node:child_process");
  const spawnOpts = {
    cwd: dir,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  };
  const rawWalls = [];
  const toolWalls = [];
  // Interleaved A/B (not two separate loops) so machine drift cancels out.
  for (let r = 0; r < RUNS; r += 1) {
    let t0 = performance.now();
    await new Promise((resolve) =>
      exec("echo bench-probe", spawnOpts, () => resolve()),
    );
    rawWalls.push(performance.now() - t0);
    t0 = performance.now();
    await executeTool("bash", { command: "echo bench-probe" }, dir);
    toolWalls.push(performance.now() - t0);
  }
  rawWalls.sort((a, b) => a - b);
  toolWalls.sort((a, b) => a - b);
  const rawP50 = rawWalls[10];
  const toolP50 = toolWalls[10];
  console.log(
    JSON.stringify({
      script: "bench-tools",
      case: "bash-overhead-ex-child",
      runs: RUNS,
      p50ms: +(toolP50 - rawP50).toFixed(3),
      p95ms: 0,
      rawExecP50ms: +rawP50.toFixed(3),
      toolP50ms: +toolP50.toFixed(3),
    }),
  );
}
// True immediate-poll semantics: one task spawned and drained to finished
// OUTSIDE the timer, then 20 timed polls of the finished task (file reads
// only). Polling straight after spawn races the child (~35 ms) and measures
// scheduler luck, not poll cost — that flaked 8–16 ms run-to-run.
{
  const started = await executeTool(
    "bash",
    { command: "echo flood-0", runInBackground: true },
    dir,
  );
  const parsed = JSON.parse(started);
  const id =
    typeof parsed.backgroundTaskId === "string"
      ? parsed.backgroundTaskId
      : String(parsed.taskId ?? started);
  for (let i = 0; i < 50; i++) {
    const s = JSON.parse(
      await executeTool("bash_output", { taskId: id }, dir),
    );
    if (!s.running) break;
  }
  await timeIt("bash-output-immediate", async () => {
    await executeTool("bash_output", { taskId: id }, dir);
  });
}
