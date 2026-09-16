// Failing-test reproduction: after /compact the TUI shows only the boundary
// line — the summary text itself never renders. Assert the model's summary
// text appears in the transcript frame after a manual /compact.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { clearCompactionHooks } from "../src/tools/compaction-hooks.js";
import { loadSession, saveSession } from "../src/session.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.1"];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  clearCompactionHooks();
});

// Queue of scripted non-streaming JSON replies; records every POST body.
function mockChatQueue(turns: Array<{ reply: string; usage?: unknown }>) {
  const posts: Array<Record<string, unknown>> = [];
  const queue = [...turns];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
    } catch {
      body = {};
    }
    posts.push(body);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: next.reply } }],
        ...(next.usage !== undefined ? { usage: next.usage } : {}),
      }),
    } as unknown as Response;
  });
  return posts;
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  what: string,
  tries = 200
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if ((app.lastFrame() ?? "").includes(what)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for "${what}"`);
}

describe("compaction summary is visible in the TUI", () => {
  test("manual /compact renders the summary text, not just the boundary line", async () => {
    mockChatQueue([
      { reply: "r1" },
      { reply: "r2" },
      { reply: "OBJECTIVE-SENTINEL was built; next step is the parser." },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await waitForFrame(app, "context compacted");
      const frame = app.lastFrame() ?? "";
      // The boundary line alone is not enough: the summary body itself
      // must be visible in the transcript.
      expect(frame).toContain("OBJECTIVE-SENTINEL");
    } finally {
      app.unmount();
    }
  });

  test("auto-compact also surfaces the summary text", async () => {
    mockChatQueue([
      { reply: "first-answer", usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } },
      { reply: "big-answer", usage: { prompt_tokens: 250000, completion_tokens: 100, total_tokens: 250100 } },
      { reply: "AUTO-SUMMARY-SENTINEL details" },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="kimi-k2.5" initialModels={["kimi-k2.5"]} />
    );
    try {
      app.stdin.write("hello-one");
      app.stdin.write("\r");
      await waitForFrame(app, "first-answer");
      app.stdin.write("hello-two");
      app.stdin.write("\r");
      await waitForFrame(app, "big-answer");
      await waitForFrame(app, "context compacted");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("AUTO-SUMMARY-SENTINEL");
    } finally {
      app.unmount();
    }
  });

  test("summary does not leak into the saved model history twice (display-only)", async () => {
    mockChatQueue([
      { reply: "r1" },
      { reply: "r2" },
      { reply: "DISPLAY-ONLY-SENTINEL" },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await waitForFrame(app, "DISPLAY-ONLY-SENTINEL");
      const loaded = loadSession();
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok") return;
      // The summary rides in history exactly once (the [Compacted context]
      // message); the display turn is transcript-only.
      const dumped = JSON.stringify(loaded.session.history);
      expect(dumped).toContain("[Compacted context");
      expect(dumped.split("DISPLAY-ONLY-SENTINEL").length - 1).toBe(1);
    } finally {
      app.unmount();
    }
  });
});
