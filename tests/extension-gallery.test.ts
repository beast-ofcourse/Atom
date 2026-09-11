// Extension guide gallery (ticket 11): the three checked-in samples under
// examples/extensions/ stay green as regression coverage. Every test loads
// the real sample files through the REAL loadExtensions path (entryPaths) —
// never a mock API, never a copy — so the guide and the working code cannot
// drift: the samples are the single source of truth and the guide
// (documentation/extensions.md) references them by filename.
//
// One load in beforeAll (jiti caches by path, so each sample activates
// exactly once); the global stores are cleared once in afterAll. Pure unit
// tests — no TUI, no network.
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadExtensions } from "../src/extensions.js";
import {
  clearExtensionCommands,
  getExtensionCommand,
  runExtensionCommand,
  type ExtensionCommandDeps,
} from "../src/extension-commands.js";
import type { ChatMessage, ChatResult, ToolCall } from "../src/zen.js";

const GALLERY_DIR = path.join(process.cwd(), "examples", "extensions");
const AUDIT_GATE = path.join(GALLERY_DIR, "01-audit-gate.js");
const NOTES_TOOL = path.join(GALLERY_DIR, "02-notes-tool.js");
const CUSTOM_COMMAND = path.join(GALLERY_DIR, "03-custom-command.js");

beforeAll(async () => {
  const runtime = await loadExtensions({ entryPaths: [AUDIT_GATE, NOTES_TOOL, CUSTOM_COMMAND] });
  expect(runtime.errors).toEqual([]);
  expect(runtime.loaded.map((e) => e.name)).toEqual(["01-audit-gate", "02-notes-tool", "03-custom-command"]);
});

afterAll(async () => {
  const { clearExtensionTools, clearToolInterceptors } = await import("../src/tools.js");
  clearExtensionTools();
  clearToolInterceptors();
  clearExtensionCommands();
});

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];
}

function scriptedChat(script: ChatResult[]) {
  let n = 0;
  return async (): Promise<ChatResult> => script[Math.min(n++, script.length - 1)]!;
}

function toolContents(history: ChatMessage[]): string[] {
  return history
    .filter((m) => m.role === "tool")
    .map((m) => String((m as { content: unknown }).content));
}

function commandDeps(overrides?: Partial<ExtensionCommandDeps>): ExtensionCommandDeps & {
  said: string[];
  asked: Array<{ question: string; options: string[]; allowCustom?: boolean }>;
} {
  const said: string[] = [];
  const asked: Array<{ question: string; options: string[]; allowCustom?: boolean }> = [];
  return {
    said,
    asked,
    cwd: "/gallery-cwd",
    askUser: async (question, options, allowCustom) => {
      asked.push({ question, options, allowCustom });
      return options[0]!;
    },
    getSession: () => ({ id: "sess-gallery", title: "Gallery", turnCount: 1 }),
    say: (message) => {
      said.push(message);
    },
    ...overrides,
  };
}

describe("01-audit-gate blocks destructive commands with a reason", () => {
  test("destructive bash is blocked end to end; the tool never runs", async () => {
    const { runLoopWithChat } = await import("../src/zen.js");
    let ran = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([{ content: null, tool_calls: [call("c1", "bash", { command: "rm -rf /tmp/x" })] }, { content: "done" }]),
      history,
      {
        execute: async () => {
          ran += 1;
          return "ran";
        },
      }
    );
    expect(reply).toBe("done");
    expect(ran).toBe(0);
    const contents = toolContents(history);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain('blocked by extension "01-audit-gate"');
    expect(contents[0]).toContain("destructive shell commands need explicit confirmation");
  });

  test("safe commands pass through untouched", async () => {
    const { runLoopWithChat } = await import("../src/zen.js");
    const seen: string[] = [];
    const history = baseHistory();
    await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "bash", { command: "ls -la" })] },
        { content: "done" },
      ]),
      history,
      {
        execute: async (_name: string, args: Record<string, unknown>) => {
          seen.push(String(args["command"]));
          return "ok";
        },
      }
    );
    expect(seen).toEqual(["ls -la"]);
    expect(toolContents(history)).toEqual(["ok"]);
  });
});

describe("02-notes-tool is callable by the model end to end", () => {
  test("registered, validated, executed", async () => {
    const { executeTool, toolNames, validateToolArgs } = await import("../src/tools.js");
    expect(toolNames()).toContain("gallery_notes");
    // Validation runs before execution: missing/wrong-typed args never run.
    expect(validateToolArgs("gallery_notes", {})).toContain('missing required field "text"');
    expect(await executeTool("gallery_notes", {})).toMatch(/^Error: invalid call:.*missing required field "text"/);
    expect(await executeTool("gallery_notes", { text: 42 })).toMatch(/^Error: invalid call:.*must be a string/);
    expect(await executeTool("gallery_notes", { text: "hello" })).toMatch(/^saved note #\d+: hello$/);
  });

  test("model call returns through the shared loop, paired by call id", async () => {
    const { runLoopWithChat } = await import("../src/zen.js");
    const history = baseHistory();
    const reply = await runLoopWithChat(
      scriptedChat([
        { content: null, tool_calls: [call("c1", "gallery_notes", { text: "oat milk" })] },
        { content: "noted" },
      ]),
      history
    );
    expect(reply).toBe("noted");
    const tools = history.filter((m) => m.role === "tool") as Array<{
      tool_call_id: string;
      content: string;
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool_call_id).toBe("c1");
    expect(String(tools[0]!.content)).toMatch(/^saved note #\d+: oat milk$/);
  });
});

describe("03-custom-command renders a dialog and completes its workflow", () => {
  test("pure workflow logic is separable from the modal (headless)", async () => {
    const mod = ((await import(CUSTOM_COMMAND)).default ?? {}) as {
      summarizeChoice: (choice: string, extra: string) => string;
    };
    expect(mod.summarizeChoice("staging", "")).toBe("deploying to staging");
    expect(mod.summarizeChoice("prod", "extra notes")).toBe("deploying to prod (extra notes)");
  });

  test("command asks via dialog and posts to the transcript", async () => {
    expect(getExtensionCommand("gallery-plan")?.description).toContain("deploy target");
    const deps = commandDeps({
      askUser: async (question, options) => {
        expect(question).toBe("Which environment?");
        expect(options).toEqual(["staging", "prod"]);
        return "prod";
      },
    });
    const result = await runExtensionCommand("gallery-plan", "extra notes", deps);
    expect(result).toEqual({ ok: true, posted: 2 });
    expect(deps.said).toEqual(["deploying to prod (extra notes)", "plan posted for prod"]);
  });
});

describe("guide references the checked-in samples (no drift)", () => {
  test("documentation/extensions.md names every sample file", () => {
    const guide = readFileSync(
      path.join(process.cwd(), "documentation", "extensions.md"),
      "utf8"
    );
    for (const file of ["01-audit-gate.js", "02-notes-tool.js", "03-custom-command.js"]) {
      expect(guide).toContain(file);
    }
  });
});
