// Project trust for extensions (ticket 07): project-scope extensions run
// unsandboxed with full user privileges, so they never execute until the
// user trusts the project. Global-scope extensions are user-owned
// (implicitly trusted, like the user's own config); the gate applies to
// project-scope + explicit paths only.
//
// The grant is durable per project directory (asked once): grants live in
// ~/.atom/trusted-projects.json (a plain JSON array of absolute dir paths,
// following the auth.json load-never-throws pattern). A decline persists
// nothing, so the next boot asks again — declining leaves project extensions
// fully inert for this session with a visible notice, never silently loaded.
// Session tool trust (/trust in App.tsx) is a separate, in-memory tier for
// write/edit/bash approval — this file is only about extension loading.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { atomDir } from "./auth.js";

export const TRUSTED_PROJECTS_FILENAME = "trusted-projects.json";

// Canonical trust prompt (single source so App and tests share the exact
// wording): states plainly that extensions run unsandboxed with full user
// privileges. The acceptance criterion pins on these words.
export function projectTrustQuestion(names: string[]): string {
  const list = names.length > 0 ? ` (${names.join(", ")})` : "";
  return (
    `This project contains ${names.length} extension(s)${list} that run unsandboxed ` +
    `with your full user privileges — they can read/write your files and run commands as you. ` +
    `Load them?`
  );
}

export function trustedProjectsFilePath(home?: string): string {
  return path.join(atomDir(home), TRUSTED_PROJECTS_FILENAME);
}

function normalizeDir(dir: string): string {
  return path.resolve(dir);
}

// Load granted project dirs; missing/corrupt files yield [] (never throws —
// a missing grant file is the normal first-run case).
export function loadTrustedProjects(home?: string): string[] {
  let raw: string;
  try {
    const p = trustedProjectsFilePath(home);
    if (!existsSync(p)) return [];
    raw = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const e of data) {
    if (typeof e === "string" && e.length > 0) {
      const abs = normalizeDir(e);
      if (!out.includes(abs)) out.push(abs);
    }
  }
  return out;
}

export function isProjectTrusted(dir: string, home?: string): boolean {
  return loadTrustedProjects(home).includes(normalizeDir(dir));
}

function saveTrustedProjects(dirs: string[], home?: string): void {
  const dir = atomDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, TRUSTED_PROJECTS_FILENAME),
    JSON.stringify([...dirs].sort(), null, 2) + "\n",
    "utf8"
  );
}

// Persist a grant (never throws — disk errors leave trust ungranted, so the
// next boot asks again rather than assuming consent).
export function grantProjectTrust(dir: string, home?: string): void {
  try {
    const abs = normalizeDir(dir);
    const current = loadTrustedProjects(home);
    if (current.includes(abs)) return;
    saveTrustedProjects([...current, abs], home);
  } catch {
    // best-effort only; trust stays ungranted
  }
}

// Remove a grant (never throws).
export function revokeProjectTrust(dir: string, home?: string): void {
  try {
    const abs = normalizeDir(dir);
    saveTrustedProjects(
      loadTrustedProjects(home).filter((d) => d !== abs),
      home
    );
  } catch {
    // best-effort only
  }
}
