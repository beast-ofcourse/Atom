// Render-stability regression tests: one render root, no direct stdout
// writes, memoized status props, and windowed live/approval surfaces —
// the structural guarantees that keep terminal rendering flicker-free.
// Network ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import * as fs from "node:fs";
import * as path from "node:path";
import { App } from "../src/App.js";
import { LiveTail, LIVE_THINKING_LINES } from "../src/ui/live-tail.js";
import { ApprovalBox, APPROVAL_DIFF_MAX_LINES } from "../src/ui/modals.js";
import { statusBarRenderProbe } from "../src/ui/status-bar.js";

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

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkSrc(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("single stdout pipeline", () => {
  test("no component writes directly to stdout; console stays in pre-TUI cli paths", () => {
    const root = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    for (const file of walkSrc(root)) {
      const text = fs.readFileSync(file, "utf8");
      const rel = path.relative(root, file);
      if (/process\.stdout\.write|process\.stderr\.write/.test(text)) {
        offenders.push(`${rel}: direct stream write`);
      }
      // cli.tsx may print before the TUI boots (--help/--dashboard/--serve,
      // all of which exit before render()). Anywhere else, console output
      // would bypass Ink's frame diffing and tear the screen.
      if (rel !== "cli.tsx" && /console\.(log|warn|error|debug|info)\s*\(/.test(text)) {
        offenders.push(`${rel}: console output outside cli.tsx`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("status bar prop stability", () => {
  test("approval preview window is bounded (display-only; engine uncapped)", () => {
    expect(APPROVAL_DIFF_MAX_LINES).toBeLessThan(Infinity);
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    const frame = stripAnsi(
      frameOf(
        <ApprovalBox
          toolName="write"
          description="⚙ write big.ts"
          selected={0}
          diff={{ oldText: null, newText: lines.join("\n"), lang: null, path: "big.ts" }}
        />
      )
    );
    // Windowed with a trailer — the modal never grows into fullscreen
    // full-clear territory; the transcript carries the whole diff.
    expect(frame).toContain("more row");
    expect(frame).not.toContain("line-199");
    expect(frame).toContain("Full diff renders in the transcript on approve.");
  });
});

describe("live thinking window", () => {
  const base = {
    isEmpty: false,
    sessionHint: false,
    draft: null,
    busy: true,
    elapsedSecs: 3,
    toolHint: null,
    toolElapsedSecs: null,
  } as const;

  test("long reasoning shows the tail with an indicator, never the whole stream", () => {
    const lines = Array.from({ length: LIVE_THINKING_LINES + 10 }, (_, i) => `thought-${i}`);
    const frame = stripAnsi(
      frameOf(<LiveTail {...base} thinking={lines.join("\n")} showThinking />)
    );
    expect(frame).toContain(`thought-${lines.length - 1}`);
    expect(frame).not.toContain("thought-0");
    expect(frame).toContain("…");
  });

  test("short reasoning renders whole (no indicator)", () => {
    const frame = stripAnsi(frameOf(<LiveTail {...base} thinking="brief musing" showThinking />));
    expect(frame).toContain("brief musing");
    expect(frame).not.toContain("…");
  });
});

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

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

describe("goal-active status stability", () => {
  test("keystrokes skip the status bar while a goal is set (memoized goal slice)", async () => {
    const app = render(
      <App
        apiKey="test-key"
        endpoint={ENDPOINT}
        initialModel="big-pickle"
        initialModels={["big-pickle"]}
      />
    );
    try {
      app.stdin.write("/goal Ship it");
      await new Promise((r) => setTimeout(r, 40));
      app.stdin.write("\r");
      await waitForFrame(app, "goal set");
      // Settle: let mount-time background renders flush first.
      await new Promise((r) => setTimeout(r, 200));
      const base = statusBarRenderProbe.count;
      app.stdin.write("zxq");
      await waitForFrame(app, "zxq");
      await new Promise((r) => setTimeout(r, 120));
      // The keystroke re-renders App (input), but the memoized goal slice
      // keeps its identity, so the status subtree bails out entirely.
      expect(statusBarRenderProbe.count).toBe(base);
    } finally {
      app.unmount();
    }
  });
});
