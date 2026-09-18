// Phase 0.2 literal-audit: all paint in src/ui flows through src/ui/theme.ts
// (or the future src/ui/themes/ registry). Fails on literal paint outside
// the theme system: color="..."/backgroundColor="..."/borderColor="..." JSX
// props and hex literals (#[0-9A-Fa-f]{3,8}). Allowed ONLY in
// src/ui/theme.ts and src/ui/themes/ (dir may not exist yet — allowance is
// path-based, not existence-based).
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_UI = path.join(HERE, "..", "src", "ui");
const THEME_FILE = path.join(SRC_UI, "theme.ts");
const THEMES_DIR = path.join(SRC_UI, "themes");

function isAllowed(file: string): boolean {
  if (file === THEME_FILE) return true;
  // Path-based allowance: themes/ may not exist yet.
  return file.startsWith(THEMES_DIR + path.sep);
}

function uiFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(SRC_UI);
  return out.sort();
}

const PROP_RE = /\b(?:color|backgroundColor|borderColor)="[^"]*"/;
const HEX_RE = /#[0-9A-Fa-f]{3,8}\b/;

function scan(re: RegExp): string[] {
  const hits: string[] = [];
  for (const f of uiFiles()) {
    if (isAllowed(f)) continue;
    const rel = path.relative(path.join(HERE, ".."), f).split(path.sep).join("/");
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((ln, i) => {
      const m = ln.match(re);
      if (m) hits.push(`${rel}:${i + 1}: ${ln.trim()} (matched ${m[0]})`);
    });
  }
  return hits;
}

describe("theme literal audit (Phase 0.2)", () => {
  test("no literal color/backgroundColor/borderColor props outside theme", () => {
    expect(scan(PROP_RE)).toEqual([]);
  });

  test("no hex literals outside theme", () => {
    expect(scan(HEX_RE)).toEqual([]);
  });
});
