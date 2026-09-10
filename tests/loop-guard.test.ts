// Loop-guard unit tests: repetition detection + error-streak recovery.
// Pure state machines, no I/O, no network.
import { describe, expect, test } from "vitest";
import {
  ErrorStreakTracker,
  errorStreakFollowUp,
  POLLING_TOOLS,
  RepetitionGuard,
  repetitionFollowUp,
  repetitionStopNotice,
} from "../src/agent/loop-guard.js";

describe("RepetitionGuard", () => {
  test("track-only by default (never intervenes, still counts)", () => {
    const g = new RepetitionGuard({});
    for (let i = 0; i < 30; i++) {
      const n = g.note("read {}");
      expect(n.intervened).toBe(false);
    }
    expect(g.shouldIntervene()).toBe(false);
    expect(g.hitCount).toBe(0);
  });

  test("consecutive threshold intervenes; nudges bounded; streaks reset", () => {
    const g = new RepetitionGuard({ maxRepeatedCalls: 3, maxNudges: 2 });
    expect(g.note("a").intervened).toBe(false);
    expect(g.note("a").intervened).toBe(false);
    const third = g.note("a");
    expect(third.intervened).toBe(true);
    expect(third.consecutive).toBe(3);
    expect(g.consumeNudge()).toBe(true);
    expect(g.consumeNudge()).toBe(true);
    expect(g.consumeNudge()).toBe(false);
    g.resetStreak();
    expect(g.shouldIntervene()).toBe(false);
    expect(g.note("b").consecutive).toBe(1);
  });

  test("different signatures break the consecutive streak", () => {
    const g = new RepetitionGuard({ maxRepeatedCalls: 3 });
    g.note("a");
    g.note("a");
    g.note("b");
    const n = g.note("a");
    expect(n.consecutive).toBe(1);
    expect(n.intervened).toBe(false);
  });

  test("minimum clamp (1 → 2)", () => {
    const g = new RepetitionGuard({ maxRepeatedCalls: 1 });
    g.note("a");
    expect(g.note("a").intervened).toBe(true);
  });

  test("messages name the pattern with bounded length", () => {
    const long = `read ${"x".repeat(500)}`;
    expect(repetitionFollowUp(long, 4)).toContain("4×");
    expect(repetitionFollowUp(long, 4).length).toBeLessThan(long.length);
    expect(repetitionStopNotice(long, 5)).toContain("5×");
  });

  test("bash_output polls never count (and break other streaks)", () => {
    expect(POLLING_TOOLS.has("bash_output")).toBe(true);
    const g = new RepetitionGuard({ maxRepeatedCalls: 2 });
    const poll = 'bash_output {"taskId":"t1"}';
    expect(g.note(poll, "bash_output").excluded).toBe(true);
    expect(g.note(poll, "bash_output").excluded).toBe(true);
    expect(g.note(poll, "bash_output").intervened).toBe(false);
    expect(g.hitCount).toBe(0);
    // A poll between identical reads breaks consecutiveness.
    const sig = 'read {"path":"a"}';
    expect(g.note(sig, "read").consecutive).toBe(1);
    expect(g.note(sig, "read").consecutive).toBe(2);
    expect(g.note(poll, "bash_output").consecutive).toBe(0);
    expect(g.note(sig, "read").consecutive).toBe(1);
  });

  test("name falls back to the signature prefix when omitted", () => {
    const g = new RepetitionGuard({ maxRepeatedCalls: 2 });
    // "bash_output {...}" parses its own exclusion without an explicit name.
    expect(g.note('bash_output {"taskId":"t1"}').excluded).toBe(true);
    expect(g.note('read {"path":"a"}').excluded).toBe(false);
  });

  test("custom exclusions add to the polling defaults", () => {
    const g = new RepetitionGuard({ maxRepeatedCalls: 2, excludedTools: ["todo_get"] });
    expect(g.note("todo_get {}", "todo_get").excluded).toBe(true);
    expect(g.note('bash_output {"taskId":"t"}', "bash_output").excluded).toBe(true);
    expect(g.note('read {"path":"a"}', "read").excluded).toBe(false);
  });
});

describe("ErrorStreakTracker", () => {
  test("default threshold 3; single errors never hold", () => {
    const t = new ErrorStreakTracker(undefined);
    expect(t.enabled).toBe(true);
    t.noteResult(true);
    expect(t.shouldHoldFinal(2)).toBe(false);
    t.noteResult(true);
    expect(t.shouldHoldFinal(2)).toBe(false);
    t.noteResult(true);
    expect(t.shouldHoldFinal(2)).toBe(true);
  });

  test("success resets the streak; holds bounded per turn", () => {
    const t = new ErrorStreakTracker(2);
    t.noteResult(true);
    t.noteResult(true);
    expect(t.shouldHoldFinal(1)).toBe(true);
    expect(t.shouldHoldFinal(1)).toBe(false); // budget spent
    t.noteResult(false);
    expect(t.current).toBe(0);
  });

  test("0 disables", () => {
    const t = new ErrorStreakTracker(0);
    expect(t.enabled).toBe(false);
    t.noteResults([true, true, true, true]);
    expect(t.shouldHoldFinal(2)).toBe(false);
  });

  test("follow-up names the streak and demands evidence", () => {
    const msg = errorStreakFollowUp(3);
    expect(msg).toContain("3");
    expect(msg).toContain("evidence");
  });
});
