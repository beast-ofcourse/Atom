// Ticket 08: compaction carries the goal. Hermetic proofs only (no TUI —
// several compact App suites are red/flaky at baseline): pure builder
// round-trips, loop-level post-compact continuation with mocked chat, and a
// save/load round-trip proving a compacted session resumes its goal from the
// record without re-exploring. Network is never touched.
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLoopWithChat,
  type ChatMessage,
  type ChatResult,
} from "../src/zen.js";
import {
  appendGoalBlock,
  formatGoalForCompact,
  goalFollowUp,
  restoreGoalFromPersist,
  serializeGoalForPersist,
} from "../src/goal.js";
import {
  buildCompactedHistory,
  buildCompactionInstruction,
  buildSummaryMessages,
  collectTouchedFiles,
  fitSummaryWithFiles,
  fitSummaryWithFilesAndGoal,
  requestCompactSummary,
} from "../src/compact.js";
import { loadSession, saveSession } from "../src/session.js";

const savedEnv = { ...process.env };
let homes: string[] = [];

async function tempHome(): Promise<string> {
  for (const k of [
    "OPENCODE_ZEN_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ]) {
    delete process.env[k];
  }
  const home = await mkdtemp(join(tmpdir(), "atom-goal-compact-"));
  homes.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

afterEach(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

// Live-goal double mirroring the App wiring (getGoal reads live state,
// counters accumulate incrementally) — same shape as the ticket-02 suite.
function liveGoal(objective = "Ship v2") {
  const state = {
    active: true,
    cleared: false,
    turns: 0,
    requests: 0,
  };
  return {
    state,
    hook: {
      getGoal: () => (state.cleared ? null : { objective, active: state.active }),
      pauseGoal: () => {
        state.active = false;
      },
      onGoalRequest: () => {
        state.requests += 1;
        if (state.requests === 2) state.cleared = true;
      },
      onGoalTurn: () => {
        state.turns += 1;
      },
    },
  };
}

describe("goal block format (pure)", () => {
  test("no goal renders empty (caller appends nothing)", () => {
    expect(formatGoalForCompact(null)).toBe("");
    expect(appendGoalBlock("SUM", "")).toBe("SUM");
  });

  test("block carries objective, state, and cumulative stats", () => {
    const text = formatGoalForCompact({
      objective: "Ship v2",
      active: true,
      stats: { turns: 3, requests: 12, tokens: 4500, workMs: 83000 },
    });
    expect(text).toContain('Goal: "Ship v2"');
    expect(text).toContain("[active]");
    expect(text).toContain("turns 3");
    expect(text).toContain("requests 12");
    expect(text).toContain("tokens 4.5K");
    expect(text).toContain("work 1m23s");
    expect(appendGoalBlock("SUMMARY", text)).toBe(`SUMMARY\n\n${text}`);
  });

  test("paused state reads paused; missing stats read as zeros", () => {
    const text = formatGoalForCompact({ objective: "Ship v2", active: false });
    expect(text).toContain("[paused]");
    expect(text).toContain("turns 0");
  });

  test("open checklist rides along; completed items stay in the prose", () => {
    const text = formatGoalForCompact(
      { objective: "Ship v2", active: true },
      [
        { content: "write the parser", status: "in_progress" },
        { content: "add tests", status: "pending" },
        { content: "done earlier", status: "completed" },
      ]
    );
    expect(text).toContain("[in_progress] write the parser");
    expect(text).toContain("[pending] add tests");
    expect(text).not.toContain("done earlier");
  });

  test("checklist tail is bounded (count and line length)", () => {
    const todos = Array.from({ length: 12 }, (_, i) => ({
      content: `item-${i}-${"x".repeat(200)}`,
      status: "pending",
    }));
    const text = formatGoalForCompact({ objective: "Ship v2", active: true }, todos);
    expect(text).toContain("item-9");
    expect(text).not.toContain("item-10");
    // Items share one `Goal todos:` line, so bound each segment (not the
    // line): every item is truncated to its cap plus its status mark.
    const todosLine = text.split("\n").find((l) => l.startsWith("Goal todos: "))!;
    const segments = todosLine.slice("Goal todos: ".length).split("; ");
    expect(segments).toHaveLength(10);
    for (const seg of segments) {
      expect(seg.length).toBeLessThan(160);
    }
  });
});

describe("compaction instruction carries the goal hint", () => {
  test("absent goal keeps the instruction byte-identical", () => {
    expect(buildCompactionInstruction()).toBe(buildCompactionInstruction(undefined, undefined));
    expect(buildCompactionInstruction("auth flow")).toBe(
      buildCompactionInstruction("auth flow", undefined)
    );
    expect(buildCompactionInstruction("", "")).toBe(buildCompactionInstruction(""));
    expect(buildCompactionInstruction()).not.toContain("Session goal to preserve");
  });

  test("live goal objective reaches the summarizer prompt", () => {
    const text = buildCompactionInstruction("", "Ship v2");
    expect(text).toContain('Session goal to preserve: "Ship v2"');
    // Template headings unchanged — the hint is prose, not a new section.
    for (const h of ["Objective", "Work State", "Next Move", "Relevant Files"]) {
      expect(text).toContain(h);
    }
    const msgs = buildSummaryMessages("sys", [{ role: "user", content: "q" }], "", "Ship v2");
    expect(String(msgs.at(-1)?.content)).toContain("Ship v2");
  });

  test("summary POST threads the goal hint with tools still disabled", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "S" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const text = await requestCompactSummary({
        provider: "opencode-zen",
        apiKey: "k",
        model: "m",
        systemContent: "sys",
        head: [{ role: "user", content: "q" }],
        goalObjective: "Ship v2",
      });
      expect(text).toBe("S");
      expect(posts).toHaveLength(1);
      expect("tools" in posts[0]!).toBe(false);
      const msgs = posts[0]!["messages"] as Array<{ content: string }>;
      expect(String(msgs.at(-1)?.content)).toContain("Ship v2");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("summary fitting with goal block", () => {  const touched = { read: ["r1.ts", "r2.ts"], modified: ["m1.ts"] };

  test("empty goal block degrades exactly to the files fitter", () => {
    expect(fitSummaryWithFilesAndGoal("SUMMARY", touched, "")).toEqual(
      fitSummaryWithFiles("SUMMARY", touched)
    );
    expect(fitSummaryWithFilesAndGoal("SUMMARY", touched, "", 40)).toEqual(
      fitSummaryWithFiles("SUMMARY", touched, 40)
    );
  });

  test("goal block lands between summary and files, all verbatim", () => {
    const goalBlock = formatGoalForCompact({
      objective: "Ship v2",
      active: true,
      stats: { turns: 3, requests: 12, tokens: 4500, workMs: 83000 },
    });
    const fitted = fitSummaryWithFilesAndGoal("SUMMARY", touched, goalBlock, 10_000);
    expect(fitted.truncated).toBe(false);
    expect(fitted.text).toContain("SUMMARY");
    expect(fitted.text).toContain('Goal: "Ship v2"');
    expect(fitted.text).toContain("Touched files:");
    // Order: summary, then goal, then files last (the files extractor's
    // lastIndexOf still finds the appended block).
    expect(fitted.text.indexOf('Goal: "Ship v2"')).toBeGreaterThan(
      fitted.text.indexOf("SUMMARY")
    );
    expect(fitted.text.indexOf("Touched files:")).toBeGreaterThan(
      fitted.text.indexOf('Goal: "Ship v2"')
    );
  });

  test("over budget shrinks only the file lists — summary and goal survive", () => {
    const goalBlock = formatGoalForCompact({ objective: "Ship v2", active: true });
    const base = `SUMMARY\n\n${goalBlock}`;
    // Budget fits the summary+goal base but not the files block: lists
    // shrink, the base survives byte-identical.
    const tight = fitSummaryWithFilesAndGoal("SUMMARY", touched, goalBlock, base.length + 10);
    expect(tight.truncated).toBe(true);
    expect(tight.text.startsWith(base)).toBe(true);
    expect(tight.text.length).toBeLessThanOrEqual(base.length + 10);
    expect(tight.text).toContain('Goal: "Ship v2"');
    // A base already over budget is still kept whole (never fails, never
    // cut — the same rule as fitSummaryWithFiles).
    const huge = fitSummaryWithFilesAndGoal("SUMMARY", touched, goalBlock, 10);
    expect(huge.text).toBe(base);
  });

  test("compacted history carries the goal block into the summary message", () => {
    const goalBlock = formatGoalForCompact({
      objective: "Ship v2",
      active: true,
      stats: { turns: 2, requests: 5, tokens: 2500, workMs: 61000 },
    });
    const fitted = fitSummaryWithFilesAndGoal("MODEL-SUMMARY", { read: [], modified: [] }, goalBlock);
    const next = buildCompactedHistory(
      { role: "system", content: "sys" },
      fitted.text,
      [{ role: "user", content: "q1" }],
      2,
      "2026-01-01T00:00:00.000Z"
    );
    expect(String((next[1] as { content: string }).content)).toContain('Goal: "Ship v2"');
    expect(String((next[1] as { content: string }).content)).toContain("[active]");
    expect(String((next[1] as { content: string }).content)).toContain("turns 2");
  });
});

describe("post-compact turns continue the same goal (loop level)", () => {
  test("compacted history plus live goal auto-continues with stats intact", async () => {
    const g = liveGoal("Ship v2");
    const goalBlock = formatGoalForCompact({
      objective: "Ship v2",
      active: true,
      stats: { turns: 2, requests: 5, tokens: 2500, workMs: 61000 },
    });
    const fitted = fitSummaryWithFilesAndGoal("MODEL-SUMMARY", { read: [], modified: [] }, goalBlock);
    // Post-compact state: the history swap already happened (summary+tail),
    // while goalRef survived in memory — the loop reads it live per POST.
    const history: ChatMessage[] = buildCompactedHistory(
      { role: "system", content: "s" },
      fitted.text,
      [{ role: "user", content: "go" }],
      2,
      "2026-01-01T00:00:00.000Z"
    );
    let posts = 0;
    const reply = await runLoopWithChat(
      async (): Promise<ChatResult> => {
        posts += 1;
        return { content: posts === 1 ? "first" : "second" };
      },
      history,
      { execute: async () => "tool-result", goal: g.hook }
    );
    expect(reply).toBe("second");
    expect(posts).toBe(2);
    expect(g.state.turns).toBe(2);
    expect(g.state.requests).toBe(2);
    // The compacted goal block survived the turn, and continuation used the
    // standard follow-up seam — no synthetic user input beyond it.
    const dumped = history.map((m) => String((m as { content?: unknown }).content ?? ""));
    expect(dumped.some((c) => c.includes('Goal: "Ship v2"'))).toBe(true);
    expect(dumped.some((c) => c.includes(goalFollowUp("Ship v2")))).toBe(true);
  });
});

describe("compacted session resumes its goal from the record (no re-explore)", () => {
  test("save/load round-trip with compacted history restores text, flag, stats", async () => {
    const home = await tempHome();
    const goal = {
      objective: "Ship v2",
      active: true,
      stats: { turns: 2, requests: 5, tokens: 2500, workMs: 61000 },
    };
    const goalBlock = formatGoalForCompact(goal);
    const fitted = fitSummaryWithFilesAndGoal(
      "MODEL-SUMMARY",
      { read: ["src/alpha.ts"], modified: [] },
      goalBlock
    );
    const history = buildCompactedHistory(
      { role: "system", content: "sys" },
      fitted.text,
      [{ role: "user", content: "q1" }],
      2,
      "2026-01-01T00:00:00.000Z"
    );
    // doCompact persists through the normal save path (persistSession carries
    // goalRef.current) — this is exactly what that save holds.
    saveSession(
      {
        provider: "opencode-zen",
        model: "big-pickle",
        effort: "auto",
        mode: "normal",
        usageTotals: null,
        goal,
        history: history as ChatMessage[],
        turns: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
        ],
      },
      home
    );
    const loaded = loadSession(home);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    // Record restore (ticket 07) brings the goal back verbatim — the summary
    // block is the model's context backstop only, so no summary extractor is
    // needed on any resume path (doResume + session switch both restore from
    // the record first).
    expect(restoreGoalFromPersist(JSON.parse(JSON.stringify(serializeGoalForPersist(loaded.session.goal))))).toEqual(
      goal
    );
    expect(loaded.session.goal).toEqual(goal);
    // History round-trips through JSON escaping, so assert on the message
    // content directly (not the dumped string).
    const summaryMsg = loaded.session.history[1] as { content: string };
    expect(summaryMsg.content).toContain("MODEL-SUMMARY");
    expect(summaryMsg.content).toContain('Goal: "Ship v2"');
    expect(summaryMsg.content).toContain("Touched files:");
    expect(summaryMsg.content).toContain("src/alpha.ts");
    // Untouched head tools still collect (proves the block composes with the
    // files precedent rather than replacing it).
    expect(collectTouchedFiles(history as ChatMessage[])).toEqual({
      read: [],
      modified: [],
    });
  });
});
