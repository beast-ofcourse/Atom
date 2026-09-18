// Heap-flatness bench (Extreme-fast Phase 4.5): 300 synthetic agent turns
// with REAL executors (read/grep/glob over a tmp tree, caches fill and
// evict), sampling process.memoryUsage. Requires `npm run build` first.
// Prints one JSON row: heap at quartiles, per-turn slope first vs second
// half (history itself grows linearly — the working set; caches must not
// add superlinear growth), and final cache sizes vs their caps.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const TURNS = 300;
const { runLoopWithChat } = await import("../dist/zen.js");
const { executeTool } = await import("../dist/tools.js");
const { getReadCacheStats } = await import("../dist/tools/read-cache.js");
const { getDirListingStats, getRealpathCacheStats } = await import("../dist/tools/dir-cache.js");
const { getSearchResultCacheStats } = await import("../dist/tools/search.js");

const dir = mkdtempSync(path.join(tmpdir(), "atom-bench-heap-"));
for (let i = 0; i < 40; i += 1) {
  writeFileSync(path.join(dir, `f${i}.txt`), `line one ${i}\nline two ${i}\nneedle-${i % 7}\n`, "utf8");
}

function tc(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

let turn = 0;
const samples = [];
samples.push({ turn: 0, heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2) });
await runLoopWithChat(
  async () => {
    turn += 1;
    if (turn % 25 === 0) {
      samples.push({ turn, heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2) });
    }
    if (turn >= TURNS) return { content: "done" };
    const i = turn % 40;
    return {
      content: null,
      tool_calls: [
        tc(`r${turn}`, "read", { path: `f${i}.txt` }),
        tc(`g${turn}`, "grep", { pattern: `needle-${i % 7}` }),
        tc(`l${turn}`, "glob", { pattern: "*.txt" }),
      ],
    };
  },
  [{ role: "system", content: "heap bench" }],
  { execute: async (name, args) => executeTool(name, args, dir), sleep: async () => {} },
);
samples.push({ turn, heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2) });

const firstHalf = samples.filter((s) => s.turn <= 150);
const secondHalf = samples.filter((s) => s.turn >= 150);
const slope = (pts) => (pts[pts.length - 1].heapMB - pts[0].heapMB) / Math.max(pts[pts.length - 1].turn - pts[0].turn, 1);
console.log(JSON.stringify({
  script: "bench-heap",
  turns: turn,
  samples,
  heapPerTurnMB: {
    firstHalf: +slope(firstHalf).toFixed(4),
    secondHalf: +slope(secondHalf).toFixed(4),
  },
  caches: {
    read: getReadCacheStats(),
    listing: getDirListingStats(),
    realpath: getRealpathCacheStats(),
    results: getSearchResultCacheStats(),
  },
}));
