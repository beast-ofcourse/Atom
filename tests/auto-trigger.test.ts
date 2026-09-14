// Ticket 02 (trigger parity): pre-request guard + size-error overflow
// recovery. Unit pins for the pure trigger helpers in src/overflow.ts plus
// one App-level proof that a provider size failure compacts (overflow
// semantics through doCompact) and the session continues instead of idling
// on the error. Hermetic ATOM_HOME (temp dir); env saved/restored per file.
// The TUI half uses React.createElement (no JSX) so this stays a .ts file.
import React from "react";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { contextWindowFor } from "../src/context-windows.js";
import {
  OVERFLOW_RESERVE_DEFAULT,
  shouldCompactOnSizeError,
  shouldPreCompactForPending,
} from "../src/overflow.js";

const savedEnv = { ...process.env };
let dirs: string[] = [];

async function isolateHome(): Promise<string> {
  for (const k of ["ATOM_COMPACT_AUTO", "ATOM_COMPACT_RESERVE", "ATOM_COMPACT_PCT"]) {
    delete process.env[k];
  }
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-auto-trigger-"));
  dirs.push(home);
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
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

const MODEL = "kimi-k2.5"; // verified 262144 window
const RESERVE = OVERFLOW_RESERVE_DEFAULT; // 20000
const USABLE = 262_144 - RESERVE; // 242144

describe("shouldPreCompactForPending (pre-request guard)", () => {
  test("below quiet, at/above the usable limit fires", async () => {
    await isolateHome();
    const opts = { auto: true, reserve: RESERVE };
    expect(shouldPreCompactForPending(MODEL, USABLE - 1, opts)).toBe(false);
    expect(shouldPreCompactForPending(MODEL, USABLE, opts)).toBe(true);
    expect(shouldPreCompactForPending(MODEL, USABLE + 5000, opts)).toBe(true);
  });

  test("default config path (no opts) uses the default reserve", async () => {
    await isolateHome();
    expect(shouldPreCompactForPending(MODEL, USABLE - 1)).toBe(false);
    expect(shouldPreCompactForPending(MODEL, USABLE)).toBe(true);
  });

  test("unknown-window models never fire (never invent a window)", async () => {
    await isolateHome();
    expect(shouldPreCompactForPending("mystery-model-xyz", 50_000_000, { auto: true })).toBe(false);
    expect(shouldPreCompactForPending("mystery-model-xyz", 50_000_000)).toBe(false);
  });

  test("auto=false suppresses even a doomed pending size", async () => {
    await isolateHome();
    expect(shouldPreCompactForPending(MODEL, USABLE * 2, { auto: false })).toBe(false);
    process.env.ATOM_COMPACT_AUTO = "0";
    expect(shouldPreCompactForPending(MODEL, USABLE * 2)).toBe(false);
  });

  test("non-finite/negative pending sizes never fire", async () => {
    await isolateHome();
    const opts = { auto: true, reserve: RESERVE };
    expect(shouldPreCompactForPending(MODEL, NaN, opts)).toBe(false);
    expect(shouldPreCompactForPending(MODEL, -1, opts)).toBe(false);
  });

  test("custom reserve shifts the firing line", async () => {
    await isolateHome();
    expect(contextWindowFor(MODEL)).toBe(262_144);
    const pending = USABLE - 1;
    expect(shouldPreCompactForPending(MODEL, pending, { auto: true, reserve: RESERVE })).toBe(false);
    expect(shouldPreCompactForPending(MODEL, pending, { auto: true, reserve: 40_000 })).toBe(true);
  });
});

describe("shouldCompactOnSizeError (overflow recovery gate)", () => {
  test("size error recovers when auto is on", async () => {
    await isolateHome();
    expect(shouldCompactOnSizeError(true)).toBe(true);
    expect(shouldCompactOnSizeError(true, { auto: true })).toBe(true);
  });

  test("non-size errors never recover", async () => {
    await isolateHome();
    expect(shouldCompactOnSizeError(false)).toBe(false);
    expect(shouldCompactOnSizeError(false, { auto: true })).toBe(false);
  });

  test("auto=false suppresses recovery even on a size error", async () => {
    await isolateHome();
    expect(shouldCompactOnSizeError(true, { auto: false })).toBe(false);
    process.env.ATOM_COMPACT_AUTO = "0";
    expect(shouldCompactOnSizeError(true)).toBe(false);
  });
});

// ---- App-level: size error → overflow compact + continue ----

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

type PostedBody = { messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown };

const textReply = (text: string) =>
  ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }) as Response;

function httpFail(status: number, text: string): Response {
  return {
    ok: false,
    status,
    text: async () => text,
    headers: { get: () => null },
  } as unknown as Response;
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 15000
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

async function waitForPosts(posts: unknown[], count: number, timeout = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (posts.length >= count) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for POST #${count}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("size-error overflow recovery (App)", () => {
  test("a 413 fails the turn, compacts with overflow semantics, and the session continues", async () => {
    const home = await isolateHome();
    const posts: PostedBody[] = [];
    // Scripted POSTs: two clean turns, a 413 on the third, the compaction
    // summary POST, then a follow-up proving the session continued.
    const script: Array<() => Response> = [
      () => textReply("r1"),
      () => textReply("r2"),
      () => httpFail(413, "context too long"),
      () => textReply("recovered summary of the older turns"),
      () => textReply("r4"),
    ];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body ?? "{}")) as PostedBody);
      return (script.shift() ?? (() => textReply("?")))();
    });
    const app = render(
      React.createElement(App, {
        apiKey: "test-key",
        endpoint: ENDPOINT,
        initialModel: MODEL,
        initialModels: [MODEL],
        skillDirs: { projectDir: home, homeDir: home },
      })
    );
    try {
      app.stdin.write("one");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("two");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      app.stdin.write("three");
      app.stdin.write("\r");
      // Overflow recovery marker (doCompact boundary line), not an idle error.
      await waitForFrame(app, "(context compacted:");
      expect(app.lastFrame()).not.toContain("HTTP 413");
      // The recovery ran through the single doCompact funnel: the 4th POST
      // is the tools-disabled summary request, not a retried main POST.
      await waitForPosts(posts, 4);
      expect(posts).toHaveLength(4);
      expect(posts[3]).not.toHaveProperty("tools");
      // Session continues: a follow-up sends and answers on compacted context.
      app.stdin.write("four");
      app.stdin.write("\r");
      await waitForFrame(app, "r4");
      await waitForPosts(posts, 5);
      expect(app.lastFrame()).not.toContain("HTTP 413");
    } finally {
      app.unmount();
    }
  });

  test("auto=false: the same 413 idles on the error with no compaction", async () => {
    const home = await isolateHome();
    process.env.ATOM_COMPACT_AUTO = "0";
    const posts: PostedBody[] = [];
    const script: Array<() => Response> = [
      () => textReply("r1"),
      () => textReply("r2"),
      () => httpFail(413, "context too long"),
    ];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body ?? "{}")) as PostedBody);
      return (script.shift() ?? (() => textReply("?")))();
    });
    const app = render(
      React.createElement(App, {
        apiKey: "test-key",
        endpoint: ENDPOINT,
        initialModel: MODEL,
        initialModels: [MODEL],
        skillDirs: { projectDir: home, homeDir: home },
      })
    );
    try {
      app.stdin.write("one");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("two");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      app.stdin.write("three");
      app.stdin.write("\r");
      // Suppressed: the error surfaces, no compaction runs (3 POSTs only).
      await waitForFrame(app, "HTTP 413");
      await new Promise((r) => setTimeout(r, 500));
      expect(posts).toHaveLength(3);
      expect(app.lastFrame()).not.toContain("(context compacted:");
    } finally {
      app.unmount();
    }
  });
});
