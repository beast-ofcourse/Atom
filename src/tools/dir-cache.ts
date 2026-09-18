// Fast directory enumeration for search tools (grep/glob).
//
// Problem (measured): every grep/glob recursively walked the repo and
// stated every entry — ~360ms per glob and ~2s per grep on a 3000-file
// tree, paid on EVERY call. Two fixes, both behavior-preserving:
//
// 1. git fast path: `git ls-files` (tracked) + `--others --exclude-standard`
//    (untracked, non-ignored) lists the same tree without recursion and
//    skips ignored build output. Verified: both spellings emit paths
//    relative to the working directory they run in. Untracked source files
//    ARE included (no "new file invisible" regression); SKIP_DIRS segments
//    (node_modules/.git) are filtered after, so the "never searched"
//    contract holds even for tracked junk. Any failure (non-git dir, no git
//    binary, timeout) falls back to the recursive walker byte-identically.
// 2. mtime-checked listing cache + exact invalidation: a cached listing is
//    reused only while the directory mtime is unchanged, AND every
//    in-process mutation path invalidates (write/edit drop ancestor listings
//    — nested creates don't move the parent mtime, so mtime alone is NOT
//    enough; any bash execution clears all — a command can touch anything).
//    Only out-of-process edits (user's editor between calls) stay TTL-bound
//    (15s), documented and accepted: all tool-driven flows are exact.
//
// Deliberate non-goal: no ripgrep binary dependency. Measured `rg --files`
// spawn alone costs ~80ms on Windows — slower than the walker on typical
// repos — with regex-dialect and hidden/ignore parity risks. Revisit only if
// walker numbers stay slow after this (they don't — see benchmarks).
//
// Kill switch: ATOM_FAST_LIST=0 forces the legacy walker every time.
// Best-effort throughout; never throws across the tool boundary.
import { execFile } from "node:child_process";
import { promises as fsp, realpathSync } from "node:fs";
import * as path from "node:path";
import { SKIP_DIRS } from "./shared.js";

const LISTING_TTL_MS = 15_000;
const LISTING_MAX_ENTRIES = 50;
const GIT_TIMEOUT_MS = 15_000;

type ListingEntry = { entries: string[]; mtimeMs: number; storedAt: number };

const listingCache = new Map<string, ListingEntry>();
const cacheStats = { hits: 0, misses: 0, stores: 0, gitUses: 0, walkerUses: 0 };

export function fastListEnabled(): boolean {
  const raw = process.env.ATOM_FAST_LIST;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

// Recursive walker (legacy contract): cwd-relative posix paths, SKIP_DIRS
// pruned, files only. Used directly when the fast path is off/unavailable.
export async function walkFiles(absDir: string, cwd: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(absDir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(absDir, e.name);
    if (e.isDirectory()) {
      await walkFiles(full, cwd, out);
    } else if (e.isFile()) {
      out.push(path.relative(cwd, full).split(path.sep).join("/"));
    }
  }
}

function gitFile(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(typeof stdout === "string" ? stdout : String(stdout ?? ""));
    });
  });
}

function toCwdRel(absDir: string, cwd: string, dirRel: string): string {
  const prefix = path.relative(cwd, absDir).split(path.sep).join("/");
  if (!prefix || prefix === ".") return dirRel;
  return `${prefix}/${dirRel}`;
}

// Public for the ripgrep adapter: rg emits dir-relative paths, but the
// enumerated contract (and therefore outputs) is cwd-relative — which may
// climb out of the tree (`../../..`) when the search dir sits outside cwd.
// Exported so both paths share the one mapping (never duplicated logic).
export function rgRelToCwdRel(absDir: string, cwd: string, dirRel: string): string {
  return toCwdRel(absDir, cwd, dirRel);
}

function filterSkipped(relPaths: string[]): string[] {
  return relPaths.filter((rel) => {
    if (!rel) return false;
    for (const seg of rel.split("/")) {
      if (SKIP_DIRS.has(seg)) return false;
    }
    return true;
  });
}

// Git enumeration: tracked + untracked-non-ignored in ONE invocation, as
// cwd-relative posix paths. Verified: both spellings emit paths relative to
// the directory git runs in. Outside a repo (or no git binary) the command
// fails and this returns null — the caller falls back to the walker.
// Negative cache (Extreme-fast 3B.2): a failed dir remembers its miss for
// the TTL window, so repeated searches outside a repo never re-spawn git.
const nonGitDirs = new Map<string, number>();

function rememberNonGit(absDir: string): void {
  try {
    nonGitDirs.delete(absDir);
    while (nonGitDirs.size >= 50) {
      const oldest = nonGitDirs.keys().next();
      if (oldest.done) break;
      nonGitDirs.delete(oldest.value as string);
    }
    nonGitDirs.set(absDir, Date.now());
  } catch {
    // cache failures never break search
  }
}

function isKnownNonGit(absDir: string): boolean {
  const at = nonGitDirs.get(absDir);
  if (at === undefined) return false;
  if (Date.now() - at >= LISTING_TTL_MS) {
    nonGitDirs.delete(absDir);
    return false;
  }
  return true;
}

async function gitListFiles(absDir: string, cwd: string): Promise<string[] | null> {
  if (!fastListEnabled() || isKnownNonGit(absDir)) return null;
  let raw: string;
  try {
    raw = await gitFile(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], absDir);
  } catch {
    rememberNonGit(absDir);
    return null;
  }
  try {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of raw.split("\0")) {
      if (!entry) continue;
      const rel = toCwdRel(absDir, cwd, entry.split(path.sep).join("/"));
      if (!seen.has(rel)) {
        seen.add(rel);
        out.push(rel);
      }
    }
    return filterSkipped(out);
  } catch {
    return null;
  }
}

async function dirMtimeMs(absDir: string): Promise<number | null> {
  try {
    return (await fsp.stat(absDir)).mtimeMs;
  } catch {
    return null;
  }
}

// Mutation generation (Extreme-fast 3B result cache): bumped on every
// in-process invalidation, so result caches keyed on it can never serve
// pre-mutation content — even when the directory mtime didn't visibly move
// (same-millisecond write+grep). Out-of-process edits stay mtime+TTL bound
// like the listing cache itself.
let listingGeneration = 0;

export function dirListingGeneration(): number {
  return listingGeneration;
}

// List files under absDir as cwd-relative posix paths (walkFiles contract).
// Fast path: mtime-validated cache → git enumeration → walker fallback.
// Walker results cache too (the mtime check is equally valid for them).
// Inflight sharing (Extreme-fast 3B.1): concurrent callers for the same key
// await ONE git/walk promise instead of enumerating N times (parallel
// grep+glob batches). The promise is dropped on settle — later calls
// re-validate via mtime, so invalidation semantics never change.
const inflightListings = new Map<string, Promise<string[]>>();

export async function listFiles(absDir: string, cwd: string): Promise<string[]> {
  const key = `${cwd}\n${absDir}`;
  const inflight = inflightListings.get(key);
  if (inflight !== undefined) {
    const shared = await inflight;
    return [...shared];
  }
  const run = listFilesUnshared(absDir, cwd, key);
  inflightListings.set(key, run);
  try {
    const out = await run;
    return [...out];
  } finally {
    if (inflightListings.get(key) === run) inflightListings.delete(key);
  }
}

async function listFilesUnshared(absDir: string, cwd: string, key: string): Promise<string[]> {
  if (fastListEnabled()) {
    const mtime = await dirMtimeMs(absDir);
    const hit = listingCache.get(key);
    if (hit && mtime !== null && hit.mtimeMs === mtime && Date.now() - hit.storedAt < LISTING_TTL_MS) {
      // LRU refresh.
      listingCache.delete(key);
      listingCache.set(key, hit);
      cacheStats.hits += 1;
      return [...hit.entries];
    }
    cacheStats.misses += 1;
    const git = await gitListFiles(absDir, cwd);
    if (git !== null) {
      cacheStats.gitUses += 1;
      storeListing(key, git, mtime);
      return [...git];
    }
  }
  cacheStats.walkerUses += 1;
  const out: string[] = [];
  await walkFiles(absDir, cwd, out);
  if (fastListEnabled()) {
    storeListing(key, out, await dirMtimeMs(absDir));
  }
  return out;
}

function storeListing(key: string, entries: string[], mtimeMs: number | null): void {
  try {
    listingCache.delete(key);
    while (listingCache.size >= LISTING_MAX_ENTRIES) {
      const oldest = listingCache.keys().next();
      if (oldest.done) break;
      listingCache.delete(oldest.value as string);
    }
    listingCache.set(
      key,
      { entries: [...entries], mtimeMs: mtimeMs ?? -1, storedAt: Date.now() }
    );
    cacheStats.stores += 1;
  } catch {
    // cache failures never break search
  }
}

export function clearDirListingCache(): void {
  listingCache.clear();
  realpathCache.clear();
  nonGitDirs.clear();
  inflightListings.clear();
  // A command can touch anything (git init, writes, moves): generation bump
  // invalidates result caches keyed on it, like a mutation does.
  listingGeneration += 1;
}

// Drop every listing whose directory is the file itself or an ancestor of it
// (a mutation inside the tree can change the listing). Called by write/edit
// next to the read-cache invalidation. Never throws.
export function invalidateListingsForFile(absFilePath: string): void {
  try {
    if (typeof absFilePath !== "string" || absFilePath.length === 0) return;
    const target = path.resolve(absFilePath);
    for (const key of [...listingCache.keys()]) {
      const splitAt = key.indexOf("\n");
      const absDir = splitAt >= 0 ? key.slice(splitAt + 1) : key;
      if (target === absDir || target.startsWith(absDir + path.sep)) {
        listingCache.delete(key);
      }
    }
    // A mutation can create/repoint symlinks: drop realpath entries under
    // the same scope (conservative full clear — entries are cheap to redo,
    // stale canonical keys would mis-batch writes). Bumps the generation so
    // result caches keyed on it invalidate too.
    realpathCache.clear();
    listingGeneration += 1;
  } catch {
    // never throw across the tool boundary
  }
}

// Canonical-path cache for the scheduler's per-write realpathSync
// (Extreme-fast 2B.1): bounded, shared invalidation with the listings above.
// Key is the LEXICAL absolute path; value is the canonical path, or the
// lexical path itself when realpath fails (fresh write target, unreadable
// link — same fallback canonicalFileKey always had). Symlink/link changes
// only happen via fs mutation, and every mutation path clears above, so a
// cached entry can never outlive the link it resolved.
const REALPATH_MAX_ENTRIES = 500;
const realpathCache = new Map<string, string>();
const realpathStats = { hits: 0, misses: 0 };

export function cachedRealpath(absLexical: string): string {
  const hit = realpathCache.get(absLexical);
  if (hit !== undefined) {
    realpathStats.hits += 1;
    return hit;
  }
  realpathStats.misses += 1;
  let canonical = absLexical;
  try {
    canonical = realpathSync(absLexical);
  } catch {
    // Fresh write target or unreadable link: the lexical path stands.
  }
  try {
    realpathCache.delete(absLexical);
    while (realpathCache.size >= REALPATH_MAX_ENTRIES) {
      const oldest = realpathCache.keys().next();
      if (oldest.done) break;
      realpathCache.delete(oldest.value as string);
    }
    realpathCache.set(absLexical, canonical);
  } catch {
    // cache failures never break planning
  }
  return canonical;
}

export function getRealpathCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: realpathStats.hits, misses: realpathStats.misses, size: realpathCache.size };
}

export function resetRealpathCacheStats(): void {
  realpathStats.hits = 0;
  realpathStats.misses = 0;
}

export function getDirListingStats(): {
  hits: number;
  misses: number;
  stores: number;
  gitUses: number;
  walkerUses: number;
  size: number;
} {
  return { ...cacheStats, size: listingCache.size };
}

export function resetDirListingStats(): void {
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  cacheStats.stores = 0;
  cacheStats.gitUses = 0;
  cacheStats.walkerUses = 0;
}
