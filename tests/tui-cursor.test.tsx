// Task B TUI tests: left/right cursor navigation, ATOM> prefix, and wire
// payload roles. Network is ALWAYS mocked here — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

const MODELS = ["big-pickle"];
const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// Key bytes via char codes (keeps control bytes out of the source text).
const ESC_CH = String.fromCharCode(27);
const LEFT = `${ESC_CH}[D`;
const RIGHT = `${ESC_CH}[C`;
const HOME = `${ESC_CH}[H`;
const ENDK = `${ESC_CH}[F`;
const DEL = `${ESC_CH}[3~`;
const BS = String.fromCharCode(127);
const ESC = ESC_CH;

// Mock the chat POST path with a fixed reply, capturing payloads.
function mockChatReply(reply: string) {
  const calls: Array<{ model: unknown; messages: unknown }> = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: unknown;
      messages?: unknown;
    };
    calls.push({ model: body.model, messages: body.messages });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
    } as Response;
  });
  return calls;
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 5000
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

async function waitForFrameAbsent(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 2000
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

// Submit pipeline ordering (SUBMIT_PIPELINE_STAGES in src/App.tsx, pinned by
// tests/submit-order.test.ts): context-assembly (env refresh) + loop-entry
// (async skill discovery) run before the first POST, so a reply needle must
// be unique (never "ok", which matches the "token: n/a" status line on mount)
// and POST-body assertions must wait for the loop-entry POST, not the frame.
async function waitForPosts(
  calls: Array<unknown>,
  count: number,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (calls.length >= count) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for POST #${count}`);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cursor navigation", () => {
  test("cursor renders at end; arrows move it; typing inserts at the cursor; Enter submits the full line", async () => {
    // NOTE: reply needle must be unique — "ok" matches the "token: n/a"
    // status line on mount. The submit pipeline (SUBMIT_PIPELINE_STAGES in
    // src/App.tsx, pinned by tests/submit-order.test.ts) runs async
    // context-assembly + loop-entry (skill discovery) before the first POST,
    // so wait for the loop-entry reply + POST, not the status line.
    const calls = mockChatReply("ok-cursor-insert-xyz");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      await waitForFrame(app, "hello");
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(LEFT);
      await sleep(40);
      // Cursor position is proven by the edit, not a glyph: the inverse
      // cursor renders as plain text in the frame. X landing mid-line
      // proves the cursor sat at index 3 (no letter-shifting block).
      app.stdin.write("X");
      await waitForFrame(app, "helXlo");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-cursor-insert-xyz");
      await waitForPosts(calls, 1);
      const messages = calls[0]?.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages.at(-1)).toEqual({ role: "user", content: "helXlo" });
    } finally {
      app.unmount();
    }
  });

  test("backspace deletes before the cursor; Delete removes at the cursor", async () => {
    // NOTE: reply needle must be unique — "ok" matches the "token: n/a"
    // status line on mount. The submit pipeline (SUBMIT_PIPELINE_STAGES in
    // src/App.tsx, pinned by tests/submit-order.test.ts) runs async
    // context-assembly + loop-entry (skill discovery) before the first POST,
    // so wait for the loop-entry reply + POST, not the status line.
    const calls = mockChatReply("ok-cursor-delete-xyz");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      await waitForFrame(app, "hello");
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(BS);
      await waitForFrame(app, "helo");
      app.stdin.write(RIGHT);
      await sleep(40);
      app.stdin.write(DEL);
      // "hel" is a substring of "helo", so wait for the absence instead.
      await waitForFrameAbsent(app, "helo");
      expect(app.lastFrame()).toContain("hel");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-cursor-delete-xyz");
      await waitForPosts(calls, 1);
      const messages = calls[0]?.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages.at(-1)).toEqual({ role: "user", content: "hel" });
    } finally {
      app.unmount();
    }
  });

  test("cursor clamps at both edges; edits at edges are no-ops", async () => {
    // NOTE: reply needle must be unique — "ok" matches the "token: n/a"
    // status line on mount. The submit pipeline (SUBMIT_PIPELINE_STAGES in
    // src/App.tsx, pinned by tests/submit-order.test.ts) runs async
    // context-assembly + loop-entry (skill discovery) before the first POST,
    // so wait for the loop-entry reply + POST, not the status line.
    const calls = mockChatReply("ok-cursor-clamp-xyz");
    const app = render(<App {...baseProps()} />);
    try {
      // Distinctive text: "hi" alone would match "thinking" in the frame.
      app.stdin.write("qz9");
      await waitForFrame(app, "qz9");
      // Past the start: extra left is a no-op — Q landing at the front
      // proves the cursor clamped at 0.
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write("Q");
      await waitForFrame(app, "Qqz9");
      // Backspace removes the just-typed Q (cursor was 1).
      app.stdin.write(BS);
      await waitForFrameAbsent(app, "Qqz9");
      // Past the end: extra right is a no-op — Z landing at the back
      // proves the cursor clamped at the end.
      app.stdin.write(RIGHT);
      await sleep(40);
      app.stdin.write(RIGHT);
      await sleep(40);
      app.stdin.write(RIGHT);
      await sleep(40);
      app.stdin.write("Z");
      await waitForFrame(app, "qz9Z");
      // Delete at end is a no-op.
      app.stdin.write(DEL);
      await sleep(60);
      expect(app.lastFrame()).toContain("qz9Z");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-cursor-clamp-xyz");
      await waitForPosts(calls, 1);
      const messages = calls[0]?.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages.at(-1)).toEqual({ role: "user", content: "qz9Z" });
    } finally {
      app.unmount();
    }
  });

  test("Home/End jump; Esc clears input and resets the cursor", async () => {
    // NOTE: reply needle must be unique — "ok" matches the "token: n/a"
    // status line on mount (and the "ok" input echo below). The submit
    // pipeline (SUBMIT_PIPELINE_STAGES in src/App.tsx, pinned by
    // tests/submit-order.test.ts) runs async context-assembly + loop-entry
    // (skill discovery) before the first POST, so wait for the loop-entry
    // reply + POST, not the status line. Submitted content stays "ok".
    const calls = mockChatReply("ok-cursor-home-end-xyz");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      await waitForFrame(app, "hello");
      app.stdin.write(HOME);
      await sleep(40);
      // X landing at the front proves the cursor jumped to 0.
      app.stdin.write("X");
      await waitForFrame(app, "Xhello");
      app.stdin.write(ENDK);
      await sleep(40);
      // Y landing at the back proves the cursor jumped to the end.
      app.stdin.write("Y");
      await waitForFrame(app, "XhelloY");
      // Lone ESC after arrows needs a beat so it isn't parsed as part of an
      // escape sequence.
      await sleep(80);
      app.stdin.write(ESC);
      await waitForFrameAbsent(app, "XhelloY");
      // Cursor reset: typing after a clear starts a fresh line at the end.
      // Distinctive text: bare "ok" would match the status line.
      app.stdin.write("ok7");
      await waitForFrame(app, "ok7");
      expect(app.lastFrame()).not.toContain("XhelloYok7");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-cursor-home-end-xyz");
      await waitForPosts(calls, 1);
      const messages = calls[0]?.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages.at(-1)).toEqual({ role: "user", content: "ok7" });
    } finally {
      app.unmount();
    }
  });
});

describe("ATOM> prefix + wire roles", () => {
  test("committed assistant lines read ATOM>; payloads still use assistant", async () => {
    // NOTE: "hello back" is already a unique loop-entry reply needle (never
    // the "token: n/a" status line). The submit pipeline
    // (SUBMIT_PIPELINE_STAGES in src/App.tsx, pinned by
    // tests/submit-order.test.ts) runs async context-assembly + loop-entry
    // (skill discovery) before the first POST, so the frame wait below is a
    // POST wait, and the second turn explicitly waits for POST #2.
    const calls = mockChatReply("hello back");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "hello back");
      await waitForPosts(calls, 1);
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("ATOM>");
      expect(frame).not.toContain("bot>");
      // Wire format untouched: the next POST carries the committed turn as
      // {role:"assistant", ...} (never "ATOM").
      app.stdin.write("again");
      app.stdin.write("\r");
      {
        const start = Date.now();
        for (;;) {
          if (calls.length >= 2) break;
          if (Date.now() - start > 5000) {
            throw new Error("timed out waiting for the second POST");
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      expect(calls).toHaveLength(2);
      const messages = calls[1]?.messages as Array<{
        role: string;
        content: string;
      }>;
      // Stable-prefix split: [stable, dynamic env] system heads, then the
      // committed turns ride unchanged.
      expect(messages.map((m) => m.role)).toEqual([
        "system",
        "system",
        "user",
        "assistant",
        "user",
      ]);
      expect(messages[3]).toEqual({
        role: "assistant",
        content: "hello back",
      });
      expect(messages.some((m) => m.role === "ATOM")).toBe(false);
    } finally {
      app.unmount();
    }
  });

  test("streaming draft prefix reads ATOM> too", async () => {
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
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      // NOTE: the first POST runs after the submit pipeline's async
      // context-assembly (env refresh) + loop-entry (skill discovery) stages
      // (SUBMIT_PIPELINE_STAGES in src/App.tsx, pinned by
      // tests/submit-order.test.ts), so the fetch mock (which captures the
      // stream controller) has not run yet here — wait for the loop-entry
      // POST before driving the stream (same pattern as
      // tests/observability.test.tsx).
      {
        const start = Date.now();
        for (;;) {
          if (controller !== undefined) break;
          if (Date.now() - start > 8000) {
            throw new Error(`timed out waiting for first POST:\n${app.lastFrame()}`);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "draft-bit" } }] })}\n\n`)
      );
      await waitForFrame(app, "draft-bit");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("ATOM>");
      expect(frame).not.toContain("bot>");
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
      await waitForFrame(app, "draft-bit");
    } finally {
      app.unmount();
    }
  });
});
