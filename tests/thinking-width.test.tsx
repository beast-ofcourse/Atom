// Thinking-block width regression tests (half-width layout fix).
//
// Regression: committed thinking always wrapped at ThinkingBlock's hardcoded
// 100-column fallback because the TranscriptView → Static → renderTranscriptItem
// chain never threaded a `columns` prop. On a 200-col terminal the block filled
// only half the width. Two guards pin the fix:
//   1. the pure wrapper wraps/chops in TERMINAL CELLS (displayWidth), so wide
//      glyphs (CJK/emoji) fill the line by display width instead of overflow;
//   2. ThinkingBlock measures the terminal itself (useTerminalSize) when its
//      caller passes no `columns`, so every renderer — committed transcript
//      included — wraps at the real width and re-wraps on resize.
//
// Component tests use the REAL Ink renderer against a fake TTY (the
// ink-testing-library stdout hardcodes `columns: 100`, which would mask the
// wide-terminal fill) — same harness as tests/terminal-resize.test.tsx.
import React from "react";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { render as inkRender } from "ink";
import { render as libRender } from "ink-testing-library";
import {
  ThinkingBlock,
  wrapWithPrefix,
} from "../src/ui/components/ThinkingBlock.js";
import { theme } from "../src/ui/theme.js";
import { displayWidth } from "../src/ui/diff-layout.js";

function stripAnsi(s: string): string {
  // Any CSI sequence (color codes AND cursor/erase control), not just `m`.
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns: number;
  rows = 24;
  text = "";
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
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
  read(): null {
    return null;
  }
}

class FakeStderr extends EventEmitter {
  write(): boolean {
    return true;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

type Terminal = ReturnType<typeof inkRender>;

const mounted: Terminal[] = [];

afterEach(() => {
  for (const inst of mounted.splice(0)) inst.unmount();
});

function mountThinking(content: string, columns: number) {
  const stdout = new FakeStdout(columns);
  const inst = inkRender(
    <ThinkingBlock content={content} variant="committed" />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: false,
      incrementalRendering: true,
    },
  );
  mounted.push(inst);
  return { inst, stdout };
}

// Rows of the stripped frame that paint thinking body text (every body row
// starts with the quoteBar prefix). The paint-only label line is excluded.
function bodyRows(frame: string): string[] {
  const quote = theme.symbol.quoteBar;
  return stripAnsi(frame)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.startsWith(quote));
}

const PREFIX = `${theme.symbol.quoteBar} `;

// One long single-source-line paragraph of distinct words — one logical
// line, no internal newlines, so wrapping at any terminal width is forced.
function paragraph(words: number, repeat = 1): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) parts.push(`word-${i}`);
  return parts.join(" ").repeat(repeat).trimEnd();
}

// ---- pure wrapper: terminal-cell measurements ------------------------------

describe("wrapWithPrefix display-width wrapping", () => {
  test("ASCII text fills the line to the requested width", () => {
    const width = 100;
    const rows = wrapWithPrefix(paragraph(200, 2), width, PREFIX);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(width);
    }
    // Dense fill: wrapped rows (not the last) reach within one word of the
    // line end — the wrap budget is pinned in terminal cells, where the
    // pre-fix hardcode simply stopped at 100 columns.
    const maxRow = Math.max(...rows.slice(0, -1).map(displayWidth));
    expect(maxRow).toBeGreaterThanOrEqual(width - 12);
  });

  test("CJK fills by display cells, never overflowing the width", () => {
    const width = 20;
    const text = Array.from({ length: 60 }, (_, i) => `汉${i}`).join(" ");
    const rows = wrapWithPrefix(text, width, PREFIX);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      // Two cells per CJK glyph: a UTF-16 length metric would let the row
      // extend double the budget. Rows must fit in CELLS.
      expect(displayWidth(row)).toBeLessThanOrEqual(width);
    }
  });

  test("emoji hard-breaks into intact full-width chunks", () => {
    const width = 10;
    // 12 emoji × 2 cells = 24 cells → 3 full chunks of the 8-cell budget.
    const rows = wrapWithPrefix("😀".repeat(12), width, PREFIX);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(width);
      // Chunks stay whole emoji: (row cells − prefix) is even.
      expect((displayWidth(row) - displayWidth(PREFIX)) % 2).toBe(0);
    }
  });

  test("surrogate pairs are never split on hard break", () => {
    const width = 6;
    // 4 cells per chunk budget: an astral emoji is 1 code point / 2 cells;
    // a UTF-16 chop would leave a lone high or low surrogate half behind.
    const rows = wrapWithPrefix("🌍".repeat(9), width, PREFIX);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const body = row.slice(PREFIX.length);
      expect([...body].length).toBe(displayWidth(body) / 2);
      for (const ch of body) {
        expect(ch.codePointAt(0)!).toBeGreaterThanOrEqual(0x1f000);
      }
    }
  });

  test("short lines keep spacing but never carry filler whitespace", () => {
    // Whole-line separators preserved mid-line; trailing trim at a break.
    const rows = wrapWithPrefix("keep   inner   spacing", 100, PREFIX);
    expect(rows).toEqual([`${PREFIX}keep   inner   spacing`]);
    // A break drops the separator before it — no trailing/leading filler.
    const long = "x".repeat(30);
    const rows2 = wrapWithPrefix(`${long} tail`, 32, PREFIX);
    expect(rows2).toEqual([`${PREFIX}${long}`, `${PREFIX}tail`]);
    // Leading indentation of the source line is preserved on row one.
    const rows3 = wrapWithPrefix("    indented", 100, PREFIX);
    expect(rows3).toEqual([`${PREFIX}    indented`]);
    for (const row of [...rows, ...rows2, ...rows3]) {
      expect(row === row.replace(/\s+$/, "")).toBe(true);
    }
  });
});

// ---- component: committed block fills the real terminal --------------------

describe("ThinkingBlock terminal-width resolution", () => {
  test("committed thinking with no columns prop fills a wide terminal", async () => {
    const width = 200;
    // 500 words ≈ 4000 cells → ~21 rows at 200 cols (under the 24-line cap).
    const { inst, stdout } = mountThinking(paragraph(500), width);
    await inst.waitUntilRenderFlush();
    await sleep(50);
    const rows = bodyRows(stdout.text);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(width);
    }
    // The fix: measured width replaces the 100-column fallback — the
    // block reaches the terminal edge instead of stopping around half.
    const maxRow = Math.max(...rows.map(displayWidth));
    expect(maxRow).toBeGreaterThanOrEqual(width - 12);
  }, 20000);

  test("resize re-wraps the block at the new terminal width", async () => {
    // 400 words ≈ 3200 cells → ~41 rows at 80 cols (cap shows first 24).
    const { inst, stdout } = mountThinking(paragraph(400), 80);
    await inst.waitUntilRenderFlush();
    await sleep(50);
    const rows80 = [...bodyRows(stdout.text)];
    expect(rows80.length).toBeGreaterThan(1);
    const maxAt80 = Math.max(...rows80.map(displayWidth));
    expect(maxAt80).toBeLessThanOrEqual(80);
    expect(maxAt80).toBeGreaterThanOrEqual(68);

    // Window drag: the driver emits `resize`; the useTerminalSize
    // subscription owned by the block must re-wrap without any prop.
    stdout.columns = 160;
    stdout.emit("resize");
    await inst.waitUntilRenderFlush();
    await sleep(50);
    // stdout.text accumulates both paints; narrow rows cannot exceed
    // maxAt80+20, so a ≥148-cell row proves the re-wrap happened and
    // every present row still fits the 160-col terminal.
    const rowsWide = bodyRows(stdout.text);
    const wide = rowsWide.filter((r) => displayWidth(r) >= 148);
    expect(wide.length).toBeGreaterThan(0);
    for (const row of rowsWide) {
      expect(displayWidth(row)).toBeLessThanOrEqual(160);
    }
  }, 20000);

  test("short lines do not stretch and rows carry no trailing spaces", async () => {
    const { inst, stdout } = mountThinking("alpha\nbeta", 120);
    await inst.waitUntilRenderFlush();
    await sleep(50);
    const stripped = stripAnsi(stdout.text);
    expect(stripped).toContain(`${PREFIX}alpha`);
    expect(stripped).toContain(`${PREFIX}beta`);
    for (const row of bodyRows(stdout.text)) {
      expect(row === row.replace(/\s+$/, "")).toBe(true);
      expect(displayWidth(row)).toBeLessThanOrEqual(120);
    }
  }, 20000);

  test("explicit columns prop still overrides the measure (live callers)", () => {
    // The live zone threads the App-measured width; the block must honor it.
    const inst = libRender(
      <ThinkingBlock
        content={paragraph(200)}
        variant="committed"
        columns={60}
      />,
    );
    try {
      const rows = bodyRows(inst.lastFrame() ?? "");
      expect(rows.length).toBeGreaterThan(1);
      const maxRow = Math.max(...rows.map(displayWidth));
      expect(maxRow).toBeLessThanOrEqual(60);
      expect(maxRow).toBeGreaterThanOrEqual(50);
    } finally {
      inst.unmount();
    }
  });
});
