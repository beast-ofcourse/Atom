// Issue 04 regression tests: the shared truncateHead contract — line/byte
// limits (whichever hits first), total-vs-emitted counts, explicit notes,
// and the documented single-giant-line tail edge case.
import { describe, expect, test } from "vitest";
import { truncateHead } from "../src/tools/shared.js";

describe("truncateHead", () => {
  test("under-cap text passes through byte-identical with no note", () => {
    const t = truncateHead("a\nb\nc", 64 * 1024, "\n[truncated: output exceeded 64KB]");
    expect(t.truncated).toBe(false);
    expect(t.head).toBe("a\nb\nc");
    expect(t.note).toBe("");
    expect(t.totalChars).toBe(5);
    expect(t.emittedChars).toBe(5);
    expect(t.totalLines).toBe(3);
    expect(t.emittedLines).toBe(3);
  });

  test("byte cut backs up to the previous newline (no partial line)", () => {
    const full = "line-one\nline-two\nline-three\nline-four";
    // Cap lands inside "line-three".
    const cap = "line-one\nline-two\nline-t".length;
    const t = truncateHead(full, cap, "\n[truncated: output exceeded 64KB]");
    expect(t.truncated).toBe(true);
    expect(t.head).toBe("line-one\nline-two");
    // Every emitted line is a complete source line.
    for (const ln of t.head.split("\n")) {
      expect(full.split("\n")).toContain(ln);
    }
    // Note keeps the legacy prefix and adds total-vs-emitted counts.
    expect(t.note.startsWith("\n[truncated: output exceeded 64KB; ")).toBe(true);
    expect(t.note).toContain(`showing ${t.emittedChars} of ${full.length} chars`);
    expect(t.note).toContain(`(${t.emittedLines} of 4 lines)`);
    expect(t.totalChars).toBe(full.length);
    expect(t.totalLines).toBe(4);
  });

  test("tail edge case: single giant line keeps the hard byte cut", () => {
    const full = "x".repeat(1000);
    const t = truncateHead(full, 100, "\n[truncated: output exceeded 64KB]");
    expect(t.truncated).toBe(true);
    expect(t.head).toBe(full.slice(0, 100));
    expect(t.head.length).toBe(100);
    expect(t.emittedLines).toBe(1);
  });

  test("line limit binds first when it is the tighter cap", () => {
    const full = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    const t = truncateHead(full, 64 * 1024, "\n[truncated: output exceeded 64KB]", 3);
    expect(t.truncated).toBe(true);
    expect(t.head).toBe("l0\nl1\nl2");
    expect(t.emittedLines).toBe(3);
    expect(t.totalLines).toBe(10);
  });

  test("empty input never truncates", () => {
    const t = truncateHead("", 10, "\n[truncated: output exceeded 64KB]");
    expect(t.truncated).toBe(false);
    expect(t.head).toBe("");
    expect(t.emittedLines).toBe(0);
  });
});
