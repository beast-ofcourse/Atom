// Turn-boundary drain (ticket 07): one ordered routine — compact, steer,
// queue, goal-resume — drains identically after success, failure, and
// cancellation. Same chain setup at every ending: a busy turn + a queued
// follow-up + a pending manual /compact. Success and failure auto-send the
// queue (the gate is the cancellation latch, not success); cancellation
// keeps the queue visible without auto-sending. Model is scripted via
// deferred fetches; network never live.
import React from "react";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { goalFollowUp } from "../src/goal.js";

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

function httpFail(status: number): Response {
  return {
    ok: false,
    status,
    text: async () => "bad",
    headers: { get: () => null },
  } as unknown as Response;
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseProps(home: string) {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
    skillDirs: { projectDir: home, homeDir: home },
  };
}

describe("turn-boundary drain chains identically across endings", () => {
  test("success: pending compact drains, then the queued follow-up auto-sends", async () => {
    const home = await tmpDir("atom-drain-");
    process.env.ATOM_HOME = home;
    const { posts, resolvers } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "Queued (1)");
      // /compact while busy stages silently — give it a beat to process.
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await sleep(250);
      expect(posts).toHaveLength(1);
      // Clean end: compact stage runs, then the queue auto-sends in order.
      resolvers.shift()?.(textReply("r1"));
      await waitForFrame(app, "r1");
      await waitForPosts(posts, 2);
      expect(lastUserText(posts, 1)).toBe("second");
      // Committed (not rolled back): POST 2 carries both user turns.
      expect((posts[1]?.messages ?? []).filter((m) => m?.role === "user").map((m) => m?.content)).toEqual([
        "first",
        "second",
      ]);
      resolvers.shift()?.(textReply("r2"));
      await waitForFrame(app, "r2");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("(nothing to compact)");
      expect(frame).not.toContain("Queued (");
      expect(posts).toHaveLength(2);
    } finally {
      app.unmount();
    }
  });

  test("failure: pending compact still drains and the queued follow-up still auto-sends", async () => {
    const home = await tmpDir("atom-drain-");
    process.env.ATOM_HOME = home;
    const { posts, resolvers } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "Queued (1)");
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await sleep(250);
      expect(posts).toHaveLength(1);
      // Failed end: rollback + error, but the drain still runs the pending
      // manual compact and still auto-sends (the gate is cancellation, not
      // success). The chained submit clears the transient error line, so
      // the failure is proven by the rollback instead: POST 2 carries only
      // the queued follow-up (the failed turn was spliced away).
      resolvers.shift()?.(httpFail(400));
      await waitForPosts(posts, 2);
      expect(lastUserText(posts, 1)).toBe("second");
      expect((posts[1]?.messages ?? []).filter((m) => m?.role === "user").map((m) => m?.content)).toEqual([
        "second",
      ]);
      resolvers.shift()?.(textReply("r2"));
      await waitForFrame(app, "r2");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("(nothing to compact)");
      expect(frame).not.toContain("Queued (");
      expect(posts).toHaveLength(2);
    } finally {
      app.unmount();
    }
  });

  test("cancellation: pending compact drains but the queue stays visible without auto-sending", async () => {
    const home = await tmpDir("atom-drain-");
    process.env.ATOM_HOME = home;
    const { posts, resolvers } = deferredFetch();
    expect(resolvers).toHaveLength(0);
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "Queued (1)");
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await sleep(250);
      app.stdin.write(String.fromCharCode(3)); // Ctrl+C
      await waitForFrame(app, "(cancelled)", 8000);
      await sleep(300);
      // Cancelled turns never auto-send — the queue stays put for the user —
      // but the pending manual compact still drained.
      expect(posts).toHaveLength(1);
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Queued (1)");
      expect(frame).toContain("(nothing to compact)");
    } finally {
      app.unmount();
    }
  });
});

describe("stranded steer rejoins the queue front", () => {
  test("failure auto-sends the stranded steer as the next turn", async () => {
    const home = await tmpDir("atom-drain-");
    process.env.ATOM_HOME = home;
    const { posts, resolvers } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("go");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      app.stdin.write("/steer via brainstorm");
      app.stdin.write("\r");
      await waitForFrame(app, "Steering: via brainstorm");
      // Fail fast: the loop throws before any step boundary drains the
      // steer, so it strands — the drain rejoins it at the queue front and
      // (not cancelled) auto-sends it as the next turn.
      resolvers.shift()?.(httpFail(400));
      await waitForPosts(posts, 2);
      expect(lastUserText(posts, 1)).toBe("via brainstorm");
      resolvers.shift()?.(textReply("done-steer"));
      await waitForFrame(app, "done-steer");
      expect(posts).toHaveLength(2);
    } finally {
      app.unmount();
    }
  });

  test("cancel keeps the stranded steer queued without auto-sending", async () => {
    const home = await tmpDir("atom-drain-");
    process.env.ATOM_HOME = home;
    const { posts, resolvers } = deferredFetch();
    expect(resolvers).toHaveLength(0);
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("go");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      app.stdin.write("/steer via brainstorm");
      app.stdin.write("\r");
      await waitForFrame(app, "Steering: via brainstorm");
      app.stdin.write(String.fromCharCode(3)); // Ctrl+C
      await waitForFrame(app, "(cancelled)", 8000);
      await sleep(300);
      expect(posts).toHaveLength(1);
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("Queued (1)");
      expect(frame).toContain("via brainstorm");
    } finally {
      app.unmount();
    }
  });
});

describe("staged goal resume drains at the boundary", () => {
  test("failed turn with a staged resume kicks exactly one continuation, then stops", async () => {
    const home = await tmpDir("atom-drain-");
    process.env.ATOM_HOME = home;
    const { posts, resolvers } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("/goal Ship v2");
      app.stdin.write("\r");
      await waitForFrame(app, 'goal set');
      // Set kicks the turn itself now (no separate "go" needed): this IS
      // the busy turn the pause/resume stages against.
      await waitForPosts(posts, 1);
      // Re-arm while busy: pause first (resume on an active goal is a no-op
      // with no staging), then resume — stages the drain flag.
      app.stdin.write("/goal pause");
      app.stdin.write("\r");
      await waitForFrame(app, "goal paused");
      app.stdin.write("/goal resume");
      app.stdin.write("\r");
      await waitForFrame(app, "goal resumes when the current turn ends");
      // Failed turns never continue inside the loop, so the drain kicks the
      // continuation; the kicked turn fails too, and the consumed flag stops
      // the chain there (no retry loop).
      resolvers.shift()?.(httpFail(400));
      await waitForPosts(posts, 2);
      expect(lastUserText(posts, 1)).toBe(goalFollowUp("Ship v2"));
      resolvers.shift()?.(httpFail(400));
      await waitForFrame(app, "HTTP 400");
      await sleep(400);
      expect(posts).toHaveLength(2);
    } finally {
      app.unmount();
    }
  });

  test("staged resume does not kick when the goal is inactive at turn end", async () => {
    const home = await tmpDir("atom-drain-");
    process.env.ATOM_HOME = home;
    const { posts, resolvers } = deferredFetch();
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("/goal Ship v2");
      app.stdin.write("\r");
      await waitForFrame(app, 'goal set');
      // The set-kicked turn is the busy turn here (no separate "go").
      await waitForPosts(posts, 1);
      app.stdin.write("/goal pause");
      app.stdin.write("\r");
      await waitForFrame(app, "goal paused");
      app.stdin.write("/goal resume");
      app.stdin.write("\r");
      await waitForFrame(app, "goal resumes when the current turn ends");
      // Paused again before turn end: the flag is consumed with no kick.
      app.stdin.write("/goal pause");
      app.stdin.write("\r");
      await waitForFrame(app, "goal paused");
      resolvers.shift()?.(textReply("r1"));
      await waitForFrame(app, "r1");
      await sleep(400);
      expect(posts).toHaveLength(1);
    } finally {
      app.unmount();
    }
  });

  test("cancelled turn with a staged resume never kicks", async () => {
    const home = await tmpDir("atom-drain-");
    process.env.ATOM_HOME = home;
    const { posts, resolvers } = deferredFetch();
    expect(resolvers).toHaveLength(0);
    const app = render(<App {...baseProps(home)} />);
    try {
      app.stdin.write("/goal Ship v2");
      app.stdin.write("\r");
      await waitForFrame(app, 'goal set');
      app.stdin.write("go");
      app.stdin.write("\r");
      await waitForPosts(posts, 1);
      app.stdin.write("/goal pause");
      app.stdin.write("\r");
      await waitForFrame(app, "goal paused");
      app.stdin.write("/goal resume");
      app.stdin.write("\r");
      await waitForFrame(app, "goal resumes when the current turn ends");
      app.stdin.write(String.fromCharCode(3)); // Ctrl+C
      await waitForFrame(app, "(cancelled)", 8000);
      await sleep(400);
      // Cancel pauses the goal and never kicks — exactly one POST total.
      expect(posts).toHaveLength(1);
    } finally {
      app.unmount();
    }
  });
});
