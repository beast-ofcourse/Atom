// Executor tests: each tool runs in a fresh temp dir (never the repo).
// Errors come back as strings, never thrown.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  TOOL_DEFINITIONS,
  bashTool,
  describeToolCall,
  editTool,
  executeTool,
  globTool,
  grepTool,
  readTool,
  resolveSandbox,
  writeTool,
} from "../src/tools.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-tools-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("read/write", () => {
  test("write creates parents, read returns content, directory lists entries", async () => {
    const cwd = await tmpDir();
    expect(await writeTool({ path: "sub/a.txt", content: "hello" }, cwd)).toContain("Wrote 5 bytes");
    expect(await readTool({ path: "sub/a.txt" }, cwd)).toBe("hello");
    const listing = await readTool({ path: "sub" }, cwd);
    expect(listing).toContain("a.txt");
    expect(await readTool({ path: "missing.txt" }, cwd)).toMatch(/^Error:/);
  });

  test("read supports offset/limit line windows", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "f.txt", content: "l1\nl2\nl3\nl4" }, cwd);
    expect(await readTool({ path: "f.txt", offset: 2, limit: 2 }, cwd)).toBe("l2\nl3");
  });
});

describe("sandbox", () => {
  test("absolute paths and ../ escapes are rejected by every tool", async () => {
    const cwd = await tmpDir();
    const abs = path.join(cwd, "x.txt");
    for (const r of [
      await readTool({ path: abs }, cwd),
      await writeTool({ path: abs, content: "x" }, cwd),
      await editTool({ path: abs, oldString: "a", newString: "b" }, cwd),
      await grepTool({ pattern: "a", dir: abs }, cwd),
      await globTool({ pattern: "*", dir: abs }, cwd),
    ]) {
      expect(r).toMatch(/^Error:/);
    }
    expect(await readTool({ path: "../outside.txt" }, cwd)).toMatch(/^Error:/);
    expect(await writeTool({ path: "..\\outside.txt", content: "x" }, cwd)).toMatch(/^Error:/);
    expect(resolveSandbox(abs, cwd).error).toMatch(/absolute/);
    expect(resolveSandbox("../x", cwd).error).toMatch(/escapes/);
  });
});

describe("edit", () => {
  test("0 matches and multi-match without replaceAll are errors", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "e.txt", content: "foo foo" }, cwd);
    expect(await editTool({ path: "e.txt", oldString: "zzz", newString: "y" }, cwd)).toMatch(/^Error:.*no match/);
    expect(await editTool({ path: "e.txt", oldString: "foo", newString: "y" }, cwd)).toMatch(/^Error:.*2 times/);
    expect(await editTool({ path: "e.txt", oldString: "foo", newString: "y", replaceAll: true }, cwd)).toContain("2 occurrence");
    expect(await readTool({ path: "e.txt" }, cwd)).toBe("y y");
    expect(await editTool({ path: "nope.txt", oldString: "a", newString: "b" }, cwd)).toMatch(/^Error:/);
  });
});

describe("grep/glob", () => {
  test("grep finds file:line matches, respects include; invalid regex is an error", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "a.ts", content: "const x = 1;\n// todo here" }, cwd);
    await writeTool({ path: "b.md", content: "todo in md" }, cwd);
    const all = await grepTool({ pattern: "todo" }, cwd);
    expect(all).toContain("a.ts:2:");
    expect(all).toContain("b.md:1:");
    const filtered = await grepTool({ pattern: "todo", include: "*.ts" }, cwd);
    expect(filtered).toContain("a.ts:2:");
    expect(filtered).not.toContain("b.md");
    expect(await grepTool({ pattern: "([invalid" }, cwd)).toMatch(/^Error:.*invalid regex/);
  });

  test("glob lists matching paths, capped", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "src/zen.ts", content: "x" }, cwd);
    await writeTool({ path: "src/App.tsx", content: "x" }, cwd);
    const out = await globTool({ pattern: "src/*.ts" }, cwd);
    expect(out).toContain("src/zen.ts");
    expect(out).not.toContain("App.tsx");
    const base = await globTool({ pattern: "*.ts" }, cwd);
    expect(base).toContain("src/zen.ts");
  });
});

describe("bash", () => {
  test("captures exit code, stdout and stderr as a JSON string", async () => {
    const cwd = await tmpDir();
    const ok = JSON.parse(
      await bashTool({ command: `${JSON.stringify(process.execPath)} -e "console.log('hi-out'); console.error('hi-err')"` }, cwd)
    ) as { exitCode: number; stdout: string; stderr: string };
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("hi-out");
    expect(ok.stderr).toContain("hi-err");
    const code = JSON.parse(
      await bashTool({ command: `${JSON.stringify(process.execPath)} -e "process.exit(3)"` }, cwd)
    ) as { exitCode: number };
    expect(code.exitCode).toBe(3);
    expect(await bashTool({ command: "" }, cwd)).toMatch(/^Error:/);
  });
});

describe("schemas/dispatch", () => {
  test("all 7 tools have OpenAI function schemas and dispatch", async () => {
    expect(TOOL_DEFINITIONS.map((t) => t.function.name).sort()).toEqual(
      ["ask_question", "bash", "edit", "glob", "grep", "read", "write"]
    );
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe("function");
      expect(typeof t.function.description).toBe("string");
      expect(t.function.parameters).toMatchObject({ type: "object" });
    }
    const cwd = await tmpDir();
    await writeTool({ path: "d.txt", content: "data" }, cwd);
    expect(await executeTool("read", { path: "d.txt" }, cwd)).toBe("data");
    expect(await executeTool("nope", {}, cwd)).toMatch(/^Error:.*unknown tool/);
    expect(describeToolCall("read", { path: "src/zen.ts" })).toBe("⚙ read src/zen.ts");
  });
});
