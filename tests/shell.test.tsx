import React from "react";
import { describe, test, expect, afterEach, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

afterEach(() => vi.restoreAllMocks());

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}

async function waitForFrame(app: { lastFrame: () => string | undefined }, needle: string, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    const frame = app.lastFrame() ?? "";
    if (frame.includes(needle)) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${frame}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("shell mode 06 parity", () => {
  test("! at offset 0 enters shell (SHELL pill + placeholder)", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("!");
      await waitForFrame(app, "SHELL");
      await waitForFrame(app, "Run a command");
      // input should not contain literal ! — command buffer empty with placeholder
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("SHELL");
      // ensure not in normal mode pill? status shows mode: shell
      expect(frame.toLowerCase()).toContain("shell");
    } finally {
      app.unmount();
    }
  });

  test("Esc exits shell back to normal", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("!");
      await waitForFrame(app, "SHELL");
      app.stdin.write(String.fromCharCode(27)); // Esc
      await waitForFrame(app, "mode: normal");
      const frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("SHELL");
      expect(frame).toContain("mode: normal");
    } finally {
      app.unmount();
    }
  });

  test("Backspace at offset 0 exits shell", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("!");
      await waitForFrame(app, "SHELL");
      // input empty, cursor 0, backspace should exit
      app.stdin.write(String.fromCharCode(127)); // backspace
      await waitForFrame(app, "mode: normal");
      const frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("SHELL");
    } finally {
      app.unmount();
    }
  });

  test("submit in shell executes bash directly (not model)", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("!");
      await waitForFrame(app, "SHELL");
      app.stdin.write("echo hello-shell");
      await waitForFrame(app, "echo hello-shell");
      app.stdin.write("\r"); // Enter
      // Wait for the shell audit line (bash) — the user echo alone also contains hello-shell, so wait for bash
      await waitForFrame(app, "bash");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("hello-shell");
      // Should have bash audit line or $ echo line
      expect(frame).toContain("bash");
      // After submit, should be back to normal mode
      await waitForFrame(app, "mode: normal");
    } finally {
      app.unmount();
    }
  });

  test("paste !echo hi enters shell and strips !", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      // bracketed paste
      app.stdin.write("\u001B[200~!echo paste-shell\u001B[201~");
      await waitForFrame(app, "SHELL");
      await waitForFrame(app, "echo paste-shell");
      const frame = app.lastFrame() ?? "";
      // Should not show literal ! at start? Our impl strips !
      expect(frame).not.toMatch(/› !echo/);
      expect(frame).toContain("echo paste-shell");
    } finally {
      app.unmount();
    }
  });

  test("! not at offset 0 does not enter shell (mid-line)", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi ");
      await waitForFrame(app, "hi ");
      app.stdin.write("!");
      await waitForFrame(app, "hi !");
      const frame = app.lastFrame() ?? "";
      // Should stay normal, input contains !
      expect(frame).toContain("hi !");
      expect(frame).toContain("mode: normal");
      expect(frame).not.toContain("SHELL");
    } finally {
      app.unmount();
    }
  });
});
