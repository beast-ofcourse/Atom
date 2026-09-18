// update_goal visibility (Temp-session c41: `complete` filed with no live
// goal, twice across sessions, after a description-only fix proved
// insufficient). update_goal now rides the model-visible schema only while a
// goal turn is live; executability (toolNames/dispatch) stays full so a
// hallucinated call still lands on the outside-turn error.
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildAnthropicBody, buildGeminiBody } from "../src/adapters.js";
import {
  TOOL_DEFINITIONS,
  allToolDefinitions,
  chatToolDefinitions,
} from "../src/tools.js";
import {
  createTelemetryRecorder,
  resolveAtomVersion,
} from "../src/telemetry.js";
import { chatCompletion, runAgenticLoop } from "../src/zen.js";
import type { ChatMessage } from "../src/zen.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

function toolNamesOf(defs: Array<{ function: { name: string } }>): string[] {
  return defs.map((t) => t.function.name);
}

describe("chatToolDefinitions", () => {
  test("full surface keeps all six goal tools; false drops every goal tool", () => {
    const full = toolNamesOf(allToolDefinitions());
    for (const name of [
      "get_goal",
      "create_goal",
      "update_goal",
      "pause_goal",
      "resume_goal",
      "clear_goal",
    ]) {
      expect(full).toContain(name);
    }
    expect(full).toContain("grep");
    const filtered = toolNamesOf(chatToolDefinitions(false));
    for (const name of [
      "get_goal",
      "create_goal",
      "update_goal",
      "pause_goal",
      "resume_goal",
      "clear_goal",
    ]) {
      expect(filtered).not.toContain(name);
    }
    expect(filtered).toContain("grep");
    expect(filtered).toHaveLength(full.length - 6);
    // Builtins untouched (13-entry pin holds through the new function).
    expect(TOOL_DEFINITIONS).toHaveLength(13);
    expect(toolNamesOf(chatToolDefinitions())).toEqual(full);
  });

  test("struct includes per flag (paused-goal matrix: get/resume/clear only)", () => {
    const names = toolNamesOf(
      chatToolDefinitions({
        update: false,
        get: true,
        create: false,
        pause: false,
        resume: true,
        clear: true,
      })
    );
    expect(names).toContain("get_goal");
    expect(names).toContain("resume_goal");
    expect(names).toContain("clear_goal");
    expect(names).not.toContain("update_goal");
    expect(names).not.toContain("create_goal");
    expect(names).not.toContain("pause_goal");
  });
});

describe("adapters honor includeUpdateGoal", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];

  test("anthropic body drops every goal tool when asked; struct narrows", () => {
    const full = buildAnthropicBody(history, "claude-x").tools!.map((t) => t.name);
    expect(full).toContain("update_goal");
    expect(full).toContain("create_goal");
    const filtered = buildAnthropicBody(history, "claude-x", { includeUpdateGoal: false }).tools!.map(
      (t) => t.name
    );
    expect(filtered).not.toContain("update_goal");
    expect(filtered).not.toContain("create_goal");
    expect(filtered).toHaveLength(full.length - 6);
    const struct = buildAnthropicBody(history, "claude-x", {
      includeUpdateGoal: { update: true, get: true, create: false, pause: false, resume: false, clear: false },
    }).tools!.map((t) => t.name);
    expect(struct).toContain("update_goal");
    expect(struct).toContain("get_goal");
    expect(struct).not.toContain("create_goal");
  });

  test("gemini body drops every goal tool when asked; struct narrows", () => {
    const full = buildGeminiBody(history, "gemini-x").tools![0]!.functionDeclarations.map((d) => d.name);
    expect(full).toContain("update_goal");
    expect(full).toContain("pause_goal");
    const filtered = buildGeminiBody(history, "gemini-x", { includeUpdateGoal: false }).tools![0]!
      .functionDeclarations.map((d) => d.name);
    expect(filtered).not.toContain("update_goal");
    expect(filtered).not.toContain("pause_goal");
    expect(filtered).toHaveLength(full.length - 6);
    const struct = buildGeminiBody(history, "gemini-x", {
      includeUpdateGoal: { update: false, get: true, create: false, pause: false, resume: true, clear: true },
    }).tools![0]!.functionDeclarations.map((d) => d.name);
    expect(struct).toContain("get_goal");
    expect(struct).toContain("resume_goal");
    expect(struct).not.toContain("update_goal");
  });
});

describe("openai-chat payload honors includeUpdateGoal", () => {
  function mockChat(seen: Array<{ body: Record<string, unknown> }>) {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push({ body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: "done" } }] }),
      };
    }) as unknown as typeof fetch;
  }

  const history: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];

  test("default POST carries goal tools; false omits every goal tool", async () => {
    const seenDefault: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seenDefault);
    await chatCompletion("https://example.test/v1", "k", "m", history, { sleep: async () => {} });
    const defaultNames = toolNamesOf(
      (seenDefault[0]!.body["tools"] as Array<{ function: { name: string } }>)
    );
    expect(defaultNames).toContain("update_goal");

    const seenFiltered: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seenFiltered);
    await chatCompletion("https://example.test/v1", "k", "m", history, {
      sleep: async () => {},
      includeUpdateGoal: false,
    });
    const filteredNames = toolNamesOf(
      (seenFiltered[0]!.body["tools"] as Array<{ function: { name: string } }>)
    );
    expect(filteredNames).not.toContain("update_goal");
    expect(filteredNames).not.toContain("create_goal");
    expect(filteredNames).not.toContain("pause_goal");
  });
});

describe("runAgenticLoop derives visibility from the live goal per POST", () => {
  function mockChat(seen: Array<{ body: Record<string, unknown> }>) {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push({ body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: "done" } }] }),
      };
    }) as unknown as typeof fetch;
  }

  const history = (): ChatMessage[] => [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];

  test("no goal hook → update_goal hidden (the c41 case cannot be emitted)", async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seen);
    const reply = await runAgenticLoop("https://example.test/v1", "k", "m", history());
    expect(reply).toBe("done");
    const names = toolNamesOf(
      (seen[0]!.body["tools"] as Array<{ function: { name: string } }>)
    );
    expect(names).not.toContain("update_goal");
  });

  test("active goal → update/get/pause/clear present, create/resume absent", async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seen);
    const reply = await runAgenticLoop("https://example.test/v1", "k", "m", history(), {
      // One POST only: the mock answers final text and the spent step
      // budget pauses the goal instead of auto-continuing.
      maxSteps: 0,
      goal: {
        getGoal: () => ({ objective: "ship it", active: true }),
        pauseGoal: () => {},
      },
    });
    expect(typeof reply).toBe("string");
    const names = toolNamesOf(
      (seen[0]!.body["tools"] as Array<{ function: { name: string } }>)
    );
    expect(names).toContain("update_goal");
    expect(names).toContain("get_goal");
    expect(names).toContain("pause_goal");
    expect(names).toContain("clear_goal");
    expect(names).not.toContain("create_goal");
    expect(names).not.toContain("resume_goal");
  });

  test("paused goal → get/resume/clear present, update/pause absent", async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seen);
    await runAgenticLoop("https://example.test/v1", "k", "m", history(), {
      maxSteps: 0,
      goal: {
        getGoal: () => ({ objective: "ship it", active: false }),
        pauseGoal: () => {},
      },
    });
    const names = toolNamesOf(
      (seen[0]!.body["tools"] as Array<{ function: { name: string } }>)
    );
    expect(names).toContain("get_goal");
    expect(names).toContain("resume_goal");
    expect(names).toContain("clear_goal");
    expect(names).not.toContain("update_goal");
    expect(names).not.toContain("pause_goal");
    expect(names).not.toContain("create_goal");
  });

  test("/goal intent in prompt arms create_goal with no live goal", async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    mockChat(seen);
    await runAgenticLoop(
      "https://example.test/v1",
      "k",
      "m",
      [
        { role: "system", content: "s" },
        { role: "user", content: "/goal Ship the migration" },
      ],
      { maxSteps: 0 }
    );
    const names = toolNamesOf(
      (seen[0]!.body["tools"] as Array<{ function: { name: string } }>)
    );
    expect(names).toContain("create_goal");
    expect(names).not.toContain("update_goal");
    expect(names).not.toContain("get_goal");
  });

  test("bare /goal and ordinary text never arm create_goal", async () => {
    for (const content of ["hi there", "/goal", "/goal pause", "goalsetting tips"]) {
      const seen: Array<{ body: Record<string, unknown> }> = [];
      mockChat(seen);
      await runAgenticLoop(
        "https://example.test/v1",
        "k",
        "m",
        [
          { role: "system", content: "s" },
          { role: "user", content },
        ],
        { maxSteps: 0 }
      );
      const names = toolNamesOf(
        (seen[0]!.body["tools"] as Array<{ function: { name: string } }>)
      );
      expect(names).not.toContain("create_goal");
    }
  });
});

describe("resolveAtomVersion stamps session records", () => {
  test("reads the package manifest version", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(resolveAtomVersion()).toBe(pkg.version);
  });

  test("recorder defaults to the manifest; explicit null stays null", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(createTelemetryRecorder({ enabled: false }).getSnapshot().atomVersion).toBe(pkg.version);
    expect(
      createTelemetryRecorder({ enabled: false, atomVersion: null }).getSnapshot().atomVersion
    ).toBeNull();
  });
});
