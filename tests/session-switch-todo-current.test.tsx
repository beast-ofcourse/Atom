// Session-switch todo reset, current contracts (functional, not textual).
//
// Same scenario as the stale "switch resets the todo checklist" case: a turn
// tracks a todo, then the user switches sessions. The stale suite waits for a
// "checklist reset" notice that no longer exists — the current switch posts
// `(switched to session "<title>" — 0 turns)` and resets the checklist
// silently (same as /new). This test pins the functional contract: the store
// is empty and the item is gone from the frame after the switch.
// Network is ALWAYS mocked; temp HOME via ATOM_HOME; "test-key" fixtures.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import { clearTodos, getTodos } from "../src/tools.js";
import { createSession, getActiveSessionId } from "../src/sessions.js";
import type { ChatMessage } from "../src/zen.js";

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
  const home = await mkdtemp(join(tmpdir(), "atom-switch-todo-current-"));
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

async function waitFor(probe: () => void, timeout = 8000): Promise<void> {
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

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialProvider: "opencode-zen" as const,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

function mockChatQueue(replies: Array<{ message: unknown; usage?: unknown }>) {
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: ChatMessage[];
    };
    void body;
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: next.message }],
        ...(next.usage !== undefined ? { usage: next.usage } : {}),
      }),
    } as Response;
  });
}

async function waitForActive(home: string): Promise<void> {
  await waitFor(() => {
    if (!getActiveSessionId(home)) throw new Error("no active session yet");
  });
}

function submit(
  app: { stdin: { write: (s: string) => void } },
  text: string
): void {
  app.stdin.write(text);
  app.stdin.write("\r");
}

describe("session switch resets the todo checklist (current contracts)", () => {
  test("checklist store is empty and the item leaves the frame after switch", async () => {
    const home = await tempHome();
    mockChatQueue([
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: {
                name: "todowrite",
                arguments:
                  '{"todos":[{"content":"Current switch todo ZZZ","status":"in_progress"}]}',
              },
            },
          ],
        },
      },
      { message: { content: "todo-tracked-done" } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/autoscroll on");
      await waitForFrame(app, "autoscroll ");
      const other = createSession({ title: "Todo Other Session" }, home);
      submit(app, "track my work");
      await waitForFrame(app, "Current switch todo ZZZ");
      await waitForFrame(app, "todo-tracked-done");
      await waitFor(() => {
        expect(getTodos().length).toBeGreaterThan(0);
      });
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Todo Other");
      await waitForFrame(app, "Todo Other Session");
      app.stdin.write("\r");
      await waitForFrame(app, 'switched to session "Todo Other Session"');
      expect(getActiveSessionId(home)).toBe(other.id);
      // Functional reset: store empty and item gone (no notice text pinned).
      await waitFor(() => {
        expect(getTodos()).toHaveLength(0);
      });
      expect(app.lastFrame()).not.toContain("Current switch todo ZZZ");
    } finally {
      app.unmount();
    }
  }, 25000);
});
