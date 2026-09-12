// Ticket 03: structured chained summary. Hermetic proofs only (mocked fetch,
// never live): the anchored template, three-link chaining that keeps the
// turn-1 goal visible, and the newer-wins conflict rule. Goal/checklist
// survival lives in tests/goal-compaction.test.ts (extended there).
import { describe, expect, test, vi, afterEach } from "vitest";
import type { ChatMessage } from "../src/zen.js";
import {
  COMPACT_SUMMARY_MAX_TOKENS,
  buildCompactedHistory,
  buildCompactionInstruction,
  buildSummaryMessages,
  collectTouchedFiles,
  fitSummaryWithFiles,
  requestCompactSummary,
  splitHistoryForCompaction,
} from "../src/compact.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const ANCHORED = [
  "Objective",
  "Important Details",
  "Work State",
  "Completed",
  "Active",
  "Blocked",
  "Next Move",
  "Relevant Files",
];

// Scripted summarizer queue: records every POST body, replies with the queued
// summaries in order (last repeats). Tools stay disabled by construction —
// requestCompactSummary never sends a `tools` key.
function mockSummaryQueue(replies: string[]) {
  const posts: Array<Record<string, unknown>> = [];
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: next } }] }),
    } as unknown as Response;
  });
  return posts;
}

function lastInstruction(post: Record<string, unknown>): string {
  const msgs = post["messages"] as Array<{ content: string }>;
  return String(msgs.at(-1)?.content ?? "");
}

describe("anchored template (criterion 1)", () => {
  test("manual compaction instruction carries all five anchored sections", () => {
    const text = buildCompactionInstruction();
    for (const h of ANCHORED) expect(text).toContain(h);
  });

  test("summary POST is tools-disabled, capped, and preserves file paths", async () => {
    const summary =
      "## Objective\nShip v2\n## Relevant Files\nsrc/alpha.ts, src/beta.ts";
    const posts = mockSummaryQueue([summary]);
    const head: ChatMessage[] = [
      { role: "user", content: "wire up the parser" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c0", type: "function", function: { name: "read", arguments: '{"path":"src/alpha.ts"}' } },
          { id: "c1", type: "function", function: { name: "edit", arguments: '{"path":"src/beta.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c0", content: "alpha" },
      { role: "tool", tool_call_id: "c1", content: "edited" },
      { role: "assistant", content: "done" },
    ];
    const text = await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "m",
      systemContent: "sys",
      head,
    });
    expect(text).toBe(summary);
    expect(posts).toHaveLength(1);
    expect("tools" in posts[0]!).toBe(false);
    expect(posts[0]!["max_tokens"]).toBe(COMPACT_SUMMARY_MAX_TOKENS);
    for (const h of ANCHORED) expect(lastInstruction(posts[0]!)).toContain(h);
    // File paths/identifiers survive the post-POST fitting into the stored
    // summary message (the downstream contract).
    const fitted = fitSummaryWithFiles(text, collectTouchedFiles(head));
    const next = buildCompactedHistory(
      { role: "system", content: "sys" },
      fitted.text,
      [{ role: "user", content: "q-new" }],
      1,
      "2026-01-01T00:00:00.000Z"
    );
    const stored = String((next[1] as { content: string }).content);
    expect(stored).toContain("src/alpha.ts");
    expect(stored).toContain("src/beta.ts");
    expect(stored).toContain("## Objective");
  });
});

describe("chained compactions keep the original goal (criterion 2)", () => {
  test("three links carry the turn-1 goal and key decisions into the third summary", async () => {
    const s1 =
      "## Objective\nShip v2\n## Important Details\nDECISION: use postgres\n## Work State\n### Active\nparser\n## Next Move\ntests\n## Relevant Files\nsrc/alpha.ts";
    const s2 =
      "## Objective\nShip v2\n## Important Details\nDECISION: use postgres; added retry\n## Work State\n### Active\ntests\n## Next Move\nship\n## Relevant Files\nsrc/alpha.ts, src/beta.ts";
    const s3 =
      "## Objective\nShip v2\n## Important Details\nDECISION: use postgres; added retry; dark mode\n## Work State\n### Active\nship\n## Next Move\nrelease\n## Relevant Files\nsrc/alpha.ts, src/beta.ts, src/gamma.ts";
    const posts = mockSummaryQueue([s1, s2, s3]);

    // Link 1: two turns of fresh conversation.
    let history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "goal: Ship v2 with postgres" },
      { role: "assistant", content: "on it" },
      { role: "user", content: "add the parser" },
      { role: "assistant", content: "parsed" },
    ];
    const compactOnce = async (newTurns: ChatMessage[]): Promise<void> => {
      const split = splitHistoryForCompaction(history);
      expect(split.head.length).toBeGreaterThan(0);
      const summary = await requestCompactSummary({
        provider: "opencode-zen",
        apiKey: "k",
        model: "m",
        systemContent: "sys",
        head: split.head,
      });
      history = [
        ...buildCompactedHistory(
          history[0]!,
          summary,
          split.tail,
          split.olderTurnCount,
          "2026-01-01T00:00:00.000Z"
        ),
        ...newTurns,
      ];
    };

    await compactOnce([
      { role: "user", content: "add retry" },
      { role: "assistant", content: "retried" },
    ]);
    await compactOnce([
      { role: "user", content: "add dark mode" },
      { role: "assistant", content: "themed" },
    ]);
    // Link 2 input carried the first summary forward.
    expect(JSON.stringify((posts[1]!["messages"] as unknown[]).slice(0, -1))).toContain(
      "Ship v2"
    );
    await compactOnce([]);

    // The third summary still shows the turn-1 goal and key decisions.
    // Link 3 input carried the merged second summary forward.
    expect(JSON.stringify((posts[2]!["messages"] as unknown[]).slice(0, -1))).toContain(
      "Ship v2"
    );
    const summaries = history
      .filter((m) => m?.role === "user" && typeof m.content === "string")
      .map((m) => String((m as { content: string }).content));
    expect(summaries.some((c) => c.includes(s3))).toBe(true);
    const latest = summaries.find((c) => c.includes(s3))!;
    expect(latest).toContain("Ship v2");
    expect(latest).toContain("DECISION: use postgres");
    // Every link used the same anchored shape via the no-tools POST.
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      expect("tools" in p).toBe(false);
      for (const h of ANCHORED) expect(lastInstruction(p)).toContain(h);
      expect(lastInstruction(p)).toContain("[Compacted context");
    }
  });
});

describe("newer conversation wins conflicts (criterion 4)", () => {
  test("instruction states the conflict rule and prior summary precedes newer turns", async () => {
    expect(buildCompactionInstruction()).toContain("newer conversation wins");
    const posts = mockSummaryQueue(["## Objective\nnew\n## Next Move\ngo"]);
    const head: ChatMessage[] = [
      {
        role: "user",
        content: "[Compacted context 2026-01-01T00:00:00.000Z: summary of 1 older turns]\n## Objective\nold\nDECISION: use sqlite",
      },
      { role: "user", content: "switch the DB to postgres" },
      { role: "assistant", content: "switched" },
    ];
    await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "m",
      systemContent: "sys",
      head,
    });
    const msgs = posts[0]!["messages"] as Array<{ content: unknown }>;
    const dumped = msgs.map((m) => String(m.content));
    // Recency order is preserved for the summarizer: stale summary first,
    // newer facts after, instruction last.
    expect(dumped.findIndex((c) => c.includes("use sqlite"))).toBeGreaterThan(0);
    expect(dumped.findIndex((c) => c.includes("postgres"))).toBeGreaterThan(
      dumped.findIndex((c) => c.includes("use sqlite"))
    );
    expect(dumped.at(-1)).toContain("newer conversation wins");
  });

  test("stale summary fact does not survive when newer turns contradict it", async () => {
    // A compliant summarizer follows the instruction: newer wins, so the
    // stored summary reflects postgres and drops sqlite.
    const fresh =
      "## Objective\nShip v2\n## Important Details\nDECISION: use postgres\n## Work State\n### Active\nmigrate\n## Next Move\nship\n## Relevant Files\nsrc/db.ts";
    const posts = mockSummaryQueue([fresh]);
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: "[Compacted context 2026-01-01T00:00:00.000Z: summary of 1 older turns]\n## Important Details\nDECISION: use sqlite",
      },
      { role: "user", content: "switch the DB to postgres" },
      { role: "assistant", content: "switched" },
      { role: "user", content: "migrate the data" },
      { role: "assistant", content: "migrated" },
    ];
    const split = splitHistoryForCompaction(history);
    const summary = await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "m",
      systemContent: "sys",
      head: split.head,
    });
    expect(posts).toHaveLength(1);
    const next = buildCompactedHistory(
      history[0]!,
      summary,
      split.tail,
      split.olderTurnCount,
      "2026-01-01T00:00:00.000Z"
    );
    const stored = String((next[1] as { content: string }).content);
    expect(stored).toContain("use postgres");
    expect(stored).not.toContain("use sqlite");
  });
});

describe("builders keep the downstream contract", () => {
  test("summary messages stay system + head + instruction", () => {
    const msgs = buildSummaryMessages(
      "sys",
      [{ role: "user", content: "q" }],
      "focus",
      "Ship v2"
    );
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(String(msgs.at(-1)?.content)).toContain("Ship v2");
    expect(String(msgs.at(-1)?.content)).toContain("focus");
  });
});
