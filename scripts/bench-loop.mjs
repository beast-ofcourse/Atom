// Loop micro-bench (Extreme-fast Phase 0.3): per-round harness overhead with
// a scripted fake chatFn and no-op executors — no network, no TUI.
// Usage: node scripts/bench-loop.mjs [reps]
// Prints one JSON row per case: {script, case, rounds, wallMs, perRoundMs,
// planMs?, planP95?}. Requires `npm run build` first (imports dist/).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPS = Number(process.argv[2] ?? 5);
const { runLoopWithChat } = await import("../dist/zen.js");
const { planBatches } = await import("../dist/scheduler.js");

function tc(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
const text = (content) => ({ content });
const noopExec = async () => "ok";

function longHistory(n) {
  const h = [{ role: "system", content: "s" }];
  for (let i = 0; i < n; i += 1) h.push({ role: "user", content: `q-${i}` }, { role: "assistant", content: `a-${i}` });
  return h;
}
function reads8() {
  const calls = [];
  for (let i = 0; i < 8; i += 1) calls.push(tc(`r${i}`, "read", { path: `f${i}.txt` }));
  return { content: null, tool_calls: calls };
}
function mixed20() {
  const calls = [];
  const kinds = ["read", "grep", "glob", "bash", "todo_get"];
  for (let i = 0; i < 20; i += 1) {
    const k = kinds[i % kinds.length];
    const args = k === "read" ? { path: `f${i}.txt` } : k === "grep" ? { pattern: `p${i}` }
      : k === "glob" ? { pattern: "*.ts" } : k === "bash" ? { command: `echo ${i}` } : {};
    calls.push(tc(`m${i}`, k, args));
  }
  return { content: null, tool_calls: calls };
}

async function timeCase(name, seedQueue, historyLen) {
  const walls = [];
  for (let r = 0; r < REPS; r += 1) {
    const history = longHistory(historyLen);
    const queue = seedQueue();
    const t0 = performance.now();
    let rounds = 0;
    await runLoopWithChat(
      async () => {
        rounds += 1;
        return queue.length > 1 ? queue.shift() : queue[queue.length - 1];
      },
      history,
      { execute: noopExec, sleep: async () => {} },
    );
    walls.push(performance.now() - t0);
    var lastRounds = rounds;
  }
  walls.sort((a, b) => a - b);
  const p50 = walls[Math.floor(walls.length / 2)];
  console.log(JSON.stringify({
    script: "bench-loop", case: name, reps: REPS, rounds: lastRounds,
    wallMsP50: +p50.toFixed(2), perRoundMsP50: +(p50 / lastRounds).toFixed(3),
  }));
}

function synthCalls(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ id: `c${i}`, type: "function", function: { name: "read", arguments: `{"path":"f${i}.txt"}` } });
  }
  return out;
}

async function timePlan() {
  const calls = synthCalls(20);
  const walls = [];
  for (let r = 0; r < 30; r += 1) {
    const t0 = performance.now();
    planBatches(calls);
    walls.push(performance.now() - t0);
  }
  walls.sort((a, b) => a - b);
  console.log(JSON.stringify({
    script: "bench-loop", case: "plan-20call", reps: 30,
    planMsP50: +walls[15].toFixed(3), planMsP95: +walls[28].toFixed(3),
  }));
}

const dir = mkdtempSync(path.join(tmpdir(), "atom-bench-loop-"));
process.chdir(dir);
await timeCase("serial-1call-short", () => [{ content: null, tool_calls: [tc("c1", "read", { path: "f.txt" })] }, text("done")], 2);
await timeCase("serial-1call-long200", () => [{ content: null, tool_calls: [tc("c1", "read", { path: "f.txt" })] }, text("done")], 200);
await timeCase("parallel-8read", () => [reads8(), text("done")], 2);
await timeCase("mixed-20call", () => [mixed20(), text("done")], 2);
await timePlan();
