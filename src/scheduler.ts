// Effect-aware tool scheduler: data-driven parallelism without Promise.all-
// ing every tool.
//
// The conservative contract (unchanged): batchable reads run concurrently,
// mutations stay serialized, results commit in original call order, cancel
// stops between batches, approval happens per call inside runOneTool. This
// module only PLANS batches; execution (zen.ts runLoopWithChat) is untouched.
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
// - any filesystem/network WRITE, or any process SPAWN → serial singleton.
//   Writes conflict GLOBALLY (not just same-target): a write splits the
//   block and read-after-write stays ordered. Target-scoped write batching
//   is a deliberate non-goal — correctness over theoretical parallelism.
// - reads (filesystem or network) batch with pairwise-disjoint keys, where
//   the key is tool + target. Same tool + same target serializes (the old
//   overlap rule, kept verbatim: e.g. two reads of one path). Reads never
//   conflict across keys — an all-read batch cannot race a writer, because
//   writers never join batches.
// - deterministic is declared per tool; its current enforcement is the
//   same-key rule (a re-poll of the same background task, whose output can
//   grow, never runs concurrently with itself).
//
// Pure module except the shared arg validators (same imports zen.ts already
// carries — no new coupling class). Covered by tests/scheduler.test.ts; the
// end-to-end ordering/cancel behavior stays pinned by
// tests/parallel-calls.test.ts.
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
  /** Same output for same args (same-key rule is its enforcement). */
  deterministic: boolean;
  /**
   * Batching scope for reads (the same-tool + same-target overlap rule).
   * Mirrors the audit-line primary per tool; null/"" means unknown
   * footprint → serial. Writes/spawns ignore it (they conflict globally).
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
    // Live search results vary call to call; same-query conflict is still
    // serialized by the same-key rule.
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
    // A running task's output grows between polls — same-task polls
    // serialize via the same-key rule.
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

// Partition one assistant message's tool_calls into commit batches,
// preserving program order: consecutive batchable calls with pairwise
// disjoint keys form one batch; any serial-only call — and any call whose
// key already appears in the open batch — closes the batch and runs as a
// strict serial singleton. A later batch never moves ahead of an earlier
// serial call (read-after-write stays ordered), and batches never span the
// block boundary.
export function planBatches<C extends SchedulableCall>(
  calls: readonly C[]
): PlannedToolCall<C>[][] {
  const batches: PlannedToolCall<C>[][] = [];
  let open: PlannedToolCall<C>[] = [];
  const keys = new Set<string>();
  const flush = (): void => {
    if (open.length > 0) {
      batches.push(open);
      open = [];
      keys.clear();
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
    // Interactive, ambient-state, mutating, or spawning calls serialize.
    if (
      meta.interactive ||
      meta.exclusive ||
      meta.filesystem === "write" ||
      meta.network === "write" ||
      meta.process !== "none"
    ) {
      singleton(call, parsed);
      continue;
    }
    // Reads batch on disjoint tool+target keys; empty target = unknown
    // footprint = serial.
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
    if (keys.has(key)) {
      singleton(call, parsed);
      continue;
    }
    keys.add(key);
    open.push({ call, parsed, parallelKey: key });
  }
  flush();
  return batches;
}
