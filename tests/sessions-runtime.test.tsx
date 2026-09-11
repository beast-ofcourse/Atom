// Runtime persistence tests: App auto-creates an active multi-session record
// on mount and persists completed turns into src/sessions.ts store.
// Network is ALWAYS mocked here — never verify against the live API.
// Temp HOME via ATOM_HOME (the existing override); "test-key" fixtures.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import {
  getActiveSession,
  getActiveSessionId,
  getSession,
  listSessions,
} from "../src/sessions.js";
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
  const home = await mkdtemp(join(tmpdir(), "atom-sessions-runtime-"));
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

// Poll a synchronous probe until it stops throwing / returns truthy.
async function waitFor(
  probe: () => void,
  timeout = 8000
): Promise<void> {
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
    // Pinned: persistence flows on the zen path here.
    initialProvider: "opencode-zen" as const,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

function sessionsDir(home: string): string {
  return join(home, ".atom", "sessions");
}

async function sessionJsonFiles(home: string): Promise<string[]> {
  const entries = await readdir(sessionsDir(home));
  return entries.filter((f) => f.endsWith(".json"));
}

// Scripted non-streaming JSON replies (no `body`, single-JSON path).
function mockChatQueue(replies: Array<{ message: unknown; usage?: unknown }>) {
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    JSON.parse(String(init?.body ?? "{}")) as {
      messages?: ChatMessage[];
    };
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

const TITLE_RE = /^\w+ \d{1,2}, \d{4} \d{2}:\d{2}:\d{2}$/;

describe("sessions runtime persistence", () => {
  test("fresh mount auto-creates exactly one active session record", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitFor(async () => {
        expect(await sessionJsonFiles(home)).toHaveLength(1);
      });
      // Besides the single *.json record, only the `active` pointer lives here.
      expect(getActiveSessionId(home)).not.toBeNull();
      const active = getActiveSession(home);
      expect(active).not.toBeNull();
      if (!active) return;
      expect(active.title).toMatch(TITLE_RE);
      expect(Number.isNaN(Date.parse(active.createdAt))).toBe(false);
      expect(await sessionJsonFiles(home)).toHaveLength(1);
    } finally {
      app.unmount();
    }
  }, 25000);

  test("completed turn persists the exchange into the active record", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "persist-reply-1" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/autoscroll on");
      app.stdin.write("\r");
      await waitForFrame(app, "autoscroll ");
      app.stdin.write("persist-q-1");
      app.stdin.write("\r");
      await waitForFrame(app, "persist-reply-1");
      await waitFor(() => {
        const active = getActiveSession(home);
        if (!active) throw new Error("no active session yet");
        const text = JSON.stringify({
          history: active.history,
          turns: active.turns,
        });
        expect(text).toContain("persist-q-1");
        expect(text).toContain("persist-reply-1");
      });
      const active = getActiveSession(home);
      expect(active).not.toBeNull();
      if (!active) return;
      expect(Date.parse(active.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(active.createdAt)
      );
    } finally {
      app.unmount();
    }
  }, 25000);

  test("remount keeps the persisted record loadable; startup stays fresh", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "restart-reply-1" } }]);
    const first = render(<App {...baseProps()} />);
    try {
      first.stdin.write("/autoscroll on");
      first.stdin.write("\r");
      await waitForFrame(first, "autoscroll ");
      first.stdin.write("restart-q-1");
      first.stdin.write("\r");
      await waitForFrame(first, "restart-reply-1");
      await waitFor(() => {
        const text = JSON.stringify(getActiveSession(home));
        expect(text).toContain("restart-q-1");
      });
    } finally {
      first.unmount();
    }
    const second = render(<App {...baseProps()} />);
    try {
      // Startup never auto-restores the transcript into the live view.
      await waitFor(() => {
        expect(second.lastFrame()).not.toContain("restart-reply-1");
      });
      // The prior record is still loadable with its turns intact.
      const sessions = listSessions(home);
      expect(sessions).toHaveLength(1);
      const reloaded = getSession(sessions[0]!.id, home);
      expect(reloaded).not.toBeNull();
      const text = JSON.stringify({
        history: reloaded!.history,
        turns: reloaded!.turns,
      });
      expect(text).toContain("restart-q-1");
      expect(text).toContain("restart-reply-1");
    } finally {
      second.unmount();
    }
  }, 25000);

  test("/new snapshots into a second record and switches the active pointer", async () => {
    const home = await tempHome();
    mockChatQueue([
      { message: { content: "newflow-reply-1" } },
      { message: { content: "newflow-reply-2" } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/autoscroll on");
      app.stdin.write("\r");
      await waitForFrame(app, "autoscroll ");
      app.stdin.write("newflow-q-1");
      app.stdin.write("\r");
      await waitForFrame(app, "newflow-reply-1");
      await waitFor(() => {
        const text = JSON.stringify(getActiveSession(home));
        expect(text).toContain("newflow-q-1");
      });
      const beforeId = getActiveSessionId(home);
      expect(beforeId).not.toBeNull();
      app.stdin.write("/new");
      app.stdin.write("\r");
      await waitForFrame(app, "(new session started");
      await waitFor(() => {
        expect(listSessions(home)).toHaveLength(2);
      });
      const afterId = getActiveSessionId(home);
      expect(afterId).not.toBeNull();
      expect(afterId).not.toBe(beforeId);
      // The old record keeps the first-turn content.
      const old = getSession(beforeId!, home);
      expect(old).not.toBeNull();
      const oldText = JSON.stringify({
        history: old!.history,
        turns: old!.turns,
      });
      expect(oldText).toContain("newflow-q-1");
      expect(oldText).toContain("newflow-reply-1");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("fresh mount without /resume overwrites the same active record (no duplicate, no merge)", async () => {
    const home = await tempHome();
    mockChatQueue([
      { message: { content: "append-reply-1" } },
      { message: { content: "append-reply-2" } },
    ]);
    const first = render(<App {...baseProps()} />);
    try {
      first.stdin.write("/autoscroll on");
      first.stdin.write("\r");
      await waitForFrame(first, "autoscroll ");
      first.stdin.write("append-q-1");
      first.stdin.write("\r");
      await waitForFrame(first, "append-reply-1");
      await waitFor(() => {
        const text = JSON.stringify(getActiveSession(home));
        expect(text).toContain("append-q-1");
      });
    } finally {
      first.unmount();
    }
    const activeBefore = getActiveSessionId(home);
    expect(activeBefore).not.toBeNull();
    const second = render(<App {...baseProps()} />);
    try {
      // The pointer survives the remount: same active record, no duplicate.
      await waitFor(() => {
        expect(getActiveSessionId(home)).toBe(activeBefore);
      });
      second.stdin.write("/autoscroll on");
      second.stdin.write("\r");
      await waitForFrame(second, "autoscroll ");
      second.stdin.write("append-q-2");
      second.stdin.write("\r");
      await waitForFrame(second, "append-reply-2");
      await waitFor(() => {
        const text = JSON.stringify(getActiveSession(home));
        expect(text).toContain("append-q-2");
      });
      // Fresh-start isolation (mirrors legacy session.json semantics: a fresh
      // message without /resume overwrites instead of merging). The pointer
      // survives the remount so the write lands in the SAME record — no
      // duplicate — and old/new turns never mix in one record.
      expect(listSessions(home)).toHaveLength(1);
      const active = getActiveSession(home);
      expect(active).not.toBeNull();
      if (!active) return;
      expect(active.id).toBe(activeBefore);
      const text = JSON.stringify({
        history: active.history,
        turns: active.turns,
      });
      expect(text).toContain("append-q-2");
      expect(text).toContain("append-reply-2");
      expect(text).not.toContain("append-q-1");
      expect(text).not.toContain("append-reply-1");
    } finally {
      second.unmount();
    }
  }, 25000);
});
