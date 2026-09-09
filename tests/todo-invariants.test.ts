// Todo runtime invariants: at most one in_progress, completed stays
// completed across rewrites unless explicitly reset via todo_update.
// Violations come back as model-mistake `invalid call` results (never
// throws, never partial) and leave the list untouched. Module-global state
// is cleared between tests.
import { afterEach, describe, expect, test } from "vitest";
import { clearTodos, getTodos, todoUpdateTool, todowriteTool } from "../src/tools.js";

afterEach(() => {
  clearTodos();
});

describe("at most one in_progress", () => {
  test("todowrite with two in_progress is refused, list untouched", async () => {
    await todowriteTool({
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "pending" },
      ],
    });
    const before = getTodos();
    const out = await todowriteTool({
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(out).toMatch(/^Error: invalid call:.*only one task may be in_progress/);
    expect(getTodos()).toEqual(before);
  });

  test("todo_update starting a second in_progress is refused, list untouched", async () => {
    await todowriteTool({
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "pending" },
      ],
    });
    const out = await todoUpdateTool({ index: 2, status: "in_progress" });
    expect(out).toMatch(/^Error: invalid call:.*only one task may be in_progress/);
    expect(out).toContain("item 1");
    expect(getTodos()[1]).toMatchObject({ content: "b", status: "pending" });
  });

  test("handing off works: complete (or pause) first, then start the next", async () => {
    await todowriteTool({
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "pending" },
      ],
    });
    expect(await todoUpdateTool({ index: 1, status: "completed" })).toContain("Todo 1 updated.");
    expect(await todoUpdateTool({ index: 2, status: "in_progress" })).toContain("Todo 2 updated.");
    expect(getTodos().map((t) => t.status)).toEqual(["completed", "in_progress"]);
  });
});

describe("completed stays completed unless explicitly reset", () => {
  test("todowrite rewrite silently reopening is refused, list untouched", async () => {
    await todowriteTool({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ],
    });
    const before = getTodos();
    const out = await todowriteTool({
      todos: [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(out).toMatch(/^Error: invalid call:.*already completed/);
    expect(out).toContain("todo_update");
    expect(getTodos()).toEqual(before);
  });

  test("explicit todo_update reset reopens, then the flow continues", async () => {
    await todowriteTool({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ],
    });
    expect(await todoUpdateTool({ index: 1, status: "in_progress" })).toContain("Todo 1 updated.");
    expect(getTodos()[0]).toMatchObject({ content: "a", status: "in_progress" });
  });

  test("keeping a completed item completed across rewrites is fine", async () => {
    await todowriteTool({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ],
    });
    const out = await todowriteTool({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(out).toContain("Todos have been modified successfully.");
    expect(getTodos().map((t) => t.status)).toEqual(["completed", "in_progress"]);
  });
});
