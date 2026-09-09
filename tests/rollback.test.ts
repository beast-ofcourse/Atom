// Rollback semantics: conversation, filesystem, and process rollback are
// three independent scopes — explicitly NOT one transaction. These tests pin
// the distinction at the runtime seams (module-level, no TUI):
// - conversation rollback never touches disk (and vice versa)
// - filesystem rollback is explicit-only, byte-exact, hash-verified
// - cancellation and failure never imply a filesystem revert
// - failed mutations and snapshot verification behave explicitly
import { promises as fsp } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ROLLBACK_MODE,
  ROLLBACK_NOTES,
  cancelledTurnLine,
} from "../src/rollback.js";
import {
  clearSnapshots,
  conversationCutIndex,
  listCheckpoints,
  pruneStaleSnapshotOverflow,
  restoreCheckpointFiles,
  type RewindMessage,
} from "../src/snapshots.js";
import { editTool, readTool, writeTool } from "../src/tools.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-rollback-"));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  clearSnapshots();
});

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
  clearSnapshots();
});

describe("the three scopes are explicitly distinct", () => {
  test("conversation rolls back automatically; filesystem explicit-only; process never", () => {
    expect(ROLLBACK_MODE).toEqual({
      conversation: "automatic",
      filesystem: "explicit",
      process: "never",
    });
    for (const note of Object.values(ROLLBACK_NOTES)) {
      expect(typeof note).toBe("string");
      expect(note.length).toBeGreaterThan(0);
    }
  });

  test("cancelled-turn line keeps (cancelled) and states the no-revert truth", () => {
    const line = cancelledTurnLine();
    expect(line).toContain("(cancelled)");
    expect(line).toMatch(/NOT reverted/);
    expect(line).toContain("/rewind");
  });
});

describe("conversation rollback without filesystem rollback", () => {
  test("splicing the turn leaves disk mutated; only explicit restore reverts bytes", async () => {
    const cwd = await tmpDir();
    const abs = path.join(cwd, "work.txt");
    await writeTool({ path: "work.txt", content: "v1" }, cwd);
    await writeTool({ path: "work.txt", content: "v2" }, cwd);
    const cps = listCheckpoints();
    expect(cps).toHaveLength(2);

    // The turn that performed the v2 write, mid-flight: user + assistant w/
    // tool_calls + tool result, no committed assistant answer yet.
    const history: RewindMessage[] = [
      { role: "system" },
      { role: "user" },
      { role: "assistant", hasToolCalls: true },
      { role: "assistant", hasToolCalls: true },
    ];
    // Cancel/failure path: splice(rollbackTo) drops the whole turn.
    const cut = conversationCutIndex(history, 1);
    const rolled = history.slice(0, cut);
    expect(rolled).toHaveLength(1);

    // Disk is untouched by the conversation rollback: the mutation remains.
    expect(await fsp.readFile(abs, "utf8")).toBe("v2");
    // The checkpoint survived too (evidence, not a journal entry).
    expect(listCheckpoints()).toHaveLength(2);
    // Only the explicit filesystem rollback reverts bytes.
    expect(await restoreCheckpointFiles(cps[1]!.id)).toBe("(rewound 1 file(s) to checkpoint #2)");
    expect(await fsp.readFile(abs, "utf8")).toBe("v1");
  });
});

describe("failed mutations are explicit, never silent rollbacks", () => {
  test("write failing after capture errors out; disk unchanged; checkpoint kept as evidence", async () => {
    const cwd = await tmpDir();
    const blocker = path.join(cwd, "blocker");
    await fsp.writeFile(blocker, "file-not-dir", "utf8");
    // mkdir fails (ENOTDIR): capture already ran, the write did not.
    const out = await writeTool({ path: "blocker/sub.txt", content: "lost" }, cwd);
    expect(out).toMatch(/^Error:/);
    await expect(fsp.stat(path.join(cwd, "blocker", "sub.txt"))).rejects.toThrow();
    // The checkpoint records the pre-mutation state (file did not exist);
    // restoring it is a no-op delete, not a resurrection of "lost".
    const cps = listCheckpoints();
    expect(cps).toHaveLength(1);
    expect(cps[0]?.files[0]?.existed).toBe(false);
    expect(await restoreCheckpointFiles(cps[0]!.id)).toBe("(rewound 1 file(s) to checkpoint #1)");
  });

  test("rejected edits (stale read) snapshot nothing — never ran, nothing to undo", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "s.txt", content: "orig" }, cwd);
    await readTool({ path: "s.txt" }, cwd);
    // External change behind the executors' back.
    await fsp.writeFile(path.join(cwd, "s.txt"), "external", "utf8");
    expect(
      await editTool({ path: "s.txt", oldString: "orig", newString: "mine" }, cwd)
    ).toMatch(/stale read/);
    // Only the write checkpoint exists; the refused edit left no trace.
    expect(listCheckpoints()).toHaveLength(1);
    expect(await fsp.readFile(path.join(cwd, "s.txt"), "utf8")).toBe("external");
  });
});

describe("snapshot verification", () => {
  test("tampered in-memory bytes fail the hash check, disk keeps the mutated content", async () => {
    const cwd = await tmpDir();
    const abs = path.join(cwd, "t.txt");
    await writeTool({ path: "t.txt", content: "good-v1" }, cwd);
    await writeTool({ path: "t.txt", content: "good-v2" }, cwd);
    const cps = listCheckpoints();
    // Corrupt the evidence (listCheckpoints shares the live entries).
    cps[1]!.files[0]!.bytes = Buffer.from("tampered", "utf8");
    expect(await restoreCheckpointFiles(cps[1]!.id)).toMatch(/hash mismatch/);
    expect(await fsp.readFile(abs, "utf8")).toBe("good-v2");
  });

  test("missing overflow copy restores as unreadable, never as guessed bytes", async () => {
    const cwd = await tmpDir();
    const big = `y${"0123456789abcdef".repeat(20000)}`; // ~320KB, spills
    await writeTool({ path: "big.bin", content: "small-first" }, cwd);
    await writeTool({ path: "big.bin", content: big }, cwd);
    await writeTool({ path: "big.bin", content: "after" }, cwd);
    const cps = listCheckpoints();
    const spill = cps[2]?.files[0]?.overflowPath;
    expect(spill).not.toBeNull();
    await fsp.rm(spill!, { force: true });
    expect(await restoreCheckpointFiles(cps[2]!.id)).toMatch(/unreadable/);
    expect(await fsp.readFile(path.join(cwd, "big.bin"), "utf8")).toBe("after");
  });
});

describe("snapshot lifecycle hygiene", () => {
  test("clearSnapshots reports the dropped count (lineage-reset call sites)", async () => {
    const cwd = await tmpDir();
    expect(clearSnapshots()).toBe(0);
    await writeTool({ path: "a.txt", content: "1" }, cwd);
    await writeTool({ path: "b.txt", content: "2" }, cwd);
    expect(clearSnapshots()).toBe(2);
    expect(listCheckpoints()).toHaveLength(0);
    expect(clearSnapshots()).toBe(0);
  });

  test("pruneStaleSnapshotOverflow removes only aged spill files, never throws", async () => {
    const cwd = await tmpDir();
    const big = `z${"0123456789abcdef".repeat(20000)}`;
    await writeTool({ path: "big.bin", content: "seed" }, cwd);
    await writeTool({ path: "big.bin", content: big }, cwd);
    await writeTool({ path: "big.bin", content: "after" }, cwd);
    const spill = listCheckpoints()[2]?.files[0]?.overflowPath;
    expect(spill).not.toBeNull();
    // Fresh spill survives the default-age prune.
    expect(pruneStaleSnapshotOverflow()).toBe(0);
    expect(fs.existsSync(spill!)).toBe(true);
    // Backdate past the threshold: the next prune collects it (crash-
    // leftover semantics — even a live checkpoint's copy can age out, in
    // which case restore reports unreadable rather than guessing).
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(spill!, ancient, ancient);
    expect(pruneStaleSnapshotOverflow()).toBe(1);
    expect(fs.existsSync(spill!)).toBe(false);
  });
});
