// History-budget tests (mocked fetch only, never live).
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGES,
  chatCompletion,
  historyCharBudget,
  historyChars,
  historyMessageBudget,
  runLoopWithChat,
  truncateHistory,
  type ChatMessage,
} from "../src/zen.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const realFetch = globalThis.fetch;
const SAVED_ENV = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of ["ATOM_MAX_HISTORY_MESSAGES", "ATOM_MAX_HISTORY_CHARS"]) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k]!;
  }
});

function userTurn(i: number): ChatMessage[] {
  return [
    { role: "user", content: `q${i}` },
    { role: "assistant", content: `a${i}` },
  ];
}

function toolTurn(i: number): ChatMessage[] {
  return [
    { role: "user", content: `q${i}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `c${i}`,
          type: "function",
          function: { name: "glob", arguments: '{"pattern":"*.ts"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: `c${i}`, content: `r${i}` },
    { role: "assistant", content: `a${i}` },
  ];
}

// Mock the chat POST path with a scripted reply queue; records every POST body.
function mockChatQueue(replies: unknown[]) {
  const posts: ChatMessage[][] = [];
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
      messages?: ChatMessage[];
    };
    posts.push(body.messages ?? []);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: true,
      json: async () => ({ choices: [{ message: next }] }),
    } as unknown as Response;
  });
  return posts;
}

function chatFn(history: ChatMessage[], o?: { onWarning?: (m: string) => void }) {
  return chatCompletion(ENDPOINT, "k", "m", history, {
    onWarning: o?.onWarning,
    sleep: async () => {},
  });
}

// OpenAI-shaped pairing invariant: system first, no orphan `tool` message,
// no assistant tool_call lacking its result.
function assertPairingIntact(msgs: ChatMessage[]) {
  expect(msgs[0]?.role).toBe("system");
  const calls = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls !== undefined) {
      expect(m.tool_calls.length).toBeGreaterThan(0);
      for (const c of m.tool_calls) {
        expect(c.id.length).toBeGreaterThan(0);
        calls.add(c.id);
      }
    }
  }
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.role === "tool") {
      expect(calls.has(m.tool_call_id)).toBe(true);
      seen.add(m.tool_call_id);
    }
  }
  expect(seen).toEqual(calls);
}

describe("message-count cap", () => {
  test("trims oldest-first before the first POST, system intact, one notice", async () => {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 60; i++) history.push(...userTurn(i)); // 121 msgs
    const posts = mockChatQueue([{ content: "done" }]);
    const warnings: string[] = [];
    const reply = await runLoopWithChat((h, o) => chatFn(h, o), history, {
      onWarning: (m) => void warnings.push(m),
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.length).toBe(99); // 11 oldest turns (22 msgs) dropped
    expect(posts[0]![0]).toEqual({ role: "system", content: "sys" });
    const dumped = JSON.stringify(posts[0]);
    expect(dumped).not.toContain('"q0"');
    expect(dumped).not.toContain('"q10"');
    expect(dumped).toContain('"q59"');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe("(history truncated: dropped 11 oldest turn(s))");
  });
});

describe("char-count cap", () => {
  test("trims by total chars independently of message count", async () => {
    const big = "x".repeat(80_000);
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 3; i++) {
      history.push({ role: "user", content: `q${i}` });
      history.push({ role: "assistant", content: `${big}${i}` });
    }
    expect(historyChars(history)).toBeGreaterThan(MAX_HISTORY_CHARS);
    const posts = mockChatQueue([{ content: "done" }]);
    const warnings: string[] = [];
    const reply = await runLoopWithChat((h, o) => chatFn(h, o), history, {
      onWarning: (m) => void warnings.push(m),
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    expect(posts).toHaveLength(1);
    expect(historyChars(posts[0]!)).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    expect(posts[0]![0]).toEqual({ role: "system", content: "sys" });
    expect(JSON.stringify(posts[0])).not.toContain('"q0"');
    expect(JSON.stringify(posts[0])).toContain('"q2"');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe("(history truncated: dropped 1 oldest turn(s))");
  });
});

describe("turn-boundary integrity", () => {
  test("tool pairs survive trimming; system intact; newest turns kept", async () => {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 26; i++) history.push(...toolTurn(i)); // 105 msgs
    const posts = mockChatQueue([{ content: "done" }]);
    const warnings: string[] = [];
    await runLoopWithChat((h, o) => chatFn(h, o), history, {
      onWarning: (m) => void warnings.push(m),
      sleep: async () => {},
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    assertPairingIntact(posts[0]!);
    const dumped = JSON.stringify(posts[0]);
    expect(dumped).not.toContain('"q0"');
    expect(dumped).toContain('"q25"');
    expect(dumped).toContain('"c25"');
    expect(warnings).toHaveLength(1);
  });

  test("latest turn is never dropped, even when it alone exceeds a cap", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "only" },
      { role: "assistant", content: "y".repeat(MAX_HISTORY_CHARS + 1) },
    ];
    const warnings: string[] = [];
    const out = truncateHistory(history, (m) => void warnings.push(m));
    expect(out.droppedTurns).toBe(0);
    expect(history).toHaveLength(3);
    expect(warnings).toHaveLength(0);
  });

  test("tiny histories are a no-op (silence, nothing dropped)", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const warnings: string[] = [];
    const out = truncateHistory(history, (m) => void warnings.push(m));
    expect(out).toEqual({ droppedTurns: 0, droppedMessages: 0 });
    expect(history).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });
});

describe("notice cadence", () => {
  test("one notice per truncating turn across multiple POSTs; silence otherwise", async () => {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 60; i++) history.push(...userTurn(i));
    const posts = mockChatQueue([
      {
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "glob", arguments: '{"pattern":"*.ts"}' },
          },
        ],
      },
      { content: "done" },
    ]);
    const warnings: string[] = [];
    const reply = await runLoopWithChat((h, o) => chatFn(h, o), history, {
      execute: async () => "tool-result",
      onWarning: (m) => void warnings.push(m),
      sleep: async () => {},
    });
    expect(reply).toBe("done");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.length).toBe(99);
    expect(posts[1]!.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    assertPairingIntact(posts[1]!);
    expect(warnings).toHaveLength(1);
  });

  test("non-truncating turns never notify", async () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    mockChatQueue([{ content: "done" }]);
    const warnings: string[] = [];
    await runLoopWithChat((h, o) => chatFn(h, o), history, {
      onWarning: (m) => void warnings.push(m),
      sleep: async () => {},
    });
    expect(warnings).toHaveLength(0);
  });
});

describe("rollback-after-truncation", () => {
  test("failed POST removes only the new turn; truncation stays applied", async () => {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 60; i++) history.push(...userTurn(i));
    const incomingText = "new question";
    const warnings: string[] = [];
    // App turn-start order: truncate BEFORE the push + rollbackTo capture,
    // reserving room for the incoming user message.
    truncateHistory(history, (m) => void warnings.push(m), {
      messages: 1,
      chars: incomingText.length,
    });
    const snapshot = [...history];
    const rollbackTo = history.length;
    history.push({ role: "user", content: incomingText });
    const bodies: ChatMessage[][] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
        messages?: ChatMessage[];
      };
      bodies.push(body.messages ?? []);
      return { ok: false, status: 400, text: async () => "boom" } as unknown as Response;
    });
    await expect(
      runLoopWithChat((h, o) => chatFn(h, o), history, { sleep: async () => {} })
    ).rejects.toThrow("Zen HTTP 400");
    history.splice(rollbackTo); // App's existing rollback contract
    expect(history).toEqual(snapshot); // the turn — and only the turn — is gone
    expect(warnings).toHaveLength(1); // loop entry was a no-op: single notice
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    expect(bodies[0]![0]).toEqual({ role: "system", content: "sys" });
    expect(bodies[0]!.at(-1)).toEqual({ role: "user", content: incomingText });
  });
});

describe("env overrides", () => {
  test("message budget clamps 10–1000, invalid/unset → default", () => {
    process.env.ATOM_MAX_HISTORY_MESSAGES = "5";
    expect(historyMessageBudget()).toBe(10);
    process.env.ATOM_MAX_HISTORY_MESSAGES = "5000";
    expect(historyMessageBudget()).toBe(1000);
    process.env.ATOM_MAX_HISTORY_MESSAGES = "250";
    expect(historyMessageBudget()).toBe(250);
    process.env.ATOM_MAX_HISTORY_MESSAGES = "abc";
    expect(historyMessageBudget()).toBe(MAX_HISTORY_MESSAGES);
    process.env.ATOM_MAX_HISTORY_MESSAGES = "";
    expect(historyMessageBudget()).toBe(MAX_HISTORY_MESSAGES);
    process.env.ATOM_MAX_HISTORY_MESSAGES = "-20";
    expect(historyMessageBudget()).toBe(MAX_HISTORY_MESSAGES);
    delete process.env.ATOM_MAX_HISTORY_MESSAGES;
    expect(historyMessageBudget()).toBe(MAX_HISTORY_MESSAGES);
  });

  test("char budget clamps 10_000–2_000_000, invalid/unset → default", () => {
    process.env.ATOM_MAX_HISTORY_CHARS = "5";
    expect(historyCharBudget()).toBe(10_000);
    process.env.ATOM_MAX_HISTORY_CHARS = "99999999";
    expect(historyCharBudget()).toBe(2_000_000);
    process.env.ATOM_MAX_HISTORY_CHARS = "500000";
    expect(historyCharBudget()).toBe(500_000);
    process.env.ATOM_MAX_HISTORY_CHARS = "nope";
    expect(historyCharBudget()).toBe(MAX_HISTORY_CHARS);
    process.env.ATOM_MAX_HISTORY_CHARS = "";
    expect(historyCharBudget()).toBe(MAX_HISTORY_CHARS);
    delete process.env.ATOM_MAX_HISTORY_CHARS;
    expect(historyCharBudget()).toBe(MAX_HISTORY_CHARS);
  });

  test("override actually drives truncation", () => {
    process.env.ATOM_MAX_HISTORY_MESSAGES = "10";
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 6; i++) history.push(...userTurn(i)); // 13 msgs
    const out = truncateHistory(history);
    expect(history.length).toBeLessThanOrEqual(10);
    expect(history[0]).toEqual({ role: "system", content: "sys" });
    expect(out.droppedTurns).toBeGreaterThan(0);
  });
});

describe("TUI notice + /clear", () => {
  async function waitForFrame(
    app: { lastFrame: () => string | undefined },
    needle: string,
    timeout = 8000
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

  test("one notice per truncating turn renders; /clear resets it", async () => {
    process.env.ATOM_MAX_HISTORY_MESSAGES = "10";
    try {
      const posts: ChatMessage[][] = [];
      let n = 0;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        n += 1;
        const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
          messages?: ChatMessage[];
        };
        posts.push(body.messages ?? []);
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: `r${n}` } }] }),
        } as unknown as Response;
      });
      const app = render(
        <App
          apiKey="test-key"
          endpoint={ENDPOINT}
          initialModel="big-pickle"
          initialModels={MODELS}
        />
      );
      try {
        for (let i = 0; i < 8; i++) {
          app.stdin.write(`m${i}`);
          app.stdin.write("\r");
          await waitForFrame(app, `r${i + 1}`);
        }
        await waitForFrame(app, "history truncated");
        const frame = app.lastFrame() ?? "";
        // Every truncating turn dropped exactly one turn with exactly one notice.
        const notices = frame.match(/history truncated: dropped 1 oldest turn\(s\)/g) ?? [];
        expect(notices.length).toBeGreaterThan(0);
        expect((frame.match(/history truncated/g) ?? []).length).toBe(notices.length);
        // The POST itself stayed within budget with the system prompt first.
        const last = posts.at(-1) ?? [];
        expect(last.length).toBeLessThanOrEqual(10);
        expect(last[0]?.role).toBe("system");
        // /clear resets the transcript AND the notice state.
        app.stdin.write("/clear");
        app.stdin.write("\r");
        await waitForFrame(app, "Say hi");
        expect(app.lastFrame()).not.toContain("history truncated");
      } finally {
        app.unmount();
      }
    } finally {
      delete process.env.ATOM_MAX_HISTORY_MESSAGES;
    }
  });
});
