// Unified /model picker TUI: keyed providers appear without switching,
// long lists window instead of taking over the screen, type-to-filter
// narrows, and picking another provider's model switches provider + model.
// Network is ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let homes: string[] = [];

async function cleanEnv(): Promise<string> {
  for (const k of [
    "OPENCODE_ZEN_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ]) {
    delete process.env[k];
  }
  const home = await mkdtemp(join(tmpdir(), "atom-mp-"));
  homes.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

async function seedKeys(home: string, ids: string[]) {
  const { saveAuth, setStoredKey, emptyAuth } = await import("../src/auth.js");
  let auth = emptyAuth();
  for (const id of ids) {
    auth = setStoredKey(auth, id as never, `test-key-${id}`);
  }
  saveAuth(auth, home);
}

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

describe("unified /model picker", () => {
  test("keyed providers list without switching; long list windows; filter narrows; cross-provider pick switches", async () => {
    const home = await cleanEnv();
    await seedKeys(home, ["openai", "anthropic", "deepseek", "mistral", "google-gemini"]);
    let gets = 0;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method !== "GET") throw new Error(`unexpected POST: ${String(url)}`);
      gets += 1;
      return {
        ok: true,
        json: async () => ({ data: [{ id: "mistral-live-1" }, { id: "mistral-live-2" }] }),
      } as Response;
    });
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="big-pickle"
        initialModels={["big-pickle", "kimi-k2.5", "glm-5.3-flash"]}
      />
    );
    try {
      // Open: zero fetches, sections for keyed providers, window clips the tail.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      expect(gets).toBe(0);
      let frame = app.lastFrame() ?? "";
      expect(frame).toContain("OpenAI");
      expect(frame).toContain("gpt-5.6-terra");
      expect(frame).toContain("more"); // windowed: tail clipped
      expect(frame).not.toContain("gemini-1.5-flash"); // past the window
      // Filter narrows to one section.
      app.stdin.write("mistral-small");
      await waitForFrame(app, "mistral-small-latest");
      frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("kimi-k2.5");
      expect(frame).not.toContain("gpt-5.6-terra");
      expect(frame).toContain("1 of ");
      expect(gets).toBe(0);
      // Pick: switches provider, keeps the picked model, live list refreshes.
      app.stdin.write("\r");
      await waitForFrame(app, "provider: mistral · model: mistral-small-latest");
      expect(gets).toBe(1);
      expect(app.lastFrame()).toContain("model: mistral-small-latest");
    } finally {
      app.unmount();
    }
  });
});
