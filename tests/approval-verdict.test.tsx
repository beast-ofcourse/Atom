// Ticket 04 — approval decides once, with provenance: decideApproval wraps
// the ordered decidePolicy rule into one verdict (decision + via + preview),
// and the TUI renders the verdict's via on the committed audit line without
// re-deciding. Pure unit tests first (no TUI), then App-level transcript
// pinning via ink-testing-library. Network is ALWAYS mocked here.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { decideApproval, type ApprovalVia, type PolicyContext } from "../src/policy.js";
import type { DiffPreview } from "../src/ui/diff.js";

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    mode: "normal",
    trustAll: false,
    rules: [],
    alwaysAllowed: new Set(),
    skillGrants: new Set(),
    approvalGated: true,
    ...over,
  };
}

const preview: DiffPreview = { oldText: "a", newText: "b", lang: null, path: "f.txt" };

describe("decideApproval: one verdict carries decision + provenance + preview", () => {
  test("deny maps to a deny verdict and still carries the preview", () => {
    const v = decideApproval(
      "bash",
      { command: "x" },
      ctx({ rules: [{ kind: "deny", tool: "bash", glob: null, pattern: "bash" }] }),
      preview
    );
    expect(v).toEqual({ decision: "deny", via: "deny", preview });
  });

  test("each allow via survives verbatim (no collapse to once)", () => {
    const cases: Array<{ over: Partial<PolicyContext>; via: ApprovalVia }> = [
      { over: { mode: "plan" }, via: "plan-passthrough" },
      {
        over: { rules: [{ kind: "allow", tool: "bash", glob: null, pattern: "bash" }] },
        via: "allow-rule",
      },
      { over: { mode: "yolo" }, via: "yolo" },
      { over: { trustAll: true }, via: "trust" },
      { over: { alwaysAllowed: new Set(["bash"]) }, via: "always" },
      { over: { skillGrants: new Set(["bash"]) }, via: "skill-grant" },
    ];
    for (const { over, via } of cases) {
      expect(decideApproval("bash", { command: "x" }, ctx(over), preview)).toEqual({
        decision: "allow",
        via,
        preview,
      });
    }
  });

  test("nothing allowing falls through to a prompt verdict", () => {
    expect(decideApproval("bash", { command: "x" }, ctx(), preview)).toEqual({
      decision: "prompt",
      via: "prompt",
      preview,
    });
  });

  test("deny still wins over plan mode (plan-passthrough never masks a deny)", () => {
    const v = decideApproval(
      "bash",
      { command: "x" },
      ctx({
        mode: "plan",
        rules: [{ kind: "deny", tool: "bash", glob: null, pattern: "bash" }],
      })
    );
    expect(v.decision).toBe("deny");
    expect(v.via).toBe("deny");
  });

  test("preview defaults to null when the caller has none (non-write/edit)", () => {
    const v = decideApproval("bash", { command: "x" }, ctx({ trustAll: true }));
    expect(v).toEqual({ decision: "allow", via: "trust", preview: null });
  });
});

// --- Transcript provenance (mocked chat, real tools, probe files) ---

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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("transcript provenance: the audit line names what allowed the call", () => {
  test("trust-all write renders the label plus a via-trust suffix", async () => {
    const probe = "verdict-probe-trust.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hello" }),
      textMsg("written"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/trust");
      app.stdin.write("\r");
      await waitForFrame(app, "trust: on");
      app.stdin.write("please write it");
      app.stdin.write("\r");
      await waitForFrame(app, "written");
      const frame = app.lastFrame() ?? "";
      // Label text itself untouched; provenance rides a dim suffix outside it.
      expect(frame).toContain(`⚙ write ${probe}`);
      expect(frame).toContain("via trust");
      expect(frame).not.toContain("allow this tool?");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("prompt-approved write renders via-prompt (Enter = once)", async () => {
    const probe = "verdict-probe-prompt.txt";
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
      app.stdin.write("\r");
      await waitForFrame(app, "written");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain(`⚙ write ${probe}`);
      expect(frame).toContain("via prompt");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("allow-rule write renders via-allow-rule with no prompt", async () => {
    const probe = "verdict-probe-rule.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hello" }),
      textMsg("written"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/allow write:verdict-probe-*.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "allowed: write:verdict-probe-*.txt");
      app.stdin.write("please write it");
      app.stdin.write("\r");
      await waitForFrame(app, "written");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain(`⚙ write ${probe}`);
      expect(frame).toContain("via allow-rule");
      expect(frame).not.toContain("allow this tool?");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("denied write names the denial with no via suffix (provenance cleared, not rendered)", async () => {
    const probe = "verdict-probe-deny.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("understood, denied"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it please");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("n");
      await waitForFrame(app, "understood, denied");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("denied by user: write");
      expect(frame).not.toContain("via deny");
      expect(frame).not.toContain("via prompt");
      expect(frame).not.toContain("via trust");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});
