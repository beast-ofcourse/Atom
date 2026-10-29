// Guard: a resize must never wipe terminal scrollback — in the PRODUCT.
//
// Ink's win32 clear path (`shouldClearTerminalForFrame`, ink/build/ink.js)
// writes `clearTerminal` when a frame height reaches the viewport rows — and
// `clearTerminal` contains ESC[3J, which deletes the terminal's scrollback
// history, then replays the entire accumulated static output at the OLD width
// (plan V1-V4). Phase 1 (frame containment) keeps the frame under the cap;
// Phase 3 (controlled repaint) owns the only full repaint (ESC[2J, no [3J).
//
// Originally this guard mounted a raw TallFrame probe; a probe bypasses
// AppShell, so the product's containment could never apply to it and the
// assertion could only fail forever. Re-pointed at the real App (equal-or-
// stronger: it exercises containment + the controlled repaint together).
// Scope note: the documented Phase 1 residual states (provider picker, /diff
// panel — App lifts the cap there) are the plan's Phase 8 subject; this guard
// covers the default states.
import React from "react";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render as inkRender } from "ink";
import { App } from "../src/App.js";

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  text = "";
  write(chunk: unknown): boolean {
    this.text += String(chunk);
    return true;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    const d = this.data;
    this.data = null;
    return d;
  }
  // Same shape as ink-testing-library's Stdin: a typed key reaches Ink's
  // input pipeline as a `data` event (tests/repaint.test.tsx harness).
  write(data: string): void {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  }
}

class FakeStderr extends EventEmitter {
  write(): boolean {
    return true;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function countOf(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// One completed turn whose answer is taller than the 24-row viewport —
// tall content is the shape that arms Ink's win32 clear path (V3, V11).
// Mount/wait shape mirrors tests/repaint.test.tsx completeOneTurn exactly.
async function mountWithTallTurn(stdout: FakeStdout) {
  const answer = Array.from({ length: 40 }, (_, i) => `tall-${i}`).join("\n");
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: answer } }] }),
  })) as unknown as typeof fetch;
  const stdin = new FakeStdin();
  const inst = inkRender(
    <App
      apiKey="test-key"
      endpoint={ENDPOINT}
      initialModel="big-pickle"
      initialModels={["big-pickle"]}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: false,
      incrementalRendering: true,
    },
  );
  await inst.waitUntilRenderFlush();
  stdin.write("u".repeat(80));
  stdin.write("\r");
  const start = Date.now();
  for (;;) {
    if (stdout.text.includes("tall-39")) break;
    if (Date.now() - start > 8000) throw new Error("tall turn never committed");
    await sleep(10);
  }
  await sleep(150); // commit + trailing paints settle
  return { inst, stdin };
}

function resettle(stdout: FakeStdout, columns: number, rows: number): void {
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.emit("resize");
}

const instances: { unmount: () => void }[] = [];

afterEach(() => {
  for (const inst of instances.splice(0)) inst.unmount();
});

describe("resize must not wipe scrollback", () => {
  test("no ESC[3J across width-decrease and width-increase resizes", async () => {
    const stdout = new FakeStdout();
    const { inst } = await mountWithTallTurn(stdout);
    instances.push(inst);

    // Drop the mount output: only what the RESIZES produce is on trial.
    stdout.text = "";

    // Width decreases (settled) — the controlled repaint path.
    resettle(stdout, 60, 20);
    const start = Date.now();
    for (;;) {
      if (stdout.text.includes("\x1b[2J")) break;
      if (Date.now() - start > 8000) throw new Error("no controlled repaint");
      await sleep(10);
    }
    await inst.waitUntilRenderFlush();
    await sleep(80);

    // And a width increase (the path Ink never clears) plus an upsized
    // viewport — neither may arm the destructive branch.
    resettle(stdout, 100, 30);
    await inst.waitUntilRenderFlush();
    await sleep(120);

    // The one hard assertion: the scrollback-destroying sequence is never
    // written. ESC[2J (viewport erase without history loss) is ours.
    expect(stdout.text).not.toContain("\x1b[3J");
    expect(countOf(stdout.text, "\x1b[2J")).toBeGreaterThanOrEqual(1);
  }, 20000);
});
