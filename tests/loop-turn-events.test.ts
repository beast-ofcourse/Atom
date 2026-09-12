// TurnEvents sink tests: the loop emits every turn event (streamed tokens,
// thinking, phase changes, tool started/finished with stable tool IDs)
// through one ordered sink while all existing callbacks keep working
// byte-identically. No network, no TUI.
import { describe, expect, test } from "vitest";
import {
  runLoopWithChat,
  type AgenticOpts,
  type ChatMessage,
  type ChatResult,
  type Phase,
} from "../src/zen.js";
import type {
  ToolFinishedInfo,
  ToolStartedInfo,
  TurnEventsSink,
} from "../src/agent/turn-events.js";

type SinkEvent =
  | { kind: "token"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "phase"; phase: Phase; detail?: string }
  | { kind: "tool-started"; info: ToolStartedInfo }
  | { kind: "tool-finished"; info: ToolFinishedInfo };

function recordingSink(into: SinkEvent[]): TurnEventsSink {
  return {
    onToken: (text) => void into.push({ kind: "token", text }),
    onThinking: (thinking) => void into.push({ kind: "thinking", text: thinking }),
    onPhase: (phase, detail) => void into.push({ kind: "phase", phase, detail }),
    onToolStarted: (info) => void into.push({ kind: "tool-started", info: { ...info } }),
    onToolFinished: (info) => void into.push({ kind: "tool-finished", info: { ...info } }),
  };
}

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

// Scripted turn: one tool round (read call_1) with streamed token/thinking/
// phase traffic mimicking a live transport, then final text.
function scriptedChat() {
  let n = 0;
  return async (_history: ChatMessage[], o?: AgenticOpts): Promise<ChatResult> => {
    n += 1;
    if (n === 1) {
      o?.onPhase?.("thinking");
      o?.onThinking?.("looking up the file");
      o?.onPhase?.("streaming");
      o?.onToken?.("working");
      o?.onToolDelta?.("read", 0);
      o?.onPhase?.("tool", "read");
      return {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a.txt"}' },
          },
        ],
      };
    }
    return { content: "done" };
  };
}

type CallbackLog = {
  phases: Array<{ phase: Phase; detail?: string }>;
  tokens: string[];
  thinking: string[];
  deltas: Array<{ name: string; index: number }>;
  activities: Array<{ label: string; result: string; isError: boolean }>;
};

function emptyLog(): CallbackLog {
  return { phases: [], tokens: [], thinking: [], deltas: [], activities: [] };
}

async function runScripted(withSink: boolean): Promise<{
  reply: string;
  log: CallbackLog;
  events: SinkEvent[];
  history: ChatMessage[];
}> {
  const log = emptyLog();
  const events: SinkEvent[] = [];
  const history = baseHistory();
  const reply = await runLoopWithChat(scriptedChat(), history, {
    execute: async () => "file contents",
    onPhase: (phase, detail) => void log.phases.push({ phase, detail }),
    onToken: (text) => void log.tokens.push(text),
    onThinking: (text) => void log.thinking.push(text),
    onToolDelta: (name, index) => void log.deltas.push({ name, index }),
    onToolActivity: (label, result, isError) =>
      void log.activities.push({ label, result, isError }),
    ...(withSink ? { turnEvents: recordingSink(events) } : {}),
  });
  return { reply, log, events, history };
}

function toolStartedOf(e: SinkEvent): ToolStartedInfo {
  if (e.kind !== "tool-started") throw new Error(`expected tool-started, saw ${e.kind}`);
  return e.info;
}

function toolFinishedOf(e: SinkEvent): ToolFinishedInfo {
  if (e.kind !== "tool-finished") throw new Error(`expected tool-finished, saw ${e.kind}`);
  return e.info;
}

describe("turn-events sink", () => {
  test("callback stream and sink stream agree on identity and order", async () => {
    const { reply, log, events } = await runScripted(true);
    expect(reply).toBe("done");

    // Token/thinking streams mirror the callbacks exactly (same values, order).
    const sinkTokens = events.filter((e) => e.kind === "token").map((e) => (e as { text: string }).text);
    expect(sinkTokens).toEqual(log.tokens);
    expect(sinkTokens).toEqual(["working"]);
    const sinkThinking = events
      .filter((e) => e.kind === "thinking")
      .map((e) => (e as { text: string }).text);
    expect(sinkThinking).toEqual(log.thinking);
    expect(sinkThinking).toEqual(["looking up the file"]);

    // Phase stream mirrors the callbacks exactly (same phases + details, order).
    const sinkPhases = events.filter((e) => e.kind === "phase");
    expect(sinkPhases).toEqual(log.phases.map((p) => ({ kind: "phase", ...p })));
    expect(log.phases.map((p) => p.phase)).toEqual([
      "thinking",
      "streaming",
      "tool",
      "tool",
      "done",
    ]);

    // Tool identity is the stable tool_call_id + name — never a display label.
    // The sink shape itself carries no label/args/result payload to parse.
    const started = events.filter((e) => e.kind === "tool-started");
    const finished = events.filter((e) => e.kind === "tool-finished");
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(toolStartedOf(started[0]!)).toEqual({
      toolCallId: "call_1",
      name: "read",
      index: 0,
    });
    expect(toolFinishedOf(finished[0]!)).toEqual({
      toolCallId: "call_1",
      name: "read",
      isError: false,
    });

    // Commit order: started before finished, and the done phase closes the turn.
    const order = events.map((e) => e.kind);
    expect(order.indexOf("tool-started")).toBeLessThan(order.indexOf("tool-finished"));
    expect(order.at(-1)).toBe("phase");
    expect((events.at(-1) as { phase: Phase }).phase).toBe("done");

    // Every tool transition visible in the callbacks also appears in the sink
    // with the same identity: each onPhase("tool") has a matching started,
    // and each onToolActivity pairs with the finished of the same call.
    const toolPhases = log.phases.filter((p) => p.phase === "tool");
    expect(toolPhases.length).toBeGreaterThan(0);
    for (const p of toolPhases) {
      expect(started.some((s) => toolStartedOf(s).name === p.detail)).toBe(true);
    }
    expect(log.activities).toHaveLength(1);
    expect(log.activities[0]!.result).toBe("file contents");
    expect(log.activities[0]!.isError).toBe(false);
    expect(toolFinishedOf(finished[0]!).toolCallId).toBe("call_1");
    expect(toolFinishedOf(finished[0]!).isError).toBe(log.activities[0]!.isError);
  });

  test("callbacks are byte-identical with and without the sink", async () => {
    const without = await runScripted(false);
    const withSink = await runScripted(true);
    expect(withSink.reply).toBe(without.reply);
    expect(withSink.log).toEqual(without.log);
    expect(withSink.history).toEqual(without.history);
  });

  test("a throwing sink never breaks the turn", async () => {
    const throwing: TurnEventsSink = {
      onToken: () => {
        throw new Error("sink boom");
      },
      onThinking: () => {
        throw new Error("sink boom");
      },
      onPhase: () => {
        throw new Error("sink boom");
      },
      onToolStarted: () => {
        throw new Error("sink boom");
      },
      onToolFinished: () => {
        throw new Error("sink boom");
      },
    };
    const phases: string[] = [];
    const tokens: string[] = [];
    const reply = await runLoopWithChat(scriptedChat(), baseHistory(), {
      execute: async () => "file contents",
      onPhase: (phase) => void phases.push(phase),
      onToken: (text) => void tokens.push(text),
      turnEvents: throwing,
    });
    expect(reply).toBe("done");
    expect(tokens).toEqual(["working"]);
    expect(phases).toContain("done");
  });
});
