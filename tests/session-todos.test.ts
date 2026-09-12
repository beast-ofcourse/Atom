// Ticket 05: per-session todos that survive compaction.
// Hermetic proofs only (no TUI): pure todos.ts round-trips plus
// updateSession/getSession round-trips with no in-memory carryover, a
// compacted-history pass through the real compact.ts path, and a fresh-read
// restore (restart) proof. The App switch-restore replay (clearTodos +
// todowriteTool) is exercised exactly as App.tsx wires it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildCompactedHistory,
  splitHistoryForCompaction,
} from "../src/compact.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSession,
} from "../src/sessions.js";
import {
  clearTodos,
  getTodos,
  todowriteTool,
} from "../src/tools/todo.js";
import {
  completeTodo,
  createTodo,
  readSessionTodos,
  reorderTodo,
  restoreTodosFromPersist,
  serializeTodosForPersist,
  updateTodo,
  validateTodoRecord,
  withSessionTodos,
  type TodoItem,
} from "../src/todos.js";
import type { ChatMessage } from "../src/zen.js";

let homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "atom-session-todos-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  clearTodos();
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

function sampleList(): TodoItem[] {
  return [
    { content: "write the parser", status: "in_progress", priority: "high" },
    { content: "add tests", status: "pending", activeForm: "adding tests" },
    { content: "done earlier", status: "completed" },
  ];
}

// Stamp a list into a session the way App.persistStoreSession does: spread
// the on-disk metadata (other keys untouched), set metadata.todos, single
// updateSession so updatedAt bumps.
function persistTodos(
  id: string,
  list: TodoItem[],
  home: string
): void {
  const disk = getSession(id, home);
  expect(disk).not.toBeNull();
  const next = updateSession(
    id,
    { metadata: withSessionTodos(disk!.metadata, list) },
    home
  );
  expect(next).not.toBeNull();
}

// Fresh read with no in-memory carryover (the restart posture).
function freshTodos(id: string, home: string): TodoItem[] {
  const disk = getSession(id, home);
  expect(disk).not.toBeNull();
  return readSessionTodos(disk!.metadata);
}

describe("todos.ts pure ops", () => {
  test("createTodo appends a validated copy; rejects malformed items", () => {
    const list = createTodo([], {
      content: "a",
      status: "pending",
      priority: "low",
      extra: "ignored",
    });
    expect(list).toEqual([{ content: "a", status: "pending", priority: "low" }]);
    expect(() => createTodo(list, { content: "", status: "pending" })).toThrow();
    expect(() =>
      createTodo(list, { content: "b", status: "done" })
    ).toThrow();
    expect(() => createTodo(list, null)).toThrow();
  });

  test("updateTodo patches one item by 1-based index (status transitions)", () => {
    const list = sampleList();
    const next = updateTodo(list, 2, {
      status: "in_progress",
      content: "add more tests",
    });
    expect(next[1]).toEqual({
      content: "add more tests",
      status: "in_progress",
      activeForm: "adding tests",
    });
    // Input untouched (pure).
    expect(list[1]!.status).toBe("pending");
    expect(() => updateTodo(list, 0, { status: "completed" })).toThrow();
    expect(() => updateTodo(list, 9, { status: "completed" })).toThrow();
    expect(() => updateTodo(list, 1, { status: "bogus" })).toThrow();
    expect(() => updateTodo(list, 1, { content: "" })).toThrow();
    expect(() => updateTodo(list, 1, { priority: "urgent" })).toThrow();
  });

  test("completeTodo marks one item completed", () => {
    const next = completeTodo(sampleList(), 1);
    expect(next[0]!.status).toBe("completed");
    expect(next[1]!.status).toBe("pending");
    expect(() => completeTodo([], 1)).toThrow();
  });

  test("reorderTodo moves order; same-index is a copy", () => {
    const list = sampleList();
    const next = reorderTodo(list, 1, 3);
    expect(next.map((t) => t.content)).toEqual([
      "add tests",
      "done earlier",
      "write the parser",
    ]);
    expect(list[0]!.content).toBe("write the parser");
    expect(reorderTodo(list, 2, 2)).toEqual(list);
    expect(() => reorderTodo(list, 0, 1)).toThrow();
    expect(() => reorderTodo(list, 1, 4)).toThrow();
  });

  test("serialize deep-copies; restore replays verbatim", () => {
    const list = sampleList();
    const saved = serializeTodosForPersist(list);
    expect(saved).toEqual(list);
    saved[0]!.content = "mutated";
    expect(list[0]!.content).toBe("write the parser");
    expect(restoreTodosFromPersist(saved)).toEqual(saved);
    expect(validateTodoRecord({ content: "x", status: "pending" })).toEqual({
      content: "x",
      status: "pending",
    });
    expect(validateTodoRecord({ content: "x", status: "nope" })).toBeNull();
  });
});

describe("session-record serialization", () => {
  test("withSessionTodos sets only the todos key; other keys pass through", () => {
    const base = { extState: { v: 1 }, filediffs: { opaque: [1, 2] } };
    const stamped = withSessionTodos(base, sampleList());
    expect(stamped["todos"]).toEqual(sampleList());
    expect(stamped["extState"]).toEqual({ v: 1 });
    expect(stamped["filediffs"]).toEqual({ opaque: [1, 2] });
    // Base untouched.
    expect(base).toEqual({ extState: { v: 1 }, filediffs: { opaque: [1, 2] } });
  });

  test("readSessionTodos: missing key reads as empty", () => {
    expect(readSessionTodos({})).toEqual([]);
    expect(readSessionTodos(undefined)).toEqual([]);
    expect(readSessionTodos(null)).toEqual([]);
  });
});

describe("criterion 1: todos are visible only in their own session", () => {
  test("two-session isolation via record round-trips", async () => {
    const home = await tempHome();
    const a = createSession({ title: "a" }, home);
    const b = createSession({ title: "b" }, home);
    persistTodos(a.id, sampleList(), home);
    // A carries the list; B reads empty — no leakage, no in-memory state.
    expect(freshTodos(a.id, home)).toEqual(sampleList());
    expect(freshTodos(b.id, home)).toEqual([]);
    // The App switch-replay for B lands on an empty live list…
    clearTodos();
    const restoredB = freshTodos(b.id, home);
    if (restoredB.length > 0) await todowriteTool({ todos: restoredB });
    expect(getTodos()).toEqual([]);
    // …while A replays its full checklist.
    clearTodos();
    await todowriteTool({ todos: freshTodos(a.id, home) });
    expect(getTodos()).toEqual(sampleList());
  });
});

describe("criterion 2: create/update/complete/reorder persist immediately", () => {
  test("every op round-trips through updateSession/getSession", async () => {
    const home = await tempHome();
    const s = createSession({ title: "work" }, home);
    let live: TodoItem[] = [];
    // Create.
    live = createTodo(live, { content: "first", status: "pending" });
    live = createTodo(live, {
      content: "second",
      status: "pending",
      priority: "medium",
    });
    persistTodos(s.id, live, home);
    expect(freshTodos(s.id, home)).toEqual(live);
    // Update (status transition + content).
    live = updateTodo(live, 1, {
      status: "in_progress",
      content: "first (refined)",
    });
    persistTodos(s.id, live, home);
    expect(freshTodos(s.id, home)).toEqual(live);
    // Complete.
    live = completeTodo(live, 1);
    persistTodos(s.id, live, home);
    expect(freshTodos(s.id, home)).toEqual(live);
    // Reorder.
    live = reorderTodo(live, 2, 1);
    persistTodos(s.id, live, home);
    expect(freshTodos(s.id, home)).toEqual(live);
    expect(freshTodos(s.id, home).map((t) => t.content)).toEqual([
      "second",
      "first (refined)",
    ]);
  });
});

describe("criterion 3: compaction + restart preserve the checklist", () => {
  test("compacted-history path keeps full states", async () => {
    const home = await tempHome();
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old work" },
      { role: "assistant", content: "did old work" },
      { role: "user", content: "new work" },
      { role: "assistant", content: "doing new work" },
    ];
    const s = createSession({ title: "compact me", history }, home);
    persistTodos(s.id, sampleList(), home);
    // Real compact.ts path: split head/tail, swap in the summary history.
    const disk = getSession(s.id, home)!;
    const split = splitHistoryForCompaction(disk.history);
    expect(split.olderTurnCount).toBeGreaterThan(0);
    const compacted = buildCompactedHistory(
      disk.history[0]!,
      "## Objective\nKeep shipping.",
      split.tail,
      split.olderTurnCount
    );
    const next = updateSession(
      s.id,
      {
        history: compacted,
        metadata: withSessionTodos(disk.metadata, sampleList()),
      },
      home
    );
    expect(next).not.toBeNull();
    // Fresh read: history is the compacted summary AND todos are intact.
    const reread = getSession(s.id, home)!;
    expect(reread.history[1]!.content).toContain("Keep shipping.");
    expect(reread.history.length).toBeLessThan(history.length);
    expect(readSessionTodos(reread.metadata)).toEqual(sampleList());
  });

  test("restart (fresh reads only) restores the checklist with states", async () => {
    const home = await tempHome();
    const s = createSession({ title: "restart me" }, home);
    persistTodos(s.id, sampleList(), home);
    // "Reopen": fresh reads only, no in-memory state carried over.
    expect(listSessions(home).map((x) => x.id)).toContain(s.id);
    const restored = readSessionTodos(getSession(s.id, home)!.metadata);
    expect(restored).toEqual(sampleList());
    // Replays through the live tool layer exactly as the switch path does.
    clearTodos();
    await todowriteTool({ todos: restored });
    expect(getTodos()).toEqual(sampleList());
  });
});

describe("criterion 4: empty and corrupt degrade gracefully", () => {
  test("empty list round-trips as empty; session loads fine", async () => {
    const home = await tempHome();
    const s = createSession({ title: "empty" }, home);
    persistTodos(s.id, [], home);
    const reread = getSession(s.id, home);
    expect(reread).not.toBeNull();
    expect(readSessionTodos(reread!.metadata)).toEqual([]);
  });

  test("missing/corrupt todos never break the session load", async () => {
    const home = await tempHome();
    const s = createSession({ title: "old-record" }, home);
    // Old record without the key reads as empty.
    expect(readSessionTodos(getSession(s.id, home)!.metadata)).toEqual([]);
    for (const corrupt of [
      "oops",
      42,
      { content: "not-a-list" },
      [{ content: "ok", status: "bogus" }],
      [{ content: "", status: "pending" }],
      [{ content: "half-ok", status: "pending" }, "junk"],
      null,
    ]) {
      const next = updateSession(
        s.id,
        { metadata: { [ "todos" ]: corrupt } },
        home
      );
      expect(next).not.toBeNull();
      const reread = getSession(s.id, home);
      expect(reread).not.toBeNull();
      expect(reread!.title).toBe("old-record");
      expect(readSessionTodos(reread!.metadata)).toEqual([]);
    }
  });
});

describe("session delete takes the checklist with it (no cleanup code)", () => {
  test("deleteSession removes the record file; todos vanish", async () => {
    const home = await tempHome();
    const s = createSession({ title: "gone" }, home);
    persistTodos(s.id, sampleList(), home);
    expect(freshTodos(s.id, home)).toEqual(sampleList());
    expect(deleteSession(s.id, home)).toBe(true);
    expect(getSession(s.id, home)).toBeNull();
  });
});
