// Extension UI surface (ticket 10): status segments (live updates, fixed
// budget), panel widgets (placement, unload/teardown cleanup), dialogs +
// notifications (render model, input resolution, never deadlock
// non-interactive), generation-stale handles, staged-activation rollback,
// and session-switch dialog cancellation. Pure unit tests — tmpdir files
// for extension loading, runtime accessors only, no TUI, no network.
//
// Live behavior always runs through the fresh session_start API (the
// sanctioned post-activation continuation from tickets 01/05) — the stashed
// factory API stages during activation only, like every other registration.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadExtensions, type ExtensionAPI, type ExtensionRuntime } from "../src/extensions.js";
import { formatExtensionStatusText } from "../src/extension-ui.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-10-"));
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
  delete process.env.ATOM_EXTENSIONS;
  // UI state is runtime-local (no global store), so per-test runtimes never
  // leak into each other — only the factory stash keys need clearing.
  for (const key of ["__cap10", "__fresh10", "__dlg10", "__unreg10"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

function writeExt(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  roots.push(root);
  return abs;
}

function captured(): ExtensionAPI {
  return (globalThis as Record<string, unknown>).__cap10 as ExtensionAPI;
}

function fresh(): ExtensionAPI {
  return (globalThis as Record<string, unknown>).__fresh10 as ExtensionAPI;
}

const STASH = `module.exports = function (api) { globalThis.__cap10 = api; api.on("session_start", (live) => { globalThis.__fresh10 = live; }); };`;

// Load one extension and hand back the runtime plus the live (fresh)
// session_start API — the handle extensions use across turns.
async function liveRuntime(
  entry: string,
  opts?: { interactive?: boolean }
): Promise<{ runtime: ExtensionRuntime; api: ExtensionAPI }> {
  const runtime = await loadExtensions({ entryPaths: [entry], interactive: opts?.interactive ?? true });
  await runtime.emit("session_start", { reason: "test" });
  return { runtime, api: fresh() };
}

describe("status segments", () => {
  test("set renders; calling again updates live; unregister removes", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "seg.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    expect(runtime.getStatusSegments()).toEqual([]);
    const unregister = api.setStatusSegment("build ok");
    expect(runtime.getStatusSegments()).toEqual([{ owner: "seg", text: "build ok" }]);
    // Live update across turns: same slot, new text, still one segment.
    api.setStatusSegment("tests 12/12");
    expect(runtime.getStatusSegments()).toEqual([{ owner: "seg", text: "tests 12/12" }]);
    unregister();
    expect(runtime.getStatusSegments()).toEqual([]);
  });

  test("activation factory can stage a segment; unregistering removes it", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "staged.js",
      `module.exports = function (api) { globalThis.__unreg10 = api.setStatusSegment("staged-live"); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], interactive: true });
    expect(runtime.getStatusSegments()).toEqual([{ owner: "staged", text: "staged-live" }]);
    ((globalThis as Record<string, unknown>).__unreg10 as () => void)();
    expect(runtime.getStatusSegments()).toEqual([]);
  });

  test("unregister before commit drops the pending segment", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "drop.js",
      `module.exports = function (api) { const undo = api.setStatusSegment("never"); undo(); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], interactive: true });
    expect(runtime.getStatusSegments()).toEqual([]);
  });

  test("empty and oversize segments throw fail-closed", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "bad.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    expect(() => api.setStatusSegment("")).toThrow(/non-empty/);
    expect(() => api.setStatusSegment("   ")).toThrow(/non-empty/);
    expect(() => api.setStatusSegment(42 as never)).toThrow(/non-empty/);
    expect(() => api.setStatusSegment("x".repeat(500))).toThrow(/too long/);
    expect(runtime.getStatusSegments()).toEqual([]);
  });
});

describe("stale rule for UI handles", () => {
  test("replacement stales captured handles but the slot persists for the fresh api", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "stale.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    const undo = api.setStatusSegment("v1");
    runtime.invalidate("extension context is stale after session switch — use the fresh API");
    // Captured handles throw loudly (set, unregister, widget, notify, prompt).
    expect(() => api.setStatusSegment("v2")).toThrow(/stale/);
    expect(() => undo()).toThrow(/stale/);
    expect(() => api.setWidget({ placement: "panel", title: "t", text: "b" })).toThrow(/stale/);
    expect(() => api.notify("hi")).toThrow(/stale/);
    expect(() => api.promptUser("q?", ["a"])).toThrow(/stale/);
    // The visible slot persists (owner-keyed, not session-scoped).
    expect(runtime.getStatusSegments()).toEqual([{ owner: "stale", text: "v1" }]);
    // The fresh session_start API updates the same slot.
    await runtime.emit("session_start", { reason: "switch" });
    fresh().setStatusSegment("v2");
    expect(runtime.getStatusSegments()).toEqual([{ owner: "stale", text: "v2" }]);
  });
});

describe("panel widgets", () => {
  test("set renders in the configured placement; same id upserts; unregister removes", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "wid.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    const undo = api.setWidget({ placement: "panel", title: "Deploy", text: "staging ready" });
    expect(runtime.getWidgets()).toEqual([
      { owner: "wid", id: "main", placement: "panel", title: "Deploy", text: "staging ready" },
    ]);
    api.setWidget({ id: "main", placement: "panel", title: "Deploy", text: "prod ready" });
    expect(runtime.getWidgets()).toEqual([
      { owner: "wid", id: "main", placement: "panel", title: "Deploy", text: "prod ready" },
    ]);
    api.setWidget({ id: "logs", placement: "panel", title: "Logs", text: "tail" });
    expect(runtime.getWidgets().map((w) => w.id)).toEqual(["main", "logs"]);
    undo();
    expect(runtime.getWidgets().map((w) => w.id)).toEqual(["logs"]);
  });

  test("bad shapes and unknown placements throw fail-closed", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "badw.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    expect(() => api.setWidget("x" as never)).toThrow(/must be an object/);
    expect(() => api.setWidget({ placement: "sidebar", title: "t", text: "b" })).toThrow(/unknown placement/);
    expect(() => api.setWidget({ placement: "panel", title: "", text: "b" })).toThrow(/non-empty title/);
    expect(() => api.setWidget({ placement: "panel", title: "t", text: "" })).toThrow(/non-empty text/);
    expect(() => api.setWidget({ id: "Bad Id", placement: "panel", title: "t", text: "b" })).toThrow(/invalid id/);
    // Nothing staged by the failures above.
    expect(runtime.getWidgets()).toEqual([]);
  });

  test("a throwing factory leaves zero UI residue", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "boom.js",
      `module.exports = function (api) {
        api.setStatusSegment("staged");
        api.setWidget({ placement: "panel", title: "t", text: "b" });
        api.notify("staged notice");
        throw new Error("activation blew up");
      };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], interactive: true });
    expect(runtime.errors.some((e) => /activation failed/.test(e.error))).toBe(true);
    expect(runtime.getStatusSegments()).toEqual([]);
    expect(runtime.getWidgets()).toEqual([]);
    expect(runtime.drainNotifications()).toEqual([]);
  });

  test("a later bad registration rolls back the earlier staged UI", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "half.js",
      `module.exports = function (api) {
        api.setStatusSegment("staged");
        api.setWidget({ placement: "nowhere", title: "t", text: "b" });
      };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], interactive: true });
    expect(runtime.errors.some((e) => /activation failed/.test(e.error))).toBe(true);
    expect(runtime.getStatusSegments()).toEqual([]);
    expect(runtime.getWidgets()).toEqual([]);
  });
});

describe("notifications", () => {
  test("notify stages in order; drain returns and clears; second drain is empty", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "note.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    api.notify("first");
    api.notify("second");
    expect(runtime.drainNotifications()).toEqual([
      { owner: "note", message: "first" },
      { owner: "note", message: "second" },
    ]);
    expect(runtime.drainNotifications()).toEqual([]);
  });

  test("empty and oversize notices throw; factory-thrown notices never stage", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "badn.js", STASH);
    const { api } = await liveRuntime(entry);
    expect(() => api.notify("")).toThrow(/non-empty/);
    expect(() => api.notify("x".repeat(2000))).toThrow(/too long/);
    const failing = writeExt(
      root,
      "failnote.js",
      `module.exports = function (api) { api.notify("doomed"); throw new Error("nope"); };`
    );
    const runtime = await loadExtensions({ entryPaths: [failing], interactive: true });
    expect(runtime.drainNotifications()).toEqual([]);
  });
});

describe("dialogs", () => {
  test("pending dialog is visible; resolve fulfills with the answer", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "dlg.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    const p = api.promptUser("Deploy?", ["staging", "prod"]);
    expect(runtime.getPendingDialog()).toMatchObject({
      owner: "dlg",
      question: "Deploy?",
      options: ["staging", "prod"],
      allowCustom: false,
    });
    expect(runtime.resolvePendingDialog("prod")).toBe(true);
    await expect(p).resolves.toBe("prod");
    expect(runtime.getPendingDialog()).toBeNull();
  });

  test("free-text dialog resolves custom input; cancel rejects with a clean error", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "free.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    const p = api.promptUser("Name?", undefined, true);
    expect(runtime.getPendingDialog()).toMatchObject({ options: [], allowCustom: true });
    expect(runtime.resolvePendingDialog("")).toBe(false);
    expect(runtime.getPendingDialog()).not.toBeNull();
    expect(runtime.cancelPendingDialog("user hit esc")).toBe(true);
    await expect(p).rejects.toThrow(/user hit esc/);
    expect(runtime.resolvePendingDialog("late")).toBe(false);
    expect(runtime.cancelPendingDialog()).toBe(false);
  });

  test("single-flight: a second request rejects immediately, never queues", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "busy.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    const first = api.promptUser("First?", ["a"]);
    await expect(api.promptUser("Second?", ["b"])).rejects.toThrow(/already open/);
    expect(runtime.getPendingDialog()).toMatchObject({ question: "First?" });
    expect(runtime.resolvePendingDialog("a")).toBe(true);
    await expect(first).resolves.toBe("a");
    // Slot freed — the next request proceeds.
    const second = api.promptUser("Second?", ["b"]);
    expect(runtime.resolvePendingDialog("b")).toBe(true);
    await expect(second).resolves.toBe("b");
  });

  test("bad dialog shapes throw synchronously (nothing pending)", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "badd.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    expect(() => api.promptUser("")).toThrow(/non-empty question/);
    expect(() => api.promptUser("q?", ["ok", ""])).toThrow(/non-empty strings/);
    expect(() => api.promptUser("q?")).toThrow(/options or allowCustom/);
    expect(() => api.promptUser("q?", Array.from({ length: 20 }, (_, i) => `o${i}`))).toThrow(/too many/);
    expect(runtime.getPendingDialog()).toBeNull();
  });

  test("non-interactive mode rejects immediately — never hangs headless", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "headless.js", STASH);
    // Default load (no interactive flag): headless by construction.
    const { runtime, api } = await liveRuntime(entry, { interactive: false });
    await expect(api.promptUser("q?", ["a"])).rejects.toThrow(/non-interactive/);
    expect(runtime.getPendingDialog()).toBeNull();
    // Status/widgets/notices still record (they never block).
    api.setStatusSegment("ok");
    api.notify("note");
    expect(runtime.getStatusSegments()).toHaveLength(1);
    expect(runtime.drainNotifications()).toHaveLength(1);
  });

  test("prompting during activation rejects instead of hanging", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "act.js",
      `module.exports = function (api) {
        const p = api.promptUser("q?", ["a"]);
        p.catch(() => {});
        globalThis.__dlg10 = p;
      };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry], interactive: true });
    expect(runtime.loaded.map((e) => e.name)).toContain("act");
    await expect((globalThis as Record<string, unknown>).__dlg10 as Promise<string>).rejects.toThrow(
      /during activation/
    );
    expect(runtime.getPendingDialog()).toBeNull();
  });

  test("a session switch rejects the pending dialog — never hangs, never wrong-session", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "sw.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    const p = api.promptUser("Proceed?", ["yes"]);
    expect(runtime.getPendingDialog()).not.toBeNull();
    runtime.invalidate("extension context is stale after session switch — rerun for fresh state");
    await expect(p).rejects.toThrow(/stale after session switch/);
    expect(runtime.getPendingDialog()).toBeNull();
  });

  test("a session switch drops staged notices — never into the new transcript", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "swn.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    api.notify("old lineage note");
    expect(runtime.drainNotifications()).toHaveLength(1);
    api.notify("staged before the switch");
    runtime.invalidate("extension context is stale after session switch — rerun for fresh state");
    // Dropped with the dead lineage: the next render drain must find nothing
    // to print into the new session (mirrors disposeUI teardown).
    expect(runtime.drainNotifications()).toEqual([]);
  });
});

describe("teardown and isolation", () => {
  test("disposeUI removes every contribution and rejects the pending dialog", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "td.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    api.setStatusSegment("live");
    api.setWidget({ placement: "panel", title: "t", text: "b" });
    api.notify("undrained");
    const p = api.promptUser("q?", ["a"]);
    const assertion = expect(p).rejects.toThrow(/teardown/);
    runtime.disposeUI();
    await assertion;
    expect(runtime.getStatusSegments()).toEqual([]);
    expect(runtime.getWidgets()).toEqual([]);
    expect(runtime.drainNotifications()).toEqual([]);
    expect(runtime.getPendingDialog()).toBeNull();
    expect(runtime.resolvePendingDialog("a")).toBe(false);
  });

  test("one extension unloading leaves the other's contributions intact", async () => {
    const root = makeTempRoot();
    const a = writeExt(root, "ext-a.js", STASH);
    const b = writeExt(
      root,
      "ext-b.js",
      `module.exports = function (api) {
        api.setStatusSegment("b-live");
        api.setWidget({ id: "b", placement: "panel", title: "B", text: "bee" });
      };`
    );
    const runtime = await loadExtensions({ entryPaths: [a, b], interactive: true });
    await runtime.emit("session_start", { reason: "test" });
    const undoA = fresh().setStatusSegment("a-live");
    expect(runtime.getStatusSegments().map((s) => s.owner).sort()).toEqual(["ext-a", "ext-b"]);
    undoA();
    expect(runtime.getStatusSegments()).toEqual([{ owner: "ext-b", text: "b-live" }]);
    expect(runtime.getWidgets()).toEqual([
      { owner: "ext-b", id: "b", placement: "panel", title: "B", text: "bee" },
    ]);
  });

  test("parallel runtimes never observe each other's UI", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "iso.js", STASH);
    const first = await loadExtensions({ entryPaths: [entry], interactive: true });
    await first.emit("session_start", { reason: "test" });
    const liveFirst = fresh();
    const second = await loadExtensions({ entryPaths: [entry], interactive: true });
    liveFirst.setStatusSegment("first-only");
    expect(first.getStatusSegments()).toEqual([{ owner: "iso", text: "first-only" }]);
    expect(second.getStatusSegments()).toEqual([]);
    expect(second.getWidgets()).toEqual([]);
    expect(second.drainNotifications()).toEqual([]);
  });

  test("read accessors return copies — mutating them changes nothing", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "copy.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    api.setStatusSegment("real");
    api.setWidget({ placement: "panel", title: "T", text: "real" });
    const segs = runtime.getStatusSegments();
    segs[0]!.text = "HACK";
    segs.length = 0;
    const wid = runtime.getWidgets();
    wid[0]!.text = "HACK";
    expect(runtime.getStatusSegments()).toEqual([{ owner: "copy", text: "real" }]);
    expect(runtime.getWidgets()[0]).toMatchObject({ text: "real" });
    const p = api.promptUser("q?", ["a"]);
    const view = runtime.getPendingDialog()!;
    view.options.push("HACK");
    view.question = "HACK";
    expect(runtime.getPendingDialog()).toMatchObject({ question: "q?", options: ["a"] });
    expect(runtime.resolvePendingDialog("a")).toBe(true);
    await expect(p).resolves.toBe("a");
  });

  test("subscribeUI emits on every mutation; unsubscribe stops", async () => {
    const root = makeTempRoot();
    const entry = writeExt(root, "sub.js", STASH);
    const { runtime, api } = await liveRuntime(entry);
    let calls = 0;
    const off = runtime.subscribeUI(() => {
      calls += 1;
    });
    expect(() => runtime.subscribeUI("x" as never)).toThrow(/must be a function/);
    api.setStatusSegment("s");
    api.notify("n");
    expect(calls).toBe(2);
    off();
    api.setWidget({ placement: "panel", title: "t", text: "b" });
    expect(calls).toBe(2);
  });
});

describe("status budget model", () => {
  test("empty input yields null; segments join with middots", () => {
    expect(formatExtensionStatusText([])).toBeNull();
    expect(formatExtensionStatusText(["", "   "])).toBeNull();
    expect(formatExtensionStatusText(["build ok"])).toBe("build ok");
    expect(formatExtensionStatusText(["a", "b"])).toBe("a · b");
  });

  test("long segments truncate to the per-segment budget", () => {
    const text = formatExtensionStatusText(["x".repeat(30)]);
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(24);
  });

  test("trailing segments drop whole past the total budget", () => {
    const twenty = "1".repeat(20);
    // 20 + 3 + 20 = 43 > 40: the second segment drops whole.
    expect(formatExtensionStatusText([twenty, "2".repeat(20)])).toBe(twenty);
    // Two short segments fit together.
    expect(formatExtensionStatusText(["alpha", "beta"])).toBe("alpha · beta");
  });

  test("non-string and blank entries are skipped", () => {
    expect(formatExtensionStatusText(["ok", 42 as unknown as string, null as unknown as string])).toBe("ok");
  });
});
