// Session-scoped revert (ticket 08): "undo that bad turn".
//
// Composition only — no new snapshot system. Every piece already exists:
//
// - src/snapshots.ts: getCheckpoint (lookup), restoreCheckpointFiles
//   (byte-exact, hash-verified file restore), conversationCutIndex (the
//   turn-boundary cut shared by /rewind and forkSession), listCheckpoints
//   (no-snapshot detection).
// - src/sessions.ts: getSession (read), updateSession (atomic persist of the
//   truncated record).
//
// Ordering is the atomicity story: file restore runs BEFORE the session
// record is touched, so a failed restore (hash mismatch, unreadable
// snapshot, unknown checkpoint) leaves the session file byte-identical —
// nothing was written yet. If the record persist then fails (disk error,
// record vanished mid-flight), the just-restored files are rolled back to
// their pre-revert bytes best-effort and a clear error is returned; the
// session file itself is untouched either way (updateSession only writes on
// success, atomically).
//
// Forked branches are separate records (ticket 07): this writes exactly one
// session file and never touches any other session or fork.
//
// Import budget: node:fs (promises only) + ./sessions.js + ./snapshots.js.
// Never touches compact/overflow/config/context-manager, loop, todos,
// file-diffs, legacy save, tool execution/registry, permissions/policy,
// skills, or provider adapters.

import { promises as fsp } from "node:fs";
import { getSession, updateSession, type Session } from "./sessions.js";
import type { ChatMessage } from "./zen.js";
import {
  conversationCutIndex,
  getCheckpoint,
  listCheckpoints,
  restoreCheckpointFiles,
  type Checkpoint,
} from "./snapshots.js";

export type SessionRevertSuccess = {
  ok: true;
  session: Session;
  /** Visible confirmation line for the transcript. */
  message: string;
};

export type SessionRevertFailure = {
  ok: false;
  error: string;
};

export type SessionRevertResult = SessionRevertSuccess | SessionRevertFailure;

// Pre-revert disk state for one checkpoint file, so a record-persist
// failure can put the bytes back. Reads are best-effort: an unreadable
// file backs up as not-existed (rollback then removes it, also
// best-effort) — backup never throws and never blocks the revert.
type DiskBackup = {
  abs: string;
  existed: boolean;
  bytes: Buffer | null;
};

async function backupDisk(files: Checkpoint["files"]): Promise<DiskBackup[]> {
  const out: DiskBackup[] = [];
  for (const f of files) {
    try {
      out.push({ abs: f.abs, existed: true, bytes: await fsp.readFile(f.abs) });
    } catch {
      out.push({ abs: f.abs, existed: false, bytes: null });
    }
  }
  return out;
}

async function rollbackDisk(backups: DiskBackup[]): Promise<void> {
  for (const b of backups) {
    try {
      if (!b.existed || b.bytes === null) {
        await fsp.rm(b.abs, { force: true });
      } else {
        await fsp.writeFile(b.abs, b.bytes);
      }
    } catch {
      // Best-effort: the session record is already byte-identical; a
      // failed file rollback is reported, never thrown.
    }
  }
}

function assistantHasToolCalls(m: ChatMessage): boolean {
  return m.role === "assistant" && m.tool_calls !== undefined;
}

// Revert one session's conversation AND files to a checkpoint captured
// earlier in its lineage. Returns a success with the persisted session and
// a confirmation line, or a failure with a clear error — failures never
// write the session file.
export async function revertSessionToCheckpoint(
  sessionId: string,
  checkpointId: string,
  home?: string
): Promise<SessionRevertResult> {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { ok: false, error: "revert failed: missing session id — nothing was changed" };
  }
  if (typeof checkpointId !== "string" || checkpointId.length === 0) {
    return {
      ok: false,
      error:
        "revert failed: missing checkpoint — nothing was changed. " +
        "Pick a checkpoint from /rewind (every write/edit auto-snapshots).",
    };
  }
  const session = getSession(sessionId, home);
  if (!session) {
    return { ok: false, error: "revert failed: unknown session — nothing was changed" };
  }
  const cp = getCheckpoint(checkpointId);
  if (!cp) {
    if (listCheckpoints().length === 0) {
      return {
        ok: false,
        error:
          "no snapshots recorded — nothing to revert and nothing was changed. " +
          "Every write/edit auto-snapshots; make a file edit, then pick a checkpoint via /rewind.",
      };
    }
    return { ok: false, error: "revert failed: checkpoint no longer available — nothing was changed" };
  }

  const backups = await backupDisk(cp.files);

  // Files first: a failed restore returns before the record is touched,
  // so the session file stays byte-identical.
  const filesMsg = await restoreCheckpointFiles(cp.id);
  if (filesMsg.startsWith("Error:")) {
    return { ok: false, error: `${filesMsg} — session left exactly as it was` };
  }

  // Turn-boundary cut (the /rewind + forkSession rule, reused — never
  // reimplemented): drops the whole turn containing the mark so
  // assistant/tool_call pairing can never split. Marks clamp to the live
  // lengths, so a checkpoint from a longer lineage can only shrink.
  const historyCut = conversationCutIndex(
    session.history.map((m) => ({ role: m.role, hasToolCalls: assistantHasToolCalls(m) })),
    cp.historyLength,
    1
  );
  const turnsCut = conversationCutIndex(
    session.turns.map((t) => ({ role: t.role })),
    cp.turnsLength,
    0
  );
  const droppedMessages = session.history.length - historyCut;
  const next = updateSession(
    sessionId,
    {
      history: session.history.slice(0, historyCut),
      turns: session.turns.slice(0, turnsCut),
    },
    home
  );
  if (!next) {
    await rollbackDisk(backups);
    return {
      ok: false,
      error:
        "revert failed: could not save the rewound session (record rejected or vanished) — " +
        "files were restored to their pre-revert state and the session is unchanged",
    };
  }
  return {
    ok: true,
    session: next,
    message:
      `(reverted "${session.title}" to checkpoint #${cp.seq} "${cp.label}" — ` +
      `dropped ${droppedMessages} message(s), restored ${cp.files.length} file(s); ` +
      `shell side effects were never snapshotted and are unchanged)`,
  };
}
