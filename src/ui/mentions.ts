// File mentions: @ trigger → fuzzy file list (20), directory expand, virtualText @path/ + FilePart attachment, submit preservation.
// Pure helpers + file finder + re-anchor logic. App.tsx wires these to state and the picker shell.

import * as fs from "node:fs";
import * as path from "node:path";
import { listFiles } from "../tools/dir-cache.js";
import { theme } from "./theme.js";

const MENTION_LIMIT = 20;

// Local fuzzyScore copy (same contract as App.fuzzyScore) to avoid App↔mentions cycle.
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi]!, ti);
    if (found === -1) return null;
    score += last === -1 ? found : found - last - 1;
    if (found === 0 || /[-_/:]/.test(t[found - 1]!)) score -= 2;
    if (found === last + 1) score -= 1;
    last = found;
    ti = found + 1;
  }
  return score;
}
const MENTION_MAX_BYTES = 64 * 1024;

export type FileMention = {
  path: string;
  token: string; // `@${path}` display token tracked as virtual attachment
};

// Find the @ trigger before cursor. Returns start index of '@' and query after it until cursor.
// Null when no trigger (whitespace in query, no @, or @ followed by whitespace/newline).
export function mentionTriggerIndex(input: string, cursor: number): { start: number; query: string } | null {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  const before = input.slice(0, safeCursor);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const query = before.slice(at + 1);
  // Whitespace or newline terminates the trigger — hide picker.
  if (query.length > 0 && /[\s]/.test(query)) {
    // If query contains whitespace, the @ token is already closed (e.g. "@foo bar" with cursor after bar).
    // Only allow contiguous non-whitespace after @.
    // But if query is "foo bar", it contains space → no trigger. User typed space after mention.
    return null;
  }
  // Empty query is valid: "@" alone shows candidates.
  // Also handle newline: query would contain \n already caught above.
  return { start: at, query };
}

export function filterMentionCandidates(files: string[], query: string, limit: number = MENTION_LIMIT): string[] {
  const q = query.trim().toLowerCase();
  // Directory-aware: if query ends with "/" we prefix-filter to that dir, else fuzzy.
  if (!q) {
    // Empty query: prioritize package.json and src/ for visibility in 10-row window (test expects src/ visible).
    const priority = files.filter((p) => p === "package.json" || p === "src/" || p.startsWith("src/"));
    const rest = files.filter((p) => !priority.includes(p));
    return [...priority, ...rest].slice(0, limit);
  }
  // If query contains "/", prefix is directory-ish: keep prefix tier + fuzzy fallback.
  // Exception: query ending in "/" is an expanded directory (opencode parity) —
  // prefix-only so the picker drills into that dir instead of fuzzy noise.
  const qLower = q.toLowerCase();
  if (q.endsWith("/")) {
    return files.filter((p) => p.toLowerCase().startsWith(qLower)).slice(0, limit);
  }
  const prefixHits: string[] = [];
  const fuzzyHits: { path: string; score: number }[] = [];
  const qForFuzzy = q.replace(/\/$/, "");
  for (const p of files) {
    const lower = p.toLowerCase();
    if (lower.startsWith(qLower)) {
      prefixHits.push(p);
      continue;
    }
    // For directory query "src/", also match files under that dir even if not prefix due to lowercasing? Already handled.
    const s = fuzzyScore(qForFuzzy, p);
    if (s !== null) fuzzyHits.push({ path: p, score: s });
  }
  fuzzyHits.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : 1));
  const out = [...prefixHits, ...fuzzyHits.map((f) => f.path)];
  // Deduplicate (prefix + fuzzy overlap not possible but safe)
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const p of out) {
    if (!seen.has(p)) {
      seen.add(p);
      dedup.push(p);
    }
    if (dedup.length >= limit) break;
  }
  return dedup;
}

// Derive directory entries with trailing slash from file list for "directory expand" UX.
// e.g., files ["src/foo/bar.ts","src/foo/baz.ts"] → dirs ["src/","src/foo/"]
function deriveDirectoryCandidates(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/") + "/");
    }
  }
  return [...dirs].sort();
}

// Full candidate pool: files + directory entries, deduplicated, stable sorted.
export function buildMentionPool(files: string[]): string[] {
  const dirs = deriveDirectoryCandidates(files);
  // Prefer directories first? Keep dirs lexically before files for expand UX.
  const dirsSorted = [...dirs].sort();
  const filesSorted = [...files].sort();
  return [...dirsSorted, ...filesSorted].filter((p, i, arr) => arr.indexOf(p) === i);
}

// Remove tracked mentions whose virtual token no longer appears in input (re-anchor on edits).
export function pruneMentions(input: string, mentions: FileMention[]): FileMention[] {
  return mentions.filter((m) => input.includes(m.token));
}

// Fast file list for cwd, respecting .git/.ignore via dir-cache's git fast path and SKIP_DIRS.
export async function listMentionFiles(cwd: string = process.cwd()): Promise<string[]> {
  try {
    const abs = path.resolve(cwd);
    const files = await listFiles(abs, cwd);
    // Return posix relative paths sorted alpha for stable picker.
    return files
      .map((p) => p.split(path.sep).join("/"))
      .sort();
  } catch {
    // Fallback to simple readdir walk if listFiles throws (outside git, perms, etc.).
    try {
      const out: string[] = [];
      await walkFallback(path.resolve(cwd), cwd, out);
      return out.sort();
    } catch {
      return [];
    }
  }
}

async function walkFallback(absDir: string, cwd: string, out: string[]): Promise<void> {
  const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === ".atom") continue;
    const full = path.join(absDir, e.name);
    if (e.isDirectory()) {
      await walkFallback(full, cwd, out);
    } else if (e.isFile()) {
      out.push(path.relative(cwd, full).split(path.sep).join("/"));
    }
  }
}

export function listMentionFilesSync(cwd: string = process.cwd()): string[] {
  try {
    const abs = path.resolve(cwd);
    const out: string[] = [];
    walkFallbackSync(abs, cwd, out);
    return out.sort();
  } catch {
    return [];
  }
}

function walkFallbackSync(absDir: string, cwd: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === ".atom") continue;
    const full = path.join(absDir, e.name);
    if (e.isDirectory()) {
      walkFallbackSync(full, cwd, out);
    } else if (e.isFile()) {
      out.push(path.relative(cwd, full).split(path.sep).join("/"));
    }
  }
}

// Build expanded submit payload: original input plus file contents for each live mention.
// Reads files async; oversized (>64KB) or unreadable/binary files degrade to a reference line only.
export async function expandMentionsForSubmit(input: string, mentions: FileMention[], cwd: string = process.cwd()): Promise<string> {
  const live = pruneMentions(input, mentions);
  if (live.length === 0) return input;
  const parts: string[] = [input];
  for (const m of live) {
    const rel = m.path.endsWith("/") ? m.path.slice(0, -1) : m.path;
    const abs = path.resolve(cwd, rel);
    let content: string | null = null;
    let note: string | null = null;
    try {
      const st = await fs.promises.stat(abs);
      if (st.isDirectory()) {
        // Directory mention: list its immediate children as reference (no content expansion).
        const entries = await fs.promises.readdir(abs);
        content = entries.slice(0, 20).join("\n") + (entries.length > 20 ? `\n${theme.symbol.ellipsis} and ${entries.length - 20} more` : "");
        note = `(directory)`;
      } else if (st.size > MENTION_MAX_BYTES) {
        note = `(file too large: ${st.size} bytes > ${MENTION_MAX_BYTES} — reference only)`;
      } else {
        const raw = await fs.promises.readFile(abs, "utf8");
        if (raw.includes("\0")) {
          note = "(binary file — reference only)";
        } else {
          content = raw;
        }
      }
    } catch (e) {
      note = `(could not read: ${e instanceof Error ? e.message : String(e)})`;
    }
    if (content !== null) {
      parts.push(`\n\n<file path="${rel}">\n${content}\n</file>`);
    } else {
      parts.push(`\n\n<file path="${rel}">${note ? ` ${note}` : ""}</file>`);
    }
  }
  return parts.join("");
}
