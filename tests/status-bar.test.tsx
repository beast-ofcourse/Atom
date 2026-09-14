// Status-bar unit tests: quiet positional layout, cwd shortening, branch
// conditionality, and busy-state prioritization. App-level segment pins
// live in tests/status.test.tsx.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar, isEstimatedLoad, markTokenEstimate, formatStatusTokenSegment, shortenCwd } from "../src/ui/status-bar.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

const base = {
  provider: "opencode-zen",
  model: "big-pickle",
  usageTotals: null,
  contextLoad: null,
  reasoningDisplay: "default",
  mode: "normal",
  trustAll: false,
  phaseLabel: "thinking…",
  elapsedSecs: 0,
  stalled: false,
  approvalPending: false,
};

describe("shortenCwd", () => {
  test("home collapses and long tails cut", () => {
    expect(shortenCwd("/home/u/p", "/home/u")).toBe("~/p");
    expect(shortenCwd("/x/y", "/home/u")).toBe("/x/y");
    const long = `/home/u/${"a".repeat(40)}`;
    const short = shortenCwd(long, "/home/u");
    expect(short.length).toBeLessThanOrEqual(20);
    expect(short.startsWith("…/")).toBe(true);
  });
  test("location yields under width pressure, fixed segments never do", () => {
    const wide = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" columns={200} />
    );
    expect(wide).toContain("~/proj : main");
    // Tight: branch drops first, cwd tail shrinks, mode stays contiguous.
    const tight = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" columns={85} />
    );
    expect(tight).not.toContain(": main");
    expect(tight).toContain("mode: normal");
    // Starved: the whole location drops rather than wrap fixed segments.
    const starved = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" columns={40} />
    );
    expect(starved).not.toContain("~/proj");
    expect(starved).toContain("mode: normal");
  });
});

describe("idle layout", () => {
  test("positional segments, branch only for repos", () => {
    const frame = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" />
    );
    expect(frame).toContain("opencode-zen/big-pickle");
    expect(frame).toContain("token: n/a");
    expect(frame).toContain("~/proj : main");
    expect(frame).toContain("reasoning: default");
    expect(frame).toContain("mode: normal");
    expect(frame).not.toContain("provider:");
    const bare = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch={null} />
    );
    expect(bare).toContain("~/proj");
    expect(bare).not.toContain(" : ");
  });
});

describe("busy layout", () => {
  test("activity, clock, model, token, and interrupt hint", () => {
    const frame = frameOf(
      <StatusBar
        {...base}
        busy
        activity="Reading src/x.ts"
        elapsedSecs={12}
        cwd="~/proj"
        branch="main"
        columns={140}
      />
    );
    expect(frame).toContain("Reading src/x.ts");
    expect(frame).toContain("12s");
    expect(frame).toContain("esc stops");
    expect(frame).toContain("big-pickle");
    expect(frame).not.toContain("~/proj");
  });
  test("phase label fallback when no activity text", () => {
    const frame = frameOf(
      <StatusBar {...base} busy activity={null} elapsedSecs={3} cwd="" branch={null} columns={140} />
    );
    expect(frame).toContain("thinking…");
  });
});

// Ticket 06 — status bar information discipline: state prioritization,
// estimate honesty, and the memo contract.
describe("ticket 06: waiting-approval prioritization", () => {
  // The test renderer wraps long lines at its own width, so multi-word
  // flags assert against the flattened frame (production width math still
  // lives in the `columns` prop, covered by the yield assertions below).
  const flatOf = (node: React.ReactNode): string =>
    frameOf(node).replace(/\s+/g, " ");
  test("idle pins the decision flag; location yields for it under pressure", () => {
    const frame = flatOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" approvalPending columns={200} />
    );
    expect(frame).toContain("waiting approval");
    // Tight: the flag survives while the location yields first.
    const tight = flatOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" approvalPending columns={85} />
    );
    expect(tight).toContain("waiting approval");
    expect(tight).toContain("mode: normal");
  });
  test("busy keeps the approval flag and suppresses the stall hint", () => {
    const frame = flatOf(
      <StatusBar {...base} busy activity="Reading src/x.ts" elapsedSecs={9} stalled approvalPending />
    );
    expect(frame).toContain("waiting approval");
    expect(frame).toContain("esc stops");
  });
});

describe("ticket 06: estimates never read as exact facts", () => {
  test("isEstimatedLoad: explicit latch wins, else never-reported heuristic", () => {
    // No usage / no load: nothing to mark (n/a path).
    expect(isEstimatedLoad(null, null)).toBe(false);
    expect(isEstimatedLoad(null, 45056)).toBe(false);
    // Reported provider: accumulated prompt_tokens present → exact.
    expect(
      isEstimatedLoad({ prompt_tokens: 45056, total_tokens: 45056 }, 45056)
    ).toBe(false);
    // Never-reported provider: no prompt_tokens anywhere → estimate.
    expect(isEstimatedLoad({ total_tokens: 45056 }, 45056)).toBe(true);
    // Explicit latch always wins over the heuristic.
    expect(isEstimatedLoad({ prompt_tokens: 1 }, 1, true)).toBe(true);
    expect(isEstimatedLoad({ total_tokens: 1 }, 1, false)).toBe(false);
  });
  test("markTokenEstimate only touches the (P%) form", () => {
    expect(markTokenEstimate("token: (17%) 44K")).toBe("token: (~17%) 44K");
    expect(markTokenEstimate("token: n/a")).toBe("token: n/a");
    expect(markTokenEstimate("token: 44K")).toBe("token: 44K");
  });
  test("bar labels estimated P% with ~, keeps reported exact, in both states", () => {
    const estimated = {
      usageTotals: { total_tokens: 45056 },
      contextLoad: 45056,
      loadEstimated: true as const,
    };
    const idle = frameOf(
      <StatusBar {...base} {...estimated} busy={false} activity={null} model="kimi-k2.5" columns={200} />
    );
    expect(idle).toContain("token: (~17%) 44K");
    const busyFrame = frameOf(
      <StatusBar {...base} {...estimated} busy activity="Reading src/x.ts" elapsedSecs={5} model="kimi-k2.5" columns={200} />
    );
    expect(busyFrame).toContain("token: (~17%) 44K");
    // Reported load stays byte-identical to the exact contract.
    expect(
      formatStatusTokenSegment(
        { prompt_tokens: 40000, completion_tokens: 5056, total_tokens: 45056 },
        "kimi-k2.5",
        45056,
        false
      )
    ).toBe("token: (17%) 44K");
    // n/a and bare forms never gain a marker, even with the latch set.
    expect(formatStatusTokenSegment(null, "kimi-k2.5", 45056, true)).toBe("token: n/a");
    expect(
      formatStatusTokenSegment({ total_tokens: 45056 }, "big-pickle", 45056, true)
    ).toBe("token: 44K");
  });
});
