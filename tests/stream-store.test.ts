// StreamStore tests: the high-frequency streaming state behind LiveTailHost.
// Contract: stable snapshot identity across no-op writes (so
// useSyncExternalStore subscribers skip renders), exactly-one notify per real
// change, unsubscribe stops delivery, clear() resets to the shared EMPTY.
import { describe, expect, test, vi } from "vitest";
import { createStreamStore } from "../src/ui/stream-store.js";

describe("createStreamStore", () => {
  test("starts empty with a stable snapshot", () => {
    const s = createStreamStore();
    expect(s.getSnapshot()).toEqual({ draft: null, thinking: null });
    expect(s.getSnapshot()).toBe(s.getSnapshot());
    expect(s.getDraft()).toBeNull();
    expect(s.getThinking()).toBeNull();
  });

  test("setDraft notifies once and swaps snapshot identity", () => {
    const s = createStreamStore();
    const cb = vi.fn();
    const unsub = s.subscribe(cb);
    const before = s.getSnapshot();
    s.setDraft("hello");
    expect(s.getDraft()).toBe("hello");
    expect(s.getThinking()).toBeNull();
    expect(s.getSnapshot()).not.toBe(before);
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });

  test("same-value writes are no-ops (no notify, stable identity)", () => {
    const s = createStreamStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.setDraft("hello");
    expect(cb).toHaveBeenCalledTimes(1);
    const snap = s.getSnapshot();
    s.setDraft("hello");
    s.setThinking(null);
    expect(s.getSnapshot()).toBe(snap);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test("draft and thinking evolve independently", () => {
    const s = createStreamStore();
    s.setDraft("d");
    s.setThinking("t");
    expect(s.getSnapshot()).toEqual({ draft: "d", thinking: "t" });
    s.setDraft(null);
    expect(s.getSnapshot()).toEqual({ draft: null, thinking: "t" });
  });

  test("unsubscribe stops delivery; clear resets and notifies once", () => {
    const s = createStreamStore();
    const cb = vi.fn();
    const unsub = s.subscribe(cb);
    unsub();
    s.setDraft("x");
    expect(cb).not.toHaveBeenCalled();
    const cb2 = vi.fn();
    s.subscribe(cb2);
    s.clear();
    expect(s.getSnapshot()).toEqual({ draft: null, thinking: null });
    expect(cb2).toHaveBeenCalledTimes(1);
    // Clearing an already-empty store is silent.
    s.clear();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
