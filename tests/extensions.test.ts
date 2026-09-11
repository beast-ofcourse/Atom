// Extension host skeleton (ticket 01): discovery, loading, lifecycle,
// stale-use enforcement. Pure loader/runtime tests — no TUI, no network.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  discoverExtensionPaths,
  globalExtensionsDir,
  loadExtensions,
  projectExtensionsDir,
  resolveExtensionName,
  type ExtensionAPI,
} from "../src/extensions.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-01-"));
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
  vi.unstubAllEnvs?.();
});

function writeExt(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  roots.push(root);
  return abs;
}

const HELLO = `module.exports = function (api) { api.on("session_start", () => {}); };`;
const HELLO_TS = `export default function (api: any) { api.on("session_start", () => {}); };`;

describe("resolveExtensionName", () => {
  test("file stem wins; index.* falls back to parent dir", () => {
    expect(resolveExtensionName("/x/extensions/hello.js")).toBe("hello");
    expect(resolveExtensionName("/x/extensions/my-ext/index.ts")).toBe("my-ext");
  });
});

describe("discoverExtensionPaths", () => {
  test("project scope, global scope, and explicit paths in order, deduped", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    const projFile = writeExt(root, "proj/.atom/extensions/a.js", HELLO);
    const globalFile = writeExt(root, "home/.atom/extensions/b.js", HELLO);
    const extraFile = writeExt(root, "extra/c.js", HELLO);
    const found = discoverExtensionPaths({ home, cwd, extraPaths: [extraFile, extraFile] });
    expect(found).toEqual([projFile, globalFile, extraFile]);
  });

  test("missing scopes are silently skipped; env paths honored", () => {
    const root = makeTempRoot();
    const extraFile = writeExt(root, "extra/c.js", HELLO);
    process.env.ATOM_EXTENSIONS = extraFile;
    const found = discoverExtensionPaths({
      home: path.join(root, "no-home"),
      cwd: path.join(root, "no-proj"),
    });
    expect(found).toEqual([extraFile]);
  });

  test("subdirectory with atom manifest resolves declared entries", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    writeExt(root, "home/.atom/extensions/pkg/dist/index.js", HELLO);
    writeExt(
      root,
      "home/.atom/extensions/pkg/package.json",
      JSON.stringify({ name: "pkg", atom: { extensions: ["./dist/index.js"] } })
    );
    const found = discoverExtensionPaths({ home, cwd: path.join(root, "no-proj") });
    expect(found).toEqual([path.join(root, "home/.atom/extensions/pkg/dist/index.js")]);
  });

  test("dir helpers honor overrides", () => {
    expect(globalExtensionsDir("/h")).toBe(path.join("/h", ".atom", "extensions"));
    expect(projectExtensionsDir("/c")).toBe(path.join("/c", ".atom", "extensions"));
  });
});

describe("loadExtensions", () => {
  test("js + ts extensions load and names are recorded", async () => {
    const root = makeTempRoot();
    const a = writeExt(root, "a.js", `module.exports = function () {};`);
    const b = writeExt(root, "b.ts", HELLO_TS);
    const runtime = await loadExtensions({ entryPaths: [a, b] });
    expect(runtime.errors).toEqual([]);
    expect(runtime.loaded.map((e) => e.name)).toEqual(["a", "b"]);
  });

  test("activation runs exactly once per extension", async () => {
    const root = makeTempRoot();
    const marker = path.join(root, "count.txt");
    writeFileSync(marker, "0", "utf8");
    const a = writeExt(
      root,
      "a.cjs",
      `const fs = require("node:fs"); module.exports = function () { fs.writeFileSync(${JSON.stringify(marker)}, String(Number(fs.readFileSync(${JSON.stringify(marker)}, "utf8")) + 1)); };`
    );
    await loadExtensions({ entryPaths: [a] });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8")).toBe("1");
  });

  test("throwing factory fails alone; siblings still load", async () => {
    const root = makeTempRoot();
    const bad = writeExt(root, "bad.js", `module.exports = function () { throw new Error("boom-activation"); };`);
    const good = writeExt(root, "good.js", HELLO);
    const runtime = await loadExtensions({ entryPaths: [bad, good] });
    expect(runtime.loaded.map((e) => e.name)).toEqual(["good"]);
    expect(runtime.errors).toHaveLength(1);
    expect(runtime.errors[0]).toMatchObject({ path: bad });
    expect(runtime.errors[0]!.error).toContain("boom-activation");
  });

  test("non-function export is an error entry, not a crash", async () => {
    const root = makeTempRoot();
    const bad = writeExt(root, "bad.js", `module.exports = { not: "a factory" };`);
    const runtime = await loadExtensions({ entryPaths: [bad] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors).toHaveLength(1);
    expect(runtime.errors[0]!.error).toContain("factory");
  });

  test("missing entry file is an error entry, never a throw", async () => {
    const runtime = await loadExtensions({ entryPaths: ["/no/such/ext.js"] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors).toHaveLength(1);
  });

  test("session_start handlers fire in registration order", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(root, "first.js", `module.exports = function (api) { api.on("session_start", () => { globalThis.__order.push("first"); }); };`),
        writeExt(root, "second.js", `module.exports = function (api) { api.on("session_start", () => { globalThis.__order.push("second"); }); };`),
      ],
    });
    (globalThis as Record<string, unknown>).__order = [];
    await runtime.emit("session_start", { reason: "startup" });
    expect((globalThis as Record<string, unknown>).__order).toEqual(["first", "second"]);
    delete (globalThis as Record<string, unknown>).__order;
    expect(runtime.errors).toEqual([]);
  });

  test("stale api throws on use after invalidate; emit-time api stays live", async () => {
    const root = makeTempRoot();
    let captured: ExtensionAPI | null = null;
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "cap.js",
          `module.exports = function (api) { globalThis.__cap = api; api.on("session_start", (fresh) => { globalThis.__fresh = fresh; }); };`
        ),
      ],
    });
    captured = (globalThis as Record<string, unknown>).__cap as ExtensionAPI;
    delete (globalThis as Record<string, unknown>).__cap;
    expect(captured).not.toBeNull();
    runtime.invalidate("stale after test switch");
    expect(() => captured!.on("session_start", () => {})).toThrow("stale after test switch");
    await runtime.emit("session_start", { reason: "switch" });
    const fresh = (globalThis as Record<string, unknown>).__fresh as ExtensionAPI;
    delete (globalThis as Record<string, unknown>).__fresh;
    expect(() => fresh.on("session_shutdown", () => {})).not.toThrow();
    expect(runtime.generation).toBe(1);
  });

  test("unsubscribe removes the handler", async () => {
    const root = makeTempRoot();
    const a = writeExt(
      root,
      "a.js",
      `module.exports = function (api) { const off = api.on("session_start", () => { globalThis.__hit = (globalThis.__hit || 0) + 1; }); off(); };`
    );
    const runtime = await loadExtensions({ entryPaths: [a] });
    await runtime.emit("session_start", { reason: "startup" });
    expect((globalThis as Record<string, unknown>).__hit ?? 0).toBe(0);
    delete (globalThis as Record<string, unknown>).__hit;
  });

  test("throwing handler is recorded and siblings still run", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(root, "bad.js", `module.exports = function (api) { api.on("session_start", () => { throw new Error("boom-handler"); }); };`),
        writeExt(root, "good.js", `module.exports = function (api) { api.on("session_start", () => { globalThis.__ok = true; }); };`),
      ],
    });
    await runtime.emit("session_start", { reason: "startup" });
    expect((globalThis as Record<string, unknown>).__ok).toBe(true);
    delete (globalThis as Record<string, unknown>).__ok;
    expect(runtime.errors.some((e) => e.error.includes("boom-handler"))).toBe(true);
  });
});
