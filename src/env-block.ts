// Per-turn environment block (Task 6, plans/tasks.md): grounds every ATOM
// turn in repo reality — cwd, git branch/status (best-effort), node version,
// timestamp.
//
// Placement: pinned to the SYSTEM message only (suffix to history[0]'s
// content via withEnvBlock), NEVER into user content. history[0] is the only
// slot truncateHistory never drops, so the block survives budget trimming.
// Caching: the App refreshes history[0] once per turn in submit() (before the
// budget check, so truncation accounts for it) — the loop's up-to-30 POSTs
// reuse the same history[0], so git is shelled at most once per turn.
// Failure-silent: missing git / non-repo cwd / timeout → the block shrinks
// (cwd + node + time only), never throws, never blocks the turn. No new
// dependencies; one cheap `git status` invocation with a short timeout, and
// zero shell-outs when `.git` is absent.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

// Cap for the block itself (~500 chars per the task). The base system prompt
// (SYSTEM_PROMPT + AGENTS.md overlay) is untouched by this cap.
export const ENV_BLOCK_CHAR_CAP = 500;
// Marker identifying a previously pinned block (for idempotent refresh).
export const ENV_BLOCK_TAG = "[env ";
// Single git invocation budget: fail fast, never stall the turn.
const GIT_TIMEOUT_MS = 750;
// Long Windows cwds would blow the cap alone: keep the identifying tail.
const CWD_DISPLAY_CAP = 180;

export type EnvBlockParts = {
  cwd: string;
  branch?: string | null;
  status?: string | null;
  nodeVersion: string;
  timestamp: string;
};

function shortCwd(cwd: string): string {
  if (cwd.length <= CWD_DISPLAY_CAP) return cwd;
  return `…${cwd.slice(cwd.length - (CWD_DISPLAY_CAP - 1))}`;
}

// Pure formatter (no I/O): always `cwd + node + time`, plus
// `branch + status` only when git reported them. Capped to
// ENV_BLOCK_CHAR_CAP (cwd is pre-truncated so time/node survive the cap).
export function buildEnvBlock(parts: EnvBlockParts): string {
  const cwd = shortCwd(parts.cwd);
  const git =
    parts.branch !== undefined &&
    parts.branch !== null &&
    parts.branch.length > 0
      ? ` branch=${parts.branch} status=${parts.status ?? "unknown"}`
      : "";
  const block = `[env cwd=${cwd}${git} node=${parts.nodeVersion} time=${parts.timestamp}]`;
  return block.length > ENV_BLOCK_CHAR_CAP
    ? `${block.slice(0, ENV_BLOCK_CHAR_CAP - 1)}]`
    : block;
}

export type GitInfo = { branch: string; status: string };

// One cheap `git status --branch --porcelain=v1`: branch from the `##` line,
// dirtiness from the remaining file lines. Null on ANY failure (no repo, no
// git binary, timeout) — the caller shrinks the block instead.
export function getGitInfo(cwd: string): GitInfo | null {
  try {
    if (!existsSync(path.join(cwd, ".git"))) return null;
    const out = execFileSync("git", ["status", "--branch", "--porcelain=v1"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const text = typeof out === "string" ? out : String(out ?? "");
    const lines = text.split("\n");
    const head = (lines[0] ?? "").trim();
    if (!head.startsWith("## ")) return null;
    const rest = head.slice(3).trim();
    let branch: string;
    if (rest.startsWith("No commits yet on ")) {
      branch = rest.slice("No commits yet on ".length).split(" ")[0] ?? "";
    } else {
      branch = rest.split("...")[0]?.split(" ")[0] ?? "";
    }
    branch = branch.trim().slice(0, 64);
    if (!branch) return null;
    let changed = 0;
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] ?? "").trim().length > 0) changed += 1;
    }
    return { branch, status: changed === 0 ? "clean" : `dirty:${changed}` };
  } catch {
    return null;
  }
}

// Gather + format for a cwd (default: process cwd). NEVER throws: every piece
// is best-effort and the block shrinks to what was available.
export function getEnvBlock(cwd: string = process.cwd()): string {
  try {
    let dir = cwd;
    try {
      if (!dir) dir = process.cwd();
    } catch {
      dir = ".";
    }
    let nodeVersion = "unknown";
    try {
      nodeVersion = process.version ?? "unknown";
    } catch {
      // keep fallback
    }
    let timestamp = "";
    try {
      timestamp = new Date().toISOString();
    } catch {
      timestamp = String(Date.now());
    }
    let git: GitInfo | null = null;
    try {
      git = getGitInfo(dir);
    } catch {
      git = null;
    }
    return buildEnvBlock({
      cwd: dir,
      branch: git?.branch ?? null,
      status: git?.status ?? null,
      nodeVersion,
      timestamp,
    });
  } catch {
    return `[env node=unknown time=${Date.now()}]`;
  }
}

// Remove a previously pinned block (idempotent refresh needs this so blocks
// never stack across turns). Only strips a TRAILING block — an "[env "
// anywhere else in the prompt is left alone.
export function stripEnvBlock(content: string): string {
  const idx = content.lastIndexOf(`\n\n${ENV_BLOCK_TAG}`);
  if (idx < 0) return content;
  const tail = content.slice(idx + 2);
  if (!tail.startsWith(ENV_BLOCK_TAG)) return content;
  if (!tail.trimEnd().endsWith("]")) return content;
  return content.slice(0, idx);
}

// Pin a fresh block to system content (strips any prior block first, so
// per-turn refresh is idempotent). NEVER throws — on any failure the input
// is returned unchanged.
export function withEnvBlock(systemContent: string, cwd?: string): string {
  try {
    const base = stripEnvBlock(systemContent);
    let block = "";
    try {
      block = getEnvBlock(cwd ?? process.cwd());
    } catch {
      return base;
    }
    if (!block) return base;
    return `${base}\n\n${block}`;
  } catch {
    return systemContent;
  }
}
