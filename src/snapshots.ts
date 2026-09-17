// File snapshots for /rewind (ticket 01).
//
// Every write/edit auto-snapshots the affected file's prior bytes BEFORE the
// mutation runs (the capture calls live inside writeTool/editTool, so every
// caller — loop, tests, future subagents — is covered regardless of path).
// Snapshots are silent: no prompt, no config, and a snapshot failure never
// fails the mutation it precedes (capturePriorBytes resolves null).
//
// Session-scoped and in-memory (small files stay as Buffers; files over
// SNAPSHOT_OVERFLOW_BYTES spill a copy under the OS temp dir — never the
// repo itself). Checkpoints are bound to the history lineage they were
// captured in: any history replacement (/clear, /new, /resume, compaction)
// drops them via clearSnapshots (see src/rollback.ts) — disk files are
// unaffected, only the undo evidence goes. Restores are byte-exact and hash-verified (sha256 of the
// bytes on disk must equal the pre-mutation hash, not a model rewrite).
// Shell side effects (bash) are explicitly out of scope: commands are never
// snapshotted and cannot be undone — the /rewind UI says so outright.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SnapshotFile = {
  /** Resolved absolute path of the snapshotted file. */
  abs: string;
  /** False when the file did not exist before the mutation (restore deletes). */
  existed: boolean;
  /** sha256 hex of the prior bytes; null when the file did not exist. */
  hash: string | null;
  /** In-memory prior bytes; null when spilled to overflowPath or not existed. */
  bytes: Buffer | null;
  /** Temp-dir copy for large files (never the repo); null otherwise. */
  overflowPath: string | null;
};

export type Checkpoint = {
  id: string;
  /** 1-based session sequence shown in the picker (#1, #2, …). */
  seq: number;
  at: number;
  /** Human label, e.g. "write src/foo.ts". */
  label: string;
  /** History/turns lengths at capture time (conversation-rewind marks). */
  historyLength: number;
  turnsLength: number;
  files: SnapshotFile[];
};

// Large-file spill threshold + session cap (oldest checkpoints drop off;
// their temp copies are removed best-effort so the session cannot leak).
export const SNAPSHOT_OVERFLOW_BYTES = 256 * 1024;
export const MAX_CHECKPOINTS = 50;
const SNAPSHOT_DIR = "atom-snapshots";

let checkpoints: Checkpoint[] = [];
let seq = 0;

export type HistoryMarks = { history: number; turns: number };

// Probe for the live conversation lengths (registered once by App on mount;
// tools.ts must stay free of App/zen imports, so the lengths flow in here).
// Null when unregistered (plain tool tests) — marks default to 0.
let historyProbe: (() => HistoryMarks | null) | null = null;

export function registerHistoryProbe(fn: (() => HistoryMarks | null) | null): void {
  historyProbe = fn;
}

function currentMarks(): HistoryMarks {
  try {
    const m = historyProbe?.();
    if (
      m !== null &&
      m !== undefined &&
      typeof m.history === "number" &&
      Number.isFinite(m.history) &&
      typeof m.turns === "number" &&
      Number.isFinite(m.turns)
    ) {
      return { history: Math.max(0, Math.floor(m.history)), turns: Math.max(0, Math.floor(m.turns)) };
    }
  } catch {
    // A broken probe must never break the mutation being snapshotted.
  }
  return { history: 0, turns: 0 };
}

/** Test isolation (plus history-lineage resets): drops every checkpoint.
 * Returns the number dropped so callers can report discarded undo evidence.
 * Disk files are untouched — only the in-memory evidence (and its temp
 * overflow copies) goes. */
export function clearSnapshots(): number {
  const dropped = checkpoints.length;
  for (const cp of checkpoints) {
    for (const f of cp.files) {
      if (f.overflowPath) {
        void fsp.rm(f.overflowPath, { force: true }).catch(() => undefined);
      }
    }
  }
  checkpoints = [];
  seq = 0;
  return dropped;
}

/** Newest-last copy for the picker and tests (the stored entries stay private). */
export function listCheckpoints(): Checkpoint[] {
  return [...checkpoints];
}

export function getCheckpoint(id: string): Checkpoint | undefined {
  return checkpoints.find((c) => c.id === id);
}

function snapshotDir(): string {
  return path.join(os.tmpdir(), SNAPSHOT_DIR);
}

// Crash-leftover overflow copies (a killed process never runs its eviction)
// would leak in the temp dir forever: prune files older than maxAgeMs on
// every new spill, mirroring the tool overflow-file precedent. Synchronous
// and best-effort, never throws. Returns the number removed (for tests).
export const SNAPSHOT_OVERFLOW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function pruneStaleSnapshotOverflow(
  maxAgeMs: number = SNAPSHOT_OVERFLOW_MAX_AGE_MS
): number {
  try {
    const dir = snapshotDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return 0; // nothing spilled yet — nothing to prune
    }
    const now = Date.now();
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith("snapshot-")) continue;
      try {
        const p = path.join(dir, name);
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.rmSync(p, { force: true });
          removed += 1;
        }
      } catch {
        // ignore per-file failures (a stale spill is harmless)
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

function newCheckpointId(nextSeq: number): string {
  return `${Date.now().toString(36)}-${nextSeq.toString(36)}${randomBytes(3).toString("hex")}`;
}

async function readPrior(abs: string): Promise<SnapshotFile> {
  let st: { isFile(): boolean; size: number };
  try {
    const s = await fsp.stat(abs);
    st = s;
  } catch {
    return { abs, existed: false, hash: null, bytes: null, overflowPath: null };
  }
  if (!st.isFile()) return { abs, existed: false, hash: null, bytes: null, overflowPath: null };
  // Large files spill via STREAMING copy (constant memory): a full readFile
  // just to decide the file is too big would itself OOM on GB inputs.
  if (st.size > SNAPSHOT_OVERFLOW_BYTES) {
    try {
      pruneStaleSnapshotOverflow();
      const dir = snapshotDir();
      await fsp.mkdir(dir, { recursive: true });
      const name = `snapshot-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.bin`;
      const file = path.join(dir, name);
      const hash = await streamCopyWithHash(abs, file);
      return { abs, existed: true, hash, bytes: null, overflowPath: file };
    } catch {
      // Streaming failed (disk/perm) — fall through to the bounded read
      // below, which keeps small files restorable; a huge file here can
      // still press memory, but only when the disk path already failed.
    }
  }
  let bytes: Buffer | null = null;
  try {
    bytes = await fsp.readFile(abs);
  } catch {
    return { abs, existed: false, hash: null, bytes: null, overflowPath: null };
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength > SNAPSHOT_OVERFLOW_BYTES) {
    try {
      pruneStaleSnapshotOverflow();
      const dir = snapshotDir();
      await fsp.mkdir(dir, { recursive: true });
      const name = `snapshot-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.bin`;
      const file = path.join(dir, name);
      await fsp.writeFile(file, bytes);
      return { abs, existed: true, hash, bytes: null, overflowPath: file };
    } catch {
      // Spill failed — keep the in-memory bytes (restore still works).
    }
  }
  return { abs, existed: true, hash, bytes, overflowPath: null };
}

// Constant-memory file copy that hashes while streaming: the hash covers
// exactly the bytes landed on disk (restore re-verifies against it).
function streamCopyWithHash(src: string, dest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let settled = false;
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    let rs: fs.ReadStream;
    let ws: fs.WriteStream;
    try {
      rs = fs.createReadStream(src);
      ws = fs.createWriteStream(dest);
    } catch (e) {
      fail(e);
      return;
    }
    rs.on("error", fail);
    ws.on("error", fail);
    rs.on("data", (chunk) => {
      hash.update(chunk as Buffer);
    });
    ws.on("finish", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(hash.digest("hex"));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    rs.pipe(ws);
  });
}

function pushCheckpoint(label: string, files: SnapshotFile[], marks: HistoryMarks): Checkpoint {
  seq += 1;
  const cp: Checkpoint = {
    id: newCheckpointId(seq),
    seq,
    at: Date.now(),
    label,
    historyLength: marks.history,
    turnsLength: marks.turns,
    files,
  };
  checkpoints.push(cp);
  while (checkpoints.length > MAX_CHECKPOINTS) {
    const dropped = checkpoints.shift();
    for (const f of dropped?.files ?? []) {
      if (f.overflowPath) {
        void fsp.rm(f.overflowPath, { force: true }).catch(() => undefined);
      }
    }
  }
  return cp;
}

// THE capture hook: snapshot prior bytes, then record one checkpoint. Never
// throws and never returns an error into the mutation path — a missed
// snapshot just means no checkpoint for this write. `priorText` lets a
// caller that ALREADY read the file (edit's own pre-read) pass the bytes
// through: no second stat + read + spill decision, same checkpoint bytes.
// Semantics match readPrior exactly (existed, sha256, overflow spill past
// SNAPSHOT_OVERFLOW_BYTES); a mismatch falls back to the disk read.
export async function capturePriorBytes(abs: string, label: string, priorText?: string): Promise<Checkpoint | null> {
  try {
    if (typeof abs !== "string" || abs.length === 0) return null;
    const file = typeof priorText === "string" ? await snapshotFromText(abs, priorText) : null;
    const cleanLabel = typeof label === "string" && label.length > 0 ? label : "edit";
    if (file !== null) return pushCheckpoint(cleanLabel, [file], currentMarks());
    const disk = await readPrior(abs);
    return pushCheckpoint(cleanLabel, [disk], currentMarks());
  } catch {
    return null;
  }
}

// In-memory variant of readPrior for caller-supplied text (edit overlap):
// same existed/hash/spill contract as the disk path, minus the stat +
// re-read syscalls. Async (spill writes) — callers already await the hook.
async function snapshotFromText(abs: string, priorText: string): Promise<SnapshotFile | null> {
  try {
    const bytes = Buffer.from(priorText, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength > SNAPSHOT_OVERFLOW_BYTES) {
      try {
        pruneStaleSnapshotOverflow();
        const dir = snapshotDir();
        await fsp.mkdir(dir, { recursive: true });
        const name = `snapshot-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.bin`;
        const file = path.join(dir, name);
        await fsp.writeFile(file, bytes);
        return { abs, existed: true, hash, bytes: null, overflowPath: file };
      } catch {
        // Spill failed — keep the in-memory bytes (restore still works),
        // exactly like readPrior's fallback below.
      }
    }
    return { abs, existed: true, hash, bytes, overflowPath: null };
  } catch {
    return null;
  }
}

async function priorBytesOf(f: SnapshotFile): Promise<Buffer | null> {
  if (!f.existed) return null;
  if (f.bytes !== null) return f.bytes;
  if (f.overflowPath) {
    try {
      return await fsp.readFile(f.overflowPath);
    } catch {
      return null;
    }
  }
  return null;
}

// Restore every file in the checkpoint to its prior bytes (or delete files
// the mutation created), hash-verified. Returns a one-line summary or an
// "Error: ..." string — never throws. onRestored lets the caller refresh
// derived state per file (tools.ts stale-read fingerprints); text is null
// for deletions. Observer errors never break the restore.
export async function restoreCheckpointFiles(
  id: string,
  onRestored?: (abs: string, text: string | null) => void
): Promise<string> {
  const cp = getCheckpoint(id);
  if (!cp) return "Error: unknown checkpoint";
  let restored = 0;
  for (const f of cp.files) {
    try {
      if (!f.existed) {
        try {
          await fsp.rm(f.abs, { force: true });
        } catch {
          return `Error: rewind failed: cannot remove ${f.abs}`;
        }
        try {
          onRestored?.(f.abs, null);
        } catch {
          // ignore observer errors
        }
        restored += 1;
        continue;
      }
      const prior = await priorBytesOf(f);
      if (prior === null) return `Error: rewind failed: snapshot for ${f.abs} is unreadable`;
      // Pre-write verification: the snapshot bytes in hand must hash to the
      // pre-mutation hash BEFORE anything touches disk, so a corrupt snapshot
      // fails loudly while leaving the live file exactly as it was.
      if (createHash("sha256").update(prior).digest("hex") !== f.hash) {
        return `Error: rewind failed: hash mismatch restoring ${f.abs}`;
      }
      try {
        await fsp.mkdir(path.dirname(f.abs), { recursive: true });
        await fsp.writeFile(f.abs, prior);
      } catch {
        return `Error: rewind failed: cannot restore ${f.abs}`;
      }
      // Post-write re-read: guards a concurrent modification racing the
      // restore itself (the bytes just written must still hash correctly).
      let check: Buffer;
      try {
        check = await fsp.readFile(f.abs);
      } catch {
        return `Error: rewind failed: cannot verify ${f.abs}`;
      }
      if (createHash("sha256").update(check).digest("hex") !== f.hash) {
        return `Error: rewind failed: hash mismatch restoring ${f.abs}`;
      }
      try {
        onRestored?.(f.abs, prior.toString("utf8"));
      } catch {
        // ignore observer errors
      }
      restored += 1;
    } catch {
      return `Error: rewind failed: cannot restore ${f.abs}`;
    }
  }
  if (restored === 0) return `(checkpoint #${cp.seq} — nothing to restore)`;
  return `(rewound ${restored} file(s) to checkpoint #${cp.seq})`;
}

export type RewindMessage = { role: string; hasToolCalls?: boolean };

// Conversation-rewind cut for a checkpoint mark: drop the whole turn that
// contains the mark (submit's splice(rollbackTo) rollback semantics), so
// assistant/tool pairing can never split. A mark taken after a turn already
// committed (an assistant message without tool_calls sits inside the slice)
// keeps everything through the mark — only later turns drop. keepFirst is
// the floor (1 keeps the system prompt for API history; 0 for the display
// transcript, which has no system line). Pure — unit-tested directly.
export function conversationCutIndex(
  messages: RewindMessage[],
  mark: number,
  keepFirst = 1
): number {
  const len = messages.length;
  const floor = Math.max(0, Math.floor(keepFirst));
  if (len <= floor) return len;
  const m = Math.max(floor, Math.min(Number.isFinite(mark) ? Math.floor(mark) : len, len));
  let turnStart = -1;
  for (let i = m - 1; i >= floor; i--) {
    if (messages[i]?.role === "user") {
      turnStart = i;
      break;
    }
  }
  if (turnStart === -1) return floor;
  for (let i = turnStart; i < m; i++) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === "assistant" && msg.hasToolCalls !== true) return m;
  }
  return turnStart;
}
