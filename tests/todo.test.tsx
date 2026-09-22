// Granular todo tools (Claude TaskGet/TaskUpdate equivalents): todo_get reads
// the session checklist, todo_update patches one item by 1-based index
// (check/uncheck without a whole-list rewrite). Plus the live <TodoPanel>.
// Todo state is module-global per test file (vitest isolates files), so each
// test seeds its own list first. No network, no repo writes.
import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import { TodoPanel } from "../src/ui/todo-panel.js";
import {
  READ_ONLY_TOOLS,
  TOOL_DEFINITIONS,
  TOOL_ONE_LINERS,
  clearTodos,
  describeToolCall,
  executeTool,
  getTodos,
  needsApproval,
  todoGetTool,
  todoUpdateTool,
  todowriteTool,
} from "../src/tools.js";

describe("todo_get", () => {
  test("empty list, echo after writes, and dispatch", async () => {
    await todowriteTool({ todos: [] });
    expect(await todoGetTool()).toBe("Todo list is empty.");
    await todowriteTool({
      todos: [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress", priority: "high", activeForm: "Doing b" },
      ],
    });
    const out = await todoGetTool();
    expect(out).toContain("Todo list (2)");
    expect(out).toContain("[pending] a");
    expect(out).toContain("[in_progress] b (high)");
    expect(await executeTool("todo_get", {})).toContain("Todo list (2)");
  });
});

describe("todo_update", () => {
  test("check/uncheck flow by index with echo", async () => {
    await todowriteTool({
      todos: [
        { content: "first", status: "pending" },
        { content: "second", status: "pending" },
      ],
    });
    expect(await todoUpdateTool({ index: 1, status: "in_progress" })).toContain("Todo 1 updated.");
    expect(getTodos()[0]).toMatchObject({ content: "first", status: "in_progress" });
    expect(await executeTool("todo_update", { index: 2, status: "completed" })).toContain(
      "[completed] second"
    );
    expect(
      await todoUpdateTool({ index: 1, status: "completed", priority: "high", content: "first!" })
    ).toContain("cleared");
    expect(getTodos()).toEqual([]);
  });

  test("patch content/priority/activeForm; empty activeForm clears it", async () => {
    await todowriteTool({
      todos: [{ content: "x", status: "pending", activeForm: "Doing x" }],
    });
    const out = await todoUpdateTool({ index: 1, content: "y", priority: "low", activeForm: "" });
    expect(out).toContain("[pending] y (low)");
    expect(getTodos()).toEqual([{ content: "y", status: "pending", priority: "low" }]);
  });

  test("validation: index, patch fields, enums, range", async () => {
    await todowriteTool({ todos: [{ content: "seed", status: "pending" }] });
    expect(await executeTool("todo_update", {})).toMatch(/^Error: invalid call:.*index/);
    expect(await executeTool("todo_update", { index: "1" })).toMatch(/^Error: invalid call:.*index/);
    expect(await executeTool("todo_update", { index: 1.5 })).toMatch(/^Error: invalid call:.*integer/);
    expect(await executeTool("todo_update", { index: 1 })).toMatch(/^Error: invalid call:.*at least one/);
    expect(await executeTool("todo_update", { index: 0, status: "completed" })).toMatch(
      /^Error: invalid call:.*out of range/
    );
    expect(await executeTool("todo_update", { index: 9, status: "completed" })).toMatch(
      /^Error: invalid call:.*out of range/
    );
    expect(await executeTool("todo_update", { index: 1, status: "done" })).toMatch(
      /^Error: invalid call:.*status/
    );
    expect(await executeTool("todo_update", { index: 1, content: "" })).toMatch(
      /^Error: invalid call:.*content/
    );
    expect(await executeTool("todo_update", { index: 1, priority: "urgent" })).toMatch(
      /^Error: invalid call:.*priority/
    );
    expect(await executeTool("todo_update", { index: 1, activeForm: 5 })).toMatch(
      /^Error: invalid call:.*activeForm/
    );
    expect(getTodos()).toEqual([{ content: "seed", status: "pending" }]);
    clearTodos();
    expect(getTodos()).toEqual([]);
  });
});

describe("todo_get/todo_update wiring", () => {
  test("read-only classification, one-liners, describe, and schemas", () => {
    for (const n of ["todo_get", "todo_update"]) {
      expect(READ_ONLY_TOOLS.has(n)).toBe(true);
      expect(needsApproval(n)).toBe(false);
    }
    expect(TOOL_ONE_LINERS["todo_get"]).toBe("Read the session task checklist.");
    expect(TOOL_ONE_LINERS["todo_update"]).toBe("Check off or edit one session task.");
    expect(describeToolCall("todo_get", {})).toBe("⚙ todo_get");
    expect(describeToolCall("todo_update", { index: 2, status: "completed" })).toBe(
      "⚙ todo_update #2 → completed"
    );
    expect(describeToolCall("todo_update", {})).toBe("⚙ todo_update");
    for (const n of ["todo_get", "todo_update"]) {
      const def = TOOL_DEFINITIONS.find((t) => t.function.name === n)!;
      expect(def.type).toBe("function");
      expect(def.function.parameters).toMatchObject({ type: "object" });
    }
  });

  test("descriptions steer like Claude/opencode and stay truthful", () => {
    const desc = (n: string): string =>
      TOOL_DEFINITIONS.find((t) => t.function.name === n)!.function.description;
    expect(desc("todo_get")).toContain("todo_update");
    expect(desc("todo_get")).toContain("WHEN NOT to use");
    expect(desc("todo_update")).toContain("1-based index");
    expect(desc("todo_update")).toContain("Patch ONE");
    expect(desc("todo_update")).toContain("todo_get first");
    expect(desc("todowrite")).toContain("todo_get");
  });
});

describe("TodoPanel", () => {
  test("renders theme glyphs, activeForm on the in-progress row, counts header; null when empty", () => {
    const full = render(
      <TodoPanel
        items={[
          { content: "Done thing", status: "completed" },
          { content: "Current thing", status: "in_progress", priority: "high", activeForm: "Doing current" },
          { content: "Later thing", status: "pending" },
        ]}
      />
    );
    try {
      const frame = full.lastFrame() ?? "";
      expect(frame).toContain("Todo");
      expect(frame).toContain("1/3");
      expect(frame).toContain("1 in-progress");
      expect(frame).toContain("✅ Done thing");
      expect(frame).toContain("🔧 Doing current");
      expect(frame).toContain("○");
      expect(frame).toContain("Later thing");
      // no legacy bracket marks, no collapse chevron, no priority metadata
      expect(frame).not.toContain("[✓]");
      expect(frame).not.toContain("[•]");
      expect(frame).not.toContain("▼");
      expect(frame).not.toContain("(high)");
    } finally {
      full.unmount();
    }
    const empty = render(<TodoPanel items={[]} />);
    try {
      expect(empty.lastFrame() ?? "").not.toContain("Todo");
      expect(empty.lastFrame() ?? "").not.toContain("✅");
    } finally {
      empty.unmount();
    }
  });

  test("hidden when all completed; overflow caps with … N more", () => {
    const done = render(
      <TodoPanel
        items={[
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
        ]}
      />
    );
    try {
      expect(done.lastFrame() ?? "").not.toContain("Todo");
    } finally {
      done.unmount();
    }
    const many = Array.from({ length: 14 }, (_, i) => ({
      content: `task ${i}`,
      status: (i === 0 ? "in_progress" : "pending") as "in_progress" | "pending",
    }));
    const big = render(<TodoPanel items={many} />);
    try {
      const frame = big.lastFrame() ?? "";
      expect(frame).toContain("0/14");
      expect(frame).toContain("6 more");
      expect(frame).not.toContain("task 13");
    } finally {
      big.unmount();
    }
  });

  test("reordered list keeps every row (content-identity keys, no index remount loss)", () => {
    const items = [
      { content: "alpha", status: "pending" as const },
      { content: "beta", status: "in_progress" as const },
      { content: "gamma", status: "pending" as const },
    ];
    const fwd = render(<TodoPanel items={items} />);
    const rev = render(<TodoPanel items={[...items].reverse()} />);
    try {
      for (const frame of [fwd.lastFrame() ?? "", rev.lastFrame() ?? ""]) {
        expect(frame).toContain("alpha");
        expect(frame).toContain("beta");
        expect(frame).toContain("gamma");
        expect(frame).toContain("0/3");
      }
    } finally {
      fwd.unmount();
      rev.unmount();
    }
  });
});

describe("todo-refactor wiring", () => {
  test("registry labels delegate to the shared helper (byte-identical)", async () => {
    const { describeTodoCall } = await import("../src/todo-shared.js");
    expect(describeToolCall("todowrite", { todos: [{}, {}] })).toBe(
      describeTodoCall("todowrite", { todos: [{}, {}] }),
    );
    expect(describeToolCall("todo_get", {})).toBe("⚙ todo_get");
    expect(describeToolCall("todo_update", { index: 2, status: "completed" })).toBe(
      "⚙ todo_update #2 → completed",
    );
  });

  test("store subscription fires on mutation and session switch", async () => {
    const { subscribeTodos, setActiveTodoSession } = await import("../src/todo-store.js");
    let fires = 0;
    const off = subscribeTodos(() => {
      fires += 1;
    });
    try {
      clearTodos();
      const base = fires;
      await todowriteTool({ todos: [{ content: "sub", status: "pending" }] });
      expect(fires).toBeGreaterThan(base);
      const base2 = fires;
      setActiveTodoSession("sub-session");
      expect(fires).toBeGreaterThan(base2);
    } finally {
      off();
      clearTodos();
    }
  });
});
