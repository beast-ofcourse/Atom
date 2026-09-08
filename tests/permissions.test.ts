// Unit tests for the scoped allow/deny rule matcher (ticket 03).
import { describe, expect, test } from "vitest";
import {
  checkRules,
  formatRules,
  matchGlob,
  parseRuleInput,
  primaryTarget,
  type PermissionRule,
} from "../src/permissions.js";

function rule(kind: "allow" | "deny", pattern: string): PermissionRule {
  const parsed = parseRuleInput(pattern, kind);
  if (!parsed) throw new Error(`test setup: bad pattern ${JSON.stringify(pattern)}`);
  return parsed;
}

describe("parseRuleInput", () => {
  test("bare tool parses as a tool-only rule", () => {
    expect(parseRuleInput("bash", "allow")).toEqual({
      kind: "allow",
      tool: "bash",
      glob: null,
      pattern: "bash",
    });
  });

  test("tool:glob splits on the first colon (globs may contain colons)", () => {
    expect(parseRuleInput("bash:npm test-- --filter a:b", "allow")).toEqual({
      kind: "allow",
      tool: "bash",
      glob: "npm test-- --filter a:b",
      pattern: "bash:npm test-- --filter a:b",
    });
  });

  test("empty glob after the colon degrades to a tool-only rule", () => {
    expect(parseRuleInput("write:  ", "deny")).toEqual({
      kind: "deny",
      tool: "write",
      glob: null,
      pattern: "write",
    });
  });

  test("rejects empty input, missing tool, and spaced tool names", () => {
    expect(parseRuleInput("", "allow")).toBeNull();
    expect(parseRuleInput("   ", "deny")).toBeNull();
    expect(parseRuleInput(":foo", "allow")).toBeNull();
    expect(parseRuleInput("my tool", "allow")).toBeNull();
    expect(parseRuleInput("Write", "allow")).toBeNull();
  });
});

describe("matchGlob", () => {
  test("* prefix/suffix/infix and ? single-char", () => {
    expect(matchGlob("npm test*", "npm test")).toBe(true);
    expect(matchGlob("npm test*", "npm test -- --filter x")).toBe(true);
    expect(matchGlob("*test*", "npm test blah")).toBe(true);
    expect(matchGlob("src/**", "src/a/b/c.ts")).toBe(true);
    expect(matchGlob("ab?", "abc")).toBe(true);
    expect(matchGlob("ab?", "ab")).toBe(false);
    expect(matchGlob("ab?", "abcd")).toBe(false);
  });

  test("literal mismatch, case-sensitivity, and empty edge cases", () => {
    expect(matchGlob("npm test", "npm test ")).toBe(false);
    expect(matchGlob("NPM*", "npm test")).toBe(false);
    expect(matchGlob("", "")).toBe(true);
    expect(matchGlob("", "x")).toBe(false);
    expect(matchGlob("*", "")).toBe(true);
    expect(matchGlob("a*b*c", "axxbyyc")).toBe(true);
    expect(matchGlob("a*b*c", "axxbxxc")).toBe(true);
    expect(matchGlob("a*b", "ba")).toBe(false);
  });
});

describe("primaryTarget", () => {
  test("mirrors the audit-line primary per tool", () => {
    expect(primaryTarget("bash", { command: "npm test" })).toBe("npm test");
    expect(primaryTarget("write", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(primaryTarget("edit", { path: "x", oldString: "a" })).toBe("x");
    expect(primaryTarget("read", { path: "AGENTS.md" })).toBe("AGENTS.md");
    expect(primaryTarget("glob", { pattern: "src/**" })).toBe("src/**");
    expect(primaryTarget("grep", { pattern: "foo" })).toBe("foo");
    expect(primaryTarget("webfetch", { url: "https://x" })).toBe("https://x");
    expect(primaryTarget("websearch", { query: "q" })).toBe("q");
  });

  test("missing/non-string primaries and tool-only tools read as empty", () => {
    expect(primaryTarget("bash", {})).toBe("");
    expect(primaryTarget("bash", { command: 42 })).toBe("");
    expect(primaryTarget("todowrite", { todos: [] })).toBe("");
    expect(primaryTarget("unknown-tool", { path: "x" })).toBe("");
  });
});

describe("checkRules", () => {
  test("no rules → null (caller falls through to the normal flow)", () => {
    expect(checkRules([], "bash", { command: "rm -rf /" })).toBeNull();
  });

  test("tool-only allow matches any args for that tool, nothing else", () => {
    const rules = [rule("allow", "bash")];
    expect(checkRules(rules, "bash", { command: "anything" })).toBe("allow");
    expect(checkRules(rules, "write", { path: "a" })).toBeNull();
  });

  test("bash command-prefix allow is scoped to the prefix", () => {
    const rules = [rule("allow", "bash:npm test*")];
    expect(checkRules(rules, "bash", { command: "npm test" })).toBe("allow");
    expect(checkRules(rules, "bash", { command: "npm test -- --filter a" })).toBe("allow");
    expect(checkRules(rules, "bash", { command: "npm run evil" })).toBeNull();
  });

  test("path allow scopes writes to the subtree", () => {
    const rules = [rule("allow", "write:src/**")];
    expect(checkRules(rules, "write", { path: "src/a/b.ts" })).toBe("allow");
    expect(checkRules(rules, "write", { path: "other/a.ts" })).toBeNull();
    expect(checkRules(rules, "edit", { path: "src/a.ts" })).toBeNull();
  });

  test("deny wins over allow regardless of order", () => {
    const allowFirst = [rule("allow", "bash"), rule("deny", "bash:rm *")];
    const denyFirst = [rule("deny", "bash:rm *"), rule("allow", "bash")];
    for (const rules of [allowFirst, denyFirst]) {
      expect(checkRules(rules, "bash", { command: "rm -rf x" })).toBe("deny");
      expect(checkRules(rules, "bash", { command: "npm test" })).toBe("allow");
    }
  });

  test("deny-only rule refuses its pattern and leaves the rest to the prompt", () => {
    const rules = [rule("deny", "bash:rm *")];
    expect(checkRules(rules, "bash", { command: "rm -rf /tmp/x" })).toBe("deny");
    expect(checkRules(rules, "bash", { command: "ls" })).toBeNull();
  });
});

describe("formatRules", () => {
  test("empty and non-empty listings", () => {
    expect(formatRules([])).toBe("(no rules)");
    expect(formatRules([rule("allow", "bash:npm test*"), rule("deny", "write:.env*")])).toBe(
      "Rules (2):\n1. allow: bash:npm test*\n2. deny: write:.env*"
    );
  });
});
