// Ticket 05: the parallel batch path executes each member through the shared
// ticket-03 pipeline runner (planToolCall + runPlannedToolCall), and the
// scheduler plans from a static registry snapshot. Behavioral only — through
// runLoopWithChat / planBatches, no TUI, no network.
import { afterEach, describe, expect, test } from "vitest";
import { runLoopWithChat, type ChatMessage, type ChatResult, type ToolCall } from "../src/zen.js";
import { captureSchedulerSnapshot, planBatches } from "../src/scheduler.js";
import type { SinkToolCallInfo } from "../src/telemetry.js";
import {
  clearToolInterceptors,
  registerBeforeToolCall,
  registerExtensionToolOverride,
  type ExtensionToolOverrideDefinition,
} from "../src/tools.js";
import type { ToolFinishedInfo, ToolStartedInfo } from "../src/agent/turn-events.js";

afterEach(() => {
  clearToolInterceptors();
});

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// One script exercising every inline-result shape alongside real execution:
// executed reads, a pre-hook block, an approval denial, a validation error,
// and an unknown tool.
const SCRIPT: Array<{ id: string; name: string; args: Record<string, unknown> }> = [
  { id: "r1", name: "read", args: { path: "a.txt" } },
  { id: "r2", name: "read", args: { path: "b.txt" } },
  { id: "g1", name: "grep", args: { pattern: "needle" } },
  { id: "w1", name: "write", args: { path: "c.txt", content: "x" } },
  { id: "bad", name: "read", args: { path: 42 as unknown as string } },
  { id: "u1", name: "nope_tool", args: {} },
];

const SCRIPT_IDS = SCRIPT.map((s) => s.id);

type ScriptRun = {
  toolContents: string[];
  toolIds: Array<string | undefined>;
  activities: Array<{ label: string; result: string; isError: boolean }>;
  startedIds: Array<string | undefined>;
  finished: ToolFinishedInfo[];
  telemetryById: Record<string, SinkToolCallInfo>;
  batchOf: Record<string, { batchIndex: number; batchSize: number }>;
  approvals: string[];
};

async function runScript(mode: "serial" | "parallel"): Promise<ScriptRun> {
  const unregisterBlock = registerBeforeToolCall(({ name }) => {
    if (name === "grep") return { block: "grep is offline in this test" };
  }, "parity-test");
  try {
    const messages: ChatResult[] =
      mode === "parallel"
        ? [{ content: null, tool_calls: SCRIPT.map((s) => call(s.id, s.name, s.args)) }]
        : SCRIPT.map((s) => ({ content: null, tool_calls: [call(s.id, s.name, s.args)] }));
    let n = 0;
    const chatFn = async (): Promise<ChatResult> => messages[n++] ?? { content: "done" };
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "go" },
    ];
    const telemetry: SinkToolCallInfo[] = [];
    const activities: ScriptRun["activities"] = [];
    const started: ToolStartedInfo[] = [];
    const finished: ToolFinishedInfo[] = [];
    const approvals: string[] = [];
    await runLoopWithChat(chatFn, history, {
      execute: async (name, args) => `out:${name}:${JSON.stringify(args)}`,
      approve: async (name) => {
        approvals.push(name);
        return name === "write" ? "no" : "once";
      },
      telemetry: { onToolCall: (info) => void telemetry.push(info) },
      onToolActivity: (label, result, isError) => void activities.push({ label, result, isError }),
      turnEvents: {
        onToolStarted: (info) => void started.push({ ...info }),
        onToolFinished: (info) => void finished.push({ ...info }),
      },
      sleep: async () => {},
    });
    const tools = history.filter((m) => m.role === "tool") as Array<{
      tool_call_id?: string;
      content: string;
    }>;
    const telemetryById: Record<string, SinkToolCallInfo> = {};
    const batchOf: Record<string, { batchIndex: number; batchSize: number }> = {};
    for (const t of telemetry) {
      telemetryById[t.toolCallId] = t;
      batchOf[t.toolCallId] = { batchIndex: t.batchIndex, batchSize: t.batchSize };
    }
    return {
      toolContents: tools.map((m) => m.content),
      toolIds: tools.map((m) => m.tool_call_id),
      activities,
      startedIds: started.map((s) => s.toolCallId),
      finished,
      telemetryById,
      batchOf,
      approvals,
    };
  } finally {
    unregisterBlock();
  }
}

describe("serial/parallel parity through the shared runner", () => {
  test("same script, identical outcomes: results, error flags, commit order", async () => {
    const serial = await runScript("serial");
    const parallel = await runScript("parallel");

    // Identical committed results, in identical call order.
    expect(parallel.toolIds).toEqual(SCRIPT_IDS);
    expect(serial.toolIds).toEqual(SCRIPT_IDS);
    expect(parallel.toolContents).toEqual(serial.toolContents);

    // Identical activity stream (labels, results, error flags).
    expect(parallel.activities).toEqual(serial.activities);

    // Identical sink pairing: started upfront in call order, finished in the
    // ordered commit funnel.
    expect(parallel.startedIds).toEqual(SCRIPT_IDS);
    expect(serial.startedIds).toEqual(SCRIPT_IDS);
    expect(parallel.finished).toEqual(serial.finished);

    // Identical per-call telemetry results (telemetry observes the same
    // receipt the commit funnel records).
    for (const id of SCRIPT_IDS) {
      expect(parallel.telemetryById[id]?.result).toBe(serial.telemetryById[id]?.result);
      expect(parallel.telemetryById[id]?.argsJson).toBe(serial.telemetryById[id]?.argsJson);
    }

    // Every inline-result shape is present and identical in both runs.
    const byId = (run: ScriptRun): Record<string, string> =>
      Object.fromEntries(run.toolIds.map((id, i) => [id as string, run.toolContents[i] as string]));
    const p = byId(parallel);
    expect(p["r1"]).toBe('out:read:{"path":"a.txt"}');
    expect(p["r2"]).toBe('out:read:{"path":"b.txt"}');
    expect(p["g1"]).toMatch(/^Error: blocked by extension/);
    expect(p["w1"]).toBe("Error: denied by user: write");
    expect(p["bad"]).toMatch(/^Error: invalid call:/);
    expect(p["u1"]).toMatch(/^Error: unknown tool "nope_tool"/);

    // The shared plan resolves approval exactly once per approval-gated call
    // in both paths — planning never double-prompts the runner.
    expect(parallel.approvals).toEqual(["write"]);
    expect(serial.approvals).toEqual(["write"]);
  });

  test("per-member telemetry keeps {batchIndex, batchSize}: parallel fans out, serial stays singleton", async () => {
    const parallel = await runScript("parallel");
    expect(parallel.batchOf["r1"]).toEqual({ batchIndex: 0, batchSize: 4 });
    expect(parallel.batchOf["r2"]).toEqual({ batchIndex: 1, batchSize: 4 });
    expect(parallel.batchOf["g1"]).toEqual({ batchIndex: 2, batchSize: 4 });
    expect(parallel.batchOf["w1"]).toEqual({ batchIndex: 3, batchSize: 4 });
    // Validation/unknown failures plan as serial singletons downstream.
    expect(parallel.batchOf["bad"]).toEqual({ batchIndex: 0, batchSize: 1 });
    expect(parallel.batchOf["u1"]).toEqual({ batchIndex: 0, batchSize: 1 });

    const serial = await runScript("serial");
    for (const id of SCRIPT_IDS) {
      expect(serial.batchOf[id]).toEqual({ batchIndex: 0, batchSize: 1 });
    }
  });
});

describe("scheduler plans from a static snapshot", () => {
  test("a snapshot freezes planning inputs: later registration cannot reshape a planned batch", () => {
    const reads = [call("r1", "read", { path: "a.txt" }), call("r2", "read", { path: "b.txt" })];
    const ids = (batches: { call: ToolCall }[][]): string[][] =>
      batches.map((b) => b.map((m) => m.call.id as string));
    const snap = captureSchedulerSnapshot();
    expect(ids(planBatches(reads, snap))).toEqual([["r1", "r2"]]);

    const over: ExtensionToolOverrideDefinition = {
      name: "read",
      execute: async (args, ctx) => ctx.passthrough(args),
      executionMode: "sequential",
    };
    const unregister = registerExtensionToolOverride(over, "snapshot-test");
    try {
      // Live planning sees the new sequential hint and serializes...
      expect(ids(planBatches(reads))).toEqual([["r1"], ["r2"]]);
      // ...but the pre-mutation snapshot still plans the old shape.
      expect(ids(planBatches(reads, snap))).toEqual([["r1", "r2"]]);
    } finally {
      unregister();
    }
    // Removal restores live batching (no residue from the override).
    expect(ids(planBatches(reads))).toEqual([["r1", "r2"]]);
  });
});
