// Issue 06: after-tool-call result hook — the sanctioned seam between tool
// execution and commit. Default is an inert passthrough; a hook may replace
// content, flip the error flag, or veto the commit; hook failures degrade to
// the original result. Mocked only, never live.
import { describe, expect, test } from "vitest";
import { runLoopWithChat, type ChatMessage, type ChatResult, type LoopStats } from "../src/zen.js";

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

function toolThenFinal(toolCallId = "c1") {
  let posts = 0;
  return async (): Promise<ChatResult> => {
    posts += 1;
    if (posts === 1) {
      return {
        content: null,
        tool_calls: [
          { id: toolCallId, type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
        ],
      };
    }
    return { content: "final" };
  };
}

describe("loop: result hook passthrough is invisible", () => {
  test("no hook vs hook returning undefined → byte-identical history and reply", async () => {
    const h1 = baseHistory();
    const r1 = await runLoopWithChat(toolThenFinal(), h1, {
      execute: async () => "file contents",
      sleep: async () => {},
    });
    const h2 = baseHistory();
    const r2 = await runLoopWithChat(toolThenFinal(), h2, {
      execute: async () => "file contents",
      onToolResult: () => undefined,
      sleep: async () => {},
    });
    expect(r2).toBe(r1);
    expect(h2).toEqual(h1);
  });

  test("hook returning null / void passthrough keeps bytes identical", async () => {
    const h1 = baseHistory();
    await runLoopWithChat(toolThenFinal(), h1, {
      execute: async () => "abc",
      sleep: async () => {},
    });
    const h2 = baseHistory();
    await runLoopWithChat(toolThenFinal(), h2, {
      execute: async () => "abc",
      onToolResult: async () => null,
      sleep: async () => {},
    });
    expect(h2).toEqual(h1);
  });

  test("throwing hook degrades to the original result, turn continues", async () => {
    const history = baseHistory();
    const activities: Array<{ result: string; isError: boolean }> = [];
    const reply = await runLoopWithChat(toolThenFinal(), history, {
      execute: async () => "original-result",
      onToolResult: () => {
        throw new Error("hook blew up");
      },
      onToolActivity: (_label, result, isError) => void activities.push({ result, isError }),
      sleep: async () => {},
    });
    expect(reply).toBe("final");
    const toolMsg = history.find((m) => m.role === "tool") as { content: string };
    expect(toolMsg.content).toBe("original-result");
    expect(activities).toEqual([{ result: "original-result", isError: false }]);
  });
});

describe("loop: result hook non-trivial rewrite end to end", () => {
  test("redaction marker replaces secret in history + activity, executor untouched", async () => {
    const history = baseHistory();
    const seen: Array<{ name: string; args: unknown; result: string; isError: boolean }> = [];
    const activities: Array<{ label: string; result: string; isError: boolean }> = [];
    let stats: LoopStats | null = null;
    const reply = await runLoopWithChat(toolThenFinal(), history, {
      execute: async () => "token sk-secret-123 done",
      onToolResult: (input) => {
        seen.push({ name: input.name, args: input.args, result: input.result, isError: input.isError });
        return input.result.replace(/sk-secret-\S+/, "[redacted]");
      },
      onToolActivity: (label, result, isError) => void activities.push({ label, result, isError }),
      onLoopStats: (s) => {
        stats = s;
      },
      sleep: async () => {},
    });
    expect(reply).toBe("final");
    // Hook observed the real execution.
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({
      name: "read",
      args: { path: "a" },
      result: "token sk-secret-123 done",
      isError: false,
    });
    // Committed history carries the rewrite; the secret leaks nowhere.
    const toolMsg = history.find((m) => m.role === "tool") as { content: string };
    expect(toolMsg.content).toBe("token [redacted] done");
    expect(JSON.stringify(history)).not.toContain("sk-secret-123");
    // Activity observes the committed (rewritten) result.
    expect(activities).toEqual([{ label: expect.any(String), result: "token [redacted] done", isError: false }]);
    expect((stats as unknown as LoopStats).toolCalls).toBe(1);
    expect((stats as unknown as LoopStats).failures).toBe(0);
  });

  test("hook may flip the error flag without touching content", async () => {
    const history = baseHistory();
    const activities: Array<{ result: string; isError: boolean }> = [];
    let stats: LoopStats | null = null;
    await runLoopWithChat(toolThenFinal(), history, {
      execute: async () => "all good",
      onToolResult: () => ({ isError: true }),
      onToolActivity: (_label, result, isError) => void activities.push({ result, isError }),
      onLoopStats: (s) => {
        stats = s;
      },
      sleep: async () => {},
    });
    const toolMsg = history.find((m) => m.role === "tool") as { content: string };
    expect(toolMsg.content).toBe("all good");
    expect(activities).toEqual([{ result: "all good", isError: true }]);
    expect((stats as unknown as LoopStats).failures).toBe(1);
  });

  test("hook may veto the commit — nothing recorded, turn continues", async () => {
    const history = baseHistory();
    const activities: string[] = [];
    const reply = await runLoopWithChat(toolThenFinal(), history, {
      execute: async () => "dropped",
      onToolResult: () => ({ veto: true }),
      onToolActivity: (label) => void activities.push(label),
      sleep: async () => {},
    });
    expect(reply).toBe("final");
    expect(history.some((m) => m.role === "tool")).toBe(false);
    expect(activities).toEqual([]);
  });
});
