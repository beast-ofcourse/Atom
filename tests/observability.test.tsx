// Phase 5 observability + latency polish: session model-list cache,
// elapsed + stall indicator, local-command zero-fetch audit.
// Network is ALWAYS mocked here — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  App,
  TURN_STALL_AFTER_MS,
  TURN_TICK_MS,
  elapsedSecsSince,
  isStalledSince,
  modelsCacheKey,
} from "../src/App.js";

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
  const home = await mkdtemp(join(tmpdir(), "atom-obs-"));
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
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForFrameAbsent(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 2000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for absence of ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("modelsCacheKey + pure timer helpers", () => {
  test("cache key is provider-only except openai-compatible (+baseURL)", () => {
    expect(modelsCacheKey("opencode-zen")).toBe("opencode-zen");
    expect(modelsCacheKey("openai", "http://ignored.example/v1")).toBe("openai");
    expect(modelsCacheKey("anthropic")).toBe("anthropic");
    expect(modelsCacheKey("openai-compatible", "http://a.example/v1")).toBe(
      "openai-compatible|http://a.example/v1"
    );
    expect(modelsCacheKey("openai-compatible", "http://b.example/v1")).toBe(
      "openai-compatible|http://b.example/v1"
    );
    expect(modelsCacheKey("openai-compatible", "http://a.example/v1")).not.toBe(
      modelsCacheKey("openai-compatible", "http://b.example/v1")
    );
    expect(modelsCacheKey("openai-compatible", "http://a.example/v1")).toBe(
      modelsCacheKey("openai-compatible", "http://a.example/v1")
    );
    expect(modelsCacheKey("openai-compatible")).toBe("openai-compatible|");
  });

  test("elapsed ticks at 1s resolution; stall after >3s", () => {
    expect(TURN_TICK_MS).toBe(1000);
    expect(TURN_STALL_AFTER_MS).toBe(3000);
    expect(elapsedSecsSince(1000, 1000)).toBe(0);
    expect(elapsedSecsSince(1000, 1999)).toBe(0);
    expect(elapsedSecsSince(1000, 2000)).toBe(1);
    expect(elapsedSecsSince(1000, 5000)).toBe(4);
    expect(elapsedSecsSince(5000, 1000)).toBe(0); // never negative
    expect(isStalledSince(1000, 4000)).toBe(false); // exactly 3s: not stalled
    expect(isStalledSince(1000, 4001)).toBe(true); // >3s: stalled
    expect(isStalledSince(1000, 8000)).toBe(true);
  });
});

describe("models-list session cache", () => {
  async function seedKeys(home: string) {
    const { saveAuth, setStoredKey, emptyAuth } = await import("../src/auth.js");
    let auth = emptyAuth();
    auth = setStoredKey(auth, "opencode-zen", "test-key");
    auth = setStoredKey(auth, "openai", "test-key-2");
    saveAuth(auth, home);
  }

  function mockLiveLists(counter: { n: number }) {
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method !== "GET") throw new Error(`unexpected POST in cache test: ${u}`);
      counter.n += 1;
      if (u.includes("api.openai.com")) {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "openai-live-x" }, { id: "openai-live-y" }] }),
        } as Response;
      }
      // Zen live list uses chat-family hints so ids outside the curated set
      // still count as live (ok:true) and stay distinguishable from fallback.
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "zen-live-a", family: "chat" },
            { id: "zen-live-b", family: "chat" },
          ],
        }),
      } as Response;
    });
  }

  async function openProviderPicker(app: { stdin: { write(s: string): void } }) {
    app.stdin.write("/provider");
    app.stdin.write("\r");
    await waitForFrame(app as never, "Select provider");
  }

  test("switch A→B→A costs 2 list calls total; switch-back is zero-fetch; /model reflects cache instantly", async () => {
    const home = await cleanEnv();
    await seedKeys(home);
    const counter = { n: 0 };
    mockLiveLists(counter);
    // No initialModels: mount fetches the zen live list (call 1).
    const app = render(<App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" />);
    try {
      // Mount live list: open /model and wait for the live id.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "zen-live-a");
      expect(counter.n).toBe(1);
      app.stdin.write("\u001B");
      await waitForFrame(app, "›");
      // Switch to openai via Esc-keeps-existing (no validation fetch).
      await openProviderPicker(app);
      app.stdin.write("\u001B[B"); // openai is index 1
      app.stdin.write("\r");
      await waitForFrame(app, "API key for openai");
      expect(app.lastFrame()).toContain("key on file");
      app.stdin.write("\u001B"); // Esc keeps + switches (list fetch, call 2)
      await waitForFrame(app, "provider: openai");
      expect(counter.n).toBe(2);
      // /model reflects the switched-to provider instantly (local open, zero fetch).
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "openai-live-x");
      expect(counter.n).toBe(2);
      app.stdin.write("\u001B");
      await waitForFrame(app, "›");
      // Switch back to zen: cache hit, zero fetches.
      await openProviderPicker(app);
      // Picker highlights current provider (openai index 1); up -> zen index 0.
      app.stdin.write("\u001B[A");
      app.stdin.write("\r");
      await waitForFrame(app, "API key for opencode-zen");
      app.stdin.write("\u001B");
      await waitForFrame(app, "provider: opencode-zen");
      expect(counter.n).toBe(2);
      // /model instantly shows the cached zen list with zero extra fetches.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "zen-live-a");
      expect(counter.n).toBe(2);
    } finally {
      app.unmount();
    }
  });

  test("failed fetches fall back uncached (revisit refetches)", async () => {
    const home = await cleanEnv();
    await seedKeys(home);
    let n = 0;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method !== "GET") throw new Error(`unexpected POST: ${String(url)}`);
      n += 1;
      return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
    });
    const app = render(<App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" />);
    try {
      // Mount fails -> curated fallback (still renders, uncached).
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      expect(app.lastFrame()).toContain("big-pickle");
      expect(n).toBe(1);
      app.stdin.write("\u001B");
      await waitForFrame(app, "›");
      // Switch to openai (fails -> openai fallback, uncached).
      await openProviderPicker(app);
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "API key for openai");
      app.stdin.write("\u001B");
      await waitForFrame(app, "provider: openai");
      expect(n).toBe(2);
      // Switch back to zen: fallback was NOT cached, so it refetches.
      await openProviderPicker(app);
      app.stdin.write("\u001B[A");
      app.stdin.write("\r");
      await waitForFrame(app, "API key for opencode-zen");
      app.stdin.write("\u001B");
      await waitForFrame(app, "provider: opencode-zen");
      expect(n).toBe(3);
    } finally {
      app.unmount();
    }
  });
});

describe("elapsed + stall indicator", () => {
  test("busy shows live elapsed seconds; >3s silence shows waiting…; next token clears it; transcript never contains it; timer cleaned up", async () => {
    await cleanEnv();
    let fakeNow = 1_000_000;
    const tickCbs: Array<() => void> = [];
    const cleared: unknown[] = [];
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="big-pickle"
        initialModels={["big-pickle"]}
        now={() => fakeNow}
        setIntervalFn={((cb: () => void) => {
          tickCbs.push(cb);
          return tickCbs.length as unknown as NodeJS.Timeout;
        }) as unknown as typeof setInterval}
        clearIntervalFn={((h: unknown) => {
          cleared.push(h);
        }) as unknown as typeof clearInterval}
      />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      // Timer started on turn begin (1s resolution); busy phase + elapsed
      // live in the footer status line (sole info bar, no header block).
      await waitForFrame(app, "thinking… 0s");
      // Busy phase + elapsed live in the footer status line (the only line
      // carrying `provider:`; 80-col test frames may wrap it mid-segment).
      expect(app.lastFrame()).toContain("provider: opencode-zen");
      expect(app.lastFrame()).toContain("thinking… 0s");
      expect(tickCbs).toHaveLength(1);
      expect(cleared).toHaveLength(0);
      // First token arrives (activity).
      controller.enqueue(enc.encode(sseData({ choices: [{ delta: { content: "hello " } }] })));
      await waitForFrame(app, "hello ");
      // +1s tick -> elapsed visible, no stall yet.
      fakeNow += 1000;
      tickCbs[0]!();
      await waitForFrame(app, "streaming… 1s");
      expect(app.lastFrame()).not.toContain("waiting…");
      // +4s silence -> dim waiting… hint (status-bar only).
      fakeNow += 3000;
      tickCbs[0]!();
      await waitForFrame(app, "waiting…");
      // Next token clears the hint mid-turn (still busy, before [DONE]).
      controller.enqueue(enc.encode(sseData({ choices: [{ delta: { content: "world" } }] })));
      await waitForFrame(app, "hello world");
      await waitForFrameAbsent(app, "waiting…");
      expect(app.lastFrame()).toContain("hello world");
      // Finish the stream: turn commits, timer cleaned up, hint never committed.
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
      // The draft already renders "ATOM>" while streaming, so commit is
      // observed via timer cleanup (turn-end finally), not via "ATOM>".
      {
        const start = Date.now();
        for (;;) {
          if (cleared.length === 1) break;
          if (Date.now() - start > 8000) {
            throw new Error(`timed out waiting for timer cleanup:\n${app.lastFrame()}`);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      await waitForFrameAbsent(app, "waiting…");
      expect(app.lastFrame()).toContain("hello world");
      expect(app.lastFrame()).not.toContain("waiting…");
      // Saved transcript never contains the hint (status-bar only). The
      // system prompt (history[0]) legitimately documents the feature, so
      // only the transcript — turns plus non-system history — is scanned,
      // for the exact `waiting…` hint text.
      const { loadSession } = await import("../src/session.js");
      const loaded = loadSession(process.env.ATOM_HOME);
      expect(loaded.status).toBe("ok");
      if (loaded.status === "ok") {
        const transcript = JSON.stringify({
          turns: loaded.session.turns,
          history: loaded.session.history.slice(1),
        });
        expect(transcript).not.toContain("waiting…");
      }
    } finally {
      app.unmount();
    }
    // Unmount after a completed turn leaks nothing extra.
    expect(cleared).toHaveLength(1);
  });

  test("pending turn unmount clears the timer (no leaked handles)", async () => {
    await cleanEnv();
    let fakeNow = 2_000_000;
    const tickCbs: Array<() => void> = [];
    const cleared: unknown[] = [];
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}) // never resolves: turn stays busy
    );
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="big-pickle"
        initialModels={["big-pickle"]}
        now={() => fakeNow}
        setIntervalFn={((cb: () => void) => {
          tickCbs.push(cb);
          return tickCbs.length as unknown as NodeJS.Timeout;
        }) as unknown as typeof setInterval}
        clearIntervalFn={((h: unknown) => {
          cleared.push(h);
        }) as unknown as typeof clearInterval}
      />
    );
    app.stdin.write("hi");
    app.stdin.write("\r");
    await waitForFrame(app, "thinking… 0s");
    expect(tickCbs).toHaveLength(1);
    expect(cleared).toHaveLength(0);
    void fakeNow;
    app.unmount();
    expect(cleared).toHaveLength(1);
  });
});

describe("local-command zero-fetch audit", () => {
  test("/model /effort /tools /help /mode /yolo /clear /resume /provider-open cost zero fetches", async () => {
    await cleanEnv();
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch call (local commands must be zero-fetch)");
    });
    globalThis.fetch = fetchMock;
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={["big-pickle", "kimi-k2.5"]} />
    );
    try {
      // /model open + Esc close (local picker).
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      app.stdin.write("\u001B");
      await waitForFrame(app, "›");
      expect(fetchMock).not.toHaveBeenCalled();
      // /effort open + Esc close (local picker).
      app.stdin.write("/effort");
      app.stdin.write("\r");
      await waitForFrame(app, "Select reasoning effort");
      app.stdin.write("\u001B");
      await waitForFrame(app, "›");
      expect(fetchMock).not.toHaveBeenCalled();
      // /tools (local list).
      app.stdin.write("/tools");
      app.stdin.write("\r");
      await waitForFrame(app, "Tools (");
      expect(fetchMock).not.toHaveBeenCalled();
      // /help (local list).
      app.stdin.write("/help");
      app.stdin.write("\r");
      await waitForFrame(app, "Commands:");
      expect(fetchMock).not.toHaveBeenCalled();
      // /mode (local print). NOTE: "/mode" is a prefix of "/model", so the
      // slash menu highlights "/model" first — arrow down once to run "/mode".
      app.stdin.write("/mode");
      await waitForFrame(app, "Atom commands");
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      // /mode pushes a `mode: …` info line, but the status line already
      // contains that text, so commit is observed via picker-closed input.
      await waitForFrame(app, "›");
      expect(app.lastFrame()).not.toContain("Select model");
      expect(fetchMock).not.toHaveBeenCalled();
      // /yolo toggle (local).
      app.stdin.write("/yolo");
      app.stdin.write("\r");
      await waitForFrame(app, "mode: yolo");
      expect(fetchMock).not.toHaveBeenCalled();
      // /clear (local reset).
      app.stdin.write("/clear");
      app.stdin.write("\r");
      await waitForFrame(app, "Say hi");
      expect(fetchMock).not.toHaveBeenCalled();
      // /resume with no save on disk (local disk read only).
      app.stdin.write("/resume");
      app.stdin.write("\r");
      await waitForFrame(app, "(no saved session)");
      expect(fetchMock).not.toHaveBeenCalled();
      // /provider picker open + Esc close (local open; validation submit is
      // network by design and is NOT asserted here).
      app.stdin.write("/provider");
      app.stdin.write("\r");
      await waitForFrame(app, "Select provider");
      app.stdin.write("\u001B");
      await waitForFrame(app, "›");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(0);
    } finally {
      app.unmount();
    }
  });
});
