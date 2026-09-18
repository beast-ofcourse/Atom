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
import { clearReadCache } from "./read-cache.js";
import { appendOverflow } from "./overflow.js";
import { err, OUTPUT_CAP, truncateHead } from "./shared.js";
export type BashArgs = {
  command: string;
  timeoutMs?: number;
  runInBackground?: boolean;
};

export type BashOutputArgs = { taskId: string; timeoutMs?: number };

// ---- Background bash tasks (Claude-Code-style run_in_background) ----

const BG_TASK_CAP = 20;
const BG_POLL_MS = 100;
// Interactive poll window (3C.3): 20 ms polls for the first 500 ms after the
// poll starts (the window where a human/loop is actively waiting), then the
// steady 100 ms cadence above.
// Background append batching (3C.4): flush per file at 16 KB or 50 ms.
const BG_FAST_POLL_MS = 20;
const BG_FAST_POLL_WINDOW_MS = 500;
const BG_APPEND_FLUSH_BYTES = 16 * 1024;
const BG_APPEND_FLUSH_MS = 50;

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

// Test seam: live record count (pins BG_TASK_CAP from tests).
export function getBgTaskCount(): number {
  return bgTasks.size;
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
async function startBackgroundBash(
  command: string,
  cwd: string,
): Promise<string> {
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
    // Batched appends (Extreme-fast 3C.4): chunk appends accumulate per
    // file and flush at 16 KB or on a 50 ms trailing timer instead of one
    // appendFileSync per chunk (event-loop jank under output floods). The
    // `close` handler flushes synchronously BEFORE marking finished, so the
    // no-flush-race contract holds exactly as with sync appends: once
    // `close` ran, every byte is on disk for bash_output.
    const pendingChunks = new Map<
      string,
      {
        parts: Uint8Array[];
        size: number;
        timer: ReturnType<typeof setTimeout> | null;
      }
    >();
    const flushFileSync = (file: string): void => {
      const buf = pendingChunks.get(file);
      if (!buf || buf.parts.length === 0) return;
      pendingChunks.delete(file);
      if (buf.timer !== null) {
        try {
          clearTimeout(buf.timer);
        } catch {
          /* ignore */
        }
      }
      // A pruned (evicted) task is unpollable: stop growing its files.
      if (bgTasks.get(id) !== rec) return;
      try {
        fs.appendFileSync(file, Buffer.concat(buf.parts));
      } catch {
        // best-effort: a failed append must never break the task
      }
    };
    const append = (file: string, chunk: unknown): void => {
      // A pruned (evicted) task is unpollable: stop growing its files.
      if (bgTasks.get(id) !== rec) return;
      const data = chunk as Uint8Array;
      let buf = pendingChunks.get(file);
      if (!buf) {
        buf = { parts: [], size: 0, timer: null };
        pendingChunks.set(file, buf);
      }
      buf.parts.push(data);
      buf.size += (data as Uint8Array)?.byteLength ?? 0;
      if (buf.size >= BG_APPEND_FLUSH_BYTES) {
        flushFileSync(file);
        return;
      }
      if (buf.timer === null) {
        try {
          const t = setTimeout(() => flushFileSync(file), BG_APPEND_FLUSH_MS);
          const u = t as unknown as { unref?: () => void };
          if (typeof u.unref === "function") u.unref();
          buf.timer = t;
        } catch {
          flushFileSync(file);
        }
      }
    };
    child.stdout?.on("data", (d) => append(stdoutFile, d));
    child.stderr?.on("data", (d) => append(stderrFile, d));
    child.on("error", () => {
      rec.running = false;
      if (rec.exitCode === null) rec.exitCode = 1;
      // `close` may still follow; it overwrites with the real code.
    });
    // `close` (not `exit`): all piped output has been received. Flush the
    // batched appends synchronously FIRST, then mark finished — bash_output
    // after close always sees every byte (no flush race, same contract as
    // the old per-chunk sync appends).
    child.on("close", (code) => {
      flushFileSync(stdoutFile);
      flushFileSync(stderrFile);
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
    return JSON.stringify({
      backgroundTaskId: id,
      status: "running",
      hint: "use bash_output to poll",
    });
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
// Deliberately unmemoized (Extreme-fast 3C.1, measured): the iteration is
// microseconds, while any TTL would serve rotated-away keys to the scrubber
// (live-env tests pin this). The per-byte scrub cost is inherent — memoizing
// the list cannot reduce it.
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
    const t = truncateHead(
      clean,
      OUTPUT_CAP,
      `\n[truncated: ${which} exceeded 8KB]`,
    );
    return appendOverflow(t.head, t.note, `background ${which}`, clean);
  }
  return clean;
}

// Poll a background task. When running and timeoutMs > 0, waits until exit
// or the wait expires — adaptive cadence (Extreme-fast 3C.3): 20 ms polls
// inside the first 500 ms (the interactive window where someone is actively
// waiting), then the steady 100 ms cadence. Uncapped — caller decides.
// Error strings, never throws.
export async function bashOutputTool(args: BashOutputArgs): Promise<string> {
  try {
    const taskId = typeof args?.taskId === "string" ? args.taskId : "";
    const rec = bgTasks.get(taskId);
    if (!rec) return err("unknown background task");
    const t = args?.timeoutMs;
    const timeoutMs =
      typeof t === "number" && Number.isFinite(t)
        ? Math.max(Math.floor(t), 0)
        : 5000;
    const start = Date.now();
    while (rec.running && Date.now() - start < timeoutMs) {
      const elapsed = Date.now() - start;
      const step =
        elapsed < BG_FAST_POLL_WINDOW_MS ? BG_FAST_POLL_MS : BG_POLL_MS;
      await sleepMs(Math.min(step, Math.max(timeoutMs - elapsed, 1)));
    }
    let stdout = "";
    let stderr = "";
    try {
      [stdout, stderr] = await Promise.all([
        fsp.readFile(rec.stdoutFile, "utf8").catch(() => ""),
        fsp.readFile(rec.stderrFile, "utf8").catch(() => ""),
      ]);
    } catch {
      stdout = "";
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

// Provably read-only commands (Extreme-fast 3C.2): a bare side-effect-free
// builtin whose text contains zero shell metacharacters cannot mutate the
// tree — no redirects, pipes, chaining, substitution, quoting, or
// backgrounding. Deliberately tiny allowlist (unknown commands clear, as
// before); matching is on the first token's basename, case-insensitive.
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "true",
  "echo",
  "printf",
  "pwd",
  "whoami",
  "hostname",
  "date",
  "uname",
]);

export function isReadOnlyCommand(command: unknown): boolean {
  try {
    if (typeof command !== "string") return false;
    const text = command.trim();
    if (text.length === 0 || text.length > 500) return false;
    if (/[><&|;`$'"(){}[\]!#~*?\\]/.test(text)) return false;
    const first = text.split(/\s+/, 1)[0] ?? "";
    const base = first.split(/[\\/]/).pop() ?? "";
    return READ_ONLY_COMMANDS.has(base.toLowerCase());
  } catch {
    return false;
  }
}

// Run in the system shell with cwd=process.cwd() (or the caller's cwd),
// stdin closed. stdout/stderr each truncated to ~8KB. Returns JSON:
// {"exitCode": number, "stdout": string, "stderr": string, ...}.
// No sandbox beyond cwd+timeout+truncation — the model must treat this
// as a privileged operation.
export function bashTool(
  args: BashArgs,
  cwd: string = process.cwd(),
): Promise<string> {
  if (typeof args?.command !== "string" || args.command.trim().length === 0) {
    return Promise.resolve(err("command must be a non-empty string"));
  }
  if (args.runInBackground === true) {
    return startBackgroundBash(args.command, cwd);
  }
  // Uncapped — AI decides per-call timeout; 0 means no timeout (exec without limit)
  const rawTimeout = args.timeoutMs;
  const timeoutMs =
    typeof rawTimeout === "number" &&
    Number.isFinite(rawTimeout) &&
    rawTimeout > 0
      ? Math.floor(rawTimeout)
      : rawTimeout === 0
        ? 0
        : 60000;
  return new Promise((resolve) => {
    const execOpts: Record<string, unknown> = {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    };
    if (timeoutMs > 0) (execOpts as { timeout: number }).timeout = timeoutMs;
    exec(args.command, execOpts as never, (error, stdout, stderr) => {
      // The command ran (whatever its exit): it may have mutated the tree,
      // so the listing cache is dropped — UNLESS the command is provably
      // read-only (Extreme-fast 3C.2): a bare side-effect-free builtin with
      // zero shell metacharacters cannot have touched the filesystem, so
      // the next search keeps its warm listing. Anything else (pipes,
      // redirects, substitutions, flags that write) clears as before.
      // Background spawn always clears (see above).
      try {
        if (!isReadOnlyCommand(args.command)) {
          clearDirListingCache();
          // Shell mutations bypass write/edit invalidators. Clear the read
          // cache conservatively: any non-provably-readonly command may
          // have touched the tree, and mtime+size alone cannot catch
          // same-ms same-size rewrites.
          try {
            clearReadCache();
          } catch {
            // cache failures never break the tool
          }
        }
      } catch {
        // never break the tool
      }
      try {
        const e = error as
          (Error & { code?: unknown; killed?: boolean }) | null;
        const exitCode = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        let out: string =
          typeof stdout === "string" ? stdout : String(stdout ?? "");
        let errText: string =
          typeof stderr === "string" ? stderr : String(stderr ?? "");
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
          const t = truncateHead(
            full,
            OUTPUT_CAP,
            "\n[truncated: stdout exceeded 8KB]",
          );
          out = appendOverflow(t.head, t.note, "command stdout", full);
          stdoutTruncated = true;
        }
        if (errText.length > OUTPUT_CAP) {
          const full = errText;
          const t = truncateHead(
            full,
            OUTPUT_CAP,
            "\n[truncated: stderr exceeded 8KB]",
          );
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
          }),
        );
      } catch (ex) {
        resolve(err(ex instanceof Error ? ex.message : String(ex)));
      }
    });
  });
}
