// Trust, enable-disable, and lockdown (ticket 07): project-scope extensions
// never execute while untrusted (factories never run — fully inert — with
// the skip reason recorded for the host's visible notice); global scope stays
// implicitly trusted; lockdown boots zero third-party extensions (no
// backdoor, even for explicitly-passed paths) with builtins unchanged;
// enable/disable patterns select deterministically with documented
// precedence; extensions query trust via api.isProjectTrusted() under the
// ticket-01 stale-generation rule. Pure unit tests — tmpdir files, no TUI,
// no network.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  classifyExtensionScope,
  discoverExtensionEntries,
  loadExtensions,
  parseExtensionFlags,
  type ExtensionAPI,
} from "../src/extensions.js";
import {
  grantProjectTrust,
  isProjectTrusted,
  loadTrustedProjects,
  projectTrustQuestion,
  revokeProjectTrust,
} from "../src/project-trust.js";
import { loadAtomConfig } from "../src/config.js";
import {
  TOOL_DEFINITIONS,
  allToolDefinitions,
  clearExtensionTools,
  needsApproval,
} from "../src/tools.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-07-"));
}

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  roots = [];
  delete process.env.ATOM_EXTENSIONS;
  clearExtensionTools();
  for (const key of ["__capTrust", "__freshTrust"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

function writeExt(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  roots.push(root);
  return abs;
}

// A factory that proves execution by writing a marker file.
function markerExt(marker: string, extra = ""): string {
  return (
    `const fs = require("node:fs"); module.exports = function (api) { ` +
    `fs.writeFileSync(${JSON.stringify(marker)}, "ran"); ${extra} };`
  );
}

function markerExists(marker: string): boolean {
  try {
    readFileSync(marker, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("trust prompt wording", () => {
  test("states unsandboxed full-user privileges plainly", () => {
    const q = projectTrustQuestion(["my-ext"]);
    expect(q).toContain("unsandboxed");
    expect(q).toContain("full user privileges");
    expect(q).toContain("my-ext");
  });
});

describe("project-trust store", () => {
  test("grant/is/revoke round-trip per project dir, never throws", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const proj = path.join(root, "proj");
    expect(isProjectTrusted(proj, home)).toBe(false);
    grantProjectTrust(proj, home);
    expect(isProjectTrusted(proj, home)).toBe(true);
    // Sibling dirs stay untrusted; re-grant is idempotent.
    expect(isProjectTrusted(path.join(root, "other"), home)).toBe(false);
    grantProjectTrust(proj, home);
    expect(loadTrustedProjects(home)).toHaveLength(1);
    revokeProjectTrust(proj, home);
    expect(isProjectTrusted(proj, home)).toBe(false);
  });

  test("missing/corrupt store reads as untrusted, never throws", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    expect(loadTrustedProjects(home)).toEqual([]);
    mkdirSync(path.join(home, ".atom"), { recursive: true });
    writeFileSync(path.join(home, ".atom", "trusted-projects.json"), "not json", "utf8");
    expect(loadTrustedProjects(home)).toEqual([]);
    expect(isProjectTrusted(path.join(root, "proj"), home)).toBe(false);
  });
});

describe("scope classification", () => {
  test("project/global/explicit scopes resolve by location", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    expect(classifyExtensionScope(path.join(cwd, ".atom", "extensions", "a.js"), { home, cwd })).toBe("project");
    expect(classifyExtensionScope(path.join(home, ".atom", "extensions", "b.js"), { home, cwd })).toBe("global");
    expect(classifyExtensionScope(path.join(root, "elsewhere", "c.js"), { home, cwd })).toBe("explicit");
  });

  test("discovery labels scopes in project/global/explicit order", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    const proj = writeExt(root, "proj/.atom/extensions/a.js", `module.exports = function () {};`);
    const glob = writeExt(root, "home/.atom/extensions/b.js", `module.exports = function () {};`);
    const extra = writeExt(root, "extra/c.js", `module.exports = function () {};`);
    const found = discoverExtensionEntries({ home, cwd, extraPaths: [extra] });
    expect(found).toEqual([
      { path: proj, scope: "project" },
      { path: glob, scope: "global" },
      { path: extra, scope: "explicit" },
    ]);
  });
});

describe("trust gate", () => {
  test("untrusted: project + explicit factories never run; global still loads", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    const projMarker = path.join(root, "proj-ran.txt");
    const expMarker = path.join(root, "exp-ran.txt");
    writeExt(root, "proj/.atom/extensions/p.js", markerExt(projMarker));
    writeExt(
      root,
      "home/.atom/extensions/g.js",
      `module.exports = function (api) { api.registerTool({ name: "trusted_global_tool", description: "d", parameters: { type: "object" }, execute: async () => "ok" }); };`
    );
    const explicit = writeExt(root, "extra/e.js", markerExt(expMarker));
    const runtime = await loadExtensions({
      home,
      cwd,
      extraPaths: [explicit],
      projectTrusted: false,
    });
    expect(markerExists(projMarker)).toBe(false);
    expect(markerExists(expMarker)).toBe(false);
    expect(runtime.loaded.map((e) => e.name)).toEqual(["g"]);
    expect(runtime.skipped).toMatchObject([
      { name: "p", reason: "untrusted-project" },
      { name: "e", reason: "untrusted-project" },
    ]);
    expect(runtime.errors).toEqual([]);
  });

  test("trusted: everything loads and nothing is skipped", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    const projMarker = path.join(root, "proj-ran.txt");
    writeExt(root, "proj/.atom/extensions/p.js", markerExt(projMarker));
    writeExt(root, "home/.atom/extensions/g.js", `module.exports = function () {};`);
    const runtime = await loadExtensions({ home, cwd, projectTrusted: true });
    expect(markerExists(projMarker)).toBe(true);
    expect(runtime.loaded.map((e) => e.name).sort()).toEqual(["g", "p"]);
    expect(runtime.skipped).toEqual([]);
    expect(runtime.errors).toEqual([]);
  });

  test("pre-resolved entryPaths honor the gate (no backdoor via explicit seam)", async () => {
    const root = makeTempRoot();
    const marker = path.join(root, "ran.txt");
    const entry = writeExt(root, "x.js", markerExt(marker));
    const denied = await loadExtensions({ entryPaths: [entry], projectTrusted: false });
    expect(markerExists(marker)).toBe(false);
    expect(denied.loaded).toEqual([]);
    expect(denied.skipped).toMatchObject([{ name: "x", reason: "untrusted-project" }]);
  });
});

describe("lockdown", () => {
  test("boots zero third-party extensions, even explicitly-passed paths", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    const markers = [path.join(root, "a.txt"), path.join(root, "b.txt"), path.join(root, "c.txt")];
    writeExt(root, "proj/.atom/extensions/a.js", markerExt(markers[0]!));
    writeExt(root, "home/.atom/extensions/b.js", markerExt(markers[1]!));
    const explicit = writeExt(root, "extra/c.js", markerExt(markers[2]!));
    const runtime = await loadExtensions({
      home,
      cwd,
      extraPaths: [explicit],
      projectTrusted: true,
      lockdown: true,
    });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors).toEqual([]);
    expect(runtime.skipped.map((s) => s.reason)).toEqual(["lockdown", "lockdown", "lockdown"]);
    for (const m of markers) expect(markerExists(m)).toBe(false);
  });

  test("builtin behavior is unchanged under lockdown", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "x.js", `module.exports = function (api) { api.registerTool({ name: "lock_me_out", description: "d", parameters: { type: "object" }, execute: async () => "x" }); };`);
    await loadExtensions({ entryPaths: [entry], lockdown: true });
    // No extension tool leaked in; the builtin set is exactly what it was.
    // Ticket 06: update_goal is registry-intercepted — model-visible via
    // allToolDefinitions but not a TOOL_DEFINITIONS builtin — so the visible
    // set is the builtins plus update_goal, with no extension residue.
    expect(allToolDefinitions()).toHaveLength(TOOL_DEFINITIONS.length + 1);
    expect(allToolDefinitions().map((t) => t.function.name).sort()).toEqual(
      [...TOOL_DEFINITIONS.map((t) => t.function.name), "update_goal"].sort()
    );
    expect(needsApproval("read")).toBe(false);
    expect(needsApproval("write")).toBe(true);
  });
});

describe("enable/disable patterns", () => {
  test("disabled wins over enabled; non-empty enabled is an allowlist", async () => {
    const root = makeTempRoot();
    const a = writeExt(root, "alpha.js", `module.exports = function () {};`);
    const b = writeExt(root, "beta.js", `module.exports = function () {};`);
    const c = writeExt(root, "gamma.js", `module.exports = function () {};`);
    // Disabled beats a matching enabled glob.
    const runtime = await loadExtensions({
      entryPaths: [a, b, c],
      projectTrusted: true,
      enabledPatterns: ["*"],
      disabledPatterns: ["beta"],
    });
    expect(runtime.loaded.map((e) => e.name).sort()).toEqual(["alpha", "gamma"]);
    expect(runtime.skipped).toMatchObject([{ name: "beta", reason: "disabled" }]);
    // Allowlist: non-matching entries skip as not-enabled.
    const listed = await loadExtensions({
      entryPaths: [a, b, c],
      projectTrusted: true,
      enabledPatterns: ["alpha", "gamma"],
    });
    expect(listed.loaded.map((e) => e.name).sort()).toEqual(["alpha", "gamma"]);
    expect(listed.skipped).toMatchObject([{ name: "beta", reason: "not-enabled" }]);
  });

  test("globs match names (`*`/`?`, case-sensitive) across scopes", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    writeExt(root, "proj/.atom/extensions/my-tool.js", `module.exports = function () {};`);
    writeExt(root, "proj/.atom/extensions/my-other.js", `module.exports = function () {};`);
    writeExt(root, "proj/.atom/extensions/unrelated.js", `module.exports = function () {};`);
    const runtime = await loadExtensions({
      home,
      cwd,
      projectTrusted: true,
      enabledPatterns: ["my-*"],
    });
    expect(runtime.loaded.map((e) => e.name).sort()).toEqual(["my-other", "my-tool"]);
    expect(runtime.skipped).toMatchObject([{ name: "unrelated", reason: "not-enabled" }]);
  });

  test("lockdown outranks trust + patterns (documented precedence)", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "a.js", `module.exports = function () {};`);
    const runtime = await loadExtensions({
      entryPaths: [entry],
      projectTrusted: true,
      lockdown: true,
      enabledPatterns: ["a"],
    });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.skipped).toMatchObject([{ name: "a", reason: "lockdown" }]);
  });
});

describe("trust-query API", () => {
  test("isProjectTrusted reflects the load and degrades gracefully", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    const body =
      `module.exports = function (api) { globalThis.__capTrust = api; ` +
      `api.on("session_start", (fresh) => { globalThis.__freshTrust = fresh; }); };`;
    // A global-scope extension loads even while the project is untrusted —
    // it observes false and degrades gracefully instead of assuming trust.
    const untrustedEntry = writeExt(root, "home/.atom/extensions/q-untrusted.js", body);
    const runtime = await loadExtensions({ home, cwd, projectTrusted: false });
    expect(runtime.loaded.map((e) => e.name)).toEqual(["q-untrusted"]);
    const captured = (globalThis as Record<string, unknown>).__capTrust as ExtensionAPI;
    expect(captured.isProjectTrusted()).toBe(false);
    await runtime.emit("session_start", { reason: "startup" });
    const fresh = (globalThis as Record<string, unknown>).__freshTrust as ExtensionAPI;
    expect(fresh.isProjectTrusted()).toBe(false);
    // Same shape under a trusted project reports true (separate file so no
    // module-cache assumption is needed).
    const trustedEntry = writeExt(root, "home/.atom/extensions/q-trusted.js", body);
    const trusted = await loadExtensions({ entryPaths: [trustedEntry], projectTrusted: true });
    expect(trusted.loaded.map((e) => e.name)).toEqual(["q-trusted"]);
    expect(((globalThis as Record<string, unknown>).__capTrust as ExtensionAPI).isProjectTrusted()).toBe(true);
    expect(untrustedEntry).toBeTruthy();
  });

  test("stale-generation rule covers isProjectTrusted (activation + emit-time)", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "cap.js",
      `module.exports = function (api) { globalThis.__capTrust = api; api.on("session_start", (fresh) => { globalThis.__freshTrust = fresh; }); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], projectTrusted: true });
    const captured = (globalThis as Record<string, unknown>).__capTrust as ExtensionAPI;
    expect(captured.isProjectTrusted()).toBe(true);
    runtime.invalidate("stale after test switch");
    expect(() => captured.isProjectTrusted()).toThrow("stale after test switch");
    await runtime.emit("session_start", { reason: "switch" });
    const fresh = (globalThis as Record<string, unknown>).__freshTrust as ExtensionAPI;
    expect(fresh.isProjectTrusted()).toBe(true);
  });
});

describe("CLI flags", () => {
  test("lockdown aliases and repeatable enable/disable (space, =, comma)", () => {
    expect(parseExtensionFlags([])).toEqual({ lockdown: false, enable: [], disable: [] });
    expect(parseExtensionFlags(["--no-extensions"]).lockdown).toBe(true);
    expect(parseExtensionFlags(["--lockdown"]).lockdown).toBe(true);
    expect(
      parseExtensionFlags(["--enable-extension", "a*", "--enable-extension=b,c", "--disable-extension", "d?"])
    ).toEqual({ lockdown: false, enable: ["a*", "b", "c"], disable: ["d?"] });
    // A following flag is not swallowed as a value; empties dropped.
    expect(parseExtensionFlags(["--enable-extension", "--no-extensions"])).toEqual({
      lockdown: true,
      enable: [],
      disable: [],
    });
    expect(parseExtensionFlags(["--disable-extension= , x "])).toEqual({
      lockdown: false,
      enable: [],
      disable: ["x"],
    });
  });
});

describe("atom.json extensions config", () => {
  test("project wins over global; invalid shapes warn and are ignored", () => {
    const root = makeTempRoot();
    const projDir = path.join(root, "proj");
    const homeDir = path.join(root, "home");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(path.join(homeDir, ".atom"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".atom", "atom.json"),
      JSON.stringify({ extensions: { enabled: ["*"], disabled: ["nope"] } }),
      "utf8"
    );
    writeFileSync(
      path.join(projDir, "atom.json"),
      JSON.stringify({ extensions: { enabled: ["mine-*"] } }),
      "utf8"
    );
    const loaded = loadAtomConfig(projDir, homeDir);
    // Per-key merge like every other atom.json key: the project block wins.
    expect(loaded.config.extensions).toEqual({ enabled: ["mine-*"] });
    expect(loaded.warnings).toEqual([]);
  });

  test("non-array keys ignored with warnings; bad entries dropped", () => {
    const root = makeTempRoot();
    const projDir = path.join(root, "proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      path.join(projDir, "atom.json"),
      JSON.stringify({ extensions: { enabled: "all", disabled: ["ok", "", 42] } }),
      "utf8"
    );
    const loaded = loadAtomConfig(projDir, path.join(root, "no-home"));
    expect(loaded.config.extensions).toEqual({ disabled: ["ok"] });
    expect(loaded.warnings.some((w) => w.includes('"extensions.enabled"'))).toBe(true);
    expect(loaded.warnings.some((w) => w.includes("dropped 2"))).toBe(true);
  });
});
