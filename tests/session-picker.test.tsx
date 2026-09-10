// /session picker coverage: open/filter/select/cancel/switch/restore.
// Network is ALWAYS mocked — never verify against the live API.
// Temp HOME via ATOM_HOME; "test-key" fixtures; real ~/.atom never touched.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  App,
  filterSessionEntries,
  type SessionPickerEntry,
} from "../src/App.js";
import {
  createSession,
  getActiveSessionId,
  getSession,
  listSessions,
  updateSession,
  type Session,
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
  delete process.env.ATOM_MAX_HISTORY_MESSAGES;
  delete process.env.ATOM_MAX_HISTORY_CHARS;
  const home = await mkdtemp(join(tmpdir(), "atom-session-picker-"));
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

async function waitForAbsence(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for absence of ${JSON.stringify(needle)}:\n${app.lastFrame()}`
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
    // Pinned: session flows on the zen path here.
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

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

// Seed one store record with display turns (history stays empty — the switch
// path falls back to a fresh system line, which is exactly what we want).
function seed(home: string, title: string, turnTexts: string[]): Session {
  return createSession(
    {
      title,
      turns: turnTexts.map((content, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content,
      })),
    },
    home
  );
}

function pickerEntry(id: string, title: string): SessionPickerEntry {
  const stamp = new Date().toISOString();
  return {
    id,
    title,
    updatedAt: stamp,
    createdAt: stamp,
    turnCount: 0,
    active: false,
  };
}

describe("session picker", () => {
  test("opens the picker listing record titles", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    seed(home, "Picker First Session", []);
    seed(home, "Picker Second Session", []);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Picker First Session");
      expect(frame).toContain("Picker Second Session");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("filterSessionEntries fuzzy-matches titles deterministically", () => {
    const entries = [
      "Build authentication",
      "Fix database migration",
      "Temple Run prototype",
      "Website redesign",
    ].map((title, i) => pickerEntry(`ses_fuzzy${i}`, title));
    // Unique subsequence hits land on top.
    expect(filterSessionEntries(entries, "auth")[0]?.title).toBe(
      "Build authentication"
    );
    const dbmig = filterSessionEntries(entries, "dbmig");
    expect(dbmig).toHaveLength(1);
    expect(dbmig[0]?.title).toBe("Fix database migration");
    expect(filterSessionEntries(entries, "web")[0]?.title).toBe(
      "Website redesign"
    );
    // Case-insensitive.
    expect(filterSessionEntries(entries, "AUTH")[0]?.title).toBe(
      "Build authentication"
    );
    // Deterministic ties: equal scores keep input order.
    const tied = [
      pickerEntry("ses_second", "Same Name"),
      pickerEntry("ses_first", "Same Name"),
    ];
    expect(filterSessionEntries(tied, "same").map((e) => e.id)).toEqual([
      "ses_second",
      "ses_first",
    ]);
  });

  test("selecting a session switches the transcript and the active pointer", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const a = seed(home, "Session Alpha Keeps", ["alpha-live-keep-111"]);
    const b = seed(home, "Session Beta Target", ["beta-target-222"]);
    expect(getActiveSessionId(home)).toBe(a.id);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Beta");
      await waitForFrame(app, "Session Beta Target");
      app.stdin.write("\r");
      await waitForFrame(app, 'switched to session "Session Beta Target"');
      await waitFor(() => {
        expect(getActiveSessionId(home)).toBe(b.id);
      });
      expect(app.lastFrame()).toContain("beta-target-222");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("Esc cancels the picker with the live session unchanged", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    const a = seed(home, "Cancel Home Session", ["cancel-live-444"]);
    seed(home, "Cancel Other Session", ["cancel-other-444"]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      const beforeId = getActiveSessionId(home);
      expect(beforeId).toBe(a.id);
      const beforeTurns = JSON.stringify(getSession(beforeId!, home)?.turns);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      // Separate data event: a lone ESC coalesced with prior writes would
      // look like the start of an incomplete escape sequence.
      await new Promise((r) => setTimeout(r, 60));
      app.stdin.write(String.fromCharCode(27));
      await waitForAbsence(app, "Sessions (");
      expect(getActiveSessionId(home)).toBe(beforeId);
      expect(JSON.stringify(getSession(beforeId!, home)?.turns)).toBe(
        beforeTurns
      );
      const frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("switched to session");
      expect(frame).not.toContain("Sessions (");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("switching replaces the transcript without merging, both directions", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    seed(home, "Alpha Keeper", ["alpha-q-555"]);
    seed(home, "Beta Keeper", ["beta-q-555"]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Beta");
      await waitForFrame(app, "Beta Keeper");
      app.stdin.write("\r");
      await waitForFrame(app, "beta-q-555");
      await waitFor(() => {
        const frame = app.lastFrame() ?? "";
        expect(frame).toContain("beta-q-555");
        expect(frame).not.toContain("alpha-q-555");
      });
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Alpha");
      await waitForFrame(app, "Alpha Keeper");
      app.stdin.write("\r");
      await waitForFrame(app, "alpha-q-555");
      await waitFor(() => {
        const frame = app.lastFrame() ?? "";
        expect(frame).toContain("alpha-q-555");
        expect(frame).not.toContain("beta-q-555");
      });
    } finally {
      app.unmount();
    }
  }, 25000);

  test("switch restores target turns verbatim plus the saved model", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    seed(home, "Model Home Session", ["home-q-666"]);
    const target = seed(home, "Model Target Session", ["model-q-666"]);
    // Distinct model via the store patch path (status bar shows the model).
    expect(updateSession(target.id, { model: "kimi-k2.5" }, home)).not.toBeNull();
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Target");
      await waitForFrame(app, "Model Target Session");
      app.stdin.write("\r");
      await waitForFrame(app, 'switched to session "Model Target Session"');
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("model-q-666");
      expect(frame).toContain("kimi-k2.5");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("switching never duplicates turns across A to B to A", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    seed(home, "Dup Alpha", ["dup-alpha-777"]);
    seed(home, "Dup Beta", ["dup-beta-777"]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Dup Beta");
      await waitForFrame(app, 'filter: "Dup Beta"');
      app.stdin.write("\r");
      await waitForFrame(app, "dup-beta-777");
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Dup Alpha");
      await waitForFrame(app, "Dup Alpha");
      app.stdin.write("\r");
      await waitForFrame(app, "dup-alpha-777");
      await waitFor(() => {
        const frame = app.lastFrame() ?? "";
        expect(frame).toContain("dup-alpha-777");
        expect(frame).not.toContain("dup-beta-777");
      });
      expect(countOccurrences(app.lastFrame() ?? "", "dup-alpha-777")).toBe(1);
    } finally {
      app.unmount();
    }
  }, 25000);

  test("picker marks the active session as (current)", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    seed(home, "Current Mark Alpha", []);
    seed(home, "Other Mark Beta", []);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      await waitForFrame(app, "(current)");
      expect(app.lastFrame()).toContain("Current Mark Alpha (current)");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("large session lists open fast and filter narrows", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    for (let i = 0; i < 299; i++) {
      createSession({ title: `Bulk Session ${i}` }, home);
    }
    createSession({ title: "qqzebraqq Unique Session" }, home);
    expect(listSessions(home)).toHaveLength(300);
    const started = Date.now();
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      expect(Date.now() - started).toBeLessThan(8000);
      app.stdin.write("qqzebraqq");
      const total = listSessions(home).length;
      await waitFor(() => {
        expect(app.lastFrame()).toContain(`Sessions (1 of ${total}`);
      });
      expect(app.lastFrame()).toContain("qqzebraqq Unique Session");
    } finally {
      app.unmount();
    }
  }, 25000);

  test("corrupt session files are skipped by the picker", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "noop" } }]);
    seed(home, "Real Survivor Session", ["survivor-1010"]);
    await writeFile(
      join(home, ".atom", "sessions", "zzz.json"),
      "not-json{{{",
      "utf8"
    );
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      expect(app.lastFrame()).toContain("Real Survivor Session");
      expect(listSessions(home).every((s) => s.id !== "zzz")).toBe(true);
    } finally {
      app.unmount();
    }
  }, 25000);

  test("deleted target errors without touching the live session", async () => {
    const home = await tempHome();
    mockChatQueue([{ message: { content: "live-reply-1111" } }]);
    const a = seed(home, "Live Home Session", []);
    const doomed = seed(home, "Doomed Target Session", ["doomed-1111"]);
    const app = render(<App {...baseProps()} />);
    try {
      await waitForActive(home);
      // A live turn makes "transcript intact" meaningful.
      submit(app, "/autoscroll on");
      await waitForFrame(app, "autoscroll ");
      submit(app, "live-q-1111");
      await waitForFrame(app, "live-reply-1111");
      const beforeId = getActiveSessionId(home);
      expect(beforeId).toBe(a.id);
      submit(app, "/session");
      await waitForFrame(app, "Sessions (");
      app.stdin.write("Doomed");
      await waitForFrame(app, "Doomed Target Session");
      // Delete the target record from disk while the picker is open.
      await rm(join(home, ".atom", "sessions", `${doomed.id}.json`), {
        force: true,
      });
      app.stdin.write("\r");
      await waitForFrame(app, "(session no longer available");
      expect(getActiveSessionId(home)).toBe(beforeId);
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("live-q-1111");
      expect(frame).not.toContain("doomed-1111");
    } finally {
      app.unmount();
    }
  }, 25000);
});
