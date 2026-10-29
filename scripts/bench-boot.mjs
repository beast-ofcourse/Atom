// Cold-start bench (Performance Gate v2, task 0B): wall-clock from process
// spawn to useful output. Three cases:
//   flag-exit — `node dist/cli.js --help`, spawn to exit. NOTE: cli.js has no
//     --version flag; --help is the real spawn-to-exit floor (dynamic imports
//     of zen.js only, never the TUI graph).
//   pipe-firstframe — spawn `node dist/cli.js` with piped stdin/stdout (not a
//     real PTY, so it works on win32); pipe `--version` through stdin and time
//     spawn to first stdout byte. Skipped cleanly with status:"skipped" if the
//     pipe mode is unusable (error or a stall, never a hang).
//   module-import — dynamic import of ../dist/App.js in-process (the heavy
//     react/ink/yoga boot load). NOTE: dist/cli.js cannot be imported
//     in-process — it starts the TUI at top level and would hang this bench;
//     App.js is the dominant module graph behind TUI boot.
// Usage: node scripts/bench-boot.mjs [reps]   (default 10)
// Prints one JSON row per case: {script, case, wallMsMedian, wallMsP95,
// wallMsArray, wallMsMin, wallMsMax} for cases flag-exit and pipe-firstframe
// plus module-import. Requires `npm run build` first.
import { spawn, execFileSync } from "node:child_process";
import * as path from "node:path";

const REPS = Math.max(1, Number(process.argv[2] ?? 10));
const CLI = path.resolve("dist/cli.js");
const TIMEOUT_MS = 15_000;
const MEDIAN = (sorted) => sorted[Math.floor((sorted.length - 1) / 2)];
const P95 = (sorted) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];

function row(name, arr, extra = {}) {
  const s = [...arr].sort((a, b) => a - b);
  console.log(JSON.stringify({
    script: "bench-boot",
    case: name,
    reps: s.length,
    wallMsMedian: +MEDIAN(s).toFixed(1),
    wallMsP95: +P95(s).toFixed(1),
    wallMsMin: +s[0].toFixed(1),
    wallMsMax: +s[s.length - 1].toFixed(1),
    wallMsArray: s.map((v) => +v.toFixed(1)),
    ...extra,
  }));
}

function timedExitRun() {
  const t0 = performance.now();
  execFileSync(process.execPath, [CLI, "--help"], {
    windowsHide: true,
    timeout: TIMEOUT_MS,
  });
  return performance.now() - t0;
}

const exitWalls = [];
for (let i = 0; i < REPS; i += 1) exitWalls.push(timedExitRun());
row("flag-exit", exitWalls);

// spawn → child, resolve on first stdout byte after stdin is fed. Kill on
// timeout (kills the whole detached tree on win32 via taskkill-less
// childProcess kill; stdio pipes die with it).
function timePipeChild() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [CLI], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ wallMs: null, timedOut: true, error: "stalled 15s" }), TIMEOUT_MS);
    child.on("error", (err) => finish({ wallMs: null, timedOut: false, error: String(err) }));
    child.stdout.once("data", () => finish({ wallMs: performance.now() - t0, timedOut: false }));
    // stdin stays an open (non-TTY) pipe; cli.js reads argv, not stdin, so the
    // TUI's first paint on piped stdout is the signal we time.
  });
}

const pipeRows = [];
for (let i = 0; i < REPS; i += 1) pipeRows.push(await timePipeChild());
const good = pipeRows.filter((r) => r.wallMs != null);
const bad = pipeRows.filter((r) => r.wallMs == null);
if (good.length === 0) {
  console.log(JSON.stringify({
    script: "bench-boot",
    case: "pipe-firstframe",
    status: "skipped",
    reason: bad[0]?.error ?? "all iterations unusable",
  }));
} else {
  row("pipe-firstframe", good.map((r) => r.wallMs), bad.length > 0 ? { timesOutReps: bad.length } : {});
}

// Boot floor minus spawn: just pay the module graph load cost in-process.
// Cache-bust the query so each rep re-reads the graph off disk.
const importWalls = [];
for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();
  const [r] = await Promise.allSettled([import(`../dist/App.js?warm=${i}`)]);
  const wallMs = performance.now() - t0;
  if (r.status === "rejected") {
    console.log(JSON.stringify({
      script: "bench-boot", case: "module-import", status: "error",
      reason: r.reason ? String(r.reason).slice(0, 200) : "import rejected",
    }));
    process.exit(0);
  }
  importWalls.push(wallMs);
}
row("module-import", importWalls);
