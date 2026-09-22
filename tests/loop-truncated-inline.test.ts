// Issue 03: length-truncated responses fail tool calls inline and the turn
// continues — instead of aborting the whole POST and rolling back.
// Transport failures (HTTP/network/empty/stalled streams) keep throwing.
// Mocked only, never live.
import { afterEach, describe, expect, test, vi } from "vitest";
import { clearTodos } from "../src/tools.js";
import {
  chatCompletion,
  readSSEMessage,
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
  type LoopStats,
  type ToolCall,
} from "../src/zen.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  clearTodos();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

function truncatedCalls(): ToolCall[] {
  return [
    {
      id: "call_trunc_1",
      type: "function",
      function: { name: "read", arguments: '{"path": "a.ts"' },
    },
    {
      id: "call_trunc_2",
      type: "function",
      function: { name: "grep", arguments: '{"pattern": "x"' },
    },
  ];
}

describe("loop: truncated-with-calls continues inline", () => {
  test("nothing executes; each call becomes a re-issue error; next round runs", async () => {
    let posts = 0;
    const history = baseHistory();
    let stats: LoopStats | null = null;
    const activities: Array<{ label: string; isError: boolean }> = [];
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return { content: "partial", tool_calls: truncatedCalls(), truncated: true };
        }
        return { content: "recovered-final" };
      },
      history,
      {
        execute: async () => {
          throw new Error("must not execute truncated calls");
        },
        onToolActivity: (label, _result, isError) => void activities.push({ label, isError }),
        onLoopStats: (s) => {
          stats = s;
        },
        sleep: async () => {},
      }
    );
    expect(reply).toBe("recovered-final");
    expect(posts).toBe(2);
    // Pairing intact: assistant-with-calls + one tool message per call.
    const roles = history.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "tool", "assistant"]);
    const assistant = history[2] as { tool_calls?: ToolCall[] };
    expect(assistant.tool_calls?.map((c) => c.id)).toEqual(["call_trunc_1", "call_trunc_2"]);
    const toolMsgs = history.filter((m) => m.role === "tool") as Array<{
      tool_call_id: string;
      content: string;
    }>;
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["call_trunc_1", "call_trunc_2"]);
    for (const m of toolMsgs) {
      expect(m.content.startsWith("Error:")).toBe(true);
      expect(m.content).toContain("truncated response");
      expect(m.content).toContain("Re-issue the call with complete arguments");
    }
    expect(activities.length).toBe(2);
    expect(activities.every((a) => a.isError)).toBe(true);
    expect((stats as unknown as LoopStats).failures).toBe(2);
    expect((stats as unknown as LoopStats).toolCalls).toBe(2);
  });
});

describe("loop: truncated-without-calls behaves as before", () => {
  test("final text ends the turn normally with no tool messages", async () => {
    let posts = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: "final text", truncated: true };
      },
      history,
      { execute: async () => "x", sleep: async () => {} }
    );
    expect(reply).toBe("final text");
    expect(posts).toBe(1);
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });
});

describe("loop: real failures still throw", () => {
  test("transport truncation aborts (caller rolls back)", async () => {
    let posts = 0;
    await expect(
      runLoopWithChat(
        async (): Promise<ChatResult> => {
          posts += 1;
          throw new Error("Truncated stream from model (connection aborted before [DONE]).");
        },
        baseHistory(),
        { execute: async () => "x", sleep: async () => {} }
      )
    ).rejects.toThrow("Truncated stream from model");
    expect(posts).toBe(1);
  });

  test("non-truncated tool calls still execute as before", async () => {
    let posts = 0;
    let executed = 0;
    const history = baseHistory();
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        if (posts === 1) {
          return {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
            ],
          };
        }
        return { content: "after-tool" };
      },
      history,
      {
        execute: async () => {
          executed += 1;
          return "file contents";
        },
        sleep: async () => {},
      }
    );
    expect(reply).toBe("after-tool");
    expect(executed).toBe(1);
  });
});

function sseBody(chunks: string[]): unknown {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i < chunks.length) return { done: false as const, value: chunks[i++]! };
        return { done: true as const, value: undefined };
      },
      releaseLock: () => {},
    }),
  };
}

describe("transport: finish_reason length returns truncated flag", () => {
  test("readSSEMessage: length chunk + [DONE] returns calls with truncated:true", async () => {
    const toolDelta = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: '{"path": "a"}' },
              },
            ],
          },
        },
      ],
    })}\n\n`;
    const lengthMark = `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "length" }],
    })}\n\n`;
    const chunks = [toolDelta, lengthMark, "data: [DONE]\n\n"];
    const res = { body: sseBody(chunks) } as unknown as Response;
    const out = await readSSEMessage(res);
    expect(out.truncated).toBe(true);
    expect(out.tool_calls?.length).toBe(1);
    expect(out.tool_calls?.[0]?.function.name).toBe("read");
  });

  test("readSSEMessage: clean finish leaves truncated unset", async () => {
    const textDelta = `data: ${JSON.stringify({
      choices: [{ delta: { content: "hi" } }],
    })}\n\n`;
    const stopMark = `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}\n\n`;
    const chunks = [textDelta, stopMark, "data: [DONE]\n\n"];
    const res = { body: sseBody(chunks) } as unknown as Response;
    const out = await readSSEMessage(res);
    expect(out.truncated).toBe(undefined);
    expect(out.content).toBe("hi");
  });

  test("chatCompletion non-streaming JSON: finish_reason length sets truncated", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "read", arguments: '{"path": "a"' },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
      }),
    })) as unknown as typeof fetch;
    const out = await chatCompletion("https://example.test/v1", "key", "m", baseHistory());
    expect(out.truncated).toBe(true);
    expect(out.tool_calls?.length).toBe(1);
  });

  test("chatCompletion non-streaming JSON: stop finish leaves truncated unset", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      }),
    })) as unknown as typeof fetch;
    const out = await chatCompletion("https://example.test/v1", "key", "m", baseHistory());
    expect(out.truncated).toBe(undefined);
    expect(out.content).toBe("hi");
  });
});

describe("transport: framing-tolerant EOF (gateway cut after finish)", () => {
  function streamResponse(chunks: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  function contentChunk(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  }

  function finishChunk(finish: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`;
  }

  test("readSSEMessage: stop finish + clean EOF without [DONE] returns content", async () => {
    const res = streamResponse([contentChunk("late tail"), finishChunk("stop")]);
    const out = await readSSEMessage(res as unknown as Response);
    expect(out.content).toBe("late tail");
    expect(out.truncated).toBe(undefined);
  });

  test("readSSEMessage: tool_calls finish + clean EOF without [DONE] returns calls", async () => {
    const toolDelta = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"a"}' },
              },
            ],
          },
        },
      ],
    })}\n\n`;
    const res = streamResponse([toolDelta, finishChunk("tool_calls")]);
    const out = await readSSEMessage(res as unknown as Response);
    expect(out.tool_calls?.length).toBe(1);
    expect(out.tool_calls?.[0]?.function.name).toBe("read");
  });

  test("readSSEMessage: mid-stream cut without finish still throws", async () => {
    const res = streamResponse([contentChunk("partial")]);
    await expect(readSSEMessage(res as unknown as Response)).rejects.toThrow(
      "connection aborted before [DONE]",
    );
  });

  test("chatCompletion: one retry on mid-stream cut, then succeeds", async () => {
    const cut = streamResponse([contentChunk("cut-")]);
    const good = streamResponse([contentChunk("recovered"), finishChunk("stop"), "data: [DONE]\n\n"]);
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return (calls === 1 ? cut : good) as unknown as Response;
    }) as unknown as typeof fetch;
    const out = await chatCompletion("https://example.test/v1", "key", "m", baseHistory(), {
      sleep: async () => {},
    });
    expect(out.content).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("chatCompletion: repeat cut throws permanently (no retry loop)", async () => {
    const cut = () => streamResponse([contentChunk("cut-")]);
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return cut() as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(
      chatCompletion("https://example.test/v1", "key", "m", baseHistory(), {
        sleep: async () => {},
      }),
    ).rejects.toThrow("connection aborted before [DONE]");
    expect(calls).toBe(2);
  });
});
