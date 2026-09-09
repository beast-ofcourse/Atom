// Read-only plan mode (ticket 04): TUI tests via ink-testing-library.
// Network is ALWAYS mocked here — never verify against the live API.
//
// Tab decision: Tab is the only mode switcher and cycles
// normal → yolo → plan → normal (pinned by tests/status.test.tsx). The
// /plan and /yolo commands are retired (typing them explains). /trust
// while in plan stays read-only with a notice (flag untouched); exiting
// plan via Tab is the human approval and always lands in normal
// (never yolo).
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App, helpListText, SLASH_COMMANDS } from "../src/App.js";
import { clearTodos, getTodos, todowriteTool } from "../src/tools.js";

const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  clearTodos();
});

function toolMsg(id: string, name: string, args: Record<string, unknown>) {
  return {
    message: {
      content: null,
      tool_calls: [
        { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
  };
}

function textMsg(content: string) {
  return { message: { content } };
}

// Queue-backed chat mock (single-JSON path): each POST pops the next scripted
// assistant message, repeating the last forever.
function mockChatScriptMessages(messages: unknown[]) {
  const queue = [...messages];
  globalThis.fetch = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { ok: true, json: async () => ({ choices: [next] }) } as Response;
  });
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

// Tab-only mode switching: two Tabs from normal enter plan
// (normal → yolo → plan), one Tab exits back to normal.
async function enterPlan(app: { stdin: { write(s: string): void }; lastFrame: () => string | undefined }) {
  app.stdin.write("\t");
  await waitForFrame(app, "mode: yolo");
  app.stdin.write("\t");
  await waitForFrame(app, "plan mode: on");
}

async function cleanProbes(...probes: string[]) {
  const { rm } = await import("node:fs/promises");
  for (const p of probes) {
    try {
      await rm(p, { force: true });
    } catch {
      // ignore
    }
  }
}

describe("plan mode entry/exit + status", () => {
  test("Tab Tab enters read-only mode (status shows it); Tab exits to normal", async () => {
    mockChatScriptMessages([textMsg("ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      expect(app.lastFrame()).toContain("mode: normal");
      await enterPlan(app);
      expect(app.lastFrame()).toContain("mode: plan");
      // /mode names the read-only contract.
      app.stdin.write("/mode");
      await waitForFrame(app, "Atom commands");
      // "/mode" prefix-matches "/model" and "/models" first — arrow down
      // twice to run "/mode".
      app.stdin.write("[B");
      app.stdin.write("[B");
      app.stdin.write("\r");
      await waitForFrame(app, "mode: plan (read-only");
      // Exiting with an empty checklist records nothing but still lands normal.
      app.stdin.write("\t");
      await waitForFrame(app, "(plan mode off — no plan recorded)");
      expect(app.lastFrame()).toContain("mode: normal");
    } finally {
      app.unmount();
    }
  });

  test("/plan and /yolo are retired; Tab owns mode switching", () => {
    expect(SLASH_COMMANDS.find((c) => c.name === "/plan")).toBeUndefined();
    expect(SLASH_COMMANDS.find((c) => c.name === "/yolo")).toBeUndefined();
    const help = helpListText();
    expect(help).toContain("Tab is the only mode switcher");
    expect(help).toContain("normal → yolo → plan → normal");
    expect(help).toMatch(/read-only/);
  });

  test("typing /plan or /yolo explains instead of switching", async () => {
    mockChatScriptMessages([textMsg("ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/plan");
      app.stdin.write("\r");
      await waitForFrame(app, "Tab cycles the permission mode");
      expect(app.lastFrame()).toContain("mode: normal");
      app.stdin.write("/yolo");
      app.stdin.write("\r");
      await waitForFrame(app, "Tab cycles the permission mode");
      expect(app.lastFrame()).toContain("mode: normal");
    } finally {
      app.unmount();
    }
  });
});

describe("plan mode blocks every mutation tool with a message (zero disk writes)", () => {
  test("write is blocked pre-execution: no prompt, audit line renders, file untouched", async () => {
    const probe = "plan-probe-write.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hello" }),
      textMsg("will plan instead"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await enterPlan(app);
      app.stdin.write("please write it");
      app.stdin.write("\r");
      await waitForFrame(app, "will plan instead");
      const frame = app.lastFrame() ?? "";
      // Replan-friendly result, never a prompt, never silent.
      expect(frame).toContain("plan mode is read-only");
      expect(frame).toContain(`⚙ write ${probe}`);
      expect(frame).not.toContain("allow this tool?");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("edit is blocked pre-execution: existing file keeps its bytes", async () => {
    const probe = "plan-probe-edit.txt";
    await cleanProbes(probe);
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(probe, "original bytes", "utf8");
    mockChatScriptMessages([
      toolMsg("c1", "edit", { path: probe, oldString: "original", newString: "CHANGED" }),
      textMsg("will plan instead"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await enterPlan(app);
      app.stdin.write("please edit it");
      app.stdin.write("\r");
      await waitForFrame(app, "will plan instead");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("plan mode is read-only");
      expect(frame).not.toContain("allow this tool?");
      await expect(readFile(probe, "utf8")).resolves.toBe("original bytes");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("bash is blocked pre-execution: no side effects, no prompt", async () => {
    const probe = "plan-probe-bash.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "bash", { command: `echo hello > ${probe}` }),
      textMsg("will plan instead"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await enterPlan(app);
      app.stdin.write("please run it");
      app.stdin.write("\r");
      await waitForFrame(app, "will plan instead");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("plan mode is read-only");
      expect(frame).not.toContain("allow this tool?");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});

describe("plan mode runs exploration tools freely", () => {
  test("read executes in plan mode (no block note)", async () => {
    const probe = "plan-probe-read.txt";
    await cleanProbes(probe);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(probe, "readable-content-123", "utf8");
    mockChatScriptMessages([
      toolMsg("c1", "read", { path: probe }),
      textMsg("saw it"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await enterPlan(app);
      app.stdin.write("read the file");
      app.stdin.write("\r");
      await waitForFrame(app, "saw it");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain(`⚙ read ${probe}`);
      // Successful reads echo only the ⚙ audit line (result text goes to the
      // model, not the transcript) — the completed turn + no block note prove
      // the tool executed free.
      expect(frame).not.toContain("plan mode is read-only");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("todowrite/todo_update run free in plan mode (checklist is the plan record)", async () => {
    mockChatScriptMessages([
      toolMsg("c1", "todowrite", { todos: [{ content: "Plan thing", status: "pending" }] }),
      toolMsg("c2", "todo_update", { index: 1, status: "completed" }),
      textMsg("tracked"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await enterPlan(app);
      app.stdin.write("track this");
      app.stdin.write("\r");
      await waitForFrame(app, "tracked");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("⚙ todowrite 1 task(s)");
      expect(frame).toContain("⚙ todo_update");
      expect(frame).toContain("1 task(s) completed");
      expect(frame).not.toContain("plan mode is read-only");
    } finally {
      app.unmount();
    }
  });

  test("ask_question runs free in plan mode (it is interaction, not mutation)", async () => {
    mockChatScriptMessages([
      toolMsg("c1", "ask_question", { question: "Which?", options: ["A", "B"] }),
      textMsg("noted choice"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      await enterPlan(app);
      app.stdin.write("decide something");
      app.stdin.write("\r");
      await waitForFrame(app, "Atom question");
      app.stdin.write("\r"); // pick the highlighted option
      await waitForFrame(app, "noted choice");
      expect(app.lastFrame()).not.toContain("plan mode is read-only");
    } finally {
      app.unmount();
    }
  });
});

describe("plan mode composition", () => {
  test("deny still wins in plan mode (deny result, not the plan note)", async () => {
    const probe = "plan-probe-deny.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hi" }),
      textMsg("understood, denied"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/deny write:plan-probe-deny.txt");
      app.stdin.write("\r");
      await waitForFrame(app, "denied: write:plan-probe-deny.txt");
      await enterPlan(app);
      app.stdin.write("write it please");
      app.stdin.write("\r");
      await waitForFrame(app, "understood, denied");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("denied by user: write");
      expect(frame).not.toContain("plan mode is read-only");
      expect(frame).not.toContain("allow this tool?");
      const { existsSync } = await import("node:fs");
      expect(existsSync(probe)).toBe(false);
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });

  test("/trust stays read-only in plan (flag untouched; works again after Tab exit)", async () => {
    mockChatScriptMessages([textMsg("ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      await enterPlan(app);
      // /trust refuses — no +trust tier while read-only.
      app.stdin.write("/trust");
      app.stdin.write("\r");
      await waitForFrame(app, "Tab out of plan before /trust; trust unchanged");
      expect(app.lastFrame()).toContain("mode: plan");
      expect(app.lastFrame()).not.toContain("+trust");
      // Tab exit (human approval) restores the normal surface: trust works.
      app.stdin.write("\t");
      await waitForFrame(app, "(plan mode off — no plan recorded)");
      app.stdin.write("/trust");
      app.stdin.write("\r");
      await waitForFrame(app, "trust: on");
    } finally {
      app.unmount();
    }
  });

  test("Tab cycles normal → yolo → plan → normal (the only switcher)", async () => {
    mockChatScriptMessages([textMsg("ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      expect(app.lastFrame()).toContain("mode: normal");
      app.stdin.write("\t");
      await waitForFrame(app, "mode: yolo");
      app.stdin.write("\t");
      await waitForFrame(app, "mode: plan");
      app.stdin.write("\t");
      await waitForFrame(app, "mode: normal");
      // Full second lap proves the cycle repeats instead of sticking.
      app.stdin.write("\t");
      await waitForFrame(app, "mode: yolo");
    } finally {
      app.unmount();
    }
  });

  test("entering plan from yolo and exiting lands in normal (never yolo)", async () => {
    mockChatScriptMessages([textMsg("ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("\t");
      await waitForFrame(app, "mode: yolo");
      app.stdin.write("\t");
      await waitForFrame(app, "mode: plan");
      app.stdin.write("\t");
      await waitForFrame(app, "mode: normal");
      // The transcript keeps earlier mode lines as scrollback, so assert on
      // the live status line (tail) — it must read normal, not yolo.
      // The status bar is the last rendered block: take the frame tail.
      const lines = (app.lastFrame() ?? "").split("\n").filter((l) => l.trim().length > 0);
      const statusTail = lines.slice(-3).join("\n");
      expect(statusTail).toContain("mode: normal");
      expect(statusTail).not.toContain("mode: yolo");
    } finally {
      app.unmount();
    }
  });

  test("exiting plan approves the recorded checklist into implementation (todowrite handoff)", async () => {
    mockChatScriptMessages([textMsg("ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      await enterPlan(app);
      // The plan is recorded on the session checklist while planning (the
      // model does this via todowrite, which runs free in plan mode).
      await todowriteTool({
        todos: [
          { content: "Implement step one", status: "pending" },
          { content: "Implement step two", status: "pending" },
        ],
      });
      // Tab exit is the human approval: the checklist carries over.
      app.stdin.write("\t");
      await waitForFrame(app, "(plan approved — 2 task(s) carry into implementation");
      expect(app.lastFrame()).toContain("mode: normal");
      expect(getTodos()).toHaveLength(2);
      expect(getTodos()[0]?.content).toBe("Implement step one");
    } finally {
      app.unmount();
    }
  });
});
