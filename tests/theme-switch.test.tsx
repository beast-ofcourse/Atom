// Phase 5 item 5.2 — /theme switcher: lists ember + classic, switches live,
// persists like provider/model/effort (session save round-trip), unknown
// names fall back to ember with a notice. Theme values and component paint
// are untouched — notices carry the observable state.
// Runs alongside tests/dock-flag.test.tsx only. Full-App mount (same
// hermetic baseProps pattern as tests/app.test.tsx): initialModels skips
// live discovery so no network is touched (turns use a mocked POST).
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, formatThemeList, normalizeThemeName, parseThemeArg } from "../src/App.js";
import { loadPrefs } from "../src/session.js";

const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let homes: string[] = [];

async function tempHome(): Promise<string> {
  delete process.env.OPENCODE_ZEN_MODEL;
  const home = await mkdtemp(join(tmpdir(), "atom-theme-"));
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

// GET lists fail (fallback, uncached) but the turn still completes;
// POST turns reply conversationally.
function mockFetchReply(reply: string) {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (method === "GET") {
      return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
    } as Response;
  });
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

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const frame = app.lastFrame() ?? "";
    if (frame.includes(needle)) return frame;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}:\n${frame}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("/theme arg helpers (pure)", () => {
  test("parseThemeArg: bare yields empty, spaced yields the name", () => {
    expect(parseThemeArg("/theme")).toBe("");
    expect(parseThemeArg("/theme classic")).toBe("classic");
    expect(parseThemeArg("  /theme   ember  ")).toBe("ember");
  });

  test("normalizeThemeName: known names pass, unknown/empty fall back to ember", () => {
    expect(normalizeThemeName("ember")).toBe("ember");
    expect(normalizeThemeName("classic")).toBe("classic");
    expect(normalizeThemeName("Classic")).toBe("classic");
    expect(normalizeThemeName("bogus")).toBe("ember");
    expect(normalizeThemeName("")).toBe("ember");
  });

  test("formatThemeList marks the current theme", () => {
    expect(formatThemeList("ember")).toContain("ember (current)");
    expect(formatThemeList("classic")).toContain("classic (current)");
    expect(formatThemeList("ember")).toContain("classic");
  });
});

describe("/theme switcher (Phase 5.2)", () => {
  test("bare /theme lists ember + classic", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      await waitForFrame(app, "big-pickle");
      app.stdin.write("/theme");
      app.stdin.write("\r");
      const frame = await waitForFrame(app, "themes:");
      expect(frame).toContain("ember");
      expect(frame).toContain("classic");
    } finally {
      app.unmount();
    }
  });

  test("/theme classic switches live (notice + list marks current)", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      await waitForFrame(app, "big-pickle");
      app.stdin.write("/theme classic");
      app.stdin.write("\r");
      await waitForFrame(app, "(theme: classic)");
      app.stdin.write("/theme");
      app.stdin.write("\r");
      const frame = await waitForFrame(app, "classic (current)");
      expect(frame).toContain("classic (current)");
    } finally {
      app.unmount();
    }
  });

  test("unknown name falls back to ember with a notice", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      await waitForFrame(app, "big-pickle");
      app.stdin.write("/theme classic");
      app.stdin.write("\r");
      await waitForFrame(app, "(theme: classic)");
      app.stdin.write("/theme bogus");
      app.stdin.write("\r");
      await waitForFrame(app, 'fell back to ember');
      expect(app.lastFrame()).toContain('(unknown theme "bogus"');
      app.stdin.write("/theme");
      app.stdin.write("\r");
      const frame = await waitForFrame(app, "ember (current)");
      expect(frame).toContain("ember (current)");
    } finally {
      app.unmount();
    }
  });

  test("theme persists like provider/model/effort and restores on relaunch", async () => {
    const home = await tempHome();
    mockFetchReply("theme-persist-reply");
    const first = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModels={MODELS}
        restorePrefs
      />,
    );
    try {
      await waitForFrame(first, "kilo/");
      first.stdin.write("/theme classic");
      first.stdin.write("\r");
      await waitForFrame(first, "(theme: classic)");
      // Complete a turn so the save carries the pick (same cadence as
      // /model: completed turns + clean exit write session.json).
      first.stdin.write("remember the theme");
      first.stdin.write("\r");
      await waitForFrame(first, "theme-persist-reply");
    } finally {
      first.unmount();
    }
    // Saved prefs carry the theme (loadPrefs is the restore path).
    expect(loadPrefs(home, ENDPOINT)?.theme).toBe("classic");
    // Remount with no explicit theme: prefs restore, conversation does not.
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModels={MODELS} restorePrefs />,
    );
    try {
      await waitForFrame(app, "kilo/");
      app.stdin.write("/theme");
      app.stdin.write("\r");
      const frame = await waitForFrame(app, "classic (current)");
      expect(frame).toContain("classic (current)");
      expect(app.lastFrame()).not.toContain("theme-persist-reply");
    } finally {
      app.unmount();
    }
  });
});
