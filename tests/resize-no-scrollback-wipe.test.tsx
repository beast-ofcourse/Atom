// Guard: a resize must never wipe terminal scrollback.
//
// Ink's win32 clear path (`shouldClearTerminalForFrame`, ink/build/ink.js)
// writes `clearTerminal` when a frame height reaches the viewport rows — and
// `clearTerminal` contains ESC[3J, which deletes the terminal's scrollback
// history, then replays the entire accumulated static output at the OLD width
// (stale wrapping + lost history). See plans/tui-resize-theme-layout.md V1-V4.
//
// This test uses the REAL Ink renderer on the fake TTY (same harness style as
// tests/terminal-resize.test.tsx): force a frame taller than the viewport,
// resize the window (the win32 clear path also fires on resize), and assert
// the destructive sequence never reaches the terminal.
import React from "react";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { Text, Box, render as inkRender } from "ink";

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  text = "";
  write(chunk: unknown): boolean {
    this.text += String(chunk);
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

// Taller than the 24-row viewport: an open overlay/inspector at full height is
// exactly the shape that arms Ink's win32 clear path (plan findings V3, V11).
function TallFrame() {
  return (
    <Box>
      <Text>{Array.from({ length: 40 }, (_, i) => `filler-${i}`).join("\n")}</Text>
    </Box>
  );
}

function mount(stdout: FakeStdout) {
  return inkRender(<TallFrame />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: false,
    incrementalRendering: true,
  });
}

const instances: { unmount: () => void }[] = [];

afterEach(() => {
  for (const inst of instances.splice(0)) inst.unmount();
});

describe("resize must not wipe scrollback", () => {
  test("no ESC[3J around a resize of a full-height frame", async () => {
    const stdout = new FakeStdout();
    const inst = mount(stdout);
    instances.push(inst);
    await inst.waitUntilRenderFlush();
    await sleep(50);

    // Drop the mount output: only what the RESIZE produces is on trial.
    stdout.text = "";
    stdout.columns = 60;
    stdout.rows = 20;
    stdout.emit("resize");
    await inst.waitUntilRenderFlush();
    await sleep(80);

    // Second resize (width decrease — the branch Ink itself additionally
    // reacts to with log.clear(), plan V2).
    stdout.columns = 40;
    stdout.rows = 18;
    stdout.emit("resize");
    await inst.waitUntilRenderFlush();
    await sleep(80);

    // The one hard assertion: the scrollback-destroying sequence is never
    // written. ESC[2J (viewport erase without history loss) is allowed — that
    // is what a controlled repaint keeps.
    expect(stdout.text).not.toContain("\x1b[3J");
  }, 20000);
});
