// atom.json App wiring: config defaults apply when no save/env/prop, project
// beats global, explicit props still win. Network never touched (initialModels
// skips the live fetch; no turns submitted).
import React from "react";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function writeProject(projectDir: string, obj: unknown): Promise<void> {
  await fsp.writeFile(path.join(projectDir, "atom.json"), JSON.stringify(obj), "utf8");
}

async function writeGlobal(home: string, obj: unknown): Promise<void> {
  await fsp.mkdir(path.join(home, ".atom"), { recursive: true });
  await fsp.writeFile(path.join(home, ".atom", "atom.json"), JSON.stringify(obj), "utf8");
}

function isolateEnv(home: string): void {
  for (const k of [
    "OPENCODE_ZEN_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENCODE_ZEN_MODEL",
  ]) {
    delete process.env[k];
  }
  process.env.ATOM_HOME = home;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("atom.json App wiring", () => {
  test("config model/effort apply with no save/env/prop; project beats global", async () => {
    const home = await tmpDir("atom-cfgapp-h-");
    const project = await tmpDir("atom-cfgapp-p-");
    isolateEnv(home);
    await writeGlobal(home, { model: "glob-model", reasoningEffort: "low", provider: "openai" });
    await writeProject(project, { model: "proj-model-x", reasoningEffort: "high" });
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModels={["x"]}
        configDirs={{ projectDir: project, homeDir: home }}
      />
    );
    try {
      await waitForFrame(app, "model: proj-model-x");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("reasoning: high (unsupported)");
      expect(frame).toContain("provider: openai");
    } finally {
      app.unmount();
    }
  });

  test("explicit initialModel still beats config", async () => {
    const home = await tmpDir("atom-cfgapp-h-");
    const project = await tmpDir("atom-cfgapp-p-");
    isolateEnv(home);
    await writeProject(project, { model: "cfg-model" });
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="explicit-model"
        initialModels={["x"]}
        configDirs={{ projectDir: project, homeDir: home }}
      />
    );
    try {
      await waitForFrame(app, "model: explicit-model");
    } finally {
      app.unmount();
    }
  });
});
