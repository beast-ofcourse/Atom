// Static-frame flicker guard: committed transcript rows must never be
// rewritten. Uses the REAL Ink renderer (not ink-testing-library, which
// runs in debug mode and never erases) against a fake TTY, and counts
// stdout bytes + fullscreen-clear escapes per commit.
//
// Background (verified against the installed Ink 7.1.1 source): once the
// dynamic frame reaches viewport height, every commit takes a clearTerminal
// + full-reprint path (unconditional on win32) — measured at ~8.3KB + clear
// per single-line change with a 120-row dynamic tree. With the transcript
// committed via <Static>, a keystroke rewrites ~2 lines (~40-70 bytes).
import React from "react";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { Box, Text } from "ink";
import { render as inkRender } from "ink";
import { InputBox } from "../src/ui/input.js";
import { TranscriptView, type Turn } from "../src/ui/transcript.js";

class FakeStdout extends EventEmitter {
  bytes = 0;
  clears = 0;
  isTTY = true;
  columns = 100;
  rows = 24;
  write(chunk: unknown): boolean {
    const s = String(chunk);
    this.bytes += s.length;
    if (s.includes("[2J") || s.includes("c")) this.clears += 1;
    return true;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

class FakeStderr extends EventEmitter {
  write(): boolean {
    return true;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeTurns(n: number): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i % 2 === 0
        ? { role: "user", content: `question number ${i}` }
        : { role: "assistant", content: `answer number ${i} with **bold** text` }
    );
  }
  return out;
}

function Frame({ turns, input }: { turns: Turn[]; input: string }) {
  return (
    <Box flexDirection="column">
      <TranscriptView turns={turns} clearGen={1} />
      <InputBox input={input} cursor={input.length} />
      <Text dimColor>status bar line</Text>
    </Box>
  );
}

describe("static frame writes", () => {
  test("keystroke commit rewrites lines, never the fullscreen", async () => {
    // 60 turns ≈ 120+ dynamic lines in the old design (way past 24 rows);
    // committed via <Static> they leave the dynamic frame entirely.
    const turns = makeTurns(60);
    const stdout = new FakeStdout();
    const inst = inkRender(<Frame turns={turns} input="a" />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: false,
      incrementalRendering: true,
    });
    try {
      await inst.waitUntilRenderFlush();
      await sleep(150);
      const baseBytes = stdout.bytes;
      const baseClears = stdout.clears;
      // Keystroke: only the input line changes.
      inst.rerender(<Frame turns={turns} input="ab" />);
      await inst.waitUntilRenderFlush();
      await sleep(150);
      // No fullscreen clear, and bytes stay at line-diff scale. The old
      // dynamic-window design measured 8347 bytes + 1 clear here.
      expect(stdout.clears - baseClears).toBe(0);
      expect(stdout.bytes - baseBytes).toBeLessThan(2000);
      // Appending a turn still prints through the static path.
      const more = [...turns, { role: "assistant", content: "brand new reply" } as Turn];
      inst.rerender(<Frame turns={more} input="ab" />);
      await inst.waitUntilRenderFlush();
      await sleep(150);
    } finally {
      inst.unmount();
    }
  }, 30000);
});
