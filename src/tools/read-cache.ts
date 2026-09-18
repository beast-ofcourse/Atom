// Read-through cache for file reads: repeated `read` calls for the same
// path+window skip disk I/O when the file hasn't changed. Correctness first:
//
// - Key: absolute path + offset + limit (different windows are different keys).
// - Validation: file mtimeMs + size checked on every hit (one stat, cheap).
//   A mismatch → miss → re-read + re-store. External edits can never serve
//   stale bytes beyond a stat race.
// - Invalidation: write/edit/delete paths call invalidatePath(abs) — the
//   write/edit executors do this, so read→write→read chains never go stale.
//   A global version bump (invalidateAll) covers tree-wide mutations.
// - Scope: successes only (errors never cache — a transient ENOENT must not
//   poison later reads). Directory listings never cache (readdir is already
//   cheap and highly mutable).
// - Bounds: LRU cap (default 100 entries) + TTL (default 30s). Disable with
//   ATOM_READ_CACHE=0. All best-effort, never throws.
//
// Measurable win: explore loops re-read the same files (read after grep,
// re-read before edit, parallel batches reading shared context). Each hit
// saves a full readFile + split + 64KB-format pass.
//
// Stats (for loop instrumentation + tests): hits, misses, stores, invalidations.
import * as path from "node:path";

export type ReadCacheEntry = {
  result: string;
  // sha1 of the FULL file content (for the stale-read fingerprint refresh on
  // hits — the cached result is a windowed view, not the full text).
  hash: string;
  mtimeMs: number;
  size: number;
  storedAt: number;
};

export type ReadCacheStats = {
  hits: number;
  misses: number;
  stores: number;
  invalidations: number;
  size: number;
};

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 30_000;

const cache = new Map<string, ReadCacheEntry>();
const stats: ReadCacheStats = { hits: 0, misses: 0, stores: 0, invalidations: 0, size: 0 };

function cacheEnabled(): boolean {
  const raw = process.env.ATOM_READ_CACHE;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

function ttlMs(): number {
  const raw = process.env.ATOM_READ_CACHE_TTL_MS;
  if (raw !== undefined) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 300_000);
  }
  return DEFAULT_TTL_MS;
}

function maxEntries(): number {
  const raw = process.env.ATOM_READ_CACHE_MAX;
  if (raw !== undefined) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 1000);
  }
  return DEFAULT_MAX_ENTRIES;
}

export function readCacheKey(abs: string, offset: number, limit: number): string {
  return `${abs}\n${offset}\n${limit}`;
}

export function normalizeReadWindow(
  offset: unknown,
  limit: unknown
): { offset: number; limit: number } {
  const o =
    typeof offset === "number" && Number.isFinite(offset) ? Math.max(1, Math.floor(offset)) : 1;
  const l =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : Number.MAX_SAFE_INTEGER;
  return { offset: o, limit: l };
}

// Lookup by absolute path + window. `stat` must be the fresh
// {mtimeMs, size} of the file (the caller already stats before reading).
// Returns the cached {result, hash} on hit, null on miss. Never throws.
export function getCachedRead(
  abs: string,
  offset: number,
  limit: number,
  stat: { mtimeMs: number; size: number }
): { result: string; hash: string } | null {
  if (!cacheEnabled()) {
    stats.misses += 1;
    return null;
  }
  const key = readCacheKey(abs, offset, limit);
  const entry = cache.get(key);
  if (!entry) {
    stats.misses += 1;
    return null;
  }
  if (Date.now() - entry.storedAt > ttlMs()) {
    cache.delete(key);
    stats.size = cache.size;
    stats.misses += 1;
    return null;
  }
  if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    cache.delete(key);
    stats.size = cache.size;
    stats.misses += 1;
    return null;
  }
  // LRU refresh: re-insert so the oldest key stays evictable first.
  cache.delete(key);
  cache.set(key, entry);
  stats.hits += 1;
  return { result: entry.result, hash: entry.hash };
}

// Store a successful file-read result. Never throws; evicts oldest first.
export function setCachedRead(
  abs: string,
  offset: number,
  limit: number,
  result: string,
  stat: { mtimeMs: number; size: number },
  hash: string
): void {
  try {
    if (!cacheEnabled() || typeof result !== "string") return;
    const key = readCacheKey(abs, offset, limit);
    cache.delete(key);
    while (cache.size >= maxEntries()) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value as string);
    }
    cache.set(key, { result, hash, mtimeMs: stat.mtimeMs, size: stat.size, storedAt: Date.now() });
    stats.size = cache.size;
    stats.stores += 1;
  } catch {
    // cache failures never break reads
  }
}

// Drop every entry for one absolute path (all windows). Called by
// write/edit/delete paths. Never throws.
export function invalidatePath(abs: string): void {
  try {
    const prefix = `${abs}\n`;
    let dropped = 0;
    for (const key of [...cache.keys()]) {
      if (key === abs || key.startsWith(prefix)) {
        cache.delete(key);
        dropped += 1;
      }
    }
    // Also match callers that pass a relative display path: compare resolved
    // basenames as a fallback so nothing obviously stale survives.
    if (dropped === 0 && typeof abs === "string") {
      const resolved = path.resolve(abs);
      const resolvedPrefix = `${resolved}\n`;
      for (const key of [...cache.keys()]) {
        if (key === resolved || key.startsWith(resolvedPrefix)) {
          cache.delete(key);
          dropped += 1;
        }
      }
    }
    if (dropped > 0) stats.invalidations += dropped;
    stats.size = cache.size;
  } catch {
    // never throw across the tool boundary
  }
}

export function clearReadCache(): void {
  cache.clear();
  stats.size = 0;
}

export function getReadCacheStats(): ReadCacheStats {
  return { ...stats, size: cache.size };
}

export function resetReadCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.stores = 0;
  stats.invalidations = 0;
  stats.size = cache.size;
}
