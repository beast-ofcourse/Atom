// Session fork (ticket 07): forking at a message creates a brand-new session
// holding the original's history up to that point, cut at a turn boundary,
// with both branches evolving independently afterwards.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildCompactedHistory } from "../src/compact.js";
import {
  createSession,
  forkSession,
  getActiveSessionId,
  getSession,
  sessionsDir,
  updateSession,
  type SessionTurn,
} from "../src/sessions.js";

let dirs: string[] = [];

async function tmpHome(): Promise<string> {
  const { promises: fsp } = await import("node:fs");
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-fork-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  const { promises: fsp } = await import("node:fs");
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

function tmpFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(".tmp."));
}

function toolCall(id: string, name = "read"): {
  id: string;
  type: string;
  function: { name: string; arguments: string };
} {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

function assistantCallTurn(content: string): SessionTurn {
  return { role: "assistant", content, ...{ tool_calls: [toolCall("call_1")] } } as SessionTurn;
}

// Two full turns + one tool turn + one open turn:
// history idx: 0=sys 1=u1 2=a1 3=u2 4=a2tc 5=tool2 6=a2done 7=u3 8=a3
function twoTurnHistory(): { role: string; content?: string | null }[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    {
      role: "assistant",
      content: null,
      ...( { tool_calls: [toolCall("call_1")] } as object ),
    },
    { role: "tool", content: "out2", ...( { tool_call_id: "call_1" } as object ) },
    { role: "assistant", content: "a2done" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  ];
}

function twoTurnTurns(): SessionTurn[] {
  return [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    assistantCallTurn("calling read"),
    { role: "tool", content: "out2" },
    { role: "assistant", content: "a2done" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  ];
}

describe("forkSession basics", () => {
  test("fork at tip keeps full history/turns with fresh id + derived title", async () => {
    const home = await tmpHome();
    const source = createSession(
      {
        title: "quest",
        cwd: "/repo",
        provider: "anthropic",
        model: "m1",
        effort: "high",
        mode: "yolo",
        history: twoTurnHistory() as never,
        turns: twoTurnTurns(),
        usageTotals: { prompt_tokens: 5, total_tokens: 9 },
        goal: {
          objective: "ship it",
          active: true,
          stats: { turns: 2, requests: 3, tokens: 9, workMs: 10 },
        },
        metadata: { todos: [{ id: "t1" }], filediffs: { turns: [] }, ext: "x" },
        now: "2026-01-01T00:00:00.000Z",
      },
      home
    );
    const beforeBytes = readFileSync(
      path.join(sessionsDir(home), `${source.id}.json`),
      "utf8"
    );
    const forked = forkSession(source.id, undefined, home);
    expect(forked).not.toBeNull();
    expect(forked!.id).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(forked!.id).not.toBe(source.id);
    expect(forked!.title).toBe("quest (fork)");
    expect(forked!.history).toEqual(source.history);
    expect(forked!.turns).toEqual(source.turns);
    expect(forked!.goal).toEqual(source.goal);
    expect(forked!.metadata).toEqual(source.metadata);
    expect(forked!.provider).toBe(source.provider);
    expect(forked!.model).toBe(source.model);
    expect(forked!.effort).toBe(source.effort);
    expect(forked!.mode).toBe(source.mode);
    expect(forked!.cwd).toBe(source.cwd);
    // New branch accrues its own spend.
    expect(forked!.usageTotals).toBeNull();
    expect(forked!.createdAt).toBe(forked!.updatedAt);
    expect(Number.isNaN(Date.parse(forked!.createdAt))).toBe(false);
    // On disk, no tmp leftovers; fork round-trips.
    expect(tmpFiles(sessionsDir(home))).toEqual([]);
    expect(getSession(forked!.id, home)).toEqual(forked);
    // Original record byte-identical; active pointer untouched (still source).
    expect(
      readFileSync(path.join(sessionsDir(home), `${source.id}.json`), "utf8")
    ).toBe(beforeBytes);
    expect(getSession(source.id, home)).toEqual(source);
    expect(getActiveSessionId(home)).toBe(source.id);
  });

  test("missing/empty source returns null and never throws", async () => {
    const home = await tmpHome();
    expect(forkSession("ses_missingmissingmissingmissing00", undefined, home)).toBeNull();
    expect(forkSession("", undefined, home)).toBeNull();
  });

  test("NaN mark forks at the tip and never throws", async () => {
    const home = await tmpHome();
    const source = createSession(
      {
        title: "nan",
        history: twoTurnHistory() as never,
        turns: twoTurnTurns(),
      },
      home
    );
    const forked = forkSession(source.id, NaN, home);
    expect(forked!.history).toEqual(source.history);
    expect(forked!.turns).toEqual(source.turns);
  });
});

describe("fork cut lands on turn boundaries", () => {
  test("clean-boundary fork keeps history up to the message and nothing after", async () => {
    const home = await tmpHome();
    const source = createSession(
      {
        title: "cut",
        history: twoTurnHistory() as never,
        turns: twoTurnTurns(),
      },
      home
    );
    // Keep [sys,u1,a1]: cut right after the first committed turn.
    const forked = forkSession(source.id, 3, home);
    expect(forked!.history.map((m) => m.content)).toEqual(["sys", "u1", "a1"]);
    expect(forked!.turns.map((t) => t.content)).toEqual(["u1", "a1"]);
  });

  test("mid-turn cut request drops the whole open turn (pairing never splits)", async () => {
    const home = await tmpHome();
    const source = createSession(
      {
        title: "mid",
        history: twoTurnHistory() as never,
        turns: twoTurnTurns(),
      },
      home
    );
    // Mark 5 = right after the assistant tool_call, before its tool result.
    // The turn is uncommitted (no plain assistant yet) so the whole turn
    // containing the mark drops: [sys,u1,a1].
    const mid = forkSession(source.id, 5, home);
    expect(mid!.history.map((m) => m.content)).toEqual(["sys", "u1", "a1"]);
    expect(mid!.turns.map((t) => t.content)).toEqual(["u1", "a1"]);
    // No dangling tool_call without its result, no result without its call.
    const calls = mid!.history.filter(
      (m) =>
        m.role === "assistant" &&
        (m as { tool_calls?: unknown }).tool_calls !== undefined
    );
    expect(calls).toEqual([]);
    // Mark 6 = after the tool result but before the closing assistant text:
    // still uncommitted, same boundary.
    const afterTool = forkSession(source.id, 6, home);
    expect(afterTool!.history.map((m) => m.content)).toEqual(["sys", "u1", "a1"]);
    // Mark 7 = after the closing assistant text: the turn committed, kept whole.
    const committed = forkSession(source.id, 7, home);
    expect(committed!.history.map((m) => m.content)).toEqual([
      "sys",
      "u1",
      "a1",
      "u2",
      null,
      "out2",
      "a2done",
    ]);
    expect(committed!.turns.map((t) => t.content)).toEqual([
      "u1",
      "a1",
      "u2",
      "calling read",
      "out2",
      "a2done",
    ]);
  });
});

describe("branches evolve independently", () => {
  test("new turns in either branch never appear in the other", async () => {
    const home = await tmpHome();
    const source = createSession(
      {
        title: "branch",
        history: twoTurnHistory() as never,
        turns: twoTurnTurns(),
        metadata: { todos: [{ id: "shared" }] },
      },
      home
    );
    const forked = forkSession(source.id, undefined, home);
    expect(forked).not.toBeNull();
    // Append to both branches.
    updateSession(
      source.id,
      {
        history: [...source.history, { role: "user", content: "orig-next" }],
        turns: [...source.turns, { role: "user", content: "orig-next" }],
        metadata: { todos: [{ id: "orig-todo" }] },
      },
      home
    );
    updateSession(
      forked!.id,
      {
        history: [...forked!.history, { role: "user", content: "fork-next" }],
        turns: [...forked!.turns, { role: "user", content: "fork-next" }],
        metadata: { todos: [{ id: "fork-todo" }] },
      },
      home
    );
    const reOrig = getSession(source.id, home)!;
    const reFork = getSession(forked!.id, home)!;
    const origTexts = reOrig.history.map((m) =>
      typeof m.content === "string" ? m.content : null
    );
    const forkTexts = reFork.history.map((m) =>
      typeof m.content === "string" ? m.content : null
    );
    expect(origTexts).toContain("orig-next");
    expect(origTexts).not.toContain("fork-next");
    expect(forkTexts).toContain("fork-next");
    expect(forkTexts).not.toContain("orig-next");
    expect(reOrig.turns.map((t) => t.content)).toContain("orig-next");
    expect(reFork.turns.map((t) => t.content)).toContain("fork-next");
    // Metadata diverged too.
    expect(reOrig.metadata).toEqual({ todos: [{ id: "orig-todo" }] });
    expect(reFork.metadata).toEqual({ todos: [{ id: "fork-todo" }] });
  });
});

describe("fork of a compacted session", () => {
  test("carries a working summary and continues", async () => {
    const home = await tmpHome();
    const system = { role: "system", content: "sys" } as const;
    const tail = [
      { role: "user", content: "u9" },
      { role: "assistant", content: "a9" },
    ] as never[];
    const compacted = buildCompactedHistory(
      system as never,
      "## Objective\nKeep going",
      tail as never,
      2,
      "2026-09-12T00:00:00.000Z"
    );
    const source = createSession(
      {
        title: "compacted",
        history: compacted as never,
        turns: [
          { role: "user", content: "older (summarized)" },
          { role: "user", content: "u9" },
          { role: "assistant", content: "a9" },
        ],
      },
      home
    );
    const forked = forkSession(source.id, undefined, home);
    expect(forked).not.toBeNull();
    // The summary message rides along verbatim.
    expect(forked!.history[1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("[Compacted context"),
    });
    expect(forked!.history[1]).toMatchObject({
      content: expect.stringContaining("## Objective\nKeep going"),
    });
    expect(
      forked!.history.map((m) => (typeof m.content === "string" ? m.content : null))
    ).toContain("a9");
    // The branch continues: extend and re-read.
    updateSession(
      forked!.id,
      {
        history: [
          ...forked!.history,
          { role: "user", content: "u10" },
          { role: "assistant", content: "a10" },
        ],
        turns: [
          ...forked!.turns,
          { role: "user", content: "u10" },
          { role: "assistant", content: "a10" },
        ],
      },
      home
    );
    const reFork = getSession(forked!.id, home)!;
    expect(reFork.history[1]).toEqual(forked!.history[1]);
    const texts = reFork.history.map((m) =>
      typeof m.content === "string" ? m.content : null
    );
    expect(texts.slice(-2)).toEqual(["u10", "a10"]);
    // The original compacted session is untouched by the extension.
    expect(
      getSession(source.id, home)!.history.map((m) =>
        typeof m.content === "string" ? m.content : null
      )
    ).not.toContain("u10");
  });
});
