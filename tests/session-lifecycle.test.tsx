// End-to-end session lifecycle: create → turn → rename → new → switch →
// continue → restart, plus isolation, todo reset on switch, and duplicate-id
// safety. Network is ALWAYS mocked — never verify against the live API.
// Temp HOME via ATOM_HOME; "test-key" fixtures; real ~/.atom never touched.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import { clearTodos, getTodos } from "../src/tools.js";
import {
  createSession,
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
  clearTodos();
  const home = await mkdtemp(join(tmpdir(), "atom-session-lifecycle-"));
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
    // Pinned: lifecycle flows on the zen path here.
    initialProvider: "opencode-zen" as const,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

// Scripted non-streaming JSON replies (no `body`, single-JSON path) that also
// capture every POSTed body so tests can assert history on the wire.
function mockChatQueue(replies: Array<{ message: unknown; usage?: unknown }>) {
  const posts: Array<{ messages?: unknown }> = [];
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: ChatMessage[];
    };
    posts.push({ messages: body.messages });
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

function recordText(id: string, home: string): string {
  const record = getSession(id, home);
  if (!record) throw new Error(`no session record for ${id}`);
  return JSON.stringify({ history: record.history, turns: record.turns });
}

const TITLE_RE = /^\w+ \d{1,2}, \d{4} \d{2}:\d{2}:\d{2}$/;

describe("session lifecycle", () => {
  test("full lifecycle: create → turn → rename → new → switch → restart", async () => {
    const home = await tempHome();
    const posts = mockChatQueue([
      { message: { content: "lifecycle-r1-bbb" } },
      { message: { content: "lifecycle-r2-ddd" } },
      { message: { content: "lifecycle-r3-fff" } },
    ]);
    const app = render(<App {...baseProps()} />);
    let firstId = "";
    try {
      await waitForActive(home);
      submit(app, "/autoscroll on");
      await waitForFrame(app, "autoscroll ");
      // One session auto-created with a date title and valid ISO createdAt.
      const created = getActiveSession(home);
      expect(created).not.toBeNull();
      firstId = created!.id;
      expect(created!.title).toMatch(TITLE_RE);
      expect(Number.isNaN(Date.parse(created!.createdAt))).toBe(false);
      const firstCreatedAt = created!.createdAt;

      // One turn lands in the record; updatedAt never predates createdAt.
      submit(app, "lifecycle-q1-aaa");
      await waitForFrame(app, "lifecycle-r1-bbb");
      await waitFor(() => {
        const text = recordText(firstId, home);
        expect(text).toContain("lifecycle-q1-aaa");
        expect(text).toContain("lifecycle-r1-bbb");
      });
      const afterTurn = getActiveSession(home)!;
      expect(Date.parse(afterTurn.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(afterTurn.createdAt)
      );
      const snapshot = recordText(firstId, home);

      // Rename: title changes, id + createdAt + history byte-identical.
      submit(app, "/rename Build authentication");
      await waitForFrame(app, 'renamed session to "Build authentication"');
      await waitFor(() => {
        expect(getActiveSession(home)?.title).toBe("Build authentication");
      });
      const renamed = getActiveSession(home)!;
      expect(renamed.id).toBe(firstId);
      expect(renamed.createdAt).toBe(firstCreatedAt);
      expect(recordText(firstId, home)).toBe(snapshot);

      // /new snapshots into a second record; the old one keeps q1/r1.
      submit(app, "/new");
      await waitForFrame(app, "(new session started");
      await waitFor(() => {
        expect(listSessions(home)).toHaveLength(2);
      });
      const secondId = getActiveSessionId(home)!;
      expect(secondId).not.toBe(firstId);
      expect(recordText(firstId, home)).toContain("lifecycle-q1-aaa");
      expect(recordText(firstId, home)).toContain("lifecycle-r1-bbb");

      // One turn in the new session, then switch back via the picker.
      submit(app, "lifecycle-q2-ccc");
      await waitForFrame(app, "lifecycle-r2-ddd");
      await waitFor(() => {
        expect(recordText(secondId, home)).toContain("lifecycle-q2-ccc");
      });
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Build");
      await waitForFrame(app, "Build authentication");
      app.stdin.write("\r");
      await waitForFrame(app, 'switched to session "Build authentication"');
      await waitFor(() => {
        expect(getActiveSessionId(home)).toBe(firstId);
        const frame = app.lastFrame() ?? "";
        expect(frame).toContain("lifecycle-q1-aaa");
        expect(frame).toContain("lifecycle-r1-bbb");
        expect(frame).not.toContain("lifecycle-q2-ccc");
      });
      // Status bar carries the renamed title after the switch.
      expect(app.lastFrame()).toContain("Build authentication");

      // The agent continues inside the switched session: the POSTed messages
      // carry the restored history (q1/r1) plus the new turn (q3).
      submit(app, "lifecycle-q3-eee");
      await waitForFrame(app, "lifecycle-r3-fff");
      expect(posts.length).toBeGreaterThanOrEqual(3);
      const wire = JSON.stringify(posts.at(-1)!.messages);
      expect(wire).toContain("lifecycle-q1-aaa");
      expect(wire).toContain("lifecycle-r1-bbb");
      expect(wire).toContain("lifecycle-q3-eee");
      await waitFor(() => {
        const text = recordText(firstId, home);
        expect(text).toContain("lifecycle-q3-eee");
        expect(text).toContain("lifecycle-r3-fff");
      });
    } finally {
      app.unmount();
    }

    // Restart: same home, fresh mount — both records survive, first intact.
    const restarted = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      expect(listSessions(home)).toHaveLength(2);
      const reloaded = getSession(firstId, home);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.title).toBe("Build authentication");
      const text = JSON.stringify({
        history: reloaded!.history,
        turns: reloaded!.turns,
      });
      expect(text).toContain("lifecycle-q1-aaa");
      expect(text).toContain("lifecycle-r1-bbb");
      expect(text).toContain("lifecycle-r3-fff");
    } finally {
      restarted.unmount();
    }
  }, 25000);

  test("isolation: turns never leak across records", async () => {
    const home = await tempHome();
    mockChatQueue([
      { message: { content: "isolate-rA-111" } },
      { message: { content: "isolate-rB-222" } },
      { message: { content: "isolate-rB2-333" } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/autoscroll on");
      await waitForFrame(app, "autoscroll ");
      const aId = getActiveSessionId(home)!;
      // Stable name on A first so the picker filter can find it later (both
      // auto titles are timestamps and not filterable).
      submit(app, "/rename Isolate Alpha Home");
      await waitForFrame(app, 'renamed session to "Isolate Alpha Home"');
      submit(app, "isolate-qA-111");
      await waitForFrame(app, "isolate-rA-111");
      await waitFor(() => {
        expect(recordText(aId, home)).toContain("isolate-qA-111");
      });
      submit(app, "/new");
      await waitForFrame(app, "(new session started");
      await waitFor(() => {
        expect(listSessions(home)).toHaveLength(2);
      });
      const bId = getActiveSessionId(home)!;
      expect(bId).not.toBe(aId);
      submit(app, "isolate-qB-222");
      await waitForFrame(app, "isolate-rB-222");
      await waitFor(() => {
        expect(recordText(bId, home)).toContain("isolate-qB-222");
      });
      // Another turn in B must not leak a byte into record A.
      submit(app, "isolate-qB2-333");
      await waitForFrame(app, "isolate-rB2-333");
      await waitFor(() => {
        expect(recordText(bId, home)).toContain("isolate-qB2-333");
      });
      expect(recordText(aId, home)).not.toContain("isolate-qB-222");
      expect(recordText(aId, home)).not.toContain("isolate-rB-222");
      expect(recordText(aId, home)).not.toContain("isolate-qB2-333");
      expect(recordText(aId, home)).not.toContain("isolate-rB2-333");
      // Switch to A: the frame shows A text, never B text.
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Isolate Alpha");
      await waitForFrame(app, "Isolate Alpha Home");
      app.stdin.write("\r");
      await waitForFrame(app, 'switched to session "Isolate Alpha Home"');
      await waitFor(() => {
        expect(getActiveSessionId(home)).toBe(aId);
        const frame = app.lastFrame() ?? "";
        expect(frame).toContain("isolate-qA-111");
        expect(frame).toContain("isolate-rA-111");
        expect(frame).not.toContain("isolate-qB-222");
        expect(frame).not.toContain("isolate-rB-222");
        expect(frame).not.toContain("isolate-qB2-333");
        expect(frame).not.toContain("isolate-rB2-333");
      });
    } finally {
      app.unmount();
    }
  }, 25000);

  test("switch resets the todo checklist", async () => {
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
                  '{"todos":[{"content":"Lifecycle todo item ZZZ","status":"in_progress"}]}',
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
      await waitForFrame(app, "Lifecycle todo item ZZZ");
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
      // Functional reset: store empty and item gone (no notice text pinned — see session-switch-todo-current.test.tsx).
      await waitFor(() => {
        expect(getTodos()).toHaveLength(0);
      });
      expect(app.lastFrame()).not.toContain("Lifecycle todo item ZZZ");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("duplicate ids never overwrite", async () => {
    const home = await tempHome();
    const first = createSession({ id: "ses_dup", title: "First Title" }, home);
    expect(first.id).toBe("ses_dup");
    const second = createSession({ id: "ses_dup", title: "Second Title" }, home);
    expect(second.id).not.toBe("ses_dup");
    expect(getSession("ses_dup", home)?.title).toBe("First Title");
    expect(listSessions(home)).toHaveLength(2);
  });
});
