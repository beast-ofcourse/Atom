// Ambient instruction files (OpenCode-V2-style AGENTS.md handling).
//
// Scope: global + project chain + lazy nested discovery, with NO size cap.
// Debloat comes from structure (scoping + laziness + prefix-cache stability),
// not from truncating the user's instructions.
//
// Discovery (mirrors https://opencode.ai/v2/docs/instructions):
//   1. Global file first: ~/.atom/AGENTS.md (ATOM_HOME-aware, like auth.json).
//   2. Project chain: every AGENTS.md from the workspace directory upward to
//      (and including) the home directory when the workspace is inside it;
//      for workspaces outside home, up to the filesystem root. Combined
//      nearest-first (leaf before root) after the global file — files are
//      combined, never resolved against each other.
//   3. Nested files below the workspace load lazily: when the agent reads a
//      file or lists a directory, AGENTS.md files between that target and the
//      workspace are injected nearest-first, deduplicated while visible.
//   4. Edits to an already-loaded file surface as an `instruction update`
//      entry before the next model request (a read failure keeps the last
//      known text, never treated as deleted).
//
// Overrides (opencode parity):
//   - $OPENCODE_AGENTS_PATH set → that single file only (legacy behavior).
//   - $OPENCODE_DISABLE_PROJECT_CONFIG=1 → project chain skipped, global kept.
//
// Node builtins only. Every entry point never throws: missing/unreadable
// files are normal and silent (or a warning string where the caller shows).
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { homeDir } from "./auth.js";

export const INSTRUCTIONS_FILENAME = "AGENTS.md";

// Upward walk guard: deep enough for any real tree, bounded so a workspace
// outside $HOME on a deep mount can never scan unboundedly.
const MAX_CHAIN_DEPTH = 40;

export type InstructionScope = "global" | "project" | "nested";

export type InstructionSource = {
  /** Absolute resolved path of the file. */
  path: string;
  scope: InstructionScope;
  content: string;
  mtimeMs: number;
  size: number;
};

function isDisableProjectConfig(): boolean {
  return process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1";
}

function singleFileOverride(): string | null {
  const p = process.env.OPENCODE_AGENTS_PATH;
  return typeof p === "string" && p.length > 0 ? p : null;
}

export function globalAgentsPath(home?: string): string {
  return path.join(home ?? homeDir(), ".atom", INSTRUCTIONS_FILENAME);
}

export function tryReadSource(absPath: string, scope: InstructionScope): InstructionSource | null {
  try {
    const resolved = path.resolve(absPath);
    let content: string;
    try {
      content = readFileSync(resolved, "utf8");
    } catch {
      return null; // missing/unreadable — normal, silent
    }
    let mtimeMs = 0;
    let size = content.length;
    try {
      const st = statSync(resolved);
      if (st.isFile()) {
        mtimeMs = st.mtimeMs;
        size = st.size;
      }
    } catch {
      // keep content-derived fallback
    }
    return { path: resolved, scope, content, mtimeMs, size };
  } catch {
    return null;
  }
}

/** Absolute AGENTS.md paths from leaf (workspace) up toward the stop dir, inclusive. */
function chainPathsUp(leafDir: string, stopDir: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(leafDir);
  const stop = path.resolve(stopDir);
  const seen = new Set<string>();
  for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
    if (seen.has(dir)) break;
    seen.add(dir);
    out.push(path.join(dir, INSTRUCTIONS_FILENAME));
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    // Stop climbing past the stop dir: only continue while the parent is
    // still at-or-below the stop (i.e. stop is a prefix of parent or equal).
    const rel = path.relative(stop, parent);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      // parent is outside stop's tree — but when stop is the filesystem
      // root this never triggers (relative root→anything never starts
      // with ".."), so outside-home workspaces climb to the root.
      break;
    }
    dir = parent;
  }
  return out;
}

/**
 * Project-chain source paths (leaf-first), before reading. Pure over the
 * filesystem existence check — used by discovery and by tests.
 */
export function projectChainPaths(cwd: string = process.cwd(), home?: string): string[] {
  const leaf = path.resolve(cwd);
  const homeResolved = path.resolve(home ?? homeDir());
  const insideHome = leaf === homeResolved || !path.relative(homeResolved, leaf).startsWith("..");
  const stop = insideHome ? homeResolved : path.parse(leaf).root;
  return chainPathsUp(leaf, stop);
}

/**
 * Full initial discovery: [global?, ...project chain leaf-first].
 * Never throws; absent files are simply absent from the result.
 */
export function discoverInstructionSources(
  cwd: string = process.cwd(),
  home?: string
): InstructionSource[] {
  const out: InstructionSource[] = [];
  const seen = new Set<string>();
  const push = (s: InstructionSource | null) => {
    if (!s) return;
    if (seen.has(s.path)) return;
    seen.add(s.path);
    out.push(s);
  };
  const override = singleFileOverride();
  if (override) {
    push(tryReadSource(override, "project"));
    return out;
  }
  push(tryReadSource(globalAgentsPath(home), "global"));
  if (!isDisableProjectConfig()) {
    for (const p of projectChainPaths(cwd, home)) {
      push(tryReadSource(p, "project"));
    }
  }
  return out;
}

/** Display label for a combined section (relative when under cwd/home, else absolute). */
function displayPath(absPath: string, cwd: string, home: string): string {
  const relCwd = path.relative(cwd, absPath);
  if (relCwd && !relCwd.startsWith("..") && !path.isAbsolute(relCwd)) return relCwd;
  const relHome = path.relative(home, absPath);
  if (relHome && !relHome.startsWith("..") && !path.isAbsolute(relHome)) {
    return `~${path.sep}${relHome}`;
  }
  return absPath;
}

/**
 * Combine sources for the system prompt. No cap, no truncation — the full
 * text of every discovered file rides the stable prefix (prefix-cacheable).
 * A single source injects bare (backward compatible); multiple sources get
 * `--- <path> ---` section headers so scopes stay attributable.
 */
export function combineInstructionSources(
  sources: InstructionSource[],
  cwd: string = process.cwd(),
  home?: string
): string | null {
  const usable = sources.filter((s) => s.content.length > 0);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0]!.content;
  const homeResolved = path.resolve(home ?? homeDir());
  const cwdResolved = path.resolve(cwd);
  return usable
    .map((s) => `--- ${displayPath(s.path, cwdResolved, homeResolved)} ---\n${s.content}`)
    .join("\n\n");
}

/** Combined initial instructions text, or null when no file exists. */
export function loadInstructionPrompt(cwd: string = process.cwd(), home?: string): string | null {
  return combineInstructionSources(discoverInstructionSources(cwd, home), cwd, home);
}

// ---- Lazy nested discovery (below the workspace) ----

/**
 * AGENTS.md paths between a read/list target and the workspace (nearest-
 * first), excluding the workspace's own file (already loaded initially).
 * Returns absolute paths that exist on disk. Never throws.
 */
export function nestedAgentsForTarget(target: string, workspaceCwd: string): string[] {
  try {
    const ws = path.resolve(workspaceCwd);
    let dir = path.resolve(target);
    // A file target contributes its containing directory.
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) dir = path.dirname(dir);
    } catch {
      dir = path.dirname(dir); // target may not exist — still walk upward
    }
    const rel = path.relative(ws, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") return [];
    const out: string[] = [];
    let cur = dir;
    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
      // The workspace's own file is already loaded initially — nested
      // discovery only covers files strictly below it.
      if (cur === ws) break;
      const candidate = path.join(cur, INSTRUCTIONS_FILENAME);
      try {
        if (existsSync(candidate)) out.push(candidate);
      } catch {
        // ignore — a stat hiccup skips one level, never the walk
      }
      const parent = path.dirname(cur);
      if (parent === cur || parent.length < ws.length) break;
      cur = parent;
    }
    return out;
  } catch {
    return [];
  }
}

// ---- Live-update + dedupe tracker ----

export type InstructionFingerprint = { mtimeMs: number; size: number };

export type InstructionTracker = {
  /** Seed/replace known state from freshly discovered sources. */
  sync(sources: InstructionSource[]): void;
  /** True when this absolute path is already model-visible. */
  has(absPath: string): boolean;
  /** Mark one nested source model-visible (after injecting it). */
  add(source: InstructionSource): void;
  /** Forget everything (history reset: /clear, /new, session switch). */
  reset(): void;
  /**
   * Re-stat known paths. Returns changed sources (with fresh content) and
   * removed paths. A transient read failure preserves last-known state
   * (never reported as removed — opencode parity). Never throws.
   */
  checkForUpdates(): { changed: InstructionSource[]; removed: string[] };
};

export function createInstructionTracker(): InstructionTracker {
  const known = new Map<string, InstructionFingerprint & { scope: InstructionScope }>();
  return {
    sync(sources: InstructionSource[]) {
      known.clear();
      for (const s of sources) {
        known.set(s.path, { mtimeMs: s.mtimeMs, size: s.size, scope: s.scope });
      }
    },
    has(absPath: string) {
      try {
        return known.has(path.resolve(absPath));
      } catch {
        return false;
      }
    },
    add(source: InstructionSource) {
      known.set(source.path, {
        mtimeMs: source.mtimeMs,
        size: source.size,
        scope: source.scope,
      });
    },
    reset() {
      known.clear();
    },
    checkForUpdates() {
      const changed: InstructionSource[] = [];
      const removed: string[] = [];
      for (const [p, prev] of known) {
        let st: { mtimeMs: number; size: number; isFile: boolean } | null = null;
        try {
          const s = statSync(p);
          st = { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() };
        } catch {
          st = null;
        }
        if (!st || !st.isFile) {
          // Deleted file reads as removed; any other failure (transient)
          // keeps the last-known text and reports nothing (opencode parity).
          let gone = false;
          try {
            gone = !existsSync(p);
          } catch {
            gone = false;
          }
          if (gone) {
            removed.push(p);
            known.delete(p);
          }
          continue;
        }
        if (st.mtimeMs !== prev.mtimeMs || st.size !== prev.size) {
          const fresh = tryReadSource(p, prev.scope);
          if (fresh) {
            known.set(p, { mtimeMs: fresh.mtimeMs, size: fresh.size, scope: fresh.scope });
            changed.push(fresh);
          }
          // Unreadable-but-present → keep last known, report nothing.
        }
      }
      return { changed, removed };
    },
  };
}

/** Model-visible entry for a file that changed mid-session. */
export function formatInstructionUpdate(source: InstructionSource): string {
  return `[instruction update: ${source.path} changed]\n${source.content}`;
}

/** Model-visible entry for a lazily discovered nested file. */
export function formatNestedInstruction(source: InstructionSource): string {
  return `[nested instructions: ${source.path}]\n${source.content}`;
}
