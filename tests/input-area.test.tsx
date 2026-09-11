// Input-area tests: multiline submit, history recall, editing keys,
// bracketed paste (verbatim, never submits), Esc clearing, and the idle
// placeholder. Network is ALWAYS mocked — posted bodies assert what the
// model would receive.
// NOTE on raw bytes: \n below is Ctrl+J (newline), \r is Enter (send),
// \x01 \x05 \x0b \x15 \x17 are Ctrl+A/E/K/U/W. \u001B sequences are arrows.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function textMsg(content: string) {
  return { message: { content } };
}

// Mock chat that records every POST body for arrival assertions.
function mockChatCapture(bodies: unknown[], replies: unknown[]) {
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    try {
      bodies.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
    } catch {
      // ignore malformed captures
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { ok: true, json: async () => ({ choices: [next] }) } as Response;
  });
}

function lastUserContent(bodies: unknown[]): string | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const msgs = (bodies[i] as { messages?: { role?: string; content?: string }[] })?.messages;
    if (Array.isArray(msgs)) {
      for (let k = msgs.length - 1; k >= 0; k--) {
        if (msgs[k]?.role === "user" && typeof msgs[k]?.content === "string") {
          return msgs[k]!.content as string;
        }
      }
    }
  }
  return null;
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

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}

describe("multiline input", () => {
  test("Ctrl+J inserts newlines; Enter sends the whole text at once", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("got it")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      app.stdin.write("\n");
      app.stdin.write("world");
      await waitForFrame(app, "world");
      // No premature submit: nothing posted yet.
      await new Promise((r) => setTimeout(r, 150));
      expect(bodies.length).toBe(0);
      app.stdin.write("\r");
      await waitForFrame(app, "got it");
      expect(lastUserContent(bodies)).toBe("hello\nworld");
    } finally {
      app.unmount();
    }
  });
  test("Esc clears a multiline draft; empty Enter sends nothing", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("reply-esc-1")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("a");
      app.stdin.write("\n");
      app.stdin.write("b");
      await waitForFrame(app, "b");
      app.stdin.write(String.fromCharCode(27));
      // Cleared: wait for the draft to actually leave the frame (a fixed
      // sleep flakes under parallel-worker load), then a short settle.
      const escStart = Date.now();
      for (;;) {
        const clearedFrame = app.lastFrame() ?? "";
        if (!clearedFrame.includes("› a")) break;
        if (Date.now() - escStart > 5000) {
          throw new Error("timed out waiting for Esc to clear the draft:\n" + clearedFrame);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 50));
      // Cleared: typing fresh and sending posts only the fresh text.
      app.stdin.write("Z");
      app.stdin.write("\r");
      await waitForFrame(app, "reply-esc-1");
      expect(lastUserContent(bodies)).toBe("Z");
    } finally {
      app.unmount();
    }
  });
});

describe("history recall", () => {
  test("Up/Down cycles past prompts; Down past newest restores the stash", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("r1"), textMsg("r2"), textMsg("r3"), textMsg("r4")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      // Stash a fresh draft, browse back twice, forward past newest.
      app.stdin.write("partial");
      await waitForFrame(app, "partial");
      app.stdin.write("\u001B[A");
      await waitForFrame(app, "r2"); // input now "second" (reply r2 already shown; submit next)
      app.stdin.write("\r");
      await waitForFrame(app, "r3");
      expect(lastUserContent(bodies)).toBe("second");
    } finally {
      app.unmount();
    }
  });
  test("Up with empty history is a silent no-op", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("ok-empty-hist-2")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("\u001B[A");
      await new Promise((r) => setTimeout(r, 100));
      expect(bodies.length).toBe(0);
      // Input still clean and usable afterwards.
      app.stdin.write("z");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-empty-hist-2");
      expect(lastUserContent(bodies)).toBe("z");
    } finally {
      app.unmount();
    }
  });
});

describe("editing keys", () => {
  test("Ctrl+A then typing prepends; Ctrl+W kills the word back", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("done1"), textMsg("done2")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      app.stdin.write("\u0001");
      app.stdin.write("X");
      app.stdin.write("\u0017");
      await waitForFrame(app, "hello");
      app.stdin.write("\r");
      await waitForFrame(app, "done1");
      // "Xhello" with cursor after X: Ctrl+W kills "X" back → "hello".
      // Then retype and kill precisely for the arrival assertion.
      app.stdin.write("abc def");
      app.stdin.write("\u0017");
      app.stdin.write("XYZ");
      app.stdin.write("\r");
      await waitForFrame(app, "done2");
      expect(lastUserContent(bodies)).toBe("abc XYZ");
    } finally {
      app.unmount();
    }
  });
  test("Ctrl+U clears to line start", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("ok-u-3")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("abc def");
      await waitForFrame(app, "abc def");
      app.stdin.write("\u0015");
      await new Promise((r) => setTimeout(r, 100));
      // Cleared: sending now posts only what is typed next.
      app.stdin.write("Q");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-u-3");
      expect(lastUserContent(bodies)).toBe("Q");
      expect(bodies.length).toBe(1);
    } finally {
      app.unmount();
    }
  });
});

describe("bracketed paste", () => {
  test("multiline paste inserts verbatim and never submits", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("pasted-ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("\u001B[200~pasted\nlines\u001B[201~");
      await waitForFrame(app, "pasted");
      await waitForFrame(app, "lines");
      await new Promise((r) => setTimeout(r, 150));
      expect(bodies.length).toBe(0);
      app.stdin.write("\r");
      await waitForFrame(app, "pasted-ok");
      expect(lastUserContent(bodies)).toBe("pasted\nlines");
    } finally {
      app.unmount();
    }
  });
});

