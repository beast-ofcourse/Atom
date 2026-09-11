// Session lifecycle for extensions (ticket 05): the cancellable
// before_switch gate (explicit-cancel-only, throwing handlers fail open,
// first-cancel-wins), per-session state persisted through the sessions store
// metadata field (isolated per session, restored on resume/reload), and the
// sanctioned post-replacement continuation (the fresh session_start API acts
// on the new session; captured pre-replacement handles throw). Pure unit
// tests — tmpdir files for extension loading + session store, no TUI, no
// network.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadExtensions, type ExtensionAPI } from "../src/extensions.js";
import { createSession, getSession } from "../src/sessions.js";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-05-"));
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
  for (const key of ["__cap05", "__fresh05", "__decision05", "__seen05", "__second05"]) {
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

const CAP = `module.exports = function (api) { globalThis.__cap05 = api; api.on("session_start", (fresh) => { globalThis.__fresh05 = fresh; }); };`;

function captured(): ExtensionAPI {
  return (globalThis as Record<string, unknown>).__cap05 as ExtensionAPI;
}

function fresh(): ExtensionAPI {
  return (globalThis as Record<string, unknown>).__fresh05 as ExtensionAPI;
}

describe("before_switch gate decisions", () => {
  test("allow shapes proceed and handlers see from/to/reason with a live api", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "gate.js",
      `module.exports = function (api) {
         api.onBeforeSwitch((live, info) => {
           globalThis.__seen05 = { info, state: live.getSessionState() };
           return globalThis.__decision05;
         });
       };`
    );
    for (const decision of [undefined, null, false, { cancel: false }]) {
      (globalThis as Record<string, unknown>).__decision05 = decision;
      const runtime = await loadExtensions({ entryPaths: [entry], home: root });
      const verdict = await runtime.requestSwitch({ fromSessionId: "ses_a", toSessionId: "ses_b", reason: "switch" });
      expect(verdict).toEqual({ cancelled: false });
      expect((globalThis as Record<string, unknown>).__seen05).toMatchObject({
        info: { fromSessionId: "ses_a", toSessionId: "ses_b", reason: "switch" },
        state: undefined,
      });
      delete (globalThis as Record<string, unknown>).__seen05;
    }
  });

  test("explicit cancel shapes veto with reasons", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "gate.js",
      `module.exports = function (api) { api.onBeforeSwitch(() => globalThis.__decision05); };`
    );
    const cases: Array<{ decision: unknown; reason: RegExp }> = [
      { decision: "unsaved work", reason: /unsaved work/ },
      { decision: true, reason: /gate.*cancelled the session switch/ },
      { decision: { cancel: "custom reason" }, reason: /custom reason/ },
      { decision: { cancel: true }, reason: /gate.*cancelled the session switch/ },
    ];
    for (const { decision, reason } of cases) {
      (globalThis as Record<string, unknown>).__decision05 = decision;
      const runtime = await loadExtensions({ entryPaths: [entry], home: root });
      const verdict = await runtime.requestSwitch({ fromSessionId: null, toSessionId: "ses_b", reason: "switch" });
      expect(verdict.cancelled).toBe(true);
      if (verdict.cancelled) expect(verdict.reason).toMatch(reason);
    }
    // Async handlers are awaited the same way.
    (globalThis as Record<string, unknown>).__decision05 = Promise.resolve({ cancel: "async-why" });
    const runtime = await loadExtensions({ entryPaths: [entry], home: root });
    const verdict = await runtime.requestSwitch({ fromSessionId: null, toSessionId: "ses_b", reason: "switch" });
    expect(verdict).toEqual({ cancelled: true, reason: "async-why" });
  });

  test("first cancel wins; later handlers never run", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(root, "first.js", `module.exports = function (api) { api.onBeforeSwitch(() => "first says no"); };`),
        writeExt(
          root,
          "second.js",
          `module.exports = function (api) { api.onBeforeSwitch(() => { globalThis.__second05 = true; }); };`
        ),
      ],
      home: root,
    });
    const verdict = await runtime.requestSwitch({ fromSessionId: "a", toSessionId: "b", reason: "switch" });
    expect(verdict).toEqual({ cancelled: true, reason: "first says no" });
    expect((globalThis as Record<string, unknown>).__second05).toBeUndefined();
  });

  test("throwing handler fails open: recorded, switch proceeds, siblings run", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(root, "bad.js", `module.exports = function (api) { api.onBeforeSwitch(() => { throw new Error("boom-gate"); }); };`),
        writeExt(root, "good.js", `module.exports = function (api) { api.onBeforeSwitch(() => { globalThis.__second05 = true; }); };`),
      ],
      home: root,
    });
    const verdict = await runtime.requestSwitch({ fromSessionId: "a", toSessionId: "b", reason: "switch" });
    expect(verdict).toEqual({ cancelled: false });
    expect((globalThis as Record<string, unknown>).__second05).toBe(true);
    expect(runtime.errors.some((e) => e.error.includes("before_switch handler failed"))).toBe(true);
    expect(runtime.errors.some((e) => e.error.includes("boom-gate"))).toBe(true);
  });
});

describe("stale-generation rule covers the new API methods", () => {
  test("captured api throws after invalidate; emit-time api stays live", async () => {
    const root = makeTempRoot();
    const home = root;
    const session = createSession({ title: "S" }, home);
    const runtime = await loadExtensions({ entryPaths: [writeExt(root, "cap.js", CAP)], home });
    const cap = captured();
    runtime.setSessionId(session.id);
    cap.setSessionState({ n: 1 });
    runtime.invalidate("stale after test switch");
    expect(() => cap.onBeforeSwitch(() => {})).toThrow("stale after test switch");
    expect(() => cap.getSessionState()).toThrow("stale after test switch");
    expect(() => cap.setSessionState({ n: 2 })).toThrow("stale after test switch");
    await runtime.emit("session_start", { reason: "switch" });
    const live = fresh();
    expect(() => live.getSessionState()).not.toThrow();
    const off = live.onBeforeSwitch(() => {});
    expect(await runtime.requestSwitch({ fromSessionId: session.id, toSessionId: "other", reason: "switch" })).toEqual({
      cancelled: false,
    });
    off();
  });

  test("unregister-after-invalidate throws like the interceptor methods", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({ entryPaths: [writeExt(root, "cap.js", CAP)], home: root });
    delete (globalThis as Record<string, unknown>).__cap05;
    await runtime.emit("session_start", { reason: "startup" });
    const live = fresh();
    const off = live.onBeforeSwitch(() => "veto");
    expect(await runtime.requestSwitch({ fromSessionId: null, toSessionId: "x", reason: "switch" })).toEqual({
      cancelled: true,
      reason: "veto",
    });
    runtime.invalidate("second switch");
    expect(() => off()).toThrow("second switch");
  });

  test("non-function handler fails activation loudly", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [writeExt(root, "bad.js", `module.exports = function (api) { api.onBeforeSwitch(123); };`)],
      home: root,
    });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("must be a function"))).toBe(true);
  });
});

describe("activation commit/rollback atomicity", () => {
  test("factory that registers then throws leaves no veto behind", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "flaky.js",
          `module.exports = function (api) { api.onBeforeSwitch(() => "veto-from-flaky"); throw new Error("boom-after-gate"); };`
        ),
      ],
      home: root,
    });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("boom-after-gate"))).toBe(true);
    expect(await runtime.requestSwitch({ fromSessionId: null, toSessionId: "x", reason: "switch" })).toEqual({
      cancelled: false,
    });
  });

  test("command commit failure rolls back the switch gate from the same round", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "squatter.js",
          `module.exports = function (api) { api.onBeforeSwitch(() => "veto-from-squatter"); api.registerCommand({ name: "new", description: "squat builtin", handler: async () => "x" }); };`
        ),
      ],
      home: root,
      builtinSlashCommands: ["/new"],
    });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("collides with a builtin"))).toBe(true);
    expect(await runtime.requestSwitch({ fromSessionId: null, toSessionId: "x", reason: "switch" })).toEqual({
      cancelled: false,
    });
  });
});

describe("per-session state (sessions store metadata)", () => {
  test("round-trips per session, isolated across sessions, visible in the record file", async () => {
    const root = makeTempRoot();
    const home = root;
    const a = createSession({ title: "A" }, home);
    const b = createSession({ title: "B" }, home);
    const runtime = await loadExtensions({ entryPaths: [writeExt(root, "cap.js", CAP)], home });
    const cap = captured();
    runtime.setSessionId(a.id);
    cap.setSessionState({ count: 1 });
    expect(cap.getSessionState()).toEqual({ count: 1 });
    // Durable in the record's metadata field (never a parallel store).
    expect(getSession(a.id, home)?.metadata).toEqual({ extensions: { cap: { count: 1 } } });
    // A new session starts blank; writes there never touch the old record.
    runtime.setSessionId(b.id);
    expect(cap.getSessionState()).toBeUndefined();
    cap.setSessionState({ count: 2 });
    expect(cap.getSessionState()).toEqual({ count: 2 });
    expect(getSession(b.id, home)?.metadata).toEqual({ extensions: { cap: { count: 2 } } });
    runtime.setSessionId(a.id);
    expect(cap.getSessionState()).toEqual({ count: 1 });
    // Reads are fresh parses: mutating the result persists nothing.
    (cap.getSessionState() as { count: number }).count = 99;
    expect(cap.getSessionState()).toEqual({ count: 1 });
  });

  test("restores on reload (new runtime, same store) and clears via undefined", async () => {
    const root = makeTempRoot();
    const home = root;
    const a = createSession({ title: "A" }, home);
    const entry = writeExt(root, "cap.js", CAP);
    const first = await loadExtensions({ entryPaths: [entry], home });
    first.setSessionId(a.id);
    captured().setSessionState({ restored: true });
    expect(getSession(a.id, home)?.metadata).toEqual({ extensions: { cap: { restored: true } } });
    // A reloaded host (fresh runtime over the same store, same extension
    // name) restores the slot — resume/reload need no separate mechanism.
    delete (globalThis as Record<string, unknown>).__cap05;
    delete (globalThis as Record<string, unknown>).__fresh05;
    const second = await loadExtensions({ entryPaths: [entry], home });
    expect(second.generation).toBe(0);
    second.setSessionId(a.id);
    expect(captured().getSessionState()).toEqual({ restored: true });
    // Clearing drops the slot (and the empty namespace with it).
    captured().setSessionState(undefined);
    expect(captured().getSessionState()).toBeUndefined();
    expect(getSession(a.id, home)?.metadata).toEqual({});
  });

  test("unserializable values and missing sessions fail loudly; unbound reads yield undefined", async () => {
    const root = makeTempRoot();
    const home = root;
    const runtime = await loadExtensions({ entryPaths: [writeExt(root, "cap.js", CAP)], home });
    const cap = captured();
    // Unbound: reads yield undefined, writes throw (never silently lost).
    expect(cap.getSessionState()).toBeUndefined();
    expect(() => cap.setSessionState({ x: 1 })).toThrow(/no active session/);
    runtime.setSessionId(null);
    expect(cap.getSessionState()).toBeUndefined();
    const session = createSession({ title: "S" }, home);
    runtime.setSessionId(session.id);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => cap.setSessionState(circular)).toThrow(/JSON-serializable/);
    expect(() => cap.setSessionState(() => {})).toThrow(/JSON-serializable/);
    runtime.setSessionId("ses_missing");
    expect(() => cap.setSessionState({ x: 1 })).toThrow(/unavailable/);
    // The failed writes left the real record untouched.
    expect(getSession(session.id, home)?.metadata).toEqual({});
  });
});

describe("sanctioned continuation vs stale handle", () => {
  test("fresh session_start api acts on the new session; captured handles throw", async () => {
    const root = makeTempRoot();
    const home = root;
    const a = createSession({ title: "A" }, home);
    const b = createSession({ title: "B" }, home);
    const runtime = await loadExtensions({
      entryPaths: [writeExt(root, "cont.js", CAP)],
      home,
    });
    const old = captured();
    runtime.setSessionId(a.id);
    old.setSessionState({ v: "old" });
    // Session replacement: invalidate, re-bind, then emit for the new lineage.
    runtime.invalidate("extension context is stale after session switch — use fresh API");
    runtime.setSessionId(b.id);
    expect(() => old.setSessionState({ v: "x" })).toThrow(/stale/);
    expect(() => old.getSessionState()).toThrow(/stale/);
    expect(() => old.onBeforeSwitch(() => {})).toThrow(/stale/);
    await runtime.emit("session_start", { reason: "switch" });
    // The sanctioned continuation — the fresh generation-bound API — works
    // and scopes to the NEW session.
    const live = fresh();
    live.setSessionState({ v: "new" });
    expect(live.getSessionState()).toEqual({ v: "new" });
    expect(getSession(b.id, home)?.metadata).toEqual({ extensions: { cont: { v: "new" } } });
    expect(getSession(a.id, home)?.metadata).toEqual({ extensions: { cont: { v: "old" } } });
  });
});
