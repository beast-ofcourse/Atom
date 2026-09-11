// Before-compaction hooks (ticket 09): the handler sees the reason (auto,
// manual, overflow) and the pending head/tail split, may cancel (leaving
// everything byte-identical) or supply a custom summary (replacing the
// builtin text at the single injection point), throwing handlers degrade to
// builtin with a visible error, hooks observe read-only deep copies, and the
// new API method honors the ticket-01 stale-generation rule with staged
// activation atomicity. Pure unit tests — tmpdir files for extension loading,
// no TUI, no network (App-plumbing verified by inspection: the gate in
// doCompact precedes every write and the custom summary enters at the single
// point where builtin text enters the fitted/boundary/swap/save pipeline).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadExtensions, type ExtensionAPI } from "../src/extensions.js";
import {
  applyBeforeCompact,
  beforeCompactInterceptors,
  clearCompactionHooks,
  registerBeforeCompact,
  type BeforeCompactInfo,
  type BeforeCompactReason,
} from "../src/tools.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-09-"));
}

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  roots = [];
  clearCompactionHooks();
  for (const key of ["__cap09", "__seen09", "__order09"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

function writeExt(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  if (!roots.includes(root)) roots.push(root);
  return abs;
}

function splitFixture() {
  return {
    head: [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ],
    tail: [{ role: "user", content: "new question" }],
    olderTurnCount: 1,
  } as unknown as Pick<BeforeCompactInfo, "head" | "tail" | "olderTurnCount">;
}

function infoFor(
  reason: BeforeCompactReason = "manual",
  focusText = ""
): BeforeCompactInfo {
  const s = splitFixture();
  return { reason, focusText, head: s.head, tail: s.tail, olderTurnCount: s.olderTurnCount };
}

describe("reason + split visibility", () => {
  test("handler sees the reason and the pending head/tail split", async () => {
    let seen: BeforeCompactInfo | null = null;
    const out = await applyBeforeCompact(
      [{ owner: "e", handler: (info) => void (seen = info) }],
      infoFor("auto", "focus-x")
    );
    expect(out.cancelled).toBe(false);
    expect(out.summary).toBeNull();
    expect(seen).toMatchObject({
      reason: "auto",
      focusText: "focus-x",
      olderTurnCount: 1,
    });
    expect(seen!.head).toEqual(splitFixture().head);
    expect(seen!.tail).toEqual(splitFixture().tail);
  });

  for (const reason of ["auto", "manual", "overflow"] as const) {
    test(`reason "${reason}" passes through`, async () => {
      let seen: BeforeCompactReason | null = null;
      await applyBeforeCompact(
        [{ owner: "e", handler: (info) => void (seen = info.reason) }],
        infoFor(reason)
      );
      expect(seen).toBe(reason);
    });
  }
});

describe("cancel decisions", () => {
  test("explicit cancel shapes veto with reasons", async () => {
    const cases: Array<{ decision: unknown; reason: RegExp }> = [
      { decision: true, reason: /cancelled compaction/ },
      { decision: "unsaved work", reason: /unsaved work/ },
      { decision: { cancel: true }, reason: /cancelled compaction/ },
      { decision: { cancel: "custom reason" }, reason: /custom reason/ },
    ];
    for (const { decision, reason } of cases) {
      const out = await applyBeforeCompact(
        [{ owner: "gate", handler: () => decision as never }],
        infoFor()
      );
      expect(out.cancelled).toBe(true);
      expect(out.cancelReason).toMatch(reason);
      expect(out.cancelOwner).toBe("gate");
    }
  });

  test("allow shapes proceed to builtin (no summary, no cancel)", async () => {
    for (const decision of [undefined, null, false, { cancel: false }, {}, { summary: 42 }]) {
      const out = await applyBeforeCompact(
        [{ owner: "e", handler: () => decision as never }],
        infoFor()
      );
      expect(out).toMatchObject({ cancelled: false, summary: null });
    }
  });

  test("cancelling leaves the pending split byte-identical (deep equality before/after)", async () => {
    const info = infoFor("auto");
    const beforeHead = structuredClone(info.head);
    const beforeTail = structuredClone(info.tail);
    const out = await applyBeforeCompact(
      [{ owner: "gate", handler: () => true }],
      info
    );
    expect(out.cancelled).toBe(true);
    // The interception layer never mutates its inputs: the caller's planning
    // (and, in doCompact, history/snapshots/totals/ledger — all untouched
    // above the gate's early return) stays byte-identical.
    expect(info.head).toEqual(beforeHead);
    expect(info.tail).toEqual(beforeTail);
  });

  test("first cancel wins; later handlers never run", async () => {
    const order: string[] = [];
    const out = await applyBeforeCompact(
      [
        { owner: "a", handler: () => void order.push("a") },
        { owner: "b", handler: () => (order.push("b"), { cancel: "b vetoes" }) },
        { owner: "c", handler: () => void order.push("c") },
      ],
      infoFor()
    );
    expect(order).toEqual(["a", "b"]);
    expect(out.cancelled).toBe(true);
    expect(out.cancelReason).toBe("b vetoes");
    expect(out.cancelOwner).toBe("b");
  });
});

describe("custom summaries", () => {
  test("a supplied summary replaces the builtin text (first valid wins)", async () => {
    const out = await applyBeforeCompact(
      [
        { owner: "a", handler: () => ({ summary: "custom from a" }) },
        { owner: "b", handler: () => ({ summary: "custom from b" }) },
      ],
      infoFor()
    );
    expect(out.cancelled).toBe(false);
    expect(out.summary).toBe("custom from a");
    expect(out.summaryOwner).toBe("a");
  });

  test("empty/whitespace/non-string summaries are ignored (builtin applies)", async () => {
    for (const summary of ["", "   ", 42, null, undefined, ["x"]]) {
      const out = await applyBeforeCompact(
        [{ owner: "e", handler: () => ({ summary }) as never }],
        infoFor()
      );
      expect(out).toMatchObject({ cancelled: false, summary: null });
    }
  });

  test("cancel beats summary when both are present", async () => {
    const out = await applyBeforeCompact(
      [{ owner: "e", handler: () => ({ cancel: true, summary: "text" }) }],
      infoFor()
    );
    expect(out.cancelled).toBe(true);
    expect(out.summary).toBeNull();
  });
});

describe("fail-open on throw", () => {
  test("a throwing handler degrades to builtin with a visible error, never half-compacted", async () => {
    const info = infoFor();
    const beforeHead = structuredClone(info.head);
    const out = await applyBeforeCompact(
      [
        { owner: "buggy", handler: () => Promise.reject(new Error("boom")) },
        { owner: "ok", handler: () => ({ summary: "fallback wins" }) },
      ],
      info
    );
    expect(out.errors).toEqual(["buggy: boom"]);
    expect(out.cancelled).toBe(false);
    expect(out.summary).toBe("fallback wins");
    expect(info.head).toEqual(beforeHead);
  });

  test("all-throwing chain still resolves to builtin (errors recorded, nothing applied)", async () => {
    const out = await applyBeforeCompact(
      [{ owner: "buggy", handler: () => Promise.reject(new Error("boom")) }],
      infoFor()
    );
    expect(out.errors).toEqual(["buggy: boom"]);
    expect(out).toMatchObject({ cancelled: false, summary: null });
  });
});

describe("read-only split", () => {
  test("a mutating hook cannot corrupt planning or later handlers", async () => {
    const info = infoFor();
    const pristineHead = structuredClone(info.head);
    const pristineTail = structuredClone(info.tail);
    let secondHead: unknown = null;
    const out = await applyBeforeCompact(
      [
        {
          owner: "mutant",
          handler: (i) => {
            (i.head as Array<unknown>).length = 0;
            (i.head as Array<unknown>).push({ role: "user", content: "poison" });
            (i.tail as Array<unknown>).length = 0;
          },
        },
        { owner: "next", handler: (i) => void (secondHead = i.head) },
      ],
      info
    );
    expect(out.cancelled).toBe(false);
    // Caller inputs untouched…
    expect(info.head).toEqual(pristineHead);
    expect(info.tail).toEqual(pristineTail);
    // …and the next handler still sees the pristine split.
    expect(secondHead).toEqual(pristineHead);
  });
});

describe("extension host wiring", () => {
  test("onBeforeCompact registers through loadExtensions and fires in order", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "hook.js",
      `module.exports = function (api) {
         api.onBeforeCompact((info) => {
           globalThis.__seen09 = { reason: info.reason, olderTurnCount: info.olderTurnCount };
         });
       };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], home: root });
    expect(runtime.errors).toEqual([]);
    expect(beforeCompactInterceptors()).toHaveLength(1);
    const out = await applyBeforeCompact(beforeCompactInterceptors(), infoFor("manual"));
    expect(out.cancelled).toBe(false);
    expect((globalThis as Record<string, unknown>).__seen09).toMatchObject({
      reason: "manual",
      olderTurnCount: 1,
    });
  });

  test("stale generation: captured api.onBeforeCompact throws after invalidate", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "cap.js",
      `module.exports = function (api) { globalThis.__cap09 = api; };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], home: root });
    const captured = (globalThis as Record<string, unknown>).__cap09 as ExtensionAPI;
    runtime.invalidate("session replaced");
    expect(() => captured.onBeforeCompact(() => {})).toThrow(/session replaced/);
  });

  test("activation atomicity: a factory that throws leaves no compaction hook behind", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "boom.js",
      `module.exports = function (api) {
         api.onBeforeCompact(() => true);
         throw new Error("activation boom");
       };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], home: root });
    expect(runtime.errors.length).toBeGreaterThan(0);
    expect(beforeCompactInterceptors()).toHaveLength(0);
  });

  test("non-function registration throws", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "bad.js",
      `module.exports = function (api) { api.onBeforeCompact("nope"); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], home: root });
    expect(runtime.errors.length).toBeGreaterThan(0);
    expect(beforeCompactInterceptors()).toHaveLength(0);
  });

  test("unregister removes the hook", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "unreg.js",
      `module.exports = function (api) {
         const undo = api.onBeforeCompact(() => true);
         undo();
       };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], home: root });
    expect(runtime.errors).toEqual([]);
    expect(beforeCompactInterceptors()).toHaveLength(0);
  });

  test("direct register/unregister round-trip", () => {
    const undo = registerBeforeCompact(() => true, "t");
    expect(beforeCompactInterceptors()).toHaveLength(1);
    undo();
    expect(beforeCompactInterceptors()).toHaveLength(0);
  });
});
