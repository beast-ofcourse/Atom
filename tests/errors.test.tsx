// Error-presentation tests: all seven states classify with distinct
// titles/glyphs/hints, label pairing names the tool, and non-errors pass
// through untouched.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  ErrorCard,
  MAX_DETAIL_CHARS,
  classifyToolError,
  parseToolLabel,
  titleCase,
  type ErrorKind,
} from "../src/ui/errors.js";
import { renderTranscriptItem, type StaticItem, type Turn } from "../src/ui/transcript.js";

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

const tool = (content: string, error?: boolean): Turn =>
  error ? { role: "tool", content, error } : { role: "tool", content };

describe("classifyToolError", () => {
  test("tool failure pairs the label for its title", () => {
    const c = classifyToolError(tool("  ↳ Error: boom", true), tool("⚙ read src/x.ts"))!;
    expect(c.kind).toBe("tool");
    expect(c.title).toBe("Read failed");
    expect(c.detail).toBe("Error: boom");
    expect(c.hint).toContain("Ctrl+O");
    expect(c.inspectable).toBe(true);
  });
  test("unlabeled tool failure still cards", () => {
    const c = classifyToolError(tool("Error: boom", true), null)!;
    expect(c.kind).toBe("tool");
    expect(c.title).toBe("Tool failed");
  });
  test("denial names the tool with guidance", () => {
    const c = classifyToolError(tool("  ↳ Error: denied by user: write", true), tool("⚙ write f"))!;
    expect(c.kind).toBe("denial");
    expect(c.title).toContain("Denied");
    expect(c.title).toContain("Write");
    expect(c.hint).toContain("/allow");
    expect(c.inspectable).toBe(false);
  });
  const networks = [
    "Zen HTTP 429: slow down",
    "HTTP 503: unavailable",
    "connection reset by peer",
    "fetch failed",
    "network timeout",
  ];
  for (const detail of networks) {
    test(`network: ${detail.slice(0, 24)}`, () => {
      const c = classifyToolError(tool(detail, true), null)!;
      expect(c.kind).toBe("network");
      expect(c.title).toBe("Network failed");
      expect(c.hint).toContain("Auto-retried");
    });
  }
  test("model failure", () => {
    const c = classifyToolError(tool("Truncated stream", true), null)!;
    expect(c.kind).toBe("model");
    expect(c.title).toBe("Model failed");
    const c2 = classifyToolError(tool("Empty reply from model", true), null)!;
    expect(c2.kind).toBe("model");
  });
  test("config failure with and without the error flag", () => {
    const c = classifyToolError(tool("Missing API key for openai — run /provider", true), null)!;
    expect(c.kind).toBe("config");
    expect(c.title).toBe("Setup needed");
    expect(c.hint).toContain("/provider");
    const plain = classifyToolError(tool("Missing API key for x"), null)!;
    expect(plain.kind).toBe("config");
  });
  test("internal error", () => {
    const c = classifyToolError(tool("panic: invariant violated", true), null)!;
    expect(c.kind).toBe("internal");
    expect(c.title).toBe("Internal error");
  });
  test("multi-line error detail summarizes to its first line (never a wall)", () => {
    const c = classifyToolError(
      tool("  ↳ Error: boom\nsecond line\nthird line", true),
      tool("⚙ read src/x.ts")
    )!;
    expect(c.kind).toBe("tool");
    expect(c.detail).toBe("Error: boom");
  });
  test("giant single-line detail caps instead of walling", () => {
    const c = classifyToolError(tool(`Error: ${"x".repeat(500)}`, true), null)!;
    expect(c.detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS + 1);
    expect(c.detail.endsWith("…")).toBe(true);
  });
  test("non-errors pass through (null)", () => {
    expect(classifyToolError(tool("⚙ read a.ts"), null)).toBe(null);
    expect(classifyToolError(tool("Tasks 1/1\n✅ done"), null)).toBe(null);
    expect(classifyToolError(tool("↻ retrying… x"), null)).toBe(null);
    expect(classifyToolError(tool("⚠ careful"), null)).toBe(null);
    expect(classifyToolError(tool("(cancelled) conversation rolled back"), null)).toBe(null);
    expect(classifyToolError(tool("⊘ notice"), null)).toBe(null);
  });
});

describe("parseToolLabel + titleCase", () => {
  test("splits name and target", () => {
    expect(parseToolLabel("⚙ bash pnpm test")).toEqual({ name: "bash", target: "pnpm test" });
    expect(parseToolLabel("⚙ todo_get")).toEqual({ name: "todo_get", target: "" });
    expect(titleCase("bash")).toBe("Bash");
    expect(titleCase("")).toBe("");
  });
});

describe("ErrorCard", () => {
  const kinds: { kind: ErrorKind; glyph: string }[] = [
    { kind: "tool", glyph: "✕" },
    { kind: "denial", glyph: "⊘" },
    { kind: "network", glyph: "⚠" },
    { kind: "model", glyph: "✕" },
    { kind: "config", glyph: "→" },
    { kind: "internal", glyph: "‼" },
  ];
  for (const { kind, glyph } of kinds) {
    test(`${kind} renders glyph + title + hint`, () => {
      const frame = frameOf(
        <ErrorCard classified={{ kind, title: "T", detail: "D", hint: "H", inspectable: false }} />
      );
      expect(frame).toContain(glyph);
      expect(frame).toContain("T");
      expect(frame).toContain("D");
      expect(frame).toContain("H");
    });
  }
  test("no hint line when absent", () => {
    const frame = frameOf(
      <ErrorCard classified={{ kind: "tool", title: "T", detail: "D", hint: null, inspectable: true }} />
    );
    expect(frame).toContain("T");
  });
  test("denial and network read calm — never the failure cross", () => {
    const denial = frameOf(
      <ErrorCard
        classified={{ kind: "denial", title: "Denied — Write", detail: "D", hint: "H", inspectable: false }}
      />
    );
    expect(denial).toContain("⊘");
    expect(denial).not.toContain("✕");
    const network = frameOf(
      <ErrorCard
        classified={{ kind: "network", title: "Network failed", detail: "D", hint: "H", inspectable: false }}
      />
    );
    expect(network).toContain("⚠");
    expect(network).not.toContain("✕");
  });
});

describe("transcript pairing", () => {
  test("adjacent label+error merge into audit line plus card", () => {
    const item: StaticItem = {
      id: "turn-0",
      turn: tool("  ↳ Error: boom", true),
      label: tool("⚙ read src/x.ts"),
    };
    const frame = frameOf(renderTranscriptItem(item) as React.ReactNode);
    expect(frame).toContain("⚙ read src/x.ts");
    expect(frame).toContain("Read failed");
    expect(frame).toContain("Error: boom");
  });
  test("lone error detail still cards without a label", () => {
    const item: StaticItem = {
      id: "turn-0",
      turn: tool("Error: boom", true),
    };
    const frame = frameOf(renderTranscriptItem(item) as React.ReactNode);
    expect(frame).toContain("Tool failed");
  });
  test("cancelled keeps its legacy line (no card)", () => {
    const item: StaticItem = {
      id: "turn-0",
      turn: tool("(cancelled) conversation rolled back"),
    };
    const frame = frameOf(renderTranscriptItem(item) as React.ReactNode);
    expect(frame).toContain("(cancelled)");
    expect(frame).not.toContain("✕");
  });
});

// --- App-level error cards (mocked chat, real tools) ---

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

describe("App error cards", () => {
  test("failed read renders a named card with inspector hint", async () => {
    mockChatScriptMessages([
      toolMsg("c1", "read", { path: "does-not-exist-xyz/nope.txt" }),
      textMsg("noted"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("read it");
      app.stdin.write("\r");
      await waitForFrame(app, "Read failed");
      expect(app.lastFrame()).toContain("Ctrl+O");
      await waitForFrame(app, "noted");
    } finally {
      app.unmount();
    }
  });
  test("denied write renders a denial card, file untouched", async () => {
    const probe = "error-probe-deny.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("understood"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("n");
      await waitForFrame(app, "Denied");
      expect(app.lastFrame()).toContain("/allow");
      await waitForFrame(app, "understood");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});
