// Message queuing + steering (Claude-Code-style follow-ups): Enter while
// busy queues (auto-sent on clean turn end, never after cancel); /steer
// injects into the running turn at the next step boundary; /queue manages.
// Model is scripted via deferred fetches; network never live.
import React from "react";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
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

type PostedBody = { messages?: Array<{ role?: string; content?: unknown }> };

function deferredFetch() {
  const posts: PostedBody[] = [];
  const resolvers: Array<(r: Response) => void> = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body ?? "{}")) as PostedBody);
    // Honor cancellation like a real fetch: abort rejects the in-flight POST
    // (the loop translates AbortError into a whole-turn cancel).
    const sig = (init as { signal?: AbortSignal } | undefined)?.signal;
    return new Promise<Response>((resolve, reject) => {
      if (sig?.aborted) {
        reject(new DOMException("This operation was aborted", "AbortError"));
        return;
      }
      const onAbort = () => reject(new DOMException("This operation was aborted", "AbortError"));
      sig?.addEventListener("abort", onAbort, { once: true });
      resolvers.push((r) => {
        sig?.removeEventListener("abort", onAbort);
        resolve(r);
      });
    });
  });
  return { posts, resolvers };
}

const textReply = (text: string) =>
  ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) }) as Response;

const toolReply = (name: string, args: unknown) =>
  ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    }),
  }) as Response;

function lastUserText(posts: PostedBody[], index: number): string | undefined {
  const msgs = posts[index]?.messages ?? [];
  const users = msgs.filter((m) => m?.role === "user");
  const last = users[users.length - 1];
  return typeof last?.content === "string" ? last.content : undefined;
}

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

async function waitForPosts(posts: unknown[], count: number, timeout = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (posts.length >= count) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for POST #${count}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function baseProps(home: string) {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
    skillDirs: { projectDir: home, homeDir: home },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("message queue", () => {
  test("Enter while busy queues; clean turn end auto-sends in order", async () => {
    const home = await tmpDir("atom-q-");
    const { posts, resolvers } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      // Busy: follow-ups queue instead of submitting (input clears, visible).
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "Queued (1)");
      app.stdin.write("third");
      app.stdin.write("\r");
      await waitForFrame(app, "Queued (2)");
      expect(posts).toHaveLength(1);
      // Clean end drains the queue in order.
      resolvers.shift()?.(textReply("r1"));
      await waitForFrame(app, "r1");
      await waitForPosts(posts, 2);
      expect(lastUserText(posts, 1)).toBe("second");
      resolvers.shift()?.(textReply("r2"));
      await waitForFrame(app, "r2");
      await waitForPosts(posts, 3);
      expect(lastUserText(posts, 2)).toBe("third");
      resolvers.shift()?.(textReply("r3"));
      await waitForFrame(app, "r3");
      expect(app.lastFrame()).not.toContain("Queued (");
    } finally {
      app.unmount();
    }
  });

  test("cancel keeps the queue visible but never auto-sends", async () => {
    const home = await tmpDir("atom-q-");
    const { posts, resolvers } = deferredFetch();
    expect(resolvers).toHaveLength(0);
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      app.stdin.write("later");
      app.stdin.write("\r");
      await waitForFrame(app, "Queued (1)");
      app.stdin.write("\u0003");
      await waitForFrame(app, "(cancelled)", 8000);
      await sleep(300);
      expect(posts).toHaveLength(1);
      expect(app.lastFrame()).toContain("Queued (1)");
    } finally {
      app.unmount();
    }
  });

  test("/queue lists and clears; cap refuses with a notice", async () => {
    const home = await tmpDir("atom-q-");
    const { posts } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      for (let i = 0; i < 10; i++) {
        app.stdin.write(`m${i}`);
        app.stdin.write("\r");
        await sleep(30);
      }
      await waitForFrame(app, "Queued (10)");
      app.stdin.write("overflow");
      app.stdin.write("\r");
      await waitForFrame(app, "queue full");
      expect(posts).toHaveLength(1);
      // /queue lists while busy; /queue clear wipes.
      app.stdin.write("/queue");
      app.stdin.write("\r");
      await waitForFrame(app, "1. m0");
      app.stdin.write("/queue clear");
      app.stdin.write("\r");
      await waitForFrame(app, "(queue cleared)");
    } finally {
      app.unmount();
    }
  });
});

describe("steering", () => {
  test("/steer injects into the running turn at the next step boundary", async () => {
    const home = await tmpDir("atom-q-");
    const { posts, resolvers } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("go");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      // First POST returns a read call; it executes, then POST 2 goes out.
      resolvers.shift()?.(toolReply("read", { path: "nowhere-xyz" }));
      await waitForPosts(posts, 2);
      // Steer mid-flight: pending indicator, no interruption, no new POST yet.
      app.stdin.write("/steer also check the outline");
      app.stdin.write("\r");
      await waitForFrame(app, "Steering: also check the outline");
      expect(posts).toHaveLength(2);
      // Second POST returns another read; the steer drains at step 3, so
      // POST 3 carries it as a user message in the SAME turn.
      resolvers.shift()?.(toolReply("read", { path: "nowhere-xyz" }));
      await waitForPosts(posts, 3);
      expect(lastUserText(posts, 2)).toBe("also check the outline");
      resolvers.shift()?.(textReply("done-steer"));
      await waitForFrame(app, "done-steer");
      expect(app.lastFrame()).toContain("also check the outline");
    } finally {
      app.unmount();
    }
  });

  test("/steer idle sends as a normal turn; bare /steer shows usage", async () => {
    const home = await tmpDir("atom-q-");
    const { posts, resolvers } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("/steer hello there");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      expect(lastUserText(posts, 0)).toBe("hello there");
      resolvers.shift()?.(textReply("hi-back"));
      await waitForFrame(app, "hi-back");

      app.stdin.write("/steer");
      app.stdin.write("\r");
      await waitForFrame(app, "usage: /steer <text>");
      expect(posts).toHaveLength(1);
    } finally {
      app.unmount();
    }
  });
});
