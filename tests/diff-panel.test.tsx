// /diff session review: pure grouping + the panel itself + App-level wiring
// (slash command → list ⇄ detail, paging, guards, empty state).
// Network ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { DiffPanel, groupSessionDiffs, type SessionFileDiff } from "../src/ui/diff-panel.js";
import { waitForFrame, waitForFrameAbsent } from "./helpers/wait-for-frame.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("groupSessionDiffs", () => {
  test("latest preview per path wins, first-seen path order kept", () => {
    const files = groupSessionDiffs([
      { diff: { oldText: null, newText: "b1", lang: null, path: "b.ts" } },
      { diff: { oldText: "a", newText: "a2", lang: null, path: "a.ts" } },
      { diff: { oldText: "a", newText: "a3", lang: null, path: "a.ts" } },
      // Ungroupable (no path) and diff-less turns are skipped, never crash.
      { diff: { oldText: "x", newText: "y", lang: null, path: null } },
      {},
    ]);
    expect(files.map((f) => f.path)).toEqual(["b.ts", "a.ts"]);
    expect(files[1]!.newText).toBe("a3");
  });

  test("counts come from the engine", () => {
    const files = groupSessionDiffs([
      { diff: { oldText: "a\nb", newText: "a\nB", lang: null, path: "x.ts" } },
    ]);
    expect(files[0]!.adds).toBe(1);
    expect(files[0]!.dels).toBe(1);
  });
});

describe("DiffPanel", () => {
  const files: SessionFileDiff[] = [
    { path: "src/a.ts", oldText: "OLD_A", newText: "NEW_A", lang: null, adds: 1, dels: 1 },
    { path: "src/b.ts", oldText: null, newText: "hello", lang: null, adds: 1, dels: 0 },
  ];

  test("list shows every file with counts and the controls", () => {
    const frame = stripAnsi(frameOf(<DiffPanel files={files} index={1} expanded={false} />));
    expect(frame).toContain("Session changes");
    expect(frame).toContain("src/a.ts");
    expect(frame).toContain("src/b.ts");
    expect(frame).toContain("+1 −1");
    expect(frame).toContain("Enter expands");
  });

  test("detail renders the diff and names the scroll keys", () => {
    const frame = stripAnsi(frameOf(<DiffPanel files={files} index={0} expanded columns={100} />));
    expect(frame).toContain("@@");
    expect(frame).toContain("OLD_A");
    expect(frame).toContain("NEW_A");
    expect(frame).toContain("PgUp/PgDn scroll");
  });

  test("empty session renders the empty state", () => {
    const frame = stripAnsi(frameOf(<DiffPanel files={[]} index={0} expanded={false} />));
    expect(frame).toContain("no file changes this session");
  });
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

describe("/diff in the app", () => {
  test("no file changes reports the empty state instead of opening", async () => {
    mockChatScriptMessages([textMsg("plain-turn")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hello");
      app.stdin.write("\r");
      await waitForFrame(app, "plain-turn");
      app.stdin.write("/diff");
      app.stdin.write("\r");
      await waitForFrame(app, "no file changes this session");
      expect(app.lastFrame()).not.toContain("Session changes");
    } finally {
      app.unmount();
    }
  });

  test("approved write lists the file, expands its diff, Esc collapses then closes", async () => {
    const probe = "diff-panel-probe.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "v1\nv2 changed" }),
      textMsg("diff-panel-done"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\r");
      await waitForFrame(app, "diff-panel-done");

      app.stdin.write("/diff");
      app.stdin.write("\r");
      await waitForFrame(app, "Session changes");
      const list = app.lastFrame() ?? "";
      expect(list).toContain(probe);
      expect(list).toContain("+2");

      // Enter expands to the diff detail (the list header is gone).
      app.stdin.write("\r");
      await waitForFrame(app, "PgUp/PgDn scroll");
      const detail = app.lastFrame() ?? "";
      expect(detail).toContain("@@");
      expect(detail).toContain("v2 changed");
      expect(detail).not.toContain("Session changes");

      // Esc collapses back to the list, a second Esc closes the panel.
      app.stdin.write(String.fromCharCode(27));
      await waitForFrame(app, "Session changes");
      app.stdin.write(String.fromCharCode(27));
      await waitForFrameAbsent(app, "Session changes");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("Ctrl+C closes the panel instead of exiting the app", async () => {
    const probe = "diff-panel-ctrlc.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "v1" }),
      textMsg("ctrlc-done"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\r");
      await waitForFrame(app, "ctrlc-done");

      app.stdin.write("/diff");
      app.stdin.write("\r");
      await waitForFrame(app, "Session changes");

      app.stdin.write("\u0003");
      await waitForFrameAbsent(app, "Session changes");
      // The TUI is still running: the composer and its status line remain.
      const after = app.lastFrame() ?? "";
      expect(after).toContain("/model");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("a long diff pages instead of growing the footer", async () => {
    const probe = "diff-panel-paged.txt";
    await cleanProbes(probe);
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: lines.join("\n") }),
      textMsg("paged-done"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write a lot");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\r");
      await waitForFrame(app, "paged-done");

      app.stdin.write("/diff");
      app.stdin.write("\r");
      await waitForFrame(app, "Session changes");
      app.stdin.write("\r"); // expand
      await waitForFrame(app, "more rows");
      const first = app.lastFrame() ?? "";
      // 60 rows with a 20-row viewport: everything below the window is named,
      // and nothing scrolled off above yet.
      expect(first).toContain("40 more rows");
      // No "↑ N more rows" indicator above the window (the `↑/↓` in the hint
      // line is the file selector, not the scroll indicator).
      expect(first).not.toMatch(/^↑ \d+ more row/m);
      expect(first).toContain("PgUp/PgDn scroll");

      // One page down: the window moves, so the view reports what is above it.
      app.stdin.write("\u001B[6~");
      await waitForFrame(app, "↑ 20 more rows");
      const scrolled = app.lastFrame() ?? "";
      expect(scrolled).toContain("20 more rows");
      // Paging must not leak into the transcript scrollback behind the panel.
      expect(scrolled).toContain("PgUp/PgDn scroll");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});
