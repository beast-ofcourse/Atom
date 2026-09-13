// Ambient instruction files (OpenCode-V2 parity): chain discovery, no-cap
// combining, lazy nested discovery, and the live-update tracker.
// All temp-rooted and hermetic — never touches the real ~/.atom.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  combineInstructionSources,
  createInstructionTracker,
  discoverInstructionSources,
  formatInstructionUpdate,
  formatNestedInstruction,
  globalAgentsPath,
  loadInstructionPrompt,
  nestedAgentsForTarget,
  projectChainPaths,
  type InstructionSource,
} from "../src/instructions.js";

const realAtomHome = process.env.ATOM_HOME;
const realAgentsPath = process.env.OPENCODE_AGENTS_PATH;
const realDisableConfig = process.env.OPENCODE_DISABLE_PROJECT_CONFIG;

let home = "";
let root = "";

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-inst-home-"));
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-inst-root-"));
  process.env.ATOM_HOME = home;
});

afterEach(async () => {
  if (realAtomHome === undefined) delete process.env.ATOM_HOME;
  else process.env.ATOM_HOME = realAtomHome;
  if (realAgentsPath === undefined) delete process.env.OPENCODE_AGENTS_PATH;
  else process.env.OPENCODE_AGENTS_PATH = realAgentsPath;
  if (realDisableConfig === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = realDisableConfig;
  if (home) await fsp.rm(home, { recursive: true, force: true });
  if (root) await fsp.rm(root, { recursive: true, force: true });
  home = "";
  root = "";
});

function src(p: string, content: string, scope: InstructionSource["scope"] = "project"): InstructionSource {
  return { path: p, scope, content, mtimeMs: 1, size: content.length };
}

describe("project chain discovery", () => {
  test("empty tree discovers nothing", () => {
    expect(discoverInstructionSources(root, home)).toEqual([]);
    expect(loadInstructionPrompt(root, home)).toBeNull();
  });

  test("global file loads first, then leaf-before-root", async () => {
    await fsp.writeFile(path.join(home, ".atom", "AGENTS.md"), "global rules", { flag: "w" }).catch(async () => {
      await fsp.mkdir(path.join(home, ".atom"), { recursive: true });
      await fsp.writeFile(path.join(home, ".atom", "AGENTS.md"), "global rules");
    });
    const pkg = path.join(root, "packages", "web");
    await fsp.mkdir(pkg, { recursive: true });
    await fsp.writeFile(path.join(root, "AGENTS.md"), "root rules");
    await fsp.writeFile(path.join(pkg, "AGENTS.md"), "leaf rules");
    const found = discoverInstructionSources(pkg, home);
    expect(found.map((s) => s.scope)).toEqual(["global", "project", "project"]);
    expect(found[0]!.path).toBe(globalAgentsPath(home));
    // nearest-first: leaf before root
    expect(found[1]!.path).toBe(path.resolve(path.join(pkg, "AGENTS.md")));
    expect(found[2]!.path).toBe(path.resolve(path.join(root, "AGENTS.md")));
    const combined = loadInstructionPrompt(pkg, home)!;
    expect(combined).toContain("global rules");
    expect(combined).toContain("leaf rules");
    expect(combined).toContain("root rules");
    // multi-source sections stay attributable
    expect(combined.indexOf("leaf rules")).toBeLessThan(combined.indexOf("root rules"));
  });

  test("OPENCODE_DISABLE_PROJECT_CONFIG=1 keeps global only", async () => {
    await fsp.mkdir(path.join(home, ".atom"), { recursive: true });
    await fsp.writeFile(path.join(home, ".atom", "AGENTS.md"), "global rules");
    await fsp.writeFile(path.join(root, "AGENTS.md"), "root rules");
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    const found = discoverInstructionSources(root, home);
    expect(found.map((s) => s.scope)).toEqual(["global"]);
  });

  test("OPENCODE_AGENTS_PATH pins a single file", async () => {
    const custom = path.join(root, "custom.md");
    await fsp.writeFile(custom, "custom rules");
    await fsp.writeFile(path.join(root, "AGENTS.md"), "root rules");
    process.env.OPENCODE_AGENTS_PATH = custom;
    const found = discoverInstructionSources(root, home);
    expect(found.length).toBe(1);
    expect(found[0]!.content).toBe("custom rules");
  });

  test("same name re-encountered never duplicates", async () => {
    await fsp.writeFile(path.join(root, "AGENTS.md"), "root rules");
    const found = discoverInstructionSources(root, home);
    const paths = found.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("no-cap combining", () => {
  test("single source injects bare (backward compatible)", () => {
    expect(combineInstructionSources([src("/x/AGENTS.md", "# Bot rules\nBe terse.")])).toBe(
      "# Bot rules\nBe terse."
    );
  });

  test("large files load in full — never truncated", () => {
    const big = "x".repeat(64 * 1024);
    const out = combineInstructionSources([src("/x/AGENTS.md", big)])!;
    expect(out.length).toBe(64 * 1024);
    expect(out).not.toContain("[truncated:");
  });

  test("empty sources combine to null", () => {
    expect(combineInstructionSources([])).toBeNull();
    expect(combineInstructionSources([src("/x/AGENTS.md", "")])).toBeNull();
  });
});

describe("lazy nested discovery", () => {
  test("target below workspace finds intermediate AGENTS.md nearest-first", async () => {
    const ws = path.join(root, "proj");
    const deep = path.join(ws, "packages", "web", "src");
    await fsp.mkdir(deep, { recursive: true });
    await fsp.writeFile(path.join(ws, "AGENTS.md"), "ws rules");
    await fsp.writeFile(path.join(ws, "packages", "AGENTS.md"), "pkg rules");
    await fsp.writeFile(path.join(ws, "packages", "web", "AGENTS.md"), "web rules");
    await fsp.writeFile(path.join(deep, "app.ts"), "const x = 1;");
    const found = nestedAgentsForTarget(path.join(deep, "app.ts"), ws);
    expect(found).toEqual([
      path.join(ws, "packages", "web", "AGENTS.md"),
      path.join(ws, "packages", "AGENTS.md"),
    ]);
  });

  test("target outside workspace finds nothing", async () => {
    const ws = path.join(root, "proj");
    await fsp.mkdir(ws, { recursive: true });
    expect(nestedAgentsForTarget(path.join(root, "other", "f.ts"), ws)).toEqual([]);
  });

  test("workspace's own file is excluded (already loaded initially)", async () => {
    const ws = path.join(root, "proj");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "AGENTS.md"), "ws rules");
    await fsp.writeFile(path.join(ws, "f.ts"), "x");
    expect(nestedAgentsForTarget(path.join(ws, "f.ts"), ws)).toEqual([]);
  });
});

describe("instruction tracker", () => {
  test("detects edits, tolerates transient state, reports deletes", async () => {
    const file = path.join(root, "AGENTS.md");
    await fsp.writeFile(file, "v1");
    const t = createInstructionTracker();
    t.sync(discoverInstructionSources(root, home));
    expect(t.checkForUpdates()).toEqual({ changed: [], removed: [] });
    await fsp.writeFile(file, "v2 — more instructions");
    const upd = t.checkForUpdates();
    expect(upd.removed).toEqual([]);
    expect(upd.changed.length).toBe(1);
    expect(upd.changed[0]!.content).toContain("v2");
    expect(formatInstructionUpdate(upd.changed[0]!)).toContain("[instruction update:");
    // second check is quiet (state advanced)
    expect(t.checkForUpdates()).toEqual({ changed: [], removed: [] });
    await fsp.rm(file);
    const del = t.checkForUpdates();
    expect(del.changed).toEqual([]);
    expect(del.removed.length).toBe(1);
  });

  test("has/add dedupe nested sources", () => {
    const t = createInstructionTracker();
    t.sync([]);
    const p = path.join(root, "AGENTS.md");
    expect(t.has(p)).toBe(false);
    t.add(src(p, "nested!", "nested"));
    expect(t.has(p)).toBe(true);
    expect(formatNestedInstruction(src(p, "nested!", "nested"))).toContain(
      "[nested instructions:"
    );
  });

  test("reset clears state", async () => {
    await fsp.writeFile(path.join(root, "AGENTS.md"), "v1");
    const t = createInstructionTracker();
    t.sync(discoverInstructionSources(root, home));
    t.reset();
    expect(t.checkForUpdates()).toEqual({ changed: [], removed: [] });
  });
});

describe("projectChainPaths", () => {
  test("leaf-first ordering up the tree", async () => {
    const deep = path.join(root, "a", "b");
    await fsp.mkdir(deep, { recursive: true });
    const chain = projectChainPaths(deep, home);
    expect(chain[0]).toBe(path.join(path.resolve(deep), "AGENTS.md"));
    expect(chain).toContain(path.join(path.resolve(root), "AGENTS.md"));
    // strictly leaf-first: deeper entries come first
    const idxDeep = chain.indexOf(path.join(path.resolve(deep), "AGENTS.md"));
    const idxRoot = chain.indexOf(path.join(path.resolve(root), "AGENTS.md"));
    expect(idxDeep).toBeLessThan(idxRoot);
  });
});
