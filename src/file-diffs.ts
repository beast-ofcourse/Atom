// Per-turn file-diff records (ticket 06) for the compaction summary's
// Relevant Files section.
//
// Each completed turn records which files it actually touched; the records
// accumulate across turns under the session's `metadata.filediffs` key and
// feed the summary's files section through compact.ts's existing
// format/fit helpers (read-only — this module never changes summary output).
//
// WIRING CONTRACT (for the conductor follow-up; App.tsx untouched here):
// - AFTER each completed turn commits (failed/cancelled turns are rolled
//   back and never recorded), call `collectTurnFileDiffs(turnMessages)`
//   with that turn's committed messages (passing the whole turn slice is
//   safe — only assistant tool_calls are inspected; capture never changes
//   tool behavior).
// - When the result is non-empty, accumulate and persist:
//     const prev = readFileDiffs(session.metadata?.["filediffs"]);
//     const merged = mergeFileDiffs(prev, turn);
//     updateSession(id, {
//       metadata: { ...session.metadata, [FILE_DIFFS_METADATA_KEY]: serializeFileDiffs(merged) },
//     });
// - On session switch/restore, rehydrate with
//   `readFileDiffs(next.metadata?.["filediffs"])` (missing key reads as
//   empty; malformed values degrade to empty without failing the load).
// - At compaction time, pass the accumulated record straight into the
//   existing `formatTouchedFiles` / `fitSummaryWithFiles` /
//   `fitSummaryWithFilesAndGoal` helpers from compact.ts.
//
// Vocabulary: this module reuses compact.ts's TouchedFiles shape
// ({ read, modified }) — no competing file-tracking vocabulary. A path both
// read and written lands in modified only (the write implies the read).
// The `metadata.todos` key (ticket 05) is never read or written here.

import { collectTouchedFiles, type TouchedFiles } from "./compact.js";
import type { ChatMessage } from "./zen.js";

// Namespace inside the generic Session.metadata record (ticket 01).
export const FILE_DIFFS_METADATA_KEY = "filediffs";

// Per-turn change record: the files one turn actually touched. Accumulated
// across turns by merging into the session-scoped record.
export type TurnFileDiffs = TouchedFiles;

export function emptyFileDiffs(): TouchedFiles {
  return { read: [], modified: [] };
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((v) => typeof v === "string")
  );
}

// Collect one turn's change record from its committed messages. Write/edit-
// style tool outcomes land in modified, read-style outcomes in read
// (insertion order, unique, modified-wins); unparseable arguments are
// skipped. Turns with no file changes produce an empty record — never
// spurious entries. Pure observer: tool behavior is untouched.
export function collectTurnFileDiffs(
  turnMessages: ChatMessage[]
): TouchedFiles {
  if (!Array.isArray(turnMessages)) return emptyFileDiffs();
  const collected = collectTouchedFiles(turnMessages);
  // Defensive copy: callers must never alias compact.ts internals.
  return { read: [...collected.read], modified: [...collected.modified] };
}

// Accumulate one turn's record into the session-scoped record. Insertion
// order is preserved, entries stay unique, and a path promoted from read to
// modified (read in an earlier turn, written later) ends in modified only.
// Neither input is mutated; the result is a fresh record.
export function mergeFileDiffs(
  accumulated: TouchedFiles,
  turn: TouchedFiles
): TouchedFiles {
  const base = readFileDiffs(accumulated);
  const next = readFileDiffs(turn);
  const read = [...base.read];
  const modified = [...base.modified];
  for (const p of next.read) {
    if (!modified.includes(p) && !read.includes(p)) read.push(p);
  }
  for (const p of next.modified) {
    const at = read.indexOf(p);
    if (at >= 0) read.splice(at, 1);
    if (!modified.includes(p)) modified.push(p);
  }
  return { read, modified };
}

// Tolerant read of the `metadata.filediffs` value: missing keys read as
// empty, and malformed values (wrong shape, non-string entries) degrade to
// the valid subset — or empty — WITHOUT failing the session load. Always
// returns a fresh record.
export function readFileDiffs(value: unknown): TouchedFiles {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyFileDiffs();
  }
  const record = value as Record<string, unknown>;
  const rawRead = isStringList(record["read"]) ? record["read"] : [];
  const rawModified = isStringList(record["modified"])
    ? record["modified"]
    : [];
  const read: string[] = [];
  const modified: string[] = [];
  for (const raw of rawModified) {
    const p = raw.trim();
    if (p.length > 0 && !modified.includes(p)) modified.push(p);
  }
  const modifiedSet = new Set(modified);
  for (const raw of rawRead) {
    const p = raw.trim();
    if (p.length === 0 || modifiedSet.has(p) || read.includes(p)) continue;
    read.push(p);
  }
  return { read, modified };
}

// JSON-safe snapshot for `metadata.filediffs` persistence via the existing
// updateSession/getSession APIs (no schema edits). Fresh copy every call.
export function serializeFileDiffs(diffs: TouchedFiles): TouchedFiles {
  return readFileDiffs(diffs);
}
