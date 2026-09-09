// Search executors: grep (content regex) and glob (path patterns).
// Read-only over the repo; node_modules/.git skipped by the walker.
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { err, GLOB_MATCH_CAP, GREP_MATCH_CAP, invalidCall, resolveSandbox, SKIP_DIRS } from "./shared.js";
// Minimal glob matcher: supports **, **/, *, ?. Used for grep `include`
// and the glob tool. Patterns without a slash match the basename.
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
  const norm = pattern.replace(/\\/g, "/");
  if (!norm.includes("/")) {
    const base = relPosix.slice(relPosix.lastIndexOf("/") + 1);
    return globToRegExp(norm).test(base);
  }
  return globToRegExp(norm).test(relPosix);
}

async function walkFiles(absDir: string, cwd: string, out: string[]): Promise<void> {
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

export type GrepArgs = { pattern: string; include?: string; dir?: string; outputMode?: string };

export const GREP_OUTPUT_MODES: ReadonlySet<string> = new Set([
  "content",
  "files_with_matches",
  "count",
]);

// Best-effort mtime (ms) for recency sorting; 0 when the file cannot be
// stat'ed (keeps such entries last instead of failing the search).
async function mtimeMs(abs: string): Promise<number> {
  try {
    return (await fsp.stat(abs)).mtimeMs;
  } catch {
    return 0;
  }
}

// Line-regex search under dir (default "."). `include` is a glob like
// "*.ts". `outputMode` selects the shape (Claude-Code-style):
// - "content" (default): "file:line: text" lines, capped at 100 matches.
// - "files_with_matches": matching file paths newest-first with a
//   "Found N file(s)" header, capped at 100 listed files.
// - "count": per-file "file:count" lines plus a totals line; the totals
//   cover every match even when the listed files are capped.
export async function grepTool(args: GrepArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    if (typeof args?.pattern !== "string") return err("pattern must be a string");
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch {
      return err(`invalid regex: ${args.pattern}`);
    }
    const mode = args?.outputMode ?? "content";
    if (!GREP_OUTPUT_MODES.has(mode)) {
      return invalidCall(
        `field "outputMode" for tool "grep" must be one of "content", "files_with_matches", "count" (got ${JSON.stringify(args?.outputMode)})`
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
    if (!st.isDirectory()) return err(`not a directory: ${dir}`);
    const files: string[] = [];
    await walkFiles(r.abs, cwd, files);
    const include = typeof args.include === "string" && args.include.length > 0 ? args.include : null;
    // Per-file match counts in alpha order (single scan for all modes).
    // Counts are matching LINES per file (ripgrep --count semantics).
    const counts: Array<{ rel: string; n: number }> = [];
    for (const rel of files.sort()) {
      if (include && !matchesGlob(include, rel)) continue;
      let text: string;
      try {
        text = await fsp.readFile(path.resolve(cwd, rel), "utf8");
      } catch {
        continue; // unreadable/binary — skip
      }
      if (text.includes("\0")) continue; // binary — skip
      const lines = text.split("\n");
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        try {
          if (!re.test(lines[i]!)) continue;
          n += 1;
        } catch {
          return err(`regex failed on input: ${args.pattern}`);
        }
        // Reset lastIndex in case the pattern is global/sticky.
        re.lastIndex = 0;
      }
      if (n > 0) counts.push({ rel, n });
    }
    if (counts.length === 0) return "No matches.";
    if (mode === "files_with_matches") {
      const withTime = await Promise.all(
        counts.map(async (c) => ({ rel: c.rel, t: await mtimeMs(path.resolve(cwd, c.rel)) }))
      );
      withTime.sort((a, b) => b.t - a.t || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      const listed = withTime.slice(0, GREP_MATCH_CAP).map((c) => c.rel);
      let out = `Found ${withTime.length} file(s)\n${listed.join("\n")}`;
      if (withTime.length > GREP_MATCH_CAP) out += "\n[truncated: more than 100 matching files]";
      return out;
    }
    if (mode === "count") {
      const listed = counts.slice(0, GREP_MATCH_CAP);
      const total = counts.reduce((s, c) => s + c.n, 0);
      let out =
        listed.map((c) => `${c.rel}:${c.n}`).join("\n") +
        `\nFound ${total} total match(es) across ${counts.length} file(s).`;
      if (counts.length > GREP_MATCH_CAP) out += "\n[truncated: more than 100 matching files]";
      return out;
    }
    const hits: string[] = [];
    for (const c of counts) {
      let text: string;
      try {
        text = await fsp.readFile(path.resolve(cwd, c.rel), "utf8");
      } catch {
        continue; // vanished mid-search — skip
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let line: string;
        try {
          if (!re.test(lines[i]!)) continue;
          line = lines[i]!;
        } catch {
          return err(`regex failed on input: ${args.pattern}`);
        }
        // Reset lastIndex in case the pattern is global/sticky.
        re.lastIndex = 0;
        hits.push(`${c.rel}:${i + 1}: ${line.length > 200 ? line.slice(0, 200) + "…" : line}`);
        if (hits.length >= GREP_MATCH_CAP) {
          return hits.join("\n") + "\n[truncated: more than 100 matches]";
        }
      }
    }
    return hits.length > 0 ? hits.join("\n") : "No matches.";
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type GlobArgs = { pattern: string; dir?: string };

// List paths matching pattern under dir, newest-first by modification
// time (opencode/Claude parity: recency ≈ relevance), capped at 200.
export async function globTool(args: GlobArgs, cwd: string = process.cwd()): Promise<string> {
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
    if (!st.isDirectory()) return err(`not a directory: ${dir}`);
    const files: string[] = [];
    await walkFiles(r.abs, cwd, files);
    const matched = files.filter((rel) => matchesGlob(args.pattern, rel));
    const withTime = await Promise.all(
      matched.map(async (rel) => ({ rel, t: await mtimeMs(path.resolve(cwd, rel)) }))
    );
    withTime.sort((a, b) => b.t - a.t || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const capped = withTime.slice(0, GLOB_MATCH_CAP).map((e) => e.rel);
    let out = capped.length > 0 ? capped.join("\n") : "No matches.";
    if (withTime.length > GLOB_MATCH_CAP) out += "\n[truncated: more than 200 matches]";
    return out;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

