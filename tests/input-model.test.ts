// Pure input-model tests: cursor math, vertical motion, kills, paste
// normalization, and history index ops.
import { describe, expect, test } from "vitest";
import {
  historyNewerIndex,
  historyOlderIndex,
  killToLineEnd,
  killToLineStart,
  killWordBefore,
  lineColOf,
  moveVertically,
  normalizePaste,
  offsetOfLines,
  pushInputHistory,
  splitInputLines,
} from "../src/ui/input-model.js";

describe("line/col math", () => {
  test("offset round-trips across lines", () => {
    const text = "ab\ncdef\ng";
    expect(lineColOf(text, 0)).toEqual({ line: 0, col: 0 });
    expect(lineColOf(text, 2)).toEqual({ line: 0, col: 2 });
    expect(lineColOf(text, 3)).toEqual({ line: 1, col: 0 });
    expect(lineColOf(text, 7)).toEqual({ line: 1, col: 4 });
    expect(lineColOf(text, 8)).toEqual({ line: 2, col: 0 });
    const lines = splitInputLines(text);
    for (const off of [0, 2, 3, 7, 8]) {
      const { line, col } = lineColOf(text, off);
      expect(offsetOfLines(lines, line, col)).toBe(off);
    }
  });
  test("columns clamp to short lines", () => {
    expect(offsetOfLines(["abcdef", "x"], 1, 5)).toBe(8);
  });
  test("vertical motion keeps columns, edges report", () => {
    const text = "abcdef\nxy\n123456";
    expect(moveVertically(text, 4, 1)).toEqual({ offset: 9, edge: false });
    expect(moveVertically(text, 0, -1)).toEqual({ offset: 0, edge: true });
    expect(moveVertically(text, 13, 1)).toEqual({ offset: 13, edge: true });
    // Column clamps when the target line is shorter.
    expect(moveVertically(text, 5, 1).offset).toBe(9);
  });
});

describe("kills", () => {
  test("Ctrl+K to line end, joins at line end", () => {
    expect(killToLineEnd("hello world", 5)).toEqual({ text: "hello", offset: 5 });
    expect(killToLineEnd("ab\ncd", 2)).toEqual({ text: "abcd", offset: 2 });
    expect(killToLineEnd("ab", 2)).toEqual({ text: "ab", offset: 2 });
  });
  test("Ctrl+U to line start", () => {
    expect(killToLineStart("ab\ncdef", 6)).toEqual({ text: "ab\nf", offset: 3 });
    expect(killToLineStart("abc", 0)).toEqual({ text: "abc", offset: 0 });
  });
  test("Ctrl+W kills word + gap, steps on punctuation", () => {
    expect(killWordBefore("foo bar", 7)).toEqual({ text: "foo ", offset: 4 });
    expect(killWordBefore("foo   ", 6)).toEqual({ text: "foo", offset: 3 });
    expect(killWordBefore("foo(bar", 7)).toEqual({ text: "foo(", offset: 4 });
    expect(killWordBefore("foo(", 4)).toEqual({ text: "foo", offset: 3 });
    expect(killWordBefore("", 0)).toEqual({ text: "", offset: 0 });
  });
});

describe("paste normalization", () => {
  test("endings normalize, content untouched", () => {
    expect(normalizePaste("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizePaste("plain")).toBe("plain");
  });
});

describe("history", () => {
  test("push skips blanks/dups and caps", () => {
    let h: string[] = [];
    h = pushInputHistory(h, "  ");
    h = pushInputHistory(h, "a");
    h = pushInputHistory(h, "a");
    h = pushInputHistory(h, "b");
    expect(h).toEqual(["a", "b"]);
    for (let i = 0; i < 150; i++) h = pushInputHistory(h, `x${i}`);
    expect(h.length).toBe(100);
    expect(h[h.length - 1]).toBe("x149");
  });
  test("browse indices walk and exit past newest", () => {
    const h = ["a", "b", "c"];
    expect(historyOlderIndex(h, null)).toBe(2);
    expect(historyOlderIndex(h, 2)).toBe(1);
    expect(historyOlderIndex(h, 0)).toBe(0);
    expect(historyOlderIndex([], null)).toBe(null);
    expect(historyNewerIndex(h, 0)).toBe(1);
    expect(historyNewerIndex(h, 2)).toBe(null);
    expect(historyNewerIndex(h, null)).toBe(null);
  });
});
