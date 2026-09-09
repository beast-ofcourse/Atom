// Rollback semantics: three independent scopes, explicitly NOT one transaction.
//
// ATOM is a coding agent, not a database: cancelling or failing a turn rolls
// the CONVERSATION back while the world it touched stays as it is. This
// module encodes that distinction in one place so runtime behavior, UX text,
// and docs cannot drift apart:
//
// - conversation — AUTOMATIC. History/turns splice back to the turn start on
//   cancel or POST failure (submit's catch), to a checkpoint mark on /rewind
//   "conversation" scopes, or to empty on /clear. Rolled-back turns never
//   reach the session file. Tool ERROR results are model-visible results and
//   are never rolled back — only whole-turn cancel/failure.
// - filesystem — EXPLICIT ONLY. The sole filesystem rollback is an explicit
//   /rewind file restore (byte-exact, hash-verified). Cancel and failure
//   NEVER revert disk: checkpoints taken mid-turn survive the cancel as
//   evidence, and the cancelled-turn line says so outright. Snapshots are
//   pre-mutation evidence, not a journal — there is no commit/abort.
// - process — NEVER. Foreground bash runs to completion (cancel stops the
//   turn AFTER the current tool finishes, never mid-exec); background tasks
//   are detached and survive cancel; nothing is ever killed. Shell side
//   effects are not snapshotted and cannot be undone.
//
// Lineage rule: file checkpoints are bound to the history lineage they were
// captured in (their history/turns marks are indices into that exact array).
// Any operation that REPLACES the history array (/clear, /new, /resume,
// compaction) drops all checkpoints — a stale mark could otherwise truncate
// the NEW conversation's tail. Disk files are unaffected by the drop; only
// the undo evidence goes.
//
// Pure module (no I/O, no UI): App owns the splice/restore side effects and
// snapshots.ts owns the bytes. Covered by tests/rollback.test.ts.
export type RollbackScope = "conversation" | "filesystem" | "process";

export type RollbackMode = "automatic" | "explicit" | "never";

/** How each scope rolls back: automatic, explicit-only, or never. */
export const ROLLBACK_MODE: Record<RollbackScope, RollbackMode> = {
  conversation: "automatic",
  filesystem: "explicit",
  process: "never",
};

/** One-line runtime truth per scope, reused by UX text and docs. */
export const ROLLBACK_NOTES: Record<RollbackScope, string> = {
  conversation:
    "history/turns splice back to the turn start (cancel/failure) or a checkpoint mark (/rewind); rolled-back turns never reach the session file",
  filesystem:
    "only an explicit /rewind restore reverts bytes (hash-verified); cancel and failure never touch disk",
  process:
    "never rolled back: foreground bash runs to completion, background tasks survive cancel, nothing is killed",
};

/**
 * The cancelled-turn transcript line. Keeps the historical "(cancelled)"
 * marker byte-identical (tests and muscle memory match on the substring)
 * and states the no-revert truth in the same breath, so a cancel can never
 * read as "undone".
 */
export function cancelledTurnLine(): string {
  return "(cancelled) conversation rolled back; files and processes were NOT reverted — /rewind restores file snapshots";
}
