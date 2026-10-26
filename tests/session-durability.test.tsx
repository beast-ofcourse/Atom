// Session durability: every session must reach disk — including the ones
// that end abnormally. Regression coverage for the three storage windows
// that used to lose data:
// 1. submit-time persist — a cancelled/failed/killed FIRST turn left no
//    record content at all (the early ensure created an empty shell);
// 2. core-path completed-turn persist — the production chat path never
//    persisted completed turns (only /exit and idle Ctrl+C did, and with a
//    stale historyRef, since core owns the authoritative history);
// 3. the process-level exit net — crash/kill/window-close now fire a final
//    save (src/exit-save.ts).
// Network is ALWAYS mocked; ATOM_HOME is hermetic per test.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import {
  getActiveSessionId,
  getSession,
  listSessions,
} from "../src/sessions.js";
import {
  installProcessSessionSave,
  registerSessionExitSaver,
  saveSessionOnExit,
} from "../src/exit-save.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let homes: string[] = [];

async function tempHome(prefix: string): Promise<string> {
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
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  // Never leak a saver into the next test (or the vitest process exit).
  registerSessionExitSaver(null);
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

// App props WITHOUT initialModels: the core path is the production chat
// path, so these tests exercise it (initialModels opts into legacy).
function coreProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialProvider: "opencode-zen" as const,
    initialModel: "big-pickle",
  };
}

// Single non-streaming JSON chat reply; any other URL (model list) gets the
// catalog shape.
function mockChatReply(message: string): void {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (String(url).includes("chat/completions")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: message } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ data: [{ id: "big-pickle" }] }) } as Response;
  }) as unknown as typeof fetch;
}

// A chat POST that never resolves: the turn hangs exactly like a killed
// process viewed from the disk's perspective.
function mockHangingChat(): void {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (String(url).includes("chat/completions")) {
      return new Promise<Response>(() => {});
    }
    return { ok: true, json: async () => ({ data: [{ id: "big-pickle" }] }) } as Response;
  }) as unknown as typeof fetch;
}

// Poll the disk (not frames): persistence is fs, so assert on fs.
async function pollFor<T>(probe: () => T | null, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = probe();
    if (hit !== null) return hit;
    if (Date.now() > deadline) throw new Error("pollFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function activeRecord(home: string): ReturnType<typeof getSession> {
  const id = getActiveSessionId(home);
  if (id === null) return null;
  return getSession(id, home);
}

describe("session durability", () => {
  test("cancelled/killed FIRST turn still stores the user message (submit-time persist)", async () => {
    const home = await tempHome("atom-durability-hang-");
    mockHangingChat();
    const app = render(<App {...coreProps()} />);
    try {
      app.stdin.write("show me the plan");
      app.stdin.write("\r");
      // The snapshot must hit disk while the POST is still hanging — this
      // is exactly the crash/kill window the old cadence lost.
      const record = await pollFor(() => {
        const r = activeRecord(home);
        if (r === null) return null;
        return r.turns.some((t) => t.role === "user" && t.content === "show me the plan") ? r : null;
      });
      expect(record.history.some((m) => m.role === "user" && m.content === "show me the plan")).toBe(true);
      // The exit net mid-turn: busy, so the saver must SKIP (no dangling
      // tool_calls snapshot) and leave the valid pre-turn state on disk.
      saveSessionOnExit();
      const after = activeRecord(home);
      expect(after?.turns.some((t) => t.role === "user" && t.content === "show me the plan")).toBe(true);
    } finally {
      app.unmount();
    }
  });

  test("core-path completed turn persists history AND transcript (previously only /exit did)", async () => {
    const home = await tempHome("atom-durability-core-");
    mockChatReply("final answer text");
    const app = render(<App {...coreProps()} />);
    try {
      app.stdin.write("hello core");
      app.stdin.write("\r");
      const record = await pollFor(() => {
        const r = activeRecord(home);
        if (r === null) return null;
        return r.turns.some((t) => t.role === "assistant" && t.content === "final answer text") ? r : null;
      });
      // The authoritative core history (system + user + assistant) must be
      // on disk — the old bug persisted a stale historyRef (system only).
      expect(record.history[0]?.role).toBe("system");
      expect(record.history.some((m) => m.role === "user" && m.content === "hello core")).toBe(true);
      expect(
        record.history.some((m) => m.role === "assistant" && m.content === "final answer text"),
      ).toBe(true);
      // Transcript parity.
      expect(record.turns.some((t) => t.role === "user" && t.content === "hello core")).toBe(true);
    } finally {
      app.unmount();
    }
  });

  test("exit net: the registered saver persists after unmount (crash simulation)", async () => {
    const home = await tempHome("atom-durability-net-");
    mockChatReply("saved by the net");
    const app = render(<App {...coreProps()} />);
    try {
      app.stdin.write("net check");
      app.stdin.write("\r");
      await pollFor(() => {
        const r = activeRecord(home);
        return r !== null && r.turns.some((t) => t.content === "saved by the net") ? r : null;
      });
    } finally {
      app.unmount();
    }
    // Simulate the crash-path save AFTER unmount: the saver stays
    // registered (no unmount unregister — see exit-save.ts), so the final
    // `exit`-event save still reaches disk.
    saveSessionOnExit();
    const record = await pollFor(() => {
      const sessions = listSessions(home);
      return sessions.length > 0 ? sessions[0]! : null;
    });
    expect(record.turns.some((t) => t.content === "saved by the net")).toBe(true);
  });
});

describe("exit-save module", () => {
  test("saver runs, latches double-fires, errors never throw, null clears", async () => {
    // The latch is module-global with real time; earlier tests in this file
    // saved, so expire any armed window before asserting the first call.
    await new Promise((r) => setTimeout(r, 55));
    let calls = 0;
    let boom = false;
    registerSessionExitSaver(() => {
      calls += 1;
      if (boom) throw new Error("disk on fire");
    });
    saveSessionOnExit();
    expect(calls).toBe(1);
    saveSessionOnExit(); // inside the latch window: skipped
    expect(calls).toBe(1);
    boom = true;
    await new Promise((r) => setTimeout(r, 55)); // expire the latch
    saveSessionOnExit(); // error swallowed
    expect(calls).toBe(2);
    registerSessionExitSaver(null);
    saveSessionOnExit();
    expect(calls).toBe(2);
  });

  test("installProcessSessionSave registers exit + signal handlers exactly once", () => {
    const beforeExit = process.listenerCount("exit");
    const beforeTerm = process.listenerCount("SIGTERM");
    installProcessSessionSave();
    installProcessSessionSave(); // idempotent
    expect(process.listenerCount("exit")).toBe(beforeExit + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
  });
});
