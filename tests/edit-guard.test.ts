// Read-tracking guard tests (Phase 2): stale-content edits are refused
// with an `invalid call` message and leave file bytes untouched; fresh
// read→edit, write→edit, edit→edit, identical rewrites, and per-cwd
// isolation never false-refuse. Executors run in temp dirs; no network.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { editTool, executeTool, readTool, writeTool } from "../src/tools.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-guard-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

const staleMsg = (p: string): string =>
  `Error: invalid call: stale read — ${p} changed since you last read it. Read it again before editing. Fix the arguments and retry.`;

describe("read-tracking guard", () => {
  test("read→edit ok", async () => {
    const cwd = await tmpDir();
    await fsp.writeFile(path.join(cwd, "f.txt"), "hello world", "utf8");
    expect(await readTool({ path: "f.txt" }, cwd)).toBe("1: hello world");
    expect(await editTool({ path: "f.txt", oldString: "world", newString: "there" }, cwd)).toContain(
      "Edited f.txt"
    );
    expect(await fsp.readFile(path.join(cwd, "f.txt"), "utf8")).toBe("hello there");
  });

  test("read→external-modify→edit refused with exact message, bytes untouched, reread recovers", async () => {
    const cwd = await tmpDir();
    await fsp.writeFile(path.join(cwd, "f.txt"), "version one", "utf8");
    expect(await readTool({ path: "f.txt" }, cwd)).toBe("1: version one");
    await fsp.writeFile(path.join(cwd, "f.txt"), "version two external", "utf8");
    const refused = await editTool(
      { path: "f.txt", oldString: "version one", newString: "version three" },
      cwd
    );
    expect(refused).toBe(staleMsg("f.txt"));
    expect(await fsp.readFile(path.join(cwd, "f.txt"), "utf8")).toBe("version two external");
    // Model recovers by re-reading, then the edit succeeds.
    expect(await readTool({ path: "f.txt" }, cwd)).toBe("1: version two external");
    expect(
      await editTool({ path: "f.txt", oldString: "version two external", newString: "version three" }, cwd)
    ).toContain("Edited f.txt");
    expect(await fsp.readFile(path.join(cwd, "f.txt"), "utf8")).toBe("version three");
  });

  test("stale refusal also flows through executeTool dispatch", async () => {
    const cwd = await tmpDir();
    await fsp.writeFile(path.join(cwd, "g.txt"), "aaa", "utf8");
    await readTool({ path: "g.txt" }, cwd);
    await fsp.writeFile(path.join(cwd, "g.txt"), "bbb", "utf8");
    expect(await executeTool("edit", { path: "g.txt", oldString: "aaa", newString: "ccc" }, cwd)).toBe(
      staleMsg("g.txt")
    );
  });

  test("write→edit and edit→edit chains never false-refuse", async () => {
    const cwd = await tmpDir();
    await fsp.writeFile(path.join(cwd, "c.txt"), "start", "utf8");
    await readTool({ path: "c.txt" }, cwd);
    expect(await writeTool({ path: "c.txt", content: "written" }, cwd)).toContain("Wrote");
    expect(await editTool({ path: "c.txt", oldString: "written", newString: "edited1" }, cwd)).toContain(
      "Edited c.txt"
    );
    expect(await editTool({ path: "c.txt", oldString: "edited1", newString: "edited2" }, cwd)).toContain(
      "Edited c.txt"
    );
    expect(await fsp.readFile(path.join(cwd, "c.txt"), "utf8")).toBe("edited2");
  });

  test("identical-content external rewrite never triggers the guard", async () => {
    const cwd = await tmpDir();
    await fsp.writeFile(path.join(cwd, "same.txt"), "abc", "utf8");
    await readTool({ path: "same.txt" }, cwd);
    await fsp.writeFile(path.join(cwd, "same.txt"), "abc", "utf8");
    expect(await editTool({ path: "same.txt", oldString: "abc", newString: "def" }, cwd)).toContain(
      "Edited same.txt"
    );
  });

  test("never-read→edit allowed (e.g. content learned via grep); dir listing tracks nothing", async () => {
    const cwd = await tmpDir();
    await fsp.writeFile(path.join(cwd, "n.txt"), "grep-found me", "utf8");
    expect(await editTool({ path: "n.txt", oldString: "grep-found", newString: "edited" }, cwd)).toContain(
      "Edited n.txt"
    );
    await fsp.writeFile(path.join(cwd, "m.txt"), "list me", "utf8");
    expect(await readTool({ path: "." }, cwd)).toContain("m.txt");
    expect(await editTool({ path: "m.txt", oldString: "list", newString: "shown" }, cwd)).toContain(
      "Edited m.txt"
    );
  });

  test("missing-file edit keeps the old no-such-file error, even with a record", async () => {
    const cwd = await tmpDir();
    expect(await editTool({ path: "nope.txt", oldString: "a", newString: "b" }, cwd)).toMatch(
      /^Error: no such file/
    );
    await fsp.writeFile(path.join(cwd, "gone.txt"), "here", "utf8");
    await readTool({ path: "gone.txt" }, cwd);
    await fsp.rm(path.join(cwd, "gone.txt"));
    const r = await editTool({ path: "gone.txt", oldString: "here", newString: "there" }, cwd);
    expect(r).toMatch(/^Error: no such file/);
    expect(r.startsWith("Error: invalid call:")).toBe(false);
  });

  test("record keyed per-cwd: same rel path under different cwd tracked separately", async () => {
    const cwd1 = await tmpDir();
    const cwd2 = await tmpDir();
    await writeTool({ path: "same.txt", content: "hello" }, cwd1);
    await writeTool({ path: "same.txt", content: "hello" }, cwd2);
    await readTool({ path: "same.txt" }, cwd1);
    await fsp.writeFile(path.join(cwd2, "same.txt"), "changed-externally", "utf8");
    // External change under cwd2 does not poison cwd1.
    expect(await editTool({ path: "same.txt", oldString: "hello", newString: "hi" }, cwd1)).toContain(
      "Edited same.txt"
    );
    // ...but cwd2 (written, then externally changed) is stale until re-read.
    expect(await editTool({ path: "same.txt", oldString: "hello", newString: "hi" }, cwd2)).toBe(
      staleMsg("same.txt")
    );
  });
});
