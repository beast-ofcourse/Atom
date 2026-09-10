// Shell executors: foreground bash and detached background tasks.
// No sandbox beyond cwd+timeout — the approval layer owns the privilege
// decision. Shell output passes through secret scrubbing (see policy.ts).
import { exec, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scrubSecrets } from "../policy.js";
import { PROVIDERS } from "../providers.js";
import { clearDirListingCache } from "./dir-cache.js";
import { appendOverflow } from "./overflow.js";
import { err, OUTPUT_CAP, truncateHead } from "./shared.js";
export type BashArgs = { command: string; timeoutMs?: number; runInBackground?: boolean };

export type BashOutputArgs = { taskId: string; timeoutMs?: number };

// ---- Background bash tasks (Claude-Code-style run_in_background) ----

const BG_TASK_CAP = 20;
const BG_POLL_MS = 100;

type BgTaskRecord = {
  id: string;
  stdoutFile: string;
  stderrFile: string;
  running: boolean;
  exitCode: number | null;
};

// Insertion-ordered: the first key is the oldest task (Map preserves
// insertion order). Finished tasks stay readable until pruned.
const bgTasks = new Map<string, BgTaskRecord>();
let bgCounter = 0;

function bgDir(): string {
  return path.join(os.tmpdir(), "atom-tasks");
}

function newBgId(): string {
  for (;;) {
    bgCounter += 1;
    const id = `${Date.now().toString(36)}${bgCounter.toString(36)}${randomBytes(3).toString("hex")}`;
    if (!bgTasks.has(id)) return id;
  }
}

// Keep the last ~20 task records in memory; prune older temp files
// best-effort (a still-running task's files may be recreated by later
// output — its append guard below stops that once pruned).
function pruneBgTasks(): void {
  while (bgTasks.size > BG_TASK_CAP) {
    const oldest = bgTasks.keys().next();
    if (oldest.done) return;
    const key = oldest.value as string;
    const rec = bgTasks.get(key);
    bgTasks.delete(key);
    if (rec) {
      for (const f of [rec.stdoutFile, rec.stderrFile]) {
        try {
          fs.rmSync(f, { force: true });
        } catch {
          // best-effort
        }
      }
    }
  }
}

// Spawn in the background (unref'd, stdin ignored, stdout/stderr piped
// and appended to temp files) and return IMMEDIATELY. The process runs
// independent of the loop; poll it with bash_output.
// Windows note: `detached: true` drops child output on Windows (verified:
// detached cmd.exe children exit 0 with empty captures, for both fd and
// pipe stdio), so Windows spawns attached — still unref'd with stdin
// ignored, so the observable contract (immediate return, independent run,
// output to temp files) is unchanged. POSIX keeps detached:true so
// background tasks are shielded from Ctrl+C in a new process group.
// Chunks are appended synchronously so that once `close` marks the task
// finished, every byte is already on disk for bash_output — no flush race.
async function startBackgroundBash(command: string, cwd: string): Promise<string> {
  try {
    const dir = bgDir();
    await fsp.mkdir(dir, { recursive: true });
    const id = newBgId();
    const stdoutFile = path.join(dir, `${id}.stdout.log`);
    const stderrFile = path.join(dir, `${id}.stderr.log`);
    await fsp.writeFile(stdoutFile, "", "utf8");
    await fsp.writeFile(stderrFile, "", "utf8");
    const rec: BgTaskRecord = {
      id,
      stdoutFile,
      stderrFile,
      running: true,
      exitCode: null,
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    bgTasks.set(id, rec);
    pruneBgTasks();
    const append = (file: string, chunk: unknown): void => {
      // A pruned (evicted) task is unpollable: stop growing its files.
      if (bgTasks.get(id) !== rec) return;
      try {
        fs.appendFileSync(file, chunk as Uint8Array);
      } catch {
        // best-effort: a failed append must never break the task
      }
    };
    child.stdout?.on("data", (d) => append(stdoutFile, d));
    child.stderr?.on("data", (d) => append(stderrFile, d));
    child.on("error", () => {
      rec.running = false;
      if (rec.exitCode === null) rec.exitCode = 1;
      // `close` may still follow; it overwrites with the real code.
    });
    // `close` (not `exit`): all piped output has been received, and the
    // synchronous appends above mean it is already on disk.
    child.on("close", (code) => {
      rec.running = false;
      rec.exitCode = typeof code === "number" ? code : 1;
    });
    child.unref();
    // A spawned command can touch anything (files, trees, checkouts): the
    // directory-listing cache cannot know what changed, so drop it all. Cheap
    // (next search rescans once) and exactly correct for tool-driven flows;
    // only out-of-process edits stay TTL-bound.
    try {
      clearDirListingCache();
    } catch {
      // never break the tool
    }
    return JSON.stringify({ backgroundTaskId: id, status: "running", hint: "use bash_output to poll" });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Known provider secrets (live env values) for shell-output scrubbing. Shell
// inherits our environment, so `env`/`printenv` — or an echoed pasted key —
// would otherwise hand secrets to the model and into saved transcripts.
// Exported for tests. Stored keys (~/.atom/auth.json) are NOT covered, only
// env-provided values; short values are skipped by scrubSecrets itself.
export function providerSecrets(): string[] {
  const out: string[] = [];
  for (const p of PROVIDERS) {
    for (const name of p.envVars) {
      const v = process.env[name];
      if (typeof v === "string" && v.length > 0) out.push(v);
    }
  }
  return out;
}

function capBgStream(s: string, which: "stdout" | "stderr"): string {
  // Presentation-layer scrub: background output files on disk keep raw bytes
  // (chunked appends cannot redact safely); everything the model sees via
  // bash_output passes through here.
  const clean = scrubSecrets(s, providerSecrets());
  if (clean.length > OUTPUT_CAP) {
    const t = truncateHead(clean, OUTPUT_CAP, `\n[truncated: ${which} exceeded 8KB]`);
    return appendOverflow(t.head, t.note, `background ${which}`, clean);
  }
  return clean;
}

// Poll a background task. When running and timeoutMs > 0, waits (polling
// the output files about every 100ms) until exit or the wait expires.
// Error strings, never throws.
export async function bashOutputTool(args: BashOutputArgs): Promise<string> {
  try {
    const taskId = typeof args?.taskId === "string" ? args.taskId : "";
    const rec = bgTasks.get(taskId);
    if (!rec) return err("unknown background task");
    const t = args?.timeoutMs;
    const timeoutMs =
      typeof t === "number" && Number.isFinite(t) ? Math.min(Math.max(Math.floor(t), 0), 60000) : 5000;
    const start = Date.now();
    while (rec.running && Date.now() - start < timeoutMs) {
      await sleepMs(Math.min(BG_POLL_MS, Math.max(timeoutMs - (Date.now() - start), 1)));
    }
    let stdout = "";
    let stderr = "";
    try {
      stdout = await fsp.readFile(rec.stdoutFile, "utf8");
    } catch {
      stdout = "";
    }
    try {
      stderr = await fsp.readFile(rec.stderrFile, "utf8");
    } catch {
      stderr = "";
    }
    return JSON.stringify({
      taskId: rec.id,
      running: rec.running,
      exitCode: rec.running ? null : rec.exitCode,
      stdout: capBgStream(stdout, "stdout"),
      stderr: capBgStream(stderr, "stderr"),
      timedOut: rec.running && timeoutMs > 0,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// Run in the system shell with cwd=process.cwd() (or the caller's cwd),
// stdin closed. stdout/stderr each truncated to ~8KB. Returns JSON:
// {"exitCode": number, "stdout": string, "stderr": string, ...}.
// No sandbox beyond cwd+timeout+truncation — the model must treat this
// as a privileged operation.
export function bashTool(args: BashArgs, cwd: string = process.cwd()): Promise<string> {
  if (typeof args?.command !== "string" || args.command.trim().length === 0) {
    return Promise.resolve(err("command must be a non-empty string"));
  }
  if (args.runInBackground === true) {
    return startBackgroundBash(args.command, cwd);
  }
  const timeoutMs = Math.min(Math.max(Math.floor(args.timeoutMs ?? 60000), 1), 120000);
  return new Promise((resolve) => {
    exec(args.command, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      // The command ran (whatever its exit): it may have mutated the tree,
      // so the listing cache is dropped (see background path above).
      try {
        clearDirListingCache();
      } catch {
        // never break the tool
      }
      try {
        const e = error as (Error & { code?: unknown; killed?: boolean }) | null;
        const exitCode = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        let out: string = typeof stdout === "string" ? stdout : String(stdout ?? "");
        let errText: string = typeof stderr === "string" ? stderr : String(stderr ?? "");
        // Scrub BEFORE truncation/spill: overflow files must never persist raw
        // secrets to disk either.
        const secrets = providerSecrets();
        if (secrets.length > 0) {
          out = scrubSecrets(out, secrets);
          errText = scrubSecrets(errText, secrets);
        }
        let stdoutTruncated = false;
        let stderrTruncated = false;
        if (out.length > OUTPUT_CAP) {
          const full = out;
          const t = truncateHead(full, OUTPUT_CAP, "\n[truncated: stdout exceeded 8KB]");
          out = appendOverflow(t.head, t.note, "command stdout", full);
          stdoutTruncated = true;
        }
        if (errText.length > OUTPUT_CAP) {
          const full = errText;
          const t = truncateHead(full, OUTPUT_CAP, "\n[truncated: stderr exceeded 8KB]");
          errText = appendOverflow(t.head, t.note, "command stderr", full);
          stderrTruncated = true;
        }
        resolve(
          JSON.stringify({
            exitCode,
            stdout: out,
            stderr: errText,
            timedOut: e?.killed === true,
            stdoutTruncated,
            stderrTruncated,
          })
        );
      } catch (ex) {
        resolve(err(ex instanceof Error ? ex.message : String(ex)));
      }
    });
  });
}

