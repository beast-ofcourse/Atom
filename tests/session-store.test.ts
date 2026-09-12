// Multi-session store: durable per-session files + active pointer.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createSession,
  deleteSession,
  ensureActiveSession,
  formatSessionTitle,
  getActiveSession,
  getActiveSessionId,
  getSession,
  listSessions,
  loadSession,
  renameSession,
  saveSession,
  setActiveSession,
  sessionsDir,
  touchSession,
  updateSession,
} from "../src/sessions.js";

let dirs: string[] = [];

async function tmpHome(): Promise<string> {
  const { promises: fsp } = await import("node:fs");
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-sessions-"));
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

describe("formatSessionTitle", () => {
  test("exact local format for a fixed date", () => {
    // Month is 0-indexed: 8 = September.
    const d = new Date(2026, 8, 9, 20, 41, 32);
    expect(formatSessionTitle(d)).toBe("September 9, 2026 20:41:32");
  });

  test("zero-pads time, not day", () => {
    const d = new Date(2026, 0, 5, 4, 7, 9);
    expect(formatSessionTitle(d)).toBe("January 5, 2026 04:07:09");
  });

  test("defaults to now and matches the shape", () => {
    expect(formatSessionTitle()).toMatch(
      /^[A-Z][a-z]+ \d{1,2}, \d{4} \d{2}:\d{2}:\d{2}$/
    );
  });
});

describe("createSession / getSession", () => {
  test("defaults, id shape, and immediate persistence", async () => {
    const home = await tmpHome();
    const s = createSession({}, home);
    expect(s.id).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(s.title).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4} \d{2}:\d{2}:\d{2}$/);
    expect(s.createdAt).toBe(s.updatedAt);
    expect(Number.isNaN(Date.parse(s.createdAt))).toBe(false);
    expect(s.provider).toBe("opencode-zen");
    expect(s.model).toBe("");
    expect(s.effort).toBe("auto");
    expect(s.mode).toBe("normal");
    expect(s.history).toEqual([]);
    expect(s.turns).toEqual([]);
    expect(s.usageTotals).toBeNull();
    expect(s.metadata).toEqual({});
    // On disk, no tmp leftovers.
    expect(existsSync(path.join(sessionsDir(home), `${s.id}.json`))).toBe(true);
    expect(tmpFiles(sessionsDir(home))).toEqual([]);
    // Round-trips through a fresh read (restart-safe).
    expect(getSession(s.id, home)).toEqual(s);
  });

  test("honors opts and trims the title", async () => {
    const home = await tmpHome();
    const s = createSession(
      {
        id: "ses_custom00000000000000000000001",
        title: "  hello  ",
        cwd: "/repo",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        effort: "high",
        mode: "yolo",
        history: [{ role: "user", content: "hi" }],
        turns: [{ role: "user", content: "hi" }],
        usageTotals: { prompt_tokens: 3 },
        metadata: { k: 1 },
        now: new Date("2026-03-04T05:06:07.000Z"),
      },
      home
    );
    expect(s.id).toBe("ses_custom00000000000000000000001");
    expect(s.title).toBe("hello");
    expect(s.createdAt).toBe("2026-03-04T05:06:07.000Z");
    expect(s.cwd).toBe("/repo");
    expect(s.usageTotals).toEqual({ prompt_tokens: 3 });
    expect(getSession(s.id, home)).toEqual(s);
  });

  test("missing id returns null and never throws", async () => {
    const home = await tmpHome();
    expect(getSession("ses_nope", home)).toBeNull();
    expect(getSession("", home)).toBeNull();
  });

  test("first create becomes active; later creates do not steal it", async () => {
    const home = await tmpHome();
    const a = createSession({ title: "a" }, home);
    const b = createSession({ title: "b" }, home);
    expect(getActiveSessionId(home)).toBe(a.id);
    expect(getActiveSession(home)).toEqual(a);
    expect(b.id).not.toBe(a.id);
  });
});

describe("listSessions", () => {
  test("sorted by updatedAt desc, empty dir yields []", async () => {
    const home = await tmpHome();
    expect(listSessions(home)).toEqual([]);
    const a = createSession(
      { id: "ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now: "2026-01-01T00:00:00.000Z" },
      home
    );
    const b = createSession(
      { id: "ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", now: "2026-02-01T00:00:00.000Z" },
      home
    );
    // b is newer.
    expect(listSessions(home).map((s) => s.id)).toEqual([b.id, a.id]);
  });

  test("tie-breaks: createdAt desc, then id asc", async () => {
    const home = await tmpHome();
    createSession(
      { id: "ses_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", now: "2026-01-01T00:00:00.000Z" },
      home
    );
    createSession(
      { id: "ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now: "2026-01-01T00:00:00.000Z" },
      home
    );
    // Same createdAt+updatedAt -> id asc.
    expect(listSessions(home).map((s) => s.id)).toEqual([
      "ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "ses_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ]);
    // Same updatedAt, different createdAt -> createdAt desc first.
    updateSession("ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      updatedAt: "2026-06-01T00:00:00.000Z",
    }, home);
    updateSession("ses_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", {
      updatedAt: "2026-06-01T00:00:00.000Z",
    }, home);
    // createdAt equal here too, so still id asc — force divergence instead:
    const c = createSession(
      { id: "ses_mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm", now: "2026-03-01T00:00:00.000Z" },
      home
    );
    updateSession(c.id, { updatedAt: "2026-06-01T00:00:00.000Z" }, home);
    const listed = listSessions(home);
    // All three share updatedAt; newest createdAt (c, March) sorts first.
    expect(listed[0]!.id).toBe(c.id);
  });

  test("skips corrupt files and never throws", async () => {
    const home = await tmpHome();
    const good = createSession({ title: "good" }, home);
    writeFileSync(
      path.join(sessionsDir(home), "ses_badbadbadbadbadbadbadbadbadbad.json"),
      "{ not json",
      "utf8"
    );
    writeFileSync(
      path.join(sessionsDir(home), "ses_wrongwrongwrongwrongwrongwrong00.json"),
      JSON.stringify({ id: "x" }),
      "utf8"
    );
    const listed = listSessions(home);
    expect(listed.map((s) => s.id)).toEqual([good.id]);
    expect(
      getSession("ses_badbadbadbadbadbadbadbadbadbad", home)
    ).toBeNull();
  });
});

describe("updateSession", () => {
  test("patches fields, bumps updatedAt, keeps id/createdAt", async () => {
    const home = await tmpHome();
    const s = createSession({ now: "2026-01-01T00:00:00.000Z" }, home);
    const next = updateSession(
      s.id,
      { model: "m1", turns: [{ role: "user", content: "x" }] },
      home
    );
    expect(next).not.toBeNull();
    expect(next!.model).toBe("m1");
    expect(next!.turns).toEqual([{ role: "user", content: "x" }]);
    expect(next!.id).toBe(s.id);
    expect(next!.createdAt).toBe(s.createdAt);
    expect(Date.parse(next!.updatedAt) >= Date.parse(s.updatedAt)).toBe(true);
    expect(getSession(s.id, home)).toEqual(next);
  });

  test("explicit updatedAt in patch is honored, not bumped", async () => {
    const home = await tmpHome();
    const s = createSession({}, home);
    const next = updateSession(s.id, { updatedAt: "2020-01-01T00:00:00.000Z" }, home);
    expect(next!.updatedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  test("id/createdAt in patch are ignored; missing returns null", async () => {
    const home = await tmpHome();
    const s = createSession({ now: "2026-01-01T00:00:00.000Z" }, home);
    const next = updateSession(
      s.id,
      { id: "ses_other", createdAt: "2000-01-01T00:00:00.000Z", title: "t" } as never,
      home
    );
    expect(next!.id).toBe(s.id);
    expect(next!.createdAt).toBe(s.createdAt);
    expect(updateSession("ses_missing", { title: "t" }, home)).toBeNull();
  });
});

describe("renameSession", () => {
  test("trims, bumps updatedAt, leaves history/turns/createdAt alone", async () => {
    const home = await tmpHome();
    const history = [{ role: "user" as const, content: "hi" }];
    const turns = [{ role: "user" as const, content: "hi" }];
    const s = createSession({ title: "old", history, turns }, home);
    const renamed = renameSession(s.id, "  new name  ", home);
    expect(renamed).not.toBeNull();
    expect(renamed!.title).toBe("new name");
    expect(renamed!.id).toBe(s.id);
    expect(renamed!.createdAt).toBe(s.createdAt);
    expect(renamed!.history).toEqual(history);
    expect(renamed!.turns).toEqual(turns);
    expect(getSession(s.id, home)!.title).toBe("new name");
  });

  test("rejects empty/whitespace and missing sessions", async () => {
    const home = await tmpHome();
    const s = createSession({ title: "keep" }, home);
    expect(renameSession(s.id, "   ", home)).toBeNull();
    expect(renameSession(s.id, "", home)).toBeNull();
    expect(getSession(s.id, home)!.title).toBe("keep");
    expect(renameSession("ses_missing", "x", home)).toBeNull();
  });
});

describe("deleteSession", () => {
  test("removes the file; false when missing", async () => {
    const home = await tmpHome();
    const s = createSession({ title: "gone" }, home);
    expect(deleteSession(s.id, home)).toBe(true);
    expect(getSession(s.id, home)).toBeNull();
    expect(deleteSession(s.id, home)).toBe(false);
    expect(deleteSession("", home)).toBe(false);
  });

  test("clears active only when it pointed at the deleted id", async () => {
    const home = await tmpHome();
    const a = createSession({ title: "a" }, home);
    const b = createSession({ title: "b" }, home);
    expect(getActiveSessionId(home)).toBe(a.id);
    expect(deleteSession(b.id, home)).toBe(true);
    expect(getActiveSessionId(home)).toBe(a.id);
    expect(deleteSession(a.id, home)).toBe(true);
    expect(getActiveSessionId(home)).toBeNull();
  });
});

describe("saveSession", () => {
  test("overwrites fields but preserves disk id/createdAt and bumps updatedAt", async () => {
    const home = await tmpHome();
    const s = createSession(
      { title: "v1", model: "m0", now: "2026-01-01T00:00:00.000Z" },
      home
    );
    const saved = saveSession(
      {
        ...s,
        createdAt: "2000-01-01T00:00:00.000Z",
        title: "v2",
        model: "m1",
      },
      home
    );
    expect(saved.id).toBe(s.id);
    expect(saved.createdAt).toBe(s.createdAt);
    expect(saved.title).toBe("v2");
    expect(saved.model).toBe("m1");
    expect(Date.parse(saved.updatedAt) >= Date.parse(s.updatedAt)).toBe(true);
    expect(getSession(s.id, home)).toEqual(saved);
  });

  test("save of a brand-new id persists it (nothing on disk to preserve)", async () => {
    const home = await tmpHome();
    const s = createSession({ title: "seed", now: "2026-01-01T00:00:00.000Z" }, home);
    const fresh = saveSession(
      { ...s, id: "ses_brandnewbrandnewbrandnewbrando", title: "new" },
      home
    );
    expect(fresh.id).toBe("ses_brandnewbrandnewbrandnewbrando");
    expect(getSession(fresh.id, home)).toEqual(fresh);
    // The seed record is untouched.
    expect(getSession(s.id, home)!.title).toBe("seed");
  });
});

describe("active pointer", () => {
  test("set/get roundtrip, null clears, unknown ignored, never throws", async () => {
    const home = await tmpHome();
    expect(getActiveSessionId(home)).toBeNull();
    expect(getActiveSession(home)).toBeNull();
    const a = createSession({ title: "a" }, home);
    const b = createSession({ title: "b" }, home);
    setActiveSession(b.id, home);
    expect(getActiveSessionId(home)).toBe(b.id);
    setActiveSession("ses_unknownunknownunknownunknown00", home);
    expect(getActiveSessionId(home)).toBe(b.id);
    setActiveSession(null, home);
    expect(getActiveSessionId(home)).toBeNull();
    expect(getActiveSession(home)).toBeNull();
    expect(() => setActiveSession(null, home)).not.toThrow();
    expect(() => setActiveSession("" as string, home)).not.toThrow();
    expect(a.id).not.toBe(b.id);
  });

  test("active file is plaintext and dangling ids read back safely", async () => {
    const home = await tmpHome();
    createSession({ title: "a" }, home);
    writeFileSync(
      path.join(sessionsDir(home), "active"),
      "ses_danglingdanglingdanglingdanglin",
      "utf8"
    );
    expect(getActiveSessionId(home)).toBe("ses_danglingdanglingdanglingdanglin");
    expect(getActiveSession(home)).toBeNull();
  });
});

describe("ensureActiveSession / touchSession / loadSession", () => {
  test("ensure returns the live active session", async () => {
    const home = await tmpHome();
    const a = createSession({ title: "a" }, home);
    expect(ensureActiveSession({}, home)).toEqual(a);
  });

  test("ensure creates when none or dangling", async () => {
    const home = await tmpHome();
    const fresh = ensureActiveSession({ title: "fresh" }, home);
    expect(fresh.title).toBe("fresh");
    expect(getActiveSessionId(home)).toBe(fresh.id);
    writeFileSync(
      path.join(sessionsDir(home), "active"),
      "ses_danglingdanglingdanglingdanglin",
      "utf8"
    );
    const recreated = ensureActiveSession({ title: "re" }, home);
    expect(recreated.title).toBe("re");
    expect(getActiveSession(home)).toEqual(recreated);
  });

  test("touch bumps updatedAt; null when missing", async () => {
    const home = await tmpHome();
    const s = createSession({ now: "2026-01-01T00:00:00.000Z" }, home);
    const touched = touchSession(s.id, home);
    expect(touched).not.toBeNull();
    expect(touched!.id).toBe(s.id);
    expect(Date.parse(touched!.updatedAt) >= Date.parse(s.updatedAt)).toBe(true);
    expect(touchSession("ses_missing", home)).toBeNull();
  });

  test("loadSession reads the full record", async () => {
    const home = await tmpHome();
    const s = createSession({ title: "full", cwd: "/x" }, home);
    expect(loadSession(s.id, home)).toEqual(s);
    expect(loadSession("ses_missing", home)).toBeNull();
  });

  test("raw disk shape carries the full record", async () => {
    const home = await tmpHome();
    const s = createSession({ title: "disk" }, home);
    const raw = JSON.parse(
      readFileSync(path.join(sessionsDir(home), `${s.id}.json`), "utf8")
    );
    expect(raw).toEqual(s);
  });
});

describe("ticket 01 acceptance: restart, switch isolation, failed turns", () => {
  test("kill + reopen restores ALL sessions with history intact", async () => {
    const home = await tmpHome();
    const a = createSession(
      {
        title: "first",
        history: [{ role: "user", content: "hello a" }],
        turns: [{ role: "user", content: "hello a" }],
      },
      home
    );
    const b = createSession(
      {
        title: "second",
        history: [{ role: "user", content: "hello b" }],
        turns: [{ role: "user", content: "hello b" }],
      },
      home
    );
    // Simulate completed turns durably saved on each session.
    const a2 = updateSession(
      a.id,
      {
        history: [
          ...a.history,
          { role: "assistant", content: "reply a" },
        ],
        turns: [...a.turns, { role: "assistant", content: "reply a" }],
      },
      home
    );
    const b2 = updateSession(
      b.id,
      {
        history: [...b.history, { role: "assistant", content: "reply b" }],
        turns: [...b.turns, { role: "assistant", content: "reply b" }],
      },
      home
    );
    expect(a2).not.toBeNull();
    expect(b2).not.toBeNull();
    setActiveSession(b.id, home);
    // "Reopen": fresh reads only, no in-memory state carried over.
    const reopened = listSessions(home);
    expect(reopened.map((s) => s.id).sort()).toEqual(
      [a.id, b.id].sort()
    );
    expect(getSession(a.id, home)).toEqual(a2);
    expect(getSession(b.id, home)).toEqual(b2);
    expect(getSession(a.id, home)!.history).toEqual([
      { role: "user", content: "hello a" },
      { role: "assistant", content: "reply a" },
    ]);
    expect(getSession(b.id, home)!.turns).toEqual([
      { role: "user", content: "hello b" },
      { role: "assistant", content: "reply b" },
    ]);
    expect(getActiveSessionId(home)).toBe(b.id);
    expect(getActiveSession(home)).toEqual(b2);
    expect(tmpFiles(sessionsDir(home))).toEqual([]);
  });

  test("switching loads exactly that session's history — no mixing", async () => {
    const home = await tmpHome();
    const a = createSession(
      {
        title: "a",
        history: [{ role: "user", content: "only-a" }],
        turns: [{ role: "user", content: "only-a" }],
      },
      home
    );
    const b = createSession(
      {
        title: "b",
        history: [
          { role: "user", content: "only-b-1" },
          { role: "assistant", content: "only-b-2" },
        ],
        turns: [
          { role: "user", content: "only-b-1" },
          { role: "assistant", content: "only-b-2" },
        ],
      },
      home
    );
    setActiveSession(a.id, home);
    expect(getActiveSession(home)!.history).toEqual(a.history);
    expect(getActiveSession(home)!.turns).toHaveLength(1);
    setActiveSession(b.id, home);
    const live = getActiveSession(home)!;
    expect(live.id).toBe(b.id);
    expect(live.history).toEqual(b.history);
    expect(live.turns).toHaveLength(2);
    // No duplication, no leakage from a.
    expect(
      live.history.some(
        (m) =>
          typeof m.content === "string" && m.content.includes("only-a")
      )
    ).toBe(false);
    setActiveSession(a.id, home);
    const backOnA = getActiveSession(home)!;
    expect(backOnA.id).toBe(a.id);
    expect(backOnA.title).toBe(a.title);
    expect(backOnA.createdAt).toBe(a.createdAt);
    expect(backOnA.history).toEqual(a.history);
    expect(backOnA.turns).toEqual(a.turns);
  });

  test("failed/cancelled turns never corrupt the last good state", async () => {
    const home = await tmpHome();
    const s = createSession(
      {
        title: "good",
        history: [{ role: "user", content: "saved" }],
        turns: [{ role: "user", content: "saved" }],
      },
      home
    );
    const file = path.join(sessionsDir(home), `${s.id}.json`);
    const before = readFileSync(file, "utf8");
    // A failed turn's malformed patch is rejected and leaves disk identical.
    expect(
      updateSession(
        s.id,
        { history: [{ role: "bogus", content: "x" }] } as never,
        home
      )
    ).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(getSession(s.id, home)).toEqual(s);
    // A cancelled turn simply never persists: last good state intact.
    expect(getSession(s.id, home)!.turns).toEqual([
      { role: "user", content: "saved" },
    ]);
    expect(tmpFiles(sessionsDir(home))).toEqual([]);
  });
});
