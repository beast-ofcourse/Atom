// Ticket 04 pins: per-block commit + collapse.
// Contract: finished thinking/text/tool blocks split via commitStepBlocks
// (one transcript turn per block, list order = paint order); done tool blocks
// leave the live list via consumeDoneToolBlocks after their turn lands;
// collapseToggleIndex targets thinking/assistant/tool (default expanded when
// the set is empty); clearGen / empty set never collapses new lists.
import { describe, expect, test } from "vitest";
import {
  commitStepBlocks,
  completeToolBlock,
  consumeDoneToolBlocks,
  startToolBlock,
  type StepBlock,
} from "../src/ui/step-blocks.js";
import {
  THINKING_COLLAPSE_KEY_LABEL,
  admitStaticBatch,
  collapseToggleIndex,
  type Turn,
} from "../src/ui/transcript.js";

function block(partial: Partial<StepBlock> & Pick<StepBlock, "id" | "kind" | "text">): StepBlock {
  return {
    stepId: "step-0",
    order: 0,
    done: false,
    ...partial,
  };
}

describe("commitStepBlocks", () => {
  test("splits matching kind with done flipped; rest keeps identity", () => {
    const a = block({ id: "t0", kind: "thinking", text: "reason" });
    const b = block({ id: "x0", kind: "text", text: "answer", order: 1 });
    const c = block({ id: "u0", kind: "thinking", text: "more", stepId: "step-1", order: 2 });
    const { finished, rest } = commitStepBlocks([a, b, c], "thinking");
    expect(finished.map((x) => x.id)).toEqual(["t0", "u0"]);
    expect(finished.every((x) => x.done)).toBe(true);
    expect(finished[0]!.text).toBe("reason");
    expect(rest.map((x) => x.id)).toEqual(["x0"]);
    expect(rest[0]!.done).toBe(false);
    // Pure: inputs untouched.
    expect(a.done).toBe(false);
    expect(c.done).toBe(false);
  });

  test("stepId narrows the split (text pins take one step only)", () => {
    const s0 = block({ id: "x0", kind: "text", text: "hello" });
    const s1 = block({ id: "x1", kind: "text", text: "world", stepId: "step-1", order: 1 });
    const { finished, rest } = commitStepBlocks([s0, s1], "text", "step-0");
    expect(finished.map((x) => x.id)).toEqual(["x0"]);
    expect(rest.map((x) => x.id)).toEqual(["x1"]);
  });

  test("no match: finished empty, rest is the same array reference", () => {
    const only = [block({ id: "t0", kind: "thinking", text: "r" })];
    const { finished, rest } = commitStepBlocks(only, "tool");
    expect(finished).toEqual([]);
    expect(rest).toBe(only);
  });

  test("order preserved: one turn per block in list order", () => {
    const blocks = [
      block({ id: "t0", kind: "thinking", text: "a", order: 0 }),
      block({ id: "t1", kind: "thinking", text: "b", order: 2 }),
      block({ id: "x0", kind: "text", text: "mid", order: 1 }),
    ];
    const { finished } = commitStepBlocks(blocks, "thinking");
    expect(finished.map((x) => x.text)).toEqual(["a", "b"]);
  });
});

describe("consumeDoneToolBlocks", () => {
  test("drops done tools, keeps running and non-tool blocks", () => {
    let blocks: StepBlock[] = startToolBlock([], { step: 0, hint: "read a.ts" });
    blocks = startToolBlock(blocks, { step: 0, hint: "bash ls" });
    blocks = completeToolBlock(blocks, {
      label: "⚙ read a.ts",
      durationMs: 10,
      summary: "1 line",
      errorLine: null,
    });
    const thinking = block({ id: "t0", kind: "thinking", text: "r" });
    const next = consumeDoneToolBlocks([thinking, ...blocks]);
    expect(next.map((b) => b.id)).toEqual(["t0", "step-0-tool-1"]);
    expect(next[1]!.done).toBe(false);
  });

  test("identity no-op when nothing is done", () => {
    const running = startToolBlock([], { step: 0, hint: "read a.ts" });
    expect(consumeDoneToolBlocks(running)).toBe(running);
    expect(consumeDoneToolBlocks([])).toEqual([]);
  });

  test("all done tools leave: transcript owns them", () => {
    let blocks: StepBlock[] = startToolBlock([], { step: 0, hint: "read a.ts" });
    blocks = completeToolBlock(blocks, {
      label: "⚙ read a.ts",
      durationMs: 5,
      summary: null,
      errorLine: null,
    });
    expect(consumeDoneToolBlocks(blocks)).toEqual([]);
  });
});

describe("per-block collapse (default expanded, beside global toggle)", () => {
  const thinking = (content: string): Turn => ({
    role: "assistant",
    content,
    thinking: true,
  });

  test("empty set admits full blocks (default expanded, byte-identical)", () => {
    const turns: Turn[] = [
      thinking("r"),
      { role: "assistant", content: "a\nb" },
      { role: "tool", content: "⚙ read x" },
    ];
    const none = admitStaticBatch(turns, 0, 3, true);
    const empty = admitStaticBatch(turns, 0, 3, true, new Set());
    expect(empty).toEqual(none);
    expect(none.items.every((i) => i.collapsedBlock === undefined)).toBe(true);
    expect(none.items.every((i) => i.collapsedThinkingLines === undefined)).toBe(true);
  });

  test("assistant and tool turns admit collapsedBlock when their id is set", () => {
    const turns: Turn[] = [
      { role: "assistant", content: "line1\nline2" },
      { role: "tool", content: "⚙ read x", ms: 1 },
    ];
    const batch = admitStaticBatch(turns, 0, 2, true, new Set(["turn-0", "turn-1"]));
    expect(batch.items[0]!.collapsedBlock).toBe(true);
    expect(batch.items[1]!.collapsedBlock).toBe(true);
    // Tool label skips the pair merge — lone one-liner.
    expect(batch.items[1]!.label).toBeUndefined();
  });

  test("global showThinking still hides ALL thinking independently of collapse", () => {
    const turns: Turn[] = [thinking("secret"), { role: "assistant", content: "ok" }];
    const hidden = admitStaticBatch(turns, 0, 2, false, new Set(["turn-0", "turn-1"]));
    expect(hidden.items).toHaveLength(1);
    expect(hidden.items[0]!.turn!.content).toBe("ok");
    expect(hidden.items[0]!.collapsedBlock).toBe(true);
  });

  test("collapseToggleIndex walks thinking, assistant, tool — never user", () => {
    const turns: Turn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "a" },
      { role: "tool", content: "⚙ read x" },
      thinking("t"),
    ];
    expect(collapseToggleIndex(turns, null)).toBe(3);
    expect(collapseToggleIndex(turns, 3)).toBe(2);
    expect(collapseToggleIndex(turns, 2)).toBe(1);
    expect(collapseToggleIndex(turns, 1)).toBeNull();
    expect(collapseToggleIndex([{ role: "user", content: "only" }], null)).toBeNull();
  });

  test("collapsed summary names the toggle key for text/tool", () => {
    const turns: Turn[] = [{ role: "assistant", content: "a\nb\nc" }];
    const batch = admitStaticBatch(turns, 0, 1, true, new Set(["turn-0"]));
    expect(batch.items[0]!.collapsedBlock).toBe(true);
    expect(THINKING_COLLAPSE_KEY_LABEL).toBe("Ctrl+T");
  });
});

describe("clear / list-replacement parity", () => {
  test("clearGen bump + empty set leaves a fresh list fully expanded", () => {
    const old: Turn[] = [{ role: "assistant", content: "old body" }];
    const oldBatch = admitStaticBatch(old, 0, 1, true, new Set(["turn-0"]));
    expect(oldBatch.items[0]!.collapsedBlock).toBe(true);
    // List replacement: App clears collapsedIds on clearGen — new list,
    // no ids, every block expanded (stale turn-0 must not hit turn-0 again).
    const fresh: Turn[] = [{ role: "assistant", content: "new body" }];
    const freshBatch = admitStaticBatch(fresh, 0, 1, true, new Set());
    expect(freshBatch.items[0]!.collapsedBlock).toBeUndefined();
  });
});
