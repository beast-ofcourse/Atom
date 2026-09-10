// Normalization unit tests: tool-result coercion/caps, stable signatures,
// defensive chat-result validation. Pure functions, no I/O, no network.
import { describe, expect, test } from "vitest";
import {
  normalizeChatResult,
  normalizeToolResult,
  TOOL_RESULT_CAP_CHARS,
  toolSignature,
} from "../src/agent/normalize.js";

describe("normalizeToolResult", () => {
  test("strings pass through byte-identical under the cap", () => {
    expect(normalizeToolResult("ok")).toBe("ok");
    expect(normalizeToolResult("")).toBe("");
    expect(normalizeToolResult("Error: boom")).toBe("Error: boom");
  });

  test("non-strings coerce via JSON, never throw", () => {
    expect(normalizeToolResult({ a: 1 })).toBe('{"a":1}');
    expect(normalizeToolResult([1, 2])).toBe("[1,2]");
    expect(normalizeToolResult(42)).toBe("42");
    expect(normalizeToolResult(null)).toMatch(/^Error:/);
    expect(normalizeToolResult(undefined)).toMatch(/^Error:/);
  });

  test("oversized custom results truncate with an explicit note", () => {
    const big = "x".repeat(TOOL_RESULT_CAP_CHARS + 100);
    const out = normalizeToolResult(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("[truncated: tool result exceeded");
    expect(out.startsWith("x")).toBe(true);
  });

  test("cap sits above built-in ceilings (overflow pointers pass through)", () => {
    expect(TOOL_RESULT_CAP_CHARS).toBe(128 * 1024);
  });
});

describe("toolSignature", () => {
  test("key order never aliases", () => {
    const a = toolSignature("read", { path: "x", limit: 5 } as Record<string, unknown>);
    const b = toolSignature("read", { limit: 5, path: "x" } as Record<string, unknown>);
    expect(a).toBe(b);
  });

  test("different names/args differ", () => {
    const a = toolSignature("read", { path: "x" });
    expect(toolSignature("glob", { path: "x" })).not.toBe(a);
    expect(toolSignature("read", { path: "y" })).not.toBe(a);
  });

  test("nested objects sort recursively", () => {
    const a = toolSignature("t", { z: { b: 1, a: 2 } });
    const b = toolSignature("t", { z: { a: 2, b: 1 } });
    expect(a).toBe(b);
  });
});

describe("normalizeChatResult", () => {
  test("well-formed messages pass through with zero warnings", () => {
    const raw = {
      content: "hi",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }],
      usage: { prompt_tokens: 3 },
    };
    const { result, warnings } = normalizeChatResult(raw);
    expect(warnings).toEqual([]);
    expect(result.content).toBe("hi");
    expect(result.tool_calls).toHaveLength(1);
    expect(result.usage).toEqual({ prompt_tokens: 3 });
  });

  test("calls with no function name drop with a warning (never execute)", () => {
    const raw = {
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "bad", type: "function", function: { arguments: "{}" } },
      ],
    };
    const { result, warnings } = normalizeChatResult(raw);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0]!.id).toBe("c1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad");
  });

  test("non-string arguments coerce; missing ids default; non-array ignored", () => {
    const objArgs = normalizeChatResult({
      content: null,
      tool_calls: [{ function: { name: "grep", arguments: { pattern: "x" } } }],
    });
    expect(objArgs.warnings).toEqual([]);
    expect(objArgs.result.tool_calls).toHaveLength(1);
    expect(objArgs.result.tool_calls![0]!.function.arguments).toBe('{"pattern":"x"}');
    expect(objArgs.result.tool_calls![0]!.id.length).toBeGreaterThan(0);

    const nonArray = normalizeChatResult({ content: "hi", tool_calls: "nope" });
    expect(nonArray.result.tool_calls).toBeUndefined();
    expect(nonArray.warnings.length).toBeGreaterThan(0);

    const nonObject = normalizeChatResult("nope");
    expect(nonObject.result.content).toBeNull();
    expect(nonObject.warnings.length).toBeGreaterThan(0);
  });
});
