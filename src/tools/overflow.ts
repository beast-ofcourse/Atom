// Overflow-to-temp spill for over-cap tool output. Best-effort, never
// throws; stale spills prune by age on each write.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// under the OS temp dir (<tmpdir>/atom-overflow/), every I/O step is
// best-effort and never throws (null/"" = keep the plain truncation note).
// Stale spills are pruned by age on each write; the OS reclaims the rest.
// Under-cap results never touch this path (byte-identical). Scope: byte-cap
// truncations where the full text is in hand (read, bash, bash_output,
// webfetch output). Count-cap notes (grep/glob "more than N matches") and
// prompt-assembly caps (skills, compact, AGENTS.md, history) are unchanged:
// their heads are already the most-relevant slice and re-query narrows them.
const OVERFLOW_DIR = "atom-overflow";
const OVERFLOW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let overflowSeq = 0;

export function overflowDir(): string {
  return path.join(os.tmpdir(), OVERFLOW_DIR);
}

function pruneOverflowFiles(): void {
  try {
    const dir = overflowDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // nothing spilled yet — nothing to prune
    }
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith("overflow-")) continue;
      try {
        const p = path.join(dir, name);
        if (now - fs.statSync(p).mtimeMs > OVERFLOW_MAX_AGE_MS) fs.rmSync(p, { force: true });
      } catch {
        // ignore per-file failures (a stale spill is harmless)
      }
    }
  } catch {
    // never throw across the tool boundary
  }
}

// Write the FULL over-cap text to a temp file; null when anything fails.
export function spillOverflow(fullText: string): string | null {
  try {
    if (typeof fullText !== "string" || fullText.length === 0) return null;
    pruneOverflowFiles();
    const dir = overflowDir();
    fs.mkdirSync(dir, { recursive: true });
    overflowSeq += 1;
    const name = `overflow-${process.pid}-${Date.now().toString(36)}-${overflowSeq}-${randomBytes(4).toString("hex")}.txt`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, fullText, "utf8");
    return file;
  } catch {
    return null;
  }
}

// Head + existing truncation note + followable overflow pointer (or just
// head + note when the spill fails — never throws, never empty-handed).
export function appendOverflow(head: string, truncNote: string, label: string, fullText: string): string {
  const file = spillOverflow(fullText);
  if (!file) return head + truncNote;
  return (
    `${head}${truncNote}\n` +
    `[overflow: full ${label} (${fullText.length} chars) spilled to ${file} — ` +
    `use read with offset/limit to page through it]`
  );
}
