// ContextLedger tests: incremental counters must NEVER diverge from the
// array, no matter which mutation path runs. Every op sequence below diffs
// stats() against the independent scanHistory() after EACH step.
import { describe, expect, test } from "vitest";
import {
  createContextManager,
  ledgerStats,
  scanHistory,
  trackHistory,
  verifyLedger,
} from "../src/context-manager.js";
import type { ChatMessage } from "../src/zen.js";

function user(text: string): ChatMessage {
  return { role: "user", content: text };
}

function assistant(text: string): ChatMessage {
  return { role: "assistant", content: text };
}

function tool(id: string, text: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content: text };
}

function expectSynced(history: ChatMessage[], label: string): void {
  const v = verifyLedger(history);
  expect(v.mismatches, label).toEqual([]);
  expect(v.ok, label).toBe(true);
  expect(ledgerStats(history), label).toEqual(scanHistory(history));
}

describe("incremental accounting never diverges", () => {
  test("append/remove/replace op sequence stays exact at every step", () => {
    const history = trackHistory([{ role: "system", content: "sys" }]);
    expectSynced(history, "init");
    history.push(user("q1"));
    expectSynced(history, "push user");
    history.push(assistant("a1"), user("q2"));
    expectSynced(history, "push two");
    history.push({ role: "assistant", content: "t", tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }] });
    expectSynced(history, "push tool_calls");
    history.push(tool("c1", "result"));
    expectSynced(history, "push tool result");
    // Whole-turn splice drop (the trim core's exact move).
    history.splice(1, 2);
    expectSynced(history, "splice drop");
    // Index assignment (the env-block refresh move).
    history[0] = { role: "system", content: "sys refreshed with more text" };
    expectSynced(history, "index assign");
    // Tail pop / head shift / unshift.
    history.pop();
    expectSynced(history, "pop");
    history.shift();
    expectSynced(history, "shift");
    history.unshift(user("new head"));
    expectSynced(history, "unshift");
    // Length truncation (rollback-style clear of the tail).
    history.length = 2;
    expectSynced(history, "length truncate");
    history.length = 0;
    expectSynced(history, "length clear");
    // Permutations preserve the multiset exactly.
    history.push(user("b"), assistant("a"), tool("c9", "r"));
    expectSynced(history, "repush");
    history.reverse();
    expectSynced(history, "reverse");
    history.sort((a, b) => String((a as { role?: unknown }).role).localeCompare(String((b as { role?: unknown }).role)));
    expectSynced(history, "sort");
    // defineProperty + deleteProperty paths.
    Object.defineProperty(history, 0, { value: user("defined"), writable: true, enumerable: true, configurable: true });
    expectSynced(history, "defineProperty");
    delete history[0];
    expectSynced(history, "delete");
  });

  test("same message object twice counts twice (cache is per-occurrence)", () => {
    const shared = user("shared text");
    const history = trackHistory([shared]);
    history.push(shared);
    const s = ledgerStats(history);
    expect(s.messages).toBe(2);
    expect(s.userMessages).toBe(2);
    expect(s.chars).toBe("shared text".length * 2);
    expectSynced(history, "duplicate identity");
  });

  test("track is idempotent; proxies stay transparent to equality", () => {
    const raw: ChatMessage[] = [user("a"), assistant("b")];
    const once = trackHistory(raw);
    expect(trackHistory(once)).toBe(once);
    expect(trackHistory(raw)).toBe(once);
    expect(once).toEqual([user("a"), assistant("b")]);
    expect(Array.isArray(once)).toBe(true);
    expect(JSON.stringify(once)).toBe(JSON.stringify(raw));
  });

  test("untracked arrays fall back to exact scans", () => {
    const plain: ChatMessage[] = [
      { role: "system", content: "s" },
      user("q"),
      tool("c1", "r"),
    ];
    expect(ledgerStats(plain)).toEqual(scanHistory(plain));
    expect(verifyLedger(plain).ok).toBe(true);
  });
});

describe("manager consumes the ledger", () => {
  test("usage/budget agree with scans; full history rides (no trimming)", () => {
    const mgr = createContextManager({ model: "mystery-model-xyz" });
    const history = trackHistory([{ role: "system", content: "sys" }]);
    for (let i = 0; i < 8; i++) {
      history.push(user(`q${i} ${"x".repeat(300)}`));
      history.push(assistant(`a${i} ${"y".repeat(300)}`));
    }
    const before = history.length;
    const u = mgr.usage(history);
    expect(u.historyChars).toBe(scanHistory(history).chars);
    expect(u.userTurns).toBe(8);
    const b = mgr.budget(history);
    expect(b.windowTokens).toBeUndefined();
    // Nothing drops: the manager measures but never trims.
    expect(history.length).toBe(before);
    expectSynced(history, "post-measure");
    expect(history[0]).toEqual({ role: "system", content: "sys" });
  });
});
