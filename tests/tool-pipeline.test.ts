// Ticket 03 receipt unity: telemetry, history, and the transcript observe
// the SAME receipt (effective post-before-hook args + final post-after-hook
// result) on the serial path. Behavioral only — through runLoopWithChat,
// no TUI, no network.
import { afterEach, describe, expect, test } from "vitest";
import { runLoopWithChat, type ChatMessage, type ChatResult } from "../src/zen.js";
import type { SinkToolCallInfo } from "../src/telemetry.js";
import { clearToolInterceptors, registerAfterToolCall, registerBeforeToolCall } from "../src/tools.js";
import type { ToolFinishedInfo, ToolStartedInfo } from "../src/agent/turn-events.js";
import { parseToolArguments } from "../src/agent/tool-pipeline.js";

afterEach(() => {
  clearToolInterceptors();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

function oneCall(id: string, name: string, args: string): ChatResult {
  return { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] };
}

function scripted(first: ChatResult, final = "done") {
  let n = 0;
  return async (): Promise<ChatResult> => {
    n += 1;
    return n === 1 ? first : { content: final };
  };
}

function toolContents(history: ChatMessage[]): string[] {
  return history
    .filter((m) => m.role === "tool")
    .map((m) => (m as { content: string }).content);
}

type Observers = {
  telemetry: SinkToolCallInfo[];
  activities: Array<{ label: string; result: string; isError: boolean }>;
  started: ToolStartedInfo[];
  finished: ToolFinishedInfo[];
};

function observe(): Observers & { opts: Record<string, unknown> } {
  const out: Observers = { telemetry: [], activities: [], started: [], finished: [] };
  return {
    ...out,
    opts: {
      telemetry: { onToolCall: (info: SinkToolCallInfo) => void out.telemetry.push(info) },
      onToolActivity: (label: string, result: string, isError: boolean) =>
        void out.activities.push({ label, result, isError }),
      turnEvents: {
        onToolStarted: (info: ToolStartedInfo) => void out.started.push({ ...info }),
        onToolFinished: (info: ToolFinishedInfo) => void out.finished.push({ ...info }),
      },
    },
  };
}

describe("receipt unity: one receipt for telemetry, history, and transcript", () => {
  test("after-hook patch is what telemetry, history, and activity all observe", async () => {
    registerAfterToolCall(() => "redacted", "scrubber");
    const history = baseHistory();
    const o = observe();
    const reply = await runLoopWithChat(
      scripted(oneCall("c1", "read", '{"path":"a.txt"}')),
      history,
      { execute: async () => "secret-bytes", ...o.opts, sleep: async () => {} }
    );
    expect(reply).toBe("done");
    expect(o.telemetry).toHaveLength(1);
    expect(o.telemetry[0]!.result).toBe("redacted");
    expect(toolContents(history)).toEqual(["redacted"]);
    expect(o.activities).toEqual([{ label: expect.any(String), result: "redacted", isError: false }]);
    expect(o.finished).toEqual([{ toolCallId: "c1", name: "read", isError: false }]);
  });

  test("onToolResult rewrite + isError flip agree across history, activity, and sink", async () => {
    const history = baseHistory();
    const o = observe();
    await runLoopWithChat(scripted(oneCall("c1", "read", '{"path":"a.txt"}')), history, {
      execute: async () => "all good",
      onToolResult: () => ({ content: "all good (flagged)", isError: true }),
      ...o.opts,
      sleep: async () => {},
    });
    expect(o.telemetry).toHaveLength(1);
    expect(o.telemetry[0]!.result).toBe("all good (flagged)");
    expect(toolContents(history)).toEqual(["all good (flagged)"]);
    expect(o.activities).toEqual([
      { label: expect.any(String), result: "all good (flagged)", isError: true },
    ]);
    expect(o.finished).toEqual([{ toolCallId: "c1", name: "read", isError: true }]);
  });

  test("before-hook rewrite: telemetry argsJson matches the args that executed", async () => {
    registerBeforeToolCall(({ name, args }) => {
      if (name === "read") return { args: { ...args, path: "rewritten.txt" } };
    }, "rewriter");
    const seen: Array<Record<string, unknown>> = [];
    const history = baseHistory();
    const o = observe();
    await runLoopWithChat(scripted(oneCall("c1", "read", '{"path":"a.txt"}')), history, {
      execute: async (_name, args) => {
        seen.push(args);
        return `ok:${String(args["path"])}`;
      },
      ...o.opts,
      sleep: async () => {},
    });
    expect(seen).toEqual([{ path: "rewritten.txt" }]);
    expect(o.telemetry).toHaveLength(1);
    expect(JSON.parse(o.telemetry[0]!.argsJson)).toEqual({ path: "rewritten.txt" });
    expect(toolContents(history)).toEqual(["ok:rewritten.txt"]);
  });

  test("veto: no history, no activity, no sink finish — telemetry still records the attempt", async () => {
    const history = baseHistory();
    const o = observe();
    const reply = await runLoopWithChat(scripted(oneCall("c1", "read", '{"path":"a.txt"}')), history, {
      execute: async () => "dropped",
      onToolResult: () => ({ veto: true }),
      ...o.opts,
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    expect(history.some((m) => m.role === "tool")).toBe(false);
    expect(o.activities).toEqual([]);
    expect(o.started).toEqual([{ toolCallId: "c1", name: "read", index: 0 }]);
    expect(o.finished).toEqual([]);
    expect(o.telemetry).toHaveLength(1);
    expect(o.telemetry[0]!.result).toBe("dropped");
  });

  test("invalid JSON routes through the funnel: patch visible to all three observers", async () => {
    registerAfterToolCall(({ result }) => `${result}+patched`, "patcher");
    const history = baseHistory();
    const o = observe();
    await runLoopWithChat(scripted(oneCall("c1", "read", "{oops")), history, {
      execute: async () => "must not run",
      ...o.opts,
      sleep: async () => {},
    });
    const contents = toolContents(history);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("invalid JSON");
    expect(contents[0]!.endsWith("+patched")).toBe(true);
    expect(o.telemetry).toHaveLength(1);
    expect(o.telemetry[0]!.result).toBe(contents[0]);
    expect(o.activities).toHaveLength(1);
    expect(o.activities[0]!.result).toBe(contents[0]);
  });

  test("truncated calls commit through the funnel with a unified receipt", async () => {
    registerAfterToolCall(({ result }) => `${result}+patched`, "patcher");
    const history = baseHistory();
    const o = observe();
    const reply = await runLoopWithChat(
      scripted({ ...oneCall("c1", "read", '{"path":"a'), truncated: true }),
      history,
      { execute: async () => "must not run", ...o.opts, sleep: async () => {} }
    );
    expect(reply).toBe("done");
    const contents = toolContents(history);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("truncated response");
    expect(o.telemetry).toHaveLength(1);
    expect(o.telemetry[0]!.result).toBe(contents[0]);
    expect(o.activities).toHaveLength(1);
    expect(o.activities[0]!.result).toBe(contents[0]);
  });
});

describe("parseToolArguments", () => {
  test("parses JSON objects, rejects malformed and non-object payloads", () => {
    expect(parseToolArguments('{"path":"a.txt"}')).toEqual({ path: "a.txt" });
    expect(parseToolArguments("{}")).toEqual({});
    expect(parseToolArguments("{oops")).toBeNull();
    expect(parseToolArguments("[1,2]")).toBeNull();
    expect(parseToolArguments("42")).toBeNull();
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments(null)).toEqual({});
  });
});
