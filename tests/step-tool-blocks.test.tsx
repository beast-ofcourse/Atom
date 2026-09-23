// Ticket 03 pins: live tool blocks (running → done, same block id).
// Contract: tool calls join the ordered live list at START (arrival order,
// one block per call) and flip to done on RESULT COMMIT (FIFO — parallel
// batches keep start/commit order); the legacy tool-hint lane stays dark
// while the blocks own the row (one tool row, never two); done blocks render
// the committed ToolCall presenter from the block payload. Model functions
// are pure: start appends, complete flips in place (same id/order) and is an
// identity no-op when nothing is running.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  completeToolBlock,
  startToolBlock,
  type StepBlock,
} from "../src/ui/step-blocks.js";
import { StepBlockList } from "../src/ui/components/StepBlockList.js";
import { LiveTail } from "../src/ui/live-tail.js";
import { activityText } from "../src/ui/activity.js";
import { theme } from "../src/ui/theme.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("startToolBlock", () => {
  test("appends a running block at arrival order with a null payload", () => {
    const blocks = startToolBlock([], { step: 0, hint: "read package.json" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: "step-0-tool-0",
      stepId: "step-0",
      kind: "tool",
      text: "read package.json",
      done: false,
      tool: { label: "read package.json", durationMs: null, summary: null, errorLine: null },
    });
    expect(blocks[0]!.order).toBe(0);
  });

  test("keeps per-step tool indexes unique and appends behind existing blocks", () => {
    let blocks = startToolBlock([], { step: 1, hint: "bash ls" });
    blocks = startToolBlock(blocks, { step: 1, hint: "read a.ts" });
    expect(blocks.map((b) => b.id)).toEqual(["step-1-tool-0", "step-1-tool-1"]);
    expect(blocks.map((b) => b.order)).toEqual([0, 1]);
    for (const b of blocks) expect(b.done).toBe(false);
  });
});

describe("completeToolBlock", () => {
  const first = { label: "⚙ read a.ts", durationMs: 2500, summary: "12 lines", errorLine: null };
  const second = { label: "⚙ bash ls", durationMs: 40, summary: "3 results", errorLine: null };

  test("flips the FIRST running block in place (same id/order) and fills the payload", () => {
    const running = startToolBlock([], { step: 0, hint: "read a.ts" });
    const id = running[0]!.id;
    const done = completeToolBlock(running, first);
    expect(done).toHaveLength(1);
    expect(done[0]!.id).toBe(id);
    expect(done[0]!.order).toBe(0);
    expect(done[0]!.done).toBe(true);
    expect(done[0]!.tool).toEqual(first);
    expect(done[0]!.text).toBe("⚙ read a.ts");
    // Input array untouched (pure).
    expect(running[0]!.done).toBe(false);
  });

  test("FIFO: parallel batch completes in start order, second block stays running", () => {
    let blocks: StepBlock[] = startToolBlock([], { step: 0, hint: "read a.ts" });
    blocks = startToolBlock(blocks, { step: 0, hint: "bash ls" });
    blocks = completeToolBlock(blocks, first);
    expect(blocks[0]!.done).toBe(true);
    expect(blocks[0]!.id).toBe("step-0-tool-0");
    expect(blocks[1]!.done).toBe(false);
    blocks = completeToolBlock(blocks, second);
    expect(blocks[1]!.done).toBe(true);
    expect(blocks[1]!.id).toBe("step-0-tool-1");
    expect(blocks.map((b) => b.done)).toEqual([true, true]);
  });

  test("a later start in the same step gets the next index (done blocks count)", () => {
    let blocks = startToolBlock([], { step: 0, hint: "read a.ts" });
    blocks = completeToolBlock(blocks, first);
    blocks = startToolBlock(blocks, { step: 0, hint: "bash ls" });
    expect(blocks.map((b) => b.id)).toEqual(["step-0-tool-0", "step-0-tool-1"]);
    expect(blocks[1]!.done).toBe(false);
  });

  test("nothing running returns the same reference (idle commits stay silent)", () => {
    const blocks = startToolBlock([], { step: 0, hint: "read a.ts" });
    const done = completeToolBlock(blocks, first);
    const again = completeToolBlock(done, second);
    expect(again).toBe(done);
    const empty = completeToolBlock([], first);
    expect(empty).toEqual([]);
  });
});

describe("StepBlockList tool rendering", () => {
  test("running block renders the live activity row, never the audit line", () => {
    const blocks = startToolBlock([], { step: 0, hint: "read package.json" });
    const frame = frameOf(<StepBlockList blocks={blocks} enabled />);
    expect(frame).toContain(activityText("read package.json"));
    expect(frame).not.toContain(theme.symbol.toolMark);
  });

  test("done success block renders the committed ToolCall once (audit + summary)", () => {
    const running = startToolBlock([], { step: 0, hint: "read a.ts" });
    const blocks = completeToolBlock(running, {
      label: "⚙ read a.ts",
      durationMs: 2500,
      summary: "12 lines",
      errorLine: null,
    });
    const frame = frameOf(<StepBlockList blocks={blocks} enabled />);
    expect(count(frame, "⚙ read a.ts")).toBe(1);
    expect(frame).toContain("12 lines");
    expect(frame).not.toContain(activityText("read a.ts"));
  });

  test("done error block renders the label + error line without crashing", () => {
    const running = startToolBlock([], { step: 0, hint: "bash missing-cmd" });
    const blocks = completeToolBlock(running, {
      label: "⚙ bash missing-cmd",
      durationMs: 12,
      summary: "command not found: missing-cmd",
      errorLine: "command not found: missing-cmd",
    });
    const frame = frameOf(<StepBlockList blocks={blocks} enabled />);
    expect(frame).toContain("⚙ bash missing-cmd");
    expect(frame).toContain("command not found: missing-cmd");
  });
});

describe("LiveTail tool-lane suppression (no double tool paint)", () => {
  const base = {
    isEmpty: false,
    sessionHint: false,
    busy: true,
    held: false,
    toolElapsedSecs: 1,
    elapsedSecs: 1,
    draft: null,
    thinking: null,
    toolHint: "read package.json",
  } as const;
  const verb = activityText("read package.json");

  test("blocks own the tool row: the legacy hint lane stays dark (one row)", () => {
    const blocks = startToolBlock([], { step: 0, hint: "read package.json" });
    const frame = frameOf(
      <LiveTail {...base} stepBlocks={blocks} useStepBlocks />,
    );
    expect(frame).toContain(verb);
    expect(count(frame, verb)).toBe(1);
  });

  test("blocks without tools leave the hint lane to legacy (announce window)", () => {
    const thinkingOnly = [{ id: "s", stepId: "step-0", order: 0, kind: "thinking" as const, text: "mulling", done: false }];
    const frame = frameOf(
      <LiveTail {...base} stepBlocks={thinkingOnly} useStepBlocks />,
    );
    expect(count(frame, verb)).toBe(1);
  });

  test("opt-out (useStepBlocks off): the legacy hint lane still paints", () => {
    const blocks = startToolBlock([], { step: 0, hint: "read package.json" });
    const frame = frameOf(
      <LiveTail {...base} stepBlocks={blocks} useStepBlocks={false} />,
    );
    expect(count(frame, verb)).toBe(1);
  });
});
