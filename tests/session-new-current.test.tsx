// /new save-and-reset, current contracts.
//
// Same flow as the stale "/new saves the live conversation, then resets it"
// case, but pinned to the current system identity (`src/system.ts` now opens
// with the ATOM one-liner, not "You are a coding assistant running inside").
// The behavior under test is unchanged: /new snapshots the live conversation
// for /resume, resets conversation + counters, keeps session settings, and
// the next POST sees only system + the new turn.
// Network is ALWAYS mocked; temp HOME via ATOM_HOME; "test-key" fixtures.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import type { ChatMessage } from "../src/zen.js";
import { SYSTEM_PROMPT } from "../src/system.js";

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
  const home = await mkdtemp(join(tmpdir(), "atom-session-new-current-"));
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

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000
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

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialProvider: "opencode-zen" as const,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

function sessionPath(home: string): string {
  return join(home, ".atom", "session.json");
}

function mockChatQueue(replies: Array<{ message: unknown; usage?: unknown }>) {
  const posts: ChatMessage[][] = [];
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: ChatMessage[];
    };
    posts.push(body.messages ?? []);
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

describe("/new (current contracts)", () => {
  test("/new saves the live conversation, then resets it (settings kept, boundary shown)", async () => {
    const home = await tempHome();
    const posts = mockChatQueue([
      {
        message: { content: "r1" },
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      },
      { message: { content: "r2" } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      // Tab is the only mode switcher.
      app.stdin.write("\t");
      await waitForFrame(app, "mode: yolo");
      app.stdin.write("/autoscroll on");
      app.stdin.write("\r");
      await waitForFrame(app, "autoscroll ");
      app.stdin.write("q1");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: 1K");
      // Wire base: the POSTed system message starts with the src/system.ts
      // one-liner — the current ATOM identity, not the retired wording.
      const firstPost = posts[0] ?? [];
      expect(firstPost[0]?.role).toBe("system");
      const sys = firstPost[0];
      if (sys?.role !== "system") return;
      expect(sys.content.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(sys.content).toContain("You are ATOM");
      app.stdin.write("/new");
      app.stdin.write("\r");
      await waitForFrame(app, "(new session started");
      const frame = app.lastFrame() ?? "";
      // Conversation + counters reset...
      expect(frame).not.toContain("r1");
      expect(frame).not.toContain("q1");
      expect(frame).toContain("token: n/a");
      // ...session settings kept.
      expect(frame).toContain("mode: yolo");
      expect(frame).toContain("big-pickle");
      // The save holds the pre-/new conversation (what /resume restores).
      const saved = await readFile(sessionPath(home), "utf8");
      expect(saved).toContain("q1");
      expect(saved).toContain("r1");
      // Fresh history: the next POST sees only system + the new turn.
      app.stdin.write("q2");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      const last = posts.at(-1) ?? [];
      const texts = last.map((m) => JSON.stringify(m)).join("\n");
      expect(texts).not.toContain("q1");
      expect(texts).not.toContain("r1");
      expect(texts).toContain("q2");
    } finally {
      app.unmount();
    }
  }, 25000);
});
