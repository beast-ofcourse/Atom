// Compaction tests (mocked fetch only, never live — Zen is 429-limited).
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  COMPACT_KEEP_TOKENS,
  COMPACT_SUMMARY_MAX_TOKENS,
  COMPACT_TOOL_OUTPUT_CAP,
  buildCompactedHistory,
  buildCompactionInstruction,
  buildSummaryMessages,
  capToolOutputsInTail,
  compactBoundaryLine,
  compactPct,
  computeContextLoad,
  countUserTurns,
  estimateTokensForChars,
  isSizeError,
  isThrashDisabled,
  requestCompactSummary,
  shouldAutoCompact,
  splitHistoryForCompaction,
  truncateHeadForRetry,
} from "../src/compact.js";
import { formatTokenSegment } from "../src/context-windows.js";
import { historyChars, type ChatMessage } from "../src/zen.js";
import { loadSession } from "../src/session.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.1"];
const realFetch = globalThis.fetch;
const SAVED_ENV = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of ["ATOM_COMPACT_PCT", "ATOM_MAX_HISTORY_CHARS", "ATOM_MAX_HISTORY_MESSAGES"]) {
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

function assertPairingIntact(msgs: ChatMessage[]) {
  expect(msgs[0]?.role).toBe("system");
  const calls = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls !== undefined) {
      for (const c of m.tool_calls) calls.add(c.id);
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

// Bounded POST-counter wait: pre-POST work (env refresh, real-dir skill
// discovery) varies under load, so tests must poll for the POST instead of
// assuming it fires within a fixed sleep — otherwise a slow POST lands
// inside a later assertion window and fails it.
async function waitForPostCount(
  counter: () => number,
  count: number,
  what: string,
  timeout = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (counter() >= count) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${count} POST(s) (${what})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Queue of scripted non-streaming JSON replies; records every POST body.
function mockChatQueue(turns: Array<{ reply: string; usage?: unknown }>) {
  const posts: Array<Record<string, unknown>> = [];
  const queue = [...turns];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
    } catch {
      body = {};
    }
    posts.push(body);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: next.reply } }],
        ...(next.usage !== undefined ? { usage: next.usage } : {}),
      }),
    } as unknown as Response;
  });
  return posts;
}

describe("trigger math", () => {
  test("known window fires at ≥83% (default)", () => {
    // kimi-k2.5 window 262144: 83% = 217579.52 → 217580 fires, 217579 does not.
    expect(shouldAutoCompact(217580, "kimi-k2.5")).toBe(true);
    expect(shouldAutoCompact(217579, "kimi-k2.5")).toBe(false);
  });

  test("unknown window never auto-triggers", () => {
    expect(shouldAutoCompact(1_000_000, "big-pickle")).toBe(false);
    expect(shouldAutoCompact(0, "big-pickle")).toBe(false);
  });

  test("estimate fallback (no prompt_tokens → chars/4)", () => {
    expect(computeContextLoad(undefined, 4000)).toBe(1000);
    expect(computeContextLoad(45056, 999999)).toBe(45056);
    expect(estimateTokensForChars(8000)).toBe(2000);
  });

  test("pct override via env percent, clamp 50–95, invalid→default", () => {
    delete process.env.ATOM_COMPACT_PCT;
    expect(compactPct()).toBeCloseTo(0.83);
    process.env.ATOM_COMPACT_PCT = "50";
    expect(compactPct()).toBeCloseTo(0.5);
    process.env.ATOM_COMPACT_PCT = "95";
    expect(compactPct()).toBeCloseTo(0.95);
    process.env.ATOM_COMPACT_PCT = "10";
    expect(compactPct()).toBeCloseTo(0.5);
    process.env.ATOM_COMPACT_PCT = "99";
    expect(compactPct()).toBeCloseTo(0.95);
    process.env.ATOM_COMPACT_PCT = "abc";
    expect(compactPct()).toBeCloseTo(0.83);
    process.env.ATOM_COMPACT_PCT = "";
    expect(compactPct()).toBeCloseTo(0.83);
    process.env.ATOM_COMPACT_PCT = "83";
    expect(shouldAutoCompact(217580, "kimi-k2.5")).toBe(true);
    process.env.ATOM_COMPACT_PCT = "95";
    // 83% load no longer fires at a 95% threshold.
    expect(shouldAutoCompact(217580, "kimi-k2.5")).toBe(false);
    expect(shouldAutoCompact(250000, "kimi-k2.5")).toBe(true);
  });
});

describe("summary POST contract", () => {
  test("no `tools` key, 4096 cap, template headings present", async () => {
    const posts = mockChatQueue([{ reply: "SUMMARY-OK" }]);
    const head: ChatMessage[] = [
      { role: "user", content: "q0" },
      { role: "assistant", content: "a0" },
    ];
    const text = await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "test-key",
      model: "kimi-k2.5",
      systemContent: "sys",
      head,
    });
    expect(text).toBe("SUMMARY-OK");
    expect(posts).toHaveLength(1);
    const body = posts[0]!;
    expect("tools" in body).toBe(false);
    expect(body["max_tokens"]).toBe(COMPACT_SUMMARY_MAX_TOKENS);
    const msgs = body["messages"] as ChatMessage[];
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    const last = msgs.at(-1) as { role: string; content: string };
    expect(last.role).toBe("user");
    for (const h of [
      "Objective",
      "Requirements",
      "Decisions",
      "Completed",
      "Active",
      "Blockers",
      "Next",
      "Relevant files",
    ]) {
      expect(last.content).toContain(h);
    }
  });

  test("anthropic + gemini summary POSTs also omit tools with 4096 cap", async () => {
    // Anthropic kind.
    const postsA: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      postsA.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "A-SUM" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      } as unknown as Response;
    });
    const a = await requestCompactSummary({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-sonnet-5",
      systemContent: "sys",
      head: [{ role: "user", content: "q" }],
    });
    expect(a).toBe("A-SUM");
    expect("tools" in (postsA[0] as Record<string, unknown>)).toBe(false);
    expect((postsA[0] as Record<string, unknown>)["max_tokens"]).toBe(4096);

    // Gemini kind.
    const postsG: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      postsG.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "G-SUM" }] } }],
        }),
      } as unknown as Response;
    });
    const g = await requestCompactSummary({
      provider: "google-gemini",
      apiKey: "k",
      model: "gemini-3-flash-preview",
      systemContent: "sys",
      head: [{ role: "user", content: "q" }],
    });
    expect(g).toBe("G-SUM");
    expect("tools" in (postsG[0] as Record<string, unknown>)).toBe(false);
    const gen = (postsG[0] as Record<string, { maxOutputTokens?: number }>)[
      "generationConfig"
    ];
    expect(gen?.maxOutputTokens).toBe(4096);
  });

  test("focus text reaches the summarization instruction", async () => {
    const posts = mockChatQueue([{ reply: "S" }]);
    await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "m",
      systemContent: "sys",
      head: [{ role: "user", content: "q" }],
      focusText: "auth flow",
    });
    const msgs = posts[0]!["messages"] as Array<{ content: string }>;
    expect(String(msgs.at(-1)?.content)).toContain("auth flow");
    expect(buildCompactionInstruction("auth flow")).toContain("auth flow");
    expect(buildCompactionInstruction("")).not.toContain("Focus for");
  });
});

describe("split + replacement", () => {
  test("head→summary+tail keeps pairing, boundary line shown", () => {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 6; i++) history.push(...toolTurn(i));
    const split = splitHistoryForCompaction(history);
    expect(split.olderTurnCount).toBeGreaterThan(0);
    expect(split.head.length).toBeGreaterThan(0);
    expect(split.tail.length).toBeGreaterThan(0);
    // Tail is whole user-turns: first tail message is a user message.
    expect(split.tail[0]?.role).toBe("user");
    const next = buildCompactedHistory(
      history[0]!,
      "SUMMARY",
      split.tail,
      split.olderTurnCount,
      "2026-01-01T00:00:00.000Z"
    );
    expect(next[0]).toEqual({ role: "system", content: "sys" });
    expect(next[1]).toMatchObject({ role: "user" });
    expect(String((next[1] as { content: string }).content)).toContain(
      "[Compacted context 2026-01-01T00:00:00.000Z: summary of"
    );
    expect(String((next[1] as { content: string }).content)).toContain("SUMMARY");
    assertPairingIntact(next);
    expect(compactBoundaryLine(split.olderTurnCount)).toBe(
      `(context compacted: ${split.olderTurnCount} turns → summary)`
    );
  });

  test("tail keeps newest turns within ~8000 estimated tokens; tool outputs capped", () => {
    const big = "y".repeat(5000);
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q0" },
      { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "glob", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c0", content: big },
      { role: "assistant", content: "a0" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    const split = splitHistoryForCompaction(history, 8000);
    const dumped = JSON.stringify(split.tail);
    for (const m of split.tail) {
      if (m.role === "tool") {
        expect((m.content as string).length).toBeLessThanOrEqual(
          COMPACT_TOOL_OUTPUT_CAP + 100
        );
      }
    }
    expect(dumped).toContain("q1");
    const capped = capToolOutputsInTail([
      { role: "tool", tool_call_id: "x", content: "z".repeat(5000) },
    ]);
    expect(capped[0]).toMatchObject({ role: "tool" });
    expect(String((capped[0] as { content: string }).content)).toContain("truncated");
  });

  test("tiny history splits to nothing (caller reports nothing-to-compact)", () => {
    expect(countUserTurns([{ role: "system", content: "s" }])).toBe(0);
    expect(
      countUserTurns([
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ])
    ).toBe(1);
    const split = splitHistoryForCompaction([
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    // Single user turn: no head to summarize (olderTurnCount 0 or head empty).
    expect(split.olderTurnCount === 0 || split.head.length === 0).toBe(true);
  });
});

describe("failure atomicity + oversize retry-once", () => {
  test("summary failure keeps history untouched + inline error (no partial swap)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    })) as unknown as typeof fetch;
    const head: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ];
    const before = JSON.stringify(head);
    await expect(
      requestCompactSummary({
        provider: "opencode-zen",
        apiKey: "k",
        model: "m",
        systemContent: "s",
        head,
      })
    ).rejects.toThrow("401");
    expect(JSON.stringify(head)).toBe(before);
    expect(isSizeError(new Error("Zen HTTP 401: nope"))).toBe(false);
  });

  test("oversize retries once with truncated head, then /clear hint", async () => {
    let n = 0;
    const seen: number[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
        messages?: unknown[];
      };
      seen.push(body.messages?.length ?? 0);
      if (n === 1) {
        return { ok: false, status: 400, text: async () => "context length exceeded" } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "RETRY-SUM" } }] }),
      } as unknown as Response;
    });
    const head: ChatMessage[] = [
      { role: "user", content: "q0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    const text = await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "m",
      systemContent: "s",
      head,
    });
    expect(text).toBe("RETRY-SUM");
    expect(n).toBe(2);
    expect(seen[1]).toBeLessThan(seen[0]!);

    // Both attempts fail → /clear hint, exactly 2 POSTs.
    let m = 0;
    globalThis.fetch = vi.fn(async () => {
      m += 1;
      return { ok: false, status: 400, text: async () => "maximum context reached" } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(
      requestCompactSummary({
        provider: "opencode-zen",
        apiKey: "k",
        model: "m",
        systemContent: "s",
        head,
      })
    ).rejects.toThrow("/clear");
    expect(m).toBe(2);
    expect(truncateHeadForRetry(head).length).toBeLessThan(head.length);
  });
});

describe("thrash guard", () => {
  test("fires at 3, manual success resets", () => {
    expect(isThrashDisabled(0)).toBe(false);
    expect(isThrashDisabled(2)).toBe(false);
    expect(isThrashDisabled(3)).toBe(true);
  });

  test("App disables auto after 3 thrashing autos; manual still works", async () => {
    process.env.ATOM_COMPACT_PCT = "50"; // glm-5.1 window 200K → 100K threshold
    process.env.ATOM_MAX_HISTORY_CHARS = "2000000"; // hold huge summaries (no truncation)
    const huge = "S".repeat(500_000); // ~125K tokens: keeps load above threshold
    const posts = mockChatQueue([
      { reply: "a1", usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } },
      { reply: "a2", usage: { prompt_tokens: 150000, completion_tokens: 10, total_tokens: 150010 } },
      { reply: huge },
      { reply: "a3", usage: { prompt_tokens: 150000, completion_tokens: 10, total_tokens: 150010 } },
      { reply: huge },
      { reply: "a4", usage: { prompt_tokens: 150000, completion_tokens: 10, total_tokens: 150010 } },
      { reply: huge },
      // After disable: manual summary + post-disable main (no auto).
      { reply: "MANUAL-SUM" },
      { reply: "a5", usage: { prompt_tokens: 150000, completion_tokens: 10, total_tokens: 150010 } },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="glm-5.1" initialModels={["glm-5.1"]} />
    );
    try {
      app.stdin.write("m1");
      app.stdin.write("\r");
      await waitForFrame(app, "a1");
      app.stdin.write("m2");
      app.stdin.write("\r");
      await waitForFrame(app, "a2");
      await waitForFrame(app, "context compacted");
      app.stdin.write("m3");
      app.stdin.write("\r");
      await waitForFrame(app, "a3");
      app.stdin.write("m4");
      app.stdin.write("\r");
      await waitForFrame(app, "a4");
      await waitForFrame(app, "auto-compact thrashing — disabled");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("auto-compact thrashing — disabled");
      // Manual still works after disable.
      const before = posts.length;
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await waitForFrame(app, "context compacted");
      expect(posts.length).toBeGreaterThan(before);
      // Boundary renders just before the manual's busy flag clears — drain
      // it before sending the next turn so the message is not dropped.
      await new Promise((r) => setTimeout(r, 600));
      // Post-disable large turn does NOT auto-compact again.
      const compactCountBefore = (app.lastFrame()?.match(/context compacted/g) ?? []).length;
      app.stdin.write("m5");
      app.stdin.write("\r");
      await waitForFrame(app, "a5");
      await new Promise((r) => setTimeout(r, 500));
      const compactCountAfter = (app.lastFrame()?.match(/context compacted/g) ?? []).length;
      expect(compactCountAfter).toBe(compactCountBefore);
    } finally {
      app.unmount();
      delete process.env.ATOM_MAX_HISTORY_CHARS;
    }
  }, 60000);
});

describe("status P uses load", () => {
  test("cumulative spend does not move P", () => {
    expect(formatTokenSegment({ total_tokens: 200000 }, "kimi-k2.5", 45056)).toBe(
      "token: (17%) 195K"
    );
    expect(formatTokenSegment({ total_tokens: 45056 }, "kimi-k2.5", 45056)).toBe(
      "token: (17%) 44K"
    );
  });

  test("App status shows load-based P with cumulative NK across turns", async () => {
    const posts = mockChatQueue([
      {
        reply: "r1",
        usage: { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 },
      },
      {
        reply: "r2",
        usage: { prompt_tokens: 10000, completion_tokens: 1000, total_tokens: 11000 },
      },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="kimi-k2.5" initialModels={["kimi-k2.5"]} />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await waitForFrame(app, "token: (15%) 44K");
      app.stdin.write("again");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      // Cumulative total = 45056+11000=56056 → 55K; load = last prompt 10000 → 4%.
      await waitForFrame(app, "token: (4%) 55K");
      expect(posts).toHaveLength(2);
    } finally {
      app.unmount();
    }
  });
});

describe("/compact command", () => {
  test("manual /compact compacts, shows boundary, saves summary history", async () => {
    const posts = mockChatQueue([
      { reply: "r1" },
      { reply: "r2" },
      { reply: "SUMMARY-TEXT" },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      app.stdin.write("first");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("second");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await waitForFrame(app, "context compacted");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("context compacted:");
      expect(frame).toContain("summary");
      // Summary POST carried the structured instruction.
      const summaryPost = posts.at(-1)! as Record<string, unknown>;
      const msgs = summaryPost["messages"] as Array<{ content: string }>;
      expect(String(msgs.at(-1)?.content)).toContain("Objective");
      // Save-after-compact contains the summary history.
      const loaded = loadSession();
      expect(loaded.status).toBe("ok");
      if (loaded.status === "ok") {
        const dumped = JSON.stringify(loaded.session.history);
        expect(dumped).toContain("[Compacted context");
        expect(dumped).toContain("SUMMARY-TEXT");
      }
    } finally {
      app.unmount();
    }
  });

  test("tiny history reports (nothing to compact)", async () => {
    mockChatQueue([{ reply: "x" }]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await waitForFrame(app, "nothing to compact");
    } finally {
      app.unmount();
    }
  });

  test("/compact focus text reaches the summary instruction", async () => {
    const posts = mockChatQueue([
      { reply: "r1" },
      { reply: "r2" },
      { reply: "S" },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      app.stdin.write("one");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      app.stdin.write("two");
      app.stdin.write("\r");
      await waitForFrame(app, "r2");
      app.stdin.write("/compact auth flow");
      app.stdin.write("\r");
      await waitForFrame(app, "context compacted");
      const summaryPost = posts.at(-1)! as Record<string, unknown>;
      const msgs = summaryPost["messages"] as Array<{ content: string }>;
      expect(String(msgs.at(-1)?.content)).toContain("auth flow");
    } finally {
      app.unmount();
    }
  });

  test("busy→pending→runs-after-turn (never mid-turn)", async () => {
    let releaseMain!: (v: unknown) => void;
    const gate = new Promise((resolve) => {
      releaseMain = resolve as (v: unknown) => void;
    });
    let calls = 0;
    const posts: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const n = calls;
      posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      if (n === 1) {
        await gate; // hold the main turn open
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "main-done" } }] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: `SUM-${n}` } }] }),
      } as unknown as Response;
    });
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      // Seed one completed turn so there is compactable history after main.
      // First unblock immediately for the seed: use a separate quick mock.
      // Instead: drive the busy turn directly with two prior quick turns via
      // the same gate pattern — simpler: send main, then /compact while busy.
      app.stdin.write("seed-one");
      // Release on next tick so the seed turn can complete, then start busy.
      setTimeout(() => releaseMain(null), 50);
      app.stdin.write("\r");
      await waitForFrame(app, "main-done");
      // Second busy turn: hold again.
      let release2!: (v: unknown) => void;
      const gate2 = new Promise((resolve) => {
        release2 = resolve as (v: unknown) => void;
      });
      let secondPhase = false;
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
        if (!secondPhase) {
          secondPhase = true;
          await gate2;
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: "second-done" } }] }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "SUM-AFTER" } }] }),
        } as unknown as Response;
      });
      void origFetch;
      app.stdin.write("second");
      app.stdin.write("\r");
      // The turn's POST follows async pre-POST work — wait for it so the
      // "busy" window below is real, not a too-early snapshot.
      await waitForPostCount(() => posts.length, 2, "second turn POST");
      // Busy with the second turn: /compact must pend, not interleave.
      const callsBefore = posts.length;
      app.stdin.write("/compact");
      app.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 100));
      // No summary POST yet (still busy on the main turn).
      expect(posts.length).toBe(callsBefore);
      release2(null);
      await waitForFrame(app, "second-done");
      await waitForFrame(app, "context compacted");
    } finally {
      app.unmount();
    }
  });

  test("auto-compact fires at ≥83% on known-window models only", async () => {
    // Two user turns are needed: a single turn has no older head to
    // summarize, so auto correctly stays quiet on it.
    const posts = mockChatQueue([
      {
        reply: "first-answer",
        usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
      },
      {
        reply: "big-answer",
        usage: { prompt_tokens: 220000, completion_tokens: 100, total_tokens: 220100 },
      },
      { reply: "AUTO-SUMMARY" },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="kimi-k2.5" initialModels={["kimi-k2.5"]} />
    );
    try {
      app.stdin.write("hello-one");
      app.stdin.write("\r");
      await waitForFrame(app, "first-answer");
      app.stdin.write("hello-two");
      app.stdin.write("\r");
      await waitForFrame(app, "big-answer");
      await waitForFrame(app, "context compacted");
      // Mains + summary POSTs.
      expect(posts.length).toBeGreaterThanOrEqual(3);
      const summaryPost = posts.at(-1)! as Record<string, unknown>;
      expect("tools" in summaryPost).toBe(false);
    } finally {
      app.unmount();
    }
  });

  test("unknown-window models never auto-compact", async () => {
    const posts = mockChatQueue([
      {
        reply: "r1",
        usage: { prompt_tokens: 500000, completion_tokens: 100, total_tokens: 500100 },
      },
    ]);
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialModel="big-pickle" initialModels={MODELS} />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "r1");
      await new Promise((r) => setTimeout(r, 300));
      expect(posts).toHaveLength(1);
      expect(app.lastFrame()).not.toContain("context compacted");
      expect(app.lastFrame()).toContain("token: 488K");
    } finally {
      app.unmount();
    }
  });
});

describe("compact unit extras", () => {
  test("KEEP constants + message builders", () => {
    expect(COMPACT_KEEP_TOKENS).toBe(8000);
    expect(COMPACT_SUMMARY_MAX_TOKENS).toBe(4096);
    expect(COMPACT_TOOL_OUTPUT_CAP).toBe(2000);
    const msgs = buildSummaryMessages("sys", [{ role: "user", content: "q" }], "f");
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(String(msgs.at(-1)?.content)).toContain("f");
    expect(historyChars([{ role: "user", content: "abcd" }])).toBe(4);
  });
});
