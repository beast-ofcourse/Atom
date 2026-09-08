// Ticket 01 (/rewind) TUI: the picker lists session checkpoints and restores
// through the real App (idle-only, same probe style as the ticket-03 rules
// tests: probes under cwd, cleaned up each test).
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { readFile, rm, writeFile } from "node:fs/promises";
import { App } from "../src/App.js";
import { clearSnapshots, listCheckpoints } from "../src/snapshots.js";

const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

const realFetch = globalThis.fetch;

beforeEach(() => {
  clearSnapshots();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  clearSnapshots();
});

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
  timeout = 5000
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
    initialModels: MODELS,
  };
}

async function cleanProbes(...probes: string[]) {
  for (const p of probes) {
    try {
      await rm(p, { force: true });
    } catch {
      // ignore
    }
  }
}

describe("/rewind picker", () => {
  test("empty session reports no checkpoints", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/rewind");
      app.stdin.write("\r");
      await waitForFrame(app, "(no checkpoints yet");
    } finally {
      app.unmount();
    }
  });

  test("files-only restore returns exact bytes, conversation keeps flowing", async () => {
    const probe = "rewind-probe-ui-files.txt";
    await cleanProbes(probe);
    await writeFile(probe, "v1", "utf8");
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "v2" }),
      textMsg("written"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/allow write:rewind-probe-ui-files.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "allowed: write:rewind-probe-ui-files.txt");
      app.stdin.write("please write it");
      app.stdin.write("\r");
      await waitForFrame(app, "written");
      expect(await readFile(probe, "utf8")).toBe("v2");
      expect(listCheckpoints().length).toBeGreaterThan(0);
      // Picker lists the checkpoint, scope defaults to files only.
      app.stdin.write("/rewind");
      app.stdin.write("\r");
      await waitForFrame(app, "Rewind to checkpoint");
      app.stdin.write("\r");
      await waitForFrame(app, "Rewind scope");
      app.stdin.write("\r");
      await waitForFrame(app, "(rewound 1 file(s) to checkpoint");
      expect(await readFile(probe, "utf8")).toBe("v1");
      // Files-only: the committed turn is still in the transcript.
      expect(app.lastFrame()).toContain("written");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("files + conversation restores bytes and drops the checkpoint turn", async () => {
    const probe = "rewind-probe-ui-both.txt";
    await cleanProbes(probe);
    await writeFile(probe, "before", "utf8");
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "after" }),
      textMsg("turn-done-marker"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/allow write:rewind-probe-ui-both.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "allowed: write:rewind-probe-ui-both.txt");
      app.stdin.write("please write it");
      app.stdin.write("\r");
      await waitForFrame(app, "turn-done-marker");
      app.stdin.write("/rewind");
      app.stdin.write("\r");
      await waitForFrame(app, "Rewind to checkpoint");
      app.stdin.write("\r");
      await waitForFrame(app, "Rewind scope");
      // Down once: "files + conversation".
      app.stdin.write("\u001B[B");
      app.stdin.write("\r");
      await waitForFrame(app, "(rewound 1 file(s) to checkpoint");
      await waitForFrame(app, "(rewound conversation to checkpoint");
      expect(await readFile(probe, "utf8")).toBe("before");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("Esc cancels the picker without touching files", async () => {
    const probe = "rewind-probe-ui-esc.txt";
    await cleanProbes(probe);
    await writeFile(probe, "kept", "utf8");
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "changed" }),
      textMsg("done-marker"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/allow write:rewind-probe-ui-esc.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "allowed: write:rewind-probe-ui-esc.txt");
      app.stdin.write("please write it");
      app.stdin.write("\r");
      await waitForFrame(app, "done-marker");
      app.stdin.write("/rewind");
      app.stdin.write("\r");
      await waitForFrame(app, "Rewind to checkpoint");
      app.stdin.write("\u001B");
      // Give the Esc render a beat, then verify nothing was restored.
      await new Promise((r) => setTimeout(r, 200));
      expect(await readFile(probe, "utf8")).toBe("changed");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});
