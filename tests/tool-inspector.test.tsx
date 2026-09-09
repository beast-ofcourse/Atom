// Tool-output inspector tests: record capping, list windowing, expanded
// viewport + truncation, and the App-level Ctrl+O open/expand/close flow.
// Network is ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  InspectorPanel,
  LIST_WINDOW,
  MAX_TOOL_RECORDS,
  STORE_CHARS,
  VIEWPORT_LINES,
  createToolRecord,
  windowedList,
  type ToolRecord,
} from "../src/ui/tool-inspector.js";

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

function rec(partial: Partial<ToolRecord> & { label: string }): ToolRecord {
  return {
    id: 0,
    result: "",
    truncated: false,
    isError: false,
    ms: 0,
    lineCount: 0,
    ...partial,
  };
}

describe("createToolRecord", () => {
  test("caps stored text and flags truncation", () => {
    const big = "x".repeat(STORE_CHARS + 100);
    const r = createToolRecord(1, "⚙ read big", big, false, 10);
    expect(r.result.length).toBe(STORE_CHARS);
    expect(r.truncated).toBe(true);
    expect(r.lineCount).toBe(1);
  });
  test("short results pass through unflagged with line counts", () => {
    const r = createToolRecord(2, "⚙ bash ok", "a\nb\nc", false, 5);
    expect(r.truncated).toBe(false);
    expect(r.result).toBe("a\nb\nc");
    expect(r.lineCount).toBe(3);
  });
  test("empty result has zero lines", () => {
    expect(createToolRecord(3, "⚙ x", "", false, 0).lineCount).toBe(0);
  });
});

describe("windowedList", () => {
  test("short lists render whole", () => {
    const w = windowedList([1, 2, 3], 2, LIST_WINDOW);
    expect(w).toEqual({ slice: [1, 2, 3], start: 0, above: 0, below: 0 });
  });
  test("long lists center on the index with counts", () => {
    const items = Array.from({ length: MAX_TOOL_RECORDS }, (_, i) => i);
    const w = windowedList(items, 25, LIST_WINDOW);
    expect(w.slice.length).toBe(LIST_WINDOW);
    expect(w.above + w.slice.length + w.below).toBe(MAX_TOOL_RECORDS);
    expect(w.slice).toContain(25);
    const end = windowedList(items, MAX_TOOL_RECORDS - 1, LIST_WINDOW);
    expect(end.below).toBe(0);
    expect(end.slice).toContain(MAX_TOOL_RECORDS - 1);
  });
});

describe("InspectorPanel list", () => {
  const records = [
    rec({ id: 1, label: "⚙ read a.ts", ms: 50 }),
    rec({ id: 2, label: "⚙ bash pnpm test", ms: 5200 }),
    rec({ id: 3, label: "⚙ write b.ts", isError: true, ms: 30 }),
  ];
  test("rows show labels, slow durations, and error rows", () => {
    const frame = frameOf(<InspectorPanel records={records} index={1} expanded={false} scroll={0} />);
    expect(frame).toContain("Tool outputs");
    expect(frame).toContain("⚙ read a.ts");
    expect(frame).toContain("⚙ bash pnpm test");
    expect(frame).toContain("· 5s");
    expect(frame).toContain("✕ ");
    expect(frame).toContain("⚙ write b.ts");
    expect(frame).toContain("❯ ");
  });
  test("fast runs show no duration suffix", () => {
    const frame = frameOf(<InspectorPanel records={records} index={0} expanded={false} scroll={0} />);
    expect(frame).not.toContain("· 0s");
  });
});

describe("InspectorPanel expanded", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
  const record = rec({
    id: 7,
    label: "⚙ bash pnpm test",
    result: lines.join("\n"),
    ms: 3200,
    lineCount: 50,
  });
  test("header carries state, duration, and line count", () => {
    const frame = frameOf(<InspectorPanel records={[record]} index={0} expanded scroll={0} />);
    expect(frame).toContain("✓ ");
    expect(frame).toContain("⚙ bash pnpm test");
    expect(frame).toContain("· 3s");
    expect(frame).toContain("50 lines");
  });
  test("viewport slices with scroll counts, rules frame the output", () => {
    const top = frameOf(<InspectorPanel records={[record]} index={0} expanded scroll={0} />);
    expect(top).toContain("line-1");
    expect(top).toContain(`line-${VIEWPORT_LINES}`);
    expect(top).not.toContain(`line-${VIEWPORT_LINES + 1}`);
    expect(top).toContain("────");
    const mid = frameOf(<InspectorPanel records={[record]} index={0} expanded scroll={10} />);
    expect(mid).toContain("line-11");
    expect(mid).toContain("↑ 10 more");
    expect(mid).toContain("↓ 20 more");
  });
  test("truncation is explicit", () => {
    const big = rec({ id: 8, label: "⚙ read big", result: "abc", truncated: true, lineCount: 1 });
    const frame = frameOf(<InspectorPanel records={[big]} index={0} expanded scroll={0} />);
    expect(frame).toContain("truncated at");
  });
  test("error record header reads failed", () => {
    const err = rec({ id: 9, label: "⚙ write b.ts", result: "Error: nope", isError: true, lineCount: 1 });
    const frame = frameOf(<InspectorPanel records={[err]} index={0} expanded scroll={0} />);
    expect(frame).toContain("✕ ");
    expect(frame).toContain("Error: nope");
  });
});

// --- App-level Ctrl+O flow (mocked chat, real read tool) ---

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

describe("App Ctrl+O inspector flow", () => {
  test("empty log reports, no panel", async () => {
    mockChatScriptMessages([textMsg("hi")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("\x0F");
      await waitForFrame(app, "(no tool calls yet");
      expect(app.lastFrame()).not.toContain("Tool outputs — select");
    } finally {
      app.unmount();
    }
  });
  test("open, expand to full output, collapse, close", async () => {
    mockChatScriptMessages([
      toolMsg("c1", "read", { path: "package.json" }),
      textMsg("read it"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("read it");
      app.stdin.write("\r");
      await waitForFrame(app, "⚙ read package.json");
      await waitForFrame(app, "read it");
      // Open: the retained call lists.
      app.stdin.write("\x0F");
      await waitForFrame(app, "Tool outputs — select");
      expect(app.lastFrame()).toContain("⚙ read package.json");
      // Expand: full file output + rules + line count.
      app.stdin.write("\r");
      await waitForFrame(app, "atom-agent");
      expect(app.lastFrame()).toContain("────");
      expect(app.lastFrame()).toContain("line");
      // Collapse back to the list, then close the panel.
      app.stdin.write("\u001B");
      await waitForFrame(app, "Tool outputs — select");
      app.stdin.write("\u001B");
      await new Promise((r) => setTimeout(r, 100));
      expect(app.lastFrame()).not.toContain("Tool outputs — select");
    } finally {
      app.unmount();
    }
  });
});
