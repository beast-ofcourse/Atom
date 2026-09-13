// /provider TUI flows (mocked fetch only, temp ATOM_HOME, "test-key" fixtures).
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS = ["big-pickle", "kimi-k2.5"];
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let homes: string[] = [];

async function cleanEnv(): Promise<string> {
  for (const k of [
    "KILO_API_KEY",
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
  const home = await mkdtemp(join(tmpdir(), "atom-flow-"));
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
  const { rm } = await import("node:fs/promises");
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
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

// Router: GET models per kind ok; POST chat per kind replies.
function mockRouter(opts?: { failAnthropicValidate?: boolean }) {
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (method === "GET") {
      if (opts?.failAnthropicValidate && u.includes("anthropic")) {
        return { ok: false, status: 401, text: async () => "unauthorized" } as unknown as Response;
      }
      if (u.includes("anthropic")) {
        return { ok: true, json: async () => ({ data: [{ id: "claude-sonnet-4-5" }] }) } as Response;
      }
      return { ok: true, json: async () => ({ data: [{ id: "x-live" }] }) } as Response;
    }
    if (u.includes("anthropic")) {
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "anthropic-hi" }],
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: "zen-hi" } }] }) } as Response;
  });
}

async function openProviderPicker(app: { stdin: { write(s: string): void } }) {
  app.stdin.write("/provider");
  app.stdin.write("\r");
  await waitForFrame(app as never, "Select provider");
}

describe("/provider TUI", () => {
  test("lists 16 providers with key markers; paste validates, saves, switches, chats", async () => {
    const home = await cleanEnv();
    mockRouter();
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      await openProviderPicker(app);
      const frame = app.lastFrame() ?? "";
      // All 16 ids listed; zen has the seeded key, anthropic has none.
      // Kilo (the default) shows its optional-key marker.
      for (const id of ["kilo", "opencode-zen", "openai", "anthropic", "deepseek", "mistral", "google-gemini", "groq", "xai", "zai", "openrouter", "cerebras", "openai-compatible", "ollama", "lmstudio", "llamacpp"]) {
        expect(frame).toContain(id);
      }
      expect(frame).toContain("key optional");
      expect(frame).toContain("✓ key");
      expect(frame).toContain("— no key");
      // Move to anthropic (index 2) + Enter -> key prompt with console URL.
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "API key for anthropic");
      expect(app.lastFrame()).toContain("console.anthropic.com");
      // Paste (masked, never full key on screen).
      app.stdin.write("test-key");
      await waitForFrame(app, "•");
      expect(app.lastFrame()).not.toContain("test-key");
      app.stdin.write("\r");
      await waitForFrame(app, "anthropic/");
      expect(app.lastFrame()).toContain("claude-sonnet-4-5");
      // Auth persisted (stored key, never env).
      const raw = await readFile(join(home, ".atom", "auth.json"), "utf8");
      expect(JSON.parse(raw).providers["anthropic"].apiKey).toBe("test-key");
      // Chat works through the anthropic adapter (normalized).
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "anthropic-hi");
    } finally {
      app.unmount();
    }
  });

  test("Esc in a fresh key prompt cancels back to the picker (no switch)", async () => {
    await cleanEnv();
    mockRouter();
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      await openProviderPicker(app);
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "API key for anthropic");
      app.stdin.write("\u001B"); // Esc -> back to picker
      await waitForFrame(app, "Select provider");
      expect(app.lastFrame()).toContain("opencode-zen/");
      app.stdin.write("\u001B"); // Esc closes picker
      await waitForFrame(app, "›");
      expect(app.lastFrame()).not.toContain("Select provider");
      expect(app.lastFrame()).toContain("opencode-zen/");
    } finally {
      app.unmount();
    }
  });

  test("validation failure shows inline error and stays (Esc back safe)", async () => {
    await cleanEnv();
    mockRouter({ failAnthropicValidate: true });
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      await openProviderPicker(app);
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "API key for anthropic");
      app.stdin.write("test-key");
      app.stdin.write("\r");
      await waitForFrame(app, "401");
      // Still in the prompt (can retry), provider unchanged.
      expect(app.lastFrame()).toContain("API key for anthropic");
      expect(app.lastFrame()).toContain("opencode-zen/");
      app.stdin.write("\u001B");
      await waitForFrame(app, "Select provider");
      expect(app.lastFrame()).toContain("opencode-zen/");
    } finally {
      app.unmount();
    }
  });

  test("replace-key: existing masked hint, typing replaces and switches", async () => {
    const home = await cleanEnv();
    // Pre-seed anthropic stored key (fixture value).
    const { saveAuth, setStoredKey, emptyAuth } = await import("../src/auth.js");
    saveAuth(setStoredKey(emptyAuth(), "anthropic", "test-key"), home);
    mockRouter();
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      await openProviderPicker(app);
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "key on file");
      expect(app.lastFrame()).toContain("…-key");
      expect(app.lastFrame()).not.toContain("test-key");
      app.stdin.write("test-key-2");
      app.stdin.write("\r");
      await waitForFrame(app, "anthropic/");
      const raw = await readFile(join(home, ".atom", "auth.json"), "utf8");
      expect(JSON.parse(raw).providers["anthropic"].apiKey).toBe("test-key-2");
    } finally {
      app.unmount();
    }
  });

  test("Esc with a key on file keeps + switches (no typing)", async () => {
    await cleanEnv();
    const { saveAuth, setStoredKey, emptyAuth } = await import("../src/auth.js");
    const home = process.env.ATOM_HOME!;
    saveAuth(setStoredKey(emptyAuth(), "anthropic", "test-key"), home);
    mockRouter();
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      await openProviderPicker(app);
      app.stdin.write("\u001B[B");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "key on file");
      app.stdin.write("\u001B"); // Esc keeps + switches
      await waitForFrame(app, "anthropic/");
    } finally {
      app.unmount();
    }
  });

  test("openai-compatible prompts baseURL (http(s) validated) then key, then switches", async () => {
    const home = await cleanEnv();
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        expect(u).toContain("local.example");
        return { ok: true, json: async () => ({ data: [{ id: "local-model" }] }) } as Response;
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "local-hi" } }] }) } as Response;
    });
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      await openProviderPicker(app);
      // openai-compatible is index 12: eleven downs from zen.
      for (let i = 0; i < 11; i++) app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "baseURL for openai-compatible");
      // Invalid scheme stays with inline error.
      app.stdin.write("ftp://local.example/v1");
      app.stdin.write("\r");
      await waitForFrame(app, "only http/https allowed");
      expect(app.lastFrame()).toContain("opencode-zen/");
      // Esc back to the picker, re-open for a fresh prompt, valid URL first.
      app.stdin.write("\u001B");
      await waitForFrame(app, "Select provider");
      for (let i = 0; i < 11; i++) app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "baseURL for openai-compatible");
      app.stdin.write("http://local.example:11434/v1");
      app.stdin.write("\r");
      await waitForFrame(app, "API key for openai-compatible");
      app.stdin.write("test-key");
      app.stdin.write("\r");
      await waitForFrame(app, "openai-compatible/");
      const raw = await readFile(join(home, ".atom", "auth.json"), "utf8");
      const saved = JSON.parse(raw).providers["openai-compatible"];
      expect(saved.apiKey).toBe("test-key");
      expect(saved.baseURL).toBe("http://local.example:11434/v1");
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "local-hi");
    } finally {
      app.unmount();
    }
  });
});
