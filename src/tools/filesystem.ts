// Filesystem executors: read/write/edit. Every mutation snapshots prior
// bytes first (see snapshots.ts); validation failures return before capture.
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import {
  MEDIA_MAX_BYTES,
  mediaDescriptor,
  oversizeImageError,
  saveMedia,
  sniffImageMime,
  sniffPdf,
  unsupportedBinaryError,
} from "../media.js";
import { capturePriorBytes } from "../snapshots.js";
import {
  contentHash,
  fingerprintKey,
  readFingerprints,
  setReadFingerprint,
} from "./fingerprints.js";
import { appendOverflow } from "./overflow.js";
import {
  getCachedRead,
  invalidatePath,
  normalizeReadWindow,
  setCachedRead,
} from "./read-cache.js";
import { invalidateListingsForFile } from "./dir-cache.js";
import {
  err,
  invalidCall,
  READ_CHAR_CAP,
  READ_FILE_MAX_BYTES,
  resolveSandbox,
  truncateHead,
} from "./shared.js";
export type ReadArgs = { path: string; offset?: number; limit?: number };

// offset/limit are 1-based line numbers. Output capped at ~64KB.
export async function readTool(
  args: ReadArgs,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    // Single-handle read path (Extreme-fast 3A.1): one open + fstat +
    // positioned reads from the same handle — no separate stat syscall, no
    // second open for the peek, no fresh open for the body. Missing paths
    // and directories fall back to a stat below (failure paths only — the
    // hot path pays exactly one open).
    let fh: import("node:fs/promises").FileHandle | null = null;
    let st: { isDirectory(): boolean; size: number; mtimeMs: number };
    try {
      fh = await fsp.open(r.abs, "r");
      st = await fh.stat();
    } catch {
      if (fh !== null) {
        try {
          await fh.close();
        } catch {
          /* ignore */
        }
        fh = null;
      }
      let dst;
      try {
        dst = await fsp.stat(r.abs);
      } catch {
        return err(`no such file or directory: ${args.path}`);
      }
      if (dst.isDirectory()) {
        const entries = await fsp.readdir(r.abs, { withFileTypes: true });
        const lines = entries.map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name,
        );
        return `Directory listing for ${args.path}:\n${lines.join("\n")}`;
      }
      return err(`no such file or directory: ${args.path}`);
    }
    if (fh === null) return err(`cannot read file: ${args.path}`); // unreachable guard
    const handle: import("node:fs/promises").FileHandle = fh;
    try {
      if (st.isDirectory()) {
        const entries = await fsp.readdir(r.abs, { withFileTypes: true });
        const lines = entries.map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name,
        );
        return `Directory listing for ${args.path}:\n${lines.join("\n")}`;
      }
      // Vision-input peek FIRST: image magic bytes sit in the first 12 bytes,
      // so every file is classified with one tiny positioned read. Supported
      // images (PNG/JPEG/GIF/WebP) take the media path with their own
      // MEDIA_MAX_BYTES cap; PDF magic gets convert-first guidance at any
      // size; everything else falls into the existing guarded text path
      // untouched.
      const fileSize = (st as { size: number }).size ?? 0;
      let peek: Buffer | null = null;
      try {
        const buf = Buffer.alloc(12);
        const { bytesRead } = await handle.read(buf, 0, 12, 0);
        peek = buf.subarray(0, bytesRead);
      } catch {
        // peek never breaks reads — null falls through to the text path
      }
      if (peek !== null) {
        const mime = sniffImageMime(peek);
        if (mime !== null) {
          if (fileSize > MEDIA_MAX_BYTES)
            return oversizeImageError(args.path, fileSize);
          let raw: Buffer;
          try {
            raw = await readAllFromHandle(handle, fileSize, r.abs);
          } catch {
            return err(`cannot read file: ${args.path}`);
          }
          const { id } = await saveMedia(raw, mime, args.path);
          // Fingerprint on the utf8 decoding so a later edit compares
          // consistently with editTool's own read+hash.
          setReadFingerprint(r.abs, contentHash(raw.toString("utf8")));
          return (
            `Image read successfully: ${args.path} (${mime}, ${raw.length} bytes, attached as vision input).\n` +
            mediaDescriptor(id, mime, raw.length)
          );
        }
        if (sniffPdf(peek)) {
          return unsupportedBinaryError(args.path, "pdf", fileSize);
        }
      }
      // OOM guard: never materialize a whole file past READ_FILE_MAX_BYTES
      // (UTF-16 doubling + split/join copies can OOM the heap on one read).
      // The size is known from the stat above, so this costs no extra I/O.
      try {
        const size = (st as { size: number }).size ?? 0;
        if (size > READ_FILE_MAX_BYTES) {
          return err(
            `file too large to read (${size} bytes > 1MB): ${args.path}. Narrow with grep/glob first`,
          );
        }
      } catch {
        // size check never breaks reads (the read below still applies its cap)
      }
      // Read-cache fast path: same abs + window + unchanged mtime/size skips
      // disk I/O. The stored hash refreshes the stale-read fingerprint so
      // read→read→edit chains keep working without re-hashing.
      const { offset: normOffset, limit: normLimit } = normalizeReadWindow(
        args.offset,
        args.limit,
      );
      try {
        const statInfo = {
          mtimeMs: (st as { mtimeMs: number }).mtimeMs ?? 0,
          size: (st as { size: number }).size ?? 0,
        };
        const hit = getCachedRead(r.abs, normOffset, normLimit, statInfo);
        if (hit) {
          setReadFingerprint(r.abs, hit.hash);
          return hit.result;
        }
      } catch {
        // cache lookup never breaks reads
      }
      let text: string;
      try {
        text = (await readAllFromHandle(handle, fileSize, r.abs)).toString(
          "utf8",
        );
      } catch {
        return err(`cannot read file: ${args.path}`);
      }
      return readTextResult(r.abs, args, text, st, normOffset, normLimit);
    } finally {
      try {
        await handle.close();
      } catch {
        // close failures never break reads
      }
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// Read `size` bytes from position 0 of an open handle (single open, no
// re-stat, no second open). Short reads (racy writers) return what landed;
// over-long buffers never exceed the fstat size, so the OOM guard above
// still bounds the allocation.
async function readAllFromHandle(
  handle: import("node:fs/promises").FileHandle,
  size: number,
  abs: string,
): Promise<Buffer> {
  const len = Math.max(0, Math.floor(size));
  const buf = Buffer.alloc(len);
  let at = 0;
  while (at < len) {
    const { bytesRead } = await handle.read(buf, at, len - at, at);
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  if (at !== len) {
    // Racy shrink between fstat and read: fall back to a fresh full read
    // rather than serving a short buffer as the whole file.
    return fsp.readFile(abs);
  }
  return buf;
}

// Line window without a full split (Extreme-fast 3A.2): small windows scan
// line starts incrementally (bounded work ~offset+limit lines, not the whole
// file) instead of `text.split("\n")` over megabytes. Byte-identical to the
// split+slice path (verified by tests, incl. trailing-newline and blank-line
// edges); large windows keep the split path.
const SMALL_WINDOW_LINES = 100;

function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  let at = 0;
  for (;;) {
    const nl = text.indexOf("\n", at);
    if (nl === -1) break;
    starts.push(nl + 1);
    at = nl + 1;
  }
  starts.push(text.length);
  return starts;
}

function windowLines(text: string, offset: number, limit: number): string[] {
  if (limit > SMALL_WINDOW_LINES)
    return text.split("\n").slice(offset - 1, offset - 1 + limit);
  const starts = lineStarts(text);
  const n = starts.length - 1; // line count, trailing-newline aware
  const out: string[] = [];
  for (let j = offset - 1; j < offset - 1 + limit && j < n; j++) {
    if (j < 0) continue;
    const end = j + 1 < n ? starts[j + 1]! - 1 : text.length;
    out.push(text.slice(starts[j]!, end));
  }
  return out;
}

// Shared text path for readTool: fingerprint + line window + 64KB cap +
// cache store. The small-file caller reuses its already-read bytes;
// the over-cap caller arrives here after the media peek.
function readTextResult(
  abs: string,
  args: ReadArgs,
  text: string,
  st: unknown,
  normOffset?: number,
  normLimit?: number,
): string {
  const stat = st as { mtimeMs: number; size: number };
  const hash = contentHash(text);
  setReadFingerprint(abs, hash);
  if (text.length === 0) return "";
  const offset = Math.max(1, Math.floor(args.offset ?? 1));
  const limit = Math.max(1, Math.floor(args.limit ?? Number.MAX_SAFE_INTEGER));
  const window = windowLines(text, offset, limit);
  let out = window.map((line, i) => `${offset + i}: ${line}`).join("\n");
  if (out.length > READ_CHAR_CAP) {
    const full = out;
    const t = truncateHead(
      full,
      READ_CHAR_CAP,
      "\n[truncated: output exceeded 64KB]",
    );
    out = appendOverflow(t.head, t.note, "file output", full);
  }
  try {
    const statInfo = { mtimeMs: stat.mtimeMs ?? 0, size: stat.size ?? 0 };
    const { offset: o, limit: l } =
      normOffset !== undefined && normLimit !== undefined
        ? { offset: normOffset, limit: normLimit }
        : normalizeReadWindow(args.offset, args.limit);
    setCachedRead(abs, o, l, out, statInfo, hash);
  } catch {
    // cache store never breaks reads
  }
  return out;
}

export type WriteArgs = { path: string; content: string };

export async function writeTool(
  args: WriteArgs,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    if (typeof args.content !== "string")
      return err("content must be a string");
    // Ticket 01 (/rewind): silent pre-mutation snapshot — every write is
    // covered regardless of caller, and capture never fails this call.
    await capturePriorBytes(r.abs, `write ${args.path}`);
    await fsp.mkdir(path.dirname(r.abs), { recursive: true });
    await fsp.writeFile(r.abs, args.content, "utf8");
    setReadFingerprint(r.abs, contentHash(args.content));
    try {
      invalidatePath(r.abs);
      invalidateListingsForFile(r.abs);
    } catch {
      // cache invalidation never breaks writes
    }
    return `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type EditArgs = {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export async function editTool(
  args: EditArgs,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    if (typeof args.oldString !== "string" || args.oldString.length === 0) {
      return err("oldString must be a non-empty string");
    }
    if (typeof args.newString !== "string")
      return err("newString must be a string");
    // OOM guard (same rationale as readTool above): an edit materializes
    // the whole file plus split/join copies, so refuse past the cap with
    // guidance instead of risking the heap. Missing paths keep the legacy
    // "no such file" error below.
    try {
      const st = await fsp.stat(r.abs);
      if (st.isFile() && st.size > READ_FILE_MAX_BYTES) {
        return err(
          `file too large to edit (${st.size} bytes > 1MB): ${args.path}. Use bash for targeted changes to huge files`,
        );
      }
    } catch {
      // stat failure falls through to the read below (missing → its error)
    }
    let text: string;
    try {
      text = await fsp.readFile(r.abs, "utf8");
    } catch {
      return err(`no such file or directory: ${args.path}`);
    }
    const key = fingerprintKey(r.abs);
    const known = readFingerprints.get(key);
    if (known !== undefined && contentHash(text) !== known) {
      return invalidCall(
        `stale read — ${args.path} changed since you last read it. Read it again before editing`,
      );
    }
    const count = text.split(args.oldString).length - 1;
    if (count === 0) return err(`no match for oldString in ${args.path}`);
    if (count > 1 && !args.replaceAll) {
      return err(
        `oldString matches ${count} times in ${args.path}; pass replaceAll=true to replace all`,
      );
    }
    const next = args.replaceAll
      ? text.split(args.oldString).join(args.newString)
      : text.replace(args.oldString, args.newString);
    // Ticket 01 (/rewind): silent pre-mutation snapshot (see writeTool).
    // The pre-read text above feeds the snapshot directly — no second
    // stat + re-read of the same bytes (Extreme-fast 2D.3).
    await capturePriorBytes(r.abs, `edit ${args.path}`, text);
    await fsp.writeFile(r.abs, next, "utf8");
    setReadFingerprint(r.abs, contentHash(next));
    try {
      invalidatePath(r.abs);
      invalidateListingsForFile(r.abs);
    } catch {
      // cache invalidation never breaks edits
    }
    return `Edited ${args.path}: replaced ${args.replaceAll ? count : 1} occurrence(s)`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
