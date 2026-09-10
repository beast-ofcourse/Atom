// Agentic-loop + AGENTS.md tests. Network is ALWAYS mocked — never hit live.
// Executors run for real in temp dirs; the TUI tests use the repo cwd
// (read-only tools) to prove tool lines render.
import React from "react";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { clearTodos, executeTool } from "../src/tools.js";
import {
  SYSTEM_PROMPT,
  buildSystemPrompt,
  loadAgentsPrompt,
  runAgenticLoop,
  type ChatMessage,
} from "../src/zen.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const realAgentsPath = process.env.OPENCODE_AGENTS_PATH;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  if (realAgentsPath === undefined) delete process.env.OPENCODE_AGENTS_PATH;
  else process.env.OPENCODE_AGENTS_PATH = realAgentsPath;
});

// Script the chat POST path with a queue of assistant messages.
function mockChatScript(messages: unknown[]) {
  const posts: Array<{ model: unknown; messages: any; tools: unknown }> = [];
  const queue = [...messages];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: unknown;
      messages?: any;
      tools?: unknown;
    };
    posts.push({ model: body.model, messages: body.messages, tools: body.tools });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: true, json: async () => ({ choices: [{ message: next }] }) } as Response;
  });
  return posts;
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("runAgenticLoop", () => {
  test("tool_call → local result → final answer, tools sent on every POST", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-agent-"));
    try {
      await fsp.writeFile(path.join(cwd, "a.ts"), "export const a = 1;\n");
      await fsp.writeFile(path.join(cwd, "b.md"), "# hi\n");
      const posts = mockChatScript([
        {
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }],
        },
        { content: "found a.ts" },
      ]);
      const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
      history.push({ role: "user", content: "list ts files" });
      const seen: string[] = [];
      const reply = await runAgenticLoop(ENDPOINT, "k", "big-pickle", history, {
        execute: (n, a) => executeTool(n, a, cwd),
        onToolActivity: (label) => seen.push(label),
      });
      expect(reply).toBe("found a.ts");
      expect(posts).toHaveLength(2);
      // tools schema attached (tool_choice omitted → default auto).
      expect((posts[0]?.tools as unknown[]).map((t: any) => t.function.name).sort()).toEqual(
        ["ask_question", "bash", "bash_output", "edit", "glob", "grep", "read", "todo_get", "todo_update", "todowrite", "webfetch", "websearch", "write"]
      );
      // Tool result fed back with the call id before the resend.
      const resend = posts[1]?.messages as ChatMessage[];
      expect(resend.some((m) => m.role === "tool" && (m as any).tool_call_id === "call_1")).toBe(true);
      expect(
        resend.some((m) => m.role === "tool" && String((m as any).content).includes("a.ts"))
      ).toBe(true);
      expect(seen).toEqual(["⚙ glob *.ts"]);
      // History keeps the full turn: user, assistant+tool_calls, tool, final.
      expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    } finally {
      await fsp.rm(cwd, { recursive: true, force: true });
    }
  });

  test("no tool_calls is the graceful fallback (single POST)", async () => {
    const posts = mockChatScript([{ content: "plain answer" }]);
    const history: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "hi" },
    ];
    await expect(runAgenticLoop(ENDPOINT, "k", "m", history)).resolves.toBe("plain answer");
    expect(posts).toHaveLength(1);
  });

  test("a model that always calls tools stops at an explicit cap with a notice", async () => {
    const posts = mockChatScript([
      { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "glob", arguments: '{"pattern":"*"}' } }] },
    ]);
    const history: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "go" },
    ];
    const reply = await runAgenticLoop(ENDPOINT, "k", "m", history, {
      execute: async () => "tool-result",
      maxSteps: 5,
    });
    expect(reply).toContain("(stopped: too many tool steps)");
    expect(posts).toHaveLength(6); // 1 initial + 5 tool rounds
    expect(history.at(-1)).toMatchObject({ role: "assistant" });
  });

  test("tool errors are results, not crashes — nothing rolls back", async () => {
    const posts = mockChatScript([
      {
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/abs/nope.txt"}' } }],
      },
      { content: "abs paths are rejected, noted" },
    ]);
    const history: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "read it" },
    ];
    const reply = await runAgenticLoop(ENDPOINT, "k", "m", history, {
      execute: (n, a) => executeTool(n, a, os.tmpdir()),
    });
    expect(reply).toContain("noted");
    const resend = posts[1]?.messages as ChatMessage[];
    expect(resend.some((m) => m.role === "tool" && String((m as any).content).startsWith("Error:"))).toBe(true);
  });
});

describe("AGENTS.md loading", () => {
  test("present file is appended to the system prompt", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-agents-"));
    try {
      await fsp.writeFile(path.join(cwd, "AGENTS.md"), "# Bot rules\nBe terse.\n");
      expect(loadAgentsPrompt(cwd)).toContain("Be terse.");
      expect(buildSystemPrompt(cwd).startsWith(`${SYSTEM_PROMPT}\n\n# Bot rules`)).toBe(true);
    } finally {
      await fsp.rm(cwd, { recursive: true, force: true });
    }
  });

  test("missing file falls back to the default prompt", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-agents-"));
    try {
      expect(loadAgentsPrompt(cwd)).toBeNull();
      expect(buildSystemPrompt(cwd)).toBe(SYSTEM_PROMPT);
    } finally {
      await fsp.rm(cwd, { recursive: true, force: true });
    }
  });

  test("oversized AGENTS.md is capped at 12KB with a truncation note", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-agents-"));
    try {
      await fsp.writeFile(path.join(cwd, "AGENTS.md"), `x`.repeat(13 * 1024));
      const loaded = loadAgentsPrompt(cwd)!;
      expect(loaded.length).toBeLessThan(13 * 1024);
      expect(loaded).toContain("[truncated: AGENTS.md exceeded 12KB]");
    } finally {
      await fsp.rm(cwd, { recursive: true, force: true });
    }
  });

  test("OPENCODE_AGENTS_PATH overrides the lookup", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-agents-"));
    try {
      const custom = path.join(cwd, "custom.md");
      await fsp.writeFile(custom, "custom rules");
      process.env.OPENCODE_AGENTS_PATH = custom;
      expect(loadAgentsPrompt(os.tmpdir())).toContain("custom rules");
    } finally {
      await fsp.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("TUI agentic display", () => {
  function baseProps() {
    return {
      apiKey: "test-key",
      endpoint: ENDPOINT,
      // Pinned: zen-path behavior, not default selection (see tests/kilo.test.ts).
      initialProvider: "opencode-zen" as const,
      initialModel: "big-pickle",
      initialModels: ["big-pickle"],
    };
  }

  test("tool calls render as dim lines, then the grounded final answer", async () => {
    mockChatScript([
      {
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: '{"pattern":"src/*.ts"}' } }],
      },
      { content: "src has zen.ts, tools.ts, App.tsx and cli.tsx" },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("list the .ts files in src and tell me what zen.ts does");
      app.stdin.write("\r");
      await waitForFrame(app, "⚙ glob src/*.ts");
      await waitForFrame(app, "src has zen.ts");
    } finally {
      app.unmount();
    }
  });

  test("tool errors render without crashing the app", async () => {
    mockChatScript([
      {
        content: null,
        tool_calls: [{ id: "c9", type: "function", function: { name: "read", arguments: '{"path":"/atom-does-not-exist-xyz/nope.txt"}' } }],
      },
      { content: "cannot read that path" },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("read the file");
      app.stdin.write("\r");
      await waitForFrame(app, "⚙ read /atom-does-not-exist-xyz/nope.txt");
      await waitForFrame(app, "no such file");
      await waitForFrame(app, "cannot read that path");
    } finally {
      app.unmount();
    }
  });

  test("todowrite renders the live checklist panel and transcript echo", async () => {
    mockChatScript([
      {
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "todowrite", arguments: '{"todos":[{"content":"Write code","status":"in_progress"},{"content":"Run tests","status":"pending"}]}' } }],
      },
      { content: "tracking two tasks" },
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("track this work");
      app.stdin.write("\r");
      await waitForFrame(app, "⚙ todowrite 2 task(s)");
      await waitForFrame(app, "Tasks 0/2");
      await waitForFrame(app, "Write code");
      await waitForFrame(app, "tracking two tasks");
    } finally {
      clearTodos();
      app.unmount();
    }
  });

  test("HTTP failure mid-loop rolls back the whole user turn", async () => {
    let n = 0;
    const seen: number[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown[] };
      seen.push(body.messages?.length ?? 0);
      if (n === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }] } }],
          }),
        } as Response;
      }
      if (n === 2) return { ok: false, status: 400, text: async () => "boom" } as Response;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "recovered" } }] }) } as Response;
    });
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "Zen HTTP 400");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "recovered");
      // POST1: [stable, dynamic env] system + user; POST2: +assistant+tool
      // (fails); POST3: clean retry. (+1 message vs history: the stable-prefix
      // split sends the env tail as its own system message.)
      expect(seen).toEqual([3, 5, 3]);
    } finally {
      app.unmount();
    }
  });

  test("AGENTS.md content reaches the POSTed system message; missing path still works", async () => {
    // Present: repo-root AGENTS.md (documents the glob tool).
    // NOTE: needle must be unique — "ok" is a substring of the "token: n/a"
    // status line, so it matches on mount before the first POST. The submit
    // pipeline (SUBMIT_PIPELINE_STAGES in src/App.tsx, pinned by
    // tests/submit-order.test.ts) runs async context-assembly (env refresh)
    // + loop-entry (skill discovery) before the first POST, so the test must
    // wait for the loop-entry reply, not the status line.
    const posts = mockChatScript([{ content: "ok-agent-overlay-xyz" }]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-agent-overlay-xyz");
      const sys = (posts[0]?.messages as ChatMessage[])[0] as { role: string; content: string };
      expect(sys.role).toBe("system");
      expect(sys.content.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(sys.content).toContain("glob");
    } finally {
      app.unmount();
    }
    // Missing: override points at nothing → default prompt + Task 6 env
    // block (no AGENTS.md overlay, still works).
    process.env.OPENCODE_AGENTS_PATH = path.join(os.tmpdir(), "atom-does-not-exist.md");
    const posts2 = mockChatScript([{ content: "ok2" }]);
    const app2 = render(<App {...baseProps()} />);
    try {
      app2.stdin.write("hi");
      app2.stdin.write("\r");
      await waitForFrame(app2, "ok2");
      const msgs2 = posts2[0]?.messages as ChatMessage[];
      const sys2 = msgs2[0] as { role: string; content: string };
      expect(sys2.role).toBe("system");
      expect(sys2.content.startsWith(SYSTEM_PROMPT)).toBe(true);
      // Stable-prefix split: the head carries the base with no env tail; the
      // env block rides as its own trailing system message.
      expect(sys2.content).not.toContain("[env ");
      const env2 = msgs2[1] as { role: string; content: string };
      expect(env2.role).toBe("system");
      expect(env2.content).toContain("[env ");
    } finally {
      app2.unmount();
    }
  });
});
