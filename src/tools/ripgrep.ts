// ripgrep-backed content search: matches from the `rg` binary when it is
// the faster choice, with the walker as the always-correct fallback.
//
// Routing (see grepTool): the caller already enumerated the file set, so the
// threshold decides on COUNT alone — enumeration cost is sunk. Below the
// threshold the walker wins (no ~80ms Windows spawn tax); above it rg's
// parallel scanner wins by multiples. `ATOM_RG_MIN_FILES` overrides the
// default; `ATOM_RG=0` forces the walker (degraded envs, tests).
//
// Exactness contract (parity-tested, never assumed):
// - File COVERAGE is the enumerated set, always: rg output is intersected
//   with it, so git-ignored-untracked files, dotfiles, and SKIP_DIRS behave
//   exactly like the walker path in both git and non-git trees.
// - `include` globs filter in JS (shared matcher), never via `-g`: our
//   minimal glob dialect and gitignore semantics could otherwise drift.
// - Case sensitivity, binary skipping (rg skips NUL files like the walker),
//   and CRLF handling (one trailing \r\n stripped, mirroring split("\n"))
//   all match the walker.
// - Modes map 1:1: content via `--json --max-count` merged in alpha order
//   with the same 100-hit cap + note; files_with_matches via
//   `--files-with-matches` into the existing recency pipeline; count via
//   `--count` into the existing totals pipeline.
// - ANY rg failure (missing binary, bad exit, unparseable output, invalid
//   regex for Rust's engine such as lookahead) returns null and the caller
//   runs the walker — search never fails when the walker could answer.
// - No timeout: the walker path is equally unbounded, and a timeout would
//   invent a failure mode neither path had.
//
// Known untested edges (documented, not solved): symlink handling (no
// privilege to create them in this env — both sides skip them by
// construction: walker via isFile/isDirectory checks, rg via no-follow
// default), lone-\r line endings, non-ASCII case/boundary semantics.
import { execFile, execFileSync } from "node:child_process";
import { rgRelToCwdRel } from "./dir-cache.js";

// Routing threshold (measured, Windows, 3000-file fixture): below it the
// walker wins outright (no ~100ms spawn tax); above it rg wins clearly
// (643ms vs 872ms end-to-end at 3000 files, and the gap widens with size
// since the walker pays per-file reads while rg does not). Conservative on
// purpose: small/medium scopes stay on the exact legacy path, and
// `ATOM_RG_MIN_FILES` overrides per environment.
export const RG_MIN_FILES_DEFAULT = 1000;
const RG_MAX_BUFFER = 64 * 1024 * 1024;
//rg --max-count per file for content mode: bounds output while keeping the
// merged take-100 exact. Rationale: take-100-alpha needs every file's FULL
// matching-line list UNLESS a file is capped — so any file hitting the cap
// forces a walker fallback (rare pathological case: 1000+ matches in one
// file). Without the cap a minified bundle could dump megabytes of JSON.
const RG_CONTENT_MAX_COUNT = 1000;

type RgStats = { uses: number; fallbacks: number };

const stats: RgStats = { uses: 0, fallbacks: 0 };
let availability: boolean | null = null;

export function rgEnabled(): boolean {
  const raw = process.env.ATOM_RG;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

export function rgMinFiles(): number {
  const raw = process.env.ATOM_RG_MIN_FILES;
  if (raw !== undefined) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return RG_MIN_FILES_DEFAULT;
}

// One-time `rg --version` probe (lazy so small searches never pay the spawn).
// Never throws; false on any failure.
export function rgAvailable(): boolean {
  if (!rgEnabled()) return false;
  if (availability !== null) return availability;
  try {
    const out = execFileSync("rg", ["--version"], {
      timeout: 10000,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    availability = typeof out === "string" && out.includes("ripgrep");
  } catch {
    availability = false;
  }
  return availability;
}

// Test seam: reset the cached probe (production never calls this).
export function resetRgAvailable(): void {
  availability = null;
}

export function getRipgrepStats(): RgStats & { available: boolean } {
  return { ...stats, available: rgAvailable() };
}

export function resetRipgrepStats(): void {
  stats.uses = 0;
  stats.fallbacks = 0;
}

function runRg(absDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("rg", args, { cwd: absDir, timeout: 0, maxBuffer: RG_MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      const code = err == null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 2;
      resolve({
        code,
        stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
        stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
      });
    });
  });
}

function isRegexError(stderr: string): boolean {
  return /regex parse error|unrecognized|error parsing regex/i.test(stderr);
}

// Shared runner: exit 0 with output wins; exit 1 + empty means no matches
// (caller renders the mode's empty shape); anything else is a fallback
// signal — with regex-parse errors being the EXPECTED fallback trigger
// (lookahead and friends are valid JS, invalid Rust).
async function runRgSearch(
  absDir: string,
  baseArgs: string[],
  pattern: string
): Promise<{ kind: "ok"; stdout: string } | { kind: "empty" } | { kind: "fallback" }> {
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await runRg(absDir, [...baseArgs, "-e", pattern, "--", "."]);
  } catch {
    return { kind: "fallback" };
  }
  if (res.code === 0) return { kind: "ok", stdout: res.stdout };
  if (res.code === 1) return { kind: "empty" };
  if (isRegexError(res.stderr)) return { kind: "fallback" };
  return { kind: "fallback" };
}

// Strip the leading "./" rg emits for cwd-relative paths + normalize to the
// posix rels the enumerated set uses. Returns null when unusable.
function toRel(rawPath: string): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  let p = rawPath.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.length === 0 || p === ".") return null;
  return p;
}

// Mirror of split("\n") line semantics: strip exactly one trailing \n and
// NOTHING else. In particular a CRLF line keeps its \r, exactly like the
// walker (parity-tested) — invisible on screen, byte-identical in output.
function splitLine(text: string): string {
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export type RgContentHit = { rel: string; line: number; text: string };

export type RgScanResult = {
  // Per-file matching-line counts, alpha order (count mode + match detection).
  counts: Array<{ rel: string; n: number }>;
  // Content hits merged in (file alpha, line) order, capped at GREP cap by
  // the caller contract below; cappedFile true when any file hit max-count.
  hits: RgContentHit[];
  cappedFile: boolean;
};

const BASE_ARGS = ["--hidden", "--no-ignore", "--glob", "!node_modules/**", "--glob", "!.git/**"];

function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === "object" && v !== null) out.push(v as Record<string, unknown>);
    } catch {
      // malformed event line: skip, never crash (caller falls back on empty)
    }
  }
  return out;
}

// Content scan: --json matches merged per file (line order), files in alpha
// order. Hits carry raw line text; the caller applies the shared 200-char
// trim + 100-hit cap + note (same code as the walker path would — see
// grepTool; this module only supplies ordered raw material).
export async function rgContentHits(
  absDir: string,
  cwd: string,
  pattern: string,
  allowed: ReadonlySet<string>
): Promise<RgScanResult | null> {
  const run = await runRgSearch(absDir, [...BASE_ARGS, "--json", "--max-count", String(RG_CONTENT_MAX_COUNT)], pattern);
  if (run.kind !== "ok") return run.kind === "empty" ? { counts: [], hits: [], cappedFile: false } : null;
  const perFile = new Map<string, Array<{ line: number; text: string }>>();
  let cappedFile = false;
  for (const evt of parseJsonEvents(run.stdout)) {
    if (evt["type"] !== "match") continue;
    const data = evt["data"] as Record<string, unknown> | undefined;
    if (typeof data !== "object" || data === null) continue;
    const rawPath = (data["path"] as { text?: unknown } | undefined)?.text;
    const dirRel = typeof rawPath === "string" ? toRel(rawPath) : null;
    const rel = dirRel === null ? null : rgRelToCwdRel(absDir, cwd, dirRel);
    if (!rel || !allowed.has(rel)) continue;
    const lineNo = data["line_number"];
    const lines = data["lines"] as { text?: unknown } | undefined;
    if (typeof lineNo !== "number" || typeof lines?.text !== "string") continue;
    const list = perFile.get(rel) ?? [];
    list.push({ line: Math.floor(lineNo), text: splitLine(lines.text) });
    perFile.set(rel, list);
  }
  const counts: Array<{ rel: string; n: number }> = [];
  const hits: RgContentHit[] = [];
  for (const rel of [...perFile.keys()].sort()) {
    const list = perFile.get(rel)!;
    // De-dupe multiple submatches on one line (walker counts LINES).
    const seen = new Set<number>();
    let n = 0;
    for (const h of list) {
      if (seen.has(h.line)) continue;
      seen.add(h.line);
      n += 1;
      hits.push({ rel, line: h.line, text: h.text });
    }
    // max-count caps MATCHES per file: a full batch means that file may hold
    // more (the walker's exactly-100 ambiguity behaves the same way).
    if (list.length >= RG_CONTENT_MAX_COUNT) cappedFile = true;
    if (n > 0) counts.push({ rel, n });
  }
  stats.uses += 1;
  return { counts, hits, cappedFile };
}

// files_with_matches + count scan: per-file matching-LINE counts via
// `rg --count` (ripgrep --count semantics already match the walker's).
// files_with_matches derives its file set from these counts, so one spawn
// serves both modes. Caller applies totals/caps/recency.
export async function rgFileCounts(
  absDir: string,
  cwd: string,
  pattern: string,
  allowed: ReadonlySet<string>
): Promise<{ counts: Array<{ rel: string; n: number }> } | null> {
  const run = await runRgSearch(absDir, [...BASE_ARGS, "--count"], pattern);
  if (run.kind !== "ok") return run.kind === "empty" ? { counts: [] } : null;
  const counts: Array<{ rel: string; n: number }> = [];
  for (const rawLine of run.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Right-split: Windows drive letters contain colons.
    const idx = line.lastIndexOf(":");
    if (idx <= 0) continue;
    const dirRel = toRel(line.slice(0, idx));
    const rel = dirRel === null ? null : rgRelToCwdRel(absDir, cwd, dirRel);
    const n = Number(line.slice(idx + 1));
    if (!rel || !allowed.has(rel) || !Number.isFinite(n) || n <= 0) continue;
    counts.push({ rel, n: Math.floor(n) });
  }
  counts.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  stats.uses += 1;
  return { counts };
}

// Record a fallback (rg answered nothing usable; walker takes over).
export function noteRgFallback(): void {
  stats.fallbacks += 1;
}
