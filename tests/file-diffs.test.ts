// Ticket 06: per-turn file diffs. Hermetic proofs (no TUI, no network):
// write/edit-style tool outcomes across turns produce per-turn change
// records scoped to the owning session; the compaction summary's files
// section built from those records names exactly the files actually
// touched (via compact.ts's existing format/fit helpers — no template
// changes); records survive a session save/load round-trip with no
// in-memory carryover; no-change turns produce no spurious entries; and
// deleting a session removes its diffs with the record file (no cleanup
// code — the whole JSON file goes).
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../src/zen.js";
import {
  fitSummaryWithFiles,
  formatTouchedFiles,
} from "../src/compact.js";
import {
  collectTurnFileDiffs,
  emptyFileDiffs,
  FILE_DIFFS_METADATA_KEY,
  mergeFileDiffs,
  readFileDiffs,
  serializeFileDiffs,
} from "../src/file-diffs.js";
import {
  createSession,
  deleteSession,
  getSession,
  sessionFilePath,
  updateSession,
} from "../src/sessions.js";
import { existsSync } from "node:fs";

let homes: string[] = [];

async function tmpHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "atom-filediffs-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

// One committed assistant tool outcome, compact.ts tool_calls shape.
function toolMsg(name: string, path: string): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: `call_${name}_${path}`,
        function: { name, arguments: JSON.stringify({ path }) },
      },
    ],
  } as unknown as ChatMessage;
}

function userMsg(content: string): ChatMessage {
  return { role: "user", content } as ChatMessage;
}

describe("per-turn change records (criterion 1)", () => {
  test("editing files across turns records per-turn records", () => {
    const turn1 = [userMsg("add login"), toolMsg("write", "src/auth/login.ts")];
    const turn2 = [
      userMsg("wire refresh"),
      toolMsg("read", "src/auth/refresh.ts"),
      toolMsg("edit", "src/auth/refresh.ts"),
    ];
    const r1 = collectTurnFileDiffs(turn1);
    const r2 = collectTurnFileDiffs(turn2);
    expect(r1).toEqual({ read: [], modified: ["src/auth/login.ts"] });
    // Read-then-written in one turn lands in modified only.
    expect(r2).toEqual({ read: [], modified: ["src/auth/refresh.ts"] });

    const accumulated = mergeFileDiffs(r1, r2);
    expect(accumulated).toEqual({
      read: [],
      modified: ["src/auth/login.ts", "src/auth/refresh.ts"],
    });
  });

  test("records stay scoped to the owning session", async () => {
    const home = await tmpHome();
    const a = createSession({ title: "a" }, home);
    const b = createSession({ title: "b" }, home);
    const turn = collectTurnFileDiffs([
      userMsg("edit"),
      toolMsg("edit", "src/only-a.ts"),
    ]);
    const mergedA = mergeFileDiffs(
      readFileDiffs(a.metadata[FILE_DIFFS_METADATA_KEY]),
      turn
    );
    updateSession(
      a.id,
      { metadata: { ...a.metadata, [FILE_DIFFS_METADATA_KEY]: serializeFileDiffs(mergedA) } },
      home
    );
    // Session b never recorded anything: still empty.
    expect(readFileDiffs(getSession(b.id, home)?.metadata[FILE_DIFFS_METADATA_KEY])).toEqual(
      emptyFileDiffs()
    );
    expect(
      readFileDiffs(getSession(a.id, home)?.metadata[FILE_DIFFS_METADATA_KEY])
    ).toEqual({ read: [], modified: ["src/only-a.ts"] });
  });
});

describe("summary files section from real records (criterion 2)", () => {
  test("names exactly the files actually touched", () => {
    const t1 = collectTurnFileDiffs([
      userMsg("add login"),
      toolMsg("write", "src/auth/login.ts"),
    ]);
    const t2 = collectTurnFileDiffs([
      userMsg("check config"),
      toolMsg("read", "atom.example.json"),
    ]);
    const accumulated = mergeFileDiffs(t1, t2);
    const block = formatTouchedFiles(accumulated);
    expect(block).toContain("src/auth/login.ts");
    expect(block).toContain("atom.example.json");
    expect(block).not.toContain("src/auth/refresh.ts");

    const fitted = fitSummaryWithFiles("## Objective\nShip v2.", accumulated);
    expect(fitted.text).toContain("src/auth/login.ts");
    expect(fitted.text).toContain("atom.example.json");
    expect(fitted.text).not.toContain("src/auth/refresh.ts");
    expect(fitted.truncated).toBe(false);
  });
});

describe("records survive save/load with no in-memory carryover (criterion 3)", () => {
  test("updateSession/getSession round-trip restores the record", async () => {
    const home = await tmpHome();
    const created = createSession({ title: "diffs" }, home);
    const accumulated = mergeFileDiffs(
      collectTurnFileDiffs([userMsg("a"), toolMsg("write", "src/a.ts")]),
      collectTurnFileDiffs([userMsg("b"), toolMsg("read", "src/b.ts")])
    );
    updateSession(
      created.id,
      {
        metadata: {
          ...created.metadata,
          [FILE_DIFFS_METADATA_KEY]: serializeFileDiffs(accumulated),
        },
      },
      home
    );
    // Drop every in-memory reference; the fresh read comes from disk only.
    const fresh = getSession(created.id, home);
    expect(fresh).not.toBeNull();
    expect(readFileDiffs(fresh?.metadata[FILE_DIFFS_METADATA_KEY])).toEqual({
      read: ["src/b.ts"],
      modified: ["src/a.ts"],
    });
  });

  test("old records without the key read as empty; malformed degrades to empty", async () => {
    const home = await tmpHome();
    const created = createSession({ title: "legacy" }, home);
    // No filediffs key at all.
    expect(
      readFileDiffs(getSession(created.id, home)?.metadata[FILE_DIFFS_METADATA_KEY])
    ).toEqual(emptyFileDiffs());

    // Malformed values never fail the session load.
    updateSession(
      created.id,
      { metadata: { ...created.metadata, [FILE_DIFFS_METADATA_KEY]: "oops" } },
      home
    );
    expect(getSession(created.id, home)).not.toBeNull();
    expect(
      readFileDiffs(getSession(created.id, home)?.metadata[FILE_DIFFS_METADATA_KEY])
    ).toEqual(emptyFileDiffs());

    updateSession(
      created.id,
      {
        metadata: {
          ...getSession(created.id, home)!.metadata,
          [FILE_DIFFS_METADATA_KEY]: { read: [42, ""], modified: "x" },
        },
      },
      home
    );
    expect(getSession(created.id, home)).not.toBeNull();
    expect(
      readFileDiffs(getSession(created.id, home)?.metadata[FILE_DIFFS_METADATA_KEY])
    ).toEqual(emptyFileDiffs());
  });

  test("session delete removes diffs with the record file (no cleanup code)", async () => {
    const home = await tmpHome();
    const created = createSession({ title: "gone" }, home);
    updateSession(
      created.id,
      {
        metadata: {
          ...created.metadata,
          [FILE_DIFFS_METADATA_KEY]: serializeFileDiffs({
            read: [],
            modified: ["src/gone.ts"],
          }),
        },
      },
      home
    );
    expect(existsSync(sessionFilePath(created.id, home))).toBe(true);
    expect(deleteSession(created.id, home)).toBe(true);
    expect(existsSync(sessionFilePath(created.id, home))).toBe(false);
    expect(getSession(created.id, home)).toBeNull();
  });
});

describe("no-change turns produce no spurious entries (criterion 4)", () => {
  test("empty turns collect, merge, and format to nothing", () => {
    const empty = collectTurnFileDiffs([
      userMsg("just chatting"),
      { role: "assistant", content: "hello" } as ChatMessage,
    ]);
    expect(empty).toEqual(emptyFileDiffs());

    const base = collectTurnFileDiffs([
      userMsg("edit"),
      toolMsg("write", "src/kept.ts"),
    ]);
    expect(mergeFileDiffs(base, empty)).toEqual(base);
    expect(mergeFileDiffs(emptyFileDiffs(), empty)).toEqual(emptyFileDiffs());
    expect(formatTouchedFiles(empty)).toBe("");
    const fitted = fitSummaryWithFiles("## Objective\nShip.", empty);
    expect(fitted.text).toBe("## Objective\nShip.");
    expect(fitted.truncated).toBe(false);
  });

  test("non-file tool outcomes and bad payloads record nothing", () => {
    const turn: ChatMessage[] = [
      userMsg("search"),
      toolMsg("grep", "src/whatever.ts"),
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "bad", function: { name: "write", arguments: "not-json" } },
        ],
      } as unknown as ChatMessage,
    ];
    // grep is not a read/write-tracked tool; bad payloads are skipped.
    expect(collectTurnFileDiffs(turn)).toEqual(emptyFileDiffs());
  });
});
