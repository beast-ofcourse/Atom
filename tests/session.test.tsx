// Session persistence tests (Phase 4): kill-safe save, /resume, fresh-start.
// Network is ALWAYS mocked here — never verify against the live API.
// Temp HOME via ATOM_HOME (the existing override); "test-key" fixtures.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import {
  SESSION_VERSION,
  loadSession,
  saveSession,
  sessionExists,
  type SessionSnapshot,
} from "../src/session.js";
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
  delete process.env.ATOM_MAX_HISTORY_MESSAGES;
  delete process.env.ATOM_MAX_HISTORY_CHARS;
  const home = await mkdtemp(join(tmpdir(), "atom-session-"));
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
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

function sessionPath(home: string): string {
  return join(home, ".atom", "session.json");
}

// Scripted non-streaming JSON replies (no `body`, single-JSON path).
// `message` is the assistant message; `usage` rides top-level like the API.
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

// OpenAI-shaped pairing invariant: system first, every tool result pairs
// with an assistant tool_call id.
function assertPairingIntact(msgs: ChatMessage[]) {
  expect(msgs[0]?.role).toBe("system");
  const calls = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls !== undefined) {
      expect(m.tool_calls.length).toBeGreaterThan(0);
      for (const c of m.tool_calls) calls.add(c.id);
    }
  }
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.role === "tool") {
      expect(calls.has(m.tool_call_id)).toBe(true);
      seen.add(m.tool_call_id);
    }
  }
  expect(seen).toEqual(calls);
}

describe("session file unit behavior", () => {
  test("missing file loads as missing (never throws)", async () => {
    const home = await tempHome();
    expect(sessionExists(home)).toBe(false);
    expect(loadSession(home)).toEqual({ status: "missing" });
  });

  test("save round-trips exactly (settings+usage+history+turns, tool pairs)", async () => {
    const home = await tempHome();
    const snapshot: SessionSnapshot = {
      provider: "opencode-zen",
      model: "kimi-k2.5",
      effort: "high",
      mode: "yolo",
      usageTotals: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read", arguments: '{"path":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "file!" },
        { role: "assistant", content: "a" },
      ],
      turns: [
        { role: "user", content: "q" },
        { role: "tool", content: "read x" },
        { role: "assistant", content: "a" },
      ],
    };
    saveSession(snapshot, home);
    const raw = await readFile(sessionPath(home), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["version"]).toBe(SESSION_VERSION);
    expect(typeof parsed["savedAt"]).toBe("string");
    const loaded = loadSession(home);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.session.provider).toBe("opencode-zen");
    expect(loaded.session.model).toBe("kimi-k2.5");
    expect(loaded.session.effort).toBe("high");
    expect(loaded.session.mode).toBe("yolo");
    expect(loaded.session.usageTotals).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
    expect(loaded.session.history).toEqual(snapshot.history);
    expect(loaded.session.turns).toEqual(snapshot.turns);
    assertPairingIntact(loaded.session.history);
    // Atomic write: no temp leftovers next to the save.
    const dirFiles = await readdir(join(home, ".atom"));
    expect(dirFiles.filter((f) => f.includes(".tmp."))).toEqual([]);
    // 0600 POSIX perms (best-effort Windows: file just exists).
    if (process.platform !== "win32") {
      expect((await stat(sessionPath(home))).mode & 0o777).toBe(0o600);
    }
  });

  test("malformed saves load as corrupt (never throw)", async () => {
    const home = await tempHome();
    await mkdir(join(home, ".atom"), { recursive: true });
    const bad: unknown[] = [
      "not json{{{",
      JSON.stringify({ version: 999 }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        provider: "nope",
        model: "m",
        effort: "default",
        mode: "normal",
        usageTotals: null,
        history: [{ role: "system", content: "s" }],
        turns: [],
      }),
      JSON.stringify({
        version: 1,
        savedAt: "not-a-date",
        provider: "opencode-zen",
        model: "m",
        effort: "default",
        mode: "normal",
        usageTotals: null,
        history: [{ role: "system", content: "s" }],
        turns: [],
      }),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        provider: "opencode-zen",
        model: "m",
        effort: "default",
        mode: "normal",
        usageTotals: null,
        history: [],
        turns: [],
      }),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        provider: "opencode-zen",
        model: "m",
        effort: "default",
        mode: "normal",
        usageTotals: null,
        history: [{ role: "user", content: "no-system-first" }],
        turns: [],
      }),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        provider: "opencode-zen",
        model: "m",
        effort: "default",
        mode: "normal",
        usageTotals: null,
        history: [{ role: "system", content: "s" }],
        turns: [{ role: "user" }],
      }),
    ];
    for (const body of bad) {
      await writeFile(sessionPath(home), String(body), "utf8");
      expect(sessionExists(home)).toBe(true);
      expect(loadSession(home)).toEqual({ status: "corrupt" });
    }
  });
});

describe("save on completed turn", () => {
  test("completed tool turn persists settings+usage+history+turns round-trip", async () => {
    const home = await tempHome();
    mockChatQueue([
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read", arguments: '{"path":"package.json"}' },
            },
          ],
        },
      },
      {
        message: { content: "done-read" },
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/yolo");
      app.stdin.write("\r");
      await waitForFrame(app, "mode: yolo");
      app.stdin.write("read pkg");
      app.stdin.write("\r");
      await waitForFrame(app, "done-read");
      const raw = await readFile(sessionPath(home), "utf8");
      const loaded = loadSession(home);
      expect(loaded).toEqual({
        status: "ok",
        session: JSON.parse(raw) as unknown,
      });
      if (loaded.status !== "ok") return;
      expect(loaded.session.provider).toBe("opencode-zen");
      expect(loaded.session.model).toBe("big-pickle");
      expect(loaded.session.effort).toBe("default");
      expect(loaded.session.mode).toBe("yolo");
      expect(loaded.session.usageTotals).toEqual({
        prompt_tokens: 5,
        completion_tokens: 6,
        total_tokens: 11,
      });
      assertPairingIntact(loaded.session.history);
      const roles = loaded.session.history.map((m) => m.role);
      expect(roles).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(
        loaded.session.turns.some(
          (t) => t.role === "user" && t.content === "read pkg"
        )
      ).toBe(true);
      expect(
        loaded.session.turns.some(
          (t) => t.role === "assistant" && t.content === "done-read"
        )
      ).toBe(true);
    } finally {
      app.unmount();
    }
  }, 25000);

  test("failed POST never touches the save (last good save intact)", async () => {
    const home = await tempHome();
    mockChatQueue([
      {
        message: { content: "good-reply" },
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("good");
      app.stdin.write("\r");
      await waitForFrame(app, "good-reply");
      const before = await readFile(sessionPath(home), "utf8");
      // Fail fast: 400 never retries, rolls the turn back.
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => "boom",
      })) as unknown as typeof fetch;
      app.stdin.write("bad");
      app.stdin.write("\r");
      await waitForFrame(app, "Zen HTTP 400");
      expect(await readFile(sessionPath(home), "utf8")).toBe(before);
      const loaded = loadSession(home);
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok") return;
      expect(
        loaded.session.turns.some(
          (t) => t.role === "assistant" && t.content === "good-reply"
        )
      ).toBe(true);
    } finally {
      app.unmount();
    }
  }, 25000);
});

describe("/resume", () => {
  test("no save file -> (no saved session) notice", async () => {
    await tempHome();
    mockChatQueue([{ message: { content: "x" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/resume");
      app.stdin.write("\r");
      await waitForFrame(app, "(no saved session)");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("corrupt save -> unreadable notice, fresh session still works", async () => {
    const home = await tempHome();
    await mkdir(join(home, ".atom"), { recursive: true });
    await writeFile(sessionPath(home), "garbage{{{", "utf8");
    mockChatQueue([{ message: { content: "fresh-reply" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/resume");
      app.stdin.write("\r");
      await waitForFrame(app, "(saved session unreadable");
      // Fresh start still works; the completed turn overwrites the corrupt file.
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "fresh-reply");
      const loaded = loadSession(home);
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok") return;
      expect(
        loaded.session.turns.some(
          (t) => t.role === "assistant" && t.content === "fresh-reply"
        )
      ).toBe(true);
    } finally {
      app.unmount();
    }
  }, 25000);

  test("resume restores transcript+settings+usage, next turn works, /model still switches", async () => {
    const home = await tempHome();
    const posts = mockChatQueue([
      {
        message: { content: "first-reply" },
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      },
      { message: { content: "second-reply" } },
    ]);
    const first = render(<App {...baseProps()} />);
    try {
      first.stdin.write("first-q");
      first.stdin.write("\r");
      await waitForFrame(first, "first-reply");
    } finally {
      first.unmount();
    }
    const app = render(<App {...baseProps()} />);
    try {
      // Startup hint (never auto-restores: old reply not yet visible).
      expect(app.lastFrame()).toContain("last session available");
      expect(app.lastFrame()).not.toContain("first-reply");
      app.stdin.write("/resume");
      app.stdin.write("\r");
      await waitForFrame(app, "resumed session from");
      expect(app.lastFrame()).toContain("2 turns");
      expect(app.lastFrame()).toContain("first-q");
      expect(app.lastFrame()).toContain("first-reply");
      // Restored usage totals show in the status line.
      await waitForFrame(app, "token: 1K");
      // History carried over: the next POST still sees the resumed turn.
      app.stdin.write("second-q");
      app.stdin.write("\r");
      await waitForFrame(app, "second-reply");
      const last = posts.at(-1) ?? [];
      const texts = last.map((m) => JSON.stringify(m)).join("\n");
      expect(texts).toContain("first-q");
      expect(texts).toContain("first-reply");
      expect(texts).toContain("second-q");
      assertPairingIntact(last);
      // Switching model after resume works normally.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B[B"); // down arrow -> kimi-k2.5
      app.stdin.write("\r");
      await waitForFrame(app, "model: kimi-k2.5");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("oversized restore runs truncation (budget holds, pairing intact)", async () => {
    const home = await tempHome();
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    const turns: SessionSnapshot["turns"] = [];
    for (let i = 0; i < 12; i++) {
      history.push(
        { role: "user", content: `q${i}` },
        { role: "assistant", content: `a${i}` }
      );
      turns.push(
        { role: "user", content: `q${i}` },
        { role: "assistant", content: `a${i}` }
      );
    }
    saveSession(
      {
        provider: "opencode-zen",
        model: "big-pickle",
        effort: "default",
        mode: "normal",
        usageTotals: null,
        history,
        turns,
      },
      home
    );
    process.env.ATOM_MAX_HISTORY_MESSAGES = "10";
    const posts = mockChatQueue([{ message: { content: "after-resume" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/resume");
      app.stdin.write("\r");
      await waitForFrame(app, "history truncated");
      app.stdin.write("next-q");
      app.stdin.write("\r");
      await waitForFrame(app, "after-resume");
      const last = posts.at(-1) ?? [];
      expect(last.length).toBeLessThanOrEqual(10);
      assertPairingIntact(last);
      // Latest resumed turn survived; oldest was dropped from history.
      expect(JSON.stringify(last)).toContain("a11");
    } finally {
      app.unmount();
    }
  }, 25000);
});

describe("startup hint + fresh-start + /clear", () => {
  test("hint shown iff a save exists (never auto-restores)", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "x" } }]);
    const empty = render(<App {...baseProps()} />);
    try {
      expect(empty.lastFrame()).not.toContain("last session available");
    } finally {
      empty.unmount();
    }
    saveSession(
      {
        provider: "opencode-zen",
        model: "big-pickle",
        effort: "default",
        mode: "normal",
        usageTotals: null,
        history: [
          { role: "system", content: "sys" },
          { role: "user", content: "old-q" },
          { role: "assistant", content: "old-reply" },
        ],
        turns: [
          { role: "user", content: "old-q" },
          { role: "assistant", content: "old-reply" },
        ],
      },
      home
    );
    const withSave = render(<App {...baseProps()} />);
    try {
      expect(withSave.lastFrame()).toContain(
        "(last session available — /resume to restore)"
      );
      // Hint only: the old transcript is NOT in the live session.
      expect(withSave.lastFrame()).not.toContain("old-reply");
    } finally {
      withSave.unmount();
    }
  });

  test("fresh message without resume overwrites the save", async () => {
    const home = await tempHome();
    saveSession(
      {
        provider: "opencode-zen",
        model: "big-pickle",
        effort: "default",
        mode: "normal",
        usageTotals: null,
        history: [
          { role: "system", content: "sys" },
          { role: "user", content: "old-q" },
          { role: "assistant", content: "old-reply" },
        ],
        turns: [
          { role: "user", content: "old-q" },
          { role: "assistant", content: "old-reply" },
        ],
      },
      home
    );
    mockChatQueue([{ message: { content: "new-reply" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("new-q");
      app.stdin.write("\r");
      await waitForFrame(app, "new-reply");
      expect(app.lastFrame()).not.toContain("old-reply");
      const loaded = loadSession(home);
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok") return;
      const text = JSON.stringify(loaded.session);
      expect(text).toContain("new-q");
      expect(text).toContain("new-reply");
      expect(text).not.toContain("old-q");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("/clear keeps the save until the next completed turn overwrites it", async () => {
    const home = await tempHome();
    mockChatQueue([
      { message: { content: "r1" } },
      { message: { content: "r2" } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("q1");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      const savedBeforeClear = await readFile(sessionPath(home), "utf8");
      expect(savedBeforeClear).toContain("r1");
      app.stdin.write("/clear");
      app.stdin.write("\r");
      await waitForFrame(app, "Say hi");
      // /clear clears the live session only — the file is untouched.
      expect(await readFile(sessionPath(home), "utf8")).toBe(savedBeforeClear);
      app.stdin.write("q2");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      const savedAfter = await readFile(sessionPath(home), "utf8");
      expect(savedAfter).toContain("r2");
      expect(savedAfter).not.toContain("r1");
    } finally {
      app.unmount();
    }
  }, 25000);
});

describe("/new", () => {
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
      app.stdin.write("/yolo");
      app.stdin.write("\r");
      await waitForFrame(app, "mode: yolo");
      app.stdin.write("q1");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: 1K");
      // Wire base: the POSTed system message starts with the src/system.ts
      // one-liner, with the repo AGENTS.md overlay still appended.
      const firstPost = posts[0] ?? [];
      expect(firstPost[0]?.role).toBe("system");
      const sys = firstPost[0];
      if (sys?.role !== "system") return;
      expect(sys.content.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(sys.content).toContain("You are a coding assistant running inside");
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
      expect(frame).toContain("model: big-pickle");
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

  test("/resume right after /new restores the pre-new conversation", async () => {
    await tempHome();
    mockChatQueue([
      {
        message: { content: "r1" },
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("q1");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: 1K");
      app.stdin.write("/new");
      app.stdin.write("\r");
      await waitForFrame(app, "(new session started");
      expect(app.lastFrame()).toContain("token: n/a");
      app.stdin.write("/resume");
      app.stdin.write("\r");
      await waitForFrame(app, "resumed session from");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("q1");
      expect(frame).toContain("r1");
      await waitForFrame(app, "token: 1K");
    } finally {
      app.unmount();
    }
  }, 25000);
});
