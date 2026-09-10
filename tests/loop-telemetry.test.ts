// Loop→telemetry wiring tests: the harness LoopStats rollup attaches to the
// open turn trace, survives endTurn, aggregates across sessions, and renders
// in the dashboard. No network, no TUI.
import { describe, expect, test } from "vitest";
import { clearTodos } from "../src/tools.js";
import { runLoopWithChat, type ChatMessage, type ChatResult } from "../src/zen.js";
import { buildDashboardHtml } from "../src/telemetry-dashboard.js";
import {
  createTelemetryRecorder,
  summarizeTelemetry,
  type TurnLoopSummary,
} from "../src/telemetry.js";

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

describe("recordLoopStats", () => {
  test("attaches to the open turn; ignores unknown turns and bad input", () => {
    const rec = createTelemetryRecorder({});
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    const summary: TurnLoopSummary = {
      cacheHits: 3,
      repetitionHits: 1,
      failures: 0,
      truncations: 0,
      contextGrowthChars: 120,
      loopDurationMs: 450,
      bottleneckName: "read",
      bottleneckMs: 200,
    };
    rec.recordLoopStats(turnId, summary);
    rec.recordLoopStats("nope", summary); // unknown turn: no-op
    rec.recordLoopStats(turnId, null); // bad input: no-op, keeps previous
    rec.recordLoopStats(null, summary); // null id: no-op
    const snap = rec.getSnapshot();
    expect(snap.turns).toHaveLength(1);
    expect(snap.turns[0]!.loop).toEqual(summary);
  });

  test("accepts raw LoopStats shape (bottleneck object + truncationNotices)", () => {
    const rec = createTelemetryRecorder({});
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    rec.recordLoopStats(turnId, {
      steps: 2,
      modelCalls: 2,
      toolCalls: 1,
      failures: 1,
      repetitionHits: 0,
      cacheHits: 2,
      truncationNotices: 1,
      durationMs: 900,
      bottleneck: { name: "grep", durationMs: 700 },
      contextGrowthChars: -50,
    });
    expect(rec.getSnapshot().turns[0]!.loop).toEqual({
      cacheHits: 2,
      repetitionHits: 0,
      failures: 1,
      truncations: 1,
      contextGrowthChars: -50,
      loopDurationMs: 900,
      bottleneckName: "grep",
      bottleneckMs: 700,
    });
  });

  test("disabled recorder is a no-op", () => {
    const rec = createTelemetryRecorder({ enabled: false });
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    expect(turnId).toBeNull();
    rec.recordLoopStats(turnId, { cacheHits: 1 });
    expect(rec.getSnapshot().turns).toHaveLength(0);
  });

  test("survives endTurn alongside the outcome", () => {
    const rec = createTelemetryRecorder({});
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    rec.recordLoopStats(turnId, {
      cacheHits: 0,
      repetitionHits: 0,
      failures: 0,
      truncations: 0,
      contextGrowthChars: 10,
      loopDurationMs: 100,
    });
    rec.endTurn(turnId, "completed", "done");
    const turn = rec.getSnapshot().turns[0]!;
    expect(turn.outcome).toBe("completed");
    expect(turn.loop?.cacheHits).toBe(0);
  });
});

describe("aggregates + dashboard", () => {
  test("cacheHits/repetitionHits sum over reporting turns only", () => {
    const rec = createTelemetryRecorder({});
    const t1 = rec.startTurn("a", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    rec.recordLoopStats(t1, {
      cacheHits: 4,
      repetitionHits: 2,
      failures: 0,
      truncations: 0,
      contextGrowthChars: 0,
      loopDurationMs: 10,
    });
    rec.endTurn(t1, "completed", "ok");
    const t2 = rec.startTurn("b", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    rec.endTurn(t2, "completed", "ok"); // no loop stats: contributes zero
    const agg = summarizeTelemetry([rec.getSnapshot()]);
    expect(agg.cacheHits).toBe(4);
    expect(agg.repetitionHits).toBe(2);
  });

  test("dashboard renders loop fragments only when reported", () => {
    const rec = createTelemetryRecorder({});
    const t1 = rec.startTurn("a", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    rec.recordLoopStats(t1, {
      cacheHits: 5,
      repetitionHits: 0,
      failures: 0,
      truncations: 0,
      contextGrowthChars: 0,
      loopDurationMs: 10,
      bottleneckName: "webfetch",
      bottleneckMs: 1200,
    });
    rec.endTurn(t1, "completed", "ok");
    const html = buildDashboardHtml([rec.getSnapshot()]);
    expect(html).toContain("read-cache hits");
    expect(html).toContain("bottleneck");
    expect(html).toContain("webfetch");
    expect(html).not.toContain("loop-guard hits"); // zero → omitted, never a fake zero claim

    const rec2 = createTelemetryRecorder({});
    const t2 = rec2.startTurn("b", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    rec2.endTurn(t2, "completed", "ok");
    const html2 = buildDashboardHtml([rec2.getSnapshot()]);
    expect(html2).not.toContain("read-cache hits");
    expect(html2).not.toContain("bottleneck");
  });
});

describe("end-to-end: loop onLoopStats → recorder", () => {
  test("a real turn flows stats into the trace without TUI", async () => {
    clearTodos();
    const rec = createTelemetryRecorder({});
    const turnId = rec.startTurn("go", { provider: "p", model: "m", effort: "default", mode: "yolo" });
    const history = baseHistory();
    const queue: ChatResult[] = [
      {
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }],
      },
      { content: "done" },
    ];
    const reply = await runLoopWithChat(
      async () => (queue.length > 1 ? queue.shift()! : queue[0]!),
      history,
      {
        execute: async () => "tool-result",
        telemetry: {
          onModelCall: (info) => rec.recordModelCall(turnId, info),
          onToolCall: (info) => rec.recordToolCall(turnId, info),
        },
        onLoopStats: (s) => rec.recordLoopStats(turnId, s),
        sleep: async () => {},
      }
    );
    expect(reply).toBe("done");
    rec.endTurn(turnId, "completed", reply);
    const turn = rec.getSnapshot().turns[0]!;
    expect(turn.modelCalls.length).toBe(2);
    expect(turn.toolCalls.length).toBe(1);
    expect(turn.loop?.cacheHits).toBeGreaterThanOrEqual(0);
    expect(turn.loop?.loopDurationMs).toBeGreaterThanOrEqual(0);
    expect(turn.loop?.bottleneckName).toBe("glob");
    clearTodos();
  });
});
