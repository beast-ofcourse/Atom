// Ticket 01 pins: ordered step-block model + inert sidecar renderer.
// Contract: derivation is pure/ordered/lane-aware; the sidecar mounts
// beside the lanes but paints nothing until a later ticket opts in, so
// LiveTail frames stay byte-identical.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { applyStepDelta, stepIdFor, toStepBlocks } from "../src/ui/step-blocks.js";
import { StepBlockList } from "../src/ui/components/StepBlockList.js";
import { LiveTail } from "../src/ui/live-tail.js";
import { reduceAgentEvent, type AdapterState } from "../src/ui/agent-adapter.js";
import { createStreamStore } from "../src/ui/stream-store.js";
import { runLoopWithChat, type ChatMessage } from "../src/zen.js";
import { theme } from "../src/ui/theme.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("toStepBlocks", () => {
  test("empty inputs yield no blocks", () => {
    expect(toStepBlocks({ draft: null, thinking: null, toolHint: null })).toEqual([]);
  });

  test("orders thinking, text, tool with per-step identity and done=false", () => {
    const blocks = toStepBlocks({ draft: "answer", thinking: "reason", toolHint: "read src/x.ts" });
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool"]);
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2]);
    for (const b of blocks) {
      expect(b.stepId).toBe("step-0");
      expect(b.done).toBe(false);
    }
    expect(blocks.map((b) => b.id)).toEqual(["step-thinking", "step-text", "step-tool"]);
  });

  test("lane-aware like LiveTail: inactive lane contributes nothing", () => {
    const draftOnly = toStepBlocks({ draft: "d", thinking: "t", toolHint: null, activeLane: "draft" });
    expect(draftOnly.map((b) => b.kind)).toEqual(["text"]);
    const thinkingOnly = toStepBlocks({ draft: "d", thinking: "t", toolHint: null, activeLane: "thinking" });
    expect(thinkingOnly.map((b) => b.kind)).toEqual(["thinking"]);
  });

  test("showThinking=false hides the thinking block", () => {
    const blocks = toStepBlocks({ draft: null, thinking: "t", toolHint: null, showThinking: false });
    expect(blocks).toEqual([]);
  });
});

describe("StepBlockList sidecar", () => {
  const blocks = toStepBlocks({ draft: "hello", thinking: null, toolHint: null });

  test("inert by default: blocks present, nothing painted", () => {
    expect(frameOf(<StepBlockList blocks={blocks} />)).toBe("");
  });

  test("empty list paints nothing even when enabled", () => {
    expect(frameOf(<StepBlockList blocks={[]} enabled />)).toBe("");
  });

  test("enabled with blocks renders the text block", () => {
    expect(frameOf(<StepBlockList blocks={blocks} enabled />)).toContain("hello");
  });
});

describe("LiveTail with sidecar mounted", () => {
  test("draft paints exactly once (sidecar adds no duplicate)", () => {
    const frame = frameOf(
      <LiveTail
        isEmpty={false}
        sessionHint={false}
        draft="hello"
        thinking={null}
        busy={false}
        held={false}
        toolHint={null}
        toolElapsedSecs={null}
        elapsedSecs={0}
      />,
    );
    expect(frame).toContain("hello");
    expect(frame.split("hello")).toHaveLength(2);
  });
});

// Ticket 02 pins: step-tagged live thinking/text.
// Contract: the loop tags each delta with its step; the live list files it
// into that step's block (thinking, text, thinking in arrival order); paint
// batching holds (one store update per flush); legacy frames stay identical
// until the opt-in flips.
describe("applyStepDelta", () => {
  test("thinking, text, thinking in one step yields three ordered blocks", () => {
    let blocks = applyStepDelta([], { lane: "thinking", text: "mulling it " });
    blocks = applyStepDelta(blocks, { lane: "text", text: "First bit " });
    blocks = applyStepDelta(blocks, { lane: "thinking", text: "mulling it over " });
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "text", "thinking"]);
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2]);
    expect(blocks.map((b) => b.stepId)).toEqual(["step-0", "step-0", "step-0"]);
    // The returning lane carries only its new segment (no duplication with
    // the frozen block above it).
    expect(blocks.map((b) => b.text)).toEqual(["mulling it ", "First bit ", "over "]);
    expect(blocks.map((b) => b.id)).toEqual(["step-0-thinking-0", "step-0-text-0", "step-0-thinking-1"]);
    for (const b of blocks) expect(b.done).toBe(false);
  });

  test("same segment continues in place (stable id, latest-wins, no new block)", () => {
    let blocks = applyStepDelta([], { lane: "text", text: "hel" });
    const id = blocks[0]!.id;
    blocks = applyStepDelta(blocks, { lane: "text", text: "hello" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.id).toBe(id);
    expect(blocks[0]!.text).toBe("hello");
  });

  test("step-N deltas never land in step-M blocks", () => {
    let blocks = applyStepDelta([], { step: 0, lane: "text", text: "step zero text" });
    blocks = applyStepDelta(blocks, { step: 1, lane: "text", text: "step one text" });
    blocks = applyStepDelta(blocks, { step: 1, lane: "thinking", text: "step one musings" });
    blocks = applyStepDelta(blocks, { step: 0, lane: "text", text: "step zero text" });
    expect(blocks.map((b) => `${b.stepId}:${b.kind}`)).toEqual([
      "step-0:text",
      "step-1:text",
      "step-1:thinking",
    ]);
    // A late step-0 repeat matches no tail block, so it must not rewrite
    // step-1's text: the step-0 block keeps its exact text.
    expect(blocks[0]!.text).toBe("step zero text");
    expect(blocks[1]!.text).toBe("step one text");
    expect(blocks[2]!.text).toBe("step one musings");
  });

  test("untagged deltas read as step 0; empty segments push nothing", () => {
    const untagged = applyStepDelta([], { lane: "thinking", text: "hmm" });
    expect(untagged[0]!.stepId).toBe("step-0");
    expect(stepIdFor(Number.NaN)).toBe("step-0");
    expect(applyStepDelta(untagged, { lane: "text", text: "" })).toHaveLength(1);
  });
});

describe("loop step tags", () => {
  test("onToken/onThinking and the sink carry the producing step (0 then 1)", async () => {
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "go" },
    ];
    const tokenSteps: Array<number | undefined> = [];
    const thinkingSteps: Array<number | undefined> = [];
    const sinkTokenSteps: Array<number | undefined> = [];
    const sinkThinkingSteps: Array<number | undefined> = [];
    let calls = 0;
    const result = await runLoopWithChat(
      async (_h, o) => {
        calls += 1;
        if (calls === 1) {
          o?.onThinking?.("mulling");
          o?.onToken?.("checking");
          return {
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }],
          };
        }
        o?.onThinking?.("reviewing");
        o?.onToken?.("done");
        return { content: "done" };
      },
      history,
      {
        execute: async () => "ok",
        onToken: (t, step) => void tokenSteps.push(step),
        onThinking: (t, step) => void thinkingSteps.push(step),
        turnEvents: {
          onToken: (_t, step) => void sinkTokenSteps.push(step),
          onThinking: (_t, step) => void sinkThinkingSteps.push(step),
        },
      },
    );
    expect(result).toBe("done");
    expect(tokenSteps).toEqual([0, 1]);
    expect(thinkingSteps).toEqual([0, 1]);
    expect(sinkTokenSteps).toEqual([0, 1]);
    expect(sinkThinkingSteps).toEqual([0, 1]);
  });
});

describe("adapter step blocks (core path)", () => {
  const base: AdapterState = {
    turns: [],
    thinking: null,
    draft: null,
    stepBlocks: [],
    toolHint: null,
    toolElapsedSecs: null,
    busy: true,
    error: null,
    records: [],
  };
  test("tagged deltas file into per-step blocks; lanes untouched", () => {
    let s = reduceAgentEvent(base, { type: "agent.thinking.delta", delta: "a", accumulated: "a", step: 0, at: "" });
    s = reduceAgentEvent(s, { type: "message.delta", delta: "b", accumulated: "b", step: 0, at: "" });
    s = reduceAgentEvent(s, { type: "message.delta", delta: "c", accumulated: "bc", step: 1, at: "" });
    expect(s.stepBlocks.map((b) => `${b.stepId}:${b.kind}`)).toEqual([
      "step-0:thinking",
      "step-0:text",
      "step-1:text",
    ]);
    // The legacy single lanes still carry the latest text each.
    expect(s.thinking).toBe("a");
    expect(s.draft).toBe("bc");
  });

  test("agent.completed clears the live blocks (transcript owns them now)", () => {
    let s = reduceAgentEvent(base, { type: "message.delta", delta: "b", accumulated: "b", step: 0, at: "" });
    expect(s.stepBlocks).toHaveLength(1);
    s = reduceAgentEvent(s, { type: "agent.completed", result: "b", at: "" });
    expect(s.stepBlocks).toEqual([]);
  });
});

describe("StepBlockList ordered live (ticket 02 opt-in)", () => {
  const multi = applyStepDelta(
    applyStepDelta(applyStepDelta([], { lane: "thinking", text: "mulling it " }), {
      lane: "text",
      text: "First bit ",
    }),
    { lane: "thinking", text: "mulling it over " },
  );

  test("enabled renders every segment once, streaming cursor only on the latest", () => {
    const frame = frameOf(<StepBlockList blocks={multi} enabled />);
    // Ink trims trailing spaces, so pins use trimmed segments.
    expect(frame).toContain("mulling it");
    expect(frame).toContain("First bit");
    expect(frame).toContain("over");
    expect(frame).not.toContain("mulling it over");
    // One streaming cursor per list: settled blocks render committed leaves.
    expect(frame.split(theme.symbol.cursorBar)).toHaveLength(2);
  });
});

describe("LiveTail step-blocks opt-in", () => {
  const base = {
    isEmpty: false,
    sessionHint: false,
    busy: true,
    held: false,
    toolHint: null,
    toolElapsedSecs: null,
    elapsedSecs: 1,
  } as const;
  const multi = applyStepDelta(
    applyStepDelta(applyStepDelta([], { lane: "thinking", text: "mulling it " }), {
      lane: "text",
      text: "First bit ",
    }),
    { lane: "thinking", text: "mulling it over " },
  );

  test("opt-out (default): legacy lanes paint whole cumulative text, sidecar silent", () => {
    const frame = frameOf(
      <LiveTail {...base} draft="First bit " thinking="mulling it over " activeLane="thinking" stepBlocks={multi} />,
    );
    expect(frame).toContain("mulling it over ");
    expect(frame).not.toContain("First bit ");
  });

  test("opt-in: ordered blocks replace the lanes (no duplicate paint)", () => {
    const frame = frameOf(
      <LiveTail
        {...base}
        draft="First bit "
        thinking="mulling it over "
        activeLane="thinking"
        stepBlocks={multi}
        useStepBlocks
      />,
    );
    expect(frame).toContain("mulling it");
    expect(frame).toContain("First bit");
    expect(frame).toContain("over");
    // Segmented blocks, not the whole cumulative string beside them.
    expect(frame).not.toContain("mulling it over");
    expect(frame.split("First bit")).toHaveLength(2);
  });

  test("opt-in respects the /thinking toggle (rendering-only)", () => {
    const frame = frameOf(
      <LiveTail {...base} draft={null} thinking="live musings" stepBlocks={multi} useStepBlocks showThinking={false} />,
    );
    expect(frame).not.toContain("live musings");
  });
});

describe("stream store step-blocks batching", () => {
  test("lanes plus blocks land in one store update (one paint)", () => {
    const store = createStreamStore();
    let paints = 0;
    const unsub = store.subscribe(() => void (paints += 1));
    try {
      const blocks = applyStepDelta([], { lane: "text", text: "hello" });
      store.set({ draft: "hello", thinking: null, activeLane: "draft", stepBlocks: blocks });
      expect(paints).toBe(1);
      expect(store.getStepBlocks()).toHaveLength(1);
      store.clear();
      expect(store.getStepBlocks()).toBe(null);
    } finally {
      unsub();
    }
  });
});
