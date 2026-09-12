// TUI consumes the TurnEvents sink: multi-tool turns commit byte-identical
// transcript lines (audit labels, todo echo, error cards, diff attach) via
// structured tool identity instead of label parsing. These tests pin the
// exact lines the pre-change snapshots already assert — zero visible change.
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

describe("turn-events sink consumer (multi-tool transcript identity)", () => {
  test("read + todowrite + failing read commit identical lines in order", async () => {
    mockChatScriptMessages([
      toolMsg("c1", "read", { path: "package.json" }),
      toolMsg("c2", "todowrite", { todos: [{ content: "sink-item", status: "pending" }] }),
      toolMsg("c3", "read", { path: "definitely-not-here-sink-12345.txt" }),
      textMsg("sink-turn-complete"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("run the sink turn");
      app.stdin.write("\r");
      await waitForFrame(app, "sink-turn-complete");
      const frame = app.lastFrame() ?? "";
      // Same audit lines the loop has always produced (label text untouched).
      expect(frame).toContain("⚙ read package.json");
      expect(frame).toContain("⚙ todowrite");
      // Todo echo rides the transcript via structured-name membership.
      expect(frame).toContain("sink-item");
      // Error card keeps its shape on the structured path (audit line +
      // the verbatim error detail).
      expect(frame).toContain("no such file or directory");
      // Commit order preserved across rounds (started/finished pairing).
      const readAt = frame.indexOf("⚙ read package.json");
      const todoAt = frame.indexOf("⚙ todowrite");
      const errAt = frame.indexOf("no such file or directory");
      const doneAt = frame.indexOf("sink-turn-complete");
      expect(readAt).toBeGreaterThanOrEqual(0);
      expect(todoAt).toBeGreaterThan(readAt);
      expect(errAt).toBeGreaterThan(todoAt);
      expect(doneAt).toBeGreaterThan(errAt);
    } finally {
      app.unmount();
    }
  });

  test("approved write in a multi-tool turn still attaches its diff", async () => {
    const probe = "sink-probe-write.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hello sink" }),
      toolMsg("c2", "read", { path: probe }),
      textMsg("sink-diff-complete"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it then read it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\r"); // [y]es once
      await waitForFrame(app, "sink-diff-complete");
      const frame = app.lastFrame() ?? "";
      // Diff slot consumed by structured identity: same committed diff.
      expect(frame).toContain("⚙ write");
      expect(frame).toContain("BEFORE");
      expect(frame).toContain("AFTER");
      expect(frame).toContain("hello sink");
      // The follow-up read commits its own audit line after the write.
      expect(frame).toContain("⚙ read");
      expect(frame.indexOf("⚙ read")).toBeGreaterThan(frame.indexOf("⚙ write"));
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});
