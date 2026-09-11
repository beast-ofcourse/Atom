// Ticket 07: pause, resume, and session persistence for the goal loop.
// Hermetic serialize/restore + save/load round-trips first (no TUI); TUI
// only where the behavior strictly needs rendering (pause-keeps-state,
// resume-kickoff, /new + /clear notices, switch isolation, /resume restore).
// Network is ALWAYS mocked — never hit live APIs. Temp HOME via ATOM_HOME;
// "test-key" fixtures; real ~/.atom never touched.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import {
  emptyGoalStats,
  restoreGoalFromPersist,
  serializeGoalForPersist,
} from "../src/goal.js";
import { loadSession, saveSession, sessionFilePath } from "../src/session.js";
import {
  createSession,
  getActiveSessionId,
  getSession,
  sessionFilePath as storeFilePath,
  updateSession,
} from "../src/sessions.js";
import { clearTodos, getTodos, todowriteTool } from "../src/tools.js";
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
  const home = await mkdtemp(join(tmpdir(), "atom-goal-persist-"));
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

// Poll a synchronous probe until it stops throwing / returns truthy.
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

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialProvider: "opencode-zen" as const,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

function submit(
  app: { stdin: { write: (s: string) => void } },
  text: string
): void {
  app.stdin.write(text);
  app.stdin.write("\r");
}

// Scripted non-streaming JSON replies (no `body`, single-JSON path) that
// also capture every POST so tests can count model traffic.
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

async function waitForActive(home: string): Promise<void> {
  await waitFor(() => {
    if (!getActiveSessionId(home)) throw new Error("no active session yet");
  });
}

describe("goal persistence shape (pure, no TUI)", () => {
  test("serialize/restore round-trips text, flag, and stats verbatim", () => {
    const live = {
      objective: "Ship v2",
      active: false,
      stats: { turns: 3, requests: 12, tokens: 4500, workMs: 83000 },
    };
    const restored = restoreGoalFromPersist(
      JSON.parse(JSON.stringify(serializeGoalForPersist(live)))
    );
    expect(restored).toEqual(live);
  });

  test("serialize copies (never aliases) and null stays null", () => {
    expect(serializeGoalForPersist(null)).toBeNull();
    const live = { objective: "A", active: true, stats: emptyGoalStats() };
    const saved = serializeGoalForPersist(live)!;
    expect(saved.stats).toEqual(emptyGoalStats());
    expect(saved.stats).not.toBe(live.stats);
  });

  test("restore degrades absent/corrupt data to no-goal without throwing", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "goal",
      [],
      {},
      { objective: "", active: true },
      { objective: 42, active: true },
      { objective: "A", active: "yes" },
      { objective: "A", active: true, stats: "trash" },
      { objective: "A", active: true, stats: [] },
    ]) {
      expect(restoreGoalFromPersist(bad)).toBeNull();
    }
    // Untouched stats default to zeros rather than failing the restore.
    expect(restoreGoalFromPersist({ objective: "A", active: true })).toEqual({
      objective: "A",
      active: true,
    });
  });

  test("restore coerces trashed counters to zero, keeps the valid ones", () => {
    expect(
      restoreGoalFromPersist({
        objective: "A",
        active: false,
        stats: { turns: "x", requests: 2.7, tokens: -5, workMs: NaN },
      })
    ).toEqual({
      objective: "A",
      active: false,
      stats: { turns: 0, requests: 2, tokens: 0, workMs: 0 },
    });
  });
});

describe("legacy save/load round-trip (no TUI)", () => {
  function snapshot(goal?: Parameters<typeof saveSession>[0]["goal"]) {
    return {
      provider: "opencode-zen" as const,
      model: "big-pickle",
      effort: "auto" as const,
      mode: "normal" as const,
      usageTotals: null,
      ...(goal !== undefined ? { goal } : {}),
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ] as ChatMessage[],
      turns: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ] as { role: "user" | "assistant" | "tool"; content: string }[],
    };
  }

  test("goal text, flag, and stats survive save to fresh load", async () => {
    const home = await tempHome();
    const goal = {
      objective: "Persist me",
      active: false,
      stats: { turns: 3, requests: 12, tokens: 4500, workMs: 83000 },
    };
    saveSession(snapshot(goal), home);
    const loaded = loadSession(home);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.session.goal).toEqual(goal);
  });

  test("missing goal key loads as no-goal with the conversation intact", async () => {
    const home = await tempHome();
    saveSession(snapshot(), home);
    const loaded = loadSession(home);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.session.goal).toBeNull();
    expect(loaded.session.history).toHaveLength(3);
  });

  test("corrupt goal data loads as no-goal without failing the load", async () => {
    const home = await tempHome();
    saveSession(
      snapshot({
        objective: "Keep me",
        active: true,
        stats: { turns: 1, requests: 2, tokens: 3, workMs: 4 },
      }),
      home
    );
    const raw = JSON.parse(await readFile(sessionFilePath(home), "utf8")) as Record<
      string,
      unknown
    >;
    raw["goal"] = { objective: 42, active: "yes", stats: "trash" };
    await writeFile(sessionFilePath(home), JSON.stringify(raw), "utf8");
    const loaded = loadSession(home);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.session.goal).toBeNull();
    expect(loaded.session.history).toHaveLength(3);
  });
});

describe("multi-session store round-trip (no TUI)", () => {
  const stats = { turns: 2, requests: 7, tokens: 900, workMs: 61000 };

  test("goal survives create/update/get with stats intact", async () => {
    const home = await tempHome();
    const s = createSession(
      { title: "g", goal: { objective: "Store me", active: true, stats } },
      home
    );
    expect(getSession(s.id, home)?.goal).toEqual({
      objective: "Store me",
      active: true,
      stats,
    });
    const updated = updateSession(
      s.id,
      { goal: { objective: "Store me", active: false, stats } },
      home
    );
    expect(updated?.goal).toEqual({
      objective: "Store me",
      active: false,
      stats,
    });
    expect(getSession(s.id, home)?.goal).toEqual(updated?.goal);
  });

  test("missing key defaults to no-goal; corrupt goal never strands the record", async () => {
    const home = await tempHome();
    const s = createSession({ title: "plain" }, home);
    expect(getSession(s.id, home)?.goal).toBeNull();
    const raw = JSON.parse(
      await readFile(storeFilePath(s.id, home), "utf8")
    ) as Record<string, unknown>;
    raw["goal"] = ["not", "a", "goal"];
    await writeFile(storeFilePath(s.id, home), JSON.stringify(raw), "utf8");
    const reloaded = getSession(s.id, home);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.goal).toBeNull();
    expect(reloaded?.title).toBe("plain");
    delete raw["goal"];
    await writeFile(storeFilePath(s.id, home), JSON.stringify(raw), "utf8");
    expect(getSession(s.id, home)?.goal).toBeNull();
  });
});

describe("goal pause keeps everything (TUI)", () => {
  test("pause mid-run stops the loop with goal, todos, evidence, and history intact", async () => {
    const home = await tempHome();
    // Never resolves: the turn stays busy so the pause lands mid-run.
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {}));
    const posts = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/goal pause-keeps-qqq");
      await waitForFrame(app, "goal set");
      await waitForFrame(app, "pause-keeps-qqq");
      // A live checklist plus conversation evidence before the pause.
      await todowriteTool({
        todos: [{ content: "checklist-keep-zzz", status: "in_progress" }],
      });
      expect(getTodos()).toHaveLength(1);
      submit(app, "mid-run-evidence-www");
      await waitForFrame(app, "thinking…");
      // The turn really started: its first model POST is on the wire (the
      // phase paints before the POST fires, so poll the POST, not the paint).
      await waitFor(() => {
        expect(posts.mock.calls.length).toBeGreaterThanOrEqual(1);
      });
      const callsBefore = posts.mock.calls.length;
      submit(app, "/goal pause");
      await waitForFrame(app, "goal paused");
      await waitForFrame(app, "pause-keeps-qqq");
      // Pausing issues no model POST of its own.
      await new Promise((r) => setTimeout(r, 300));
      expect(posts.mock.calls.length).toBe(callsBefore);
      // All four survive: status shows the paused goal, todos are untouched,
      // and the transcript still holds the pre-pause evidence.
      submit(app, "/goal");
      await waitForFrame(app, "[paused]");
      expect(app.lastFrame()).toContain("pause-keeps-qqq");
      expect(getTodos()).toEqual([
        { content: "checklist-keep-zzz", status: "in_progress" },
      ]);
      expect(app.lastFrame()).toContain("mid-run-evidence-www");
      // Resuming while busy refuses loudly: no turn is ever injected, and
      // the notice says the running turn picks the live flag up instead.
      submit(app, "/goal resume");
      await waitForFrame(app, "goal resumed");
      await waitForFrame(app, "no new turn started while busy");
      await new Promise((r) => setTimeout(r, 300));
      expect(posts.mock.calls.length).toBe(callsBefore);
      submit(app, "/goal");
      await waitForFrame(app, "[active]");
    } finally {
      app.unmount();
    }
  }, 25000);
});

describe("goal resume continues the run (TUI)", () => {
  test("resume kicks a continuation POST with cumulative stats intact", async () => {
    const home = await tempHome();
    const posts = mockChatQueue([
      { message: { content: "first-done-eee" } },
      { message: { content: "judge prose, no verdict" } },
      { message: { content: "second-done-rrr" } },
      { message: { content: "still just prose" } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/goal kick-goal-www");
      await waitForFrame(app, "kick-goal-www");
      submit(app, "start-work-vvv");
      await waitForFrame(app, "first-done-eee");
      // No update_goal report, unclear judge verdict: the loop pauses
      // (preserves) instead of looping.
      await waitForFrame(app, "judge unclear");
      submit(app, "/goal");
      await waitForFrame(app, "turns 1");
      expect(app.lastFrame()).toContain("requests 1");
      // Resume re-arms AND continues: a real continuation POST goes out,
      // and the counters accumulate across the pause boundary (never reset).
      submit(app, "/goal resume");
      await waitForFrame(app, "goal resumed");
      await waitForFrame(app, "second-done-rrr");
      await waitForFrame(app, "judge unclear");
      submit(app, "/goal");
      await waitForFrame(app, "turns 2");
      expect(app.lastFrame()).toContain("requests 2");
      await waitFor(() => {
        expect(posts.length).toBe(4);
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(posts.length).toBe(4);
    } finally {
      app.unmount();
    }
  }, 30000);
});

describe("/new and /clear end the goal (TUI)", () => {
  test("each clears the active goal with its own visible notice", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/goal newline-goal-aaa");
      await waitForFrame(app, "newline-goal-aaa");
      submit(app, "/new");
      await waitForFrame(app, "new session started");
      await waitForFrame(app, "goal cleared");
      await waitForFrame(app, "/new starts a fresh conversation");
      submit(app, "/goal");
      await waitForFrame(app, "set one with /goal");
      submit(app, "/goal clearline-goal-bbb");
      await waitForFrame(app, "clearline-goal-bbb");
      submit(app, "/clear");
      await waitForFrame(app, "goal cleared");
      await waitForFrame(app, "/clear wipes the conversation");
      submit(app, "/goal");
      await waitForFrame(app, "set one with /goal");
    } finally {
      app.unmount();
    }
  }, 25000);
});

describe("session switches never leak goals (TUI)", () => {
  test("goal in A, switch to B shows no goal, switch back restores A's goal", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const a = createSession({ title: "Goal Alpha Home" }, home);
    const b = createSession({ title: "Goal Beta Plain" }, home);
    expect(getActiveSessionId(home)).toBe(a.id);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/goal goal-alpha-zzz");
      await waitForFrame(app, "goal-alpha-zzz");
      // The set persisted into A's own record.
      await waitFor(() => {
        expect(getSession(a.id, home)?.goal?.objective).toBe("goal-alpha-zzz");
      });
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Beta");
      await waitForFrame(app, "Goal Beta Plain");
      app.stdin.write("\r");
      await waitForFrame(app, 'switched to session "Goal Beta Plain"');
      submit(app, "/goal");
      await waitForFrame(app, "set one with /goal");
      expect(getSession(b.id, home)?.goal).toBeNull();
      // Back to A: the goal (and its stats row) is exactly what it was.
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Alpha");
      await waitForFrame(app, "Goal Alpha Home");
      app.stdin.write("\r");
      await waitForFrame(app, 'switched to session "Goal Alpha Home"');
      submit(app, "/goal");
      await waitForFrame(app, "goal-alpha-zzz");
      expect(app.lastFrame()).toContain("[active]");
    } finally {
      app.unmount();
    }
  }, 30000);
});

describe("/resume restores the goal (TUI)", () => {
  test("saved goal text, flag, and stats return verbatim and the run continues", async () => {
    const home = await tempHome();
    saveSession(
      {
        provider: "opencode-zen",
        model: "big-pickle",
        effort: "auto",
        mode: "normal",
        usageTotals: null,
        goal: {
          objective: "goal-resume-zzz",
          active: true,
          stats: { turns: 2, requests: 5, tokens: 2500, workMs: 61000 },
        },
        history: [
          { role: "system", content: "sys" },
          { role: "user", content: "old-q-qq" },
          { role: "assistant", content: "old-a-aa" },
        ],
        turns: [
          { role: "user", content: "old-q-qq" },
          { role: "assistant", content: "old-a-aa" },
        ],
      },
      home
    );
    const posts = mockChatQueue([
      { message: { content: "continued-reply-qqq" } },
      { message: { content: "judge prose, no verdict" } },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/resume");
      await waitForFrame(app, "resumed session");
      // Restoring never auto-fires a turn: the goal comes back live, quiet.
      await new Promise((r) => setTimeout(r, 500));
      expect(posts.length).toBe(0);
      submit(app, "/goal");
      await waitForFrame(app, "goal-resume-zzz");
      expect(app.lastFrame()).toContain("[active]");
      expect(app.lastFrame()).toContain("turns 2");
      expect(app.lastFrame()).toContain("requests 5");
      // The next turn continues the restored goal: one model POST, one
      // judge POST, and the counters accumulate (turns 3, requests 6).
      submit(app, "follow-up-www");
      await waitForFrame(app, "continued-reply-qqq");
      await waitForFrame(app, "judge unclear");
      submit(app, "/goal");
      await waitForFrame(app, "turns 3");
      expect(app.lastFrame()).toContain("requests 6");
      expect(app.lastFrame()).toContain("goal-resume-zzz");
    } finally {
      app.unmount();
    }
  }, 30000);
});
