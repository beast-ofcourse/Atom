// Search executors: grep (content regex) and glob (path patterns).
// Read-only over the repo; node_modules/.git skipped by the walker.
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import {
  dirListingGeneration,
  fastListEnabled,
  listFiles,
} from "./dir-cache.js";
import { appendOverflow } from "./overflow.js";
import {
  noteRgFallback,
  rgAvailable,
  rgContentHits,
  rgFileCounts,
  rgMinFiles,
} from "./ripgrep.js";
import {
  err,
  GLOB_MATCH_CAP,
  GREP_MATCH_CAP,
  invalidCall,
  READ_CHAR_CAP,
  READ_FILE_MAX_BYTES,
  resolveSandbox,
  truncateHead,
} from "./shared.js";
// Minimal glob matcher: supports **, **/, *, ?, and {a,b,c} brace
// alternation (single- or multi-level, e.g. "*.{ts,tsx}" or
// "src/**/*.{test,spec}.ts"). Patterns without a slash match the basename.
function expandBraces(pattern: string): string[] {
  // Cap: a pathological "{a,b}x{a,b}x..." chain explodes combinatorially;
  // past the cap the raw pattern stands (legacy literal-brace behavior).
  const MAX_EXPANSIONS = 128;
  const out = expandBracesInner(pattern);
  return out.length > MAX_EXPANSIONS ? [pattern] : out;
}

function expandBracesInner(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  // Find the matching close brace, accounting for nesting.
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === "{") depth += 1;
    else if (pattern[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [pattern]; // unbalanced — literal
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const inner = pattern.slice(open + 1, close);
  // Split on top-level commas only (nested braces stay intact per part).
  const parts: string[] = [];
  let partDepth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "{") partDepth += 1;
    else if (ch === "}") partDepth -= 1;
    if (ch === "," && partDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  if (parts.length < 2) return [pattern]; // no alternation — literal
  const out: string[] = [];
  for (const part of parts) {
    for (const expanded of expandBracesInner(`${prefix}${part}${suffix}`)) {
      out.push(expanded);
    }
  }
  return out;
}
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories; bare "**" matches all.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesGlob(pattern: string, relPosix: string): boolean {
  return matchesGlobCompiled(compileGlobPattern(pattern), relPosix);
}

// Per-call compiled glob set (Extreme-fast 3B.7): expansion + RegExp
// compilation happen ONCE per call, not per file (200 files × N patterns
// recompiled the same expressions). Semantics byte-identical to the
// per-file path above (basename-only for slash-less alts; full + **/
// fallback otherwise).
type CompiledGlob = Array<{ basenameOnly: boolean; re: RegExp }>;

function compileGlobPattern(pattern: string): CompiledGlob {
  const norm = pattern.replace(/\\/g, "/");
  const out: CompiledGlob = [];
  for (const alt of expandBraces(norm)) {
    if (!alt.includes("/")) {
      out.push({ basenameOnly: true, re: globToRegExp(alt) });
    } else {
      out.push({ basenameOnly: false, re: globToRegExp(alt) });
      out.push({ basenameOnly: false, re: globToRegExp(`**/${alt}`) });
    }
  }
  return out;
}

function matchesGlobCompiled(
  compiled: CompiledGlob,
  relPosix: string,
): boolean {
  const base = relPosix.slice(relPosix.lastIndexOf("/") + 1);
  for (const c of compiled) {
    if (c.re.test(c.basenameOnly ? base : relPosix)) return true;
  }
  return false;
}

// Grep pattern pre-parse: a leading "(?i)" prefix selects case-insensitive
// matching (Python-trained models reach for it; JS RegExp has no inline
// flags, so `new RegExp("(?i)goal")` throws "invalid regex"). The prefix is
// stripped and re-applied as the `i` flag for the walker and as `-i` for
// ripgrep — one documented spelling, both engines agree.
function parseGrepPattern(raw: string): {
  source: string;
  caseInsensitive: boolean;
} {
  if (raw.startsWith("(?i)"))
    return { source: raw.slice(4), caseInsensitive: true };
  return { source: raw, caseInsensitive: false };
}

// Literal fast path (Extreme-fast 3B.4): patterns without regex metachars
// match identically via substring search — no regex engine setup, no
// lastIndex dance. Byte-identical hits (a metachar-free regex IS a substring
// match; case-insensitive compares lowercase both sides).
function literalOf(source: string): string | null {
  if (source.length === 0) return null;
  if (/[.*+?^${}()|[\]\\]/.test(source)) return null;
  return source;
}

function matchLine(
  re: RegExp,
  lit: string | null,
  litLower: string | null,
  line: string,
): boolean {
  if (lit !== null) {
    return litLower !== null
      ? line.toLowerCase().includes(litLower)
      : line.includes(lit);
  }
  return re.test(line);
}

export type GrepArgs = {
  pattern: string;
  include?: string;
  dir?: string;
  outputMode?: string;
};

export const GREP_OUTPUT_MODES: ReadonlySet<string> = new Set([
  "content",
  "files_with_matches",
  "count",
]);

// Result cache (Extreme-fast 3B, cache proof): repeat identical searches
// skip the scan entirely. Key = scope + query shape + directory mtime +
// mutation generation: in-process writes/edits/bash bump the generation
// (exact invalidation even on same-millisecond mtime); out-of-process edits
// move the mtime; anything else TTL-bounds (15 s, same as listings).
// Single-file `dir` searches bypass it (one stat+read, nothing to save).
// Bounded (100 entries, LRU); never throws; kill switch follows the listing
// cache (ATOM_FAST_LIST=0 disables result caching too).
const RESULT_CACHE_MAX = 100;
const RESULT_CACHE_TTL_MS = 15_000;
const resultCache = new Map<string, { result: string; storedAt: number }>();
const resultCacheStats = { hits: 0, stores: 0 };

function resultCacheGet(key: string): string | null {
  try {
    const hit = resultCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.storedAt >= RESULT_CACHE_TTL_MS) {
      resultCache.delete(key);
      return null;
    }
    resultCache.delete(key);
    resultCache.set(key, hit);
    resultCacheStats.hits += 1;
    return hit.result;
  } catch {
    return null;
  }
}

function resultCacheSet(key: string, result: string): void {
  try {
    resultCache.delete(key);
    while (resultCache.size >= RESULT_CACHE_MAX) {
      const oldest = resultCache.keys().next();
      if (oldest.done) break;
      resultCache.delete(oldest.value as string);
    }
    resultCache.set(key, { result, storedAt: Date.now() });
    resultCacheStats.stores += 1;
  } catch {
    // cache failures never break search
  }
}

export function getSearchResultCacheStats(): {
  hits: number;
  stores: number;
  size: number;
} {
  return {
    hits: resultCacheStats.hits,
    stores: resultCacheStats.stores,
    size: resultCache.size,
  };
}

export function resetSearchResultCacheStats(): void {
  resultCacheStats.hits = 0;
  resultCacheStats.stores = 0;
}

export function clearSearchResultCache(): void {
  resultCache.clear();
}

async function resultCacheKey(
  kind: string,
  absDir: string,
  parts: Array<string | number | boolean>,
): Promise<string | null> {
  try {
    const st = await fsp.stat(absDir);
    return [kind, absDir, st.mtimeMs, dirListingGeneration(), ...parts].join(
      "\n",
    );
  } catch {
    return null;
  }
}

// File-read fan-out for scans: bounded parallelism (32 in flight) over an
// ordered list, results in input order. Disk I/O overlaps instead of
// serializing one open/read/close at a time; the regex pass stays sequential
// afterwards so outputs and first-failure errors keep exact alpha order.
// 32 concurrent opens is far below EMFILE on every supported platform.
const SCAN_CONCURRENCY = 32;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(
    Math.min(Math.max(limit, 1), Math.max(items.length, 1)),
  )
    .fill(0)
    .map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    });
  await Promise.all(workers);
  return out;
}

// One hit line, shared by the walker and ripgrep scans so both paths stay
// byte-identical by construction (1-based line, 200-char trim).
export function formatGrepHit(
  rel: string,
  lineNo: number,
  line: string,
): string {
  return `${rel}:${lineNo}: ${line.length > 200 ? line.slice(0, 200) + "…" : line}`;
}

// ripgrep scan for one grep call: fills the same {counts, hits, hitsCapped}
// shape as the walker scan below (or null = run the walker). Content hits
// arrive merged in (file alpha, line) order; the 100-hit cap + note apply
// exactly like the walker path (including its take-100-blindly quirk).
async function scanWithRipgrep(
  absDir: string,
  cwd: string,
  pattern: string,
  mode: string,
  allowed: ReadonlySet<string>,
  caseInsensitive = false,
): Promise<{
  counts: Array<{ rel: string; n: number }>;
  hits: string[];
  hitsCapped: boolean;
} | null> {
  if (mode === "content") {
    const r = await rgContentHits(
      absDir,
      cwd,
      pattern,
      allowed,
      caseInsensitive,
    );
    if (r === null) return null;
    if (r.cappedFile) return null; // pathological volume: walker stays exact
    const hits = r.hits
      .slice(0, GREP_MATCH_CAP)
      .map((h) => formatGrepHit(h.rel, h.line, h.text));
    return {
      counts: r.counts,
      hits,
      hitsCapped: r.hits.length >= GREP_MATCH_CAP,
    };
  }
  const r = await rgFileCounts(absDir, cwd, pattern, allowed, caseInsensitive);
  if (r === null) return null;
  return { counts: r.counts, hits: [], hitsCapped: false };
}
// Issue 04: every tool output passes the shared head-truncation contract.
// Search hits are already line-capped (100/200) far below the byte cap, so
// this is a byte-identical safety net that never fires on reachable outputs
// — grep/glob shape, ordering, modes, count notes, and the ripgrep/walker
// selection (issue 01) stay exactly as settled. If it ever fires, the head
// is line-aligned with total-vs-emitted counts plus the overflow pointer.
function capSearchOutput(out: string, label: string): string {
  if (out.length <= READ_CHAR_CAP) return out;
  const t = truncateHead(
    out,
    READ_CHAR_CAP,
    `\n[truncated: ${label} exceeded 64KB]`,
  );
  return appendOverflow(t.head, t.note, label, out);
}
// Best-effort mtime (ms) for recency sorting; 0 when the file cannot be
// stat'ed (keeps such entries last instead of failing the search).
async function mtimeMs(abs: string): Promise<number> {
  try {
    return (await fsp.stat(abs)).mtimeMs;
  } catch {
    return 0;
  }
}

// Walker scan: ONE read per file (bulk parallel reads, sequential regex so
// outputs and first-failure errors keep exact alpha order). The ripgrep path
// fills the same shape; the formatting tails below serve both.
type WalkerScan =
  | {
      counts: Array<{ rel: string; n: number }>;
      hits: string[];
      hitsCapped: boolean;
    }
  | { error: string };

// Binary/oversize fast reject (Extreme-fast 3B.3): files over FAST_REJECT_BYTES
// get a 4 KB head probe instead of a full read — NUL in the head or a bogus
// size skips the body (bundles/media skip after 4 KB, not full megabytes).
// Small files read directly exactly as before (no extra open on the hot path).
const FAST_REJECT_BYTES = 64 * 1024;
const HEAD_PROBE_BYTES = 4096;

async function readScanBody(
  full: string,
  size: number,
): Promise<string | null> {
  if (size <= FAST_REJECT_BYTES) {
    try {
      const text = await fsp.readFile(full, "utf8");
      if (text.includes("\0")) return null; // binary — skip
      return text;
    } catch {
      return null; // unreadable — skip
    }
  }
  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    fh = await fsp.open(full, "r");
    const head = Buffer.alloc(Math.min(HEAD_PROBE_BYTES, size));
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const slice = head.subarray(0, bytesRead).toString("utf8");
    if (slice.includes("\0")) return null; // binary — skip body
    const text = await fsp.readFile(full, "utf8");
    if (text.includes("\0")) return null; // NUL past the head — skip
    return text;
  } catch {
    return null; // unreadable — skip
  } finally {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
  }
}

async function scanWithWalker(
  cwd: string,
  re: RegExp,
  pattern: string,
  sorted: string[],
  include: string | null,
  mode: string,
  lit: string | null = null,
  litLower: string | null = null,
): Promise<WalkerScan> {
  const collectHits = mode === "content";
  const includeCompiled = include ? compileGlobPattern(include) : null;
  const bodies = await mapLimit(sorted, SCAN_CONCURRENCY, async (rel) => {
    if (includeCompiled && !matchesGlobCompiled(includeCompiled, rel))
      return null;
    try {
      // OOM guard: the walker reads every file fully and concurrently —
      // one GB input (bundle, pack, media) would OOM the heap. Oversize
      // files skip exactly like binaries (the ripgrep path bounds itself
      // via --max-count instead).
      const full = path.resolve(cwd, rel);
      let size = 0;
      try {
        const st = await fsp.stat(full);
        if (st.isFile() && st.size > READ_FILE_MAX_BYTES) return null;
        size = st.isFile() ? st.size : 0;
      } catch {
        // stat failure falls through to the read below (same as before)
      }
      const text = await readScanBody(full, size);
      if (text === null) return null;
      return { rel, text };
    } catch {
      return null; // unreadable — skip
    }
  });
  const counts: Array<{ rel: string; n: number }> = [];
  const hits: string[] = [];
  let hitsCapped = false;
  for (const body of bodies) {
    if (body === null) continue;
    if (collectHits && hitsCapped) break;
    const { rel, text } = body;
    const lines = text.split("\n");
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      let matched: boolean;
      try {
        matched = matchLine(re, lit, litLower, lines[i]!);
      } catch {
        return { error: err(`regex failed on input: ${pattern}`) };
      }
      // Reset lastIndex in case the pattern is global/sticky (literal path
      // never touches it — matchLine bypasses the engine entirely).
      if (lit === null) re.lastIndex = 0;
      if (!matched) continue;
      n += 1;
      if (collectHits && !hitsCapped) {
        hits.push(formatGrepHit(rel, i + 1, lines[i]!));
        if (hits.length >= GREP_MATCH_CAP) hitsCapped = true;
      }
    }
    if (n > 0) counts.push({ rel, n });
  }
  return { counts, hits, hitsCapped };
}

// Single-file grep (file-path tolerance for `dir`): same match semantics as
// the walker over a one-entry set, same output shapes per mode. Skips
// oversize/binary files exactly like the walker (→ "No matches.").
async function grepSingleFile(
  cwd: string,
  re: RegExp,
  pattern: string,
  rel: string,
  abs: string,
  include: string | null,
  includeCompiled: CompiledGlob | null,
  mode: string,
  lit: string | null = null,
  litLower: string | null = null,
): Promise<string> {
  if (
    includeCompiled
      ? !matchesGlobCompiled(includeCompiled, rel)
      : include && !matchesGlob(include, rel)
  )
    return "No matches.";
  try {
    const st = await fsp.stat(abs);
    if (st.isFile() && st.size > READ_FILE_MAX_BYTES) return "No matches.";
    const text = await fsp.readFile(abs, "utf8");
    if (text.includes("\0")) return "No matches.";
    const lines = text.split("\n");
    const hits: string[] = [];
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      let matched: boolean;
      try {
        matched = matchLine(re, lit, litLower, lines[i]!);
      } catch {
        return err(`regex failed on input: ${pattern}`);
      }
      if (lit === null) re.lastIndex = 0;
      if (!matched) continue;
      n += 1;
      if (mode === "content" && hits.length < GREP_MATCH_CAP) {
        hits.push(formatGrepHit(rel, i + 1, lines[i]!));
      }
    }
    if (n === 0) return "No matches.";
    if (mode === "files_with_matches")
      return capSearchOutput(`Found 1 file(s)\n${rel}`, "grep results");
    if (mode === "count") {
      return capSearchOutput(
        `${rel}:${n}\nFound ${n} total match(es) across 1 file(s).`,
        "grep results",
      );
    }
    return capSearchOutput(hits.join("\n"), "grep results");
  } catch {
    return "No matches.";
  }
}

// Line-regex search under dir (default "."). `include` is a glob like
// "*.ts". `outputMode` selects the shape (Claude-Code-style):
// - "content" (default): "file:line: text" lines, capped at 100 matches.
// - "files_with_matches": matching file paths newest-first with a
//   "Found N file(s)" header, capped at 100 listed files.
// - "count": per-file "file:count" lines plus a totals line; the totals
//   cover every match even when the listed files are capped.
export async function grepTool(
  args: GrepArgs,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    if (typeof args?.pattern !== "string")
      return err("pattern must be a string");
    const parsed = parseGrepPattern(args.pattern);
    let re: RegExp;
    try {
      re = new RegExp(parsed.source, parsed.caseInsensitive ? "i" : "");
    } catch {
      return err(
        `invalid regex: ${args.pattern} (JS RegExp syntax; prefix with (?i) for case-insensitive)`,
      );
    }
    const mode = args?.outputMode ?? "content";
    if (!GREP_OUTPUT_MODES.has(mode)) {
      return invalidCall(
        `field "outputMode" for tool "grep" must be one of "content", "files_with_matches", "count" (got ${JSON.stringify(args?.outputMode)})`,
      );
    }
    const dir = args.dir ?? ".";
    const r = resolveSandbox(dir, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad dir");
    let st;
    try {
      st = await fsp.stat(r.abs);
    } catch {
      return err(`no such directory: ${dir}`);
    }
    const include =
      typeof args.include === "string" && args.include.length > 0
        ? args.include
        : null;
    const includeCompiled = include ? compileGlobPattern(include) : null;
    // Literal fast path, computed once per call (3B.4).
    const lit = literalOf(parsed.source);
    const litLower =
      lit !== null && parsed.caseInsensitive ? lit.toLowerCase() : null;
    // File-path tolerance: `dir` pointing at a file searches just that file
    // (models habitually pass "src/foo.ts" as dir). Same output shapes as
    // the directory path; ripgrep is skipped (cwd-anchored by construction).
    if (st.isFile()) {
      const rel = path.relative(cwd, r.abs).split(path.sep).join("/");
      return grepSingleFile(
        cwd,
        re,
        parsed.source,
        rel,
        r.abs,
        include,
        includeCompiled,
        mode,
        lit,
        litLower,
      );
    }
    if (!st.isDirectory())
      return err(
        `not a directory: ${dir} (pass a directory in dir, or read the file directly)`,
      );
    // Result cache: repeat identical directory searches skip the scan (3B).
    // Single-file `dir` bypasses (one stat+read, nothing to save); disabled
    // listing cache disables this too (same kill switch, same contract).
    let grepCacheKey: string | null = null;
    const storeGrep = (s: string): string => {
      if (grepCacheKey) resultCacheSet(grepCacheKey, s);
      return s;
    };
    if (fastListEnabled()) {
      grepCacheKey = await resultCacheKey("grep", r.abs, [
        args.pattern,
        mode,
        include ?? "",
        parsed.caseInsensitive,
      ]);
      if (grepCacheKey) {
        const hit = resultCacheGet(grepCacheKey);
        if (hit !== null) return hit;
      }
    }
    const files = await listFiles(r.abs, cwd);
    const sorted = files.sort();
    // Allowed set shared by both scan paths (include filtering is identical
    // either way, so ripgrep coverage matches the walker exactly).
    const allowed = new Set(
      sorted.filter(
        (rel) => !includeCompiled || matchesGlobCompiled(includeCompiled, rel),
      ),
    );
    // ripgrep fast path: large scopes only (process-spawn cost), silent
    // walker fallback on anything unusable (missing binary, bad exit,
    // unparseable output, JS-only regex). A scope that WANTS rg but gets
    // the walker (binary missing/disabled) counts as a fallback too, so
    // regressions in rg availability surface in stats + bench output.
    let counts: Array<{ rel: string; n: number }>;
    let hits: string[];
    let hitsCapped: boolean;
    const wantRg = sorted.length >= rgMinFiles();
    if (wantRg && rgAvailable()) {
      const fast = await scanWithRipgrep(
        r.abs,
        cwd,
        parsed.source,
        mode,
        allowed,
        parsed.caseInsensitive,
      );
      if (fast !== null) {
        ({ counts, hits, hitsCapped } = fast);
      } else {
        noteRgFallback();
        const walked = await scanWithWalker(
          cwd,
          re,
          args.pattern,
          sorted,
          include,
          mode,
          lit,
          litLower,
        );
        if ("error" in walked) return walked.error;
        ({ counts, hits, hitsCapped } = walked);
      }
    } else {
      if (wantRg) noteRgFallback();
      const walked = await scanWithWalker(
        cwd,
        re,
        args.pattern,
        sorted,
        include,
        mode,
        lit,
        litLower,
      );
      if ("error" in walked) return walked.error;
      ({ counts, hits, hitsCapped } = walked);
    }
    if (counts.length === 0) return storeGrep("No matches.");
    if (mode === "files_with_matches") {
      // Recency order is pinned (newest-first even at small N — see tests),
      // so the mtime stats stay; bounded concurrency keeps big match sets
      // from fanning out unbounded stat storms (Extreme-fast 3B.5).
      const withTime = await mapLimit(counts, SCAN_CONCURRENCY, async (c) => ({
        rel: c.rel,
        t: await mtimeMs(path.resolve(cwd, c.rel)),
      }));
      withTime.sort(
        (a, b) => b.t - a.t || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
      );
      const listed = withTime.slice(0, GREP_MATCH_CAP).map((c) => c.rel);
      let out = `Found ${withTime.length} file(s)\n${listed.join("\n")}`;
      if (withTime.length > GREP_MATCH_CAP)
        out += "\n[truncated: more than 100 matching files]";
      return storeGrep(capSearchOutput(out, "grep results"));
    }
    if (mode === "count") {
      const listed = counts.slice(0, GREP_MATCH_CAP);
      const total = counts.reduce((s, c) => s + c.n, 0);
      let out =
        listed.map((c) => `${c.rel}:${c.n}`).join("\n") +
        `\nFound ${total} total match(es) across ${counts.length} file(s).`;
      if (counts.length > GREP_MATCH_CAP)
        out += "\n[truncated: more than 100 matching files]";
      return storeGrep(capSearchOutput(out, "grep results"));
    }
    // Content hits accumulated inline above (same order, same cap).
    if (hitsCapped)
      return storeGrep(
        capSearchOutput(
          hits.join("\n") + "\n[truncated: more than 100 matches]",
          "grep results",
        ),
      );
    return storeGrep(
      hits.length > 0
        ? capSearchOutput(hits.join("\n"), "grep results")
        : "No matches.",
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type GlobArgs = { pattern: string; dir?: string };

// List paths matching pattern under dir, newest-first by modification
// time (opencode/Claude parity: recency ≈ relevance), capped at 200.
export async function globTool(
  args: GlobArgs,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    if (typeof args?.pattern !== "string" || args.pattern.length === 0) {
      return err("pattern must be a non-empty string");
    }
    const dir = args.dir ?? ".";
    const r = resolveSandbox(dir, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad dir");
    let st;
    try {
      st = await fsp.stat(r.abs);
    } catch {
      return err(`no such directory: ${dir}`);
    }
    // File-path tolerance: `dir` pointing at a file tests just that file
    // against the glob (models habitually pass "src/foo.ts" as dir).
    if (st.isFile()) {
      const rel = path.relative(cwd, r.abs).split(path.sep).join("/");
      return matchesGlob(args.pattern, rel)
        ? capSearchOutput(rel, "glob results")
        : "No matches.";
    }
    if (!st.isDirectory())
      return err(
        `not a directory: ${dir} (pass a directory in dir, or read the file directly)`,
      );
    let globCacheKey: string | null = null;
    if (fastListEnabled()) {
      globCacheKey = await resultCacheKey("glob", r.abs, [args.pattern]);
      if (globCacheKey) {
        const hit = resultCacheGet(globCacheKey);
        if (hit !== null) return hit;
      }
    }
    const files = await listFiles(r.abs, cwd);
    const patternCompiled = compileGlobPattern(args.pattern);
    const matched = files.filter((rel) =>
      matchesGlobCompiled(patternCompiled, rel),
    );
    // Same pinned recency order as grep (see 3B.5 above): bounded fan-out.
    const withTime = await mapLimit(matched, SCAN_CONCURRENCY, async (rel) => ({
      rel,
      t: await mtimeMs(path.resolve(cwd, rel)),
    }));
    withTime.sort(
      (a, b) => b.t - a.t || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
    );
    const capped = withTime.slice(0, GLOB_MATCH_CAP).map((e) => e.rel);
    let out = capped.length > 0 ? capped.join("\n") : "No matches.";
    if (withTime.length > GLOB_MATCH_CAP)
      out += "\n[truncated: more than 200 matches]";
    const final = capSearchOutput(out, "glob results");
    if (globCacheKey) resultCacheSet(globCacheKey, final);
    return final;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
