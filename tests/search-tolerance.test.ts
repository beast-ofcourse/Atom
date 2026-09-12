// Regression tests for the Temp-session failure modes (session
// 360113c5: 18 iterations / 93 tool calls for a file list):
// - grep `include` with {a,b} brace alternation (was literal-matched, so
//   "*.{ts,tsx,...}" returned "No matches." and the model kept retrying).
// - grep "(?i)" prefix for case-insensitive search (was "invalid regex").
// - grep/glob `dir` pointing at a file (was "not a directory" x6).
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { globTool, grepTool, writeTool } from "../src/tools.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-search-tol-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("search tolerance (Temp-session regressions)", () => {
  test("grep include supports {a,b} alternation", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "a.ts", content: "goal here" }, cwd);
    await writeTool({ path: "b.md", content: "goal here" }, cwd);
    await writeTool({ path: "c.txt", content: "goal here" }, cwd);
    const out = await grepTool({ pattern: "goal", include: "*.{ts,md}", outputMode: "files_with_matches" }, cwd);
    expect(out).toContain("a.ts");
    expect(out).toContain("b.md");
    expect(out).not.toContain("c.txt");
  });

  test("grep (?i) prefix is case-insensitive", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "a.ts", content: "Goal line\nnothing" }, cwd);
    const out = await grepTool({ pattern: "(?i)goal" }, cwd);
    expect(out).toContain("a.ts:1:");
    // Still-invalid patterns stay errors (with the (?i) hint).
    expect(await grepTool({ pattern: "([invalid" }, cwd)).toMatch(/^Error:.*invalid regex/);
  });

  test("grep accepts a file path in dir", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "src/session.ts", content: "goal line\nplain" }, cwd);
    await writeTool({ path: "src/other.ts", content: "goal line" }, cwd);
    const out = await grepTool({ pattern: "goal", dir: "src/session.ts" }, cwd);
    expect(out).toContain("session.ts:1:");
    expect(out).not.toContain("other.ts");
    const names = await grepTool({ pattern: "goal", dir: "src/session.ts", outputMode: "files_with_matches" }, cwd);
    expect(names).toBe("Found 1 file(s)\nsrc/session.ts");
  });

  test("glob accepts a file path in dir", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "src/session.ts", content: "x" }, cwd);
    expect(await globTool({ pattern: "*.ts", dir: "src/session.ts" }, cwd)).toBe("src/session.ts");
    expect(await globTool({ pattern: "*.md", dir: "src/session.ts" }, cwd)).toBe("No matches.");
  });

  test("glob pattern supports {a,b} alternation", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "a.ts", content: "x" }, cwd);
    await writeTool({ path: "b.tsx", content: "x" }, cwd);
    await writeTool({ path: "c.md", content: "x" }, cwd);
    const out = await globTool({ pattern: "*.{ts,tsx}" }, cwd);
    expect(out).toContain("a.ts");
    expect(out).toContain("b.tsx");
    expect(out).not.toContain("c.md");
  });

  test("grep include matches a trailing subpath (Temp-session c21)", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "src/tools/registry.ts", content: "name: x\ndescription: y" }, cwd);
    await writeTool({ path: "src/other.ts", content: "nothing here" }, cwd);
    // Shorthand without the src/ prefix must still hit (suffix fallback).
    const out = await grepTool(
      { pattern: "name:", dir: "src", include: "tools/registry.ts", outputMode: "files_with_matches" },
      cwd
    );
    expect(out).toContain("src/tools/registry.ts");
    // Exact full-rel include keeps working.
    const exact = await grepTool(
      { pattern: "name:", dir: "src", include: "src/tools/registry.ts", outputMode: "files_with_matches" },
      cwd
    );
    expect(exact).toContain("src/tools/registry.ts");
  });

  test("glob pattern matches a trailing subpath", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "src/tools/registry.ts", content: "x" }, cwd);
    await writeTool({ path: "src/other.md", content: "x" }, cwd);
    const out = await globTool({ pattern: "tools/*.ts" }, cwd);
    expect(out).toContain("src/tools/registry.ts");
    expect(out).not.toContain("other.md");
  });
});
