// atom.json config: per-key merge, validation, precedence
// (env > project > global > default), and App wiring. File-level tests use
// explicit temp dirs; budget tests isolate ATOM_HOME like session.test.ts.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compactPct } from "../src/compact.js";
import {
  globalConfigPath,
  loadAtomConfig,
  projectConfigPath,
} from "../src/config.js";
import { PROVIDERS } from "../src/providers.js";
import {
  EFFORT_OPTIONS,
  toolStepBudget,
} from "../src/zen.js";

const savedEnv = { ...process.env };
let dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

async function writeProjectConfig(projectDir: string, body: string): Promise<void> {
  await fsp.writeFile(projectConfigPath(projectDir), body, "utf8");
}

async function writeGlobalConfig(home: string, body: string): Promise<void> {
  await fsp.mkdir(path.join(home, ".atom"), { recursive: true });
  await fsp.writeFile(globalConfigPath(home), body, "utf8");
}

function isolateHome(home: string): void {
  for (const k of ["ATOM_MAX_TOOL_STEPS", "ATOM_COMPACT_PCT"]) {
    delete process.env[k];
  }
  process.env.ATOM_HOME = home;
}

describe("loadAtomConfig", () => {
  test("missing files yield empty config, silently", async () => {
    const loaded = loadAtomConfig(await tmpDir("atom-cfg-p-"), await tmpDir("atom-cfg-h-"));
    expect(loaded).toEqual({ config: {}, warnings: [], sources: { project: false, global: false } });
  });

  test("malformed JSON and non-objects warn, never throw", async () => {
    const project = await tmpDir("atom-cfg-p-");
    const home = await tmpDir("atom-cfg-h-");
    await writeProjectConfig(project, "{nope");
    await writeGlobalConfig(home, "[1,2]");
    const loaded = loadAtomConfig(project, home);
    expect(loaded.config).toEqual({});
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.sources).toEqual({ project: true, global: true });
  });

  test("per-key merge: project wins, global fills the rest", async () => {
    const project = await tmpDir("atom-cfg-p-");
    const home = await tmpDir("atom-cfg-h-");
    await writeProjectConfig(project, JSON.stringify({ model: "proj-model", maxToolSteps: 12 }));
    await writeGlobalConfig(
      home,
      JSON.stringify({ model: "glob-model", maxToolSteps: 9 })
    );
    const { config, warnings } = loadAtomConfig(project, home);
    expect(warnings).toEqual([]);
    expect(config).toEqual({ model: "proj-model", maxToolSteps: 12 });
  });

  test("invalid values are ignored per-key with warnings; ranges clamp", async () => {
    const project = await tmpDir("atom-cfg-p-");
    await writeProjectConfig(
      project,
      JSON.stringify({
        provider: "not-a-provider",
        model: "",
        reasoningEffort: "ultra",
        maxToolSteps: 500,
        compactPct: 10,
        futureKey: true,
      })
    );
    const { config, warnings } = loadAtomConfig(project, await tmpDir("atom-cfg-x-"));
    expect(config).toEqual({
      maxToolSteps: 100,
      compactPct: 50,
    });
    // Unknown future keys stay silent; the three invalid ones warn, plus the
    // two clamped ones say so.
    expect(warnings).toHaveLength(5);
    expect(warnings.join("\n")).not.toContain("futureKey");
    expect(warnings.join("\n")).toContain("clamped");
  });

  test("valid provider/model/effort load; effort values mirror EFFORT_OPTIONS", async () => {
    const project = await tmpDir("atom-cfg-p-");
    await writeProjectConfig(
      project,
      JSON.stringify({ provider: "openai", model: "gpt-x", reasoningEffort: "high" })
    );
    const { config, warnings } = loadAtomConfig(project, await tmpDir("atom-cfg-x-"));
    expect(warnings).toEqual([]);
    expect(config).toEqual({ provider: "openai", model: "gpt-x", reasoningEffort: "high" });
    expect(["default", "low", "medium", "high", "max"].sort()).toEqual([...EFFORT_OPTIONS].sort());
    expect(PROVIDERS.length).toBeGreaterThan(0);
  });
});

describe("budget precedence (env > file > default)", () => {
  test("global file applies when env is unset; env wins when set", async () => {
    const home = await tmpDir("atom-cfg-h-");
    isolateHome(home);
    await writeGlobalConfig(home, JSON.stringify({ maxToolSteps: 7 }));
    expect(toolStepBudget()).toBe(7);
    process.env.ATOM_MAX_TOOL_STEPS = "9";
    expect(toolStepBudget()).toBe(9);
  });

  test("no file and no env yields compiled defaults (tool steps uncapped)", async () => {
    isolateHome(await tmpDir("atom-cfg-h-"));
    expect(toolStepBudget()).toBe(Number.POSITIVE_INFINITY);
  });

  test("compactPct file applies as a fraction; env wins", async () => {
    const home = await tmpDir("atom-cfg-h-");
    isolateHome(home);
    await writeGlobalConfig(home, JSON.stringify({ compactPct: 50 }));
    expect(compactPct()).toBe(0.5);
    process.env.ATOM_COMPACT_PCT = "90";
    expect(compactPct()).toBe(0.9);
  });
});
