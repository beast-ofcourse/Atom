// Resize reactivity guard: the single terminal-size source (useTerminalSize)
// must re-render its consumers when the terminal emits `resize`.
//
// Regression: `useTerminalSize()` read `useStdout()?.stdout.columns` — a plain
// context read with NO resize subscription. Ink's own resize handler
// (ink/build/ink.js `resized`) only recalculates yoga layout and re-renders
// the *existing* React tree; it never schedules a React update, so consumers
// of the size hook kept the pre-resize width until an unrelated re-render
// (keystroke/token tick) happened. Width-derived UI (status bar fit-or-drop,
// input frame, diff panes, wrapping) therefore stayed laid out for the OLD
// terminal width while Ink re-laid it out at the new one — the "distorted on
// resize" symptom.
//
// This test uses the REAL Ink renderer (not ink-testing-library, whose stdout
// hardcodes `columns: 100`) against a fake TTY whose size can change and that
// can emit 'resize', which is exactly what a real terminal driver does.
import React from "react";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { Text, render as inkRender } from "ink";
import { useTerminalSize } from "../src/ui/layout.js";

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

function SizeProbe() {
  const size = useTerminalSize();
  return (
    <Text>
      probe:{size.columns}x{size.rows}
    </Text>
  );
}

function mount(stdout: FakeStdout) {
  return inkRender(<SizeProbe />, {
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

describe("terminal resize reactivity", () => {
  test("a stdout 'resize' event repaints consumers at the new size", async () => {
    const stdout = new FakeStdout();
    const inst = mount(stdout);
    instances.push(inst);
    await inst.waitUntilRenderFlush();
    await sleep(50);
    expect(stdout.text).toContain("probe:100x24");

    // Terminal shrinks — exactly what the driver emits on a window drag.
    stdout.text = "";
    stdout.columns = 60;
    stdout.rows = 20;
    stdout.emit("resize");
    await inst.waitUntilRenderFlush();
    await sleep(50);
    expect(stdout.text).toContain("probe:60x20");

    // And grows back (the path Ink never clears, so the app must still react).
    stdout.text = "";
    stdout.columns = 132;
    stdout.rows = 40;
    stdout.emit("resize");
    await inst.waitUntilRenderFlush();
    await sleep(50);
    expect(stdout.text).toContain("probe:132x40");
  }, 20000);

  test("a resize event with an unchanged size does not churn frames", async () => {
    const stdout = new FakeStdout();
    const inst = mount(stdout);
    instances.push(inst);
    await inst.waitUntilRenderFlush();
    await sleep(50);

    stdout.text = "";
    stdout.emit("resize");
    await inst.waitUntilRenderFlush();
    await sleep(50);
    // Same dimensions: the hook must bail out of the state update, so no
    // probe line is rewritten.
    expect(stdout.text).not.toContain("probe:100x24");
  }, 20000);
});
