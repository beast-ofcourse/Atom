// Core-path transcript regression: real runs (no `initialModels`) take the
// AgentCore path in submit(). Two visual bugs lived there:
//   1. stuck `◐ Thinking… · Ns` + `thinking…` status after the answer was done
//      (the early return skipped the turn-boundary drain — fixed in App.tsx).
//   2. vanishing user messages (the echo commit + adapter seeding skipped —
//      fixed in App.tsx).
// This file drives the real App through a mocked provider and asserts the
// echo survives and the busy UI fully clears after a core turn.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import { AgentCore } from "../src/agent/core.js";
import type { AgentEvent } from "../src/agent/events.js";

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
  const home = await mkdtemp(join(tmpdir(), "atom-core-txn-"));
  homes.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

async function seedKeys(home: string) {
  const { saveAuth, setStoredKey, emptyAuth } = await import("../src/auth.js");
  let auth = emptyAuth();
  auth = setStoredKey(auth, "opencode-zen", "test-key");
  saveAuth(auth, home);
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

// Serves both the mount model-list GET and the chat POSTs with one mock.
function mockCoreProvider(reply: string) {
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (method === "GET") {
      return {
        ok: true,
        json: async () => ({ data: [{ id: "big-pickle", family: "chat" }] }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
    } as Response;
  }) as unknown as typeof fetch;
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 15000
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("core-path transcript", () => {
  test("ask_question resolves through the TUI hook and tools commit full labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atom-core-hooks-"));
    homes.push(dir);
    await writeFile(join(dir, "main.ts"), "export const main = 1;\n", "utf8");
    const posts: unknown[] = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "t1",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: "main.ts", offset: 1, limit: 5 }) },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "t2",
                  type: "function",
                  function: {
                    name: "ask_question",
                    arguments: JSON.stringify({ question: "Which check?", options: ["quick echo", "full suite"] }),
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "done" } }] },
    ];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => posts.shift() ?? { choices: [{ message: { content: "done" } }] },
    })) as unknown as typeof fetch;
    let asked = "";
    const seen: AgentEvent[] = [];
    const agent = new AgentCore({
      provider: "opencode-zen",
      model: "big-pickle",
      effort: "auto",
      mode: "normal",
      apiKey: "test-key",
      baseURL: ENDPOINT,
      cwd: dir,
      history: [{ role: "system", content: "s" }],
      getHooks: () => ({
        askUser: async (question) => {
          asked = question;
          return "full suite";
        },
      }),
    });
    agent.onEvent((e) => seen.push(e));
    const result = await agent.send("run the check");
    // The question reached the hook (no "has no UI hook" error path).
    expect(asked).toBe("Which check?");
    // The read committed its full label (window included) exactly once.
    const completed = seen.filter((e) => e.type === "tool.completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ name: "read", label: "⚙ read main.ts [offset=1, limit=5]" });
    expect(completed[1]).toMatchObject({ name: "ask_question" });
    expect(result).toContain("done");
  });
  test("user echo survives and busy UI clears after a core turn", async () => {
    const home = await cleanEnv();
    await seedKeys(home);
    mockCoreProvider("core reply here");
    // No initialModels: normal chat takes the AgentCore path.
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" />
    );
    try {
      app.stdin.write("hello core");
      app.stdin.write("\r");
      // The answer lands via agent.completed → adapter → transcript.
      await waitForFrame(app, "core reply here");
      // The user's own message is still in the transcript (it used to vanish
      // — the core path never committed the echo).
      expect(app.lastFrame()).toContain("hello core");
      // Past a full 1s busy tick: no stuck Thinking gap line, and the status
      // bar is back to its idle shape (turn teardown ran on the core path).
      await sleep(1600);
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("hello core");
      expect(frame).toContain("core reply here");
      expect(frame).not.toContain("Thinking");
      expect(frame).toContain("mode: normal");
    } finally {
      app.unmount();
    }
  });
  test("core commits survive a /clear replacement (no adopt deadlock)", async () => {
    const home = await cleanEnv();
    await seedKeys(home);
    const replies = ["first core reply", "second core reply after clear"];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "big-pickle", family: "chat" }] }),
        } as Response;
      }
      const reply = replies.shift() ?? "second core reply after clear";
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: reply } }] }),
      } as Response;
    }) as unknown as typeof fetch;
    // No initialModels: normal chat takes the AgentCore path.
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" />
    );
    try {
      app.stdin.write("first question");
      app.stdin.write("\r");
      await waitForFrame(app, "first core reply");
      // Wholesale transcript replacement: /clear used to strand the
      // adapter's forward-only adopt guard, so every later core commit was
      // dropped — the streamed preview "vanished" at commit time.
      app.stdin.write("/clear");
      app.stdin.write("\r");
      await waitForFrame(app, "discarded", 5000).catch(() => {});
      app.stdin.write("second question");
      app.stdin.write("\r");
      await waitForFrame(app, "second core reply after clear");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("second question");
      expect(frame).toContain("second core reply after clear");
    } finally {
      app.unmount();
    }
  });
});
