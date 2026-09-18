// Narrow-terminal pass (Extreme-fast 5.2): the 48 / 80 / 140 widths must
// hold after every layout change — widget collapse <50/70, table stack
// <50, todo overflow, status-bar fit. No ui/* file changed in Phases 3-4,
// so this pins the contract rather than chasing a regression.
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";

const mockStdout = vi.hoisted(() => ({ columns: 100, rows: 30 }));

vi.mock("ink", async (importOriginal) => {
  const mod = await importOriginal<typeof import("ink")>();
  return {
    ...mod,
    useStdout: () => ({ stdout: mockStdout }),
  };
});

import { ToolCall } from "../src/ui/components/ToolCall.js";
import { TodoPanel } from "../src/ui/todo-panel.js";
import { StatusBar } from "../src/ui/status-bar.js";
import { MarkdownBody } from "../src/ui/components/Markdown.js";
import { theme } from "../src/ui/theme.js";
import type { Turn } from "../src/ui/transcript.js";
import type { TodoItem } from "../src/tools.js";

function frameAt(node: React.ReactNode, columns: number): string {
  mockStdout.columns = columns;
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function maxLineLen(frame: string): number {
  return frame.split("\n").reduce((m, l) => Math.max(m, [...l].length), 0);
}

const audit = (content: string, extra?: Partial<Turn>): Turn => ({ role: "tool", content, ...extra });

const LONG_TARGET = "src/some/very/deeply/nested/directory/structure/with-a-long-filename-that-keeps-going.ts";

describe("narrow terminal widths", () => {
  for (const cols of [48, 80, 140]) {
    test(`tool widget fits at ${cols} cols`, () => {
      const frame = frameAt(
        <ToolCall
          turn={audit(`⚙ read ${LONG_TARGET}`, { summary: "50 lines" })}
          result={Array.from({ length: 10 }, (_, i) => `output line number ${i} with content`).join("\n")}
        />,
        cols,
      );
      expect(frame).toContain("╭");
      expect(frame).toContain("4 more lines");
      expect(maxLineLen(frame)).toBeLessThanOrEqual(cols);
    });
  }

  test("todo overflow ellipsizes at 48 cols", () => {
    const items: TodoItem[] = Array.from({ length: 14 }, (_, i) => ({
      content: `task number ${i} with a fairly long description text`,
      status: i < 5 ? "completed" : i === 5 ? "in_progress" : "pending",
      activeForm: i === 5 ? "working task number 5" : undefined,
    })) as TodoItem[];
    const frame = frameAt(<TodoPanel items={items} />, 48);
    expect(frame).toContain("Todo");
    // Overflow contract: 8 visible + "… N more" footer (14 items).
    expect(frame).toContain("more");
    expect(frame).not.toContain("task number 13");
    // Rows size to Ink width (harness: 100); on a real 48-col terminal Ink
    // wraps them at 48. The panel never assumes width beyond Ink.
    expect(maxLineLen(frame)).toBeLessThanOrEqual(100);
  });

  test("markdown table stacks below 50 cols, grids at 80+", () => {
    const table = "| name | value |\n|---|---|\n| alpha | 1 |\n| beta | 2 |\n";
    const narrow = frameAt(<MarkdownBody text={table} />, 48);
    expect(narrow).toContain("alpha");
    expect(narrow).not.toContain("│");
    const wide = frameAt(<MarkdownBody text={table} />, 80);
    expect(wide).toContain("│");
    expect(maxLineLen(wide)).toBeLessThanOrEqual(80);
  });

  test("status bar fits at 48 and 140 cols", () => {
    const base = {
      model: "model-x",
      provider: "kilo",
      tokens: 100,
      usage: null,
      mode: "normal",
      busy: false,
      activity: null,
      elapsedSecs: 0,
      cwd: "/repo",
      branch: "main",
      goal: null,
    } as unknown as React.ComponentProps<typeof StatusBar>;
    for (const cols of [48, 140]) {
      const frame = frameAt(<StatusBar {...base} columns={cols} />, cols);
      expect(frame.length).toBeGreaterThan(0);
      expect(maxLineLen(frame)).toBeLessThanOrEqual(cols);
    }
  });

  test("bullet symbol used by stacked tables exists", () => {
    expect(typeof theme.symbol.bullet).toBe("string");
  });
});
