// Effect-aware tool scheduler: data-driven parallelism, parallel by default.
//
// The contract: batchable calls run concurrently, conflicting calls stay
// serialized, results commit in original call order, cancel stops between
// batches, approval happens per call in order before execution. This module
// only PLANS batches; execution (agent/loop.ts runLoopWithChat) is untouched.
//
// Parallel-by-default posture: side-effect-free reads batch unconditionally
// (same target included — two reads can never race each other); only real
// conflicts serialize: same-file write order, read/write on the same file,
// invisible footprints (bash), shared ambient state (todos), interactive
// prompts, and calls the planner cannot see (unknown/malformed/invalid).
//
// How it reasons (per tool, from the TOOL_EFFECTS table — the single
// coupling point; the algorithm below has no per-tool branches):
// - missing metadata → serial singleton (new tools fail safe, like the old
//   allowlist-miss; current safe behavior is preserved when metadata is
//   absent, not degraded).
// - unknown name / malformed JSON / failed validation / empty target →
//   serial singleton (never batch what you cannot see; validation failures
//   become inline-error singletons downstream, exactly as before).
// - interactive (ask_question) or exclusive (shared ambient state the effect
//   model cannot see: todowrite/todo_update/todo_get) → serial singleton.
// - process SPAWN or network WRITE (bash: unbounded footprint) → serial
//   singleton, splitting the block globally.
// - filesystem writes (write/edit) batch on disjoint canonical file keys
//   (see canonicalFileKey): same-file mutations never share a batch, so they
//   stay strictly ordered in program order; different files run concurrently.
//   An unresolvable target stays serial (never batch what you cannot see).
// - reads (filesystem or network) always batch: a pure read has no observable
//   footprint, so even the same tool + same target runs concurrently. A path
//   read against an open write to the same canonical file still stays ordered
//   (read-after-write): it splits the batch — and a write conflicts with any
//   open read on its key (write-after-read stays ordered). Directory-scoped
//   scans (grep/glob) vs concurrent writes to unscanned-listed files are out
//   of scope — same exposure as an editor saving mid-scan; only
//   same-canonical-path pairs are ordered.
// - deterministic is informational only (same output for same args); it no
//   longer drives batching — not even same-task bash_output polls serialize,
//   since concurrent polls are side-effect-free reads whose results commit in
//   call order anyway.
//
// Pure module except the shared arg validators (same imports zen.ts already
// carries — no new coupling class) plus best-effort path canonicalization
// (node:fs/node:path only, so the architecture boundary is unchanged:
// scheduler still reasons from metadata, never from tool branches).
// Covered by tests/scheduler.test.ts; the end-to-end ordering/cancel
// behavior stays pinned by tests/parallel-calls.test.ts and
// tests/parallel-writes.test.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import { toolNames, validateToolArgs } from "./tools.js";

export type FilesystemEffect = "none" | "read" | "write";
export type NetworkEffect = "none" | "read" | "write";
export type ProcessEffect = "none" | "spawn";

export type ToolEffect = {
  filesystem: FilesystemEffect;
  network: NetworkEffect;
  process: ProcessEffect;
  /** Blocks on a UI modal (parallel prompts make no sense). */
  interactive: boolean;
  /**
   * Shares ambient module state outside the effect model (todo list):
   * always a serial singleton, even for pure reads of that state.
   */
  exclusive: boolean;
  /** Same output for same args (informational; batching no longer keys on it). */
  deterministic: boolean;
  /**
   * Read target for conflict checks against open writes on the same canonical
   * file (read-after-write ordering). Null/"" means unknown footprint →
   * serial. Writes/spawns ignore it (they conflict globally).
   */
  target: (args: Record<string, unknown>) => string | null;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const targetOf =
  (key: string) =>
  (args: Record<string, unknown>): string | null => {
    const t = str(args[key]);
    return t.length > 0 ? t : null;
  };

/** Effect metadata for every known tool. Missing name ⇒ serial singleton. */
export const TOOL_EFFECTS: Record<string, ToolEffect> = {
  read: {
    filesystem: "read",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: false,
    deterministic: true,
    target: targetOf("path"),
  },
  grep: {
    filesystem: "read",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: false,
    deterministic: true,
    target: targetOf("pattern"),
  },
  glob: {
    filesystem: "read",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: false,
    deterministic: true,
    target: targetOf("pattern"),
  },
  webfetch: {
    filesystem: "none",
    network: "read",
    process: "none",
    interactive: false,
    exclusive: false,
    deterministic: true,
    target: targetOf("url"),
  },
  websearch: {
    filesystem: "none",
    network: "read",
    process: "none",
    interactive: false,
    exclusive: false,
    // Live search results vary call to call; concurrent same-query searches
    // are merely redundant, never incorrect — reads always batch.
    deterministic: false,
    target: targetOf("query"),
  },
  bash_output: {
    // Reads background-task temp files scoped by taskId (not the repo).
    filesystem: "read",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: false,
    // A running task's output grows between polls — concurrent same-task
    // polls are side-effect-free reads whose results commit in call order.
    deterministic: false,
    target: targetOf("taskId"),
  },
  write: {
    filesystem: "write",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: false,
    deterministic: true,
    target: targetOf("path"),
  },
  edit: {
    filesystem: "write",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: false,
    deterministic: true,
    target: targetOf("path"),
  },
  bash: {
    // A command can touch anything (files, network, processes) with no
    // statically visible footprint: global conflict, always singleton.
    filesystem: "write",
    network: "write",
    process: "spawn",
    interactive: false,
    exclusive: false,
    deterministic: false,
    target: targetOf("command"),
  },
  ask_question: {
    filesystem: "none",
    network: "none",
    process: "none",
    interactive: true,
    exclusive: false,
    deterministic: false,
    target: () => null,
  },
  todowrite: {
    filesystem: "none",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: true,
    deterministic: false,
    target: () => null,
  },
  todo_update: {
    filesystem: "none",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: true,
    deterministic: false,
    target: () => null,
  },
  todo_get: {
    filesystem: "none",
    network: "none",
    process: "none",
    interactive: false,
    exclusive: true,
    deterministic: true,
    target: () => null,
  },
};

/** Structural tool-call shape (no import from zen — zero coupling). */
export type SchedulableCall = {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown } | null;
};

export type PlannedToolCall<C extends SchedulableCall = SchedulableCall> = {
  call: C;
  /** Lenient parse ({} when the JSON is malformed — classification only). */
  parsed: Record<string, unknown>;
  /** Non-null exactly when the call may join a parallel batch. */
  parallelKey: string | null;
};

// Canonical per-file mutation key: the identity two mutation calls compare
// before sharing a batch. Lexical resolve against the process cwd (the same
// base the executors default to), then best-effort symlink resolution, then
// case-folding on case-insensitive filesystems. Null when the target is
// missing, empty, or unresolvable — unknown footprints stay serial. Sync and
// best-effort by design: a handful of calls per tool block, and a miss only
// costs parallelism, never correctness.
export function canonicalFileKey(rawPath: unknown, cwd: string = process.cwd()): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  if (rawPath.includes("\0")) return null;
  let abs: string;
  try {
    abs = path.resolve(cwd, rawPath);
  } catch {
    return null;
  }
  try {
    abs = fs.realpathSync(abs);
  } catch {
    // Fresh write target or unreadable link: the lexical path stands.
  }
  try {
    abs = path.normalize(abs);
  } catch {
    return null;
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    abs = abs.toLowerCase();
  }
  return abs;
}

// Partition one assistant message's tool_calls into commit batches,
// preserving program order: consecutive batchable calls form one batch; any
// serial-only call closes the batch and runs as a strict serial singleton.
// Filesystem writes join a batch only on a disjoint canonical file key
// (same-file mutations split into sequential batches, never concurrent); a
// path read conflicting with an open write — or a write conflicting with any
// open member — on the same canonical key also splits, so per-file program
// order always holds. Reads never split on each other. A later batch never
// moves ahead of an earlier serial call, and batches never span the block
// boundary.
export function planBatches<C extends SchedulableCall>(
  calls: readonly C[]
): PlannedToolCall<C>[][] {
  const batches: PlannedToolCall<C>[][] = [];
  let open: PlannedToolCall<C>[] = [];
  // Canonical file keys of the open batch ("read" and/or "write" per key).
  // This is the ONLY cross-call ordering state: same-file read/write pairs
  // stay in program order; everything else batches freely.
  const openFiles = new Map<string, "read" | "write">();
  const flush = (): void => {
    if (open.length > 0) {
      batches.push(open);
      open = [];
      openFiles.clear();
    }
  };
  const singleton = (call: C, parsed: Record<string, unknown>): void => {
    flush();
    batches.push([{ call, parsed, parallelKey: null }]);
  };
  for (const call of calls) {
    let parsed: Record<string, unknown>;
    let malformed = false;
    try {
      const raw = call?.function?.arguments ?? "{}";
      const v: unknown = JSON.parse(typeof raw === "string" ? raw : "{}");
      parsed = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    } catch {
      parsed = {};
      malformed = true;
    }
    const name =
      typeof call?.function?.name === "string" ? call.function.name : "(unknown)";
    // Missing metadata fails safe to serial (never batch the unknown).
    const meta = TOOL_EFFECTS[name];
    if (malformed || !meta || !toolNames().includes(name)) {
      singleton(call, parsed);
      continue;
    }
    // Failed validation becomes an inline-error singleton downstream.
    if (validateToolArgs(name, parsed)) {
      singleton(call, parsed);
      continue;
    }
    // Interactive, ambient-state, spawning, or network-writing calls
    // serialize (bash has no statically visible footprint: global conflict).
    if (
      meta.interactive ||
      meta.exclusive ||
      meta.network === "write" ||
      meta.process !== "none"
    ) {
      singleton(call, parsed);
      continue;
    }
    // Filesystem writes batch on disjoint canonical file keys: the
    // per-file mutation queue. Same-file mutations split into sequential
    // batches (never interleave); disjoint files run concurrently.
    if (meta.filesystem === "write") {
      const fileKey = canonicalFileKey(parsed["path"]);
      if (!fileKey || openFiles.has(fileKey)) {
        singleton(call, parsed);
        continue;
      }
      openFiles.set(fileKey, "write");
      open.push({ call, parsed, parallelKey: `${name} ${fileKey}` });
      continue;
    }
    // Reads always batch (parallel by default): a pure read has no
    // observable footprint, so even the same tool + same target runs
    // concurrently. Empty target = unknown footprint = serial.
    let target: string | null = null;
    try {
      target = meta.target(parsed);
    } catch {
      target = null;
    }
    if (!target) {
      singleton(call, parsed);
      continue;
    }
    const key = `${name} ${target}`;
    // A path read against an open write to the same canonical file stays
    // ordered (read-after-write): split the batch.
    if (name === "read") {
      const fileKey = canonicalFileKey(target);
      if (fileKey && openFiles.get(fileKey) === "write") {
        singleton(call, parsed);
        continue;
      }
      if (fileKey && !openFiles.has(fileKey)) openFiles.set(fileKey, "read");
      open.push({ call, parsed, parallelKey: key });
      continue;
    }
    open.push({ call, parsed, parallelKey: key });
  }
  flush();
  return batches;
}
