// Extension re-loading (reload prefactor): a second loadExtensions() in one
// process evaluates fresh file contents instead of serving stale cached
// code, added files appear, deleted files disappear. Pure loader tests —
// no TUI, no network.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { clearExtensionCommands, getExtensionCommand } from "../src/extension-commands.js";
import { loadExtensions, type ExtensionRuntime } from "../src/extensions.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-reload-"));
}

let roots: string[] = [];
let runtimes: ExtensionRuntime[] = [];
afterEach(() => {
  for (const r of runtimes) {
    try {
      r.unload();
    } catch {
      // unload never throws by contract; defensive only
    }
  }
  runtimes = [];
  clearExtensionCommands();
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  roots = [];
  delete process.env.ATOM_EXTENSIONS;
});

function writeExt(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  if (!roots.includes(root)) roots.push(root);
  return abs;
}

function probeExt(marker: string, version: string, command: string): string {
  return `const fs = require("node:fs"); module.exports = function (api) { fs.writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(version)}); api.registerCommand({ name: ${JSON.stringify(command)}, description: "reload probe", handler: async () => ${JSON.stringify(version)} }); };`;
}

describe("extension re-loading", () => {
  test("edited file runs fresh code on the second load", async () => {
    const root = makeTempRoot();
    const marker = path.join(root, "version.txt");
    const entry = writeExt(root, "probe.js", probeExt(marker, "v1", "rl_probe_one"));
    const first = await loadExtensions({ entryPaths: [entry] });
    runtimes.push(first);
    expect(first.errors).toEqual([]);
    expect(readFileSync(marker, "utf8")).toBe("v1");
    expect(getExtensionCommand("rl_probe_one")?.owner).toBe("probe");
    first.unload();

    writeFileSync(entry, probeExt(marker, "v2", "rl_probe_two"), "utf8");
    const second = await loadExtensions({ entryPaths: [entry] });
    runtimes.push(second);
    expect(second.errors).toEqual([]);
    // Fresh evaluation: the new factory body ran (marker says v2), the new
    // command is live, and the old one left with the unloaded runtime.
    expect(readFileSync(marker, "utf8")).toBe("v2");
    expect(getExtensionCommand("rl_probe_two")?.owner).toBe("probe");
    expect(getExtensionCommand("rl_probe_one")).toBeUndefined();
  });

  test("added file appears and deleted file disappears across loads", async () => {
    const root = makeTempRoot();
    const marker = path.join(root, "version.txt");
    const a = writeExt(root, "a_probe.js", probeExt(marker, "a1", "rl_probe_a"));
    const first = await loadExtensions({ entryPaths: [a] });
    runtimes.push(first);
    expect(first.errors).toEqual([]);
    expect(getExtensionCommand("rl_probe_a")).toBeDefined();
    first.unload();

    const b = writeExt(root, "b_probe.js", probeExt(marker, "b1", "rl_probe_b"));
    const second = await loadExtensions({ entryPaths: [a, b] });
    runtimes.push(second);
    expect(second.errors).toEqual([]);
    expect(getExtensionCommand("rl_probe_a")).toBeDefined();
    expect(getExtensionCommand("rl_probe_b")).toBeDefined();
    second.unload();

    unlinkSync(b);
    const third = await loadExtensions({ entryPaths: [a] });
    runtimes.push(third);
    expect(third.errors).toEqual([]);
    expect(getExtensionCommand("rl_probe_a")).toBeDefined();
    expect(getExtensionCommand("rl_probe_b")).toBeUndefined();
  });

  test("unload frees registrations so the same entries load cleanly twice", async () => {
    const root = makeTempRoot();
    const marker = path.join(root, "version.txt");
    const entry = writeExt(root, "probe.js", probeExt(marker, "v1", "rl_probe_same"));
    const first = await loadExtensions({ entryPaths: [entry] });
    runtimes.push(first);
    expect(first.errors).toEqual([]);
    first.unload();
    // Without unload this second load would fail alone on the duplicate
    // command name; with it the same entries commit cleanly again.
    const second = await loadExtensions({ entryPaths: [entry] });
    runtimes.push(second);
    expect(second.errors).toEqual([]);
    expect(second.loaded.map((e) => e.name)).toEqual(["probe"]);
    expect(getExtensionCommand("rl_probe_same")?.owner).toBe("probe");
  });
});
