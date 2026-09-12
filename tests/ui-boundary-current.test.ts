// Refined UI-boundary contract (web-runtime era).
//
// `src/web/runtime.ts` shares the pure diff engine (`src/ui/diff.ts`) with
// the TUI so both surfaces compute identical hunks/rows. The blanket
// "no runtime module imports ui/*" rule predates src/web and is stale for
// zero-dependency engines. The rules that still matter, pinned here with
// the same static-scan convention as tests/architecture.test.ts:
//
// - react/ink live only in App, cli, and ui/* (web/ included in the ban).
// - ui/diff.ts (and ui/highlight.ts) are pure: no react/ink references, so
//   sharing them from web/ or anywhere else cannot drag the TUI into the
//   server path.
// - web/'s only ui/* dependency is that pure diff engine.
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

function keyOf(file: string): string {
  return path.relative(SRC, file).replace(/\.tsx?$/, "").split(path.sep).join("/");
}

function runtimeDeps(file: string): { mods: string[]; external: string[] } {
  let s = readFileSync(file, "utf8");
  s = s.replace(/import\s+type\s+[^;]+;/g, "");
  s = s.replace(/\{([^}]*)\}/g, (m, inner: string) => {
    const kept = String(inner)
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p && !/^type\b/.test(p));
    return kept.length > 0 ? `{${kept.join(", ")}}` : "{}";
  });
  const mods: string[] = [];
  const external: string[] = [];
  for (const m of s.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1]!;
    if (spec === "react" || spec === "ink" || spec === "ink-testing-library") {
      external.push(spec);
      continue;
    }
    if (!spec.startsWith(".")) continue;
    const resolved = path.normalize(path.join(path.dirname(file), spec.split(".js")[0]!));
    mods.push(keyOf(resolved));
  }
  return { mods: [...new Set(mods)], external: [...new Set(external)] };
}

describe("ui boundary (web-runtime era)", () => {
  test("pure diff engines carry no react/ink references", () => {
    for (const name of ["ui/diff", "ui/highlight"]) {
      const src = readFileSync(path.join(SRC, ...name.split("/")) + ".ts", "utf8");
      expect(src, `${name} must stay react-free`).not.toMatch(/from\s+['"]react['"]/);
      expect(src, `${name} must stay ink-free`).not.toMatch(/from\s+['"]ink['"]/);
    }
  });

  test("react/ink stay inside App, cli, and ui/* (web/ included in the ban)", () => {
    const bad: string[] = [];
    for (const f of srcFiles()) {
      const k = keyOf(f);
      if (k === "App" || k === "cli" || k.startsWith("ui/")) continue;
      const { external } = runtimeDeps(f);
      if (external.length > 0) bad.push(`${k} -> ${external.join(",")}`);
    }
    expect(bad).toEqual([]);
  });

  test("web/ shares only the pure diff engine from ui/*", () => {
    const bad: string[] = [];
    for (const f of srcFiles()) {
      const k = keyOf(f);
      if (!k.startsWith("web/")) continue;
      const { mods } = runtimeDeps(f);
      const hits = mods.filter(
        (d) => d === "App" || d === "cli" || (d.startsWith("ui/") && d !== "ui/diff")
      );
      if (hits.length > 0) bad.push(`${k} -> ${hits.join(",")}`);
    }
    expect(bad).toEqual([]);
  });
});
