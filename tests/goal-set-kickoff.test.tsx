// Phase 1 loop for: `/goal build me X` shows the set notice but starts no
// work (zero model POSTs). Red-capable: asserts the user's exact symptom —
// a turn must kick off when a goal is set. Hermetic: mocked fetch, temp
// HOME, never touches real ~/.atom or live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import { clearTodos } from "../src/tools.js";
import { getActiveSessionId } from "../src/sessions.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS = ["big-pickle", "kimi-k2.5"];
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
  clearTodos();
  const home = await mkdtemp(join(tmpdir(), "atom-goal-set-kickoff-"));
  homes.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  clearTodos();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 12000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitFor(probe: () => void, timeout = 12000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      probe();
      return;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function mockChatQueue(replies: Array<{ message: unknown; usage?: unknown }>) {
  const posts: unknown[] = [];
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body ?? "{}")));
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: next.message }],
        ...(next.usage !== undefined ? { usage: next.usage } : {}),
      }),
    } as Response;
  });
  return posts;
}

describe("/goal set kicks off work (TUI)", () => {
  test("`/goal build me X` starts a turn: at least one model POST fires", async () => {
    const home = await tempHome();
    const posts = mockChatQueue([
      { message: { content: "working-on-it-qqq" } },
      { message: { content: "judge prose, no verdict" } },
    ]);
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialProvider="opencode-zen"
        initialModel="big-pickle"
        initialModels={MODELS}
      />
    );
    try {
      await waitFor(() => {
        if (!getActiveSessionId(home)) throw new Error("no active session yet");
      });
      app.stdin.write("/goal build-me-qqq");
      app.stdin.write("\r");
      await waitForFrame(app, "build-me-qqq");
      // THE SYMPTOM: the notice shows but no turn starts — zero POSTs.
      // Fixed behavior: setting a goal kicks a turn like /goal resume does.
      await waitFor(() => {
        expect(posts.length).toBeGreaterThanOrEqual(1);
      });
      await waitForFrame(app, "working-on-it-qqq");
    } finally {
      app.unmount();
    }
  }, 30000);
});
