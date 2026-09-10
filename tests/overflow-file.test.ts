// Overflow-to-file (ticket 04): over-cap tool output spills to a temp file
// with a pointer the model follows, instead of a dead-end truncation note.
// Under-cap results are byte-identical (no note, no spill). Temp files live
// under the OS temp dir; all spill I/O is best-effort and never throws.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  bashTool,
  executeTool,
  overflowDir,
  readTool,
  spillOverflow,
  webfetchTool,
  writeTool,
} from "../src/tools.js";
import { runLoopWithChat, type ChatMessage, type ChatResult } from "../src/zen.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-overflow-test-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function extractSpill(result: string): string {
  const m = /\[overflow: full .* spilled to (\S+) —/.exec(result);
  expect(m, "expected an [overflow: ...] pointer in the result").not.toBeNull();
  return m![1]!;
}

function bigBody(sentinelLine = 2500, totalLines = 3000): string {
  // Many short lines (~31 chars each, ~93KB total): the 64KB head cuts
  // around line ~2000, so the sentinel sits past the cut but inside the
  // spill — and line-based offset/limit paging can reach it.
  const lines: string[] = [];
  for (let i = 1; i <= totalLines; i++) {
    lines.push(i === sentinelLine ? "SENTINEL-OVERFLOW-OK" : `LINE-${i}-padding-padding-pad`);
  }
  return lines.join("\n") + "\n";
}

describe("overflow-to-file", () => {
  test("over-cap read names a readable temp file plus the retrieval command", async () => {
    const cwd = await tmpDir();
    expect(await writeTool({ path: "big.txt", content: bigBody() }, cwd)).toContain("Wrote");
    const out = await readTool({ path: "big.txt" }, cwd);
    // Existing cap + note prefix are unchanged (the note now also carries
    // total-vs-emitted counts); the pointer is appended after them.
    expect(out).toContain("[truncated: output exceeded 64KB; showing ");
    expect(out).not.toContain("SENTINEL-OVERFLOW-OK");
    expect(out).toContain("use read with offset/limit to page through it");
    const spill = extractSpill(out);
    expect(spill.startsWith(overflowDir() + path.sep)).toBe(true);
    // The spilled file holds the FULL output (head-cut content recoverable).
    const spilled = await fsp.readFile(spill, "utf8");
    expect(spilled).toContain("SENTINEL-OVERFLOW-OK");
    // ... and the model follows it with the named retrieval command.
    const paged = await readTool({ path: spill, offset: 2499, limit: 5 });
    expect(paged).toContain("SENTINEL-OVERFLOW-OK");
  });

  test("under-cap read is unchanged (no note, no spill)", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "small.txt", content: "hello\n" }, cwd);
    const out = await readTool({ path: "small.txt" }, cwd);
    expect(out).not.toContain("[truncated:");
    expect(out).not.toContain("[overflow:");
  });

  test("over-cap bash stdout spills; JSON shape and flags are unchanged", async () => {
    const cwd = await tmpDir();
    const raw = await bashTool(
      { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(9000) + 'TAIL-MARK')" ` },
      cwd
    );
    const parsed = JSON.parse(raw) as { stdout: string; stdoutTruncated: boolean };
    expect(parsed.stdoutTruncated).toBe(true);
    expect(parsed.stdout).toContain("[truncated: stdout exceeded 8KB; showing ");
    const spill = extractSpill(parsed.stdout);
    const spilled = await fsp.readFile(spill, "utf8");
    expect(spilled).toContain("TAIL-MARK");
    expect(spilled.length).toBeGreaterThan(9000);
  });

  test("spill I/O never throws and lives under the OS temp dir", async () => {
    expect(overflowDir().startsWith(os.tmpdir())).toBe(true);
    expect(spillOverflow("")).toBeNull();
    expect(spillOverflow(null as unknown as string)).toBeNull();
  });

  test("fixture turn: the model follows the pointer to the cut content", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "big.txt", content: bigBody() }, cwd);
    let n = 0;
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "read big.txt" },
    ];
    const reply = await runLoopWithChat(
      async (h: ChatMessage[]): Promise<ChatResult> => {
        n += 1;
        if (n === 1) return toolCall("c1", "read", { path: path.join(cwd, "big.txt") });
        if (n === 2) {
          const last = h[h.length - 1] as { content: string };
          const spill = /\[overflow: full .* spilled to (\S+) —/.exec(last.content)?.[1];
          expect(spill).toBeDefined();
          return toolCall("c2", "read", { path: spill, offset: 2499, limit: 5 });
        }
        return { content: "recovered the cut content" };
      },
      history,
      { execute: (name, args) => executeTool(name, args, cwd), sleep: async () => {} }
    );
    expect(reply).toBe("recovered the cut content");
    // The spilled content actually entered history via the followed pointer.
    expect(history.some((m) => m.role === "tool" && String((m as { content: string }).content).includes("SENTINEL-OVERFLOW-OK"))).toBe(true);
  });

  test("over-cap webfetch output spills; existing notes are unchanged", async () => {
    const saved = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        headers: { get: () => "text/plain" },
        text: async () => "w ".repeat(40000),
      })) as unknown as typeof fetch;
      const out = await webfetchTool({ url: "https://example.com/big" });
      expect(out).toContain("[truncated: output exceeded 64KB; showing ");
      expect(out.length).toBeLessThan(70 * 1024);
      const spill = extractSpill(out);
      expect((await fsp.readFile(spill, "utf8")).length).toBeGreaterThan(64 * 1024);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
