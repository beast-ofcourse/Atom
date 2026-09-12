// Session revert (ticket 08): session-scoped composition of the existing
// machinery — conversationCutIndex turn-boundary cut (shared with /rewind
// and forkSession) + hash-verified file restore + atomic session persist.
// Proves: conversation AND files restore, failed reverts are byte-identical,
// other sessions/forks are untouched, and the no-snapshot case is graceful.
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { revertSessionToCheckpoint } from "../src/session-revert.js";
import {
  createSession,
  forkSession,
  getActiveSessionId,
  getSession,
  sessionFilePath,
  sessionsDir,
  updateSession,
  type SessionTurn,
} from "../src/sessions.js";
import type { ChatMessage } from "../src/zen.js";
import {
  clearSnapshots,
  getCheckpoint,
  registerHistoryProbe,
} from "../src/snapshots.js";
import { writeTool } from "../src/tools.js";

let dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const { promises: fsp } = await import("node:fs");
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  clearSnapshots();
  registerHistoryProbe(null);
});

afterEach(async () => {
  const { promises: fsp } = await import("node:fs");
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
  clearSnapshots();
  registerHistoryProbe(null);
});

function oneTurnHistory(): ChatMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ];
}

function oneTurnTurns(): SessionTurn[] {
  return [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ];
}

function sessionBytes(id: string, home: string): string {
  return readFileSync(path.join(sessionsDir(home), `${id}.json`), "utf8");
}

// A "good point" checkpoint: file holds v-good, marks pin the one-turn
// conversation (history 3, turns 2). Afterwards the caller adds the bad
// turn (file change + appended messages) and reverts to the returned id.
async function checkpointGoodPoint(
  sessionId: string,
  cwd: string,
  home: string
): Promise<string> {
  void sessionId;
  void home;
  await writeTool({ path: "notes.txt", content: "v-good" }, cwd);
  registerHistoryProbe(() => ({ history: 3, turns: 2 }));
  try {
    await writeTool({ path: "notes.txt", content: "v-bad" }, cwd);
  } finally {
    registerHistoryProbe(null);
  }
  const { listCheckpoints } = await import("../src/snapshots.js");
  const cps = listCheckpoints();
  const cp = cps[cps.length - 1]!;
  expect(cp.historyLength).toBe(3);
  expect(cp.turnsLength).toBe(2);
  return cp.id;
}

async function appendBadTurn(sessionId: string, home: string): Promise<void> {
  const s = getSession(sessionId, home)!;
  const next = updateSession(
    sessionId,
    {
      history: [
        ...s.history,
        { role: "user", content: "u2-bad" },
        { role: "assistant", content: "a2-bad" },
      ],
      turns: [
        ...s.turns,
        { role: "user", content: "u2-bad" },
        { role: "assistant", content: "a2-bad" },
      ],
    },
    home
  );
  expect(next).not.toBeNull();
  expect(next!.history).toHaveLength(5);
}

describe("revert restores conversation and files", () => {
  test("prior turn returns: history cut at the turn boundary, bytes restored", async () => {
    const home = await tmpDir("atom-revert-home-");
    const cwd = await tmpDir("atom-revert-cwd-");
    const s = createSession(
      {
        title: "quest",
        history: oneTurnHistory(),
        turns: oneTurnTurns(),
      },
      home
    );
    const cpId = await checkpointGoodPoint(s.id, cwd, home);
    await appendBadTurn(s.id, home);

    const result = await revertSessionToCheckpoint(s.id, cpId, home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toContain('reverted "quest"');
    expect(result.message).toContain("dropped 2 message(s)");
    expect(result.message).toContain("restored 1 file(s)");
    expect(result.message).toMatch(/never snapshotted/);

    // Conversation: back to the one committed turn, pairing intact.
    expect(result.session.history.map((m) => m.content)).toEqual(["sys", "u1", "a1"]);
    expect(result.session.turns.map((t) => t.content)).toEqual(["u1", "a1"]);
    expect(getSession(s.id, home)).toEqual(result.session);
    // Files: byte-exact prior content.
    const { promises: fsp } = await import("node:fs");
    expect(await fsp.readFile(path.join(cwd, "notes.txt"), "utf8")).toBe("v-good");
    // No tmp leftovers from the persist.
    const { existsSync, readdirSync } = await import("node:fs");
    expect(existsSync(sessionsDir(home))).toBe(true);
    expect(readdirSync(sessionsDir(home)).filter((f) => f.includes(".tmp."))).toEqual([]);
  });
});

describe("failed revert is byte-identical", () => {
  test("corrupt snapshot: clear error, session file + disk exactly as before", async () => {
    const home = await tmpDir("atom-revert-fail-home-");
    const cwd = await tmpDir("atom-revert-fail-cwd-");
    const s = createSession(
      {
        title: "fragile",
        history: oneTurnHistory(),
        turns: oneTurnTurns(),
      },
      home
    );
    const cpId = await checkpointGoodPoint(s.id, cwd, home);
    await appendBadTurn(s.id, home);

    // Corrupt the live snapshot bytes: the pre-write hash check must fail.
    const live = getCheckpoint(cpId)!;
    expect(live).toBeDefined();
    live.files[0]!.bytes = Buffer.from("tampered-by-test");

    const beforeBytes = sessionBytes(s.id, home);
    const beforeRecord = getSession(s.id, home)!;
    const { promises: fsp } = await import("node:fs");
    const beforeDisk = await fsp.readFile(path.join(cwd, "notes.txt"), "utf8");
    expect(beforeDisk).toBe("v-bad");

    const result = await revertSessionToCheckpoint(s.id, cpId, home);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^Error: rewind failed/);
    expect(result.error).toMatch(/exactly as it was/);

    expect(sessionBytes(s.id, home)).toBe(beforeBytes);
    expect(getSession(s.id, home)).toEqual(beforeRecord);
    expect(await fsp.readFile(path.join(cwd, "notes.txt"), "utf8")).toBe(beforeDisk);
  });
});

describe("revert never touches other sessions or forks", () => {
  test("sibling session and forked branch stay byte-identical", async () => {
    const home = await tmpDir("atom-revert-iso-home-");
    const cwd = await tmpDir("atom-revert-iso-cwd-");
    const a = createSession(
      {
        title: "main",
        history: oneTurnHistory(),
        turns: oneTurnTurns(),
      },
      home
    );
    const b = createSession(
      {
        title: "sibling",
        history: oneTurnHistory(),
        turns: oneTurnTurns(),
      },
      home
    );
    const cpId = await checkpointGoodPoint(a.id, cwd, home);
    const forked = forkSession(a.id, undefined, home);
    expect(forked).not.toBeNull();

    const bBytes = sessionBytes(b.id, home);
    const bRecord = getSession(b.id, home)!;
    const fBytes = sessionBytes(forked!.id, home);
    const fRecord = getSession(forked!.id, home)!;
    const activeBefore = getActiveSessionId(home);

    await appendBadTurn(a.id, home);
    const result = await revertSessionToCheckpoint(a.id, cpId, home);
    expect(result.ok).toBe(true);

    expect(sessionBytes(b.id, home)).toBe(bBytes);
    expect(getSession(b.id, home)).toEqual(bRecord);
    expect(sessionBytes(forked!.id, home)).toBe(fBytes);
    expect(getSession(forked!.id, home)).toEqual(fRecord);
    expect(getActiveSessionId(home)).toBe(activeBefore);
    // And the target itself did revert.
    expect(getSession(a.id, home)!.history).toHaveLength(3);
  });
});

describe("no-snapshot case", () => {
  test("graceful guidance, zero data loss", async () => {
    const home = await tmpDir("atom-revert-empty-home-");
    const s = createSession(
      {
        title: "fresh",
        history: oneTurnHistory(),
        turns: oneTurnTurns(),
      },
      home
    );
    const beforeBytes = sessionBytes(s.id, home);
    const beforeRecord = getSession(s.id, home)!;

    const result = await revertSessionToCheckpoint(s.id, "no-such-checkpoint", home);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no snapshots recorded/);
    expect(result.error).toMatch(/nothing was changed/);

    expect(sessionBytes(s.id, home)).toBe(beforeBytes);
    expect(getSession(s.id, home)).toEqual(beforeRecord);
  });

  test("unknown session id is an error, never a throw", async () => {
    const home = await tmpDir("atom-revert-unknown-home-");
    const result = await revertSessionToCheckpoint(
      "ses_missingmissingmissingmissing00",
      "also-missing",
      home
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unknown session/);
  });
});
