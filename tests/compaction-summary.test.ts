// Ticket 03: structured chained summary. Hermetic acceptance locks (no TUI,
// no network): the compaction instruction demands the five anchored sections,
// the manual round-trip preserves them with paths/identifiers verbatim, a
// three-link chain keeps the turn-1 goal and key decisions visible, and a
// conflicting old summary never overwrites newer conversation facts.
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../src/zen.js";
import {
  buildCompactedHistory,
  buildCompactionInstruction,
  buildSummaryMessages,
  fitSummaryWithFilesAndGoal,
  requestCompactSummary,
} from "../src/compact.js";

const SYS = { role: "system", content: "sys" } as ChatMessage;

function cannedSummary(): string {
  return [
    "## Objective",
    "Ship v2 of the auth flow.",
    "## Important Details",
    "Token refresh uses getToken() in src/auth/login.ts; retries capped at 3.",
    "## Work State",
    "### Completed",
    "- login form wired to POST /v2/session",
    "### Active",
    "- refresh-token rotation",
    "### Blocked",
    "- staging cert expired",
    "## Next Move",
    "Finish rotation, then re-run tests/smoke-auth.test.ts.",
    "## Relevant Files",
    "src/auth/login.ts, src/auth/refresh.ts, tests/smoke-auth.test.ts",
  ].join("\n");
}

// Mock the summary POST: capture the instruction sent to the model and answer
// with a canned summary. The canned text stands in for the model, which the
// instruction orders to merge prior summaries forward (newer wins conflicts).
function mockSummaryFetch(answer: string, seen: Array<Record<string, unknown>>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: answer } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function lastUserContent(post: Record<string, unknown>): string {
  const msgs = post["messages"] as Array<{ content: string }>;
  return String(msgs.at(-1)?.content ?? "");
}

describe("compaction instruction anchors all five sections (ticket 03.1)", () => {
  test("headings present with and without focus/goal hints", () => {
    for (const text of [
      buildCompactionInstruction(),
      buildCompactionInstruction("auth flow"),
      buildCompactionInstruction("auth flow", "Ship v2"),
    ]) {
      for (const h of [
        "## Objective",
        "## Important Details",
        "## Work State",
        "### Completed",
        "### Active",
        "### Blocked",
        "## Next Move",
        "## Relevant Files",
      ]) {
        expect(text).toContain(h);
      }
      expect(text).toContain("Preserve file paths and identifiers verbatim");
    }
  });

  test("manual round-trip keeps every section with paths/identifiers verbatim", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const restore = mockSummaryFetch(cannedSummary(), seen);
    try {
      const head: ChatMessage[] = [
        { role: "user", content: "wire login to POST /v2/session" } as ChatMessage,
        { role: "assistant", content: "done, see src/auth/login.ts" } as ChatMessage,
      ];
      const summary = await requestCompactSummary({
        provider: "opencode-zen",
        apiKey: "k",
        model: "m",
        systemContent: "sys",
        head,
      });
      expect(seen).toHaveLength(1);
      expect("tools" in seen[0]!).toBe(false);
      expect(lastUserContent(seen[0]!)).toContain("## Relevant Files");
      const fitted = fitSummaryWithFilesAndGoal(summary, { read: [], modified: [] }, "");
      const next = buildCompactedHistory(SYS, fitted.text, head.slice(-1), 1);
      const stored = String((next[1] as { content: string }).content);
      for (const section of [
        "## Objective",
        "## Important Details",
        "## Work State",
        "### Completed",
        "### Active",
        "### Blocked",
        "## Next Move",
        "## Relevant Files",
      ]) {
        expect(stored).toContain(section);
      }
      for (const id of [
        "src/auth/login.ts",
        "src/auth/refresh.ts",
        "tests/smoke-auth.test.ts",
        "getToken()",
        "/v2/session",
      ]) {
        expect(stored).toContain(id);
      }
    } finally {
      restore();
    }
  });
});

describe("three chained compactions keep the turn-1 goal (ticket 03.2)", () => {
  test("prior summary feeds forward; third summary still shows goal + decisions", async () => {
    const link = (goal: string, decision: string, extra: string): string =>
      [
        "## Objective",
        goal,
        "## Important Details",
        decision,
        "## Work State",
        "### Completed",
        extra,
        "### Active",
        "- keep going",
        "### Blocked",
        "- none",
        "## Next Move",
        "Continue.",
        "## Relevant Files",
        "src/auth/login.ts",
      ].join("\n");
    const s1 = link("Ship v2 of the auth flow.", "Use zod for validation.", "- turn-1 work");
    const s2 = link(
      "Ship v2 of the auth flow.",
      "Use zod for validation; rotation uses getToken().",
      "- turn-2 work"
    );
    const s3 = link(
      "Ship v2 of the auth flow.",
      "Use zod for validation; rotation uses getToken(); retries capped at 3.",
      "- turn-3 work"
    );

    // Link 1: turn-1 head compacts to s1.
    const seen: Array<Record<string, unknown>> = [];
    let restore = mockSummaryFetch(s1, seen);
    const head1: ChatMessage[] = [
      { role: "user", content: "goal: Ship v2 of the auth flow" } as ChatMessage,
      { role: "assistant", content: "Use zod for validation" } as ChatMessage,
    ];
    const out1 = await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "m",
      systemContent: "sys",
      head: head1,
    });
    restore();
    const h1 = buildCompactedHistory(
      SYS,
      fitSummaryWithFilesAndGoal(out1, { read: [], modified: [] }, "").text,
      [{ role: "user", content: "turn-2 work" } as ChatMessage],
      1,
      "2026-01-01T00:00:00.000Z"
    );

    // Link 2: the head opens with the prior summary; the instruction orders
    // the merge forward. Model answers s2; history compacts again.
    const head2 = [...h1.slice(1), { role: "assistant", content: "turn-2 done" } as ChatMessage];
    expect(String((head2[0] as { content: string }).content)).toContain("[Compacted context");
    expect(String((head2[0] as { content: string }).content)).toContain("Ship v2");
    const msgs2 = buildSummaryMessages("sys", head2);
    expect(lastUserContent({ messages: msgs2 })).toContain("Merge it forward");
    restore = mockSummaryFetch(s2, seen);
    const out2 = await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "m",
      systemContent: "sys",
      head: head2,
    });
    restore();
    const h2 = buildCompactedHistory(
      SYS,
      fitSummaryWithFilesAndGoal(out2, { read: [], modified: [] }, "").text,
      [{ role: "user", content: "turn-3 work" } as ChatMessage],
      2,
      "2026-01-02T00:00:00.000Z"
    );

    // Link 3: same feed-forward; the third stored summary still shows the
    // turn-1 goal and key decisions, and only one summary head remains.
    const head3 = [...h2.slice(1), { role: "assistant", content: "turn-3 done" } as ChatMessage];
    restore = mockSummaryFetch(s3, seen);
    const out3 = await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "m",
      systemContent: "sys",
      head: head3,
    });
    restore();
    const h3 = buildCompactedHistory(
      SYS,
      fitSummaryWithFilesAndGoal(out3, { read: [], modified: [] }, "").text,
      [{ role: "user", content: "turn-4 work" } as ChatMessage],
      3,
      "2026-01-03T00:00:00.000Z"
    );
    const stored = String((h3[1] as { content: string }).content);
    expect(stored).toContain("Ship v2 of the auth flow.");
    expect(stored).toContain("Use zod for validation");
    expect(stored).toContain("getToken()");
    expect(h3.filter((m) => String((m as { content: string }).content).includes("[Compacted context"))).toHaveLength(1);
  });
});

describe("stale summary never overwrites newer facts (ticket 03.4)", () => {
  test("instruction orders newer-wins; stored summary keeps not-X", async () => {
    const prior =
      "[Compacted context 2026-01-01T00:00:00.000Z: summary of 2 older turns]\n" +
      "## Objective\nShip v2.\n## Important Details\nEndpoint is /v1/session.\n";
    const head: ChatMessage[] = [
      { role: "user", content: prior } as ChatMessage,
      { role: "user", content: "correction: endpoint is /v2/session, /v1 is retired" } as ChatMessage,
      { role: "assistant", content: "wired to /v2/session" } as ChatMessage,
    ];
    const msgs = buildSummaryMessages("sys", head);
    // Both reach the summarizer in order (stale first, newer after) with the
    // newer-wins rule attached.
    const dumped = msgs.map((m) => String((m as { content: string }).content));
    expect(dumped[1]).toContain("/v1/session");
    expect(dumped[dumped.length - 2]).toContain("/v2/session");
    expect(dumped.at(-1)).toContain("the newer conversation wins");

    const seen: Array<Record<string, unknown>> = [];
    const restore = mockSummaryFetch(
      "## Objective\nShip v2.\n## Important Details\nEndpoint is /v2/session (/v1 retired).\n## Work State\n### Completed\n- wired /v2\n### Active\n- none\n### Blocked\n- none\n## Next Move\nShip.\n## Relevant Files\nsrc/auth/login.ts",
      seen
    );
    try {
      const summary = await requestCompactSummary({
        provider: "opencode-zen",
        apiKey: "k",
        model: "m",
        systemContent: "sys",
        head,
      });
      const next = buildCompactedHistory(
        SYS,
        fitSummaryWithFilesAndGoal(summary, { read: [], modified: [] }, "").text,
        [{ role: "user", content: "ship it" } as ChatMessage],
        2
      );
      const stored = String((next[1] as { content: string }).content);
      expect(stored).toContain("/v2/session");
      expect(stored).not.toContain("Endpoint is /v1/session.");
      // The stale head summary is consumed (replaced), never duplicated.
      expect(next.filter((m) => String((m as { content: string }).content).includes("[Compacted context"))).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
