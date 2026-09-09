// Architecture boundaries: the module DAG that keeps the agent runtime
// independent of the TUI. Static scan (no imports executed): strips
// type-only imports, builds the runtime graph, and pins the directions the
// refactor established — UI owns React, runtime owns everything else, policy
// stays subagent-safe, and the tools/agent internals keep their one-way
// edges. A failure here names the exact file + edge that crossed a boundary.
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

// Module key: "tools" for src/tools.ts, "tools/web" for src/tools/web.ts,
// "App" for src/App.tsx, ...
function keyOf(file: string): string {
  return path
    .relative(SRC, file)
    .replace(/\.tsx?$/, "")
    .split(path.sep)
    .join("/");
}

// Runtime (value) imports of one file: type-only imports stripped, so
// `import type { X } from "../App.js"` (erased at compile) never counts.
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
    if (!spec.startsWith(".")) continue; // node:*, vitest, etc.
    const resolved = path.normalize(path.join(path.dirname(file), spec.split(".js")[0]!));
    mods.push(keyOf(resolved));
  }
  // `import { a } from` with an emptied specifier list was type-only.
  return { mods: [...new Set(mods)], external: [...new Set(external)] };
}

function graph(): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const f of srcFiles()) {
    const k = keyOf(f);
    const { mods } = runtimeDeps(f);
    // Self-imports and extensionless twin hits (./x matching ./x.ts) collapse.
    g.set(k, mods.filter((d) => d !== k && !d.endsWith("/" + k)));
  }
  return g;
}

describe("module DAG", () => {
  test("runtime import graph is acyclic", () => {
    const g = graph();
    const state = new Map<string, number>();
    const stack: string[] = [];
    let cycle: string[] | null = null;
    const visit = (n: string): void => {
      if (cycle) return;
      state.set(n, 1);
      stack.push(n);
      for (const d of g.get(n) ?? []) {
        if (!g.has(d)) continue; // extension twins resolved above; skip unknown
        if (state.get(d) === 1) {
          cycle = [...stack.slice(stack.indexOf(d)), d];
          return;
        }
        if (!state.get(d)) visit(d);
      }
      stack.pop();
      state.set(n, 2);
    };
    for (const n of g.keys()) if (!state.get(n)) visit(n);
    expect(cycle).toBeNull();
  });

  test("React/Ink live only in the UI layer", () => {
    const bad: string[] = [];
    for (const f of srcFiles()) {
      const k = keyOf(f);
      const isUi = k === "App" || k === "cli" || k.startsWith("ui/");
      if (isUi) continue;
      const { external } = runtimeDeps(f);
      if (external.length > 0) bad.push(`${k} -> ${external.join(",")}`);
    }
    expect(bad).toEqual([]);
  });

  test("runtime modules never import the UI", () => {
    const bad: string[] = [];
    for (const f of srcFiles()) {
      const k = keyOf(f);
      const isUi = k === "App" || k === "cli" || k.startsWith("ui/");
      if (isUi) continue;
      const { mods } = runtimeDeps(f);
      const hits = mods.filter((d) => d === "App" || d === "cli" || d.startsWith("ui/"));
      if (hits.length > 0) bad.push(`${k} -> ${hits.join(",")}`);
    }
    expect(bad).toEqual([]);
  });

  test("policy stays subagent-safe: permissions only, no fs/net/UI", () => {
    const g = graph();
    expect(g.get("policy")).toEqual(["permissions"]);
  });

  test("agent direction: loop/gates/types never import zen at runtime", () => {
    const g = graph();
    for (const m of ["agent/loop", "agent/gates", "agent/types"]) {
      expect(g.get(m) ?? []).not.toContain("zen");
    }
    // zen may re-export the loop (compat), never the reverse.
    expect(g.get("zen") ?? []).toContain("agent/loop");
  });

  test("tools direction: executors never import the registry", () => {
    const g = graph();
    const owners = [
      "tools/shared",
      "tools/overflow",
      "tools/fingerprints",
      "tools/filesystem",
      "tools/search",
      "tools/shell",
      "tools/web",
      "tools/todo",
    ];
    for (const m of owners) {
      expect(g.get(m) ?? []).not.toContain("tools/registry");
    }
    expect(g.get("tools/registry") ?? []).toContain("tools/filesystem");
  });

  test("scheduler reasons from metadata, not tool branches", () => {
    const g = graph();
    expect(g.get("scheduler")).toEqual(["tools"]);
  });
});
