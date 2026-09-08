// Ticket 01 (/rewind): auto-snapshots before mutation + hash-verified restore.
// Module-level tests (no TUI): every write/edit checkpoints with zero
// prompts, restores return exact bytes, files-only leaves the conversation
// alone while files+conversation truncates it, and shell side effects are
// documented out of scope (doc assertion only — no shell is ever run here).
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { REWIND_SCOPES, SLASH_COMMANDS, helpListText } from "../src/App.js";
import {
  SNAPSHOT_OVERFLOW_BYTES,
  capturePriorBytes,
  clearSnapshots,
  conversationCutIndex,
  listCheckpoints,
  restoreCheckpointFiles,
} from "../src/snapshots.js";
import { editTool, executeTool, readTool, writeTool } from "../src/tools.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-rewind-"));
  dirs.push(d);
  return d;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

beforeEach(() => {
  clearSnapshots();
});

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
  clearSnapshots();
});

describe("checkpoint-per-mutation (silent, no prompts)", () => {
  test("every write/edit records one checkpoint, even for missing files", async () => {
    const cwd = await tmpDir();
    expect(await writeTool({ path: "a.txt", content: "v1" }, cwd)).toContain("Wrote");
    expect(await writeTool({ path: "a.txt", content: "v2" }, cwd)).toContain("Wrote");
    // editTool needs a fresh read fingerprint first (stale-read guard).
    expect(await readTool({ path: "a.txt" }, cwd)).toContain("v2");
    expect(await editTool({ path: "a.txt", oldString: "v2", newString: "v3" }, cwd)).toContain(
      "Edited"
    );
    const cps = listCheckpoints();
    expect(cps).toHaveLength(3);
    expect(cps[0]?.label).toBe("write a.txt");
    expect(cps[1]?.label).toBe("write a.txt");
    expect(cps[2]?.label).toBe("edit a.txt");
    // The first checkpoint predates the file (restore must delete it).
    expect(cps[0]?.files[0]?.existed).toBe(false);
    expect(cps[1]?.files[0]?.existed).toBe(true);
    // Sequential checkpoint numbers for the picker.
    expect(cps.map((c) => c.seq)).toEqual([1, 2, 3]);
  });

  test("the executeTool dispatch path snapshots too (single choke point)", async () => {
    const cwd = await tmpDir();
    expect(await executeTool("write", { path: "d.txt", content: "hi" }, cwd)).toContain("Wrote");
    expect(await executeTool("edit", { path: "d.txt", oldString: "hi", newString: "yo" }, cwd)).toContain(
      "Edited"
    );
    expect(listCheckpoints()).toHaveLength(2);
  });

  test("validation failures snapshot nothing (never ran, nothing to undo)", async () => {
    const cwd = await tmpDir();
    expect(await executeTool("write", { path: "d.txt" }, cwd)).toMatch(/^Error: invalid call/);
    expect(await executeTool("edit", { path: "nope.txt", oldString: "a", newString: "b" }, cwd)).toMatch(
      /^Error:/
    );
    // The failed edit read nothing, so no checkpoint either (read failed first).
    expect(listCheckpoints()).toHaveLength(0);
  });

  test("capture failures resolve null and never break the mutation", async () => {
    const cwd = await tmpDir();
    expect(await capturePriorBytes("", "write x")).toBeNull();
    expect(await writeTool({ path: "ok.txt", content: "fine" }, cwd)).toContain("Wrote");
  });
});

describe("restore-exactness (hash, not rewrite)", () => {
  test("restoring returns the exact prior bytes", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "f.txt", content: "v1-content" }, cwd);
    await writeTool({ path: "f.txt", content: "v2-content" }, cwd);
    await writeTool({ path: "f.txt", content: "v3-content" }, cwd);
    const cps = listCheckpoints();
    expect(cps).toHaveLength(3);
    // Checkpoint #2 holds the pre-v2 bytes ("v1-content").
    const msg = await restoreCheckpointFiles(cps[1]!.id);
    expect(msg).toBe("(rewound 1 file(s) to checkpoint #2)");
    const abs = path.join(cwd, "f.txt");
    const bytes = await fsp.readFile(abs, "utf8");
    expect(bytes).toBe("v1-content");
    expect(sha(bytes)).toBe(sha("v1-content"));
  });

  test("restoring a pre-creation checkpoint deletes the file", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "fresh.txt", content: "hello" }, cwd);
    await writeTool({ path: "fresh.txt", content: "changed" }, cwd);
    const cps = listCheckpoints();
    expect(await restoreCheckpointFiles(cps[0]!.id)).toBe("(rewound 1 file(s) to checkpoint #1)");
    await expect(fsp.stat(path.join(cwd, "fresh.txt"))).rejects.toThrow();
  });

  test("edit checkpoints restore the pre-edit bytes", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "e.txt", content: "alpha\nbeta\n" }, cwd);
    await readTool({ path: "e.txt" }, cwd);
    await editTool({ path: "e.txt", oldString: "beta", newString: "GAMMA" }, cwd);
    expect(await fsp.readFile(path.join(cwd, "e.txt"), "utf8")).toBe("alpha\nGAMMA\n");
    const cps = listCheckpoints();
    await restoreCheckpointFiles(cps[cps.length - 1]!.id);
    expect(await fsp.readFile(path.join(cwd, "e.txt"), "utf8")).toBe("alpha\nbeta\n");
  });

  test("unknown checkpoint id is an error string, never a throw", async () => {
    await expect(restoreCheckpointFiles("no-such-id")).resolves.toMatch(/^Error: unknown checkpoint/);
  });

  test("large files spill to the temp dir (never the repo) and restore exactly", async () => {
    const cwd = await tmpDir();
    const big = `x${"0123456789abcdef".repeat(20000)}`; // ~320KB > 256KB spill line
    expect(big.length).toBeGreaterThan(SNAPSHOT_OVERFLOW_BYTES);
    await writeTool({ path: "big.bin", content: "small-first" }, cwd);
    await writeTool({ path: "big.bin", content: big }, cwd);
    await writeTool({ path: "big.bin", content: "after" }, cwd);
    const cps = listCheckpoints();
    expect(cps).toHaveLength(3);
    // The pre-"after" write spilled: its prior bytes are the ~320KB blob
    // (the pre-big checkpoint just holds "small-first" in memory).
    expect(cps[1]?.files[0]?.bytes?.toString("utf8")).toBe("small-first");
    expect(cps[2]?.files[0]?.overflowPath).not.toBeNull();
    expect(cps[2]?.files[0]?.bytes).toBeNull();
    expect(cps[2]?.files[0]?.overflowPath?.startsWith(os.tmpdir())).toBe(true);
    expect(cps[2]?.files[0]?.overflowPath?.startsWith(cwd)).toBe(false);
    expect(await restoreCheckpointFiles(cps[2]!.id)).toBe("(rewound 1 file(s) to checkpoint #3)");
    const restored = await fsp.readFile(path.join(cwd, "big.bin"), "utf8");
    expect(restored).toBe(big);
    expect(sha(restored)).toBe(sha(big));
  });
});

describe("files-only vs files+conversation", () => {
  test("files-only restore leaves the conversation array untouched", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "g.txt", content: "before" }, cwd);
    await writeTool({ path: "g.txt", content: "after" }, cwd);
    const history = [
      { role: "system", content: "sys" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "done" },
    ];
    const before = JSON.stringify(history);
    const cps = listCheckpoints();
    expect(await restoreCheckpointFiles(cps[1]!.id)).toContain("(rewound 1 file(s)");
    expect(JSON.stringify(history)).toBe(before);
    expect(await fsp.readFile(path.join(cwd, "g.txt"), "utf8")).toBe("before");
  });

  test("mid-turn mark drops the whole containing turn (pairing never splits)", () => {
    const history = [
      { role: "system" },
      { role: "user" },
      { role: "assistant", hasToolCalls: true },
      { role: "tool" },
      { role: "assistant", hasToolCalls: true },
    ];
    // Mark 5 = captured while the second assistant tool_calls ran.
    expect(conversationCutIndex(history, 5)).toBe(1);
  });

  test("post-turn mark keeps the committed turn, drops only later turns", () => {
    const history = [
      { role: "system" },
      { role: "user" },
      { role: "assistant" },
      { role: "user" },
      { role: "assistant" },
    ];
    expect(conversationCutIndex(history, 3)).toBe(3);
    expect(conversationCutIndex(history, 5)).toBe(5);
  });

  test("display transcript variant cuts at its own user boundary (floor 0)", () => {
    // Mid-turn transcript: user + tool lines, no committed assistant yet.
    expect(
      conversationCutIndex([{ role: "user" }, { role: "tool" }, { role: "tool" }], 3, 0)
    ).toBe(0);
    // Committed turn is kept through the mark.
    expect(conversationCutIndex([{ role: "user" }, { role: "assistant" }], 2, 0)).toBe(2);
  });

  test("cut never lands mid-pair (user boundary or floor)", () => {
    const history = [
      { role: "system" },
      { role: "user" },
      { role: "assistant", hasToolCalls: true },
      { role: "tool" },
    ];
    for (let mark = 0; mark <= 6; mark++) {
      const cut = conversationCutIndex(history, mark);
      expect(cut).toBeGreaterThanOrEqual(1);
      expect(cut).toBeLessThanOrEqual(history.length);
      if (cut > 1) expect(history[cut]?.role).toBe("user");
    }
  });
});

describe("shell side effects are out of scope (docs only)", () => {
  test("/rewind is registered and names the shell exclusion", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/rewind");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toMatch(/shell/i);
    expect(REWIND_SCOPES).toEqual(["files only", "files + conversation", "conversation only"]);
  });

  test("/help documents checkpoints plus the shell exclusion", () => {
    const help = helpListText();
    expect(help).toContain("/rewind");
    expect(help).toContain("out of scope");
    expect(help).toMatch(/bash/);
  });
});
