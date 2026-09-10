// Focused /rename coverage: App-level via TUI where behavior lives,
// store-level where asserted. Network is ALWAYS mocked — never verify
// against the live API. Temp HOME via ATOM_HOME; "test-key" fixtures.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, RENAME_USAGE, parseRenameArg } from "../src/App.js";
import { getActiveSession, getActiveSessionId } from "../src/sessions.js";
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
  delete process.env.ATOM_MAX_HISTORY_MESSAGES;
  delete process.env.ATOM_MAX_HISTORY_CHARS;
  const home = await mkdtemp(join(tmpdir(), "atom-rename-"));
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
    // Pinned: rename flows on the zen path here.
    initialProvider: "opencode-zen" as const,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
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

async function waitForActive(home: string): Promise<void> {
  await waitFor(() => {
    const active = getActiveSession(home);
    if (!active) throw new Error("no active session yet");
  });
}

function submit(app: { stdin: { write: (s: string) => void } }, text: string): void {
  app.stdin.write(text);
  app.stdin.write("\r");
}

describe("rename", () => {
  test("renames the current session and surfaces the new title", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/rename Build authentication");
      await waitForFrame(app, 'renamed session to "Build authentication"');
      await waitFor(() => {
        expect(getActiveSession(home)?.title).toBe("Build authentication");
      });
      // Identity surfaces carry the new title: the rename confirmation
      // above plus the /session picker row (the status bar stays title-free
      // by design — fixed width budget).
      expect(app.lastFrame()).toContain("Build authentication");
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      expect(app.lastFrame()).toContain("Build authentication");
      // Close the picker before unmount (cleaner tail).
      await new Promise((r) => setTimeout(r, 60));
      app.stdin.write(String.fromCharCode(27));
    } finally {
      app.unmount();
    }
  }, 25000);

  test("renames with unquoted multi-word and quoted names", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/rename Build authentication flow");
      await waitForFrame(app, 'renamed session to "Build authentication flow"');
      expect(getActiveSession(home)?.title).toBe("Build authentication flow");
      submit(app, '/rename "name with spaces"');
      await waitForFrame(app, 'renamed session to "name with spaces"');
      expect(getActiveSession(home)?.title).toBe("name with spaces");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("empty rename shows usage and preserves the previous name", async () => {
    // Pure parser: every empty/whitespace/quoted-empty shape yields "".
    for (const raw of ["", "/rename", "/rename   ", '/rename ""', "/rename ''"]) {
      expect(parseRenameArg(raw)).toBe("");
    }
    expect(RENAME_USAGE).toContain("usage: /rename");

    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      const before = getActiveSession(home)?.title;
      expect(before).toBeTruthy();
      submit(app, "/rename");
      await waitForFrame(app, "usage: /rename");
      expect(getActiveSession(home)?.title).toBe(before);
      submit(app, "/rename   ");
      await waitForFrame(app, "usage: /rename");
      // Failed rename keeps the previous name in the store and in the
      // picker (the empty-state session line hides once turns exist, so
      // verify through the identity surface that always lists titles).
      expect(getActiveSession(home)?.title).toBe(before);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      expect(app.lastFrame()).toContain(before!);
    } finally {
      app.unmount();
    }
  }, 25000);

  test("renamed title persists across restart and syncs to the fresh mount", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const first = render(<App {...baseProps()} />);
    let id: string | null = null;
    try {
      await waitForActive(home);
      id = getActiveSessionId(home);
      submit(first, "/rename Persistent Name");
      await waitForFrame(first, 'renamed session to "Persistent Name"');
      await waitFor(() => {
        expect(getActiveSession(home)?.title).toBe("Persistent Name");
      });
    } finally {
      first.unmount();
    }
    const second = render(<App {...baseProps()} />);
    try {
      // Same record survives; the mount effect syncs the display state.
      await waitFor(() => {
        expect(getActiveSessionId(home)).toBe(id);
        expect(getActiveSession(home)?.title).toBe("Persistent Name");
      });
      await waitForFrame(second, "Persistent Name");
    } finally {
      second.unmount();
    }
  }, 25000);

  test("rename preserves the session id", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      const beforeId = getActiveSessionId(home);
      const beforeRecordId = getActiveSession(home)?.id;
      expect(beforeId).not.toBeNull();
      submit(app, "/rename Same Session New Name");
      await waitForFrame(app, 'renamed session to "Same Session New Name"');
      await waitFor(() => {
        expect(getActiveSessionId(home)).toBe(beforeId);
        expect(getActiveSession(home)?.id).toBe(beforeRecordId);
      });
    } finally {
      app.unmount();
    }
  }, 25000);

  test("rename preserves createdAt", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      const beforeCreated = getActiveSession(home)?.createdAt;
      expect(beforeCreated).toBeTruthy();
      submit(app, "/rename Keep Created Stamp");
      await waitForFrame(app, 'renamed session to "Keep Created Stamp"');
      await waitFor(() => {
        expect(getActiveSession(home)?.createdAt).toBe(beforeCreated);
      });
    } finally {
      app.unmount();
    }
  }, 25000);

  test("rename bumps updatedAt past the pre-rename value", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      const before = getActiveSession(home)?.updatedAt;
      expect(before).toBeTruthy();
      const beforeMs = Date.parse(before!);
      expect(Number.isNaN(beforeMs)).toBe(false);
      // ISO timestamps resolve to the millisecond — spin until the local
      // clock ticks past the pre-rename stamp so strict > never flakes.
      while (Date.now() <= beforeMs) {
        await new Promise((r) => setTimeout(r, 1));
      }
      submit(app, "/rename Bump Updated Stamp");
      await waitForFrame(app, 'renamed session to "Bump Updated Stamp"');
      await waitFor(() => {
        const after = getActiveSession(home)?.updatedAt;
        expect(Date.parse(after!)).toBeGreaterThan(beforeMs);
      });
    } finally {
      app.unmount();
    }
  }, 25000);

  test("rename leaves history and turns byte-identical after a completed turn", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "rename-turn-reply" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/autoscroll on");
      await waitForFrame(app, "autoscroll ");
      submit(app, "rename-turn-q");
      await waitForFrame(app, "rename-turn-reply");
      let snapshot = "";
      await waitFor(() => {
        const active = getActiveSession(home);
        if (!active) throw new Error("no active session yet");
        const text = JSON.stringify({
          history: active.history,
          turns: active.turns,
        });
        expect(text).toContain("rename-turn-q");
        expect(text).toContain("rename-turn-reply");
        snapshot = text;
      });
      submit(app, "/rename History Intact");
      await waitForFrame(app, 'renamed session to "History Intact"');
      await waitFor(() => {
        const active = getActiveSession(home);
        expect(
          JSON.stringify({ history: active!.history, turns: active!.turns })
        ).toBe(snapshot);
      });
    } finally {
      app.unmount();
    }
  }, 25000);
});
