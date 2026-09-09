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
