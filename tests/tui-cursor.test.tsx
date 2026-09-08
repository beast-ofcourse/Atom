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
    const calls = mockChatReply("ok");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      await waitForFrame(app, "hello█");
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(LEFT);
      await sleep(40);
      await waitForFrame(app, "hel█lo");
      app.stdin.write("X");
      await waitForFrame(app, "helX█lo");
      app.stdin.write("\r");
      await waitForFrame(app, "ok");
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
    const calls = mockChatReply("ok");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      await waitForFrame(app, "hello█");
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(LEFT);
      await sleep(40);
      await waitForFrame(app, "hel█lo");
      app.stdin.write(BS);
      await waitForFrame(app, "he█lo");
      app.stdin.write(RIGHT);
      await waitForFrame(app, "hel█o");
      app.stdin.write(DEL);
      await waitForFrame(app, "hel█");
      expect(app.lastFrame()).not.toContain("helo");
      app.stdin.write("\r");
      await waitForFrame(app, "ok");
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
    const calls = mockChatReply("ok");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      await waitForFrame(app, "hi█");
      // Past the start: extra left is a no-op.
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(LEFT);
      await sleep(40);
      app.stdin.write(LEFT);
      await sleep(40);
      await waitForFrame(app, "█hi");
      // Backspace at 0 is a no-op.
      app.stdin.write(BS);
      await sleep(40);
      await waitForFrame(app, "█hi");
      // Past the end: extra right is a no-op.
      app.stdin.write(RIGHT);
      await sleep(40);
      app.stdin.write(RIGHT);
      await sleep(40);
      app.stdin.write(RIGHT);
      await sleep(40);
      await waitForFrame(app, "hi█");
      // Delete at end is a no-op.
      app.stdin.write(DEL);
      await sleep(40);
      await waitForFrame(app, "hi█");
      app.stdin.write("\r");
      await waitForFrame(app, "ok");
      const messages = calls[0]?.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages.at(-1)).toEqual({ role: "user", content: "hi" });
    } finally {
      app.unmount();
    }
  });

  test("Home/End jump; Esc clears input and resets the cursor", async () => {
    const calls = mockChatReply("ok");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      await waitForFrame(app, "hello█");
      app.stdin.write(HOME);
      await waitForFrame(app, "█hello");
      app.stdin.write("X");
      await waitForFrame(app, "X█hello");
      app.stdin.write(ENDK);
      await waitForFrame(app, "Xhello█");
      app.stdin.write("Y");
      await waitForFrame(app, "XhelloY█");
      // Lone ESC after arrows needs a beat so it isn't parsed as part of an
      // escape sequence.
      await sleep(80);
      app.stdin.write(ESC);
      await waitForFrameAbsent(app, "XhelloY");
      // Cursor reset: typing after a clear starts a fresh line at the end.
      app.stdin.write("ok");
      await waitForFrame(app, "ok█");
      expect(app.lastFrame()).not.toContain("XhelloYok");
      app.stdin.write("\r");
      await waitForFrame(app, "ok");
      const messages = calls[0]?.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages.at(-1)).toEqual({ role: "user", content: "ok" });
    } finally {
      app.unmount();
    }
  });
});

describe("ATOM> prefix + wire roles", () => {
  test("committed assistant lines read ATOM>; payloads still use assistant", async () => {
    const calls = mockChatReply("hello back");
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "hello back");
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
      expect(messages.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
      ]);
      expect(messages[2]).toEqual({
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
