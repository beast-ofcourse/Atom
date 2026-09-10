// Tool kernel: byte/path caps, error formatters, and sandbox-free path
// resolution shared by every executor. No executor state, no side effects.
import * as path from "node:path";
export const READ_CHAR_CAP = 64 * 1024;
export const OUTPUT_CAP = 8 * 1024;
export const GREP_MATCH_CAP = 100;
export const GLOB_MATCH_CAP = 200;
export const SKIP_DIRS = new Set(["node_modules", ".git"]);
export function err(msg: string): string {
  return `Error: ${msg}`;
}
// Model-mistake framing helper: `Error: invalid call: <detail> Fix the
// arguments and retry.` — the tool never ran. Tool-runtime failures keep
// plain `Error: <detail>`.
export function invalidCall(detail: string): string {
  const d = detail.endsWith(".") ? detail : `${detail}.`;
  return `Error: invalid call: ${d} Fix the arguments and retry.`;
}
// Resolve a user-supplied path: relative paths resolve against cwd, and
// absolute paths (plus `..` escapes) are allowed anywhere on the computer
// (Claude-Code-style permissions model — the mode system, not a path
// sandbox, is the control plane). Only empty/non-string paths and null
// bytes are rejected.
export function resolveSandbox(
  p: unknown,
  cwd: string = process.cwd()
): { abs?: string; error?: string } {
  if (typeof p !== "string" || p.length === 0) {
    return { error: "Error: path must be a non-empty string" };
  }
  if (p.includes("\0")) return { error: "Error: invalid path" };
  return { abs: path.resolve(cwd, p) };
}

// ---- Line-aware head truncation (issue 04: no-partial-line caps) ----
// Single owner for every tool-output cap: byte limit + line limit, whichever
// hits first. The head never ends mid-line: a byte cut backs up to the
// previous "\n" so the last emitted line is complete.
//
// Documented tail edge case: when the cap lands inside a line with no
// preceding newline (one giant line, minified bundles, base64 blobs), there
// is no line boundary to back up to without emitting zero bytes — the head
// ends mid-line with the hard byte cut.
//
// The note keeps the caller's legacy prefix and appends total-vs-emitted
// counts inside the trailing bracket. Where
// the rest lives: spill paths (read, shell, webfetch) append the overflow
// pointer right after the note via appendOverflow (overflow.ts, unchanged);
// safety-net paths (normalize, compact tail, inspector store) drop the rest
// by design — re-query narrowly to recover it.
export type TruncatedHead = {
  head: string;
  truncated: boolean;
  totalChars: number;
  emittedChars: number;
  totalLines: number;
  emittedLines: number;
  note: string;
};

export function truncateHead(
  full: string,
  maxChars: number,
  truncNote: string,
  maxLines: number = Number.MAX_SAFE_INTEGER
): TruncatedHead {
  const text = typeof full === "string" ? full : "";
  const cap = Math.max(1, Math.floor(maxChars));
  const lineCap = Math.max(1, Math.floor(maxLines));
  const totalChars = text.length;
  const totalLines = text.length === 0 ? 0 : text.split("\n").length;
  if (totalChars <= cap && totalLines <= lineCap) {
    return {
      head: text,
      truncated: false,
      totalChars,
      emittedChars: totalChars,
      totalLines,
      emittedLines: totalLines,
      note: "",
    };
  }
  let head = text;
  if (totalChars > cap) {
    const candidate = text.slice(0, cap);
    const nl = candidate.lastIndexOf("\n");
    // nl <= 0 means no usable boundary (single giant line, or the text
    // starts with "\n"): keep the hard cut — the documented tail edge case.
    head = nl > 0 ? candidate.slice(0, nl) : candidate;
  }
  if (totalLines > lineCap) {
    const lineHead = text.split("\n").slice(0, lineCap).join("\n");
    if (lineHead.length < head.length) head = lineHead;
  }
  const emittedChars = head.length;
  const emittedLines = head.length === 0 ? 0 : head.split("\n").length;
  const detail =
    `showing ${emittedChars} of ${totalChars} chars ` +
    `(${emittedLines} of ${totalLines} lines)`;
  const note = truncNote.endsWith("]")
    ? `${truncNote.slice(0, -1)}; ${detail}]`
    : `${truncNote} [${detail}]`;
  return { head, truncated: true, totalChars, emittedChars, totalLines, emittedLines, note };
}
