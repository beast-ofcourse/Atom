// Tools micro-bench (Extreme-fast Phase 0.3): executor throughput on a
// hermetic tmp tree — no network, no TUI. Usage: node scripts/bench-tools.mjs
// Prints one JSON row per case: {script, case, runs, p50ms, p95ms, extra?}.
// Requires `npm run build` first (imports dist/).
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const RUNS = 20;
const { executeTool } = await import("../dist/tools.js");
const { clearReadCache, getReadCacheStats, resetReadCacheStats } = await import("../dist/tools/read-cache.js");

const dir = mkdtempSync(path.join(tmpdir(), "atom-bench-tools-"));
for (let i = 0; i < 30; i += 1) {
  writeFileSync(path.join(dir, `f${i}.txt`), `line one ${i}\nline two ${i}\nneedle-${i}\n`, "utf8");
}
mkdirSync(path.join(dir, "sub"), { recursive: true });
writeFileSync(path.join(dir, "sub", "g.ts"), "export const g = 1;\n", "utf8");

async function timeIt(name, fn, extra) {
  const walls = [];
  for (let r = 0; r < RUNS; r += 1) {
    const t0 = performance.now();
    await fn(r);
    walls.push(performance.now() - t0);
  }
  walls.sort((a, b) => a - b);
  console.log(JSON.stringify({
    script: "bench-tools", case: name, runs: RUNS,
    p50ms: +walls[10].toFixed(3), p95ms: +walls[18].toFixed(3), ...(extra ?? {}),
  }));
}

await timeIt("read-cold", async () => {
  clearReadCache();
  await executeTool("read", { path: "f3.txt" }, dir);
});
resetReadCacheStats();
await timeIt("read-warm", async () => {
  await executeTool("read", { path: "f3.txt" }, dir);
}, { cache: getReadCacheStats() });
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
  await executeTool("grep", { pattern: "needle", outputMode: "files_with_matches" }, dir);
});
await timeIt("grep-count", async () => {
  await executeTool("grep", { pattern: "needle", outputMode: "count" }, dir);
});
await timeIt("bash-noop", async () => {
  await executeTool("bash", { command: "echo bench-probe" }, dir);
});
await timeIt("bash-output-immediate", async () => {
  const started = await executeTool("bash", { command: "echo flood-0", runInBackground: true }, dir);
  const id = JSON.parse(started).taskId ?? started;
  await executeTool("bash_output", { taskId: typeof id === "string" ? id : String(id) }, dir);
});
