// Approval UI tests: hierarchy renders (title/tool/preview/options),
// pinned shortcut strings preserved, preview splitting, and the App-level
// arrows+Enter flow (once/always-wrap-to-deny) with real execution.
// Policy itself is untouched — these pin presentation + key mapping only.
// Network is ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  ApprovalBox,
  approvalPreview,
  approvalTitle,
} from "../src/ui/modals.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("approval presentation", () => {
  const box = (selected: number) => (
    <ApprovalBox toolName="bash" description="⚙ bash pnpm test" selected={selected} />
  );
  test("title, tool headline, command preview, all options", () => {
    const frame = frameOf(box(0));
    expect(frame).toContain("allow this tool?");
    expect(frame).toContain("Bash");
    expect(frame).toContain("pnpm test");
    expect(frame).toContain("[y]es once");
    expect(frame).toContain("[a]lways allow bash this session");
    expect(frame).toContain("[t]rust all");
    expect(frame).toContain("[n]o");
    expect(frame).not.toContain("⚙ bash pnpm test");
  });
  test("selection marker follows the highlight", () => {
    expect(frameOf(box(0))).toContain("❯ [y]es once");
    expect(frameOf(box(2))).toContain("❯ [t]rust all");
    expect(frameOf(box(3))).toContain("❯ [n]o");
  });
  test("preview splitting", () => {
    expect(approvalPreview("bash", "⚙ bash pnpm test")).toBe("pnpm test");
    expect(approvalPreview("read", "⚙ read src/x.ts")).toBe("src/x.ts");
    expect(approvalPreview("todo_get", "⚙ todo_get")).toBe("⚙ todo_get");
    expect(approvalPreview("bash", "unexpected shape")).toBe("unexpected shape");
    expect(approvalTitle("bash")).toBe("Bash");
    expect(approvalTitle("")).toBe("");
  });
});

// --- App-level arrows+Enter (mocked chat, real write tool) ---

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

function toolMsg(id: string, name: string, args: Record<string, unknown>) {
  return {
    message: {
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
  };
}
function textMsg(content: string) {
  return { message: { content } };
}
function mockChatScriptMessages(messages: unknown[]) {
  const queue = [...messages];
  globalThis.fetch = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { ok: true, json: async () => ({ choices: [next] }) } as Response;
  });
}
async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}
async function cleanProbes(...probes: string[]) {
  const { rm } = await import("node:fs/promises");
  for (const p of probes) {
    try {
      await rm(p, { force: true });
    } catch {
      // ignore
    }
  }
}

describe("App approval keyboard", () => {
  test("Enter on the default row approves once and executes", async () => {
    const probe = "approval-probe-enter.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("written"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      expect(app.lastFrame()).toContain("❯ [y]es once");
      app.stdin.write("\r");
      await waitForFrame(app, "written");
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(probe, "utf8")).resolves.toBe("hi");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
  test("Up wraps to Deny: Enter denies, file untouched", async () => {
    const probe = "approval-probe-wrap.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("understood, denied"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\u001B[A");
      await waitForFrame(app, "❯ [n]o");
      app.stdin.write("\r");
      await waitForFrame(app, "understood, denied");
      expect(app.lastFrame()).toContain("denied by user: write");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
  test("Down selects Always: second same-tool call runs unprompted", async () => {
    const probeA = "approval-probe-al-a.txt";
    const probeB = "approval-probe-al-b.txt";
    await cleanProbes(probeA, probeB);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probeA, content: "a" }),
      toolMsg("c2", "write", { path: probeB, content: "b" }),
      textMsg("both done"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("do both");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\u001B[B");
      await waitForFrame(app, "❯ [a]lways allow");
      app.stdin.write("\r");
      await waitForFrame(app, "both done");
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(probeA, "utf8")).resolves.toBe("a");
      await expect(readFile(probeB, "utf8")).resolves.toBe("b");
    } finally {
      app.unmount();
      await cleanProbes(probeA, probeB);
    }
  });
});
