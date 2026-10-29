// Controlled repaint guards (plan tui-resize-theme-layout Phase 3).
//
// The contract: the only full repaint in the process is ours — one atomic
// ESC[2J ESC[1;1H write (never ESC[3J, which deletes terminal scrollback —
// V1/V4), the transcript re-admitted from index 0 by the clearGen bump so it
// re-wraps at the NEW width (V10), the footer intact (the frame rewrites in
// the same Ink render), and triggers collapsed to one clear per
// REPAINT_MIN_INTERVAL_MS.
//
// App-level byte assertions use the REAL Ink renderer on a fake TTY (same
// harness as tests/terminal-resize.test.tsx — ink-testing-library's stdout
// has no isTTY, so Ink's win32 clear path never arms there and [3J can never
// be observed). Dispatch/menu wiring that does not need byte-level evidence
// uses the ink-testing-library + baseProps pattern from
// tests/diff-panel.test.tsx. Network ALWAYS mocked — never live APIs.
import React from "react";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render as inkRender } from "ink";
import { render as inkTestRender } from "ink-testing-library";
import { App } from "../src/App.js";
import { TranscriptView, type Turn } from "../src/ui/transcript.js";
import {
  REPAINT_CLEAR,
  REPAINT_MIN_INTERVAL_MS,
  createRepaintWriter,
  repaintWindowFrom,
  shouldRepaint,
} from "../src/ui/repaint.js";
import { buildSlashMenu, filterSlashCommands } from "../src/ui/slash-menu.js";
import { waitForFrame } from "./helpers/wait-for-frame.js";

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
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  data: string | null = null;
  read(): string | null {
    const d = this.data;
    this.data = null;
    return d;
  }
  // Same shape as ink-testing-library's Stdin: a typed key reaches Ink's
  // input pipeline as a `data` event.
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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function countOf(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

// Poll the accumulated terminal bytes (the fake TTY appends every write).
// `strip` for prose needles; escape-sequence needles must poll the RAW bytes
// (`strip=false`) — stripAnsi's pattern removes ESC[2J itself, so a stripped
// poll for an escape sequence can never succeed (the Ctrl+L test timeout).
async function waitForText(
  stdout: FakeStdout,
  needle: string,
  timeout = 8000,
  strip = true,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const text = strip ? stripAnsi(stdout.text) : stdout.text;
    if (text.includes(needle)) return text;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
    }
    await sleep(10);
  }
}

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

function textMsg(content: string) {
  return { message: { content } };
}

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const instances: { unmount: () => void }[] = [];

function mountRealInk(
  stdout: FakeStdout,
  tree: React.ReactNode,
): { inst: ReturnType<typeof inkRender>; stdin: FakeStdin } {
  const stdin = new FakeStdin();
  const inst = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: false,
    incrementalRendering: true,
  });
  instances.push(inst);
  return { inst, stdin };
}

afterEach(() => {
  for (const inst of instances.splice(0)) inst.unmount();
});

// One completed turn: a long single-word user probe (85 columns — fits the
// 100-col mount width, wraps at 60) plus a distinct assistant answer. The
// user echo renders content verbatim (single Text, wrap is Ink's job), so
// the re-wrap proof rides a line we fully control.
async function completeOneTurn(stdout: FakeStdout) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [textMsg("atom-repaint-answer")] }),
  })) as unknown as typeof fetch;
  const { inst, stdin } = mountRealInk(stdout, <App {...baseProps()} />);
  await inst.waitUntilRenderFlush();
  stdin.write("u".repeat(80));
  stdin.write("\r");
  await waitForText(stdout, "you>");
  await waitForText(stdout, "atom-repaint-answer");
  await sleep(120); // turn end + trailing paints settle before the trial
  return { inst, stdin };
}

describe("repaint pure helpers", () => {
  test("shouldRepaint truth table", () => {
    expect(shouldRepaint({ columns: 100, rows: 24 }, { columns: 60, rows: 24 })).toBe(true);
    expect(shouldRepaint({ columns: 60, rows: 24 }, { columns: 100, rows: 24 })).toBe(false);
    expect(shouldRepaint({ columns: 100, rows: 24 }, { columns: 100, rows: 24 })).toBe(false);
    expect(shouldRepaint({ columns: 100, rows: 40 }, { columns: 100, rows: 24 })).toBe(false);
    // Overflow safety net: above the cap (⇔ >= viewport rows) repaints;
    // exactly at the cap (rows - 1) does not — Ink's branch is not armed.
    expect(shouldRepaint({ columns: 100, rows: 24 }, { columns: 100, rows: 24 }, 24)).toBe(true);
    expect(shouldRepaint({ columns: 100, rows: 24 }, { columns: 100, rows: 24 }, 23)).toBe(false);
    expect(shouldRepaint({ columns: 100, rows: 24 }, { columns: 100, rows: 24 }, 40)).toBe(true);
    // Growth with an overflowing frame still repaints (the arm is the hazard).
    expect(shouldRepaint({ columns: 60, rows: 24 }, { columns: 100, rows: 24 }, 40)).toBe(true);
  });

  test("REPAINT_CLEAR never contains ESC[3J", () => {
    expect(REPAINT_CLEAR).toBe("\x1b[2J\x1b[1;1H");
    expect(REPAINT_CLEAR.includes("\x1b[3J")).toBe(false);
  });

  test("repaintWindowFrom: full below the cap, tail of REPAINT_MAX_TURNS above", () => {
    expect(repaintWindowFrom(0)).toBe(0);
    expect(repaintWindowFrom(200)).toBe(0);
    expect(repaintWindowFrom(201)).toBe(1);
    expect(repaintWindowFrom(500)).toBe(300);
  });

  test("two triggers inside the interval collapse to one clear (injected clock)", () => {
    const writes: string[] = [];
    let t = 1000;
    const writer = createRepaintWriter({
      stdout: { write: (chunk) => void writes.push(chunk) },
      now: () => t,
    });
    expect(writer.write()).toBe(true);
    expect(writes).toEqual([REPAINT_CLEAR]);
    t += REPAINT_MIN_INTERVAL_MS - 1;
    expect(writer.write()).toBe(false); // 249 ms in: collapsed
    t += 1;
    expect(writer.write()).toBe(true); // exactly at 250 ms: writes again
    expect(writes).toHaveLength(2);
  });

  test("a re-entrant write inside a write collapses (no double clear)", () => {
    const writes: string[] = [];
    const writer = createRepaintWriter({
      stdout: {
        write: (chunk) => {
          writes.push(chunk);
          if (writes.length === 1) writer.write(); // re-entrant trigger
        },
      },
    });
    expect(writer.write()).toBe(true);
    expect(writes).toEqual([REPAINT_CLEAR]);
  });

  test("null stdout never writes and never claims a repaint", () => {
    const writer = createRepaintWriter({ stdout: null });
    expect(writer.write()).toBe(false);
  });
});

describe("controlled repaint on the real app", () => {
  test("resize after tall content: ESC[2J exactly once, never ESC[3J, footer intact", async () => {
    const stdout = new FakeStdout();
    const { inst, stdin } = await completeOneTurn(stdout);

    // Trial: a width-decreasing drag past the settle edge.
    stdout.text = "";
    stdout.columns = 60;
    stdout.emit("resize");
    await sleep(400); // settle (120 ms) + repaint + reprint flush
    await inst.waitUntilRenderFlush();

    expect(countOf(stdout.text, "\x1b[3J")).toBe(0);
    expect(countOf(stdout.text, "\x1b[2J")).toBe(1);
    // One atomic write: the clear bytes are contiguous.
    expect(stdout.text).toContain(REPAINT_CLEAR);
    // Footer rewrote with the reprint frame (dock pills, model segment).
    expect(stripAnsi(stdout.text)).toContain("model:");
  }, 20000);

  test("the reprint re-wraps at the NEW width only", async () => {
    const stdout = new FakeStdout();
    const { inst } = await completeOneTurn(stdout);

    // The original print at 100 columns: the probe row is one unbroken line.
    const before = stripAnsi(stdout.text);
    expect(before).toContain(`you> ${"u".repeat(80)}`);
    const originalProbes = countOf(before, `you> ${"u".repeat(80)}`);

    stdout.text = "";
    stdout.columns = 60;
    stdout.emit("resize");
    await sleep(400);
    await inst.waitUntilRenderFlush();

    const after = stripAnsi(stdout.text);
    // Only the pre-repaint scrollback holds the unwrapped row.
    expect(countOf(before, `you> ${"u".repeat(80)}`)).toBe(originalProbes);
    expect(after).not.toContain(`you> ${"u".repeat(80)}`);
    // At 60 columns the same logical line breaks: 60-char head, 25-char tail.
    expect(after).toContain(`you> ${"u".repeat(55)}\n${"u".repeat(25)}`);
  }, 20000);

  test("Ctrl+L repaints when idle, does nothing mid-stream", async () => {
    const stdout = new FakeStdout();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({ choices: [textMsg("atom-repaint-answer")] }),
      } as Response;
    }) as unknown as typeof fetch;
    const { inst, stdin } = mountRealInk(stdout, <App {...baseProps()} />);
    await inst.waitUntilRenderFlush();

    // Idle: Ctrl+L repaints. Escape-sequence needles poll RAW bytes.
    stdin.write("\x0c");
    await waitForText(stdout, "\x1b[2J", 8000, false);
    expect(countOf(stdout.text, "\x1b[2J")).toBe(1);
    expect(countOf(stdout.text, "\x1b[3J")).toBe(0);

    // Mid-stream (turn in flight): Ctrl+L must not repaint.
    stdin.write("hi");
    stdin.write("\r");
    await sleep(200); // POST in flight, live zone active
    stdin.write("\x0c");
    await sleep(150);
    expect(countOf(stdout.text, "\x1b[2J")).toBe(1);

    // Turn ends, idle again: Ctrl+L repaints once more.
    release();
    await waitForText(stdout, "atom-repaint-answer");
    await sleep(200); // turn-end transition settles before the next trial
    stdin.write("\x0c");
    // The two clears are never byte-adjacent (Ink writes frames between
    // them) — count on raw bytes instead of waiting for a contiguous pair.
    const start = Date.now();
    for (;;) {
      if (countOf(stdout.text, "\x1b[2J") >= 2) break;
      if (Date.now() - start > 8000) {
        throw new Error("second Ctrl+L produced no second repaint");
      }
      await sleep(10);
    }
    expect(countOf(stdout.text, "\x1b[3J")).toBe(0);
  }, 20000);

  test("repaint mid-stream does not duplicate rows", async () => {
    const stdout = new FakeStdout();
    // Turn 1 completes; turn 2 hangs mid-POST so the repaint lands while a
    // stream is active.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [textMsg("first-turn-probe")] }),
    })) as unknown as () => Promise<unknown>;
    const second = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({ choices: [textMsg("second-turn-probe")] }),
      } as Response;
    });
    const calls: (() => Promise<unknown>)[] = [first, second];
    globalThis.fetch = vi.fn(async () => {
      const next = calls.length > 1 ? calls.shift()! : calls[0]!;
      return next();
    }) as unknown as typeof fetch;
    const { inst, stdin } = mountRealInk(stdout, <App {...baseProps()} />);
    await inst.waitUntilRenderFlush();

    stdin.write("one");
    stdin.write("\r");
    await waitForText(stdout, "first-turn-probe");
    await sleep(150);

    stdin.write("two");
    stdin.write("\r");
    await sleep(200); // second POST in flight (active stream)

    // The settled width-decrease trigger fires mid-stream — exactly the
    // window where a trailing paint could duplicate rows.
    stdout.text = "";
    stdout.columns = 60;
    stdout.emit("resize");
    await sleep(400);
    await inst.waitUntilRenderFlush();
    expect(countOf(stdout.text, "\x1b[2J")).toBe(1);

    release();
    await waitForText(stdout, "second-turn-probe");
    await sleep(200);

    // first-turn-probe: post-reset bytes hold the clearGen reprint — exactly
    // one copy. 0 = the reprint lost the turn; >=2 = a duplicated row (the
    // pre-repaint scrollback copy is outside this accumulator by design —
    // stdout.text was reset before the repaint).
    const full = stripAnsi(stdout.text);
    expect(countOf(full, "first-turn-probe")).toBe(1);
    expect(countOf(full, "second-turn-probe")).toBe(1);
    expect(countOf(full, "\x1b[3J")).toBe(0);
  }, 20000);
});

describe("repaint tail window (D5 cost gate)", () => {
  const manyTurns = (n: number): Turn[] =>
    Array.from({ length: n }, (_, i) => ({
      role: "assistant" as const,
      content: `turnbody-${i}`,
    }));
  const renderView = (turns: Turn[], repaintFrom: number | null) => {
    const app = inkTestRender(
      <TranscriptView turns={turns} clearGen={0} repaintFrom={null} />,
    );
    // The controlled repaint is a clearGen BUMP on a live view (App's
    // repaint()): same turns, new gen. Mount with gen 0, then bump.
    app.rerender(
      <TranscriptView turns={turns} clearGen={1} repaintFrom={repaintFrom} />,
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    return stripAnsi(frame);
  };

  test("full reprint below the cap: every turn re-admits", () => {
    const frame = renderView(manyTurns(4), null);
    expect(frame).toContain("turnbody-0");
    expect(frame).toContain("turnbody-3");
    expect(frame).not.toContain("earlier history remains");
  });

  test("tail window above the cap: head turns skipped, dim notice printed", () => {
    // REPAINT_MAX_TURNS window start = turns.length - REPAINT_MAX_TURNS.
    const frame = renderView(manyTurns(6), 3);
    expect(frame).not.toContain("turnbody-0");
    expect(frame).not.toContain("turnbody-2");
    expect(frame).toContain("turnbody-3");
    expect(frame).toContain("turnbody-5");
    // The one dim line names where the earlier history went.
    expect(frame).toContain("earlier history remains in terminal scrollback");
  });
});

describe("/redraw registration and dispatch", () => {
  test("is in the slash registry and the menu lists it", () => {
    const exact = filterSlashCommands("/redraw");
    expect(exact).toHaveLength(1);
    expect(exact[0]!.name).toBe("/redraw");
    expect(exact[0]!.description.length).toBeGreaterThan(0);
    const menu = buildSlashMenu("/redraw", [], []);
    expect(menu.items[0]!.name).toBe("/redraw");
  });

  test("/redraw dispatches the controlled repaint", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [textMsg("unused")] }),
    })) as unknown as typeof fetch;
    const app = inkTestRender(<App {...baseProps()} />);
    try {
      app.stdin.write("/redraw");
      app.stdin.write("\r");
      const start = Date.now();
      for (;;) {
        if (app.stdout.frames.some((f) => f.includes("\x1b[2J"))) break;
        if (Date.now() - start > 8000) throw new Error("no repaint frame");
        await sleep(10);
      }
      expect(
        app.stdout.frames.filter((f) => f.includes("\x1b[2J")),
      ).toHaveLength(1);
      expect(app.stdout.frames.some((f) => f.includes("\x1b[3J"))).toBe(false);
      // The clearGen bump re-follows the (empty) transcript: the app is
      // still alive and the composer renders after the repaint.
      await waitForFrame(app as never, "model:");
    } finally {
      app.unmount();
    }
  });

  test("two /redraw dispatches inside the interval produce one clear", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [textMsg("unused")] }),
    })) as unknown as typeof fetch;
    const app = inkTestRender(<App {...baseProps()} />);
    try {
      app.stdin.write("/redraw");
      app.stdin.write("\r");
      app.stdin.write("/redraw");
      app.stdin.write("\r");
      const start = Date.now();
      for (;;) {
        if (app.stdout.frames.some((f) => f.includes("\x1b[2J"))) break;
        if (Date.now() - start > 8000) throw new Error("no repaint frame");
        await sleep(10);
      }
      await sleep(150);
      expect(
        app.stdout.frames.filter((f) => f.includes("\x1b[2J")),
      ).toHaveLength(1);
    } finally {
      app.unmount();
    }
  });
});
