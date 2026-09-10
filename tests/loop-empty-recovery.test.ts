// Empty-response recovery + data-silence bound tests.
// Loop level: silent POSTs spend bounded repair budget instead of aborting.
// Transport level: queue comments carry no model output and must not extend
// the stall budget. Mocked only, never live.
import { afterEach, describe, expect, test } from "vitest";
import { clearTodos } from "../src/tools.js";
import { readAnthropicSSEMessage } from "../src/adapters.js";
import {
  emptyResponseFollowUp,
  isEmptyReplyError,
  MAX_EMPTY_ROUNDS,
  readSSEMessage,
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
  type LoopStats,
} from "../src/zen.js";

const SAVED_STALL = process.env.ATOM_STALL_TIMEOUT_MS;

afterEach(() => {
  clearTodos();
  if (SAVED_STALL === undefined) delete process.env.ATOM_STALL_TIMEOUT_MS;
  else process.env.ATOM_STALL_TIMEOUT_MS = SAVED_STALL;
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "go" },
  ];
}

const EMPTY_ERROR = "Empty reply from model (unexpected payload).";

describe("empty-response helpers", () => {
  test("budget is 2; matcher is prefix-exact; nudge names the attempt", () => {
    expect(MAX_EMPTY_ROUNDS).toBe(2);
    expect(isEmptyReplyError(new Error(EMPTY_ERROR))).toBe(true);
    expect(isEmptyReplyError(new Error("Empty reply (custom suffix)"))).toBe(true);
    expect(isEmptyReplyError(new Error("boom"))).toBe(false);
    expect(isEmptyReplyError("Empty reply")).toBe(false);
    expect(emptyResponseFollowUp(1)).toContain("attempt 1");
    expect(emptyResponseFollowUp(2)).toContain("silence");
  });
});

describe("loop recovery from silent POSTs", () => {
  test("two empties then an answer deliver the answer with repair pairs", async () => {
    let n = 0;
    const warnings: string[] = [];
    const history = baseHistory();
    let stats: LoopStats | null = null;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        n += 1;
        if (n <= 2) throw new Error(EMPTY_ERROR);
        return { content: "recovered" };
      },
      history,
      {
        execute: async () => {
          throw new Error("must not execute");
        },
        onWarning: (m) => void warnings.push(m),
        onLoopStats: (s) => {
          stats = s;
        },
        sleep: async () => {},
      }
    );
    expect(reply).toBe("recovered");
    expect(n).toBe(3);
    // Two repair pairs (assistant silence + user nudge), pairing intact.
    const roles = history.map((m) => m.role);
    expect(roles).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(history)).toContain("empty response");
    expect(warnings).toEqual([]);
    expect((stats as unknown as LoopStats).failures).toBe(2);
  });

  test("persistent silence throws after the budget (caller rolls back)", async () => {
    let n = 0;
    const history = baseHistory();
    await expect(
      runLoopWithChat(
        async (): Promise<ChatResult> => {
          n += 1;
          throw new Error(EMPTY_ERROR);
        },
        history,
        { execute: async () => "x", sleep: async () => {} }
      )
    ).rejects.toThrow(EMPTY_ERROR);
    expect(n).toBe(1 + MAX_EMPTY_ROUNDS);
  });

  test("non-empty failures still throw immediately (single attempt)", async () => {
    let n = 0;
    await expect(
      runLoopWithChat(
        async (): Promise<ChatResult> => {
          n += 1;
          throw new Error("boom");
        },
        baseHistory(),
        { execute: async () => "x", sleep: async () => {} }
      )
    ).rejects.toThrow("boom");
    expect(n).toBe(1);
  });

  test("cancellation wins over empty recovery", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runLoopWithChat(
        async (): Promise<ChatResult> => {
          throw new Error(EMPTY_ERROR);
        },
        baseHistory(),
        { execute: async () => "x", sleep: async () => {}, signal: ctrl.signal }
      )
    ).rejects.toThrow("(cancelled)");
  });
});

function commentTrickleBody(gapMs: number): unknown {
  return {
    getReader: () => {
      let alive = true;
      return {
        read: async () => {
          if (!alive) return { done: true as const, value: undefined };
          await new Promise((r) => setTimeout(r, gapMs));
          return { done: false as const, value: ": KILO PROCESSING\n\n" };
        },
        cancel: () => {
          alive = false;
        },
        releaseLock: () => {},
      };
    },
  };
}

describe("data-silence bound (comments are not progress)", () => {
  test("zen: comment-only stream fails fast with a no-output stall error", async () => {
    process.env.ATOM_STALL_TIMEOUT_MS = "80";
    const res = { body: commentTrickleBody(20) } as unknown as Response;
    const t0 = Date.now();
    const err = await readSSEMessage(res).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith("Truncated stream")).toBe(true);
    expect((err as Error).message).toContain("no output");
  });

  test("adapters: comment-only stream fails fast too", async () => {
    process.env.ATOM_STALL_TIMEOUT_MS = "80";
    const res = { body: commentTrickleBody(20) } as unknown as Response;
    const t0 = Date.now();
    const err = await readAnthropicSSEMessage(res).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith("Truncated stream")).toBe(true);
    expect((err as Error).message).toContain("no output");
  });

  test("slow-but-real data lines never trip the bound", async () => {
    process.env.ATOM_STALL_TIMEOUT_MS = "500";
    const chunks = [
      'data: {"choices":[{"delta":{"content":"slow"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" but alive"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    let i = 0;
    const res = {
      body: {
        getReader: () => ({
          read: async () => {
            await new Promise((r) => setTimeout(r, 120));
            return i < chunks.length
              ? { done: false as const, value: chunks[i++]! }
              : { done: true as const, value: undefined };
          },
          releaseLock: () => {},
        }),
      },
    } as unknown as Response;
    const out = await readSSEMessage(res);
    expect(out.content).toBe("slow but alive");
  });
});
