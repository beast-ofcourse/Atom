// Approved-write diff attach, current rendering (uncapped-diff era).
//
// Same flow as the stale "approved write in a multi-tool turn still attaches
// its diff" case, but pinned to the current pane shape: the DiffSummary line
// (`new file +N −M · path`) plus side-by-side rows, not BEFORE/AFTER pane
// headers (those labels are gone; stale suites assert them and fail).
// Network ALWAYS mocked.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

function toolMsg(id: string, name: string, args: Record<string, unknown>) {
  return {
    message: {
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
  };
}
function textMsg(content: string) {
  return { message: { content } };
}
function mockChatScriptMessages(messages: unknown[]) {
  const queue = [...messages];
  globalThis.fetch = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { ok: true, json: async () => ({ choices: [next] }) } as Response;
  });
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
async function cleanProbes(...probes: string[]) {
  const { rm } = await import("node:fs/promises");
  for (const p of probes) {
    try {
      await rm(p, { force: true });
    } catch {
      // ignore
    }
  }
}

describe("approved write attaches its diff (current rendering)", () => {
  test("write + read commits summary header, pane rows, and ordered audit lines", async () => {
    const probe = "current-probe-write.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hello current" }),
      toolMsg("c2", "read", { path: probe }),
      textMsg("current-diff-complete"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it then read it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\r"); // [y]es once
      await waitForFrame(app, "current-diff-complete");
      const frame = app.lastFrame() ?? "";
      // Audit line plus the current summary shape for a new file.
      expect(frame).toContain("⚙ write");
      expect(frame).toContain("new file");
      expect(frame).toContain("+1");
      expect(frame).toContain("hello current");
      // The follow-up read commits its own audit line after the write.
      expect(frame).toContain("⚙ read");
      expect(frame.indexOf("⚙ read")).toBeGreaterThan(frame.indexOf("⚙ write"));
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});
