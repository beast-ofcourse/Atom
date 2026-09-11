// Model memory across restarts (Claude-Code-style): provider/model/effort
// persist via the session save and restore on launch with a FRESH
// conversation (transcript only ever restores via explicit /resume).
// Network is ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import { getProvider } from "../src/providers.js";
import { loadPrefs, sessionFilePath } from "../src/session.js";

// Compiled defaults for a fresh start: Kilo (the default provider) on its
// free routing model — no paid credentials required.
const KILO_DEFAULT_MODEL = getProvider("kilo")!.defaultModel;

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let homes: string[] = [];

async function tempHome(): Promise<string> {
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
  delete process.env.OPENCODE_ZEN_MODEL;
  const home = await mkdtemp(join(tmpdir(), "atom-prefs-"));
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

// GET lists fail (fallback, uncached) but the switch still completes;
// POST turns reply conversationally.
function mockFetchReply(reply: string) {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (method === "GET") {
      return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
    } as Response;
  });
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

const ZEN_MODELS = ["kimi-k2.5", "big-pickle"];

describe("model memory across restarts", () => {
  test("provider/model/effort restore with a fresh conversation", async () => {
    const home = await tempHome();
    await seedKeys(home, ["opencode-zen", "openai"]);
    mockFetchReply("first-reply-xyz");
    const first = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="kimi-k2.5"
        initialModels={ZEN_MODELS}
        restorePrefs
      />
    );
    try {
      // Effort high (supported on kimi-k2.5).
      first.stdin.write("/effort");
      first.stdin.write("\r");
      await waitForFrame(first, "Select reasoning effort");
      for (let i = 0; i < 3; i++) first.stdin.write("[B");
      first.stdin.write("\r");
      await waitForFrame(first, "reasoning: high");
      // Switch to openai via Esc-keeps-existing (stored key, fallback list).
      first.stdin.write("/provider");
      first.stdin.write("\r");
      await waitForFrame(first, "Select provider");
      first.stdin.write("[B"); // +1: kilo leads the picker
      first.stdin.write("[B"); // openai is index 1
      first.stdin.write("\r");
      await waitForFrame(first, "API key for openai");
      first.stdin.write("");
      await waitForFrame(first, "openai/");
      // Complete a turn so the save carries the picks.
      first.stdin.write("first-q");
      first.stdin.write("\r");
      await waitForFrame(first, "first-reply-xyz");
    } finally {
      first.unmount();
    }
    // Remount with no explicit model: prefs restore, conversation does not.
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModels={ZEN_MODELS} restorePrefs />
    );
    try {
      await waitForFrame(app, "openai/");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("gpt-5.6-terra"); // openai fallback default
      expect(frame).toContain("reasoning: high"); // effort restored and valid on every provider
      expect(frame).not.toContain("(unsupported)");
      expect(frame).toContain("token: n/a"); // fresh counters
      expect(frame).toContain("Say hi"); // fresh transcript…
      expect(frame).not.toContain("first-reply-xyz"); // …never auto-restored
      expect(frame).toContain("last session available"); // …but resumable
    } finally {
      app.unmount();
    }
  });

  test("explicit initialModel beats the saved model (provider still restores)", async () => {
    const home = await tempHome();
    await seedKeys(home, ["opencode-zen", "openai"]);
    mockFetchReply("reply-abc");
    const first = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="kimi-k2.5"
        initialModels={ZEN_MODELS}
        restorePrefs
      />
    );
    try {
      first.stdin.write("/provider");
      first.stdin.write("\r");
      await waitForFrame(first, "Select provider");
      first.stdin.write("[B"); // +1: kilo leads the picker
      first.stdin.write("[B");
      first.stdin.write("\r");
      await waitForFrame(first, "API key for openai");
      first.stdin.write("");
      await waitForFrame(first, "openai/");
      first.stdin.write("q");
      first.stdin.write("\r");
      await waitForFrame(first, "reply-abc");
    } finally {
      first.unmount();
    }
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="kimi-k2.5"
        initialModels={ZEN_MODELS}
        restorePrefs
      />
    );
    try {
      await waitForFrame(app, "kimi-k2.5");
      expect(app.lastFrame()).toContain("openai/");
    } finally {
      app.unmount();
    }
  });

  test("saved provider without a key falls back to kilo defaults", async () => {
    const home = await tempHome();
    await seedKeys(home, ["opencode-zen", "openai"]);
    mockFetchReply("reply-def");
    const first = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="kimi-k2.5"
        initialModels={ZEN_MODELS}
        restorePrefs
      />
    );
    try {
      first.stdin.write("/provider");
      first.stdin.write("\r");
      await waitForFrame(first, "Select provider");
      first.stdin.write("[B"); // +1: kilo leads the picker
      first.stdin.write("[B");
      first.stdin.write("\r");
      await waitForFrame(first, "API key for openai");
      first.stdin.write("");
      await waitForFrame(first, "openai/");
      first.stdin.write("q");
      first.stdin.write("\r");
      await waitForFrame(first, "reply-def");
    } finally {
      first.unmount();
    }
    // Revoke all keys: the openai save is unusable, so startup is kilo-fresh.
    const { saveAuth, emptyAuth } = await import("../src/auth.js");
    saveAuth(emptyAuth(), home);
    expect(loadPrefs(home, ENDPOINT)).toBeNull();
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModels={ZEN_MODELS} restorePrefs />
    );
    try {
      await waitForFrame(app, "Say hi");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("kilo/");
      expect(frame).toContain(`${KILO_DEFAULT_MODEL}`);
    } finally {
      app.unmount();
    }
  });

  test("flag off means defaults despite a save (deterministic tests)", async () => {
    const home = await tempHome();
    await seedKeys(home, ["opencode-zen", "openai"]);
    mockFetchReply("reply-ghi");
    const first = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="kimi-k2.5"
        initialModels={ZEN_MODELS}
        restorePrefs
      />
    );
    try {
      first.stdin.write("/provider");
      first.stdin.write("\r");
      await waitForFrame(first, "Select provider");
      first.stdin.write("[B"); // +1: kilo leads the picker
      first.stdin.write("[B");
      first.stdin.write("\r");
      await waitForFrame(first, "API key for openai");
      first.stdin.write("");
      await waitForFrame(first, "openai/");
      first.stdin.write("q");
      first.stdin.write("\r");
      await waitForFrame(first, "reply-ghi");
    } finally {
      first.unmount();
    }
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModels={ZEN_MODELS} />
    );
    try {
      await waitForFrame(app, "Say hi");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("kilo/");
      expect(frame).toContain(`${KILO_DEFAULT_MODEL}`);
    } finally {
      app.unmount();
    }
  });

  test("corrupt save starts fresh", async () => {
    const home = await tempHome();
    await seedKeys(home, ["opencode-zen"]);
    await writeFile(sessionFilePath(home), "{not json", "utf8");
    expect(loadPrefs(home, ENDPOINT)).toBeNull();
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModels={ZEN_MODELS} restorePrefs />
    );
    try {
      await waitForFrame(app, "Say hi");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("kilo/");
      expect(frame).toContain(`${KILO_DEFAULT_MODEL}`);
    } finally {
      app.unmount();
    }
  });
});
